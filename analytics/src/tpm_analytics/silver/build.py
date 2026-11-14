"""Run the bronze → silver transform with DuckDB.

The transform is one deterministic SQL statement (``sql/silver.sql``); this module supplies the
session settings, resolves the input glob, and exposes the result as a :class:`BuildStats`.

A build writes into a hidden sibling directory, verifies it, and only then renames it into place.
A rejected build therefore never leaves a plausible-looking target behind, and a retry into the
same path is possible as long as no earlier build succeeded there.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import cast
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
from tpm_analytics.silver.constants import TIMETABLE_BOUNDARY

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


class EmptyCorpusError(ValueError):
    """Raised when the source glob matches no rows at all."""


class UnsupportedLocationError(NotImplementedError):
    """Raised for an S3 or other URI, which this build does not support yet."""


def local_path(value: str | Path, *, role: str) -> Path:
    """Reject URIs so a future S3 caller cannot silently write into a local ``s3:/`` directory."""
    text = str(value)
    if "://" in text:
        raise UnsupportedLocationError(
            f"{role} {text!r} is a URI; silver builds only support local paths until the S3 writer lands"
        )
    return Path(text)


@dataclass(frozen=True)
class BuildStats:
    """What one silver build produced."""

    source: str
    target: str
    rows_in: int
    rows_out: int
    duplicates_removed: int
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
        .replace("{{TIMETABLE_BOUNDARY}}", TIMETABLE_BOUNDARY)
        .replace("{{TARGET}}", sql_string(target.as_posix()))
    )


def parse_copy_stats(
    column_names: Sequence[str],
    written: Sequence[Sequence[object]],
) -> tuple[int, int]:
    """Read rows and partition count from a ``COPY … RETURN_STATS`` result.

    Parsed by column name: the result is a seven-column internal contract and a future release
    could insert a column without notice.
    """
    try:
        count_at = column_names.index("count")
        partition_at = column_names.index("partition_keys")
    except ValueError as error:
        raise RuntimeError(f"unexpected COPY RETURN_STATS columns: {column_names}") from error
    rows_out = sum(int(cast("int | str", row[count_at])) for row in written)
    partitions = len({tuple(sorted(cast("dict[str, object]", row[partition_at]).items())) for row in written})
    return rows_out, partitions


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
    if "://" in source:
        raise UnsupportedLocationError(f"source {source!r} is a URI; silver builds only support local paths")
    sql_path = Path(sql_path) if sql_path is not None else asset_dir("sql") / "silver.sql"
    stations_path = Path(stations_path) if stations_path is not None else asset_dir("data") / "stations.json"
    final_target = local_path(target, role="target")
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
        if rows_in == 0:
            raise EmptyCorpusError(f"source {source!r} matched no rows")
        result = connection.execute(
            render_sql(
                sql_path,
                bronze_source_sql=source_sql,
                stations_path=stations_path,
                target=partial,
            )
        )
        column_names = [column[0] for column in (result.description or [])]
        written = result.fetchall()
        rows_out, partitions = parse_copy_stats(column_names, written)
        silver_glob = str(partial / "**" / "*.parquet")
        if verify:
            report = quality.check(
                connection,
                bronze_glob=source,
                silver_glob=silver_glob,
                bronze_rows=rows_in,
                expected_rows=rows_out,
            )
            violations = list(report.violations)
            if report.rows != rows_out:
                violations.append(quality.Violation("writer count != gate count", f"{rows_out} != {report.rows}"))
            on_disk = len(list(partial.glob("departure_year=*/departure_month=*")))
            if on_disk != partitions:
                violations.append(quality.Violation("partition count != directories", f"{partitions} != {on_disk}"))
            quality.raise_for_violations(violations)
        # Close the engine before touching the directory tree: Windows keeps a handle on open files.
        connection.close()
        connection = None
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
        duplicates_removed=rows_in - rows_out,
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

    if args.no_verify:
        print("warning: quality gate disabled (--no-verify); this output is not publishable", file=sys.stderr)

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
    except (
        EmptyCorpusError,
        FileExistsError,
        OSError,
        quality.QualityError,
        UnsupportedLocationError,
        duckdb.Error,
    ) as error:
        print(f"error: silver build of {args.source} -> {args.target} failed: {error}", file=sys.stderr)
        return 2

    print(json.dumps(asdict(stats), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
