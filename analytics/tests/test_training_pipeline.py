"""End-to-end tests for the training dataset and the one-command CLI."""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import datetime, timedelta
from pathlib import Path

import duckdb
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from tpm_analytics.training.cli import main
from tpm_analytics.training.config import DEFAULT_CONFIG_PATH, ConfigError, load_config
from tpm_analytics.training.dataset import DatasetError, DatasetStats, build_dataset
from tpm_analytics.training.features import feature_spec
from tpm_analytics.training.model import _calibration_curve, load_split
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
    assert (run_out / "metrics.json").is_file()
    assert (run_out / "calibration.csv").is_file()
    assert (run_out / "manifest.json").is_file()
    metrics = json.loads((run_out / "metrics.json").read_text())
    assert metrics["evaluation"]["chosen_model"] in {"base_rate", "logistic", "hist_gradient_boosting"}
    assert len(metrics["evaluation"]["headroom"]) == 5
