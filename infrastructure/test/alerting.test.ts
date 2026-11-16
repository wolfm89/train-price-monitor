import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AlertingStack, PUSHOVER_FORWARDER_SOURCE } from '../lib/alerting';

function synth(): Template {
  const app = new cdk.App();
  const stack = new AlertingStack(app, 'TestAlertingStack', {
    env: { account: '111111111111', region: 'eu-central-1' },
  });
  return Template.fromStack(stack);
}

describe('AlertingStack', () => {
  test('creates one alert topic and subscribes the Pushover forwarder', () => {
    const template = synth();
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'lambda',
      TopicArn: { Ref: Match.stringLikeRegexp('Alerts') },
    });
  });

  test('lets CloudWatch publish alarm state changes', () => {
    const template = synth();
    template.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sns:Publish',
            Principal: { Service: 'cloudwatch.amazonaws.com' },
          }),
        ]),
      },
    });
  });

  test('forwarder reads only the two Pushover parameters', () => {
    const template = synth();
    const json = JSON.stringify(template.toJSON());
    expect(json).toContain('parameter/train-price-monitor/pushover-token');
    expect(json).toContain('parameter/train-price-monitor/pushover-user-key');
    const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement
    );
    const ssmReads = statements.filter((statement) => statement.Action === 'ssm:GetParameter');
    expect(ssmReads).toHaveLength(2);
  });

  test('creates the $1 monthly budget with two notifications', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: {
        BudgetName: 'TrainPriceMonitor-Monthly',
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: 1, Unit: 'USD' },
        Metrics: ['UnblendedCost'],
        FilterExpression: {
          Not: { Dimensions: { Key: 'RECORD_TYPE', Values: ['Credit', 'Refund'] } },
        },
      },
      NotificationsWithSubscribers: Match.arrayWith([
        Match.objectLike({
          Notification: {
            NotificationType: 'ACTUAL',
            ComparisonOperator: 'GREATER_THAN',
            Threshold: 50,
            ThresholdType: 'PERCENTAGE',
          },
          Subscribers: Match.arrayWith([Match.objectLike({ SubscriptionType: 'SNS' })]),
        }),
        Match.objectLike({
          Notification: {
            NotificationType: 'FORECASTED',
            ComparisonOperator: 'GREATER_THAN',
            Threshold: 100,
            ThresholdType: 'PERCENTAGE',
          },
          Subscribers: Match.arrayWith([Match.objectLike({ SubscriptionType: 'SNS' })]),
        }),
      ]),
    });
  });

  test('lets AWS Budgets publish to the alert topic', () => {
    const template = synth();
    template.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sns:Publish',
            Principal: { Service: 'budgets.amazonaws.com' },
            Condition: {
              StringEquals: { 'aws:SourceAccount': '111111111111' },
              ArnLike: { 'aws:SourceArn': 'arn:aws:budgets::111111111111:*' },
            },
          }),
        ]),
      },
    });
  });

  test('forwarder carries the analytics and budget branches', () => {
    expect(PUSHOVER_FORWARDER_SOURCE).toContain('silver_build_failed');
    expect(PUSHOVER_FORWARDER_SOURCE).toContain('AWS Budgets:');
    expect(PUSHOVER_FORWARDER_SOURCE).toContain('billing/home#/budgets');
  });
});

test('forwarder handles budget, silver failure and alarm records', async () => {
  const calls: Record<string, string>[] = [];
  const ssm = {
    SSMClient: class {
      async send() {
        return { Parameter: { Value: 'x' } };
      }
    },
    GetParameterCommand: class {},
  };
  const exportsObject: Record<string, unknown> = {};
  const run = new Function(
    'require',
    'process',
    'URLSearchParams',
    'fetch',
    'exports',
    `${PUSHOVER_FORWARDER_SOURCE}; return exports;`
  ) as (
    require: (name: string) => unknown,
    process: { env: Record<string, string> },
    urlSearchParams: typeof URLSearchParams,
    fetch: typeof globalThis.fetch,
    exports: Record<string, unknown>
  ) => { handler: (event: unknown) => Promise<void> };

  const fetchStub = async (_url: string, init?: { body?: URLSearchParams }) => {
    calls.push(Object.fromEntries(init?.body ?? new URLSearchParams()));
    return { ok: true, text: async () => '' };
  };
  const forwarder = run(
    (name: string) => {
      if (name === '@aws-sdk/client-ssm') return ssm;
      throw new Error(`unexpected require ${name}`);
    },
    { env: { PUSHOVER_TOKEN_PARAM: 'token', PUSHOVER_USER_PARAM: 'user' } },
    URLSearchParams,
    fetchStub as unknown as typeof globalThis.fetch,
    exportsObject
  );

  await forwarder.handler({
    Records: [
      {
        Sns: {
          Subject: 'AWS Budgets: TrainPriceMonitor-Monthly has exceeded your alert threshold',
          Message: 'Budget Name: TrainPriceMonitor-Monthly\nAlert Type: ACTUAL',
        },
      },
    ],
  });
  await forwarder.handler({
    Records: [
      {
        Sns: {
          Message: JSON.stringify({
            event: 'silver_build_failed',
            build_id: 'b1',
            stage: 'snapshot',
            error_type: 'EmptyCorpusError',
            error: 'no bronze',
            function: 'fn',
            region: 'evil.example/',
            log_group: '/aws/lambda/fn',
          }),
        },
      },
    ],
  });
  await forwarder.handler({
    Records: [
      {
        Sns: {
          Message: JSON.stringify({
            AlarmName: 'PollerErrors',
            NewStateValue: 'ALARM',
            NewStateReason: 'threshold',
            StateChangeTime: '2026-11-16T12:00:00Z',
            AlarmArn: 'arn:aws:cloudwatch:eu-central-1:111111111111:alarm:PollerErrors',
          }),
        },
      },
    ],
  });

  expect(calls).toHaveLength(3);
  expect(calls[0].title).toContain('AWS Budgets:');
  expect(calls[0].priority).toBe('0');
  expect(calls[1].message).toContain('[snapshot] EmptyCorpusError: no bronze');
  expect(calls[1].priority).toBe('1');
  expect(calls[1].url).toContain('https://eu-central-1.console.aws.amazon.com/');
  expect(calls[2].title).toBe('ALARM: PollerErrors');
  expect(calls[2].priority).toBe('1');
});
