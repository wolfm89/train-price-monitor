"""Typed access to the silver build configuration.

The JSON file lives inside the package so the wheel and the Lambda image carry the same values
that ``analytics-stack.ts`` reads at synth time. Environment variables still override the Lambda
defaults at runtime; this module only removes the duplicated literals.
"""

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

CONFIG_PATH = Path(__file__).resolve().parents[1] / "data" / "silver-config.json"

_SIZE = re.compile(r"^(\d+)(MB|GB)$")


def size_mib(value: str) -> int:
    """Convert the ``8GB``/``700MB`` strings used by DuckDB to MiB."""
    match = _SIZE.fullmatch(value)
    if match is None:
        raise ValueError(f"invalid size {value!r}; expected e.g. 8GB or 700MB")
    amount, unit = int(match.group(1)), match.group(2)
    return amount * 1024 if unit == "GB" else amount


@dataclass(frozen=True)
class DuckDbConfig:
    threads: int
    memory_limit: str
    max_temp_size: str


@dataclass(frozen=True)
class LambdaConfig:
    memory_mib: int
    timeout_seconds: int
    ephemeral_mib: int
    threads: int
    duckdb_memory_limit: str
    duckdb_max_temp_size: str
    publish_reserve_seconds: int
    build_budget_seconds: int
    retry_attempts: int
    max_event_age_minutes: int


@dataclass(frozen=True)
class ScheduleConfig:
    retry_attempts: int
    max_event_age_minutes: int


@dataclass(frozen=True)
class QualityConfig:
    report_version: int
    prefix: str
    pointer_name: str
    event: str
    expected_route_count: int
    window_days: int
    baseline_days: int
    final_7d_coverage_min: float
    final_24h_coverage_min: float
    route_coverage_min: float
    rows_drop_pct_max: float
    freshness_hours_max: int
    fare_null_rate_max: float
    load_factor_null_rate_max: float


@dataclass(frozen=True)
class SilverConfig:
    prefix: str
    bronze_prefix: str
    builds_root: str
    manifest_name: str
    pointer_name: str
    failure_event: str
    stages: tuple[str, ...]
    orphan_grace_seconds: int
    min_build_age_seconds: int
    keep: int
    lambda_: LambdaConfig
    local: DuckDbConfig
    schedule: ScheduleConfig
    quality: QualityConfig


def _validate(config: SilverConfig) -> SilverConfig:
    if not config.prefix or config.prefix.startswith("/") or config.prefix.endswith("/"):
        raise ValueError("prefix must be a non-empty path without leading/trailing slashes")
    if not config.bronze_prefix or config.bronze_prefix.startswith("/") or config.bronze_prefix.endswith("/"):
        raise ValueError("bronze_prefix must be a non-empty path without leading/trailing slashes")
    if not config.builds_root or config.builds_root.startswith("/") or config.builds_root.endswith("/"):
        raise ValueError("builds_root must be a non-empty relative path without leading/trailing slashes")
    if not config.manifest_name or not config.pointer_name:
        raise ValueError("manifest_name and pointer_name must be non-empty")
    if not config.failure_event:
        raise ValueError("failure_event must be non-empty")
    if not config.stages or len(set(config.stages)) != len(config.stages):
        raise ValueError("stages must be a non-empty unique list")
    if config.orphan_grace_seconds < 1 or config.min_build_age_seconds < config.orphan_grace_seconds:
        raise ValueError("retention grace windows must be positive and ordered")
    if config.keep < 2:
        raise ValueError("keep must be at least 2 so one cycle of readers survives")

    swap = config.lambda_
    if not 512 <= swap.memory_mib <= 10_240:
        raise ValueError("Lambda memory must be between 512 and 10240 MiB")
    if not 1 <= swap.timeout_seconds <= 900:
        raise ValueError("Lambda timeout must be between 1 and 900 seconds")
    if not 512 <= swap.ephemeral_mib <= 10_240:
        raise ValueError("ephemeral storage must be between 512 and 10240 MiB")
    if size_mib(swap.duckdb_memory_limit) >= swap.memory_mib:
        raise ValueError("DuckDB memory_limit must stay below Lambda memory")
    # The measured silver output is ~3 GB; DuckDB spill plus that output must fit in /tmp.
    if size_mib(swap.duckdb_max_temp_size) + 3000 > swap.ephemeral_mib:
        raise ValueError("DuckDB max_temp_size plus ~3 GB output must fit in ephemeral storage")
    if not 0 < swap.publish_reserve_seconds < swap.build_budget_seconds < swap.timeout_seconds:
        raise ValueError("require publish_reserve < build_budget < timeout")
    if swap.build_budget_seconds + swap.publish_reserve_seconds > swap.timeout_seconds:
        raise ValueError("build_budget + publish_reserve must fit inside the timeout")
    if not 0 <= swap.retry_attempts <= 2:
        raise ValueError("Lambda retry_attempts must be between 0 and 2")
    if not 0 <= config.schedule.retry_attempts <= 185:
        raise ValueError("scheduler retry_attempts must be between 0 and 185")
    if not 1 <= config.schedule.max_event_age_minutes <= 1440:
        raise ValueError("scheduler max_event_age_minutes must be between 1 and 1440")

    quality = config.quality
    if not quality.prefix or quality.prefix.startswith("/") or quality.prefix.endswith("/"):
        raise ValueError("quality.prefix must be a non-empty path without leading/trailing slashes")
    if not quality.pointer_name or not quality.event:
        raise ValueError("quality.pointer_name and quality.event must be non-empty")
    if quality.event == config.failure_event:
        raise ValueError("quality.event must differ from failure_event")
    if not 1 <= quality.report_version <= 100:
        raise ValueError("quality.report_version must be between 1 and 100")
    if not 1 <= quality.expected_route_count <= 10_000:
        raise ValueError("quality.expected_route_count must be between 1 and 10000")
    if not 1 <= quality.window_days <= 365:
        raise ValueError("quality.window_days must be between 1 and 365")
    if not quality.window_days <= quality.baseline_days <= 365:
        raise ValueError("quality.baseline_days must be between window_days and 365")
    for name in (
        "final_7d_coverage_min",
        "final_24h_coverage_min",
        "route_coverage_min",
        "rows_drop_pct_max",
        "fare_null_rate_max",
        "load_factor_null_rate_max",
    ):
        value = getattr(quality, name)
        if not 0 <= value <= 1:
            raise ValueError(f"quality.{name} must be between 0 and 1")
    if not 1 <= quality.freshness_hours_max <= 1_440:
        raise ValueError("quality.freshness_hours_max must be between 1 and 1440")
    return config


def _quality_int(raw: dict[str, object], key: str) -> int:
    value = raw[key]
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"quality.{key} must be an integer")
    return value


def _quality_float(raw: dict[str, object], key: str) -> float:
    value = raw[key]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"quality.{key} must be a number")
    return float(value)


def _quality_str(raw: dict[str, object], key: str) -> str:
    value = raw[key]
    if not isinstance(value, str):
        raise ValueError(f"quality.{key} must be a string")
    return value


@lru_cache(maxsize=1)
def load_config() -> SilverConfig:
    raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    lambda_raw = raw["lambda"]
    local_raw = raw["local"]
    schedule_raw = raw["schedule"]
    quality_raw = raw["quality"]
    return _validate(
        SilverConfig(
            prefix=raw["prefix"],
            bronze_prefix=raw["bronze_prefix"],
            builds_root=raw["builds_root"],
            manifest_name=raw["manifest_name"],
            pointer_name=raw["pointer_name"],
            failure_event=raw["failure_event"],
            stages=tuple(raw["stages"]),
            orphan_grace_seconds=int(raw["orphan_grace_seconds"]),
            min_build_age_seconds=int(raw["min_build_age_seconds"]),
            keep=int(raw["keep"]),
            lambda_=LambdaConfig(
                memory_mib=int(lambda_raw["memory_mib"]),
                timeout_seconds=int(lambda_raw["timeout_seconds"]),
                ephemeral_mib=int(lambda_raw["ephemeral_mib"]),
                threads=int(lambda_raw["threads"]),
                duckdb_memory_limit=lambda_raw["duckdb_memory_limit"],
                duckdb_max_temp_size=lambda_raw["duckdb_max_temp_size"],
                publish_reserve_seconds=int(lambda_raw["publish_reserve_seconds"]),
                build_budget_seconds=int(lambda_raw["build_budget_seconds"]),
                retry_attempts=int(lambda_raw["retry_attempts"]),
                max_event_age_minutes=int(lambda_raw["max_event_age_minutes"]),
            ),
            local=DuckDbConfig(
                threads=int(local_raw["threads"]),
                memory_limit=local_raw["duckdb_memory_limit"],
                max_temp_size=local_raw["duckdb_max_temp_size"],
            ),
            schedule=ScheduleConfig(
                retry_attempts=int(schedule_raw["retry_attempts"]),
                max_event_age_minutes=int(schedule_raw["max_event_age_minutes"]),
            ),
            quality=QualityConfig(
                report_version=_quality_int(quality_raw, "report_version"),
                prefix=_quality_str(quality_raw, "prefix"),
                pointer_name=_quality_str(quality_raw, "pointer_name"),
                event=_quality_str(quality_raw, "event"),
                expected_route_count=_quality_int(quality_raw, "expected_route_count"),
                window_days=_quality_int(quality_raw, "window_days"),
                baseline_days=_quality_int(quality_raw, "baseline_days"),
                final_7d_coverage_min=_quality_float(quality_raw, "final_7d_coverage_min"),
                final_24h_coverage_min=_quality_float(quality_raw, "final_24h_coverage_min"),
                route_coverage_min=_quality_float(quality_raw, "route_coverage_min"),
                rows_drop_pct_max=_quality_float(quality_raw, "rows_drop_pct_max"),
                freshness_hours_max=_quality_int(quality_raw, "freshness_hours_max"),
                fare_null_rate_max=_quality_float(quality_raw, "fare_null_rate_max"),
                load_factor_null_rate_max=_quality_float(quality_raw, "load_factor_null_rate_max"),
            ),
        )
    )


_CONFIG = load_config()
FAILURE_EVENT = _CONFIG.failure_event
QUALITY_EVENT = _CONFIG.quality.event
STAGES = _CONFIG.stages
