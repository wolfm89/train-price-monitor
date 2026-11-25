import { gzipSync } from 'node:zlib';
import { fetch } from '../../../shared/db-fetch';

export interface DbProxyRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface DbProxyResponse {
  status: number;
  statusText: string;
  contentType: string | null;
  encoding: 'gzip';
  body: string;
}

/**
 * Lambda handler for the DB egress proxy.
 *
 * DB's Akamai edge refuses some Lambda regions (and Decodo) on the Navigator
 * API. This function runs in the configured DB proxy region and performs the
 * HTTPS request from an egress DB accepts for that region.
 *
 * The body is gzipped and base64-encoded to keep cross-region response traffic
 * small; the caller decompresses it. The handler returns only status, content
 * type and body: those are the fields db-vendo-client's `request` uses.
 */
export async function handler(event: DbProxyRequest): Promise<DbProxyResponse> {
  if (!event || typeof event.url !== 'string' || event.url.length === 0) {
    throw new Error('DB proxy request is missing a URL');
  }

  const response = await fetch(event.url, {
    method: event.method ?? 'GET',
    headers: event.headers ?? {},
    body: event.body,
  });
  const body = await response.text();

  return {
    status: response.status,
    statusText: `${response.status} ${response.statusText}`.trim(),
    contentType: response.headers.get('content-type'),
    encoding: 'gzip',
    body: gzipSync(Buffer.from(body, 'utf8')).toString('base64'),
  };
}
