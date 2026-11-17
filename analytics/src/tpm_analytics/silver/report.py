"""Weekly data-quality metrics for a published silver build.

The report is intentionally separate from the blocking quality gate: the gate protects the data
contract, while this report measures whether the week is representative enough for training. A
warning is published to the existing alert topic; it does not roll back a verified build.
"""

import json
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from tpm_analytics.silver._duck import read_parquet
from tpm_analytics.silver.config import QualityConfig
from tpm_analytics.silver.storage import ObjectStore

LOGGER = logging.getLogger(__name__)
REPORT_CONTENT_TYPE = "application/json"


@dataclass(frozen=True)
class Violation:
    metric: str
    value: float
    threshold: float
    message: str

    def to_dict(self) -> dict[str, object]:
        return {
            "metric": self.metric,
            "value": self.value,
            "threshold": self.threshold,
            "message": self.message,
        }


@dataclass(frozen=True)
class QualityReport:
    report_version: int
    build_id: str
    generated_at: str
    status: str
    window_days: int
    baseline_days: int
    metrics: dict[str, Any]
    thresholds: dict[str, float | int]
    violations: tuple[Violation, ...]
    build: dict[str, Any]

    def to_json(self) -> bytes:
        payload = {
            "report_version": self.report_version,
            "build_id": self.build_id,
            "generated_at": self.generated_at,
            "status": self.status,
            "window": {"days": self.window_days, "baseline_days": self.baseline_days},
            "metrics": self.metrics,
            "thresholds": self.thresholds,
            "violations": [violation.to_dict() for violation in self.violations],
            "build": self.build,
        }
        return (json.dumps(payload, indent=2, sort_keys=True, allow_nan=False) + "\n").encode("utf-8")


def quality_prefix(prefix: str, quality: QualityConfig) -> str:
    return f"{prefix.strip('/')}/{quality.prefix.strip('/')}"


def report_key(prefix: str, quality: QualityConfig, build_id: str) -> str:
    return f"{quality_prefix(prefix, quality)}/{build_id}.json"


def pointer_key(prefix: str, quality: QualityConfig) -> str:
    return f"{quality_prefix(prefix, quality)}/{quality.pointer_name}"


def _utc(moment: datetime) -> datetime:
    return moment.replace(tzinfo=UTC) if moment.tzinfo is None else moment.astimezone(UTC)


def _timestamp(moment: datetime) -> str:
    return _utc(moment).strftime("%Y-%m-%d %H:%M:%S")


def _rate(numerator: int, denominator: int) -> float | None:
    return None if denominator == 0 else numerator / denominator


def _violation(metric: str, value: float, threshold: float, message: str) -> Violation:
    return Violation(metric=metric, value=value, threshold=threshold, message=message)


def build_report(
    connection: Any,
    silver_glob: str,
    *,
    build_id: str,
    as_of: datetime,
    quality: QualityConfig,
    build: dict[str, Any],
) -> QualityReport:
    """Compute the weekly quality profile from a local silver tree."""
    silver = read_parquet(silver_glob)
    as_of_utc = _utc(as_of)
    as_of_sql = _timestamp(as_of_utc)
    # departure_date is a Berlin-local date (silver.sql), while observed_at is UTC. Derive the
    # cutoff the same way the transform does so a late run does not shift the window by a day.
    as_of_date = connection.execute(
        f"SELECT CAST(timezone('Europe/Berlin', TIMESTAMP '{as_of_sql}' AT TIME ZONE 'UTC') AS DATE)"
    ).fetchone()[0]
    window = quality.window_days
    baseline = quality.baseline_days
    window_start = f"TIMESTAMP '{as_of_sql}' - INTERVAL '{window} days'"

    by_day = [
        {"date": str(day), "rows": int(rows)}
        for day, rows in connection.execute(
            f"""
            SELECT CAST(observed_at AS DATE) AS day, count(*)::BIGINT AS rows
            FROM {silver}
            WHERE observed_at >= TIMESTAMP '{as_of_sql}' - INTERVAL '{baseline} days'
              AND observed_at <= TIMESTAMP '{as_of_sql}'
            GROUP BY 1
            ORDER BY 1
            """
        ).fetchall()
    ]

    last_7d, prior_7d = connection.execute(
        f"""
        SELECT
            count(*) FILTER (WHERE observed_at >= {window_start})::BIGINT,
            count(*) FILTER (
                WHERE observed_at >= TIMESTAMP '{as_of_sql}' - INTERVAL '{window * 2} days'
                  AND observed_at < {window_start}
            )::BIGINT
        FROM {silver}
        WHERE observed_at <= TIMESTAMP '{as_of_sql}'
        """
    ).fetchone()
    change_pct = None if prior_7d == 0 else (last_7d - prior_7d) / prior_7d

    active_routes = connection.execute(
        f"""
        SELECT count(DISTINCT route_id) FILTER (WHERE observed_at >= {window_start})::BIGINT
        FROM {silver}
        WHERE observed_at <= TIMESTAMP '{as_of_sql}'
        """
    ).fetchone()[0]
    route_coverage = min(1.0, active_routes / quality.expected_route_count)

    observed_route_days, final_7d_covered, final_24h_covered = connection.execute(
        f"""
        WITH windowed AS (
            SELECT
                route_id,
                departure_date,
                observed_at,
                min(departure_planned) OVER (PARTITION BY route_id, departure_date) AS first_departure
            FROM {silver}
            WHERE departure_date >= DATE '{as_of_date}' - INTERVAL '{window} days'
              AND departure_date < DATE '{as_of_date}'
        ),
        route_days AS (
            SELECT
                route_id,
                departure_date,
                first_departure,
                max(observed_at) FILTER (WHERE observed_at <= first_departure) AS last_before_departure
            FROM windowed
            GROUP BY 1, 2, 3
        )
        SELECT
            count(*)::BIGINT,
            count(*) FILTER (
                WHERE last_before_departure >= first_departure - INTERVAL '{window} days'
            )::BIGINT,
            count(*) FILTER (
                WHERE last_before_departure >= first_departure - INTERVAL '24 hours'
            )::BIGINT
        FROM route_days
        """
    ).fetchone()
    expected_route_days = quality.expected_route_count * window
    final_7d_coverage = min(1.0, final_7d_covered / expected_route_days)
    final_24h_coverage = min(1.0, final_24h_covered / expected_route_days)

    recent_rows, fare_nulls, load_nulls, v2_rows, v2_fare_nulls = connection.execute(
        f"""
        SELECT
            count(*)::BIGINT,
            count(*) FILTER (WHERE fare_lowest_eur IS NULL)::BIGINT,
            count(*) FILTER (WHERE load_factor IS NULL)::BIGINT,
            count(*) FILTER (WHERE schema_version = 2)::BIGINT,
            count(*) FILTER (WHERE schema_version = 2 AND fare_lowest_eur IS NULL)::BIGINT
        FROM {silver}
        WHERE observed_at >= {window_start}
          AND observed_at <= TIMESTAMP '{as_of_sql}'
        """
    ).fetchone()
    fare_null_rate = _rate(fare_nulls, recent_rows)
    v2_fare_null_rate = _rate(v2_fare_nulls, v2_rows)
    load_factor_null_rate = _rate(load_nulls, recent_rows)

    latest_observed_at = connection.execute(
        f"SELECT max(observed_at) FROM {silver} WHERE observed_at <= TIMESTAMP '{as_of_sql}'"
    ).fetchone()[0]
    freshness_hours = None
    if latest_observed_at is not None:
        freshness_hours = max(0.0, (as_of_utc - _utc(latest_observed_at)).total_seconds() / 3600)

    metrics: dict[str, Any] = {
        "rows": {
            "by_observed_day": by_day,
            "last_7d": int(last_7d),
            "prior_7d": int(prior_7d),
            "change_pct": change_pct,
        },
        "routes": {
            "expected": quality.expected_route_count,
            "active_last_7d": int(active_routes),
            "coverage": route_coverage,
        },
        "route_days": {
            "expected": expected_route_days,
            "observed": int(observed_route_days),
            "final_7d_covered": int(final_7d_covered),
            "final_7d_coverage": final_7d_coverage,
            "final_24h_covered": int(final_24h_covered),
            "final_24h_coverage": final_24h_coverage,
        },
        "nulls": {
            "fare": {
                "rate": fare_null_rate,
                "v2_rate": v2_fare_null_rate,
            },
            "load_factor": {
                "rate": load_factor_null_rate,
            },
        },
        "freshness": {
            "latest_observed_at": None if latest_observed_at is None else _utc(latest_observed_at).isoformat(),
            "hours": freshness_hours,
        },
    }

    thresholds: dict[str, float | int] = {
        "expected_route_count": quality.expected_route_count,
        "final_7d_coverage_min": quality.final_7d_coverage_min,
        "final_24h_coverage_min": quality.final_24h_coverage_min,
        "route_coverage_min": quality.route_coverage_min,
        "rows_drop_pct_max": quality.rows_drop_pct_max,
        "freshness_hours_max": quality.freshness_hours_max,
        "fare_null_rate_max": quality.fare_null_rate_max,
        "load_factor_null_rate_max": quality.load_factor_null_rate_max,
    }

    violations: list[Violation] = []
    if last_7d == 0:
        violations.append(_violation("rows_last_7d", 0, 1, "no observations in the last 7 days"))
    if observed_route_days == 0:
        violations.append(_violation("route_days_observed", 0, 1, "no completed route-days in the window"))
    if final_7d_coverage < quality.final_7d_coverage_min:
        violations.append(
            _violation(
                "final_7d_coverage",
                final_7d_coverage,
                quality.final_7d_coverage_min,
                f"final-7-day coverage {final_7d_coverage:.1%} below {quality.final_7d_coverage_min:.1%}",
            )
        )
    if final_24h_coverage < quality.final_24h_coverage_min:
        violations.append(
            _violation(
                "final_24h_coverage",
                final_24h_coverage,
                quality.final_24h_coverage_min,
                f"final-24-hour coverage {final_24h_coverage:.1%} below {quality.final_24h_coverage_min:.1%}",
            )
        )
    if route_coverage < quality.route_coverage_min:
        violations.append(
            _violation(
                "route_coverage",
                route_coverage,
                quality.route_coverage_min,
                f"route coverage {route_coverage:.1%} below {quality.route_coverage_min:.1%}",
            )
        )
    if active_routes > quality.expected_route_count:
        violations.append(
            _violation(
                "route_count_mismatch",
                active_routes,
                quality.expected_route_count,
                f"{active_routes} active routes exceed the configured catalogue of "
                f"{quality.expected_route_count}; update quality.expected_route_count",
            )
        )
    if change_pct is not None and change_pct < -quality.rows_drop_pct_max:
        violations.append(
            _violation(
                "rows_change",
                change_pct,
                -quality.rows_drop_pct_max,
                f"rows dropped {abs(change_pct):.1%} week over week",
            )
        )
    if freshness_hours is not None and freshness_hours > quality.freshness_hours_max:
        violations.append(
            _violation(
                "freshness_hours",
                freshness_hours,
                quality.freshness_hours_max,
                f"latest observation is {freshness_hours:.1f} hours old",
            )
        )
    if fare_null_rate is not None and fare_null_rate > quality.fare_null_rate_max:
        violations.append(
            _violation(
                "fare_null_rate",
                fare_null_rate,
                quality.fare_null_rate_max,
                f"fare null rate {fare_null_rate:.1%} above {quality.fare_null_rate_max:.1%}",
            )
        )
    if load_factor_null_rate is not None and load_factor_null_rate > quality.load_factor_null_rate_max:
        violations.append(
            _violation(
                "load_factor_null_rate",
                load_factor_null_rate,
                quality.load_factor_null_rate_max,
                f"load-factor null rate {load_factor_null_rate:.1%} above {quality.load_factor_null_rate_max:.1%}",
            )
        )

    return QualityReport(
        report_version=quality.report_version,
        build_id=build_id,
        generated_at=as_of_utc.isoformat(),
        status="warning" if violations else "ok",
        window_days=window,
        baseline_days=baseline,
        metrics=metrics,
        thresholds=thresholds,
        violations=tuple(violations),
        build=build,
    )


def write_report(
    store: ObjectStore,
    *,
    prefix: str,
    quality: QualityConfig,
    report: QualityReport,
) -> str:
    """Write the immutable report and the latest pointer; return the report key."""
    key = report_key(prefix, quality, report.build_id)
    store.put_bytes(report.to_json(), key, content_type=REPORT_CONTENT_TYPE)
    LOGGER.info("silver quality report object written build_id=%s report=%s", report.build_id, key)
    pointer = {
        "build_id": report.build_id,
        "report": key,
        "generated_at": report.generated_at,
    }
    store.put_bytes(
        (json.dumps(pointer, indent=2, sort_keys=True) + "\n").encode("utf-8"),
        pointer_key(prefix, quality),
        content_type=REPORT_CONTENT_TYPE,
    )
    LOGGER.info("silver quality report written build_id=%s report=%s", report.build_id, key)
    return key
