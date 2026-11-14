"""Quality gates for the silver layer.

A build is published only when every check here passes. The gates encode the invariants the
transform is supposed to guarantee, so a schema change that silently breaks one of them fails the
build instead of poisoning the training data.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

import duckdb

from tpm_analytics.silver._duck import read_parquet, scalar

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
    "transfers",
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

COUNT_CHECKS: tuple[tuple[str, str], ...] = (
    (
        "schema_version null",
        "SELECT count(*) FROM silver WHERE schema_version IS NULL",
    ),
    (
        "journey_id set on a v1 row",
        "SELECT count(*) FROM silver WHERE schema_version = 1 AND journey_id IS NOT NULL",
    ),
    (
        "journey_id missing on a v2 row",
        "SELECT count(*) FROM silver WHERE schema_version = 2 AND journey_id IS NULL",
    ),
    (
        "null fare on a v1 row",
        "SELECT count(*) FROM silver WHERE schema_version = 1 AND fare_lowest_eur IS NULL",
    ),
    (
        "load_factor_ordinal out of sync with load_factor",
        "SELECT count(*) FROM silver WHERE (load_factor IS NULL) <> (load_factor_ordinal IS NULL)",
    ),
    (
        "null timetable_period",
        "SELECT count(*) FROM silver WHERE timetable_period IS NULL",
    ),
    (
        "null observation_era",
        "SELECT count(*) FROM silver WHERE observation_era IS NULL",
    ),
    (
        "negative transfers_actual",
        "SELECT count(*) FROM silver WHERE transfers_actual < 0",
    ),
    (
        "negative days_to_departure",
        "SELECT count(*) FROM silver WHERE days_to_departure < 0",
    ),
    (
        "station missing from the dimension",
        "SELECT count(*) FROM silver WHERE origin_state IS NULL OR dest_state IS NULL",
    ),
    (
        "null scrapes_per_route_day",
        "SELECT count(*) FROM silver WHERE scrapes_per_route_day IS NULL",
    ),
)


@dataclass(frozen=True)
class Violation:
    check: str
    detail: str


class QualityError(RuntimeError):
    """Raised when one or more silver invariants do not hold."""

    def __init__(self, violations: Iterable[Violation]) -> None:
        self.violations = tuple(violations)
        summary = "; ".join(f"{violation.check} ({violation.detail})" for violation in self.violations)
        super().__init__(f"silver quality gate failed: {summary}")


def _silver_source(silver_glob: str) -> str:
    return read_parquet(silver_glob, hive_partitioning=True)


def check(
    connection: duckdb.DuckDBPyConnection,
    *,
    bronze_glob: str,
    silver_glob: str,
    expected_rows: int | None = None,
) -> list[Violation]:
    """Return every invariant violation in the built silver layer."""
    silver = _silver_source(silver_glob)
    actual_columns = {row[0] for row in connection.execute(f"DESCRIBE SELECT * FROM {silver}").fetchall()}
    missing = [column for column in REQUIRED_COLUMNS if column not in actual_columns]
    if missing:
        return [Violation("missing columns", ", ".join(missing))]

    bronze_rows = scalar(connection, f"SELECT count(*) FROM {read_parquet(bronze_glob)}")
    silver_rows = scalar(connection, f"SELECT count(*) FROM {silver}")

    violations: list[Violation] = []
    if expected_rows is not None and bronze_rows != expected_rows:
        violations.append(Violation("bronze row count changed mid-build", f"{expected_rows} -> {bronze_rows}"))
    if bronze_rows != silver_rows:
        violations.append(Violation("row count bronze != silver", f"{bronze_rows} != {silver_rows}"))

    for name, sql in COUNT_CHECKS:
        offending = scalar(connection, sql.replace("FROM silver", f"FROM {silver}"))
        if offending:
            violations.append(Violation(name, f"{offending} rows"))

    empty_partitions = scalar(
        connection,
        f"SELECT count(*) FROM (SELECT departure_year, departure_month, count(*) AS n FROM {silver} "
        "GROUP BY 1, 2 HAVING n = 0)",
    )
    if empty_partitions:
        violations.append(Violation("empty partition", f"{empty_partitions} partitions"))

    return violations


def raise_for_violations(violations: Iterable[Violation]) -> None:
    violations = tuple(violations)
    if violations:
        raise QualityError(violations)
