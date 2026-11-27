import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DB_TLS_PROFILES } from '../lib/config';
import { DbProxyStack } from '../lib/db-proxy-stack';

test('DbProxyStack creates the us-east-1 Navigator proxy', () => {
  const stack = new DbProxyStack(new cdk.App(), 'TestDbProxyStack', {
    env: { account: '111111111111', region: 'us-east-1' },
  });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'TrainPriceMonitor-DbProxy',
    Runtime: 'nodejs24.x',
    Timeout: 20,
    ReservedConcurrentExecutions: 6,
    Environment: {
      Variables: Match.objectLike({
        DB_TLS_PROFILES,
        DB_MAX_ATTEMPTS: '1',
        DB_TOTAL_BUDGET_MS: '18000',
        DB_REQUEST_TIMEOUT_MS: '15000',
      }),
    },
  });
  template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 14 });

  const functions = Object.values(template.findResources('AWS::Lambda::Function'));
  const variables = functions[0]?.Properties.Environment.Variables ?? {};
  expect(variables.DB_TLS_PROFILES).toBe(DB_TLS_PROFILES);
  expect(variables.DB_TLS_PROFILE).toBeUndefined();
});
