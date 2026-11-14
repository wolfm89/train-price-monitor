"""Lambda entry point: build silver from S3 bronze and publish it.

The handler reads its inputs from the environment, never from the event: the event cannot choose a
source, a bucket or whether the gate runs. A retry after a crash is safe because each run writes a
new build id and only the pointer moves.
"""

from __future__ import annotations

import logging
import os
import shutil
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import boto3
import duckdb

from tpm_analytics.silver._duck import S3Secret
from tpm_analytics.silver.build import run_build
from tpm_analytics.silver.manifest import build_id_for, utc_now
from tpm_analytics.silver.publish import publish
from tpm_analytics.silver.storage import S3ObjectStore

LOGGER = logging.getLogger(__name__)

# Leave enough time to upload a 3 GB build and move the pointer.
PUBLISH_RESERVE_SECONDS = 180


@dataclass(frozen=True)
class Settings:
    bucket: str
    prefix: str
    bronze_prefix: str
    source: str
    region: str
    threads: int
    memory_limit: str
    max_temp_size: str
    keep: int
    transform_version: str


def load_settings() -> Settings:
    bucket = os.environ["SILVER_BUCKET"]
    return Settings(
        bucket=bucket,
        prefix=os.environ.get("SILVER_PREFIX", "silver"),
        bronze_prefix=os.environ.get("BRONZE_PREFIX", "prices/"),
        source=os.environ.get("BRONZE_SOURCE", f"s3://{bucket}/prices/**/*.parquet"),
        region=os.environ.get("AWS_REGION", "eu-central-1"),
        threads=int(os.environ.get("SILVER_THREADS", "6")),
        memory_limit=os.environ.get("SILVER_MEMORY_LIMIT", "8GB"),
        max_temp_size=os.environ.get("SILVER_MAX_TEMP_SIZE", "5GB"),
        keep=int(os.environ.get("SILVER_KEEP", "2")),
        transform_version=os.environ.get("TRANSFORM_VERSION", "unknown"),
    )


def aws_secret(region: str) -> S3Secret:
    """Turn the execution role's credentials into a DuckDB secret payload."""
    credentials = boto3.Session().get_credentials()
    if credentials is None:
        raise RuntimeError("no AWS credentials available for the DuckDB secret")
    frozen = credentials.get_frozen_credentials()
    return S3Secret(
        access_key=frozen.access_key,
        secret_key=frozen.secret_key,
        session_token=frozen.token or "",
        region=region,
    )


def sweep_workspace() -> list[str]:
    """Remove ``silver-*`` directories left behind by a killed invocation in this sandbox."""
    removed: list[str] = []
    for path in Path(tempfile.gettempdir()).glob("silver-*"):
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
            removed.append(path.name)
    return removed


def remaining_seconds(context: object) -> float | None:
    getter = getattr(context, "get_remaining_time_in_millis", None)
    if not callable(getter):
        return None
    return float(getter()) / 1000.0


def handler(event: dict[str, Any], context: object) -> dict[str, Any]:
    started = time.perf_counter()
    settings = load_settings()
    build_id = build_id_for(utc_now())
    swept = sweep_workspace()
    LOGGER.info(
        "silver build starting build_id=%s bucket=%s prefix=%s threads=%s memory_limit=%s max_temp_size=%s",
        build_id,
        settings.bucket,
        settings.prefix,
        settings.threads,
        settings.memory_limit,
        settings.max_temp_size,
    )

    with tempfile.TemporaryDirectory(prefix="silver-") as workspace:
        workdir = Path(workspace)
        target = workdir / build_id
        stats = run_build(
            settings.source,
            target,
            s3=aws_secret(settings.region),
            temp_directory=workdir / "duckdb",
            threads=settings.threads,
            memory_limit=settings.memory_limit,
            max_temp_size=settings.max_temp_size,
        )
        store = S3ObjectStore(settings.bucket)
        remaining = remaining_seconds(context)
        if remaining is not None and remaining < PUBLISH_RESERVE_SECONDS:
            raise RuntimeError(f"only {remaining:.0f}s left before the build deadline; refusing to start the upload")
        result = publish(
            store,
            build_id=build_id,
            local_dir=target,
            stats=stats,
            source=settings.source,
            source_files=tuple(store.list_keys(settings.bronze_prefix)),
            bucket=settings.bucket,
            prefix=settings.prefix,
            transform_version=settings.transform_version,
            duckdb_version=duckdb.__version__,
            keep=settings.keep,
        )

    duration = round(time.perf_counter() - started, 3)
    LOGGER.info(
        "silver build finished build_id=%s rows_in=%s rows_out=%s duplicates_removed=%s "
        "partitions=%s uploaded_bytes=%s deleted_builds=%s warnings=%s duration_seconds=%s",
        build_id,
        stats.rows_in,
        stats.rows_out,
        stats.duplicates_removed,
        stats.partitions,
        result.uploaded_bytes,
        list(result.deleted_builds),
        list(result.warnings),
        duration,
    )
    return {
        "build_id": build_id,
        "rows_in": stats.rows_in,
        "rows_out": stats.rows_out,
        "duplicates_removed": stats.duplicates_removed,
        "partitions": stats.partitions,
        "uploaded_bytes": result.uploaded_bytes,
        "deleted_builds": list(result.deleted_builds),
        "warnings": list(result.warnings),
        "swept_workspaces": swept,
        "duration_seconds": duration,
    }
