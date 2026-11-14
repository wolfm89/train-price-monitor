"""The Lambda handler: env-driven inputs, real build, local fake store."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from tpm_analytics.silver import handler as handler_module
from tpm_analytics.silver._duck import S3Secret, create_secret_sql
from tpm_analytics.silver.build import run_build
from tpm_analytics.silver.manifest import Pointer, pointer_key
from tpm_analytics.silver.storage import LocalObjectStore


def test_handler_builds_and_publishes(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, bronze_glob: str) -> None:
    bucket = tmp_path / "bucket"
    real_run_build = run_build
    seen: dict[str, Any] = {}

    def fake_run_build(source: str, target: Path, **kwargs: Any) -> object:
        # The handler passes S3 credentials and an s3:// source; the test swaps in the fixture.
        seen.update(kwargs)
        seen["source"] = source
        kwargs.pop("s3", None)
        return real_run_build(bronze_glob, target, **kwargs)

    monkeypatch.setattr(handler_module, "run_build", fake_run_build)
    monkeypatch.setattr(handler_module, "S3ObjectStore", lambda name: LocalObjectStore(bucket))
    monkeypatch.setattr(
        handler_module,
        "aws_secret",
        lambda region: S3Secret(access_key="a", secret_key="b", session_token="c", region=region),
    )
    monkeypatch.setenv("SILVER_BUCKET", "test-bucket")
    monkeypatch.setenv("SILVER_PREFIX", "silver")
    monkeypatch.setenv("TRANSFORM_VERSION", "test-sha")

    result = handler_module.handler({}, None)

    assert result["rows_in"] == 6
    assert result["rows_out"] == 6
    assert result["duplicates_removed"] == 0
    # The credentials reach the build: without this the first real run fails on read_parquet.
    assert isinstance(seen["s3"], S3Secret)
    assert seen["s3"].region == "eu-central-1"
    assert seen["source"] == "s3://test-bucket/prices/**/*.parquet"
    assert seen.get("verify", True) is True
    pointer = Pointer.from_json((bucket / pointer_key("silver")).read_bytes())
    assert pointer.build_id == result["build_id"]
    assert (bucket / pointer.manifest).is_file()


def test_handler_ignores_the_event(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, bronze_glob: str) -> None:
    """A hostile event must not be able to choose the source, the target or skip the gate."""
    seen: dict[str, object] = {}
    real_run_build = run_build

    def fake_run_build(source: str, target: Path, **kwargs: Any) -> object:
        seen["source"] = source
        seen["verify"] = kwargs.get("verify", True)
        kwargs.pop("s3", None)
        return real_run_build(bronze_glob, target, **kwargs)

    monkeypatch.setattr(handler_module, "run_build", fake_run_build)
    monkeypatch.setattr(handler_module, "S3ObjectStore", lambda name: LocalObjectStore(tmp_path / "bucket"))
    monkeypatch.setattr(
        handler_module,
        "aws_secret",
        lambda region: S3Secret(access_key="a", secret_key="b", session_token="c", region=region),
    )
    monkeypatch.setenv("SILVER_BUCKET", "test-bucket")

    handler_module.handler({"source": "s3://evil/prices/", "verify": False}, None)

    assert seen["source"] == "s3://test-bucket/prices/**/*.parquet"
    assert seen.get("verify", True) is True


def test_secret_sql_escapes_values() -> None:
    sql = create_secret_sql(S3Secret(access_key="AK'IA", secret_key="s'ecret", session_token="", region="eu-central-1"))
    assert sql.startswith("CREATE OR REPLACE SECRET silver_s3")
    assert "KEY_ID 'AK''IA'" in sql
    assert "SECRET 's''ecret'" in sql
    assert "SESSION_TOKEN" not in sql


def test_secret_sql_includes_the_session_token() -> None:
    sql = create_secret_sql(S3Secret(access_key="a", secret_key="b", session_token="token", region="eu-central-1"))
    assert "SESSION_TOKEN 'token'" in sql
