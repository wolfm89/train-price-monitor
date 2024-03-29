import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Bucket, BucketAccessControl, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { Distribution, OriginAccessIdentity, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { S3Origin } from 'aws-cdk-lib/aws-cloudfront-origins';
import * as path from 'path';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';

export interface FrontendProps {
  certificate: Certificate;
  domainName: string;
}

export class Frontend extends Construct {
  constructor(scope: Construct, id: string, { certificate, domainName }: FrontendProps) {
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
      domainNames: [domainName],
      certificate: certificate,
      defaultBehavior: {
        origin: new S3Origin(bucket, { originAccessIdentity }),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
      },
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
      ],
    });

    new cdk.CfnOutput(this, 'CloudFrontUrl', {
      value: distribution.distributionDomainName,
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
    });
  }
}
