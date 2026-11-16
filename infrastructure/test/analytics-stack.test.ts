import * as cdk from 'aws-cdk-lib';
import { aws_s3 as s3, aws_sns as sns } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AnalyticsStack } from '../lib/analytics-stack';
import { ALERT_TOPIC_NAME, SCHEDULES, SILVER_CONFIG } from '../lib/config';

function synth(context: Record<string, string> = {}): Template {
  const app = new cdk.App({ context });
  const helper = new cdk.Stack(app, 'HelperStack', {
    env: { account: '111111111111', region: 'eu-central-1' },
  });
  // Keep the helper template non-empty; it only holds the imported bucket/topic.
  new cdk.CfnResource(helper, 'Placeholder', { type: 'AWS::CloudFormation::WaitConditionHandle' });
  const bucket = s3.Bucket.fromBucketAttributes(helper, 'DataBucket', {
    bucketName: 'test-bucket',
    bucketArn: 'arn:aws:s3:::test-bucket',
  });
  const topic = sns.Topic.fromTopicArn(
    helper,
    'AlertTopic',
    `arn:aws:sns:eu-central-1:111111111111:${ALERT_TOPIC_NAME}`
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
      MemorySize: SILVER_CONFIG.lambda.memory_mib,
      Timeout: SILVER_CONFIG.lambda.timeout_seconds,
      EphemeralStorage: { Size: SILVER_CONFIG.lambda.ephemeral_mib },
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
      SILVER_PREFIX: SILVER_CONFIG.prefix,
      BRONZE_SOURCE: `s3://test-bucket/${SILVER_CONFIG.bronze_prefix}/**/*.parquet`,
      SILVER_THREADS: String(SILVER_CONFIG.lambda.threads),
      SILVER_MEMORY_LIMIT: SILVER_CONFIG.lambda.duckdb_memory_limit,
      SILVER_MAX_TEMP_SIZE: SILVER_CONFIG.lambda.duckdb_max_temp_size,
      SILVER_KEEP: String(SILVER_CONFIG.keep),
      TRANSFORM_VERSION: 'abc123def456',
      ALERT_TOPIC_ARN: `arn:aws:sns:eu-central-1:111111111111:${ALERT_TOPIC_NAME}`,
    });
    expect(fn.Properties.Environment.Variables).toHaveProperty('LOG_GROUP_NAME');
    expect(fn.Properties.Environment.Variables).not.toHaveProperty('AWS_REGION');
    const groups = template.findResources('AWS::Logs::LogGroup');
    const logGroupId = Object.keys(groups)[0];
    expect(fn.Properties.Environment.Variables.LOG_GROUP_NAME).toEqual({ Ref: logGroupId });
    expect(fn.Properties.LoggingConfig.LogGroup).toEqual({ Ref: logGroupId });
  });

  test('schedules a weekly Sunday 03:30 UTC rebuild', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: `cron(${SCHEDULES.analytics.minute} ${SCHEDULES.analytics.hour} ? * SUN *)`,
      ScheduleExpressionTimezone: 'Etc/UTC',
      State: 'ENABLED',
      FlexibleTimeWindow: { Mode: 'OFF' },
    });

    const schedule = Object.values(template.findResources('AWS::Scheduler::Schedule'))[0];
    expect(Object.values(template.findResources('AWS::Scheduler::Schedule'))).toHaveLength(1);
    expect(schedule.Properties.Target.RetryPolicy.MaximumRetryAttempts).toBe(SILVER_CONFIG.schedule.retry_attempts);
    expect(schedule.Properties.Target.RetryPolicy.MaximumEventAgeInSeconds).toBe(
      SILVER_CONFIG.schedule.max_event_age_minutes * 60
    );
    expect(schedule.Properties.Target.DeadLetterConfig).toBeUndefined();
    expect(schedule.Properties.Target.RoleArn).toBeDefined();
    expect(schedule.Properties.Target.Arn).toBeDefined();
  });

  test('analytics_paused disables the schedule without removing it', () => {
    const template = synth({ analytics_paused: '1' });
    template.hasResourceProperties('AWS::Scheduler::Schedule', { State: 'DISABLED' });
  });

  test('retries once and sends exhausted invocations to the alert topic', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      MaximumRetryAttempts: SILVER_CONFIG.lambda.retry_attempts,
      MaximumEventAgeInSeconds: SILVER_CONFIG.lambda.max_event_age_minutes * 60,
      DestinationConfig: {
        OnFailure: {
          Destination: `arn:aws:sns:eu-central-1:111111111111:${ALERT_TOPIC_NAME}`,
        },
      },
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
    const listResources = Array.isArray(list.Resource) ? list.Resource : [list.Resource];
    expect(listResources).toEqual(['arn:aws:s3:::test-bucket']);
    expect(list.Condition?.StringLike?.['s3:prefix']).toEqual(
      expect.arrayContaining([`${SILVER_CONFIG.bronze_prefix}/*`, `${SILVER_CONFIG.prefix}/*`])
    );

    const writes = policies.filter((statement) => {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      return actions.some((action: string) =>
        ['s3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload'].includes(action)
      );
    });
    expect(writes).toHaveLength(2);
    const writeResources = writes.flatMap((statement) =>
      Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource]
    );
    expect(writeResources).toEqual(
      expect.arrayContaining([
        `arn:aws:s3:::test-bucket/${SILVER_CONFIG.prefix}/*`,
        `arn:aws:s3:::test-bucket/${SILVER_CONFIG.prefix}/${SILVER_CONFIG.builds_root}/*`,
      ])
    );
    expect(
      writeResources.every((resource: string) =>
        String(resource).startsWith(`arn:aws:s3:::test-bucket/${SILVER_CONFIG.prefix}/`)
      )
    ).toBe(true);

    // Delete/abort must stay on build prefixes: widening it to silver/* would let a
    // failed build delete the live _latest.json pointer.
    const deleteStatements = writes.filter((statement) => {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      return actions.some((action: string) => ['s3:DeleteObject', 's3:AbortMultipartUpload'].includes(action));
    });
    expect(deleteStatements).toHaveLength(1);
    const deleteResources = Array.isArray(deleteStatements[0].Resource)
      ? deleteStatements[0].Resource
      : [deleteStatements[0].Resource];
    expect(deleteResources).toEqual([
      `arn:aws:s3:::test-bucket/${SILVER_CONFIG.prefix}/${SILVER_CONFIG.builds_root}/*`,
    ]);

    const bronzeWrites = policies.filter((statement) => {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
      return (
        resources.some((resource: string) => String(resource).includes(`/${SILVER_CONFIG.bronze_prefix}/*`)) &&
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
    expect(publishResources).toContain(`arn:aws:sns:eu-central-1:111111111111:${ALERT_TOPIC_NAME}`);
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

test('imports the real bucket and topic across stacks', () => {
  const app = new cdk.App();
  const env = { account: '111111111111', region: 'eu-central-1' };
  const producer = new cdk.Stack(app, 'ProducerStack', { env });
  const bucket = new s3.Bucket(producer, 'DataBucket');
  const topic = new sns.Topic(producer, 'AlertTopic');
  const analytics = new AnalyticsStack(app, 'ConsumerStack', {
    env,
    dataBucket: bucket,
    alertTopic: topic,
  });

  const template = Template.fromStack(analytics);
  expect(JSON.stringify(template.toJSON())).toContain('Fn::ImportValue');
  expect(JSON.stringify(Template.fromStack(producer).toJSON())).toContain('ExportsOutput');
});
