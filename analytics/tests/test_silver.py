"""Semantics of the bronze → silver transform."""

from __future__ import annotations

from collections.abc import Callable
from datetime import date, datetime
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from tests.conftest import Built, bronze_row, v1_row, write_bronze
from tpm_analytics.silver import quality
from tpm_analytics.silver.build import main, run_build


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
        "SELECT transfers_raw, transfers_actual, load_factor, load_factor_ordinal, journey_id,"
        " train_numbers, source_profile, query_mode "
        "FROM {silver} WHERE schema_version = 1 ORDER BY observed_at",
    )
    assert result == [
        (2, 1, "low", 1, None, "1001", "dbweb", "bestprice"),
        (0, 0, "very-high", 3, None, "1001", "dbweb", "bestprice"),
    ]


def test_v2_rows_are_preserved(build, duck) -> None:
    built = build()
    result = rows(
        duck,
        built,
        "SELECT transfers_raw, transfers_actual, load_factor, load_factor_ordinal, journey_id "
        "FROM {silver} WHERE journey_id = 'journey-a'",
    )
    assert result == [(1, 1, "high", 2, "journey-a")]


def test_unpriced_journey_keeps_a_null_fare(build, duck) -> None:
    built = build()
    result = rows(duck, built, "SELECT fare_lowest_eur, schema_version FROM {silver} WHERE journey_id = 'journey-a'")
    assert result == [(None, 2)]


def test_timetable_period_uses_berlin_time(build, duck) -> None:
    built = build()
    result = rows(
        duck,
        built,
        "SELECT journey_id, timetable_period, departure_date FROM {silver} "
        "WHERE journey_id IN ('journey-b', 'journey-c') ORDER BY journey_id",
    )
    # 2026-12-12 21:30Z is 22:30 Berlin, still the old timetable.
    assert result[0] == ("journey-b", "2025-12", date(2026, 12, 12))
    # 2026-12-12 23:30Z is 00:30 Berlin on the 13th, already the new timetable.
    assert result[1] == ("journey-c", "2026-12", date(2026, 12, 13))


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


def test_dst_summer_time(tmp_path: Path, duck) -> None:
    """July is CEST (UTC+2); November is CET (UTC+1)."""
    root = tmp_path / "summer"
    write_bronze(
        root / "day=01",
        [bronze_row(departure_planned=datetime(2026, 7, 15, 10, 0), arrival_planned=datetime(2026, 7, 15, 14, 0))],
        schema_version=2,
    )
    built = run_build(str(root / "**" / "*.parquet"), tmp_path / "silver-summer")
    result = rows(
        duck,
        Built(stats=built, target=tmp_path / "silver-summer"),
        "SELECT departure_hour_local, departure_date, departure_weekday FROM {silver}",
    )
    expected_weekday = (date(2026, 7, 15).weekday() + 1) % 7  # DuckDB: 0 = Sunday
    assert result == [(12, date(2026, 7, 15), expected_weekday)]


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
    # Route Berlin->München, local departure 2026-11-15: two August scrapes plus the November one.
    assert result == [("journey-a", 3), ("journey-b", 1)]


def test_observation_eras(tmp_path: Path, duck) -> None:
    root = tmp_path / "eras"
    write_bronze(
        root / "day=01",
        [
            bronze_row(
                observed_at=datetime(2026, 7, 1, 8, 0),
                journey_id="dense",
                departure_planned=datetime(2026, 12, 20, 9, 0),
            ),
            bronze_row(
                observed_at=datetime(2026, 10, 1, 8, 0),
                journey_id="sparse",
                departure_planned=datetime(2026, 12, 20, 9, 0),
            ),
            bronze_row(
                observed_at=datetime(2026, 11, 13, 18, 14, 59),
                journey_id="just-before",
                departure_planned=datetime(2026, 12, 20, 9, 0),
            ),
            bronze_row(
                observed_at=datetime(2026, 11, 13, 18, 15, 49),
                journey_id="post-fix",
                departure_planned=datetime(2026, 12, 20, 9, 0),
            ),
        ],
        schema_version=2,
    )
    stats = run_build(str(root / "**" / "*.parquet"), tmp_path / "silver-eras")
    result = rows(
        duck,
        Built(stats=stats, target=tmp_path / "silver-eras"),
        "SELECT journey_id, observation_era FROM {silver} ORDER BY observed_at",
    )
    assert result == [
        ("dense", "dense"),
        ("sparse", "sparse"),
        ("just-before", "sparse"),
        ("post-fix", "post-fix"),
    ]


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
        "SELECT schema_version, journey_id, train_numbers, source_profile, query_mode FROM {silver}",
    )
    assert result == [(1, None, "1001", "dbweb", "bestprice")]


def test_v2_only_corpus(tmp_path: Path, duck) -> None:
    root = tmp_path / "v2-only"
    write_bronze(root / "day=01", [bronze_row(), bronze_row(journey_id="journey-2")], schema_version=2)
    built = run_build(str(root / "**" / "*.parquet"), tmp_path / "silver-v2-only")
    assert built.rows_out == 2
    result = rows(
        duck,
        Built(stats=built, target=tmp_path / "silver-v2-only"),
        "SELECT schema_version, count(*) FROM {silver} GROUP BY 1",
    )
    assert result == [(2, 2)]


def test_pyarrow_reads_the_output(build) -> None:
    built = build()
    table = pq.read_table(built.target, partitioning="hive")
    assert table.num_rows == 6
    schema = table.schema
    assert schema.field("observed_at").type == pa.timestamp("us")
    assert schema.field("schema_version").type == pa.int32()
    assert schema.field("transfers_actual").type == pa.int32()
    assert schema.field("departure_date").type == pa.date32()
    assert schema.field("is_weekend").type == pa.bool_()
    assert schema.field("distance_km").type == pa.float64()
    assert schema.field("timetable_period").type == pa.string()


def test_two_builds_produce_the_same_rows(build: Callable[..., Built], duck) -> None:
    first = build(threads=1)
    second = build(threads=4)
    left = silver(first.target)
    right = silver(second.target)
    (only_left,) = duck.execute(f"SELECT count(*) FROM (SELECT * FROM {left} EXCEPT SELECT * FROM {right})").fetchone()
    (only_right,) = duck.execute(f"SELECT count(*) FROM (SELECT * FROM {right} EXCEPT SELECT * FROM {left})").fetchone()
    assert (only_left, only_right) == (0, 0)


def test_target_is_never_overwritten(build, bronze_glob: str) -> None:
    built = build()
    with pytest.raises(FileExistsError):
        run_build(bronze_glob, built.target)


def test_rejected_build_leaves_no_target(tmp_path: Path, bronze_glob: str) -> None:
    target = tmp_path / "silver-rejected"
    bad_root = tmp_path / "bad"
    write_bronze(bad_root / "day=01", [v1_row(fare_lowest_eur=None)], schema_version=1)
    with pytest.raises(quality.QualityError):
        run_build(str(bad_root / "**" / "*.parquet"), target)
    assert not target.exists()
    assert not list(tmp_path.glob(".silver-rejected.partial-*"))


def test_empty_corpus_fails_loudly(tmp_path: Path) -> None:
    with pytest.raises(duckdb.Error):
        run_build(str(tmp_path / "nothing" / "**" / "*.parquet"), tmp_path / "silver-empty")


def test_cli_reports_a_known_error(build, bronze_glob: str, capsys) -> None:
    built = build()
    exit_code = main(["--source", bronze_glob, "--target", str(built.target)])
    assert exit_code == 2
    assert "already exists" in capsys.readouterr().err


def test_rows_are_observation_level(build, duck) -> None:
    """One journey appears once per scrape and service class, not once overall."""
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
