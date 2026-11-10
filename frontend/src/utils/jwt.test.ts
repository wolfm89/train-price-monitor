import { describe, expect, it } from 'vitest';
import { decodeJwtPayload, isJwtExpired } from './jwt';

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function tokenWithPayload(payload: unknown): string {
  return [encode({ alg: 'none', typ: 'JWT' }), encode(payload), 'signature'].join('.');
}

describe('decodeJwtPayload', () => {
  it('decodes the payload of a well-formed token', () => {
    const token = tokenWithPayload({ sub: 'user-1', exp: 1_800_000_000 });
    expect(decodeJwtPayload(token)).toMatchObject({ sub: 'user-1', exp: 1_800_000_000 });
  });

  it('returns null for malformed tokens', () => {
    expect(decodeJwtPayload('not-a-jwt')).toBeNull();
    expect(decodeJwtPayload('header.%%%not-base64%%%.signature')).toBeNull();
    expect(decodeJwtPayload('header.bnVsbA.signature')).toBeNull();
  });
});

describe('isJwtExpired', () => {
  const now = Date.UTC(2026, 10, 10, 12, 0, 0);
  const exp = Math.floor(now / 1000) + 3600;

  it('accepts a token that is valid for a while', () => {
    expect(isJwtExpired(tokenWithPayload({ exp }), now)).toBe(false);
  });

  it('rejects a token whose exp has passed', () => {
    expect(isJwtExpired(tokenWithPayload({ exp: Math.floor(now / 1000) - 1 }), now)).toBe(true);
  });

  it('rejects a token close enough to expiry that the request could race it', () => {
    expect(isJwtExpired(tokenWithPayload({ exp: Math.floor(now / 1000) + 20 }), now)).toBe(true);
  });

  it('treats missing, malformed and exp-less tokens as expired', () => {
    expect(isJwtExpired(undefined, now)).toBe(true);
    expect(isJwtExpired(null, now)).toBe(true);
    expect(isJwtExpired('garbage', now)).toBe(true);
    expect(isJwtExpired(tokenWithPayload({ sub: 'no-exp' }), now)).toBe(true);
    expect(isJwtExpired(tokenWithPayload({ exp: 'soon' }), now)).toBe(true);
  });
});
