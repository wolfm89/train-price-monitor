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
  aws_ses as ses,
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

    const frontendOrigin = `https://${frontendDomainName}`;

    // While the SES account is in the sandbox, every recipient has to be a
    // verified identity, so the API registers each user's address with SES.
    // Once AWS grants production access, set CDK_SES_PRODUCTION_ACCESS=1 (context
    // `ses_production_access`) to switch the workaround off and drop its IAM
    // permissions.
    const sesSandbox = String(this.node.tryGetContext('ses_production_access') ?? '') !== '1';

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
      FRONTEND_URL: frontendOrigin,
      // Origins the Lambda echoes in CORS headers (comma-separated).
      CORS_ALLOWED_ORIGINS: frontendOrigin,
      SES_FROM_EMAIL: sesFromEmail,
      SES_SANDBOX: sesSandbox ? 'true' : 'false',
      NODE_OPTIONS: '--enable-source-maps',
      DEPLOY_VERSION: 'v15',
      // Start with the profile that is currently accepted; the transport still
      // rotates through the rest if DB blocks it (see shared/db-fetch.ts).
      DB_TLS_PROFILE: 'tls13',
      // DB is reached directly with a browser-like TLS client; when DB throttles
      // the environment the request falls back to Decodo. Name of the SSM
      // SecureString holding the Decodo key; the value itself is never in the
      // template (see decodo.ts and shared/db-fetch.ts).
      DECODO_API_KEY_PARAM: decodoApiKeyParamName(this),
    };

    // Both functions run the same image (the pre-built bundle plus production
    // dependencies). Only sizing, triggers and DB pacing differ.
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
        // For the daily deletion of unconfirmed sign-ups (deleteUnconfirmedSignups).
        COGNITO_USER_POOL_ID: userPool.userPoolId,
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

    // Sign-ups that are never confirmed exist only in Cognito; the refresher
    // deletes them once a day after UNCONFIRMED_SIGNUP_RETENTION_DAYS
    // (backend/src/lib/retention.ts), as the privacy policy states.
    new events.Rule(this, 'DeleteUnconfirmedSignupsRule', {
      schedule: events.Schedule.rate(cdk.Duration.days(1)),
      targets: [
        new targets.SqsQueue(queue, {
          message: events.RuleTargetInput.fromObject({
            query: 'mutation { deleteUnconfirmedSignups }',
          }),
        }),
      ],
    });
    refresherFunction.addToRolePolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: ['cognito-idp:ListUsers', 'cognito-idp:AdminGetUser', 'cognito-idp:AdminDeleteUser'],
        resources: [userPool.userPoolArn],
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
        // Only the app itself calls the API from a browser. It sends the token
        // in the Authorization header, not as a cookie, so no credentials flag.
        allowOrigins: [frontendOrigin],
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: apigateway.Cors.DEFAULT_HEADERS,
        // Without this the browser re-preflights every polled GraphQL request,
        // doubling the API Gateway count.
        maxAge: cdk.Duration.minutes(10),
      },
      deployOptions: {
        accessLogDestination: new apigateway.LogGroupLogDestination(logGroup),
        // Request metadata without the caller's IP address or identity: nothing
        // in operations needs them, and the logs are kept for 14 days.
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: false,
          httpMethod: true,
          ip: false,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: false,
        }),
        loggingLevel: apigateway.MethodLoggingLevel.OFF,
        dataTraceEnabled: false,
      },
    });

    api.addGatewayResponse('invalid-endpoint-error-response', {
      type: ResponseType.UNAUTHORIZED,
      statusCode: '401',
      responseHeaders: {
        // The app must be able to read the 401 to refresh its token.
        'Access-Control-Allow-Origin': `'${frontendOrigin}'`,
      },
    });

    // The verified sending domain, created here instead of by hand. The DKIM
    // tokens are only known after creation, so they are published as stack
    // outputs; their CNAME records belong at the DNS provider. Do not create the
    // identity manually as well, and do not move the sender to another domain:
    // either replaces this identity and changes the tokens.
    if (!sesFromEmail.includes('@')) {
      throw new Error(`ses_from_email '${sesFromEmail}' is not an email address`);
    }
    const mailDomain = sesFromEmail.slice(sesFromEmail.lastIndexOf('@') + 1);
    const domainIdentity = new ses.EmailIdentity(this, 'SesDomainIdentity', {
      identity: ses.Identity.domain(mailDomain),
      // Easy DKIM; RSA 2048 is also the SES default, stated here so a change is visible.
      dkimIdentity: ses.DkimIdentity.easyDkim(ses.EasyDkimSigningKeyLength.RSA_2048_BIT),
      // Envelope sender in the app's own domain (MX and SPF TXT for the subdomain
      // live at the DNS provider), so SPF aligns with wolfgangmoser.eu as well as
      // DKIM. If that DNS is broken, keep sending through amazonses.com.
      mailFromDomain: 'bounce.wolfgangmoser.eu',
      mailFromBehaviorOnMxFailure: ses.MailFromBehaviorOnMxFailure.USE_DEFAULT_VALUE,
    });
    new cdk.CfnOutput(this, 'SesDomainIdentityName', { value: domainIdentity.emailIdentityName });
    new cdk.CfnOutput(this, 'SesDkimToken1Name', { value: domainIdentity.dkimDnsTokenName1 });
    new cdk.CfnOutput(this, 'SesDkimToken1Value', { value: domainIdentity.dkimDnsTokenValue1 });
    new cdk.CfnOutput(this, 'SesDkimToken2Name', { value: domainIdentity.dkimDnsTokenName2 });
    new cdk.CfnOutput(this, 'SesDkimToken2Value', { value: domainIdentity.dkimDnsTokenValue2 });
    new cdk.CfnOutput(this, 'SesDkimToken3Name', { value: domainIdentity.dkimDnsTokenName3 });
    new cdk.CfnOutput(this, 'SesDkimToken3Value', { value: domainIdentity.dkimDnsTokenValue3 });

    // Allow both functions to send emails: the refresher consumes the
    // notification-email messages. The resource stays '*' on purpose: a send is
    // authorised against the identity that authorises it (the domain or the
    // address identity, and in the sandbox both exist), so scoping this to one
    // of them can silently stop the alert emails.
    const sesSendPolicy = new cdk.aws_iam.PolicyStatement({
      actions: ['ses:SendEmail'],
      resources: ['*'],
    });
    lambdaFunction.addToRolePolicy(sesSendPolicy);
    refresherFunction.addToRolePolicy(sesSendPolicy);

    // deleteUser removes the address from the account-level suppression list
    // (hard bounces and complaints). The action has no resource-level scope.
    lambdaFunction.addToRolePolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: ['ses:DeleteSuppressedDestination'],
        resources: ['*'],
      })
    );

    // Sandbox workaround only: createUser/deleteUser (API function) add and
    // remove the user's address as a recipient identity.
    if (sesSandbox) {
      lambdaFunction.addToRolePolicy(
        new cdk.aws_iam.PolicyStatement({
          actions: ['ses:CreateEmailIdentity', 'ses:DeleteEmailIdentity'],
          resources: [cdk.Stack.of(this).formatArn({ service: 'ses', resource: 'identity', resourceName: '*' })],
        })
      );
    }

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
    // Alarms and dashboard (CloudWatch free tier: 10 alarms, 10 custom metrics
    // across both stacks; 5 alarms and 3 custom metrics are defined here)
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
      defaultValue: 0,
    });
    // The refresher is the component most likely to burn the Decodo allowance
    // unattended. Its SQS handler logs the transport counters on "SQS message
    // processed"; publishing to the same metric name keeps the custom-metric
    // count at 10 while making refresher fallbacks visible to the alarm and
    // the App dashboard.
    new logs.MetricFilter(this, 'RefresherFallbackFilter', {
      logGroup: refresherLogGroup,
      filterPattern: logs.FilterPattern.stringValue('$.message', '=', 'SQS message processed'),
      metricNamespace: 'TrainPriceMonitor',
      metricName: 'SearchFallbackOk',
      metricValue: '$.transport.fallbackOk',
      defaultValue: 0,
    });
    // A thrown transport/Yoga failure logs "GraphQL request failed" instead of
    // "GraphQL response"; publish that snapshot to the same metric so a failed
    // request cannot hide a Decodo fallback from the alarm.
    new logs.MetricFilter(this, 'SearchFallbackFailureFilter', {
      logGroup: apiLogGroup,
      filterPattern: logs.FilterPattern.stringValue('$.message', '=', 'GraphQL request failed'),
      metricNamespace: 'TrainPriceMonitor',
      metricName: 'SearchFallbackOk',
      metricValue: '$.transport.fallbackOk',
      defaultValue: 0,
    });
    // The refresher's failure log carries the same drained snapshot; publish it
    // too, otherwise a fallback followed by an exception disappears from the
    // alarm until the next healthy run.
    new logs.MetricFilter(this, 'RefresherFallbackFailureFilter', {
      logGroup: refresherLogGroup,
      filterPattern: logs.FilterPattern.stringValue('$.message', '=', 'SQS message processing failed'),
      metricNamespace: 'TrainPriceMonitor',
      metricName: 'SearchFallbackOk',
      metricValue: '$.transport.fallbackOk',
      defaultValue: 0,
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
      alarmName: 'TPM-App-SearchErrors',
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
      alarmName: 'TPM-App-UsingDecodoFallback',
      alarmDescription: 'The DB direct transport is degraded: search or refresher requests are falling back to Decodo.',
      metric: new cloudwatch.Metric({
        namespace: 'TrainPriceMonitor',
        metricName: 'SearchFallbackOk',
        period: cdk.Duration.hours(1),
        statistic: 'Sum',
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const refresherErrors = new cloudwatch.Alarm(this, 'RefresherErrors', {
      alarmName: 'TPM-App-RefresherErrors',
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
      alarmName: 'TPM-App-SearchThrottled',
      alarmDescription: 'The GraphQL API is being throttled (concurrency limit reached).',
      metric: lambdaFunction.metricThrottles({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // The 10th free alarm slot: a failed SQS refresh that exhausted its retries
    // must not sit silently in the DLQ. The log-based RefresherErrors alarm only
    // covers failures the handler caught.
    const refresherDlq = new cloudwatch.Alarm(this, 'RefresherDlq', {
      alarmName: 'TPM-App-RefresherDLQ',
      alarmDescription:
        'The refresher DLQ has messages: a watchlist refresh failed after retries. Purge the queue after investigating; messages remain for 14 days.',
      metric: dlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // CloudWatch publishes to SNS through a dedicated action object.
    for (const alarm of [searchErrors, searchFallback, refresherErrors, searchThrottled, refresherDlq]) {
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
        refresherFunction,
        dlq,
        apiLogGroup,
        refresherLogGroup,
        alarms: [searchErrors, searchFallback, refresherErrors, searchThrottled, refresherDlq],
      }),
    });
  }
}
