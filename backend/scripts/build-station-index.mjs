// Generates backend/src/stations/stations.json — the station index behind the
// `locations` autocomplete — from the db-hafas-stations package.
//
// Why a generated file instead of reading the package at runtime:
//   db-hafas-stations ships data.ndjson (13.5 MB, 292,625 stations) and is read
//   with a streaming ndjson parser that rebuilds one object per line. That cost
//   ~1.1 s on the first `locations` call in every cold Lambda environment, and
//   the package adds 133 MB to the image.
//
//   The index below keeps only stations with a meaningful weight (the rest are
//   bus stops and POIs, irrelevant for a rail price monitor), in the most compact
//   shape that still parses quickly: an array of [id, name, weight] tuples.
//   Measured: ~0.66 MiB and ~20 ms to parse, versus 13.5 MB and ~1,100 ms.
//
// Regenerate with:  npm run stations   (in backend/)
//
// The output is deliberately NOT committed (it is 0.67 MiB, and the repo's
// pre-commit hook rejects files above 500 KB). `pretypecheck` and `prebuild`
// run this script, so `npm run typecheck` and `npm run build` always have it,
// locally and in CI. The package it reads from is a devDependency, so it is
// present wherever those run and never ships.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Stations below this weight are overwhelmingly bus stops, tram stops and POIs
// rather than rail stations. Raise it to shrink the index further, lower it if a
// real station ever goes missing from autocomplete.
const MIN_WEIGHT = Number(process.env.MIN_WEIGHT ?? 1);

const here = dirname(fileURLToPath(import.meta.url));
const source = fileURLToPath(new URL('../node_modules/db-hafas-stations/data.ndjson', import.meta.url));
const target = fileURLToPath(new URL('../src/stations/stations.json', import.meta.url));

const rows = readFileSync(source, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((station) => typeof station[2] === 'number' && station[2] >= MIN_WEIGHT);

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(rows));

const bytes = readFileSync(target).length;
console.log(
  `stations.json: ${rows.length} stations (weight >= ${MIN_WEIGHT}), ${(bytes / 1048576).toFixed(2)} MiB -> ${target}`
);
