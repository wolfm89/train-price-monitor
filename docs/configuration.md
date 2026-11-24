# Configuration

This is the canonical environment-variable reference. **Never commit values** for secrets. The
deployed functions receive most runtime values from CDK; do not set them by hand.

## How to read this table

- **Scope** is the module that reads the value.
- **Default / deployed** is the code default, or the value injected by CDK/the deployment.
- **Set by** is who normally provides it: `CDK`, `CI`, `developer`, or `Lambda`.
- Values such as `DECODO_API_KEY`, `PUSHOVER_API_TOKEN` and `PUSHOVER_USER_KEY` are secrets.
  They live in repository secrets and are written to SSM SecureStrings by CI, never in a template.

## CDK deployment inputs

| Variable                    | Scope          | Default / deployed                                 | Set by         | Purpose                                                                             |
| --------------------------- | -------------- | -------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------- |
| `CDK_APP_NAME`              | Infrastructure | required                                           | developer / CI | Application name, Cognito domain and resource names.                                |
| `CDK_DOMAIN_NAME`           | Infrastructure | required                                           | developer / CI | Custom frontend domain and ACM certificate.                                         |
| `CDK_SES_FROM_EMAIL`        | Infrastructure | required                                           | developer / CI | SES sender and cognito `fromEmail`.                                                 |
| `CDK_DECODO_API_KEY_PARAM`  | Infrastructure | `/train-price-monitor/decodo-api-key`              | developer / CI | SSM SecureString name for the Decodo key.                                           |
| `CDK_SCRAPER_PAUSED`        | Infrastructure | unset                                              | developer / CI | `1` disables poller and hydrator schedules; compactor stays on.                     |
| `CDK_ANALYTICS_PAUSED`      | Infrastructure | CI defaults to `1` when the repo variable is unset | developer / CI | `1` disables the weekly silver schedule. Set `0` after first-run checks.            |
| `CDK_TRANSFORM_VERSION`     | Infrastructure | empty                                              | CI             | Short commit SHA recorded in the silver manifest; empty falls back to `sql-<hash>`. |
| `CDK_SES_PRODUCTION_ACCESS` | Infrastructure | unset                                              | developer / CI | `1` once SES production access is granted; disables the sandbox workaround.         |
| `AWS_REGION`                | Infrastructure | `eu-central-1`                                     | developer / CI | Deployment region for the four application stacks.                                  |

CI also uses `CDK_DEFAULT_ACCOUNT`/`CDK_DEFAULT_REGION`, the AWS credential/role secrets, the
frontend `REACT_APP_*` build values, `DECODO_API_KEY`, `PUSHOVER_API_TOKEN` and
`PUSHOVER_USER_KEY`. See [deployment.md](deployment.md).

## Backend runtime

| Variable                             | Scope               | Default / deployed                                                     | Set by            | Purpose                                                                      |
| ------------------------------------ | ------------------- | ---------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------- |
| `PROFILE_IMAGE_BUCKET_NAME`          | Backend             | —                                                                      | CDK / `env:local` | S3 bucket for profile images.                                                |
| `TPM_SQS_QUEUE_URL`                  | Backend             | —                                                                      | CDK / `env:local` | SQS queue for hourly refresh, daily cleanup and notification-email messages. |
| `SES_FROM_EMAIL`                     | Backend             | —                                                                      | CDK               | Sender address for user emails.                                              |
| `SES_SANDBOX`                        | Backend             | `true`                                                                 | CDK               | `false` turns off the sandbox-only per-user recipient identities.            |
| `CORS_ALLOWED_ORIGINS`               | Backend             | localhost/127.0.0.1 on port 3000                                       | CDK / developer   | Comma-separated browser origins; CDK sets the frontend origin.               |
| `FRONTEND_URL`                       | Backend             | `http://localhost:3000`                                                | CDK               | Base URL used in notification links.                                         |
| `COGNITO_USER_POOL_ID`               | Backend (refresher) | —                                                                      | CDK / `env:local` | User pool for the daily unconfirmed-sign-up cleanup.                         |
| `LOCAL_DEV`                          | Backend             | unset                                                                  | developer         | `1` runs an HTTP server instead of the Lambda handler.                       |
| `PORT`                               | Backend             | `4000`                                                                 | developer         | Local HTTP port when `LOCAL_DEV=1`.                                          |
| `DECODO_API_KEY_PARAM`               | Backend             | `/train-price-monitor/decodo-api-key`                                  | CDK               | SSM SecureString name for the Decodo fallback key.                           |
| `DECODO_API_KEY`                     | Backend             | unset                                                                  | developer         | Literal key for local development; wins over `_PARAM`. Never commit.         |
| `DECODO_KEY_TTL_MS`                  | Backend             | `900000`                                                               | developer         | How long a resolved Decodo key is cached.                                    |
| `DB_TRANSPORT`                       | Backend             | unset                                                                  | developer         | `decodo` forces the fallback (kill switch).                                  |
| `POWERTOOLS_LOG_LEVEL` / `LOG_LEVEL` | Backend             | `INFO` in Lambda; `DEBUG` when `NODE_ENV=development`                  | developer         | Log level; `POWERTOOLS_LOG_LEVEL` wins over `LOG_LEVEL`.                     |
| `NODE_ENV`                           | Backend             | unset                                                                  | developer         | `development` selects the DEBUG default; do not set it in Lambda.            |
| `POWERTOOLS_SERVICE_NAME`            | Scraper             | set by CDK (`scraper-poller`, `scraper-hydrator`, `scraper-compactor`) | CDK               | Service name in structured logs.                                             |

## DB transport and pacing

Shared by the backend and scraper.

| Variable                       | Scope             | Default / deployed                                      | Set by          | Purpose                                                                       |
| ------------------------------ | ----------------- | ------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------- |
| `DB_MIN_GAP_MS`                | Backend + scraper | `1000` code; API `300`, refresher `1500`, poller `2500` | CDK / developer | Minimum spacing between request starts.                                       |
| `DB_MAX_IN_FLIGHT`             | Backend + scraper | `2`                                                     | CDK / developer | Concurrent DB requests.                                                       |
| `DB_MAX_ATTEMPTS`              | Backend + scraper | `2`; API `1`                                            | CDK / developer | Direct attempts per request.                                                  |
| `DB_RETRY_BACKOFF_MS`          | Backend + scraper | `3000`                                                  | developer       | Pause before a retry, multiplied by the attempt number.                       |
| `DB_REQUEST_TIMEOUT_MS`        | Backend + scraper | `20000`; API `8000`                                     | CDK / developer | Per-attempt timeout.                                                          |
| `DB_BREAKER_THRESHOLD`         | Backend + scraper | `3`                                                     | developer       | Consecutive failed requests that open the circuit breaker.                    |
| `DB_BREAKER_COOLDOWN_MS`       | Backend + scraper | `180000`                                                | developer       | How long the breaker stays open.                                              |
| `DB_TOTAL_BUDGET_MS`           | Backend + scraper | API `24000`, refresher `110000`, poller `45000`         | CDK             | Wall-clock budget per request, direct plus fallback.                          |
| `DB_TLS_PROFILE`               | Backend + scraper | `tls13` in CDK; code default `firefox`                  | CDK / developer | First TLS profile: `firefox`, `safari`, `chrome`, `tls13`, `tls12`, `legacy`. |
| `DB_PROFILE_BLOCK_COOLDOWN_MS` | Backend + scraper | `900000`                                                | developer       | How long a profile that returned `OPS_BLOCKED` is skipped.                    |

The direct path is Node `https` with a browser-like ClientHello. Decodo is only wired into the
backend; the poller has no fallback key. See [architecture.md](architecture.md#design-decisions).

## Frontend build

| Variable                                 | Scope         | Default / deployed      | Set by           | Purpose                                                                                             |
| ---------------------------------------- | ------------- | ----------------------- | ---------------- | --------------------------------------------------------------------------------------------------- |
| `REACT_APP_GRAPHQL_ENDPOINT`             | Frontend      | production API URL      | CI               | API Gateway base URL for production builds; the client appends `graphql`. Dev uses the proxy below. |
| `VITE_DEV_BACKEND_URL`                   | Dev / preview | `http://127.0.0.1:4000` | Compose / shell  | Target of the dev server and `vite preview` `/graphql` proxy. Compose sets `http://backend:4000`.   |
| `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` | Dev only      | —                       | shell            | Extra hostnames for the dev server (comma separated); `localhost`/IPs are always allowed.           |
| `REACT_APP_COGNITO_USER_POOL_ID`         | Frontend      | —                       | CI / `env:local` | Cognito user pool ID.                                                                               |
| `REACT_APP_COGNITO_CLIENT_ID`            | Frontend      | —                       | CI / `env:local` | Cognito app client ID.                                                                              |
| `REACT_APP_COGNITO_IDENTITY_POOL_ID`     | Frontend      | —                       | CI / `env:local` | Cognito identity pool ID.                                                                           |

Vite accepts the unprefixed `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID` and
`COGNITO_IDENTITY_POOL_ID` names in local `.env` files and maps them to the build-time
`REACT_APP_*` defines. `env:local` writes the unprefixed names; CI supplies the `REACT_APP_*`
values directly.

## Scraper

| Variable                    | Scope   | Default / deployed | Set by    | Purpose                                                            |
| --------------------------- | ------- | ------------------ | --------- | ------------------------------------------------------------------ |
| `SCRAPER_TABLE_NAME`        | Scraper | —                  | CDK       | DynamoDB schedule table.                                           |
| `SCRAPER_BUCKET_NAME`       | Scraper | —                  | CDK       | S3 bucket for bronze Parquet.                                      |
| `SCRAPER_BATCH_SIZE`        | Scraper | `25`               | CDK       | Targets per poller run; one target is two DB calls.                |
| `HYDRATOR_LOOKAHEAD_DAYS`   | Scraper | `60`               | CDK       | Days ahead to seed.                                                |
| `HYDRATOR_SEED_WINDOW_DAYS` | Scraper | `3`                | CDK       | Newest days re-seeded per nightly run.                             |
| `HYDRATOR_FULL_SEED`        | Scraper | unset              | developer | `1` seeds the whole lookahead window and prunes beyond it; manual. |
| `AWS_ENDPOINT_URL`          | Scraper | unset              | mise      | Local Floci endpoint for scraper development.                      |

## Analytics

| Variable               | Scope     | Default / deployed                  | Set by             | Purpose                                                                  |
| ---------------------- | --------- | ----------------------------------- | ------------------ | ------------------------------------------------------------------------ |
| `SILVER_BUCKET`        | Analytics | —                                   | CDK                | Shared scraper bucket.                                                   |
| `SILVER_PREFIX`        | Analytics | `silver`                            | CDK                | Prefix for builds, pointer and quality reports.                          |
| `BRONZE_SOURCE`        | Analytics | `s3://<bucket>/prices/**/*.parquet` | CDK                | Bronze glob; the handler lists the snapshot.                             |
| `SILVER_THREADS`       | Analytics | `2`                                 | CDK                | DuckDB threads for the build.                                            |
| `SILVER_MEMORY_LIMIT`  | Analytics | `6GB`                               | CDK                | DuckDB memory limit.                                                     |
| `SILVER_MAX_TEMP_SIZE` | Analytics | `7GB`                               | CDK                | DuckDB spill cap.                                                        |
| `SILVER_KEEP`          | Analytics | `2`                                 | CDK                | Number of silver builds to retain.                                       |
| `TRANSFORM_VERSION`    | Analytics | commit SHA or `sql-<hash>`          | CDK/CI             | Recorded in the silver manifest.                                         |
| `ALERT_TOPIC_ARN`      | Analytics | —                                   | CDK                | SNS topic for quality warnings and the failure destination.              |
| `LOG_GROUP_NAME`       | Analytics | —                                   | CDK                | Log group used in failure links.                                         |
| `AWS_LAMBDA_LOG_LEVEL` | Analytics | unset (handler defaults to `INFO`)  | Lambda / developer | Runtime log level; the handler respects it when setting the root logger. |

`AWS_REGION` is reserved by Lambda; do not set it on the analytics function.

## Analytics local

| Variable                     | Scope     | Default / deployed | Set by    | Purpose                                                                                                                         |
| ---------------------------- | --------- | ------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `DUCKDB_EXTENSION_DIR`       | Analytics | unset              | developer | Directory with the bundled httpfs extension for local S3 reads (`mise run //analytics:httpfs`); required for `--source s3://…`. |
| `TRAIN_DUCKDB_MEMORY_LIMIT`  | Analytics | `6GB`              | developer | DuckDB memory limit for the local training builder.                                                                             |
| `TRAIN_DUCKDB_MAX_TEMP_SIZE` | Analytics | `20GB`             | developer | DuckDB spill cap for the local training builder.                                                                                |

## Alerting

| Variable               | Scope           | Default / deployed                       | Set by    | Purpose                                                  |
| ---------------------- | --------------- | ---------------------------------------- | --------- | -------------------------------------------------------- |
| `PUSHOVER_TOKEN_PARAM` | Alerting Lambda | `/train-price-monitor/pushover-token`    | CDK       | SSM SecureString name for the app token.                 |
| `PUSHOVER_USER_PARAM`  | Alerting Lambda | `/train-price-monitor/pushover-user-key` | CDK       | SSM SecureString name for the user key.                  |
| `PUSHOVER_KEY_TTL_MS`  | Alerting Lambda | `900000`                                 | developer | Cache duration for resolved Pushover values.             |
| `PUSHOVER_API_TOKEN`   | Infrastructure  | —                                        | CI secret | Pushover application token; CI writes the SSM parameter. |
| `PUSHOVER_USER_KEY`    | Infrastructure  | —                                        | CI secret | Pushover user key; CI writes the SSM parameter.          |

## Local scripts

| Variable      | Scope       | Purpose                                                   |
| ------------- | ----------- | --------------------------------------------------------- |
| `AWS_PROFILE` | developer   | SSO profile used by `env:local` and local backend/docker. |
| `STACK_NAME`  | `env:local` | Stack to read; defaults to `InfrastructureStack`.         |

Defaults are also in `shared/runtime-config.json` (scraper/retention),
`analytics/src/tpm_analytics/data/silver-config.json` (silver sizing/quality) and the module code.
When changing a value, update the code/config and this table together.
