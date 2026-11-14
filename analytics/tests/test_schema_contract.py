"""The test fixtures must mirror the scraper's Parquet writer.

The fixtures are a hand copy of ``scraper/src/parquet.ts``. If the scraper appends a column,
reorders them, changes a type or flips nullability, the transform keeps passing tests while
silently dropping or coercing data, so the copy is checked against the TypeScript source.
"""

from __future__ import annotations

import re
from pathlib import Path

import pyarrow as pa

from tests.conftest import V1_FIELDS, V2_FIELDS

REPO_ROOT = Path(__file__).resolve().parents[2]
PARQUET_WRITER = REPO_ROOT / "scraper" / "src" / "parquet.ts"

TYPE_MAP = {
    "TIMESTAMP": pa.timestamp("ms"),
    "INT32": pa.int32(),
    "STRING": pa.string(),
    "DOUBLE": pa.float64(),
}

COLUMN_PATTERN = re.compile(
    r"name:\s*'([a-z_]+)',\s*type:\s*'([A-Z0-9]+)',\s*nullable:\s*(true|false)",
)


def writer_fields() -> list[tuple[str, pa.DataType, bool]]:
    source = PARQUET_WRITER.read_text(encoding="utf-8")
    return [
        (name, TYPE_MAP[type_name], nullable == "true") for name, type_name, nullable in COLUMN_PATTERN.findall(source)
    ]


def fixture_fields() -> list[tuple[str, pa.DataType, bool]]:
    return list(V1_FIELDS + V2_FIELDS)


def test_fixture_schema_matches_the_writer() -> None:
    fields = writer_fields()
    assert fields, "could not parse any columns out of scraper/src/parquet.ts"
    assert fixture_fields() == fields
