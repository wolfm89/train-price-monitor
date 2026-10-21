/**
 * `fetch` implementation for db-vendo-client (it hardcodes `import {Request, fetch}
 * from 'cross-fetch'`; the backend and scraper bundles alias that import to this
 * file with esbuild, so db-vendo-client's request building and response parsing
 * stay untouched).
 *
 * Why not Node's own fetch: DB's edge (Akamai) matches the TLS ClientHello and
 * answers `403 OPS_BLOCKED` to Node's default client, curl, Chrome-imitating
 * clients and headless browsers alike. What passes is Node's own https client
 * with a browser-like cipher list — repeatedly, on keep-alive and fresh
 * connections. The exact list/order is what DB matches: the 2026-10-20
 * Chrome-like order was refused on 2026-10-21 while Firefox, Safari and a
 * different Chrome order still returned 201 on the real tagesbestpreis POST.
 * The transport therefore carries several profiles, rotates to the first one DB
 * accepts, remembers it for the environment, and skips a blocked profile for a
 * cooldown. No browser, no proxy, no vendor account.
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
 *  DB_TOTAL_BUDGET_MS       wall-clock budget for one request, direct + fallback (default 24000)
 *  DB_BREAKER_THRESHOLD     consecutive failed requests that open the breaker (default 3)
 *  DB_BREAKER_COOLDOWN_MS   how long the breaker stays open (default 180000)
 *  DB_TLS_PROFILE           first TLS profile to try: firefox (default), safari,
 *                           chrome, tls13, tls12. A 403 OPS_BLOCKED rotates on.
 *  DB_PROFILE_BLOCK_COOLDOWN_MS  how long a blocked profile is skipped (default 900000)
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
  /** How often a request had to switch to the next TLS profile after OPS_BLOCKED. */
  profileRotations: number;
  fallbackOk: number;
  fallbackFailed: number;
}

export interface DbTransportSnapshot extends DbTransportStats {
  /** The TLS profile the environment is currently using. */
  tlsProfile: string;
}

const stats: DbTransportStats = {
  directOk: 0,
  directThrottled: 0,
  directFailed: 0,
  retries: 0,
  breakerOpened: 0,
  breakerSkips: 0,
  profileRotations: 0,
  fallbackOk: 0,
  fallbackFailed: 0,
};

/** Returns the counters accumulated since the last call and resets them. */
export function takeDbTransportStats(): DbTransportSnapshot {
  const snapshot = { ...stats, tlsProfile: TLS_PROFILES[activeProfileIndex].name };
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
// Direct path: Node's HTTPS client with a rotating browser-like TLS profile.
//
// DB matches the TLS ClientHello, so the cipher list/order decides whether a
// request gets through. No single list lasts forever: the public
// db-vendo-client#46 Chrome order was blocked on 2026-10-21 (403 OPS_BLOCKED)
// while Firefox, Safari and a different Chrome order still returned 201 on the
// real tagesbestpreis POST. The transport therefore carries several profiles
// and rotates on a block; the first accepted profile becomes sticky for the
// environment, and a blocked one is skipped for a cooldown instead of being
// retried on every request.
// ---------------------------------------------------------------------------

interface TlsProfile {
  name: string;
  ciphers: string;
  minVersion?: 'TLSv1.2' | 'TLSv1.3';
  maxVersion?: 'TLSv1.2' | 'TLSv1.3';
}

const TLS_PROFILES: TlsProfile[] = [
  {
    name: 'firefox',
    ciphers: [
      'TLS_AES_128_GCM_SHA256',
      'TLS_CHACHA20_POLY1305_SHA256',
      'TLS_AES_256_GCM_SHA384',
      'ECDHE-ECDSA-AES128-GCM-SHA256',
      'ECDHE-RSA-AES128-GCM-SHA256',
      'ECDHE-ECDSA-CHACHA20-POLY1305',
      'ECDHE-RSA-CHACHA20-POLY1305',
      'ECDHE-ECDSA-AES256-GCM-SHA384',
      'ECDHE-RSA-AES256-GCM-SHA384',
    ].join(':'),
  },
  {
    name: 'safari',
    ciphers: [
      'TLS_AES_256_GCM_SHA384',
      'TLS_CHACHA20_POLY1305_SHA256',
      'TLS_AES_128_GCM_SHA256',
      'ECDHE-ECDSA-AES256-GCM-SHA384',
      'ECDHE-ECDSA-AES128-GCM-SHA256',
      'ECDHE-RSA-AES256-GCM-SHA384',
      'ECDHE-RSA-AES128-GCM-SHA256',
      'ECDHE-ECDSA-CHACHA20-POLY1305',
      'ECDHE-RSA-CHACHA20-POLY1305',
    ].join(':'),
  },
  {
    name: 'chrome',
    ciphers: [
      'TLS_AES_128_GCM_SHA256',
      'TLS_AES_256_GCM_SHA384',
      'TLS_CHACHA20_POLY1305_SHA256',
      'ECDHE-ECDSA-AES128-GCM-SHA256',
      'ECDHE-RSA-AES128-GCM-SHA256',
      'ECDHE-ECDSA-AES256-GCM-SHA384',
      'ECDHE-RSA-AES256-GCM-SHA384',
      'ECDHE-ECDSA-CHACHA20-POLY1305',
      'ECDHE-RSA-CHACHA20-POLY1305',
    ].join(':'),
  },
  {
    name: 'tls13',
    ciphers: ['TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256', 'TLS_AES_128_GCM_SHA256'].join(':'),
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3',
  },
  {
    name: 'tls12',
    ciphers: [
      'ECDHE-ECDSA-AES128-GCM-SHA256',
      'ECDHE-RSA-AES128-GCM-SHA256',
      'ECDHE-ECDSA-AES256-GCM-SHA384',
      'ECDHE-RSA-AES256-GCM-SHA384',
      'ECDHE-ECDSA-CHACHA20-POLY1305',
      'ECDHE-RSA-CHACHA20-POLY1305',
    ].join(':'),
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.2',
  },
  {
    // The public 2026-10-20 workaround list. DB blocked it on 2026-10-21, but
    // blocks have lifted before, so it stays as the last-resort candidate.
    name: 'legacy',
    ciphers: [
      'TLS_AES_128_GCM_SHA256',
      'TLS_AES_256_GCM_SHA384',
      'TLS_CHACHA20_POLY1305_SHA256',
      'ECDHE-ECDSA-AES128-GCM-SHA256',
      'ECDHE-RSA-AES128-GCM-SHA256',
    ].join(':'),
  },
];

const preferredProfileName = process.env.DB_TLS_PROFILE?.trim();
const preferredProfileIndex = TLS_PROFILES.findIndex((profile) => profile.name === preferredProfileName);
let activeProfileIndex = preferredProfileIndex >= 0 ? preferredProfileIndex : 0;

/** Profiles that recently answered OPS_BLOCKED, with the time they may be retried. */
const blockedProfiles = new Map<string, number>();
const agents = new Map<string, https.Agent>();

function agentFor(profile: TlsProfile): https.Agent {
  const existing = agents.get(profile.name);
  if (existing) return existing;

  const created = new https.Agent({
    keepAlive: true,
    maxSockets: 2,
    ciphers: profile.ciphers,
    // Browser-like group order; Node's default differs. Keep it aligned with
    // the cipher impersonation.
    ecdhCurve: 'X25519:P-256:P-384',
    ALPNProtocols: ['http/1.1'],
    ...(profile.minVersion ? { minVersion: profile.minVersion } : {}),
    ...(profile.maxVersion ? { maxVersion: profile.maxVersion } : {}),
  });
  agents.set(profile.name, created);
  return created;
}

function isProfileBlocked(profile: TlsProfile): boolean {
  return (blockedProfiles.get(profile.name) ?? 0) > Date.now();
}

function markProfileBlocked(profile: TlsProfile): void {
  blockedProfiles.set(profile.name, Date.now() + intFromEnv('DB_PROFILE_BLOCK_COOLDOWN_MS', 15 * 60_000));
}

/** Active profile first, then the rest in declaration order, skipping blocked ones. */
function availableProfiles(): TlsProfile[] {
  const active = TLS_PROFILES[activeProfileIndex];
  return [active, ...TLS_PROFILES.filter((profile) => profile !== active)].filter(
    (profile) => !isProfileBlocked(profile)
  );
}

function isFingerprintBlocked(status: number, bodyText: string): boolean {
  return status === 403 && /OPS_BLOCKED/.test(bodyText);
}

/** A refusal that says nothing about the request itself: DB is throttling or blocking this client. */
function isThrottled(status: number, bodyText: string): boolean {
  return status === 429 || isFingerprintBlocked(status, bodyText);
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

function directOnce(url: string, init: FetchInit, profile: TlsProfile): Promise<FetchCompatibleResponse> {
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
      { method: (init.method ?? 'GET').toUpperCase(), headers, agent: agentFor(profile), timeout: timeoutMs },
      (response) => {
        const chunks: Buffer[] = [];
        // A connection that dies after the headers emits 'error'/'aborted' on the
        // response, not on the request; without this the promise never settles and
        // the transport slot is held until the Lambda times out.
        response.on('error', reject);
        response.on('aborted', () => reject(new Error('DB response aborted')));
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
async function decodoFetch(
  key: string,
  url: string,
  init: FetchInit,
  deadline: number
): Promise<FetchCompatibleResponse> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(init.headers ?? {})) {
    // Hop-by-hop headers describe our connection to Decodo, not the request to DB.
    if (/^(host|content-length|connection|accept-encoding|content-encoding)$/i.test(name)) continue;
    headers[name] = value;
  }

  for (let attempt = 1; ; attempt++) {
    // Share one wall-clock budget with the direct path: the API Lambda lives
    // behind a 29 s gateway cap, so a late throttling response must not start
    // another full 18 s attempt.
    const remaining = deadline - Date.now();
    if (remaining < 1_000) throw new Error('DB request budget exhausted before the fallback');

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
      signal: AbortSignal.timeout(Math.min(intFromEnv('DB_REQUEST_TIMEOUT_MS', 20_000) + 10_000, remaining)),
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
    if (isThrottled(status, bodyText) && attempt < 2 && deadline - Date.now() > 3_000) continue;

    return new FetchCompatibleResponse(status, '', bodyText, Object.entries(result.headers ?? {}));
  }
}

async function viaFallback(url: string, init: FetchInit, deadline: number): Promise<FetchCompatibleResponse | null> {
  const key = await resolveDecodoKey();
  if (!key) return null;

  try {
    const response = await decodoFetch(key, url, init, deadline);
    // The vendor answers 401/402 when the key is wrong or the quota is gone; those
    // are failures, not successful fallbacks.
    if (response.ok) stats.fallbackOk++;
    else stats.fallbackFailed++;
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
  const deadline = Date.now() + intFromEnv('DB_TOTAL_BUDGET_MS', 24_000);

  if (process.env.DB_TRANSPORT === 'decodo') {
    const forced = await viaFallback(url, init, deadline);
    if (forced) return forced;
  }

  if (breakerOpen()) {
    stats.breakerSkips++;
    const fallback = await viaFallback(url, init, deadline);
    if (fallback) return fallback;
    throw new DbThrottledError();
  }

  const maxAttempts = Math.max(1, intFromEnv('DB_MAX_ATTEMPTS', 2));
  let lastResponse: FetchCompatibleResponse | null = null;
  let lastError: unknown = null;

  // Do not start an attempt that the shared wall-clock budget can no longer hold.
  for (let attempt = 1; attempt <= maxAttempts && Date.now() < deadline; attempt++) {
    const release = await acquireSlot();
    try {
      const candidates = availableProfiles();
      if (candidates.length === 0) {
        // Every profile is cooling down after OPS_BLOCKED; do not spend the
        // budget on another guaranteed refusal.
        stats.directThrottled++;
        lastResponse = null;
        lastError = null;
        break;
      }

      let response: FetchCompatibleResponse | null = null;
      let bodyText = '';

      // Rotate through the profiles until DB accepts one. A blocked profile is
      // put on cooldown, so the next request starts with the one that worked.
      for (let index = 0; index < candidates.length; index++) {
        if (index > 0) stats.profileRotations++;
        const profile = candidates[index];
        response = await directOnce(url, init, profile);
        bodyText = await response.text();

        if (!isFingerprintBlocked(response.status, bodyText)) {
          activeProfileIndex = TLS_PROFILES.indexOf(profile);
          break;
        }

        markProfileBlocked(profile);
        if (index === candidates.length - 1 || Date.now() >= deadline) break;
      }

      if (!response) {
        stats.directThrottled++;
        lastResponse = null;
        lastError = null;
        break;
      }

      const throttled = isThrottled(response.status, bodyText);
      // Only 2xx is a success. A 5xx is a transient failure; a plain 400/403 is a
      // failure too (counting it as directOk would keep PollerNoPrices green while
      // nothing is scraped). Non-retryable responses are still returned to the
      // caller so db-vendo can surface them.
      const retryable = throttled || response.status >= 500;
      if (!retryable && response.ok) {
        recordSuccess();
        stats.directOk++;
        return response;
      }
      if (throttled) stats.directThrottled++;
      else stats.directFailed++;
      if (!retryable) return response;
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

    if (attempt < maxAttempts && Date.now() < deadline) {
      stats.retries++;
      await sleep(Math.min(intFromEnv('DB_RETRY_BACKOFF_MS', 3000) * attempt, Math.max(0, deadline - Date.now())));
    }
  }

  recordFailure();

  const fallback = await viaFallback(url, init, deadline);
  if (fallback) return fallback;
  if (breakerOpen()) throw new DbThrottledError();
  if (lastResponse) return lastResponse;
  throw lastError instanceof Error ? lastError : new Error('DB request failed');
}

export { FetchCompatibleRequest as Request };
