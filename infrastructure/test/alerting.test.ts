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
              ArnLike: { 'aws:SourceArn': 'arn:aws:budgets::111111111111:' },
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
