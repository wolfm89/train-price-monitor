# Backend

GraphQL Yoga API for Train Price Monitor. One native AWS Lambda handler serves both API Gateway
requests and SQS messages; the same Docker image is used by the API and refresher functions with
different timeouts, triggers and DB pacing.

## Commands

```bash
npm install
npm run dev          # esbuild watch + local HTTP server on port 4000
npm run dev:types    # optional tsc --watch
npm run build        # codegen + esbuild Lambda bundle
npm run codegen      # GraphQL resolver/type generation
npm run typecheck
npm run lint
npm test             # Node test runner + ts-node assertion scripts
```

From the repository root, use `mise run //backend:dev` and `mise run //backend:test`.

## Runtime

- **API Gateway path:** REST API with a Cognito user-pool authorizer. API Gateway caps the integration
  at 29 s; the API Lambda is sized for a waiting user and uses one direct DB attempt before Decodo.
- **SQS path:** hourly `updateJourneyMonitors` and daily `deleteUnconfirmedSignups` messages. The
  refresher has a 120 s timeout and paces DB calls gently.
- **Storage:** DynamoDB `TrainPriceMonitor` (users, journeys, notifications), S3 profile images, SQS
  queue and DLQ, SES email.
- **DB access:** `db-vendo-client` through the shared `cross-fetch` alias. The shared transport uses
  Node `https` with browser-like TLS profiles; the API/refresher can fall back to Decodo. See
  [docs/architecture.md](../docs/architecture.md#design-decisions).

The handler exports `handler` from `src/main.ts` and supports API Gateway payload v1 and v2 plus SQS.
`LOCAL_DEV=1` starts an HTTP server for local development.

## Code generation

`src/schema/schema.graphql` is the source of truth for the SDL. `npm run codegen` regenerates the
resolver types; `npm run stations` and `npm run schema` generate the autocomplete index and bundled
SDL. The generated station index and SDL JSON are not committed; the resolver types are.

## Environment and tests

`mise run env:local` writes `backend/.env` with the profile-image bucket, SQS queue and Cognito pool.
The full variable list is in [docs/configuration.md](../docs/configuration.md#backend-runtime).

`npm test` covers the backfill planners, journey matcher and privacy helpers (retention, export,
upload validation, CORS and log redaction). Run `npm run typecheck` and `npm run lint` before a PR.

## More

- [Architecture](../docs/architecture.md)
- [Development](../docs/development.md)
- [Configuration](../docs/configuration.md)
- [Privacy](../docs/privacy.md)
