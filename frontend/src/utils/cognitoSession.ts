export interface CognitoRefreshTokenLike {
  getToken(): string;
}

export interface CognitoSessionLike<RefreshToken extends CognitoRefreshTokenLike> {
  getRefreshToken(): RefreshToken | null | undefined;
}

export interface RefreshableCognitoUser<
  Session extends CognitoSessionLike<RefreshToken>,
  RefreshToken extends CognitoRefreshTokenLike,
> {
  getSession(callback: (error: Error | null, session: Session | null) => void): void;
  refreshSession(refreshToken: RefreshToken, callback: (error: Error | null, session: Session | null) => void): void;
}

/**
 * Loads the current Cognito session, optionally forcing a refresh-token exchange.
 *
 * `CognitoUser.getSession` returns the cached session while it is still valid, so
 * it cannot refresh a token that is about to expire. Passing `forceRefresh`
 * performs the refresh-token exchange explicitly; if no refresh token is
 * available the cached session is still returned so the caller can decide what
 * to do.
 */
export function loadCognitoSession<
  Session extends CognitoSessionLike<RefreshToken>,
  RefreshToken extends CognitoRefreshTokenLike,
>(user: RefreshableCognitoUser<Session, RefreshToken>, forceRefresh = false): Promise<Session | null> {
  return new Promise((resolve, reject) => {
    user.getSession((error, session) => {
      if (error) {
        reject(error);
        return;
      }
      if (!forceRefresh || !session) {
        resolve(session);
        return;
      }

      const refreshToken = session.getRefreshToken();
      if (!refreshToken?.getToken()) {
        resolve(session);
        return;
      }

      user.refreshSession(refreshToken, (refreshError, refreshedSession) => {
        if (refreshError) {
          reject(refreshError);
          return;
        }
        resolve(refreshedSession);
      });
    });
  });
}
