"""Resolve a training source (S3 pointer, S3/local glob, or local directory).

The pointer is a small JSON document with ``build_id`` and ``manifest`` keys. We keep the resolution
in one place so the CLI, the manifest and tests all agree on what "the latest silver build" means.
"""

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from tpm_analytics.silver._duck import S3Secret
from tpm_analytics.silver.manifest import Pointer
from tpm_analytics.silver.storage import S3ObjectStore


class SourceError(ValueError):
    """The source cannot be resolved into Parquet files."""


@dataclass(frozen=True)
class SourceSpec:
    """A resolved Parquet source and its provenance."""

    glob: str
    label: str
    build_id: str | None
    manifest_sha256: str | None
    s3_secret: S3Secret | None = None


def _sha256(data: bytes) -> str:
    """Return the SHA-256 of bytes."""
    return hashlib.sha256(data).hexdigest()


def _pointer_from(data: bytes) -> Pointer:
    """Build a source spec from a resolved pointer."""
    try:
        return Pointer.from_json(data)
    except (TypeError, ValueError, KeyError) as error:
        raise SourceError("silver pointer is malformed") from error


def _s3_source(uri: str) -> SourceSpec:
    """Resolve an S3 pointer into a source spec."""
    parsed = urlparse(uri)
    bucket = parsed.netloc
    key = parsed.path.lstrip("/")
    if not bucket or not key:
        raise SourceError(f"invalid S3 URI {uri!r}")
    store = S3ObjectStore(bucket)
    if not key.endswith(".json"):
        return SourceSpec(
            glob=f"s3://{bucket}/{key}",
            label=f"s3://{bucket}/{key}",
            build_id=None,
            manifest_sha256=None,
            s3_secret=None,
        )
    pointer = _pointer_from(store.get_bytes(key))
    manifest_key = pointer.manifest
    build_root = manifest_key.rsplit("/", 1)[0]
    manifest_sha = _sha256(store.get_bytes(manifest_key))
    return SourceSpec(
        glob=f"s3://{bucket}/{build_root}/**/*.parquet",
        label=f"s3://{bucket}/{key}",
        build_id=pointer.build_id,
        manifest_sha256=manifest_sha,
        s3_secret=None,
    )


def _local_pointer(path: Path) -> SourceSpec:
    """Resolve a local _latest.json pointer."""
    pointer = _pointer_from(path.read_bytes())
    build_root = path.parent / "builds" / pointer.build_id
    if not build_root.is_dir():
        raise SourceError(f"pointer {path} names missing build directory {build_root}")
    manifest_path = build_root / "_manifest.json"
    manifest_sha = _sha256(manifest_path.read_bytes()) if manifest_path.is_file() else None
    return SourceSpec(
        glob=str(build_root / "**" / "*.parquet"),
        label=str(path),
        build_id=pointer.build_id,
        manifest_sha256=manifest_sha,
    )


def resolve_source(value: str) -> SourceSpec:
    """Resolve a pointer, glob, file or directory into a Parquet glob and provenance."""
    if value.startswith("s3://"):
        spec = _s3_source(value)
        # Deferred import keeps the local path free of boto3 session work.
        from tpm_analytics.silver.storage import s3_secret_from_session

        return SourceSpec(
            glob=spec.glob,
            label=spec.label,
            build_id=spec.build_id,
            manifest_sha256=spec.manifest_sha256,
            s3_secret=s3_secret_from_session(),
        )
    path = Path(value)
    if path.is_dir():
        pointer = path / "_latest.json"
        if pointer.is_file():
            return _local_pointer(pointer)
        files = sorted(path.glob("**/*.parquet"))
        if not files:
            raise SourceError(f"directory {path} contains no Parquet files")
        manifest_path = path / "_manifest.json"
        build_id: str | None = None
        manifest_sha: str | None = None
        if manifest_path.is_file():
            manifest_bytes = manifest_path.read_bytes()
            try:
                payload = json.loads(manifest_bytes)
            except json.JSONDecodeError as error:
                raise SourceError(f"manifest {manifest_path} is not valid JSON") from error
            value = payload.get("build_id")
            build_id = str(value) if value else None
            manifest_sha = _sha256(manifest_bytes)
        return SourceSpec(
            glob=str(path / "**" / "*.parquet"),
            label=str(path),
            build_id=build_id,
            manifest_sha256=manifest_sha,
        )
    if path.is_file() and path.suffix == ".json":
        return _local_pointer(path)
    if "*" in value:
        return SourceSpec(glob=value, label=value, build_id=None, manifest_sha256=None)
    if path.is_file():
        return SourceSpec(glob=str(path), label=str(path), build_id=None, manifest_sha256=None)
    raise SourceError(f"source {value!r} is not an S3 URI, pointer, glob, file or directory")
