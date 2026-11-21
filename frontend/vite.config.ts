import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '', '');
  // Cognito values are provided by CI as REACT_APP_* secrets and by the
  // locally generated frontend/.env (scripts/generate-local-env.sh) as
  // unprefixed COGNITO_* names. Support both so builds work in either place.
  const cognitoUserPoolId = env.REACT_APP_COGNITO_USER_POOL_ID ?? env.COGNITO_USER_POOL_ID;
  const cognitoIdentityPoolId = env.REACT_APP_COGNITO_IDENTITY_POOL_ID ?? env.COGNITO_IDENTITY_POOL_ID;
  const cognitoClientId = env.REACT_APP_COGNITO_CLIENT_ID ?? env.COGNITO_CLIENT_ID;
  return {
    plugins: [react()],
    server: {
      port: 3000,
      host: true,
      // Coder's app proxy requires the session cookie, and a CORS preflight
      // never carries one, so the browser cannot reach the backend app
      // cross-origin. Proxy GraphQL through this dev server instead: the
      // request is same-origin and Vite talks to the backend on loopback.
      // `localhost`/IP hosts stay allowed, so running the dev server on a
      // laptop is unaffected.
      allowedHosts: ['.coder.local.home'],
      proxy: {
        '/graphql': 'http://127.0.0.1:4000',
        '/health': 'http://127.0.0.1:4000',
      },
    },
    build: {
      outDir: 'build',
      sourcemap: false,
      chunkSizeWarningLimit: 500,
      rollupOptions: {
        output: {
          // Split the monolithic bundle into independently cacheable chunks.
          // Each chunk is named with a content hash so CloudFront's 1-year cache
          // policy only needs to be invalidated when that chunk actually changes.
          manualChunks(id) {
            if (
              id.includes('node_modules/react/') ||
              id.includes('node_modules/react-dom/') ||
              id.includes('node_modules/react-router') ||
              id.includes('node_modules/amazon-cognito-identity-js/') ||
              id.includes('node_modules/lodash')
            ) {
              return 'vendor';
            }
            if (id.includes('node_modules/@mui/') || id.includes('node_modules/@emotion/')) {
              return 'mui';
            }
            if (id.includes('node_modules/urql') || id.includes('node_modules/@urql/')) {
              return 'urql';
            }
          },
        },
      },
    },
    optimizeDeps: {
      include: ['amazon-cognito-identity-js'],
    },
    define: {
      global: 'globalThis',
      // Dev always talks to the local proxy (same origin); production keeps the
      // configured endpoint. This makes `mise run env:local` rewrites harmless.
      'process.env.REACT_APP_GRAPHQL_ENDPOINT': JSON.stringify(
        mode === 'development' ? '/' : env.REACT_APP_GRAPHQL_ENDPOINT
      ),
      'process.env.REACT_APP_COGNITO_USER_POOL_ID': JSON.stringify(cognitoUserPoolId),
      'process.env.REACT_APP_COGNITO_IDENTITY_POOL_ID': JSON.stringify(cognitoIdentityPoolId),
      'process.env.REACT_APP_COGNITO_CLIENT_ID': JSON.stringify(cognitoClientId),
      'process.env.PUBLIC_URL': JSON.stringify(''),
    },
  };
});
