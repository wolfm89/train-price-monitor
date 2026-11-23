"""Publish a verified local build into an object store.

Order matters: every data file, then the manifest, then a read-back check, and only then the
pointer. The pointer write is the commit point: once it has been attempted the build is never
deleted, because a PUT that errors may still have landed.

Retention is best effort *after* the commit. It never deletes the build the pointer names, and it
only considers builds that have a manifest, so prefixes abandoned by a killed run cannot push a
good build out.
"""

import hashlib
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from botocore.exceptions import ClientError

from tpm_analytics.silver._duck import asset_dir
from tpm_analytics.silver.config import load_config
from tpm_analytics.silver.manifest import (
    BUILD_ID_PATTERN,
    BUILD_ROOT,
    MANIFEST_VERSION,
    BuildFile,
    BuildManifest,
    Pointer,
    build_prefix,
    manifest_key,
    pointer_key,
    timestamp_of,
    utc_now,
)
from tpm_analytics.silver.models import BuildStats
from tpm_analytics.silver.storage import ObjectStore

DEFAULT_KEEP = load_config().keep
ORPHAN_GRACE_SECONDS = load_config().orphan_grace_seconds
MIN_BUILD_AGE_SECONDS = load_config().min_build_age_seconds
LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class PublishResult:
    """The outcome of publishing a build."""

    manifest: BuildManifest
    uploaded_bytes: int
    deleted_builds: tuple[str, ...]
    warnings: tuple[str, ...] = ()


def normalise_prefix(prefix: str) -> str:
    """Normalise a prefix to a trailing-slash form."""
    normalised = prefix.strip("/")
    if not normalised:
        raise ValueError("prefix must not be empty")
    return normalised


def validate_build_id(build_id: str) -> None:
    """Validate this configuration section. build id."""
    if not BUILD_ID_PATTERN.fullmatch(build_id):
        raise ValueError(f"invalid build id {build_id!r}")


def asset_hashes() -> tuple[str, str, str]:
    """Hash every input that changes the output: SQL, station dimension and constants."""
    sql = (asset_dir("sql") / "silver.sql").read_bytes()
    stations = (asset_dir("data") / "stations.json").read_bytes()
    constants = (Path(__file__).with_name("constants.py")).read_bytes()
    return (
        hashlib.sha256(sql).hexdigest(),
        hashlib.sha256(stations).hexdigest(),
        hashlib.sha256(constants).hexdigest(),
    )


def _read_pointer(store: ObjectStore, prefix: str) -> Pointer | None:
    """A missing pointer is None; a malformed one is ignored with a warning; other errors surface."""
    try:
        data = store.get_bytes(pointer_key(prefix))
    except FileNotFoundError:
        return None
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") in {"NoSuchKey", "404", "NotFound"}:
            return None
        raise
    try:
        pointer = Pointer.from_json(data)
    except TypeError, ValueError:
        LOGGER.warning("ignoring malformed pointer")
        return None
    if not BUILD_ID_PATTERN.fullmatch(pointer.build_id):
        LOGGER.warning("ignoring pointer with malformed build_id=%r", pointer.build_id[:32])
        return None
    try:
        manifest = BuildManifest.from_json(store.get_bytes(pointer.manifest))
    except FileNotFoundError, TypeError, ValueError, KeyError:
        LOGGER.warning("ignoring pointer to an unreadable manifest build_id=%s", pointer.build_id)
        return None
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") in {"NoSuchKey", "404", "NotFound"}:
            LOGGER.warning("ignoring pointer to a missing manifest build_id=%s", pointer.build_id)
            return None
        raise
    if manifest.build_id != pointer.build_id:
        LOGGER.warning("ignoring pointer whose manifest names %s", manifest.build_id)
        return None
    return pointer


def _latest_manifest(store: ObjectStore, prefix: str) -> tuple[str | None, BuildManifest | None]:
    """Newest readable build, falling back to a scan when the pointer is missing or malformed.

    The pointer is the normal source. If it is corrupt, both publish guards (no backwards
    move and no >10% corpus shrink) must still compare against the newest complete build.
    """
    pointer = _read_pointer(store, prefix)
    if pointer is not None:
        try:
            return pointer.build_id, BuildManifest.from_json(store.get_bytes(pointer.manifest))
        except FileNotFoundError, ClientError, TypeError, ValueError, KeyError:
            LOGGER.warning("pointer manifest became unreadable build_id=%s", pointer.build_id)

    builds = build_ids(store, prefix)
    if not builds:
        return None, None
    build_id = builds[0]
    try:
        return build_id, BuildManifest.from_json(store.get_bytes(manifest_key(prefix, build_id)))
    except FileNotFoundError, ClientError, TypeError, ValueError, KeyError:
        return build_id, None


def verify_upload(store: ObjectStore, manifest: BuildManifest) -> None:
    """The upload is only usable if every file is there with the recorded size."""
    prefix_root = build_prefix(manifest.prefix, manifest.build_id) + "/"
    for file in manifest.files:
        if not file.key.startswith(prefix_root):
            raise ValueError(f"file {file.key} is outside {prefix_root}")
        try:
            size = store.size(file.key)
        except ClientError as error:
            code = error.response.get("Error", {}).get("Code", "unknown")
            raise ValueError(f"cannot verify {file.key} ({code})") from error
        if size != file.bytes:
            raise ValueError(f"uploaded file {file.key} does not match its recorded size")

    landed = BuildManifest.from_json(store.get_bytes(manifest_key(manifest.prefix, manifest.build_id)))
    if landed != manifest:
        raise ValueError("manifest read back from the store does not match the one written")

    expected = {file.key for file in manifest.files} | {manifest_key(manifest.prefix, manifest.build_id)}
    present = set(store.list_keys(prefix_root))
    if present != expected:
        raise ValueError(f"build prefix contains unexpected keys: {sorted(present - expected)}")


def publish(
    store: ObjectStore,
    *,
    build_id: str,
    local_dir: str | Path,
    stats: BuildStats,
    source: str,
    source_files: tuple[str, ...],
    prefix: str,
    transform_version: str,
    duckdb_version: str,
    keep: int = DEFAULT_KEEP,
    warnings: Sequence[str] = (),
) -> PublishResult:
    """Upload ``local_dir`` under ``<prefix>/builds/<build_id>/`` and move the pointer."""
    root = Path(local_dir)
    prefix = normalise_prefix(prefix)
    validate_build_id(build_id)
    if keep < 2:
        raise ValueError("keep must be at least 2; a reader must survive one cycle")
    if not stats.verified:
        raise ValueError("refusing to publish a build whose quality gate did not run")
    parquet_files = sorted(path for path in root.rglob("*.parquet"))
    if not parquet_files:
        raise ValueError(f"build directory {root} contains no parquet files")
    if len(parquet_files) < stats.partitions:
        raise ValueError(f"{len(parquet_files)} files for {stats.partitions} partitions")

    prefix_root = build_prefix(prefix, build_id)
    if store.list_keys(prefix_root + "/"):
        raise ValueError(f"build prefix {prefix_root} already exists")

    # A slower, older run must not move the pointer backwards over a newer build.
    current_id, previous = _latest_manifest(store, prefix)
    if current_id is not None and timestamp_of(current_id) > timestamp_of(build_id):
        raise ValueError(f"build {current_id} is already newer than {build_id}")

    if previous is not None and previous.rows_in and stats.rows_in < previous.rows_in * 0.9:
        raise ValueError(f"corpus shrank from {previous.rows_in} to {stats.rows_in} rows; refusing to publish")

    sql_sha, stations_sha, constants_sha = asset_hashes()
    transform_version = transform_version or f"sql-{sql_sha[:12]}"
    uploaded: list[BuildFile] = []
    written_keys: list[str] = []
    pointer_attempted = False
    manifest: BuildManifest | None = None
    try:
        LOGGER.info(
            "publishing build_id=%s files=%s bytes=%s",
            build_id,
            len(parquet_files),
            sum(p.stat().st_size for p in parquet_files),
        )
        for path in parquet_files:
            key = f"{prefix_root}/{path.relative_to(root).as_posix()}"
            size = store.put_file(path, key)
            uploaded.append(BuildFile(key=key, bytes=size))
            written_keys.append(key)

        manifest = BuildManifest(
            manifest_version=MANIFEST_VERSION,
            build_id=build_id,
            created_at=utc_now().isoformat(),
            source=source,
            source_files=tuple(source_files),
            bucket=store.bucket,
            prefix=prefix,
            rows_in=stats.rows_in,
            rows_out=stats.rows_out,
            duplicates_removed=stats.duplicates_removed,
            partitions=stats.partitions,
            duration_seconds=stats.duration_seconds,
            transform_version=transform_version,
            duckdb_version=duckdb_version,
            sql_sha256=sql_sha,
            stations_sha256=stations_sha,
            constants_sha256=constants_sha,
            warnings=tuple(warnings),
            files=tuple(uploaded),
        )
        key = manifest_key(prefix, build_id)
        # Append before the PUT: if the response is lost the object may exist, and cleanup must
        # remove it too.
        written_keys.append(key)
        store.put_bytes(manifest.to_json(), key, content_type="application/json")
        verify_upload(store, manifest)

        pointer = Pointer(build_id=build_id, manifest=key, updated_at=utc_now().isoformat())
        latest_id, _ = _latest_manifest(store, prefix)
        if latest_id is not None and timestamp_of(latest_id) > timestamp_of(build_id):
            raise ValueError(f"a newer build ({latest_id}) was published while this one was uploading")
        pointer_attempted = True
        store.put_bytes(pointer.to_json(), pointer_key(prefix), content_type="application/json")
        LOGGER.info("pointer moved build_id=%s", build_id)
    except BaseException:
        # After the pointer PUT has been attempted the build may be live, even if the PUT raised.
        if not pointer_attempted:
            _delete_quietly(store, written_keys)
        raise

    emitted = list(warnings)
    try:
        deleted = retain(store, prefix=prefix, keep=keep)
    except Exception as error:
        deleted = ()
        emitted.append(f"retention failed: {error}")

    return PublishResult(
        manifest=manifest,
        uploaded_bytes=manifest.total_bytes,
        deleted_builds=deleted,
        warnings=tuple(emitted),
    )


def _delete_quietly(store: ObjectStore, keys: list[str]) -> None:
    """Delete keys, ignoring missing keys."""
    if not keys:
        return
    try:
        store.delete(keys)
    except Exception:
        return


def _build_time(build_id: str) -> datetime:
    """Build and return time."""
    return datetime.strptime(build_id[:16], "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)


def _age_seconds(build_id: str, now: datetime) -> float | None:
    """Age from the id itself; an id with an impossible date is not age-decidable."""
    try:
        return (now - _build_time(build_id)).total_seconds()
    except ValueError:
        return None


def _scan_builds(store: ObjectStore, prefix: str) -> tuple[list[str], list[str]]:
    """Return (complete builds newest first, manifest-less prefixes).

    A build whose manifest exists but cannot be read is neither: deleting it would turn a
    transient S3 error into data loss.
    """
    root = f"{prefix}/{BUILD_ROOT}/"
    keys = set(store.list_keys(root))
    candidates = {key[len(root) :].split("/")[0] for key in keys if key.startswith(root)}
    complete: list[str] = []
    orphans: list[str] = []
    for build_id in candidates:
        if not BUILD_ID_PATTERN.fullmatch(build_id):
            continue
        key = manifest_key(prefix, build_id)
        if key not in keys:
            orphans.append(build_id)
            continue
        try:
            manifest = BuildManifest.from_json(store.get_bytes(key))
        except FileNotFoundError, ClientError, TypeError, ValueError:
            LOGGER.warning("skipping build with unreadable manifest build_id=%s", build_id)
            continue
        if manifest.build_id == build_id and manifest.files:
            complete.append(build_id)
        else:
            LOGGER.warning("skipping build with inconsistent manifest build_id=%s", build_id)
    return sorted(complete, reverse=True), orphans


def build_ids(store: ObjectStore, prefix: str) -> list[str]:
    """Build ids with a readable, consistent manifest, newest first."""
    return _scan_builds(store, normalise_prefix(prefix))[0]


def retain(store: ObjectStore, *, prefix: str, keep: int) -> tuple[str, ...]:
    """Delete old builds and abandoned prefixes; the pointed-at build is never deleted."""
    if keep < 2:
        raise ValueError("keep must be at least 2")
    prefix = normalise_prefix(prefix)
    pointer = _read_pointer(store, prefix)
    protected = {pointer.build_id} if pointer is not None else set()

    ordered, orphans = _scan_builds(store, prefix)
    keep_set = set(ordered[:keep]) | protected
    now = utc_now()

    # A reader may still be scanning the previous build when the pointer moves; only delete a
    # complete build once it is a day old.
    stale = [
        build_id
        for build_id in ordered
        if build_id not in keep_set and (age := _age_seconds(build_id, now)) is not None and age > MIN_BUILD_AGE_SECONDS
    ]
    # A killed run leaves a prefix without a manifest. Age makes reclamation safe: an upload that
    # is still in flight is younger than the grace period.
    abandoned = [
        build_id
        for build_id in orphans
        if (age := _age_seconds(build_id, now)) is not None and age > ORPHAN_GRACE_SECONDS
    ]
    if abandoned:
        LOGGER.warning("reclaiming abandoned build prefixes: %s", sorted(abandoned))

    doomed_ids = stale + abandoned
    if not doomed_ids:
        return ()
    roots = tuple(f"{prefix}/{BUILD_ROOT}/{build_id}/" for build_id in doomed_ids)
    doomed = [key for key in store.list_keys(f"{prefix}/{BUILD_ROOT}/") if key.startswith(roots)]
    if not doomed:
        return ()
    store.delete(doomed)
    return tuple(sorted(doomed_ids))
