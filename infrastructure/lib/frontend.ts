import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Bucket, BucketAccessControl, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import {
  CachePolicy,
  CacheCookieBehavior,
  CacheHeaderBehavior,
  CacheQueryStringBehavior,
  Distribution,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { BucketDeployment, CacheControl, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
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

    // Cache policy for versioned/hashed static assets (JS, CSS in /assets/*).
    // Content-hashed filenames never collide, so 1-year immutable caching is safe.
    const assetsCachePolicy = new CachePolicy(this, 'AssetsCachePolicy', {
      cachePolicyName: `${id}-AssetsCachePolicy`,
      comment: 'Long-term cache for content-hashed frontend assets',
      defaultTtl: cdk.Duration.days(365),
      maxTtl: cdk.Duration.days(365),
      minTtl: cdk.Duration.seconds(0),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
      cookieBehavior: CacheCookieBehavior.none(),
      headerBehavior: CacheHeaderBehavior.none(),
      queryStringBehavior: CacheQueryStringBehavior.none(),
    });

    // CloudFront distribution with custom domain
    const distribution = new Distribution(this, 'DistributionNew', {
      defaultRootObject: 'index.html',
      domainNames: [domainName], // Adding back the custom domain
      certificate: certificate,
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
        // index.html must always be fresh so browsers pick up new chunk filenames
        // after a deployment — disable caching at the CDN layer for root files.
        cachePolicy: CachePolicy.CACHING_DISABLED,
      },
      additionalBehaviors: {
        // Vite writes all JS/CSS bundles under /assets/ with content hashes in
        // their filenames, so they are safe to cache for a full year.
        'assets/*': {
          origin: S3BucketOrigin.withOriginAccessControl(bucket),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          compress: true,
          cachePolicy: assetsCachePolicy,
        },
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

    // Deploy frontend to S3 bucket using separate deployments for different
    // cache-control strategies. This ensures browsers cache hashed assets
    // long-term while always revalidating mutable files like index.html.

    const buildPath = path.resolve(__dirname, '../../frontend/build');

    // Hashed assets (JS/CSS in /assets/) — immutable, 1-year browser cache
    new BucketDeployment(this, 'AssetsDeployment', {
      sources: [Source.asset(buildPath, { exclude: ['*', '!assets/**'] })],
      destinationBucket: bucket,
      distribution,
      cacheControl: [CacheControl.setPublic(), CacheControl.maxAge(cdk.Duration.days(365)), CacheControl.immutable()],
    });

    // Static images (logos, icons) — cacheable but not immutable
    new BucketDeployment(this, 'ImagesDeployment', {
      sources: [Source.asset(buildPath, { exclude: ['*', '!*.png', '!*.ico', '!*.svg', '!*.webp'] })],
      destinationBucket: bucket,
      distribution,
      cacheControl: [CacheControl.setPublic(), CacheControl.maxAge(cdk.Duration.days(7))],
    });

    // Mutable root files (index.html, manifest.json, etc.) — always revalidate
    new BucketDeployment(this, 'RootFilesDeployment', {
      sources: [Source.asset(buildPath, { exclude: ['assets/**', '*.png', '*.ico', '*.svg', '*.webp'] })],
      destinationBucket: bucket,
      distribution,
      cacheControl: [CacheControl.noCache()],
    });

    new cdk.CfnOutput(this, 'CloudFrontUrl', {
      value: distribution.distributionDomainName,
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
    });
  }
}
