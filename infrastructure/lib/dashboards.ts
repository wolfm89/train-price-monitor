import * as cdk from 'aws-cdk-lib';
import { aws_apigateway as apigateway, aws_cloudwatch as cloudwatch, aws_lambda as lambda } from 'aws-cdk-lib';

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
  refresh: 'Hourly watchlist refresh',
  alarms: 'Alarms',
};

/** Relative start used by both dashboards (48 h). */
export const DASHBOARD_START = DEFAULT_START;

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
  return new cloudwatch.AlarmStatusWidget({ title: TITLE.alarms, alarms, width, height: 3 });
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
export function scraperWidgets(props: ScraperDashboardProps): cloudwatch.IWidget[][] {
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

  return [
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
  ];
}

export interface AppDashboardProps {
  api: apigateway.RestApi;
  refresherFunction: lambda.IFunction;
  alarms: cloudwatch.IAlarm[];
}

/**
 * "Is the app healthy for the user?" — traffic and errors, latency, the queue
 * that feeds the hourly watchlist refresh, and alarm state.
 */
export function appWidgets(props: AppDashboardProps): cloudwatch.IWidget[][] {
  const requests = props.api.metricCount({ period: cdk.Duration.minutes(5), statistic: 'Sum' });
  const clientErrors = props.api.metricClientError({ period: cdk.Duration.minutes(5), statistic: 'Sum' });
  const serverErrors = props.api.metricServerError({ period: cdk.Duration.minutes(5), statistic: 'Sum' });
  const latencyP50 = props.api.metricLatency({ period: cdk.Duration.minutes(5), statistic: 'p50' });
  const latencyP90 = props.api.metricLatency({ period: cdk.Duration.minutes(5), statistic: 'p90' });
  const fallbacks = metric('TrainPriceMonitor', 'SearchFallbackOk', cdk.Duration.minutes(5), 'Sum');

  // The queue itself is useless as an indicator: EventBridge drops one message
  // per hour and the refresher consumes it in well under a second, so a 5-minute
  // sample is ~always zero. The refresher's own invocations show the same hourly
  // pulse and also reveal failures.
  const refreshRuns = props.refresherFunction.metricInvocations({
    period: cdk.Duration.hours(1),
    statistic: 'Sum',
  });
  const refreshErrors = props.refresherFunction.metricErrors({
    period: cdk.Duration.hours(1),
    statistic: 'Sum',
  });
  const refreshDuration = props.refresherFunction.metricDuration({
    period: cdk.Duration.hours(1),
    statistic: 'p90',
  });

  return [
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
        title: TITLE.refresh,
        left: [refreshRuns, refreshErrors],
        right: [refreshDuration],
        leftYAxis: { min: 0, label: 'runs / errors' },
        rightYAxis: { min: 0, label: 'p90 (ms)' },
        width: HALF,
        height: 5,
      }),
      alarmStatus(props.alarms, HALF),
    ],
  ];
}
