"""DuckDB session and path helpers shared by the silver build and its checks."""

from __future__ import annotations

import os
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

import duckdb

DEFAULT_THREADS = 2
DEFAULT_MEMORY_LIMIT = "700MB"
DEFAULT_MAX_TEMP_SIZE = "4GB"

# The sql/ and data/ directories live inside the package, so a wheel built from
# analytics/ is self-contained and the Lambda image only has to copy tpm_analytics/.
PACKAGE_DIR = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class S3Secret:
    """Credentials from the execution role, handed to DuckDB as a temporary secret."""

    access_key: str
    secret_key: str = field(repr=False)
    session_token: str = field(repr=False)
    region: str


def create_secret_sql(secret: S3Secret) -> str:
    """Build the CREATE SECRET statement; values are escaped, never interpolated raw."""
    parts = [
        "CREATE OR REPLACE SECRET silver_s3 (TYPE s3, PROVIDER config",
        f"KEY_ID '{sql_string(secret.access_key)}'",
        f"SECRET '{sql_string(secret.secret_key)}'",
        f"REGION '{sql_string(secret.region)}'",
    ]
    if secret.session_token:
        parts.append(f"SESSION_TOKEN '{sql_string(secret.session_token)}'")
    return ", ".join(parts) + ")"


def sql_string(value: str) -> str:
    """Escape a value for inline use inside a single-quoted DuckDB string literal."""
    return value.replace("'", "''")


def asset_dir(name: str) -> Path:
    """Return a packaged asset directory (``sql`` or ``data``)."""
    path = PACKAGE_DIR / name
    if not path.is_dir():
        raise FileNotFoundError(f"packaged asset directory {name!r} missing at {path}")
    return path


def extension_directory() -> Path | None:
    """The image bakes httpfs into DUCKDB_EXTENSION_DIR; local runs leave it unset."""
    configured = os.environ.get("DUCKDB_EXTENSION_DIR")
    return Path(configured) if configured else None


def connect(
    *,
    temp_directory: Path,
    threads: int = DEFAULT_THREADS,
    memory_limit: str = DEFAULT_MEMORY_LIMIT,
    max_temp_size: str = DEFAULT_MAX_TEMP_SIZE,
    extensions: Path | None = None,
    secret: S3Secret | None = None,
) -> duckdb.DuckDBPyConnection:
    """Open an in-memory DuckDB session tuned for a batch build."""
    connection = duckdb.connect()
    try:
        temp_directory.mkdir(parents=True, exist_ok=True)
        connection.execute("SET timezone = 'UTC'")
        # The wheel bundles parquet, json and icu. Refuse to reach the network for an extension:
        # in the Lambda image a missing one must fail fast, not stall on a download.
        connection.execute("SET autoinstall_known_extensions = false")
        connection.execute("SET autoload_known_extensions = false")
        connection.execute(f"SET memory_limit = '{sql_string(memory_limit)}'")
        connection.execute(f"SET max_temp_directory_size = '{sql_string(max_temp_size)}'")
        connection.execute(f"SET temp_directory = '{sql_string(temp_directory.as_posix())}'")
        connection.execute("SET preserve_insertion_order = false")
        connection.execute(f"SET threads = {int(threads)}")
        bundled = extensions if extensions is not None else extension_directory()
        if bundled is not None:
            connection.execute(f"SET extension_directory = '{sql_string(bundled.as_posix())}'")
            connection.execute("LOAD httpfs")
        if secret is not None:
            if bundled is None:
                raise RuntimeError("S3 reads need the httpfs extension; set DUCKDB_EXTENSION_DIR")
            try:
                connection.execute(create_secret_sql(secret))
            except duckdb.Error:
                # DuckDB error text echoes the statement, which contains the credentials.
                raise RuntimeError("could not create the DuckDB S3 secret (statement redacted)") from None
    except Exception:
        connection.close()
        raise
    return connection


def scalar(connection: duckdb.DuckDBPyConnection, sql: str) -> int:
    """Run a single-value query."""
    rows = connection.execute(sql).fetchall()
    if not rows:
        raise RuntimeError("query returned no rows")
    return int(rows[0][0])


def read_parquet(paths: str | Sequence[str], *, hive_partitioning: bool = False) -> str:
    """Build a read_parquet table expression for a glob or an explicit file list.

    An explicit list is what the handler passes: it is the snapshot the build reads, so a poller
    or compactor run that lands mid-build cannot change the corpus under it.

    ``hive_partitioning`` is always passed explicitly: DuckDB auto-detects
    ``key=value`` directories, and bronze is laid out as ``year=/month=/day=``,
    which must never become columns.
    """
    if isinstance(paths, str):
        target = f"'{sql_string(paths)}'"
    else:
        target = "[" + ", ".join(f"'{sql_string(path)}'" for path in paths) + "]"
    options = f"union_by_name = true, hive_partitioning = {'true' if hive_partitioning else 'false'}"
    return f"read_parquet({target}, {options})"
