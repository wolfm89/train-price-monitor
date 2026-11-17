# Operations

Operational alerts, dashboards, budget and runbooks. The application is designed to stay inside the
AWS free tier: ten CloudWatch alarms, ten custom metrics, two dashboards and a **$1.00 USD** monthly
budget.

## Alert path

1. CloudWatch alarms, AWS Budgets, the analytics `onFailure` destination and quality warnings publish
   to `TrainPriceMonitorAlerts`.
2. The `PushoverForwarder` Lambda reads two SSM SecureStrings and sends a Pushover notification.
3. Alarm state changes and build failures use high priority with the siren; recovery, quality
   warnings and budget alerts use normal priority.

The forwarder is the only Pushover adapter. SNS cannot deliver to Pushover directly because it needs
an HTTPS subscription that answers `SubscriptionConfirmation`.

## Alarms

| Alarm                             | What it means                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `TPM-Scraper-PollerNotRunning`    | No poller invocation for 45 minutes; missing data is treated as breaching.                  |
| `TPM-Scraper-PollerErrors`        | The poller Lambda is failing.                                                               |
| `TPM-Scraper-PollerThrottledByDb` | DB throttling in two consecutive runs; a single 429 is noise.                               |
| `TPM-Scraper-PollerNoPrices`      | No direct successful scrape for 45 minutes.                                                 |
| `TPM-Scraper-PollerBatchAborted`  | A run hit the 250 s abort; the log line, not a raw duration threshold.                      |
| `TPM-App-SearchErrors`            | GraphQL search errors in the API.                                                           |
| `TPM-App-UsingDecodoFallback`     | The direct DB transport has been degraded for two consecutive hours.                        |
| `TPM-App-RefresherErrors`         | The hourly/daily SQS worker is failing.                                                     |
| `TPM-App-SearchThrottled`         | The GraphQL Lambda is being throttled (account concurrency limit reached).                  |
| `TPM-App-RefresherDLQ`            | A refresh message reached the dead-letter queue. Investigate, then purge; it stays 14 days. |

`TPM-App-UsingDecodoFallback` aggregates the API's GraphQL response line and the refresher's SQS
message line, so either path can raise it. A single fallback is not an incident; the alarm requires
two consecutive hours.

Do not add an eleventh alarm or custom metric without accepting the cost. Do not use metric math,
Metrics Insights or anomaly-detection bands in alarms; they are billed differently from the free
alarm metrics.

## Dashboards

- `TrainPriceMonitor-Scraper`: run duration vs the 250 s abort, scrapes per run, failed target
  scrapes, pipeline errors, DB throttling/backlog, price rows written, S3 storage and the last failed
  scrapes.
- `TrainPriceMonitor-App`: API p50/p90/p99 and integration latency, requests, GraphQL errors, 4xx/5xx,
  refresher duration and errors, Lambda throttles, DLQ depth/age, SES sends/deliveries/bounces/
  complaints and a diagnostics table for both log groups.

Both dashboards follow Google's Four Golden Signals: one row each for latency, traffic, errors and
saturation, plus alarm state. The app dashboard uses p50 < 200 ms as the interactive SLO, p99 < 8 s
as the search budget and 120 s as the refresher timeout; its error rate is
`(5xx + GraphQL errors) / invocations`, and 4xx counts as expired-token noise.

The SQS queue is not shown; one message per hour is consumed in under a second.

## Budget

`TrainPriceMonitor-Monthly` is **$1.00 USD/month** with ACTUAL 50% and FORECASTED 100%
notifications. AWS Budgets are USD-only, so $1.00 is the conservative €1 guardrail. The manual
`Zero-Spend Budget` is an email backstop until a real Budgets notification is observed; keep it until
then.

## Pause and resume

- **Scraper:** set `CDK_SCRAPER_PAUSED=1` and redeploy. Poller and hydrator stop; the compactor stays
  on. This survives deploys.
- **Analytics:** set `CDK_ANALYTICS_PAUSED=1` and redeploy. The schedule remains deployed but
  disabled. CI defaults to paused when the variable is unset; set `0` after first-run checks.
- **Budget/alerts:** do not disable the alert topic to silence a noisy alarm; fix the cause or tune
  the alarm.

## Runbooks

### DB throttling or `403 OPS_BLOCKED`

1. Check the `TPM-App-UsingDecodoFallback` alarm and the poller transport counters.
2. The backend uses the direct TLS transport first and Decodo as fallback when
   `DECODO_API_KEY_PARAM` resolves. If Decodo is unavailable, interactive search degrades.
3. The poller has no Decodo key. On throttling it ends the batch; untouched targets are retried by
   the next run. Do not raise `SCRAPER_BATCH_SIZE` while the transport counters are dirty.
4. If every TLS profile is blocked, wait for the profile cooldown or rotate the preferred profile;
   the breaker prevents hammering a throttled IP.

### Poller not running / no prices

1. Confirm the poller schedule is enabled (`CDK_SCRAPER_PAUSED` not `1`) and the Lambda has recent
   invocations.
2. Check the poller logs for `DbThrottledError`, TLS profile rotations and batch aborts.
3. Check the schedule table backlog: healthy runs drain 25 targets every 15 minutes; the `ByDue`
   index serves NEAR first.
4. If the backlog is deep, do not raise the batch size blindly; DB pacing is the constraint.

### SearchThrottled

1. Check Lambda `ConcurrentExecutions` and account concurrency limits. The API and refresher share
   the account's concurrency pool; a traffic spike or a stuck refresher can starve the API.
2. Reduce traffic, stop the refresher temporarily, or request a quota increase. The backend does not
   use reserved concurrency.

### Refresher errors or DLQ

1. Inspect the DLQ message and the refresher logs; the message is a GraphQL mutation.
2. Common causes are expired DB access, a missing journey, or a notification/SES failure.
3. Fix the cause, redrive if appropriate, and purge old messages after investigating. The DLQ
   retains messages for 14 days.

### Analytics build failure

1. The `onFailure` destination publishes one `silver_build_failed` event after every retry fails.
2. Check the analytics log group for the build id, stage and error type; the pointer is unchanged.
   A missing-object error can mean a compactor run deleted a listed `batch_*` file; wait for
   compaction to finish and rerun without overlapping it.
3. Re-run the weekly build with `aws lambda invoke --invocation-type Event`, or temporarily edit the
   schedule to fire once.
4. A failed report query blocks publish by design; a failed report write after publish is logged and
   does not roll back the build.

### Quality warning

1. The report is at `silver/quality/<build_id>.json`; `_latest.json` names the newest.
2. Check coverage, rows, null rates and freshness; the weekly warning is diagnostic, not a data
   corruption gate.
3. Tune thresholds only with evidence from several weekly reports; the current baseline is in
   [analytics/README.md](../analytics/README.md).

### SES bounces or complaints

1. Check the SES metrics and the notification block on the app dashboard.
2. Bounces/complaints are account-level; the sandbox workaround is controlled by
   `CDK_SES_PRODUCTION_ACCESS`.
3. Do not send to unverified addresses in sandbox mode.

## First-run checks

- After the first deploy, confirm the Lambda environment, the `tpm-silver-weekly` schedule and the
  alert topic as described in [deployment.md](deployment.md#post-deploy-verification).
- After the first weekly silver run, inspect `silver/_latest.json`,
  `silver/builds/<id>/_manifest.json` and `silver/quality/_latest.json`.
- Confirm the healthy baseline is `status: ok` and no quality warning was sent.
- Keep the manual `Zero-Spend Budget` until a real Budgets notification arrives.

## Retention

- DynamoDB: journey TTL after expiry + 7 days; notifications 90 days, but not before journey expiry
  - 7 days; unconfirmed sign-ups 7 days. See [privacy.md](privacy.md#retention).
- SQS: 4 days; DLQ 14 days.
- Logs: 14 days. Older `/aws/lambda/InfrastructureStack-Backend*` groups predate the CDK-managed
  groups; delete them or give them a retention.
- Silver builds: newest two; quality reports: kept indefinitely.
- Bronze Parquet: intended as the permanent historical record.

See [privacy.md](privacy.md) for the data-protection rules and [architecture.md](architecture.md) for
the pipeline shape.
