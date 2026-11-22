"""Typed, validated configuration for the baseline training builder.

The JSON file lives outside the package on purpose: it is a repository input, not a Lambda asset.
Every value that changes the dataset, the model or the report is hashed into the manifest.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any

CALENDAR_SETS = ("none", "public", "public_school", "full")
LABEL_ESTIMANDS = ("next_day_fare",)
PROTOCOL_KINDS = ("backtest", "static_split")
FOLD_ROLE_ORDER = {"development": 0, "evaluation": 1, "sparse_era": 2, "forward": 3}
FOLD_ROLES = ("development", "evaluation", "sparse_era", "forward")
MODEL_NAMES = ("base_rate", "logistic", "hist_gradient_boosting", "lightgbm")
CALIBRATION_METHODS = ("sigmoid", "isotonic", "temperature")


class ConfigError(ValueError):
    """The training configuration is missing, malformed or inconsistent."""


@dataclass(frozen=True)
class SplitConfig:
    train_end: date
    validation_select_start: date
    validation_select_end: date
    validation_calibrate_start: date
    validation_calibrate_end: date
    test_start: date
    test_end: date

    def validate(self) -> None:
        if not (
            self.train_end
            < self.validation_select_start
            <= self.validation_select_end
            < self.validation_calibrate_start
            <= self.validation_calibrate_end
            < self.test_start
            <= self.test_end
        ):
            raise ConfigError("split dates must be strictly ordered and non-overlapping")
        if (
            self.train_end + timedelta(days=1) != self.validation_select_start
            or self.validation_select_end + timedelta(days=1) != self.validation_calibrate_start
            or self.validation_calibrate_end + timedelta(days=1) != self.test_start
        ):
            raise ConfigError("split windows must be contiguous so no departure silently disappears")


@dataclass(frozen=True)
class LabelConfig:
    estimand: str
    horizon_hours: int
    check_window_hours: tuple[int, int]
    min_hours_to_departure: int
    max_hours_to_departure: int
    headroom_pct: tuple[int, ...]

    def validate(self) -> None:
        if self.estimand not in LABEL_ESTIMANDS:
            raise ConfigError(f"label.estimand must be one of {LABEL_ESTIMANDS}")
        if self.horizon_hours < 1:
            raise ConfigError("label.horizon_hours must be positive")
        if self.horizon_hours != 24:
            raise ConfigError("the next-day label requires horizon_hours = 24")
        start, end = self.check_window_hours
        if not 0 < start < end:
            raise ConfigError("label.check_window_hours must be a positive, increasing pair")
        if start < self.horizon_hours - 4 or end > self.horizon_hours + 4:
            raise ConfigError("label.check_window_hours must stay within 20-28 h of the snapshot")
        if not start <= self.horizon_hours <= end:
            raise ConfigError("label.check_window_hours must contain the horizon")
        if self.min_hours_to_departure < self.horizon_hours:
            raise ConfigError("label.min_hours_to_departure must be at least the horizon")
        if self.max_hours_to_departure <= self.min_hours_to_departure:
            raise ConfigError("label.max_hours_to_departure must exceed the minimum")
        if not self.headroom_pct or any(value <= 0 for value in self.headroom_pct):
            raise ConfigError("label.headroom_pct must be a non-empty list of positive integers")
        if tuple(sorted(set(self.headroom_pct))) != self.headroom_pct:
            raise ConfigError("label.headroom_pct must be strictly increasing and unique")


@dataclass(frozen=True)
class ResampleConfig:
    outer_bin_hours: int
    outer_threshold_hours: int
    inner_bin_hours: int

    def validate(self) -> None:
        if min(self.outer_bin_hours, self.outer_threshold_hours, self.inner_bin_hours) < 1:
            raise ConfigError("resample values must be positive")
        if self.outer_threshold_hours <= self.inner_bin_hours:
            raise ConfigError("resample.outer_threshold_hours must exceed the inner bin")


@dataclass(frozen=True)
class SampleConfig:
    sample_rate: float
    max_route_days: int | None
    seed: int

    def validate(self) -> None:
        if not 0 < self.sample_rate <= 1:
            raise ConfigError("sample.sample_rate must be in (0, 1]")
        if self.max_route_days is not None and self.max_route_days < 1:
            raise ConfigError("sample.max_route_days must be positive when set")


@dataclass(frozen=True)
class CalendarConfig:
    feature_set: str

    def validate(self) -> None:
        if self.feature_set not in CALENDAR_SETS:
            raise ConfigError(f"calendar.feature_set must be one of {CALENDAR_SETS}")


@dataclass(frozen=True)
class ModelConfig:
    candidates: tuple[str, ...]
    max_iter: int
    learning_rate: float
    max_leaf_nodes: int
    random_state: int

    def validate(self) -> None:
        if not self.candidates:
            raise ConfigError("model.candidates must not be empty")
        unknown = set(self.candidates) - set(MODEL_NAMES)
        if unknown:
            raise ConfigError(f"unknown model candidates: {sorted(unknown)}")
        if self.max_iter < 1 or self.max_leaf_nodes < 2:
            raise ConfigError("model iteration and leaf counts must be positive")
        if not 0 < self.learning_rate <= 1:
            raise ConfigError("model.learning_rate must be in (0, 1]")


@dataclass(frozen=True)
class CalibrationConfig:
    methods: tuple[str, ...]
    min_positives: int
    folds: int

    def validate(self) -> None:
        if not self.methods or set(self.methods) - set(CALIBRATION_METHODS):
            raise ConfigError(f"calibration.methods must be a subset of {CALIBRATION_METHODS}")
        if self.min_positives < 1:
            raise ConfigError("calibration positive thresholds must be positive")
        if not 2 <= self.folds <= 10:
            raise ConfigError("calibration.folds must be between 2 and 10")


@dataclass(frozen=True)
class ReportConfig:
    bootstrap_replicates: int
    metric_bootstrap_replicates: int
    bootstrap_cluster: str
    threshold_precision_floor: float
    calibration_bins: int
    min_eligible_rows: int
    min_split_positives: int
    min_band_positives: int
    min_headroom_positives: int
    min_sparse_band_positives: int = 20
    r24_max_tail_hours: int = 4
    r24_max_gap_hours: int = 6

    def validate(self) -> None:
        if not 1 <= self.bootstrap_replicates <= 5000:
            raise ConfigError("report.bootstrap_replicates must be between 1 and 5000")
        if not 1 <= self.metric_bootstrap_replicates <= 2000:
            raise ConfigError("report.metric_bootstrap_replicates must be between 1 and 2000")
        if self.bootstrap_cluster not in {"departure_date", "route_day"}:
            raise ConfigError("report.bootstrap_cluster must be departure_date or route_day")
        if not 0 <= self.threshold_precision_floor <= 1:
            raise ConfigError("report.threshold_precision_floor must be in [0, 1]")
        if not 2 <= self.calibration_bins <= 50:
            raise ConfigError("report.calibration_bins must be between 2 and 50")
        if self.min_eligible_rows < 0:
            raise ConfigError("report.min_eligible_rows must be non-negative")
        if self.min_split_positives < 0:
            raise ConfigError("report.min_split_positives must be non-negative")
        if self.min_band_positives < 0:
            raise ConfigError("report.min_band_positives must be non-negative")
        if self.min_sparse_band_positives < 0:
            raise ConfigError("report.min_sparse_band_positives must be non-negative")
        if self.min_headroom_positives < 0:
            raise ConfigError("report.min_headroom_positives must be non-negative")
        if self.r24_max_tail_hours < 0 or self.r24_max_gap_hours < 0:
            raise ConfigError("report R24 thresholds must be non-negative")


@dataclass(frozen=True)
class FoldConfig:
    cutoff: date
    role: str
    name: str

    def validate(self) -> None:
        if self.role not in FOLD_ROLES:
            raise ConfigError(f"protocol fold role must be one of {FOLD_ROLES}")
        if self.cutoff.weekday() != 0:
            raise ConfigError(f"protocol cutoff {self.cutoff} is not a Monday")
        if not self.name:
            raise ConfigError("protocol fold name must not be empty")


@dataclass(frozen=True)
class ProtocolConfig:
    kind: str
    cutoffs: tuple[FoldConfig, ...]
    embargo_hours: int = 24
    block_days: int = 7
    sparse_era_max_hours_to_departure: int = 168
    forward_start: date = date(2026, 10, 1)
    forward_end: date = date(2026, 11, 12)
    forward_min_hours_to_departure: int = 24
    forward_max_hours_to_departure: int = 168
    forward_sample_rate: float = 0.05

    def validate(self) -> None:
        if self.forward_start > self.forward_end:
            raise ConfigError("protocol.forward_start must not be after forward_end")
        if self.forward_min_hours_to_departure >= self.forward_max_hours_to_departure:
            raise ConfigError("protocol forward TTD domain must be increasing")
        if not 0 < self.forward_sample_rate <= 1:
            raise ConfigError("protocol.forward.sample_rate must be in (0, 1]")
        if self.kind not in PROTOCOL_KINDS:
            raise ConfigError(f"protocol.kind must be one of {PROTOCOL_KINDS}")
        if self.embargo_hours < 0 or self.block_days < 1:
            raise ConfigError("protocol embargo and block length must be non-negative/positive")
        if self.sparse_era_max_hours_to_departure < 1:
            raise ConfigError("protocol sparse-era domain must be positive")
        if self.kind == "backtest" and not self.cutoffs:
            raise ConfigError("protocol.cutoffs must not be empty in backtest mode")
        dates = [item.cutoff for item in self.cutoffs]
        if dates != sorted(set(dates)):
            raise ConfigError("protocol.cutoffs must be sorted and unique")
        ranks = [FOLD_ROLE_ORDER[item.role] for item in self.cutoffs]
        if ranks != sorted(ranks):
            raise ConfigError("protocol.cutoffs must follow role order: development, evaluation, sparse_era, forward")
        for item in self.cutoffs:
            item.validate()
        if self.kind == "backtest" and not any(item.role == "development" for item in self.cutoffs):
            raise ConfigError("protocol.cutoffs must contain at least one development fold")


@dataclass(frozen=True)
class TrainingConfig:
    version: int
    seed: int
    source: str | None
    output_root: str
    splits: SplitConfig
    protocol: ProtocolConfig
    label: LabelConfig
    resample: ResampleConfig
    sample: SampleConfig
    calendar: CalendarConfig
    model: ModelConfig
    calibration: CalibrationConfig
    report: ReportConfig

    def validate(self) -> None:
        if self.version != 1:
            raise ConfigError(f"unsupported training config version {self.version}")
        if not self.output_root or self.output_root.startswith("/"):
            raise ConfigError("output_root must be a relative path")
        self.splits.validate()
        self.protocol.validate()
        self.label.validate()
        self.resample.validate()
        self.sample.validate()
        self.calendar.validate()
        self.model.validate()
        self.calibration.validate()
        self.report.validate()

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def hash(self) -> str:
        payload = json.dumps(self.to_dict(), sort_keys=True, default=str).encode("utf-8")
        return hashlib.sha256(payload).hexdigest()


def _date(raw: dict[str, Any], key: str) -> date:
    value = raw.get(key)
    if not isinstance(value, str):
        raise ConfigError(f"splits.{key} must be an ISO date string")
    try:
        return date.fromisoformat(value)
    except ValueError as error:
        raise ConfigError(f"splits.{key} is not a valid ISO date") from error


def _int(raw: dict[str, Any], key: str, *, minimum: int | None = None, default: int | None = None) -> int:
    if key not in raw and default is not None:
        return default
    value = raw.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ConfigError(f"{key} must be an integer")
    if minimum is not None and value < minimum:
        raise ConfigError(f"{key} must be at least {minimum}")
    return value


def _float(raw: dict[str, Any], key: str) -> float:
    value = raw.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ConfigError(f"{key} must be a number")
    return float(value)


def _str(raw: dict[str, Any], key: str) -> str:
    value = raw.get(key)
    if not isinstance(value, str):
        raise ConfigError(f"{key} must be a string")
    return value


def parse_config(raw: dict[str, Any]) -> TrainingConfig:
    try:
        splits_raw = raw["splits"]
        label_raw = raw["label"]
        resample_raw = raw["resample"]
        sample_raw = raw["sample"]
        calendar_raw = raw["calendar"]
        model_raw = raw["model"]
        calibration_raw = raw["calibration"]
        report_raw = raw["report"]
    except (KeyError, TypeError) as error:
        raise ConfigError(f"training config is missing section {error}") from error
    if not all(
        isinstance(section, dict)
        for section in (
            splits_raw,
            label_raw,
            resample_raw,
            sample_raw,
            calendar_raw,
            model_raw,
            calibration_raw,
            report_raw,
        )
    ):
        raise ConfigError("every config section must be an object")

    protocol_raw = raw.get("protocol")
    if protocol_raw is None:
        protocol_raw = {"kind": "static_split"}
    if not isinstance(protocol_raw, dict):
        raise ConfigError("protocol must be an object")
    cutoffs_raw = protocol_raw.get("cutoffs") or []
    if not isinstance(cutoffs_raw, list):
        raise ConfigError("protocol.cutoffs must be a list")
    cutoffs: list[FoldConfig] = []
    for item in cutoffs_raw:
        if not isinstance(item, dict):
            raise ConfigError("every protocol cutoff must be an object")
        cutoffs.append(
            FoldConfig(
                cutoff=_date(item, "cutoff"),
                role=_str(item, "role"),
                name=_str(item, "name"),
            )
        )
    forward_raw = protocol_raw.get("forward") or {}
    if not isinstance(forward_raw, dict):
        raise ConfigError("protocol.forward must be an object")
    protocol = ProtocolConfig(
        kind=_str(protocol_raw, "kind"),
        cutoffs=tuple(cutoffs),
        embargo_hours=_int(protocol_raw, "embargo_hours", minimum=0, default=24),
        block_days=_int(protocol_raw, "block_days", minimum=1, default=7),
        sparse_era_max_hours_to_departure=_int(
            protocol_raw, "sparse_era_max_hours_to_departure", minimum=1, default=168
        ),
        forward_start=(
            _date(forward_raw, "departure_start") if "departure_start" in forward_raw else date(2026, 10, 1)
        ),
        forward_end=(_date(forward_raw, "departure_end") if "departure_end" in forward_raw else date(2026, 11, 12)),
        forward_min_hours_to_departure=_int(forward_raw, "min_hours_to_departure", minimum=1, default=24),
        forward_max_hours_to_departure=_int(forward_raw, "max_hours_to_departure", minimum=1, default=168),
        forward_sample_rate=_float(forward_raw, "sample_rate") if "sample_rate" in forward_raw else 0.05,
    )
    check_window = label_raw.get("check_window_hours")
    if (
        not isinstance(check_window, list)
        or len(check_window) != 2
        or any(isinstance(value, bool) or not isinstance(value, int) for value in check_window)
    ):
        raise ConfigError("label.check_window_hours must be a two-integer list")
    config = TrainingConfig(
        version=_int(raw, "version", minimum=1),
        seed=_int(raw, "seed", minimum=0),
        source=None if raw.get("source") is None else _str(raw, "source"),
        output_root=_str(raw, "output_root"),
        protocol=protocol,
        splits=SplitConfig(
            train_end=_date(splits_raw, "train_end"),
            validation_select_start=_date(splits_raw, "validation_select_start"),
            validation_select_end=_date(splits_raw, "validation_select_end"),
            validation_calibrate_start=_date(splits_raw, "validation_calibrate_start"),
            validation_calibrate_end=_date(splits_raw, "validation_calibrate_end"),
            test_start=_date(splits_raw, "test_start"),
            test_end=_date(splits_raw, "test_end"),
        ),
        label=LabelConfig(
            estimand=_str(label_raw, "estimand"),
            horizon_hours=_int(label_raw, "horizon_hours", minimum=1),
            check_window_hours=(check_window[0], check_window[1]),
            min_hours_to_departure=_int(label_raw, "min_hours_to_departure", minimum=1),
            max_hours_to_departure=_int(label_raw, "max_hours_to_departure", minimum=1),
            headroom_pct=tuple(int(value) for value in label_raw.get("headroom_pct", [])),
        ),
        resample=ResampleConfig(
            outer_bin_hours=_int(resample_raw, "outer_bin_hours", minimum=1),
            outer_threshold_hours=_int(resample_raw, "outer_threshold_hours", minimum=1),
            inner_bin_hours=_int(resample_raw, "inner_bin_hours", minimum=1),
        ),
        sample=SampleConfig(
            sample_rate=_float(sample_raw, "sample_rate"),
            max_route_days=(
                None if sample_raw.get("max_route_days") is None else _int(sample_raw, "max_route_days", minimum=1)
            ),
            seed=_int(sample_raw, "seed", minimum=0),
        ),
        calendar=CalendarConfig(feature_set=_str(calendar_raw, "feature_set")),
        model=ModelConfig(
            candidates=tuple(model_raw.get("candidates", [])),
            max_iter=_int(model_raw, "max_iter", minimum=1),
            learning_rate=_float(model_raw, "learning_rate"),
            max_leaf_nodes=_int(model_raw, "max_leaf_nodes", minimum=2),
            random_state=_int(model_raw, "random_state", minimum=0),
        ),
        calibration=CalibrationConfig(
            methods=tuple(calibration_raw.get("methods", [])),
            min_positives=_int(calibration_raw, "min_positives", minimum=1),
            folds=_int(calibration_raw, "folds", minimum=2),
        ),
        report=ReportConfig(
            bootstrap_replicates=_int(report_raw, "bootstrap_replicates", minimum=1),
            metric_bootstrap_replicates=_int(report_raw, "metric_bootstrap_replicates", minimum=1, default=400),
            bootstrap_cluster=_str(report_raw, "bootstrap_cluster"),
            threshold_precision_floor=_float(report_raw, "threshold_precision_floor"),
            calibration_bins=_int(report_raw, "calibration_bins", minimum=2),
            min_eligible_rows=_int(report_raw, "min_eligible_rows", minimum=0),
            min_split_positives=_int(report_raw, "min_split_positives", minimum=0),
            min_band_positives=_int(report_raw, "min_band_positives", minimum=0),
            min_sparse_band_positives=_int(report_raw, "min_sparse_band_positives", minimum=0, default=20),
            min_headroom_positives=_int(report_raw, "min_headroom_positives", minimum=0),
            r24_max_tail_hours=_int(report_raw, "r24_max_tail_hours", minimum=0, default=4),
            r24_max_gap_hours=_int(report_raw, "r24_max_gap_hours", minimum=0, default=6),
        ),
    )
    config.validate()
    return config


def load_config(path: str | Path) -> TrainingConfig:
    config_path = Path(path)
    try:
        raw = json.loads(config_path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ConfigError(f"training config not found: {config_path}") from error
    except json.JSONDecodeError as error:
        raise ConfigError(f"training config is not valid JSON: {config_path}") from error
    if not isinstance(raw, dict):
        raise ConfigError("training config root must be an object")
    return parse_config(raw)


DEFAULT_CONFIG_PATH = Path(__file__).resolve().parents[3] / "config" / "training.json"
