import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  aws_apigateway as apigateway,
  aws_lambda as lambda,
  aws_dynamodb as dynamodb,
  aws_s3 as s3,
  aws_logs as logs,
  aws_events as events,
  aws_events_targets as targets,
  aws_sqs as sqs,
  aws_lambda_event_sources as sources,
} from 'aws-cdk-lib';
import { tableDefinitions } from './dynamodb-tables';
import { grantScrapingBrowserEndpointRead, scrapingBrowserParamName } from './scraping-browser';
import { UserPool } from 'aws-cdk-lib/aws-cognito';
import { ResponseType } from 'aws-cdk-lib/aws-apigateway';

export class Backend extends Construct {
  constructor(scope: Construct, id: string, userPool: UserPool, frontendDomainName: string, sesFromEmail: string) {
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
      DEPLOY_VERSION: 'v14',
      // Name of the SSM SecureString holding the vendor CDP endpoint; the value
      // itself is never in the template (see scraping-browser.ts).
      BROWSER_WS_ENDPOINT_PARAM: scrapingBrowserParamName(this),
    };

    // All three functions run the same image. DB's bot protection rejects
    // requests from non-consumer hosts (a browser running in a Lambda container
    // is refused no matter how genuine it is), so all of them reach DB through a
    // managed unblocking browser. Only sizing and triggers differ.
    //
    // Journey searches run in the worker, not the API function: a vendor browser
    // session costs 11-22 s to provision and expires after five minutes without
    // traffic, so a session in an arbitrary execution environment is worthless —
    // the next request lands somewhere else. Reserved concurrency 1 makes the
    // environment — and therefore the session — deterministic without paying for
    // provisioned concurrency, and the keep-warm rule below keeps it validated.
    // It has no API Gateway route; only the API function reaches it.
    const journeyWorkerLogGroup = new logs.LogGroup(this, 'JourneyWorkerLogs', {
      retention: logs.RetentionDays.TWO_WEEKS,
    });

    const journeyWorkerFunction = new lambda.DockerImageFunction(this, 'JourneyWorkerLambda', {
      code: lambda.DockerImageCode.fromImageAsset('../backend', { cmd: ['worker.handler'] }),
      architecture: lambda.Architecture.X86_64,
      logGroup: journeyWorkerLogGroup,
      // Deterministic name: the deploy job warms the worker right after `cdk deploy`,
      // and the CI role is allowed neither lambda:ListFunctions nor
      // cloudformation:DescribeStacks, so it must not have to look the name up.
      functionName: `${cdk.Stack.of(this).stackName}-JourneyWorker`,
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      reservedConcurrentExecutions: 1,
      environment: {
        ...commonEnvironment,
        // Search budget: the API function waits at most 24 s for a result, so a
        // search must not spend longer than that replacing a blocked session — it
        // would hold the single worker slot and throttle every other search.
        BROWSER_RETRY_BUDGET_MS: '25000',
        // The keeper has nobody waiting on it and must end up with a *good*
        // session, but a search colliding with it waits: 30 s covers one setup
        // (~11-22 s) plus a quick failover, and the backoff in worker.ts stops it
        // from repeating during a bad vendor stretch.
        BROWSER_KEEPALIVE_BUDGET_MS: '30000',
      },
    });

    const lambdaFunction = new lambda.DockerImageFunction(this, 'GraphqlLambda', {
      code: lambda.DockerImageCode.fromImageAsset('../backend'),
      architecture: lambda.Architecture.X86_64,
      logGroup: apiLogGroup,
      // API Gateway REST cuts the integration off at 29 s. The function itself
      // never does DB work (it delegates to the journey worker), so this is
      // headroom for GraphQL processing only.
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        ...commonEnvironment,
        // Present only here: the refresher runs the same resolver code without it
        // and keeps calling DB directly (see backend/src/lib/journeyWorker.ts).
        JOURNEY_WORKER_FUNCTION: journeyWorkerFunction.functionName,
      },
    });

    const refresherLogGroup = new logs.LogGroup(this, 'RefresherLambdaLogs', {
      retention: logs.RetentionDays.TWO_WEEKS,
    });

    // Scheduled/queued work is isolated from the API so a slow refresh cannot
    // consume API concurrency, and so it can run past API Gateway's 29 s cap.
    // Nobody waits on it, so it is sized for cost rather than latency, and it is
    // given a more generous retry budget: a blocked vendor session is replaced by
    // paying another session setup (~8-10 s), which is worth it here.
    const refresherFunction = new lambda.DockerImageFunction(this, 'RefresherLambda', {
      code: lambda.DockerImageCode.fromImageAsset('../backend'),
      architecture: lambda.Architecture.X86_64,
      logGroup: refresherLogGroup,
      timeout: cdk.Duration.seconds(120),
      memorySize: 512,
      environment: {
        ...commonEnvironment,
        // Each retry costs a full remote-session setup, so allow a few within the
        // 120 s timeout instead of the tighter default used by the API path.
        BROWSER_RETRY_BUDGET_MS: '60000',
      },
    });

    // Add necessary IAM permissions
    profileImageBucket.grantReadWrite(lambdaFunction);
    tables.forEach((table: dynamodb.Table) => {
      table.grantReadWriteData(lambdaFunction);
      table.grantReadWriteData(refresherFunction);
    });
    // Journey search and the hourly refresh both reach DB through the vendor, so
    // all three functions need the endpoint parameter.
    grantScrapingBrowserEndpointRead(this, 'ScrapingBrowserEndpoint', [
      lambdaFunction,
      refresherFunction,
      journeyWorkerFunction,
    ]);

    // The API delegates every DB call to the worker.
    journeyWorkerFunction.grantInvoke(lambdaFunction);

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

    // Keeps the worker's sessions — and therefore its usefulness — alive, and
    // rotates them before the vendor's 60-minute cap.
    //
    // Two minutes, not three: the pool holds two sessions and the vendor drops one
    // after five minutes without traffic, so each session has to be touched inside
    // that window (alternating pings = every four minutes). A real DB query, not a
    // CDP ping, is what resets the timer — measured, a CDP-only ping does not.
    new events.Rule(this, 'KeepWarmRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(2)),
      targets: [
        new targets.LambdaFunction(journeyWorkerFunction, {
          event: events.RuleTargetInput.fromObject({ job: 'keepAlive' }),
        }),
      ],
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

    // Read by the deploy job to warm the worker after an update; avoids granting
    // the CI role lambda:ListFunctions just to discover the generated name.
    new cdk.CfnOutput(this, 'JourneyWorkerFunctionName', {
      value: journeyWorkerFunction.functionName,
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
  }
}
