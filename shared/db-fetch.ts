/**
 * `fetch` implementation for db-vendo-client (it hardcodes `import {Request, fetch}
 * from 'cross-fetch'`; the backend and scraper bundles alias that import to this
 * file with esbuild, so db-vendo-client's request building and response parsing
 * stay untouched).
 *
 * Why not Node's own fetch: DB's edge (Akamai) matches the TLS ClientHello and
 * answers `403`/`452 OPS_BLOCKED` to Node's default client, curl and several
 * browser-like cipher lists. What passes is Node's own https client with a
 * browser-like cipher list — repeatedly, on keep-alive and fresh connections.
 * The exact list/order is what DB matches; the accepted order changes without
 * notice (tls12 was accepted on 2026-11-25 and refused again on 2026-11-27).
 * The transport therefore carries several profiles and, for every request,
 * tries them in a configurable order until one is accepted, remembering the
 * winner for the environment and skipping a refused profile for a cooldown.
 *
 * Egress: DB refuses some regions and rate-limits others. The caller can be
 * configured with several proxy Lambdas (`DB_PROXY_FUNCTIONS`, one per region).
 * Each request tries the healthiest proxy region first and fails over to the
 * next one on a throttle/refusal, so a block or a 429 in one region does not
 * stop the app. A region that fails is skipped for a cooldown instead of being
 * hammered.
 *
 * Measured constraints this file encodes:
 *  - For the bahn.de web API, only `Content-Type`/`Accept` plus `Origin`/`Referer`
 *    may be sent. db-vendo's own User-Agent and correlation headers turn an
 *    accepted request into a 403. The DB Navigator API is the exception: it
 *    requires `X-Correlation-ID`, which is forwarded when the profile supplies it.
 *  - Bursts get an IP throttled (429) for minutes: 6 parallel calls were fine,
 *    60 at concurrency 6 were not. Calls are therefore spaced and few are in flight.
 *  - Once an environment is throttled, hammering it only extends the ban. After a
 *    few consecutive failures the transport opens a circuit breaker.
 *
 * This file has no vendor fallback: no third-party proxy, no SSM lookup and no
 * second HTTP client. The only egress options are the app-owned proxy Lambdas
 * and the TLS profiles above.
 *
 * Environment (all optional):
 *  DB_MIN_GAP_MS                  minimum spacing between request starts (default 1000)
 *  DB_MAX_IN_FLIGHT               concurrent requests (default 2)
 *  DB_MAX_ATTEMPTS                rounds over the proxy regions per request (default 2)
 *  DB_RETRY_BACKOFF_MS            pause before the next round, multiplied by the round (default 3000)
 *  DB_REQUEST_TIMEOUT_MS          per-attempt timeout; in proxy mode bounds the Lambda invoke (default 20000)
 *  DB_TOTAL_BUDGET_MS             wall-clock budget for one request (default 24000)
 *  DB_BREAKER_THRESHOLD           consecutive failed requests that open the breaker (default 3)
 *  DB_BREAKER_COOLDOWN_MS         how long the breaker stays open (default 180000)
 *  DB_REGION_COOLDOWN_MS          how long a proxy region is skipped after a refusal (default 120000)
 *  DB_TLS_PROFILES                comma-separated profile order (default chrome,legacy,firefox,safari,tls13,tls12)
 *  DB_TLS_PROFILE                 legacy alias: put this profile first
 *  DB_PROFILE_BLOCK_COOLDOWN_MS   how long a refused profile is skipped (default 900000)
 *  DB_PROFILE_THROTTLE_ROTATIONS  extra profiles tried after a 429 (default 2)
 *  DB_PROXY_FUNCTIONS             comma-separated proxy Lambda ARNs, one per region (preferred)
 *  DB_PROXY_FUNCTION              single proxy Lambda ARN (legacy alias)
 *  DB_PROXY_REGION                region of a single ARN when it cannot be parsed (default us-east-1)
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
 * Thrown when every egress option (all proxy regions × all TLS profiles) is
 * throttling this environment. Bulk callers should stop their batch instead of
 * retrying: every further request only extends the throttle.
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
  /** The proxy rejected an invoke because its concurrency limit was full. */
  proxyBusy: number;
  /** How often DB refused the preferred profile and the next one was used. */
  profileRotations: number;
  /** How often the request had to move to the next proxy region. */
  regionRotations: number;
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
  proxyBusy: 0,
  profileRotations: 0,
  regionRotations: 0,
};

/** The profile that last completed a request, for logs and the dashboard. */
let currentProfileName: string | null = null;

/** Returns the counters accumulated since the last call and resets them. */
export function takeDbTransportStats(): DbTransportSnapshot {
  const snapshot = { ...stats, tlsProfile: currentProfileName ?? configuredProfileOrder()[0]?.name ?? 'firefox' };
  for (const key of Object.keys(stats) as Array<keyof DbTransportStats>) stats[key] = 0;
  return snapshot;
}

/** The profile the environment is currently using (proxy handler reports it to the caller). */
export function activeTlsProfileName(): string {
  return currentProfileName ?? configuredProfileOrder()[0]?.name ?? 'firefox';
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  // `Number` rejects partial values such as "3s"; parseInt would accept them.
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
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

function openBreaker(): void {
  consecutiveFailures = 0;
  breakerOpenUntil = Date.now() + intFromEnv('DB_BREAKER_COOLDOWN_MS', 180_000);
  stats.breakerOpened++;
}

function recordFailure(): void {
  consecutiveFailures++;
  if (consecutiveFailures >= Math.max(1, intFromEnv('DB_BREAKER_THRESHOLD', 3))) {
    openBreaker();
  }
}

// ---------------------------------------------------------------------------
// Direct path: Node's HTTPS client with a rotating browser-like TLS profile.
//
// DB matches the TLS ClientHello, so the cipher list/order decides whether a
// request gets through. No single list lasts forever: the public
// db-vendo-client#46 Chrome order was blocked on 2026-10-21, the `tls12` profile
// that the proxy pinned since 2026-11-25 was refused again on 2026-11-27 while
// `chrome` and `legacy` still returned 200. The transport therefore carries all
// profiles in one configurable order, rotates on a refusal *and* on a 429, and
// skips a refused profile for a cooldown instead of retrying it every call.
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
    // blocks have lifted before; on 2026-11-27 it was accepted again, so it is
    // part of the rotation rather than a dead last resort.
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

const DEFAULT_PROFILE_ORDER = 'chrome,legacy,firefox,safari,tls13,tls12';

/** Profiles in the order they should be tried: explicit override, active winner, configured order. */
function configuredProfileOrder(): TlsProfile[] {
  const names = [
    process.env.DB_TLS_PROFILE?.trim(),
    currentProfileName,
    ...(process.env.DB_TLS_PROFILES?.trim() || DEFAULT_PROFILE_ORDER).split(','),
    ...TLS_PROFILES.map((profile) => profile.name),
  ].filter((name): name is string => Boolean(name && name.trim()));

  const ordered: TlsProfile[] = [];
  for (const name of names) {
    const profile = TLS_PROFILES.find((candidate) => candidate.name === name.trim());
    if (profile && !ordered.includes(profile)) ordered.push(profile);
  }
  return ordered;
}

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

/** Preferred order first, skipping profiles that recently answered OPS_BLOCKED. */
function availableProfiles(): TlsProfile[] {
  return configuredProfileOrder().filter((profile) => !isProfileBlocked(profile));
}

function isFingerprintBlocked(status: number, bodyText: string): boolean {
  // The bahn.de web API answers 403; the DB Navigator API answers 452. A 452
  // is always the edge's block code, even if the body changes, so rotate on it
  // unconditionally. A 403 only means "blocked" with the OPS_BLOCKED body.
  return status === 452 || (status === 403 && /OPS_BLOCKED/i.test(bodyText));
}

/** A refusal that says nothing about the request itself: DB is throttling or blocking this client. */
export function isThrottled(status: number, bodyText: string): boolean {
  return status === 429 || isFingerprintBlocked(status, bodyText);
}

function pick(headers: Record<string, string> | undefined, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

function decodeBody(buffer: Buffer, encoding: string | undefined): Buffer {
  const values = (encoding ?? '')
    .toLowerCase()
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) return buffer;
  if (values.length > 1) throw new Error(`Unsupported DB content-encoding: ${encoding}`);
  const value = values[0];
  if (value === 'gzip' || value === 'x-gzip') return zlib.gunzipSync(buffer);
  if (value === 'deflate') return zlib.inflateSync(buffer);
  if (value === 'br') return zlib.brotliDecompressSync(buffer);
  throw new Error(`Unsupported DB content-encoding: ${encoding}`);
}

function directOnce(
  url: string,
  init: FetchInit,
  profile: TlsProfile,
  deadline: number
): Promise<FetchCompatibleResponse> {
  const target = new URL(url);
  const remaining = deadline - Date.now();
  if (remaining < 1_000) {
    return Promise.reject(new Error('DB request budget exhausted before the attempt'));
  }
  // The https timeout option is an idle timeout; cap it to the remaining
  // budget and add an absolute timer below so a trickling response cannot hold
  // the invocation until the Lambda timeout.
  const timeoutMs = Math.max(1, Math.min(intFromEnv('DB_REQUEST_TIMEOUT_MS', 20_000), remaining));

  const headers: Record<string, string> = {
    Origin: target.origin,
    Referer: `${target.origin}/`,
  };
  const contentType = pick(init.headers, 'content-type');
  const accept = pick(init.headers, 'accept');
  const correlationId = pick(init.headers, 'x-correlation-id');
  if (contentType) headers['Content-Type'] = contentType;
  if (accept) headers.Accept = accept;
  if (correlationId) headers['X-Correlation-ID'] = correlationId;

  return new Promise((resolve, reject) => {
    let settled = false;
    const succeed = (response: FetchCompatibleResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(response);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error('DB request timed out')), timeoutMs);

    const request = https.request(
      url,
      { method: (init.method ?? 'GET').toUpperCase(), headers, agent: agentFor(profile), timeout: timeoutMs },
      (response) => {
        const chunks: Buffer[] = [];
        // A connection that dies after the headers emits 'error'/'aborted' on the
        // response, not on the request; without this the promise never settles and
        // the transport slot is held until the Lambda times out.
        response.on('error', fail);
        response.on('aborted', () => fail(new Error('DB response aborted')));
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          let body: Buffer;
          try {
            body = decodeBody(Buffer.concat(chunks), String(response.headers['content-encoding'] ?? ''));
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
            return;
          }

          const responseHeaders: Array<[string, string]> = [];
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) for (const entry of value) responseHeaders.push([name, entry]);
            else if (value !== undefined) responseHeaders.push([name, String(value)]);
          }

          succeed(
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

    request.on('error', fail);
    request.on('timeout', () => request.destroy(new Error('DB request timed out')));
    if (init.body) request.write(init.body);
    request.end();
  });
}

// ---------------------------------------------------------------------------
// Cross-region proxy: invoke a Lambda whose egress DB accepts.
// ---------------------------------------------------------------------------

type LambdaSdk = typeof import('@aws-sdk/client-lambda');
let lambdaSdk: LambdaSdk | null = null;
const lambdaClients = new Map<string, InstanceType<LambdaSdk['LambdaClient']>>();

interface ProxyTarget {
  arn: string;
  region: string;
}

interface ProxyHealth {
  blockedUntil: number;
  preferredProfile: string | null;
}

const proxyHealth = new Map<string, ProxyHealth>();

function proxyTargets(): ProxyTarget[] {
  // An empty DB_PROXY_FUNCTIONS must fall back to the legacy single ARN, not
  // disable the proxy (which would send requests out from the app region).
  const raw = (process.env.DB_PROXY_FUNCTIONS?.trim() || process.env.DB_PROXY_FUNCTION?.trim() || '').trim();
  if (!raw) return [];
  const fallbackRegion = process.env.DB_PROXY_REGION?.trim() || 'us-east-1';
  const seen = new Set<string>();
  const targets: ProxyTarget[] = [];
  for (const value of raw.split(',')) {
    const arn = value.trim();
    if (!arn || seen.has(arn)) continue;
    seen.add(arn);
    const parts = arn.split(':');
    const region = parts.length >= 4 && parts[3] ? parts[3] : fallbackRegion;
    targets.push({ arn, region });
  }
  return targets;
}

function lambdaClientFor(region: string): InstanceType<LambdaSdk['LambdaClient']> {
  let client = lambdaClients.get(region);
  if (!client) {
    if (!lambdaSdk) throw new Error('Lambda SDK is not loaded');
    client = new lambdaSdk.LambdaClient({
      region,
      // The transport owns retries; do not multiply them at the SDK layer.
      maxAttempts: 1,
    });
    lambdaClients.set(region, client);
  }
  return client;
}

/** Regions that are not cooling down, in configured order. */
function availableProxyTargets(targets: ProxyTarget[]): ProxyTarget[] {
  const now = Date.now();
  return targets.filter((target) => (proxyHealth.get(target.arn)?.blockedUntil ?? 0) <= now);
}

function markProxyUnhealthy(target: ProxyTarget): void {
  const health = proxyHealth.get(target.arn) ?? { blockedUntil: 0, preferredProfile: null };
  health.blockedUntil = Date.now() + intFromEnv('DB_REGION_COOLDOWN_MS', 120_000);
  proxyHealth.set(target.arn, health);
}

function markProxyHealthy(target: ProxyTarget, usedProfile: string | null): void {
  const health = proxyHealth.get(target.arn) ?? { blockedUntil: 0, preferredProfile: null };
  health.blockedUntil = 0;
  if (usedProfile) health.preferredProfile = usedProfile;
  proxyHealth.set(target.arn, health);
}

/** Bounds one proxy invoke by the configured timeout and the caller's remaining budget. */
export function proxyInvokeTimeout(
  deadline: number,
  now = Date.now(),
  requestTimeoutMs = intFromEnv('DB_REQUEST_TIMEOUT_MS', 20_000)
): number {
  return Math.max(1, Math.min(requestTimeoutMs, deadline - now));
}

async function invokeProxy(
  target: ProxyTarget,
  url: string,
  init: FetchInit,
  deadline: number,
  profile: string | null
): Promise<{ response: FetchCompatibleResponse; usedProfile: string | null }> {
  if (!lambdaSdk) lambdaSdk = await import('@aws-sdk/client-lambda');

  // The SDK has no request timeout by default. Bound the invoke by the
  // per-attempt timeout and the caller's remaining budget so a slow proxy cannot
  // hold a user request past the API Gateway cap.
  const requestTimeout = proxyInvokeTimeout(deadline);
  const payload = JSON.stringify({
    url,
    method: init.method ?? 'GET',
    headers: init.headers ?? {},
    body: init.body,
    acceptEncoding: 'gzip',
    timeoutMs: requestTimeout,
    ...(profile ? { profile } : {}),
  });
  const result = await lambdaClientFor(target.region).send(
    new lambdaSdk.InvokeCommand({
      FunctionName: target.arn,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(payload),
    }),
    { abortSignal: AbortSignal.timeout(requestTimeout) }
  );

  if (result.FunctionError) {
    const raw = result.Payload ? Buffer.from(result.Payload).toString('utf8') : '';
    let message = result.FunctionError;
    try {
      const error = JSON.parse(raw) as { errorMessage?: string };
      if (typeof error.errorMessage === 'string' && error.errorMessage) message = error.errorMessage;
    } catch {
      // Keep the FunctionError name when the payload is not JSON.
    }
    if (isProxyThrottleError(message)) throw new DbThrottledError(message);
    throw new Error(`DB proxy failed: ${message}`);
  }

  const raw = result.Payload ? Buffer.from(result.Payload).toString('utf8') : '';
  let parsed: {
    status?: number;
    statusText?: string;
    contentType?: string | null;
    encoding?: 'gzip';
    body?: string;
    usedProfile?: string;
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new Error('DB proxy returned an invalid response');
  }
  if (typeof parsed.status !== 'number') throw new Error('DB proxy returned an invalid response');

  const body = decodeProxyBody(parsed.encoding, parsed.body);
  const bodyText = body.toString('utf8');
  if (
    typeof parsed.usedProfile === 'string' &&
    parsed.usedProfile &&
    !isThrottled(parsed.status, bodyText) &&
    parsed.status < 500
  ) {
    currentProfileName = parsed.usedProfile;
    if (profile && profile !== parsed.usedProfile) stats.profileRotations++;
  }

  const headers: Array<[string, string]> = parsed.contentType ? [['content-type', parsed.contentType]] : [];
  return {
    response: new FetchCompatibleResponse(parsed.status, parsed.statusText || String(parsed.status), bodyText, headers),
    usedProfile: typeof parsed.usedProfile === 'string' && parsed.usedProfile ? parsed.usedProfile : null,
  };
}

/** True when a proxy error means DB is throttling/refusing the egress. */
export function isProxyThrottleError(message: string): boolean {
  // Do not match generic network errors (ECONNREFUSED contains "refused"):
  // those are proxy failures, not a DB block.
  return /OPS_BLOCKED|throttl|breaker/i.test(message);
}

/** True when Lambda rejected the invoke because the proxy's concurrency limit was full. */
export function isProxyBusyError(error: unknown): boolean {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name?: unknown }).name ?? '')
      : '';
  return name === 'TooManyRequestsException';
}

/** Decodes the optional gzip/base64 proxy body; plain strings pass through. */
export function decodeProxyBody(encoding: 'gzip' | undefined, body: string | undefined): Buffer {
  return encoding === 'gzip' ? zlib.gunzipSync(Buffer.from(body ?? '', 'base64')) : Buffer.from(body ?? '');
}

async function proxyFetch(
  targets: ProxyTarget[],
  url: string,
  init: FetchInit,
  deadline: number
): Promise<FetchCompatibleResponse> {
  const maxRounds = Math.max(1, intFromEnv('DB_MAX_ATTEMPTS', 2));
  let lastResponse: FetchCompatibleResponse | null = null;
  let lastError: unknown = null;
  let sawThrottle = false;
  let sawNonThrottleFailure = false;
  let sawBusy = false;
  let attempted = 0;

  for (let round = 0; round < maxRounds && Date.now() < deadline; round++) {
    const available = availableProxyTargets(targets);
    if (available.length === 0) break;

    for (let index = 0; index < available.length && Date.now() < deadline; index++) {
      const target = available[index];
      if (index > 0) stats.regionRotations++;
      const profile = proxyHealth.get(target.arn)?.preferredProfile ?? null;
      const release = await acquireSlot();
      if (Date.now() >= deadline) {
        release();
        break;
      }
      try {
        attempted++;
        const { response, usedProfile } = await invokeProxy(target, url, init, deadline, profile);
        const bodyText = await response.text();
        const throttled = isThrottled(response.status, bodyText);

        if (!throttled && response.ok) {
          recordSuccess();
          stats.directOk++;
          markProxyHealthy(target, usedProfile);
          return response;
        }

        if (throttled) {
          stats.directThrottled++;
          sawThrottle = true;
          markProxyUnhealthy(target);
        } else {
          stats.directFailed++;
          sawNonThrottleFailure = true;
        }
        lastResponse = response;
        lastError = null;
        if (!throttled && response.status < 500) return response;
      } catch (error) {
        if (isProxyBusyError(error)) {
          // Our own concurrency cap, not a DB block. Do not penalise the region
          // or record a DB failure; the outer loop retries while budget remains.
          stats.proxyBusy++;
          sawBusy = true;
          lastError = error;
          lastResponse = null;
        } else if (error instanceof DbThrottledError) {
          // The proxy's own breaker is open. It answers in ~100 ms; retrying is
          // noise, and this is a block, not a generic failure.
          stats.directThrottled++;
          sawThrottle = true;
          markProxyUnhealthy(target);
          lastError = error;
          lastResponse = null;
        } else {
          // Network/timeout/FunctionError: cool the region briefly so a broken
          // proxy is not the first choice on every request.
          stats.directFailed++;
          sawNonThrottleFailure = true;
          markProxyUnhealthy(target);
          lastError = error;
          lastResponse = null;
        }
      } finally {
        release();
      }

      if (index < available.length - 1) stats.retries++;
    }

    if (round < maxRounds - 1 && Date.now() < deadline) {
      stats.retries++;
      await sleep(Math.min(intFromEnv('DB_RETRY_BACKOFF_MS', 3000) * (round + 1), Math.max(0, deadline - Date.now())));
    }
  }

  if (attempted === 0 || sawThrottle) {
    // Every region was cooling down, or DB throttled at least one of them:
    // stop the caller immediately instead of returning a raw 429/452 that the
    // poller would treat as a per-target error and keep hammering.
    openBreaker();
    throw new DbThrottledError();
  }

  if (sawBusy && !sawNonThrottleFailure) {
    throw new DbThrottledError('DB proxy is busy (Lambda concurrency limit)');
  }

  recordFailure();
  if (breakerOpen()) throw new DbThrottledError();
  if (lastResponse) return lastResponse;
  throw lastError instanceof Error ? lastError : new Error('DB proxy request failed');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function directFetch(url: string, init: FetchInit, deadline: number): Promise<FetchCompatibleResponse> {
  const maxAttempts = Math.max(1, intFromEnv('DB_MAX_ATTEMPTS', 2));
  let lastResponse: FetchCompatibleResponse | null = null;
  let lastError: unknown = null;
  let allProfilesBlocked = false;

  // Do not start an attempt that the shared wall-clock budget can no longer hold.
  for (let attempt = 1; attempt <= maxAttempts && Date.now() < deadline; attempt++) {
    const release = await acquireSlot();
    if (Date.now() >= deadline) {
      release();
      break;
    }
    try {
      const candidates = availableProfiles();
      if (candidates.length === 0) {
        // Every profile is cooling down after OPS_BLOCKED; do not spend the
        // budget on another guaranteed refusal. The caller must stop the batch.
        stats.directThrottled++;
        allProfilesBlocked = true;
        lastResponse = null;
        lastError = null;
        break;
      }

      let response: FetchCompatibleResponse | null = null;
      let bodyText = '';
      let throttleRotations = 0;
      const maxThrottleRotations = intFromEnv('DB_PROFILE_THROTTLE_ROTATIONS', 2);

      // Rotate through the profiles until DB accepts one. A refused profile is
      // put on cooldown; a 429 also rotates (another fingerprint has its own
      // bucket) but is not marked blocked.
      for (let index = 0; index < candidates.length; index++) {
        if (index > 0) stats.profileRotations++;
        const profile = candidates[index];
        response = await directOnce(url, init, profile, deadline);
        bodyText = await response.text();

        if (isFingerprintBlocked(response.status, bodyText)) {
          markProfileBlocked(profile);
          if (index === candidates.length - 1 || Date.now() >= deadline) break;
          continue;
        }

        if (
          response.status === 429 &&
          throttleRotations < maxThrottleRotations &&
          index < candidates.length - 1 &&
          Date.now() < deadline
        ) {
          throttleRotations++;
          continue;
        }

        if (!isThrottled(response.status, bodyText) && response.status < 500) {
          currentProfileName = profile.name;
        }
        break;
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

  if (allProfilesBlocked) throw new DbThrottledError();
  recordFailure();
  if (breakerOpen()) throw new DbThrottledError();
  if (lastResponse) return lastResponse;
  throw lastError instanceof Error ? lastError : new Error('DB request failed');
}

export async function fetch(url: string, init: FetchInit = {}): Promise<FetchCompatibleResponse> {
  const deadline = Date.now() + intFromEnv('DB_TOTAL_BUDGET_MS', 24_000);

  if (breakerOpen()) {
    stats.breakerSkips++;
    throw new DbThrottledError();
  }

  const targets = proxyTargets();
  if (targets.length > 0) return proxyFetch(targets, url, init, deadline);
  return directFetch(url, init, deadline);
}

export { FetchCompatibleRequest as Request };
