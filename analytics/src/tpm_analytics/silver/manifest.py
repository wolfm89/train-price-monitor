"""Build manifest and the ``_latest.json`` pointer.

The manifest is the record of what a build contains; the pointer is the only thing a reader has to
resolve. Both are written by the publisher, and the pointer always names a manifest that was read
back and checked first.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from uuid import uuid4

MANIFEST_NAME = "_manifest.json"
POINTER_NAME = "_latest.json"
MANIFEST_VERSION = 1

# 20261114T173000Z-a1b2c3d4: sortable by time, unique within a second.
BUILD_ID_PATTERN = re.compile(r"^\d{8}T\d{6}Z-[0-9a-f]{8}$")


@dataclass(frozen=True)
class BuildFile:
    key: str
    bytes: int


@dataclass(frozen=True)
class BuildManifest:
    """Everything needed to reproduce and audit one build."""

    manifest_version: int
    build_id: str
    created_at: str
    source: str
    source_files: tuple[str, ...]
    bucket: str
    prefix: str
    rows_in: int
    rows_out: int
    duplicates_removed: int
    partitions: int
    duration_seconds: float
    transform_version: str
    duckdb_version: str
    sql_sha256: str
    stations_sha256: str
    files: tuple[BuildFile, ...]

    @property
    def total_bytes(self) -> int:
        return sum(file.bytes for file in self.files)

    def to_json(self) -> bytes:
        payload = asdict(self)
        payload["files"] = [asdict(file) for file in self.files]
        return (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8")

    @classmethod
    def from_json(cls, data: bytes) -> BuildManifest:
        payload = json.loads(data)
        version = payload.get("manifest_version")
        if version != MANIFEST_VERSION:
            raise ValueError(f"unsupported manifest version {version!r}; this reader knows {MANIFEST_VERSION}")
        files = tuple(BuildFile(key=item["key"], bytes=int(item["bytes"])) for item in payload.pop("files"))
        payload["source_files"] = tuple(payload.get("source_files", ()))
        return cls(**payload, files=files)


@dataclass(frozen=True)
class Pointer:
    build_id: str
    manifest: str
    updated_at: str

    def to_json(self) -> bytes:
        return (json.dumps(asdict(self), indent=2, sort_keys=True) + "\n").encode("utf-8")

    @classmethod
    def from_json(cls, data: bytes) -> Pointer:
        return cls(**json.loads(data))


def utc_now() -> datetime:
    return datetime.now(UTC)


def build_id_for(moment: datetime) -> str:
    """Sortable and collision-free: ``20261114T173000Z-a1b2c3d4``."""
    return f"{moment.strftime('%Y%m%dT%H%M%SZ')}-{uuid4().hex[:8]}"


def timestamp_of(build_id: str) -> str:
    """The sortable time part of a build id, used to compare two builds."""
    return build_id[:16]


def manifest_key(prefix: str, build_id: str) -> str:
    return f"{prefix}/builds/{build_id}/{MANIFEST_NAME}"


def pointer_key(prefix: str) -> str:
    return f"{prefix}/{POINTER_NAME}"
