import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  aws_dynamodb as dynamodb,
  aws_s3 as s3,
  aws_lambda as lambda,
  aws_events as events,
  aws_events_targets as targets,
  aws_logs as logs,
} from 'aws-cdk-lib';

interface ScraperStackProps extends cdk.StackProps {
  /** Pin the S3 bucket name (useful locally; undefined → CDK-generated name in prod). */
  bucketName?: string;
  /** Override the hydrator lookahead window (useful locally; undefined → 90 days in prod). */
  hydratorLookaheadDays?: number;
}

export class ScraperStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: ScraperStackProps) {
    super(scope, id, props);

    // -------------------------------------------------------------------------
    // DynamoDB table: ScraperSchedule
    // PK: ROUTE#{route_id}#DATE#{YYYY-MM-DD}, SK: SCHEDULE
    // GSI ByNextScrape: PK=status, SK=next_scrape_at
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
    // A DockerImageFunction because the bundle needs `impit` next to it: a native
    // HTTP client that imitates Firefox's TLS/HTTP2 handshake, which is what DB's
    // Akamai edge accepts (see ../../shared/db-fetch.ts). The esbuild bundle at
    // dist/poller/index.mjs is copied into the image unchanged — no build happens
    // inside the container. x86_64, because the image installs impit's
    // linux-x64-gnu binary.
    //
    // Sizing: the work is network-bound (a paced call every ~2.5 s), so memory
    // only needs to hold the route catalog, the AWS SDK and one batch of Parquet
    // rows.
    // -------------------------------------------------------------------------
    const pollerFn = new lambda.DockerImageFunction(this, 'ScraperPoller', {
      code: lambda.DockerImageCode.fromImageAsset('../scraper'),
      architecture: lambda.Architecture.X86_64,
      memorySize: 512,
      // A 12-target batch is ~24 paced calls (~70 s). ABORT_THRESHOLD_MS in
      // scraper/src/poller.ts (150 s) is deliberately below this.
      timeout: cdk.Duration.seconds(180),
      logGroup: pollerLogGroup,
      environment: {
        SCRAPER_TABLE_NAME: table.tableName,
        SCRAPER_BUCKET_NAME: bucket.bucketName,
        POWERTOOLS_SERVICE_NAME: 'scraper-poller',
        // 12 targets = 24 API calls per run: a deliberately small start. Raise it
        // only while the transport stats in the "Poller finished" log stay clean
        // (no throttled calls, breaker never opened). See AGENTS.md.
        SCRAPER_BATCH_SIZE: '12',
        // Spacing and concurrency of DB calls (see shared/db-fetch.ts). Measured:
        // 6 parallel calls were fine, a 60-call burst got the IP throttled for
        // minutes, 24 calls one at a time with 2.5 s gaps all succeeded.
        DB_MIN_GAP_MS: '2500',
        DB_MAX_IN_FLIGHT: '2',
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
      // Every 15 minutes with a small batch: ~1,150 scrapes/day (see ttd.ts).
      // Bigger or more frequent bursts risk getting the Lambda's egress IP
      // throttled by DB.
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
    // Stack outputs
    // -------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ScraperTableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'ScraperBucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'PollerFunctionName', { value: pollerFn.functionName });
    new cdk.CfnOutput(this, 'HydratorFunctionName', { value: hydratorFn.functionName });
    new cdk.CfnOutput(this, 'CompactorFunctionName', { value: compactorFn.functionName });
  }
}
