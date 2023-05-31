import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Bucket, BucketAccessControl, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { Distribution, OriginAccessIdentity } from 'aws-cdk-lib/aws-cloudfront';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { S3Origin } from 'aws-cdk-lib/aws-cloudfront-origins';
import * as path from 'path';

export class Frontend extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Create S3 bucket
    const bucket = new Bucket(this, 'FrontendBucket', {
      enforceSSL: true,
      encryption: BucketEncryption.S3_MANAGED,
      accessControl: BucketAccessControl.PRIVATE,
    });

    // Deploy frontend to S3 bucket using BucketDeployment
    new BucketDeployment(this, 'FrontendDeployment', {
      sources: [Source.asset(path.resolve(__dirname, '../../frontend/build'))],
      destinationBucket: bucket,
    });

    // Create CloudFront distribution
    const originAccessIdentity = new OriginAccessIdentity(this, 'OriginAccessIdentity');
    bucket.grantRead(originAccessIdentity);

    const distribution = new Distribution(this, 'Distribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: new S3Origin(bucket, { originAccessIdentity }),
      },
    });

    new cdk.CfnOutput(this, 'CloudFrontUrl', {
      value: distribution.distributionDomainName,
    });
  }
}
