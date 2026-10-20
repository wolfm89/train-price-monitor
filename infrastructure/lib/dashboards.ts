import * as cdk from 'aws-cdk-lib';
import {
  aws_apigateway as apigateway,
  aws_cloudwatch as cloudwatch,
  aws_dynamodb as dynamodb,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_sqs as sqs,
} from 'aws-cdk-lib';

/**
 * Dashboards follow Google's Four Golden Signals (SRE book, ch. 6): one block
 * each for latency, traffic, errors and saturation, followed by the alarm state
 * and a diagnostics table. Every block pairs a graph (the trend) with a gauge or
 * number (the value now).
 *
 * Latency budgets: Nielsen/RAIL put "flow" at 1 s and common API SLOs pair
 * p95 < 500 ms with p99 < 1 s, so the app graph annotates 1 s as the tail budget
 * and the gauge bands at 300 ms (good) and 1000 ms (limit). The scraper's
 * budgets are its own limits: 210 s abort, 240 s timeout.
 *
 * Everything stays inside the CloudWatch free tier (3 dashboards, 50 metrics
 * each). Default window: 48 hours, two nightly compactions.
 */
const DEFAULT_START = '-PT48H';

/** Relative start used by both dashboards. */
export const DASHBOARD_START = DEFAULT_START;

const FULL = 24;
const GRAPH_WIDTH = 16;
const VALUE_WIDTH = 8;
const GRAPH_HEIGHT = 6;
const VALUE_HEIGHT = 6;

const GREEN = '#2ca02c';
const AMBER = '#ff9900';
const RED = '#d62728';

function metric(namespace: string, metricName: string, period: cdk.Duration, statistic: string): cloudwatch.Metric {
  return new cloudwatch.Metric({ namespace, metricName, period, statistic });
}

function alarmStatus(alarms: cloudwatch.IAlarm[]): cloudwatch.AlarmStatusWidget {
  return new cloudwatch.AlarmStatusWidget({ title: 'Alarms', alarms, width: FULL, height: 3 });
}

function header(markdown: string): cloudwatch.TextWidget {
  return new cloudwatch.TextWidget({ markdown, width: FULL, height: 2 });
}

function logsTable(title: string, logGroup: logs.ILogGroup, queryLines: string[]): cloudwatch.LogQueryWidget {
  return new cloudwatch.LogQueryWidget({
    title,
    logGroupNames: [logGroup.logGroupName],
    queryLines,
    view: cloudwatch.LogQueryVisualizationType.TABLE,
    width: FULL,
    height: 5,
  });
}

export interface ScraperDashboardProps {
  pollerFunction: lambda.IFunction;
  hydratorFunction: lambda.IFunction;
  compactorFunction: lambda.IFunction;
  scheduleTable: dynamodb.ITable;
  pollerLogGroup: logs.ILogGroup;
  alarms: cloudwatch.IAlarm[];
}

/** Latency / traffic / errors / saturation for the data pipeline. */
export function scraperWidgets(props: ScraperDashboardProps): cloudwatch.IWidget[][] {
  const runMsP50 = metric('TrainPriceMonitor', 'PollerRunMs', cdk.Duration.minutes(15), 'p50');
  const runMsP90 = metric('TrainPriceMonitor', 'PollerRunMs', cdk.Duration.minutes(15), 'p90');
  const runMsMax = metric('TrainPriceMonitor', 'PollerRunMs', cdk.Duration.minutes(15), 'Maximum');
  const scrapes = metric('TrainPriceMonitor', 'PollerTargetsScraped', cdk.Duration.minutes(15), 'Sum');
  const scrapesPerHour = metric('TrainPriceMonitor', 'PollerTargetsScraped', cdk.Duration.hours(1), 'Sum');
  const failed = metric('TrainPriceMonitor', 'PollerFailedTargets', cdk.Duration.minutes(15), 'Sum');
  const throttled = metric('TrainPriceMonitor', 'PollerThrottled', cdk.Duration.minutes(15), 'Sum');
  const backlog = metric('TrainPriceMonitor', 'PollerBacklog', cdk.Duration.minutes(15), 'Maximum');
  const rowsPerRun = metric('TrainPriceMonitor', 'PollerRowsWritten', cdk.Duration.minutes(15), 'Sum');
  const rowsPerHour = metric('TrainPriceMonitor', 'PollerRowsWritten', cdk.Duration.hours(1), 'Sum');

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

  // Failure rate over the visible window: failures / attempts.
  const failureRate = new cloudwatch.MathExpression({
    expression: '100 * m1 / (m1 + m2)',
    usingMetrics: { m1: failed, m2: scrapes },
    label: 'failure rate %',
    period: cdk.Duration.minutes(15),
  });

  // The schedule table is provisioned at 5 WCU; this is the most constrained
  // resource of the pipeline, so it is the saturation headline.
  const writeUtilization = new cloudwatch.MathExpression({
    expression: '100 * m1 / 5',
    usingMetrics: {
      m1: props.scheduleTable.metricConsumedWriteCapacityUnits({ period: cdk.Duration.minutes(15), statistic: 'Sum' }),
    },
    label: 'write capacity utilization %',
    period: cdk.Duration.minutes(15),
  });

  return [
    [header('**Scraper** · batch 22 targets every 15 min · priority NEAR → MID → FAR · abort 210 s · timeout 240 s')],
    [
      new cloudwatch.GraphWidget({
        title: 'Latency — run duration',
        left: [runMsP50, runMsP90, runMsMax],
        leftYAxis: { min: 0, label: 'ms' },
        leftAnnotations: [
          { value: 210_000, label: 'abort', color: AMBER },
          { value: 240_000, label: 'timeout', color: RED },
        ],
        width: GRAPH_WIDTH,
        height: GRAPH_HEIGHT,
      }),
      new cloudwatch.GaugeWidget({
        title: 'Latency — slowest run now',
        metrics: [runMsMax],
        leftYAxis: { min: 0, max: 240_000 },
        annotations: [
          { value: 180_000, label: 'warn', color: AMBER },
          { value: 210_000, label: 'abort', color: RED },
        ],
        width: VALUE_WIDTH,
        height: VALUE_HEIGHT,
      }),
    ],
    [
      new cloudwatch.GraphWidget({
        title: 'Traffic — scrapes per run',
        left: [scrapes],
        view: cloudwatch.GraphWidgetView.BAR,
        leftYAxis: { min: 0, label: 'scrapes' },
        leftAnnotations: [{ value: 22, label: 'batch capacity', color: GREEN }],
        width: GRAPH_WIDTH,
        height: GRAPH_HEIGHT,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Traffic — scrapes in the last hour',
        metrics: [scrapesPerHour],
        sparkline: true,
        width: VALUE_WIDTH,
        height: VALUE_HEIGHT,
      }),
    ],
    [
      new cloudwatch.GraphWidget({
        title: 'Errors — failed target scrapes and pipeline errors',
        left: [failed, pipelineErrors],
        view: cloudwatch.GraphWidgetView.BAR,
        stacked: true,
        leftYAxis: { min: 0 },
        width: GRAPH_WIDTH,
        height: GRAPH_HEIGHT,
      }),
      new cloudwatch.GaugeWidget({
        title: 'Errors — failure rate',
        metrics: [failureRate],
        leftYAxis: { min: 0, max: 100 },
        annotations: [
          { value: 5, label: 'elevated', color: AMBER },
          { value: 20, label: 'degraded', color: RED },
        ],
        width: VALUE_WIDTH,
        height: VALUE_HEIGHT,
      }),
    ],
    [
      new cloudwatch.GraphWidget({
        title: 'Saturation — DB throttling and backlog',
        left: [throttled],
        right: [backlog],
        leftYAxis: { min: 0, label: 'throttled calls' },
        rightYAxis: { min: 0, max: 1, label: 'backlog (1 = behind)' },
        width: GRAPH_WIDTH,
        height: GRAPH_HEIGHT,
      }),
      new cloudwatch.GaugeWidget({
        title: 'Saturation — schedule table write capacity',
        metrics: [writeUtilization],
        leftYAxis: { min: 0, max: 100 },
        annotations: [
          { value: 70, label: 'watch', color: AMBER },
          { value: 90, label: 'at limit', color: RED },
        ],
        width: VALUE_WIDTH,
        height: VALUE_HEIGHT,
      }),
    ],
    [
      new cloudwatch.GraphWidget({
        title: 'Data — price rows written per run',
        left: [rowsPerRun],
        view: cloudwatch.GraphWidgetView.BAR,
        leftYAxis: { min: 0, label: 'rows' },
        width: GRAPH_WIDTH,
        height: GRAPH_HEIGHT,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Data — rows written in the last hour',
        metrics: [rowsPerHour],
        sparkline: true,
        width: VALUE_WIDTH,
        height: VALUE_HEIGHT,
      }),
    ],
    [alarmStatus(props.alarms)],
    [
      logsTable('Diagnostics — recent failed target scrapes', props.pollerLogGroup, [
        'fields @timestamp, route_id, departure_date, err',
        '| filter message = "Failed to scrape target"',
        '| sort @timestamp desc',
        '| limit 10',
      ]),
    ],
  ];
}

export interface AppDashboardProps {
  api: apigateway.RestApi;
  apiFunction: lambda.IFunction;
  dlq: sqs.IQueue;
  apiLogGroup: logs.ILogGroup;
  alarms: cloudwatch.IAlarm[];
}

/** Latency / traffic / errors / saturation for the user-facing API. */
export function appWidgets(props: AppDashboardProps): cloudwatch.IWidget[][] {
  const latencyP50 = props.api.metricLatency({ period: cdk.Duration.minutes(5), statistic: 'p50' });
  const latencyP90 = props.api.metricLatency({ period: cdk.Duration.minutes(5), statistic: 'p90' });
  const latencyP99 = props.api.metricLatency({ period: cdk.Duration.minutes(5), statistic: 'p99' });
  const backendP90 = props.api.metricIntegrationLatency({ period: cdk.Duration.minutes(5), statistic: 'p90' });
  const requests = props.api.metricCount({ period: cdk.Duration.minutes(5), statistic: 'Sum' });
  const requestsPerMinute = props.api.metricCount({ period: cdk.Duration.minutes(1), statistic: 'Sum' });
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

  const sesSends = metric('AWS/SES', 'Send', cdk.Duration.minutes(5), 'Sum');
  const sesDeliveries = metric('AWS/SES', 'Delivery', cdk.Duration.minutes(5), 'Sum');
  const sesBounceRate = metric('AWS/SES', 'Reputation.BounceRate', cdk.Duration.hours(1), 'Average');
  const sesSendsPerHour = metric('AWS/SES', 'Send', cdk.Duration.hours(1), 'Sum');

  const errorRate = new cloudwatch.MathExpression({
    expression: '100 * (m1 + m2) / m3',
    usingMetrics: { m1: clientErrors, m2: serverErrors, m3: requests },
    label: 'error rate %',
    period: cdk.Duration.minutes(5),
  });

  return [
    [
      header(
        '**App** · GraphQL API behind Cognito · DB direct with Decodo fallback · latency budget p99 < 1 s (p95 < 500 ms)'
      ),
    ],
    [
      new cloudwatch.GraphWidget({
        title: 'Latency — API percentiles and backend time',
        left: [latencyP50, latencyP90, latencyP99, backendP90],
        leftYAxis: { min: 0, label: 'ms' },
        leftAnnotations: [{ value: 1000, label: 'p99 budget', color: AMBER }],
        width: GRAPH_WIDTH,
        height: GRAPH_HEIGHT,
      }),
      new cloudwatch.GaugeWidget({
        title: 'Latency — p90 now',
        metrics: [latencyP90],
        leftYAxis: { min: 0, max: 1000 },
        annotations: [
          { value: 300, label: 'good', color: GREEN },
          { value: 1000, label: 'limit', color: RED },
        ],
        width: VALUE_WIDTH,
        height: VALUE_HEIGHT,
      }),
    ],
    [
      new cloudwatch.GraphWidget({
        title: 'Traffic — requests per 5 minutes',
        left: [requests],
        view: cloudwatch.GraphWidgetView.BAR,
        leftYAxis: { min: 0, label: 'requests' },
        width: GRAPH_WIDTH,
        height: GRAPH_HEIGHT,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Traffic — requests per minute now',
        metrics: [requestsPerMinute],
        sparkline: true,
        width: VALUE_WIDTH,
        height: VALUE_HEIGHT,
      }),
    ],
    [
      new cloudwatch.GraphWidget({
        title: 'Errors — 4xx, 5xx and implicit failures (DB refused, Decodo served)',
        left: [clientErrors, serverErrors, fallbacks],
        view: cloudwatch.GraphWidgetView.BAR,
        stacked: true,
        leftYAxis: { min: 0 },
        width: GRAPH_WIDTH,
        height: GRAPH_HEIGHT,
      }),
      new cloudwatch.GaugeWidget({
        title: 'Errors — error rate',
        metrics: [errorRate],
        leftYAxis: { min: 0, max: 100 },
        annotations: [
          { value: 1, label: 'elevated', color: AMBER },
          { value: 5, label: 'degraded', color: RED },
        ],
        width: VALUE_WIDTH,
        height: VALUE_HEIGHT,
      }),
    ],
    [
      new cloudwatch.GraphWidget({
        title: 'Saturation — Lambda concurrency, throttles and dead-letter queue',
        left: [concurrency, throttles],
        right: [dlqDepth],
        leftYAxis: { min: 0 },
        rightYAxis: { min: 0, label: 'DLQ messages' },
        width: GRAPH_WIDTH,
        height: GRAPH_HEIGHT,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Saturation — DLQ messages now',
        metrics: [dlqDepth],
        sparkline: true,
        width: VALUE_WIDTH,
        height: VALUE_HEIGHT,
      }),
    ],
    [
      new cloudwatch.GraphWidget({
        title: 'Notifications — SES sends and deliveries',
        left: [sesSends, sesDeliveries],
        leftYAxis: { min: 0, label: 'emails' },
        width: GRAPH_WIDTH,
        height: GRAPH_HEIGHT,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Notifications — emails sent in the last hour',
        metrics: [sesSendsPerHour],
        sparkline: true,
        width: VALUE_WIDTH,
        height: VALUE_HEIGHT,
      }),
    ],
    [
      new cloudwatch.GaugeWidget({
        title: 'Notifications — bounce rate',
        metrics: [sesBounceRate],
        leftYAxis: { min: 0, max: 10 },
        annotations: [
          { value: 2, label: 'watch', color: AMBER },
          { value: 5, label: 'AWS limit', color: RED },
        ],
        width: VALUE_WIDTH,
        height: VALUE_HEIGHT,
      }),
      new cloudwatch.TextWidget({
        markdown:
          'Alert emails go out through SES when a watched journey crosses its threshold. A rising bounce rate means the address on file is undeliverable.',
        width: GRAPH_WIDTH,
        height: VALUE_HEIGHT,
      }),
    ],
    [alarmStatus(props.alarms)],
    [
      logsTable('Diagnostics — recent API errors', props.apiLogGroup, [
        'fields @timestamp, message',
        '| filter level = "ERROR"',
        '| sort @timestamp desc',
        '| limit 10',
      ]),
    ],
  ];
}
