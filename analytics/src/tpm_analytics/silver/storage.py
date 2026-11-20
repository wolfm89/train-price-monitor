"""Object-store abstraction for publishing a build.

The publisher never talks to S3 directly: it takes an :class:`ObjectStore`, which keeps the
publish logic (ordering, verification, pointer, retention) testable against a local directory.
"""

import os
from itertools import batched
from pathlib import Path
from typing import Any, Protocol

import boto3

from tpm_analytics.silver._duck import S3Secret


def s3_secret_from_session() -> S3Secret:
    """Freeze the current boto3 credentials for DuckDB's temporary secret.

    The training CLI uses the same profile/role as the rest of the local tooling. The secret is
    passed to DuckDB in memory and is never written to the manifest or a log line.
    """
    session = boto3.Session()
    credentials = session.get_credentials()
    if credentials is None:
        raise RuntimeError("no AWS credentials found; run aws sso login or set a profile")
    frozen = credentials.get_frozen_credentials()
    if frozen.access_key is None or frozen.secret_key is None:
        raise RuntimeError("AWS credentials are missing an access key or secret")
    region = (
        session.region_name or os.environ.get("AWS_DEFAULT_REGION") or os.environ.get("AWS_REGION") or "eu-central-1"
    )
    return S3Secret(
        access_key=frozen.access_key,
        secret_key=frozen.secret_key,
        session_token=frozen.token or "",
        region=region,
    )


class ObjectStore(Protocol):
    """The subset of S3 the publisher needs."""

    bucket: str

    def put_file(self, local_path: Path, key: str) -> int:
        """Upload a file and return its size in bytes."""

    def put_bytes(self, data: bytes, key: str, *, content_type: str = "application/octet-stream") -> None: ...

    def get_bytes(self, key: str) -> bytes: ...

    def size(self, key: str) -> int: ...

    def list_keys(self, prefix: str) -> list[str]: ...

    def delete(self, keys: list[str]) -> None: ...


class LocalObjectStore:
    """A directory pretending to be a bucket. Simplified: no multipart, no ETags, no per-key errors."""

    def __init__(self, root: Path, bucket: str = "local") -> None:
        self.bucket = bucket
        self._root = root
        self._root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        path = (self._root / key).resolve()
        if not path.is_relative_to(self._root.resolve()):
            raise ValueError(f"key {key!r} escapes the store root")
        return path

    def _write(self, destination: Path, data: bytes) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(destination.suffix + ".tmp")
        temporary.write_bytes(data)
        os.replace(temporary, destination)

    def put_file(self, local_path: Path, key: str) -> int:
        self._write(self._path(key), local_path.read_bytes())
        return self._path(key).stat().st_size

    def put_bytes(self, data: bytes, key: str, *, content_type: str = "application/octet-stream") -> None:
        self._write(self._path(key), data)

    def get_bytes(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def size(self, key: str) -> int:
        return self._path(key).stat().st_size

    def list_keys(self, prefix: str) -> list[str]:
        base = self._path(prefix)
        if not base.exists():
            return []
        return sorted(path.relative_to(self._root).as_posix() for path in base.rglob("*") if path.is_file())

    def delete(self, keys: list[str]) -> None:
        for key in keys:
            path = self._path(key)
            if path.exists():
                path.unlink()


class S3ObjectStore:
    """The real thing. Credentials come from the Lambda execution role."""

    def __init__(
        self,
        bucket: str,
        client: Any | None = None,
        *,
        region: str | None = None,
        config: Any | None = None,
    ) -> None:
        self.bucket = bucket
        self._client: Any = client if client is not None else boto3.client("s3", region_name=region, config=config)

    def put_file(self, local_path: Path, key: str) -> int:
        self._client.upload_file(str(local_path), self.bucket, key)
        return local_path.stat().st_size

    def put_bytes(self, data: bytes, key: str, *, content_type: str = "application/octet-stream") -> None:
        self._client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type)

    def get_bytes(self, key: str) -> bytes:
        response = self._client.get_object(Bucket=self.bucket, Key=key)
        body: bytes = response["Body"].read()
        return body

    def size(self, key: str) -> int:
        response = self._client.head_object(Bucket=self.bucket, Key=key)
        return int(response["ContentLength"])

    def list_keys(self, prefix: str) -> list[str]:
        keys: list[str] = []
        paginator = self._client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
            keys.extend(item["Key"] for item in page.get("Contents", []))
        return sorted(keys)

    def delete(self, keys: list[str]) -> None:
        for batch in batched(keys, 1000, strict=False):
            response = self._client.delete_objects(
                Bucket=self.bucket, Delete={"Objects": [{"Key": key} for key in batch]}
            )
            errors = response.get("Errors") or []
            if errors:
                detail = ", ".join(f"{item.get('Key')}: {item.get('Code')}" for item in errors)
                raise RuntimeError(f"S3 refused to delete {len(errors)} key(s): {detail}")
