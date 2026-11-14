"""The test fixtures must mirror the scraper's Parquet writer.

The fixtures are a hand copy of ``scraper/src/parquet.ts``. If the scraper appends a column or
reorders them, the transform keeps passing tests while silently dropping data, so the copy is
checked against the TypeScript source.
"""

from __future__ import annotations

import re
from pathlib import Path

from tests.conftest import V1_FIELDS, V2_FIELDS

REPO_ROOT = Path(__file__).resolve().parents[2]
PARQUET_WRITER = REPO_ROOT / "scraper" / "src" / "parquet.ts"


def writer_columns() -> list[str]:
    source = PARQUET_WRITER.read_text(encoding="utf-8")
    return re.findall(r"name: '([a-z_]+)'", source)


def fixture_columns() -> list[str]:
    return [name for name, _, _ in V1_FIELDS + V2_FIELDS]


def test_fixture_schema_matches_the_writer() -> None:
    assert fixture_columns() == writer_columns()
