"""Quality gates for the silver layer.

A build is published only when every check here passes. The checks encode the invariants the
transform is supposed to guarantee, so a schema change or a bad join fails the build instead of
poisoning the training data. The row checks are evaluated in one scan; the duplicate check is a
second pass with a hash aggregate.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

import duckdb

from tpm_analytics.silver._duck import read_parquet, scalar
from tpm_analytics.silver.constants import TIMETABLE_REVIEW_AFTER

REQUIRED_COLUMNS: tuple[str, ...] = (
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
    "is_weekend",
    "distance_km",
    "origin_state",
    "dest_state",
    "origin_station_category",
    "dest_station_category",
    "timetable_period",
    "observation_era",
    "scrapes_per_route_day",
    "departure_year",
    "departure_month",
)

LOAD_FACTOR_RANK_SQL = """
    CASE load_factor
        WHEN 'low' THEN 1
        WHEN 'low-to-medium' THEN 1
        WHEN 'high' THEN 2
        WHEN 'very-high' THEN 3
        WHEN 'exceptionally-high' THEN 4
    END
"""

# Columns that must never be NULL. A NULL silently defeats range checks (`x < 0` is NULL, not
# true), so they are asserted explicitly instead of relying on each predicate.
REQUIRED_NON_NULL: tuple[str, ...] = (
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
    "schema_version",
    "source_profile",
    "query_mode",
    "departure_date",
    "departure_weekday",
    "departure_hour_local",
    "is_weekend",
    "distance_km",
    "origin_state",
    "dest_state",
    "origin_station_category",
    "dest_station_category",
    "timetable_period",
    "observation_era",
    "scrapes_per_route_day",
    "departure_year",
    "departure_month",
)

# (name, predicate over a row of silver). A non-zero count is a violation.
ROW_CHECKS: tuple[tuple[str, str], ...] = (
    ("schema_version outside {1,2}", "schema_version IS NULL OR schema_version NOT IN (1, 2)"),
    ("journey_id set on a v1 row", "schema_version = 1 AND journey_id IS NOT NULL"),
    ("journey_id missing on a v2 row", "schema_version = 2 AND journey_id IS NULL"),
    ("null fare on a v1 row", "schema_version = 1 AND fare_lowest_eur IS NULL"),
    (
        "load_factor_ordinal out of sync with load_factor",
        "(load_factor IS NULL) <> (load_factor_ordinal IS NULL)",
    ),
    (
        "load_factor_ordinal does not match load_factor",
        f"load_factor_ordinal IS NOT NULL AND load_factor_ordinal <> {LOAD_FACTOR_RANK_SQL}",
    ),
    (
        "unknown load_factor value",
        f"load_factor IS NOT NULL AND ({LOAD_FACTOR_RANK_SQL}) IS NULL",
    ),
    (
        "null required field",
        " OR ".join(f"{column} IS NULL" for column in REQUIRED_NON_NULL),
    ),
    ("service_class outside {1,2}", "service_class NOT IN (1, 2)"),
    # Historical rows can predate the arrival-after-departure guarantee; only new data is gated.
    (
        "non-positive duration after the fix",
        "observed_at >= TIMESTAMP '2026-11-13 18:15:49' AND duration_minutes <= 0",
    ),
    ("non-positive fare", "fare_lowest_eur <= 0"),
    ("negative transfers_actual", "transfers_actual < 0"),
    # Before #141 the poller wrote journeys that had already left; that is history, not a
    # regression. Only rows observed after the fix have to satisfy the invariant.
    (
        "negative days_to_departure after the fix",
        "observed_at >= TIMESTAMP '2026-11-13 18:15:49' AND days_to_departure < 0",
    ),
    ("station missing from the dimension", "origin_state IS NULL OR dest_state IS NULL"),
    ("distance_km missing or implausible", "distance_km IS NULL OR distance_km <= 0 OR distance_km > 1500"),
    ("scrapes_per_route_day missing", "scrapes_per_route_day IS NULL OR scrapes_per_route_day < 1"),
    (
        "partition does not match departure_date",
        "EXTRACT(year FROM departure_date) <> departure_year OR EXTRACT(month FROM departure_date) <> departure_month",
    ),
    # The timetable_period boundary in silver.sql is hand-maintained. Departures past the end of
    # the reviewed period mean the boundary is stale: fail the build rather than mislabel a year.
    (
        "departure beyond the reviewed timetable period",
        f"departure_date >= DATE '{TIMETABLE_REVIEW_AFTER}'",
    ),
)

# Bronze columns that silver carries under a clearer name. Anything else missing from silver is
# a schema drift the explicit projection would otherwise drop silently.
RENAMED_COLUMNS: dict[str, str] = {"transfers": "transfers_raw"}

# The compactor's own de-duplication key (scraper/src/rows.ts, parquetRowKey).
DUPLICATE_KEY = (
    "observed_at, route_id, service_class, departure_planned, arrival_planned, "
    "train_numbers, fare_lowest_eur, journey_id"
)


@dataclass(frozen=True)
class Violation:
    check: str
    detail: str


@dataclass(frozen=True)
class Report:
    """Result of one gate run: how many rows the gate saw, and what is wrong with them."""

    rows: int
    violations: tuple[Violation, ...]

    @property
    def ok(self) -> bool:
        return not self.violations


class QualityError(RuntimeError):
    """Raised when one or more silver invariants do not hold."""

    def __init__(self, violations: Iterable[Violation]) -> None:
        self.violations = tuple(violations)
        summary = "; ".join(f"{violation.check} ({violation.detail})" for violation in self.violations)
        super().__init__(f"silver quality gate failed: {summary}")


def _silver_source(silver_glob: str) -> str:
    return read_parquet(silver_glob, hive_partitioning=True)


def _columns(connection: duckdb.DuckDBPyConnection, source: str) -> set[str]:
    return {row[0] for row in connection.execute(f"DESCRIBE SELECT * FROM {source}").fetchall()}


def _row_violations(connection: duckdb.DuckDBPyConnection, silver: str) -> tuple[list[Violation], int]:
    projection = ", ".join(
        f"count(*) FILTER (WHERE {predicate}) AS c{index}" for index, (_, predicate) in enumerate(ROW_CHECKS)
    )
    row = connection.execute(f"SELECT {projection}, count(*) AS total FROM {silver}").fetchone()
    if row is None:
        raise RuntimeError("silver scan returned no row")
    violations = [Violation(name, f"{row[index]} rows") for index, (name, _) in enumerate(ROW_CHECKS) if row[index]]
    return violations, int(row[-1])


def _duplicate_violation(connection: duckdb.DuckDBPyConnection, silver: str) -> list[Violation]:
    duplicates = scalar(
        connection,
        "SELECT coalesce(sum(n - 1), 0) FROM ("
        f"SELECT count(*) AS n FROM {silver} GROUP BY {DUPLICATE_KEY} HAVING count(*) > 1)",
    )
    if duplicates == 0:
        return []
    sample = connection.execute(
        f"SELECT {DUPLICATE_KEY}, count(*) AS n FROM {silver} "
        f"GROUP BY {DUPLICATE_KEY} HAVING count(*) > 1 ORDER BY n DESC LIMIT 3"
    ).fetchall()
    return [Violation("duplicate observations", f"{duplicates} extra rows; sample {sample[:3]}")]


def check(
    connection: duckdb.DuckDBPyConnection,
    *,
    bronze_glob: str,
    silver_glob: str,
    bronze_rows: int | None = None,
    expected_rows: int | None = None,
) -> Report:
    """Run every invariant against the built silver layer."""
    silver = _silver_source(silver_glob)
    silver_columns = _columns(connection, silver)
    missing = [column for column in REQUIRED_COLUMNS if column not in silver_columns]
    if missing:
        return Report(rows=0, violations=(Violation("missing columns", ", ".join(missing)),))

    # A bronze column that silver does not carry is a schema drift the explicit projection
    # would otherwise drop silently.
    bronze = read_parquet(bronze_glob)
    dropped = sorted(_columns(connection, bronze) - silver_columns - set(RENAMED_COLUMNS))
    violations = [Violation("bronze column dropped by the transform", ", ".join(dropped))] if dropped else []

    row_violations, rows_out = _row_violations(connection, silver)
    violations.extend(row_violations)
    violations.extend(_duplicate_violation(connection, silver))

    # Count bronze again after the COPY: a compactor run that swaps a day's files mid-build
    # changes the corpus the transform actually read. count(*) uses Parquet metadata, so this is
    # cheap even on the full history.
    current_rows = scalar(connection, f"SELECT count(*) FROM {bronze}")
    if bronze_rows is not None and current_rows != bronze_rows:
        violations.append(Violation("bronze changed during build", f"{bronze_rows} -> {current_rows}"))
    if expected_rows is not None and expected_rows != rows_out:
        violations.append(Violation("row count != transform output", f"{expected_rows} != {rows_out}"))

    return Report(rows=rows_out, violations=tuple(violations))


def raise_for_violations(violations: Iterable[Violation]) -> None:
    violations = tuple(violations)
    if violations:
        raise QualityError(violations)
