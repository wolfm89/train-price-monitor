"""Publishing: upload order, manifest, pointer, retention and failure cleanup."""

from __future__ import annotations

from pathlib import Path

import pytest

from tests.conftest import Built
from tpm_analytics.silver.build import BuildStats
from tpm_analytics.silver.manifest import BuildManifest, Pointer, manifest_key, pointer_key
from tpm_analytics.silver.publish import build_ids, publish, retain
from tpm_analytics.silver.storage import LocalObjectStore, ObjectStore


def stats_for(rows: int = 6, *, verified: bool = True) -> BuildStats:
    return BuildStats(
        source="/data/prices/**/*.parquet",
        target="/tmp/silver",
        rows_in=rows,
        rows_out=rows,
        duplicates_removed=0,
        partitions=2,
        duration_seconds=1.5,
        verified=verified,
    )


def publish_one(store: LocalObjectStore, built: Built, build_id: str, *, keep: int = 2) -> str:
    result = publish(
        store,
        build_id=build_id,
        local_dir=built.target,
        stats=built.stats,
        source=built.stats.source,
        source_files=("prices/a.parquet", "prices/b.parquet"),
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
    build_id = "20260101T000000Z-abcdef01"
    publish_one(store, built, build_id)

    keys = store.list_keys("silver/builds/")
    parquet_keys = [key for key in keys if key.endswith(".parquet")]
    assert len(parquet_keys) == built.stats.partitions
    assert all(key.startswith(f"silver/builds/{build_id}/departure_year=") for key in parquet_keys)
    assert manifest_key("silver", build_id) in keys

    manifest = BuildManifest.from_json(store.get_bytes(manifest_key("silver", build_id)))
    assert manifest.build_id == build_id
    assert manifest.rows_in == built.stats.rows_in
    assert manifest.duplicates_removed == 0
    assert manifest.partitions == built.stats.partitions
    assert manifest.source_files == ("prices/a.parquet", "prices/b.parquet")
    assert len(manifest.sql_sha256) == 64
    assert len(manifest.stations_sha256) == 64
    assert manifest.total_bytes == sum(file.bytes for file in manifest.files)
    assert all(store.size(file.key) == file.bytes for file in manifest.files)

    pointer = Pointer.from_json(store.get_bytes(pointer_key("silver")))
    assert pointer.build_id == build_id
    assert pointer.manifest == manifest_key("silver", build_id)


def test_pointer_only_moves_after_the_build_is_readable(build, tmp_path: Path) -> None:
    built = build()
    store = LocalObjectStore(tmp_path / "bucket")
    publish_one(store, built, "20260101T000000Z-aaaaaaaa")
    before = store.get_bytes(pointer_key("silver"))

    class BrokenStore(LocalObjectStore):
        def size(self, key: str) -> int:
            raise FileNotFoundError(key)

    with pytest.raises(FileNotFoundError):
        publish_one(BrokenStore(store._root), built, "20260102T000000Z-bbbbbbbb")

    assert store.get_bytes(pointer_key("silver")) == before
    assert build_ids(store, "silver") == ["20260101T000000Z-aaaaaaaa"]


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
        publish_one(FailingStore(store._root), built, "20260103T000000Z-cccccccc")

    assert build_ids(store, "silver") == []


def test_a_pointer_write_that_errors_does_not_delete_the_build(build, tmp_path: Path) -> None:
    """The PUT may have landed; deleting the build would leave a dangling pointer."""
    built = build()
    store = LocalObjectStore(tmp_path / "bucket")

    class AmbiguousStore(LocalObjectStore):
        def put_bytes(self, data: bytes, key: str, *, content_type: str = "application/octet-stream") -> None:
            super().put_bytes(data, key, content_type=content_type)
            if key.endswith("_latest.json"):
                raise TimeoutError("connection reset after the PUT")

    with pytest.raises(TimeoutError):
        publish_one(AmbiguousStore(store._root), built, "20260104T000000Z-dddddddd")

    pointer = Pointer.from_json(store.get_bytes(pointer_key("silver")))
    assert pointer.build_id == "20260104T000000Z-dddddddd"
    assert build_ids(store, "silver") == ["20260104T000000Z-dddddddd"]
    assert manifest_key("silver", "20260104T000000Z-dddddddd") in store.list_keys("silver/builds/")


def test_retention_keeps_the_newest_builds_and_the_pointer(build, tmp_path: Path) -> None:
    built = build()
    store = LocalObjectStore(tmp_path / "bucket")
    for build_id in (
        "20260101T000000Z-aaaaaaaa",
        "20260102T000000Z-bbbbbbbb",
        "20260103T000000Z-cccccccc",
    ):
        publish_one(store, built, build_id)

    assert build_ids(store, "silver") == ["20260103T000000Z-cccccccc", "20260102T000000Z-bbbbbbbb"]
    pointer = Pointer.from_json(store.get_bytes(pointer_key("silver")))
    assert pointer.build_id in build_ids(store, "silver")


def test_retention_never_deletes_the_pointed_at_build(build, tmp_path: Path) -> None:
    built = build()
    store = LocalObjectStore(tmp_path / "bucket")
    publish_one(store, built, "20260101T000000Z-aaaaaaaa")
    # A foreign key that sorts after every timestamp: it must not push the pointer target out.
    store.put_bytes(b"junk", "silver/builds/zzz/data.parquet")
    publish_one(store, built, "20260102T000000Z-bbbbbbbb", keep=1)

    pointer = Pointer.from_json(store.get_bytes(pointer_key("silver")))
    assert pointer.build_id == "20260102T000000Z-bbbbbbbb"
    assert pointer.build_id in build_ids(store, "silver")


def test_abandoned_prefixes_do_not_count_as_builds(build, tmp_path: Path) -> None:
    built = build()
    store = LocalObjectStore(tmp_path / "bucket")
    store.put_bytes(b"partial", "silver/builds/20260109T000000Z-ffffffff/data_0.parquet")
    publish_one(store, built, "20260101T000000Z-aaaaaaaa")
    publish_one(store, built, "20260102T000000Z-bbbbbbbb")
    publish_one(store, built, "20260103T000000Z-cccccccc")

    assert build_ids(store, "silver") == ["20260103T000000Z-cccccccc", "20260102T000000Z-bbbbbbbb"]


def test_publish_refuses_an_existing_build_prefix(build, tmp_path: Path) -> None:
    built = build()
    store = LocalObjectStore(tmp_path / "bucket")
    build_id = "20260101T000000Z-aaaaaaaa"
    publish_one(store, built, build_id)
    with pytest.raises(ValueError, match="already exists"):
        publish_one(store, built, build_id)


def test_publish_refuses_an_unverified_build(build, tmp_path: Path) -> None:
    built = build()
    store = LocalObjectStore(tmp_path / "bucket")
    with pytest.raises(ValueError, match="quality gate"):
        publish(
            store,
            build_id="20260101T000000Z-aaaaaaaa",
            local_dir=built.target,
            stats=stats_for(verified=False),
            source="s3://bucket/prices/**/*.parquet",
            source_files=(),
            bucket="test-bucket",
            prefix="silver",
            transform_version="test",
            duckdb_version="2.0.0",
        )


def test_publish_refuses_an_invalid_build_id(build, tmp_path: Path) -> None:
    store = LocalObjectStore(tmp_path / "bucket")
    with pytest.raises(ValueError, match="invalid build id"):
        publish(
            store,
            build_id="../escape",
            local_dir=build().target,
            stats=stats_for(),
            source="s3://bucket/prices/**/*.parquet",
            source_files=(),
            bucket="test-bucket",
            prefix="silver",
            transform_version="test",
            duckdb_version="2.0.0",
        )


def test_prefix_is_normalised(build, tmp_path: Path) -> None:
    built = build()
    store = LocalObjectStore(tmp_path / "bucket")
    publish(
        store,
        build_id="20260101T000000Z-aaaaaaaa",
        local_dir=built.target,
        stats=built.stats,
        source="s3://bucket/prices/**/*.parquet",
        source_files=(),
        bucket="test-bucket",
        prefix="/silver/",
        transform_version="test",
        duckdb_version="2.0.0",
    )
    assert build_ids(store, "silver") == ["20260101T000000Z-aaaaaaaa"]


def test_retain_is_idempotent(build, tmp_path: Path) -> None:
    built = build()
    store = LocalObjectStore(tmp_path / "bucket")
    publish_one(store, built, "20260101T000000Z-aaaaaaaa")
    assert retain(store, prefix="silver", keep=2) == ()


def test_publish_rejects_an_empty_directory(tmp_path: Path) -> None:
    store = LocalObjectStore(tmp_path / "bucket")
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(ValueError, match="no parquet files"):
        publish(
            store,
            build_id="20260101T000000Z-aaaaaaaa",
            local_dir=empty,
            stats=stats_for(),
            source="s3://bucket/prices/**/*.parquet",
            source_files=(),
            bucket="test-bucket",
            prefix="silver",
            transform_version="test",
            duckdb_version="2.0.0",
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
