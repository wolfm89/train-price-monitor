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
    // Poller Lambda — runs every 6 minutes, scrapes due targets
    // Docker image: ../scraper/Dockerfile  (copies pre-built ESM bundle)
    //
    // Must be a DockerImageFunction (not a Node.js runtime Lambda) because the
    // image ships a Chromium headless shell: DB's Akamai Bot Manager rejects
    // every non-browser TLS/HTTP2 fingerprint with `403 OPS_BLOCKED`, so the
    // poller drives a real browser (see ../../shared/browser-fetch.ts). The
    // esbuild bundle at dist/poller/index.mjs is copied into the image
    // unchanged — no build happens inside the container.
    //
    // x86_64 rather than arm64: Chromium's shared-library dependencies are
    // installed for the target architecture, which would need QEMU emulation to
    // build an arm64 image on an amd64 host.
    //
    // Sizing is cost-driven. Chromium cannot run in the previous 256 MB, and
    // Lambda duration cost scales with memory, so the goal is the lowest *safe*
    // setting rather than the fastest: per-call latency is network-bound
    // (~2.5 s at every size from 512–1536 MB), so extra memory buys no speedup.
    //
    // 768 MB was measured as safe for a bare browser (~615 MB peak) but is NOT
    // enough here: the poller also holds the route catalog, the AWS SDK and a
    // batch of Parquet rows, which pushed peak usage to 756 MB of 768 (98%) and
    // got Chromium killed mid-run ("Target page, context or browser has been
    // closed"). 1024 MB restores headroom.
    //
    // The enlarged /tmp is required, not optional: `--disable-dev-shm-usage`
    // makes Chromium put its shared-memory files under /tmp, and the default
    // 512 MB left it with <64 MB free.
    // -------------------------------------------------------------------------
    const pollerFn = new lambda.DockerImageFunction(this, 'ScraperPoller', {
      code: lambda.DockerImageCode.fromImageAsset('../scraper'),
      architecture: lambda.Architecture.X86_64,
      memorySize: 1024,
      ephemeralStorageSize: cdk.Size.gibibytes(1),
      timeout: cdk.Duration.seconds(180),
      logGroup: pollerLogGroup,
      environment: {
        SCRAPER_TABLE_NAME: table.tableName,
        SCRAPER_BUCKET_NAME: bucket.bucketName,
        POWERTOOLS_SERVICE_NAME: 'scraper-poller',
        // 18 targets = 36 API calls ≈ 102 s per run, measured at ~5.2 GB-s of
        // fixed per-run overhead plus ~4.93 GB-s per target. With the
        // 15-minute cadence below that is ~298,000 GB-s/month.
        //
        // This deliberately does not spend the whole free tier. The backend
        // scales with usage while the scraper does not: every monitored journey
        // costs ~4,380 GB-s/month to refresh hourly, and each journey search
        // costs ~10 GB-s because it has to drive the browser. Roughly
        // 100,000 GB-s/month is therefore left unclaimed as user headroom —
        // about 20 additional monitored journeys — on top of the ~10,000 GB-s
        // used by the hydrator and compactor and a 10% safety margin.
        SCRAPER_BATCH_SIZE: '18',
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
      // actual use). The browser-backed poller collects ~1,654 targets/day, so
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
    new events.Rule(this, 'PollerSchedule', {
      // Every 10 minutes rather than every minute. Driving a real browser
      // raises the memory floor from 256 MB to 1024 MB and per-call latency
      // from ~0.5 s to ~2.5 s, making each target ~6x more expensive; at the
      // original 1-minute cadence this function alone would cost roughly
      // €25–35/month.
      //
      // Cadence and batch size are chosen together to maximise scrapes per
      // free-tier GB-second. Each run pays ~5.2 GB-s of fixed overhead (browser
      // launch + origin navigation), so fewer, larger runs are cheaper per
      // target, so the cadence is stretched from 1 minute to 15. Cadence and
      // batch size are chosen together: each run pays ~5.2 GB-s of fixed
      // overhead (browser launch + origin navigation), so fewer, larger runs
      // cost less per target. 15 min x 18 yields ~1,728 scrapes/day, which is
      // just above the ~1,654/day the TTD intervals demand for a 60-day
      // horizon, so the schedule is actually met instead of permanently
      // overdue. Going longer still would add only a few percent while pushing
      // toward bursts large enough to risk rate limiting.
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
      targets: [new targets.LambdaFunction(pollerFn)],
    });

    new events.Rule(this, 'HydratorSchedule', {
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
