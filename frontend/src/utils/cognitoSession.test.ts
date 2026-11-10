import { describe, expect, it, vi } from 'vitest';
import { loadCognitoSession } from './cognitoSession';
import type { CognitoRefreshTokenLike, CognitoSessionLike } from './cognitoSession';

interface FakeRefreshToken extends CognitoRefreshTokenLike {
  token: string;
}

interface FakeSession extends CognitoSessionLike<FakeRefreshToken> {
  id: string;
}

const refreshToken: FakeRefreshToken = { token: 'refresh-token', getToken: () => 'refresh-token' };
const cachedSession: FakeSession = { id: 'cached', getRefreshToken: () => refreshToken };
const refreshedSession: FakeSession = { id: 'refreshed', getRefreshToken: () => refreshToken };

function sessionUser(
  session: FakeSession | null = cachedSession,
  refreshResult: FakeSession | null = refreshedSession,
  refreshError: Error | null = null
) {
  return {
    getSession: vi.fn((callback: (error: Error | null, value: FakeSession | null) => void) => callback(null, session)),
    refreshSession: vi.fn(
      (_token: FakeRefreshToken, callback: (error: Error | null, value: FakeSession | null) => void) =>
        callback(refreshError, refreshResult)
    ),
  };
}

describe('loadCognitoSession', () => {
  it('returns the cached session without calling refreshSession by default', async () => {
    const user = sessionUser();
    const session = await loadCognitoSession(user);

    expect(session).toBe(cachedSession);
    expect(user.getSession).toHaveBeenCalledOnce();
    expect(user.refreshSession).not.toHaveBeenCalled();
  });

  it('forces a refresh-token exchange when requested', async () => {
    const user = sessionUser();
    const session = await loadCognitoSession(user, true);

    expect(session).toBe(refreshedSession);
    expect(user.refreshSession).toHaveBeenCalledOnce();
    expect(user.refreshSession).toHaveBeenCalledWith(refreshToken, expect.any(Function));
  });

  it('falls back to the cached session when there is no refresh token', async () => {
    const sessionWithoutRefreshToken: FakeSession = { id: 'no-refresh', getRefreshToken: () => null };
    const user = sessionUser(sessionWithoutRefreshToken);

    await expect(loadCognitoSession(user, true)).resolves.toBe(sessionWithoutRefreshToken);
    expect(user.refreshSession).not.toHaveBeenCalled();
  });

  it('rejects when the refresh-token exchange fails', async () => {
    const user = sessionUser(cachedSession, null, new Error('NotAuthorizedException'));

    await expect(loadCognitoSession(user, true)).rejects.toThrow('NotAuthorizedException');
  });

  it('rejects when the cached session cannot be loaded', async () => {
    const user = {
      getSession: vi.fn((callback: (error: Error | null, value: FakeSession | null) => void) =>
        callback(new Error('No user found'), null)
      ),
      refreshSession: vi.fn(),
    };

    await expect(loadCognitoSession(user)).rejects.toThrow('No user found');
  });
});
