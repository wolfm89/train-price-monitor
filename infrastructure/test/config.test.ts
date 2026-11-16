import { PUSHOVER_FORWARDER_SOURCE } from '../lib/alerting';
import {
  ALERT_TOPIC_NAME,
  BRONZE_PREFIX,
  DASHBOARD_NAMES,
  METRIC_NAMESPACE,
  MONTHLY_BUDGET_NAME,
  MONTHLY_BUDGET_USD,
  RETENTION_CONFIG,
  SCHEDULES,
  SCRAPER_CONFIG,
  SILVER_CONFIG,
  SILVER_FAILURE_EVENT,
  SILVER_FAILURE_STAGES,
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
    // Worst-case target (two 20 s attempts plus backoff ~= 43 s) plus the final upload.
    expect(SCRAPER_CONFIG.abort_threshold_ms + 44_000).toBeLessThanOrEqual(
      SCRAPER_CONFIG.poller_timeout_seconds * 1000
    );
    expect(SCRAPER_CONFIG.hydrator_timeout_minutes).toBeGreaterThan(0);
    expect(SCRAPER_CONFIG.compactor_timeout_seconds).toBeGreaterThan(0);
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
    expect([...SILVER_FAILURE_STAGES]).toEqual(['settings', 'preflight', 'snapshot', 'build', 'publish']);
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
