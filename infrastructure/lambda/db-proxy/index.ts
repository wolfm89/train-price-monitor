import { gzipSync } from 'node:zlib';
import { activeTlsProfileName, fetch } from '../../../shared/db-fetch';

export interface DbProxyRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** The new caller advertises gzip; old deployed callers omit it. */
  acceptEncoding?: string;
  /** The caller's remaining budget; bounds the proxy's own DB request. */
  timeoutMs?: number;
  /**
   * The TLS profile that worked last time for this caller. It is only a hint:
   * the transport falls back to the configured order and rotates on a refusal.
   */
  profile?: string;
}

export interface DbProxyResponse {
  status: number;
  statusText: string;
  contentType: string | null;
  encoding?: 'gzip';
  body: string;
  /** The profile that served the request; the caller remembers it per region. */
  usedProfile: string;
}

/**
 * Lambda handler for the DB egress proxy.
 *
 * DB's Akamai edge refuses some Lambda regions on the Navigator API and
 * rate-limits the egress it accepts. This function runs in one configured proxy
 * region, performs the HTTPS request and reports the TLS fingerprint that
 * served it so the caller can remember it for this region.
 *
 * The body is gzipped only when the caller advertises support, so callers
 * deployed before the gzip change keep receiving plain JSON during a rolling
 * deploy. The handler returns only status, content type and body: those are the
 * fields db-vendo-client's `request` uses.
 */
const DB_PROXY_HOST = 'app.services-bahn.de';
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** The proxy is not a generic relay: only the Navigator API, GET/POST, https/443. */
function validateTarget(rawUrl: string, method: string): void {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    throw new Error('DB proxy received an invalid URL');
  }
  if (target.protocol !== 'https:') throw new Error('DB proxy only forwards HTTPS URLs');
  if (target.hostname !== DB_PROXY_HOST) throw new Error('DB proxy only forwards to the Navigator API host');
  if (target.username || target.password) throw new Error('DB proxy rejects URL credentials');
  if (target.port && target.port !== '443') throw new Error('DB proxy rejects non-443 ports');
  if (!['GET', 'POST'].includes(method)) throw new Error('DB proxy only forwards GET and POST');
}

export async function handler(event: DbProxyRequest): Promise<DbProxyResponse> {
  if (!event || typeof event.url !== 'string' || event.url.length === 0) {
    throw new Error('DB proxy request is missing a URL');
  }

  const method = (event.method ?? 'GET').toUpperCase();
  validateTarget(event.url, method);
  if (typeof event.body === 'string' && Buffer.byteLength(event.body) > MAX_BODY_BYTES) {
    throw new Error('DB proxy request body exceeds the size limit');
  }

  const requestedTimeoutMs =
    typeof event.timeoutMs === 'number' && Number.isFinite(event.timeoutMs) ? Math.floor(event.timeoutMs) : 15_000;
  // The Lambda timeout is 20 s. Cap the inner DB request at 15 s so the proxy
  // can return a structured response before the caller and Lambda time out.
  const timeoutMs = Math.min(Math.max(1_000, requestedTimeoutMs), 15_000);
  const previousTotal = process.env.DB_TOTAL_BUDGET_MS;
  const previousRequest = process.env.DB_REQUEST_TIMEOUT_MS;
  const previousProfile = process.env.DB_TLS_PROFILE;
  process.env.DB_TOTAL_BUDGET_MS = String(timeoutMs);
  process.env.DB_REQUEST_TIMEOUT_MS = String(timeoutMs);
  // Per-invocation hint: the caller remembers which profile worked for this
  // region and sends it back. The transport still rotates to the rest on a
  // refusal or a 429, so a stale hint is safe.
  if (typeof event.profile === 'string' && /^[a-z0-9]{3,12}$/.test(event.profile)) {
    process.env.DB_TLS_PROFILE = event.profile;
  }

  try {
    const response = await fetch(event.url, {
      method,
      headers: event.headers ?? {},
      body: event.body,
    });
    const body = await response.text();
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      throw new Error('DB proxy response exceeds the size limit');
    }
    const common = {
      status: response.status,
      statusText: `${response.status} ${response.statusText}`.trim(),
      contentType: response.headers.get('content-type'),
      usedProfile: activeTlsProfileName(),
    };

    if (event.acceptEncoding === 'gzip') {
      return {
        ...common,
        encoding: 'gzip',
        body: gzipSync(Buffer.from(body, 'utf8')).toString('base64'),
      };
    }
    return { ...common, body };
  } finally {
    if (previousTotal === undefined) delete process.env.DB_TOTAL_BUDGET_MS;
    else process.env.DB_TOTAL_BUDGET_MS = previousTotal;
    if (previousRequest === undefined) delete process.env.DB_REQUEST_TIMEOUT_MS;
    else process.env.DB_REQUEST_TIMEOUT_MS = previousRequest;
    if (previousProfile === undefined) delete process.env.DB_TLS_PROFILE;
    else process.env.DB_TLS_PROFILE = previousProfile;
  }
}
