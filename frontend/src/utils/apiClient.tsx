import { authExchange } from '@urql/exchange-auth';
import * as auth from '../utils/auth';
import { isJwtExpired } from '../utils/jwt';
import { Client, cacheExchange, fetchExchange } from 'urql';

const apiGatewayEndpoint = `${process.env.REACT_APP_GRAPHQL_ENDPOINT!}graphql`;

const getJwtToken = async () => {
  let session;
  try {
    session = await auth.getSession();
  } catch {
    // Ignore errors - session will be undefined
  }
  return session?.getIdToken().getJwtToken();
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
      token = await getJwtToken();
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
