import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ScraperStack } from '../lib/scraper-stack';

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
      Timeout: 240,
      Environment: {
        Variables: Match.objectLike({ SCRAPER_BATCH_SIZE: '22', DB_MIN_GAP_MS: '2500', DB_MAX_IN_FLIGHT: '2' }),
      },
    });
    const poller = Object.values(template.findResources('AWS::Lambda::Function')).find(
      (fn) => fn.Properties.PackageType === 'Image'
    );
    const variables = Object.keys(poller?.Properties.Environment.Variables ?? {});
    expect(variables.some((name) => name.startsWith('DECODO') || name.startsWith('BROWSER'))).toBe(false);
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
});
