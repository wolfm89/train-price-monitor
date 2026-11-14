"""Lambda entry point: build silver from S3 bronze and publish it.

The handler reads its inputs from the environment, never from the event: the event cannot choose a
source, a bucket or whether the gate runs. A retry after a crash is safe because each run writes a
new build id and only the pointer moves.
"""

from __future__ import annotations

import os
import tempfile
import time
from pathlib import Path
from typing import Any

import boto3
import duckdb

from tpm_analytics.silver._duck import S3Secret
from tpm_analytics.silver.build import run_build
from tpm_analytics.silver.manifest import build_id_for, utc_now
from tpm_analytics.silver.publish import publish
from tpm_analytics.silver.storage import S3ObjectStore

HANDLER_THREADS = int(os.environ.get("SILVER_THREADS", "6"))
HANDLER_MEMORY_LIMIT = os.environ.get("SILVER_MEMORY_LIMIT", "8GB")
HANDLER_MAX_TEMP_SIZE = os.environ.get("SILVER_MAX_TEMP_SIZE", "9GB")
HANDLER_KEEP = int(os.environ.get("SILVER_KEEP", "2"))


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


def handler(event: dict[str, Any], context: object) -> dict[str, Any]:
    started = time.perf_counter()
    bucket = os.environ["SILVER_BUCKET"]
    prefix = os.environ.get("SILVER_PREFIX", "silver").strip("/")
    region = os.environ.get("AWS_REGION", "eu-central-1")
    source = os.environ.get("BRONZE_SOURCE", f"s3://{bucket}/prices/**/*.parquet")
    build_id = build_id_for(utc_now())

    with tempfile.TemporaryDirectory(prefix="silver-") as workspace:
        workdir = Path(workspace)
        target = workdir / build_id
        stats = run_build(
            source,
            target,
            s3=aws_secret(region),
            temp_directory=workdir / "duckdb",
            threads=HANDLER_THREADS,
            memory_limit=HANDLER_MEMORY_LIMIT,
            max_temp_size=HANDLER_MAX_TEMP_SIZE,
        )
        result = publish(
            S3ObjectStore(bucket),
            build_id=build_id,
            local_dir=target,
            stats=stats,
            source=source,
            bucket=bucket,
            prefix=prefix,
            transform_version=os.environ.get("TRANSFORM_VERSION", "unknown"),
            duckdb_version=duckdb.__version__,
            keep=HANDLER_KEEP,
        )

    return {
        "build_id": build_id,
        "rows_in": stats.rows_in,
        "rows_out": stats.rows_out,
        "duplicates_removed": stats.duplicates_removed,
        "partitions": stats.partitions,
        "uploaded_bytes": result.uploaded_bytes,
        "deleted_builds": list(result.deleted_builds),
        "duration_seconds": round(time.perf_counter() - started, 3),
    }
