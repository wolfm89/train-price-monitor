#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { InfrastructureStack } from '../lib/infrastructure-stack';
import { CertificateStack } from '../lib/certificate-stack';
import { ScraperStack } from '../lib/scraper-stack';

const app = new cdk.App();

// Allow environment variables to override cdk.json context values
if (process.env.CDK_APP_NAME) app.node.setContext('app_name', process.env.CDK_APP_NAME);
if (process.env.CDK_DOMAIN_NAME) app.node.setContext('domain_name', process.env.CDK_DOMAIN_NAME);
if (process.env.CDK_SES_FROM_EMAIL) app.node.setContext('ses_from_email', process.env.CDK_SES_FROM_EMAIL);
// Name of the SSM SecureString holding the Decodo API key (non-secret).
if (process.env.CDK_DECODO_API_KEY_PARAM)
  app.node.setContext('decodo_api_key_param', process.env.CDK_DECODO_API_KEY_PARAM);
// `1` disables the scraper's poller and hydrator schedules (they stay deployed).
if (process.env.CDK_SCRAPER_PAUSED) app.node.setContext('scraper_paused', process.env.CDK_SCRAPER_PAUSED);

const certificateStack = new CertificateStack(app, 'CertificateStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  crossRegionReferences: true,
});
new InfrastructureStack(
  app,
  'InfrastructureStack',
  {
    certificate: certificateStack.certificate,
    domainName: certificateStack.domainName,
  },
  {
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.CDK_DEFAULT_REGION,
    },
    crossRegionReferences: true,
  }
);

new ScraperStack(app, 'ScraperStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
