import { gzipSync } from 'node:zlib';
import { fetch } from '../../../shared/db-fetch';

export interface DbProxyRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** The new caller advertises gzip; old deployed callers omit it. */
  acceptEncoding?: string;
  /** The caller's remaining budget; bounds the proxy's own DB request. */
  timeoutMs?: number;
}

export interface DbProxyResponse {
  status: number;
  statusText: string;
  contentType: string | null;
  encoding?: 'gzip';
  body: string;
}

/**
 * Lambda handler for the DB egress proxy.
 *
 * DB's Akamai edge refuses some Lambda regions (and Decodo) on the Navigator
 * API. This function runs in the configured DB proxy region and performs the
 * HTTPS request from an egress DB accepts for that region.
 *
 * The body is gzipped only when the caller advertises support, so callers
 * deployed before the gzip change keep receiving plain JSON during a rolling
 * deploy. The handler returns only status, content type and body: those are the
 * fields db-vendo-client's `request` uses.
 */
export async function handler(event: DbProxyRequest): Promise<DbProxyResponse> {
  if (!event || typeof event.url !== 'string' || event.url.length === 0) {
    throw new Error('DB proxy request is missing a URL');
  }

  const timeoutMs =
    typeof event.timeoutMs === 'number' && Number.isFinite(event.timeoutMs)
      ? Math.max(1_000, Math.floor(event.timeoutMs))
      : 15_000;
  const previousTotal = process.env.DB_TOTAL_BUDGET_MS;
  const previousRequest = process.env.DB_REQUEST_TIMEOUT_MS;
  process.env.DB_TOTAL_BUDGET_MS = String(timeoutMs);
  process.env.DB_REQUEST_TIMEOUT_MS = String(timeoutMs);

  try {
    const response = await fetch(event.url, {
      method: event.method ?? 'GET',
      headers: event.headers ?? {},
      body: event.body,
    });
    const body = await response.text();
    const common = {
      status: response.status,
      statusText: `${response.status} ${response.statusText}`.trim(),
      contentType: response.headers.get('content-type'),
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
  }
}
