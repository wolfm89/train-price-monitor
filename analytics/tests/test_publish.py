"""Publishing: upload order, manifest, pointer, retention and failure cleanup."""

from __future__ import annotations

from pathlib import Path

import pytest

from tests.conftest import Built
from tpm_analytics.silver.build import BuildStats
from tpm_analytics.silver.manifest import BuildManifest, Pointer, manifest_key, pointer_key
from tpm_analytics.silver.publish import build_ids, publish, retain
from tpm_analytics.silver.storage import LocalObjectStore, ObjectStore


def stats_for(rows: int = 6) -> BuildStats:
    return BuildStats(
        source="/data/prices/**/*.parquet",
        target="/tmp/silver",
        rows_in=rows,
        rows_out=rows,
        duplicates_removed=0,
        partitions=2,
        duration_seconds=1.5,
    )


def publish_one(
    store: LocalObjectStore,
    built: Built,
    build_id: str,
    *,
    keep: int = 2,
) -> str:
    result = publish(
        store,
        build_id=build_id,
        local_dir=built.target,
        stats=built.stats,
        source=built.stats.source,
        bucket="test-bucket",
        prefix="silver",
        transform_version="test",
        duckdb_version="2.0.0",
        keep=keep,
    )
    return result.manifest.build_id


def test_publish_writes_files_manifest_and_pointer(build, tmp_path: Path) -> None:
    built = build()
    store = LocalObjectStore(tmp_path / "bucket")
    build_id = "20260101T000000Z"
    publish_one(store, built, build_id)

    keys = store.list_keys("silver/builds/")
    parquet_keys = [key for key in keys if key.endswith(".parquet")]
    assert len(parquet_keys) == built.stats.partitions
    assert manifest_key("silver", build_id) in keys

    manifest = BuildManifest.from_json(store.get_bytes(manifest_key("silver", build_id)))
    assert manifest.build_id == build_id
    assert manifest.rows_in == built.stats.rows_in
    assert manifest.rows_out == built.stats.rows_out
    assert manifest.duplicates_removed == 0
    assert manifest.partitions == built.stats.partitions
    assert manifest.total_bytes == sum(file.bytes for file in manifest.files)
    assert all(store.size(file.key) == file.bytes for file in manifest.files)

    pointer = Pointer.from_json(store.get_bytes(pointer_key("silver")))
    assert pointer.build_id == build_id
    assert pointer.manifest == manifest_key("silver", build_id)


def test_pointer_only_moves_after_the_build_is_readable(build, tmp_path: Path) -> None:
    built = build()
    store = LocalObjectStore(tmp_path / "bucket")
    publish_one(store, built, "20260101T000000Z")
    before = store.get_bytes(pointer_key("silver"))

    class BrokenStore(LocalObjectStore):
        def size(self, key: str) -> int:
            raise FileNotFoundError(key)

    broken = BrokenStore(store._root)
    with pytest.raises(FileNotFoundError):
        publish_one(broken, built, "20260102T000000Z")

    assert store.get_bytes(pointer_key("silver")) == before
    assert build_ids(store, "silver") == ["20260101T000000Z"]


def test_failed_upload_removes_the_half_written_build(build, tmp_path: Path) -> None:
    built = build()
    store = LocalObjectStore(tmp_path / "bucket")

    class FailingStore(LocalObjectStore):
        calls = 0

        def put_file(self, local_path: Path, key: str) -> int:
            FailingStore.calls += 1
            if FailingStore.calls == 2:
                raise OSError("network went away")
            return super().put_file(local_path, key)

    with pytest.raises(OSError, match="network went away"):
        publish_one(FailingStore(store._root), built, "20260103T000000Z")

    assert build_ids(store, "silver") == []


def test_retention_keeps_the_newest_builds(build, tmp_path: Path) -> None:
    built = build()
    store = LocalObjectStore(tmp_path / "bucket")
    for build_id in ("20260101T000000Z", "20260102T000000Z", "20260103T000000Z"):
        publish_one(store, built, build_id)

    assert build_ids(store, "silver") == ["20260103T000000Z", "20260102T000000Z"]
    manifest = BuildManifest.from_json(store.get_bytes(manifest_key("silver", "20260103T000000Z")))
    assert manifest.build_id == "20260103T000000Z"


def test_retain_is_idempotent(build, tmp_path: Path) -> None:
    built = build()
    store = LocalObjectStore(tmp_path / "bucket")
    publish_one(store, built, "20260101T000000Z")
    assert retain(store, prefix="silver", keep=2) == ()


def test_publish_rejects_an_empty_directory(tmp_path: Path) -> None:
    store = LocalObjectStore(tmp_path / "bucket")
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(ValueError, match="no parquet files"):
        publish(
            store,
            build_id="20260101T000000Z",
            local_dir=empty,
            stats=stats_for(),
            source="s3://bucket/prices/**/*.parquet",
            bucket="test-bucket",
            prefix="silver",
            transform_version="test",
            duckdb_version="2.0.0",
        )


def test_publish_rejects_keep_below_one(build, tmp_path: Path) -> None:
    store = LocalObjectStore(tmp_path / "bucket")
    with pytest.raises(ValueError, match="keep"):
        publish(
            store,
            build_id="20260101T000000Z",
            local_dir=build().target,
            stats=stats_for(),
            source="s3://bucket/prices/**/*.parquet",
            bucket="test-bucket",
            prefix="silver",
            transform_version="test",
            duckdb_version="2.0.0",
            keep=0,
        )


def test_local_store_cannot_escape_its_root(tmp_path: Path) -> None:
    store = LocalObjectStore(tmp_path / "bucket")
    with pytest.raises(ValueError, match="escapes"):
        store.put_bytes(b"x", "../../etc/passwd")


def test_store_protocol_can_be_satisfied_by_the_local_store(tmp_path: Path) -> None:
    store: ObjectStore = LocalObjectStore(tmp_path / "bucket")
    store.put_bytes(b"hello", "a/b.txt")
    assert store.size("a/b.txt") == 5
    assert store.get_bytes("a/b.txt") == b"hello"
    assert store.list_keys("a/") == ["a/b.txt"]
    store.delete(["a/b.txt"])
    assert store.list_keys("a/") == []
