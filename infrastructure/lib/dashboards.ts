import * as cdk from 'aws-cdk-lib';
import {
  aws_cloudwatch as cloudwatch,
  aws_lambda as lambda,
  aws_sqs as sqs,
  aws_apigateway as apigateway,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * Dashboard defaults: 48 hours, which covers two nightly compactions and a full
 * day/night cycle of the scraper. Everything here stays inside the CloudWatch
 * free tier (3 dashboards, 50 metrics each).
 */
const DEFAULT_START = '-PT48H';

/** Widget sizes on the default 24-column grid. */
const QUARTER = 6;
const HALF = 12;
const FULL = 24;

const TITLE = {
  targets: 'Scrapes',
  throttled: 'DB calls throttled',
  slowestRun: 'Slowest run',
  pipelineErrors: 'Pipeline errors',
  requests: 'Requests',
  serverErrors: '5xx errors',
  latency: 'Latency p90',
  fallbacks: 'Decodo fallbacks',
  queue: 'Watchlist refresh queue',
  alarms: 'Alarms',
};

function metric(namespace: string, metricName: string, period: cdk.Duration, statistic: string): cloudwatch.Metric {
  return new cloudwatch.Metric({ namespace, metricName, period, statistic });
}

function statTile(title: string, value: cloudwatch.IMetric): cloudwatch.SingleValueWidget {
  return new cloudwatch.SingleValueWidget({
    title,
    metrics: [value],
    width: QUARTER,
    height: 3,
    // Aggregate over the dashboard's visible range (48 h by default) rather
    // than showing the latest sample.
    setPeriodToTimeRange: true,
  });
}

function alarmStatus(alarms: cloudwatch.IAlarm[], width: number): cloudwatch.AlarmStatusWidget {
  return new cloudwatch.AlarmStatusWidget({
    title: TITLE.alarms,
    alarms,
    width,
    height: 3,
  });
}

export interface ScraperDashboardProps {
  pollerFunction: lambda.IFunction;
  hydratorFunction: lambda.IFunction;
  compactorFunction: lambda.IFunction;
  alarms: cloudwatch.IAlarm[];
}

/**
 * "Is data still being collected?" — one screen: throughput and pace at the top,
 * the run that matters in the middle, alarm state at the bottom.
 */
export class ScraperDashboard extends Construct {
  constructor(scope: Construct, id: string, props: ScraperDashboardProps) {
    super(scope, id);

    const targets = metric('TrainPriceMonitor', 'PollerTargetsScraped', cdk.Duration.minutes(15), 'Sum');
    const throttled = metric('TrainPriceMonitor', 'PollerThrottled', cdk.Duration.minutes(15), 'Sum');
    const runMs = metric('TrainPriceMonitor', 'PollerRunMs', cdk.Duration.minutes(15), 'Maximum');

    const pipelineErrors = new cloudwatch.MathExpression({
      expression: 'm1 + m2 + m3',
      usingMetrics: {
        m1: props.pollerFunction.metricErrors({ period: cdk.Duration.minutes(15), statistic: 'Sum' }),
        m2: props.hydratorFunction.metricErrors({ period: cdk.Duration.minutes(15), statistic: 'Sum' }),
        m3: props.compactorFunction.metricErrors({ period: cdk.Duration.minutes(15), statistic: 'Sum' }),
      },
      label: 'Poller + hydrator + compactor errors',
      period: cdk.Duration.minutes(15),
    });

    new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: 'TrainPriceMonitor-Scraper',
      start: DEFAULT_START,
      widgets: [
        [
          statTile(`${TITLE.targets} (48 h)`, targets),
          statTile(`${TITLE.throttled} (48 h)`, throttled),
          statTile(`${TITLE.slowestRun} (48 h, abort at 210 s)`, runMs),
          statTile(`${TITLE.pipelineErrors} (48 h)`, pipelineErrors),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'Throughput and pace per run',
            left: [targets],
            right: [runMs],
            leftYAxis: { min: 0, label: 'scrapes' },
            rightYAxis: { min: 0, max: 240_000, label: 'ms' },
            width: FULL,
            height: 6,
          }),
        ],
        [alarmStatus(props.alarms, FULL)],
      ],
    });
  }
}

export interface AppDashboardProps {
  api: apigateway.RestApi;
  queue: sqs.IQueue;
  alarms: cloudwatch.IAlarm[];
}

/**
 * "Is the app healthy for the user?" — traffic and errors, latency, the queue
 * that feeds the hourly watchlist refresh, and alarm state.
 */
export class AppDashboard extends Construct {
  constructor(scope: Construct, id: string, props: AppDashboardProps) {
    super(scope, id);

    const requests = props.api.metricCount({ period: cdk.Duration.minutes(5), statistic: 'Sum' });
    const clientErrors = props.api.metricClientError({ period: cdk.Duration.minutes(5), statistic: 'Sum' });
    const serverErrors = props.api.metricServerError({ period: cdk.Duration.minutes(5), statistic: 'Sum' });
    const latencyP50 = props.api.metricLatency({ period: cdk.Duration.minutes(5), statistic: 'p50' });
    const latencyP90 = props.api.metricLatency({ period: cdk.Duration.minutes(5), statistic: 'p90' });
    const fallbacks = metric('TrainPriceMonitor', 'SearchFallbackOk', cdk.Duration.minutes(5), 'Sum');

    const visible = props.queue.metricApproximateNumberOfMessagesVisible({
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    });
    const oldestAge = props.queue.metricApproximateAgeOfOldestMessage({
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    });

    new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: 'TrainPriceMonitor-App',
      start: DEFAULT_START,
      widgets: [
        [
          statTile(`${TITLE.requests} (48 h)`, requests),
          statTile(`${TITLE.serverErrors} (48 h)`, serverErrors),
          statTile(`${TITLE.latency} (48 h)`, latencyP90),
          statTile(`${TITLE.fallbacks} (48 h)`, fallbacks),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'Requests and errors',
            left: [requests, clientErrors, serverErrors],
            leftYAxis: { min: 0 },
            width: HALF,
            height: 6,
          }),
          new cloudwatch.GraphWidget({
            title: 'Latency',
            left: [latencyP50, latencyP90],
            leftYAxis: { min: 0, label: 'ms' },
            width: HALF,
            height: 6,
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: TITLE.queue,
            left: [visible],
            right: [oldestAge],
            leftYAxis: { min: 0, label: 'messages' },
            rightYAxis: { min: 0, label: 'age (s)' },
            width: HALF,
            height: 5,
          }),
          alarmStatus(props.alarms, HALF),
        ],
      ],
    });
  }
}
