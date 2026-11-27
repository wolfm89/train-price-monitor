# Infrastructure — Agent Guide

AWS CDK v2 TypeScript stacks for Train Price Monitor. The root [`AGENTS.md`](../AGENTS.md) still
applies; this file adds the infrastructure and deployment rules.

## Commands

```bash
npm install
npm run build        # compile TypeScript
npm test             # Jest + ts-jest
npm run typecheck
npm run lint
npx cdk diff         # after mise run //...:build
npx cdk synth
```

From the repository root: `mise run //infrastructure:test` runs the tests.
`//infrastructure:deploy` and `//infrastructure:deploy-scraper` are human-only AWS deploys; see the
guardrail below. The full `deploy` task builds the frontend, backend and scraper assets first;
`deploy-scraper` builds only the scraper bundle. A raw `cdk deploy` from a fresh clone fails synth
or bakes stale bundles because those `dist/`/`build/` directories are consumed as assets.

## Deploy guardrail

- Always build and review `cdk diff` before a deploy. Never run `cdk deploy` without a human
  reviewing the diff, and never deploy from an agent session.
- `CDK_APP_NAME`, `CDK_DOMAIN_NAME` and `CDK_SES_FROM_EMAIL` must be set before synth; missing values
  fail at synth time.
- The deploy tasks pass `--require-approval never`; the reviewed diff is the only gate, so never run
  them unreviewed.

## Stacks

Seven stacks in the default configuration: `CertificateStack` in `us-east-1`; the two regional
`DbProxyStack`s in `CDK_DB_PROXY_REGIONS` (default `us-east-1,eu-central-1`); `AlertingStack`,
`InfrastructureStack`, `ScraperStack` and `AnalyticsStack` in `eu-central-1`. Responsibilities,
outputs, bootstrap and rollback are in [docs/deployment.md](../docs/deployment.md).

`DbProxyStack` is the DB egress proxy: one `NodejsFunction` per configured region that reaches the
Navigator API and reports the TLS fingerprint that served the request. It adds no VPC, NAT, alarm or
metric. It is capped at 20 s and 6 reserved concurrent executions, and gzips the response when the
caller advertises gzip. Keep the poller at
20 targets / 384 MB: projected Lambda usage is ~258-341k GB-s/month (64-85% of the 400k free tier),
and the existing budget forecast was $0.924 before the fix. Cross-region response data is the only
real incremental dollar cost; re-check the forecast after a full day.

Add new stacks under `lib/` and wire them in `bin/infrastructure.ts`. Extend `cdk.Stack`, use
descriptive construct IDs, prefer L2 constructs and accept `props?: cdk.StackProps`.

## Alerting and cost invariants

- One topic, `TrainPriceMonitorAlerts`, receives every alarm state change, budget notification and
  analytics failure. `PushoverForwarder` is the only Pushover adapter; no other service may send
  alerts.
- The free tier allows ten alarms, ten custom metrics and three dashboards. The project uses nine
  alarms, ten custom metrics and two dashboards. Do not add an eleventh alarm or metric without
  accepting the cost ($0.10 and $0.30 per month), and do not use metric math, Metrics Insights or
  anomaly-detection bands in alarms.
- Do not add SSE with the AWS-managed `alias/aws/sns` key: CloudWatch alarms cannot use it. A
  customer-managed key would exceed the €1 budget.
- The budget is `TrainPriceMonitor-Monthly`, $1.00 USD/month, ACTUAL 50 % and FORECASTED 100 %.
  Keep the manual `Zero-Spend Budget` until a real Budgets notification has been observed.
- Alarm names are prefixed `TPM-Scraper-` or `TPM-App-`; construct IDs omit the prefix.
- Custom metrics come from log filters on existing log lines; application code does not emit
  metrics. Do not add `PutMetricData` calls.
- Budget notifications are plain text, so the forwarder branches on the `AWS Budgets:` subject
  before JSON parsing. Keep that branch.
- The topic policy scopes publishers with `aws:SourceAccount`/`aws:SourceArn` conditions; keep them
  scoped when adding a publisher.
- IAM follows per-function least privilege: grant only the table and bucket actions that Lambda
  needs, not a shared read-write role.

## Runtime configuration and lifecycle

- Scraper sizing, tuning and retention live in `../shared/runtime-config.json`; analytics sizing,
  retention, retry and report values live in
  `../analytics/src/tpm_analytics/data/silver-config.json`. The weekly cron and timezone live in
  `lib/config.ts` and `lib/analytics-stack.ts`.
- `CDK_SCRAPER_PAUSED=1` disables the poller/hydrator schedules and their alarm actions; the
  compactor stays on. `CDK_ANALYTICS_PAUSED=1` disables the weekly silver schedule. Both survive
  deploys, unlike console changes.
- `ToolkitCleaner` runs daily and removes unused CDK assets from the bootstrap ECR repository and S3
  bucket, keeping assets newer than 10 days. There is no separate `cdk gc` step.
- Backend log groups are CDK-managed with 14-day retention:
  `InfrastructureStack-BackendLambdaLogs*`, `InfrastructureStack-BackendRefresherLambdaLogs*` and
  `InfrastructureStack-BackendApiGatewayLogs*`. Scraper groups are `ScraperStack-PollerLogs*`,
  `ScraperStack-HydratorLogs*` and `ScraperStack-CompactorLogs*`. Older
  `/aws/lambda/InfrastructureStack-Backend*` groups predate them; delete them or give them a
  retention. Do not create unretained log groups.

## Tests and hygiene

Jest tests use descriptive names, for example `test('SQS Queue Created')`. `jest.config.js` caps
workers at two; keep it there for low-memory machines. Never edit `cdk.out/`, and change
`package-lock.json` only through `npm install`. CloudFormation output keys carry a hash suffix;
`mise run env:local` resolves them by prefix, so do not copy a suffix into code or docs.

See [docs/deployment.md](../docs/deployment.md) for bootstrap, inputs, outputs, verification and
rollback.
