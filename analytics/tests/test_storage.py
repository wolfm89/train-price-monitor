"""S3ObjectStore against botocore's Stubber: pagination, batching and error handling."""

from __future__ import annotations

import boto3
import pytest
from botocore.stub import Stubber

from tpm_analytics.silver.storage import S3ObjectStore


def make_store() -> tuple[S3ObjectStore, Stubber]:
    client = boto3.client(
        "s3",
        region_name="eu-central-1",
        aws_access_key_id="test",
        aws_secret_access_key="test",
    )
    return S3ObjectStore("bucket", client=client), Stubber(client)


def test_list_keys_follows_pagination() -> None:
    store, stubber = make_store()
    stubber.add_response(
        "list_objects_v2",
        {"IsTruncated": True, "Contents": [{"Key": "a"}], "NextContinuationToken": "next"},
        {"Bucket": "bucket", "Prefix": "p/"},
    )
    stubber.add_response(
        "list_objects_v2",
        {"IsTruncated": False, "Contents": [{"Key": "b"}]},
        {"Bucket": "bucket", "Prefix": "p/", "ContinuationToken": "next"},
    )
    with stubber:
        assert store.list_keys("p/") == ["a", "b"]


def test_delete_splits_at_one_thousand_keys() -> None:
    store, stubber = make_store()
    keys = [f"k{index}" for index in range(1001)]
    for batch in (keys[:1000], keys[1000:]):
        stubber.add_response(
            "delete_objects",
            {},
            {"Bucket": "bucket", "Delete": {"Objects": [{"Key": key} for key in batch]}},
        )
    with stubber:
        store.delete(keys)


def test_delete_surfaces_per_key_errors() -> None:
    store, stubber = make_store()
    stubber.add_response(
        "delete_objects",
        {"Errors": [{"Key": "k1", "Code": "AccessDenied"}]},
        {"Bucket": "bucket", "Delete": {"Objects": [{"Key": "k1"}]}},
    )
    with stubber, pytest.raises(RuntimeError, match="AccessDenied"):
        store.delete(["k1"])


def test_size_requires_a_head_response() -> None:
    store, stubber = make_store()
    stubber.add_response("head_object", {"ContentLength": 42}, {"Bucket": "bucket", "Key": "k"})
    with stubber:
        assert store.size("k") == 42


def test_put_bytes_sets_the_content_type() -> None:
    store, stubber = make_store()
    stubber.add_response(
        "put_object",
        {},
        {"Bucket": "bucket", "Key": "k.json", "Body": b"{}", "ContentType": "application/json"},
    )
    with stubber:
        store.put_bytes(b"{}", "k.json", content_type="application/json")
