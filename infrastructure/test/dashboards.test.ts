import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { aws_apigateway as apigateway, aws_cloudwatch as cloudwatch, aws_lambda as lambda } from 'aws-cdk-lib';
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
    widgets: scraperWidgets({ pollerFunction: fn, hydratorFunction: fn, compactorFunction: fn, alarms: [alarm] }),
  });
  const api = new apigateway.RestApi(stack, 'Api', { deployOptions: { stageName: 'prod' } });
  api.root.addMethod('GET', new apigateway.MockIntegration());

  new cdk.aws_cloudwatch.Dashboard(stack, 'BackendDashboard', {
    dashboardName: 'TrainPriceMonitor-App',
    start: '-PT48H',
    widgets: appWidgets({ api, refresherFunction: fn, alarms: [alarm] }),
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
      'Scrapes (48 h)',
      'DB calls throttled (48 h)',
      'Slowest run (48 h, abort at 210 s)',
      'Pipeline errors (48 h)',
      'Throughput and pace per run',
      'Alarms',
    ]) {
      expect(scraper).toContain(title);
    }

    const app = bodies.get('TrainPriceMonitor-App') ?? '';
    for (const title of [
      'Requests (48 h)',
      '5xx errors (48 h)',
      'Latency p90 (48 h)',
      'Decodo fallbacks (48 h)',
      'Requests and errors',
      'Hourly watchlist refresh',
      'Alarms',
    ]) {
      expect(app).toContain(title);
    }
  });
});
