import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  aws_apigateway as apigateway,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cloudwatch_actions,
  aws_lambda as lambda,
  aws_dynamodb as dynamodb,
  aws_s3 as s3,
  aws_logs as logs,
  aws_events as events,
  aws_events_targets as targets,
  aws_sns as sns,
  aws_sqs as sqs,
  aws_lambda_event_sources as sources,
} from 'aws-cdk-lib';
import { tableDefinitions } from './dynamodb-tables';
import { decodoApiKeyParamName, grantDecodoApiKeyRead } from './decodo';
import { DASHBOARD_START, appWidgets } from './dashboards';
import { UserPool } from 'aws-cdk-lib/aws-cognito';
import { ResponseType } from 'aws-cdk-lib/aws-apigateway';

export class Backend extends Construct {
  constructor(
    scope: Construct,
    id: string,
    userPool: UserPool,
    frontendDomainName: string,
    sesFromEmail: string,
    alertTopic?: sns.ITopic
  ) {
    super(scope, id);

    // Create DynamoDB tables
    const tables: dynamodb.Table[] = tableDefinitions.map((tableDefinition: dynamodb.TableProps) => {
      if (tableDefinition.tableName === undefined) {
        throw new Error('Table name is not set.');
      }
      return new dynamodb.Table(this, tableDefinition.tableName, tableDefinition);
    });

    // Create S3 bucket
    const profileImageBucket = new s3.Bucket(this, 'ProfileImageBucket', {
      enforceSSL: true,
      encryption: s3.BucketEncryption.KMS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
        },
        {
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: [`https://${frontendDomainName}`, 'http://localhost:3000'],
          allowedHeaders: ['*'],
        },
      ],
    });

    // Create DLQ for failed messages
    const dlq = new sqs.Queue(this, 'TrainPriceMonitorDLQ', {
      retentionPeriod: cdk.Duration.days(14),
      visibilityTimeout: cdk.Duration.seconds(180),
    });

    // The visibility timeout must be at least the consuming function's timeout,
    // otherwise SQS re-delivers a message that is still being processed.
    const queue = new sqs.Queue(this, 'TrainPriceMonitorQueue', {
      visibilityTimeout: cdk.Duration.seconds(180),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });

    // Create Lambda function
    const apiLogGroup = new logs.LogGroup(this, 'LambdaLogs', {
      retention: logs.RetentionDays.TWO_WEEKS,
    });

    const commonEnvironment = {
      PROFILE_IMAGE_BUCKET_NAME: profileImageBucket.bucketName,
      TPM_SQS_QUEUE_URL: queue.queueUrl,
      FRONTEND_URL: `https://${frontendDomainName}`,
      SES_FROM_EMAIL: sesFromEmail,
      NODE_OPTIONS: '--enable-source-maps',
      DEPLOY_VERSION: 'v15',
      // DB is reached directly with a Firefox-imitating HTTP client; when DB
      // throttles the environment the request falls back to Decodo. Name of the
      // SSM SecureString holding the Decodo key; the value itself is never in the
      // template (see decodo.ts and shared/db-fetch.ts).
      DECODO_API_KEY_PARAM: decodoApiKeyParamName(this),
    };

    // Both functions run the same image (it contains `impit`, a native HTTP
    // client, next to the bundle). Only sizing, triggers and DB pacing differ.
    const lambdaFunction = new lambda.DockerImageFunction(this, 'GraphqlLambda', {
      code: lambda.DockerImageCode.fromImageAsset('../backend'),
      architecture: lambda.Architecture.X86_64,
      logGroup: apiLogGroup,
      // API Gateway REST cuts the integration off at 29 s, so there is no point
      // in running longer than that.
      timeout: cdk.Duration.seconds(29),
      memorySize: 512,
      environment: {
        ...commonEnvironment,
        // A user is waiting: one short direct attempt, then straight to Decodo.
        // Worst case is ~8 s direct + ~10 s Decodo, inside the 29 s cap.
        DB_MAX_ATTEMPTS: '1',
        DB_REQUEST_TIMEOUT_MS: '8000',
        DB_MIN_GAP_MS: '300',
        // API Gateway cuts the integration at 29 s; leave 5 s for start-up.
        DB_TOTAL_BUDGET_MS: '24000',
      },
    });

    const refresherLogGroup = new logs.LogGroup(this, 'RefresherLambdaLogs', {
      retention: logs.RetentionDays.TWO_WEEKS,
    });

    // Scheduled/queued work is isolated from the API so a slow refresh cannot
    // consume API concurrency, and so it can run past API Gateway's 29 s cap.
    // Nobody waits on it, so it is sized for cost rather than latency and paces
    // its DB calls gently (one journey after the other).
    const refresherFunction = new lambda.DockerImageFunction(this, 'RefresherLambda', {
      code: lambda.DockerImageCode.fromImageAsset('../backend'),
      architecture: lambda.Architecture.X86_64,
      logGroup: refresherLogGroup,
      timeout: cdk.Duration.seconds(120),
      memorySize: 512,
      environment: {
        ...commonEnvironment,
        DB_MIN_GAP_MS: '1500',
        DB_TOTAL_BUDGET_MS: '110000',
      },
    });

    // Add necessary IAM permissions
    profileImageBucket.grantReadWrite(lambdaFunction);
    tables.forEach((table: dynamodb.Table) => {
      table.grantReadWriteData(lambdaFunction);
      table.grantReadWriteData(refresherFunction);
    });
    // Journey search and the hourly refresh both fall back to Decodo.
    grantDecodoApiKeyRead(this, 'DecodoApiKey', [lambdaFunction, refresherFunction]);

    const logGroup = new logs.LogGroup(this, 'ApiGatewayLogs', {
      retention: logs.RetentionDays.TWO_WEEKS,
    });

    refresherFunction.addEventSource(new sources.SqsEventSource(queue, { batchSize: 1 }));
    queue.grantSendMessages(lambdaFunction);
    queue.grantSendMessages(refresherFunction);

    // Create EventBridge rule
    const rule = new events.Rule(this, 'UpdateJourneysRule', {
      schedule: events.Schedule.expression('rate(1 hour)'),
    });

    // Add SQS queue as a target for the EventBridge rule
    rule.addTarget(
      new targets.SqsQueue(queue, {
        message: events.RuleTargetInput.fromObject({
          query: 'mutation { updateJourneyMonitors }',
        }),
      })
    );

    const api = new apigateway.LambdaRestApi(this, 'GraphqlApi', {
      handler: lambdaFunction,
      proxy: true,
      cloudWatchRole: true,
      binaryMediaTypes: ['multipart/form-data'],
      defaultMethodOptions: {
        authorizer: new apigateway.CognitoUserPoolsAuthorizer(this, 'Authorizer', {
          cognitoUserPools: [userPool],
        }),
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: apigateway.Cors.DEFAULT_HEADERS,
        allowCredentials: true,
      },
      deployOptions: {
        accessLogDestination: new apigateway.LogGroupLogDestination(logGroup),
        loggingLevel: apigateway.MethodLoggingLevel.OFF,
        dataTraceEnabled: false,
      },
    });

    api.addGatewayResponse('invalid-endpoint-error-response', {
      type: ResponseType.UNAUTHORIZED,
      statusCode: '401',
      responseHeaders: {
        'Access-Control-Allow-Origin': "'*'",
      },
    });

    // AWS SES email identity must exist in the account for the configured ses_from_email

    // Allow Lambda functions to send emails and create email identities. The
    // refresher needs this too: it consumes the notification-email messages.
    const sesPolicy = new cdk.aws_iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:CreateEmailIdentity'],
      resources: ['*'],
    });
    lambdaFunction.addToRolePolicy(sesPolicy);
    refresherFunction.addToRolePolicy(sesPolicy);

    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: api.url,
    });

    tables.forEach((table: dynamodb.Table) => {
      let tableName = table.tableName.toLowerCase();
      tableName = tableName.charAt(0).toUpperCase() + tableName.slice(1);
      new cdk.CfnOutput(this, `${tableName}TableName`, {
        value: table.tableName,
      });
    });

    new cdk.CfnOutput(this, 'ProfileImageBucketName', {
      value: profileImageBucket.bucketName,
    });

    new cdk.CfnOutput(this, 'QueueUrl', {
      value: queue.queueUrl,
    });

    // -------------------------------------------------------------------------
    // Alarms and dashboard (CloudWatch free tier: 9 alarms, 4 custom metrics)
    // -------------------------------------------------------------------------

    // The transport logs a `transport` object on every GraphQL response; a
    // non-zero `fallbackOk` means DB refused the direct path and Decodo served
    // the request instead — the user-facing path is degraded even though the
    // request succeeded.
    new logs.MetricFilter(this, 'SearchFallbackFilter', {
      logGroup: apiLogGroup,
      filterPattern: logs.FilterPattern.stringValue('$.message', '=', 'GraphQL response'),
      metricNamespace: 'TrainPriceMonitor',
      metricName: 'SearchFallbackOk',
      metricValue: '$.transport.fallbackOk',
    });

    // Yoga handles resolver errors and returns HTTP 200, and the refresher catches
    // per-journey failures, so Lambda's Errors metric stays 0 for both. The
    // ERROR log lines are the real signal.
    new logs.MetricFilter(this, 'SearchErrorLogFilter', {
      logGroup: apiLogGroup,
      filterPattern: logs.FilterPattern.stringValue('$.level', '=', 'ERROR'),
      metricNamespace: 'TrainPriceMonitor',
      metricName: 'SearchErrorLogs',
      metricValue: '1',
    });
    new logs.MetricFilter(this, 'RefresherErrorLogFilter', {
      logGroup: refresherLogGroup,
      filterPattern: logs.FilterPattern.stringValue('$.level', '=', 'ERROR'),
      metricNamespace: 'TrainPriceMonitor',
      metricName: 'RefresherErrorLogs',
      metricValue: '1',
    });

    const searchErrors = new cloudwatch.Alarm(this, 'SearchErrors', {
      alarmDescription: 'The GraphQL API returned errors (search is failing for the user).',
      metric: new cloudwatch.Metric({
        namespace: 'TrainPriceMonitor',
        metricName: 'SearchErrorLogs',
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const searchFallback = new cloudwatch.Alarm(this, 'SearchUsingDecodoFallback', {
      alarmDescription: 'Journey search is falling back to Decodo: DB is refusing the direct transport.',
      metric: new cloudwatch.Metric({
        namespace: 'TrainPriceMonitor',
        metricName: 'SearchFallbackOk',
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const refresherErrors = new cloudwatch.Alarm(this, 'RefresherErrors', {
      alarmDescription: 'The hourly watchlist refresh failed (journeys stay stale and alerts are late).',
      metric: new cloudwatch.Metric({
        namespace: 'TrainPriceMonitor',
        metricName: 'RefresherErrorLogs',
        period: cdk.Duration.hours(1),
        statistic: 'Sum',
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const searchThrottled = new cloudwatch.Alarm(this, 'SearchThrottled', {
      alarmDescription: 'The GraphQL API is being throttled (concurrency limit reached).',
      metric: lambdaFunction.metricThrottles({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // CloudWatch publishes to SNS through a dedicated action object.
    for (const alarm of [searchErrors, searchFallback, refresherErrors, searchThrottled]) {
      if (alertTopic) {
        alarm.addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));
        // Recovery notifications are part of the forwarder; without an OK action
        // CloudWatch never publishes the transition.
        alarm.addOkAction(new cloudwatch_actions.SnsAction(alertTopic));
      }
    }

    // Keeps the previous dashboard's construct id so CloudFormation replaces the
    // resource in place; only the displayed name changes (Backend -> App).
    new cloudwatch.Dashboard(this, 'BackendDashboard', {
      dashboardName: 'TrainPriceMonitor-App',
      start: DASHBOARD_START,
      widgets: appWidgets({
        api,
        apiFunction: lambdaFunction,
        dlq,
        apiLogGroup,
        alarms: [searchErrors, searchFallback, refresherErrors, searchThrottled],
      }),
    });
  }
}
