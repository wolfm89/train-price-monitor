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
    // Poller Lambda — runs every 1 minute, scrapes due targets
    // Docker image: ../scraper/Dockerfile  (copies pre-built ESM bundle)
    //
    // Must be a DockerImageFunction (not a Node.js runtime Lambda) because
    // Akamai's IP-reputation rule blocks outbound HTTP from AWS Node.js runtime
    // Lambda egress IPs. Docker Lambda uses different egress IPs and is not
    // blocked. The esbuild bundle at dist/poller/index.mjs is copied into the
    // image unchanged — no build happens inside the container.
    // -------------------------------------------------------------------------
    const pollerFn = new lambda.DockerImageFunction(this, 'ScraperPoller', {
      code: lambda.DockerImageCode.fromImageAsset('../scraper'),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
      logGroup: pollerLogGroup,
      environment: {
        SCRAPER_TABLE_NAME: table.tableName,
        SCRAPER_BUCKET_NAME: bucket.bucketName,
        POWERTOOLS_SERVICE_NAME: 'scraper-poller',
      },
    });

    // -------------------------------------------------------------------------
    // Hydrator Lambda — runs nightly at 02:00 UTC, seeds schedule rows
    // Bundle: ../scraper/dist/hydrator/index.mjs  (ESM, pre-built by esbuild)
    // -------------------------------------------------------------------------
    const hydratorFn = new lambda.Function(this, 'ScraperHydrator', {
      functionName: 'scraper-hydrator',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      code: lambda.Code.fromAsset('../scraper/dist/hydrator'),
      handler: 'index.handler',
      memorySize: 128,
      timeout: cdk.Duration.seconds(120),
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
      functionName: 'scraper-compactor',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      code: lambda.Code.fromAsset('../scraper/dist/compactor'),
      handler: 'index.handler',
      memorySize: 1024,
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
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
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
