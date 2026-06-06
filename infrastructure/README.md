# Infrastructure (CDK)

AWS CDK v2 TypeScript stacks for the Train Price Monitor.

## Stacks

| Stack                 | Description                                                              |
| --------------------- | ------------------------------------------------------------------------ |
| `InfrastructureStack` | Main application stack: API Gateway, backend Lambda, Cognito, S3, SQS    |
| `CertificateStack`    | ACM certificate in us-east-1 for the custom domain                       |
| `ScraperStack`        | Scraper pipeline: DynamoDB schedule table, S3 bucket, 3 Lambda functions |

## Commands

Run these mise tasks from anywhere in the repo (they map to tasks in `mise.toml`):

| Command                                          | Description                                       |
| ------------------------------------------------ | ------------------------------------------------- |
| `mise run //infrastructure:install`              | Install dependencies                              |
| `mise run //infrastructure:build`                | Compile TypeScript                                |
| `mise run //infrastructure:typecheck`            | TypeScript type check                             |
| `mise run //infrastructure:lint`                 | ESLint check                                      |
| `mise run //infrastructure:test`                 | Run Jest tests                                    |
| `mise run //infrastructure:deploy`               | Deploy all stacks (builds frontend first)         |
| `mise run //infrastructure:deploy-scraper`       | Deploy only `ScraperStack` (builds scraper first) |
| `mise run //infrastructure:deploy-local-scraper` | Deploy `ScraperStack` to local Floci              |
| `mise run //infrastructure:clean`                | Remove CDK synthesis output (`cdk.out`)           |

The deploy tasks wrap `cdk` with the correct dependencies and approval flags. For raw CDK access
(e.g. `cdk diff`, `cdk synth`, `cdk bootstrap`), run `npx cdk <command>` from this directory.

For scraper architecture and local development, see [../scraper/README.md](../scraper/README.md).
