// Production bundle for the Lambda image: `npm run build` runs codegen first
// (prebuild runs the generated station index and schema) and then this script.
import { build } from 'esbuild';
import { bundleOptions } from './esbuild.config.mjs';

await build({ ...bundleOptions, minify: true });
