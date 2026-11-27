# Train Price Monitor — Agent Guide

Train Price Monitor is a serverless web app that watches Deutsche Bahn fares. A user searches a
journey, sets a price limit and gets an in-app notification plus an email (on by default) when the
fare reaches or exceeds it. A separate scraper pipeline records historical fares to Parquet on S3,
and a weekly DuckDB build publishes the analytics silver layer. Everything is AWS CDK v2 and runs
through a `mise` monorepo.

This file is the shared contract. Each module has a nested `AGENTS.md` with the commands, guardrails
and traps specific to that code. The nearest file wins for its subtree; if two files conflict, the
stricter rule wins and the drift gets fixed. Read the module file before editing.

## Where things live

| Path              | What it is                                                                                     | Agent guide                                          |
| ----------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `frontend/`       | React 19 SPA with Material-UI v7, urql and Cognito                                             | [frontend/AGENTS.md](frontend/AGENTS.md)             |
| `backend/`        | GraphQL Yoga API + SQS refresher, both on Lambda                                               | [backend/AGENTS.md](backend/AGENTS.md)               |
| `scraper/`        | Independent Hydrator/Poller/Compactor pipeline writing bronze Parquet                          | [scraper/AGENTS.md](scraper/AGENTS.md)               |
| `analytics/`      | Python 3.15 + DuckDB silver builds and quality reports                                         | [analytics/AGENTS.md](analytics/AGENTS.md)           |
| `infrastructure/` | AWS CDK v2 stacks, alarms, dashboards and deployment                                           | [infrastructure/AGENTS.md](infrastructure/AGENTS.md) |
| `shared/`         | DB transport (`db-fetch.ts`) and cross-module runtime configuration                            | [shared/AGENTS.md](shared/AGENTS.md)                 |
| `docs/`           | User-facing documentation (architecture, deployment, development, config, operations, privacy) | [docs/README.md](docs/README.md)                     |

Module directories have a `README.md` describing the product and its interfaces (`shared/` is the
exception). `docs/` is canonical for architecture, deployment, development, configuration,
operations and privacy: update the relevant page when behavior changes instead of duplicating it
here.

## Setup and shared commands

```bash
mise install                    # Node 24, AWS CLI 2, uv
mise run install                # npm install in every module + uv sync for analytics
export AWS_PROFILE=<profile>    # local development only
aws sso login --profile "$AWS_PROFILE"
mise run env:local              # write ignored backend/frontend env files from CloudFormation
mise run //...:build            # build every module
mise run //...:test             # test every module
mise run //...:lint             # lint every module
mise run //...:typecheck        # typecheck every module
pre-commit run --all-files      # format, lint, lockfile
pre-commit run --all-files --hook-stage manual  # slower tsc/ty checks
```

Per-module dev servers and test commands are in the nested guides. CI runs the per-module typecheck,
lint and test commands; pre-commit enforces formatting on every commit. On a low-memory machine use
`MISE_JOBS=1 mise run //:test` so modules run one at a time; parallel Jest/Vitest workers have
exhausted a 17.6 GB VM.

## Conventions that apply everywhere

- Python is 3.15+ and analytics-only; write modern 3.15 syntax and do not add
  `from __future__ import annotations` (deferred annotations are the default, PEP 649).

- TypeScript strict mode in every module; explicit parameter and return types, `interface` for object
  shapes, `unknown` instead of `any`.
- `const` by default, `let` only when reassignment is needed.
- No unsuppressed console calls (`no-console: error`). Backend and scraper log through
  `@aws-lambda-powertools/logger`; the two suppressions in
  `frontend/src/providers/AuthProvider.tsx` are intentional.
- Prettier: `trailingComma: es5`, `tabWidth: 2`, `printWidth: 120`, `semi: true`, `singleQuote: true`.
  ESLint v10 flat config lives in `eslint.config.cjs`.
- Imports: external packages first (alphabetical), then internal relative paths, separated by a
  blank line.
- Naming: Components PascalCase; hooks `useX`; utilities/API camelCase; classes/stacks PascalCase;
  constants SCREAMING_SNAKE_CASE. Match the existing file naming in the module: TypeScript source
  files camelCase (components PascalCase), Python files snake_case, CDK stack files kebab-case (for
  example `analytics-stack.ts`).
- Commits use a short imperative subject, for example `Add price alert threshold validation`.
  Pre-commit hooks must pass before committing.

## Non-negotiable guardrails

- **Secrets and personal data.** Never commit `.env` files, credentials or tokens. Never log email
  addresses, names, free-text search input, raw events, request bodies or tokens; log pseudonymous
  IDs and counts. Pass AWS error messages through `redactEmails` (`backend/src/lib/redact.ts`)
  before logging them. See [docs/privacy.md](docs/privacy.md).
- **Authentication.** API Gateway uses a Cognito authorizer and every user-scoped resolver must load
  the `User` row and compare its `cognitoSub` with the verified token. Never trust the GraphQL
  `userId` or `id` arguments on their own. Rows without `cognitoSub` are rejected, not auto-bound.
- **Privacy lifecycle.** Every per-user item must be covered by `exportMyData`, `deleteUser` and the
  TTL rules in `backend/src/lib/retention.ts`. New item types get a `ttl` or an explicit reason why
  not. Any change to what is stored, logged, sent to a third party or kept in the browser needs a
  matching update to the public privacy policy.
- **CORS.** Allowlist only (`CORS_ALLOWED_ORIGINS` and the gateway preflight/401 response); never
  `*`. Details in [backend/AGENTS.md](backend/AGENTS.md).
- **Generated and vendored files.** Never edit `**/dist/`, `**/node_modules/`, `**/cdk.out/`,
  GraphQL codegen output or `package-lock.json` by hand. Change dependencies with `npm install`.
- **esbuild.** Follow the per-module bundling rules; externalizing an ESM-only package crashes the
  CJS Lambda at runtime with `UserCodeSyntaxError`, which API Gateway reports as a 502 and often
  disguises as CORS. Details in [backend/AGENTS.md](backend/AGENTS.md) and
  [scraper/AGENTS.md](scraper/AGENTS.md).
- **DB transport.** All DB access goes through `shared/db-fetch.ts`; never replace it with a browser,
  proxy, undici, `fetch` or another vendor. The only egress is the app-owned regional proxies and the
  TLS fingerprints; there is no vendor fallback. Read `shared/AGENTS.md` before touching the
  transport.
- **Infrastructure.** Build and review `cdk diff` before any deploy; never run `cdk deploy` without
  a human reviewing the diff. Do not deploy to AWS from an agent session
  (`//infrastructure:deploy`, `//infrastructure:deploy-scraper`); the local Floci deploy
  (`//infrastructure:deploy-local-scraper`) is allowed.
- **Cost ceiling.** The CloudWatch free-tier limits are fully allocated (see
  [infrastructure/AGENTS.md](infrastructure/AGENTS.md) and [docs/operations.md](docs/operations.md)).
  Do not add an eleventh alarm or metric, and do not use metric math, Metrics Insights or
  anomaly-detection bands in alarms without accepting the billing change. The budget is $1.00
  USD/month.
- **Deployment inputs.** `CDK_APP_NAME`, `CDK_DOMAIN_NAME` and `CDK_SES_FROM_EMAIL` must be set
  before `cdk deploy`; missing values fail at synth time.
- **Python is analytics-only.** Do not add Python code, dependencies or tooling to `backend/`,
  `scraper/`, `frontend/` or `shared/`.
- **Dependencies.** Dependabot alerts and PRs are the source of truth, not `npm audit`. Review them in
  batches, apply updates with `npm install`/`npm update` in the affected module, and run that module's
  checks. Do not run `npm audit fix --force`; it proposes unsupported downgrades. GitHub Actions use
  pinned major tags and are updated together with the workflow.

## Further reading

- [docs/README.md](docs/README.md) — documentation index and reading paths.
- [docs/architecture.md](docs/architecture.md) — system context, flows and design decisions.
- [docs/deployment.md](docs/deployment.md) — stacks, inputs, outputs, verification and rollback.
- [docs/development.md](docs/development.md) — toolchain, local modes, tests and troubleshooting.
- [docs/configuration.md](docs/configuration.md) — canonical environment-variable reference.
- [docs/operations.md](docs/operations.md) — alarms, dashboards, budget and runbooks.
- [docs/privacy.md](docs/privacy.md) — storage, logging, export/retention and email rules.
- [docs/diagrams/](docs/diagrams/) — editable web app, scraper and analytics diagrams.
