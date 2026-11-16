"""Semantics of the bronze → silver transform."""

from collections.abc import Callable
from datetime import date, datetime
from pathlib import Path
from typing import Any

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
    # ISO: 0 = Monday … 6 = Sunday. Sunday 2026-11-15 -> 6, Monday 2026-11-16 -> 0.
    assert result == [(6, 11, True), (0, 8, False)]


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
    expected_weekday = date(2026, 7, 15).weekday()  # ISO: 0 = Monday
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
        "SELECT journey_id, scrapes_per_route_day_final FROM {silver} "
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
    assert schema.field("observed_at").type == pa.timestamp("ms")
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


def test_stats_match_the_files_on_disk(build) -> None:
    """Rows and partitions reported by RETURN_STATS must match what landed on disk."""
    built = build()
    files = list(built.target.glob("departure_year=*/departure_month=*/*.parquet"))
    assert files
    on_disk = sum(pq.ParquetFile(path).metadata.num_rows for path in files)
    assert on_disk == built.stats.rows_out
    partitions = {(path.parent.parent.name, path.parent.name) for path in files}
    assert len(partitions) == built.stats.partitions


def test_copy_stats_are_parsed_by_column_name() -> None:
    from tpm_analytics.silver.build import parse_copy_stats

    names = [
        "filename",
        "count",
        "file_size_bytes",
        "footer_size_bytes",
        "column_statistics",
        "partition_keys",
        "extra_info",
    ]
    written = [
        ("/out/a.parquet", 3, 1, 2, {}, {"departure_year": "2026", "departure_month": "11"}, {}),
        ("/out/b.parquet", 4, 1, 2, {}, {"departure_year": "2026", "departure_month": "12"}, {}),
        ("/out/c.parquet", 5, 1, 2, {}, {"departure_year": "2026", "departure_month": "11"}, {}),
    ]
    assert parse_copy_stats(names, written) == (12, 2)

    # The engine could insert a column; parsing by name must survive a reordering.
    reordered = [
        "extra_info",
        "partition_keys",
        "count",
        "filename",
        "file_size_bytes",
        "footer_size_bytes",
        "column_statistics",
    ]
    rewritten = [(row[6], row[5], row[1], row[0], row[2], row[3], row[4]) for row in written]
    assert parse_copy_stats(reordered, rewritten) == (12, 2)


def test_zero_row_corpus_is_rejected(tmp_path: Path) -> None:
    from tpm_analytics.silver.build import EmptyCorpusError

    root = tmp_path / "empty-day"
    write_bronze(root / "day=01", [], schema_version=2)
    with pytest.raises(EmptyCorpusError):
        run_build(str(root / "**" / "*.parquet"), tmp_path / "silver-zero")


def test_exact_timetable_boundary(tmp_path: Path, duck) -> None:
    """23:59 local is still the old timetable; 00:00 is the new one."""
    root = tmp_path / "boundary"
    write_bronze(
        root / "day=01",
        [
            # 2026-12-12 23:59 Berlin == 22:59 UTC.
            bronze_row(
                departure_planned=datetime(2026, 12, 12, 22, 59),
                arrival_planned=datetime(2026, 12, 13, 6, 0),
                journey_id="last-old",
            ),
            # 2026-12-13 00:00 Berlin == 23:00 UTC on the 12th.
            bronze_row(
                departure_planned=datetime(2026, 12, 12, 23, 0),
                arrival_planned=datetime(2026, 12, 13, 6, 30),
                journey_id="first-new",
            ),
        ],
        schema_version=2,
    )
    built = run_build(str(root / "**" / "*.parquet"), tmp_path / "silver-boundary")
    result = rows(
        duck,
        Built(stats=built, target=tmp_path / "silver-boundary"),
        "SELECT journey_id, timetable_period FROM {silver} ORDER BY departure_planned",
    )
    assert result == [("last-old", "2025-12"), ("first-new", "2026-12")]


def test_uri_paths_are_rejected(tmp_path: Path) -> None:
    from tpm_analytics.silver.build import UnsupportedLocationError

    with pytest.raises(UnsupportedLocationError, match="target"):
        run_build(str(tmp_path / "x" / "**" / "*.parquet"), "s3://bucket/silver")
    with pytest.raises(UnsupportedLocationError, match="source"):
        run_build("s3://bucket/prices/**/*.parquet", tmp_path / "silver-s3")


@pytest.mark.parametrize(
    ("load_factor", "ordinal"),
    [("low", 1), ("low-to-medium", 1), ("high", 2), ("very-high", 3), ("exceptionally-high", 4)],
)
def test_load_factor_ladder_matches_the_sql(tmp_path: Path, duck, load_factor: str, ordinal: int) -> None:
    """The gate and the transform must agree on every value the DB can emit."""
    root = tmp_path / f"lf-{ordinal}-{load_factor}"
    write_bronze(
        root / "day=01",
        [bronze_row(load_factor=load_factor, load_factor_ordinal=None, journey_id=f"j-{load_factor}")],
        schema_version=2,
    )
    built = run_build(str(root / "**" / "*.parquet"), tmp_path / f"silver-lf-{ordinal}-{load_factor}")
    result = rows(
        duck,
        Built(stats=built, target=tmp_path / f"silver-lf-{ordinal}-{load_factor}"),
        "SELECT load_factor_ordinal FROM {silver}",
    )
    assert result == [(ordinal,)]


@pytest.mark.parametrize(
    ("departure", "weekday", "iso_week", "iso_year"),
    [
        (datetime(2026, 11, 15, 10, 0), 6, 46, 2026),  # Sunday
        (datetime(2026, 11, 16, 9, 0), 0, 47, 2026),  # Monday
        (datetime(2027, 1, 1, 9, 0), 4, 53, 2026),  # ISO week-year differs from the calendar year
    ],
)
def test_iso_calendar_columns(
    tmp_path: Path, duck, departure: datetime, weekday: int, iso_week: int, iso_year: int
) -> None:
    root = tmp_path / f"iso-{weekday}"
    write_bronze(
        root / "day=01",
        [bronze_row(departure_planned=departure, arrival_planned=departure)],
        schema_version=2,
    )
    built = run_build(str(root / "**" / "*.parquet"), tmp_path / f"silver-iso-{weekday}")
    result = rows(
        duck,
        Built(stats=built, target=tmp_path / f"silver-iso-{weekday}"),
        "SELECT departure_weekday, departure_iso_week, departure_iso_year, is_weekend FROM {silver}",
    )
    assert result == [(weekday, iso_week, iso_year, weekday >= 5)]


def test_v1_rows_that_differ_only_in_train_number_are_not_duplicates(tmp_path: Path) -> None:
    """The dedupe key is normalised; two trains on the same route/time are different rows."""
    root = tmp_path / "v1-trains"
    write_bronze(
        root / "day=01",
        [v1_row(train_number="1001"), v1_row(train_number="1003")],
        schema_version=1,
    )
    built = run_build(str(root / "**" / "*.parquet"), tmp_path / "silver-v1-trains")
    assert built.rows_out == 2
    assert built.duplicates_removed == 0


def test_identical_v1_rows_are_deduplicated(tmp_path: Path) -> None:
    root = tmp_path / "v1-dupes"
    write_bronze(root / "day=01", [v1_row(), v1_row()], schema_version=1)
    built = run_build(str(root / "**" / "*.parquet"), tmp_path / "silver-v1-dupes")
    assert built.rows_out == 1
    assert built.duplicates_removed == 1


def test_compacted_v1_empty_strings_fall_back(tmp_path: Path, duck) -> None:
    """The compactor writes v1 rows with all 22 columns and empty strings."""
    root = tmp_path / "compacted-v1"
    write_bronze(root / "day=01", [v1_row()], schema_version=1, compacted=True)
    built = run_build(str(root / "**" / "*.parquet"), tmp_path / "silver-compacted-v1")
    result = rows(
        duck,
        Built(stats=built, target=tmp_path / "silver-compacted-v1"),
        "SELECT train_numbers, source_profile, query_mode, schema_version FROM {silver}",
    )
    assert result == [("1001", "dbweb", "bestprice", 1)]


def test_explicit_file_list_is_a_supported_source(bronze_root: Path, tmp_path: Path) -> None:
    files = tuple(sorted(str(path) for path in bronze_root.glob("**/*.parquet")))
    built = run_build(list(files), tmp_path / "silver-list")
    assert built.rows_in == 6
    assert built.rows_out == 6
    assert built.source_files == files


def test_empty_file_list_is_rejected(tmp_path: Path) -> None:
    from tpm_analytics.silver.build import EmptyCorpusError

    with pytest.raises(EmptyCorpusError):
        run_build([], tmp_path / "silver-empty-list")


def test_cli_success_prints_json(bronze_glob: str, tmp_path: Path, capsys) -> None:
    import json

    exit_code = main(["--source", bronze_glob, "--target", str(tmp_path / "silver-cli")])
    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["rows_out"] == 6


def test_cli_no_verify_warns_and_succeeds(bronze_glob: str, tmp_path: Path, capsys) -> None:
    exit_code = main(["--source", bronze_glob, "--target", str(tmp_path / "silver-cli-nv"), "--no-verify"])
    assert exit_code == 0
    assert "quality gate disabled" in capsys.readouterr().err


def test_dedupe_survivor_is_thread_independent(tmp_path: Path, duck) -> None:
    """Two rows sharing the key but differing in transfers: the same one must survive."""
    root = tmp_path / "ties"
    write_bronze(
        root / "day=01",
        [bronze_row(transfers=0, train_number="1001"), bronze_row(transfers=2, train_number="1001")],
        schema_version=2,
    )
    source = str(root / "**" / "*.parquet")
    one = run_build(source, tmp_path / "silver-ties-1", threads=1)
    four = run_build(source, tmp_path / "silver-ties-4", threads=4)
    assert one.rows_out == four.rows_out == 1

    def survivor(target: Path | str) -> tuple[object, ...]:
        glob = f"{target}/**/*.parquet"
        return duck.execute(
            f"SELECT transfers_raw FROM read_parquet('{glob}', union_by_name=true, hive_partitioning=true)"
        ).fetchone()

    assert survivor(tmp_path / "silver-ties-1") == survivor(tmp_path / "silver-ties-4") == (0,)
    left = f"read_parquet('{tmp_path}/silver-ties-1/**/*.parquet', hive_partitioning=true)"
    right = f"read_parquet('{tmp_path}/silver-ties-4/**/*.parquet', hive_partitioning=true)"
    assert duck.execute(f"SELECT count(*) FROM (SELECT * FROM {left} EXCEPT ALL SELECT * FROM {right})").fetchone() == (
        0,
    )
    assert duck.execute(f"SELECT count(*) FROM (SELECT * FROM {right} EXCEPT ALL SELECT * FROM {left})").fetchone() == (
        0,
    )


def test_dedupe_survivor_is_deterministic_across_file_order(tmp_path: Path, duck) -> None:
    """The full ORDER BY must pick the same row even when the scan order is reversed."""
    low = write_bronze(tmp_path / "a", [bronze_row(transfers=0, train_number="1001")], schema_version=2)
    high = write_bronze(tmp_path / "b", [bronze_row(transfers=2, train_number="1001")], schema_version=2)
    forward = run_build([str(low), str(high)], tmp_path / "silver-forward")
    reverse = run_build([str(high), str(low)], tmp_path / "silver-reverse")
    assert forward.duplicates_removed == reverse.duplicates_removed == 1

    def survivor(target: Path | str) -> tuple[object, ...]:
        glob = f"{target}/**/*.parquet"
        return duck.execute(
            f"SELECT transfers_raw FROM read_parquet('{glob}', union_by_name=true, hive_partitioning=true)"
        ).fetchone()

    assert survivor(forward.target) == survivor(reverse.target) == (0,)


def test_coarse_dedupe_hash_is_rejected(tmp_path: Path, bronze_glob: str) -> None:
    """A hash collision/coarse key must fail the removed-vs-duplicate check, not drop rows."""
    sql = Path(__file__).parents[1] / "src" / "tpm_analytics" / "sql" / "silver.sql"
    coarse = tmp_path / "silver-coarse.sql"
    coarse.write_text(sql.read_text().replace("hash({{DEDUPE_KEY}})", "hash({{DEDUPE_KEY}}) % 2"))
    with pytest.raises(quality.QualityError, match="removed rows != duplicate rows"):
        run_build(bronze_glob, tmp_path / "silver-coarse", sql_path=coarse)


EXPECTED_SILVER_COLUMNS = (
    "observed_at",
    "service_class",
    "route_id",
    "origin_eva",
    "origin_name",
    "dest_eva",
    "dest_name",
    "departure_planned",
    "arrival_planned",
    "train_type",
    "train_number",
    "train_numbers",
    "transfers_raw",
    "duration_minutes",
    "days_to_departure",
    "fare_lowest_eur",
    "load_factor",
    "load_factor_ordinal",
    "journey_id",
    "schema_version",
    "source_profile",
    "query_mode",
    "transfers_actual",
    "departure_date",
    "departure_weekday",
    "departure_hour_local",
    "departure_iso_week",
    "departure_iso_year",
    "is_weekend",
    "distance_km",
    "origin_state",
    "dest_state",
    "origin_station_category",
    "dest_station_category",
    "timetable_period",
    "observation_era",
    "scrapes_per_route_day_final",
    "departure_year",
    "departure_month",
)


def test_output_columns_are_exactly_the_contract(build) -> None:
    built = build()
    table = pq.read_table(built.target, partitioning="hive")
    assert tuple(table.column_names) == EXPECTED_SILVER_COLUMNS


def test_compacted_v1_layout_keeps_the_compactor_values(tmp_path: Path, duck) -> None:
    """The compactor backfills v2 columns on v1 rows; silver must not overwrite them."""
    root = tmp_path / "compacted-v1-values"
    row = v1_row(train_numbers="1001", load_factor_ordinal=1, source_profile="dbweb", query_mode="bestprice")
    write_bronze(root / "day=01", [row], schema_version=1, compacted=True)
    built = run_build(str(root / "**" / "*.parquet"), tmp_path / "silver-compacted-v1-values")
    result = rows(
        duck,
        Built(stats=built, target=tmp_path / "silver-compacted-v1-values"),
        "SELECT train_numbers, source_profile, query_mode, load_factor_ordinal FROM {silver}",
    )
    assert result == [("1001", "dbweb", "bestprice", 1)]


def test_duplicate_count_is_exact_with_mixed_rows(tmp_path: Path) -> None:
    """Three rows, one duplicate pair: the gate must expect one removed row, not two."""
    root = tmp_path / "mixed-duplicates"
    write_bronze(
        root / "day=01",
        [bronze_row(journey_id="a"), bronze_row(journey_id="a"), bronze_row(journey_id="b")],
        schema_version=2,
    )
    built = run_build(str(root / "**" / "*.parquet"), tmp_path / "silver-mixed-duplicates")
    assert built.rows_in == 3
    assert built.rows_out == 2
    assert built.duplicates_removed == 1


def test_secret_reaches_connect(monkeypatch, bronze_glob: str, tmp_path: Path) -> None:
    from tpm_analytics.silver import build as build_module
    from tpm_analytics.silver._duck import S3Secret

    captured: dict[str, object] = {}
    real_connect = build_module.connect

    def spy(**kwargs: Any) -> object:
        captured.update(kwargs)
        kwargs.pop("secret")
        return real_connect(**kwargs)

    monkeypatch.setattr(build_module, "connect", spy)
    secret = S3Secret(access_key="a", secret_key="b", session_token="c", region="eu-west-1")
    run_build(bronze_glob, tmp_path / "silver-secret", s3=secret)

    assert captured["secret"] is secret
