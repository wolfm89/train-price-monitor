#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ScraperStack } from '../lib/scraper-stack';

const app = new cdk.App();

new ScraperStack(app, 'ScraperStack', {
  bucketName: 'scraper-data-local',
  hydratorLookaheadDays: 3,
  env: { account: '000000000000', region: 'eu-central-1' },
});
