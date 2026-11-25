import { PUSHOVER_FORWARDER_SOURCE } from '../lib/alerting';
import {
  ALERT_TOPIC_NAME,
  BRONZE_PREFIX,
  DASHBOARD_NAMES,
  METRIC_NAMESPACE,
  MONTHLY_BUDGET_NAME,
  MONTHLY_BUDGET_USD,
  POLLER_DB_GAP_MS,
  POLLER_DB_TOTAL_BUDGET_MS,
  RETENTION_CONFIG,
  SCHEDULES,
  SCRAPER_CONFIG,
  SILVER_CONFIG,
  SILVER_FAILURE_EVENT,
  SILVER_FAILURE_STAGES,
  SILVER_QUALITY_EVENT,
} from '../lib/config';

function minutesOfDay(schedule: { hour: number; minute: number }): number {
  return schedule.hour * 60 + schedule.minute;
}

function sizeMib(value: string): number {
  const match = /^(\d+)(MB|GB)$/.exec(value);
  if (!match) throw new Error(`invalid size ${value}`);
  return Number(match[1]) * (match[2] === 'GB' ? 1024 : 1);
}

describe('shared configuration', () => {
  test('keeps the analytics schedule after the compactor', () => {
    expect(SCHEDULES.analytics).toEqual({ hour: 3, minute: 30 });
    expect(minutesOfDay(SCHEDULES.analytics)).toBe(minutesOfDay(SCHEDULES.compactor) + 30);
  });

  test('keeps the poller safety margin inside the Lambda timeout', () => {
    // Worst case: the guard, one staggered target at the full request budget,
    // and the final upload. The poller now runs 20 targets, so normal runs are
    // well below the guard.
    const dbGapMs = POLLER_DB_GAP_MS;
    const dbTotalBudgetMs = POLLER_DB_TOTAL_BUDGET_MS;
    const uploadMs = 1_000;
    expect(SCRAPER_CONFIG.abort_threshold_ms + dbGapMs + dbTotalBudgetMs + uploadMs).toBeLessThanOrEqual(290_000);
    expect(SCRAPER_CONFIG.abort_threshold_ms + dbGapMs + dbTotalBudgetMs + uploadMs).toBeLessThanOrEqual(
      SCRAPER_CONFIG.poller_timeout_seconds * 1000
    );
    expect(SCRAPER_CONFIG.hydrator_timeout_minutes).toBeGreaterThan(0);
    expect(SCRAPER_CONFIG.compactor_timeout_seconds).toBeGreaterThan(0);
  });

  test('DB proxy region defaults to us-east-1 and follows CDK_DB_PROXY_REGION', async () => {
    const previous = process.env.CDK_DB_PROXY_REGION;
    try {
      delete process.env.CDK_DB_PROXY_REGION;
      jest.resetModules();
      expect((await import('../lib/config')).DB_PROXY_REGION).toBe('us-east-1');

      process.env.CDK_DB_PROXY_REGION = 'eu-central-1';
      jest.resetModules();
      expect((await import('../lib/config')).DB_PROXY_REGION).toBe('eu-central-1');
    } finally {
      if (previous === undefined) delete process.env.CDK_DB_PROXY_REGION;
      else process.env.CDK_DB_PROXY_REGION = previous;
      jest.resetModules();
    }
  });

  test('keeps the DuckDB memory and temp budgets inside Lambda limits', () => {
    const lambda = SILVER_CONFIG.lambda;
    expect(sizeMib(lambda.duckdb_memory_limit)).toBeLessThan(lambda.memory_mib);
    // ~3 GB of silver output plus DuckDB spill must fit in /tmp.
    expect(sizeMib(lambda.duckdb_max_temp_size) + 3000).toBeLessThan(lambda.ephemeral_mib);
    expect(lambda.publish_reserve_seconds).toBeLessThan(lambda.build_budget_seconds);
    expect(lambda.build_budget_seconds).toBeLessThan(lambda.timeout_seconds);
    expect(lambda.build_budget_seconds + lambda.publish_reserve_seconds).toBeLessThanOrEqual(lambda.timeout_seconds);
    expect(lambda.retry_attempts).toBe(1);
    expect(lambda.max_event_age_minutes).toBeGreaterThan(lambda.timeout_seconds / 60);
    expect(SILVER_CONFIG.keep).toBeGreaterThanOrEqual(2);
  });

  test('uses the shared names', () => {
    expect(ALERT_TOPIC_NAME).toBe('TrainPriceMonitorAlerts');
    expect(MONTHLY_BUDGET_NAME).toBe('TrainPriceMonitor-Monthly');
    expect(MONTHLY_BUDGET_USD).toBe(1);
    expect(METRIC_NAMESPACE).toBe('TrainPriceMonitor');
    expect(DASHBOARD_NAMES.scraper).toBe('TrainPriceMonitor-Scraper');
    expect(DASHBOARD_NAMES.app).toBe('TrainPriceMonitor-App');
  });

  test('keeps the storage and failure contract stable', () => {
    expect(`${SILVER_CONFIG.prefix}/`).toBe('silver/');
    expect(`${SILVER_CONFIG.bronze_prefix}/`).toBe('prices/');
    expect(BRONZE_PREFIX).toBe(SILVER_CONFIG.bronze_prefix);
    expect(`${SILVER_CONFIG.builds_root}/`).toBe('builds/');
    expect(SILVER_CONFIG.manifest_name).toBe('_manifest.json');
    expect(SILVER_CONFIG.pointer_name).toBe('_latest.json');
    expect(SILVER_FAILURE_EVENT).toBe('silver_build_failed');
    expect([...SILVER_FAILURE_STAGES]).toEqual(['settings', 'preflight', 'snapshot', 'build', 'report', 'publish']);
    expect(SILVER_QUALITY_EVENT).toBe('silver_quality_failed');
    expect(SILVER_CONFIG.quality).toMatchObject({
      report_version: 1,
      prefix: 'quality',
      pointer_name: '_latest.json',
      window_days: 7,
      baseline_days: 28,
      final_7d_coverage_min: 0.8,
      final_24h_coverage_min: 0.6,
      route_coverage_min: 0.9,
      rows_drop_pct_max: 0.35,
      freshness_hours_max: 36,
      fare_null_rate_max: 0.1,
      load_factor_null_rate_max: 0.35,
    });
    expect(SILVER_CONFIG.quality.event).not.toBe(SILVER_FAILURE_EVENT);
    expect(PUSHOVER_FORWARDER_SOURCE).toContain(SILVER_QUALITY_EVENT);
    expect(PUSHOVER_FORWARDER_SOURCE).toContain(SILVER_FAILURE_EVENT);
  });

  test('keeps the shared retention contract', () => {
    expect(RETENTION_CONFIG).toEqual({
      notification_retention_days: 90,
      journey_ttl_margin_days: 7,
      unconfirmed_signup_retention_days: 7,
    });
  });
});
