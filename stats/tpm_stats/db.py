"""DuckDB access layer shared by every notebook and the mart builder.

Single responsibility: hand back a DuckDB connection that already exposes the
canonical ``prices`` view (and ``mart_*`` views when materialised). Notebooks
should never call ``read_parquet`` directly — they import :func:`get_connection`
so the schema lives in exactly one place.
"""

from __future__ import annotations

from glob import glob as _glob
from pathlib import Path

import duckdb

from .config import DATA_GLOB, MARTS_DIR, prices_view_sql


class NoDataError(RuntimeError):
    """Raised when no local parquet files are available to analyse."""


def available_files(glob: str = DATA_GLOB) -> list[Path]:
    """Return the sorted list of daily parquet files currently on disk."""
    return sorted(Path(p) for p in _glob(glob))


def get_connection(*, glob: str = DATA_GLOB, attach_marts: bool = True) -> duckdb.DuckDBPyConnection:
    """Open an in-memory DuckDB connection with the ``prices`` view registered.

    Args:
        glob: Parquet glob to back the ``prices`` view.
        attach_marts: When True, also register a view per ``mart_*.parquet``
            found in :data:`~tpm_stats.config.MARTS_DIR` (named after the file).

    Raises:
        NoDataError: If the glob matches no files (fail fast with guidance).
    """
    if not available_files(glob):
        raise NoDataError(
            f"No parquet files match {glob!r}. Fetch data first, e.g. `mise run //stats:fetch --days 30`."
        )

    conn = duckdb.connect(database=":memory:")
    conn.execute(prices_view_sql(glob))

    if attach_marts:
        for mart in sorted(MARTS_DIR.glob("mart_*.parquet")):
            name = mart.stem  # e.g. "mart_booking_curve"
            literal = str(mart).replace("'", "''")
            conn.execute(f"CREATE OR REPLACE VIEW {name} AS SELECT * FROM read_parquet('{literal}')")

    return conn
