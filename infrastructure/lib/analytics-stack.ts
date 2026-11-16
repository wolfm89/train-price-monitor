import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  aws_ecr_assets as ecrAssets,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_destinations as lambdaDestinations,
  aws_logs as logs,
  aws_s3 as s3,
  aws_scheduler as scheduler,
  aws_scheduler_targets as schedulerTargets,
  aws_sns as sns,
} from 'aws-cdk-lib';
import { ANALYTICS_SCHEDULE_NAME, SCHEDULES, SILVER_CONFIG } from './config';

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
      memorySize: SILVER_CONFIG.lambda.memory_mib,
      timeout: cdk.Duration.seconds(SILVER_CONFIG.lambda.timeout_seconds),
      ephemeralStorageSize: cdk.Size.mebibytes(SILVER_CONFIG.lambda.ephemeral_mib),
      reservedConcurrentExecutions: 1,
      // One async retry covers transient S3/throttle errors; every run has a fresh build id
      // and the pointer is the only commit, so a duplicate is safe. The max age is longer
      // than the timeout so a late first attempt still leaves time for the retry.
      retryAttempts: SILVER_CONFIG.lambda.retry_attempts,
      maxEventAge: cdk.Duration.minutes(SILVER_CONFIG.lambda.max_event_age_minutes),
      // The handler raises a structured payload; this destination publishes it after the
      // retries and also covers a timeout/OOM where the handler cannot run.
      onFailure: new lambdaDestinations.SnsDestination(props.alertTopic),
      logGroup,
      environment: {
        SILVER_BUCKET: props.dataBucket.bucketName,
        SILVER_PREFIX: SILVER_CONFIG.prefix,
        BRONZE_SOURCE: `s3://${props.dataBucket.bucketName}/${SILVER_CONFIG.bronze_prefix}/**/*.parquet`,
        SILVER_THREADS: String(SILVER_CONFIG.lambda.threads),
        SILVER_MEMORY_LIMIT: SILVER_CONFIG.lambda.duckdb_memory_limit,
        SILVER_MAX_TEMP_SIZE: SILVER_CONFIG.lambda.duckdb_max_temp_size,
        SILVER_KEEP: String(SILVER_CONFIG.keep),
        // Empty (manual deploy) lets the handler record sql-<hash>; CI supplies the SHA.
        TRANSFORM_VERSION: (props.transformVersion || '').slice(0, 12),
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
        conditions: {
          StringLike: {
            's3:prefix': [`${SILVER_CONFIG.bronze_prefix}/*`, `${SILVER_CONFIG.prefix}/*`],
          },
        },
      })
    );

    // Bronze: read only. DuckDB httpfs reads the explicit snapshot URLs; the handler has
    // already listed the keys, so no list is needed for the read itself.
    silverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [`${bucketArn}/${SILVER_CONFIG.bronze_prefix}/*`],
      })
    );

    // Silver: upload/read back. Deleting and aborting is limited to build prefixes; the
    // pointer is never deleted by the handler. boto3 upload_file uses multipart for the
    // ~60 MB parquet files.
    silverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject'],
        resources: [`${bucketArn}/${SILVER_CONFIG.prefix}/*`],
      })
    );
    silverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:DeleteObject', 's3:AbortMultipartUpload'],
        resources: [`${bucketArn}/${SILVER_CONFIG.prefix}/${SILVER_CONFIG.builds_root}/*`],
      })
    );

    // The async on-failure destination publishes with the function's execution role.
    props.alertTopic.grantPublish(silverFunction);

    const analyticsPaused = String(this.node.tryGetContext('analytics_paused') ?? '') === '1';
    const analyticsSchedule = SCHEDULES.analytics;
    const schedule = new scheduler.Schedule(this, 'SilverSchedule', {
      scheduleName: ANALYTICS_SCHEDULE_NAME,
      description: `Weekly silver rebuild (Sunday ${String(analyticsSchedule.hour).padStart(2, '0')}:${String(
        analyticsSchedule.minute
      ).padStart(2, '0')} UTC), after the ${String(SCHEDULES.compactor.hour).padStart(2, '0')}:${String(
        SCHEDULES.compactor.minute
      ).padStart(2, '0')} compactor.`,
      enabled: !analyticsPaused,
      // UTC on purpose: the compactor runs at 03:00 UTC. A Europe/Berlin schedule would
      // drift to 02:30 UTC in summer and read bronze before the compactor has run.
      schedule: scheduler.ScheduleExpression.cron({
        minute: String(analyticsSchedule.minute),
        hour: String(analyticsSchedule.hour),
        weekDay: 'SUN',
        timeZone: cdk.TimeZone.ETC_UTC,
      }),
      target: new schedulerTargets.LambdaInvoke(silverFunction, {
        // Scheduler's retry policy only covers the Invoke API: a 202 means the function
        // already started. Two retries handle transient throttling/5xx without repeating
        // a build; the short max age prevents a very late duplicate.
        retryAttempts: SILVER_CONFIG.schedule.retry_attempts,
        maxEventAge: cdk.Duration.minutes(SILVER_CONFIG.schedule.max_event_age_minutes),
      }),
    });

    new cdk.CfnOutput(this, 'SilverFunctionName', { value: silverFunction.functionName });
    new cdk.CfnOutput(this, 'SilverScheduleName', { value: schedule.scheduleName });
    new cdk.CfnOutput(this, 'SilverLogGroupName', { value: logGroup.logGroupName });
    new cdk.CfnOutput(this, 'SilverPointer', {
      value: `s3://${props.dataBucket.bucketName}/${SILVER_CONFIG.prefix}/${SILVER_CONFIG.pointer_name}`,
    });
  }
}
