import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
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
    ReservedConcurrentExecutions: 5,
    Environment: {
      Variables: Match.objectLike({
        DB_TLS_PROFILES: 'chrome,legacy,firefox,safari,tls13,tls12',
        DB_MAX_ATTEMPTS: '1',
        DB_TOTAL_BUDGET_MS: '18000',
        DB_REQUEST_TIMEOUT_MS: '15000',
      }),
    },
  });
  template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 14 });
});
