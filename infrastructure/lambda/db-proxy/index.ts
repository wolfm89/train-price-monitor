import { fetch } from '../../../shared/db-fetch';

export interface DbProxyRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface DbProxyResponse {
  status: number;
  contentType: string | null;
  body: string;
}

/**
 * Lambda handler for the DB egress proxy.
 *
 * DB's Akamai edge refuses some Lambda regions (and Decodo) on the Navigator
 * API. This function runs in the configured DB proxy region and performs the
 * HTTPS request from an egress DB accepts for that region.
 *
 * The handler returns only status, content type and body: those are the fields
 * db-vendo-client's `request` uses.
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

  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: await response.text(),
  };
}
