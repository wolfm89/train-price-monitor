"""Semantics of the bronze → silver transform."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import duckdb
import pyarrow.parquet as pq
import pytest

from tests.conftest import Built, bronze_row, v1_row, write_bronze
from tpm_analytics.silver import quality
from tpm_analytics.silver.build import run_build


def silver(glob_source: Path | str) -> str:
    glob = str(glob_source / "**" / "*.parquet") if isinstance(glob_source, Path) else glob_source
    return f"read_parquet('{glob}', union_by_name = true, hive_partitioning = true)"


def rows(connection: duckdb.DuckDBPyConnection, built: Built, sql: str) -> list[tuple[object, ...]]:
    return connection.execute(sql.replace("{silver}", silver(built.target))).fetchall()


def test_row_count_and_partitions(build: Callable[..., Built]) -> None:
    built = build()
    assert built.stats.rows_in == 6
    assert built.stats.rows_out == 6
    assert built.stats.partitions == 2
    assert (built.target / "departure_year=2026" / "departure_month=11").is_dir()
    assert (built.target / "departure_year=2026" / "departure_month=12").is_dir()


def test_v1_rows_are_normalised(build, duck) -> None:
    built = build()
    result = rows(
        duck,
        built,
        "SELECT transfers, transfers_actual, load_factor, load_factor_ordinal, journey_id "
        "FROM {silver} WHERE schema_version = 1 ORDER BY observed_at",
    )
    assert result == [(2, 1, "low", 1, None), (0, 0, "very-high", 3, None)]


def test_v2_rows_are_preserved(build, duck) -> None:
    built = build()
    result = rows(
        duck,
        built,
        "SELECT transfers_actual, load_factor, load_factor_ordinal, journey_id "
        "FROM {silver} WHERE journey_id = 'journey-a'",
    )
    assert result == [(1, "high", 2, "journey-a")]


def test_unpriced_journey_keeps_a_null_fare(build, duck) -> None:
    built = build()
    result = rows(duck, built, "SELECT fare_lowest_eur, schema_version FROM {silver} WHERE journey_id = 'journey-a'")
    assert result == [(None, 2)]


def test_timetable_period_boundary(build, duck) -> None:
    built = build()
    result = rows(
        duck,
        built,
        "SELECT journey_id, timetable_period, departure_date FROM {silver} "
        "WHERE journey_id IN ('journey-b', 'journey-c') ORDER BY journey_id",
    )
    assert result[0][1] == "2025-12"  # 2026-12-12
    assert result[1][1] == "2026-12"  # 2026-12-13
    assert str(result[0][2]) == "2026-12-12"
    assert str(result[1][2]) == "2026-12-13"


def test_departure_context(build, duck) -> None:
    built = build()
    result = rows(
        duck,
        built,
        "SELECT departure_weekday, departure_hour_local, is_weekend FROM {silver} "
        "WHERE journey_id IN ('journey-a', 'journey-d') ORDER BY journey_id",
    )
    # Sunday 2026-11-15 10:00 UTC -> 11:00 CET; Monday 2026-11-16 07:30 UTC -> 08:30 CET.
    assert result == [(0, 11, True), (1, 8, False)]


def test_distance_km(build, duck) -> None:
    built = build()
    (distance,) = rows(duck, built, "SELECT distance_km FROM {silver} WHERE journey_id = 'journey-a'")[0]
    assert isinstance(distance, float)
    assert 490 < distance < 520  # Berlin Hbf -> München Hbf is about 504 km


def test_station_dimension_join(build, duck) -> None:
    built = build()
    result = rows(
        duck,
        built,
        "SELECT origin_state, dest_state, origin_station_category FROM {silver} WHERE journey_id = 'journey-d'",
    )
    assert result == [("Bayern", "Berlin", 1)]


def test_scrapes_per_route_day(build, duck) -> None:
    built = build()
    result = rows(
        duck,
        built,
        "SELECT journey_id, scrapes_per_route_day FROM {silver} "
        "WHERE journey_id IN ('journey-a', 'journey-b') ORDER BY journey_id",
    )
    # Route Berlin->München, departure 2026-11-15: two August scrapes plus the November one.
    assert result == [("journey-a", 3), ("journey-b", 1)]


def test_observation_era(build, duck) -> None:
    built = build()
    result = rows(
        duck,
        built,
        "SELECT schema_version, observation_era FROM {silver} GROUP BY 1, 2 ORDER BY 1",
    )
    assert result == [(1, "dense"), (2, "post-fix")]


def test_v1_only_corpus(tmp_path: Path, duck) -> None:
    """A corpus that predates schema v2 has none of the v2 columns; the build still works."""
    root = tmp_path / "v1-only"
    write_bronze(root / "year=2026" / "month=08" / "day=01", [v1_row()], schema_version=1)
    built = run_build(str(root / "**" / "*.parquet"), tmp_path / "silver-v1-only")
    assert built.rows_in == 1
    assert built.rows_out == 1
    result = rows(
        duck,
        Built(stats=built, target=tmp_path / "silver-v1-only"),
        "SELECT schema_version, journey_id, train_numbers, source_profile FROM {silver}",
    )
    assert result == [(1, None, None, None)]


def test_pyarrow_reads_the_output(build) -> None:
    built = build()
    table = pq.read_table(built.target, partitioning="hive")
    assert table.num_rows == 6
    assert {"distance_km", "timetable_period", "scrapes_per_route_day"} <= set(table.column_names)


def test_target_is_never_overwritten(build, bronze_glob: str, tmp_path: Path) -> None:
    built = build()
    with pytest.raises(FileExistsError):
        run_build(bronze_glob, built.target)


def test_three_classes_share_a_journey(build, duck) -> None:
    """Rows are observation-level: one journey appears once per scrape and class."""
    built = build()
    (count,) = rows(
        duck,
        built,
        "SELECT count(*) FROM {silver} WHERE route_id = '8011160-8000261'",
    )[0]
    assert count == 3


def test_missing_station_is_flagged(tmp_path: Path) -> None:
    """An unknown EVA leaves the derived station columns null and fails the gate."""
    root = tmp_path / "unknown-station"
    write_bronze(root / "day=01", [bronze_row(origin_eva="9999999")], schema_version=2)
    with pytest.raises(quality.QualityError, match="station missing from the dimension"):
        run_build(str(root / "**" / "*.parquet"), tmp_path / "silver-unknown")
