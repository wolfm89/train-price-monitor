import * as cdk from 'aws-cdk-lib';
import {
  aws_apigateway as apigateway,
  aws_cloudwatch as cloudwatch,
  aws_dynamodb as dynamodb,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_s3 as s3,
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
 * budgets are its own limits: 250 s abort, 300 s timeout.
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

// The poller's own limits, in one place so the graph, the gauge and the alarms
// cannot drift apart as the batch size changes.
const RUN_WARN_MS = 200_000;
const RUN_ABORT_MS = 250_000;
const RUN_TIMEOUT_MS = 300_000;

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
  /** Targets per poller run, drawn as the traffic ceiling. */
  batchSize: number;
  pollerFunction: lambda.IFunction;
  hydratorFunction: lambda.IFunction;
  compactorFunction: lambda.IFunction;
  scheduleTable: dynamodb.ITable;
  dataBucket: s3.IBucket;
  pollerLogGroup: logs.ILogGroup;
  alarms: cloudwatch.IAlarm[];
}

/** Latency / traffic / errors / saturation for the data pipeline. */
export function scraperWidgets(props: ScraperDashboardProps): cloudwatch.IWidget[][] {
  // Lambda's own Duration metric is the run length; no custom metric needed.
  const runMsP50 = props.pollerFunction
    .metricDuration({ period: cdk.Duration.minutes(15), statistic: 'p50' })
    .with({ label: 'run p50' });
  const runMsP90 = props.pollerFunction
    .metricDuration({ period: cdk.Duration.minutes(15), statistic: 'p90' })
    .with({ label: 'run p90' });
  const runMsMax = props.pollerFunction
    .metricDuration({ period: cdk.Duration.minutes(15), statistic: 'Maximum' })
    .with({ label: 'run max' });
  // Average across the dashboard's aggregation window keeps this "per run" even
  // when a 1-week view aggregates four 15-minute runs into one hour.
  const scrapes = metric('TrainPriceMonitor', 'PollerTargetsScraped', cdk.Duration.minutes(15), 'Average').with({
    label: 'scrapes per run',
  });
  const scrapesPerHour = metric('TrainPriceMonitor', 'PollerTargetsScraped', cdk.Duration.hours(1), 'Sum');
  const failed = metric('TrainPriceMonitor', 'PollerFailedTargets', cdk.Duration.minutes(15), 'Sum').with({
    label: 'failed scrapes',
  });
  const throttled = metric('TrainPriceMonitor', 'PollerThrottled', cdk.Duration.minutes(15), 'Sum').with({
    label: 'throttled calls',
  });
  const backlog = metric('TrainPriceMonitor', 'PollerBacklog', cdk.Duration.minutes(15), 'Maximum').with({
    label: 'backlog (1 = behind)',
  });
  const rowsPerRun = metric('TrainPriceMonitor', 'PollerRowsWritten', cdk.Duration.minutes(15), 'Average').with({
    label: 'rows per run',
  });
  const rowsPerHour = metric('TrainPriceMonitor', 'PollerRowsWritten', cdk.Duration.hours(1), 'Sum');

  // S3 publishes storage metrics once per day. The graph follows the dashboard's
  // selected range (one point per day), so it never shows a different time frame.
  const bucketMetric = (name: string, storageType: string): cloudwatch.Metric =>
    new cloudwatch.Metric({
      namespace: 'AWS/S3',
      metricName: name,
      dimensionsMap: { BucketName: props.dataBucket.bucketName, StorageType: storageType },
      period: cdk.Duration.days(1),
      statistic: 'Average',
    });
  const storageStandard = bucketMetric('BucketSizeBytes', 'StandardStorage').with({ label: 'Standard' });
  const storageIa = bucketMetric('BucketSizeBytes', 'StandardIAStorage').with({ label: 'Standard-IA' });
  const objectCount = bucketMetric('NumberOfObjects', 'AllStorageTypes').with({ label: 'objects' });
  // Keep bytes: CloudWatch then formats the value as GB/MB on its own. Dividing
  // to MiB kept the inherited byte unit and rendered "1.66 kB".
  const storageTotal = new cloudwatch.MathExpression({
    expression: 'm1 + m2',
    usingMetrics: { m1: storageStandard, m2: storageIa },
    label: 'storage',
    period: cdk.Duration.days(1),
  });

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
    expression: '100 * m1 / (5 * 900)',
    usingMetrics: {
      m1: props.scheduleTable.metricConsumedWriteCapacityUnits({ period: cdk.Duration.minutes(15), statistic: 'Sum' }),
    },
    label: 'write capacity utilization %',
    period: cdk.Duration.minutes(15),
  });

  return [
    [header('**Scraper** · batch 25 targets every 15 min · priority NEAR → MID → FAR · abort 250 s · timeout 300 s')],
    [alarmStatus(props.alarms)],
    [
      new cloudwatch.GraphWidget({
        title: 'Latency — run duration',
        left: [runMsP50, runMsP90, runMsMax],
        leftYAxis: { min: 0, label: 'ms' },
        leftAnnotations: [
          { value: RUN_ABORT_MS, label: 'abort', color: AMBER },
          { value: RUN_TIMEOUT_MS, label: 'timeout', color: RED },
        ],
        width: GRAPH_WIDTH,
        height: GRAPH_HEIGHT,
      }),
      new cloudwatch.GaugeWidget({
        title: 'Latency — slowest run now',
        metrics: [runMsMax],
        leftYAxis: { min: 0, max: RUN_TIMEOUT_MS },
        annotations: [
          // 180 s was the warn band at batch 18-22; at batch 25 the p90 is already
          // 190 s, so warning there would paint a healthy pipeline amber.
          { value: RUN_WARN_MS, label: 'warn', color: AMBER },
          { value: RUN_ABORT_MS, label: 'abort', color: RED },
        ],
        width: VALUE_WIDTH,
        height: VALUE_HEIGHT,
      }),
    ],
    [
      new cloudwatch.GraphWidget({
        // Bars are only readable while the window holds a handful of runs; 48 h at
        // 15-minute bars collapses into one solid block.
        title: 'Traffic — scrapes per run',
        left: [scrapes],
        view: cloudwatch.GraphWidgetView.TIME_SERIES,
        leftYAxis: { min: 0, label: 'scrapes' },
        leftAnnotations: [{ value: props.batchSize, label: 'batch capacity', color: GREEN }],
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
        view: cloudwatch.GraphWidgetView.TIME_SERIES,
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
        title: 'Data — price rows per run',
        left: [rowsPerRun],
        view: cloudwatch.GraphWidgetView.TIME_SERIES,
        leftYAxis: { min: 0, label: 'rows' },
        width: GRAPH_WIDTH,
        height: GRAPH_HEIGHT,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Data — rows written in the last hour',
        metrics: [rowsPerHour],
        sparkline: false,
        width: VALUE_WIDTH,
        height: VALUE_HEIGHT,
      }),
    ],
    [
      new cloudwatch.GraphWidget({
        title: 'Storage — bucket size (daily)',
        left: [storageStandard, storageIa],
        stacked: true,
        leftYAxis: { min: 0, label: 'bytes' },
        width: GRAPH_WIDTH,
        height: GRAPH_HEIGHT,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Storage — current size',
        metrics: [storageTotal],
        sparkline: false,
        width: VALUE_WIDTH,
        height: VALUE_HEIGHT,
      }),
    ],
    [
      new cloudwatch.GraphWidget({
        title: 'Storage — objects (daily)',
        left: [objectCount],
        leftYAxis: { min: 0, label: 'objects' },
        legendPosition: cloudwatch.LegendPosition.HIDDEN,
        width: GRAPH_WIDTH,
        height: GRAPH_HEIGHT,
      }),
      new cloudwatch.TextWidget({
        markdown:
          'Objects are the Parquet files: one per poller batch plus one compacted file per day. The count rises during the day and drops after compaction at 03:00 UTC.',
        width: VALUE_WIDTH,
        height: VALUE_HEIGHT,
      }),
    ],
    [
      logsTable('Diagnostics — recent failed target scrapes', props.pollerLogGroup, [
        'fields @timestamp, route_id, departure_date, err',
        'filter message = "Failed to scrape target"',
        'sort @timestamp desc',
        'limit 10',
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
  const latencyP50 = props.api
    .metricLatency({ period: cdk.Duration.minutes(5), statistic: 'p50' })
    .with({ label: 'Latency p50' });
  const latencyP90 = props.api
    .metricLatency({ period: cdk.Duration.minutes(5), statistic: 'p90' })
    .with({ label: 'Latency p90' });
  const latencyP99 = props.api
    .metricLatency({ period: cdk.Duration.minutes(5), statistic: 'p99' })
    .with({ label: 'Latency p99' });
  const backendP90 = props.api
    .metricIntegrationLatency({ period: cdk.Duration.minutes(5), statistic: 'p90' })
    .with({ label: 'Integration p90' });
  const requests = props.api
    .metricCount({ period: cdk.Duration.minutes(5), statistic: 'Sum' })
    .with({ label: 'API Gateway requests' });
  const requestsPerHour = props.api.metricCount({ period: cdk.Duration.hours(1), statistic: 'Sum' });
  const invocations = props.apiFunction
    .metricInvocations({ period: cdk.Duration.minutes(5), statistic: 'Sum' })
    .with({ label: 'GraphQL invocations' });
  const clientErrors = props.api
    .metricClientError({ period: cdk.Duration.minutes(5), statistic: 'Sum' })
    .with({ label: '4xx (client/token)' });
  const serverErrors = props.api
    .metricServerError({ period: cdk.Duration.minutes(5), statistic: 'Sum' })
    .with({ label: '5xx' });
  const fallbacks = metric('TrainPriceMonitor', 'SearchFallbackOk', cdk.Duration.minutes(5), 'Sum').with({
    label: 'DB refused (Decodo)',
  });
  // Yoga returns HTTP 200 with an errors[] payload, so API Gateway's 5xx metric
  // misses resolver failures. The backend logs them at ERROR; the filter metric
  // is already part of the free ten.
  const graphqlErrors = metric('TrainPriceMonitor', 'SearchErrorLogs', cdk.Duration.minutes(5), 'Sum').with({
    label: 'GraphQL errors',
  });

  const concurrency = props.apiFunction
    .metric('ConcurrentExecutions', {
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    })
    .with({ label: 'API concurrency' });
  const throttles = props.apiFunction
    .metricThrottles({ period: cdk.Duration.minutes(5), statistic: 'Sum' })
    .with({ label: 'API throttles' });
  const dlqDepth = props.dlq
    .metricApproximateNumberOfMessagesVisible({
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    })
    .with({ label: 'DLQ messages' });
  const dlqAge = props.dlq
    .metricApproximateAgeOfOldestMessage({
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    })
    .with({ label: 'DLQ oldest message age' });

  const sesSends = metric('AWS/SES', 'Send', cdk.Duration.minutes(5), 'Sum').with({ label: 'SES sends' });
  const sesDeliveries = metric('AWS/SES', 'Delivery', cdk.Duration.minutes(5), 'Sum').with({
    label: 'SES deliveries',
  });
  const sesBounces = metric('AWS/SES', 'Bounce', cdk.Duration.minutes(5), 'Sum').with({ label: 'SES bounces' });
  const sesComplaints = metric('AWS/SES', 'Complaint', cdk.Duration.minutes(5), 'Sum').with({
    label: 'SES complaints',
  });
  const sesBounceRate = new cloudwatch.MathExpression({
    expression: '100 * m1 / m2',
    usingMetrics: { m1: sesBounces, m2: sesSends },
    label: 'bounce rate %',
    period: cdk.Duration.minutes(5),
  });

  const errorRate = new cloudwatch.MathExpression({
    // 4xx stays separate (expired tokens / client errors). A GraphQL failure is
    // an HTTP 200 with an errors[] entry, so the log-based SearchErrorLogs metric
    // is part of the numerator. Lambda invocations, not the API Gateway count
    // (which includes preflights), are the denominator.
    expression: '100 * (m2 + m4) / m3',
    usingMetrics: { m2: serverErrors, m3: invocations, m4: graphqlErrors },
    label: 'error rate % (5xx + GraphQL)',
    period: cdk.Duration.minutes(5),
  });

  return [
    [
      header(
        '**App** · GraphQL API behind Cognito · DB direct with Decodo fallback · interactive p50 < 200 ms · search p99 < 8 s'
      ),
    ],
    [alarmStatus(props.alarms)],
    [
      new cloudwatch.GraphWidget({
        title: 'Latency — API percentiles and backend time',
        // Interactive calls and searches have different budgets; two axes keep
        // the 8 s search tail from flattening the 10-300 ms interactive curves.
        left: [latencyP50, latencyP90],
        right: [latencyP99, backendP90],
        leftYAxis: { min: 0, max: 1000, label: 'ms (interactive)' },
        rightYAxis: { min: 0, max: 8000, label: 'ms (search)' },
        leftAnnotations: [{ value: 200, label: 'interactive SLO', color: GREEN }],
        rightAnnotations: [{ value: 8000, label: 'search p99 budget', color: AMBER }],
        width: GRAPH_WIDTH,
        height: GRAPH_HEIGHT,
      }),
      new cloudwatch.GaugeWidget({
        title: 'Latency — p50 (current period)',
        metrics: [latencyP50],
        leftYAxis: { min: 0, max: 1000 },
        annotations: [
          { value: 200, label: 'good', color: GREEN },
          { value: 500, label: 'limit', color: RED },
        ],
        width: VALUE_WIDTH,
        height: VALUE_HEIGHT,
      }),
    ],
    [
      new cloudwatch.GraphWidget({
        title: 'Traffic — requests',
        left: [requests, invocations],
        view: cloudwatch.GraphWidgetView.TIME_SERIES,
        leftYAxis: { min: 0, label: 'requests' },
        width: GRAPH_WIDTH,
        height: GRAPH_HEIGHT,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Traffic — requests (last hour)',
        metrics: [requestsPerHour],
        sparkline: false,
        width: VALUE_WIDTH,
        height: VALUE_HEIGHT,
      }),
    ],
    [
      new cloudwatch.GraphWidget({
        title: 'Errors — 4xx, 5xx, GraphQL errors and fallbacks',
        left: [clientErrors, serverErrors, graphqlErrors, fallbacks],
        view: cloudwatch.GraphWidgetView.TIME_SERIES,
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
        title: 'Saturation — DLQ oldest message age',
        metrics: [dlqAge],
        sparkline: false,
        width: VALUE_WIDTH,
        height: VALUE_HEIGHT,
      }),
    ],
    [
      logsTable('Diagnostics — recent API errors', props.apiLogGroup, [
        'fields @timestamp, message',
        'filter level = "ERROR"',
        'sort @timestamp desc',
        'limit 10',
      ]),
    ],
    [
      new cloudwatch.GraphWidget({
        title: 'Notifications — SES sends, deliveries, bounces',
        left: [sesSends, sesDeliveries, sesBounces, sesComplaints],
        leftYAxis: { min: 0, label: 'emails' },
        width: GRAPH_WIDTH,
        height: GRAPH_HEIGHT,
      }),
      new cloudwatch.GaugeWidget({
        title: 'Notifications — bounce rate',
        metrics: [sesBounceRate],
        leftYAxis: { min: 0, max: 5 },
        annotations: [{ value: 2, label: 'limit', color: RED }],
        width: VALUE_WIDTH,
        height: VALUE_HEIGHT,
      }),
    ],
  ];
}
