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
  aws_ses as ses,
} from 'aws-cdk-lib';
import { tableDefinitions } from './dynamodb-tables';
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
      visibilityTimeout: cdk.Duration.seconds(60),
    });

    // Create SQS queue with DLQ
    const queue = new sqs.Queue(this, 'TrainPriceMonitorQueue', {
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });

    // Create Lambda function
    const apiLogGroup = new logs.LogGroup(this, 'LambdaLogs', {
      retention: logs.RetentionDays.TWO_WEEKS,
    });

    const lambdaFunction = new lambda.DockerImageFunction(this, 'GraphqlLambda', {
      code: lambda.DockerImageCode.fromImageAsset('../backend'),
      logGroup: apiLogGroup,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        PROFILE_IMAGE_BUCKET_NAME: profileImageBucket.bucketName,
        TPM_SQS_QUEUE_URL: queue.queueUrl,
        FRONTEND_URL: `https://${frontendDomainName}`,
        SES_FROM_EMAIL: sesFromEmail,
        NODE_OPTIONS: '--enable-source-maps',
        DEPLOY_VERSION: 'v13',
      },
    });

    // Add necessary IAM permissions
    profileImageBucket.grantReadWrite(lambdaFunction);
    tables.forEach((table: dynamodb.Table) => {
      table.grantReadWriteData(lambdaFunction);
    });

    const logGroup = new logs.LogGroup(this, 'ApiGatewayLogs', {
      retention: logs.RetentionDays.TWO_WEEKS,
    });

    lambdaFunction.addEventSource(new sources.SqsEventSource(queue, { batchSize: 1 }));
    queue.grantSendMessages(lambdaFunction);

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

    // Allow Lambda function to send emails and create email identities
    lambdaFunction.addToRolePolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: ['ses:SendEmail', 'ses:CreateEmailIdentity'],
        resources: ['*'],
      })
    );

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
  }
}
