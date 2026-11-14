"""Fixtures: bronze Parquet written the way the scraper writes it."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from tpm_analytics.silver.build import BuildStats, run_build

V1_FIELDS = (
    ("observed_at", pa.timestamp("ms"), False),
    ("service_class", pa.int32(), False),
    ("route_id", pa.string(), False),
    ("origin_eva", pa.string(), False),
    ("origin_name", pa.string(), False),
    ("dest_eva", pa.string(), False),
    ("dest_name", pa.string(), False),
    ("departure_planned", pa.timestamp("ms"), False),
    ("arrival_planned", pa.timestamp("ms"), False),
    ("train_type", pa.string(), False),
    ("train_number", pa.string(), False),
    ("transfers", pa.int32(), False),
    ("duration_minutes", pa.int32(), False),
    ("days_to_departure", pa.float64(), False),
    ("fare_lowest_eur", pa.float64(), True),
    ("load_factor", pa.string(), True),
)

V2_FIELDS = (
    ("train_numbers", pa.string(), False),
    ("load_factor_ordinal", pa.int32(), True),
    ("journey_id", pa.string(), True),
    ("schema_version", pa.int32(), False),
    ("source_profile", pa.string(), False),
    ("query_mode", pa.string(), False),
)

BERLIN = ("8011160", "Berlin Hbf")
MUNICH = ("8000261", "München Hbf")
HAMBURG = ("8002549", "Hamburg Hbf")


def bronze_row(**overrides: object) -> dict[str, object]:
    """A complete v2 row; override whatever a test cares about."""
    row: dict[str, object] = {
        "observed_at": datetime(2026, 11, 14, 8, 0),
        "service_class": 2,
        "route_id": f"{BERLIN[0]}-{MUNICH[0]}",
        "origin_eva": BERLIN[0],
        "origin_name": BERLIN[1],
        "dest_eva": MUNICH[0],
        "dest_name": MUNICH[1],
        "departure_planned": datetime(2026, 11, 15, 10, 0),
        "arrival_planned": datetime(2026, 11, 15, 14, 0),
        "train_type": "ICE",
        "train_number": "1001",
        "transfers": 1,
        "duration_minutes": 240,
        "days_to_departure": 1.0,
        "fare_lowest_eur": 59.9,
        "load_factor": "high",
        "train_numbers": "ICE 1001",
        "load_factor_ordinal": 2,
        "journey_id": "journey-1",
        "schema_version": 2,
        "source_profile": "dbweb",
        "query_mode": "bestprice",
    }
    row.update(overrides)
    return row


def v1_row(**overrides: object) -> dict[str, object]:
    """A v1 row: no v2 columns, even transfers, the collapsed ``low`` load factor."""
    defaults: dict[str, object] = {
        "schema_version": 1,
        "transfers": 2,
        "load_factor": "low",
        "load_factor_ordinal": None,
        "journey_id": None,
        "train_numbers": "",
        "source_profile": "",
        "query_mode": "",
    }
    defaults.update(overrides)
    return bronze_row(**defaults)


def write_bronze(directory: Path, rows: list[dict[str, object]], *, schema_version: int) -> Path:
    """Write one bronze batch file under ``directory``."""
    fields = V1_FIELDS if schema_version == 1 else V1_FIELDS + V2_FIELDS
    schema = pa.schema([pa.field(name, kind, nullable=nullable) for name, kind, nullable in fields])
    names = {field.name for field in schema}
    filtered = [{key: value for key, value in row.items() if key in names} for row in rows]
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"batch_{schema_version}.parquet"
    pq.write_table(pa.Table.from_pylist(filtered, schema=schema), path)
    return path


def default_rows() -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    """Two v1 rows and four v2 rows covering the interesting boundaries."""
    v1 = [
        v1_row(observed_at=datetime(2026, 8, 1, 8, 0), fare_lowest_eur=59.9),
        v1_row(
            observed_at=datetime(2026, 8, 1, 12, 0),
            service_class=1,
            transfers=0,
            load_factor="very-high",
            fare_lowest_eur=99.9,
        ),
    ]
    v2 = [
        bronze_row(observed_at=datetime(2026, 11, 14, 8, 0), fare_lowest_eur=None, journey_id="journey-a"),
        bronze_row(
            observed_at=datetime(2026, 11, 14, 9, 0),
            route_id=f"{HAMBURG[0]}-{MUNICH[0]}",
            origin_eva=HAMBURG[0],
            origin_name=HAMBURG[1],
            # 22:30 Berlin on the 12th: the last departure before the timetable change.
            departure_planned=datetime(2026, 12, 12, 21, 30),
            arrival_planned=datetime(2026, 12, 13, 4, 0),
            load_factor="very-high",
            load_factor_ordinal=3,
            journey_id="journey-b",
            fare_lowest_eur=129.0,
        ),
        bronze_row(
            observed_at=datetime(2026, 11, 14, 10, 0),
            route_id=f"{HAMBURG[0]}-{MUNICH[0]}",
            origin_eva=HAMBURG[0],
            origin_name=HAMBURG[1],
            # 23:30 UTC on the 12th is 00:30 Berlin on the 13th: the first departure under the
            # new timetable, and the case a UTC-derived date gets wrong.
            departure_planned=datetime(2026, 12, 12, 23, 30),
            arrival_planned=datetime(2026, 12, 13, 7, 0),
            load_factor="low-to-medium",
            load_factor_ordinal=1,
            journey_id="journey-c",
            fare_lowest_eur=39.9,
        ),
        bronze_row(
            observed_at=datetime(2026, 11, 14, 11, 0),
            route_id=f"{MUNICH[0]}-{BERLIN[0]}",
            origin_eva=MUNICH[0],
            origin_name=MUNICH[1],
            dest_eva=BERLIN[0],
            dest_name=BERLIN[1],
            departure_planned=datetime(2026, 11, 16, 7, 30),
            arrival_planned=datetime(2026, 11, 16, 11, 30),
            journey_id="journey-d",
            fare_lowest_eur=49.9,
        ),
    ]
    return v1, v2


@dataclass(frozen=True)
class Built:
    stats: BuildStats
    target: Path


@pytest.fixture
def bronze_root(tmp_path: Path) -> Path:
    """A bronze tree laid out like the scraper's: prices/year=/month=/day=/batch_*.parquet."""
    v1, v2 = default_rows()
    root = tmp_path / "prices"
    write_bronze(root / "year=2026" / "month=10" / "day=01", v1, schema_version=1)
    write_bronze(root / "year=2026" / "month=11" / "day=14", v2, schema_version=2)
    return root


@pytest.fixture
def bronze_glob(bronze_root: Path) -> str:
    return str(bronze_root / "**" / "*.parquet")


@pytest.fixture
def build(bronze_glob: str, tmp_path: Path) -> Callable[..., Built]:
    """Build silver once per call into a fresh directory."""

    def _build(source: str = bronze_glob, **kwargs: Any) -> Built:
        target = tmp_path / f"silver-{uuid4().hex[:8]}"
        stats = run_build(source, target, **kwargs)
        return Built(stats=stats, target=target)

    return _build


@pytest.fixture
def duck() -> Iterator[duckdb.DuckDBPyConnection]:
    connection = duckdb.connect()
    connection.execute("SET timezone = 'UTC'")
    yield connection
    connection.close()
