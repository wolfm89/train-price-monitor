"""The quality gate must accept good builds and reject each broken invariant."""

from __future__ import annotations

from pathlib import Path

import duckdb
import pytest

from tests.conftest import Built, v1_row, write_bronze
from tpm_analytics.silver import quality
from tpm_analytics.silver.build import run_build


def violations_for(connection: duckdb.DuckDBPyConnection, built: Built, source: str) -> list[quality.Violation]:
    return quality.check(
        connection,
        bronze_glob=source,
        silver_glob=str(built.target / "**" / "*.parquet"),
        expected_rows=built.stats.rows_in,
    )


def test_good_build_passes(build, duck, bronze_glob: str) -> None:
    built = build()
    assert violations_for(duck, built, bronze_glob) == []


def test_v1_null_fare_is_rejected(tmp_path: Path, duck) -> None:
    root = tmp_path / "bad-v1"
    write_bronze(root / "day=01", [v1_row(fare_lowest_eur=None)], schema_version=1)
    source = str(root / "**" / "*.parquet")
    stats = run_build(source, tmp_path / "silver-bad-v1", verify=False)
    built = Built(stats=stats, target=tmp_path / "silver-bad-v1")

    found = [violation.check for violation in violations_for(duck, built, source)]
    assert "null fare on a v1 row" in found


def test_v2_journey_id_is_required(tmp_path: Path, duck) -> None:
    root = tmp_path / "bad-v2"
    write_bronze(root / "day=01", [v1_row(journey_id=None, schema_version=2)], schema_version=2)
    source = str(root / "**" / "*.parquet")
    stats = run_build(source, tmp_path / "silver-bad-v2", verify=False)
    built = Built(stats=stats, target=tmp_path / "silver-bad-v2")

    found = [violation.check for violation in violations_for(duck, built, source)]
    assert "journey_id missing on a v2 row" in found


def test_missing_columns_are_reported(duck, bronze_glob: str) -> None:
    """Pointing the gate at bronze (which lacks the derived columns) must fail loudly."""
    found = quality.check(duck, bronze_glob=bronze_glob, silver_glob=bronze_glob, expected_rows=6)
    assert [violation.check for violation in found] == ["missing columns"]
    assert "distance_km" in found[0].detail


def test_raise_for_violations_is_a_runtime_error(duck, build, bronze_glob: str) -> None:
    built = build()
    violations = violations_for(duck, built, bronze_glob)
    quality.raise_for_violations(violations)  # no raise

    with pytest.raises(quality.QualityError):
        quality.raise_for_violations([quality.Violation("row count bronze != silver", "6 != 5")])
