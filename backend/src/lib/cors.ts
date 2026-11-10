/** Used when CORS_ALLOWED_ORIGINS is unset, i.e. the local dev server. */
const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];

export const CORS_METHODS = ['GET', 'POST', 'OPTIONS'];
export const CORS_ALLOWED_HEADERS = ['Content-Type', 'Authorization', 'X-Api-Key'];

/** Parses the comma-separated CORS_ALLOWED_ORIGINS value the stack sets. */
export function parseAllowedOrigins(value: string | undefined): string[] {
  const origins = (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : DEFAULT_ALLOWED_ORIGINS;
}

/** Reads the Origin header from API Gateway headers, whose case varies by payload version. */
export function requestOrigin(headers: Record<string, string | undefined> | null | undefined): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'origin');
  return key ? headers[key] : undefined;
}

/**
 * CORS headers for responses the Lambda builds itself (Yoga adds its own).
 * The origin is echoed only when it is on the allowlist; otherwise the header
 * is omitted and the browser blocks the response.
 */
export function corsHeaders(origin: string | undefined, allowedOrigins: string[]): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': CORS_METHODS.join(', '),
    'Access-Control-Allow-Headers': CORS_ALLOWED_HEADERS.join(', '),
    Vary: 'Origin',
  };
  if (origin && allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}
