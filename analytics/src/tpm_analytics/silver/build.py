"""Run the bronze → silver transform with DuckDB.

The transform is one deterministic SQL statement (``sql/silver.sql``); this module supplies the
session settings, resolves the input glob, and exposes the result as a :class:`BuildStats`.
A build never overwrites an existing target: callers write to a fresh directory.
"""

from __future__ import annotations

import argparse
import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import duckdb

from tpm_analytics.silver import quality
from tpm_analytics.silver._duck import asset_dir, connect, read_parquet, scalar, sql_string

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
        .replace("{{STATIONS_PATH}}", sql_string(str(stations_path)))
        .replace("{{TARGET}}", sql_string(str(target)))
    )


def run_build(
    source: str,
    target: str | Path,
    *,
    sql_path: Path | None = None,
    stations_path: Path | None = None,
    temp_directory: Path | None = None,
    threads: int = 2,
    memory_limit: str = "900MB",
    verify: bool = True,
) -> BuildStats:
    """Build silver from ``source`` into the new directory ``target``."""
    started = time.perf_counter()
    sql_path = Path(sql_path) if sql_path is not None else asset_dir("sql") / "silver.sql"
    stations_path = Path(stations_path) if stations_path is not None else asset_dir("data") / "stations.json"
    target_path = Path(target)
    if target_path.exists():
        raise FileExistsError(f"target {target_path} already exists; silver builds never overwrite")

    connection = connect(
        temp_directory=temp_directory if temp_directory is not None else target_path.parent / ".duckdb-tmp",
        threads=threads,
        memory_limit=memory_limit,
    )
    try:
        source_sql = bronze_source(connection, source)
        rows_in = scalar(connection, f"SELECT count(*) FROM {source_sql}")
        connection.execute(
            render_sql(
                sql_path,
                bronze_source_sql=source_sql,
                stations_path=stations_path,
                target=target_path,
            )
        )
        silver_glob = str(target_path / "**" / "*.parquet")
        silver_sql = read_parquet(silver_glob, hive_partitioning=True)
        rows_out = scalar(connection, f"SELECT count(*) FROM {silver_sql}")
        partitions = scalar(
            connection,
            f"SELECT count(*) FROM (SELECT DISTINCT departure_year, departure_month FROM {silver_sql})",
        )
        if verify:
            quality.raise_for_violations(
                quality.check(
                    connection,
                    bronze_glob=source,
                    silver_glob=silver_glob,
                    expected_rows=rows_in,
                )
            )
    finally:
        connection.close()

    return BuildStats(
        source=source,
        target=str(target_path),
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
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--memory-limit", default="900MB")
    parser.add_argument("--no-verify", action="store_true", help="skip the quality gate (debug only)")
    args = parser.parse_args(argv)

    stats = run_build(
        args.source,
        args.target,
        sql_path=args.sql,
        stations_path=args.stations,
        temp_directory=args.temp_directory,
        threads=args.threads,
        memory_limit=args.memory_limit,
        verify=not args.no_verify,
    )
    print(json.dumps(asdict(stats), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
