# Documentation

Start with the [README](../README.md) for the product overview and quick start. These documents go
deeper; each fact should live in one place and the code is the final source of truth.

## Reading paths

| I want to…                           | Read                                                                 |
| ------------------------------------ | -------------------------------------------------------------------- |
| Run the app locally                  | [Development](development.md)                                        |
| Deploy or change the infrastructure  | [Deployment](deployment.md)                                          |
| Understand the system                | [Architecture](architecture.md)                                      |
| Change a configuration value         | [Configuration](configuration.md)                                    |
| Operate or debug the deployment      | [Operations](operations.md)                                          |
| Understand stored data and retention | [Privacy](privacy.md)                                                |
| Work on the scraper or analytics     | [Scraper](../scraper/README.md), [Analytics](../analytics/README.md) |
| Contribute code                      | [Contributing](../CONTRIBUTING.md)                                   |

## Reference

| Document                          | Contents                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [Architecture](architecture.md)   | Context, containers, request/auth path, hourly refresh, scraper and analytics diagrams, data model, design decisions. |
| [Deployment](deployment.md)       | Stacks and regions, CDK inputs, bootstrap, deploy, outputs, verification, pause switches and rollback.                |
| [Development](development.md)     | Toolchain, `env:local`, frontend/backend/Docker workflows, tests and troubleshooting.                                 |
| [Configuration](configuration.md) | Canonical environment-variable reference, with scope, default and injection source.                                   |
| [Operations](operations.md)       | Alert topic, alarms, dashboards, budget, retention, runbooks and first-run checks.                                    |
| [Privacy](privacy.md)             | Data inventory, logging, export, deletion and retention rules.                                                        |

## Diagrams

The diagrams are single editable files with the drawio XML embedded. Open them directly in
[draw.io](https://www.drawio.com/) or export them from there.

| Diagram                                             | Scope                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [Web app](diagrams/web-app-aws.drawio.png)          | CloudFront/S3, Cognito, API Gateway, GraphQL Lambda, DynamoDB, SQS/refresher and SES. |
| [Scraper](diagrams/scraper-pipeline.drawio.png)     | EventBridge schedules, Hydrator/Poller/Compactor, schedule table and bronze S3.       |
| [Analytics](diagrams/analytics-pipeline.drawio.png) | Weekly scheduler, silver build, quality report and alerting.                          |

## Module READMEs

- [Frontend](../frontend/README.md)
- [Backend](../backend/README.md)
- [Scraper](../scraper/README.md)
- [Analytics](../analytics/README.md)
- [Infrastructure](../infrastructure/README.md)
