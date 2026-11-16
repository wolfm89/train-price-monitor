import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  aws_ecr_assets as ecrAssets,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_s3 as s3,
  aws_scheduler as scheduler,
  aws_scheduler_targets as schedulerTargets,
  aws_sns as sns,
} from 'aws-cdk-lib';

export interface AnalyticsStackProps extends cdk.StackProps {
  /** Scraper bucket: bronze under prices/, silver under silver/. */
  readonly dataBucket: s3.IBucket;
  /** Alert topic owned by AlertingStack. */
  readonly alertTopic: sns.ITopic;
  /** Commit SHA recorded in the manifest; empty → handler falls back to the SQL hash. */
  readonly transformVersion?: string;
}

/**
 * Weekly silver rebuild.
 *
 * The stack owns no data: it reads bronze under `prices/`, writes `silver/` in the
 * ScraperStack bucket, and publishes failures to the AlertingStack topic. There is no
 * VPC and no new alarm; the 10-alarm/10-metric allowance is already full.
 */
export class AnalyticsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AnalyticsStackProps) {
    super(scope, id, props);

    const logGroup = new logs.LogGroup(this, 'SilverBuildLogs', {
      retention: logs.RetentionDays.TWO_WEEKS,
      // The stack owns no data; do not leave a retained log group behind on cdk destroy.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const silverFunction = new lambda.DockerImageFunction(this, 'SilverBuildLambda', {
      code: lambda.DockerImageCode.fromImageAsset('../analytics', {
        // Lambda runs x86_64. Pinning the asset platform makes an ARM workstation fail
        // loudly instead of publishing an arm64 image the function cannot start.
        // Requires Docker Buildx (present on GitHub runners and current Docker Desktop).
        platform: ecrAssets.Platform.LINUX_AMD64,
        // `.dockerignore` is honoured in Docker ignore mode; this keeps .venv, tests and
        // caches out of both the asset fingerprint and the build context.
        ignoreMode: cdk.IgnoreMode.DOCKER,
      }),
      architecture: lambda.Architecture.X86_64,
      memorySize: 10240,
      timeout: cdk.Duration.seconds(900),
      ephemeralStorageSize: cdk.Size.mebibytes(10240),
      reservedConcurrentExecutions: 1,
      // One attempt. Function errors are deterministic (gate/refusal); throttle retries
      // are capped by maxEventAge so a run queued behind a manual build is dropped.
      retryAttempts: 0,
      maxEventAge: cdk.Duration.minutes(15),
      logGroup,
      environment: {
        SILVER_BUCKET: props.dataBucket.bucketName,
        SILVER_PREFIX: 'silver',
        BRONZE_SOURCE: `s3://${props.dataBucket.bucketName}/prices/**/*.parquet`,
        SILVER_THREADS: '4',
        SILVER_MEMORY_LIMIT: '8GB',
        SILVER_MAX_TEMP_SIZE: '5GB',
        SILVER_KEEP: '2',
        // Empty (manual deploy) lets the handler record sql-<hash>; CI supplies the SHA.
        TRANSFORM_VERSION: (props.transformVersion || '').slice(0, 12),
        ALERT_TOPIC_ARN: props.alertTopic.topicArn,
        // Lambda reserves AWS_LAMBDA_LOG_GROUP_NAME; a plain name keeps the failure
        // message's log link deterministic.
        LOG_GROUP_NAME: logGroup.logGroupName,
        // Do NOT set AWS_REGION: Lambda reserves it and injects the stack region.
      },
    });

    const bucketArn = props.dataBucket.bucketArn;

    // List the bronze snapshot and the silver tree. s3:prefix is the ListBucket condition
    // key; the handler always lists with a prefix (prices/, silver/, silver/builds/).
    silverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [bucketArn],
        conditions: { StringLike: { 's3:prefix': ['prices/*', 'silver/*'] } },
      })
    );

    // Bronze: read only. DuckDB httpfs reads the explicit snapshot URLs; the handler has
    // already listed the keys, so no list is needed for the read itself.
    silverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [`${bucketArn}/prices/*`],
      })
    );

    // Silver: upload, read back for verification, delete expired builds, abort multipart
    // uploads. boto3 upload_file uses multipart for the ~60 MB parquet files.
    silverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload'],
        resources: [`${bucketArn}/silver/*`],
      })
    );

    props.alertTopic.grantPublish(silverFunction);

    const analyticsPaused = String(this.node.tryGetContext('analytics_paused') ?? '') === '1';
    const schedule = new scheduler.Schedule(this, 'SilverSchedule', {
      scheduleName: 'tpm-silver-weekly',
      description: 'Weekly silver rebuild (Sunday 03:30 UTC), after the 03:00 compactor.',
      enabled: !analyticsPaused,
      // UTC on purpose: the compactor runs at 03:00 UTC. A Europe/Berlin schedule would
      // drift to 02:30 UTC in summer and read bronze before the compactor has run.
      schedule: scheduler.ScheduleExpression.cron({
        minute: '30',
        hour: '3',
        weekDay: 'SUN',
        timeZone: cdk.TimeZone.ETC_UTC,
      }),
      target: new schedulerTargets.LambdaInvoke(silverFunction, {
        // Scheduler's default is 185 retries over 24 h. The Invoke API returning 202 is
        // success; function failures are Lambda's async retry domain, disabled above.
        // No DLQ: the handler's SNS message is the signal, and TargetErrorCount stays
        // visible in the console for Invoke-API problems.
        retryAttempts: 0,
      }),
    });

    new cdk.CfnOutput(this, 'SilverFunctionName', { value: silverFunction.functionName });
    new cdk.CfnOutput(this, 'SilverScheduleName', { value: schedule.scheduleName });
    new cdk.CfnOutput(this, 'SilverLogGroupName', { value: logGroup.logGroupName });
    new cdk.CfnOutput(this, 'SilverPointer', {
      value: `s3://${props.dataBucket.bucketName}/silver/_latest.json`,
    });
  }
}
