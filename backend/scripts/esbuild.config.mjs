// The backend bundle, defined once and used by `npm run build` (scripts/build.mjs)
// and `npm run dev` (scripts/dev.mjs), so the local dev server runs exactly the
// code the Lambda runs — including the `cross-fetch` alias below.
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const bundleOptions = {
  absWorkingDir: backendRoot,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  platform: 'node',
  target: 'es2020',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  // db-vendo-client imports `cross-fetch`. The alias swaps in the Node-https
  // transport with browser-like TLS profiles and the Decodo fallback; without it
  // DB's edge answers 403 OPS_BLOCKED.
  alias: { 'cross-fetch': '../shared/db-fetch.ts' },
  // Provided by the Node 24 runtime or needed at runtime as-is; bundling them
  // breaks the Lambdas (see AGENTS.md).
  external: ['gps-distance', 'https-proxy-agent', 'luxon', '@aws-sdk/client-ssm', 'qs', 'slugg'],
};
