"""S3ObjectStore against botocore's Stubber: pagination, batching and error handling."""

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


def _manifest_json(build_id: str) -> bytes:
    from tpm_analytics.silver.manifest import BuildFile, BuildManifest

    manifest = BuildManifest(
        manifest_version=2,
        build_id=build_id,
        created_at="2026-01-01T00:00:00Z",
        source="s3://bucket/prices/**/*.parquet",
        source_files=(),
        bucket="bucket",
        prefix="silver",
        rows_in=1,
        rows_out=1,
        duplicates_removed=0,
        partitions=1,
        duration_seconds=0.0,
        transform_version="t",
        duckdb_version="2.0.0",
        sql_sha256="0" * 64,
        stations_sha256="0" * 64,
        constants_sha256="0" * 64,
        warnings=(),
        files=(BuildFile(key=f"silver/builds/{build_id}/data.parquet", bytes=1),),
    )
    return manifest.to_json()


def test_s3_pointer_missing_key_is_absent() -> None:
    from tpm_analytics.silver.manifest import pointer_key
    from tpm_analytics.silver.publish import _read_pointer

    store, stubber = make_store()
    stubber.add_client_error(
        "get_object",
        service_error_code="NoSuchKey",
        service_message="missing",
        http_status_code=404,
        expected_params={"Bucket": "bucket", "Key": pointer_key("silver")},
    )
    with stubber:
        assert _read_pointer(store, "silver") is None


def test_s3_pointer_permission_error_propagates() -> None:
    import pytest
    from botocore.exceptions import ClientError

    from tpm_analytics.silver.publish import _read_pointer

    store, stubber = make_store()
    stubber.add_client_error(
        "get_object",
        service_error_code="AccessDenied",
        service_message="no",
        http_status_code=403,
    )
    with stubber, pytest.raises(ClientError):
        _read_pointer(store, "silver")


def test_s3_pointer_is_validated_against_its_manifest() -> None:
    import io

    from botocore.response import StreamingBody

    from tpm_analytics.silver.manifest import Pointer, manifest_key, pointer_key
    from tpm_analytics.silver.publish import _read_pointer

    build_id = "20260101T000000Z-aaaaaaaa"
    pointer = Pointer(build_id=build_id, manifest=manifest_key("silver", build_id), updated_at="x")
    store, stubber = make_store()
    for key, body in (
        (pointer_key("silver"), pointer.to_json()),
        (manifest_key("silver", build_id), _manifest_json(build_id)),
    ):
        stubber.add_response(
            "get_object",
            {"Body": StreamingBody(io.BytesIO(body), len(body))},
            {"Bucket": "bucket", "Key": key},
        )
    with stubber:
        assert _read_pointer(store, "silver") == pointer
