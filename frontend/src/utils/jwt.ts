export interface JwtPayload {
  exp?: number;
  [claim: string]: unknown;
}

/**
 * Decodes the payload of a JWT without verifying its signature.
 *
 * The frontend only needs the `exp` claim to decide whether to refresh before a
 * request; the token is still verified by API Gateway. Returns `null` for
 * malformed tokens so callers can treat them as unusable.
 */
export function decodeJwtPayload(token: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;

  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const payload: unknown = JSON.parse(atob(padded));
    return typeof payload === 'object' && payload !== null ? (payload as JwtPayload) : null;
  } catch {
    return null;
  }
}

/**
 * True when a token is missing, malformed, or at (or within `skewSeconds` of)
 * its `exp` claim. The skew refreshes a little early so a token cannot expire
 * between building the request and API Gateway validating it.
 */
export function isJwtExpired(token: string | null | undefined, nowMs: number = Date.now(), skewSeconds = 30): boolean {
  if (!token) return true;
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== 'number') return true;
  return nowMs / 1000 >= payload.exp - skewSeconds;
}
