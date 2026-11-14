"""The quality gate must accept good builds and reject each broken invariant."""

from __future__ import annotations

import shutil
from datetime import datetime
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from tests.conftest import BERLIN, MUNICH, V1_FIELDS, Built, bronze_row, v1_row, write_bronze
from tpm_analytics.silver import quality
from tpm_analytics.silver.build import run_build


def unchecked(source: str, target: Path) -> Built:
    return Built(stats=run_build(source, target, verify=False), target=target)


def violations_for(connection: duckdb.DuckDBPyConnection, built: Built, source: str) -> list[quality.Violation]:
    return quality.check(
        connection,
        bronze_glob=source,
        silver_glob=str(built.target / "**" / "*.parquet"),
        rows_in=built.stats.rows_in,
    )


def names(violations: list[quality.Violation]) -> list[str]:
    return [violation.check for violation in violations]


def test_good_build_passes(build, duck, bronze_glob: str) -> None:
    built = build()
    assert violations_for(duck, built, bronze_glob) == []


def test_v1_null_fare_is_rejected(tmp_path: Path, duck) -> None:
    root = tmp_path / "bad-v1"
    write_bronze(root / "day=01", [v1_row(fare_lowest_eur=None)], schema_version=1)
    source = str(root / "**" / "*.parquet")
    assert "null fare on a v1 row" in names(violations_for(duck, unchecked(source, tmp_path / "silver-bad-v1"), source))


def test_v2_journey_id_is_required(tmp_path: Path, duck) -> None:
    root = tmp_path / "bad-v2"
    write_bronze(root / "day=01", [v1_row(journey_id=None, schema_version=2)], schema_version=2)
    source = str(root / "**" / "*.parquet")
    built = unchecked(source, tmp_path / "silver-bad-v2")
    assert "journey_id missing on a v2 row" in names(violations_for(duck, built, source))


def test_duplicate_observations_are_rejected(tmp_path: Path, duck) -> None:
    root = tmp_path / "duplicates"
    write_bronze(root / "day=01", [bronze_row(), bronze_row()], schema_version=2)
    source = str(root / "**" / "*.parquet")
    built = unchecked(source, tmp_path / "silver-duplicates")
    assert "duplicate observations" in names(violations_for(duck, built, source))


def test_negative_days_are_history_before_the_fix(tmp_path: Path, duck) -> None:
    root = tmp_path / "negative-history"
    write_bronze(
        root / "day=01",
        [bronze_row(observed_at=datetime(2026, 6, 1, 8, 0), days_to_departure=-0.5)],
        schema_version=2,
    )
    source = str(root / "**" / "*.parquet")
    built = unchecked(source, tmp_path / "silver-negative-history")
    assert violations_for(duck, built, source) == []


def test_negative_days_are_rejected_after_the_fix(tmp_path: Path, duck) -> None:
    root = tmp_path / "negative-postfix"
    write_bronze(
        root / "day=01",
        [bronze_row(observed_at=datetime(2026, 11, 14, 8, 0), days_to_departure=-0.5)],
        schema_version=2,
    )
    source = str(root / "**" / "*.parquet")
    built = unchecked(source, tmp_path / "silver-negative-postfix")
    assert "negative days_to_departure after the fix" in names(violations_for(duck, built, source))


def test_odd_v1_transfers_are_rejected(tmp_path: Path, duck) -> None:
    root = tmp_path / "odd-transfers"
    write_bronze(root / "day=01", [v1_row(transfers=3)], schema_version=1)
    source = str(root / "**" / "*.parquet")
    built = unchecked(source, tmp_path / "silver-odd")
    assert "odd transfers on a v1 row" in names(violations_for(duck, built, source))


def test_unknown_load_factor_is_rejected(tmp_path: Path, duck) -> None:
    root = tmp_path / "unknown-factor"
    write_bronze(root / "day=01", [bronze_row(load_factor="packed", load_factor_ordinal=2)], schema_version=2)
    source = str(root / "**" / "*.parquet")
    built = unchecked(source, tmp_path / "silver-unknown-factor")
    assert "unknown load_factor value" in names(violations_for(duck, built, source))


def test_ordinal_value_is_checked(tmp_path: Path, duck) -> None:
    root = tmp_path / "wrong-ordinal"
    write_bronze(root / "day=01", [bronze_row(load_factor="high", load_factor_ordinal=4)], schema_version=2)
    source = str(root / "**" / "*.parquet")
    built = unchecked(source, tmp_path / "silver-wrong-ordinal")
    assert "load_factor_ordinal does not match load_factor" in names(violations_for(duck, built, source))


def test_non_positive_fare_is_rejected(tmp_path: Path, duck) -> None:
    root = tmp_path / "zero-fare"
    write_bronze(root / "day=01", [bronze_row(fare_lowest_eur=0.0)], schema_version=2)
    source = str(root / "**" / "*.parquet")
    built = unchecked(source, tmp_path / "silver-zero-fare")
    assert "non-positive fare" in names(violations_for(duck, built, source))


def test_partition_mismatch_is_rejected(build, duck, bronze_glob: str) -> None:
    built = build()
    source_file = next(built.target.glob("departure_year=2026/departure_month=11/*.parquet"))
    wrong = built.target / "departure_year=2020" / "departure_month=01"
    wrong.mkdir(parents=True)
    shutil.copy(source_file, wrong / "data_0.parquet")
    assert "partition does not match departure_date" in names(violations_for(duck, built, bronze_glob))


def test_bronze_column_dropped_is_rejected(tmp_path: Path, duck) -> None:
    """A column the scraper adds later must fail the build, not be silently projected away."""
    root = tmp_path / "future-schema"
    fields = [pa.field(name, kind) for name, kind, _ in V1_FIELDS]
    fields.append(pa.field("future_metric", pa.float64()))
    table = pa.Table.from_pylist(
        [
            {
                "observed_at": datetime(2026, 11, 14, 8, 0),
                "service_class": 2,
                "route_id": f"{BERLIN[0]}-{MUNICH[0]}",
                "origin_eva": BERLIN[0],
                "origin_name": BERLIN[1],
                "dest_eva": MUNICH[0],
                "dest_name": MUNICH[1],
                "departure_planned": datetime(2026, 12, 1, 10, 0),
                "arrival_planned": datetime(2026, 12, 1, 14, 0),
                "train_type": "ICE",
                "train_number": "1",
                "transfers": 0,
                "duration_minutes": 240,
                "days_to_departure": 3.0,
                "fare_lowest_eur": 49.9,
                "load_factor": "low",
                "future_metric": 1.0,
            }
        ],
        schema=pa.schema(fields),
    )
    root.mkdir()
    pq.write_table(table, root / "batch.parquet")
    source = str(root / "**" / "*.parquet")
    built = unchecked(source, tmp_path / "silver-future")
    assert "bronze column dropped by the transform" in names(violations_for(duck, built, source))


def test_departure_beyond_the_reviewed_timetable_is_rejected(tmp_path: Path, duck) -> None:
    root = tmp_path / "stale-timetable"
    write_bronze(
        root / "day=01",
        [bronze_row(departure_planned=datetime(2027, 7, 1, 9, 0), arrival_planned=datetime(2027, 7, 1, 13, 0))],
        schema_version=2,
    )
    source = str(root / "**" / "*.parquet")
    built = unchecked(source, tmp_path / "silver-stale-timetable")
    assert "departure beyond the reviewed timetable period" in names(violations_for(duck, built, source))


def test_missing_columns_are_reported(duck, bronze_glob: str) -> None:
    """Pointing the gate at bronze (which lacks the derived columns) must fail loudly."""
    found = quality.check(duck, bronze_glob=bronze_glob, silver_glob=bronze_glob, rows_in=6)
    assert names(found) == ["missing columns"]
    assert "distance_km" in found[0].detail


def test_raise_for_violations_is_a_runtime_error(duck, build, bronze_glob: str) -> None:
    built = build()
    quality.raise_for_violations(violations_for(duck, built, bronze_glob))  # no raise

    with pytest.raises(quality.QualityError):
        quality.raise_for_violations([quality.Violation("row count bronze != silver", "6 != 5")])
