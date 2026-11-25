import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ScraperStack } from '../lib/scraper-stack';
import { DB_PROXY_REGION, SCRAPER_CONFIG, SILVER_CONFIG } from '../lib/config';

// The stack bundles the pre-built scraper output as Lambda assets. The CDK tests
// do not need real bundles, only that the (gitignored) directories exist.
beforeAll(() => {
  for (const name of ['hydrator', 'compactor']) {
    mkdirSync(resolve(__dirname, '../../scraper/dist', name), { recursive: true });
  }
});

function synth(context: Record<string, string> = {}): Template {
  const app = new cdk.App({ context });
  const stack = new ScraperStack(app, 'TestScraperStack', { env: { account: '111111111111', region: 'eu-central-1' } });
  return Template.fromStack(stack);
}

describe('ScraperStack', () => {
  test('Poller and hydrator schedules are enabled by default', () => {
    const template = synth();
    const states = Object.values(template.findResources('AWS::Events::Rule')).map((r) => r.Properties.State);
    expect(states.filter((state) => state === 'ENABLED')).toHaveLength(3);
  });

  test('scraper_paused disables the poller and hydrator but not the compactor', () => {
    const template = synth({ scraper_paused: '1' });
    const rules = Object.values(template.findResources('AWS::Events::Rule'));
    expect(rules.filter((r) => r.Properties.State === 'DISABLED')).toHaveLength(2);
    expect(rules.filter((r) => r.Properties.State === 'ENABLED')).toHaveLength(1);
  });

  test('Poller paces DB calls and has no Decodo fallback', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      PackageType: 'Image',
      Timeout: SCRAPER_CONFIG.poller_timeout_seconds,
      MemorySize: SCRAPER_CONFIG.poller_memory_mib,
      Environment: {
        Variables: Match.objectLike({
          SCRAPER_BATCH_SIZE: String(SCRAPER_CONFIG.batch_size),
          DB_MIN_GAP_MS: '3500',
          DB_MAX_IN_FLIGHT: '2',
        }),
      },
    });
    const poller = Object.values(template.findResources('AWS::Lambda::Function')).find(
      (fn) => fn.Properties.PackageType === 'Image'
    );
    const variables = Object.keys(poller?.Properties.Environment.Variables ?? {});
    expect(variables.some((name) => name.startsWith('DECODO') || name.startsWith('BROWSER'))).toBe(false);
  });

  test('Poller invokes the configured DB proxy and keeps the alarm threshold sane', () => {
    const proxyArn = `arn:aws:lambda:${DB_PROXY_REGION}:111111111111:function:TrainPriceMonitor-DbProxy`;
    const stack = new ScraperStack(new cdk.App(), 'ProxyScraperStack', {
      env: { account: '111111111111', region: 'eu-central-1' },
      dbProxyFunctionArn: proxyArn,
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      PackageType: 'Image',
      Environment: {
        Variables: Match.objectLike({
          DB_PROXY_FUNCTION: proxyArn,
          DB_PROXY_REGION,
          DB_TLS_PROFILE: 'tls12',
        }),
      },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'lambda:InvokeFunction', Resource: proxyArn, Effect: 'Allow' }),
        ]),
      },
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'TPM-Scraper-PollerThrottledByDb',
      Threshold: 0,
    });
    template.hasResourceProperties('AWS::Logs::MetricFilter', {
      MetricTransformations: Match.arrayWith([
        Match.objectLike({ MetricName: 'PollerThrottled', MetricValue: '$.transport.breakerOpened' }),
      ]),
    });
  });

  test('Schedule table exposes the ByDue priority index', () => {
    const template = synth();
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'ByDue',
          KeySchema: [
            { AttributeName: 'status', KeyType: 'HASH' },
            { AttributeName: 'due_key', KeyType: 'RANGE' },
          ],
        }),
      ]),
    });
    const indexes = Object.values(template.findResources('AWS::DynamoDB::Table')).flatMap((table) =>
      (table.Properties.GlobalSecondaryIndexes ?? []).map((index: { IndexName: string }) => index.IndexName)
    );
    expect(indexes).toEqual(['ByDue']);
  });

  test('creates the five poller alarms and their log metrics', () => {
    const template = synth();
    template.resourceCountIs('AWS::CloudWatch::Alarm', 5);
    const metricNames = Object.values(template.findResources('AWS::Logs::MetricFilter')).map(
      (filter) => filter.Properties.MetricTransformations[0].MetricName
    );
    expect(metricNames.sort()).toEqual([
      'PollerAborted',
      'PollerBacklog',
      'PollerDirectOk',
      'PollerFailedTargets',
      'PollerRowsWritten',
      'PollerTargetsScraped',
      'PollerThrottled',
    ]);
  });

  test('pausing the scraper disables the alarm actions', () => {
    const template = synth({ scraper_paused: '1' });
    const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'));
    expect(alarms.every((alarm) => alarm.Properties.ActionsEnabled === false)).toBe(true);
  });

  test('aborts incomplete silver multipart uploads', () => {
    const template = synth();
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
            Prefix: `${SILVER_CONFIG.prefix}/`,
            Status: 'Enabled',
          }),
        ]),
      },
    });
  });

  test('hydrator receives the shared lookahead and seed window', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          HYDRATOR_LOOKAHEAD_DAYS: String(SCRAPER_CONFIG.lookahead_days),
          HYDRATOR_SEED_WINDOW_DAYS: String(SCRAPER_CONFIG.seed_window_days),
        }),
      },
    });
  });
});
