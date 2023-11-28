import { authExchange } from '@urql/exchange-auth';
import * as auth from '../utils/auth';
import { Client, cacheExchange, fetchExchange } from 'urql';

const apiGatewayEndpoint = `${process.env.REACT_APP_API_GATEWAY_ENDPOINT!}graphql`;

const getJwtToken = async () => {
  let session;
  try {
    session = await auth.getSession();
  } catch (error) {}
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
      return error.graphQLErrors.some((e) => e.extensions?.code === 'FORBIDDEN');
    },
    async refreshAuth() {
      token = await getJwtToken();
      if (!token) auth.signOut();
    },
    willAuthError(_operation) {
      return !token;
    },
  };
});

export const client = new Client({
  url: apiGatewayEndpoint,
  exchanges: [cacheExchange, cognitoAuthExchange, fetchExchange],
});
