import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  aws_apigateway as apigateway,
  aws_lambda as lambda,
  aws_dynamodb as dynamodb,
  aws_s3 as s3,
} from 'aws-cdk-lib';
import { tableDefinitions } from './dynamodb-tables';

export class Backend extends Construct {
  constructor(scope: Construct, id: string) {
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

    const lambdaFunction = new lambda.DockerImageFunction(this, 'GraphqlLambda', {
      code: lambda.DockerImageCode.fromImageAsset('../backend'),
      environment: {
        PROFILE_IMAGE_BUCKET_NAME: profileImageBucket.bucketName,
      },
    });

    // Add necessary IAM permissions
    profileImageBucket.grantReadWrite(lambdaFunction);
    tables.forEach((table: dynamodb.Table) => {
      table.grantReadWriteData(lambdaFunction);
    });

    const api = new apigateway.LambdaRestApi(this, 'GraphqlApi', {
      handler: lambdaFunction,
      proxy: true,
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
  }
}
