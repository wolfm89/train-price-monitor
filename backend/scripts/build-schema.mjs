// Generates backend/src/schema/schema.generated.json, the SDL bundled into the
// Lambda instead of being read from disk at cold start.
//
// Why: main.ts used `readFileSync('src/schema/schema.graphql')`, a path relative
// to the process cwd. It worked only because the Dockerfile copied the file to
// the same relative location in the task root; any packaging or cwd change would
// turn it into an ENOENT at module init. A JSON string import is bundled by
// esbuild, so the bundle is self-contained.
//
// Regenerate with:  npm run schema   (in backend/)
//
// The output is deliberately NOT committed: `pretypecheck`, `prebuild`, `predev`
// and `prestart` run it, so every local and CI build has it. It is tiny (~15 KB)
// and a single JSON string, so parsing costs nothing measurable.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../src/schema/schema.graphql', import.meta.url));
const target = fileURLToPath(new URL('../src/schema/schema.generated.json', import.meta.url));

const sdl = readFileSync(source, 'utf8');
writeFileSync(target, JSON.stringify(sdl));

console.log(`schema.generated.json: ${sdl.length} characters of SDL -> ${target}`);
