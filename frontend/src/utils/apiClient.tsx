import { authExchange } from '@urql/exchange-auth';
import * as auth from '../utils/auth';
import { isJwtExpired } from '../utils/jwt';
import { Client, cacheExchange, fetchExchange } from 'urql';

const apiGatewayEndpoint = `${process.env.REACT_APP_GRAPHQL_ENDPOINT!}graphql`;

const getJwtToken = async (forceRefresh = false) => {
  try {
    const session = await auth.getSession({ forceRefresh });
    return session?.getIdToken().getJwtToken();
  } catch {
    if (!forceRefresh) {
      // Ignore errors - the token stays undefined.
      return undefined;
    }

    // A forced refresh can fail transiently while the cached session is still
    // usable for a few seconds. Fall back to it rather than signing the user out.
    try {
      const cachedSession = await auth.getSession();
      return cachedSession?.getIdToken().getJwtToken();
    } catch {
      return undefined;
    }
  }
};

const cognitoAuthExchange = authExchange(async (utils) => {
  let token = await getJwtToken();

  return {
    addAuthToOperation(operation) {
      if (!token) return operation;
      return utils.appendHeaders(operation, {
        Authorization: token,
      });
    },
    didAuthError(error, _operation) {
      return error.response?.status && error.response?.status === 401;
    },
    async refreshAuth() {
      // Force the refresh-token exchange: Cognito's getSession would otherwise
      // return the cached ID token while it is still valid, including inside the
      // early-expiry window that triggered this refresh.
      token = await getJwtToken(true);
      if (!token) auth.signOut();
    },
    // Cognito ID tokens expire after 60 minutes. `willAuthError` runs before the
    // request is sent, so refreshing here avoids a guaranteed 401 and the extra
    // round-trip that `didAuthError` would need to recover from it.
    willAuthError() {
      return isJwtExpired(token);
    },
  };
});

export const client = new Client({
  url: apiGatewayEndpoint,
  exchanges: [cacheExchange, cognitoAuthExchange, fetchExchange],
});
