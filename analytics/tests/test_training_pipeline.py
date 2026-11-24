"""End-to-end tests for the training dataset and the one-command CLI."""

from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, cast

import duckdb
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from tpm_analytics.training import backtest as backtest_module
from tpm_analytics.training import model as tpm_training_model
from tpm_analytics.training.backtest import (
    Recipe,
    _bss_paired_ci,
    _check_fold_gates,
    _decision_value_cells,
    _grouped_importance,
    _permuted_features,
    _pooled_cell_metrics,
    _pr_curves,
    _threshold_cells,
    _threshold_hold_rate,
    fit_fold,
    fit_forward_scorer,
    load_forward,
    load_panel,
    run_backtest,
    score_forward,
    score_forward_artifact,
    select_recipe,
    write_backtest_artifacts,
)
from tpm_analytics.training.bands import CLIMATOLOGY_BANDS, HEADLINE_BANDS, ttd_band
from tpm_analytics.training.chains import build_chain_map
from tpm_analytics.training.cli import (
    _dataset_cache_key,
    _mark_dataset_cache,
    _restore_dataset,
    _store_dataset,
    main,
)
from tpm_analytics.training.config import DEFAULT_CONFIG_PATH, ConfigError, FoldConfig, ProtocolConfig, load_config
from tpm_analytics.training.dataset import (
    DatasetError,
    DatasetStats,
    SplitStats,
    _final_columns,
    _git_state,
    _source_inventory,
    build_dataset,
)
from tpm_analytics.training.features import (
    LABEL_COLUMNS,
    analog_features,
    column_roles,
    family_members,
    feature_family,
    feature_spec,
)
from tpm_analytics.training.identity import berlin_week_sql, series_key_sql
from tpm_analytics.training.labels import breach, breach_sql, cents
from tpm_analytics.training.model import (
    Evaluation,
    FittedModel,
    LogisticPrep,
    ModelError,
    TabularData,
    _band_labels,
    _bootstrap,
    _bootstrap_metrics,
    _bootstrap_paired,
    _bss_train,
    _calibration_curve,
    _calibration_stats,
    _cell_threshold,
    _cluster_mean_ci,
    _compact_datetime,
    _cross_fitted_with_folds,
    _decision_row,
    _decision_value_rows,
    _early_stopping_plan,
    _encode_text,
    _fit_final_calibration,
    _holdout_mask,
    _matrix,
    _pooled_decision_value_rows,
    _strata_rows,
    _train_prevalence,
    _ttd_array,
    _wilson_lower,
    fit_calibrator,
    fit_candidate,
    fit_climatology,
    fit_encoder,
    load_model,
    load_split,
    train_and_evaluate,
)
from tpm_analytics.training.protocol import assert_purged, fold_masks, fold_slices, scored_folds
from tpm_analytics.training.report import _warnings
from tpm_analytics.training.selection import (
    development_folds,
    paired_bootstrap,
    replacement_rule,
    select_outcome,
    table_sha256,
)
from tpm_analytics.training.sources import SourceSpec
from tpm_analytics.training.study import (
    _present,
    _stress_targets,
    _study_report,
    coverage_profile,
    forward_analog_availability,
    mask_family,
    study_arms,
)

SPLITS = {
    "train_end": "2026-07-10",
    "validation_select_start": "2026-07-11",
    "validation_select_end": "2026-07-20",
    "validation_calibrate_start": "2026-07-21",
    "validation_calibrate_end": "2026-07-25",
    "test_start": "2026-07-26",
    "test_end": "2026-08-10",
}


def _row(
    *,
    observed_at: datetime,
    departure: datetime,
    route: str,
    train: str | None,
    fare: float,
    **overrides: object,
) -> dict[str, object]:
    row: dict[str, object] = {
        "observed_at": observed_at,
        "service_class": 2,
        "route_id": route,
        "train_number": train,
        "departure_planned": departure,
        "arrival_planned": departure + timedelta(hours=4),
        "departure_date": departure.date(),
        "departure_weekday": departure.weekday(),
        "departure_hour_local": 10,
        "duration_minutes": 240,
        "transfers_actual": 0,
        "load_factor_ordinal": 2,
        "fare_lowest_eur": fare,
        "distance_km": 500.0,
        "origin_state": "Berlin",
        "dest_state": "Bayern",
        "origin_station_category": 1,
        "dest_station_category": 1,
        "train_type": "ICE",
        "observation_era": "dense",
        "scrapes_per_route_day_final": 8,
        "schema_version": 1,
        "journey_id": None,
    }
    row.update(overrides)
    return row


def _write_silver(path: Path, rows: list[dict[str, object]]) -> None:
    schema = pa.schema(
        [
            ("observed_at", pa.timestamp("ms")),
            ("service_class", pa.int32()),
            ("route_id", pa.string()),
            ("train_number", pa.string()),
            ("departure_planned", pa.timestamp("ms")),
            ("arrival_planned", pa.timestamp("ms")),
            ("departure_date", pa.date32()),
            ("departure_weekday", pa.int32()),
            ("departure_hour_local", pa.int32()),
            ("duration_minutes", pa.int32()),
            ("transfers_actual", pa.int32()),
            ("load_factor_ordinal", pa.int32()),
            ("fare_lowest_eur", pa.float64()),
            ("distance_km", pa.float64()),
            ("origin_state", pa.string()),
            ("dest_state", pa.string()),
            ("origin_station_category", pa.int32()),
            ("dest_station_category", pa.int32()),
            ("train_type", pa.string()),
            ("observation_era", pa.string()),
            ("scrapes_per_route_day_final", pa.int32()),
            ("schema_version", pa.int32()),
            ("journey_id", pa.string()),
        ]
    )
    pq.write_table(pa.Table.from_pylist(rows, schema=schema), path)


def _rows() -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    routes = [("8011160-8000261", "Berlin"), ("8002549-8000261", "Bayern")]
    for offset in range(0, 41):
        departure = datetime(2026, 7, 1, 10, 0) + timedelta(days=offset)
        for route_index, (route, state) in enumerate(routes):
            for series in range(12):
                fare = 80.0 + route_index * 10 + series * 2
                for days_before in range(2, 21):
                    observed = departure - timedelta(days=days_before, hours=2)
                    fare = max(20.0, fare + (10.0 if (days_before + series) % 7 == 0 else (series % 3) - 1))
                    rows.append(
                        _row(
                            observed_at=observed,
                            departure=departure,
                            route=route,
                            train=f"ICE{1000 + series}",
                            fare=fare,
                            origin_state=state,
                            load_factor_ordinal=None if series == 0 else 2,
                            transfers_actual=None if series == 1 else 0,
                        )
                    )
    return rows


def _config(tmp_path: Path) -> Path:
    raw = json.loads(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))
    raw["splits"] = SPLITS
    raw["sample"]["sample_rate"] = 1.0
    raw["calendar"]["feature_set"] = "full"
    raw["calibration"]["methods"] = ["sigmoid", "isotonic", "temperature"]
    raw["protocol"] = {"kind": "static_split"}
    raw["report"]["min_headroom_positives"] = 0
    raw["report"]["min_eligible_rows"] = 0
    raw["report"]["min_split_positives"] = 0
    raw["report"]["min_band_positives"] = 0
    path = tmp_path / "training.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    return path


def _build(tmp_path: Path) -> tuple[DatasetStats, Path]:
    source = tmp_path / "silver.parquet"
    rows = _rows()
    _write_silver(source, rows)
    config = load_config(_config(tmp_path))
    connection = duckdb.connect()
    try:
        stats = build_dataset(
            connection,
            SourceSpec(glob=str(source), label="test", build_id="test", manifest_sha256=None),
            config,
            tmp_path / "run",
            run_id="test",
        )
    finally:
        connection.close()
    return stats, tmp_path / "run"


def test_uniform_multi_file_glob_builds(tmp_path: Path) -> None:
    rows = _rows()
    first = tmp_path / "a.parquet"
    second = tmp_path / "b.parquet"
    midpoint = len(rows) // 2
    _write_silver(first, rows[:midpoint])
    _write_silver(second, rows[midpoint:])
    table = pq.read_table(second)
    pq.write_table(table.select(list(reversed(table.column_names))), second)
    config = load_config(_config(tmp_path))
    connection = duckdb.connect()
    try:
        stats = build_dataset(
            connection,
            SourceSpec(glob=str(tmp_path / "*.parquet"), label="uniform", build_id="uniform", manifest_sha256=None),
            config,
            tmp_path / "uniform-run",
            run_id="uniform",
        )
    finally:
        connection.close()
    assert stats.rows > 0


def test_mixed_schema_glob_raises_dataset_error(tmp_path: Path) -> None:
    first = tmp_path / "a.parquet"
    second = tmp_path / "b.parquet"
    pq.write_table(pa.table({"a": [1]}), first)
    pq.write_table(pa.table({"a": [1], "b": [2]}), second)
    config = load_config(_config(tmp_path))
    connection = duckdb.connect()
    try:
        with pytest.raises(DatasetError, match="mixes Parquet schemas"):
            build_dataset(
                connection,
                SourceSpec(glob=str(tmp_path / "*.parquet"), label="mixed", build_id="mixed", manifest_sha256=None),
                config,
                tmp_path / "mixed-run",
                run_id="mixed",
            )
    finally:
        connection.close()


def _analog_rows() -> list[dict[str, object]]:
    """A snapshot, its D-1 analog and filler rows for the other splits."""
    rows = [
        _row(
            observed_at=datetime(2026, 7, 8, 10, 0),
            departure=datetime(2026, 7, 10, 10, 0),
            route="analog",
            train="ICE1",
            fare=100.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 9, 8, 0),
            departure=datetime(2026, 7, 10, 10, 0),
            route="analog",
            train="ICE1",
            fare=110.0,
        ),
    ]
    for observed, fare in (
        (datetime(2026, 7, 7, 10, 0), 80.0),
        (datetime(2026, 7, 7, 22, 0), 85.0),
        (datetime(2026, 7, 8, 8, 0), 120.0),
        (datetime(2026, 7, 8, 12, 0), 130.0),
    ):
        rows.append(
            _row(
                observed_at=observed,
                departure=datetime(2026, 7, 9, 10, 0),
                route="analog",
                train="ICE1",
                fare=fare,
            )
        )
    for departure in (datetime(2026, 7, 15, 10, 0), datetime(2026, 7, 22, 10, 0), datetime(2026, 7, 29, 10, 0)):
        rows.append(
            _row(
                observed_at=departure - timedelta(days=2),
                departure=departure,
                route="filler",
                train="ICE2",
                fare=80.0,
            )
        )
        rows.append(
            _row(
                observed_at=departure - timedelta(days=1, hours=2),
                departure=departure,
                route="filler",
                train="ICE2",
                fare=85.0,
            )
        )
    return rows


def test_analog_features_use_the_previous_departure(tmp_path: Path) -> None:
    source = tmp_path / "analog-silver.parquet"
    _write_silver(source, _analog_rows())
    config_path = _config(tmp_path)
    raw = json.loads(config_path.read_text())
    raw["calendar"]["feature_set"] = "none"
    raw["features"] = {"analog_departures": {"enabled": True, "offsets_days": [1]}}
    config_path.write_text(json.dumps(raw), encoding="utf-8")
    config = load_config(config_path)
    out = tmp_path / "analog-run"
    connection = duckdb.connect()
    try:
        stats = build_dataset(
            connection,
            SourceSpec(glob=str(source), label="analog", build_id="analog", manifest_sha256=None),
            config,
            out,
            run_id="analog",
        )
    finally:
        connection.close()
    assert stats.rows > 0
    connection = duckdb.connect()
    try:
        row = connection.execute(
            """
            SELECT analog_d1_price_ratio, analog_d1_lead_gap_h,
                   analog_d1_next_ratio, analog_d1_rise_lead_gap_h
            FROM read_parquet(?)
            WHERE route_id = 'analog' AND snapshot_at = TIMESTAMP '2026-07-08 10:00:00'
            """,
            [str(out / "dataset" / "train.parquet")],
        ).fetchone()
    finally:
        connection.close()
    assert row is not None
    assert row[0] == pytest.approx(100.0 / 80.0)
    assert row[1] == pytest.approx(0.0)
    assert row[2] == pytest.approx(120.0 / 80.0)
    assert row[3] == pytest.approx(0.0)
    roles = json.loads((out / "column_roles.json").read_text())
    assert "analog_d1_price_ratio" in roles["features"]
    loaded = load_split(out / "dataset" / "train.parquet", feature_spec("none", analog_offsets=(1,)))
    assert "analog_d1_price_ratio" in loaded.features


def _analog_snapshot_values(source: Path, config_path: Path, out: Path) -> tuple[Any, ...]:
    """Build an analog dataset and return the test snapshot's four analog columns."""
    config = load_config(config_path)
    connection = duckdb.connect()
    try:
        build_dataset(
            connection,
            SourceSpec(glob=str(source), label="analog", build_id="analog", manifest_sha256=None),
            config,
            out,
            run_id=out.name,
        )
    finally:
        connection.close()
    connection = duckdb.connect()
    try:
        row = connection.execute(
            """
            SELECT analog_d1_price_ratio, analog_d1_lead_gap_h,
                   analog_d1_next_ratio, analog_d1_rise_lead_gap_h
            FROM read_parquet(?)
            WHERE route_id = 'analog' AND snapshot_at = TIMESTAMP '2026-07-08 10:00:00'
            """,
            [str(out / "dataset" / "train.parquet")],
        ).fetchone()
    finally:
        connection.close()
    assert row is not None
    return tuple(row)


def test_forward_analog_availability_finds_the_d1_analog(tmp_path: Path) -> None:
    source = tmp_path / "forward-silver.parquet"
    _write_silver(source, _analog_rows())
    config_path = _config(tmp_path)
    raw = json.loads(config_path.read_text())
    raw["calendar"]["feature_set"] = "none"
    raw["features"] = {"analog_departures": {"enabled": True, "offsets_days": [1]}}
    config_path.write_text(json.dumps(raw), encoding="utf-8")
    config = load_config(config_path)
    out = tmp_path / "forward-dataset"
    connection = duckdb.connect()
    try:
        build_dataset(
            connection,
            SourceSpec(glob=str(source), label="forward", build_id="forward", manifest_sha256=None),
            config,
            out,
            run_id="forward",
        )
        row = connection.execute(
            """
            SELECT series_key, route_id, service_class, departure_planned, departure_date,
                   hours_to_departure, price_eur, snapshot_at
            FROM read_parquet(?)
            WHERE route_id = 'analog' AND snapshot_at = TIMESTAMP '2026-07-08 10:00:00'
            """,
            [str(out / "dataset" / "train.parquet")],
        ).fetchone()
    finally:
        connection.close()
    assert row is not None
    forward_path = tmp_path / "forward.parquet"
    pq.write_table(
        pa.table(
            {
                "series_key": [row[0]],
                "snapshot_at": [row[7]],
                "bin_regime": ["12h"],
                "bin_index": [4],
                "route_id": [row[1]],
                "service_class": [row[2]],
                "departure_planned": [row[3]],
                "departure_date": [row[4]],
                "hours_to_departure": [row[5]],
                "price_eur": [row[6]],
                "ttd_band": ["1-3d"],
                "observation_era": ["forward"],
            }
        ),
        forward_path,
    )
    connection = duckdb.connect()
    try:
        availability = forward_analog_availability(
            connection, forward_path, f"read_parquet('{source.as_posix()}')", (1, 7)
        )
    finally:
        connection.close()
    assert availability["rows"] == 1
    assert availability["bands"][0]["band"] == "1-3d"
    assert availability["bands"][0]["d1_price"] == pytest.approx(1.0)
    assert availability["bands"][0]["d1_rise"] == pytest.approx(1.0)


def test_study_build_marks_calendar_and_analog_columns_as_candidates(tmp_path: Path) -> None:
    source = tmp_path / "study-silver.parquet"
    _write_silver(source, _analog_rows())
    config_path = _config(tmp_path)
    raw = json.loads(config_path.read_text())
    raw["calendar"]["feature_set"] = "none"
    raw["features"] = {"analog_departures": {"enabled": True, "offsets_days": [1]}}
    config_path.write_text(json.dumps(raw), encoding="utf-8")
    config = load_config(config_path)
    out = tmp_path / "study-run"
    connection = duckdb.connect()
    try:
        build_dataset(
            connection,
            SourceSpec(glob=str(source), label="study", build_id="study", manifest_sha256=None),
            config,
            out,
            run_id="study",
            study=True,
        )
    finally:
        connection.close()
    roles = json.loads((out / "column_roles.json").read_text())
    manifest = json.loads((out / "dataset_manifest.json").read_text())
    assert roles["features"] == list(feature_spec("none").names)
    assert "origin_public_holiday" in roles["candidate_feature"]
    assert "analog_d1_price_ratio" in roles["candidate_feature"]
    assert manifest["analog_departures"]["study"] is True
    assert "analog_d1_price_ratio" in manifest["build_features"]
    assert manifest["feature_spec_sha256"] != manifest["active_feature_spec_sha256"]


def test_analog_features_ignore_observations_after_the_snapshot(tmp_path: Path) -> None:
    source = tmp_path / "analog-base.parquet"
    _write_silver(source, _analog_rows())
    config_path = _config(tmp_path)
    raw = json.loads(config_path.read_text())
    raw["calendar"]["feature_set"] = "none"
    raw["features"] = {"analog_departures": {"enabled": True, "offsets_days": [1]}}
    config_path.write_text(json.dumps(raw), encoding="utf-8")
    base = _analog_snapshot_values(source, config_path, tmp_path / "base")

    future = _analog_rows()
    future.extend(
        [
            _row(
                observed_at=datetime(2026, 7, 8, 10, 30),
                departure=datetime(2026, 7, 9, 10, 0),
                route="analog",
                train="ICE1",
                fare=1.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 8, 11, 0),
                departure=datetime(2026, 7, 9, 10, 0),
                route="analog",
                train="ICE1",
                fare=2.0,
            ),
        ]
    )
    mutated_source = tmp_path / "analog-future.parquet"
    _write_silver(mutated_source, future)
    mutated = _analog_snapshot_values(mutated_source, config_path, tmp_path / "future")
    assert mutated == pytest.approx(base)


def test_analog_features_ignore_other_trains_and_departure_shifts(tmp_path: Path) -> None:
    rows = _analog_rows()
    # A different train and a departure 20 minutes later must not be analogs.
    rows.extend(
        [
            _row(
                observed_at=datetime(2026, 7, 7, 10, 0),
                departure=datetime(2026, 7, 9, 10, 0),
                route="analog",
                train="ICE-OTHER",
                fare=10.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 7, 10, 0),
                departure=datetime(2026, 7, 9, 10, 20),
                route="analog",
                train="ICE1",
                fare=20.0,
            ),
        ]
    )
    source = tmp_path / "analog-wrong.parquet"
    _write_silver(source, rows)
    config_path = _config(tmp_path)
    raw = json.loads(config_path.read_text())
    raw["calendar"]["feature_set"] = "none"
    raw["features"] = {"analog_departures": {"enabled": True, "offsets_days": [1]}}
    config_path.write_text(json.dumps(raw), encoding="utf-8")
    values = _analog_snapshot_values(source, config_path, tmp_path / "wrong")
    assert values[0] == pytest.approx(100.0 / 80.0)
    assert values[2] == pytest.approx(120.0 / 80.0)


def test_analog_lead_window_boundary(tmp_path: Path) -> None:
    config_path = _config(tmp_path)
    raw = json.loads(config_path.read_text())
    raw["calendar"]["feature_set"] = "none"
    raw["features"] = {"analog_departures": {"enabled": True, "offsets_days": [1]}}
    config_path.write_text(json.dumps(raw), encoding="utf-8")

    def build_with(extra_observed: datetime, label: str) -> tuple[Any, ...]:
        rows = [
            row
            for row in _analog_rows()
            if not (row["route_id"] == "analog" and row["departure_planned"] == datetime(2026, 7, 9, 10, 0))
        ]
        rows.append(
            _row(
                observed_at=extra_observed,
                departure=datetime(2026, 7, 9, 10, 0),
                route="analog",
                train="ICE1",
                fare=85.0,
            )
        )
        source = tmp_path / f"{label}.parquet"
        _write_silver(source, rows)
        return _analog_snapshot_values(source, config_path, tmp_path / label)

    at_boundary = build_with(datetime(2026, 7, 7, 22, 0), "boundary")
    assert at_boundary[0] == pytest.approx(100.0 / 85.0)
    assert at_boundary[1] == pytest.approx(-12.0)
    outside = build_with(datetime(2026, 7, 8, 0, 0), "outside")
    assert outside[0] is None


def test_analog_tie_break_prefers_later_lead(tmp_path: Path) -> None:
    rows = _analog_rows()
    # Replace the exact-lead analog with two observations one hour either side. The larger lead
    # (+1 h) wins the second tie-break.
    rows = [
        row
        for row in rows
        if not (
            row["observed_at"] == datetime(2026, 7, 7, 10, 0)
            and row["departure_planned"] == datetime(2026, 7, 9, 10, 0)
        )
    ]
    rows.extend(
        [
            _row(
                observed_at=datetime(2026, 7, 7, 9, 0),
                departure=datetime(2026, 7, 9, 10, 0),
                route="analog",
                train="ICE1",
                fare=70.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 7, 11, 0),
                departure=datetime(2026, 7, 9, 10, 0),
                route="analog",
                train="ICE1",
                fare=60.0,
            ),
        ]
    )
    source = tmp_path / "analog-tie.parquet"
    _write_silver(source, rows)
    config_path = _config(tmp_path)
    raw = json.loads(config_path.read_text())
    raw["calendar"]["feature_set"] = "none"
    raw["features"] = {"analog_departures": {"enabled": True, "offsets_days": [1]}}
    config_path.write_text(json.dumps(raw), encoding="utf-8")
    values = _analog_snapshot_values(source, config_path, tmp_path / "tie")
    assert values[0] == pytest.approx(100.0 / 70.0)
    assert values[1] == pytest.approx(1.0)


def test_analog_midnight_wrap_and_second_precision(tmp_path: Path) -> None:
    rows = [
        _row(
            observed_at=datetime(2026, 7, 8, 0, 5),
            departure=datetime(2026, 7, 10, 0, 5),
            route="midnight",
            train="ICE1",
            fare=100.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 9, 0, 5),
            departure=datetime(2026, 7, 10, 0, 5),
            route="midnight",
            train="ICE1",
            fare=110.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 7, 23, 50),
            departure=datetime(2026, 7, 9, 23, 50),
            route="midnight",
            train="ICE1",
            fare=80.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 8, 0, 5),
            departure=datetime(2026, 7, 9, 23, 50),
            route="midnight",
            train="ICE1",
            fare=90.0,
        ),
    ]
    for departure in (datetime(2026, 7, 15, 10, 0), datetime(2026, 7, 22, 10, 0), datetime(2026, 7, 29, 10, 0)):
        rows.extend(_filler_rows(departure))
    source = tmp_path / "midnight.parquet"
    _write_silver(source, rows)
    config_path = _config(tmp_path)
    raw = json.loads(config_path.read_text())
    raw["calendar"]["feature_set"] = "none"
    raw["features"] = {"analog_departures": {"enabled": True, "offsets_days": [1]}}
    config_path.write_text(json.dumps(raw), encoding="utf-8")
    connection = duckdb.connect()
    try:
        config = load_config(config_path)
        build_dataset(
            connection,
            SourceSpec(glob=str(source), label="midnight", build_id="midnight", manifest_sha256=None),
            config,
            tmp_path / "midnight-run",
            run_id="midnight",
        )
        row = connection.execute(
            """
            SELECT analog_d1_price_ratio, analog_d1_lead_gap_h
            FROM read_parquet(?)
            WHERE route_id = 'midnight' AND snapshot_at = TIMESTAMP '2026-07-08 00:05:00'
            """,
            [str(tmp_path / "midnight-run" / "dataset" / "train.parquet")],
        ).fetchone()
    finally:
        connection.close()
    assert row is not None
    assert row[0] == pytest.approx(100.0 / 80.0)
    assert row[1] == pytest.approx(0.0)

    shifted = _analog_rows()
    shifted = [
        item
        for item in shifted
        if not (item["route_id"] == "analog" and item["departure_planned"] == datetime(2026, 7, 9, 10, 0))
    ]
    shifted.append(
        _row(
            observed_at=datetime(2026, 7, 7, 10, 0),
            departure=datetime(2026, 7, 9, 10, 15, 59),
            route="analog",
            train="ICE1",
            fare=10.0,
        )
    )
    source = tmp_path / "seconds.parquet"
    _write_silver(source, shifted)
    connection = duckdb.connect()
    try:
        config = load_config(config_path)
        build_dataset(
            connection,
            SourceSpec(glob=str(source), label="seconds", build_id="seconds", manifest_sha256=None),
            config,
            tmp_path / "seconds-run",
            run_id="seconds",
        )
        row = connection.execute(
            "SELECT analog_d1_price_ratio FROM read_parquet(?) "
            "WHERE route_id = 'analog' AND snapshot_at = TIMESTAMP '2026-07-08 10:00:00'",
            [str(tmp_path / "seconds-run" / "dataset" / "train.parquet")],
        ).fetchone()
    finally:
        connection.close()
    assert row is not None
    assert row[0] is None


def _filler_rows(departure: datetime) -> list[dict[str, object]]:
    """Two rows for one filler split, mirroring the analog fixture."""
    return [
        _row(
            observed_at=departure - timedelta(days=2),
            departure=departure,
            route="filler",
            train="ICE2",
            fare=80.0,
        ),
        _row(
            observed_at=departure - timedelta(days=1, hours=2),
            departure=departure,
            route="filler",
            train="ICE2",
            fare=85.0,
        ),
    ]


def test_analog_d7_uses_the_week_earlier_departure(tmp_path: Path) -> None:
    rows = [
        _row(
            observed_at=datetime(2026, 7, 8, 10, 0),
            departure=datetime(2026, 7, 10, 10, 0),
            route="week",
            train="ICE1",
            fare=100.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 9, 8, 0),
            departure=datetime(2026, 7, 10, 10, 0),
            route="week",
            train="ICE1",
            fare=110.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 1, 10, 0),
            departure=datetime(2026, 7, 3, 10, 0),
            route="week",
            train="ICE1",
            fare=70.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 2, 8, 0),
            departure=datetime(2026, 7, 3, 10, 0),
            route="week",
            train="ICE1",
            fare=80.0,
        ),
    ]
    for departure in (datetime(2026, 7, 15, 10, 0), datetime(2026, 7, 22, 10, 0), datetime(2026, 7, 29, 10, 0)):
        rows.extend(_filler_rows(departure))
    source = tmp_path / "week.parquet"
    _write_silver(source, rows)
    config_path = _config(tmp_path)
    raw = json.loads(config_path.read_text())
    raw["calendar"]["feature_set"] = "none"
    raw["features"] = {"analog_departures": {"enabled": True, "offsets_days": [7]}}
    config_path.write_text(json.dumps(raw), encoding="utf-8")
    config = load_config(config_path)
    out = tmp_path / "week-run"
    connection = duckdb.connect()
    try:
        build_dataset(
            connection,
            SourceSpec(glob=str(source), label="week", build_id="week", manifest_sha256=None),
            config,
            out,
            run_id="week",
        )
        row = connection.execute(
            """
            SELECT analog_d7_price_ratio, analog_d7_next_ratio
            FROM read_parquet(?)
            WHERE route_id = 'week' AND snapshot_at = TIMESTAMP '2026-07-08 10:00:00'
            """,
            [str(out / "dataset" / "train.parquet")],
        ).fetchone()
    finally:
        connection.close()
    assert row is not None
    assert row[0] == pytest.approx(100.0 / 70.0)
    assert row[1] == pytest.approx(80.0 / 70.0)


def test_analog_next_day_point_uses_the_analog_journey(tmp_path: Path) -> None:
    rows = _analog_rows()
    # Same train and departure time but a different arrival: a different series key. This decoy is
    # closer to +24 h and much cheaper, so it would win if the series key were not matched.
    rows.append(
        _row(
            observed_at=datetime(2026, 7, 8, 10, 0),
            departure=datetime(2026, 7, 9, 10, 0),
            route="analog",
            train="ICE1",
            fare=1.0,
            arrival_planned=datetime(2026, 7, 9, 15, 0),
        )
    )
    source = tmp_path / "decoy.parquet"
    _write_silver(source, rows)
    config_path = _config(tmp_path)
    raw = json.loads(config_path.read_text())
    raw["calendar"]["feature_set"] = "none"
    raw["features"] = {"analog_departures": {"enabled": True, "offsets_days": [1]}}
    config_path.write_text(json.dumps(raw), encoding="utf-8")
    values = _analog_snapshot_values(source, config_path, tmp_path / "decoy")
    assert values[2] == pytest.approx(120.0 / 80.0)


def test_present_handles_compact_bytes_sentinels() -> None:
    values = np.array([b"__missing__", b"", b"x"], dtype="S11")
    assert _present(values).tolist() == [False, False, True]


def test_feature_spec_default_and_candidate_roles() -> None:
    assert feature_spec("none").names == (
        "price_eur",
        "headroom_pct",
        "price_rank_route_day",
        "price_rank_missing",
        "price_vs_series_min",
        "price_vs_series_median",
        "price_change_24h",
        "price_change_24h_missing",
        "price_velocity_24h",
        "price_jumps_24h",
        "price_min_7d",
        "price_max_7d",
        "price_drawdown_7d",
        "price_runup_7d",
        "load_factor_ordinal",
        "load_factor_missing",
        "load_factor_change_24h",
        "load_factor_change_24h_missing",
        "hours_to_departure",
        "departure_weekday",
        "departure_hour_local",
        "service_class",
        "distance_km",
        "train_type",
        "duration_minutes",
        "transfers_actual",
        "transfers_missing",
        "origin_state",
        "dest_state",
        "origin_station_category",
        "dest_station_category",
    )
    roles = column_roles(feature_spec("none"), analog_features((1, 7)))
    assert roles["features"] == list(feature_spec("none").names)
    assert set(roles["candidate_feature"]) == {
        "analog_d1_price_ratio",
        "analog_d1_lead_gap_h",
        "analog_d1_next_ratio",
        "analog_d1_rise_lead_gap_h",
        "analog_d7_price_ratio",
        "analog_d7_lead_gap_h",
        "analog_d7_next_ratio",
        "analog_d7_rise_lead_gap_h",
    }
    assert not set(roles["candidate_feature"]) & set(roles["features"])


def _route_day_hash(connection: duckdb.DuckDBPyConnection, route: str, day: date, seed: int = 42) -> int:
    """Return the builder's route-day sampling bucket for a route and departure date."""
    row = connection.execute(
        f"""
        SELECT CAST((('0x' || substr(sha256(concat_ws('|', {seed}, '{route}',
            CAST(DATE '{day.isoformat()}' AS VARCHAR))), 1, 8))::UBIGINT % 10000) AS INTEGER)
        """
    ).fetchone()
    assert row is not None
    return int(row[0])


def test_analog_features_use_unsampled_route_days(tmp_path: Path) -> None:
    connection = duckdb.connect()
    try:
        train_route = next(
            route
            for route in (f"route{index}" for index in range(1000))
            if _route_day_hash(connection, route, date(2026, 7, 10)) < 500
            and _route_day_hash(connection, route, date(2026, 7, 9)) >= 500
        )
        other = {}
        for name, day in (
            ("select", date(2026, 7, 15)),
            ("calibrate", date(2026, 7, 22)),
            ("test", date(2026, 7, 29)),
        ):
            other[name] = next(
                route
                for route in (f"{name}{index}" for index in range(1000))
                if _route_day_hash(connection, route, day) < 500
            )
    finally:
        connection.close()
    rows = [
        _row(
            observed_at=datetime(2026, 7, 8, 10, 0),
            departure=datetime(2026, 7, 10, 10, 0),
            route=train_route,
            train="ICE1",
            fare=100.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 9, 8, 0),
            departure=datetime(2026, 7, 10, 10, 0),
            route=train_route,
            train="ICE1",
            fare=110.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 7, 10, 0),
            departure=datetime(2026, 7, 9, 10, 0),
            route=train_route,
            train="ICE1",
            fare=80.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 8, 8, 0),
            departure=datetime(2026, 7, 9, 10, 0),
            route=train_route,
            train="ICE1",
            fare=120.0,
        ),
    ]
    for name, day in (("select", date(2026, 7, 15)), ("calibrate", date(2026, 7, 22)), ("test", date(2026, 7, 29))):
        rows.extend(
            (
                _row(
                    observed_at=datetime.combine(day - timedelta(days=2), datetime.min.time()) + timedelta(hours=10),
                    departure=datetime.combine(day, datetime.min.time()) + timedelta(hours=10),
                    route=other[name],
                    train="ICE2",
                    fare=80.0,
                ),
                _row(
                    observed_at=datetime.combine(day - timedelta(days=1), datetime.min.time()) + timedelta(hours=8),
                    departure=datetime.combine(day, datetime.min.time()) + timedelta(hours=10),
                    route=other[name],
                    train="ICE2",
                    fare=85.0,
                ),
            )
        )
    source = tmp_path / "analog-unsampled.parquet"
    _write_silver(source, rows)
    config_path = _config(tmp_path)
    raw = json.loads(config_path.read_text())
    raw["sample"]["sample_rate"] = 0.05
    raw["calendar"]["feature_set"] = "none"
    raw["features"] = {"analog_departures": {"enabled": True, "offsets_days": [1]}}
    config_path.write_text(json.dumps(raw), encoding="utf-8")
    config = load_config(config_path)
    out = tmp_path / "unsampled"
    connection = duckdb.connect()
    try:
        build_dataset(
            connection,
            SourceSpec(glob=str(source), label="unsampled", build_id="unsampled", manifest_sha256=None),
            config,
            out,
            run_id="unsampled",
        )
    finally:
        connection.close()
    connection = duckdb.connect()
    try:
        sampled = connection.execute(
            "SELECT DISTINCT route_id, departure_date FROM read_parquet(?)",
            [str(out / "dataset" / "train.parquet")],
        ).fetchall()
        row = connection.execute(
            """
            SELECT analog_d1_price_ratio, analog_d1_next_ratio
            FROM read_parquet(?)
            WHERE route_id = ? AND snapshot_at = TIMESTAMP '2026-07-08 10:00:00'
            """,
            [str(out / "dataset" / "train.parquet"), train_route],
        ).fetchone()
    finally:
        connection.close()
    assert (train_route, date(2026, 7, 9)) not in sampled
    assert row is not None
    assert row[0] == pytest.approx(100.0 / 80.0)
    assert row[1] == pytest.approx(120.0 / 80.0)


def test_mask_family_hits_the_target_share() -> None:
    count = 200
    band = np.array(["1-3d"] * 100 + ["3-5d"] * 100, dtype=object)
    features = {
        "analog_d1_price_ratio": np.concatenate([np.full(100, 1.2), np.full(100, np.nan)]),
        "analog_d1_lead_gap_h": np.concatenate([np.zeros(100), np.full(100, np.nan)]),
        "analog_d1_next_ratio": np.concatenate([np.full(100, 1.1), np.full(100, np.nan)]),
        "analog_d1_rise_lead_gap_h": np.concatenate([np.zeros(100), np.full(100, np.nan)]),
    }
    data = TabularData(
        features=features,
        y=np.zeros(count, dtype=np.int8),
        series=np.array(["s"] * count, dtype=str),
        route_day=np.array(["r"] * count, dtype=str),
        price=np.full(count, 100.0),
        check_price=np.full(count, 110.0),
        future_max=np.full(count, 120.0),
        future_observations=np.ones(count, dtype=np.int16),
        headroom=np.ones(count, dtype=np.int16),
        departure_date=np.array(["2026-07-10"] * count, dtype=str),
        snapshot_at=np.array(["2026-07-08 10:00:00"] * count, dtype=str),
        observation_era=np.array(["dense"] * count, dtype=str),
        observation_week=np.array(["2026-W28"] * count, dtype=str),
    )
    masked = mask_family(
        data,
        ("analog_d1_price_ratio", "analog_d1_lead_gap_h", "analog_d1_next_ratio", "analog_d1_rise_lead_gap_h"),
        {"1-3d": {"price": 0.5, "rise": 0.25}},
        band,
        np.random.default_rng(7),
    )
    near = band == "1-3d"
    assert np.isfinite(masked.features["analog_d1_price_ratio"][near]).sum() == 50
    assert np.isfinite(masked.features["analog_d1_next_ratio"][near]).sum() == 25
    price_present = np.isfinite(masked.features["analog_d1_price_ratio"])
    rise_present = np.isfinite(masked.features["analog_d1_next_ratio"])
    assert not (rise_present & ~price_present).any()
    assert np.isnan(masked.features["analog_d1_price_ratio"][~near]).all()
    assert np.isnan(masked.features["analog_d1_next_ratio"][~near]).all()


def test_mask_family_joint_keeps_the_measured_joint_share() -> None:
    count = 1000
    band = np.array(["1-3d"] * count, dtype=object)
    features = {
        "analog_d1_price_ratio": np.full(count, 1.2),
        "analog_d1_lead_gap_h": np.zeros(count),
        "analog_d1_next_ratio": np.full(count, 1.1),
        "analog_d1_rise_lead_gap_h": np.zeros(count),
        "analog_d7_price_ratio": np.full(count, 1.2),
        "analog_d7_lead_gap_h": np.zeros(count),
        "analog_d7_next_ratio": np.full(count, 1.1),
        "analog_d7_rise_lead_gap_h": np.zeros(count),
    }
    data = TabularData(
        features=features,
        y=np.zeros(count, dtype=np.int8),
        series=np.array(["s"] * count, dtype=str),
        route_day=np.array(["r"] * count, dtype=str),
        price=np.full(count, 100.0),
        check_price=np.full(count, 110.0),
        future_max=np.full(count, 120.0),
        future_observations=np.ones(count, dtype=np.int16),
        headroom=np.ones(count, dtype=np.int16),
        departure_date=np.array(["2026-07-10"] * count, dtype=str),
        snapshot_at=np.array(["2026-07-08 10:00:00"] * count, dtype=str),
        observation_era=np.array(["dense"] * count, dtype=str),
        observation_week=np.array(["2026-W28"] * count, dtype=str),
    )
    names = tuple(features)
    masked = mask_family(
        data,
        names,
        {"1-3d": {"price": 0.6, "rise": 0.3, "joint_price": 0.25, "joint_rise": 0.1}},
        band,
        np.random.default_rng(9),
        joint=True,
    )
    d1 = np.isfinite(masked.features["analog_d1_price_ratio"])
    d7 = np.isfinite(masked.features["analog_d7_price_ratio"])
    rise1 = np.isfinite(masked.features["analog_d1_next_ratio"])
    rise7 = np.isfinite(masked.features["analog_d7_next_ratio"])
    assert d1.sum() == 600
    assert (d1 & d7).sum() == 250
    assert not (d7 & ~d1).any()
    assert rise1.sum() == 300
    assert (rise1 & rise7).sum() == 100
    assert not (rise7 & ~rise1).any()


def test_study_arms_are_fixed_and_stress_prefers_the_forward_set() -> None:
    arms = study_arms((1, 7))
    assert [arm.name for arm in arms] == [
        "base",
        "analog_d1",
        "analog_d1_d7",
        "calendar_public",
        "calendar_public_school",
        "calendar_full",
    ]
    assert arms[0].reference is None
    assert arms[1].reference == "base"
    assert arms[2].reference == "analog_d1"
    targets, source, sources = _stress_targets(
        {"bands": [{"band": "1-3d", "price": 0.6, "rise": 0.4, "d1_price": 0.6, "d1_rise": 0.4}]},
        {"bands": [{"band": "1-3d", "share": 0.9}, {"band": "7-14d", "share": 0.15}]},
    )
    assert source == "forward_set+coverage_profile"
    assert targets["1-3d"] == {"price": 0.6, "rise": 0.4}
    assert targets["7-14d"] == {"price": 0.15, "rise": 0.15}
    assert sources == {"1-3d": "forward_set", "7-14d": "coverage_profile"}
    targets, source, _ = _stress_targets(None, {"bands": [{"band": "1-3d", "share": 0.9}]})
    assert source == "coverage_profile"
    assert targets["1-3d"] == {"price": 0.9, "rise": 0.9}
    with pytest.raises(ModelError, match="pre-registered"):
        study_arms((1, 3))


def test_feature_study_report_verdict_covers_every_family() -> None:
    result = {
        "run_id": "synthetic",
        "folds": ["dev"],
        "settings": {"replicates": 10, "seed": 1, "cluster": "departure_date"},
        "coverage": {"window_start": "a", "window_end": "b", "days": 28, "rows": 0},
        "stress": {"target_source": "forward_set"},
        "families": [
            {
                "name": "analog_d1",
                "reference": "base",
                "comparison": {"log_loss": [0.0, 0.1], "mean_log_loss": 0.05},
                "bands": [],
                "rule_passed": False,
                "stress_status": "not_run",
                "decision": "drop",
                "reason": "rule",
                "informative": True,
            },
            {
                "name": "calendar_public",
                "reference": "base",
                "comparison": {"log_loss": [-0.1, -0.0], "mean_log_loss": -0.05},
                "bands": [],
                "rule_passed": True,
                "stress_status": "not_applicable",
                "decision": "keep",
                "reason": "calendar",
                "informative": True,
            },
        ],
        "availability": {"panel": [], "coverage": []},
        "calendar_coverage": {"public_holiday_rows": 0},
        "no_family_added": False,
    }
    text = _study_report(result)
    assert "Families to add: calendar_public" in text
    assert "No family was added" not in text
    assert "null test" in text


def test_feature_study_report_no_family_added() -> None:
    result = {
        "run_id": "synthetic",
        "folds": ["dev"],
        "settings": {"replicates": 10, "seed": 1, "cluster": "departure_date"},
        "coverage": {"window_start": "a", "window_end": "b", "days": 28, "rows": 0},
        "stress": {"target_source": "forward_set"},
        "families": [],
        "availability": {"panel": [], "coverage": []},
        "calendar_coverage": {"public_holiday_rows": 10},
        "no_family_added": True,
    }
    assert "No family was added" in _study_report(result)


def test_coverage_profile_measures_the_d_minus_one_window(tmp_path: Path) -> None:
    source = tmp_path / "coverage.parquet"
    rows = [
        _row(
            observed_at=datetime(2026, 7, 8, 10, 0),
            departure=datetime(2026, 7, 10, 10, 0),
            route="hit",
            train="ICE1",
            fare=100.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 7, 10, 0),
            departure=datetime(2026, 7, 9, 10, 0),
            route="hit",
            train="ICE1",
            fare=80.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 8, 10, 0),
            departure=datetime(2026, 7, 10, 10, 0),
            route="miss",
            train="ICE2",
            fare=100.0,
        ),
    ]
    _write_silver(source, rows)
    connection = duckdb.connect()
    try:
        profile = coverage_profile(connection, f"read_parquet('{source.as_posix()}')")
    finally:
        connection.close()
    assert profile["days"] == 28
    assert profile["rows"] == 3
    assert profile["bands"] == [
        {
            "band": "1-3d",
            "rows": 3,
            "share": pytest.approx(1.0 / 3.0),
            "share_v1": pytest.approx(1.0 / 3.0),
        }
    ]


def test_dataset_contract_and_null_handoff(tmp_path: Path) -> None:
    stats, out = _build(tmp_path)
    assert stats.rows > 0
    assert {item.split for item in stats.splits} == {
        "train",
        "validation_select",
        "validation_calibrate",
        "test",
    }
    for split in stats.splits:
        assert split.labelled > 0
        assert split.positive_rate == pytest.approx(split.positives / split.labelled)
    spec = feature_spec("full")
    data = load_split(out / "dataset" / "train.parquet", spec)
    assert len(data) > 0
    assert (data.features["load_factor_ordinal"] == "__missing__").any()
    assert data.features["load_factor_missing"].sum() > 0
    assert np.isnan(data.features["transfers_actual"]).any()
    assert data.features["transfers_missing"].sum() > 0
    assert not np.isnan(data.features["price_rank_route_day"]).all()
    assert data.features["price_rank_missing"].sum() == 0
    assert set(np.unique(data.headroom)) <= {1, 5, 10, 20, 30}
    expected = breach(data.price_cents, data.check_price_cents, data.headroom)
    assert np.array_equal(data.y, expected)
    assert (data.headroom == 1).any()
    assert np.all(np.isfinite(data.check_price))

    connection = duckdb.connect()
    try:
        duplicates_row = connection.execute(
            """
            SELECT count(*) FROM (
                SELECT series_key, bin_regime, bin_index, count(*) AS n
                FROM read_parquet(?)
                GROUP BY 1, 2, 3
                HAVING count(*) > 1
            )
            """,
            [str(out / "dataset" / "train.parquet")],
        ).fetchone()
        assert duplicates_row is not None
        assert int(duplicates_row[0]) == 0
        crossing_row = connection.execute(
            """
            SELECT count(*) FROM (
                SELECT series_key, count(DISTINCT split) AS n
                FROM read_parquet(?)
                GROUP BY 1
                HAVING count(DISTINCT split) > 1
            )
            """,
            [str(out / "dataset" / "*.parquet")],
        ).fetchone()
        assert crossing_row is not None
        assert int(crossing_row[0]) == 0
    finally:
        connection.close()


def test_v2_row_in_a_split_fails(tmp_path: Path) -> None:
    v2 = _row(
        observed_at=datetime(2026, 7, 1, 6, 0),
        departure=datetime(2026, 7, 10, 10, 0),
        route="8011160-8000261",
        train="ICE1",
        fare=100.0,
        schema_version=2,
        journey_id="journey-1",
    )
    source = tmp_path / "v2.parquet"
    _write_silver(source, [v2])
    config = load_config(_config(tmp_path))
    config = replace(config, sample=replace(config.sample, sample_rate=0.05))
    connection = duckdb.connect()
    try:
        with pytest.raises(DatasetError, match="v2"):
            build_dataset(
                connection,
                SourceSpec(glob=str(source), label="v2", build_id=None, manifest_sha256=None),
                config,
                tmp_path / "run-v2",
                run_id="v2",
            )
    finally:
        connection.close()


def test_headroom_bucket_assignment_is_golden(tmp_path: Path) -> None:
    _, out = _build(tmp_path)
    connection = duckdb.connect()
    try:
        rows = connection.execute(
            "SELECT series_key, snapshot_at, headroom_pct "
            "FROM read_parquet(?) ORDER BY series_key, snapshot_at, bin_regime, bin_index LIMIT 20",
            [str(out / "dataset" / "train.parquet")],
        ).fetchall()
    finally:
        connection.close()
    grid = (1, 5, 10, 20, 30)
    assert rows
    for series_key, snapshot_at, actual in rows:
        payload = f"{series_key}|{snapshot_at.strftime('%Y-%m-%d %H:%M:%S')}".encode()
        bucket = int(hashlib.sha256(payload).hexdigest()[:8], 16) % len(grid)
        assert actual == grid[bucket]


def test_journey_successor_uses_new_series(tmp_path: Path) -> None:
    departure = datetime(2026, 7, 5, 10, 0)
    source = tmp_path / "successor.parquet"
    _write_silver(
        source,
        [
            _row(
                observed_at=datetime(2026, 7, 3, 8, 0),
                departure=departure,
                route="successor",
                train="ICE-OLD",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 2, 10, 0),
                departure=departure,
                route="existing",
                train="ICE-KEEP",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 3, 8, 0),
                departure=departure,
                route="existing",
                train="ICE-KEEP",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 3, 9, 0),
                departure=departure,
                route="existing",
                train="ICE-KEEP",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 3, 10, 0),
                departure=departure,
                route="existing",
                train="ICE-KEEP",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 4, 10, 0),
                departure=departure,
                route="existing",
                train="ICE-KEEP",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 2, 10, 0),
                departure=departure,
                route="other",
                train="ICE-GONE",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 3, 8, 0),
                departure=departure,
                route="other",
                train="ICE-GONE",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 3, 10, 0),
                departure=departure,
                route="other",
                train="ICE-GONE",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 4, 10, 0),
                departure=departure,
                route="other",
                train="ICE-NEW",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 3, 10, 0),
                departure=departure + timedelta(days=1),
                route="other",
                train="ICE-GONE",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 3, 9, 0),
                departure=departure,
                route="successor",
                train="ICE-OLD",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 3, 10, 0),
                departure=departure,
                route="successor",
                train="ICE-OLD",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 4, 10, 0),
                departure=departure + timedelta(minutes=10),
                route="successor",
                train="ICE-OLD",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 2, 10, 0),
                departure=departure,
                route="shift20",
                train="ICE-SHIFT",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 3, 8, 0),
                departure=departure,
                route="shift20",
                train="ICE-SHIFT",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 3, 10, 0),
                departure=departure,
                route="shift20",
                train="ICE-SHIFT",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 4, 10, 0),
                departure=departure + timedelta(minutes=20),
                route="shift20",
                train="ICE-SHIFT",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 4, 10, 0),
                departure=departure + timedelta(minutes=20),
                route="other",
                train="ICE-NEW",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 3, 8, 0),
                departure=departure,
                route="none",
                train="ICE-LEAVE",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 3, 9, 0),
                departure=departure,
                route="none",
                train="ICE-LEAVE",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 3, 10, 0),
                departure=departure,
                route="none",
                train="ICE-LEAVE",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 2, 10, 0),
                departure=departure,
                route="none",
                train="ICE-EXISTING",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 4, 10, 0),
                departure=departure,
                route="none",
                train="ICE-EXISTING",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 15, 10, 0),
                departure=datetime(2026, 7, 16, 10, 0),
                route="select",
                train="ICE-SELECT",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 22, 10, 0),
                departure=datetime(2026, 7, 23, 10, 0),
                route="calibrate",
                train="ICE-CAL",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 29, 10, 0),
                departure=datetime(2026, 7, 30, 10, 0),
                route="test",
                train="ICE-TEST",
                fare=80.0,
            ),
        ],
    )
    config_path = _config(tmp_path)
    raw = json.loads(config_path.read_text())
    raw["calendar"]["feature_set"] = "none"
    raw["report"]["min_eligible_rows"] = 0
    raw["report"]["min_split_positives"] = 0
    raw["report"]["min_band_positives"] = 0
    config_path.write_text(json.dumps(raw))
    config = load_config(config_path)
    connection = duckdb.connect()
    try:
        build_dataset(
            connection,
            SourceSpec(glob=str(source), label="successor", build_id=None, manifest_sha256=None),
            config,
            tmp_path / "successor-run",
            run_id="successor",
        )
    finally:
        connection.close()
    profile = json.loads((tmp_path / "successor-run" / "profile.json").read_text())["profile"]
    successors: dict[str, int] = {}
    successors_60: dict[str, int] = {}
    for group in profile["journey"]["groups"]:
        successors[group["successor"]] = successors.get(group["successor"], 0) + group["journeys"]
        successors_60[group["successor_60"]] = successors_60.get(group["successor_60"], 0) + group["journeys"]
    assert successors.get("same_train", 0) >= 1
    assert successors.get("other_train", 0) >= 1
    assert successors.get("none", 0) >= 1
    assert successors_60.get("none", 0) >= 1
    assert successors_60.get("same_train", 0) > successors.get("same_train", 0)
    assert successors_60.get("other_train", 0) < successors.get("other_train", 0)


def _chain_fixture(
    *,
    successor_train: str = "ICE-CHAIN",
    successor_departure: datetime | None = None,
    successor_arrival_offset: timedelta = timedelta(minutes=16),
    second_successor: bool = False,
) -> list[dict[str, object]]:
    departure = datetime(2026, 7, 6, 20, 0)
    successor_departure = successor_departure or departure
    rows = [
        _row(
            observed_at=datetime(2026, 7, 3, 20, 0),
            departure=departure,
            route="chain",
            train="ICE-CHAIN",
            fare=80.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 4, 20, 0),
            departure=departure,
            route="chain",
            train="ICE-CHAIN",
            fare=82.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 5, 10, 0),
            departure=successor_departure,
            arrival_planned=successor_departure + timedelta(hours=4) + successor_arrival_offset,
            route="chain",
            train=successor_train,
            fare=99.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 5, 22, 0),
            departure=successor_departure,
            arrival_planned=successor_departure + timedelta(hours=4) + successor_arrival_offset,
            route="chain",
            train=successor_train,
            fare=70.0,
        ),
    ]
    rows.append(dict(rows[0]))
    if second_successor:
        rows.append(
            _row(
                observed_at=datetime(2026, 7, 5, 10, 0),
                departure=departure + timedelta(minutes=10),
                arrival_planned=departure + timedelta(hours=4),
                route="chain",
                train="ICE-CHAIN",
                fare=97.0,
            )
        )
    return rows


def _build_chain_dataset(
    tmp_path: Path, rows: list[dict[str, object]], *, strict: bool = False
) -> tuple[DatasetStats, Path]:
    tmp_path.mkdir(parents=True, exist_ok=True)
    source = tmp_path / "chain.parquet"
    _write_silver(source, _rows() + rows)
    config_path = _config(tmp_path)
    raw = json.loads(config_path.read_text())
    raw["report"]["min_eligible_rows"] = 0
    raw["report"]["min_split_positives"] = 0
    raw["report"]["min_band_positives"] = 0
    config_path.write_text(json.dumps(raw))
    connection = duckdb.connect()
    try:
        stats = build_dataset(
            connection,
            SourceSpec(glob=str(source), label="chain", build_id="chain", manifest_sha256=None),
            load_config(config_path),
            tmp_path / "chain-run",
            run_id="chain",
            write_splits=True,
            strict_chains=strict,
        )
    finally:
        connection.close()
    return stats, tmp_path / "chain-run"


def test_observation_week_uses_berlin_time(tmp_path: Path) -> None:
    departure = datetime(2026, 7, 10, 10, 0)
    rows = [
        _row(
            observed_at=datetime(2026, 7, 5, 23, 30),
            departure=departure,
            route="week",
            train="ICE-WEEK",
            fare=80.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 6, 20, 0),
            departure=departure,
            route="week",
            train="ICE-WEEK",
            fare=90.0,
        ),
    ]
    _, out = _build_chain_dataset(tmp_path, rows)
    predictions = pq.read_table(out / "dataset" / "train.parquet").to_pydict()
    index = next(
        index
        for index, route in enumerate(predictions["route_id"])
        if route == "week" and str(predictions["snapshot_at"][index]) == "2026-07-05 23:30:00"
    )
    assert predictions["observation_week"][index] == "2026-W28"
    data = load_split(out / "dataset" / "train.parquet", feature_spec("full"))
    week_index = next(
        index for index, snapshot in enumerate(data.snapshot_at) if str(snapshot).startswith("2026-07-05T23:30")
    )
    assert str(data.observation_week[week_index]) == "2026-W28"


def test_v2_overlap_audit_splits_merges_and_missing_counterpart(tmp_path: Path) -> None:
    departure = datetime(2026, 8, 20, 10, 0)
    rows = []
    for arrival_offset in (timedelta(hours=4), timedelta(hours=4, minutes=16)):
        for observed in (datetime(2026, 8, 18, 10, 0), datetime(2026, 8, 19, 10, 0)):
            rows.append(
                _row(
                    observed_at=observed,
                    departure=departure,
                    arrival_planned=departure + arrival_offset,
                    route="overlap",
                    train="ICE-OVER",
                    fare=80.0,
                )
            )
    for journey, arrival_offset in (
        ("journey-overlap", timedelta(hours=4)),
        ("journey-overlap-2", timedelta(hours=4, minutes=30)),
    ):
        rows.append(
            _row(
                observed_at=datetime(2026, 8, 19, 12, 0),
                departure=departure,
                arrival_planned=departure + arrival_offset,
                route="overlap",
                train="ICE-OVER",
                fare=90.0,
                schema_version=2,
                journey_id=journey,
            )
        )
    rows.append(
        _row(
            observed_at=datetime(2026, 8, 19, 12, 0),
            departure=departure,
            route="overlap-none",
            train="ICE-NONE",
            fare=90.0,
            schema_version=2,
            journey_id="journey-none",
        )
    )
    _, out = _build_chain_dataset(tmp_path, rows)
    profile = json.loads((out / "profile.json").read_text())["profile"]
    audit = profile["chain_v2"]
    assert audit is not None
    assert audit["v2_journeys"] == 3
    assert audit["no_v1_counterpart"] == 1
    assert audit["overlap_journeys"] == 2
    assert audit["matched_journeys"] == 2
    assert audit["unmatched_share"] == 0.0
    assert audit["split_journeys"] == 2
    assert audit["split_rate"] == pytest.approx(1.0)
    assert audit["parallel_split_journeys"] == 2
    assert audit["matched_series"] == 2
    assert audit["merged_series"] == 2
    assert audit["merge_rate"] == pytest.approx(1.0)
    assert audit["same_itinerary_merges"] == 0
    assert audit["different_itinerary_merges"] == 2


def test_berlin_week_handles_dst_boundaries() -> None:
    connection = duckdb.connect()
    try:
        spring = connection.execute(f"SELECT {berlin_week_sql("TIMESTAMP '2026-03-29 22:30:00'")}").fetchone()
        autumn = connection.execute(f"SELECT {berlin_week_sql("TIMESTAMP '2026-10-25 22:30:00'")}").fetchone()
    finally:
        connection.close()
    assert spring is not None
    assert spring[0] == "2026-W14"
    assert autumn is not None
    assert autumn[0] == "2026-W43"


def test_chain_follows_arrival_change(tmp_path: Path) -> None:
    stats, out = _build_chain_dataset(tmp_path, _chain_fixture())
    assert stats.profile["chain"]["links"] >= 1
    assert stats.profile["chain"]["chains"] >= 1
    assert stats.profile["duplicates"]["duplicate_groups"] == 1
    assert stats.profile["duplicates"]["extra_duplicate_rows"] == 1
    assert stats.profile["scrape_gap"]
    assert stats.profile["chain_v2"] is None
    predictions = pq.read_table(out / "dataset" / "train.parquet").to_pydict()
    route_rows = [index for index, route in enumerate(predictions["route_id"]) if route == "chain"]
    assert len(route_rows) == 3
    assert len({predictions["chain_id"][index] for index in route_rows}) == 1
    assert len({predictions["series_key"][index] for index in route_rows}) == 2
    before = next(index for index in route_rows if str(predictions["snapshot_at"][index]) == "2026-07-04 20:00:00")
    after = next(index for index in route_rows if str(predictions["snapshot_at"][index]) == "2026-07-05 10:00:00")
    assert predictions["future_max_fare_24h"][before] == pytest.approx(99.0)
    assert predictions["future_observations"][before] == 1
    assert predictions["history_depth_h"][after] == pytest.approx(38.0)


def test_overlap_candidates_excludes_self_pairs(tmp_path: Path) -> None:
    departure = datetime(2026, 7, 6, 20, 0)
    rows = [
        _row(
            observed_at=datetime(2026, 7, 3, 20, 0),
            departure=departure,
            arrival_planned=departure + timedelta(hours=4),
            route="overlap-count",
            train="ICE-OC",
            fare=80.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 4, 20, 0),
            departure=departure,
            arrival_planned=departure + timedelta(hours=4),
            route="overlap-count",
            train="ICE-OC",
            fare=81.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 4, 20, 0),
            departure=departure,
            arrival_planned=departure + timedelta(hours=4, minutes=16),
            route="overlap-count",
            train="ICE-OC",
            fare=90.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 5, 10, 0),
            departure=departure,
            arrival_planned=departure + timedelta(hours=4, minutes=16),
            route="overlap-count",
            train="ICE-OC",
            fare=91.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 4, 20, 0),
            departure=departure,
            route="overlap-self",
            train="ICE-OS",
            fare=80.0,
        ),
    ]
    stats, _ = _build_chain_dataset(tmp_path, rows)
    assert stats.profile["chain"]["overlap_candidates"] == 1


def test_scrape_gap_audit_includes_departures_after_test_end(tmp_path: Path) -> None:
    departure = datetime(2026, 9, 20, 10, 0)
    rows = [
        _row(
            observed_at=datetime(2026, 9, 1, 10, 0),
            departure=departure,
            route="gap",
            train="ICE-GAP",
            fare=80.0,
            observation_era="sparse",
        ),
        _row(
            observed_at=datetime(2026, 9, 10, 10, 0),
            departure=departure,
            route="gap",
            train="ICE-GAP",
            fare=82.0,
            observation_era="sparse",
        ),
    ]
    stats, _ = _build_chain_dataset(tmp_path, rows)
    gap = [item for item in stats.profile["scrape_gap"] if item["era"] == "sparse" and item["band"] == "7-30d"]
    assert len(gap) == 1
    assert gap[0]["scrapes"] == 2
    assert gap[0]["median_gap_h"] == pytest.approx(216.0)
    assert gap[0]["without_24h_share"] == pytest.approx(1.0)


def _chain_snapshot(out: Path) -> dict[str, object]:
    predictions = pq.read_table(out / "dataset" / "train.parquet").to_pydict()
    index = next(
        index
        for index, route in enumerate(predictions["route_id"])
        if route == "chain" and str(predictions["snapshot_at"][index]) == "2026-07-04 20:00:00"
    )
    return {name: predictions[name][index] for name in predictions}


def _assert_chain_features_equal(base: dict[str, object], mutated: dict[str, object]) -> None:
    feature_names = (
        "price_vs_series_min",
        "price_vs_series_median",
        "price_min_7d",
        "price_max_7d",
        "price_drawdown_7d",
        "price_runup_7d",
        "history_depth_h",
        "price_change_24h",
        "price_jumps_24h",
        "load_factor_change_24h",
    )
    for name in feature_names:
        left = base[name]
        right = mutated[name]
        if left is None or right is None:
            assert left is None
            assert right is None
        else:
            assert float(cast(Any, left)) == pytest.approx(float(cast(Any, right)))


def test_chain_future_mutation_changes_label_not_features(tmp_path: Path) -> None:
    base_rows = _chain_fixture()
    _, base_out = _build_chain_dataset(tmp_path / "base", base_rows)
    high = _row(
        observed_at=datetime(2026, 7, 5, 18, 0),
        departure=datetime(2026, 7, 6, 20, 0),
        arrival_planned=datetime(2026, 7, 6, 20, 0) + timedelta(hours=4, minutes=16),
        route="chain",
        train="ICE-CHAIN",
        fare=120.0,
    )
    low = _row(
        observed_at=datetime(2026, 7, 5, 18, 0),
        departure=datetime(2026, 7, 6, 20, 0),
        arrival_planned=datetime(2026, 7, 6, 20, 0) + timedelta(hours=4, minutes=16),
        route="chain",
        train="ICE-CHAIN",
        fare=10.0,
    )
    _, high_out = _build_chain_dataset(tmp_path / "high", [*base_rows, high])
    _, low_out = _build_chain_dataset(tmp_path / "low", [*base_rows, low])

    base = _chain_snapshot(base_out)
    _assert_chain_features_equal(base, _chain_snapshot(high_out))
    _assert_chain_features_equal(base, _chain_snapshot(low_out))
    # Absolute values catch look-ahead in min-type features: the low future fare must not change
    # the predecessor's min/7-day minimum, and the high future fare must not change its maximum.
    assert base["price_vs_series_min"] == pytest.approx(2.0)
    assert base["price_min_7d"] == pytest.approx(80.0)
    assert base["price_max_7d"] == pytest.approx(82.0)
    assert base["price_vs_series_median"] == pytest.approx(82.0 / 81.0)
    assert base["future_max_fare_24h"] == pytest.approx(99.0)
    assert _chain_snapshot(high_out)["future_max_fare_24h"] == pytest.approx(120.0)
    assert _chain_snapshot(low_out)["future_max_fare_24h"] == pytest.approx(99.0)


def test_chain_link_created_after_snapshot_keeps_features(tmp_path: Path) -> None:
    departure = datetime(2026, 7, 6, 20, 0)
    base_rows = [
        _row(observed_at=datetime(2026, 7, 3, 20, 0), departure=departure, route="chain", train="ICE-CHAIN", fare=80.0),
        _row(observed_at=datetime(2026, 7, 4, 20, 0), departure=departure, route="chain", train="ICE-CHAIN", fare=82.0),
    ]
    successor = [
        _row(
            observed_at=datetime(2026, 7, 5, 10, 0),
            departure=departure,
            arrival_planned=departure + timedelta(hours=4, minutes=16),
            route="chain",
            train="ICE-CHAIN",
            fare=99.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 5, 22, 0),
            departure=departure,
            arrival_planned=departure + timedelta(hours=4, minutes=16),
            route="chain",
            train="ICE-CHAIN",
            fare=70.0,
        ),
    ]
    _, base_out = _build_chain_dataset(tmp_path / "link-base", base_rows)
    _, mutated_out = _build_chain_dataset(tmp_path / "link-mutated", [*base_rows, *successor])
    base = _chain_snapshot(base_out)
    mutated = _chain_snapshot(mutated_out)
    _assert_chain_features_equal(base, mutated)
    assert base["future_max_fare_24h"] is None
    assert mutated["future_max_fare_24h"] == pytest.approx(99.0)


def test_chain_rejects_null_train_numbers(tmp_path: Path) -> None:
    departure = datetime(2026, 7, 6, 20, 0)
    rows = [
        _row(observed_at=datetime(2026, 7, 3, 20, 0), departure=departure, route="null-train", train=None, fare=80.0),
        _row(observed_at=datetime(2026, 7, 4, 20, 0), departure=departure, route="null-train", train=None, fare=81.0),
        _row(
            observed_at=datetime(2026, 7, 5, 10, 0),
            departure=departure,
            arrival_planned=departure + timedelta(hours=4, minutes=16),
            route="null-train",
            train=None,
            fare=90.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 5, 22, 0),
            departure=departure,
            arrival_planned=departure + timedelta(hours=4, minutes=16),
            route="null-train",
            train=None,
            fare=91.0,
        ),
    ]
    stats, _ = _build_chain_dataset(tmp_path, rows)
    assert stats.profile["chain"]["links"] == 0
    assert stats.profile["chain"]["split_series"] == 0


def test_same_scrape_rekey_does_not_split_the_series(tmp_path: Path) -> None:
    departure = datetime(2026, 7, 6, 20, 0)
    rows = [
        _row(observed_at=datetime(2026, 7, 3, 20, 0), departure=departure, route="overlap", train="ICE-O", fare=80.0),
        _row(observed_at=datetime(2026, 7, 4, 20, 0), departure=departure, route="overlap", train="ICE-O", fare=82.0),
        _row(observed_at=datetime(2026, 7, 5, 10, 0), departure=departure, route="overlap", train="ICE-O", fare=84.0),
        _row(
            observed_at=datetime(2026, 7, 5, 10, 0),
            departure=departure,
            arrival_planned=departure + timedelta(hours=4, minutes=16),
            route="overlap",
            train="ICE-O",
            fare=99.0,
        ),
    ]
    stats, _ = _build_chain_dataset(tmp_path, rows)
    assert stats.profile["chain"]["split_series"] == 0
    assert stats.profile["chain"]["overlap_candidates"] >= 1
    assert stats.profile["chain"]["links"] == 0


def _returning_successor_panel() -> list[tuple[object, ...]]:
    departure = datetime(2026, 7, 10, 20, 0)
    arrival = {
        "s": datetime(2026, 7, 11, 0, 0),
        "s2": datetime(2026, 7, 11, 0, 16),
        "p": datetime(2026, 7, 11, 0, 30),
    }
    scrapes = {
        "s": (4, 5, 7),
        "s2": (6,),
        "p": (5, 6, 8),
    }
    rows: list[tuple[object, ...]] = []
    for series_key, days in scrapes.items():
        for day in days:
            rows.append(
                (
                    series_key,
                    "r",
                    departure.date(),
                    "ICE-M",
                    2,
                    departure,
                    datetime(2026, 7, day, 10, 0),
                    80.0 if series_key == "p" else 90.0,
                    2,
                    arrival[series_key],
                    0,
                )
            )
    return rows


def _build_probe_map(
    connection: duckdb.DuckDBPyConnection,
    rows: list[tuple[object, ...]],
    prefix: str,
    *,
    strict: bool = False,
) -> Any:
    connection.execute("DROP TABLE IF EXISTS base")
    connection.execute(
        """
        CREATE TABLE base (
            series_key TEXT, route_id TEXT, departure_date DATE, train_number TEXT,
            service_class INTEGER, departure_planned TIMESTAMP, observed_at TIMESTAMP,
            price_eur DOUBLE, load_factor_ordinal INTEGER, arrival_planned TIMESTAMP,
            transfers_actual INTEGER
        )
        """
    )
    connection.executemany("INSERT INTO base VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
    connection.execute("DROP TABLE IF EXISTS grid")
    connection.execute("CREATE TABLE grid AS SELECT DISTINCT route_id, departure_date, observed_at FROM base")
    return build_chain_map(
        connection,
        base_view="base",
        grid_view="grid",
        prefix=prefix,
        map_table=f"{prefix}_map",
        strict=strict,
    )


def test_returning_successor_chain_is_causal() -> None:
    cutoff = datetime(2026, 7, 7, 10, 0)
    full_rows = _returning_successor_panel()
    cut_rows = [row for row in full_rows if cast(datetime, row[6]) <= cutoff]
    connection = duckdb.connect()
    try:
        _build_probe_map(connection, full_rows, "full")
        _build_probe_map(connection, cut_rows, "cut")
        full = {
            observed: chain
            for series, observed, chain in connection.execute(
                "SELECT series_key, observed_at, chain_id FROM full_map_rows "
                "WHERE series_key = 'p' AND observed_at <= ? ORDER BY observed_at",
                [cutoff],
            ).fetchall()
        }
        cut = {
            observed: chain
            for series, observed, chain in connection.execute(
                "SELECT series_key, observed_at, chain_id FROM cut_map_rows "
                "WHERE series_key = 'p' AND observed_at <= ? ORDER BY observed_at",
                [cutoff],
            ).fetchall()
        }
        successor_chain = connection.execute(
            "SELECT chain_id FROM full_map_rows WHERE series_key = 's' AND observed_at = ?",
            [cutoff],
        ).fetchone()
        full_links = set(
            connection.execute(
                "SELECT l.predecessor, l.successor FROM full_links l JOIN full_series s "
                "ON s.series_key = l.successor WHERE s.first_obs <= ?",
                [cutoff],
            ).fetchall()
        )
        cut_links = set(
            connection.execute(
                "SELECT l.predecessor, l.successor FROM cut_links l JOIN cut_series s "
                "ON s.series_key = l.successor WHERE s.first_obs <= ?",
                [cutoff],
            ).fetchall()
        )
        assert full == cut
        assert full_links == cut_links
        assert ("p", "s#r1") in full_links
        assert successor_chain is not None
        assert set(full.values()) == {successor_chain[0]}
        split_series = connection.execute(
            "SELECT count(*) FROM (SELECT base_series_key FROM full_obs_rekeyed "
            "GROUP BY base_series_key HAVING count(DISTINCT incarnation_rank) > 1)"
        ).fetchone()
        assert split_series is not None
        assert split_series[0] >= 2
    finally:
        connection.close()


def test_rejected_continuation_does_not_split_a_returning_predecessor() -> None:
    departure = datetime(2026, 7, 10, 20, 0)
    rows = [
        (
            "p1",
            "r",
            departure.date(),
            "ICE-R",
            2,
            departure,
            datetime(2026, 7, 6, 10, 0),
            80.0,
            2,
            departure + timedelta(hours=4),
            0,
        ),
        (
            "p2",
            "r",
            departure.date(),
            "ICE-R",
            2,
            departure,
            datetime(2026, 7, 6, 10, 0),
            81.0,
            2,
            departure + timedelta(hours=4, minutes=16),
            0,
        ),
        (
            "s",
            "r",
            departure.date(),
            "ICE-R",
            2,
            departure,
            datetime(2026, 7, 7, 10, 0),
            90.0,
            2,
            departure + timedelta(hours=4, minutes=30),
            0,
        ),
        (
            "p1",
            "r",
            departure.date(),
            "ICE-R",
            2,
            departure,
            datetime(2026, 7, 8, 10, 0),
            85.0,
            2,
            departure + timedelta(hours=4),
            0,
        ),
        (
            "p2",
            "r",
            departure.date(),
            "ICE-R",
            2,
            departure,
            datetime(2026, 7, 8, 10, 0),
            86.0,
            2,
            departure + timedelta(hours=4, minutes=16),
            0,
        ),
    ]
    connection = duckdb.connect()
    try:
        matched = _build_probe_map(connection, cast(list[tuple[object, ...]], rows), "matched")
        assert matched.split_series == 1
        assert matched.links == 2  # one predecessor -> s, then s -> the winner's return
        strict = _build_probe_map(connection, cast(list[tuple[object, ...]], rows), "strict", strict=True)
        assert strict.split_series == 0
        assert strict.links == 0
    finally:
        connection.close()


def test_chain_gap_stops_at_departure() -> None:
    departure = datetime(2026, 7, 10, 20, 0)
    rows = [
        (
            "p",
            "r",
            departure.date(),
            "ICE-M",
            2,
            departure,
            datetime(2026, 7, 8, 10, 0),
            80.0,
            2,
            departure + timedelta(hours=4),
            0,
        ),
        (
            "s",
            "r",
            departure.date(),
            "ICE-M",
            2,
            departure,
            datetime(2026, 7, 10, 22, 0),
            90.0,
            2,
            departure + timedelta(hours=4, minutes=16),
            0,
        ),
    ]
    connection = duckdb.connect()
    try:
        _build_probe_map(connection, cast(list[tuple[object, ...]], rows), "stop")
        split_points = connection.execute("SELECT count(*) FROM stop_split_points").fetchone()
        links = connection.execute("SELECT count(*) FROM stop_links").fetchone()
        assert split_points == (0,)
        assert links == (0,)
    finally:
        connection.close()


def test_split_requires_matching_train_and_departure(tmp_path: Path) -> None:
    departure = datetime(2026, 7, 8, 20, 0)
    cases = (
        ("different-train", "ICE-OTHER", departure),
        ("shifted", "ICE-P", departure + timedelta(minutes=16)),
    )
    for name, successor_train, successor_departure in cases:
        rows = [
            _row(
                observed_at=datetime(2026, 7, 5, 20, 0),
                departure=departure,
                route=name,
                train="ICE-P",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 6, 20, 0),
                departure=departure,
                route=name,
                train="ICE-P",
                fare=82.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 7, 10, 0),
                departure=successor_departure,
                arrival_planned=successor_departure + timedelta(hours=4, minutes=16),
                route=name,
                train=successor_train,
                fare=99.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 7, 12, 0),
                departure=departure,
                route=name,
                train="ICE-P",
                fare=85.0,
            ),
        ]
        stats, out = _build_chain_dataset(tmp_path / name, rows)
        assert stats.profile["chain"]["split_series"] == 0
        predictions = pq.read_table(out / "dataset" / "train.parquet").to_pydict()
        by_time = {
            str(predictions["snapshot_at"][index]): index
            for index, route in enumerate(predictions["route_id"])
            if route == name and predictions["price_eur"][index] in {82.0, 85.0}
        }
        assert (
            predictions["chain_id"][by_time["2026-07-06 20:00:00"]]
            == predictions["chain_id"][by_time["2026-07-07 12:00:00"]]
        )


def test_chain_map_is_series_level_and_row_map_is_unique() -> None:
    connection = duckdb.connect()
    try:
        connection.execute(
            """
            CREATE TABLE base (
                series_key TEXT, route_id TEXT, departure_date DATE, train_number TEXT,
                service_class INTEGER, departure_planned TIMESTAMP, observed_at TIMESTAMP,
                price_eur DOUBLE, load_factor_ordinal INTEGER, arrival_planned TIMESTAMP,
                transfers_actual INTEGER
            )
            """
        )
        connection.execute(
            """
            INSERT INTO base VALUES
                ('p', 'r', DATE '2026-07-08', 'ICE-M', 2,
                 TIMESTAMP '2026-07-08 20:00:00', TIMESTAMP '2026-07-05 20:00:00',
                 80.0, 2, TIMESTAMP '2026-07-09 00:00:00', 0),
                ('p', 'r', DATE '2026-07-08', 'ICE-M', 2,
                 TIMESTAMP '2026-07-08 20:00:00', TIMESTAMP '2026-07-06 20:00:00',
                 82.0, 2, TIMESTAMP '2026-07-09 00:00:00', 0),
                ('p', 'r', DATE '2026-07-08', 'ICE-M', 2,
                 TIMESTAMP '2026-07-08 20:00:00', TIMESTAMP '2026-07-07 12:00:00',
                 85.0, 2, TIMESTAMP '2026-07-09 00:00:00', 0),
                ('s', 'r', DATE '2026-07-08', 'ICE-M', 2,
                 TIMESTAMP '2026-07-08 20:00:00', TIMESTAMP '2026-07-07 10:00:00',
                 99.0, 2, TIMESTAMP '2026-07-09 00:00:16', 0),
                ('s', 'r', DATE '2026-07-08', 'ICE-M', 2,
                 TIMESTAMP '2026-07-08 20:00:00', TIMESTAMP '2026-07-07 12:00:00',
                 98.0, 2, TIMESTAMP '2026-07-09 00:00:16', 0)
            """
        )
        connection.execute("CREATE TABLE grid AS SELECT DISTINCT route_id, departure_date, observed_at FROM base")
        stats = build_chain_map(
            connection,
            base_view="base",
            grid_view="grid",
            prefix="probe",
            map_table="probe_map",
        )
        assert stats.base_series == 2
        assert stats.split_series == 1
        assert connection.execute("SELECT count(*) FROM probe_map").fetchone() == (2,)
        assert connection.execute("SELECT count(*) FROM probe_map_rows").fetchone() == (5,)
        duplicates = connection.execute(
            "SELECT count(*) FROM (SELECT series_key, observed_at FROM probe_map_rows "
            "GROUP BY 1, 2 HAVING count(*) > 1)"
        ).fetchone()
        assert duplicates == (0,)
    finally:
        connection.close()


def test_chain_does_not_cross_departure_date(tmp_path: Path) -> None:
    first = datetime(2026, 7, 5, 23, 55)
    second = datetime(2026, 7, 6, 0, 5)
    rows = [
        _row(observed_at=datetime(2026, 7, 4, 10, 0), departure=first, route="midnight", train="ICE-MID", fare=80.0),
        _row(observed_at=datetime(2026, 7, 5, 10, 0), departure=first, route="midnight", train="ICE-MID", fare=81.0),
        _row(observed_at=datetime(2026, 7, 5, 22, 0), departure=first, route="midnight", train="ICE-FILL", fare=80.0),
        _row(
            observed_at=datetime(2026, 7, 5, 22, 0),
            departure=second,
            arrival_planned=second + timedelta(hours=4, minutes=16),
            route="midnight",
            train="ICE-MID",
            fare=90.0,
        ),
    ]
    stats, _ = _build_chain_dataset(tmp_path, rows)
    assert stats.profile["chain"]["at_risk_series"] == 1
    assert stats.profile["chain"]["candidate_links"] == 0
    assert stats.profile["chain"]["links"] == 0


def test_s3_source_inventory_shape() -> None:
    class FakeCursor:
        def fetchall(self) -> list[tuple[str, int]]:
            return [("s3://bucket/build/file.parquet", 42)]

    class FakeConnection:
        def execute(self, sql: str) -> FakeCursor:
            return FakeCursor()

    inventory = _source_inventory(
        cast(Any, FakeConnection()),
        SourceSpec(
            glob="s3://bucket/build/**/*.parquet",
            label="s3://bucket/_latest.json",
            build_id=None,
            manifest_sha256=None,
        ),
    )
    assert inventory == [{"path": "s3://bucket/build/file.parquet", "rows": 42}]


def test_chain_is_independent_of_same_scrape_row_order(tmp_path: Path) -> None:
    departure = datetime(2026, 7, 6, 20, 0)
    rows = [
        _row(
            observed_at=datetime(2026, 7, 4, 10, 0),
            departure=departure,
            arrival_planned=departure + timedelta(hours=4),
            route="scan-order",
            train="ICE-SCAN",
            fare=80.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 4, 10, 0),
            departure=departure + timedelta(minutes=5),
            arrival_planned=departure + timedelta(hours=4, minutes=5),
            route="scan-order",
            train="ICE-SCAN",
            fare=90.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 5, 10, 0),
            departure=departure + timedelta(minutes=16),
            arrival_planned=departure + timedelta(hours=4, minutes=16),
            route="scan-order",
            train="ICE-SCAN",
            fare=95.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 5, 22, 0),
            departure=departure + timedelta(minutes=16),
            arrival_planned=departure + timedelta(hours=4, minutes=16),
            route="scan-order",
            train="ICE-SCAN",
            fare=96.0,
        ),
    ]
    stats_a, out_a = _build_chain_dataset(tmp_path / "order-a", rows)
    stats_b, out_b = _build_chain_dataset(tmp_path / "order-b", list(reversed(rows)))
    assert stats_a.profile["chain"] == stats_b.profile["chain"]
    assert stats_a.profile["chain"]["links"] == 1
    for out in (out_a, out_b):
        predictions = pq.read_table(out / "dataset" / "train.parquet").to_pydict()
        route_rows = [index for index, route in enumerate(predictions["route_id"]) if route == "scan-order"]
        assert len(route_rows) == 2
        assert len({predictions["chain_id"][index] for index in route_rows}) == 1


def test_v2_handover_same_itinerary_merge(tmp_path: Path) -> None:
    departure = datetime(2026, 8, 20, 10, 0)
    rows = [
        _row(
            observed_at=datetime(2026, 8, 18, 10, 0),
            departure=departure,
            route="same-itin",
            train="ICE-SI",
            fare=80.0,
        ),
        _row(
            observed_at=datetime(2026, 8, 19, 10, 0),
            departure=departure,
            route="same-itin",
            train="ICE-SI",
            fare=82.0,
        ),
    ]
    for journey in ("same-itin-1", "same-itin-2"):
        rows.append(
            _row(
                observed_at=datetime(2026, 8, 19, 12, 0),
                departure=departure,
                route="same-itin",
                train="ICE-SI",
                fare=90.0,
                schema_version=2,
                journey_id=journey,
            )
        )
    _, out = _build_chain_dataset(tmp_path, rows)
    audit = json.loads((out / "profile.json").read_text())["profile"]["chain_v2"]
    assert audit is not None
    assert audit["v2_journeys"] == 2
    assert audit["matched_journeys"] == 2
    assert audit["matched_series"] == 1
    assert audit["merged_series"] == 1
    assert audit["same_itinerary_merges"] == 1
    assert audit["different_itinerary_merges"] == 0


def test_chain_rejects_different_train_and_large_shift(tmp_path: Path) -> None:
    for name, rows in (
        ("train", _chain_fixture(successor_train="ICE-OTHER")),
        ("shift", _chain_fixture(successor_departure=datetime(2026, 7, 6, 20, 16))),
    ):
        stats, out = _build_chain_dataset(tmp_path / name, rows)
        predictions = pq.read_table(out / "dataset" / "train.parquet").to_pydict()
        route_rows = [index for index, route in enumerate(predictions["route_id"]) if route == "chain"]
        assert len({predictions["chain_id"][index] for index in route_rows}) == 2
        before = next(index for index in route_rows if str(predictions["snapshot_at"][index]) == "2026-07-04 20:00:00")
        assert predictions["future_max_fare_24h"][before] is None
        assert stats.profile["chain"]["links"] == 0
        assert stats.profile["chain"]["split_series"] == 0


def test_chain_matching_prioritises_cardinality_over_closest_candidate(tmp_path: Path) -> None:
    departure = datetime(2026, 7, 7, 20, 0)
    later = datetime(2026, 7, 7, 20, 10)
    earlier = datetime(2026, 7, 7, 19, 45)
    rows = [
        _row(observed_at=datetime(2026, 7, 4, 20, 0), departure=departure, route="match", train="ICE-MATCH", fare=80.0),
        _row(observed_at=datetime(2026, 7, 5, 10, 0), departure=departure, route="match", train="ICE-MATCH", fare=81.0),
        _row(
            observed_at=datetime(2026, 7, 4, 20, 0),
            departure=later,
            arrival_planned=later + timedelta(hours=4, minutes=16),
            route="match",
            train="ICE-MATCH",
            fare=80.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 5, 10, 0),
            departure=later,
            arrival_planned=later + timedelta(hours=4, minutes=16),
            route="match",
            train="ICE-MATCH",
            fare=81.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 5, 22, 0),
            departure=departure,
            arrival_planned=departure + timedelta(hours=4, minutes=16),
            route="match",
            train="ICE-MATCH",
            fare=90.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 5, 22, 0),
            departure=earlier,
            arrival_planned=earlier + timedelta(hours=4),
            route="match",
            train="ICE-MATCH",
            fare=91.0,
        ),
    ]
    stats, out = _build_chain_dataset(tmp_path, rows)
    chain = stats.profile["chain"]
    assert chain["candidate_links"] == 3
    assert chain["links"] == 2
    assert chain["chains"] == 2
    assert chain["unused_candidates"] == 1
    # The crossing case is the documented exception to "closest first": P1 gives up S1 for S2 so
    # that P2 can keep S1 and the matching stays maximum.
    predictions = pq.read_table(out / "dataset" / "train.parquet").to_pydict()
    by_key = {
        (
            str(predictions["snapshot_at"][index]),
            float(predictions["price_eur"][index]),
            str(predictions["departure_planned"][index]),
        ): predictions["chain_id"][index]
        for index in range(len(predictions["route_id"]))
        if predictions["route_id"][index] == "match"
    }
    p1 = by_key[("2026-07-04 20:00:00", 80.0, "2026-07-07 20:00:00")]
    p2 = by_key[("2026-07-04 20:00:00", 80.0, "2026-07-07 20:10:00")]
    s1 = by_key[("2026-07-05 22:00:00", 90.0, "2026-07-07 20:00:00")]
    s2 = by_key[("2026-07-05 22:00:00", 91.0, "2026-07-07 19:45:00")]
    assert p1 == s2
    assert p2 == s1
    assert p1 != p2


def test_resample_keeps_one_row_per_chain_bin(tmp_path: Path) -> None:
    departure = datetime(2026, 7, 6, 20, 0)
    rows = [
        _row(
            observed_at=datetime(2026, 7, 4, 12, 30), departure=departure, route="matchbin", train="ICE-BIN", fare=80.0
        ),
        _row(
            observed_at=datetime(2026, 7, 5, 12, 30), departure=departure, route="matchbin", train="ICE-BIN", fare=81.0
        ),
        _row(
            observed_at=datetime(2026, 7, 5, 12, 45),
            departure=departure,
            arrival_planned=departure + timedelta(hours=4, minutes=16),
            route="matchbin",
            train="ICE-BIN",
            fare=90.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 6, 10, 0),
            departure=departure,
            arrival_planned=departure + timedelta(hours=4, minutes=16),
            route="matchbin",
            train="ICE-BIN",
            fare=70.0,
        ),
    ]
    _, out = _build_chain_dataset(tmp_path, rows)
    predictions = pq.read_table(out / "dataset" / "train.parquet").to_pydict()
    indexes = [index for index, route in enumerate(predictions["route_id"]) if route == "matchbin"]
    in_bin = [index for index in indexes if predictions["bin_index"][index] == 31]
    assert len(in_bin) == 1
    assert str(predictions["snapshot_at"][in_bin[0]]) == "2026-07-05 12:30:00"


def test_series_key_bucket_edges_round_to_the_half_minute() -> None:
    connection = duckdb.connect()
    try:
        rows = connection.execute(
            f"""
            SELECT departure_planned, {series_key_sql()} AS series_key
            FROM (VALUES
                (TIMESTAMP '2026-07-05 09:52:29', 'r', 'ICE', 2, TIMESTAMP '2026-07-05 14:00:00', 0),
                (TIMESTAMP '2026-07-05 09:52:30', 'r', 'ICE', 2, TIMESTAMP '2026-07-05 14:00:00', 0),
                (TIMESTAMP '2026-07-05 10:07:29', 'r', 'ICE', 2, TIMESTAMP '2026-07-05 14:00:00', 0),
                (TIMESTAMP '2026-07-05 10:07:30', 'r', 'ICE', 2, TIMESTAMP '2026-07-05 14:00:00', 0)
            ) t(departure_planned, route_id, train_number, service_class, arrival_planned, transfers_actual)
            ORDER BY departure_planned
            """
        ).fetchall()
    finally:
        connection.close()
    keys = [row[1] for row in rows]
    assert keys[0] != keys[1]
    assert keys[1] == keys[2]
    assert keys[2] != keys[3]


def test_chain_ambiguity_warning_is_gated_by_strict_mode() -> None:
    evaluation = _evaluation(
        evaluation_on_test=False,
        calibration_prevalence=0.2,
        train_prevalence=0.2,
        positive_rate=0.2,
    )
    base = _stats()
    ambiguous = replace(
        base,
        profile={"chain": {"strict": False, "ambiguous_predecessors": 2, "ambiguous_successors": 1}},
    )
    assert any("run --strict-chains" in warning for warning in _warnings(ambiguous, evaluation))
    strict = replace(
        base,
        profile={"chain": {"strict": True, "ambiguous_predecessors": 2, "ambiguous_successors": 1}},
    )
    assert not any("run --strict-chains" in warning for warning in _warnings(strict, evaluation))


def test_chain_one_to_one_picks_closest_departure_and_strict_drops_ambiguity(tmp_path: Path) -> None:
    _, out = _build_chain_dataset(tmp_path, _chain_fixture(second_successor=True))
    predictions = pq.read_table(out / "dataset" / "train.parquet").to_pydict()
    route_rows = [index for index, route in enumerate(predictions["route_id"]) if route == "chain"]
    chain_ids = {predictions["chain_id"][index] for index in route_rows}
    assert len(chain_ids) == 2
    first_successor = next(
        index
        for index in route_rows
        if str(predictions["snapshot_at"][index]) == "2026-07-05 10:00:00"
        and predictions["price_eur"][index] == pytest.approx(99.0)
    )
    before = next(index for index in route_rows if str(predictions["snapshot_at"][index]) == "2026-07-04 20:00:00")
    assert predictions["chain_id"][before] == predictions["chain_id"][first_successor]
    _, strict_out = _build_chain_dataset(tmp_path / "strict", _chain_fixture(second_successor=True), strict=True)
    strict_predictions = pq.read_table(strict_out / "dataset" / "train.parquet").to_pydict()
    strict_rows = [index for index, route in enumerate(strict_predictions["route_id"]) if route == "chain"]
    assert len({strict_predictions["chain_id"][index] for index in strict_rows}) == 3


def test_journey_next_scrape_stops_at_departure(tmp_path: Path) -> None:
    departure = datetime(2026, 7, 5, 10, 0)
    source = tmp_path / "journey-boundary.parquet"
    _write_silver(
        source,
        [
            _row(
                observed_at=datetime(2026, 7, 2, 10, 0),
                departure=departure,
                route="boundary",
                train="ICE-EARLY",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 3, 8, 0),
                departure=departure,
                route="boundary",
                train="ICE-EARLY",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 3, 10, 0),
                departure=departure,
                route="boundary",
                train="ICE-EARLY",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 5, 11, 0),
                departure=datetime(2026, 7, 5, 18, 0),
                route="boundary",
                train="ICE-LATE",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 5, 12, 0),
                departure=datetime(2026, 7, 5, 18, 0),
                route="boundary",
                train="ICE-LATE",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 5, 13, 0),
                departure=datetime(2026, 7, 5, 18, 0),
                route="boundary",
                train="ICE-LATE",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 15, 10, 0),
                departure=datetime(2026, 7, 16, 10, 0),
                route="select",
                train="ICE-SELECT",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 22, 10, 0),
                departure=datetime(2026, 7, 23, 10, 0),
                route="calibrate",
                train="ICE-CAL",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 29, 10, 0),
                departure=datetime(2026, 7, 30, 10, 0),
                route="test",
                train="ICE-TEST",
                fare=80.0,
            ),
        ],
    )
    config_path = _config(tmp_path)
    raw = json.loads(config_path.read_text())
    raw["report"]["min_eligible_rows"] = 0
    raw["report"]["min_split_positives"] = 0
    raw["report"]["min_band_positives"] = 0
    config_path.write_text(json.dumps(raw))
    connection = duckdb.connect()
    try:
        build_dataset(
            connection,
            SourceSpec(glob=str(source), label="boundary", build_id=None, manifest_sha256=None),
            load_config(config_path),
            tmp_path / "boundary-run",
            run_id="boundary",
        )
    finally:
        connection.close()
    journey = json.loads((tmp_path / "boundary-run" / "profile.json").read_text())["profile"]["journey"]
    assert journey["total_journeys"] == 2
    assert journey["at_risk"] == 1
    assert journey["disappeared"] == 0
    assert journey["groups"] == []


def test_evaluate_test_uses_one_population(tmp_path: Path) -> None:
    source = tmp_path / "mixed-tier.parquet"
    rows = _rows()
    rows.extend(
        [
            _row(
                observed_at=datetime(2026, 7, 27, 10, 0),
                departure=datetime(2026, 7, 28, 10, 0),
                route="mixed-two",
                train="ICE-MIX",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 27, 22, 0),
                departure=datetime(2026, 7, 28, 10, 0),
                route="mixed-two",
                train="ICE-MIX",
                fare=90.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 28, 9, 0),
                departure=datetime(2026, 7, 28, 10, 0),
                route="mixed-two",
                train="ICE-MIX",
                fare=90.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 27, 10, 0),
                departure=datetime(2026, 7, 28, 12, 0),
                route="mixed-one",
                train="ICE-ONE",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 27, 22, 0),
                departure=datetime(2026, 7, 28, 12, 0),
                route="mixed-one",
                train="ICE-ONE",
                fare=90.0,
            ),
        ]
    )
    _write_silver(source, rows)
    config_path = _config(tmp_path)
    raw = json.loads(config_path.read_text())
    raw["report"]["min_eligible_rows"] = 0
    raw["report"]["min_split_positives"] = 0
    raw["report"]["min_band_positives"] = 0
    config_path.write_text(json.dumps(raw))
    out = tmp_path / "mixed-run"
    assert (
        main(
            [
                "--config",
                str(config_path),
                "--source",
                str(source),
                "--out",
                str(out),
                "--evaluate-test",
            ]
        )
        == 0
    )
    metrics = json.loads((out / "metrics.json").read_text())
    assert metrics["evaluation"]["evaluation_on_test"] is True
    assert metrics["evaluation"]["metrics_all"] is None
    assert metrics["evaluation"]["evaluation_tier"] == "all_labelled_rows"
    assert metrics["evaluation"]["evaluation_tier_rows"] >= 1
    calibration_split = next(item for item in metrics["dataset"]["splits"] if item["split"] == "validation_calibrate")
    test_split = next(item for item in metrics["dataset"]["splits"] if item["split"] == "test")
    assert metrics["evaluation"]["calibration_rows"] == calibration_split["labelled"]
    assert metrics["evaluation"]["evaluation_tier_rows"] == test_split["labelled"]
    assert any(item["split"] == "test" for item in metrics["dataset"]["splits"])
    assert "test" in metrics["evaluation"]["split_sizes"]
    assert (out / "predictions" / "test.parquet").is_file()


def test_integer_cent_label_counts_an_exact_limit_as_reached() -> None:
    assert breach(np.array([10_000]), np.array([10_100]), np.array([1])).tolist() == [1]
    assert breach(np.array([10_000]), np.array([10_099]), np.array([1])).tolist() == [0]
    assert cents(np.array([100.0, 101.01, np.nan])).tolist() == [10_000, 10_101, -1]


def test_a29_fixed_five_percent_uses_fixed_five(tmp_path: Path) -> None:
    departure = datetime(2026, 7, 5, 10, 0)
    snapshot = datetime(2026, 7, 3, 10, 0)
    rows = [
        _row(observed_at=snapshot, departure=departure, route="a29", train="ICE-A29", fare=100.0),
        _row(
            observed_at=snapshot + timedelta(hours=4),
            departure=departure,
            route="a29",
            train="ICE-A29",
            fare=100.0,
        ),
        _row(
            observed_at=snapshot + timedelta(hours=8),
            departure=departure,
            route="a29",
            train="ICE-A29",
            fare=104.0,
        ),
        _row(
            observed_at=snapshot + timedelta(hours=12),
            departure=departure,
            route="a29",
            train="ICE-A29",
            fare=104.0,
        ),
        _row(
            observed_at=snapshot + timedelta(hours=16),
            departure=departure,
            route="a29",
            train="ICE-A29",
            fare=106.0,
        ),
        _row(
            observed_at=snapshot + timedelta(hours=20),
            departure=departure,
            route="a29",
            train="ICE-A29",
            fare=104.0,
        ),
        _row(
            observed_at=snapshot + timedelta(hours=24),
            departure=departure,
            route="a29",
            train="ICE-A29",
            fare=104.0,
        ),
    ]
    for index, split_departure in enumerate(
        (
            datetime(2026, 7, 8, 10, 0),
            datetime(2026, 7, 16, 10, 0),
            datetime(2026, 7, 23, 10, 0),
            datetime(2026, 7, 30, 10, 0),
        )
    ):
        rows.append(
            _row(
                observed_at=split_departure - timedelta(days=4),
                departure=split_departure,
                route=f"a29-filler-{index}",
                train=f"ICE-F{index}",
                fare=80.0,
            )
        )
    source = tmp_path / "a29.parquet"
    _write_silver(source, rows)
    config_path = _config(tmp_path)
    config = load_config(config_path)
    connection = duckdb.connect()
    try:
        stats = build_dataset(
            connection,
            SourceSpec(glob=str(source), label="a29", build_id="a29", manifest_sha256=None),
            config,
            tmp_path / "a29-run",
            run_id="a29",
        )
    finally:
        connection.close()
    a29 = [item for item in stats.profile["a29"] if item["split"] == "train" and item["band"] == "1-3d"]
    assert len(a29) == 1
    assert a29[0]["rows"] >= 1
    assert a29[0]["within_day_rate"] == pytest.approx(1.0)
    assert a29[0]["next_day_rate"] == pytest.approx(0.0)
    assert a29[0]["crossed_back_rate"] == pytest.approx(1.0)


def test_dataset_label_counts_an_exact_limit_as_reached(tmp_path: Path) -> None:
    departure = datetime(2026, 7, 5, 10, 0)
    snapshot = datetime(2026, 7, 3, 10, 0)
    rows: list[dict[str, object]] = []
    for index in range(50):
        rows.append(
            _row(
                observed_at=snapshot,
                departure=departure,
                route="exact-limit",
                train=f"ICE-E{index}",
                fare=90.0,
            )
        )
        rows.append(
            _row(
                observed_at=snapshot + timedelta(hours=24),
                departure=departure,
                route="exact-limit",
                train=f"ICE-E{index}",
                fare=99.0,
            )
        )
    for index, split_departure in enumerate(
        (
            datetime(2026, 7, 8, 10, 0),
            datetime(2026, 7, 16, 10, 0),
            datetime(2026, 7, 23, 10, 0),
            datetime(2026, 7, 30, 10, 0),
        )
    ):
        rows.append(
            _row(
                observed_at=split_departure - timedelta(days=4),
                departure=split_departure,
                route=f"exact-filler-{index}",
                train=f"ICE-F{index}",
                fare=80.0,
            )
        )
    source = tmp_path / "exact.parquet"
    _write_silver(source, rows)
    config = load_config(_config(tmp_path))
    connection = duckdb.connect()
    try:
        build_dataset(
            connection,
            SourceSpec(glob=str(source), label="exact", build_id="exact", manifest_sha256=None),
            config,
            tmp_path / "exact-run",
            run_id="exact",
        )
        labelled = connection.execute(
            "SELECT headroom_pct, breached_next_day, count(*) FROM read_parquet(?) "
            "WHERE route_id = 'exact-limit' AND snapshot_at = TIMESTAMP '2026-07-03 10:00:00' "
            "GROUP BY 1, 2 ORDER BY 1, 2",
            [str(tmp_path / "exact-run" / "dataset" / "train.parquet")],
        ).fetchall()
    finally:
        connection.close()
    by_headroom: dict[int, dict[int, int]] = {}
    for headroom, label, count in labelled:
        by_headroom.setdefault(int(headroom), {})[int(label)] = int(count)
    assert by_headroom[10].get(1, 0) > 0  # 99.00 exactly equals 90.00 * 1.10 in cents
    assert by_headroom[10].get(0, 0) == 0
    assert by_headroom[20].get(0, 0) > 0
    assert by_headroom[30].get(0, 0) > 0


def test_breach_sql_counts_an_exact_limit_as_reached() -> None:
    connection = duckdb.connect()
    try:
        row = connection.execute(
            f"SELECT {breach_sql('9900', '9000', '10')}, {breach_sql('9899', '9000', '10')}"
        ).fetchone()
        assert row is not None
        exact, below = row
    finally:
        connection.close()
    assert exact is True
    assert below is False


def test_check_fare_comes_from_the_chain_successor(tmp_path: Path) -> None:
    departure = datetime(2026, 7, 6, 20, 0)
    rows = [
        _row(
            observed_at=datetime(2026, 7, 3, 20, 0), departure=departure, route="chain-fare", train="ICE-CF", fare=80.0
        ),
        _row(
            observed_at=datetime(2026, 7, 4, 10, 0), departure=departure, route="chain-fare", train="ICE-CF", fare=81.0
        ),
        _row(
            observed_at=datetime(2026, 7, 4, 20, 0), departure=departure, route="chain-fare", train="ICE-CF", fare=82.0
        ),
        _row(
            observed_at=datetime(2026, 7, 5, 12, 0), departure=departure, route="chain-fare", train="ICE-CF", fare=85.0
        ),
        _row(
            observed_at=datetime(2026, 7, 5, 10, 0),
            departure=departure,
            arrival_planned=departure + timedelta(hours=4, minutes=16),
            route="chain-fare",
            train="ICE-CF",
            fare=99.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 5, 12, 0),
            departure=departure,
            arrival_planned=departure + timedelta(hours=4, minutes=16),
            route="chain-fare",
            train="ICE-CF",
            fare=98.0,
        ),
    ]
    _, out = _build_chain_dataset(tmp_path, rows)
    predictions = pq.read_table(out / "dataset" / "train.parquet").to_pydict()
    snapshot = [
        index
        for index, route in enumerate(predictions["route_id"])
        if route == "chain-fare"
        and str(predictions["snapshot_at"][index]) == "2026-07-04 10:00:00"
        and predictions["price_eur"][index] == pytest.approx(81.0)
    ]
    assert snapshot
    assert predictions["check_price_eur"][snapshot[0]] == pytest.approx(99.0)
    assert predictions["label_observed"][snapshot[0]] is True
    assert predictions["censor_reason"][snapshot[0]] is None


def test_next_day_label_and_censoring(tmp_path: Path) -> None:
    departure = datetime(2026, 7, 5, 10, 0)
    rows = [
        _row(observed_at=datetime(2026, 7, 3, 10, 0), departure=departure, route="censor", train="ICE-A", fare=80.0),
        _row(observed_at=datetime(2026, 7, 3, 10, 0), departure=departure, route="censor", train="ICE-B", fare=70.0),
        _row(observed_at=datetime(2026, 7, 4, 10, 0), departure=departure, route="censor", train="ICE-B", fare=75.0),
        _row(observed_at=datetime(2026, 7, 3, 10, 0), departure=departure, route="nocheck", train="ICE-C", fare=60.0),
    ]
    _, out = _build_chain_dataset(tmp_path, rows)
    predictions = pq.read_table(out / "dataset" / "train.parquet").to_pydict()
    by_route = {}
    for index, route in enumerate(predictions["route_id"]):
        by_route.setdefault(route, []).append(index)
    labelled = [
        index
        for index in by_route["censor"]
        if predictions["price_eur"][index] == pytest.approx(70.0)
        and str(predictions["snapshot_at"][index]) == "2026-07-03 10:00:00"
    ]
    censored = [
        index
        for index in by_route["censor"]
        if predictions["price_eur"][index] == pytest.approx(80.0)
        and str(predictions["snapshot_at"][index]) == "2026-07-03 10:00:00"
    ]
    assert labelled
    assert censored
    later_b = [
        index
        for index in by_route["censor"]
        if predictions["price_eur"][index] == pytest.approx(75.0)
        and str(predictions["snapshot_at"][index]) == "2026-07-04 10:00:00"
    ]
    assert later_b
    assert predictions["eligible"][later_b[0]] is False
    assert predictions["eligible"][labelled[0]] is True
    assert predictions["label_observed"][labelled[0]] is True
    assert predictions["check_price_eur"][labelled[0]] == pytest.approx(75.0)
    assert str(predictions["label_window_end"][labelled[0]]) == "2026-07-04 10:00:00"
    assert predictions["eligible"][censored[0]] is True
    assert predictions["label_observed"][censored[0]] is False
    assert predictions["breached_next_day"][censored[0]] is None
    assert predictions["censor_reason"][censored[0]] == "not_listed"
    assert str(predictions["label_window_end"][censored[0]]) == "2026-07-04 10:00:00"
    nocheck = by_route["nocheck"][0]
    assert predictions["eligible"][nocheck] is False
    assert predictions["label_observed"][nocheck] is False
    assert predictions["censor_reason"][nocheck] == "no_check"
    assert predictions["breached_next_day"][nocheck] is None
    assert predictions["fare_lost"][nocheck] is False


def test_chain_links_causally_and_splits_a_later_return(tmp_path: Path) -> None:
    departure = datetime(2026, 7, 8, 20, 0)
    rows = [
        _row(observed_at=datetime(2026, 7, 5, 20, 0), departure=departure, route="causal", train="ICE-C", fare=80.0),
        _row(observed_at=datetime(2026, 7, 6, 20, 0), departure=departure, route="causal", train="ICE-C", fare=82.0),
        _row(
            observed_at=datetime(2026, 7, 7, 10, 0),
            departure=departure,
            arrival_planned=departure + timedelta(hours=4, minutes=16),
            route="causal",
            train="ICE-C",
            fare=99.0,
        ),
        _row(observed_at=datetime(2026, 7, 7, 12, 0), departure=departure, route="causal", train="ICE-C", fare=85.0),
        _row(
            observed_at=datetime(2026, 7, 7, 12, 0),
            departure=departure,
            arrival_planned=departure + timedelta(hours=4, minutes=16),
            route="causal",
            train="ICE-C",
            fare=98.0,
        ),
    ]
    stats, out = _build_chain_dataset(tmp_path, rows)
    predictions = pq.read_table(out / "dataset" / "train.parquet").to_pydict()
    causal_rows = [index for index, route in enumerate(predictions["route_id"]) if route == "causal"]
    assert len(causal_rows) == 5  # five snapshots, with no join fan-out
    by_time = {
        (str(predictions["snapshot_at"][index]), float(predictions["price_eur"][index])): index for index in causal_rows
    }
    assert (
        predictions["chain_id"][by_time[("2026-07-06 20:00:00", 82.0)]]
        == predictions["chain_id"][by_time[("2026-07-07 10:00:00", 99.0)]]
    )
    assert (
        predictions["chain_id"][by_time[("2026-07-07 12:00:00", 85.0)]]
        != predictions["chain_id"][by_time[("2026-07-06 20:00:00", 82.0)]]
    )
    assert stats.profile["chain"]["split_series"] >= 1
    assert stats.profile["chain"]["links"] >= 1


def test_check_grid_and_coverage(tmp_path: Path) -> None:
    departure = datetime(2026, 7, 5, 10, 0)
    source = tmp_path / "check-grid.parquet"
    _write_silver(
        source,
        [
            _row(
                observed_at=departure - timedelta(hours=47),
                departure=departure,
                route="check",
                train="ICE-CHECK",
                fare=80.0,
            ),
            _row(
                observed_at=departure - timedelta(hours=24),
                departure=departure,
                route="check",
                train="ICE-CHECK",
                fare=90.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 15, 10, 0),
                departure=datetime(2026, 7, 16, 10, 0),
                route="select",
                train="ICE-SELECT",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 22, 10, 0),
                departure=datetime(2026, 7, 23, 10, 0),
                route="calibrate",
                train="ICE-CAL",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 29, 10, 0),
                departure=datetime(2026, 7, 30, 10, 0),
                route="test",
                train="ICE-TEST",
                fare=80.0,
            ),
        ],
    )
    config_path = _config(tmp_path)
    raw = json.loads(config_path.read_text())
    raw["report"]["min_eligible_rows"] = 0
    raw["report"]["min_split_positives"] = 0
    raw["report"]["min_band_positives"] = 0
    config_path.write_text(json.dumps(raw))
    config = load_config(config_path)
    connection = duckdb.connect()
    try:
        build_dataset(
            connection,
            SourceSpec(glob=str(source), label="check", build_id=None, manifest_sha256=None),
            config,
            tmp_path / "check-run",
            run_id="check",
        )
        row = connection.execute(
            "SELECT check_at, check_lag_h, check_price_eur, cov_tail_h, cov_max_gap_h, r24_covered, "
            "check_at_2024, check_at_2226, check_price_2024_eur, check_price_2226_eur, label_window_end "
            "FROM read_parquet(?) WHERE snapshot_at = TIMESTAMP '2026-07-03 11:00:00'",
            [str(tmp_path / "check-run" / "dataset" / "train.parquet")],
        ).fetchone()
    finally:
        connection.close()
    assert row is not None
    assert str(row[0]) == "2026-07-04 10:00:00"
    assert row[1] == pytest.approx(-1.0)
    assert row[2] == pytest.approx(90.0)
    assert row[3] == pytest.approx(1.0)
    assert row[4] == pytest.approx(23.0)
    assert row[5] is False
    assert str(row[6]) == "2026-07-04 10:00:00"
    assert str(row[7]) == "2026-07-04 10:00:00"
    assert row[8] == pytest.approx(90.0)
    assert row[9] == pytest.approx(90.0)
    assert str(row[10]) == "2026-07-04 10:00:00"  # check_at, not the nominal t+24 h (11:00)


def test_r24_share_ignores_out_of_domain_rows(tmp_path: Path) -> None:
    departure = datetime(2026, 7, 5, 10, 0)
    start = departure - timedelta(hours=48)
    rows = [
        _row(
            observed_at=start + timedelta(hours=offset),
            departure=departure,
            route="r24",
            train="ICE-R24",
            fare=80.0 + offset / 10,
        )
        for offset in range(0, 25, 4)
    ]
    long_departure = datetime(2026, 7, 8, 10, 0)
    rows.append(
        _row(
            observed_at=long_departure - timedelta(days=20),
            departure=long_departure,
            route="long",
            train="ICE-LONG",
            fare=80.0,
        )
    )
    for index, split_departure in enumerate(
        (
            datetime(2026, 7, 16, 10, 0),
            datetime(2026, 7, 23, 10, 0),
            datetime(2026, 7, 30, 10, 0),
        )
    ):
        rows.append(
            _row(
                observed_at=split_departure - timedelta(days=4),
                departure=split_departure,
                route=f"r24-filler-{index}",
                train=f"ICE-F{index}",
                fare=80.0,
            )
        )
    source = tmp_path / "r24.parquet"
    _write_silver(source, rows)
    config_path = _config(tmp_path)
    config = load_config(config_path)
    connection = duckdb.connect()
    try:
        stats = build_dataset(
            connection,
            SourceSpec(glob=str(source), label="r24", build_id="r24", manifest_sha256=None),
            config,
            tmp_path / "r24-run",
            run_id="r24",
        )
    finally:
        connection.close()
    train = next(item for item in stats.profile["coverage"] if item["split"] == "train")
    # Two of the seven in-domain snapshots are R24-covered; the 14-30 d row is NULL and must
    # not enter the denominator (the old CASE would have made it 2/8).
    assert train["r24_share"] == pytest.approx(2 / 7)


def test_narrow_primary_window_keeps_the_wider_diagnostics(tmp_path: Path) -> None:
    snapshot = datetime(2026, 7, 3, 11, 0)
    departure = snapshot + timedelta(hours=48)
    rows = [
        _row(observed_at=snapshot, departure=departure, route="narrow", train="ICE-N", fare=80.0),
        _row(
            observed_at=snapshot + timedelta(hours=21),
            departure=departure,
            route="narrow",
            train="ICE-N",
            fare=90.0,
        ),
        _row(
            observed_at=snapshot + timedelta(hours=26),
            departure=departure,
            route="narrow",
            train="ICE-N",
            fare=95.0,
        ),
    ]
    for index, split_departure in enumerate(
        (
            datetime(2026, 7, 8, 10, 0),
            datetime(2026, 7, 16, 10, 0),
            datetime(2026, 7, 23, 10, 0),
            datetime(2026, 7, 30, 10, 0),
        )
    ):
        rows.append(
            _row(
                observed_at=split_departure - timedelta(days=4),
                departure=split_departure,
                route=f"narrow-filler-{index}",
                train=f"ICE-F{index}",
                fare=80.0,
            )
        )
    source = tmp_path / "narrow.parquet"
    _write_silver(source, rows)
    config_path = _config(tmp_path)
    raw = json.loads(config_path.read_text())
    raw["label"]["check_window_hours"] = [22, 26]
    config_path.write_text(json.dumps(raw))
    connection = duckdb.connect()
    try:
        build_dataset(
            connection,
            SourceSpec(glob=str(source), label="narrow", build_id="narrow", manifest_sha256=None),
            load_config(config_path),
            tmp_path / "narrow-run",
            run_id="narrow",
        )
        row = connection.execute(
            "SELECT check_at, check_at_2024, check_at_2226 FROM read_parquet(?) "
            "WHERE route_id = 'narrow' AND snapshot_at = ?",
            [str(tmp_path / "narrow-run" / "dataset" / "train.parquet"), snapshot],
        ).fetchone()
    finally:
        connection.close()
    assert row is not None
    assert str(row[0]) == "2026-07-04 13:00:00"  # primary 22-26 h
    assert str(row[1]) == "2026-07-04 08:00:00"  # 20-24 h diagnostic keeps the 21 h scrape
    assert str(row[2]) == "2026-07-04 13:00:00"  # 22-26 h diagnostic


def test_check_windows_distinguish_late_checks(tmp_path: Path) -> None:
    snapshot = datetime(2026, 7, 3, 11, 0)
    departure = snapshot + timedelta(hours=48)
    source = tmp_path / "windows.parquet"
    _write_silver(
        source,
        [
            _row(observed_at=snapshot, departure=departure, route="only25", train="ICE-25", fare=80.0),
            _row(
                observed_at=snapshot + timedelta(hours=25),
                departure=departure,
                route="only25",
                train="ICE-25",
                fare=90.0,
            ),
            _row(observed_at=snapshot, departure=departure, route="only265", train="ICE-265", fare=80.0),
            _row(
                observed_at=snapshot + timedelta(hours=26, minutes=30),
                departure=departure,
                route="only265",
                train="ICE-265",
                fare=95.0,
            ),
            _row(
                observed_at=snapshot,
                departure=snapshot + timedelta(hours=24, minutes=30),
                route="after",
                train="ICE-EARLY",
                fare=80.0,
            ),
            _row(
                observed_at=snapshot + timedelta(hours=25),
                departure=snapshot + timedelta(hours=33),
                route="after",
                train="ICE-LATE",
                fare=90.0,
            ),
            _row(observed_at=snapshot, departure=departure, route="atearly", train="ICE-20", fare=80.0),
            _row(
                observed_at=snapshot + timedelta(hours=20),
                departure=departure,
                route="atearly",
                train="ICE-20",
                fare=90.0,
            ),
            _row(observed_at=snapshot, departure=departure, route="atlate", train="ICE-28", fare=80.0),
            _row(
                observed_at=snapshot + timedelta(hours=28),
                departure=departure,
                route="atlate",
                train="ICE-28",
                fare=90.0,
            ),
            _row(observed_at=snapshot, departure=departure, route="tooearly", train="ICE-EARLY", fare=80.0),
            _row(
                observed_at=snapshot + timedelta(hours=19),
                departure=departure,
                route="tooearly",
                train="ICE-EARLY",
                fare=90.0,
            ),
            _row(observed_at=snapshot, departure=departure, route="toolate", train="ICE-LATE", fare=80.0),
            _row(
                observed_at=snapshot + timedelta(hours=29),
                departure=departure,
                route="toolate",
                train="ICE-LATE",
                fare=90.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 15, 10, 0),
                departure=datetime(2026, 7, 16, 10, 0),
                route="select",
                train="ICE-SELECT",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 22, 10, 0),
                departure=datetime(2026, 7, 23, 10, 0),
                route="calibrate",
                train="ICE-CAL",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 29, 10, 0),
                departure=datetime(2026, 7, 30, 10, 0),
                route="test",
                train="ICE-TEST",
                fare=80.0,
            ),
        ],
    )
    config_path = _config(tmp_path)
    raw = json.loads(config_path.read_text())
    raw["report"]["min_eligible_rows"] = 0
    raw["report"]["min_split_positives"] = 0
    raw["report"]["min_band_positives"] = 0
    config_path.write_text(json.dumps(raw))
    connection = duckdb.connect()
    try:
        build_dataset(
            connection,
            SourceSpec(glob=str(source), label="windows", build_id=None, manifest_sha256=None),
            load_config(config_path),
            tmp_path / "windows-run",
            run_id="windows",
        )
        rows = connection.execute(
            "SELECT route_id, check_at, check_at_2024, check_at_2226, "
            "check_price_eur, check_price_2024_eur, check_price_2226_eur FROM read_parquet(?) "
            "WHERE snapshot_at = TIMESTAMP '2026-07-03 11:00:00' ORDER BY route_id",
            [str(tmp_path / "windows-run" / "dataset" / "train.parquet")],
        ).fetchall()
    finally:
        connection.close()
    by_route = {row[0]: row for row in rows}
    only25 = by_route["only25"]
    assert str(only25[1]) == "2026-07-04 12:00:00"
    assert only25[2] is None
    assert str(only25[3]) == "2026-07-04 12:00:00"
    assert only25[4] == pytest.approx(90.0)
    assert only25[5] is None
    assert only25[6] == pytest.approx(90.0)
    only265 = by_route["only265"]
    assert str(only265[1]) == "2026-07-04 13:30:00"
    assert only265[2] is None
    assert only265[3] is None
    assert only265[4] == pytest.approx(95.0)
    assert only265[5] is None
    assert only265[6] is None
    after = by_route["after"]
    assert after[1] is None
    assert after[2] is None
    assert after[3] is None
    assert after[4] is None
    assert after[5] is None
    assert after[6] is None
    for route in ("tooearly", "toolate"):
        row = by_route[route]
        assert row[1] is None
        assert row[2] is None
        assert row[3] is None
        assert row[4] is None
    atearly = by_route["atearly"]
    assert str(atearly[1]) == "2026-07-04 07:00:00"
    assert atearly[4] == pytest.approx(90.0)
    atlate = by_route["atlate"]
    assert str(atlate[1]) == "2026-07-04 15:00:00"
    assert atlate[4] == pytest.approx(90.0)


def test_check_grid_uses_microsecond_distance(tmp_path: Path) -> None:
    snapshot = datetime(2026, 7, 3, 10, 0, 0, 900_000)
    departure = snapshot + timedelta(hours=48)
    target = snapshot + timedelta(hours=24)
    source = tmp_path / "microseconds.parquet"
    _write_silver(
        source,
        [
            _row(observed_at=snapshot, departure=departure, route="subsecond", train="ICE-SUB", fare=80.0),
            _row(
                observed_at=target - timedelta(milliseconds=800),
                departure=departure,
                route="subsecond",
                train="ICE-SUB",
                fare=88.0,
            ),
            _row(
                observed_at=target + timedelta(milliseconds=100),
                departure=departure,
                route="subsecond",
                train="ICE-SUB",
                fare=96.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 15, 10, 0),
                departure=datetime(2026, 7, 16, 10, 0),
                route="select",
                train="ICE-SELECT",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 22, 10, 0),
                departure=datetime(2026, 7, 23, 10, 0),
                route="calibrate",
                train="ICE-CAL",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 29, 10, 0),
                departure=datetime(2026, 7, 30, 10, 0),
                route="test",
                train="ICE-TEST",
                fare=80.0,
            ),
        ],
    )
    config_path = _config(tmp_path)
    raw = json.loads(config_path.read_text())
    raw["report"]["min_eligible_rows"] = 0
    raw["report"]["min_split_positives"] = 0
    raw["report"]["min_band_positives"] = 0
    config_path.write_text(json.dumps(raw))
    connection = duckdb.connect()
    try:
        build_dataset(
            connection,
            SourceSpec(glob=str(source), label="microseconds", build_id=None, manifest_sha256=None),
            load_config(config_path),
            tmp_path / "microseconds-run",
            run_id="microseconds",
        )
        row = connection.execute(
            "SELECT check_at, check_price_eur FROM read_parquet(?) "
            "WHERE route_id = 'subsecond' AND snapshot_at = TIMESTAMP '2026-07-03 10:00:00.900'",
            [str(tmp_path / "microseconds-run" / "dataset" / "train.parquet")],
        ).fetchone()
    finally:
        connection.close()
    assert row is not None
    assert str(row[0]) == "2026-07-04 10:00:01"
    assert row[1] == pytest.approx(96.0)


def test_check_grid_tie_prefers_earlier_scrape(tmp_path: Path) -> None:
    departure = datetime(2026, 7, 5, 12, 0)
    snapshot = departure - timedelta(hours=46)
    source = tmp_path / "tie.parquet"
    _write_silver(
        source,
        [
            _row(observed_at=snapshot, departure=departure, route="tie", train="ICE-TIE", fare=80.0),
            _row(
                observed_at=snapshot + timedelta(hours=22),
                departure=departure,
                route="tie",
                train="ICE-TIE",
                fare=88.0,
            ),
            _row(
                observed_at=snapshot + timedelta(hours=26),
                departure=departure,
                route="tie",
                train="ICE-TIE",
                fare=99.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 15, 10, 0),
                departure=datetime(2026, 7, 16, 10, 0),
                route="select",
                train="ICE-SELECT",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 22, 10, 0),
                departure=datetime(2026, 7, 23, 10, 0),
                route="calibrate",
                train="ICE-CAL",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 29, 10, 0),
                departure=datetime(2026, 7, 30, 10, 0),
                route="test",
                train="ICE-TEST",
                fare=80.0,
            ),
        ],
    )
    config_path = _config(tmp_path)
    raw = json.loads(config_path.read_text())
    raw["report"]["min_eligible_rows"] = 0
    raw["report"]["min_split_positives"] = 0
    raw["report"]["min_band_positives"] = 0
    config_path.write_text(json.dumps(raw))
    connection = duckdb.connect()
    try:
        build_dataset(
            connection,
            SourceSpec(glob=str(source), label="tie", build_id=None, manifest_sha256=None),
            load_config(config_path),
            tmp_path / "tie-run",
            run_id="tie",
        )
        row = connection.execute(
            "SELECT check_at, check_price_eur FROM read_parquet(?) WHERE snapshot_at = TIMESTAMP '2026-07-03 14:00:00'",
            [str(tmp_path / "tie-run" / "dataset" / "train.parquet")],
        ).fetchone()
    finally:
        connection.close()
    assert row is not None
    assert str(row[0]) == "2026-07-04 12:00:00"
    assert row[1] == pytest.approx(88.0)


def test_two_builds_have_same_content_digest(tmp_path: Path) -> None:
    source = tmp_path / "silver.parquet"
    _write_silver(source, _rows())
    config = load_config(_config(tmp_path))
    digests = []
    for name in ("a", "b"):
        connection = duckdb.connect()
        try:
            build_dataset(
                connection,
                SourceSpec(glob=str(source), label="test", build_id=None, manifest_sha256=None),
                config,
                tmp_path / name,
                run_id=name,
            )
        finally:
            connection.close()
        manifest = json.loads((tmp_path / name / "dataset_manifest.json").read_text())
        digests.append(next(item for item in manifest["dataset_files"] if item["split"] == "train"))
    assert digests[0]["sum64"] == digests[1]["sum64"]
    assert digests[0]["xor64"] == digests[1]["xor64"]
    assert digests[0]["rows"] == digests[1]["rows"]
    # The content digest must reproduce from the written Parquet, not only from the in-memory relation.
    columns = _final_columns("full")
    payload = ", ".join(f"coalesce(CAST({column} AS VARCHAR), '<null>')" for column in columns)
    hash_expression = f"CAST(('0x' || substr(sha256(concat_ws('|', {payload})), 1, 16)) AS UBIGINT)"
    connection = duckdb.connect()
    try:
        row = connection.execute(
            f"SELECT count(*), sum({hash_expression}), bit_xor({hash_expression}) "
            f"FROM read_parquet('{(tmp_path / 'a' / 'dataset' / 'train.parquet').as_posix()}')"
        ).fetchone()
    finally:
        connection.close()
    assert row == (digests[0]["rows"], digests[0]["sum64"], digests[0]["xor64"])
    # The byte hash is the guard for the total ORDER BY: the content digest is order-independent.
    assert digests[0]["sha256"] == digests[1]["sha256"]


def test_unknown_git_state_is_not_reported_as_clean(monkeypatch: pytest.MonkeyPatch) -> None:
    import subprocess

    def fail(*args: object, **kwargs: object) -> str:
        raise OSError("git is unavailable")

    monkeypatch.setattr(subprocess, "check_output", fail)
    assert _git_state() == (None, None, ())


def test_git_state_ignores_untracked_files_outside_analytics(tmp_path: Path) -> None:
    import subprocess

    repo = tmp_path / "repo"
    (repo / "analytics").mkdir(parents=True)
    (repo / "docs").mkdir()
    (repo / "analytics" / "tracked.py").write_text("x", encoding="utf-8")
    (repo / "docs" / "tracked.txt").write_text("x", encoding="utf-8")
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    subprocess.run(
        ["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"],
        cwd=repo,
        check=True,
    )
    (repo / "docs" / "explainer.html").write_text("user work", encoding="utf-8")
    sha, dirty, outside = _git_state(repo)
    assert sha
    assert dirty is False
    assert outside == ("docs/explainer.html",)
    (repo / "analytics" / "untracked.py").write_text("x", encoding="utf-8")
    _, dirty, _ = _git_state(repo)
    assert dirty is True
    (repo / "analytics" / "untracked.py").unlink()
    (repo / "analytics" / "tracked.py").write_text("changed", encoding="utf-8")
    _, dirty, _ = _git_state(repo)
    assert dirty is True
    (repo / "analytics" / "tracked.py").write_text("x", encoding="utf-8")
    (repo / "docs" / "tracked.txt").write_text("changed", encoding="utf-8")
    _, dirty, _ = _git_state(repo)
    assert dirty is True


def test_column_roles_and_source_inventory(tmp_path: Path) -> None:
    _, out = _build(tmp_path)
    roles = json.loads((out / "column_roles.json").read_text())
    manifest = json.loads((out / "dataset_manifest.json").read_text())
    assert manifest["column_roles"] == "column_roles.json"
    assert roles["version"] == 2
    assert roles["candidate_feature"] == []
    assert set(roles["features"]) == set(feature_spec("full").names)
    assert not set(roles["features"]) & set(roles["labels"])
    assert not set(roles["features"]) & set(roles["audit"])
    assert not set(roles["labels"]) & set(roles["audit"])
    assert set(roles["features"] + roles["labels"] + roles["audit"]) == set(_final_columns("full"))
    assert manifest["source_inventory"]
    assert all(item["sha256"] and item["bytes"] for item in manifest["source_inventory"])
    assert manifest["dataset_peak_rss_kb"] > 0


def test_future_mutation_changes_label_not_features(tmp_path: Path) -> None:
    departure = datetime(2026, 7, 10, 10, 0)

    def window_row(observed_at: datetime, fare: float) -> dict[str, object]:
        return _row(
            observed_at=observed_at,
            departure=departure,
            route="future",
            train="ICE4",
            fare=fare,
        )

    extra = [
        _row(
            observed_at=datetime(2026, 7, 2, 10, 0),
            departure=datetime(2026, 7, 12, 10, 0),
            route="v",
            train="ICE2",
            fare=80.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 12, 10, 0),
            departure=datetime(2026, 7, 22, 10, 0),
            route="c",
            train="ICE3",
            fare=80.0,
        ),
        _row(
            observed_at=datetime(2026, 7, 22, 10, 0),
            departure=datetime(2026, 8, 1, 10, 0),
            route="t",
            train="ICE5",
            fare=80.0,
        ),
    ]
    raw = json.loads(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))
    raw["splits"] = SPLITS
    raw["calendar"]["feature_set"] = "none"
    raw["sample"]["sample_rate"] = 1.0
    raw["report"]["min_headroom_positives"] = 0
    raw["report"]["min_eligible_rows"] = 0
    raw["report"]["min_split_positives"] = 0
    raw["report"]["min_band_positives"] = 0
    config_path = tmp_path / "future.json"
    config_path.write_text(json.dumps(raw), encoding="utf-8")
    config = load_config(config_path)
    outputs = []
    for name, future_fare in (("low", 100.0), ("high", 120.0)):
        source = tmp_path / f"{name}.parquet"
        rows = [
            window_row(departure - timedelta(hours=54), 90.0),
            window_row(departure - timedelta(hours=30), 100.0),
            window_row(departure - timedelta(hours=10), future_fare),
            *extra,
        ]
        _write_silver(source, rows)
        connection = duckdb.connect()
        try:
            build_dataset(
                connection,
                SourceSpec(glob=str(source), label=name, build_id=None, manifest_sha256=None),
                config,
                tmp_path / name,
                run_id=name,
            )
        finally:
            connection.close()
        outputs.append(load_split(tmp_path / name / "dataset" / "train.parquet", feature_spec("none")))
    low, high = outputs
    low_index = int(np.flatnonzero(low.price == 100.0)[0])
    high_index = int(np.flatnonzero(high.price == 100.0)[0])
    for name in low.features:
        np.testing.assert_equal(low.features[name][low_index], high.features[name][high_index])
    assert float(low.future_max[low_index]) != float(high.future_max[high_index])


def test_train_evaluate_is_permutation_invariant(tmp_path: Path) -> None:
    _, out = _build(tmp_path)
    spec = feature_spec("full")
    splits = {
        name: load_split(out / "dataset" / f"{name}.parquet", spec)
        for name in ("train", "validation_select", "validation_calibrate", "test")
    }
    config = load_config(_config(tmp_path))
    first, _, _ = train_and_evaluate(splits, spec, config)
    rng = np.random.default_rng(11)
    shuffled = {name: data.subset(rng.permutation(len(data))) for name, data in splits.items()}
    second, _, _ = train_and_evaluate(shuffled, spec, config)
    assert first.metrics["brier"] == pytest.approx(second.metrics["brier"], rel=1e-6)
    assert first.metrics["log_loss"] == pytest.approx(second.metrics["log_loss"], rel=1e-6)

    def stable(value: object) -> object:
        if isinstance(value, float):
            return round(value, 6)
        if isinstance(value, dict):
            return {key: stable(item) for key, item in value.items()}
        if isinstance(value, list):
            return [stable(item) for item in value]
        return value

    first_digest = hashlib.sha256(json.dumps(stable(first.to_dict()), sort_keys=True, default=str).encode()).hexdigest()
    second_digest = hashlib.sha256(
        json.dumps(stable(second.to_dict()), sort_keys=True, default=str).encode()
    ).hexdigest()
    assert first_digest == second_digest


def test_load_split_rejects_a_corrupted_label(tmp_path: Path) -> None:
    _, out = _build(tmp_path)
    source = out / "dataset" / "train.parquet"
    broken = tmp_path / "broken.parquet"
    table = pq.read_table(source)
    payload = table.to_pydict()
    payload["breached_next_day"][0] = 1 - payload["breached_next_day"][0]
    pq.write_table(pa.table(payload), broken)
    with pytest.raises(ModelError, match="disagree"):
        load_split(broken, feature_spec("full"))


def test_calibrator_outputs_are_bounded() -> None:
    rng = np.random.default_rng(5)
    raw = rng.random(1000)
    y = rng.integers(0, 2, size=1000)
    calibrator = fit_calibrator(raw, y, "isotonic", min_positives=1)
    probabilities = calibrator.predict(raw)
    assert probabilities.min() >= 1e-6
    assert probabilities.max() <= 1.0 - 1e-6
    constant = fit_calibrator(raw, np.ones(len(raw), dtype=np.int8), "sigmoid", min_positives=1)
    extreme = constant.predict(np.array([0.0, 1.0]))
    assert np.all(extreme > 0.0)
    assert np.all(extreme < 1.0)
    # The static legacy path keeps its 1e-3 clip so its reference predictions stay byte-identical.
    legacy = fit_calibrator(raw, np.zeros(len(raw), dtype=np.int8), "sigmoid", min_positives=1, epsilon=1e-3)
    assert np.allclose(legacy.predict(np.array([0.0, 1.0])), 1e-3)
    modern = fit_calibrator(raw, np.zeros(len(raw), dtype=np.int8), "sigmoid", min_positives=1)
    assert np.allclose(modern.predict(np.array([0.0, 1.0])), 1e-6)
    # Two classes actually reach the sigmoid branch; single-class labels hit the constant branch.
    two_raw = np.r_[np.full(500, 1e-6), np.full(500, 1.0 - 1e-6)]
    two_y = np.r_[np.zeros(500, dtype=np.int8), np.ones(500, dtype=np.int8)]
    sigmoid = fit_calibrator(two_raw, two_y, "sigmoid", min_positives=1, epsilon=1e-3)
    bounded = sigmoid.predict(np.array([0.0, 1.0]))
    assert bounded.min() >= 1e-3
    assert bounded.max() <= 1.0 - 1e-3


def test_load_model_rejects_wrong_hash(tmp_path: Path) -> None:
    path = tmp_path / "model.joblib"
    path.write_bytes(b"not a model")
    with pytest.raises(Exception, match="hash mismatch"):
        load_model(path, "0" * 64)


def test_empty_configured_split_fails_cleanly(tmp_path: Path) -> None:
    source = tmp_path / "empty-split.parquet"
    _write_silver(
        source,
        [
            _row(
                observed_at=datetime(2026, 7, 1, 10, 0),
                departure=datetime(2026, 7, 5, 10, 0),
                route="train",
                train="ICE1",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 26, 10, 0),
                departure=datetime(2026, 7, 30, 10, 0),
                route="test",
                train="ICE2",
                fare=80.0,
            ),
        ],
    )
    raw = json.loads(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))
    raw["splits"] = SPLITS
    raw["calendar"]["feature_set"] = "none"
    raw["sample"]["sample_rate"] = 1.0
    raw["report"]["min_headroom_positives"] = 0
    raw["report"]["min_eligible_rows"] = 0
    raw["report"]["min_split_positives"] = 0
    raw["report"]["min_band_positives"] = 0
    config_path = tmp_path / "empty-split.json"
    config_path.write_text(json.dumps(raw), encoding="utf-8")
    config = load_config(config_path)
    connection = duckdb.connect()
    try:
        with pytest.raises(DatasetError, match="missing split"):
            build_dataset(
                connection,
                SourceSpec(glob=str(source), label="empty", build_id=None, manifest_sha256=None),
                config,
                tmp_path / "empty-run",
                run_id="empty",
            )
        assert not list((tmp_path / "empty-run" / "dataset").glob("*.parquet"))
    finally:
        connection.close()


def test_failed_build_leaves_output_directory_reusable(tmp_path: Path) -> None:
    source = tmp_path / "reusable.parquet"
    departures = {
        "train": datetime(2026, 7, 5, 10, 0),
        "validation_select": datetime(2026, 7, 16, 10, 0),
        "validation_calibrate": datetime(2026, 7, 23, 10, 0),
        "test": datetime(2026, 7, 30, 10, 0),
    }
    _write_silver(
        source,
        [
            _row(
                observed_at=departure - timedelta(days=4),
                departure=departure,
                route=split,
                train=f"ICE-{split}",
                fare=80.0,
            )
            for split, departure in departures.items()
        ],
    )
    raw = json.loads(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))
    raw["splits"] = SPLITS
    raw["calendar"]["feature_set"] = "none"
    raw["sample"]["sample_rate"] = 1.0
    raw["report"]["min_headroom_positives"] = 0
    raw["report"]["min_eligible_rows"] = 0
    raw["report"]["min_split_positives"] = 0
    raw["report"]["min_band_positives"] = 0
    raw["report"]["min_eligible_rows"] = 1
    config_path = tmp_path / "coverage-gate.json"
    config_path.write_text(json.dumps(raw), encoding="utf-8")
    config = load_config(config_path)
    spec = SourceSpec(glob=str(source), label="reusable", build_id=None, manifest_sha256=None)
    out = tmp_path / "reusable-run"
    connection = duckdb.connect()
    try:
        with pytest.raises(DatasetError, match="eligible rows"):
            build_dataset(connection, spec, config, out, run_id="reusable")
    finally:
        connection.close()
    assert not out.exists()
    permissive = replace(config, report=replace(config.report, min_eligible_rows=0))
    connection = duckdb.connect()
    try:
        build_dataset(connection, spec, permissive, out, run_id="reusable")
    finally:
        connection.close()
    assert (out / "dataset" / "train.parquet").is_file()


def test_backtest_fold_gate_and_baseline_isolation(tmp_path: Path) -> None:
    _, out = _build(tmp_path)
    spec = feature_spec("full")
    panel = load_panel(out, spec)
    config = load_config(_config(tmp_path))
    protocol = ProtocolConfig(
        "backtest",
        (FoldConfig(date(2026, 7, 6), "development", "dev"),),
    )
    config = replace(config, protocol=protocol)
    fold = protocol.cutoffs[0]
    masks = fold_masks(panel, fold, protocol)
    train, calibrate, test = fold_slices(panel, masks)
    recipe = Recipe(
        model="base_rate",
        calibration="sigmoid",
        threshold_floor=0.7,
        model_settings={
            "max_iter": config.model.max_iter,
            "learning_rate": config.model.learning_rate,
            "max_leaf_nodes": config.model.max_leaf_nodes,
            "random_state": config.model.random_state,
        },
    )
    base = fit_fold(recipe, fold, train, calibrate, test, config, spec)
    mutated = fit_fold(
        recipe,
        fold,
        train,
        calibrate,
        replace(test, y=1 - test.y),
        config,
        spec,
    )
    if test.check_price_cents is not None:
        price_mutated = fit_fold(
            recipe,
            fold,
            train,
            calibrate,
            replace(test, check_price_cents=test.check_price_cents * 2),
            config,
            spec,
        )
        for headroom in config.label.headroom_pct:
            assert np.array_equal(base.probabilities[headroom], price_mutated.probabilities[headroom])
    assert np.array_equal(base.calibrated, mutated.calibrated)
    assert np.array_equal(base.raw, mutated.raw)
    assert base.threshold == mutated.threshold
    assert base.threshold_met == mutated.threshold_met
    assert base.train_rate == mutated.train_rate
    assert base.metrics["alert_share"] == mutated.metrics["alert_share"]
    for headroom in config.label.headroom_pct:
        assert np.array_equal(base.climate[headroom], mutated.climate[headroom])
        assert np.array_equal(base.probabilities[headroom], mutated.probabilities[headroom])
    strict = replace(config, report=replace(config.report, min_band_positives=10**9))
    with pytest.raises(DatasetError, match="band"):
        fit_fold(recipe, fold, train, calibrate, test, strict, spec)


def test_fit_fold_uses_the_frozen_recipe(tmp_path: Path) -> None:
    _, out = _build(tmp_path)
    spec = feature_spec("full")
    panel = load_panel(out, spec)
    config = load_config(_config(tmp_path))
    fold = FoldConfig(date(2026, 7, 6), "development", "dev")
    protocol = ProtocolConfig("backtest", (fold,))
    config = replace(config, protocol=protocol)
    masks = fold_masks(panel, fold, protocol)
    train, calibrate, test = fold_slices(panel, masks)
    settings = {
        "max_iter": 2,
        "learning_rate": config.model.learning_rate,
        "max_leaf_nodes": 3,
        "random_state": config.model.random_state,
    }
    recipe = Recipe("hist_gradient_boosting", "temperature", 0.4, settings)
    small = fit_fold(recipe, fold, train, calibrate, test, config, spec)
    large = fit_fold(
        replace(recipe, model_settings={**settings, "max_iter": 80}),
        fold,
        train,
        calibrate,
        test,
        config,
        spec,
    )
    assert not np.allclose(small.raw, large.raw)
    assert small.early_stopping is not None
    assert small.early_stopping["iterations"] <= 2
    assert large.early_stopping is not None
    assert large.early_stopping["iterations"] <= 80
    assert small.early_stopping["holdout_rows"] > 0
    sigmoid = fit_fold(replace(recipe, calibration="sigmoid"), fold, train, calibrate, test, config, spec)
    assert not np.allclose(small.calibrated, sigmoid.calibrated)
    higher_floor = fit_fold(replace(recipe, threshold_floor=0.9), fold, train, calibrate, test, config, spec)
    assert higher_floor.threshold != small.threshold
    base = fit_fold(replace(recipe, model="base_rate"), fold, train, calibrate, test, config, spec)
    assert np.unique(base.raw).size <= len(config.label.headroom_pct)


def test_calibration_cross_fit_uses_departure_date(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _, out = _build(tmp_path)
    spec = feature_spec("full")
    panel = load_panel(out, spec)
    config = load_config(_config(tmp_path))
    fold = FoldConfig(date(2026, 7, 6), "development", "dev")
    protocol = ProtocolConfig("backtest", (fold,))
    config = replace(config, protocol=protocol)
    masks = fold_masks(panel, fold, protocol)
    train, calibrate, test = fold_slices(panel, masks)
    recipe = Recipe(
        "base_rate",
        "sigmoid",
        0.7,
        {
            "max_iter": config.model.max_iter,
            "learning_rate": config.model.learning_rate,
            "max_leaf_nodes": config.model.max_leaf_nodes,
            "random_state": config.model.random_state,
        },
    )
    captured: list[np.ndarray] = []
    threshold_inputs: list[np.ndarray] = []
    original = backtest_module._cross_fitted_detailed
    original_headroom = backtest_module._cross_fitted_at_headroom
    original_cell = backtest_module._cell_threshold

    def spy(raw: Any, y: Any, groups: Any, method: str, cfg: Any, **kwargs: Any) -> Any:
        captured.append(np.asarray(groups).copy())
        return original(raw, y, groups, method, cfg, **kwargs)

    def headroom_spy(
        fit_raw: Any,
        fit_y: Any,
        groups: Any,
        apply_raw: Any,
        method: str,
        cfg: Any,
        **kwargs: Any,
    ) -> Any:
        captured.append(np.asarray(groups).copy())
        predicted, methods = original_headroom(fit_raw, fit_y, groups, apply_raw, method, cfg, **kwargs)
        return np.full(len(predicted), 0.25), methods

    def cell_spy(y: Any, probabilities: Any, floor: float, min_alerts: int) -> Any:
        threshold_inputs.append(np.asarray(probabilities).copy())
        return original_cell(y, probabilities, floor, min_alerts)

    monkeypatch.setattr(backtest_module, "_cross_fitted_detailed", spy)
    monkeypatch.setattr(backtest_module, "_cross_fitted_at_headroom", headroom_spy)
    monkeypatch.setattr(backtest_module, "_cell_threshold", cell_spy)
    result = fit_fold(recipe, fold, train, calibrate, test, config, spec)
    assert captured
    assert all(np.array_equal(groups, calibrate.departure_date) for groups in captured)
    # One cross-fit for the pooled calibrator and one per headroom for the cell thresholds.
    assert len(captured) == 1 + len(config.label.headroom_pct)
    # The threshold must see the out-of-fold scores, never the in-fold raw scores.
    assert threshold_inputs
    assert all(np.allclose(values, 0.25) for values in threshold_inputs)
    assert 0 < len(result.cell_thresholds) <= len(config.label.headroom_pct) * len(HEADLINE_BANDS)
    assert all(headroom in config.label.headroom_pct for headroom, _ in result.cell_thresholds)
    assert all(band in {label for label, _, _ in HEADLINE_BANDS} for _, band in result.cell_thresholds)


def test_protocol_boundaries_are_inclusive() -> None:
    count = 7
    panel = TabularData(
        features={"hours_to_departure": np.full(count, 48.0, dtype=np.float32)},
        y=np.zeros(count, dtype=np.int8),
        series=np.array([f"s{i}" for i in range(count)], dtype=object),
        route_day=np.arange(count, dtype=np.int64),
        price=np.full(count, 100.0),
        check_price=np.full(count, 100.0),
        future_max=np.full(count, 100.0),
        future_observations=np.full(count, 2, dtype=np.int16),
        headroom=np.full(count, 1, dtype=np.int16),
        departure_date=np.full(count, "2026-07-01", dtype=object),
        snapshot_at=np.array(
            [
                "2026-06-23 00:00:00",
                "2026-06-23 00:01:00",
                "2026-06-30 00:00:00",
                "2026-06-29 23:59:59",
                "2026-06-30 12:00:00",
                "2026-06-30 12:00:00",
                "2026-06-22 00:00:00",
            ],
            dtype=object,
        ),
        observation_era=np.full(count, "dense", dtype=object),
        observation_week=np.full(count, "2026-W26", dtype=object),
        label_window_end=np.array(
            [
                "2026-06-29 00:00:00",
                "2026-06-29 00:01:00",
                "2026-07-01 00:00:00",
                "2026-06-30 12:00:00",
                "2026-07-07 00:00:00",
                "2026-07-07 00:01:00",
                "2026-06-22 12:00:00",
            ],
            dtype=object,
        ),
    )
    fold = FoldConfig(date(2026, 6, 22), "development", "dev")
    masks = fold_masks(panel, fold, ProtocolConfig("backtest", (fold,)))
    assert masks.train.tolist() == [False] * count
    assert masks.calibrate.tolist() == [True, False, False, False, False, False, True]
    assert masks.test.tolist() == [False, False, True, False, True, False, False]


def test_cross_fitted_folds_keep_departure_groups_together(tmp_path: Path) -> None:
    config = load_config(_config(tmp_path))
    raw = np.linspace(0.05, 0.95, 60)
    y = (np.arange(60) % 2).astype(np.int8)
    groups = np.repeat(np.arange(6), 10)
    _, fold_ids = _cross_fitted_with_folds(raw, y, groups, "sigmoid", config)
    for group in np.unique(groups):
        assert len(set(fold_ids[groups == group].tolist())) == 1


def test_forward_fold_limits_calibration_and_test_domain() -> None:
    panel = _protocol_panel()
    panel = replace(
        panel,
        features={
            "hours_to_departure": np.array([200.0, 200.0, 200.0, 48.0, 48.0, 200.0, 48.0, 200.0], dtype=np.float32)
        },
    )
    fold = FoldConfig(date(2026, 6, 22), "forward", "forward")
    masks = fold_masks(panel, fold, ProtocolConfig("backtest", (fold,)))
    assert masks.train.tolist() == [True, False, False, False, False, True, False, False]
    assert masks.calibrate.tolist() == [False, False, False, False, False, False, True, False]
    assert masks.test.tolist() == [False, False, False, True, False, False, False, False]
    assert not masks.calibrate[2]
    assert not masks.test[7]


def test_recipe_depends_on_development_labels(tmp_path: Path) -> None:
    _, out = _build(tmp_path)
    spec = feature_spec("full")
    panel = load_panel(out, spec)
    config = load_config(_config(tmp_path))
    protocol = ProtocolConfig(
        "backtest",
        (
            FoldConfig(date(2026, 7, 6), "development", "dev"),
            FoldConfig(date(2026, 7, 20), "development", "dev2"),
        ),
    )
    config = replace(config, protocol=protocol)
    base = select_recipe(panel, config, spec)
    flipped = select_recipe(replace(panel, y=(1 - panel.y).astype(np.int8)), config, spec)
    assert base.sha256() != flipped.sha256()


def test_bootstrap_clusters_by_group_not_row() -> None:
    y = np.array([0, 1] * 50, dtype=np.int8)
    probabilities = np.linspace(0.1, 0.9, len(y))
    assert _bootstrap(y, probabilities, np.zeros(len(y), dtype=int), 20, 1) == {}
    assert _bootstrap_metrics(y, probabilities, np.zeros(len(y), dtype=int), 20, 1, 0.5) == {}


def test_bss_interval_matches_the_climatology_estimand() -> None:
    rng = np.random.default_rng(7)
    labels = rng.integers(0, 2, 400).astype(np.int8)
    model = np.clip(rng.normal(0.5, 0.2, 400), 0.01, 0.99)
    climatology = np.clip(rng.normal(0.45, 0.1, 400), 0.01, 0.99)
    groups = np.repeat(np.arange(20), 20)
    interval = _bss_paired_ci(labels, model, climatology, groups, 200, 3)
    point = 1.0 - float(np.mean((model - labels) ** 2)) / float(np.mean((climatology - labels) ** 2))
    assert interval[0] <= point <= interval[1]


def test_backtest_gate_failure_aborts_instead_of_skipping(tmp_path: Path) -> None:
    _, out = _build(tmp_path)
    spec = feature_spec("full")
    panel = load_panel(out, spec)
    config = load_config(_config(tmp_path))
    fold = FoldConfig(date(2026, 7, 6), "development", "dev")
    config = replace(
        config,
        protocol=ProtocolConfig("backtest", (fold,)),
        report=replace(config.report, min_eligible_rows=10**9),
    )
    with pytest.raises(DatasetError, match="floor"):
        run_backtest(panel, config, spec, evaluate_test=False)


def test_dirty_tree_disables_fold_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _, out = _build(tmp_path)
    spec = feature_spec("full")
    panel = load_panel(out, spec)
    config = load_config(_config(tmp_path))
    fold = FoldConfig(date(2026, 7, 6), "development", "dev")
    config = replace(config, protocol=ProtocolConfig("backtest", (fold,)))
    cache = tmp_path / "cache"
    monkeypatch.setattr(backtest_module, "_code_identity", lambda: ("deadbeef", True))
    run_backtest(panel, config, spec, evaluate_test=False, cache_dir=cache)
    assert not (cache / "folds").exists() or not list((cache / "folds").glob("*.pkl"))
    assert not (cache / "recipe.json").exists()


def test_band_labels_match_ttd_band_at_every_edge() -> None:
    values = [
        CLIMATOLOGY_BANDS[0][1],
        CLIMATOLOGY_BANDS[0][2] - 1e-6,
        CLIMATOLOGY_BANDS[0][2],
        CLIMATOLOGY_BANDS[-1][2],
        CLIMATOLOGY_BANDS[-1][2] + 1e-6,
        float("nan"),
        float("inf"),
        float("-inf"),
    ]
    for value in values:
        assert _band_labels(np.array([value]), CLIMATOLOGY_BANDS)[0] == ttd_band(value, CLIMATOLOGY_BANDS)


def test_compact_text_and_datetime_preserve_values() -> None:
    values = np.array(["Baden-Württemberg", "München", "plain"], dtype=object)
    encoded = _encode_text(values)
    assert [value.decode("utf-8") for value in encoded] == values.tolist()
    timestamps = _compact_datetime(np.array(["2026-06-01 10:00:00.428", "2026-06-01 10:00:00"], dtype=object), "ms")
    assert timestamps.dtype == np.dtype("datetime64[ms]")
    assert backtest_module._text(timestamps) == ["2026-06-01 10:00:00.428", "2026-06-01 10:00:00"]


def test_dataset_cache_key_covers_build_inputs(tmp_path: Path) -> None:
    config = load_config(DEFAULT_CONFIG_PATH)
    source = SourceSpec(glob="x", label="x", build_id="a", manifest_sha256="m")
    base = _dataset_cache_key(config, "x", "sha", False, source)
    assert base != _dataset_cache_key(config, "x", "sha", True, source)
    assert base != _dataset_cache_key(config, "x", "other", False, source)
    changed = replace(config, model=replace(config.model, max_iter=config.model.max_iter + 1))
    assert base == _dataset_cache_key(changed, "x", "sha", False, source)
    reseeded = replace(config, seed=config.seed + 1)
    assert base != _dataset_cache_key(reseeded, "x", "sha", False, source)
    other_build = SourceSpec(glob="x", label="x", build_id="b", manifest_sha256="m")
    assert base != _dataset_cache_key(config, "x", "sha", False, other_build)
    other_manifest = SourceSpec(glob="x", label="x", build_id="a", manifest_sha256="n")
    assert base != _dataset_cache_key(config, "x", "sha", False, other_manifest)


def test_backtest_cli_smoke(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    _, _ = _build(tmp_path)
    raw = json.loads(_config(tmp_path).read_text())
    raw["protocol"] = {
        "kind": "backtest",
        "cutoffs": [
            {"cutoff": "2026-07-06", "role": "development", "name": "dev"},
            {"cutoff": "2026-07-20", "role": "evaluation", "name": "eval"},
        ],
    }
    config_path = tmp_path / "backtest.json"
    config_path.write_text(json.dumps(raw))
    out = tmp_path / "cli-backtest"
    code = main(
        [
            "--config",
            str(config_path),
            "--source",
            str(tmp_path / "silver.parquet"),
            "--out",
            str(out),
            "--evaluate-test",
        ]
    )
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["evaluated_blocks"] == ["dev", "eval"]
    assert (out / "predictions" / "backtest.parquet").is_file()
    assert (out / "backtest.json").is_file()
    assert (out / "manifest.json").is_file()


def test_clean_fold_cache_round_trip(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _, out = _build(tmp_path)
    spec = feature_spec("full")
    panel = load_panel(out, spec)
    config = load_config(_config(tmp_path))
    fold = FoldConfig(date(2026, 7, 6), "development", "dev")
    config = replace(config, protocol=ProtocolConfig("backtest", (fold,)))
    monkeypatch.setattr(backtest_module, "_code_identity", lambda: ("cafebabe", False))
    cache = tmp_path / "cache"
    first = run_backtest(panel, config, spec, evaluate_test=False, cache_dir=cache, dataset_sha256="data")
    second = run_backtest(panel, config, spec, evaluate_test=False, cache_dir=cache, dataset_sha256="data")
    assert first.fold_cache_hits == 0
    assert second.recipe_from_cache is True
    assert second.fold_cache_hits == 1
    assert first.pooled == second.pooled
    assert first.folds[0].metrics == second.folds[0].metrics
    assert first.selection == second.selection
    assert first.selection
    assert first.recipe.sha256() == second.recipe.sha256()
    monkeypatch.setattr(backtest_module, "_code_identity", lambda: ("other-head", False))
    third = run_backtest(panel, config, spec, evaluate_test=False, cache_dir=cache, dataset_sha256="data")
    assert third.fold_cache_hits == 1
    monkeypatch.setattr(backtest_module, "_fit_code_hash", lambda: "changed-fit-code")
    fourth = run_backtest(panel, config, spec, evaluate_test=False, cache_dir=cache, dataset_sha256="data")
    assert fourth.fold_cache_hits == 0
    (cache / "folds" / "dev.pkl").write_bytes(b"corrupt")
    fifth = run_backtest(panel, config, spec, evaluate_test=False, cache_dir=cache, dataset_sha256="data")
    assert fifth.fold_cache_hits == 0
    assert fifth.folds[0].metrics == first.folds[0].metrics


def test_recipe_hash_records_the_rule_not_the_fitted_table() -> None:
    settings = {"max_iter": 400}
    rule = {"replicates": 2000, "alpha": 0.05, "cluster": "departure_date"}
    first = Recipe(
        "hist_gradient_boosting",
        "temperature",
        0.7,
        settings,
        selection_settings=rule,
        selection_table={"chosen": {"model": "hist_gradient_boosting", "calibration": "temperature"}},
    )
    second = Recipe(
        "hist_gradient_boosting",
        "temperature",
        0.7,
        settings,
        selection_settings=rule,
        selection_table={"chosen": {"model": "base_rate", "calibration": "sigmoid"}},
    )
    assert first.sha256() == second.sha256()
    assert "selection_table" not in first.payload()
    other = Recipe(
        "hist_gradient_boosting",
        "temperature",
        0.7,
        settings,
        selection_settings={**rule, "replicates": 1000},
    )
    assert other.sha256() != first.sha256()
    rules = Recipe(
        "hist_gradient_boosting",
        "temperature",
        0.7,
        settings,
        rule_settings={"early_stopping": {"patience": 99}},
    )
    assert rules.sha256() != first.sha256()


def test_replacement_rule_needs_both_intervals() -> None:
    accepted, reason = replacement_rule({"log_loss": [-2.0, -1.0]})
    assert accepted is False
    assert "incomplete" in reason
    accepted, reason = replacement_rule({"log_loss": [-2.0, -1.0], "brier": [0.1, 0.2]})
    assert accepted is False
    assert "Brier" in reason


def test_base_rate_is_per_headroom() -> None:
    spec = feature_spec("none")
    count = 40
    features: dict[str, Any] = {}
    for feature in spec.features:
        if feature.kind == "categorical":
            features[feature.name] = np.array(["a", "b"] * (count // 2), dtype=object)
        else:
            features[feature.name] = np.full(count, 1.0, dtype=np.float32)
    headroom = np.array([1] * 20 + [30] * 20, dtype=np.int16)
    features["headroom_pct"] = headroom.astype(np.float32)
    y = np.array([1] * 15 + [0] * 5 + [1] * 5 + [0] * 15, dtype=np.int8)
    data = TabularData(
        features=features,
        y=y,
        series=np.array([f"s{i}" for i in range(count)], dtype=object),
        route_day=np.arange(count, dtype=np.int64),
        price=np.full(count, 100.0),
        check_price=np.full(count, 100.0),
        future_max=np.full(count, 100.0),
        future_observations=np.full(count, 2, dtype=np.int16),
        headroom=headroom,
        departure_date=np.full(count, "2026-07-01", dtype=object),
        snapshot_at=np.full(count, "2026-07-01T00:00:00", dtype=object),
        observation_era=np.full(count, "dense", dtype=object),
        observation_week=np.full(count, "2026-W27", dtype=object),
    )
    config = load_config(DEFAULT_CONFIG_PATH)
    model = fit_candidate("base_rate", data, spec, config)
    probabilities = model.predict(data)
    assert probabilities[:20].tolist() == pytest.approx([0.75] * 20)
    assert probabilities[20:].tolist() == pytest.approx([0.25] * 20)
    at_30 = model.predict(data, headroom=30)
    assert at_30.tolist() == pytest.approx([0.25] * count)
    nan_headroom = TabularData(
        features={**data.features, "headroom_pct": np.r_[np.nan, data.features["headroom_pct"][1:]]},
        y=data.y,
        series=data.series,
        route_day=data.route_day,
        price=data.price,
        check_price=data.check_price,
        future_max=data.future_max,
        future_observations=data.future_observations,
        headroom=data.headroom,
        departure_date=data.departure_date,
        snapshot_at=data.snapshot_at,
        observation_era=data.observation_era,
        observation_week=data.observation_week,
    )
    nan_probabilities = model.predict(nan_headroom)
    assert np.all(np.isfinite(nan_probabilities))
    assert nan_probabilities[0] == pytest.approx(0.5)


def test_dataset_cache_round_trip(tmp_path: Path) -> None:
    _, out = _build(tmp_path)
    cache = tmp_path / "datasets"
    _mark_dataset_cache(out, "key")
    _store_dataset(cache, "key", out)
    restored = tmp_path / "restored"
    restored.mkdir()
    source = SourceSpec(glob=str(tmp_path / "silver.parquet"), label="test", build_id="test", manifest_sha256=None)
    stats = _restore_dataset(
        cache,
        "key",
        restored,
        run_id="restored",
        cli_argv=("test",),
        strict_chains=False,
        source=source,
    )
    assert stats is not None
    assert stats.rows > 0
    assert (restored / "dataset" / "train.parquet").is_file()
    manifest = json.loads((restored / "dataset_manifest.json").read_text())
    assert manifest["reused"] is True

    manifest_path = cache / "key" / "dataset_manifest.json"
    original = manifest_path.read_text()
    changed = json.loads(original)
    changed["calendar_version"] = "1999-01-01"
    manifest_path.write_text(json.dumps(changed))
    calendar_target = tmp_path / "calendar"
    calendar_target.mkdir()
    assert (
        _restore_dataset(
            cache,
            "key",
            calendar_target,
            run_id="calendar",
            cli_argv=("test",),
            strict_chains=False,
            source=source,
        )
        is None
    )
    manifest_path.write_text(original)
    (cache / "key" / "profile.json").write_text("{}")
    profile_target = tmp_path / "profile"
    profile_target.mkdir()
    assert (
        _restore_dataset(
            cache,
            "key",
            profile_target,
            run_id="profile",
            cli_argv=("test",),
            strict_chains=False,
            source=source,
        )
        is None
    )
    (cache / "key" / "dataset" / "train.parquet").write_bytes(b"corrupt")
    corrupt_target = tmp_path / "corrupt"
    corrupt_target.mkdir()
    assert (
        _restore_dataset(
            cache,
            "key",
            corrupt_target,
            run_id="corrupt",
            cli_argv=("test",),
            strict_chains=False,
            source=source,
        )
        is None
    )


def test_forward_builder_has_grid_columns_but_no_labels(tmp_path: Path) -> None:
    source = tmp_path / "forward.parquet"
    rows = _rows()
    rows.append(
        _row(
            observed_at=datetime(2026, 7, 8, 10, 0),
            departure=datetime(2026, 7, 10, 10, 0),
            route="v2-route",
            train="ICE-V2",
            fare=50.0,
            schema_version=2,
            journey_id="v2:forward-test",
        )
    )
    _write_silver(source, rows)
    config = load_config(_config(tmp_path))
    config = replace(
        config,
        protocol=replace(
            config.protocol,
            forward_start=date(2026, 7, 1),
            forward_end=date(2026, 8, 10),
            forward_sample_rate=1.0,
        ),
    )
    connection = duckdb.connect()
    try:
        stats = build_dataset(
            connection,
            SourceSpec(glob=str(source), label="forward", build_id="forward", manifest_sha256=None),
            config,
            tmp_path / "forward-run",
            run_id="forward",
            write_splits=False,
            forward=True,
        )
        columns = {
            row[0]
            for row in connection.execute(
                "DESCRIBE SELECT * FROM read_parquet(?)",
                [str(tmp_path / "forward-run" / "forward.parquet")],
            ).fetchall()
        }
    finally:
        connection.close()
    assert stats.rows > 0
    assert {"eligible", "check_at", "check_lag_h", "hours_to_departure"} <= columns
    connection = duckdb.connect()
    try:
        v2 = connection.execute(
            "SELECT count(*) FROM read_parquet(?) WHERE series_key LIKE 'v2:%'",
            [str(tmp_path / "forward-run" / "forward.parquet")],
        ).fetchone()
        assert v2 is not None
        assert v2[0] == 0
        bounds = connection.execute(
            "SELECT min(hours_to_departure), max(hours_to_departure) FROM read_parquet(?)",
            [str(tmp_path / "forward-run" / "forward.parquet")],
        ).fetchone()
        assert bounds is not None
        lower, upper = bounds
    finally:
        connection.close()
    assert lower >= config.protocol.forward_min_hours_to_departure
    assert upper <= config.protocol.forward_max_hours_to_departure
    assert not (set(LABEL_COLUMNS) - {"eligible", "check_at", "check_lag_h"}) & columns
    manifest = json.loads((tmp_path / "forward-run" / "forward_manifest.json").read_text())
    assert manifest["forward"] is True
    assert manifest["rows"] == stats.rows
    assert manifest["forward_sample_rate"] == 1.0
    assert manifest["sampled_route_days"] == manifest["route_days_total"]
    assert manifest["route_days_with_domain_rows"] >= manifest["route_days"]
    assert manifest["departure_bounds"] == ["2026-07-01", "2026-08-10"]
    assert manifest["missing_departure_dates"] == []
    assert manifest["feature_missingness"]
    assert {"git_sha_end", "git_dirty_end", "runtime_seconds", "peak_rss_kb", "cli_argv"} <= manifest.keys()

    base_dir = tmp_path / "base"
    base_dir.mkdir()
    _, base_out = _build(base_dir)
    panel = load_panel(base_out, feature_spec("full"))
    fold = FoldConfig(date(2026, 7, 6), "development", "dev")
    masks = fold_masks(panel, fold, config.protocol)
    train, calibrate, _ = fold_slices(panel, masks)
    recipe = Recipe(
        model="hist_gradient_boosting",
        calibration="sigmoid",
        threshold_floor=0.7,
        model_settings={
            "max_iter": 2,
            "learning_rate": config.model.learning_rate,
            "max_leaf_nodes": 3,
            "random_state": config.model.random_state,
        },
    )
    scorer = fit_forward_scorer(recipe, train, calibrate, config, feature_spec("full"))
    forward = load_forward(tmp_path / "forward-run" / "forward.parquet", feature_spec("full"))
    probabilities = score_forward(forward, scorer)
    assert len(probabilities) == len(forward)
    assert np.all(np.isfinite(probabilities))
    assert float(probabilities.min()) > 0.0
    assert float(probabilities.max()) < 1.0
    assert float(np.std(probabilities)) > 0.0

    forward_config = replace(
        config,
        protocol=ProtocolConfig("backtest", (FoldConfig(date(2026, 7, 6), "forward", "forward"),)),
    )
    smoke_dir = tmp_path / "forward-smoke"
    smoke_dir.mkdir()
    smoke = score_forward_artifact(
        smoke_dir,
        panel,
        forward_config,
        recipe,
        feature_spec("full"),
        tmp_path / "forward-run" / "forward.parquet",
    )
    assert smoke["finite"] is True
    assert smoke["labels"] is False
    assert smoke["rows"] == len(forward)
    assert 0.0 < smoke["min_score"] < smoke["max_score"] < 1.0
    assert (
        smoke["forward_sha256"]
        == hashlib.sha256((tmp_path / "forward-run" / "forward.parquet").read_bytes()).hexdigest()
    )
    assert (smoke_dir / "forward_input.parquet").is_file()


def test_backtest_smoke_and_recipe_freeze(tmp_path: Path) -> None:
    _, out = _build(tmp_path)
    spec = feature_spec("full")
    panel = load_panel(out, spec)
    config = load_config(_config(tmp_path))
    protocol = ProtocolConfig(
        "backtest",
        (
            FoldConfig(date(2026, 7, 6), "development", "dev"),
            FoldConfig(date(2026, 7, 20), "evaluation", "eval"),
        ),
    )
    config = replace(config, protocol=protocol)
    recipe = select_recipe(panel, config, spec)
    frozen = recipe.sha256()
    eval_mask = fold_masks(panel, protocol.cutoffs[1], protocol).test
    mutated = replace(panel, y=np.where(eval_mask, 1 - panel.y, panel.y).astype(np.int8))
    assert select_recipe(mutated, config, spec).sha256() == frozen
    development = run_backtest(panel, config, spec, evaluate_test=False)
    assert [item.fold.name for item in development.folds] == ["dev"]
    assert development.pooled == {}
    assert development.development_pooled["brier"] is not None
    assert development.development_headroom
    assert development.development_headroom_ttd
    scored = run_backtest(panel, config, spec, evaluate_test=True)
    assert [item.fold.role for item in scored.folds] == ["development", "evaluation"]
    assert scored.pooled["brier"] is not None
    summary = write_backtest_artifacts(out, scored, config, spec)
    assert (out / "predictions" / "backtest.parquet").is_file()
    assert (out / "recipe.json").is_file()
    connection = duckdb.connect()
    try:
        row = connection.execute(
            "SELECT count(*) AS total, count(d.snapshot_at) AS matched "
            "FROM read_parquet(?) p LEFT JOIN read_parquet(?) d "
            "ON p.series_key = d.series_key AND p.snapshot_at = d.snapshot_at",
            [str(out / "predictions" / "backtest.parquet"), str(out / "dataset" / "*.parquet")],
        ).fetchone()
    finally:
        connection.close()
    assert row is not None
    assert row[0] == row[1]
    assert summary["evaluated_blocks"] == ["dev", "eval"]
    assert scored.recipe.sha256() == recipe.sha256()
    assert scored.recipe.model_settings["max_iter"] == config.model.max_iter
    assert scored.recipe.threshold_floor == config.report.threshold_precision_floor
    evaluation = tuple(item for item in scored.folds if item.fold.role == "evaluation")
    expected_clusters = len(np.unique(np.concatenate([item.test.departure_date for item in evaluation])))
    assert scored.pooled["bootstrap_clusters"] == expected_clusters
    assert scored.development_calibration_cells
    assert scored.calibration_cells
    required = {"headroom_pct", "ttd_band", "era", "rows", "slope", "intercept", "ece"}
    assert all(required <= set(row) for row in scored.calibration_cells)
    assert all(row["rows"] >= 20 for row in scored.calibration_cells)
    assert len(scored.development_threshold_cells) == 5 * len(HEADLINE_BANDS)
    assert len(scored.threshold_cells) == 5 * len(HEADLINE_BANDS)
    assert all("operating_point" in row and "floor_met" in row for row in scored.threshold_cells)
    assert scored.threshold_hold_rate["cells"] == 5 * len(HEADLINE_BANDS)
    assert scored.threshold_hold_rate["with_operating_point"] == sum(
        row["operating_point"] for row in scored.threshold_cells
    )
    assert scored.development_threshold_hold_rate["with_operating_point"] == sum(
        row["operating_point"] for row in scored.development_threshold_cells
    )
    assert scored.pr_curves
    assert all(point["precision"] >= 0.0 for curve in scored.pr_curves for point in curve["points"])
    assert all(row["cell_thresholds"] for row in scored.per_fold)
    assert all(row["calibration_methods"] for row in scored.per_fold)
    assert all(any(item["fold"] == "applied" for item in row["calibration_methods"]) for row in scored.per_fold)
    assert 0 < len(scored.development_decision_value) <= 5 * len(HEADLINE_BANDS)
    assert 0 < len(scored.decision_value) <= 5 * len(HEADLINE_BANDS)
    required_oracle = {"perfect_breach_vs_wait_eur", "perfect_breach_vs_book_eur", "perfect_timing_vs_book_eur"}
    assert all(required_oracle <= set(row) for row in scored.decision_value)
    assert all(len(row["ci_saving_vs_wait_eur"]) == 2 for row in scored.decision_value)
    assert all(len(row["ci_saving_vs_book_eur"]) == 2 for row in scored.decision_value)
    assert scored.importance
    assert {row["kind"] for row in scored.importance} == {"family", "feature"}
    assert all(np.isfinite(row["delta_log_loss"]) for row in scored.importance)
    assert all("date_std" in row for row in scored.importance)
    point = scored.pooled.get("cell_threshold_precision")
    if "precision" in scored.pooled.get("intervals", {}) and point is not None:
        low, high = scored.pooled["intervals"]["precision"]
        assert low <= point <= high
    development = tuple(item for item in scored.folds if item.fold.role == "development")
    small = _grouped_importance(development, spec, sample=400, repeats=1, seed=5)
    assert len([row for row in small if row["kind"] == "family"]) == 7
    assert len([row for row in small if row["kind"] == "feature"]) == len(spec.names)
    expected_dates = len(np.unique(np.concatenate([item.test.departure_date for item in development])))
    assert all(row["departures"] == expected_dates for row in small)
    assert all(row["rows"] <= 400 for row in small)
    assert max(row["delta_log_loss"] for row in small if row["kind"] == "family") > 0.0


def test_selection_rejects_a_non_development_fold() -> None:
    development = FoldConfig(date(2026, 6, 22), "development", "dev")
    assert development_folds((development,)) == (development,)
    with pytest.raises(ModelError, match="development folds"):
        development_folds((FoldConfig(date(2026, 7, 27), "evaluation", "eval"),))
    with pytest.raises(ModelError, match="development folds"):
        development_folds((FoldConfig(date(2026, 8, 31), "sparse_era", "sparse"),))
    with pytest.raises(ModelError, match="at least one"):
        development_folds(())


def _bootstrap_fixture(
    magnitudes: np.ndarray, labels_per_cluster: np.ndarray, rows_per_cluster: int = 200
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Return labels, challenger, incumbent and date clusters with per-cluster values."""
    count = len(magnitudes) * rows_per_cluster
    clusters = np.repeat(np.arange(len(magnitudes)), rows_per_cluster)
    labels = np.repeat(labels_per_cluster, rows_per_cluster).astype(np.int8)
    incumbent = np.full(count, 0.5, dtype=np.float64)
    challenger = np.clip(incumbent + np.repeat(magnitudes, rows_per_cluster), 1e-6, 1.0 - 1e-6)
    return labels, challenger, incumbent, clusters


def test_replacement_rule_keeps_a_clear_winner_and_rejects_a_crossing_interval() -> None:
    labels, challenger, incumbent, clusters = _bootstrap_fixture(np.array([0.2, -0.2] * 4), np.array([1, 0] * 4))
    winner = paired_bootstrap(labels, challenger, incumbent, clusters, replicates=500, seed=7)
    assert replacement_rule(winner)[0] is True
    assert winner["log_loss"][1] < 0.0

    labels, challenger, incumbent, clusters = _bootstrap_fixture(
        np.array([0.32, -0.32, -0.18, 0.18, 0.32, -0.32, -0.18, 0.18]),
        np.array([1, 0, 1, 0, 1, 0, 1, 0]),
    )
    interval = paired_bootstrap(labels, challenger, incumbent, clusters, replicates=500, seed=7)
    assert interval["mean_log_loss"] < 0.0
    assert interval["log_loss"][0] < 0.0 < interval["log_loss"][1]
    accepted, reason = replacement_rule(interval)
    assert accepted is False
    assert "not entirely below zero" in reason


def test_paired_bootstrap_clusters_by_departure_date() -> None:
    labels, challenger, incumbent, clusters = _bootstrap_fixture(
        np.array([0.25, -0.23, 0.24, -0.22, 0.26, -0.21, 0.25, -0.22]),
        np.array([1, 0, 1, 0, 1, 0, 1, 0]),
    )
    by_date = paired_bootstrap(labels, challenger, incumbent, clusters, replicates=800, seed=11)
    rows = np.arange(len(labels))
    by_row = paired_bootstrap(labels, challenger, incumbent, rows, replicates=800, seed=11)
    date_width = by_date["log_loss"][1] - by_date["log_loss"][0]
    row_width = by_row["log_loss"][1] - by_row["log_loss"][0]
    # A row-clustered mutant ignores the within-date correlation and reports a much narrower interval.
    assert date_width > row_width * 2.0
    assert by_date["clusters"] == 8
    assert by_row["clusters"] == len(labels)


def test_selection_joint_search_and_deterministic_table(tmp_path: Path) -> None:
    _, out = _build(tmp_path)
    spec = feature_spec("full")
    panel = load_panel(out, spec)
    config = load_config(_config(tmp_path))
    protocol = ProtocolConfig(
        "backtest",
        (
            FoldConfig(date(2026, 7, 6), "development", "dev"),
            FoldConfig(date(2026, 7, 20), "development", "dev2"),
        ),
    )
    config = replace(
        config,
        protocol=protocol,
        calibration=replace(config.calibration, methods=("sigmoid", "isotonic", "temperature", "covariate")),
    )
    first = select_outcome(panel, config, spec, replicates=200)
    second = select_outcome(panel, config, spec, replicates=200)
    assert table_sha256(first.table) == table_sha256(second.table)
    assert first.table["chosen"] == {"model": first.model, "calibration": first.calibration}
    pairs = {(row["model"], row["calibration"]) for row in first.table["rows"]}
    assert pairs == {
        ("base_rate", "sigmoid"),
        ("base_rate", "covariate"),
        ("logistic", "sigmoid"),
        ("logistic", "isotonic"),
        ("logistic", "temperature"),
        ("logistic", "covariate"),
        ("hist_gradient_boosting", "sigmoid"),
        ("hist_gradient_boosting", "isotonic"),
        ("hist_gradient_boosting", "temperature"),
        ("hist_gradient_boosting", "covariate"),
        ("climatology", "none"),
    }
    assert first.table["folds"] == ["dev", "dev2"]
    assert set(first.models) == {"dev", "dev2"}
    assert all("beats_climatology" in row for row in first.table["rows"] if row.get("selectable", True))
    assert first.table["rule"]["cluster"] == "departure_date"
    assert first.table["rule"]["replicates"] == 200
    expected_rows = sum(int(fold_masks(panel, fold, protocol).test.sum()) for fold in protocol.cutoffs)
    assert {row["rows"] for row in first.table["rows"]} == {expected_rows}


def test_early_stopping_plan_uses_patience_and_tolerance() -> None:
    losses = [0.5 - 0.001 * index for index in range(1, 151)] + [0.35] * 250
    best, stop = _early_stopping_plan(losses)
    assert best == 150
    assert stop == 150 + 50
    never = [0.5 - 0.001 * index for index in range(1, 401)]
    assert _early_stopping_plan(never) == (400, 400)
    flat = [0.4] * 400
    assert _early_stopping_plan(flat) == (1, 51)
    plateau = [0.5 - 0.001 * index for index in range(10)] + [0.491] * 60 + [0.49099] + [0.491] * 329
    assert _early_stopping_plan(plateau) == (10, 60)


def test_holdout_is_the_last_training_week() -> None:
    days = np.arange(40, dtype="timedelta64[D]") + np.datetime64("2026-01-01T00:00:00", "ms")
    snapshot = np.repeat(days, 20)
    holdout = _holdout_mask(snapshot)
    assert holdout is not None
    selected = snapshot[holdout]
    assert selected.min() > snapshot.max() - np.timedelta64(7, "D")
    assert selected.max() == snapshot.max()
    assert holdout.sum() == 7 * 20
    assert _holdout_mask(snapshot[:100]) is None


def test_logistic_prep_transforms_headroom_and_relative_fares() -> None:
    spec = feature_spec("none")
    count = 30
    rng = np.random.default_rng(5)
    features: dict[str, Any] = {}
    for feature in spec.features:
        if feature.kind == "categorical":
            features[feature.name] = np.array(["a", "b", "c"] * 10, dtype=object)
        elif feature.name in {"price_eur", "headroom_pct"}:
            features[feature.name] = np.full(count, 100.0, dtype=np.float32)
        else:
            features[feature.name] = rng.normal(size=count).astype(np.float32)
    features["price_change_24h"] = np.full(count, 10.0, dtype=np.float32)
    features["price_velocity_24h"] = np.full(count, 1.0, dtype=np.float32)
    data = TabularData(
        features=features,
        y=np.tile(np.array([0, 1], dtype=np.int8), count // 2),
        series=np.array([f"s{i}" for i in range(count)], dtype=object),
        route_day=np.arange(count, dtype=np.int64),
        price=np.full(count, 100.0),
        check_price=np.full(count, 100.0),
        future_max=np.full(count, 100.0),
        future_observations=np.full(count, 2, dtype=np.int16),
        headroom=np.full(count, 5, dtype=np.int16),
        departure_date=np.full(count, "2026-07-01", dtype=object),
        snapshot_at=np.full(count, "2026-07-01T00:00:00", dtype=object),
        observation_era=np.full(count, "dense", dtype=object),
        observation_week=np.full(count, "2026-W27", dtype=object),
    )
    encoder = fit_encoder(data, spec)
    matrix = _matrix(data, spec, encoder)
    prep = LogisticPrep(spec).fit(matrix)
    numeric = prep._numeric(matrix)
    spline_width = numeric.shape[1] - (len(prep.numeric_) - 1)
    # Six knots with a cubic basis give seven columns in place of the raw hours column.
    assert spline_width == 7

    headroom_index = spec.names.index("headroom_pct")
    raised = matrix.copy()
    raised[:, headroom_index] = 30.0
    difference = prep._numeric(raised) - numeric
    changed = np.flatnonzero(np.any(np.abs(difference) > 1e-9, axis=0))
    assert len(changed) == 1
    assert np.allclose(difference[:, changed[0]], np.log1p(30.0) - np.log1p(100.0))

    change_index = spec.names.index("price_change_24h")
    cheaper = matrix.copy()
    cheaper[:, change_index] = 5.0
    relative = prep._numeric(cheaper) - numeric
    changed = np.flatnonzero(np.any(np.abs(relative) > 1e-9, axis=0))
    assert len(changed) == 1
    assert np.allclose(relative[:, changed[0]], 5.0 / 100.0 - 10.0 / 100.0)


def test_hgb_early_stopping_refits_with_the_chosen_iteration_count() -> None:
    spec = feature_spec("none")
    count = 600
    rng = np.random.default_rng(9)
    features: dict[str, Any] = {}
    for feature in spec.features:
        if feature.kind == "categorical":
            features[feature.name] = np.array(["a", "b"] * (count // 2), dtype=object)
        else:
            features[feature.name] = rng.normal(size=count).astype(np.float32)
    y = (features["price_eur"] > 0).astype(np.int8)
    data = TabularData(
        features=features,
        y=y,
        series=np.array([f"s{i}" for i in range(count)], dtype=object),
        route_day=np.arange(count, dtype=np.int64),
        price=np.full(count, 100.0),
        check_price=np.full(count, 100.0),
        future_max=np.full(count, 100.0),
        future_observations=np.full(count, 2, dtype=np.int16),
        headroom=np.full(count, 5, dtype=np.int16),
        departure_date=np.full(count, "2026-07-01", dtype=object),
        snapshot_at=(np.datetime64("2026-05-01T00:00:00", "ms") + np.arange(count).astype("timedelta64[h]")),
        observation_era=np.full(count, "dense", dtype=object),
        observation_week=np.full(count, "2026-W18", dtype=object),
    )
    config = load_config(DEFAULT_CONFIG_PATH)
    model = fit_candidate("hist_gradient_boosting", data, spec, config)
    assert model.early_stopping is not None
    record = model.early_stopping
    assert record["fallback"] is False
    assert record["holdout_rows"] == 168
    assert record["iterations"] == model.estimator.max_iter
    assert 1 <= record["iterations"] <= 400
    assert record["holdout_log_loss"] <= 1.0


def _calibration_fixture(size: int = 3000) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    rng = np.random.default_rng(17)
    raw = rng.random(size)
    hours = rng.uniform(24.0, 720.0, size)
    headroom = rng.choice([1, 5, 10, 20, 30], size)
    y = (rng.random(size) < (0.1 + 0.8 * raw)).astype(np.int8)
    return raw, y, hours, headroom, raw


@pytest.mark.parametrize("method", ["sigmoid", "isotonic", "temperature", "covariate"])
def test_fit_calibrator_supports_every_method(method: str) -> None:
    raw, y, hours, headroom, _ = _calibration_fixture()
    calibrator = fit_calibrator(raw, y, method, min_positives=100, hours=hours, headroom=headroom)
    probabilities = calibrator.predict(raw, hours=hours, headroom=headroom)
    assert len(probabilities) == len(raw)
    assert np.all(probabilities >= 1e-6)
    assert np.all(probabilities <= 1.0 - 1e-6)
    assert calibrator.requested == method
    assert calibrator.fallback is False


def test_covariate_calibrator_is_monotone_and_uses_the_band() -> None:
    raw, y, hours, headroom, _ = _calibration_fixture()
    calibrator = fit_calibrator(raw, y, "covariate", min_positives=100, hours=hours, headroom=headroom)
    assert calibrator.method == "covariate"
    assert calibrator.model.model.coef_.shape == (1, 10)
    design = calibrator.model.design(np.array([0.5]), np.array([48.0]), np.array([5.0]))
    assert design.shape == (1, 10)
    scores = np.linspace(0.01, 0.99, 41)
    for _, low, high in HEADLINE_BANDS:
        values = calibrator.predict(
            scores,
            hours=np.full(len(scores), (low + high) / 2.0),
            headroom=np.full(len(scores), 5),
        )
        assert np.all(np.diff(values) >= -1e-9)
    steps = np.array([1.0, 5.0, 10.0, 20.0, 30.0])
    for _, low, high in HEADLINE_BANDS:
        values = calibrator.predict(
            np.full(len(steps), 0.7),
            hours=np.full(len(steps), (low + high) / 2.0),
            headroom=steps,
        )
        assert np.all(np.diff(values) <= 1e-9)
    same_score = np.full(2, 0.7)
    near = calibrator.predict(same_score, hours=np.array([40.0, 40.0]), headroom=np.array([5.0, 5.0]))
    far = calibrator.predict(same_score, hours=np.array([600.0, 600.0]), headroom=np.array([5.0, 5.0]))
    assert not np.allclose(near, far)


def test_covariate_fallback_is_recorded(monkeypatch: pytest.MonkeyPatch) -> None:
    raw, y, hours, headroom, _ = _calibration_fixture()
    monkeypatch.setattr(tpm_training_model, "_covariate_constraints", lambda calibrator: (False, "forced violation"))
    calibrator = fit_calibrator(raw, y, "covariate", min_positives=100, hours=hours, headroom=headroom)
    assert calibrator.method == "isotonic"
    assert calibrator.requested == "covariate"
    assert calibrator.fallback is True
    assert calibrator.fallback_reason == "forced violation"
    few = fit_calibrator(raw, y, "isotonic", min_positives=10_000, hours=hours, headroom=headroom)
    assert few.method == "sigmoid"
    assert few.fallback is True
    assert "positive" in (few.fallback_reason or "")
    thin = fit_calibrator(raw, y, "covariate", min_positives=10_000, hours=hours, headroom=headroom)
    assert thin.method == "sigmoid"
    assert thin.requested == "covariate"
    assert thin.fallback is True


def test_fit_fold_uses_the_selected_calibrator_for_headroom_tables(tmp_path: Path) -> None:
    _, out = _build(tmp_path)
    spec = feature_spec("full")
    panel = load_panel(out, spec)
    config = load_config(_config(tmp_path))
    fold = FoldConfig(date(2026, 7, 6), "development", "dev")
    protocol = ProtocolConfig("backtest", (fold,))
    config = replace(config, protocol=protocol)
    masks = fold_masks(panel, fold, protocol)
    train, calibrate, test = fold_slices(panel, masks)
    recipe = Recipe(
        "logistic",
        "covariate",
        0.7,
        {
            "max_iter": config.model.max_iter,
            "learning_rate": config.model.learning_rate,
            "max_leaf_nodes": config.model.max_leaf_nodes,
            "random_state": config.model.random_state,
        },
    )
    result = fit_fold(recipe, fold, train, calibrate, test, config, spec)
    assert result.calibration_methods
    assert all(item["requested"] == "covariate" for item in result.calibration_methods)
    assert set(result.isotonic_probabilities) == set(config.label.headroom_pct)
    assert set(result.probabilities) == set(config.label.headroom_pct)
    assert not np.allclose(
        result.probabilities[5],
        result.isotonic_probabilities[5],
    )
    for values in result.probabilities.values():
        assert np.all(values >= 1e-6)
        assert np.all(values <= 1.0 - 1e-6)


def test_wilson_lower_matches_the_one_sided_bound() -> None:
    assert _wilson_lower(0, 10) == pytest.approx(0.0)
    assert _wilson_lower(7, 10) == pytest.approx(0.4417, abs=1e-4)
    assert _wilson_lower(70, 100) == pytest.approx(0.6202, abs=1e-4)
    assert _wilson_lower(80, 100) == pytest.approx(0.7267, abs=1e-4)
    assert _wilson_lower(30, 30) == pytest.approx(0.9173, abs=1e-4)
    assert _wilson_lower(0, 0) == 0.0


def test_cell_threshold_respects_the_wilson_boundary() -> None:
    y = np.array([1] * 80 + [0] * 20, dtype=np.int8)
    probabilities = np.full(100, 0.9)
    qualifying = _cell_threshold(y, probabilities, 0.7266961911903833, 100)
    assert qualifying["qualified"] is True
    assert qualifying["threshold"] == pytest.approx(0.9)
    assert qualifying["precision"] == pytest.approx(0.8)
    rejected = _cell_threshold(y, probabilities, 0.727, 100)
    assert rejected["qualified"] is False
    assert rejected["threshold"] is None


def test_cell_threshold_enforces_minimum_alerts_and_the_none_path() -> None:
    y = np.array([1] * 30 + [0] * 100, dtype=np.int8)
    probabilities = np.concatenate([np.full(30, 0.9), np.full(100, 0.8)])
    small = _cell_threshold(y, probabilities, 0.7, 30)
    assert small["qualified"] is True
    assert small["alerts"] == 30
    assert small["precision"] == pytest.approx(1.0)
    larger = _cell_threshold(y, probabilities, 0.7, 31)
    assert larger["qualified"] is False
    assert larger["threshold"] is None
    empty = _cell_threshold(np.zeros(10, dtype=np.int8), np.full(10, 0.5), 0.7, 1)
    assert empty["qualified"] is False
    assert empty["positives"] == 0


def test_cell_threshold_ignores_non_finite_scores() -> None:
    y = np.array([1] * 20 + [0] * 10, dtype=np.int8)
    probabilities = np.array([0.9] * 20 + [0.1] * 8 + [np.nan, np.inf])
    row = _cell_threshold(y, probabilities, 0.7, 20)
    assert row["qualified"] is True
    assert row["threshold"] is not None
    assert np.isfinite(row["threshold"])
    assert row["alerts"] == 20


def test_cell_threshold_handles_ties_and_prefers_recall() -> None:
    tied = _cell_threshold(
        np.array([1] * 80 + [0] * 20, dtype=np.int8),
        np.full(100, 0.9),
        0.7,
        30,
    )
    assert tied["qualified"] is True
    assert tied["threshold"] == pytest.approx(0.9)
    assert tied["alerts"] == 100
    assert tied["recall"] == pytest.approx(1.0)
    y = np.array([1] * 30, dtype=np.int8)
    probabilities = np.concatenate([np.full(10, 0.9), np.full(20, 0.8)])
    recall_first = _cell_threshold(y, probabilities, 0.7, 10)
    assert recall_first["threshold"] == pytest.approx(0.8)
    assert recall_first["recall"] == pytest.approx(1.0)


def test_feature_families_cover_every_feature() -> None:
    families = family_members()
    core_families = {name: names for name, names in families.items() if not name.startswith("analog_")}
    for calendar_set in ("none", "public", "public_school", "full"):
        spec = feature_spec(calendar_set)
        assigned: list[str] = []
        for names in core_families.values():
            assigned.extend(names)
        assert len(assigned) == len(set(assigned))
        assert set(spec.names) <= set(assigned)
        assert all(feature_family(name) in families for name in spec.names)
    assert feature_family("headroom_pct") == "limit"
    assert set(feature_spec("full").names) == set(assigned)
    analog = set(feature_spec("none", analog_offsets=(1, 7)).names) - set(feature_spec("none").names)
    assert analog
    assert all(feature_family(name).startswith("analog_") for name in analog)


def test_permuting_a_family_changes_only_that_family() -> None:
    features = {
        "a": np.array([10.0, 20.0, 30.0]),
        "b": np.array([1.0, 2.0, 3.0]),
        "c": np.array([100.0, 200.0, 300.0]),
    }
    order = np.array([2, 0, 1])
    permuted = _permuted_features(features, ("a", "b"), order)
    assert permuted["a"].tolist() == [30.0, 10.0, 20.0]
    assert permuted["b"].tolist() == [3.0, 1.0, 2.0]
    assert "c" not in permuted
    assert features["c"].tolist() == [100.0, 200.0, 300.0]
    # The within-family row correspondence survives the shared permutation.
    assert (permuted["a"] / permuted["b"]).tolist() == [10.0, 10.0, 10.0]


def test_hgb_probe_drops_columns_empty_only_after_label_purge(tmp_path: Path) -> None:
    spec = feature_spec("none")
    count = 600
    base = np.datetime64("2026-06-01T00:00:00", "ms")
    snapshots = base + np.arange(count).astype("timedelta64[h]")
    features: dict[str, Any] = {}
    for feature in spec.features:
        if feature.kind == "categorical":
            features[feature.name] = np.array(["a"] * count, dtype=object)
        else:
            features[feature.name] = np.zeros(count, dtype=np.float32)
    labels_end = snapshots + np.timedelta64(28, "h")
    cutoff = snapshots.max() - np.timedelta64(7, "D")
    purged = (snapshots <= cutoff) & (labels_end > cutoff)
    features["price_rank_route_day"] = np.full(count, np.nan, dtype=np.float32)
    features["price_rank_route_day"][purged] = np.linspace(0.1, 0.9, int(purged.sum())).astype(np.float32)
    y = np.arange(count) % 2
    data = TabularData(
        features=features,
        y=y.astype(np.int8),
        series=np.array([f"s{i}" for i in range(count)], dtype=object),
        route_day=np.arange(count, dtype=np.int64),
        price=np.full(count, 100.0),
        check_price=np.full(count, 100.0),
        future_max=np.full(count, 100.0),
        future_observations=np.full(count, 2, dtype=np.int16),
        headroom=np.full(count, 5, dtype=np.int16),
        departure_date=np.full(count, "2026-07-01", dtype=object),
        snapshot_at=snapshots,
        observation_era=np.full(count, "dense", dtype=object),
        observation_week=np.full(count, "2026-W23", dtype=object),
        label_window_end=labels_end,
    )
    config = load_config(DEFAULT_CONFIG_PATH)
    model = fit_candidate("hist_gradient_boosting", data, spec, config)
    assert model.early_stopping is not None
    assert model.early_stopping["fallback"] is True
    assert purged.any()


def test_threshold_and_decision_helpers_agree_with_the_fold_state(tmp_path: Path) -> None:
    _, out = _build(tmp_path)
    spec = feature_spec("full")
    panel = load_panel(out, spec)
    config = load_config(_config(tmp_path))
    fold = FoldConfig(date(2026, 7, 6), "development", "dev")
    protocol = ProtocolConfig("backtest", (fold,))
    config = replace(config, protocol=protocol)
    masks = fold_masks(panel, fold, protocol)
    train, calibrate, test = fold_slices(panel, masks)
    recipe = Recipe(
        "base_rate",
        "sigmoid",
        0.2,
        {
            "max_iter": config.model.max_iter,
            "learning_rate": config.model.learning_rate,
            "max_leaf_nodes": config.model.max_leaf_nodes,
            "random_state": config.model.random_state,
        },
        threshold_min_alerts=5,
    )
    result = fit_fold(recipe, fold, train, calibrate, test, config, spec)
    rows = _threshold_cells((result,), config, floor=0.2, min_alerts=5)
    assert len(rows) == 5 * len(HEADLINE_BANDS)
    assert all("thresholds" in row and "operating_point" in row for row in rows)
    assert all("threshold" not in row for row in rows)
    hold = _threshold_hold_rate(rows)
    assert hold["cells"] == len(rows)
    assert hold["with_operating_point"] == sum(row["operating_point"] for row in rows)
    pooled = _pooled_cell_metrics((result,), config)
    assert pooled["cell_threshold_rows"] == len(test)
    bands = _ttd_array(result.test)
    chosen = next(
        (key for key, entry in result.cell_thresholds.items() if entry["qualified"] and entry["alerts"] > 0),
        None,
    )
    assert chosen is not None
    headroom, band = chosen
    entry = result.cell_thresholds[chosen]
    mask = bands == band
    alert = result.probabilities[headroom][mask] >= float(entry["threshold"])
    row = next(item for item in rows if item["headroom_pct"] == headroom and item["ttd_band"] == band)
    assert row["test_alerts"] == int(alert.sum())
    assigned = np.full(len(test), np.inf)
    for (value, label), cell in result.cell_thresholds.items():
        if cell["qualified"]:
            assigned[(test.headroom == value) & (bands == label)] = float(cell["threshold"])
    assigned_alert = np.isfinite(assigned) & (result.calibrated >= assigned)
    assert pooled["cell_threshold_alerts"] == int(assigned_alert.sum())
    assert pooled["cell_threshold_precision"] == pytest.approx(
        np.sum(assigned_alert & (test.y == 1)) / max(int(assigned_alert.sum()), 1)
    )
    decisions = _decision_value_cells((result,), config, replicates=20, seed=4)
    assert decisions
    assert all("operating_point" in row for row in decisions)
    assert all("perfect_breach_vs_wait_eur" in row for row in decisions)
    decision = next(item for item in decisions if item["headroom_pct"] == headroom and item["band"] == band)
    check = np.asarray(test.check_price, dtype=np.float64)
    price = np.asarray(test.price, dtype=np.float64)
    valid = (bands == band) & np.isfinite(check) & np.isfinite(price) & (price > 0)
    saving = check[valid] - price[valid]
    expected = float(np.mean(np.where(result.probabilities[headroom][valid] >= float(entry["threshold"]), saving, 0.0)))
    assert decision["saving_vs_always_wait_eur"] == pytest.approx(expected)
    curves = _pr_curves((result,))
    assert curves
    assert all("points" in curve for curve in curves)
    assert sum(item["fold"] == "applied" for item in result.calibration_methods) == 1


def test_protocol_rejects_non_monday_and_unsorted_cutoffs(tmp_path: Path) -> None:
    raw = json.loads(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))
    raw["protocol"]["cutoffs"] = [{"cutoff": "2026-06-23", "role": "development", "name": "bad"}]
    path = tmp_path / "monday.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(ConfigError, match="Monday"):
        load_config(path)
    raw["protocol"]["cutoffs"] = [
        {"cutoff": "2026-06-29", "role": "development", "name": "later"},
        {"cutoff": "2026-06-22", "role": "development", "name": "earlier"},
    ]
    path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(ConfigError, match="sorted"):
        load_config(path)
    raw["protocol"]["cutoffs"] = [
        {"cutoff": "2026-06-22", "role": "evaluation", "name": "eval"},
        {"cutoff": "2026-06-29", "role": "development", "name": "dev"},
    ]
    path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(ConfigError, match="role order"):
        load_config(path)
    raw["protocol"]["cutoffs"] = [
        {"cutoff": "2026-06-22", "role": "development", "name": "same"},
        {"cutoff": "2026-06-29", "role": "development", "name": "same"},
    ]
    path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(ConfigError, match="unique names"):
        load_config(path)
    raw["protocol"]["cutoffs"] = [
        {"cutoff": "2026-06-22", "role": "development", "name": "../escape"},
    ]
    path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(ConfigError, match="fold name"):
        load_config(path)


def test_protocol_reads_and_validates_forward_sample_rate(tmp_path: Path) -> None:
    raw = json.loads(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))
    raw["protocol"]["forward"]["sample_rate"] = 0.25
    path = tmp_path / "sample.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    config = load_config(path)
    assert config.protocol.forward_sample_rate == 0.25
    assert load_config(DEFAULT_CONFIG_PATH).protocol.forward_sample_rate == 0.05

    raw["protocol"]["forward"]["sample_rate"] = 0.0
    path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(ConfigError, match="sample_rate"):
        load_config(path)


def _protocol_panel() -> TabularData:
    count = 8
    return TabularData(
        features={"hours_to_departure": np.full(count, 48.0, dtype=np.float32)},
        y=np.zeros(count, dtype=np.int8),
        series=np.array([f"s{i}" for i in range(count)], dtype=object),
        route_day=np.arange(count, dtype=np.int64),
        price=np.full(count, 100.0),
        check_price=np.full(count, 100.0),
        future_max=np.full(count, 100.0),
        future_observations=np.full(count, 2, dtype=np.int16),
        headroom=np.full(count, 1, dtype=np.int16),
        departure_date=np.full(count, "2026-07-01", dtype=object),
        snapshot_at=np.array(
            [
                "2026-06-01 10:00:00",
                "2026-06-21 12:00:00",
                "2026-06-23 10:00:00",
                "2026-06-30 10:00:00",
                "2026-06-19 10:00:00",
                "2026-06-20 00:00:00",
                "2026-06-24 10:00:00",
                "2026-07-02 10:00:00",
            ],
            dtype=object,
        ),
        observation_era=np.full(count, "dense", dtype=object),
        observation_week=np.full(count, "2026-W22", dtype=object),
        label_window_end=np.array(
            [
                "2026-06-02 10:00:00",
                "2026-06-21 12:00:00",
                "2026-06-24 10:00:00",
                "2026-07-01 10:00:00",
                "2026-06-23 10:00:00",
                "2026-06-21 00:00:00",
                "2026-06-24 10:00:00",
                "2026-07-08 10:00:00",
            ],
            dtype=object,
        ),
    )


def test_fold_masks_purge_on_label_end_and_gate_evaluation() -> None:
    panel = _protocol_panel()
    fold = FoldConfig(date(2026, 6, 22), "development", "dev")
    protocol = ProtocolConfig("backtest", (fold,))
    masks = fold_masks(panel, fold, protocol)
    # row 4 has a snapshot before the purge line but a label that matures after it: no block.
    # row 1 matures inside the embargo; row 5 sits exactly on the label-end boundary.
    assert masks.train.tolist() == [True, False, False, False, False, True, False, False]
    assert masks.calibrate.tolist() == [False, False, True, False, False, False, True, False]
    assert masks.test.tolist() == [False, False, False, True, False, False, False, False]
    assert_purged(panel, fold, protocol, masks)
    evaluation = FoldConfig(date(2026, 6, 22), "evaluation", "eval")
    forward = FoldConfig(date(2026, 6, 22), "forward", "forward")
    gated = ProtocolConfig("backtest", (fold, evaluation, forward))
    assert [item.name for item in scored_folds(gated, evaluate_test=False)] == ["dev"]
    assert [item.name for item in scored_folds(gated, evaluate_test=True)] == ["dev", "eval"]


def test_assert_purged_rejects_each_boundary_violation() -> None:
    panel = _protocol_panel()
    fold = FoldConfig(date(2026, 6, 22), "development", "dev")
    protocol = ProtocolConfig("backtest", (fold,))
    masks = fold_masks(panel, fold, protocol)
    index = np.arange(len(panel))

    train_leak = replace(masks, train=(index == 1) | masks.train)
    with pytest.raises(ModelError, match="training label"):
        assert_purged(panel, fold, protocol, train_leak)

    calibrate_leak = replace(masks, calibrate=(index == 7) | masks.calibrate)
    with pytest.raises(ModelError, match="calibration label"):
        assert_purged(panel, fold, protocol, calibrate_leak)

    test_snapshot_leak = replace(masks, test=(index == 1) | masks.test)
    with pytest.raises(ModelError, match="test snapshot"):
        assert_purged(panel, fold, protocol, test_snapshot_leak)

    test_label_leak = replace(masks, test=(index == 7) | masks.test)
    with pytest.raises(ModelError, match="test label"):
        assert_purged(panel, fold, protocol, test_label_leak)

    overlap = replace(masks, calibrate=(index == 0) | masks.calibrate)
    with pytest.raises(ModelError, match="overlap"):
        assert_purged(panel, fold, protocol, overlap)


def test_sparse_era_band_floor_and_domain_gate(tmp_path: Path) -> None:
    hours = np.repeat(np.array([48.0, 100.0, 150.0, 200.0, 400.0], dtype=np.float32), 25)
    count = len(hours)
    block = TabularData(
        features={"hours_to_departure": hours},
        y=np.ones(count, dtype=np.int8),
        series=np.array([f"s{i}" for i in range(count)], dtype=object),
        route_day=np.arange(count, dtype=np.int64),
        price=np.full(count, 100.0),
        check_price=np.full(count, 100.0),
        future_max=np.full(count, 100.0),
        future_observations=np.full(count, 2, dtype=np.int16),
        headroom=np.full(count, 1, dtype=np.int16),
        departure_date=np.full(count, "2026-09-01", dtype=object),
        snapshot_at=np.full(count, "2026-08-31 10:00:00", dtype=object),
        observation_era=np.full(count, "sparse", dtype=object),
        observation_week=np.full(count, "2026-W36", dtype=object),
        label_window_end=np.full(count, "2026-09-01 10:00:00", dtype=object),
    )
    config = load_config(_config(tmp_path))
    config = replace(
        config,
        report=replace(
            config.report,
            min_eligible_rows=0,
            min_split_positives=0,
            min_band_positives=50,
            min_sparse_band_positives=20,
        ),
    )
    sparse = FoldConfig(date(2026, 8, 31), "sparse_era", "sparse")
    _check_fold_gates(sparse, block, block, block, config)
    evaluation = FoldConfig(date(2026, 8, 31), "evaluation", "eval")
    with pytest.raises(DatasetError, match="positives"):
        _check_fold_gates(evaluation, block, block, block, config)

    short = block.subset(np.arange(75))
    with pytest.raises(DatasetError, match="missing TTD bands"):
        _check_fold_gates(evaluation, short, short, short, config)


def test_change_to_evaluation_calibration_labels_does_not_change_recipe(tmp_path: Path) -> None:
    _, out = _build(tmp_path)
    spec = feature_spec("full")
    panel = load_panel(out, spec)
    config = load_config(_config(tmp_path))
    protocol = ProtocolConfig(
        "backtest",
        (
            FoldConfig(date(2026, 7, 6), "development", "dev"),
            FoldConfig(date(2026, 7, 20), "evaluation", "eval"),
        ),
    )
    config = replace(config, protocol=protocol)
    frozen = select_outcome(panel, config, spec, replicates=200)
    mask = fold_masks(panel, protocol.cutoffs[1], protocol).calibrate
    mutated = replace(panel, y=np.where(mask, 1 - panel.y, panel.y).astype(np.int8))
    changed = select_outcome(mutated, config, spec, replicates=200)
    assert changed.model == frozen.model
    assert changed.calibration == frozen.calibration
    assert table_sha256(changed.table) == table_sha256(frozen.table)
    assert frozen.table["folds"] == ["dev"]


def test_sparse_era_fold_keeps_all_bands_in_train() -> None:
    count = 6
    panel = TabularData(
        features={"hours_to_departure": np.array([48.0, 240.0, 48.0, 240.0, 48.0, 240.0], dtype=np.float32)},
        y=np.zeros(count, dtype=np.int8),
        series=np.array([f"s{i}" for i in range(count)], dtype=object),
        route_day=np.arange(count, dtype=np.int64),
        price=np.full(count, 100.0),
        check_price=np.full(count, 100.0),
        future_max=np.full(count, 100.0),
        future_observations=np.full(count, 2, dtype=np.int16),
        headroom=np.full(count, 1, dtype=np.int16),
        departure_date=np.full(count, "2026-07-01", dtype=object),
        snapshot_at=np.array(
            [
                "2026-06-01 10:00:00",
                "2026-06-01 10:00:00",
                "2026-06-23 10:00:00",
                "2026-06-23 10:00:00",
                "2026-06-30 10:00:00",
                "2026-06-30 10:00:00",
            ],
            dtype=object,
        ),
        observation_era=np.full(count, "dense", dtype=object),
        observation_week=np.full(count, "2026-W22", dtype=object),
        label_window_end=np.array(
            [
                "2026-06-02 10:00:00",
                "2026-06-02 10:00:00",
                "2026-06-24 10:00:00",
                "2026-06-24 10:00:00",
                "2026-07-01 10:00:00",
                "2026-07-01 10:00:00",
            ],
            dtype=object,
        ),
    )
    fold = FoldConfig(date(2026, 6, 22), "sparse_era", "sparse")
    protocol = ProtocolConfig("backtest", (fold,), sparse_era_max_hours_to_departure=168)
    masks = fold_masks(panel, fold, protocol)
    assert masks.train.tolist() == [True, True, False, False, False, False]
    assert masks.calibrate.tolist() == [False, False, True, False, False, False]
    assert masks.test.tolist() == [False, False, False, False, True, False]
    assert_purged(panel, fold, protocol, masks)


def test_panel_loader_includes_label_window_end(tmp_path: Path) -> None:
    _, out = _build(tmp_path)
    panel = load_panel(out, feature_spec("full"))
    assert panel.label_window_end is not None
    assert len(panel.label_window_end) == len(panel.y) > 0


def test_config_rejects_out_of_range_check_windows(tmp_path: Path) -> None:
    for window in ([19, 28], [20, 29], [20, 21], [20], [20, "28"]):
        raw = json.loads(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))
        raw["label"]["check_window_hours"] = window
        path = tmp_path / f"window-{window}.json"
        path.write_text(json.dumps(raw), encoding="utf-8")
        with pytest.raises(ConfigError):
            load_config(path)


def test_band_positives_gate_raises(tmp_path: Path) -> None:
    source = tmp_path / "gate.parquet"
    _write_silver(source, _rows())
    config_path = _config(tmp_path)
    raw = json.loads(config_path.read_text())
    raw["report"]["min_eligible_rows"] = 0
    raw["report"]["min_split_positives"] = 0
    raw["report"]["min_headroom_positives"] = 0
    raw["report"]["min_band_positives"] = 10**9
    config_path.write_text(json.dumps(raw))
    connection = duckdb.connect()
    try:
        with pytest.raises(DatasetError, match="band"):
            build_dataset(
                connection,
                SourceSpec(glob=str(source), label="gate", build_id="gate", manifest_sha256=None),
                load_config(config_path),
                tmp_path / "gate-run",
                run_id="gate",
            )
    finally:
        connection.close()


def test_config_rejects_unknown_model_candidate(tmp_path: Path) -> None:
    raw = json.loads(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))
    raw["model"]["candidates"] = ["base_rate", "lightgbm"]
    path = tmp_path / "unknown-candidate.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(ConfigError, match="unknown model candidates"):
        load_config(path)


def test_config_rejects_covariate_in_static_mode(tmp_path: Path) -> None:
    raw = json.loads(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))
    raw["protocol"] = {"kind": "static_split"}
    raw["calibration"]["methods"] = ["sigmoid", "covariate"]
    path = tmp_path / "static-covariate.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(ConfigError, match="covariate is backtest-only"):
        load_config(path)


def test_config_rejects_out_of_range_headroom(tmp_path: Path) -> None:
    raw = json.loads(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))
    raw["label"]["headroom_pct"] = [1, 5, 40000]
    path = tmp_path / "headroom.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(ConfigError, match="int16"):
        load_config(path)


def test_config_rejects_overlapping_splits(tmp_path: Path) -> None:
    raw = json.loads(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))
    raw["splits"]["validation_select_start"] = raw["splits"]["train_end"]
    path = tmp_path / "bad.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(ConfigError):
        load_config(path)


def test_config_rejects_invalid_analog_offsets(tmp_path: Path) -> None:
    raw = json.loads(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))
    raw["features"] = {"analog_departures": {"enabled": True, "offsets_days": [7, 1]}}
    path = tmp_path / "analog-order.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(ConfigError, match="strictly increasing"):
        load_config(path)
    raw["features"] = {"analog_departures": {"enabled": "yes"}}
    path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(ConfigError, match="enabled must be a boolean"):
        load_config(path)


def test_label_window_sees_observations_under_24h_to_departure(tmp_path: Path) -> None:
    dates = [
        datetime(2026, 7, 5, 10, 0),
        datetime(2026, 7, 12, 10, 0),
        datetime(2026, 7, 22, 10, 0),
        datetime(2026, 7, 30, 10, 0),
    ]
    source = tmp_path / "window.parquet"
    rows: list[dict[str, object]] = []
    for index, departure in enumerate(dates):
        rows.extend(
            [
                _row(
                    observed_at=departure - timedelta(hours=30),
                    departure=departure,
                    route=f"r{index}",
                    train=f"ICE{index}",
                    fare=100.0,
                ),
                _row(
                    observed_at=departure - timedelta(hours=14),
                    departure=departure,
                    route=f"r{index}",
                    train=f"ICE{index}",
                    fare=110.0,
                ),
                _row(
                    observed_at=departure - timedelta(hours=6),
                    departure=departure,
                    route=f"r{index}",
                    train=f"ICE{index}",
                    fare=120.0,
                ),
            ]
        )
    _write_silver(source, rows)
    raw = json.loads(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))
    raw["splits"] = SPLITS
    raw["calendar"]["feature_set"] = "none"
    raw["sample"]["sample_rate"] = 1.0
    raw["report"]["min_headroom_positives"] = 0
    raw["report"]["min_eligible_rows"] = 0
    raw["report"]["min_split_positives"] = 0
    raw["report"]["min_band_positives"] = 0
    config_path = tmp_path / "window.json"
    config_path.write_text(json.dumps(raw), encoding="utf-8")
    config = load_config(config_path)
    connection = duckdb.connect()
    try:
        build_dataset(
            connection,
            SourceSpec(glob=str(source), label="window", build_id=None, manifest_sha256=None),
            config,
            tmp_path / "window-run",
            run_id="window",
        )
    finally:
        connection.close()
    data = load_split(tmp_path / "window-run" / "dataset" / "train.parquet", feature_spec("none"))
    assert len(data) == 1
    assert float(data.check_price[0]) == 120.0
    assert float(data.future_max[0]) == 120.0


def test_price_change_uses_raw_24h_reference(tmp_path: Path) -> None:
    departure = datetime(2026, 7, 10, 10, 0)
    source = tmp_path / "lag.parquet"
    _write_silver(
        source,
        [
            _row(
                observed_at=departure - timedelta(hours=800),
                departure=departure,
                route="lag",
                train="ICE9",
                fare=50.0,
            ),
            _row(
                observed_at=departure - timedelta(hours=54),
                departure=departure,
                route="lag",
                train="ICE9",
                fare=90.0,
            ),
            _row(
                observed_at=departure - timedelta(hours=30),
                departure=departure,
                route="lag",
                train="ICE9",
                fare=100.0,
            ),
            _row(
                observed_at=departure - timedelta(hours=10),
                departure=departure,
                route="lag",
                train="ICE9",
                fare=100.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 2, 10, 0),
                departure=datetime(2026, 7, 12, 10, 0),
                route="lag2",
                train="ICE8",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 12, 10, 0),
                departure=datetime(2026, 7, 22, 10, 0),
                route="lag5",
                train="ICE5",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 22, 10, 0),
                departure=datetime(2026, 8, 1, 10, 0),
                route="lag3",
                train="ICE7",
                fare=80.0,
            ),
            _row(
                observed_at=datetime(2026, 7, 30, 10, 0),
                departure=datetime(2026, 8, 10, 10, 0),
                route="lag4",
                train="ICE6",
                fare=80.0,
            ),
        ],
    )
    raw = json.loads(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))
    raw["splits"] = SPLITS
    raw["calendar"]["feature_set"] = "none"
    raw["sample"]["sample_rate"] = 1.0
    raw["report"]["min_headroom_positives"] = 0
    raw["report"]["min_eligible_rows"] = 0
    raw["report"]["min_split_positives"] = 0
    raw["report"]["min_band_positives"] = 0
    config_path = tmp_path / "lag.json"
    config_path.write_text(json.dumps(raw), encoding="utf-8")
    config = load_config(config_path)
    connection = duckdb.connect()
    try:
        build_dataset(
            connection,
            SourceSpec(glob=str(source), label="lag", build_id=None, manifest_sha256=None),
            config,
            tmp_path / "lag-run",
            run_id="lag",
        )
    finally:
        connection.close()
    data = load_split(tmp_path / "lag-run" / "dataset" / "train.parquet", feature_spec("none"))
    index = int(np.flatnonzero(data.price == 100.0)[0])
    assert float(data.features["price_change_24h"][index]) == pytest.approx(10.0)
    assert float(data.features["price_velocity_24h"][index]) == pytest.approx(10.0 / 24.0)
    assert float(data.features["price_vs_series_min"][index]) == pytest.approx(50.0)
    connection = duckdb.connect()
    try:
        regimes = connection.execute(
            "SELECT hours_to_departure, bin_regime FROM read_parquet(?) ORDER BY hours_to_departure",
            [str(tmp_path / "lag-run" / "dataset" / "train.parquet")],
        ).fetchall()
    finally:
        connection.close()
    assert (54.0, "12h") in regimes
    assert (30.0, "1h") in regimes


def _tabular(
    y: np.ndarray,
    future_observations: np.ndarray,
    headroom: np.ndarray,
    features: dict[str, np.ndarray] | None = None,
) -> TabularData:
    size = len(y)
    return TabularData(
        features=features or {},
        y=y,
        series=np.array([f"s{index}" for index in range(size)], dtype=object),
        route_day=np.arange(size, dtype=np.int64),
        price=np.full(size, 80.0, dtype=np.float64),
        future_max=np.full(size, 90.0, dtype=np.float64),
        future_observations=future_observations,
        headroom=headroom,
        departure_date=np.full(size, "2026-07-01", dtype=object),
        snapshot_at=np.array([f"2026-07-01T{index % 24:02d}:00:00" for index in range(size)], dtype=object),
        observation_era=np.full(size, "dense", dtype=object),
        observation_week=np.full(size, "2026-W27", dtype=object),
        check_price=np.full(size, np.nan, dtype=np.float64),
    )


def _evaluation(
    *, evaluation_on_test: bool, calibration_prevalence: float, train_prevalence: float, positive_rate: float
) -> Evaluation:
    return Evaluation(
        chosen_model="logistic",
        calibration_method="isotonic",
        threshold=0.5,
        threshold_precision_floor_met=True,
        candidates={},
        metrics={
            "brier": 0.2,
            "log_loss": 0.5,
            "roc_auc": 0.7,
            "average_precision": 0.5,
            "positive_rate": positive_rate,
            "precision_floor_met_on_evaluation": True,
            "headroom_monotonic": True,
        },
        metrics_all=None,
        evaluation_tier="all_labelled_rows",
        evaluation_tier_rows=1_000,
        calibration_rows=1_000,
        evaluation_split="test" if evaluation_on_test else "validation_calibrate",
        evaluation_on_test=evaluation_on_test,
        calibration_prevalence=calibration_prevalence,
        train_prevalence=train_prevalence,
        dropped_features=(),
        calibration=(np.array([0.2]), np.array([0.2]), np.array([10])),
        headroom=(),
        importance=(),
        bootstrap={"brier": [0.1, 0.3], "log_loss": [0.4, 0.6]},
        split_sizes={"train": 1_000},
    )


def _stats() -> DatasetStats:
    return DatasetStats(
        run_id="warnings",
        rows=1_000,
        labelled_rows=1_000,
        series=100,
        route_days=10,
        splits=(
            SplitStats(
                "train",
                rows=1_000,
                series=100,
                route_days=10,
                eligible=1_000,
                labelled=1_000,
                positives=240,
                positive_rate=0.24,
            ),
        ),
        duration_seconds=1.0,
    )


def test_train_prevalence_uses_one_population() -> None:
    train = _tabular(
        y=np.array([1, 0, 1, 0], dtype=np.int8),
        future_observations=np.array([1, 3, 3, 5], dtype=np.int16),
        headroom=np.array([1, 5, 10, 5], dtype=np.int32),
    )
    assert _train_prevalence(train) == pytest.approx(0.5)


def test_bss_train_uses_matching_train_prevalence() -> None:
    labels = np.array(([1] * 239) + ([0] * 761), dtype=np.int8)
    matching = _bss_train(0.11115, labels, 0.2704)
    inflated = _bss_train(0.11115, labels, 0.134)
    assert matching == pytest.approx(0.392, abs=0.002)
    assert inflated == pytest.approx(0.424, abs=0.002)
    assert matching is not None
    assert inflated is not None
    assert inflated > matching  # all-labelled train prevalence inflates the score


def test_prevalence_warnings_are_formatted_and_gated() -> None:
    evaluated = _evaluation(
        evaluation_on_test=True,
        calibration_prevalence=0.27037560714730513,
        train_prevalence=0.27037560714730513,
        positive_rate=0.2392969572255863,
    )
    warnings = _warnings(_stats(), evaluated)
    assert "prevalence shift between calibration and evaluation: 0.270 vs 0.239" in warnings
    assert "prevalence shift between train and evaluation: 0.270 vs 0.239" in warnings
    assert all("0.27037560714730513" not in warning for warning in warnings)
    validation_only = _evaluation(
        evaluation_on_test=False,
        calibration_prevalence=0.27037560714730513,
        train_prevalence=0.2392969572255863,
        positive_rate=0.2392969572255863,
    )
    assert not any("calibration and evaluation" in warning for warning in _warnings(_stats(), validation_only))


def test_ttd_band_boundaries() -> None:
    assert ttd_band(24) == "1-3d"
    assert ttd_band(71.999) == "1-3d"
    assert ttd_band(72) == "3-5d"
    assert ttd_band(336) == "14-30d"
    assert ttd_band(720) == "14-30d"
    assert ttd_band(721) == "unknown"
    assert len(HEADLINE_BANDS) == 5


def test_climatology_smoothing_is_bounded() -> None:
    data = _tabular(
        y=np.array([1, 0, 1, 0, 1, 0], dtype=np.int8),
        future_observations=np.full(6, 2, dtype=np.int16),
        headroom=np.array([5, 5, 10, 10, 30, 30], dtype=np.int16),
        features={
            "hours_to_departure": np.array([30, 30, 60, 60, 300, 300], dtype=np.float32),
            "service_class": np.array(["2", "1", "2", "1", "2", "1"], dtype=object),
        },
    )
    model = fit_climatology(data)
    predictions = model.predict(data)
    assert np.all(predictions > 0)
    assert np.all(predictions < 1)
    at_30 = model.predict(data, headroom=30)
    at_1 = model.predict(data, headroom=1)
    assert np.mean(at_30) <= np.mean(at_1)


def test_decision_value_sign_convention() -> None:
    size = 20
    data = _tabular(
        y=np.zeros(size, dtype=np.int8),
        future_observations=np.full(size, 2, dtype=np.int16),
        headroom=np.full(size, 1, dtype=np.int16),
    )
    half = size // 2
    data = TabularData(
        features=data.features,
        y=data.y,
        series=data.series,
        route_day=data.route_day,
        price=np.full(size, 100.0),
        future_max=data.future_max,
        future_observations=data.future_observations,
        headroom=data.headroom,
        departure_date=np.array([f"2026-07-{index % 10 + 1:02d}" for index in range(size)], dtype=object),
        snapshot_at=data.snapshot_at,
        observation_era=data.observation_era,
        observation_week=data.observation_week,
        check_price=np.array([110.0] * half + [90.0] * half),
    )
    rows = _decision_value_rows(
        data,
        (1,),
        [np.array([0.9] * half + [0.1] * half)],
        np.array(["1-3d"] * size),
        0.5,
        50,
        7,
    )
    row = rows[0]
    assert row["saving_vs_always_wait_eur"] == pytest.approx(5.0)
    assert row["saving_vs_always_book_eur"] == pytest.approx(5.0)
    assert row["conditional_saving_when_alert_eur"] == pytest.approx(10.0)
    assert row["cost_of_waiting_eur"] == pytest.approx(0.0)


def test_decision_row_pins_the_oracle_columns() -> None:
    saving = np.array([10.0, -20.0, -5.0, -10.0])
    price = np.array([100.0, 120.0, 80.0, 100.0])
    alert = np.array([True, True, False, False])
    labels = np.array([1, 0, 1, 0], dtype=np.int8)
    groups = np.array(["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"], dtype=object)
    row = _decision_row(
        band="1-3d",
        headroom_pct=5,
        price=price,
        saving=saving,
        alert=alert,
        groups=groups,
        replicates=50,
        seed=3,
        labels=labels,
    )
    assert row["alert_share"] == pytest.approx(0.5)
    assert row["saving_vs_always_wait_eur"] == pytest.approx(-2.5)
    assert row["saving_vs_always_book_eur"] == pytest.approx(3.75)
    assert row["random_alert_saving_vs_wait_eur"] == pytest.approx(-3.125)
    assert row["cost_of_waiting_eur"] == pytest.approx(-6.25)
    assert row["conditional_saving_when_alert_eur"] == pytest.approx(-5.0)
    assert row["perfect_breach_vs_wait_eur"] == pytest.approx(1.25)
    assert row["perfect_breach_vs_book_eur"] == pytest.approx(7.5)
    assert row["perfect_timing_vs_book_eur"] == pytest.approx(8.75)
    assert row["perfect_breach_rows"] == 2


def test_zero_alert_decision_row_is_kept() -> None:
    size = 20
    data = _tabular(
        y=np.zeros(size, dtype=np.int8),
        future_observations=np.full(size, 2, dtype=np.int16),
        headroom=np.full(size, 1, dtype=np.int16),
    )
    data = TabularData(
        features=data.features,
        y=data.y,
        series=data.series,
        route_day=data.route_day,
        price=np.full(size, 100.0),
        future_max=data.future_max,
        future_observations=data.future_observations,
        headroom=data.headroom,
        departure_date=np.array([f"2026-07-{index % 10 + 1:02d}" for index in range(size)], dtype=object),
        snapshot_at=data.snapshot_at,
        observation_era=data.observation_era,
        observation_week=data.observation_week,
        check_price=np.full(size, 110.0),
    )
    bands = np.array(["1-3d"] * size, dtype=object)
    rows = _decision_value_rows(data, (1,), [np.full(size, 0.1)], bands, 0.5, 7, 7)
    assert len(rows) == 1
    row = rows[0]
    assert row["alert_rows"] == 0
    assert row["conditional_saving_when_alert_eur"] is None
    assert row["saving_vs_always_wait_eur"] == pytest.approx(0.0)
    assert row["saving_vs_always_book_eur"] == pytest.approx(-10.0)
    pooled = _pooled_decision_value_rows(data, np.full(size, 0.1), bands, 0.5, 7, 7)
    assert len(pooled) == 1
    assert pooled[0]["alert_rows"] == 0
    assert pooled[0]["conditional_saving_when_alert_eur"] is None


def test_strata_do_not_fall_back_to_pooled_prevalence() -> None:
    size = 20
    data = _tabular(
        y=np.array([1, 0] * (size // 2), dtype=np.int8),
        future_observations=np.full(size, 2, dtype=np.int16),
        headroom=np.full(size, 5, dtype=np.int16),
        features={
            "hours_to_departure": np.full(size, 30.0, dtype=np.float32),
            "service_class": np.full(size, "A", dtype=object),
        },
    )
    train = _tabular(
        y=np.array([1, 0], dtype=np.int8),
        future_observations=np.full(2, 2, dtype=np.int16),
        headroom=np.full(2, 5, dtype=np.int16),
        features={
            "hours_to_departure": np.full(2, 30.0, dtype=np.float32),
            "service_class": np.array(["B", "B"], dtype=object),
        },
    )
    rows = _strata_rows(data, np.full(size, 0.5), train, 0.5)
    service = next(item for item in rows if item["dimension"] == "service_class")
    assert service["train_rows"] == 0
    assert service["bss_train"] is None


def test_bootstrap_helpers_produce_bounded_intervals() -> None:
    y = np.array([0, 1, 0, 1, 1, 0, 1, 0], dtype=np.int8)
    probabilities = np.array([0.1, 0.8, 0.2, 0.7, 0.9, 0.3, 0.6, 0.4])
    groups = np.array(["a", "a", "b", "b", "c", "c", "d", "d"], dtype=object)
    metrics = _bootstrap_metrics(y, probabilities, groups, 20, 7, 0.5)
    assert set(metrics) == {"bss", "roc_auc", "average_precision", "precision", "recall"}
    assert all(low <= high for low, high in metrics.values())
    paired = _bootstrap_paired(y, probabilities, np.full(len(y), 0.5), groups, 20, 8)
    assert len(paired) == 2
    assert paired[0] <= paired[1]
    interval = _cluster_mean_ci(probabilities, groups, 20, 9)
    assert len(interval) == 2
    assert interval[0] <= interval[1]
    constant = _cluster_mean_ci(np.full(len(y), 5.0), groups, 20, 9)
    assert constant == pytest.approx([5.0, 5.0])
    identical = _bootstrap_paired(y, probabilities, probabilities, groups, 20, 10)
    assert identical == pytest.approx([0.0, 0.0])
    assert _bootstrap(y, probabilities, np.full(len(y), "only"), 20, 11) == {}


def test_feature_study_is_development_only(tmp_path: Path) -> None:
    out = tmp_path / "study"
    code = main(
        [
            "--feature-study",
            "--evaluate-test",
            "--source",
            str(tmp_path / "missing.parquet"),
            "--out",
            str(out),
        ]
    )
    assert code == 2
    assert not out.exists()


def test_feature_study_requires_a_forward_availability_file(tmp_path: Path) -> None:
    out = tmp_path / "study-no-forward"
    assert main(["--feature-study", "--source", str(tmp_path / "missing.parquet"), "--out", str(out)]) == 2
    assert not out.exists()
    assert (
        main(
            [
                "--feature-study",
                "--forward-availability",
                str(tmp_path / "missing.parquet"),
                "--source",
                str(tmp_path / "missing.parquet"),
                "--out",
                str(out),
            ]
        )
        == 2
    )
    assert not out.exists()


def test_feature_study_rejects_calendar_override_and_profile(tmp_path: Path) -> None:
    out = tmp_path / "study-flags"
    assert (
        main(
            [
                "--feature-study",
                "--calendar-features",
                "full",
                "--forward-availability",
                str(tmp_path / "missing.parquet"),
                "--source",
                str(tmp_path / "missing.parquet"),
                "--out",
                str(out),
            ]
        )
        == 2
    )
    assert not out.exists()
    assert (
        main(
            [
                "--feature-study",
                "--profile",
                "--forward-availability",
                str(tmp_path / "missing.parquet"),
                "--source",
                str(tmp_path / "missing.parquet"),
                "--out",
                str(out),
            ]
        )
        == 2
    )
    assert not out.exists()


def test_feature_study_requires_the_backtest_config(tmp_path: Path) -> None:
    out = tmp_path / "study-static"
    code = main(
        [
            "--config",
            str(DEFAULT_CONFIG_PATH.parent / "training-static.json"),
            "--feature-study",
            "--source",
            str(tmp_path / "missing.parquet"),
            "--out",
            str(out),
        ]
    )
    assert code == 2
    assert not out.exists()


def test_backtest_flags_are_rejected_in_static_mode(tmp_path: Path) -> None:
    out = tmp_path / "static"
    code = main(
        [
            "--config",
            str(DEFAULT_CONFIG_PATH.parent / "training-static.json"),
            "--cache-dir",
            str(tmp_path / "cache"),
            "--source",
            str(tmp_path / "missing.parquet"),
            "--out",
            str(out),
        ]
    )
    assert code == 2
    assert not out.exists()


def test_cli_failure_leaves_no_output_or_temp(tmp_path: Path) -> None:
    source = tmp_path / "silver.parquet"
    rows = _rows()
    rows[-1]["schema_version"] = 2
    rows[-1]["journey_id"] = "v2-row"
    _write_silver(source, rows)
    config_path = _config(tmp_path)
    out = tmp_path / "nested" / "failed-run"
    assert (
        main(
            [
                "--config",
                str(config_path),
                "--source",
                str(source),
                "--out",
                str(out),
            ]
        )
        == 2
    )
    assert not out.exists()
    assert (tmp_path / "nested").is_dir()
    assert not list(tmp_path.glob(".failed-run.*.tmp"))


def test_single_class_calibration_preserves_requested_method() -> None:
    size = 20
    data = TabularData(
        features={},
        y=np.zeros(size, dtype=np.int8),
        series=np.array([f"s{index}" for index in range(size)], dtype=object),
        route_day=np.arange(size, dtype=np.int64),
        price=np.full(size, 100.0),
        future_max=np.where(np.arange(size) % 2 == 0, 135.0, 100.0),
        future_observations=np.full(size, 2, dtype=np.int16),
        headroom=np.full(size, 1, dtype=np.int16),
        departure_date=np.array([f"2026-07-{index % 5 + 1:02d}" for index in range(size)], dtype=object),
        snapshot_at=np.array([f"2026-06-{index + 1:02d}T10:00:00" for index in range(size)], dtype=object),
        observation_era=np.full(size, "dense", dtype=object),
        observation_week=np.full(size, "2026-W27", dtype=object),
        check_price=np.full(size, np.nan),
    )

    class FakeModel:
        def predict(self, rows: TabularData, headroom: int | None = None) -> np.ndarray:
            return np.linspace(0.1, 0.9, len(rows))

    config = load_config(DEFAULT_CONFIG_PATH)
    cal_data, calibrator, method, constant, _, _, _ = _fit_final_calibration(
        cast(FittedModel, FakeModel()), data, config
    )
    assert method in config.calibration.methods
    assert constant is True
    assert calibrator.method == "constant"
    y_mixed = (data.future_max >= data.price * 1.3).astype(np.int8)
    assert y_mixed.min() == 0
    assert y_mixed.max() == 1
    mixed = fit_calibrator(
        FakeModel().predict(cal_data),
        y_mixed,
        method,
        min_positives=config.calibration.min_positives,
    )
    assert mixed.method != "constant"


def test_calibration_metadata_records_sigmoid_fallback() -> None:
    size = 20
    y = np.zeros(size, dtype=np.int8)
    y[0] = 1
    data = TabularData(
        features={},
        y=y,
        series=np.array([f"s{index}" for index in range(size)], dtype=object),
        route_day=np.arange(size, dtype=np.int64),
        price=np.full(size, 100.0),
        future_max=np.full(size, 90.0),
        future_observations=np.full(size, 2, dtype=np.int16),
        headroom=np.full(size, 1, dtype=np.int16),
        departure_date=np.array([f"2026-07-{index % 5 + 1:02d}" for index in range(size)], dtype=object),
        snapshot_at=np.array([f"2026-06-{index + 1:02d}T10:00:00" for index in range(size)], dtype=object),
        observation_era=np.full(size, "dense", dtype=object),
        observation_week=np.full(size, "2026-W27", dtype=object),
        check_price=np.full(size, np.nan),
    )

    class FakeModel:
        def predict(self, rows: TabularData, headroom: int | None = None) -> np.ndarray:
            return np.linspace(0.1, 0.9, len(rows))

    config = load_config(DEFAULT_CONFIG_PATH)
    config = replace(
        config,
        calibration=replace(config.calibration, methods=("isotonic",), min_positives=1_000),
    )
    _, calibrator, method, constant, oof, _, _ = _fit_final_calibration(cast(FittedModel, FakeModel()), data, config)
    assert calibrator.method == "sigmoid"
    assert method == "sigmoid"
    assert constant is False
    assert len(oof["sigmoid"]) == size


def test_calibration_stats_are_reported() -> None:
    rng = np.random.default_rng(11)
    probabilities = rng.uniform(0.05, 0.95, size=20_000)
    y = rng.binomial(1, probabilities).astype(np.int8)
    stats = _calibration_stats(y, probabilities, 10)
    assert stats["slope"] == pytest.approx(1.0, abs=0.1)
    assert stats["intercept"] == pytest.approx(0.0, abs=0.1)
    assert stats["ece"] == pytest.approx(0.0, abs=0.03)


def test_calibration_counts_match_quantile_bins() -> None:
    rng = np.random.default_rng(3)
    y = rng.integers(0, 2, size=10_000).astype(np.int8)
    probabilities = rng.beta(2, 12, size=10_000)
    predicted, observed, counts = _calibration_curve(y, probabilities, 10)
    assert len(predicted) == len(observed) == len(counts)
    assert int(counts.sum()) == len(y)
    assert counts.min() > len(y) / 30  # quantile bins, not uniform bins


def test_cli_profile_and_full_run(tmp_path: Path) -> None:
    source = tmp_path / "silver.parquet"
    _write_silver(source, _rows())
    config = _config(tmp_path)
    profile_out = tmp_path / "profile"
    assert (
        main(
            [
                "--config",
                str(config),
                "--source",
                str(source),
                "--out",
                str(profile_out),
                "--profile",
            ]
        )
        == 0
    )
    assert (profile_out / "profile.json").is_file()
    profile_json = json.loads((profile_out / "profile.json").read_text())
    assert profile_json["profile"]["cohort"]
    assert profile_json["profile"]["label"]
    assert profile_json["profile"]["journey"]["total_journeys"] >= 0
    assert profile_json["profile"]["a18"]
    assert profile_json["profile"]["a19"]
    assert profile_json["profile"]["a26"]
    assert "a24" in profile_json["profile"]
    assert profile_json["profile"]["label_era"]
    assert profile_json["profile"]["label_week"]
    assert all("successor_60" in group for group in profile_json["profile"]["journey"]["groups"])
    assert "end_of_observation_at_risk" in profile_json["profile"]["journey"]

    run_out = tmp_path / "run"
    assert (
        main(
            [
                "--config",
                str(config),
                "--source",
                str(source),
                "--out",
                str(run_out),
            ]
        )
        == 0
    )
    assert (run_out / "report.md").is_file()
    assert (run_out.stat().st_mode & 0o777) == 0o755
    assert (run_out / "metrics.json").is_file()
    assert (run_out / "calibration.csv").is_file()
    assert (run_out / "manifest.json").is_file()
    connection = duckdb.connect()
    try:
        columns = {
            row[0]
            for row in connection.execute(
                f"DESCRIBE SELECT * FROM read_parquet('{run_out / 'dataset' / 'train.parquet'}')"
            ).fetchall()
        }
    finally:
        connection.close()
    assert {
        "check_at",
        "check_lag_h",
        "cov_tail_h",
        "cov_max_gap_h",
        "breached_next_day",
        "eligible",
        "censor_reason",
        "price_cents",
        "check_price_cents",
        "breached_within_24h",
    } <= columns
    report_text = (run_out / "report.md").read_text()
    assert "Known limitations" in report_text
    assert "Prevalence:" in report_text
    assert "average precision" in report_text
    assert "| split | rows | series | chains |" in report_text
    manifest_json = json.loads((run_out / "manifest.json").read_text())
    assert manifest_json["evaluation_on_test"] is False
    assert "test" not in manifest_json["model"]
    assert manifest_json["duckdb_settings"]["memory_limit"]
    assert manifest_json["duckdb_settings"]["max_temp_directory_size"]
    metrics = json.loads((run_out / "metrics.json").read_text())
    assert metrics["evaluation"]["chosen_model"] in {"base_rate", "logistic", "hist_gradient_boosting"}
    assert len(metrics["evaluation"]["headroom"]) == 5
    assert metrics["evaluation"]["evaluation_on_test"] is False
    assert metrics["evaluation"]["metrics"]["split"] == "validation_calibrate"
    assert "test" not in metrics["evaluation"]
    assert metrics["evaluation"]["climatology"]["brier"] is not None
    assert set(metrics["evaluation"]["candidate_train"]) == set(metrics["evaluation"]["candidates"])
    assert 0 < len(metrics["evaluation"]["headroom_ttd"]) <= 25
    assert (run_out / "predictions" / "validation_calibrate.parquet").is_file()
    assert not (run_out / "predictions" / "test.parquet").exists()
    assert "| test |" not in report_text
    assert (run_out / "model.joblib").is_file()
    assert "predictions/validation_calibrate.parquet" in manifest_json["artifacts"]
    assert manifest_json["model"]["predictions"] == "predictions/validation_calibrate.parquet"
    assert "config_sha256" not in manifest_json
    assert manifest_json["build_config_sha256"]
    assert "evaluation_config" in manifest_json
    assert "model.joblib" in manifest_json["artifact_sha256"]
    assert "column_roles.json" in manifest_json["artifact_sha256"]
    assert manifest_json["runtime"]["wall_seconds"] > 0
    assert manifest_json["git_sha"]
    assert manifest_json["git_sha_end"]
    assert isinstance(manifest_json["git_dirty"], bool)
    assert all(item["split"] != "test" for item in metrics["dataset"]["splits"])
    splits = metrics["dataset"]["splits"]
    assert metrics["dataset"]["rows"] == sum(item["rows"] for item in splits)
    assert metrics["dataset"]["labelled_rows"] == sum(item["labelled"] for item in splits)
    assert metrics["dataset"]["series"] == sum(item["series"] for item in splits)
    assert metrics["dataset"]["route_days"] == sum(item["route_days"] for item in splits)
    assert "test" not in metrics["evaluation"]["split_sizes"]
    for key in (
        "headroom",
        "coverage",
        "cohort",
        "early_window",
        "ttd",
        "label",
        "label_era",
        "label_week",
        "a18",
        "a19",
        "a24",
        "censored_band",
        "censored_outcome",
        "a26",
        "a29",
        "tier",
        "unlabelled",
        "coverage_r24",
        "era",
    ):
        assert all(item.get("split") != "test" for item in metrics["dataset"]["profile"].get(key, []))
    assert manifest_json["runtime"]["peak_rss_kb"] > 0
    predictions_schema = pq.read_schema(run_out / "predictions" / "validation_calibrate.parquet")
    assert pa.types.is_timestamp(predictions_schema.field("snapshot_at").type)
    assert pa.types.is_date32(predictions_schema.field("departure_date").type)
    assert "chain_id" in predictions_schema.names
    predictions = pq.read_table(run_out / "predictions" / "validation_calibrate.parquet").to_pydict()
    assert len(predictions["label"]) == 5 * metrics["evaluation"]["evaluation_tier_rows"]
    assert set(predictions["calibration_mode"]) == {"oof"}
    assert min(predictions["calibration_fold"]) >= 0
    assert {"raw_score_pooled", "assigned_headroom", "calibrated_score_pooled", "ttd_band", "chain_id"} <= set(
        predictions
    )
    connection = duckdb.connect()
    try:
        mismatch_row = connection.execute(
            "SELECT count(*), count(*) FILTER (WHERE p.label != d.breached_next_day) "
            "FROM read_parquet(?) p JOIN read_parquet(?) d USING (series_key, snapshot_at, headroom_pct) "
            "WHERE p.headroom_pct = 1",
            [
                str(run_out / "predictions" / "validation_calibrate.parquet"),
                str(run_out / "dataset" / "validation_calibrate.parquet"),
            ],
        ).fetchone()
        assert mismatch_row is not None
        joined, mismatches = mismatch_row
    finally:
        connection.close()
    assert joined > 0
    assert mismatches == 0
    model_payload = load_model(run_out / "model.joblib", manifest_json["artifact_sha256"]["model.joblib"])
    assert model_payload["chosen_model"] == metrics["evaluation"]["chosen_model"]
    assert model_payload["calibration_mode"] == "oof"
    assert "source" not in model_payload["config"]
    assert "prediction_series" not in metrics["evaluation"]

    test_out = tmp_path / "tested"
    assert (
        main(
            [
                "--config",
                str(config),
                "--source",
                str(source),
                "--out",
                str(test_out),
                "--evaluate-test",
            ]
        )
        == 0
    )
    tested = json.loads((test_out / "metrics.json").read_text())
    assert tested["evaluation"]["evaluation_on_test"] is True
    assert tested["evaluation"]["metrics"]["split"] == "test"
    assert tested["evaluation_on_test"] is True
    assert (test_out / "predictions" / "test.parquet").is_file()
    tested_predictions = pq.read_table(test_out / "predictions" / "test.parquet").to_pydict()
    assert set(tested_predictions["calibration_mode"]) == {"full"}
    assert set(tested_predictions["calibration_fold"]) == {-1}
