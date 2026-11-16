import * as cdk from 'aws-cdk-lib';
import {
  aws_budgets as budgets,
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
 * Forwards SNS messages to Pushover: CloudWatch alarm state changes, the weekly
 * silver build failure and the account budget alerts.
 *
 * SNS cannot deliver to Pushover directly: every HTTPS subscription has to
 * answer SNS's `SubscriptionConfirmation` handshake, which Pushover does not
 * implement. This function is that adapter.
 *
 * A state change to ALARM and a failed silver build are sent at high priority
 * (bypasses quiet hours) with the siren sound; recovery and budget alerts use
 * normal priority.
 */
export const PUSHOVER_FORWARDER_SOURCE = `
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

function format(payload) {
  if (payload && payload.event === 'silver_build_failed') {
    const region = payload.region || 'eu-central-1';
    const logGroup = payload.log_group;
    const url = logGroup
      ? 'https://' + region + '.console.aws.amazon.com/cloudwatch/home?region=' + region +
        '#logsV2:log-groups/log-group/' + encodeURIComponent(logGroup)
      : 'https://' + region + '.console.aws.amazon.com/lambda/home?region=' + region +
        '#/functions/' + encodeURIComponent(payload.function || '') + '?tab=logs';
    return {
      title: 'Silver build failed',
      message:
        (payload.stage ? '[' + payload.stage + '] ' : '') +
        (payload.error_type ? payload.error_type + ': ' : '') +
        (payload.error || 'no error message') +
        (payload.build_id ? ' | build ' + payload.build_id : ''),
      priority: '1',
      sound: 'siren',
      timestamp: String(Math.floor(Date.now() / 1000)),
      url,
      url_title: 'Open the build logs',
    };
  }

  // Not an alarm and not ours: a shared topic can carry other messages.
  if (!payload || !payload.NewStateValue || !payload.AlarmName) return undefined;

  const alarming = payload.NewStateValue === 'ALARM';
  // The Region field carries a display name ("EU (Frankfurt)"); the ARN has the id.
  const region = String(payload.AlarmArn || '').split(':')[3] || payload.Region || 'eu-central-1';
  return {
    title: (alarming ? 'ALARM: ' : 'OK: ') + payload.AlarmName,
    message: payload.NewStateReason || '',
    priority: alarming ? '1' : '0',
    sound: alarming ? 'siren' : 'pushover',
    timestamp: String(Math.floor(new Date(payload.StateChangeTime).getTime() / 1000)),
    url:
      'https://' + region + '.console.aws.amazon.com/cloudwatch/home?region=' + region +
      '#alarmsV2:alarm/' + encodeURIComponent(payload.AlarmName),
    url_title: 'Open alarm in CloudWatch',
  };
}

exports.handler = async (event) => {
  const { token, user } = await credentials();
  for (const record of event.Records || []) {
    const subject = record.Sns.Subject || '';
    const message = String(record.Sns.Message || '');
    let notification;
    if (subject.startsWith('AWS Budgets:') || message.startsWith('AWS Budget Notification')) {
      // Budgets sends a human-readable message; do not JSON.parse it.
      notification = {
        title: (subject || 'AWS Budget alert').slice(0, 100),
        message: message.slice(0, 1000),
        priority: '0',
        sound: 'pushover',
        timestamp: String(Math.floor(Date.now() / 1000)),
        url: 'https://console.aws.amazon.com/billing/home#/budgets',
        url_title: 'Open AWS Budgets',
      };
    } else {
      let payload;
      try {
        payload = JSON.parse(message);
      } catch {
        continue; // A non-JSON SNS message that is not a budget alert is not ours.
      }
      notification = format(payload);
    }
    if (!notification) continue;
    const body = new URLSearchParams({ token, user, ...notification });
    const res = await fetch('https://api.pushover.net/1/messages.json', { method: 'POST', body });
    // Throw so the SNS-to-Lambda async retry can deliver it; a logged failure
    // would just lose the alarm.
    if (!res.ok) throw new Error('Pushover rejected the notification: ' + res.status + ' ' + (await res.text()));
  }
};
`;

/**
 * Owns the alert topic and the Pushover forwarder, so the backend, scraper,
 * analytics build and account budget can publish to the same place.
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

    // AWS Budgets is USD-only; $1.00 (~€0.86) is deliberately stricter than the €1
    // ceiling. The first two budgets and their notifications are free.
    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: 'TrainPriceMonitor-Monthly',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: 1, unit: 'USD' },
        metrics: ['UnblendedCost'],
        filterExpression: {
          not: { dimensions: { key: 'RECORD_TYPE', values: ['Credit', 'Refund'] } },
        },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 50,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [{ subscriptionType: 'SNS', address: this.topic.topicArn }],
        },
        {
          notification: {
            notificationType: 'FORECASTED',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [{ subscriptionType: 'SNS', address: this.topic.topicArn }],
        },
      ],
    });

    // Budgets publishes as its own service principal; the default topic policy
    // does not cover it.
    this.topic.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['sns:Publish'],
        principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
        resources: [this.topic.topicArn],
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:budgets::${this.account}:` },
        },
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
    new cdk.CfnOutput(this, 'MonthlyBudgetName', { value: 'TrainPriceMonitor-Monthly' });
  }
}
