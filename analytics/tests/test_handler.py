"""The Lambda handler: env-driven inputs, real build, local fake store."""

import json
from pathlib import Path
from typing import Any

import pytest

from tpm_analytics.silver import handler as handler_module
from tpm_analytics.silver._duck import S3Secret, create_secret_sql
from tpm_analytics.silver.build import EmptyCorpusError, run_build
from tpm_analytics.silver.manifest import BuildManifest, Pointer, pointer_key
from tpm_analytics.silver.storage import LocalObjectStore


def test_handler_builds_and_publishes(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, bronze_glob: str) -> None:
    bucket = tmp_path / "bucket"
    (bucket / "prices").mkdir(parents=True)
    (bucket / "prices" / "a.parquet").write_bytes(b"x")
    real_run_build = run_build
    seen: dict[str, Any] = {}

    def fake_run_build(source: str, target: Path, **kwargs: Any) -> object:
        # The handler passes S3 credentials and an s3:// source; the test swaps in the fixture.
        seen.update(kwargs)
        seen["source"] = source
        kwargs.pop("s3", None)
        return real_run_build(bronze_glob, target, **kwargs)

    monkeypatch.setattr(handler_module, "run_build", fake_run_build)
    monkeypatch.setattr(handler_module, "S3ObjectStore", lambda name, **kwargs: LocalObjectStore(bucket))
    (tmp_path / "tmp").mkdir()
    monkeypatch.setattr(handler_module.tempfile, "gettempdir", lambda: str(tmp_path / "tmp"))
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
    assert seen["source"] == ("s3://test-bucket/prices/a.parquet",)
    assert seen.get("verify", True) is True
    pointer = Pointer.from_json((bucket / pointer_key("silver")).read_bytes())
    assert pointer.build_id == result["build_id"]
    assert (bucket / pointer.manifest).is_file()
    manifest = BuildManifest.from_json((bucket / pointer.manifest).read_bytes())
    assert manifest.transform_version == "test-sha"


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
    bucket = tmp_path / "bucket"
    (bucket / "prices").mkdir(parents=True)
    (bucket / "prices" / "a.parquet").write_bytes(b"x")
    (tmp_path / "tmp").mkdir()
    monkeypatch.setattr(handler_module.tempfile, "gettempdir", lambda: str(tmp_path / "tmp"))
    monkeypatch.setattr(handler_module, "S3ObjectStore", lambda name, **kwargs: LocalObjectStore(bucket))
    monkeypatch.setattr(
        handler_module,
        "aws_secret",
        lambda region: S3Secret(access_key="a", secret_key="b", session_token="c", region=region),
    )
    monkeypatch.setenv("SILVER_BUCKET", "test-bucket")

    handler_module.handler({"source": "s3://evil/prices/", "verify": False}, None)

    assert seen["source"] == ("s3://test-bucket/prices/a.parquet",)
    assert seen.get("verify", True) is True


def test_secret_sql_escapes_values() -> None:
    sql = create_secret_sql(S3Secret(access_key="AK'IA", secret_key="s'ecret", session_token="", region="eu-central-1"))
    assert sql.startswith("CREATE OR REPLACE TEMPORARY SECRET silver_s3")
    assert "KEY_ID 'AK''IA'" in sql
    assert "SECRET 's''ecret'" in sql
    assert "SESSION_TOKEN" not in sql


def test_secret_sql_includes_the_session_token() -> None:
    sql = create_secret_sql(S3Secret(access_key="a", secret_key="b", session_token="token", region="eu-central-1"))
    assert "SESSION_TOKEN 'token'" in sql


class FakeContext:
    def __init__(self, *values: int) -> None:
        self._values = iter(values)

    def get_remaining_time_in_millis(self) -> int:
        return next(self._values)


def _prepare_handler(monkeypatch, tmp_path: Path, bronze_glob: str, *remaining: int):
    from tpm_analytics.silver import handler as handler_module
    from tpm_analytics.silver.build import run_build as real_run_build

    bucket = tmp_path / "bucket"
    (bucket / "prices").mkdir(parents=True, exist_ok=True)
    (bucket / "prices" / "a.parquet").write_bytes(b"x")
    calls = {"build": 0}

    def fake_run_build(source: str, target: Path, **kwargs: Any) -> object:
        calls["build"] += 1
        kwargs.pop("s3", None)
        return real_run_build(bronze_glob, target, **kwargs)

    monkeypatch.setattr(handler_module, "run_build", fake_run_build)
    monkeypatch.setattr(handler_module, "S3ObjectStore", lambda name, **kwargs: LocalObjectStore(bucket))
    (tmp_path / "tmp").mkdir(exist_ok=True)
    monkeypatch.setattr(handler_module.tempfile, "gettempdir", lambda: str(tmp_path / "tmp"))
    monkeypatch.setattr(
        handler_module,
        "aws_secret",
        lambda region: S3Secret(access_key="a", secret_key="b", session_token="c", region=region),
    )
    monkeypatch.setenv("SILVER_BUCKET", "test-bucket")
    return calls, bucket


def test_handler_refuses_when_too_little_time_is_left(monkeypatch, tmp_path: Path, bronze_glob: str) -> None:
    calls, _ = _prepare_handler(monkeypatch, tmp_path, bronze_glob)
    with pytest.raises(RuntimeError, match="not starting a build"):
        handler_module.handler({}, FakeContext(500_000))
    assert calls["build"] == 0


def test_handler_refuses_to_publish_on_the_last_minute(monkeypatch, tmp_path: Path, bronze_glob: str) -> None:
    calls, bucket = _prepare_handler(monkeypatch, tmp_path, bronze_glob)
    with pytest.raises(RuntimeError, match="refusing to start the upload"):
        handler_module.handler({}, FakeContext(900_000, 100_000))
    assert calls["build"] == 1
    assert not (bucket / "silver" / "_latest.json").exists()


def test_handler_warns_when_bronze_changes_during_the_build(monkeypatch, tmp_path: Path, bronze_glob: str) -> None:
    _calls, bucket = _prepare_handler(monkeypatch, tmp_path, bronze_glob)

    class DriftingStore(LocalObjectStore):
        calls = 0

        def list_keys(self, prefix: str) -> list[str]:
            DriftingStore.calls += 1
            keys = super().list_keys(prefix)
            if DriftingStore.calls == 2:
                keys = [*keys, "prices/late.parquet"]
            return keys

    monkeypatch.setattr(handler_module, "S3ObjectStore", lambda name, **kwargs: DriftingStore(bucket))
    result = handler_module.handler({}, None)
    assert any("bronze changed" in warning for warning in result["warnings"])
    manifest = Pointer.from_json((bucket / pointer_key("silver")).read_bytes())
    payload = (bucket / manifest.manifest).read_bytes()
    assert b"bronze changed" in payload


def test_sweep_only_removes_its_own_workspaces(tmp_path: Path, monkeypatch) -> None:
    (tmp_path / "silver-lambda-old").mkdir()
    (tmp_path / "silver-other").mkdir()
    monkeypatch.setattr(handler_module.tempfile, "gettempdir", lambda: str(tmp_path))

    removed = handler_module.sweep_workspace()

    assert removed == ["silver-lambda-old"]
    assert not (tmp_path / "silver-lambda-old").exists()
    assert (tmp_path / "silver-other").exists()


def test_non_parquet_objects_do_not_look_like_drift(monkeypatch, tmp_path: Path, bronze_glob: str) -> None:
    _calls, bucket = _prepare_handler(monkeypatch, tmp_path, bronze_glob)
    (bucket / "prices" / "marker.json").write_bytes(b"{}")
    result = handler_module.handler({}, None)
    assert not any("bronze changed" in warning for warning in result["warnings"])


def _empty_bucket(monkeypatch, tmp_path: Path) -> Path:
    bucket = tmp_path / "bucket"
    (bucket / "prices").mkdir(parents=True)
    (tmp_path / "tmp").mkdir()
    monkeypatch.setattr(handler_module.tempfile, "gettempdir", lambda: str(tmp_path / "tmp"))
    monkeypatch.setattr(handler_module, "S3ObjectStore", lambda name, **kwargs: LocalObjectStore(bucket))
    monkeypatch.setenv("SILVER_BUCKET", "test-bucket")
    return bucket


def _failure_payload(exc: pytest.ExceptionInfo[RuntimeError]) -> dict[str, Any]:
    return json.loads(str(exc.value))


def test_failure_raises_build_id_stage_and_error(monkeypatch, tmp_path: Path) -> None:
    _empty_bucket(monkeypatch, tmp_path)
    monkeypatch.setenv("LOG_GROUP_NAME", "/aws/lambda/analytics")
    monkeypatch.delenv("AWS_REGION", raising=False)

    with pytest.raises(RuntimeError) as exc:
        handler_module.handler({}, None)

    assert isinstance(exc.value.__cause__, EmptyCorpusError)
    payload = _failure_payload(exc)
    assert payload["event"] == "silver_build_failed"
    assert payload["build_id"]
    assert payload["stage"] == "snapshot"
    assert payload["error_type"] == "EmptyCorpusError"
    assert "no bronze objects" in payload["error"]
    assert payload["log_group"] == "/aws/lambda/analytics"
    assert payload["region"] == "eu-central-1"
    # Lambda's async error record must carry the whole structured payload.
    assert len(json.dumps(payload).encode()) < 1024


def test_failure_does_not_create_an_sns_client(monkeypatch, tmp_path: Path) -> None:
    _empty_bucket(monkeypatch, tmp_path)
    monkeypatch.setattr(
        handler_module.boto3,
        "client",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("handler must not publish SNS")),
    )

    with pytest.raises(RuntimeError):
        handler_module.handler({}, None)


def test_failure_in_build_reports_build_stage(monkeypatch, tmp_path: Path, bronze_glob: str) -> None:
    _calls, _bucket = _prepare_handler(monkeypatch, tmp_path, bronze_glob)
    monkeypatch.setattr(
        handler_module,
        "run_build",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("build broke")),
    )

    with pytest.raises(RuntimeError) as exc:
        handler_module.handler({}, None)

    assert isinstance(exc.value.__cause__, RuntimeError)
    assert _failure_payload(exc)["stage"] == "build"


def test_failure_during_publish_reports_publish_stage_and_leaves_no_pointer(
    monkeypatch, tmp_path: Path, bronze_glob: str
) -> None:
    _calls, bucket = _prepare_handler(monkeypatch, tmp_path, bronze_glob)

    class FailingStore(LocalObjectStore):
        def put_file(self, local_path: Path, key: str) -> int:
            raise OSError("s3 is down")

    monkeypatch.setattr(handler_module, "S3ObjectStore", lambda *args, **kwargs: FailingStore(bucket))

    with pytest.raises(RuntimeError) as exc:
        handler_module.handler({}, None)

    assert isinstance(exc.value.__cause__, OSError)
    assert _failure_payload(exc)["stage"] == "publish"
    assert not (bucket / pointer_key("silver")).exists()
    assert not (bucket / "silver" / "builds").exists()


def test_redact_error_hides_secret_fragments() -> None:
    text = "CREATE SECRET s (KEY_ID 'AKIA1234567890123456', SECRET 's3cr3t', SESSION_TOKEN 'tok')"
    redacted = handler_module.redact_error(text)
    assert "AKIA" not in redacted
    assert "s3cr3t" not in redacted
    assert "tok" not in redacted


def test_redact_error_hides_secret_key_fragments() -> None:
    redacted = handler_module.redact_error("credentials SECRET_KEY 'abc123' leaked")
    assert "abc123" not in redacted


def test_failure_message_uses_lambda_log_group(monkeypatch) -> None:
    monkeypatch.delenv("LOG_GROUP_NAME", raising=False)
    monkeypatch.setenv("AWS_LAMBDA_LOG_GROUP_NAME", "/aws/lambda/analytics")
    message = handler_module.failure_message("build-id", RuntimeError("boom"), "build")
    assert message["log_group"] == "/aws/lambda/analytics"


def test_failure_message_reports_unknown_stage_without_raising() -> None:
    message = handler_module.failure_message("build-id", RuntimeError("boom"), "new-stage")
    assert message["stage"] == "unknown"


def test_failure_before_settings_reports_settings_stage(monkeypatch) -> None:
    monkeypatch.delenv("SILVER_BUCKET", raising=False)

    with pytest.raises(RuntimeError) as exc:
        handler_module.handler({}, None)

    assert isinstance(exc.value.__cause__, KeyError)
    assert _failure_payload(exc)["stage"] == "settings"
