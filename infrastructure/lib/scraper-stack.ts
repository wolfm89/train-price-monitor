import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cloudwatch_actions,
  aws_dynamodb as dynamodb,
  aws_s3 as s3,
  aws_lambda as lambda,
  aws_events as events,
  aws_events_targets as targets,
  aws_logs as logs,
  aws_sns as sns,
} from 'aws-cdk-lib';
import { DASHBOARD_START, scraperWidgets } from './dashboards';

interface ScraperStackProps extends cdk.StackProps {
  /** Pin the S3 bucket name (useful locally; undefined → CDK-generated name in prod). */
  bucketName?: string;
  /** Override the hydrator lookahead window (useful locally; undefined → 90 days in prod). */
  hydratorLookaheadDays?: number;
  /** ARN of the alert topic (owned by AlertingStack). */
  alertTopicArn?: string;
}

export class ScraperStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: ScraperStackProps) {
    super(scope, id, props);

    // -------------------------------------------------------------------------
    // DynamoDB table: ScraperSchedule
    // PK: ROUTE#{route_id}#DATE#{YYYY-MM-DD}, SK: SCHEDULE
    // GSI ByDue: PK=status, SK=due_key (`<tier rank>#<next_scrape_at>`), which the
    // poller reads one tier at a time (NEAR, MID, FAR) so a capacity shortfall
    // costs the far end of the horizon rather than next week's departures.
    // -------------------------------------------------------------------------
    const table = new dynamodb.Table(this, 'ScraperSchedule', {
      tableName: 'ScraperSchedule',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 5,
      writeCapacity: 5,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    table.addGlobalSecondaryIndex({
      indexName: 'ByDue',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'due_key', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
      readCapacity: 5,
      writeCapacity: 5,
    });

    // Transitional: CloudFormation rejects creating and deleting a GSI in one
    // update, so the old index stays for the release that introduces ByDue. It is
    // unused and removed by a follow-up deploy once ByDue is live everywhere.
    table.addGlobalSecondaryIndex({
      indexName: 'ByNextScrape',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'next_scrape_at', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
      readCapacity: 5,
      writeCapacity: 5,
    });

    // -------------------------------------------------------------------------
    // S3 bucket for Parquet price data
    // -------------------------------------------------------------------------
    const bucket = new s3.Bucket(this, 'ScraperData', {
      bucketName: props?.bucketName,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
        },
      ],
    });
    // -------------------------------------------------------------------------
    // Shared Lambda log groups (retain 2 weeks)
    // -------------------------------------------------------------------------
    const pollerLogGroup = new logs.LogGroup(this, 'PollerLogs', {
      retention: logs.RetentionDays.TWO_WEEKS,
    });

    const hydratorLogGroup = new logs.LogGroup(this, 'HydratorLogs', {
      retention: logs.RetentionDays.TWO_WEEKS,
    });

    const compactorLogGroup = new logs.LogGroup(this, 'CompactorLogs', {
      retention: logs.RetentionDays.TWO_WEEKS,
    });

    // -------------------------------------------------------------------------
    // Poller Lambda — runs every 15 minutes, scrapes due targets
    // Docker image: ../scraper/Dockerfile  (copies pre-built ESM bundle)
    //
    // A DockerImageFunction so the pre-built esbuild bundle at dist/poller/index.mjs
    // is copied into the image unchanged (no build inside the container). The
    // transport is pure Node (node:https) with rotating TLS profiles; see
    // ../../shared/db-fetch.ts. x86_64 to match the Lambda architecture.
    //
    // Sizing: the work is network-bound (a paced call every ~2.5 s), so memory
    // only needs to hold the route catalog, the AWS SDK and one batch of Parquet
    // rows.
    // -------------------------------------------------------------------------
    const POLLER_BATCH_SIZE = 25;
    const pollerFn = new lambda.DockerImageFunction(this, 'ScraperPoller', {
      code: lambda.DockerImageCode.fromImageAsset('../scraper'),
      architecture: lambda.Architecture.X86_64,
      memorySize: 512,
      // A 25-target batch is ~50 paced calls (~125 s), and the p90 run is ~190 s.
      // ABORT_THRESHOLD_MS in scraper/src/poller.ts (250 s) leaves 50 s for the
      // current target's worst case (~43 s) and the final S3 upload.
      timeout: cdk.Duration.seconds(300),
      logGroup: pollerLogGroup,
      environment: {
        SCRAPER_TABLE_NAME: table.tableName,
        SCRAPER_BUCKET_NAME: bucket.bucketName,
        POWERTOOLS_SERVICE_NAME: 'scraper-poller',
        // 25 targets = 50 API calls per run (~2,400 scrapes/day), comfortably
        // above the ~1,654 the TTD intervals need, so the backlog drains in about
        // a week. Raise it only while the transport stats in the "Poller finished"
        // log stay clean.
        SCRAPER_BATCH_SIZE: String(POLLER_BATCH_SIZE),
        // Spacing and concurrency of DB calls (see shared/db-fetch.ts). Measured:
        // 6 parallel calls were fine, a 60-call burst got the IP throttled for
        // minutes, 24 calls one at a time with 2.5 s gaps all succeeded.
        DB_MIN_GAP_MS: '2500',
        DB_MAX_IN_FLIGHT: '2',
        // One target makes two calls in parallel; 45 s covers two 20 s attempts
        // plus backoff, and 250 s guard + 45 s + upload stays under the timeout.
        DB_TOTAL_BUDGET_MS: '45000',
        // No Decodo key on purpose: the poller is bulk work and must never spend
        // the free allowance. When DB throttles it stops the batch instead.
      },
    });

    // -------------------------------------------------------------------------
    // Hydrator Lambda — runs nightly at 02:00 UTC, seeds schedule rows
    // Bundle: ../scraper/dist/hydrator/index.mjs  (ESM, pre-built by esbuild)
    // -------------------------------------------------------------------------
    const hydratorFn = new lambda.Function(this, 'ScraperHydrator', {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      code: lambda.Code.fromAsset('../scraper/dist/hydrator'),
      handler: 'index.handler',
      memorySize: 128,
      // A normal run only seeds the newest few days (~420 conditional writes,
      // well under a minute at 5 WCU). The generous timeout exists for the
      // manual HYDRATOR_FULL_SEED backfill, which rewrites the whole lookahead
      // window and is bounded by the table's write capacity rather than by CPU.
      timeout: cdk.Duration.minutes(15),
      logGroup: hydratorLogGroup,
      environment: {
        SCRAPER_TABLE_NAME: table.tableName,
        POWERTOOLS_SERVICE_NAME: 'scraper-hydrator',
        ...(props?.hydratorLookaheadDays !== undefined && {
          HYDRATOR_LOOKAHEAD_DAYS: String(props.hydratorLookaheadDays),
        }),
      },
    });

    // -------------------------------------------------------------------------
    // Compactor Lambda — runs nightly at 03:00 UTC, consolidates price files
    // Bundle: ../scraper/dist/compactor/index.mjs  (ESM, pre-built by esbuild)
    // -------------------------------------------------------------------------
    const compactorFn = new lambda.Function(this, 'ScraperCompactor', {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      code: lambda.Code.fromAsset('../scraper/dist/compactor'),
      handler: 'index.handler',
      // The compactor holds a whole day of rows in memory before re-serializing
      // them, so its footprint tracks scrape volume. 3072 MB was sized when the
      // poller ran every minute (~21,600 targets/day, peaking at ~1022 MB of
      // actual use). The poller collects ~1,150 targets/day, so
      // a day's partition is roughly an order of magnitude smaller. 1536 MB
      // keeps generous headroom over that; re-check Max Memory Used after the
      // first full-day compaction at the new volume before trimming further.
      memorySize: 1536,
      timeout: cdk.Duration.seconds(300),
      logGroup: compactorLogGroup,
      environment: {
        SCRAPER_BUCKET_NAME: bucket.bucketName,
        POWERTOOLS_SERVICE_NAME: 'scraper-compactor',
      },
    });

    // -------------------------------------------------------------------------
    // IAM permissions (least privilege)
    // -------------------------------------------------------------------------
    table.grantReadWriteData(pollerFn);
    table.grantReadWriteData(hydratorFn);
    bucket.grantPut(pollerFn);
    bucket.grantReadWrite(compactorFn);

    // -------------------------------------------------------------------------
    // EventBridge rules
    // -------------------------------------------------------------------------
    // The poller and hydrator can be paused from configuration (context key
    // `scraper_paused`, set from CDK_SCRAPER_PAUSED=1). Pausing by hand in the
    // console would be undone by the next deploy that touches the rule; this
    // survives deploys. The compactor stays on: it costs next to nothing.
    const scraperPaused = String(this.node.tryGetContext('scraper_paused') ?? '') === '1';

    new events.Rule(this, 'PollerSchedule', {
      enabled: !scraperPaused,
      // Every 15 minutes with a small batch: ~2,400 scrapes/day, above what the
      // TTD intervals demand. Bigger or more frequent bursts risk getting the
      // Lambda's egress IP throttled by DB.
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
      targets: [new targets.LambdaFunction(pollerFn)],
    });

    new events.Rule(this, 'HydratorSchedule', {
      enabled: !scraperPaused,
      // 02:00 UTC daily
      schedule: events.Schedule.cron({ minute: '0', hour: '2' }),
      targets: [new targets.LambdaFunction(hydratorFn)],
    });

    new events.Rule(this, 'CompactorSchedule', {
      // 03:00 UTC daily
      schedule: events.Schedule.cron({ minute: '0', hour: '3' }),
      targets: [new targets.LambdaFunction(compactorFn)],
    });

    // -------------------------------------------------------------------------
    // Alarms and dashboard (CloudWatch free tier: 9 alarms, 4 custom metrics)
    // -------------------------------------------------------------------------
    const alertTopic = props?.alertTopicArn
      ? sns.Topic.fromTopicArn(this, 'AlertTopic', props.alertTopicArn)
      : undefined;

    // The poller logs one "Poller finished" line per run with the transport
    // counters; these filters turn them into metrics without any extra code.
    new logs.MetricFilter(this, 'PollerDirectOkFilter', {
      logGroup: pollerLogGroup,
      filterPattern: logs.FilterPattern.stringValue('$.message', '=', 'Poller finished'),
      metricNamespace: 'TrainPriceMonitor',
      metricName: 'PollerDirectOk',
      metricValue: '$.transport.directOk',
    });
    new logs.MetricFilter(this, 'PollerThrottledFilter', {
      logGroup: pollerLogGroup,
      filterPattern: logs.FilterPattern.stringValue('$.message', '=', 'Poller finished'),
      metricNamespace: 'TrainPriceMonitor',
      metricName: 'PollerThrottled',
      metricValue: '$.transport.directThrottled',
    });
    // One metric per scraped target (the transport counters are per DB call, and
    // there are two calls per target). Used by the dashboard and within the free
    // custom-metric allowance.
    new logs.MetricFilter(this, 'PollerTargetsFilter', {
      logGroup: pollerLogGroup,
      filterPattern: logs.FilterPattern.stringValue('$.message', '=', 'Target scraped'),
      metricNamespace: 'TrainPriceMonitor',
      metricName: 'PollerTargetsScraped',
      metricValue: '1',
    });

    // Errors signal: targets that failed to scrape (DB refusal, timeout, ...).
    new logs.MetricFilter(this, 'PollerFailedFilter', {
      logGroup: pollerLogGroup,
      filterPattern: logs.FilterPattern.stringValue('$.message', '=', 'Failed to scrape target'),
      metricNamespace: 'TrainPriceMonitor',
      metricName: 'PollerFailedTargets',
      metricValue: '1',
    });

    // Data volume: rows written per Parquet batch.
    new logs.MetricFilter(this, 'PollerRowsFilter', {
      logGroup: pollerLogGroup,
      filterPattern: logs.FilterPattern.stringValue('$.message', '=', 'Parquet written to S3'),
      metricNamespace: 'TrainPriceMonitor',
      metricName: 'PollerRowsWritten',
      metricValue: '$.rows',
    });

    // Runs that hit the abort threshold. A slow-but-complete run is not a problem;
    // one that has to stop early is, and the log line says why.
    new logs.MetricFilter(this, 'PollerAbortedFilter', {
      logGroup: pollerLogGroup,
      filterPattern: logs.FilterPattern.stringValue('$.message', '=', 'Approaching timeout, aborting batch'),
      metricNamespace: 'TrainPriceMonitor',
      metricName: 'PollerAborted',
      metricValue: '1',
    });

    // Saturation signal: 1 when the due queue is deeper than one batch.
    new logs.MetricFilter(this, 'PollerBacklogFilter', {
      logGroup: pollerLogGroup,
      filterPattern: logs.FilterPattern.stringValue('$.message', '=', 'Poller started'),
      metricNamespace: 'TrainPriceMonitor',
      metricName: 'PollerBacklog',
      metricValue: '$.backlog',
    });

    const directOk = new cloudwatch.Metric({
      namespace: 'TrainPriceMonitor',
      metricName: 'PollerDirectOk',
      period: cdk.Duration.minutes(15),
      statistic: 'Sum',
    });
    const throttled = new cloudwatch.Metric({
      namespace: 'TrainPriceMonitor',
      metricName: 'PollerThrottled',
      period: cdk.Duration.minutes(15),
      statistic: 'Sum',
    });
    const aborted = new cloudwatch.Metric({
      namespace: 'TrainPriceMonitor',
      metricName: 'PollerAborted',
      period: cdk.Duration.minutes(15),
      statistic: 'Sum',
    });

    // A deliberate pause must not page anyone: the pause switch disables the
    // actions of the poller alarms (they still record state in the console).
    const actionsEnabled = !scraperPaused;

    const notRunning = new cloudwatch.Alarm(this, 'PollerNotRunning', {
      alarmDescription: 'The poller has not run for 45 minutes: schedule disabled or function broken.',
      metric: pollerFn.metricInvocations({ period: cdk.Duration.minutes(15), statistic: 'Sum' }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      actionsEnabled,
    });

    const pollerErrors = new cloudwatch.Alarm(this, 'PollerErrors', {
      alarmDescription: 'The poller returned errors.',
      metric: pollerFn.metricErrors({ period: cdk.Duration.minutes(15), statistic: 'Sum' }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      actionsEnabled,
    });

    const dbThrottling = new cloudwatch.Alarm(this, 'PollerThrottledByDb', {
      alarmDescription:
        'DB has throttled the poller in two consecutive runs (early warning before the fingerprint is blocked).',
      metric: throttled,
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      actionsEnabled,
    });

    const noPrices = new cloudwatch.Alarm(this, 'PollerNoPrices', {
      alarmDescription: 'No target has returned prices for 45 minutes: DB is refusing every request.',
      metric: directOk,
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      actionsEnabled,
    });

    const batchAborted = new cloudwatch.Alarm(this, 'PollerBatchAborted', {
      alarmDescription: 'A poller run hit the abort threshold (it stopped before finishing its batch).',
      metric: aborted,
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      actionsEnabled,
    });

    for (const alarm of [notRunning, pollerErrors, dbThrottling, noPrices, batchAborted]) {
      if (alertTopic) {
        alarm.addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));
        alarm.addOkAction(new cloudwatch_actions.SnsAction(alertTopic));
      }
    }

    // The construct id is kept from the previous dashboard implementation so
    // CloudFormation updates this resource instead of creating a second one with
    // the same name.
    new cloudwatch.Dashboard(this, 'ScraperDashboard', {
      dashboardName: 'TrainPriceMonitor-Scraper',
      start: DASHBOARD_START,
      widgets: scraperWidgets({
        batchSize: POLLER_BATCH_SIZE,
        pollerFunction: pollerFn,
        hydratorFunction: hydratorFn,
        compactorFunction: compactorFn,
        scheduleTable: table,
        dataBucket: bucket,
        pollerLogGroup,
        alarms: [notRunning, pollerErrors, dbThrottling, noPrices, batchAborted],
      }),
    });

    // -------------------------------------------------------------------------
    // Stack outputs
    // -------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ScraperTableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'ScraperBucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'PollerFunctionName', { value: pollerFn.functionName });
    new cdk.CfnOutput(this, 'HydratorFunctionName', { value: hydratorFn.functionName });
    new cdk.CfnOutput(this, 'CompactorFunctionName', { value: compactorFn.functionName });
  }
}
