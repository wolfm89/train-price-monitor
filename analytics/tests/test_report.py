"""Weekly quality report metrics, thresholds and S3 layout."""

import json
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from tests.conftest import HAMBURG, MUNICH, bronze_row, write_bronze
from tpm_analytics.silver._duck import connect
from tpm_analytics.silver.build import run_build
from tpm_analytics.silver.config import QualityConfig, load_config
from tpm_analytics.silver.report import QualityReport, build_report, pointer_key, report_key, write_report
from tpm_analytics.silver.storage import LocalObjectStore


def _connection(tmp_path: Path):
    return connect(
        temp_directory=tmp_path / "duckdb-report",
        threads=1,
        memory_limit="256MB",
        max_temp_size="1GB",
    )


def test_report_metrics_and_ok_status(build, tmp_path: Path) -> None:
    built = build()
    quality = replace(
        load_config().quality,
        expected_route_count=3,
        final_7d_coverage_min=0,
        final_24h_coverage_min=0,
        route_coverage_min=0,
        rows_drop_pct_max=1,
        freshness_hours_max=10_000,
        fare_null_rate_max=1,
        load_factor_null_rate_max=1,
    )
    connection = _connection(tmp_path)
    try:
        report = build_report(
            connection,
            f"{built.target}/**/*.parquet",
            build_id="20261120T000000Z-aaaaaaaa",
            as_of=datetime(2026, 11, 20, tzinfo=UTC),
            quality=quality,
            build={"manifest": "silver/builds/x/_manifest.json", "rows_out": built.stats.rows_out, "partitions": 2},
        )
    finally:
        connection.close()

    assert report.status == "ok"
    assert report.metrics["rows"]["last_7d"] > 0
    assert report.metrics["rows"]["prior_7d"] == 0
    assert report.metrics["routes"]["active_last_7d"] >= 1
    assert report.metrics["route_days"]["observed"] >= 1
    assert report.metrics["nulls"]["fare"]["rate"] is not None
    assert report.metrics["freshness"]["hours"] is not None
    assert report.metrics["freshness"]["latest_observed_at"].endswith("+00:00")
    assert (report.window_days, report.baseline_days) == (7, 28)
    assert json.loads(report.to_json())["window"] == {"days": 7, "baseline_days": 28}


def test_report_flags_missing_route_and_final_coverage(build, tmp_path: Path) -> None:
    built = build()
    connection = _connection(tmp_path)
    try:
        report = build_report(
            connection,
            f"{built.target}/**/*.parquet",
            build_id="20261120T000000Z-bbbbbbbb",
            as_of=datetime(2026, 11, 20, tzinfo=UTC),
            quality=load_config().quality,
            build={"manifest": "silver/builds/x/_manifest.json", "rows_out": built.stats.rows_out, "partitions": 2},
        )
    finally:
        connection.close()

    assert report.status == "warning"
    assert {violation.metric for violation in report.violations} >= {
        "route_coverage",
        "final_7d_coverage",
        "final_24h_coverage",
    }


def test_write_report_uses_versioned_key_and_pointer(build, tmp_path: Path) -> None:
    built = build()
    store = LocalObjectStore(tmp_path / "bucket")
    quality = load_config().quality
    connection = _connection(tmp_path)
    try:
        report = build_report(
            connection,
            f"{built.target}/**/*.parquet",
            build_id="20261120T000000Z-cccccccc",
            as_of=datetime(2026, 11, 20, tzinfo=UTC),
            quality=quality,
            build={"manifest": "silver/builds/x/_manifest.json", "rows_out": built.stats.rows_out, "partitions": 2},
        )
    finally:
        connection.close()

    key = write_report(store, prefix="silver", quality=quality, report=report)
    assert key == report_key("silver", quality, report.build_id)
    assert store.size(key) > 0
    pointer = store.get_bytes(pointer_key("silver", quality)).decode()
    assert report.build_id in pointer
    assert key in pointer


def test_report_handles_no_recent_data_without_dividing_by_zero(build, tmp_path: Path) -> None:
    built = build()
    connection = _connection(tmp_path)
    try:
        report = build_report(
            connection,
            f"{built.target}/**/*.parquet",
            build_id="20270101T000000Z-dddddddd",
            as_of=datetime(2027, 1, 1, tzinfo=UTC),
            quality=load_config().quality,
            build={"manifest": "silver/builds/x/_manifest.json", "rows_out": built.stats.rows_out, "partitions": 2},
        )
    finally:
        connection.close()

    assert report.status == "warning"
    assert {violation.metric for violation in report.violations} >= {
        "rows_last_7d",
        "route_days_observed",
    }


def _custom_build(tmp_path: Path, rows: list[dict[str, object]]) -> Path:
    root = tmp_path / f"prices-{uuid4().hex[:8]}"
    write_bronze(root / "year=2026" / "month=11" / "day=01", rows, schema_version=2)
    target = tmp_path / f"silver-{uuid4().hex[:8]}"
    run_build(str(root / "**" / "*.parquet"), target)
    return target


def _report_for(target: Path, tmp_path: Path, *, as_of: datetime, quality: QualityConfig) -> QualityReport:
    connection = _connection(tmp_path)
    try:
        return build_report(
            connection,
            f"{target}/**/*.parquet",
            build_id="20261120T000000Z-aaaaaaaa",
            as_of=as_of,
            quality=quality,
            build={"manifest": "silver/builds/x/_manifest.json", "rows_out": 1, "partitions": 1},
        )
    finally:
        connection.close()


def test_route_day_last_observation_after_first_departure_is_not_covered(tmp_path: Path) -> None:
    target = _custom_build(
        tmp_path,
        [
            bronze_row(
                observed_at=datetime(2026, 11, 8, 10, 0),
                departure_planned=datetime(2026, 11, 18, 6, 0),
                arrival_planned=datetime(2026, 11, 18, 10, 0),
                train_number="1001",
                journey_id="journey-first",
            ),
            bronze_row(
                observed_at=datetime(2026, 11, 18, 19, 0),
                departure_planned=datetime(2026, 11, 18, 20, 0),
                arrival_planned=datetime(2026, 11, 19, 0, 0),
                train_number="1002",
                journey_id="journey-later",
            ),
        ],
    )
    report = _report_for(
        target,
        tmp_path,
        as_of=datetime(2026, 11, 20, tzinfo=UTC),
        quality=replace(load_config().quality, expected_route_count=1),
    )

    assert report.metrics["route_days"]["observed"] == 1
    assert report.metrics["route_days"]["final_7d_covered"] == 0
    assert report.metrics["route_days"]["final_24h_covered"] == 0


def test_route_day_inside_seven_days_but_outside_24_hours(tmp_path: Path) -> None:
    target = _custom_build(
        tmp_path,
        [
            bronze_row(
                observed_at=datetime(2026, 11, 15, 6, 0),
                departure_planned=datetime(2026, 11, 18, 6, 0),
                arrival_planned=datetime(2026, 11, 18, 10, 0),
            )
        ],
    )
    report = _report_for(
        target,
        tmp_path,
        as_of=datetime(2026, 11, 20, tzinfo=UTC),
        quality=replace(load_config().quality, expected_route_count=1),
    )

    route_days = report.metrics["route_days"]
    assert route_days["expected"] == 7
    assert route_days["observed"] == 1
    assert route_days["final_7d_covered"] == 1
    assert route_days["final_7d_coverage"] == 1 / 7
    assert route_days["final_24h_covered"] == 0
    assert route_days["final_24h_coverage"] == 0


def test_rows_drop_is_measured_against_the_preceding_week(tmp_path: Path) -> None:
    rows = [
        bronze_row(
            observed_at=datetime(2026, 11, hour, minute),
            departure_planned=datetime(2026, 12, 10, 8, 0),
            arrival_planned=datetime(2026, 12, 10, 12, 0),
            train_number=f"100{hour}{minute}",
        )
        for hour, minute in [(18, 8), (18, 9), (10, 8), (10, 9), (10, 10), (10, 11)]
    ]
    target = _custom_build(tmp_path, rows)
    report = _report_for(
        target,
        tmp_path,
        as_of=datetime(2026, 11, 20, tzinfo=UTC),
        quality=replace(load_config().quality, expected_route_count=1),
    )

    assert report.metrics["rows"]["last_7d"] == 2
    assert report.metrics["rows"]["prior_7d"] == 4
    assert report.metrics["rows"]["change_pct"] == -0.5
    assert "rows_change" in {violation.metric for violation in report.violations}


def test_freshness_and_load_factor_null_rate_are_flagged(tmp_path: Path) -> None:
    target = _custom_build(
        tmp_path,
        [
            bronze_row(
                observed_at=datetime(2026, 11, 18, 0, 0),
                departure_planned=datetime(2026, 11, 25, 8, 0),
                arrival_planned=datetime(2026, 11, 25, 12, 0),
                load_factor=None,
                load_factor_ordinal=None,
            )
        ],
    )
    report = _report_for(
        target,
        tmp_path,
        as_of=datetime(2026, 11, 20, tzinfo=UTC),
        quality=replace(load_config().quality, expected_route_count=1),
    )

    assert report.metrics["freshness"]["hours"] == 48.0
    assert report.metrics["nulls"]["load_factor"]["rate"] == 1.0
    metrics = {violation.metric for violation in report.violations}
    assert {"freshness_hours", "load_factor_null_rate"} <= metrics


def test_active_routes_above_the_catalogue_are_clamped_and_flagged(tmp_path: Path) -> None:
    target = _custom_build(
        tmp_path,
        [
            bronze_row(
                observed_at=datetime(2026, 11, 18, 8, 0),
                departure_planned=datetime(2026, 11, 25, 8, 0),
                arrival_planned=datetime(2026, 11, 25, 12, 0),
            ),
            bronze_row(
                observed_at=datetime(2026, 11, 18, 9, 0),
                route_id=f"{HAMBURG[0]}-{MUNICH[0]}",
                origin_eva=HAMBURG[0],
                origin_name=HAMBURG[1],
                departure_planned=datetime(2026, 11, 25, 9, 0),
                arrival_planned=datetime(2026, 11, 25, 13, 0),
                train_number="2002",
                journey_id="journey-hamburg",
            ),
        ],
    )
    report = _report_for(
        target,
        tmp_path,
        as_of=datetime(2026, 11, 20, tzinfo=UTC),
        quality=replace(load_config().quality, expected_route_count=1, route_coverage_min=0.0),
    )

    assert report.metrics["routes"]["active_last_7d"] == 2
    assert report.metrics["routes"]["coverage"] == 1.0
    assert "route_count_mismatch" in {violation.metric for violation in report.violations}
