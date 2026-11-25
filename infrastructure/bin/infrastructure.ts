#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AlertingStack } from '../lib/alerting';
import { AnalyticsStack } from '../lib/analytics-stack';
import { InfrastructureStack } from '../lib/infrastructure-stack';
import { CertificateStack } from '../lib/certificate-stack';
import { DbProxyStack } from '../lib/db-proxy-stack';
import { DB_PROXY_FUNCTION_NAME, DB_PROXY_REGION } from '../lib/config';
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
// `1` disables the weekly silver schedule (it stays deployed).
if (process.env.CDK_ANALYTICS_PAUSED) app.node.setContext('analytics_paused', process.env.CDK_ANALYTICS_PAUSED);
// `1` once SES production access is granted: turns off the sandbox-only
// per-user recipient identities.
if (process.env.CDK_SES_PRODUCTION_ACCESS)
  app.node.setContext('ses_production_access', process.env.CDK_SES_PRODUCTION_ACCESS);

const certificateStack = new CertificateStack(app, 'CertificateStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  crossRegionReferences: true,
});

// Created first: both other stacks reference its alert topic.
const alertingStack = new AlertingStack(app, 'AlertingStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

const dbProxyStack = new DbProxyStack(app, 'DbProxyStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: DB_PROXY_REGION,
  },
});
const dbProxyFunctionArn = `arn:aws:lambda:${DB_PROXY_REGION}:${process.env.CDK_DEFAULT_ACCOUNT}:function:${DB_PROXY_FUNCTION_NAME}`;

const infrastructureStack = new InfrastructureStack(
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
    alertTopicArn: alertingStack.topic.topicArn,
    dbProxyFunctionArn,
  }
);
infrastructureStack.addDependency(dbProxyStack);

const scraperStack = new ScraperStack(app, 'ScraperStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  alertTopicArn: alertingStack.topic.topicArn,
  dbProxyFunctionArn,
});
scraperStack.addDependency(dbProxyStack);

// Short form matches the handler's sql-<hash> fallback. CI sets GITHUB_SHA; a manual
// deploy can override with CDK_TRANSFORM_VERSION.
const transformVersion = process.env.CDK_TRANSFORM_VERSION || process.env.GITHUB_SHA || '';

new AnalyticsStack(app, 'AnalyticsStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  dataBucket: scraperStack.bucket,
  alertTopic: alertingStack.topic,
  transformVersion,
});
