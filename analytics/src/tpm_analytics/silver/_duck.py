"""DuckDB session and path helpers shared by the silver build and its checks."""

from __future__ import annotations

from pathlib import Path

import duckdb

DEFAULT_THREADS = 2
DEFAULT_MEMORY_LIMIT = "900MB"
DEFAULT_MAX_TEMP_SIZE = "1GB"

# The sql/ and data/ directories live inside the package, so a wheel built from
# analytics/ is self-contained and the Lambda image only has to copy tpm_analytics/.
PACKAGE_DIR = Path(__file__).resolve().parents[1]


def sql_string(value: str) -> str:
    """Escape a value for inline use inside a single-quoted DuckDB string literal."""
    return value.replace("'", "''")


def asset_dir(name: str) -> Path:
    """Return a packaged asset directory (``sql`` or ``data``)."""
    path = PACKAGE_DIR / name
    if not path.is_dir():
        raise FileNotFoundError(f"packaged asset directory {name!r} missing at {path}")
    return path


def connect(
    *,
    temp_directory: Path,
    threads: int = DEFAULT_THREADS,
    memory_limit: str = DEFAULT_MEMORY_LIMIT,
    max_temp_size: str = DEFAULT_MAX_TEMP_SIZE,
) -> duckdb.DuckDBPyConnection:
    """Open an in-memory DuckDB session tuned for a single-pass batch build."""
    connection = duckdb.connect()
    try:
        temp_directory.mkdir(parents=True, exist_ok=True)
        connection.execute("SET timezone = 'UTC'")
        connection.execute(f"SET memory_limit = '{sql_string(memory_limit)}'")
        connection.execute(f"SET max_temp_directory_size = '{sql_string(max_temp_size)}'")
        connection.execute(f"SET temp_directory = '{sql_string(temp_directory.as_posix())}'")
        connection.execute("SET preserve_insertion_order = false")
        connection.execute(f"SET threads = {int(threads)}")
    except Exception:
        connection.close()
        raise
    return connection


def scalar(connection: duckdb.DuckDBPyConnection, sql: str) -> int:
    """Run a single-value query."""
    row = connection.execute(sql).fetchone()
    if row is None:
        raise RuntimeError("query returned no rows")
    return int(row[0])


def read_parquet(path_glob: str, *, hive_partitioning: bool = False) -> str:
    """Build a read_parquet table expression for a glob.

    ``hive_partitioning`` is always passed explicitly: DuckDB auto-detects
    ``key=value`` directories, and bronze is laid out as ``year=/month=/day=``,
    which must never become columns.
    """
    options = f"union_by_name = true, hive_partitioning = {'true' if hive_partitioning else 'false'}"
    return f"read_parquet('{sql_string(path_glob)}', {options})"
