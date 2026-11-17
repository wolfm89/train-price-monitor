"""Lambda entry point: build silver from S3 bronze and publish it.

The handler reads its inputs from the environment, never from the event: the event cannot choose a
source, a bucket or whether the gate runs. A retry after a crash is safe because each run writes a
new build id and only the pointer moves.
"""

import json
import logging
import os
import re
import shutil
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import boto3
import duckdb
from botocore.config import Config

from tpm_analytics.silver._duck import S3Secret, connect
from tpm_analytics.silver.build import EmptyCorpusError, run_build
from tpm_analytics.silver.config import FAILURE_EVENT, QUALITY_EVENT, STAGES, load_config
from tpm_analytics.silver.manifest import build_id_for, manifest_key, utc_now
from tpm_analytics.silver.publish import publish
from tpm_analytics.silver.report import QualityReport, build_report, write_report
from tpm_analytics.silver.storage import S3ObjectStore

# Lambda installs no root handler; without one, INFO would never be emitted.
logging.basicConfig(level=logging.INFO)
LOGGER = logging.getLogger(__name__)

# Leave enough time to upload a 1.5 GB build and move the pointer.
_CONFIG = load_config()
PUBLISH_RESERVE_SECONDS = _CONFIG.lambda_.publish_reserve_seconds
# The measured full build is ~576 s; do not start one that cannot finish.
BUILD_BUDGET_SECONDS = _CONFIG.lambda_.build_budget_seconds
# Report writes and the quality SNS run after the pointer moved; bound them so a stall cannot
# turn a published build into a timeout, a retry and a false failure page.
POST_PUBLISH_RESERVE_SECONDS = 20
QUALITY_SNS_RESERVE_SECONDS = 20
# One total attempt per PUT: a retried report write is not worth the risk of a retried
# invocation after the pointer moved. Two PUTs at 2 s connect / 5 s read stay inside the 20 s
# reserve. `total_max_attempts` is explicit because `max_attempts` counts retries, not attempts.
REPORT_S3_CONFIG = Config(connect_timeout=2, read_timeout=5, retries={"total_max_attempts": 1})

_SECRET_FRAGMENT = re.compile(r"(?:KEY_ID|SECRET_KEY|SECRET|SESSION_TOKEN)\s+'[^']*'|AKIA[0-9A-Z]{16}")


def redact_error(message: str) -> str:
    """Keep credentials out of the notification even if a future error embeds them."""
    return _SECRET_FRAGMENT.sub("<redacted>", message)


@dataclass(frozen=True)
class Settings:
    bucket: str
    prefix: str
    source: str
    region: str
    threads: int
    memory_limit: str
    max_temp_size: str
    keep: int
    transform_version: str


def load_settings() -> Settings:
    bucket = os.environ["SILVER_BUCKET"]
    lambda_config = _CONFIG.lambda_
    return Settings(
        bucket=bucket,
        prefix=os.environ.get("SILVER_PREFIX", _CONFIG.prefix),
        source=os.environ.get("BRONZE_SOURCE", f"s3://{bucket}/{_CONFIG.bronze_prefix}/**/*.parquet"),
        region=os.environ.get("AWS_REGION", "eu-central-1"),
        threads=int(os.environ.get("SILVER_THREADS", str(lambda_config.threads))),
        memory_limit=os.environ.get("SILVER_MEMORY_LIMIT", lambda_config.duckdb_memory_limit),
        max_temp_size=os.environ.get("SILVER_MAX_TEMP_SIZE", lambda_config.duckdb_max_temp_size),
        keep=int(os.environ.get("SILVER_KEEP", str(_CONFIG.keep))),
        transform_version=os.environ.get("TRANSFORM_VERSION", ""),
    )


def parse_bronze_source(source: str) -> tuple[str, str]:
    """Return (bucket, prefix) for the glob, so the snapshot cannot disagree with the read."""
    parsed = urlsplit(source)
    if parsed.scheme != "s3" or not parsed.netloc:
        raise ValueError(f"BRONZE_SOURCE must be an s3:// glob, got {source!r}")
    prefix = parsed.path.lstrip("/").split("**")[0].rstrip("/")
    if not prefix:
        raise ValueError(f"BRONZE_SOURCE {source!r} has no prefix before the wildcard")
    return parsed.netloc, prefix + "/"


def aws_secret(region: str) -> S3Secret:
    """Turn the execution role's credentials into a DuckDB secret payload.

    DuckDB could read the same role through `PROVIDER credential_chain`, which resolves the
    AWS_* variables Lambda injects, but that needs the `aws` extension baked into the image and
    would not remove boto3 (it is still the S3 client). One credential path, no second native
    extension.
    """
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
    """Remove this module's own workspaces left behind by a killed invocation."""
    removed: list[str] = []
    for path in Path(tempfile.gettempdir()).glob("silver-lambda-*"):
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
            removed.append(path.name)
    return removed


def remaining_seconds(context: object) -> float | None:
    getter = getattr(context, "get_remaining_time_in_millis", None)
    if not callable(getter):
        return None
    return float(getter()) / 1000.0


def notify_quality(report: QualityReport, key: str | None) -> None:
    """Publish one quality warning without turning a verified build into a failure."""
    if report.status != "warning":
        return
    topic_arn = os.environ.get("ALERT_TOPIC_ARN")
    if not topic_arn:
        LOGGER.warning("ALERT_TOPIC_ARN is not set; quality warning was not published build_id=%s", report.build_id)
        return
    # Everything after publish() must be incapable of failing the invocation: the pointer has
    # already moved, so a raise here would page a priority-1 failure for a published build.
    try:
        payload = {
            "event": QUALITY_EVENT,
            "build_id": report.build_id,
            "generated_at": report.generated_at,
            "report": key,
            "violations": [violation.to_dict() for violation in report.violations[:10]],
            "function": os.environ.get("AWS_LAMBDA_FUNCTION_NAME", "local"),
            "region": os.environ.get("AWS_REGION", "eu-central-1"),
            "log_group": os.environ.get("LOG_GROUP_NAME") or os.environ.get("AWS_LAMBDA_LOG_GROUP_NAME", ""),
        }
        client = boto3.client(
            "sns",
            config=Config(connect_timeout=2, read_timeout=5, retries={"total_max_attempts": 2}),
        )
        client.publish(
            TopicArn=topic_arn,
            Subject="Silver data quality warning",
            Message=json.dumps(payload),
        )
    except Exception:
        LOGGER.exception("could not publish the silver quality warning build_id=%s", report.build_id)


def failure_message(build_id: str, error: BaseException, stage: str) -> dict[str, str]:
    """The structured payload the Lambda on-failure destination forwards to Pushover."""
    if stage not in STAGES:
        # A notification must never be lost because a new stage was not added to the
        # contract first; report it as unknown instead of losing the failure payload.
        LOGGER.warning("unknown failure stage %r build_id=%s", stage, build_id)
        stage = "unknown"
    return {
        "event": FAILURE_EVENT,
        "build_id": build_id,
        "stage": stage,
        "error_type": type(error).__name__,
        "error": redact_error(str(error))[:500],
        "function": os.environ.get("AWS_LAMBDA_FUNCTION_NAME", "local"),
        "region": os.environ.get("AWS_REGION", "eu-central-1"),
        # LOG_GROUP_NAME is set by CDK; AWS_LAMBDA_LOG_GROUP_NAME covers a manual run.
        "log_group": os.environ.get("LOG_GROUP_NAME") or os.environ.get("AWS_LAMBDA_LOG_GROUP_NAME", ""),
    }


def _run_build(
    _event: dict[str, Any],
    context: object,
    build_id: str,
    progress: dict[str, str],
) -> dict[str, Any]:
    started = time.perf_counter()
    settings = load_settings()
    if not settings.source.startswith("s3://"):
        raise ValueError("BRONZE_SOURCE must be an s3:// glob in the handler")
    progress["stage"] = "preflight"
    remaining = remaining_seconds(context)
    if remaining is not None and remaining < BUILD_BUDGET_SECONDS + PUBLISH_RESERVE_SECONDS:
        raise RuntimeError(f"only {remaining:.0f}s left before the deadline; not starting a build")
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

    progress["stage"] = "snapshot"
    store = S3ObjectStore(settings.bucket, region=settings.region)
    # One snapshot of the corpus: the build reads exactly these objects and the manifest records
    # them. The poller appends a batch every 15 minutes, so a live glob would change mid-build.
    source_bucket, prefix_in_source = parse_bronze_source(settings.source)
    if source_bucket != settings.bucket:
        raise ValueError(f"BRONZE_SOURCE names a different bucket than SILVER_BUCKET ({settings.bucket})")
    silver_prefix = settings.prefix.strip("/") + "/"
    if prefix_in_source.startswith(silver_prefix) or silver_prefix.startswith(prefix_in_source):
        raise ValueError("BRONZE_SOURCE must not point at the silver prefix")
    snapshot = tuple(
        f"s3://{settings.bucket}/{key}" for key in store.list_keys(prefix_in_source) if key.endswith(".parquet")
    )
    if not snapshot:
        raise EmptyCorpusError(f"no bronze objects under {prefix_in_source!r}")
    LOGGER.info("silver source snapshot files=%s", len(snapshot))

    progress["stage"] = "build"
    with tempfile.TemporaryDirectory(prefix="silver-lambda-", ignore_cleanup_errors=True) as workspace:
        workdir = Path(workspace)
        target = workdir / build_id
        build_started = time.perf_counter()
        stats = run_build(
            snapshot,
            target,
            s3=aws_secret(settings.region),
            temp_directory=workdir / "duckdb",
            threads=settings.threads,
            memory_limit=settings.memory_limit,
            max_temp_size=settings.max_temp_size,
        )
        build_seconds = round(time.perf_counter() - build_started, 3)
        progress["stage"] = "report"
        report_started = time.perf_counter()
        report_connection = connect(
            temp_directory=workdir / "duckdb-report",
            threads=2,
            memory_limit="2GB",
            max_temp_size="1GB",
        )
        try:
            report = build_report(
                report_connection,
                str(target / "**" / "*.parquet"),
                build_id=build_id,
                as_of=utc_now(),
                quality=_CONFIG.quality,
                build={
                    "manifest": manifest_key(settings.prefix, build_id),
                    "rows_out": stats.rows_out,
                    "partitions": stats.partitions,
                },
            )
        finally:
            report_connection.close()
        report_seconds = round(time.perf_counter() - report_started, 3)
        progress["stage"] = "publish"
        remaining = remaining_seconds(context)
        if remaining is not None and remaining < PUBLISH_RESERVE_SECONDS:
            raise RuntimeError(f"only {remaining:.0f}s left before the build deadline; refusing to start the upload")
        after = {
            f"s3://{settings.bucket}/{key}" for key in store.list_keys(prefix_in_source) if key.endswith(".parquet")
        }
        warnings: list[str] = []
        if after != set(snapshot):
            warnings.append(
                f"bronze changed during the build: {len(after)} objects now vs {len(snapshot)} in the snapshot"
            )
        publish_started = time.perf_counter()
        result = publish(
            store,
            build_id=build_id,
            local_dir=target,
            stats=stats,
            source=settings.source,
            source_files=snapshot,
            prefix=settings.prefix,
            transform_version=settings.transform_version,
            duckdb_version=duckdb.__version__,
            keep=settings.keep,
            warnings=tuple(warnings),
        )
        publish_seconds = round(time.perf_counter() - publish_started, 3)
        report_key_written: str | None = None
        remaining = remaining_seconds(context)
        if remaining is not None and remaining < POST_PUBLISH_RESERVE_SECONDS:
            LOGGER.warning(
                "skipping the silver quality report; only %.0fs left after publish build_id=%s",
                remaining,
                build_id,
            )
        else:
            try:
                report_store = S3ObjectStore(settings.bucket, region=settings.region, config=REPORT_S3_CONFIG)
                report_key_written = write_report(
                    report_store,
                    prefix=settings.prefix,
                    quality=_CONFIG.quality,
                    report=report,
                )
            except Exception:
                LOGGER.exception("could not write the silver quality report build_id=%s", build_id)
            if report.status == "warning":
                remaining = remaining_seconds(context)
                if remaining is None or remaining >= QUALITY_SNS_RESERVE_SECONDS:
                    notify_quality(report, report_key_written)
                else:
                    LOGGER.warning(
                        "skipping the silver quality warning; only %.0fs left after publish build_id=%s",
                        remaining,
                        build_id,
                    )
        LOGGER.info(
            "silver quality report build_id=%s status=%s violations=%s report=%s report_seconds=%s",
            build_id,
            report.status,
            len(report.violations),
            report_key_written,
            report_seconds,
        )
        try:
            usage = shutil.disk_usage(workspace)
            tmp_used, tmp_free = usage.used, usage.free
        except OSError:
            # The pointer is already committed; do not turn cosmetic bookkeeping into a page.
            tmp_used, tmp_free = 0, 0

    duration = round(time.perf_counter() - started, 3)
    LOGGER.info(
        "silver phases build_seconds=%s report_seconds=%s publish_seconds=%s tmp_used_bytes=%s tmp_free_bytes=%s",
        build_seconds,
        report_seconds,
        publish_seconds,
        tmp_used,
        tmp_free,
    )
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
        "build_seconds": build_seconds,
        "publish_seconds": publish_seconds,
        "duration_seconds": duration,
        "quality_status": report.status,
        "quality_report": report_key_written,
    }


def handler(event: dict[str, Any], context: object) -> dict[str, Any]:
    build_id = build_id_for(utc_now())
    progress = {"stage": "settings"}
    LOGGER.info("silver handler start build_id=%s", build_id)
    try:
        return _run_build(event, context, build_id, progress)
    except Exception as error:
        # A failed attempt is logged for transient-error diagnosis, then re-raised so Lambda
        # retries it. The on-failure destination publishes only after every attempt fails, so
        # a recovered retry is silent and a final failure produces exactly one SNS message.
        LOGGER.warning(
            "silver build attempt failed build_id=%s stage=%s error_type=%s",
            build_id,
            progress["stage"],
            type(error).__name__,
        )
        raise RuntimeError(json.dumps(failure_message(build_id, error, progress["stage"]))) from error
