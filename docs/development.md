# Development

This repository is a `mise` monorepo. Tool versions live in `.mise.toml`; per-module tasks are
reachable as `mise run //<module>:<task>`.

## Toolchain

Install once:

```bash
mise install          # Node 24, AWS CLI 2, uv
mise run install      # npm install in every module; uv sync for analytics
```

`npm install` is still fine inside a single module, but `mise run install` is the expected setup for
a fresh checkout.

## Local environment

The frontend needs Cognito and GraphQL build values; the backend needs the profile-image bucket and
SQS queue URL. Generate them from a deployed `InfrastructureStack`:

```bash
export AWS_PROFILE=<profile>
aws sso login --profile "$AWS_PROFILE"
mise run env:local
```

The script verifies `sts:GetCallerIdentity`, reads the prefixed CloudFormation outputs and writes
the ignored `backend/.env` and `frontend/.env`. It needs
`cloudformation:DescribeStacks` and `cognito-idp:ListUserPoolClients`. Set `STACK_NAME` if the stack
is not `InfrastructureStack`. See [deployment.md](deployment.md#outputs-and-local-environment).

Do not commit `.env` files. The canonical variable reference is [configuration.md](configuration.md).

## Local workflows

| Workflow           | Command                                                       | What is local                                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend only      | `mise run //frontend:dev`                                     | Vite on port 3000; API calls are same-origin and proxied to `VITE_DEV_BACKEND_URL` (default `http://127.0.0.1:4000`).                                                                                       |
| Backend + frontend | `mise run //backend:dev` in one terminal, frontend in another | GraphQL on port 4000; S3/SQS/Cognito are the deployed resources from `env:local`.                                                                                                                           |
| Docker Compose     | `mise run dev:docker`                                         | Frontend, backend and a Floci container. It reads `AWS_PROFILE`, `PROFILE_IMAGE_BUCKET_NAME` and `TPM_SQS_QUEUE_URL` from the shell or repo-root `.env`, not `backend/.env`, and publishes ports 3000/4000. |
| Scraper on Floci   | see [scraper/README.md](../scraper/README.md)                 | Local DynamoDB/S3 and the scraper tasks.                                                                                                                                                                    |

The frontend-only flow is not enough to sign in unless `mise run env:local` has written the Cognito
values. There is no mock auth mode.

### Backend

```bash
cd backend
npm install
npm run dev          # esbuild watch + node on port 4000
npm run dev:types    # optional tsc --watch in a second terminal
```

`npm run dev` uses the same bundle as the Lambda and aliases `cross-fetch` to the shared DB
transport. It does not typecheck; run `npm run dev:types` or `npm run typecheck` separately.

### Frontend

```bash
cd frontend
npm install
npm run dev          # Vite on http://localhost:3000
```

Production builds read `REACT_APP_GRAPHQL_ENDPOINT` and `REACT_APP_COGNITO_*` as Vite defines; in
dev the client always calls `/graphql` and the dev server proxies it to `VITE_DEV_BACKEND_URL`, so
the endpoint is not used there. The dev server accepts the unprefixed `COGNITO_*` names too; CI
supplies the `REACT_APP_*` values.

## Checks

Run from the repository root:

```bash
mise run //frontend:test
mise run //backend:test
mise run //scraper:test
mise run //infrastructure:test
mise run //analytics:test
mise run //...:lint
mise run //...:typecheck
```

Or per module. Each line runs in a subshell, so every check starts from the repository root:

```bash
(cd frontend && npm run test:ci && npm run typecheck && npm run lint)
(cd backend && npm test && npm run typecheck && npm run lint)
(cd scraper && npm test && npm run typecheck && npm run lint)
(cd infrastructure && npm test && npm run typecheck && npm run lint)
(cd analytics && uv run pytest && uv run ruff check . && uv run ty check)
```

Install the pre-commit hooks once:

```bash
pip install pre-commit
pre-commit install
pre-commit run --all-files
pre-commit run --all-files --hook-stage manual   # includes tsc and ty
```

Prettier, ESLint, ruff and uv-lock run on the changed files. The manual stage adds the slower
typechecks.

## Code generation

The backend generates two files before typecheck/build/dev/prestart:

- `backend/src/stations/stations.json` from `db-hafas-stations` for autocomplete;
- `backend/src/schema/schema.generated.json` from `schema.graphql` for the bundled SDL.

They are generated, not committed. To regenerate explicitly:

```bash
cd backend
npm run stations
npm run schema
npm run codegen      # GraphQL resolver/type types
```

Edit `backend/src/schema/schema.graphql`, then run `npm run codegen` before implementing a resolver.
The generated resolver types are committed; the SDL JSON and station index are not.

## Troubleshooting

- **Frontend cannot sign in / Cognito IDs undefined:** run `mise run env:local`; restart Vite.
- **AWS errors during `env:local`:** the SSO session expired; run `aws sso login` again.
- **DB requests return `403 OPS_BLOCKED`:** the TLS profile is blocked. The transport rotates
  profiles automatically; the backend can fall back to Decodo when `DECODO_API_KEY_PARAM` is set.
  The poller deliberately has no Decodo key and ends its batch on throttling.
- **CORS errors:** `CORS_ALLOWED_ORIGINS` defaults to `http://localhost:3000` and
  `http://127.0.0.1:3000`; set it to the exact browser origin for a custom frontend.
- **Backend image build fails on Apple Silicon:** the Lambda image is `linux/amd64`; ensure Docker
  Buildx is available. The analytics asset pins `linux/amd64` too.
- **Docker Compose environment:** it does not read `backend/.env`; export `AWS_PROFILE`,
  `PROFILE_IMAGE_BUCKET_NAME` and `TPM_SQS_QUEUE_URL` or put them in the repo-root `.env`, and stop
  the two dev servers first because Compose publishes 3000/4000. Floci is used by the scraper's local
  tasks, not as a complete replacement for the app's Cognito and API resources.
- **Missing generated files after a fresh clone:** run `mise run install` then
  `mise run //backend:codegen`; the prebuild hooks regenerate the station index and SDL.
