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
import { UserPool } from 'aws-cdk-lib/aws-cognito';
import { ResponseType } from 'aws-cdk-lib/aws-apigateway';

export class Backend extends Construct {
  constructor(scope: Construct, id: string, userPool: UserPool) {
    super(scope, id);

    // Create DynamoDB tables
    const tables: dynamodb.Table[] = tableDefinitions.map((tableDefinition: dynamodb.TableProps) => {
      if (tableDefinition.tableName === undefined) {
        throw new Error('Table name is not set.');
      }
      // eslint-disable-next-line awscdk/require-dynamodb-ptr, awscdk/require-dynamodb-autoscale
      return new dynamodb.Table(this, tableDefinition.tableName, tableDefinition);
    });

    // Create S3 bucket
    const profileImageBucket = new s3.Bucket(this, 'ProfileImageBucket', {
      enforceSSL: true,
      encryption: s3.BucketEncryption.KMS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create SQS queue
    const queue = new sqs.Queue(this, 'TrainPriceMonitorQueue', {
      visibilityTimeout: cdk.Duration.seconds(60), // Set visibility timeout as needed
    });

    // Create Lambda function
    const lambdaFunction = new lambda.DockerImageFunction(this, 'GraphqlLambda', {
      code: lambda.DockerImageCode.fromImageAsset('../backend'),
      logRetention: logs.RetentionDays.TWO_WEEKS,
      timeout: cdk.Duration.seconds(10),
      memorySize: 512,
      environment: {
        PROFILE_IMAGE_BUCKET_NAME: profileImageBucket.bucketName,
        TPM_SQS_QUEUE_URL: queue.queueUrl,
        NODE_OPTIONS: '--enable-source-maps',
      },
    });

    // Add necessary IAM permissions
    profileImageBucket.grantReadWrite(lambdaFunction);
    tables.forEach((table: dynamodb.Table) => {
      table.grantReadWriteData(lambdaFunction);
    });

    const logGroup = new logs.LogGroup(this, 'ApiLogs', {
      retention: logs.RetentionDays.TWO_WEEKS,
    });

    lambdaFunction.addEventSource(new sources.SqsEventSource(queue, { batchSize: 1 }));
    queue.grantSendMessages(lambdaFunction);

    // Create EventBridge rule
    const rule = new events.Rule(this, 'UpdateJourneysRule', {
      schedule: events.Schedule.expression('rate(1 minute)'),
    });

    // Add SQS queue as a target for the EventBridge rule
    rule.addTarget(
      new targets.SqsQueue(queue, {
        message: events.RuleTargetInput.fromObject({
          query: 'mutation { updateJourneys }',
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
