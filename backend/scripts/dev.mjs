// Local dev server: rebuild the bundle on every change (esbuild watch) and run it
// with Node, so the code path, the `cross-fetch` transport alias and the Lambda
// entry point are identical to production.
//
// `LOCAL_DEV=1` makes `src/main.ts` start an HTTP server on `PORT` (default 4000);
// .mise.toml's dev task sets both, and the defaults below cover plain `npm run dev`.
import { context } from 'esbuild';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { bundleOptions } from './esbuild.config.mjs';

const entry = path.resolve(bundleOptions.absWorkingDir, bundleOptions.outfile);

const childEnv = {
  ...process.env,
  NODE_ENV: 'development',
  LOCAL_DEV: process.env.LOCAL_DEV ?? '1',
  PORT: process.env.PORT ?? '4000',
};

let child;
let restarting = false;
let firstBuildDone = false;

function start() {
  const proc = spawn(process.execPath, ['--enable-source-maps', entry], {
    stdio: 'inherit',
    env: childEnv,
  });
  child = proc;
  proc.on('exit', (code, signal) => {
    if (child === proc) child = undefined;
    if (!restarting && signal === null && code !== 0) {
      console.error(`backend exited with code ${code}; waiting for the next successful build`);
    }
  });
}

function restart() {
  const proc = child;
  if (!proc) {
    start();
    return;
  }
  if (restarting) return;
  restarting = true;
  // Start the next one only after the old process released the port.
  proc.once('exit', () => {
    restarting = false;
    start();
  });
  proc.kill('SIGTERM');
}

const ctx = await context({
  ...bundleOptions,
  minify: false,
  plugins: [
    {
      name: 'restart-backend',
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length > 0) return;
          if (!firstBuildDone) {
            firstBuildDone = true;
            start();
          } else {
            restart();
          }
        });
      },
    },
  ],
});

await ctx.watch();

const shutdown = async () => {
  restarting = true;
  child?.kill('SIGTERM');
  await ctx.dispose();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
