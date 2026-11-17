# Infrastructure (CDK)

AWS CDK v2 TypeScript stacks for Train Price Monitor.

> Part of [Train Price Monitor](../README.md). See [Deployment](../docs/deployment.md) for the
> bootstrap, inputs, outputs, verification and rollback flow, and [Architecture](../docs/architecture.md)
> for the runtime diagrams.

## Stacks

| Stack                 | Region         | Description                                                                                                              |
| --------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `CertificateStack`    | `us-east-1`    | ACM certificate for the CloudFront custom domain.                                                                        |
| `AlertingStack`       | `eu-central-1` | SNS alert topic, Pushover forwarder and the $1 monthly account budget.                                                   |
| `InfrastructureStack` | `eu-central-1` | CloudFront/S3 frontend, Cognito, API Gateway/GraphQL Lambda, DynamoDB, profile S3, SQS/refresher, SES, `ToolkitCleaner`. |
| `ScraperStack`        | `eu-central-1` | Scraper pipeline: DynamoDB schedule table, S3 bucket, 3 Lambda functions.                                                |
| `AnalyticsStack`      | `eu-central-1` | Weekly silver build: image Lambda, EventBridge Scheduler, IAM, SNS failure path.                                         |

`InfrastructureStack` also runs `ToolkitCleaner` daily: it removes unused CDK ECR and S3 assets
after checking deployed CloudFormation templates, keeping assets created in the last 10 days.

Scraper sizing/tuning and retention values live in `../shared/runtime-config.json`; analytics sizing,
retention, retry and report values live in `../analytics/src/tpm_analytics/data/silver-config.json`.
The weekly cron and timezone live in `lib/config.ts` and `analytics-stack.ts`.

## Outputs

CloudFormation output keys carry a hash suffix. `mise run env:local` resolves the prefixes with
`starts_with`; do not copy the suffix. Important prefixes: `FrontendCloudFrontUrl`,
`BackendApiEndpoint`, `BackendQueueUrl`, `BackendProfileImageBucketName`, `CognitoAuthUserPoolId`,
`CognitoAuthIdentityPoolId`, `ScraperBucketName`, `SilverFunctionName`, `SilverScheduleName`.

## Commands

Run these mise tasks from anywhere in the repo (they map to tasks in `.mise.toml`):

| Command                                          | Description                                        |
| ------------------------------------------------ | -------------------------------------------------- |
| `mise run //infrastructure:install`              | Install dependencies.                              |
| `mise run //infrastructure:build`                | Compile TypeScript.                                |
| `mise run //infrastructure:typecheck`            | TypeScript type check.                             |
| `mise run //infrastructure:lint`                 | ESLint check.                                      |
| `mise run //infrastructure:test`                 | Run Jest tests.                                    |
| `mise run //infrastructure:deploy`               | Deploy all stacks (builds frontend first).         |
| `mise run //infrastructure:deploy-scraper`       | Deploy only `ScraperStack` (builds scraper first). |
| `mise run //infrastructure:deploy-local-scraper` | Deploy `ScraperStack` to local Floci.              |
| `mise run //infrastructure:clean`                | Remove CDK synthesis output (`cdk.out`).           |

The deploy tasks wrap `cdk` with the correct dependencies and approval flags. For raw CDK access
(e.g. `cdk diff`, `cdk synth`, `cdk bootstrap`), run `npx cdk <command>` from this directory after
`npm run build`.

## Environment

The required CDK inputs and optional pause/SES/Decodo settings are in
[Configuration](../docs/configuration.md#cdk-deployment-inputs). Never commit credentials or
generated `.env` files.

For scraper architecture and local development, see [../scraper/README.md](../scraper/README.md);
for the analytics build, see [../analytics/README.md](../analytics/README.md).
