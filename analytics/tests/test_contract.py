"""The Python runtime and the deployed storage/failure contract must agree.

The expected values are pinned here rather than in a second JSON file: this test is the
independent side of the contract, so changing ``silver-config.json`` without updating the
deployment contract fails.
"""

import json
from pathlib import Path

import pytest

from tpm_analytics.silver import config as config_module
from tpm_analytics.silver import manifest
from tpm_analytics.silver.config import QUALITY_EVENT, STAGES, load_config
from tpm_analytics.silver.handler import failure_message
from tpm_analytics.silver.report import pointer_key, report_key

RUNTIME = json.loads((Path(__file__).resolve().parents[2] / "shared" / "runtime-config.json").read_text())


def test_storage_contract_is_stable() -> None:
    config = load_config()
    # The scraper writes bronze under the same prefix the silver build reads.
    assert RUNTIME["bronze_prefix"] == config.bronze_prefix
    assert (config.prefix, config.bronze_prefix, config.builds_root) == ("silver", "prices", "builds")
    assert (config.manifest_name, config.pointer_name) == ("_manifest.json", "_latest.json")
    assert (manifest.BUILD_ROOT, manifest.MANIFEST_NAME, manifest.POINTER_NAME) == (
        "builds",
        "_manifest.json",
        "_latest.json",
    )


def test_failure_contract_is_stable() -> None:
    assert STAGES == ("settings", "preflight", "snapshot", "build", "report", "publish")
    assert QUALITY_EVENT == "silver_quality_failed"
    message = failure_message("build-id", RuntimeError("boom"), "settings")
    assert message["event"] == "silver_build_failed"
    assert message["stage"] == "settings"


def test_quality_contract_and_thresholds_are_pinned() -> None:
    quality = load_config().quality
    assert quality.report_version == 1
    assert (quality.prefix, quality.pointer_name, quality.event) == (
        "quality",
        "_latest.json",
        "silver_quality_failed",
    )
    assert (quality.window_days, quality.baseline_days) == (7, 28)
    assert (
        quality.final_7d_coverage_min,
        quality.final_24h_coverage_min,
        quality.route_coverage_min,
        quality.rows_drop_pct_max,
        quality.freshness_hours_max,
        quality.fare_null_rate_max,
        quality.load_factor_null_rate_max,
    ) == (0.8, 0.6, 0.9, 0.35, 36, 0.1, 0.35)
    assert report_key("silver", quality, "x") == "silver/quality/x.json"
    assert pointer_key("silver", quality) == "silver/quality/_latest.json"


def test_expected_route_count_matches_scraper_catalog() -> None:
    stations = json.loads(
        (Path(__file__).resolve().parents[2] / "scraper" / "stations.json").read_text(encoding="utf-8")
    )
    assert set(stations) == {"t1", "t2"}
    t1, t2 = stations["t1"], stations["t2"]
    expected = len(t1) * (len(t1) - 1) + 2 * len(t1) * len(t2)
    assert load_config().quality.expected_route_count == expected


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("report_version", 0),
        ("report_version", 1.5),
        ("expected_route_count", 0),
        ("expected_route_count", 10_001),
        ("window_days", 0),
        ("window_days", 366),
        ("baseline_days", 6),
        ("baseline_days", 366),
        ("final_7d_coverage_min", 1.5),
        ("freshness_hours_max", 0),
        ("freshness_hours_max", 1_441),
        ("prefix", ""),
        ("prefix", "/quality"),
        ("event", ""),
        ("event", "silver_build_failed"),
        ("window_days", "7"),
    ],
)
def test_quality_config_rejects_bad_values(monkeypatch, tmp_path: Path, key: str, value: object) -> None:
    raw = json.loads(config_module.CONFIG_PATH.read_text(encoding="utf-8"))
    raw["quality"][key] = value
    path = tmp_path / "silver-config.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    monkeypatch.setattr(config_module, "CONFIG_PATH", path)
    load_config.cache_clear()
    try:
        with pytest.raises(ValueError, match=f"quality\\.{key}"):
            load_config()
    finally:
        load_config.cache_clear()
