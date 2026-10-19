import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AlertingStack } from '../lib/alerting';

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
});
