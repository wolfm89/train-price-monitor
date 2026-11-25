"""Source resolution and provenance tests for the training CLI."""

import hashlib
import json
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from tpm_analytics.training.sources import SourceError, resolve_source


def _parquet(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_pylist([{"route_id": "r", "fare_lowest_eur": 1.0}]), path)


def test_directory_source_reads_manifest_provenance(tmp_path: Path) -> None:
    build = tmp_path / "silver" / "20261117T000000Z-abcdef12"
    _parquet(build / "departure_year=2026" / "data.parquet")
    manifest = build / "_manifest.json"
    manifest.write_text(json.dumps({"build_id": "20261117T000000Z-abcdef12"}), encoding="utf-8")

    source = resolve_source(str(build))
    assert source.build_id == "20261117T000000Z-abcdef12"
    assert source.manifest_sha256 == hashlib.sha256(manifest.read_bytes()).hexdigest()
    assert source.glob.endswith("**/*.parquet")


def test_directory_without_manifest_has_no_build_id(tmp_path: Path) -> None:
    build = tmp_path / "some_stale_download"
    _parquet(build / "data.parquet")
    source = resolve_source(str(build))
    assert source.build_id is None
    assert source.manifest_sha256 is None


def test_local_pointer_source(tmp_path: Path) -> None:
    root = tmp_path / "silver"
    build = root / "builds" / "20261117T000000Z-abcdef12"
    _parquet(build / "data.parquet")
    (build / "_manifest.json").write_text(json.dumps({"build_id": "20261117T000000Z-abcdef12"}), encoding="utf-8")
    pointer = root / "_latest.json"
    pointer.write_text(
        json.dumps(
            {
                "build_id": "20261117T000000Z-abcdef12",
                "manifest": "silver/builds/20261117T000000Z-abcdef12/_manifest.json",
                "updated_at": "2026-11-17T00:00:00+00:00",
            }
        ),
        encoding="utf-8",
    )
    source = resolve_source(str(pointer))
    assert source.build_id == "20261117T000000Z-abcdef12"
    assert source.glob.endswith("builds/20261117T000000Z-abcdef12/**/*.parquet")


def test_invalid_source_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(SourceError):
        resolve_source(str(tmp_path / "missing"))
