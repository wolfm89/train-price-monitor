"""DuckDB session and path helpers shared by the silver build and its checks."""

from __future__ import annotations

from pathlib import Path

import duckdb

DEFAULT_THREADS = 2
DEFAULT_MEMORY_LIMIT = "900MB"


def sql_string(value: str) -> str:
    """Escape a value for inline use inside a single-quoted DuckDB string literal."""
    return value.replace("'", "''")


def asset_dir(name: str) -> Path:
    """Resolve a module asset directory in both the repo checkout and the Lambda task root.

    Locally: ``analytics/sql`` sits next to ``analytics/src``.
    In the image: ``/var/task/sql`` sits next to ``/var/task/tpm_analytics``.
    """
    package_dir = Path(__file__).resolve().parents[1]
    for candidate in (package_dir.parent.parent / name, package_dir.parent / name):
        if candidate.is_dir():
            return candidate
    raise FileNotFoundError(f"asset directory {name!r} not found next to {package_dir}")


def connect(
    *,
    temp_directory: Path,
    threads: int = DEFAULT_THREADS,
    memory_limit: str = DEFAULT_MEMORY_LIMIT,
) -> duckdb.DuckDBPyConnection:
    """Open an in-memory DuckDB session tuned for a single-pass batch build."""
    connection = duckdb.connect()
    temp_directory.mkdir(parents=True, exist_ok=True)
    connection.execute("SET timezone = 'UTC'")
    connection.execute(f"SET memory_limit = '{sql_string(memory_limit)}'")
    connection.execute(f"SET temp_directory = '{sql_string(str(temp_directory))}'")
    connection.execute("SET preserve_insertion_order = false")
    connection.execute(f"SET threads = {int(threads)}")
    return connection


def scalar(connection: duckdb.DuckDBPyConnection, sql: str) -> int:
    """Run a single-value query."""
    row = connection.execute(sql).fetchone()
    if row is None:
        raise RuntimeError("query returned no rows")
    return int(row[0])


def read_parquet(path_glob: str, *, hive_partitioning: bool = False) -> str:
    """Build a read_parquet table expression for a glob."""
    options = f"union_by_name = true, hive_partitioning = {'true' if hive_partitioning else 'false'}"
    return f"read_parquet('{sql_string(path_glob)}', {options})"
