"""Publish a verified local build into an object store.

Order matters: every data file, then the manifest, then a read-back check, and only then the
pointer. The pointer write is the commit point: once it has been attempted the build is never
deleted, because a PUT that errors may still have landed.

Retention is best effort *after* the commit. It never deletes the build the pointer names, and it
only considers builds that have a manifest, so prefixes abandoned by a killed run cannot push a
good build out.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

from botocore.exceptions import ClientError

from tpm_analytics.silver._duck import asset_dir
from tpm_analytics.silver.build import BuildStats
from tpm_analytics.silver.manifest import (
    BUILD_ID_PATTERN,
    MANIFEST_VERSION,
    BuildFile,
    BuildManifest,
    Pointer,
    manifest_key,
    pointer_key,
    timestamp_of,
    utc_now,
)
from tpm_analytics.silver.storage import ObjectStore

DEFAULT_KEEP = 2
BUILD_ROOT = "builds"


@dataclass(frozen=True)
class PublishResult:
    manifest: BuildManifest
    uploaded_bytes: int
    deleted_builds: tuple[str, ...]
    warnings: tuple[str, ...] = ()


def normalise_prefix(prefix: str) -> str:
    normalised = prefix.strip("/")
    if not normalised:
        raise ValueError("prefix must not be empty")
    return normalised


def validate_build_id(build_id: str) -> None:
    if not BUILD_ID_PATTERN.match(build_id):
        raise ValueError(f"invalid build id {build_id!r}")


def asset_hashes() -> tuple[str, str]:
    """The SQL and the station dimension determine the transform as much as the code does."""
    sql = (asset_dir("sql") / "silver.sql").read_bytes()
    stations = (asset_dir("data") / "stations.json").read_bytes()
    return hashlib.sha256(sql).hexdigest(), hashlib.sha256(stations).hexdigest()


def _build_prefix(prefix: str, build_id: str) -> str:
    return f"{prefix}/{BUILD_ROOT}/{build_id}"


def _read_pointer(store: ObjectStore, prefix: str) -> Pointer | None:
    try:
        return Pointer.from_json(store.get_bytes(pointer_key(prefix)))
    except (FileNotFoundError, ClientError, ValueError):
        return None


def verify_upload(store: ObjectStore, manifest: BuildManifest) -> None:
    """The upload is only usable if every file is there with the recorded size."""
    build_prefix = _build_prefix(manifest.prefix, manifest.build_id) + "/"
    for file in manifest.files:
        if not file.key.startswith(build_prefix):
            raise ValueError(f"file {file.key} is outside {build_prefix}")
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
    present = set(store.list_keys(build_prefix))
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
    bucket: str,
    prefix: str,
    transform_version: str,
    duckdb_version: str,
    keep: int = DEFAULT_KEEP,
) -> PublishResult:
    """Upload ``local_dir`` under ``<prefix>/builds/<build_id>/`` and move the pointer."""
    root = Path(local_dir)
    prefix = normalise_prefix(prefix)
    validate_build_id(build_id)
    if keep < 1:
        raise ValueError("keep must be at least 1")
    if not stats.verified:
        raise ValueError("refusing to publish a build whose quality gate did not run")
    parquet_files = sorted(path for path in root.rglob("*.parquet"))
    if not parquet_files:
        raise ValueError(f"build directory {root} contains no parquet files")
    if len(parquet_files) < stats.partitions:
        raise ValueError(f"{len(parquet_files)} files for {stats.partitions} partitions")

    build_prefix = _build_prefix(prefix, build_id)
    if store.list_keys(build_prefix + "/"):
        raise ValueError(f"build prefix {build_prefix} already exists")

    # A slower, older run must not move the pointer backwards over a newer build.
    current = _read_pointer(store, prefix)
    if current is not None and timestamp_of(current.build_id) > timestamp_of(build_id):
        raise ValueError(f"build {current.build_id} is already newer than {build_id}")

    sql_sha, stations_sha = asset_hashes()
    uploaded: list[BuildFile] = []
    written_keys: list[str] = []
    pointer_attempted = False
    manifest: BuildManifest | None = None
    try:
        for path in parquet_files:
            key = f"{build_prefix}/{path.relative_to(root).as_posix()}"
            size = store.put_file(path, key)
            uploaded.append(BuildFile(key=key, bytes=size))
            written_keys.append(key)

        manifest = BuildManifest(
            manifest_version=MANIFEST_VERSION,
            build_id=build_id,
            created_at=utc_now().isoformat(),
            source=source,
            source_files=tuple(source_files),
            bucket=bucket,
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
            files=tuple(uploaded),
        )
        key = manifest_key(prefix, build_id)
        store.put_bytes(manifest.to_json(), key, content_type="application/json")
        written_keys.append(key)
        verify_upload(store, manifest)

        pointer = Pointer(build_id=build_id, manifest=key, updated_at=utc_now().isoformat())
        pointer_attempted = True
        store.put_bytes(pointer.to_json(), pointer_key(prefix), content_type="application/json")
    except BaseException:
        if not (pointer_attempted and _pointer_names(store, prefix, build_id)):
            _delete_quietly(store, written_keys)
        raise

    warnings: list[str] = []
    try:
        deleted = retain(store, prefix=prefix, keep=keep)
    except Exception as error:
        deleted = ()
        warnings.append(f"retention failed: {error}")

    return PublishResult(
        manifest=manifest,
        uploaded_bytes=manifest.total_bytes,
        deleted_builds=deleted,
        warnings=tuple(warnings),
    )


def _pointer_names(store: ObjectStore, prefix: str, build_id: str) -> bool:
    try:
        current = _read_pointer(store, prefix)
    except Exception:
        return True
    return current is not None and current.build_id == build_id


def _delete_quietly(store: ObjectStore, keys: list[str]) -> None:
    if not keys:
        return
    try:
        store.delete(keys)
    except Exception:
        return


def build_ids(store: ObjectStore, prefix: str) -> list[str]:
    """Build ids with a manifest, newest first. Abandoned prefixes are ignored."""
    prefix = normalise_prefix(prefix)
    root = f"{prefix}/{BUILD_ROOT}/"
    keys = set(store.list_keys(root))
    candidates = {key[len(root) :].split("/")[0] for key in keys if key.startswith(root)}
    complete = [build_id for build_id in candidates if manifest_key(prefix, build_id) in keys]
    return sorted(complete, reverse=True)


def retain(store: ObjectStore, *, prefix: str, keep: int) -> tuple[str, ...]:
    """Delete every build older than the newest ``keep``; the pointed-at build is never deleted."""
    if keep < 1:
        raise ValueError("keep must be at least 1")
    prefix = normalise_prefix(prefix)
    pointer = _read_pointer(store, prefix)
    protected = {pointer.build_id} if pointer is not None else set()

    ordered = build_ids(store, prefix)
    keep_set = set(ordered[:keep]) | protected
    stale = [build_id for build_id in ordered if build_id not in keep_set]
    if not stale:
        return ()

    stale_roots = tuple(f"{prefix}/{BUILD_ROOT}/{build_id}/" for build_id in stale)
    doomed = [key for key in store.list_keys(f"{prefix}/{BUILD_ROOT}/") if key.startswith(stale_roots)]
    if not doomed:
        return ()
    store.delete(doomed)
    return tuple(sorted(stale))
