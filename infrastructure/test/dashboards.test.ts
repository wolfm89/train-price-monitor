import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import {
  aws_apigateway as apigateway,
  aws_cloudwatch as cloudwatch,
  aws_lambda as lambda,
  aws_sqs as sqs,
} from 'aws-cdk-lib';
import { appWidgets, scraperWidgets } from '../lib/dashboards';

function synth(): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestDashboards', { env: { account: '111111111111', region: 'eu-central-1' } });

  const fn = new lambda.Function(stack, 'Probe', {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => {};'),
  });
  const alarm = new cloudwatch.Alarm(stack, 'ProbeAlarm', {
    metric: fn.metricErrors(),
    threshold: 1,
    evaluationPeriods: 1,
  });

  new cdk.aws_cloudwatch.Dashboard(stack, 'ScraperDashboard', {
    dashboardName: 'TrainPriceMonitor-Scraper',
    start: '-PT48H',
    widgets: scraperWidgets({
      batchSize: 25,
      pollerFunction: fn,
      hydratorFunction: fn,
      compactorFunction: fn,
      scheduleTable: new cdk.aws_dynamodb.Table(stack, 'Schedule', {
        partitionKey: { name: 'pk', type: cdk.aws_dynamodb.AttributeType.STRING },
      }),
      dataBucket: new cdk.aws_s3.Bucket(stack, 'Data'),
      pollerLogGroup: new cdk.aws_logs.LogGroup(stack, 'PollerLogs'),
      alarms: [alarm],
    }),
  });
  const api = new apigateway.RestApi(stack, 'Api', { deployOptions: { stageName: 'prod' } });
  api.root.addMethod('GET', new apigateway.MockIntegration());

  new cdk.aws_cloudwatch.Dashboard(stack, 'BackendDashboard', {
    dashboardName: 'TrainPriceMonitor-App',
    start: '-PT48H',
    widgets: appWidgets({
      api,
      apiFunction: fn,
      dlq: new sqs.Queue(stack, 'Dlq'),
      apiLogGroup: new cdk.aws_logs.LogGroup(stack, 'ApiLogs'),
      alarms: [alarm],
    }),
  });

  return Template.fromStack(stack);
}

describe('Dashboards', () => {
  test('creates exactly two dashboards', () => {
    synth().resourceCountIs('AWS::CloudWatch::Dashboard', 2);
  });

  test('both dashboards default to a 48 hour window', () => {
    const template = synth();
    for (const dashboard of Object.values(template.findResources('AWS::CloudWatch::Dashboard'))) {
      expect(dashboard.Properties.DashboardBody['Fn::Join'][1]).toEqual(
        expect.arrayContaining([expect.stringContaining('-PT48H')])
      );
    }
  });

  test('each dashboard carries its key widgets', () => {
    const template = synth();
    const bodies = new Map(
      Object.values(template.findResources('AWS::CloudWatch::Dashboard')).map((dashboard) => [
        dashboard.Properties.DashboardName as string,
        JSON.stringify(dashboard.Properties.DashboardBody),
      ])
    );

    const scraper = bodies.get('TrainPriceMonitor-Scraper') ?? '';
    for (const title of [
      'Latency — run duration',
      'Traffic — scrapes per run (12 h)',
      'Errors — failed target scrapes',
      'Saturation — DB throttling',
      'Data — price rows written per run',
      'Storage — bucket size (30 d)',
      'Storage — objects (30 d)',
      'Alarms',
      'Diagnostics — recent failed target scrapes',
    ]) {
      expect(scraper).toContain(title);
    }

    // The gauge's warn band must sit above the normal run time (p90 ~190 s at batch
    // 25) and just below the abort, not at the old 180 s.
    expect(scraper).toContain('200000');
    expect(scraper).toContain('210000');

    const app = bodies.get('TrainPriceMonitor-App') ?? '';
    for (const title of [
      'Latency — API percentiles',
      'Traffic — requests per hour',
      'Errors — 4xx',
      'Saturation — Lambda concurrency',
      'Notifications — SES sends',
      'Alarms',
      'Diagnostics — recent API errors',
    ]) {
      expect(app).toContain(title);
    }
  });
});
