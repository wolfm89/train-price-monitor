# Deployment

The application is seven AWS CDK stacks in the default configuration: five run in `eu-central-1`
(the four application stacks plus the eu-central-1 proxy), one DB proxy runs in `us-east-1`, and the
CloudFront certificate is in `us-east-1`. CI deploys `main`; manual deployments use the same checks
and a reviewed `cdk diff`.

## CI deploy security

- The deploy job runs in the `production` environment with a fixed
  `deploy-production` concurrency group. Configure required reviewers and a
  `main`-only deployment branch policy in the repository settings.
- A manual `workflow_dispatch` with `deploy=true` can deploy the selected ref
  with repository-scoped AWS secrets. Only grant write access to trusted users;
  the branch's workflow definition is what runs, so environment protection rules
  are not a substitute for that trust boundary.
- Prefer GitHub OIDC over the long-lived `AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY` repository secrets; the current keys are available to
  any branch workflow.

## Prerequisites

- An AWS account with permission to create the stacks, IAM roles, Cognito, SES, SNS, EventBridge,
  Lambda, S3, DynamoDB, API Gateway, CloudFront and ACM resources.
- An AWS SSO profile. `mise run env:local` uses it to read `InfrastructureStack` outputs.
- `mise`, Node.js 24, Docker/Buildx (the backend, poller and analytics images are built locally),
  and the AWS CLI.
- Repository secrets/variables for the CI deploy: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
  `AWS_ROLE_TO_ASSUME`, `AWS_ROLE_EXTERNAL_ID`, `CDK_APP_NAME`, `CDK_DOMAIN_NAME`,
  `CDK_SES_FROM_EMAIL`, `REACT_APP_*` build values, `PUSHOVER_API_TOKEN`, `PUSHOVER_USER_KEY`,
  `DISTRIBUTION_ID`; variables `AWS_REGION=eu-central-1`, `CDK_ANALYTICS_PAUSED`,
  `CDK_SCRAPER_PAUSED`, `CDK_SES_PRODUCTION_ACCESS`, `CDK_DB_PROXY_REGIONS`,
  `CDK_DB_TLS_PROFILES`. The deploy job invalidates the CloudFront `/*` path after deploying.

Never commit credentials or generated `.env` files.

## Stacks

| Stack                                                       | Region                                               | What it creates                                                                                                                                                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CertificateStack`                                          | `us-east-1`                                          | ACM certificate for the custom domain and CloudFront.                                                                                                                                           |
| `DbProxyStack` (+ `DbProxyStack-<region>` per extra region) | `CDK_DB_PROXY_REGIONS` (`us-east-1`, `eu-central-1`) | DB egress proxy Lambda for the Navigator API; no VPC, NAT or alarms.                                                                                                                            |
| `AlertingStack`                                             | `eu-central-1`                                       | `TrainPriceMonitorAlerts` SNS topic, Pushover forwarder and the `$1` monthly budget.                                                                                                            |
| `InfrastructureStack`                                       | `eu-central-1`                                       | CloudFront, private frontend S3, Cognito user/identity pools, API Gateway + GraphQL Lambda, DynamoDB, profile S3, SQS + DLQ, refresher Lambda, SES identity, API/access logs, `ToolkitCleaner`. |
| `ScraperStack`                                              | `eu-central-1`                                       | Schedule table + `ByDue` GSI, scraper S3 bucket, Hydrator/Poller/Compactor and three EventBridge rules.                                                                                         |
| `AnalyticsStack`                                            | `eu-central-1`                                       | Weekly silver Docker Lambda, EventBridge Scheduler, IAM, SNS failure path.                                                                                                                      |

`AnalyticsStack` and `ScraperStack` share the scraper S3 bucket. The alert topic is imported by the
application, scraper and analytics stacks.

## Required CDK inputs

`CDK_APP_NAME`, `CDK_DOMAIN_NAME` and `CDK_SES_FROM_EMAIL` are required and fail at synth time when
missing. The full list, including optional pause and fallback settings, is in
[configuration.md](configuration.md).

Useful values:

- `CDK_ANALYTICS_PAUSED=1` deploys the weekly schedule disabled. CI defaults to `1` when the
  repository variable is unset; set it to `0` only after the first-run checks.
- `CDK_SCRAPER_PAUSED=1` disables the poller and hydrator schedules; the compactor stays enabled.
- `CDK_SES_PRODUCTION_ACCESS=1` switches off the SES sandbox workaround.
- `CDK_TRANSFORM_VERSION` records the short commit SHA in the silver manifest; empty falls back to
  `sql-<hash>`.
- `CDK_DB_PROXY_REGIONS` lists the regions that get a proxy (`us-east-1,eu-central-1` default).
  The legacy region (`CDK_DB_PROXY_REGION`, default `us-east-1`) keeps the stack id `DbProxyStack`;
  other regions use `DbProxyStack-<region>`. If your existing proxy was deployed in another region,
  set `CDK_DB_PROXY_REGION` to it for the first deploy; otherwise the new stack collides on the
  `TrainPriceMonitor-DbProxy` function name. Removing a region from the list leaves its stack
  deployed; delete it explicitly, e.g.
  `aws cloudformation delete-stack --region eu-central-1 --stack-name DbProxyStack-eu-central-1`.
- `CDK_DB_TLS_PROFILES` sets the fingerprint order (`chrome,legacy,firefox,safari,tls13,tls12`
  default). DB changes the accepted order over time; keep several entries and do not pin one.

## Bootstrap

Bootstrap both regions once per account:

```bash
cd infrastructure
npx cdk bootstrap aws://<account>/us-east-1 aws://<account>/eu-central-1
```

`CertificateStack` uses `us-east-1` because CloudFront requires the certificate there. The other
stacks use `CDK_DEFAULT_REGION=eu-central-1`.

## Deploy

For a local deploy, export the CDK inputs and build the assets the synth graph consumes:

```bash
export CDK_APP_NAME=TrainPriceMonitor
export CDK_DOMAIN_NAME=example.com
export CDK_SES_FROM_EMAIL=noreply@example.com
mise run //...:build
```

Review the diff before changing AWS:

```bash
cd infrastructure
npx cdk diff
```

Then deploy all stacks with the repository task:

```bash
mise run //infrastructure:deploy
```

The task rebuilds the frontend, backend and scraper bundles, then deploys all stacks with approval
disabled. CDK builds the analytics Docker image as part of the deployment. `npx cdk deploy --all`
uses the same stacks and assets once they have been built; it keeps CDK's normal approval prompt.

Use `mise run //infrastructure:deploy-scraper` or the other targeted tasks from
[infrastructure/README.md](../infrastructure/README.md) when only one stack changed.

CI runs the same `cdk diff` and `cdk deploy --all` on a push to `main` after every module job is
green. Pull-request runs never deploy.

## Outputs and local environment

CloudFormation output keys are generated logical IDs with a hash suffix, for example
`FrontendCloudFrontUrlD7235372`, `BackendQueueUrl20B4D97A`,
`BackendProfileImageBucketNameBD41614A` and `BackendApiEndpoint8C3010C1`. Do not copy the suffix.

`mise run env:local` resolves the prefixes with `starts_with` and writes the ignored local files:

- `backend/.env`: `AWS_PROFILE`, `PROFILE_IMAGE_BUCKET_NAME`, `TPM_SQS_QUEUE_URL`,
  `COGNITO_USER_POOL_ID`.
- `frontend/.env`: Cognito user/identity pool and client IDs plus `AWS_REGION` (the current app does
  not read `AWS_REGION`; it is kept in the generated file for local tooling). The dev server needs
  no `.env.development`: it proxies `/graphql` to `VITE_DEV_BACKEND_URL` (default
  `http://127.0.0.1:4000`).
- `frontend/.env.production`: `REACT_APP_GRAPHQL_ENDPOINT` from `BackendApiEndpoint`.

Set `STACK_NAME` if the stack is not named `InfrastructureStack`. The script verifies the AWS
identity with `sts:GetCallerIdentity` and needs `cloudformation:DescribeStacks` and
`cognito-idp:ListUserPoolClients`.

## Post-deploy verification

1. Open the CloudFront URL; the frontend loads and the Cognito login screen works.
2. Sign in and run a journey search; the GraphQL Lambda is active and the Cognito authorizer accepts
   the token. The local `/health` endpoint is only available with `LOCAL_DEV=1`, not in Lambda mode.
3. Check the SQS queue and DLQ: the hourly rule should enqueue one `updateJourneyMonitors` message
   per hour.
4. Inspect the silver Lambda environment for `ALERT_TOPIC_ARN` and `TRANSFORM_VERSION`.
5. Check `tpm-silver-weekly` is `ENABLED` with `cron(30 3 ? * SUN *)` in `Etc/UTC`.
6. Confirm `TrainPriceMonitorAlerts` is the SNS topic used by the forwarder and the analytics failure
   destination.

For the analytics first run, see [analytics/README.md](../analytics/README.md). The schedule runs
Sunday 03:30 UTC, after the 03:00 compactor.

## Pause, rollback and retention

- **Pause the scraper:** set `CDK_SCRAPER_PAUSED=1` and redeploy. Poller and hydrator stop;
  compactor continues. This survives deploys unlike a manual console disable.
- **Pause analytics:** set `CDK_ANALYTICS_PAUSED=1` and redeploy. The schedule stays deployed but
  disabled.
- **Roll back an application deploy:** `cdk deploy` the previous commit; the S3/data resources are
  retained according to the stack policies. A rollback to a pre-proxy commit leaves the
  `DbProxyStack`s orphaned and the callers on the blocked direct path; the only safe rollback is to
  a proxy-aware commit (or restore the proxy env/IAM manually). Keep or delete the orphaned stacks
  explicitly (see the `CDK_DB_PROXY_REGIONS` note above).
- **Roll back a silver build:** move `silver/_latest.json` to an older manifest. Builds are kept for
  at least a day and the newest two are retained.
- **Quality reports** are kept indefinitely; `silver/builds/` keeps two builds.
- **`ToolkitCleaner`** removes unused CDK ECR/S3 assets daily, keeping assets newer than 10 days.

## SES and Pushover

- SES domain identity and DKIM are created by `InfrastructureStack`; add the DNS records before
  expecting mail. Set `CDK_SES_PRODUCTION_ACCESS=1` once production access is granted.
- CI writes the Pushover token and user key to the two SSM parameters read by the forwarder. Neither
  value is in a CDK template or `cdk diff`.
- The DB transport uses only the app-owned regional proxies.

## Cost guardrails

The account budget `TrainPriceMonitor-Monthly` is **$1.00 USD** with notifications at 50% actual and
100% forecasted. The CloudWatch free tier allows ten alarms, ten custom metrics and three dashboards;
the project uses ten alarms, ten custom metrics and two. Do not add an eleventh alarm or metric
without accepting the cost.
See [operations.md](operations.md).
