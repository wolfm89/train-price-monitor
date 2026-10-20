/**
 * `fetch` implementation for db-vendo-client (it hardcodes `import {Request, fetch}
 * from 'cross-fetch'`; the backend and scraper bundles alias that import to this
 * file with esbuild, so db-vendo-client's request building and response parsing
 * stay untouched).
 *
 * Why not Node's own fetch: DB's edge (Akamai) refuses requests by TLS
 * fingerprint and answers `403 OPS_BLOCKED` to Node's default client, curl,
 * Chrome-imitating clients and headless browsers alike. What passes (measured
 * 2026-10-20 from Lambda) is Node's own https client with the browser cipher
 * order below — repeatedly, on keep-alive and fresh connections. The cipher list
 * is the deciding factor; Node's default order gets 403, ALPN does not matter.
 * No browser, no proxy, no vendor account. Fingerprints that become popular get
 * blocked (the impit Firefox profile lasted two days), which is why the fallback
 * exists.
 *
 * Measured constraints this file encodes:
 *  - Only `Content-Type`/`Accept` plus `Origin`/`Referer` may be sent. db-vendo's
 *    own User-Agent and correlation headers turn an accepted request into a 403.
 *  - Bursts get an IP throttled (429) for minutes: 6 parallel calls were fine,
 *    60 at concurrency 6 were not. Calls are therefore spaced and few are in flight.
 *  - Once an environment is throttled, hammering it only extends the ban. After a
 *    few consecutive failures the transport opens a circuit breaker.
 *
 * Fallback: when a Decodo API key is configured (`DECODO_API_KEY` or an SSM
 * SecureString named by `DECODO_API_KEY_PARAM`), requests that the direct path
 * cannot get through are executed by Decodo's managed /scrape instead (premium
 * pool; its standard pool cannot send custom headers and is refused by DB). Only
 * the user-facing backend functions are configured with a key — the poller is
 * bulk work and must never spend the free Decodo allowance, so it stops instead
 * (see DbThrottledError).
 *
 * Environment (all optional):
 *  DB_MIN_GAP_MS            minimum spacing between request starts (default 1000)
 *  DB_MAX_IN_FLIGHT         concurrent requests (default 2)
 *  DB_MAX_ATTEMPTS          direct attempts per request (default 2)
 *  DB_RETRY_BACKOFF_MS      pause before a retry, multiplied by the attempt (default 3000)
 *  DB_REQUEST_TIMEOUT_MS    per-attempt timeout (default 20000)
 *  DB_BREAKER_THRESHOLD     consecutive failed requests that open the breaker (default 3)
 *  DB_BREAKER_COOLDOWN_MS   how long the breaker stays open (default 180000)
 *  DB_TRANSPORT             `decodo` forces the fallback path (kill switch)
 *  DECODO_API_KEY[_PARAM]   Decodo credentials (literal, or SSM SecureString name)
 *  DECODO_KEY_TTL_MS        how long a resolved SSM key is cached (default 15 min)
 */
import https from 'node:https';
import zlib from 'node:zlib';

interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  // Other fields set by db-vendo-client's request.js (agent, keepalive, redirect,
  // query) are ignored: `query` is already merged into the URL before fetch().
  [key: string]: unknown;
}

class FetchCompatibleHeaders {
  private readonly values: Map<string, string>;

  constructor(headers: Array<[string, string]>) {
    this.values = new Map(headers.map(([name, value]) => [name.toLowerCase(), value]));
  }

  get(name: string): string | null {
    return this.values.get(name.toLowerCase()) ?? null;
  }
}

class FetchCompatibleResponse {
  readonly ok: boolean;
  readonly headers: FetchCompatibleHeaders;

  constructor(
    readonly status: number,
    readonly statusText: string,
    private readonly bodyText: string,
    headers: Array<[string, string]>
  ) {
    this.ok = status >= 200 && status < 300;
    this.headers = new FetchCompatibleHeaders(headers);
  }

  async text(): Promise<string> {
    return this.bodyText;
  }
}

// db-vendo-client's request.js only constructs `Request` to pass it to
// `profile.logRequest`, which is a no-op unless `DEBUG=hafas-client` is set.
class FetchCompatibleRequest {
  readonly url: string;
  readonly body: string | undefined;

  constructor(url: string, init: FetchInit = {}) {
    this.url = url;
    this.body = init.body;
  }
}

/**
 * Thrown when DB is throttling this execution environment and no fallback is
 * configured. Bulk callers should stop their batch instead of retrying: every
 * further request only extends the throttle.
 */
export class DbThrottledError extends Error {
  constructor(message = 'DB is throttling this environment (circuit breaker open)') {
    super(message);
    this.name = 'DbThrottledError';
  }
}

export interface DbTransportStats {
  directOk: number;
  directThrottled: number;
  directFailed: number;
  retries: number;
  breakerOpened: number;
  breakerSkips: number;
  fallbackOk: number;
  fallbackFailed: number;
}

const stats: DbTransportStats = {
  directOk: 0,
  directThrottled: 0,
  directFailed: 0,
  retries: 0,
  breakerOpened: 0,
  breakerSkips: 0,
  fallbackOk: 0,
  fallbackFailed: 0,
};

/** Returns the counters accumulated since the last call and resets them. */
export function takeDbTransportStats(): DbTransportStats {
  const snapshot = { ...stats };
  for (const key of Object.keys(stats) as Array<keyof DbTransportStats>) stats[key] = 0;
  return snapshot;
}

function intFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Pacing: spaced request starts and a small in-flight cap.
// ---------------------------------------------------------------------------

let nextStartAt = 0;
let inFlight = 0;
const waiters: Array<() => void> = [];

async function acquireSlot(): Promise<() => void> {
  while (inFlight >= Math.max(1, intFromEnv('DB_MAX_IN_FLIGHT', 2))) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  inFlight++;

  const now = Date.now();
  const startAt = Math.max(now, nextStartAt);
  nextStartAt = startAt + intFromEnv('DB_MIN_GAP_MS', 1000);
  if (startAt > now) await sleep(startAt - now);

  return () => {
    inFlight--;
    waiters.shift()?.();
  };
}

// ---------------------------------------------------------------------------
// Circuit breaker: stop hitting DB from an environment that is being throttled.
// ---------------------------------------------------------------------------

let consecutiveFailures = 0;
let breakerOpenUntil = 0;

function breakerOpen(): boolean {
  return Date.now() < breakerOpenUntil;
}

function recordSuccess(): void {
  consecutiveFailures = 0;
}

function recordFailure(): void {
  consecutiveFailures++;
  if (consecutiveFailures >= Math.max(1, intFromEnv('DB_BREAKER_THRESHOLD', 3))) {
    consecutiveFailures = 0;
    breakerOpenUntil = Date.now() + intFromEnv('DB_BREAKER_COOLDOWN_MS', 180_000);
    stats.breakerOpened++;
  }
}

// ---------------------------------------------------------------------------
// Direct path: Node's HTTPS client with a browser cipher list.
//
// Measured 2026-10-20 from Lambda: every impit browser profile (Firefox, Chrome,
// iOS, okhttp) was refused with 403, while Node's own https client with the
// cipher order below returned 201 — repeatedly, on keep-alive and fresh
// connections. The cipher list is the deciding factor: Node's default order
// still gets 403, and ALPN (http/1.1) makes no difference. This is the same
// class of workaround db-vendo-client#46 describes; like every fingerprint it
// can be blocked once it becomes popular, which is why the Decodo fallback
// stays in place.
// ---------------------------------------------------------------------------

const BROWSER_CIPHERS = [
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
].join(':');

const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 2,
  ciphers: BROWSER_CIPHERS,
  // Browser-like group order; Node's default differs. Harmless either way, so
  // keep it aligned with the cipher impersonation.
  ecdhCurve: 'X25519:P-256:P-384',
  ALPNProtocols: ['http/1.1'],
});

/** A refusal that says nothing about the request itself: DB is throttling or blocking this client. */
function isThrottled(status: number, bodyText: string): boolean {
  return status === 429 || (status === 403 && /OPS_BLOCKED/.test(bodyText));
}

function pick(headers: Record<string, string> | undefined, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

function decodeBody(buffer: Buffer, encoding: string | undefined): Buffer {
  if (!encoding) return buffer;
  if (encoding === 'gzip') return zlib.gunzipSync(buffer);
  if (encoding === 'deflate') return zlib.inflateSync(buffer);
  if (encoding === 'br') return zlib.brotliDecompressSync(buffer);
  return buffer;
}

function directOnce(url: string, init: FetchInit): Promise<FetchCompatibleResponse> {
  const target = new URL(url);
  const timeoutMs = intFromEnv('DB_REQUEST_TIMEOUT_MS', 20_000);

  const headers: Record<string, string> = {
    Origin: target.origin,
    Referer: `${target.origin}/`,
  };
  const contentType = pick(init.headers, 'content-type');
  const accept = pick(init.headers, 'accept');
  if (contentType) headers['Content-Type'] = contentType;
  if (accept) headers.Accept = accept;

  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      { method: (init.method ?? 'GET').toUpperCase(), headers, agent, timeout: timeoutMs },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          let body: Buffer;
          try {
            body = decodeBody(Buffer.concat(chunks), String(response.headers['content-encoding'] ?? ''));
          } catch (error) {
            reject(error);
            return;
          }

          const responseHeaders: Array<[string, string]> = [];
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) for (const entry of value) responseHeaders.push([name, entry]);
            else if (value !== undefined) responseHeaders.push([name, String(value)]);
          }

          resolve(
            new FetchCompatibleResponse(
              response.statusCode ?? 0,
              response.statusMessage ?? '',
              body.toString('utf8'),
              responseHeaders
            )
          );
        });
      }
    );

    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('DB request timed out')));
    if (init.body) request.write(init.body);
    request.end();
  });
}

// ---------------------------------------------------------------------------
// Fallback: Decodo Web Data API (managed browser-like egress, premium pool).
// ---------------------------------------------------------------------------

const DECODO_SCRAPE_URL = 'https://data.decodo.com/v1/scrape';

let decodoKeyCache: { value: string; expiresAt: number } | null = null;
let decodoKeyRequest: Promise<string | null> | null = null;

/**
 * Resolves the Decodo API key: a literal for local development, otherwise the SSM
 * SecureString named by DECODO_API_KEY_PARAM (written by CI from a repo secret).
 * Cached, so a rotated key takes effect within the TTL.
 */
async function resolveDecodoKey(): Promise<string | null> {
  const literal = process.env.DECODO_API_KEY;
  if (literal) return literal;

  const parameterName = process.env.DECODO_API_KEY_PARAM;
  if (!parameterName) return null;

  if (decodoKeyCache && Date.now() < decodoKeyCache.expiresAt) return decodoKeyCache.value;

  if (!decodoKeyRequest) {
    decodoKeyRequest = (async (): Promise<string | null> => {
      const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
      const result = await new SSMClient({}).send(
        new GetParameterCommand({ Name: parameterName, WithDecryption: true })
      );
      const value = result.Parameter?.Value;
      if (!value) throw new Error(`SSM parameter ${parameterName} is empty`);
      decodoKeyCache = { value, expiresAt: Date.now() + intFromEnv('DECODO_KEY_TTL_MS', 15 * 60_000) };
      return value;
    })().finally(() => {
      decodoKeyRequest = null;
    });
  }

  return decodoKeyRequest;
}

/** Executes one request through Decodo; a DB refusal is retried once because the egress is picked per request. */
async function decodoFetch(key: string, url: string, init: FetchInit): Promise<FetchCompatibleResponse> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(init.headers ?? {})) {
    // Hop-by-hop headers describe our connection to Decodo, not the request to DB.
    if (/^(host|content-length|connection|accept-encoding|content-encoding)$/i.test(name)) continue;
    headers[name] = value;
  }

  for (let attempt = 1; ; attempt++) {
    const response = await globalThis.fetch(DECODO_SCRAPE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        url,
        http_method: (init.method ?? 'GET').toUpperCase(),
        proxy_pool: 'premium',
        headers,
        force_headers: true,
        ...(init.body ? { payload: Buffer.from(init.body).toString('base64') } : {}),
      }),
      signal: AbortSignal.timeout(intFromEnv('DB_REQUEST_TIMEOUT_MS', 20_000) + 10_000),
    });

    const text = await response.text();
    if (!response.ok) {
      return new FetchCompatibleResponse(response.status, response.statusText, text, []);
    }

    const envelope = JSON.parse(text) as {
      results?: Array<{ content?: string; status_code?: number; headers?: Record<string, string> }>;
    };
    const result = envelope.results?.[0];
    if (!result) throw new Error('Decodo returned no result');

    const status = result.status_code ?? 200;
    const bodyText = result.content ?? '';
    if (isThrottled(status, bodyText) && attempt < 2) continue;

    return new FetchCompatibleResponse(status, '', bodyText, Object.entries(result.headers ?? {}));
  }
}

async function viaFallback(url: string, init: FetchInit): Promise<FetchCompatibleResponse | null> {
  const key = await resolveDecodoKey();
  if (!key) return null;

  try {
    const response = await decodoFetch(key, url, init);
    if (isThrottled(response.status, await response.text()) || response.status >= 500) {
      stats.fallbackFailed++;
    } else {
      stats.fallbackOk++;
    }
    return response;
  } catch (error) {
    stats.fallbackFailed++;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function fetch(url: string, init: FetchInit = {}): Promise<FetchCompatibleResponse> {
  if (process.env.DB_TRANSPORT === 'decodo') {
    const forced = await viaFallback(url, init);
    if (forced) return forced;
  }

  if (breakerOpen()) {
    stats.breakerSkips++;
    const fallback = await viaFallback(url, init);
    if (fallback) return fallback;
    throw new DbThrottledError();
  }

  const maxAttempts = Math.max(1, intFromEnv('DB_MAX_ATTEMPTS', 2));
  let lastResponse: FetchCompatibleResponse | null = null;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const release = await acquireSlot();
    try {
      const response = await directOnce(url, init);
      const throttled = isThrottled(response.status, await response.text());
      // A 5xx is a failure, not a success: DB's edge returns 502/503 while it is
      // recovering, and counting those as successful calls silently defeated the
      // "no prices" alarm. Only 2xx counts as ok.
      const failed = response.status >= 500;
      if (!throttled && !failed) {
        recordSuccess();
        stats.directOk++;
        return response;
      }
      if (throttled) stats.directThrottled++;
      else stats.directFailed++;
      lastResponse = response;
      lastError = null;
    } catch (error) {
      // Network-level failure (timeout, reset): a failure, not throttling — the
      // "DB is throttling" alarm must not fire for our own timeouts.
      stats.directFailed++;
      lastError = error;
      lastResponse = null;
    } finally {
      release();
    }

    if (attempt < maxAttempts) {
      stats.retries++;
      await sleep(intFromEnv('DB_RETRY_BACKOFF_MS', 3000) * attempt);
    }
  }

  recordFailure();

  const fallback = await viaFallback(url, init);
  if (fallback) return fallback;
  if (breakerOpen()) throw new DbThrottledError();
  if (lastResponse) return lastResponse;
  throw lastError instanceof Error ? lastError : new Error('DB request failed');
}

export { FetchCompatibleRequest as Request };
