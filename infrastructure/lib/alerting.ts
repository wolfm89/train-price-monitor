import * as cdk from 'aws-cdk-lib';
import {
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_sns as sns,
  aws_sns_subscriptions as subs,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * Name of the SSM SecureStrings holding the Pushover credentials. Like the
 * Decodo key, the values never appear in a template: CI writes them from the
 * repository secrets `PUSHOVER_API_TOKEN` and `PUSHOVER_USER_KEY`, and the
 * forwarder reads them at runtime. Override the names with the
 * `pushover_token_param` / `pushover_user_param` context keys.
 */
export const DEFAULT_PUSHOVER_TOKEN_PARAM = '/train-price-monitor/pushover-token';
export const DEFAULT_PUSHOVER_USER_PARAM = '/train-price-monitor/pushover-user-key';

export function pushoverParamNames(scope: Construct): { token: string; user: string } {
  return {
    token: (scope.node.tryGetContext('pushover_token_param') as string | undefined) ?? DEFAULT_PUSHOVER_TOKEN_PARAM,
    user: (scope.node.tryGetContext('pushover_user_param') as string | undefined) ?? DEFAULT_PUSHOVER_USER_PARAM,
  };
}

/**
 * Forwards SNS messages (CloudWatch alarm state changes) to Pushover.
 *
 * SNS cannot deliver to Pushover directly: every HTTPS subscription has to
 * answer SNS's `SubscriptionConfirmation` handshake, which Pushover does not
 * implement. This function is that adapter — it is invoked only on alarm state
 * changes, so a handful of times a month.
 *
 * A state change to ALARM is sent at high priority (bypasses quiet hours) with
 * the siren sound; recovery uses normal priority.
 */
const PUSHOVER_FORWARDER_SOURCE = `
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const client = new SSMClient({});
let cached;

async function credentials() {
  if (cached) return cached;
  const read = async (name) => {
    const res = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    if (!res.Parameter || !res.Parameter.Value) throw new Error('empty SSM parameter ' + name);
    return res.Parameter.Value;
  };
  cached = {
    token: await read(process.env.PUSHOVER_TOKEN_PARAM),
    user: await read(process.env.PUSHOVER_USER_PARAM),
  };
  return cached;
}

exports.handler = async (event) => {
  const { token, user } = await credentials();
  for (const record of event.Records || []) {
    const alarm = JSON.parse(record.Sns.Message);
    const alarming = alarm.NewStateValue === 'ALARM';
    // The Region field carries a display name ("EU (Frankfurt)"); the ARN has the id.
    const region = String(alarm.AlarmArn || '').split(':')[3] || alarm.Region;
    const body = new URLSearchParams({
      token,
      user,
      title: (alarming ? 'ALARM: ' : 'OK: ') + alarm.AlarmName,
      message: alarm.NewStateReason || '',
      priority: alarming ? '1' : '0',
      sound: alarming ? 'siren' : 'pushover',
      timestamp: String(Math.floor(new Date(alarm.StateChangeTime).getTime() / 1000)),
      url: 'https://' + region + '.console.aws.amazon.com/cloudwatch/home?region=' + region +
        '#alarmsV2:alarm/' + encodeURIComponent(alarm.AlarmName),
      url_title: 'Open alarm in CloudWatch',
    });
    const res = await fetch('https://api.pushover.net/1/messages.json', { method: 'POST', body });
    // Throw so the SNS-to-Lambda async retry can deliver it; a logged failure
    // would just lose the alarm.
    if (!res.ok) throw new Error('Pushover rejected the notification: ' + res.status + ' ' + (await res.text()));
  }
};
`;

/**
 * Owns the alert topic and the Pushover forwarder, so both the backend and the
 * scraper can publish alarm state changes to the same place.
 */
export class AlertingStack extends cdk.Stack {
  readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.topic = new sns.Topic(this, 'Alerts', {
      topicName: 'TrainPriceMonitorAlerts',
      displayName: 'Train Price Monitor',
    });

    // CloudWatch publishes alarm state changes as the cloudwatch.amazonaws.com
    // service principal; the default topic policy does not cover it.
    this.topic.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['sns:Publish'],
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
        resources: [this.topic.topicArn],
        conditions: { StringEquals: { 'aws:SourceOwner': this.account } },
      })
    );

    const { token, user } = pushoverParamNames(this);

    const forwarder = new lambda.Function(this, 'PushoverForwarder', {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 128,
      timeout: cdk.Duration.seconds(15),
      handler: 'index.handler',
      code: lambda.Code.fromInline(PUSHOVER_FORWARDER_SOURCE),
      logGroup: new logs.LogGroup(this, 'PushoverForwarderLogs', {
        retention: logs.RetentionDays.TWO_WEEKS,
      }),
      environment: {
        PUSHOVER_TOKEN_PARAM: token,
        PUSHOVER_USER_PARAM: user,
      },
    });

    // Least privilege: exactly GetParameter on the two Pushover parameters.
    for (const name of [token, user]) {
      forwarder.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter'],
          resources: [
            cdk.Stack.of(this).formatArn({
              service: 'ssm',
              resource: 'parameter',
              resourceName: name.replace(/^\//, ''),
            }),
          ],
        })
      );
    }

    this.topic.addSubscription(new subs.LambdaSubscription(forwarder));

    new cdk.CfnOutput(this, 'AlertTopicArn', { value: this.topic.topicArn });
  }
}
