import * as cdk from 'aws-cdk-lib';
import {
  aws_apigateway as apigateway,
  aws_cloudwatch as cloudwatch,
  aws_lambda as lambda,
  aws_sqs as sqs,
} from 'aws-cdk-lib';

/**
 * Dashboards follow Google's Four Golden Signals (SRE book, ch. 6): one row each
 * for latency, traffic, errors and saturation, plus the alarm state. Rates and
 * percentiles are shown instead of 48-hour totals — a total tells you what
 * happened, a rate tells you what is happening.
 *
 * Everything stays inside the CloudWatch free tier (3 dashboards, 50 metrics
 * each). Default window: 48 hours, which covers two nightly compactions.
 */
const DEFAULT_START = '-PT48H';

/** Relative start used by both dashboards. */
export const DASHBOARD_START = DEFAULT_START;

const FULL = 24;
const GRAPH_HEIGHT = 5;

function metric(namespace: string, metricName: string, period: cdk.Duration, statistic: string): cloudwatch.Metric {
  return new cloudwatch.Metric({ namespace, metricName, period, statistic });
}

function signal(title: string, widget: cloudwatch.IWidget): cloudwatch.IWidget[] {
  return [widget];
}

function alarmStatus(alarms: cloudwatch.IAlarm[]): cloudwatch.AlarmStatusWidget {
  return new cloudwatch.AlarmStatusWidget({ title: 'Alarms', alarms, width: FULL, height: 3 });
}

export interface ScraperDashboardProps {
  pollerFunction: lambda.IFunction;
  hydratorFunction: lambda.IFunction;
  compactorFunction: lambda.IFunction;
  alarms: cloudwatch.IAlarm[];
}

/**
 * Latency / traffic / errors / saturation for the data pipeline.
 */
export function scraperWidgets(props: ScraperDashboardProps): cloudwatch.IWidget[][] {
  const runMsP90 = metric('TrainPriceMonitor', 'PollerRunMs', cdk.Duration.minutes(15), 'p90');
  const runMsMax = metric('TrainPriceMonitor', 'PollerRunMs', cdk.Duration.minutes(15), 'Maximum');
  const scrapes = metric('TrainPriceMonitor', 'PollerTargetsScraped', cdk.Duration.minutes(15), 'Sum');
  const failed = metric('TrainPriceMonitor', 'PollerFailedTargets', cdk.Duration.minutes(15), 'Sum');
  const throttled = metric('TrainPriceMonitor', 'PollerThrottled', cdk.Duration.minutes(15), 'Sum');
  const backlog = metric('TrainPriceMonitor', 'PollerBacklog', cdk.Duration.minutes(15), 'Maximum');

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
    signal(
      'Latency',
      new cloudwatch.GraphWidget({
        title: 'Latency — run duration (p90 and max; abort at 210 s, timeout 240 s)',
        left: [runMsP90, runMsMax],
        leftYAxis: { min: 0, label: 'ms' },
        width: FULL,
        height: GRAPH_HEIGHT,
      })
    ),
    signal(
      'Traffic',
      new cloudwatch.GraphWidget({
        title: 'Traffic — scrapes per 15-minute run',
        left: [scrapes],
        leftYAxis: { min: 0, label: 'scrapes' },
        width: FULL,
        height: GRAPH_HEIGHT,
      })
    ),
    signal(
      'Errors',
      new cloudwatch.GraphWidget({
        title: 'Errors — failed target scrapes and pipeline errors',
        left: [failed, pipelineErrors],
        leftYAxis: { min: 0 },
        width: FULL,
        height: GRAPH_HEIGHT,
      })
    ),
    signal(
      'Saturation',
      new cloudwatch.GraphWidget({
        title: 'Saturation — DB-throttled calls and backlog (1 = more due than one batch)',
        left: [throttled],
        right: [backlog],
        leftYAxis: { min: 0, label: 'throttled calls' },
        rightYAxis: { min: 0, max: 1, label: 'backlog' },
        width: FULL,
        height: GRAPH_HEIGHT,
      })
    ),
    [alarmStatus(props.alarms)],
  ];
}

export interface AppDashboardProps {
  api: apigateway.RestApi;
  apiFunction: lambda.IFunction;
  dlq: sqs.IQueue;
  alarms: cloudwatch.IAlarm[];
}

/**
 * Latency / traffic / errors / saturation for the user-facing API.
 */
export function appWidgets(props: AppDashboardProps): cloudwatch.IWidget[][] {
  const latencyP50 = props.api.metricLatency({ period: cdk.Duration.minutes(5), statistic: 'p50' });
  const latencyP90 = props.api.metricLatency({ period: cdk.Duration.minutes(5), statistic: 'p90' });
  const backendP90 = props.api.metricIntegrationLatency({ period: cdk.Duration.minutes(5), statistic: 'p90' });
  const requests = props.api.metricCount({ period: cdk.Duration.minutes(5), statistic: 'Sum' });
  const clientErrors = props.api.metricClientError({ period: cdk.Duration.minutes(5), statistic: 'Sum' });
  const serverErrors = props.api.metricServerError({ period: cdk.Duration.minutes(5), statistic: 'Sum' });
  const fallbacks = metric('TrainPriceMonitor', 'SearchFallbackOk', cdk.Duration.minutes(5), 'Sum');

  const concurrency = props.apiFunction.metric('ConcurrentExecutions', {
    period: cdk.Duration.minutes(5),
    statistic: 'Maximum',
  });
  const throttles = props.apiFunction.metricThrottles({ period: cdk.Duration.minutes(5), statistic: 'Sum' });
  const dlqDepth = props.dlq.metricApproximateNumberOfMessagesVisible({
    period: cdk.Duration.minutes(5),
    statistic: 'Maximum',
  });

  return [
    signal(
      'Latency',
      new cloudwatch.GraphWidget({
        title: 'Latency — API p50/p90 and backend (integration) p90',
        left: [latencyP50, latencyP90, backendP90],
        leftYAxis: { min: 0, label: 'ms' },
        width: FULL,
        height: GRAPH_HEIGHT,
      })
    ),
    signal(
      'Traffic',
      new cloudwatch.GraphWidget({
        title: 'Traffic — requests per 5 minutes',
        left: [requests],
        leftYAxis: { min: 0, label: 'requests' },
        width: FULL,
        height: GRAPH_HEIGHT,
      })
    ),
    signal(
      'Errors',
      new cloudwatch.GraphWidget({
        title: 'Errors — 4xx, 5xx and implicit failures (DB refused, Decodo served)',
        left: [clientErrors, serverErrors, fallbacks],
        leftYAxis: { min: 0 },
        width: FULL,
        height: GRAPH_HEIGHT,
      })
    ),
    signal(
      'Saturation',
      new cloudwatch.GraphWidget({
        title: 'Saturation — Lambda concurrency, throttles and dead-letter queue depth',
        left: [concurrency, throttles],
        right: [dlqDepth],
        leftYAxis: { min: 0 },
        rightYAxis: { min: 0, label: 'DLQ messages' },
        width: FULL,
        height: GRAPH_HEIGHT,
      })
    ),
    [alarmStatus(props.alarms)],
  ];
}
