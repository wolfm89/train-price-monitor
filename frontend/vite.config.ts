import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '', '');
  return {
    plugins: [react()],
    server: {
      port: 3000,
      host: true,
    },
    build: {
      outDir: 'build',
      sourcemap: true,
      chunkSizeWarningLimit: 1200,
    },
    optimizeDeps: {
      include: ['amazon-cognito-identity-js'],
    },
    define: {
      global: 'globalThis',
      'process.env.REACT_APP_GRAPHQL_ENDPOINT': JSON.stringify(env.REACT_APP_GRAPHQL_ENDPOINT),
      'process.env.REACT_APP_COGNITO_USER_POOL_ID': JSON.stringify(env.REACT_APP_COGNITO_USER_POOL_ID),
      'process.env.REACT_APP_COGNITO_IDENTITY_POOL_ID': JSON.stringify(env.REACT_APP_COGNITO_IDENTITY_POOL_ID),
      'process.env.REACT_APP_COGNITO_CLIENT_ID': JSON.stringify(env.REACT_APP_COGNITO_CLIENT_ID),
      'process.env.PUBLIC_URL': JSON.stringify(''),
    },
  };
});
