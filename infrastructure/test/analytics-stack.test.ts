import * as cdk from 'aws-cdk-lib';
import { aws_s3 as s3, aws_sns as sns } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AnalyticsStack } from '../lib/analytics-stack';

function synth(context: Record<string, string> = {}): Template {
  const app = new cdk.App({ context });
  const helper = new cdk.Stack(app, 'HelperStack', {
    env: { account: '111111111111', region: 'eu-central-1' },
  });
  // Keep the helper template non-empty; it only holds the imported bucket/topic.
  new cdk.CfnResource(helper, 'Placeholder', { type: 'AWS::CloudFormation::WaitConditionHandle' });
  const bucket = s3.Bucket.fromBucketName(helper, 'DataBucket', 'test-bucket');
  const topic = sns.Topic.fromTopicArn(
    helper,
    'AlertTopic',
    'arn:aws:sns:eu-central-1:111111111111:TrainPriceMonitorAlerts'
  );
  const stack = new AnalyticsStack(app, 'TestAnalyticsStack', {
    env: { account: '111111111111', region: 'eu-central-1' },
    dataBucket: bucket,
    alertTopic: topic,
    transformVersion: 'abc123def456',
  });
  return Template.fromStack(stack);
}

interface PolicyStatement {
  Action: string | string[];
  Resource: string | string[];
  Condition?: { StringLike?: Record<string, string[]> };
}

function statements(template: Template): PolicyStatement[] {
  return Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
    (policy) => policy.Properties.PolicyDocument.Statement as PolicyStatement[]
  );
}

describe('AnalyticsStack', () => {
  test('sizes the image function for the measured corpus', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      PackageType: 'Image',
      MemorySize: 10240,
      Timeout: 900,
      EphemeralStorage: { Size: 10240 },
      Architectures: ['x86_64'],
      ReservedConcurrentExecutions: 1,
    });

    const fn = Object.values(template.findResources('AWS::Lambda::Function'))[0];
    expect(fn.Properties.VpcConfig).toBeUndefined();
    expect(fn.Properties.LoggingConfig).toBeDefined();
  });

  test('passes the runtime contract and never sets AWS_REGION', () => {
    const template = synth();
    const fn = Object.values(template.findResources('AWS::Lambda::Function'))[0];
    expect(fn.Properties.Environment.Variables).toMatchObject({
      SILVER_BUCKET: 'test-bucket',
      SILVER_PREFIX: 'silver',
      BRONZE_SOURCE: 's3://test-bucket/prices/**/*.parquet',
      SILVER_THREADS: '4',
      SILVER_MEMORY_LIMIT: '8GB',
      SILVER_MAX_TEMP_SIZE: '5GB',
      SILVER_KEEP: '2',
      TRANSFORM_VERSION: 'abc123def456',
      ALERT_TOPIC_ARN: 'arn:aws:sns:eu-central-1:111111111111:TrainPriceMonitorAlerts',
    });
    expect(fn.Properties.Environment.Variables).toHaveProperty('LOG_GROUP_NAME');
    expect(fn.Properties.Environment.Variables).not.toHaveProperty('AWS_REGION');
  });

  test('schedules a weekly Sunday 03:30 UTC rebuild', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'cron(30 3 ? * SUN *)',
      ScheduleExpressionTimezone: 'Etc/UTC',
      State: 'ENABLED',
      FlexibleTimeWindow: { Mode: 'OFF' },
    });

    const schedule = Object.values(template.findResources('AWS::Scheduler::Schedule'))[0];
    expect(schedule.Properties.Target.RetryPolicy.MaximumRetryAttempts).toBe(0);
    expect(schedule.Properties.Target.DeadLetterConfig).toBeUndefined();
    expect(schedule.Properties.Target.RoleArn).toBeDefined();
    expect(schedule.Properties.Target.Arn).toBeDefined();
  });

  test('analytics_paused disables the schedule without removing it', () => {
    const template = synth({ analytics_paused: '1' });
    template.hasResourceProperties('AWS::Scheduler::Schedule', { State: 'DISABLED' });
  });

  test('caps function retries and the throttle window', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      MaximumRetryAttempts: 0,
      MaximumEventAgeInSeconds: 900,
    });
  });

  test('has no legacy rule, VPC, alarm, metric filter or owned topic', () => {
    const template = synth();
    template.resourceCountIs('AWS::Events::Rule', 0);
    template.resourceCountIs('AWS::EC2::VPC', 0);
    template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
    template.resourceCountIs('AWS::Logs::MetricFilter', 0);
    template.resourceCountIs('AWS::SNS::Topic', 0);
  });

  test('grants prefix-scoped S3 access and never writes bronze', () => {
    const template = synth();
    const policies = statements(template);
    const actions = policies.flatMap((statement) =>
      Array.isArray(statement.Action) ? statement.Action : [statement.Action]
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        's3:ListBucket',
        's3:GetObject',
        's3:PutObject',
        's3:DeleteObject',
        's3:AbortMultipartUpload',
        'sns:Publish',
        'lambda:InvokeFunction',
      ])
    );
    expect(actions).not.toContain('s3:*');
    expect(actions).not.toContain('*');

    const list = policies.find((statement) => {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      return actions.includes('s3:ListBucket');
    })!;
    expect(JSON.stringify(list.Resource)).toContain('test-bucket');
    expect(list.Condition?.StringLike?.['s3:prefix']).toEqual(expect.arrayContaining(['prices/*', 'silver/*']));

    const bronzeWrites = policies.filter((statement) => {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
      return (
        resources.some((resource: string) => String(resource).includes('/prices/*')) &&
        actions.some((action: string) =>
          ['s3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload'].includes(action)
        )
      );
    });
    expect(bronzeWrites).toHaveLength(0);
  });

  test('publishes failures to the existing alert topic', () => {
    const template = synth();
    const publish = statements(template).find((statement) => {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      return actions.includes('sns:Publish');
    })!;
    const publishResources = Array.isArray(publish.Resource) ? publish.Resource : [publish.Resource];
    expect(publishResources).toContain('arn:aws:sns:eu-central-1:111111111111:TrainPriceMonitorAlerts');
  });

  test('keeps logs for two weeks and deletes them with the stack', () => {
    const template = synth();
    const groups = template.findResources('AWS::Logs::LogGroup');
    expect(Object.keys(groups)).toHaveLength(1);
    const group = Object.values(groups)[0];
    expect(group.Properties.RetentionInDays).toBe(14);
    expect(group.DeletionPolicy).toBe('Delete');
  });
});
