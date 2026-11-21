import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, '', '');
  // The proxy runs in Vite's process, not the browser. Compose starts the dev
  // server in a container where the backend is a separate service, so the
  // target is overridable there; laptop and Coder use the loopback default.
  const devBackendUrl = env.VITE_DEV_BACKEND_URL || 'http://127.0.0.1:4000';
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
      // request is same-origin and Vite talks to the backend.
      // `localhost`/IP hosts stay allowed, and other Coder deployments can add
      // their suffix through __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS.
      allowedHosts: ['.coder.local.home'],
      proxy: {
        '/graphql': devBackendUrl,
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
      // Dev always talks to the local proxy (same origin); builds keep the
      // configured endpoint. `command`, not `mode`, so a build with a custom
      // mode still bakes the real API URL.
      'process.env.REACT_APP_GRAPHQL_ENDPOINT': JSON.stringify(
        command === 'serve' ? '/' : env.REACT_APP_GRAPHQL_ENDPOINT
      ),
      'process.env.REACT_APP_COGNITO_USER_POOL_ID': JSON.stringify(cognitoUserPoolId),
      'process.env.REACT_APP_COGNITO_IDENTITY_POOL_ID': JSON.stringify(cognitoIdentityPoolId),
      'process.env.REACT_APP_COGNITO_CLIENT_ID': JSON.stringify(cognitoClientId),
      'process.env.PUBLIC_URL': JSON.stringify(''),
    },
  };
});
