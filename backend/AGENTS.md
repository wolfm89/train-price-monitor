# Backend — Agent Guide

GraphQL Yoga API for Train Price Monitor. One native Lambda handler serves API Gateway requests
and SQS messages; the API and refresher functions run the same Docker image with different timeouts,
triggers and DB pacing. Docker Lambda cold start is about 15 s. The root [`AGENTS.md`](../AGENTS.md)
still applies; this file adds the backend-specific rules.

## Commands

```bash
npm install
npm run dev          # esbuild watch + local HTTP server on port 4000
npm run dev:types    # optional tsc --watch in a second terminal
npm run build        # codegen + esbuild Lambda bundle
npm run codegen      # GraphQL resolver/type generation
npm run typecheck
npm run lint
npm test             # Node test runner + ts-node assertion scripts
```

From the repository root: `mise run //backend:dev` and `mise run //backend:test`. The dev task sets
`LOCAL_DEV=1`, which switches the entry point from the Lambda handler to a plain HTTP server.
`npm run dev` uses the same bundle as Lambda but does not typecheck.

## Authorization and privacy

- Every user-scoped resolver must load the `User` row and compare `cognitoSub` with the verified
  token. Never trust the GraphQL `userId` or `id` arguments alone, and reject rows without
  `cognitoSub` instead of binding them to the caller. New accounts store the binding from the token
  in `createUser`; existing rows are migrated once with
  `cd backend && npm run backfill:cognito-sub -- --user-pool-id <pool> --table TrainPriceMonitor`
  (add `--dry-run` first).
- Only the SQS/EventBridge context may run `updateJourneyMonitors`, `sendEmailNotification` and
  `deleteUnconfirmedSignups`. Do not expose them as user-callable mutations.
- Never log emails, names, search text, raw events, request bodies or tokens. Log `userId`,
  `journeyId` and counts. Run AWS error messages through `redactEmails`
  (`src/lib/redact.ts`) before logging.
- Every per-user item must be covered by `exportMyData`, `deleteUser` and the TTL rules in
  `src/lib/retention.ts`. A new item type needs a `ttl` or a documented reason why not.
- CORS is an allowlist (`CORS_ALLOWED_ORIGINS`, the API Gateway preflight and the 401 gateway
  response). Do not reintroduce `*`.

## GraphQL and caching

- `src/schema/schema.graphql` is the SDL source of truth. Edit it, run `npm run codegen`, then
  implement the resolver. Generated resolver types are committed.
- The response cache is in-memory per container with a 30 s TTL, and mutation invalidation is local.
  The refresher and other API containers can serve a write up to 30 s late; this is accepted for the
  watchlist snapshot. Do not add a shared cache without revisiting that trade-off.

## DB transport and bundling

- `db-vendo-client` reaches DB through the shared `cross-fetch` alias to `../shared/db-fetch.ts`,
  using the `dbnav` Navigator profile. Read [`shared/AGENTS.md`](../shared/AGENTS.md) before
  touching transport behavior.
- The API and refresher can fall back to Decodo when the direct path is throttled
  (`DECODO_API_KEY_PARAM`, premium pool). `DB_TRANSPORT=decodo` is the kill switch. The key lives in
  an SSM SecureString written by CI; functions receive only the parameter name, never the key.
- The bundle is `--format=cjs`. Do **not** externalize ESM-only packages: `require()` of ESM crashes
  Lambda with `UserCodeSyntaxError`, which API Gateway reports as a 502 and often disguises as CORS.
  `db-vendo-client` must stay bundled.
- `src/stations/stations.json` and `src/schema/schema.generated.json` are generated and bundled, not
  committed. `npm run stations` and `npm run schema` run automatically before typecheck/build/dev.
  Importing `db-hafas-stations` at runtime cost ~1.1 s on the first `locations` call and added
  133 MB to the image; the generated index parses in ~20 ms. The image copies only `dist/main.js`,
  so never read `schema.graphql` from disk at runtime. Do not hand-edit the generated files; the
  station index is 0.67 MiB, gitignored, and would trip the 500 KB large-file hook if force-added.
- The bundle is built on the host because it pulls in `../shared/`, outside the Docker build
  context. `mise run //infrastructure:deploy` builds it first; a raw Docker image build without
  `dist/` bakes in a stale bundle.

## Tests

`npm test` runs Node's test runner for the backfill planners plus `ts-node` assertion scripts for
the journey matcher, privacy helpers and SES manager. Add a check when you change matching,
retention, export, upload validation, CORS or log redaction. Run `typecheck` and `lint` before a PR.

Update `README.md` for interface changes and [docs/configuration.md](../docs/configuration.md) for
new environment variables.
