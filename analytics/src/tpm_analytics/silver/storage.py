"""Object-store abstraction for publishing a build.

The publisher never talks to S3 directly: it takes an :class:`ObjectStore`, which keeps the
publish logic (ordering, verification, pointer, retention) testable against a local directory.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol

import boto3


class ObjectStore(Protocol):
    """The subset of S3 the publisher needs."""

    def put_file(self, local_path: Path, key: str) -> int:
        """Upload a file and return its size in bytes."""

    def put_bytes(self, data: bytes, key: str) -> None: ...

    def get_bytes(self, key: str) -> bytes: ...

    def size(self, key: str) -> int: ...

    def list_keys(self, prefix: str) -> list[str]: ...

    def delete(self, keys: list[str]) -> None: ...


class LocalObjectStore:
    """A directory pretending to be a bucket; used by the tests and by ``--target s3`` dry runs."""

    def __init__(self, root: Path) -> None:
        self._root = root
        self._root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        path = (self._root / key).resolve()
        if not path.is_relative_to(self._root.resolve()):
            raise ValueError(f"key {key!r} escapes the store root")
        return path

    def put_file(self, local_path: Path, key: str) -> int:
        destination = self._path(key)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(local_path.read_bytes())
        return destination.stat().st_size

    def put_bytes(self, data: bytes, key: str) -> None:
        destination = self._path(key)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)

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

    def __init__(self, bucket: str, client: Any | None = None) -> None:
        self.bucket = bucket
        self._client: Any = client if client is not None else boto3.client("s3")

    def put_file(self, local_path: Path, key: str) -> int:
        self._client.upload_file(str(local_path), self.bucket, key)
        return local_path.stat().st_size

    def put_bytes(self, data: bytes, key: str) -> None:
        self._client.put_object(Bucket=self.bucket, Key=key, Body=data)

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
        for start in range(0, len(keys), 1000):
            batch = keys[start : start + 1000]
            self._client.delete_objects(Bucket=self.bucket, Delete={"Objects": [{"Key": key} for key in batch]})
