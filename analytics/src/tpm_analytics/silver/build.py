"""Run the bronze → silver transform with DuckDB.

The transform is one deterministic SQL statement (``sql/silver.sql``); this module supplies the
session settings, resolves the input glob, and exposes the result as a :class:`BuildStats`.

A build writes into a hidden sibling directory, verifies it, and only then renames it into place.
A rejected build therefore never leaves a plausible-looking target behind, and a retry into the
same path is always possible.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from uuid import uuid4

import duckdb

from tpm_analytics.silver import quality
from tpm_analytics.silver._duck import (
    DEFAULT_MAX_TEMP_SIZE,
    DEFAULT_MEMORY_LIMIT,
    DEFAULT_THREADS,
    asset_dir,
    connect,
    read_parquet,
    scalar,
    sql_string,
)

# Columns introduced by schema v2. A corpus that predates v2 has none of them, and union_by_name
# cannot invent a column that exists in no file, so the source expression adds them as typed NULLs.
V2_COLUMN_DEFAULTS: dict[str, str] = {
    "train_numbers": "CAST(NULL AS VARCHAR)",
    "load_factor_ordinal": "CAST(NULL AS INTEGER)",
    "journey_id": "CAST(NULL AS VARCHAR)",
    "schema_version": "CAST(NULL AS INTEGER)",
    "source_profile": "CAST(NULL AS VARCHAR)",
    "query_mode": "CAST(NULL AS VARCHAR)",
}


@dataclass(frozen=True)
class BuildStats:
    """What one silver build produced."""

    source: str
    target: str
    rows_in: int
    rows_out: int
    partitions: int
    duration_seconds: float


def bronze_source(connection: duckdb.DuckDBPyConnection, bronze_glob: str) -> str:
    """Return a table expression over the bronze glob that always has the full v2 schema."""
    source = read_parquet(bronze_glob)
    columns = {row[0] for row in connection.execute(f"DESCRIBE SELECT * FROM {source}").fetchall()}
    missing = {name: expression for name, expression in V2_COLUMN_DEFAULTS.items() if name not in columns}
    if not missing:
        return source
    projection = ", ".join(f"{expression} AS {name}" for name, expression in missing.items())
    return f"(SELECT *, {projection} FROM {source})"


def render_sql(
    sql_path: Path,
    *,
    bronze_source_sql: str,
    stations_path: Path,
    target: Path,
) -> str:
    """Substitute the placeholders in ``silver.sql``."""
    return (
        sql_path.read_text(encoding="utf-8")
        .replace("{{BRONZE_SOURCE}}", bronze_source_sql)
        .replace("{{STATIONS_PATH}}", sql_string(stations_path.as_posix()))
        .replace("{{TARGET}}", sql_string(target.as_posix()))
    )


def run_build(
    source: str,
    target: str | Path,
    *,
    sql_path: Path | None = None,
    stations_path: Path | None = None,
    temp_directory: Path | None = None,
    threads: int = DEFAULT_THREADS,
    memory_limit: str = DEFAULT_MEMORY_LIMIT,
    max_temp_size: str = DEFAULT_MAX_TEMP_SIZE,
    verify: bool = True,
) -> BuildStats:
    """Build silver from ``source`` into the new directory ``target``."""
    started = time.perf_counter()
    sql_path = Path(sql_path) if sql_path is not None else asset_dir("sql") / "silver.sql"
    stations_path = Path(stations_path) if stations_path is not None else asset_dir("data") / "stations.json"
    final_target = Path(target)
    if final_target.exists():
        raise FileExistsError(f"target {final_target} already exists; silver builds never overwrite")

    # Write to a hidden sibling first: a rejected build must not leave a target that looks usable.
    partial = final_target.parent / f".{final_target.name}.partial-{uuid4().hex[:8]}"
    owns_temp_dir = temp_directory is None
    temp_dir = temp_directory if temp_directory is not None else final_target.parent / f".duckdb-tmp-{uuid4().hex[:8]}"
    temp_dir.mkdir(parents=True, exist_ok=True)

    connection: duckdb.DuckDBPyConnection | None = None
    try:
        connection = connect(
            temp_directory=temp_dir,
            threads=threads,
            memory_limit=memory_limit,
            max_temp_size=max_temp_size,
        )
        source_sql = bronze_source(connection, source)
        rows_in = scalar(connection, f"SELECT count(*) FROM {source_sql}")
        written = connection.execute(
            render_sql(
                sql_path,
                bronze_source_sql=source_sql,
                stations_path=stations_path,
                target=partial,
            )
        ).fetchall()
        rows_out = sum(int(row[1]) for row in written)
        partitions = len({tuple(sorted(row[5].items())) for row in written}) if written else 0
        silver_glob = str(partial / "**" / "*.parquet")
        if verify:
            quality.raise_for_violations(
                quality.check(
                    connection,
                    bronze_glob=source,
                    silver_glob=silver_glob,
                    rows_in=rows_in,
                )
            )
        partial.rename(final_target)
    except BaseException:
        shutil.rmtree(partial, ignore_errors=True)
        raise
    finally:
        if connection is not None:
            connection.close()
        if owns_temp_dir:
            shutil.rmtree(temp_dir, ignore_errors=True)

    return BuildStats(
        source=source,
        target=str(final_target),
        rows_in=rows_in,
        rows_out=rows_out,
        partitions=partitions,
        duration_seconds=round(time.perf_counter() - started, 3),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m tpm_analytics.silver.build",
        description="Build the silver layer from a bronze Parquet glob.",
    )
    parser.add_argument("--source", required=True, help="bronze glob, e.g. '/data/prices/**/*.parquet'")
    parser.add_argument("--target", required=True, help="new output directory (must not exist)")
    parser.add_argument("--sql", type=Path, default=None, help="override sql/silver.sql")
    parser.add_argument("--stations", type=Path, default=None, help="override data/stations.json")
    parser.add_argument("--temp-directory", type=Path, default=None, help="DuckDB spill directory")
    parser.add_argument("--threads", type=int, default=DEFAULT_THREADS)
    parser.add_argument("--memory-limit", default=DEFAULT_MEMORY_LIMIT)
    parser.add_argument("--max-temp-size", default=DEFAULT_MAX_TEMP_SIZE)
    parser.add_argument("--no-verify", action="store_true", help="skip the quality gate (debug only)")
    args = parser.parse_args(argv)

    try:
        stats = run_build(
            args.source,
            args.target,
            sql_path=args.sql,
            stations_path=args.stations,
            temp_directory=args.temp_directory,
            threads=args.threads,
            memory_limit=args.memory_limit,
            max_temp_size=args.max_temp_size,
            verify=not args.no_verify,
        )
    except (FileExistsError, quality.QualityError, duckdb.Error) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    print(json.dumps(asdict(stats), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
