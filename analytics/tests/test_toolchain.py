"""The same tool must be pinned to the same version in every place that names it."""

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def test_uv_pin_is_identical_everywhere() -> None:
    pin = re.search(r'^uv\s*=\s*"([0-9.]+)"', read(".mise.toml"), re.M)
    assert pin, "no uv pin in .mise.toml"
    version = pin.group(1)

    assert f"version: '{version}'" in read(".github/workflows/ci.yaml")
    assert f"ghcr.io/astral-sh/uv:{version}" in read("analytics/Dockerfile")
    assert f"rev: '{version}'" in read(".pre-commit-config.yaml")


def test_uv_build_range_allows_the_uv_pin() -> None:
    pin = re.search(r'^uv\s*=\s*"([0-9.]+)"', read(".mise.toml"), re.M)
    assert pin
    major, minor = pin.group(1).split(".")[:2]
    build = re.search(r"uv_build>=([0-9.]+),<([0-9.]+)", read("analytics/pyproject.toml"))
    assert build, "no bounded uv_build requirement"
    assert float(f"{major}.{minor}") >= float(build.group(1).rsplit(".", 1)[0])
    assert int(minor) < int(build.group(2).split(".")[1])


def test_python_and_duckdb_pins_are_identical_everywhere() -> None:
    python = read("analytics/.python-version").strip()
    assert python == "3.15"
    assert f'requires-python = ">={python}"' in read("analytics/pyproject.toml")
    assert f"public.ecr.aws/lambda/python:{python}" in read("analytics/Dockerfile")

    duckdb = re.search(r'"duckdb==([0-9.]+)"', read("analytics/pyproject.toml"))
    assert duckdb, "no duckdb pin"
    assert duckdb.group(1) == "2.0.0"


def test_node_pin_is_identical_everywhere() -> None:
    assert read(".nvmrc").strip() == "24"
    assert re.search(r'^node\s*=\s*"24"', read(".mise.toml"), re.M)
    assert "node-version-file: '.nvmrc'" in read(".github/workflows/ci.yaml")
    for dockerfile in ("backend/Dockerfile", "scraper/Dockerfile"):
        assert "nodejs:24" in read(dockerfile)
    for dockerfile in ("backend/Dockerfile.dev", "frontend/Dockerfile.dev"):
        assert "node:24" in read(dockerfile)
