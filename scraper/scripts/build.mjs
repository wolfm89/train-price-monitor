import * as esbuild from 'esbuild';

// These packages are provided by the Lambda Node.js 24 runtime and must not
// be bundled. Externalizing them keeps the bundle small and avoids version
// conflicts with the runtime-supplied SDK.
const external = ['@aws-sdk/client-dynamodb', '@aws-sdk/lib-dynamodb', '@aws-sdk/client-s3'];

const sharedConfig = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  external,
};

await esbuild.build({
  ...sharedConfig,
  entryPoints: ['src/hydrator.ts'],
  outfile: 'dist/hydrator/index.mjs',
});

await esbuild.build({
  ...sharedConfig,
  entryPoints: ['src/poller.ts'],
  outfile: 'dist/poller/index.mjs',
  // Banner required because of a CJS/ESM mismatch in the dependency tree:
  //
  // The bundle MUST use ESM format (.mjs) because hyparquet-writer is ESM-only
  // and cannot be require()'d from CJS. However, db-vendo-client pulls in CJS
  // transitive deps (qs → object-inspect) that call require('util') at runtime,
  // which is not available in ESM scope. The banner injects a CJS-compatible
  // require() shim at the top of the bundle so those calls succeed.
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
});

await esbuild.build({
  ...sharedConfig,
  entryPoints: ['src/compactor.ts'],
  outfile: 'dist/compactor/index.mjs',
});
