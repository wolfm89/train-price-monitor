"""The Python runtime and the deployed storage/failure contract must agree.

The expected values are pinned here rather than in a second JSON file: this test is the
independent side of the contract, so changing ``silver-config.json`` without updating the
deployment contract fails.
"""

import json
from pathlib import Path

from tpm_analytics.silver import manifest
from tpm_analytics.silver.config import STAGES, load_config
from tpm_analytics.silver.handler import failure_message

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
    assert STAGES == ("settings", "preflight", "snapshot", "build", "publish")
    message = failure_message("build-id", RuntimeError("boom"), "settings")
    assert message["event"] == "silver_build_failed"
    assert message["stage"] == "settings"
