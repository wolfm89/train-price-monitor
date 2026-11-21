"""End-to-end tests for the training dataset and the one-command CLI."""

from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from datetime import datetime, timedelta
from pathlib import Path
from typing import cast

import duckdb
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from tpm_analytics.training.bands import HEADLINE_BANDS, ttd_band
from tpm_analytics.training.cli import main
from tpm_analytics.training.config import DEFAULT_CONFIG_PATH, ConfigError, load_config
from tpm_analytics.training.dataset import (
    DatasetError,
    DatasetStats,
    SplitStats,
    _final_columns,
    _git_state,
    build_dataset,
)
from tpm_analytics.training.features import feature_spec
from tpm_analytics.training.identity import berlin_week_sql, series_key_sql
from tpm_analytics.training.model import (
    Evaluation,
    FittedModel,
    TabularData,
    _bootstrap,
    _bootstrap_metrics,
    _bootstrap_paired,
    _bss_train,
    _calibration_curve,
    _calibration_stats,
    _cluster_mean_ci,
    _decision_value_rows,
    _fit_final_calibration,
    _pooled_decision_value_rows,
    _strata_rows,
    _train_prevalence,
    fit_calibrator,
    fit_climatology,
    load_model,
    load_split,
    train_and_evaluate,
)
from tpm_analytics.training.report import _warnings
from tpm_analytics.training.sources import SourceSpec

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
    *, observed_at: datetime, departure: datetime, route: str, train: str, fare: float, **overrides: object
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
    raw["report"]["min_headroom_positives"] = 0
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
    expected = (data.future_max >= data.price * (1 + data.headroom / 100.0)).astype(np.int8)
    assert np.array_equal(data.y, expected)
    assert (data.headroom == 1).any()

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
    raw["report"]["min_label_coverage"] = 0
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
    raw["report"]["min_label_coverage"] = 0
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
        spring = connection.execute(f"SELECT {berlin_week_sql("TIMESTAMP '2026-03-29 00:30:00'")}").fetchone()
        autumn = connection.execute(f"SELECT {berlin_week_sql("TIMESTAMP '2026-10-25 00:30:00'")}").fetchone()
    finally:
        connection.close()
    assert spring is not None
    assert spring[0] == "2026-W13"
    assert autumn is not None
    assert autumn[0] == "2026-W43"


def test_chain_follows_arrival_change(tmp_path: Path) -> None:
    stats, out = _build_chain_dataset(tmp_path, _chain_fixture())
    assert stats.profile["chain"]["links"] >= 1
    assert stats.profile["chain"]["chains"] >= 1
    assert stats.profile["duplicates"]["duplicate_groups"] >= 1
    assert stats.profile["duplicates"]["extra_duplicate_rows"] >= 1
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


def test_chain_matching_is_maximum_cardinality(tmp_path: Path) -> None:
    departure = datetime(2026, 7, 6, 20, 0)
    later = datetime(2026, 7, 6, 20, 10)
    earlier = datetime(2026, 7, 6, 19, 45)
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
    stats, _ = _build_chain_dataset(tmp_path, rows)
    chain = stats.profile["chain"]
    assert chain["candidate_links"] == 3
    assert chain["links"] == 2
    assert chain["chains"] == 2
    assert chain["unused_candidates"] == 1


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
    assert str(predictions["snapshot_at"][in_bin[0]]) == "2026-07-05 12:45:00"


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
    raw["report"]["min_label_coverage"] = 0
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


def test_evaluate_test_with_mixed_evidence_tier(tmp_path: Path) -> None:
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
    raw["report"]["min_tier_rows"] = 1
    raw["report"]["min_label_coverage"] = 0
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
    assert metrics["evaluation"]["metrics_all"] is not None
    assert metrics["evaluation"]["evaluation_tier"] == "two_plus_observations"
    assert metrics["evaluation"]["evaluation_tier_rows"] >= 1
    assert (out / "predictions" / "test.parquet").is_file()


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
    raw["report"]["min_label_coverage"] = 0
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
            "check_at_2028, check_at_2226, check_price_2028_eur, check_price_2226_eur "
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
    raw["report"]["min_label_coverage"] = 0
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
            "SELECT route_id, check_at, check_at_2028, check_at_2226, "
            "check_price_2028_eur, check_price_2226_eur FROM read_parquet(?) "
            "WHERE snapshot_at = TIMESTAMP '2026-07-03 11:00:00' ORDER BY route_id",
            [str(tmp_path / "windows-run" / "dataset" / "train.parquet")],
        ).fetchall()
    finally:
        connection.close()
    by_route = {row[0]: row for row in rows}
    only25 = by_route["only25"]
    assert only25[1] is None
    assert str(only25[2]) == "2026-07-04 12:00:00"
    assert str(only25[3]) == "2026-07-04 12:00:00"
    assert only25[4] == pytest.approx(90.0)
    assert only25[5] == pytest.approx(90.0)
    only265 = by_route["only265"]
    assert only265[1] is None
    assert str(only265[2]) == "2026-07-04 13:30:00"
    assert only265[3] is None
    assert only265[4] == pytest.approx(95.0)
    assert only265[5] is None
    after = by_route["after"]
    assert after[1] is None
    assert after[2] is None
    assert after[3] is None
    assert after[4] is None
    assert after[5] is None


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
    raw["report"]["min_label_coverage"] = 0
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
            "SELECT check_at, check_at_2028, check_price_2028_eur FROM read_parquet(?) "
            "WHERE route_id = 'subsecond' AND snapshot_at = TIMESTAMP '2026-07-03 10:00:00.900'",
            [str(tmp_path / "microseconds-run" / "dataset" / "train.parquet")],
        ).fetchone()
    finally:
        connection.close()
    assert row is not None
    assert str(row[0]) == "2026-07-04 10:00:00.100000"
    assert str(row[1]) == "2026-07-04 10:00:01"
    assert row[2] == pytest.approx(96.0)


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
    raw["report"]["min_label_coverage"] = 0
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
            "SELECT check_at_2028, check_price_2028_eur FROM read_parquet(?) "
            "WHERE snapshot_at = TIMESTAMP '2026-07-03 14:00:00'",
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
    assert _git_state() == (None, None)


def test_column_roles_and_source_inventory(tmp_path: Path) -> None:
    _, out = _build(tmp_path)
    roles = json.loads((out / "column_roles.json").read_text())
    manifest = json.loads((out / "dataset_manifest.json").read_text())
    assert manifest["column_roles"] == "column_roles.json"
    assert roles["version"] == 1
    assert set(roles["features"]) == set(feature_spec("full").names)
    assert not set(roles["features"]) & set(roles["labels"])
    assert not set(roles["features"]) & set(roles["audit"])
    assert not set(roles["labels"]) & set(roles["audit"])
    assert set(roles["features"] + roles["labels"] + roles["audit"]) == set(_final_columns("full"))
    assert manifest["source_inventory"]
    assert all(item["sha256"] and item["bytes"] for item in manifest["source_inventory"])


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
    raw["report"]["min_label_coverage"] = 0.0
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


def test_calibrator_outputs_are_bounded() -> None:
    rng = np.random.default_rng(5)
    raw = rng.random(1000)
    y = rng.integers(0, 2, size=1000)
    calibrator = fit_calibrator(raw, y, "isotonic", min_positives=1)
    probabilities = calibrator.predict(raw)
    assert probabilities.min() >= 1e-3
    assert probabilities.max() <= 1.0 - 1e-3


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
    raw["report"]["min_label_coverage"] = 0.0
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
    raw["report"]["min_label_coverage"] = 1.0
    config_path = tmp_path / "coverage-gate.json"
    config_path.write_text(json.dumps(raw), encoding="utf-8")
    config = load_config(config_path)
    spec = SourceSpec(glob=str(source), label="reusable", build_id=None, manifest_sha256=None)
    out = tmp_path / "reusable-run"
    connection = duckdb.connect()
    try:
        with pytest.raises(DatasetError, match="labelled rows"):
            build_dataset(connection, spec, config, out, run_id="reusable")
    finally:
        connection.close()
    assert not out.exists()
    permissive = replace(config, report=replace(config.report, min_label_coverage=0.0))
    connection = duckdb.connect()
    try:
        build_dataset(connection, spec, permissive, out, run_id="reusable")
    finally:
        connection.close()
    assert (out / "dataset" / "train.parquet").is_file()


def test_config_rejects_overlapping_splits(tmp_path: Path) -> None:
    raw = json.loads(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))
    raw["splits"]["validation_select_start"] = raw["splits"]["train_end"]
    path = tmp_path / "bad.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(ConfigError):
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
            ]
        )
    _write_silver(source, rows)
    raw = json.loads(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))
    raw["splits"] = SPLITS
    raw["calendar"]["feature_set"] = "none"
    raw["sample"]["sample_rate"] = 1.0
    raw["report"]["min_headroom_positives"] = 0
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
    assert float(data.future_max[0]) == 110.0


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
    raw["report"]["min_label_coverage"] = 0.0
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
        evaluation_tier="two_plus_observations",
        evaluation_tier_rows=1_000,
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
                "train", rows=1_000, series=100, route_days=10, labelled=1_000, positives=240, positive_rate=0.24
            ),
        ),
        duration_seconds=1.0,
    )


def test_train_prevalence_matches_evaluated_tier() -> None:
    train = _tabular(
        y=np.array([1, 0, 1, 0], dtype=np.int8),
        future_observations=np.array([1, 3, 3, 5], dtype=np.int16),
        headroom=np.array([1, 5, 10, 5], dtype=np.int32),
    )
    assert _train_prevalence(train, "all_labelled_rows") == pytest.approx(0.5)
    assert _train_prevalence(train, "two_plus_observations") == pytest.approx(1 / 3)


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
    assert profile_json["profile"]["two_plus_week"] is not None
    assert profile_json["profile"]["label_era"]
    assert profile_json["profile"]["label_week"]
    assert all("successor_60" in group for group in profile_json["profile"]["journey"]["groups"])

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
    assert {"check_at", "check_lag_h", "cov_tail_h", "cov_max_gap_h", "breached_at_check"} <= columns
    report_text = (run_out / "report.md").read_text()
    assert "Known limitations" in report_text
    assert "Prevalence:" in report_text
    assert "average precision" in report_text
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
    predictions_schema = pq.read_schema(run_out / "predictions" / "validation_calibrate.parquet")
    assert pa.types.is_timestamp(predictions_schema.field("snapshot_at").type)
    assert pa.types.is_date32(predictions_schema.field("departure_date").type)
    predictions = pq.read_table(run_out / "predictions" / "validation_calibrate.parquet").to_pydict()
    assert len(predictions["label"]) == 5 * metrics["evaluation"]["evaluation_tier_rows"]
    assert set(predictions["calibration_mode"]) == {"oof"}
    assert min(predictions["calibration_fold"]) >= 0
    assert {"raw_score_pooled", "assigned_headroom", "calibrated_score_pooled", "ttd_band"} <= set(predictions)
    connection = duckdb.connect()
    try:
        mismatch_row = connection.execute(
            "SELECT count(*), count(*) FILTER (WHERE p.label != "
            "CAST(d.future_max_fare_24h >= d.price_eur * 1.01 AS TINYINT)) "
            "FROM read_parquet(?) p JOIN read_parquet(?) d USING (series_key, snapshot_at) "
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

    ablation_out = tmp_path / "ablation"
    assert (
        main(
            [
                "--config",
                str(config),
                "--source",
                str(source),
                "--out",
                str(ablation_out),
                "--ablation",
            ]
        )
        == 0
    )
    ablated = json.loads((ablation_out / "metrics.json").read_text())
    assert ablated["evaluation_on_test"] is False
    assert all("test_brier" not in item for item in ablated["ablation"].values())
