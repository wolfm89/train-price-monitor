import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface DuckDbConfig {
  threads: number;
  memory_limit: string;
  max_temp_size: string;
}

export interface SilverConfig {
  prefix: string;
  bronze_prefix: string;
  builds_root: string;
  manifest_name: string;
  pointer_name: string;
  failure_event: string;
  stages: string[];
  orphan_grace_seconds: number;
  min_build_age_seconds: number;
  keep: number;
  lambda: {
    memory_mib: number;
    timeout_seconds: number;
    ephemeral_mib: number;
    threads: number;
    duckdb_memory_limit: string;
    duckdb_max_temp_size: string;
    publish_reserve_seconds: number;
    build_budget_seconds: number;
    retry_attempts: number;
    max_event_age_minutes: number;
  };
  local: DuckDbConfig;
  schedule: {
    retry_attempts: number;
    max_event_age_minutes: number;
  };
  quality: {
    report_version: number;
    prefix: string;
    pointer_name: string;
    event: string;
    expected_route_count: number;
    window_days: number;
    baseline_days: number;
    final_7d_coverage_min: number;
    final_24h_coverage_min: number;
    route_coverage_min: number;
    rows_drop_pct_max: number;
    freshness_hours_max: number;
    fare_null_rate_max: number;
    load_factor_null_rate_max: number;
  };
}

export interface ScraperConfig {
  batch_size: number;
  abort_threshold_ms: number;
  poller_timeout_seconds: number;
  poller_memory_mib: number;
  hydrator_memory_mib: number;
  hydrator_timeout_minutes: number;
  compactor_memory_mib: number;
  compactor_timeout_seconds: number;
  lookahead_days: number;
  seed_window_days: number;
}

export interface RetentionConfig {
  notification_retention_days: number;
  journey_ttl_margin_days: number;
  unconfirmed_signup_retention_days: number;
}

interface RuntimeConfig {
  bronze_prefix: string;
  scraper: ScraperConfig;
  retention: RetentionConfig;
}

type FieldType = 'string' | 'number' | 'string[]';
type Schema = { readonly [key: string]: FieldType | Schema };

const SILVER_SCHEMA: Schema = {
  prefix: 'string',
  bronze_prefix: 'string',
  builds_root: 'string',
  manifest_name: 'string',
  pointer_name: 'string',
  failure_event: 'string',
  stages: 'string[]',
  orphan_grace_seconds: 'number',
  min_build_age_seconds: 'number',
  keep: 'number',
  lambda: {
    memory_mib: 'number',
    timeout_seconds: 'number',
    ephemeral_mib: 'number',
    threads: 'number',
    duckdb_memory_limit: 'string',
    duckdb_max_temp_size: 'string',
    publish_reserve_seconds: 'number',
    build_budget_seconds: 'number',
    retry_attempts: 'number',
    max_event_age_minutes: 'number',
  },
  local: {
    threads: 'number',
    duckdb_memory_limit: 'string',
    duckdb_max_temp_size: 'string',
  },
  schedule: {
    retry_attempts: 'number',
    max_event_age_minutes: 'number',
  },
  quality: {
    report_version: 'number',
    prefix: 'string',
    pointer_name: 'string',
    event: 'string',
    expected_route_count: 'number',
    window_days: 'number',
    baseline_days: 'number',
    final_7d_coverage_min: 'number',
    final_24h_coverage_min: 'number',
    route_coverage_min: 'number',
    rows_drop_pct_max: 'number',
    freshness_hours_max: 'number',
    fare_null_rate_max: 'number',
    load_factor_null_rate_max: 'number',
  },
};

const RUNTIME_SCHEMA: Schema = {
  bronze_prefix: 'string',
  scraper: {
    batch_size: 'number',
    abort_threshold_ms: 'number',
    poller_timeout_seconds: 'number',
    poller_memory_mib: 'number',
    hydrator_memory_mib: 'number',
    hydrator_timeout_minutes: 'number',
    compactor_memory_mib: 'number',
    compactor_timeout_seconds: 'number',
    lookahead_days: 'number',
    seed_window_days: 'number',
  },
  retention: {
    notification_retention_days: 'number',
    journey_ttl_margin_days: 'number',
    unconfirmed_signup_retention_days: 'number',
  },
};

function validateShape(value: unknown, schema: Schema, path: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be a JSON object`);
  }
  const record = value as Record<string, unknown>;
  for (const [key, expected] of Object.entries(schema)) {
    const actual = record[key];
    const fieldPath = `${path}.${key}`;
    if (typeof expected === 'string') {
      if (expected === 'number') {
        if (typeof actual !== 'number' || !Number.isFinite(actual)) {
          throw new Error(`${fieldPath} must be a number`);
        }
      } else if (expected === 'string') {
        if (typeof actual !== 'string') {
          throw new Error(`${fieldPath} must be a string`);
        }
      } else if (!Array.isArray(actual) || !actual.every((item) => typeof item === 'string')) {
        throw new Error(`${fieldPath} must be an array of strings`);
      }
    } else {
      validateShape(actual, expected, fieldPath);
    }
  }
}

function loadJson<T>(path: string, schema: Schema): T {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  validateShape(parsed, schema, path);
  return parsed as T;
}

function assertIntegerInRange(value: number, min: number, max: number, path: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${path} must be an integer between ${min} and ${max}`);
  }
}

function validateSilverValues(config: SilverConfig): void {
  const { lambda, schedule } = config;
  assertIntegerInRange(config.keep, 2, Number.MAX_SAFE_INTEGER, 'silver-config.json.keep');
  assertIntegerInRange(lambda.memory_mib, 128, 10_240, 'silver-config.json.lambda.memory_mib');
  assertIntegerInRange(lambda.timeout_seconds, 1, 900, 'silver-config.json.lambda.timeout_seconds');
  assertIntegerInRange(lambda.ephemeral_mib, 512, 10_240, 'silver-config.json.lambda.ephemeral_mib');
  assertIntegerInRange(lambda.threads, 1, 10_240, 'silver-config.json.lambda.threads');
  assertIntegerInRange(lambda.retry_attempts, 0, 2, 'silver-config.json.lambda.retry_attempts');
  // Lambda EventInvokeConfig allows at most six hours.
  assertIntegerInRange(lambda.max_event_age_minutes, 1, 360, 'silver-config.json.lambda.max_event_age_minutes');
  assertIntegerInRange(schedule.retry_attempts, 0, 185, 'silver-config.json.schedule.retry_attempts');
  assertIntegerInRange(schedule.max_event_age_minutes, 1, 1_440, 'silver-config.json.schedule.max_event_age_minutes');
  const quality = config.quality;
  for (const [name, value] of [
    ['prefix', quality.prefix],
    ['pointer_name', quality.pointer_name],
    ['event', quality.event],
  ] as const) {
    if (!value) {
      throw new Error(`silver-config.json.quality.${name} must be a non-empty string`);
    }
  }
  if (quality.prefix.startsWith('/') || quality.prefix.endsWith('/')) {
    throw new Error('silver-config.json.quality.prefix must not start or end with /');
  }
  if (quality.event === config.failure_event) {
    throw new Error('silver-config.json.quality.event must differ from failure_event');
  }
  assertIntegerInRange(quality.report_version, 1, 100, 'silver-config.json.quality.report_version');
  assertIntegerInRange(quality.expected_route_count, 1, 10_000, 'silver-config.json.quality.expected_route_count');
  assertIntegerInRange(quality.window_days, 1, 365, 'silver-config.json.quality.window_days');
  if (
    !Number.isInteger(quality.baseline_days) ||
    quality.baseline_days < quality.window_days ||
    quality.baseline_days > 365
  ) {
    throw new Error(
      `silver-config.json.quality.baseline_days must be an integer between window_days (${quality.window_days}) and 365`
    );
  }
  assertIntegerInRange(quality.freshness_hours_max, 1, 1_440, 'silver-config.json.quality.freshness_hours_max');
  for (const [name, value] of [
    ['final_7d_coverage_min', quality.final_7d_coverage_min],
    ['final_24h_coverage_min', quality.final_24h_coverage_min],
    ['route_coverage_min', quality.route_coverage_min],
    ['rows_drop_pct_max', quality.rows_drop_pct_max],
    ['fare_null_rate_max', quality.fare_null_rate_max],
    ['load_factor_null_rate_max', quality.load_factor_null_rate_max],
  ] as const) {
    if (value < 0 || value > 1) {
      throw new Error(`silver-config.json.quality.${name} must be between 0 and 1`);
    }
  }
  if (!(
    lambda.publish_reserve_seconds < lambda.build_budget_seconds && lambda.build_budget_seconds < lambda.timeout_seconds
  )) {
    throw new Error('silver-config.json requires publish_reserve < build_budget < timeout');
  }
  if (lambda.build_budget_seconds + lambda.publish_reserve_seconds > lambda.timeout_seconds) {
    throw new Error('silver-config.json build_budget + publish_reserve must fit inside timeout');
  }
}

// The silver config lives in the Python package so the wheel and the Lambda image carry the
// same values. The runtime config is shared by the scraper bundle and the backend.
const SILVER_CONFIG_PATH = resolve(__dirname, '../../analytics/src/tpm_analytics/data/silver-config.json');
const RUNTIME_CONFIG_PATH = resolve(__dirname, '../../shared/runtime-config.json');

export const SILVER_CONFIG = loadJson<SilverConfig>(SILVER_CONFIG_PATH, SILVER_SCHEMA);
validateSilverValues(SILVER_CONFIG);
const RUNTIME_CONFIG = loadJson<RuntimeConfig>(RUNTIME_CONFIG_PATH, RUNTIME_SCHEMA);
export const BRONZE_PREFIX = RUNTIME_CONFIG.bronze_prefix;
export const SCRAPER_CONFIG = RUNTIME_CONFIG.scraper;
export const RETENTION_CONFIG = RUNTIME_CONFIG.retention;

/** Shared names and schedules for the CDK stacks.
 *
 * Values that are also asserted by tests or referenced from docs live here once.
 */
export const APP_NAME = 'TrainPriceMonitor';
export const APP_DISPLAY_NAME = 'Train Price Monitor';
export const METRIC_NAMESPACE = APP_NAME;

/**
 * DB egress proxies: one small Lambda per region. The transport tries them in
 * order and fails over on a refusal or a 429, so a block in one region does not
 * stop the app. Override the list with `CDK_DB_PROXY_REGIONS` (comma-separated).
 */
const configuredProxyRegions = [
  ...new Set(
    (process.env.CDK_DB_PROXY_REGIONS?.trim() || '')
      .split(',')
      .map((region) => region.trim())
      .filter(Boolean)
  ),
];
for (const region of configuredProxyRegions) {
  if (!/^[a-z]{2,}(-[a-z]+)+-\d+$/.test(region)) {
    throw new Error(`Invalid CDK_DB_PROXY_REGIONS entry: ${region}`);
  }
}
export const DB_PROXY_REGIONS =
  configuredProxyRegions.length > 0 ? configuredProxyRegions : ['us-east-1', 'eu-central-1'];

/** The pre-existing stack kept the unsuffixed id in `CDK_DB_PROXY_REGION` (default us-east-1). */
export const DB_PROXY_LEGACY_REGION = process.env.CDK_DB_PROXY_REGION?.trim() || 'us-east-1';

/** Stack id for a proxy region: the legacy region keeps `DbProxyStack`, others are suffixed. */
export function dbProxyStackId(region: string): string {
  return region === DB_PROXY_LEGACY_REGION ? 'DbProxyStack' : `DbProxyStack-${region}`;
}
export const DB_PROXY_FUNCTION_NAME = `${APP_NAME}-DbProxy`;

/**
 * TLS fingerprints the transport tries, in order. DB accepts different orders
 * over time: `chrome` and `legacy` answered 200 on 2026-11-27 while `tls12`
 * (the previous fixed choice) was refused with `452 OPS_BLOCKED`.
 */
export const DB_TLS_PROFILES = process.env.CDK_DB_TLS_PROFILES?.trim() || 'chrome,legacy,firefox,safari,tls13,tls12';

/** Poller DB pacing; shared by the stack and the safety-margin test. */
export const POLLER_DB_GAP_MS = 3_500;
export const POLLER_DB_TOTAL_BUDGET_MS = 45_000;

export const ALERT_TOPIC_NAME = `${APP_NAME}Alerts`;
export const MONTHLY_BUDGET_NAME = `${APP_NAME}-Monthly`;
export const MONTHLY_BUDGET_USD = 1;
export const MONTHLY_BUDGET_ACTUAL_THRESHOLD = 50;
export const MONTHLY_BUDGET_FORECAST_THRESHOLD = 100;

export const ANALYTICS_SCHEDULE_NAME = 'tpm-silver-weekly';
export const SILVER_FAILURE_EVENT = SILVER_CONFIG.failure_event;
export const SILVER_FAILURE_STAGES = SILVER_CONFIG.stages;
export const SILVER_QUALITY_EVENT = SILVER_CONFIG.quality.event;

export const DASHBOARD_NAMES = {
  scraper: `${APP_NAME}-Scraper`,
  app: `${APP_NAME}-App`,
} as const;

export const SCHEDULES = {
  pollerMinutes: 15,
  hydrator: { hour: 2, minute: 0 },
  compactor: { hour: 3, minute: 0 },
  analytics: { hour: 3, minute: 30 },
} as const;
