"""Publish a verified local build into an object store.

Order matters: every data file, then the manifest, then a read-back check, and only then the
pointer. A failure at any step removes the half-written build and leaves ``_latest.json`` pointing
at the previous good one.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from tpm_analytics.silver.build import BuildStats
from tpm_analytics.silver.manifest import (
    BuildFile,
    BuildManifest,
    Pointer,
    manifest_key,
    pointer_key,
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


def _build_prefix(prefix: str, build_id: str) -> str:
    return f"{prefix}/{BUILD_ROOT}/{build_id}"


def verify_upload(store: ObjectStore, manifest: BuildManifest) -> None:
    """The upload is only usable if every file is there with the recorded size."""
    for file in manifest.files:
        if store.size(file.key) != file.bytes:
            raise RuntimeError(f"uploaded file {file.key} does not match its recorded size")
    landed = BuildManifest.from_json(store.get_bytes(manifest_key(manifest.prefix, manifest.build_id)))
    if landed.build_id != manifest.build_id:
        raise RuntimeError("manifest read back from the store names a different build")


def publish(
    store: ObjectStore,
    *,
    build_id: str,
    local_dir: str | Path,
    stats: BuildStats,
    source: str,
    bucket: str,
    prefix: str,
    transform_version: str,
    duckdb_version: str,
    keep: int = DEFAULT_KEEP,
) -> PublishResult:
    """Upload ``local_dir`` under ``<prefix>/builds/<build_id>/`` and move the pointer."""
    root = Path(local_dir)
    parquet_files = sorted(path for path in root.rglob("*.parquet"))
    if not parquet_files:
        raise ValueError(f"build directory {root} contains no parquet files")
    if keep < 1:
        raise ValueError("keep must be at least 1")

    uploaded: list[BuildFile] = []
    written_keys: list[str] = []
    build_prefix = _build_prefix(prefix, build_id)
    manifest: BuildManifest | None = None
    try:
        for path in parquet_files:
            key = f"{build_prefix}/{path.relative_to(root).as_posix()}"
            size = store.put_file(path, key)
            uploaded.append(BuildFile(key=key, bytes=size))
            written_keys.append(key)

        manifest = BuildManifest(
            manifest_version=1,
            build_id=build_id,
            created_at=utc_now().isoformat(),
            source=source,
            bucket=bucket,
            prefix=prefix,
            rows_in=stats.rows_in,
            rows_out=stats.rows_out,
            duplicates_removed=stats.duplicates_removed,
            partitions=stats.partitions,
            duration_seconds=stats.duration_seconds,
            transform_version=transform_version,
            duckdb_version=duckdb_version,
            files=tuple(uploaded),
        )
        key = manifest_key(prefix, build_id)
        store.put_bytes(manifest.to_json(), key)
        written_keys.append(key)

        verify_upload(store, manifest)

        pointer = Pointer(build_id=build_id, manifest=key, updated_at=utc_now().isoformat())
        store.put_bytes(pointer.to_json(), pointer_key(prefix))
    except BaseException:
        store.delete(written_keys)
        raise

    deleted = retain(store, prefix=prefix, keep=keep)
    return PublishResult(
        manifest=manifest,
        uploaded_bytes=manifest.total_bytes,
        deleted_builds=deleted,
    )


def build_ids(store: ObjectStore, prefix: str) -> list[str]:
    """Build ids present in the store, newest first (ids sort chronologically)."""
    root = f"{prefix}/{BUILD_ROOT}/"
    ids = {key[len(root) :].split("/")[0] for key in store.list_keys(root) if key.startswith(root)}
    return sorted(ids, reverse=True)


def retain(store: ObjectStore, *, prefix: str, keep: int) -> tuple[str, ...]:
    """Delete every build older than the newest ``keep``; returns the deleted ids."""
    stale = build_ids(store, prefix)[keep:]
    if not stale:
        return ()
    stale_roots = tuple(f"{prefix}/{BUILD_ROOT}/{build_id}/" for build_id in stale)
    doomed = [key for key in store.list_keys(f"{prefix}/{BUILD_ROOT}/") if key.startswith(stale_roots)]
    store.delete(doomed)
    return tuple(sorted(stale))
