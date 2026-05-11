import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Bucket, BucketAccessControl, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import {
  CachePolicy,
  CacheCookieBehavior,
  CacheHeaderBehavior,
  CacheQueryStringBehavior,
  Distribution,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  ResponseHeadersPolicy,
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

    // Security response headers policy applied to all CloudFront responses.
    const responseHeadersPolicy = new ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: `${id}-SecurityHeaders`,
      comment: 'Security headers for frontend distribution',
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: {
          frameOption: HeadersFrameOption.DENY,
          override: true,
        },
        referrerPolicy: {
          referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        xssProtection: {
          protection: true,
          modeBlock: true,
          override: true,
        },
      },
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
        responseHeadersPolicy,
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
          responseHeadersPolicy,
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

    // Deploy frontend to S3 bucket using two deployments with different
    // cache-control strategies. This ensures browsers cache hashed assets
    // long-term while always revalidating mutable files like index.html.
    //
    // NOTE: Source.asset exclude patterns do NOT support negation ("!foo").
    // CDK passes them to minimatch as an ignore list and the "!" prefix is
    // treated as a literal character, not a negation operator.  Using a
    // subdirectory as the source (AssetsDeployment) or a plain exclude list
    // without negation (RootFilesDeployment) avoids this pitfall.
    //
    // NOTE: All BucketDeployment instances that share the same destination
    // bucket root will prune each other's files when prune=true (the default),
    // because each deployment runs "aws s3 sync --delete" against the full
    // bucket prefix.  The BucketDeployment-level `exclude` option maps to
    // "--exclude" flags on that sync command and prevents the RootFiles
    // deployment from deleting the assets uploaded by AssetsDeployment.

    const buildPath = path.resolve(__dirname, '../../frontend/build');

    // Hashed assets (JS/CSS in /assets/) — immutable, 1-year browser cache.
    // Using the assets/ subdirectory directly as the source avoids the
    // broken-negation-pattern problem and scopes prune=true to assets/ only.
    new BucketDeployment(this, 'AssetsDeployment', {
      sources: [Source.asset(path.join(buildPath, 'assets'))],
      destinationBucket: bucket,
      destinationKeyPrefix: 'assets',
      distribution,
      distributionPaths: ['/assets/*'],
      cacheControl: [CacheControl.setPublic(), CacheControl.maxAge(cdk.Duration.days(365)), CacheControl.immutable()],
      prune: true, // safe: scoped to the 'assets/' prefix by destinationKeyPrefix
    });

    // Mutable root files (index.html, images, manifest.json, etc.) — always
    // revalidate.  Images are not content-hashed so no-cache is correct.
    // The BucketDeployment-level exclude prevents this deployment from pruning
    // the assets/ objects uploaded above.
    new BucketDeployment(this, 'RootFilesDeployment', {
      sources: [Source.asset(buildPath, { exclude: ['assets/**'] })],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ['/*'],
      cacheControl: [CacheControl.noCache()],
      prune: true,
      exclude: ['assets/*'], // don't --delete s3://bucket/assets/* during sync
    });

    new cdk.CfnOutput(this, 'CloudFrontUrl', {
      value: distribution.distributionDomainName,
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
    });
  }
}
