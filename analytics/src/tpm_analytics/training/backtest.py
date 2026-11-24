"""Additive rolling-origin backtest protocol.

The dataset is built once; each fold selects rows by ``snapshot_at`` and ``label_window_end``. The
recipe is frozen on the development folds, then refitted on each evaluation fold without any
selection. Evaluation and sparse-era folds are scored only with ``--evaluate-test``.
"""

from __future__ import annotations

import hashlib
import itertools
import json
import logging
import os
import pickle
import shutil
import time
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import duckdb
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from tpm_analytics.silver._duck import sql_string
from tpm_analytics.training.bands import HEADLINE_BANDS, band_labels
from tpm_analytics.training.config import MODEL_NAMES, FoldConfig, ProtocolConfig, TrainingConfig
from tpm_analytics.training.dataset import DatasetError, _git_state
from tpm_analytics.training.features import BOOLEAN, CATEGORICAL, LABEL_COLUMNS, FeatureSpec, family_members
from tpm_analytics.training.labels import breach
from tpm_analytics.training.model import (
    CALIBRATION_EPS,
    EARLY_STOPPING_DAYS,
    EARLY_STOPPING_MAX_ITER,
    EARLY_STOPPING_PATIENCE,
    EARLY_STOPPING_TOLERANCE,
    LOGISTIC_SPLINE_KNOTS,
    WILSON_ONE_SIDED_Z,
    Array,
    FittedModel,
    ModelError,
    TabularData,
    _bootstrap,
    _bootstrap_metrics,
    _calibration_stats,
    _cell_threshold,
    _compact_category,
    _cross_fitted,
    _cross_fitted_at_headroom,
    _cross_fitted_detailed,
    _decision_metrics,
    _decision_row,
    _filled,
    _hours,
    _metrics,
    _pr_curve_points,
    _threshold,
    _ttd_array,
    concat_tabular,
    fit_calibrator,
    fit_candidate,
    fit_climatology,
    load_splits,
)
from tpm_analytics.training.protocol import (
    FoldMasks,
    assert_purged,
    fold_masks,
    fold_slices,
    scored_folds,
)
from tpm_analytics.training.selection import select_outcome, selection_settings, table_sha256

MIN_CELL_ROWS = 20
_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class ForwardScorer:
    """The fitted model, calibrator and threshold used to score the forward set."""

    model: FittedModel
    calibrator: Any
    threshold: float


@dataclass(frozen=True)
class Recipe:
    """The frozen model family, settings and calibration choice used by every fold."""

    model: str
    calibration: str
    threshold_floor: float
    model_settings: dict[str, Any]
    calibration_folds: int = 5
    calibration_min_positives: int = 1000
    threshold_min_alerts: int = 30
    selection_settings: dict[str, Any] = field(default_factory=dict)
    rule_settings: dict[str, Any] = field(default_factory=dict)
    selection_table: dict[str, Any] = field(default_factory=dict, compare=False, repr=False)

    def payload(self) -> dict[str, Any]:
        """Return the recipe as a JSON-serialisable payload.

        The selection *rule* settings are part of the hash; the fitted selection table is not.
        """
        return {
            "model": self.model,
            "calibration": self.calibration,
            "threshold_floor": self.threshold_floor,
            "model_settings": self.model_settings,
            "calibration_folds": self.calibration_folds,
            "calibration_min_positives": self.calibration_min_positives,
            "threshold_min_alerts": self.threshold_min_alerts,
            "selection_settings": self.selection_settings,
            "rule_settings": self.rule_settings,
        }

    def sha256(self) -> str:
        """Return the stable recipe content hash."""
        return hashlib.sha256(json.dumps(self.payload(), sort_keys=True).encode()).hexdigest()


@dataclass
class FoldResult:
    """The fitted state and scores for one backtest fold."""

    fold: FoldConfig
    test: TabularData
    calibrated: Array
    raw: Array
    climatology: Array
    threshold: float
    threshold_met: bool
    train_rate: float
    metrics: dict[str, float | None]
    bss_climatology: float | None
    bss_train: float | None
    probabilities: dict[int, Array]
    raw_probabilities: dict[int, Array]
    climate: dict[int, Array]
    labels: dict[int, Array]
    runtime_seconds: float = 0.0
    from_cache: bool = False
    fit_included: bool = True
    train_rows: int = 0
    calibrate_rows: int = 0
    train: TabularData | None = None
    calibrate: TabularData | None = None
    calibration_stats: dict[str, float | None] = field(default_factory=dict)
    headroom_monotonic: bool = True
    early_stopping: dict[str, Any] | None = None
    calibration_methods: tuple[dict[str, Any], ...] = ()
    isotonic_probabilities: dict[int, Array] = field(default_factory=dict)
    cell_thresholds: dict[tuple[int, str], dict[str, Any]] = field(default_factory=dict)
    model: FittedModel | None = field(default=None, repr=False, compare=False)
    calibrator: Any | None = field(default=None, repr=False, compare=False)


@dataclass
class BacktestResult:
    """The complete result of a backtest run."""

    recipe: Recipe
    folds: tuple[FoldResult, ...]
    pooled: dict[str, Any]
    per_fold: list[dict[str, Any]]
    headroom: list[dict[str, Any]]
    headroom_ttd: list[dict[str, Any]]
    sparse: list[dict[str, Any]]
    decision_value: list[dict[str, Any]]
    evaluated_blocks: tuple[str, ...]
    development_pooled: dict[str, Any] = field(default_factory=dict)
    development_headroom: list[dict[str, Any]] = field(default_factory=list)
    development_headroom_ttd: list[dict[str, Any]] = field(default_factory=list)
    calibration_cells: list[dict[str, Any]] = field(default_factory=list)
    development_calibration_cells: list[dict[str, Any]] = field(default_factory=list)
    threshold_cells: list[dict[str, Any]] = field(default_factory=list)
    development_threshold_cells: list[dict[str, Any]] = field(default_factory=list)
    pr_curves: list[dict[str, Any]] = field(default_factory=list)
    development_pr_curves: list[dict[str, Any]] = field(default_factory=list)
    threshold_hold_rate: dict[str, Any] = field(default_factory=dict)
    development_threshold_hold_rate: dict[str, Any] = field(default_factory=dict)
    development_decision_value: list[dict[str, Any]] = field(default_factory=list)
    importance: list[dict[str, Any]] = field(default_factory=list)
    warnings: tuple[str, ...] = ()
    runtime_seconds: float = 0.0
    peak_rss_kb: int = 0
    cache_dir: str | None = None
    cache_enabled: bool = False
    code_sha: str | None = None
    code_dirty: bool | None = None
    fit_code_sha: str | None = None
    recipe_from_cache: bool = False
    fold_cache_hits: int = 0
    folds_refit: int = 0
    selection: dict[str, Any] = field(default_factory=dict)


def load_panel(out_dir: Path, spec: FeatureSpec) -> TabularData:
    """Load the four split Parquets as one compact backtest panel."""
    paths = [
        out_dir / "dataset" / f"{name}.parquet"
        for name in ("train", "validation_select", "validation_calibrate", "test")
    ]
    return load_splits(paths, spec)


def load_forward(path: Path, spec: FeatureSpec) -> TabularData:
    """Load the label-free forward Parquet for prediction only."""
    columns = ", ".join(
        dict.fromkeys(
            (
                *spec.names,
                "series_key",
                "chain_id",
                "snapshot_at",
                "departure_date",
                "headroom_pct",
                "bin_regime",
                "bin_index",
            )
        )
    )
    connection = duckdb.connect()
    try:
        available = {
            row[0]
            for row in connection.execute(
                f"DESCRIBE SELECT * FROM read_parquet('{sql_string(path.as_posix())}')"
            ).fetchall()
        }
        forbidden = set(LABEL_COLUMNS) - {"eligible", "check_at", "check_lag_h"}
        if forbidden & available:
            raise ModelError(f"forward Parquet contains label columns: {sorted(forbidden & available)}")
        rows = connection.execute(
            f"SELECT {columns} FROM read_parquet('{sql_string(path.as_posix())}') "
            "ORDER BY series_key, snapshot_at, bin_regime, bin_index"
        ).fetchnumpy()
    finally:
        connection.close()
    features: dict[str, Array] = {}
    for feature in spec.features:
        values = rows[feature.name]
        if feature.kind == CATEGORICAL:
            features[feature.name] = _compact_category(values)
        elif feature.kind == BOOLEAN:
            features[feature.name] = _filled(values, 0.0)
        else:
            features[feature.name] = _filled(values, np.nan)
    count = len(rows["series_key"])
    return TabularData(
        features=features,
        y=np.zeros(count, dtype=np.int8),
        series=np.asarray(rows["series_key"], dtype=str),
        route_day=np.asarray(rows["series_key"], dtype=str),
        price=np.zeros(count, dtype=np.float64),
        check_price=np.zeros(count, dtype=np.float64),
        future_max=np.zeros(count, dtype=np.float64),
        future_observations=np.zeros(count, dtype=np.int16),
        headroom=np.asarray(rows["headroom_pct"], dtype=np.int16),
        departure_date=np.asarray(rows["departure_date"], dtype=str),
        snapshot_at=np.asarray(rows["snapshot_at"], dtype=str),
        observation_era=np.full(count, "forward", dtype=object),
        observation_week=np.full(count, "forward", dtype=object),
        chain=np.asarray(rows["chain_id"], dtype=str),
    )


def fit_forward_scorer(
    recipe: Recipe,
    train: TabularData,
    calibrate: TabularData,
    config: TrainingConfig,
    spec: FeatureSpec,
) -> ForwardScorer:
    """Fit the forward model, calibrator and threshold on the forward fold."""
    model_config = replace(config.model, **recipe.model_settings)
    calibration_config = replace(
        config.calibration,
        folds=recipe.calibration_folds,
        min_positives=recipe.calibration_min_positives,
    )
    fold_config = replace(config, model=model_config, calibration=calibration_config)
    model = fit_candidate(recipe.model, train, spec, fold_config)
    hours_cal = _hours(calibrate)
    raw_cal = model.predict(calibrate)
    oof = _cross_fitted(
        raw_cal,
        calibrate.y,
        calibrate.departure_date,
        recipe.calibration,
        fold_config,
        hours=hours_cal,
        headroom=calibrate.headroom,
    )
    calibrator = fit_calibrator(
        raw_cal,
        calibrate.y,
        recipe.calibration,
        min_positives=recipe.calibration_min_positives,
        hours=hours_cal,
        headroom=calibrate.headroom,
    )
    threshold, _ = _threshold(calibrate.y, oof, recipe.threshold_floor)
    return ForwardScorer(
        model=model,
        calibrator=calibrator,
        threshold=threshold,
    )


def score_forward(forward: TabularData, scorer: ForwardScorer) -> Array:
    """Return the calibrated forward probability at each row's assigned headroom."""
    return scorer.calibrator.predict(
        scorer.model.predict(forward),
        hours=_hours(forward),
        headroom=forward.headroom,
    )


def forward_fold(protocol: ProtocolConfig) -> FoldConfig:
    """Return the configured forward refit fold."""
    for fold in protocol.cutoffs:
        if fold.role == "forward":
            return fold
    raise ModelError("the protocol has no forward fold")


def fit_forward_fold(
    panel: TabularData,
    config: TrainingConfig,
    recipe: Recipe,
    spec: FeatureSpec,
) -> tuple[ForwardScorer, FoldConfig]:
    """Slice the forward fold and fit its scorer."""
    fold = forward_fold(config.protocol)
    masks = fold_masks(panel, fold, config.protocol)
    assert_purged(panel, fold, config.protocol, masks)
    train = panel.subset(masks.train)
    calibrate = panel.subset(masks.calibrate)
    for name, block in (("train", train), ("calibrate", calibrate)):
        if len(block) < config.report.min_eligible_rows:
            raise DatasetError(f"{fold.name} {name}: {len(block)} rows; floor is {config.report.min_eligible_rows}")
        if int(np.sum(block.y)) < config.report.min_split_positives:
            raise DatasetError(
                f"{fold.name} {name}: {int(np.sum(block.y))} positives; floor is {config.report.min_split_positives}"
            )
    scorer = fit_forward_scorer(recipe, train, calibrate, config, spec)
    return scorer, fold


def score_forward_artifact(
    out_dir: Path,
    panel: TabularData,
    config: TrainingConfig,
    recipe: Recipe,
    spec: FeatureSpec,
    forward_path: Path,
) -> dict[str, Any]:
    """Score the unscored forward Parquet; write predictions and a no-label smoke report."""
    scorer, fold = fit_forward_fold(panel, config, recipe, spec)
    forward = load_forward(forward_path, spec)
    probabilities = score_forward(forward, scorer)
    if not np.all(np.isfinite(probabilities)):
        raise ModelError("forward scoring produced non-finite probabilities")
    predictions_path = out_dir / "forward_predictions.parquet"
    input_copy = out_dir / "forward_input.parquet"
    shutil.copy2(forward_path, input_copy)
    snapshot_text = (
        _text(forward.snapshot_at)
        if np.issubdtype(forward.snapshot_at.dtype, np.datetime64)
        else _snapshot_strings(forward.snapshot_at)
    )
    departure_text = (
        _dates(forward.departure_date)
        if np.issubdtype(forward.departure_date.dtype, np.datetime64)
        else np.asarray(forward.departure_date, dtype=str).tolist()
    )
    table = pa.table(
        {
            "fold": [fold.name] * len(forward),
            "series_key": np.asarray(forward.series, dtype=str),
            "chain_id": np.asarray(forward.chain if forward.chain is not None else forward.series, dtype=str),
            "snapshot_at": snapshot_text,
            "departure_date": departure_text,
            "headroom_pct": forward.headroom.astype(np.int16),
            "score": probabilities,
            "threshold": np.full(len(forward), scorer.threshold, dtype=np.float64),
        }
    )
    pq.write_table(table, predictions_path, compression="zstd")
    sibling = forward_path.parent / "forward_manifest.json"
    if not sibling.is_file():
        raise ModelError(f"forward manifest is missing: {sibling}")
    manifest_payload = json.loads(sibling.read_text(encoding="utf-8"))
    expected_spec = hashlib.sha256(json.dumps(list(spec.names)).encode("utf-8")).hexdigest()
    if manifest_payload.get("feature_spec_sha256") != expected_spec:
        raise ModelError("forward Parquet was built with a different feature specification")
    missingness = manifest_payload.get("feature_missingness", {})
    smoke = {
        "fold": fold.name,
        "forward_input": str(forward_path),
        "forward_sha256": _file_sha256(forward_path),
        "forward_manifest_sha256": (hashlib.sha256(sibling.read_bytes()).hexdigest() if sibling.is_file() else None),
        "forward_artifact_sha256": manifest_payload.get("artifact_sha256"),
        "forward_sample_rate": manifest_payload.get("forward_sample_rate"),
        "forward_coverage": manifest_payload.get("coverage"),
        "forward_departure_bounds": manifest_payload.get("departure_bounds"),
        "forward_missing_departure_dates": manifest_payload.get("missing_departure_dates"),
        "feature_missingness": missingness,
        "rows": len(forward),
        "min_score": float(probabilities.min()),
        "max_score": float(probabilities.max()),
        "finite": bool(np.all(np.isfinite(probabilities))),
        "threshold": scorer.threshold,
        "recipe_sha256": recipe.sha256(),
        "labels": False,
        "metrics": False,
    }
    (out_dir / "forward_smoke.json").write_text(json.dumps(smoke, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return smoke


def _model_settings(config: TrainingConfig) -> dict[str, Any]:
    """Return the frozen estimator settings from the config."""
    return {
        "max_iter": config.model.max_iter,
        "learning_rate": config.model.learning_rate,
        "max_leaf_nodes": config.model.max_leaf_nodes,
        "random_state": config.model.random_state,
    }


def _fold_slices(
    panel: TabularData, fold: FoldConfig, config: TrainingConfig
) -> tuple[FoldMasks, TabularData, TabularData, TabularData]:
    """Return the purged train, calibration and test blocks for a fold."""
    masks = fold_masks(panel, fold, config.protocol)
    assert_purged(panel, fold, config.protocol, masks)
    train, calibrate, test = fold_slices(panel, masks)
    return masks, train, calibrate, test


def _fold_metrics(
    test: TabularData, calibrated: Array, climatology: Array, train_rate: float
) -> dict[str, float | None]:
    """Compute metrics for one fitted fold."""
    metrics = _metrics(test.y, calibrated)
    reference = float(np.mean((test.y - climatology) ** 2))
    metrics["bss_climatology"] = 1.0 - float(metrics["brier"] or 0.0) / reference if reference > 0 else None
    reference_train = float(np.mean((test.y - train_rate) ** 2))
    metrics["bss_train"] = 1.0 - float(metrics["brier"] or 0.0) / reference_train if reference_train > 0 else None
    return metrics


def select_recipe_bundle(
    panel: TabularData, config: TrainingConfig, spec: FeatureSpec
) -> tuple[Recipe, dict[str, FittedModel], dict[str, Any]]:
    """Choose model family and calibration method on the development folds only."""
    outcome = select_outcome(panel, config, spec)
    recipe = Recipe(
        model=outcome.model,
        calibration=outcome.calibration,
        threshold_floor=config.report.threshold_precision_floor,
        model_settings=_model_settings(config),
        calibration_folds=config.calibration.folds,
        calibration_min_positives=config.calibration.min_positives,
        threshold_min_alerts=config.report.threshold_min_alerts,
        selection_settings=selection_settings(outcome.table),
        rule_settings={
            "early_stopping": {
                "days": EARLY_STOPPING_DAYS,
                "max_iter": EARLY_STOPPING_MAX_ITER,
                "patience": EARLY_STOPPING_PATIENCE,
                "tolerance": EARLY_STOPPING_TOLERANCE,
            },
            "logistic_spline_knots": LOGISTIC_SPLINE_KNOTS,
            "calibration_epsilon": CALIBRATION_EPS,
            "wilson_z": WILSON_ONE_SIDED_Z,
        },
        selection_table=outcome.table,
    )
    return recipe, outcome.models, outcome.table


def select_recipe(panel: TabularData, config: TrainingConfig, spec: FeatureSpec) -> Recipe:
    """Select and return recipe."""
    return select_recipe_bundle(panel, config, spec)[0]


def _check_fold_gates(
    fold: FoldConfig,
    train: TabularData,
    calibrate: TabularData,
    test: TabularData,
    config: TrainingConfig,
) -> None:
    """Raise when a fold block is below its row, positive or band floor."""
    for name, block in (("train", train), ("calibrate", calibrate), ("test", test)):
        if len(block) < config.report.min_eligible_rows:
            raise DatasetError(f"{fold.name} {name}: {len(block)} rows; floor is {config.report.min_eligible_rows}")
        positives = int(np.sum(block.y))
        if positives < config.report.min_split_positives:
            raise DatasetError(
                f"{fold.name} {name}: {positives} positives; floor is {config.report.min_split_positives}"
            )
    band_floor = (
        config.report.min_sparse_band_positives if fold.role == "sparse_era" else config.report.min_band_positives
    )
    expected = {
        label
        for label, low, _ in HEADLINE_BANDS
        if fold.role != "sparse_era" or low < config.protocol.sparse_era_max_hours_to_departure
    }
    for name, block in (("calibrate", calibrate), ("test", test)):
        bands = _ttd_array(block)
        present = set(bands.tolist())
        if band_floor > 0:
            missing = expected - present
            if missing:
                raise DatasetError(f"{fold.name} {name}: missing TTD bands {sorted(missing)}")
        for band in sorted(present):
            positives = int(np.sum(block.y[bands == band]))
            if positives < band_floor:
                raise DatasetError(f"{fold.name} {name} band {band}: {positives} positives; floor is {band_floor}")


def fit_fold(
    recipe: Recipe,
    fold: FoldConfig,
    train: TabularData,
    calibrate: TabularData,
    test: TabularData,
    config: TrainingConfig,
    spec: FeatureSpec,
    *,
    fitted_model: FittedModel | None = None,
) -> FoldResult:
    """Fit one fold with the frozen recipe and return its scores and metrics."""
    started = time.perf_counter()
    _check_fold_gates(fold, train, calibrate, test, config)
    # The recipe, not the live config, supplies the model family and settings. A later config
    # change cannot silently re-tune an evaluation fold.
    model_config = replace(config.model, **recipe.model_settings)
    calibration_config = replace(
        config.calibration,
        folds=recipe.calibration_folds,
        min_positives=recipe.calibration_min_positives,
    )
    fold_config = replace(config, model=model_config, calibration=calibration_config)
    model = fitted_model or fit_candidate(recipe.model, train, spec, fold_config)
    climatology = fit_climatology(train)
    cal_matrix = model.transform(calibrate)
    test_matrix = model.transform(test)
    hours_cal = _hours(calibrate)
    hours_test = _hours(test)
    raw_cal = model.predict_matrix(cal_matrix)
    oof_cal, _, calibration_methods = _cross_fitted_detailed(
        raw_cal,
        calibrate.y,
        calibrate.departure_date,
        recipe.calibration,
        fold_config,
        hours=hours_cal,
        headroom=calibrate.headroom,
    )
    calibrator = fit_calibrator(
        raw_cal,
        calibrate.y,
        recipe.calibration,
        min_positives=recipe.calibration_min_positives,
        hours=hours_cal,
        headroom=calibrate.headroom,
    )
    threshold, threshold_met = _threshold(calibrate.y, oof_cal, recipe.threshold_floor)
    raw = model.predict_matrix(test_matrix)
    calibrated = calibrator.predict(raw, hours=hours_test, headroom=test.headroom)
    climate = climatology.predict(test)
    train_rate = float(np.mean(train.y))
    metrics = _fold_metrics(test, calibrated, climate, train_rate)
    metrics["threshold"] = threshold
    metrics["threshold_met"] = float(threshold_met)
    metrics["alert_share"] = float(np.mean(calibrated >= threshold))
    metrics.update(_decision_metrics(test.y, calibrated, threshold))
    probabilities: dict[int, Array] = {}
    raw_probabilities: dict[int, Array] = {}
    climate_by_headroom: dict[int, Array] = {}
    labels: dict[int, Array] = {}
    isotonic_probabilities: dict[int, Array] = {}
    cell_thresholds: dict[tuple[int, str], dict[str, Any]] = {}
    headroom_methods: list[dict[str, Any]] = []
    bands_cal = _ttd_array(calibrate)
    for headroom in config.label.headroom_pct:
        raw_cal_headroom = model.predict_matrix(model.with_headroom(cal_matrix, headroom))
        y_cal = breach(calibrate.price_cents, calibrate.check_price_cents, headroom)
        raw_headroom = model.predict_matrix(model.with_headroom(test_matrix, headroom))
        oof_headroom, methods = _cross_fitted_at_headroom(
            raw_cal,
            calibrate.y,
            calibrate.departure_date,
            raw_cal_headroom,
            recipe.calibration,
            fold_config,
            hours=hours_cal,
            fit_headroom=calibrate.headroom,
            predict_headroom=np.full(len(calibrate), headroom, dtype=np.int16),
        )
        headroom_methods.extend({**item, "headroom_pct": headroom} for item in methods)
        for band in band_labels():
            mask = bands_cal == band
            if int(mask.sum()) == 0:
                continue
            cell_thresholds[(headroom, band)] = {
                "headroom_pct": headroom,
                "ttd_band": band,
                **_cell_threshold(
                    y_cal[mask],
                    oof_headroom[mask],
                    recipe.threshold_floor,
                    recipe.threshold_min_alerts,
                ),
            }
        raw_probabilities[headroom] = raw_headroom
        # The report tables use the selected calibrator at this headroom; the old per-headroom
        # isotonic stays as a diagnostic column only.
        probabilities[headroom] = calibrator.predict(
            raw_headroom,
            hours=hours_test,
            headroom=np.full(len(test), headroom, dtype=np.int16),
        )
        diagnostic = fit_calibrator(
            raw_cal_headroom,
            y_cal,
            "isotonic",
            min_positives=0,
        )
        isotonic_probabilities[headroom] = diagnostic.predict(raw_headroom)
        climate_by_headroom[headroom] = climatology.predict(test, headroom=headroom)
        labels[headroom] = breach(test.price_cents, test.check_price_cents, headroom)
    ordered = [probabilities[headroom] for headroom in config.label.headroom_pct]
    headroom_monotonic = bool(all(np.all(left >= right) for left, right in itertools.pairwise(ordered)))
    calibration_stats = _calibration_stats(test.y, calibrated, config.report.calibration_bins)
    bands_test = _ttd_array(test)
    thresholds = np.full(len(test), np.nan, dtype=np.float64)
    for (headroom, band), entry in cell_thresholds.items():
        mask = (test.headroom == headroom) & (bands_test == band)
        if entry["qualified"]:
            thresholds[mask] = float(entry["threshold"])
    cell_alert = np.isfinite(thresholds) & (calibrated >= thresholds)
    cell_true = int(np.sum(cell_alert & (test.y == 1)))
    cell_alerts = int(cell_alert.sum())
    cell_positives = int(np.sum(test.y))
    metrics["cell_threshold_alerts"] = cell_alerts
    metrics["cell_threshold_precision"] = cell_true / cell_alerts if cell_alerts else None
    metrics["cell_threshold_recall"] = cell_true / cell_positives if cell_positives else None
    return FoldResult(
        fold=fold,
        train_rows=len(train),
        calibrate_rows=len(calibrate),
        test=test,
        calibrated=calibrated,
        raw=raw,
        climatology=climate,
        threshold=threshold,
        threshold_met=threshold_met,
        train_rate=train_rate,
        metrics=metrics,
        bss_climatology=metrics.get("bss_climatology"),
        bss_train=metrics.get("bss_train"),
        probabilities=probabilities,
        raw_probabilities=raw_probabilities,
        climate=climate_by_headroom,
        labels=labels,
        runtime_seconds=time.perf_counter() - started,
        fit_included=fitted_model is None,
        calibration_stats=calibration_stats,
        headroom_monotonic=headroom_monotonic,
        early_stopping=model.early_stopping,
        calibration_methods=(
            *calibration_methods,
            *headroom_methods,
            {
                "fold": "applied",
                "requested": calibrator.requested,
                "fitted": calibrator.method,
                "fallback": calibrator.fallback,
                "fallback_reason": calibrator.fallback_reason,
            },
        ),
        isotonic_probabilities=isotonic_probabilities,
        cell_thresholds=cell_thresholds,
        model=model,
        calibrator=calibrator,
    )


def _bss_paired_ci(
    labels: Array,
    model: Array,
    climatology: Array,
    groups: Array,
    replicates: int,
    seed: int,
) -> list[float]:
    """Return the paired cluster-bootstrap interval for BSS against climatology."""
    unique, inverse = np.unique(groups, return_inverse=True)
    if len(unique) < 2:
        return []
    model_brier = (np.clip(model, 1e-9, 1.0 - 1e-9) - labels) ** 2
    clim_brier = (np.clip(climatology, 1e-9, 1.0 - 1e-9) - labels) ** 2
    model_sums = np.bincount(inverse, weights=model_brier, minlength=len(unique))
    clim_sums = np.bincount(inverse, weights=clim_brier, minlength=len(unique))
    counts = np.bincount(inverse, minlength=len(unique))
    rng = np.random.default_rng(seed)
    values: list[float] = []
    for _ in range(replicates):
        sampled = rng.integers(0, len(unique), size=len(unique))
        total = counts[sampled].sum()
        model_b = model_sums[sampled].sum() / total
        clim_b = clim_sums[sampled].sum() / total
        if clim_b <= 0:
            continue
        # Paired cluster bootstrap of the same quantity shown in the BSS-climatology
        # column: 1 - model Brier / climatology Brier.
        values.append(1.0 - model_b / clim_b)
    if not values:
        return []
    return [float(np.percentile(values, 2.5)), float(np.percentile(values, 97.5))]


def _band_seed(seed: int, headroom: int, band: str) -> int:
    """Return a deterministic seed for a headroom and TTD band."""
    return seed + headroom * 1000 + sum((index + 1) * ord(char) for index, char in enumerate(band))


def _headroom_rows(
    pooled: TabularData, folds: tuple[FoldResult, ...], config: TrainingConfig
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Compute per-headroom and headroom by TTD metrics."""
    bands = _ttd_array(pooled)
    groups = pooled.departure_date
    headroom_rows: list[dict[str, Any]] = []
    headroom_ttd: list[dict[str, Any]] = []
    for headroom in config.label.headroom_pct:
        labels = np.concatenate([fold.labels[headroom] for fold in folds])
        probabilities = np.concatenate([fold.probabilities[headroom] for fold in folds])
        climatology = np.concatenate([fold.climate[headroom] for fold in folds])
        item: dict[str, Any] = _metrics(labels, probabilities)
        reference = float(np.mean((labels - climatology) ** 2))
        item["bss_climatology"] = 1.0 - float(item["brier"] or 0.0) / reference if reference > 0 else None
        isotonic = np.concatenate([fold.isotonic_probabilities[headroom] for fold in folds])
        item["brier_isotonic"] = _metrics(labels, isotonic)["brier"]
        item["headroom_pct"] = headroom
        item["bss_ci"] = _bss_paired_ci(
            labels,
            probabilities,
            climatology,
            groups,
            config.report.metric_bootstrap_replicates,
            config.seed + headroom,
        )
        headroom_rows.append(item)
        order = {label: index for index, (label, _, _) in enumerate(HEADLINE_BANDS)}
        for band in sorted(set(bands.tolist()), key=lambda value: order.get(value, len(order))):
            mask = bands == band
            if int(mask.sum()) < MIN_CELL_ROWS:
                continue
            cell: dict[str, Any] = _metrics(labels[mask], probabilities[mask])
            reference = float(np.mean((labels[mask] - climatology[mask]) ** 2))
            cell["bss_climatology"] = 1.0 - float(cell["brier"] or 0.0) / reference if reference > 0 else None
            cell["bss_ci"] = _bss_paired_ci(
                labels[mask],
                probabilities[mask],
                climatology[mask],
                groups[mask],
                config.report.metric_bootstrap_replicates,
                _band_seed(config.seed, headroom, band),
            )
            cell["headroom_pct"] = headroom
            cell["ttd_band"] = band
            headroom_ttd.append(cell)
    return headroom_rows, headroom_ttd


def _calibration_cells(folds: tuple[FoldResult, ...], config: TrainingConfig) -> list[dict[str, Any]]:
    """Calibration slope, intercept and ECE per headroom x TTD band x era."""
    if not folds:
        return []
    pooled = concat_tabular([item.test for item in folds])
    bands = _ttd_array(pooled)
    eras = np.asarray(pooled.observation_era, dtype=str)
    rows: list[dict[str, Any]] = []
    for headroom in config.label.headroom_pct:
        labels = np.concatenate([item.labels[headroom] for item in folds])
        probabilities = np.concatenate([item.probabilities[headroom] for item in folds])
        for band in band_labels():
            for era in sorted(set(eras.tolist())):
                mask = (bands == band) & (eras == era)
                if int(mask.sum()) < MIN_CELL_ROWS:
                    continue
                stats = _calibration_stats(labels[mask], probabilities[mask], config.report.calibration_bins)
                rows.append(
                    {
                        "headroom_pct": headroom,
                        "ttd_band": band,
                        "era": era,
                        "rows": int(mask.sum()),
                        "prevalence": float(np.mean(labels[mask])),
                        "slope": stats["slope"],
                        "intercept": stats["intercept"],
                        "ece": stats["ece"],
                    }
                )
    return rows


def _threshold_cells(
    folds: tuple[FoldResult, ...],
    config: TrainingConfig,
    *,
    floor: float,
    min_alerts: int,
) -> list[dict[str, Any]]:
    """Pool per-fold cell thresholds into one row per headroom x TTD band."""
    rows: list[dict[str, Any]] = []
    if not folds:
        return rows
    for headroom in config.label.headroom_pct:
        for band in band_labels():
            calibration_alerts = 0
            calibration_true = 0.0
            calibration_positives = 0
            calibration_true_positives = 0.0
            qualifying_folds = 0
            thresholds: list[float] = []
            total_alerts = 0
            true_positives = 0
            positives = 0
            test_rows = 0
            for fold in folds:
                entry = fold.cell_thresholds.get((headroom, band))
                if entry is not None:
                    calibration_positives += int(entry["positives"])
                    if entry["qualified"]:
                        qualifying_folds += 1
                        calibration_alerts += int(entry["alerts"])
                        calibration_true += float(entry["precision"]) * int(entry["alerts"])
                        calibration_true_positives += float(entry["recall"]) * int(entry["positives"])
                        if entry["threshold"] is not None:
                            thresholds.append(float(entry["threshold"]))
                bands = _ttd_array(fold.test)
                mask = bands == band
                if int(mask.sum()) == 0:
                    continue
                test_rows += int(mask.sum())
                labels = fold.labels[headroom][mask]
                positives += int(np.sum(labels))
                if entry is None or not entry["qualified"]:
                    continue
                alert = fold.probabilities[headroom][mask] >= float(entry["threshold"])
                total_alerts += int(alert.sum())
                true_positives += int(np.sum(alert & (labels == 1)))
            precision = true_positives / total_alerts if total_alerts else None
            recall = true_positives / positives if positives else None
            calibration_precision = calibration_true / calibration_alerts if calibration_alerts else None
            calibration_recall = calibration_true_positives / calibration_positives if calibration_positives else None
            rows.append(
                {
                    "headroom_pct": headroom,
                    "ttd_band": band,
                    "qualifying_folds": qualifying_folds,
                    "folds": len(folds),
                    "thresholds": sorted(thresholds),
                    "calibration_alerts": calibration_alerts,
                    "calibration_precision": calibration_precision,
                    "calibration_recall": calibration_recall,
                    "test_rows": test_rows,
                    "test_alerts": total_alerts,
                    "test_precision": precision,
                    "test_recall": recall,
                    "test_positives": positives,
                    "floor_met": bool(precision is not None and precision >= floor and total_alerts >= min_alerts),
                    "operating_point": qualifying_folds > 0,
                }
            )
    return rows


def _threshold_hold_rate(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Summarise how many cells with an operating point held the floor on test."""
    with_point = [row for row in rows if row["operating_point"]]
    met = [row for row in with_point if row["floor_met"]]
    substantive = [row for row in with_point if row["test_alerts"] >= 100 and (row["test_recall"] or 0.0) >= 0.05]
    substantive_met = [row for row in substantive if row["floor_met"]]
    return {
        "cells": len(rows),
        "with_operating_point": len(with_point),
        "test_floor_met": len(met),
        "hold_rate": (len(met) / len(with_point)) if with_point else None,
        "substantive_cells": len(substantive),
        "substantive_test_floor_met": len(substantive_met),
        "substantive_hold_rate": (len(substantive_met) / len(substantive)) if substantive else None,
    }


def _pooled_cell_metrics(folds: tuple[FoldResult, ...], config: TrainingConfig) -> dict[str, Any]:
    """Pooled precision and recall using each row's own fold and cell threshold."""
    alerts = 0
    true_positives = 0
    positives = 0
    rows = 0
    for fold in folds:
        bands = _ttd_array(fold.test)
        thresholds = np.full(len(fold.test), np.nan, dtype=np.float64)
        for (headroom, band), entry in fold.cell_thresholds.items():
            if entry is None or not entry["qualified"]:
                continue
            mask = (fold.test.headroom == headroom) & (bands == band)
            thresholds[mask] = float(entry["threshold"])
        valid = np.isfinite(thresholds)
        probabilities = np.zeros(len(fold.test), dtype=np.float64)
        for headroom in config.label.headroom_pct:
            mask = fold.test.headroom == headroom
            probabilities[mask] = fold.probabilities[headroom][mask]
        alert = valid & (probabilities >= thresholds)
        alerts += int(alert.sum())
        true_positives += int(np.sum(alert & (fold.test.y == 1)))
        positives += int(np.sum(fold.test.y))
        rows += len(fold.test)
    return {
        "cell_threshold_rows": rows,
        "cell_threshold_alerts": alerts,
        "cell_threshold_precision": (true_positives / alerts) if alerts else None,
        "cell_threshold_recall": (true_positives / positives) if positives else None,
    }


def _pr_curves(folds: tuple[FoldResult, ...]) -> list[dict[str, Any]]:
    """Precision at fixed recall targets per TTD band for the pooled rows."""
    if not folds:
        return []
    pooled = concat_tabular([item.test for item in folds])
    probabilities = np.concatenate([item.calibrated for item in folds])
    bands = _ttd_array(pooled)
    targets = (0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9)
    curves: list[dict[str, Any]] = []
    for band in band_labels():
        mask = bands == band
        if int(mask.sum()) < MIN_CELL_ROWS:
            continue
        curves.append(
            {
                "band": band,
                "rows": int(mask.sum()),
                "average_precision": _metrics(pooled.y[mask], probabilities[mask])["average_precision"],
                "points": _pr_curve_points(pooled.y[mask], probabilities[mask], targets),
            }
        )
    return curves


def _decision_value_cells(
    folds: tuple[FoldResult, ...],
    config: TrainingConfig,
    *,
    replicates: int,
    seed: int,
) -> list[dict[str, Any]]:
    """Decision value per headroom x TTD band on the next-day check."""
    rows: list[dict[str, Any]] = []
    if not folds:
        return rows
    for headroom in config.label.headroom_pct:
        for band in band_labels():
            prices: list[Array] = []
            savings: list[Array] = []
            alerts: list[Array] = []
            labels: list[Array] = []
            groups: list[Array] = []
            operating = False
            for fold in folds:
                bands = _ttd_array(fold.test)
                check = np.asarray(fold.test.check_price, dtype=np.float64)
                price = np.asarray(fold.test.price, dtype=np.float64)
                mask = (bands == band) & np.isfinite(check) & np.isfinite(price) & (price > 0)
                if not mask.any():
                    continue
                entry = fold.cell_thresholds.get((headroom, band))
                qualified = bool(entry is not None and entry["qualified"])
                operating = operating or qualified
                if qualified:
                    alert = fold.probabilities[headroom][mask] >= float(entry["threshold"])
                else:
                    alert = np.zeros(int(mask.sum()), dtype=bool)
                prices.append(price[mask])
                savings.append(check[mask] - price[mask])
                alerts.append(alert)
                labels.append(fold.labels[headroom][mask])
                groups.append(fold.test.departure_date[mask])
            if not prices:
                continue
            row = _decision_row(
                band=band,
                headroom_pct=headroom,
                price=np.concatenate(prices),
                saving=np.concatenate(savings),
                alert=np.concatenate(alerts),
                groups=np.concatenate(groups),
                replicates=replicates,
                seed=seed + headroom * 1000 + sum((index + 1) * ord(char) for index, char in enumerate(band)),
                labels=np.concatenate(labels),
            )
            row["operating_point"] = operating
            rows.append(row)
    return rows


def _row_log_loss(y: Array, probabilities: Array) -> Array:
    """Return the clipped per-row log loss."""
    clipped = np.clip(probabilities, 1e-6, 1.0 - 1e-6)
    return -(y * np.log(clipped) + (1.0 - y) * np.log(1.0 - clipped))


def _permuted_features(features: dict[str, Array], names: tuple[str, ...], order: Array) -> dict[str, Array]:
    """Return the named columns permuted by one shared row order."""
    return {name: np.asarray(features[name])[order] for name in names}


def _importance_losses(
    samples: list[tuple[FoldResult, Array, Array]],
    overrides: dict[str, Array] | None,
) -> Array:
    """Per-row log loss for the sampled rows, optionally with permuted feature columns."""
    losses = np.empty(sum(len(local) for _, _, local in samples), dtype=np.float64)
    for fold, positions, local in samples:
        model = fold.model
        calibrator = fold.calibrator
        if model is None or calibrator is None:
            raise ModelError("permutation importance needs a fitted model and calibrator")
        data = fold.test.subset(local)
        if overrides:
            data = replace(
                data,
                features={**data.features, **{name: values[positions] for name, values in overrides.items()}},
            )
        probabilities = model.predict(data)
        heads = data.headroom
        if overrides is not None and "headroom_pct" in overrides:
            # The permuted headroom must reach the calibrator too, not only the model matrix.
            heads = np.rint(np.asarray(data.features["headroom_pct"], dtype=np.float64)).astype(np.int16)
        calibrated = calibrator.predict(
            probabilities,
            hours=_hours(data),
            headroom=heads,
        )
        losses[positions] = _row_log_loss(data.y, calibrated)
    return losses


def _grouped_importance(
    folds: tuple[FoldResult, ...],
    spec: FeatureSpec,
    *,
    sample: int = 20_000,
    repeats: int = 5,
    seed: int = 0,
) -> list[dict[str, Any]]:
    """Grouped permutation importance on the pooled development test blocks."""
    if not folds or any(fold.model is None or fold.calibrator is None for fold in folds):
        return []
    pooled = concat_tabular([fold.test for fold in folds])
    rng = np.random.default_rng(seed)
    departure = np.asarray(pooled.departure_date, dtype=str)
    dates = np.unique(departure)
    per_date = max(1, sample // len(dates))
    selected_parts: list[Array] = []
    for value in dates:
        indices = np.flatnonzero(departure == value)
        if len(indices) > per_date:
            indices = np.sort(rng.choice(indices, size=per_date, replace=False))
        selected_parts.append(indices)
    selected = np.concatenate(selected_parts)
    if len(selected) == 0:
        return []
    samples: list[tuple[FoldResult, Array, Array]] = []
    start = 0
    for fold in folds:
        end = start + len(fold.test)
        positions = np.flatnonzero((selected >= start) & (selected < end))
        samples.append((fold, positions, selected[positions] - start))
        start = end
    pooled_sample = pooled.subset(selected)
    baseline = _importance_losses(samples, None)
    selected_departure = np.asarray(pooled_sample.departure_date, dtype=str)
    date_values, date_inverse = np.unique(selected_departure, return_inverse=True)
    date_counts = np.bincount(date_inverse, minlength=len(date_values))
    families = {
        family: tuple(name for name in names if name in spec.names) for family, names in family_members().items()
    }
    entries: list[tuple[str, str, tuple[str, ...]]] = [
        ("family", family, names) for family, names in families.items() if names
    ]
    entries.extend(("feature", name, (name,)) for name in spec.names)
    rows: list[dict[str, Any]] = []
    for kind, name, names in entries:
        deltas: list[float] = []
        date_means: list[Array] = []
        for _ in range(repeats):
            order = rng.permutation(len(selected))
            overrides = _permuted_features(pooled_sample.features, names, order)
            delta = _importance_losses(samples, overrides) - baseline
            deltas.append(float(delta.mean()))
            date_means.append(np.bincount(date_inverse, weights=delta, minlength=len(date_values)) / date_counts)
        values = np.asarray(deltas, dtype=np.float64)
        mean_by_date = np.mean(np.column_stack(date_means), axis=1)
        rows.append(
            {
                "kind": kind,
                "name": name,
                "features": list(names),
                "delta_log_loss": float(values.mean()),
                "std": float(values.std()),
                "min": float(values.min()),
                "max": float(values.max()),
                "date_std": float(np.std(mean_by_date)),
                "date_min": float(np.min(mean_by_date)),
                "date_max": float(np.max(mean_by_date)),
                "repeats": int(repeats),
                "rows": len(selected),
                "departures": len(date_values),
            }
        )
    return sorted(rows, key=lambda row: (row["kind"], -row["delta_log_loss"]))


def _code_identity() -> tuple[str | None, bool | None]:
    """Return the current git SHA and dirty flag."""
    try:
        sha, dirty, _ = _git_state()
    except Exception:
        return None, None
    return sha, dirty


def _fit_code_hash() -> str:
    """Hash the fit-relevant source files for cache identity."""
    root = Path(__file__).resolve().parents[1]
    excluded = {"cli.py", "report.py", "__init__.py"}
    files = sorted(path for path in (root / "training").glob("*.py") if path.name not in excluded)
    files.extend((root / "calendar.py", root / "silver" / "_duck.py", root.parent.parent / "uv.lock"))
    digest = hashlib.sha256()
    for path in files:
        if path.is_file():
            digest.update(path.relative_to(root.parent.parent).as_posix().encode("utf-8"))
            digest.update(path.read_bytes())
    return digest.hexdigest()


def _recipe_cache_path(cache_dir: Path) -> Path:
    """Recipe cache path."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir / "recipe.json"


def _load_cached_recipe(
    cache_dir: Path | None,
    config: TrainingConfig,
    dataset_sha256: str | None,
    code_sha: str | None,
    code_dirty: bool | None,
    fit_code_sha: str,
) -> Recipe | None:
    """Load and return cached recipe."""
    if cache_dir is None:
        return None
    path = _recipe_cache_path(cache_dir)
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except OSError, ValueError, TypeError, KeyError, AttributeError:
        return None
    if not isinstance(payload, dict) or payload.get("config_sha256") != config.hash():
        return None
    if payload.get("model") not in MODEL_NAMES:
        return None
    if dataset_sha256 is None or payload.get("dataset_sha256") != dataset_sha256:
        return None
    if code_sha is None or code_dirty is not False:
        return None
    if payload.get("fit_code_sha") != fit_code_sha:
        return None
    try:
        return Recipe(
            model=payload["model"],
            calibration=payload["calibration"],
            threshold_floor=float(payload["threshold_floor"]),
            model_settings=payload["model_settings"],
            calibration_folds=int(payload.get("calibration_folds", config.calibration.folds)),
            calibration_min_positives=int(payload.get("calibration_min_positives", config.calibration.min_positives)),
            threshold_min_alerts=int(payload.get("threshold_min_alerts", config.report.threshold_min_alerts)),
            selection_settings=payload.get("selection_settings") or {},
            rule_settings=payload.get("rule_settings") or {},
            selection_table=payload.get("selection") or {},
        )
    except KeyError, TypeError, ValueError:
        return None


def _save_cached_recipe(
    cache_dir: Path | None,
    config: TrainingConfig,
    recipe: Recipe,
    dataset_sha256: str | None,
    code_sha: str | None,
    fit_code_sha: str,
    selection_table: dict[str, Any],
) -> None:
    """Persist the cached recipe and its fitted selection table."""
    if cache_dir is None:
        return
    payload = {
        **recipe.payload(),
        "config_sha256": config.hash(),
        "dataset_sha256": dataset_sha256,
        "code_sha": code_sha,
        "fit_code_sha": fit_code_sha,
        "selection": selection_table,
    }
    path = _recipe_cache_path(cache_dir)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _cache_paths(cache_dir: Path, fold: FoldConfig) -> tuple[Path, Path]:
    """Return the fold checkpoint paths."""
    folder = cache_dir / "folds"
    folder.mkdir(parents=True, exist_ok=True)
    return folder / f"{fold.name}.pkl", folder / f"{fold.name}.json"


def _load_cached_fold(
    cache_dir: Path | None,
    fold: FoldConfig,
    recipe: Recipe,
    config: TrainingConfig,
    dataset_sha256: str | None,
    code_sha: str | None,
    code_dirty: bool | None,
    fit_code_sha: str,
) -> FoldResult | None:
    """Load and return cached fold."""
    if cache_dir is None:
        return None
    data_path, meta_path = _cache_paths(cache_dir, fold)
    if not data_path.is_file() or not meta_path.is_file():
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except OSError, ValueError, TypeError:
        return None
    if meta.get("recipe_sha256") != recipe.sha256() or meta.get("config_sha256") != config.hash():
        return None
    if dataset_sha256 is None or meta.get("dataset_sha256") != dataset_sha256:
        return None
    if code_sha is None or code_dirty is not False:
        return None
    if meta.get("fit_code_sha") != fit_code_sha:
        return None
    expected = meta.get("pkl_sha256")
    if expected is None or hashlib.sha256(data_path.read_bytes()).hexdigest() != expected:
        return None
    try:
        with data_path.open("rb") as handle:
            loaded = pickle.load(handle)
    except (
        OSError,
        EOFError,
        pickle.UnpicklingError,
        ValueError,
        AttributeError,
        ImportError,
        TypeError,
        KeyError,
    ):
        return None
    # Older checkpoints stored the full train/calibrate panels; drop them from the report state.
    return replace(loaded, train=None, calibrate=None, from_cache=True)


def _save_cached_fold(
    cache_dir: Path | None,
    fold: FoldConfig,
    recipe: Recipe,
    config: TrainingConfig,
    result: FoldResult,
    dataset_sha256: str | None,
    code_sha: str | None,
    fit_code_sha: str,
) -> None:
    """Persist cached fold."""
    if cache_dir is None:
        return
    data_path, meta_path = _cache_paths(cache_dir, fold)
    tmp_path = data_path.with_suffix(".tmp")
    with tmp_path.open("wb") as handle:
        pickle.dump(result, handle)
    os.replace(tmp_path, data_path)
    pkl_sha256 = hashlib.sha256(data_path.read_bytes()).hexdigest()
    meta_tmp = meta_path.with_suffix(".tmp")
    meta_tmp.write_text(
        json.dumps(
            {
                "fold": fold.name,
                "recipe_sha256": recipe.sha256(),
                "config_sha256": config.hash(),
                "dataset_sha256": dataset_sha256,
                "code_sha": code_sha,
                "fit_code_sha": fit_code_sha,
                "pkl_sha256": pkl_sha256,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    os.replace(meta_tmp, meta_path)


def _pooled_summary(
    folds: tuple[FoldResult, ...], config: TrainingConfig
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    """Compute pooled metrics and headroom tables for a set of folds."""
    pooled = concat_tabular([item.test for item in folds])
    calibrated = np.concatenate([item.calibrated for item in folds])
    climatology = np.concatenate([item.climatology for item in folds])
    train_rate = np.concatenate([np.full(len(item.test), item.train_rate, dtype=np.float64) for item in folds])
    metrics: dict[str, Any] = _metrics(pooled.y, calibrated)
    reference = float(np.mean((pooled.y - climatology) ** 2))
    metrics["bss_climatology"] = 1.0 - float(metrics["brier"] or 0.0) / reference if reference > 0 else None
    reference_train = float(np.mean((pooled.y - train_rate) ** 2))
    metrics["bss_train"] = 1.0 - float(metrics["brier"] or 0.0) / reference_train if reference_train > 0 else None
    metrics["bootstrap_clusters"] = len(np.unique(pooled.departure_date))
    metrics["bootstrap"] = _bootstrap(
        pooled.y, calibrated, pooled.departure_date, config.report.bootstrap_replicates, config.seed
    )
    cell_thresholds: list[Array] = []
    for item in folds:
        bands = _ttd_array(item.test)
        thresholds = np.full(len(item.test), np.inf, dtype=np.float64)
        for (headroom, band), entry in item.cell_thresholds.items():
            if entry is not None and entry["qualified"]:
                mask = (item.test.headroom == headroom) & (bands == band)
                thresholds[mask] = float(entry["threshold"])
        cell_thresholds.append(thresholds)
    metrics["intervals"] = _bootstrap_metrics(
        pooled.y,
        calibrated,
        pooled.departure_date,
        config.report.metric_bootstrap_replicates,
        config.seed + 1,
        np.concatenate(cell_thresholds),
    )
    headroom, headroom_ttd = _headroom_rows(pooled, folds, config)
    metrics.update(_pooled_cell_metrics(folds, config))
    return metrics, headroom, headroom_ttd


def run_backtest(
    panel: TabularData,
    config: TrainingConfig,
    spec: FeatureSpec,
    *,
    evaluate_test: bool,
    cache_dir: Path | None = None,
    dataset_sha256: str | None = None,
) -> BacktestResult:
    """Run the rolling-origin backtest and return its result."""
    started = time.perf_counter()
    if config.report.bootstrap_cluster != "departure_date":
        raise ModelError("backtest bootstrap_cluster must be departure_date")
    code_sha, code_dirty = _code_identity()
    fit_code_sha = _fit_code_hash()
    cache_enabled = (
        cache_dir is not None and dataset_sha256 is not None and code_sha is not None and code_dirty is False
    )
    active_cache = cache_dir if cache_enabled else None
    folds = scored_folds(config.protocol, evaluate_test=evaluate_test)
    if not folds:
        raise ModelError("no scored folds")
    for fold in folds:
        _, train, calibrate, test = _fold_slices(panel, fold, config)
        _check_fold_gates(fold, train, calibrate, test, config)
    cached_recipe = _load_cached_recipe(active_cache, config, dataset_sha256, code_sha, code_dirty, fit_code_sha)
    recipe_from_cache = cached_recipe is not None
    selection_table: dict[str, Any] = {}
    if cached_recipe is not None:
        _LOGGER.info("backtest: using cached recipe %s / %s", cached_recipe.model, cached_recipe.calibration)
        recipe = cached_recipe
        selection_table = recipe.selection_table
        development_models: dict[str, FittedModel] = {}
    else:
        _LOGGER.info("backtest: selecting recipe on development folds")
        recipe, development_models, selection_table = select_recipe_bundle(panel, config, spec)
        _save_cached_recipe(active_cache, config, recipe, dataset_sha256, code_sha, fit_code_sha, selection_table)
        _LOGGER.info("backtest: recipe %s / %s", recipe.model, recipe.calibration)
    results: list[FoldResult] = []
    for fold in folds:
        cached = _load_cached_fold(
            active_cache, fold, recipe, config, dataset_sha256, code_sha, code_dirty, fit_code_sha
        )
        if cached is not None:
            _LOGGER.info("backtest: using cached %s", fold.name)
            results.append(cached)
            continue
        _LOGGER.info("backtest: fitting %s (%s)", fold.name, fold.role)
        _, train, calibrate, test = _fold_slices(panel, fold, config)
        result = fit_fold(
            recipe,
            fold,
            train,
            calibrate,
            test,
            config,
            spec,
            fitted_model=development_models.get(fold.name),
        )
        _save_cached_fold(active_cache, fold, recipe, config, result, dataset_sha256, code_sha, fit_code_sha)
        results.append(result)
        _LOGGER.info("backtest: finished %s", fold.name)
    development = tuple(item for item in results if item.fold.role == "development")
    evaluation = tuple(item for item in results if item.fold.role == "evaluation")
    if not development:
        raise ModelError("the backtest produced no development result")
    per_fold = [
        {
            "fold": item.fold.name,
            "role": item.fold.role,
            "cutoff": item.fold.cutoff.isoformat(),
            "train_rows": item.train_rows,
            "calibrate_rows": item.calibrate_rows,
            "rows": len(item.test),
            "positive_rate": item.metrics.get("positive_rate"),
            "brier": item.metrics.get("brier"),
            "bss": item.metrics.get("bss"),
            "bss_climatology": item.bss_climatology,
            "bss_train": item.bss_train,
            "roc_auc": item.metrics.get("roc_auc"),
            "average_precision": item.metrics.get("average_precision"),
            "threshold": item.threshold,
            "threshold_met": item.threshold_met,
            "alert_share": item.metrics.get("alert_share"),
            "precision_at_threshold": item.metrics.get("precision_at_threshold"),
            "recall_at_threshold": item.metrics.get("recall_at_threshold"),
            "cell_threshold_alerts": item.metrics.get("cell_threshold_alerts"),
            "cell_threshold_precision": item.metrics.get("cell_threshold_precision"),
            "cell_threshold_recall": item.metrics.get("cell_threshold_recall"),
            "headroom_monotonic": item.headroom_monotonic,
            "calibration_stats": item.calibration_stats,
            "early_stopping": item.early_stopping,
            "dropped_features": list(item.model.dropped) if item.model is not None else [],
            "calibration_methods": [dict(item) for item in item.calibration_methods],
            "cell_thresholds": [
                dict(row) for _, row in sorted(item.cell_thresholds.items(), key=lambda pair: (pair[0][0], pair[0][1]))
            ],
            "runtime_seconds": item.runtime_seconds,
            "from_cache": item.from_cache,
            "fit_included": item.fit_included,
        }
        for item in results
    ]
    warnings: list[str] = []
    if cache_dir is not None and not cache_enabled:
        warnings.append("fold cache disabled: the working tree is dirty or the git state is unknown")
    if not evaluation:
        warnings.append("evaluation folds were not scored; pass --evaluate-test to score them")
    pooled_metrics: dict[str, Any] = {}
    headroom_rows: list[dict[str, Any]] = []
    headroom_ttd: list[dict[str, Any]] = []
    decision_value: list[dict[str, Any]] = []
    if evaluation:
        pooled_metrics, headroom_rows, headroom_ttd = _pooled_summary(evaluation, config)
        decision_value = _decision_value_cells(
            evaluation,
            config,
            replicates=config.report.metric_bootstrap_replicates,
            seed=config.seed + 2,
        )
    development_results = tuple(item for item in results if item.fold.role == "development")
    development_decision_value = _decision_value_cells(
        development_results,
        config,
        replicates=config.report.metric_bootstrap_replicates,
        seed=config.seed + 3,
    )
    development_pooled: dict[str, Any] = {}
    development_headroom: list[dict[str, Any]] = []
    development_headroom_ttd: list[dict[str, Any]] = []
    if development_results:
        development_pooled, development_headroom, development_headroom_ttd = _pooled_summary(
            development_results, config
        )
    threshold_cells = _threshold_cells(
        evaluation,
        config,
        floor=recipe.threshold_floor,
        min_alerts=recipe.threshold_min_alerts,
    )
    development_threshold_cells = _threshold_cells(
        development_results,
        config,
        floor=recipe.threshold_floor,
        min_alerts=recipe.threshold_min_alerts,
    )
    importance = _grouped_importance(
        development_results,
        spec,
        seed=config.seed + 4,
    )
    return BacktestResult(
        recipe=recipe,
        folds=tuple(results),
        pooled=pooled_metrics,
        per_fold=per_fold,
        headroom=headroom_rows,
        headroom_ttd=headroom_ttd,
        sparse=[row for row in per_fold if row["role"] == "sparse_era"],
        development_pooled=development_pooled,
        development_headroom=development_headroom,
        development_headroom_ttd=development_headroom_ttd,
        calibration_cells=_calibration_cells(evaluation, config),
        development_calibration_cells=_calibration_cells(development_results, config),
        threshold_cells=threshold_cells,
        development_threshold_cells=development_threshold_cells,
        pr_curves=_pr_curves(evaluation),
        development_pr_curves=_pr_curves(development_results),
        threshold_hold_rate=_threshold_hold_rate(threshold_cells),
        development_threshold_hold_rate=_threshold_hold_rate(development_threshold_cells),
        decision_value=decision_value,
        development_decision_value=development_decision_value,
        importance=importance,
        evaluated_blocks=tuple(item.fold.name for item in results),
        warnings=tuple(warnings),
        runtime_seconds=time.perf_counter() - started,
        peak_rss_kb=0,
        cache_dir=None if cache_dir is None else str(cache_dir),
        cache_enabled=cache_enabled,
        code_sha=code_sha,
        code_dirty=code_dirty,
        fit_code_sha=fit_code_sha,
        recipe_from_cache=recipe_from_cache,
        fold_cache_hits=sum(1 for item in results if item.from_cache),
        folds_refit=sum(1 for item in results if not item.from_cache),
        selection=selection_table,
    )


def _fmt(value: Any, digits: int = 4) -> str:
    """Format a report value."""
    if value is None:
        return "—"
    if isinstance(value, float):
        return f"{value:.{digits}f}"
    return str(value)


def _p(value: Any) -> str:
    """Format a probability as a percentage."""
    return "—" if value is None else f"{float(value):.1%}"


def _yes(value: Any) -> str:
    """Format a boolean as yes or no."""
    return "—" if value is None else ("yes" if float(value) >= 1.0 else "no")


def _table(headers: list[str], rows: list[list[Any]]) -> str:
    """Render a Markdown table from headers and rows."""
    if any(len(row) != len(headers) for row in rows):
        raise ValueError("backtest table row width does not match the header width")
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    lines.extend("| " + " | ".join(_fmt(cell) for cell in row) + " |" for row in rows)
    return "\n".join(lines)


def _file_sha256(path: Path) -> str:
    """Return the SHA-256 of a file, read in chunks."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _text(values: Array) -> list[str]:
    """Convert compact text or datetime values to report strings."""
    if values.dtype.kind == "S":
        return [value.decode("utf-8") for value in values]
    if values.dtype.kind == "U":
        return values.tolist()
    if np.issubdtype(values.dtype, np.datetime64):
        text = np.datetime_as_string(values, unit="ms").astype(str)
        cleaned: list[str] = []
        for item in text:
            value = item.replace("T", " ")
            base, _, fraction = value.partition(".")
            fraction = fraction.rstrip("0")
            cleaned.append(f"{base}.{fraction}" if fraction else base)
        return cleaned
    return values.tolist()


def _snapshot_strings(values: Array) -> list[str]:
    """Normalise snapshot timestamps to the dataset string format."""
    cleaned: list[str] = []
    for value in values:
        item = str(value).replace("T", " ")
        base, _, fraction = item.partition(".")
        fraction = fraction.rstrip("0")
        cleaned.append(f"{base}.{fraction}" if fraction else base)
    return cleaned


def _dates(values: Array) -> list[str]:
    """Convert date values to ISO date strings."""
    if np.issubdtype(values.dtype, np.datetime64):
        return np.datetime_as_string(values, unit="D").astype(str).tolist()
    return values.astype(str).tolist()


def _write_predictions(path: Path, result: BacktestResult) -> None:
    """Stream one row group per fold/headroom so the pooled table never lives in Python lists."""
    schema = pa.schema(
        [
            ("fold", pa.string()),
            ("role", pa.string()),
            ("series_key", pa.string()),
            ("chain_id", pa.string()),
            ("snapshot_at", pa.timestamp("ms")),
            ("departure_date", pa.date32()),
            ("ttd_band", pa.string()),
            ("assigned_headroom", pa.int16()),
            ("headroom_pct", pa.int16()),
            ("raw_score", pa.float64()),
            ("calibrated_score", pa.float64()),
            ("calibrated_score_pooled", pa.float64()),
            ("label", pa.int8()),
            ("fold_threshold", pa.float64()),
        ]
    )
    with pq.ParquetWriter(path, schema, compression="zstd") as writer:
        for item in result.folds:
            bands = _ttd_array(item.test)
            chain = item.test.chain if item.test.chain is not None else item.test.series
            count = len(item.test)
            order = np.lexsort((item.test.snapshot_at, item.test.series))
            series = item.test.series[order]
            snapshot = item.test.snapshot_at[order]
            departure = item.test.departure_date[order]
            assigned = item.test.headroom[order].astype(np.int16)
            series_text = _text(series)
            chain_text = _text(chain[order])
            band_text = bands[order].tolist()
            for headroom in sorted(item.probabilities):
                writer.write_table(
                    pa.table(
                        {
                            "fold": [item.fold.name] * count,
                            "role": [item.fold.role] * count,
                            "series_key": series_text,
                            "chain_id": chain_text,
                            "snapshot_at": snapshot,
                            "departure_date": departure,
                            "ttd_band": band_text,
                            "assigned_headroom": assigned,
                            "headroom_pct": np.full(count, headroom, dtype=np.int16),
                            "raw_score": item.raw_probabilities[headroom][order],
                            "calibrated_score": item.probabilities[headroom][order],
                            "calibrated_score_pooled": item.calibrated[order],
                            "label": item.labels[headroom][order].astype(np.int8),
                            "fold_threshold": np.full(count, item.threshold, dtype=np.float64),
                        },
                        schema=schema,
                    )
                )


def _report(result: BacktestResult, config: TrainingConfig, dataset_manifest: dict[str, Any]) -> str:
    """Render the backtest report as Markdown."""
    sparse = [row for row in result.per_fold if row["role"] == "sparse_era"]
    fold_rows = [
        [
            row["fold"],
            row["role"],
            row["cutoff"],
            row.get("train_rows", "—"),
            row.get("calibrate_rows", "—"),
            row["rows"],
            _p(row.get("positive_rate")),
            _fmt(row.get("brier")),
            _fmt(row.get("bss")),
            _fmt(row.get("bss_climatology")),
            _fmt(row.get("roc_auc")),
            _fmt(row.get("average_precision")),
            _fmt(row.get("threshold")),
            _yes(row.get("threshold_met")),
            _fmt(row.get("precision_at_threshold")),
            _fmt(row.get("recall_at_threshold")),
            _p(row.get("alert_share")),
            _fmt(row.get("runtime_seconds"), 1),
        ]
        for row in result.per_fold
    ]
    pooled = result.pooled
    if pooled:
        pooled_table = _table(
            ["metric", "value"],
            [
                ["rows", sum(row["rows"] for row in result.per_fold if row["role"] == "evaluation")],
                ["Brier", _fmt(pooled.get("brier"))],
                ["log loss", _fmt(pooled.get("log_loss"))],
                ["BSS (base rate)", _fmt(pooled.get("bss"))],
                ["BSS climatology", _fmt(pooled.get("bss_climatology"))],
                ["BSS train", _fmt(pooled.get("bss_train"))],
                ["ROC-AUC", _fmt(pooled.get("roc_auc"))],
                ["Average Precision (AP)", _fmt(pooled.get("average_precision"))],
                ["cell-threshold precision", _fmt(pooled.get("cell_threshold_precision"))],
                ["cell-threshold recall", _fmt(pooled.get("cell_threshold_recall"))],
                ["prevalence", _p(pooled.get("positive_rate"))],
            ],
        )
    else:
        pooled_table = "Evaluation folds were not scored."
    headroom_table = (
        _table(
            [
                "headroom %",
                "prevalence",
                "Brier",
                "Brier isotonic",
                "log loss",
                "BSS",
                "BSS clim",
                "BSS clim CI",
                "AUC",
                "AP",
            ],
            [
                [
                    item["headroom_pct"],
                    _p(item.get("positive_rate")),
                    _fmt(item.get("brier")),
                    _fmt(item.get("brier_isotonic")),
                    _fmt(item.get("log_loss")),
                    _fmt(item.get("bss")),
                    _fmt(item.get("bss_climatology")),
                    _ci(item.get("bss_ci")),
                    _fmt(item.get("roc_auc")),
                    _fmt(item.get("average_precision")),
                ]
                for item in result.headroom
            ],
        )
        if result.headroom
        else "Evaluation folds were not scored."
    )
    headroom_ttd_table = (
        _table(
            [
                "TTD band",
                "headroom %",
                "prevalence",
                "Brier",
                "log loss",
                "BSS",
                "BSS clim",
                "BSS clim CI",
                "AUC",
                "AP",
            ],
            [
                [
                    item["ttd_band"],
                    item["headroom_pct"],
                    _p(item.get("positive_rate")),
                    _fmt(item.get("brier")),
                    _fmt(item.get("log_loss")),
                    _fmt(item.get("bss")),
                    _fmt(item.get("bss_climatology")),
                    _ci(item.get("bss_ci")),
                    _fmt(item.get("roc_auc")),
                    _fmt(item.get("average_precision")),
                ]
                for item in result.headroom_ttd
            ],
        )
        if result.headroom_ttd
        else "Evaluation folds were not scored."
    )
    evaluation_eras = sorted({str(row["era"]) for row in result.calibration_cells})
    development_eras = sorted({str(row["era"]) for row in result.development_calibration_cells})
    if not evaluation_eras:
        era_note = "Evaluation calibration cells were not scored."
    elif evaluation_eras == ["dense"] and development_eras == ["dense"]:
        era_note = (
            "The evaluation folds are all dense; the era dimension is shown for completeness. The "
            "development cells are dense as well, and the sparse-era folds are not pooled into "
            "these tables."
        )
    else:
        era_note = (
            f"Evaluation eras present: {', '.join(evaluation_eras)}; development eras: "
            f"{', '.join(development_eras) or 'none'}. The sparse-era folds are not pooled into "
            "these tables."
        )
    calibration_cells_table = (
        _table(
            ["headroom %", "TTD band", "era", "rows", "prevalence", "slope", "intercept", "ECE"],
            [
                [
                    item["headroom_pct"],
                    item["ttd_band"],
                    item["era"],
                    item["rows"],
                    _p(item.get("prevalence")),
                    _fmt(item.get("slope")),
                    _fmt(item.get("intercept")),
                    _fmt(item.get("ece")),
                ]
                for item in result.calibration_cells
            ],
        )
        if result.calibration_cells
        else "Evaluation folds were not scored."
    )
    development_threshold_table = (
        _table(
            [
                "headroom %",
                "TTD band",
                "operating point",
                "threshold",
                "folds",
                "cal alerts",
                "cal precision",
                "cal recall",
                "test rows",
                "test alerts",
                "test precision",
                "test recall",
                "floor met",
            ],
            [
                [
                    item["headroom_pct"],
                    item["ttd_band"],
                    _yes(item.get("operating_point")),
                    _value_range(item.get("thresholds")),
                    f"{item['qualifying_folds']}/{item['folds']}",
                    item["calibration_alerts"],
                    _fmt(item.get("calibration_precision")),
                    _fmt(item.get("calibration_recall")),
                    item["test_rows"],
                    item["test_alerts"],
                    _fmt(item.get("test_precision")),
                    _fmt(item.get("test_recall")),
                    _yes(item.get("floor_met")),
                ]
                for item in result.development_threshold_cells
            ],
        )
        if result.development_threshold_cells
        else "Development folds were not scored."
    )
    threshold_table = (
        _table(
            [
                "headroom %",
                "TTD band",
                "operating point",
                "threshold",
                "folds",
                "cal alerts",
                "cal precision",
                "cal recall",
                "test rows",
                "test alerts",
                "test precision",
                "test recall",
                "floor met",
            ],
            [
                [
                    item["headroom_pct"],
                    item["ttd_band"],
                    _yes(item.get("operating_point")),
                    _value_range(item.get("thresholds")),
                    f"{item['qualifying_folds']}/{item['folds']}",
                    item["calibration_alerts"],
                    _fmt(item.get("calibration_precision")),
                    _fmt(item.get("calibration_recall")),
                    item["test_rows"],
                    item["test_alerts"],
                    _fmt(item.get("test_precision")),
                    _fmt(item.get("test_recall")),
                    _yes(item.get("floor_met")),
                ]
                for item in result.threshold_cells
            ],
        )
        if result.threshold_cells
        else "Evaluation folds were not scored."
    )
    family_importance = [row for row in result.importance if row["kind"] == "family"]
    feature_importance = [row for row in result.importance if row["kind"] == "feature"]
    importance_table = (
        _table(
            ["group", "features", "delta log loss", "std", "min", "max", "date std", "rows", "departures"],
            [
                [
                    row["name"],
                    len(row["features"]),
                    _fmt(row["delta_log_loss"], 5),
                    _fmt(row["std"], 5),
                    _fmt(row["min"], 5),
                    _fmt(row["max"], 5),
                    _fmt(row.get("date_std"), 5),
                    row["rows"],
                    row["departures"],
                ]
                for row in family_importance
            ],
        )
        if family_importance
        else "Development folds were not scored."
    )
    feature_importance_table = (
        _table(
            ["feature", "delta log loss", "std", "min", "max", "date std", "departures"],
            [
                [
                    row["name"],
                    _fmt(row["delta_log_loss"], 5),
                    _fmt(row["std"], 5),
                    _fmt(row["min"], 5),
                    _fmt(row["max"], 5),
                    _fmt(row.get("date_std"), 5),
                    row["departures"],
                ]
                for row in feature_importance[:15]
            ],
        )
        if feature_importance
        else "Development folds were not scored."
    )
    pr_targets = (0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9)

    def _pr_rows(items: list[dict[str, Any]]) -> list[list[Any]]:
        """Render precision at fixed recall targets."""
        return [
            [
                item["band"],
                item["rows"],
                _fmt(item.get("average_precision")),
                *[
                    _fmt(
                        next(
                            (point["precision"] for point in item["points"] if abs(point["recall"] - target) < 1e-9),
                            None,
                        )
                    )
                    for target in pr_targets
                ],
            ]
            for item in items
        ]

    development_pr_table = (
        _table(
            ["TTD band", "rows", "AP", *[f"P@R{int(target * 100)}" for target in pr_targets]],
            _pr_rows(result.development_pr_curves),
        )
        if result.development_pr_curves
        else "Development folds were not scored."
    )
    pr_table = (
        _table(
            ["TTD band", "rows", "AP", *[f"P@R{int(target * 100)}" for target in pr_targets]],
            [
                [
                    item["band"],
                    item["rows"],
                    _fmt(item.get("average_precision")),
                    *[
                        _fmt(
                            next(
                                (
                                    point["precision"]
                                    for point in item["points"]
                                    if abs(point["recall"] - target) < 1e-9
                                ),
                                None,
                            )
                        )
                        for target in pr_targets
                    ],
                ]
                for item in result.pr_curves
            ],
        )
        if result.pr_curves
        else "Evaluation folds were not scored."
    )
    hold_rate = result.threshold_hold_rate or {}
    development_hold_rate = result.development_threshold_hold_rate or {}
    hold_note = (
        f"{hold_rate.get('test_floor_met', 0)} of {hold_rate.get('with_operating_point', 0)} cells with an "
        f"operating point held the {result.recipe.threshold_floor:g} point-estimate test precision floor "
        f"({_p(hold_rate.get('hold_rate'))}); among cells with at least 100 test alerts and 5 % recall, "
        f"{hold_rate.get('substantive_test_floor_met', 0)} of {hold_rate.get('substantive_cells', 0)} held "
        f"({_p(hold_rate.get('substantive_hold_rate'))}). The Wilson bound is nominal under "
        "departure-date correlation; the hold rate is descriptive, not a 95 % guarantee."
        if hold_rate.get("with_operating_point", 0) > 0
        else "No evaluation cell has an operating point."
    )
    development_hold_note = (
        f"{development_hold_rate.get('test_floor_met', 0)} of "
        f"{development_hold_rate.get('with_operating_point', 0)} development cells with an operating "
        f"point held the {result.recipe.threshold_floor:g} floor "
        f"({_p(development_hold_rate.get('hold_rate'))})."
        if development_hold_rate.get("with_operating_point", 0) > 0
        else "No development cell has an operating point."
    )
    decision_headers = [
        "headroom %",
        "TTD band",
        "operating point",
        "rows",
        "alert share",
        "saving vs wait EUR",
        "95 % CI vs wait",
        "saving vs book EUR",
        "95 % CI vs book",
        "random vs wait",
        "perfect breach vs wait",
        "perfect breach vs book",
        "perfect timing vs book",
        "cost of waiting",
    ]

    def _decision_rows(items: list[dict[str, Any]]) -> list[list[Any]]:
        """Render decision-value cells."""
        return [
            [
                item.get("headroom_pct"),
                item.get("band"),
                _yes(item.get("operating_point")),
                item.get("rows"),
                _p(item.get("alert_share")),
                _fmt(item.get("saving_vs_always_wait_eur"), 2),
                _ci(item.get("ci_saving_vs_wait_eur")),
                _fmt(item.get("saving_vs_always_book_eur"), 2),
                _ci(item.get("ci_saving_vs_book_eur")),
                _fmt(item.get("random_alert_saving_vs_wait_eur"), 2),
                _fmt(item.get("perfect_breach_vs_wait_eur"), 2),
                _fmt(item.get("perfect_breach_vs_book_eur"), 2),
                _fmt(item.get("perfect_timing_vs_book_eur"), 2),
                _fmt(item.get("cost_of_waiting_eur"), 2),
            ]
            for item in items
        ]

    development_decision_table = (
        _table(decision_headers, _decision_rows(result.development_decision_value))
        if result.development_decision_value
        else "Development folds were not scored."
    )
    decision_table = (
        _table(decision_headers, _decision_rows(result.decision_value))
        if result.decision_value
        else "Evaluation folds were not scored."
    )
    sparse_table = (
        _table(
            ["fold", "cutoff", "rows", "prevalence", "Brier", "BSS", "AUC", "AP"],
            [
                [
                    row["fold"],
                    row["cutoff"],
                    row["rows"],
                    _p(row.get("positive_rate")),
                    _fmt(row.get("brier")),
                    _fmt(row.get("bss")),
                    _fmt(row.get("roc_auc")),
                    _fmt(row.get("average_precision")),
                ]
                for row in sparse
            ],
        )
        if sparse
        else "Sparse-era folds were not scored."
    )
    intervals = pooled.get("intervals", {}) if pooled else {}
    bootstrap = pooled.get("bootstrap", {}) if pooled else {}
    combined_intervals = {**bootstrap, **intervals}
    interval_rows = [
        [name, _fmt(values[0]), _fmt(values[1])] for name, values in combined_intervals.items() if len(values) == 2
    ]
    interval_table = _table(["metric", "2.5 %", "97.5 %"], interval_rows) if interval_rows else ""
    clusters = pooled.get("bootstrap_clusters") if pooled else None
    intervals_note = (
        f"Intervals are a cluster bootstrap by departure date across folds: "
        f"{config.report.bootstrap_replicates} replicates for Brier and log loss, "
        f"{config.report.metric_bootstrap_replicates} for the other metrics, {clusters} clusters; "
        "precision and recall use each row's own fold and cell threshold; these intervals are "
        "conditional on the fitted thresholds and do not include threshold-selection variance. The "
        "per-fold table's `fold thr` columns are the legacy global rule, not the candidate alert rule."
        if interval_rows
        else ""
    )
    all_warnings = [*result.warnings, *dataset_manifest.get("warnings", [])]
    warnings = "\n".join(f"- {warning}" for warning in all_warnings) or "- none"
    recipe_line = (
        f"- Recipe: model `{result.recipe.model}`, calibration `{result.recipe.calibration}`, "
        f"threshold floor {result.recipe.threshold_floor} with at least "
        f"{result.recipe.threshold_min_alerts} alerts"
    )
    calibration_records = [record for row in result.per_fold for record in row.get("calibration_methods", [])]
    applied_methods = sorted(
        {str(record.get("fitted")) for record in calibration_records if record.get("fold") == "applied"}
    )
    fallback_records = [record for record in calibration_records if record.get("fallback")]
    fallback_reasons = sorted(
        {str(record.get("fallback_reason")) for record in fallback_records if record.get("fallback_reason")}
    )
    calibration_line = (
        f"- Fitted calibration: {', '.join(applied_methods) or result.recipe.calibration}; "
        f"fallback folds: {len(fallback_records)}" + (f" ({'; '.join(fallback_reasons)})" if fallback_reasons else "")
    )
    selection = result.selection
    selection_rows = selection.get("rows", []) if selection else []
    selection_table = (
        _table(
            ["model", "calibration", "fitted", "fallbacks", "rows", "Brier", "log loss", "BSS", "AUC", "AP"],
            [
                [
                    row["model"],
                    row["calibration"],
                    ", ".join(row.get("fitted_methods", [row["calibration"]])),
                    row.get("fallback_folds", 0),
                    row["rows"],
                    _fmt(row.get("brier")),
                    _fmt(row.get("log_loss")),
                    _fmt(row.get("bss")),
                    _fmt(row.get("roc_auc")),
                    _fmt(row.get("average_precision")),
                ]
                for row in selection_rows
            ],
        )
        if selection_rows
        else "Selection was served from the recipe cache without a table."
    )
    selection_note = (
        f"Chosen: `{selection.get('chosen', {}).get('model')}` / "
        f"`{selection.get('chosen', {}).get('calibration')}`. The paired intervals and every "
        "comparison are in `recipe.json`."
        if selection
        else ""
    )
    development = result.development_pooled
    development_table = (
        _table(
            ["metric", "value"],
            [
                ["rows", sum(row["rows"] for row in result.per_fold if row["role"] == "development")],
                ["Brier", _fmt(development.get("brier"))],
                ["log loss", _fmt(development.get("log_loss"))],
                ["BSS (base rate)", _fmt(development.get("bss"))],
                ["BSS climatology", _fmt(development.get("bss_climatology"))],
                ["ROC-AUC", _fmt(development.get("roc_auc"))],
                ["average precision", _fmt(development.get("average_precision"))],
                ["cell-threshold precision", _fmt(development.get("cell_threshold_precision"))],
                ["cell-threshold recall", _fmt(development.get("cell_threshold_recall"))],
                ["prevalence", _p(development.get("positive_rate"))],
            ],
        )
        if development
        else "Development folds were not scored."
    )
    development_headroom_table = (
        _table(
            [
                "headroom %",
                "prevalence",
                "Brier",
                "Brier isotonic",
                "log loss",
                "BSS",
                "BSS clim",
                "BSS clim CI",
                "AUC",
                "AP",
            ],
            [
                [
                    item["headroom_pct"],
                    _p(item.get("positive_rate")),
                    _fmt(item.get("brier")),
                    _fmt(item.get("brier_isotonic")),
                    _fmt(item.get("log_loss")),
                    _fmt(item.get("bss")),
                    _fmt(item.get("bss_climatology")),
                    _ci(item.get("bss_ci")),
                    _fmt(item.get("roc_auc")),
                    _fmt(item.get("average_precision")),
                ]
                for item in result.development_headroom
            ],
        )
        if result.development_headroom
        else "Development folds were not scored."
    )
    development_cells_table = (
        _table(
            ["headroom %", "TTD band", "era", "rows", "prevalence", "slope", "intercept", "ECE"],
            [
                [
                    item["headroom_pct"],
                    item["ttd_band"],
                    item["era"],
                    item["rows"],
                    _p(item.get("prevalence")),
                    _fmt(item.get("slope")),
                    _fmt(item.get("intercept")),
                    _fmt(item.get("ece")),
                ]
                for item in result.development_calibration_cells
            ],
        )
        if result.development_calibration_cells
        else "Development folds were not scored."
    )
    development_headroom_ttd_table = (
        _table(
            [
                "TTD band",
                "headroom %",
                "prevalence",
                "Brier",
                "log loss",
                "BSS",
                "BSS clim",
                "BSS clim CI",
                "AUC",
                "AP",
            ],
            [
                [
                    item["ttd_band"],
                    item["headroom_pct"],
                    _p(item.get("positive_rate")),
                    _fmt(item.get("brier")),
                    _fmt(item.get("log_loss")),
                    _fmt(item.get("bss")),
                    _fmt(item.get("bss_climatology")),
                    _ci(item.get("bss_ci")),
                    _fmt(item.get("roc_auc")),
                    _fmt(item.get("average_precision")),
                ]
                for item in result.development_headroom_ttd
            ],
        )
        if result.development_headroom_ttd
        else "Development folds were not scored."
    )
    spread_note = ""
    evaluation_rows = [row for row in result.per_fold if row["role"] == "evaluation"]
    train_sizes = [int(row.get("train_rows", 0)) for row in evaluation_rows]
    train_note = (
        f"evaluation folds train on {min(train_sizes) / 1e6:.1f}-{max(train_sizes) / 1e6:.1f} M rows "
        "rather than an equal sample."
        if train_sizes and min(train_sizes) > 0
        else "evaluation folds train on different-sized samples."
    )
    if evaluation_rows:

        def _range(key: str, percent: bool = False) -> str:
            """Format the observed minimum and maximum of a metric."""
            values = [float(row[key]) for row in evaluation_rows if row.get(key) is not None]
            if not values:
                return "—"
            low, high = min(values), max(values)
            return f"{low:.2%}-{high:.2%}" if percent else f"{low:.4f}-{high:.4f}"

        spread_note = (
            "Evaluation-fold spread: "
            f"Brier {_range('brier')}, BSS {_range('bss')}, AUC {_range('roc_auc')}, "
            f"AP {_range('average_precision')}, prevalence {_range('positive_rate', percent=True)}."
        )
    test_precision = [
        float(row["precision_at_threshold"]) for row in result.per_fold if row.get("precision_at_threshold") is not None
    ]
    fit_note = (
        "Development fold times exclude the selection fit; their model was reused."
        if any(not row.get("fit_included", True) for row in result.per_fold)
        else ""
    )
    precision_note = (
        f"Test precision at each fold's threshold ranges {min(test_precision):.3f}-{max(test_precision):.3f}; "
        f"the {result.recipe.threshold_floor:g} floor is selected on the calibration block, "
        "not guaranteed on test."
        if test_precision
        else ""
    )
    diagnostics_table = _table(
        ["fold", "headroom monotonic", "calibration slope", "ECE", "HGB iterations", "holdout log loss"],
        [
            [
                row["fold"],
                _yes(row.get("headroom_monotonic")),
                _fmt((row.get("calibration_stats") or {}).get("slope")),
                _fmt((row.get("calibration_stats") or {}).get("ece")),
                _fmt((row.get("early_stopping") or {}).get("iterations"), 0),
                _fmt((row.get("early_stopping") or {}).get("holdout_log_loss")),
            ]
            for row in result.per_fold
        ],
    )
    dropped = sorted({name for row in result.per_fold for name in row.get("dropped_features", [])})
    dropped_note = (
        f"Dropped constant or all-null features in at least one fold: {', '.join(dropped)}."
        if dropped
        else "No feature was dropped in any fold."
    )
    fold_table = _table(
        [
            "fold",
            "role",
            "cutoff",
            "train",
            "cal",
            "test rows",
            "prevalence",
            "Brier",
            "BSS",
            "BSS clim",
            "AUC",
            "AP",
            "fold thr",
            "floor met",
            "test prec",
            "test rec",
            "alert share",
            "s",
        ],
        fold_rows,
    )
    return f"""# Baseline training backtest

> Rolling-origin, point-in-time evaluation. Development folds pick the recipe; evaluation folds
> refit it without selection.

## Run

- Runner: `{dataset_manifest.get("runner", "local")}`
- Code: `{dataset_manifest.get("run_code_sha") or dataset_manifest.get("git_sha")}`
  (dirty: {dataset_manifest.get("run_code_dirty", dataset_manifest.get("git_dirty"))})
- Dataset build: `{dataset_manifest.get("dataset_git_sha") or dataset_manifest.get("git_sha")}`
  (dirty: {dataset_manifest.get("dataset_git_dirty", dataset_manifest.get("git_dirty"))})
- Silver build: `{dataset_manifest.get("silver_build_id")}`
- Dataset cache: {dataset_manifest.get("dataset_cache_key")}; reused: {dataset_manifest.get("dataset_reused", False)}
- Sample: {config.sample.sample_rate:.0%} of route-days (all rows on a sampled route-day)
- Protocol: `backtest`; embargo {config.protocol.embargo_hours} h; block {config.protocol.block_days} d
{recipe_line}
{calibration_line}
- Recipe hash: `{result.recipe.sha256()}`
- Evaluated blocks: {", ".join(result.evaluated_blocks)}
- Cache: {result.cache_dir or "none"}; enabled: {result.cache_enabled}
  code: {result.code_sha} (dirty: {result.code_dirty})
  recipe cached: {result.recipe_from_cache}; fold hits: {result.fold_cache_hits}; refits: {result.folds_refit}
- Wall: {result.runtime_seconds:.1f} s; peak RSS: {result.peak_rss_kb} KiB

**Label:** the chain's fare at the route-day check closest to `t + 24 h` inside 20-28 h and before
departure, in the 24 h-30 d domain. Rows are the labelled subset; a missing check is censored
(`not_listed`), not a negative.

**What is clean:** the evaluation weeks were inspected in PR 5 and earlier; these are a
re-measurement on an inspected cohort, not an unbiased estimate for a new period. The
October-November forward set is the only untouched data. These are different populations and
protocols from the static validation split; a higher Brier here is not a model regression.

> `BSS` is 1 - Brier / base-rate Brier; `BSS clim` is 1 - model Brier / fold-climatology Brier;
> `BSS train` uses each fold's train prevalence. The BSS interval re-estimates prevalence in each
> resample. The climatology is the smoothed train prevalence; unlike the static report it is not
> passed through the model calibrator.

## Folds

{fold_table}

The per-fold `fold thr` and `floor met` columns use the legacy global threshold; the per-cell
threshold table below is the candidate alert rule evaluated here. The backend still alerts on the
user's price limit; this rule is not shipped.

{diagnostics_table}

{dropped_note}

{spread_note}

{precision_note}

{fit_note}

## Development folds

Development folds choose the recipe and are the only folds the next selection step may use. The
selection table below is the joint model x calibration search; the full paired intervals are in
`recipe.json`. Their metric tables apply the selected calibrator at each headroom, like the
evaluation tables.

{selection_note}

{selection_table}

{development_table}

### Development per-headroom

`Brier isotonic` is the old per-headroom isotonic fit kept as a diagnostic. The main columns use
the selected calibrator at each headroom, so tables and headline share one model.

{development_headroom_table}

### Development per-headroom x TTD band

{development_headroom_ttd_table}

### Development calibration cells (headroom x TTD band x era)

{development_cells_table}

## Pooled evaluation

{pooled_table}

{intervals_note}

{interval_table}

## Per-headroom

Per-headroom rows relabel each test row at a fixed headroom and apply the selected calibrator at
that headroom; `Brier isotonic` stays as the old per-headroom diagnostic. `BSS clim CI` uses 400
departure-date cluster-bootstrap replicates.

{headroom_table}

## Per-headroom x TTD band

{headroom_ttd_table}

## Evaluation calibration cells (headroom x TTD band x era)

{era_note}

{calibration_cells_table}

ECE is prevalence-bounded; compare slope and intercept across cells, and read the intercept against
the prevalence column because it is at logit(p)=0. Cells below `MIN_CELL_ROWS` are omitted.

## Thresholds

Thresholds are chosen per headroom x TTD band on the calibration block's out-of-fold scores: the
highest recall whose one-sided 95 % Wilson lower bound on precision is at least
{result.recipe.threshold_floor:g}, with at least {result.recipe.threshold_min_alerts} alerts. A cell
with no qualifying operating point does not alert. `folds` counts the folds with an operating
point; the precision and recall columns pool every fold at its own threshold. The test `floor met`
check uses point-estimate precision; the calibration rule used the Wilson lower bound. That bound
is **nominal**: it assumes independent rows, while alerts within a departure date share the same
fare movement. The measured design effect is 1.4-3.2x, and a boundary rule is expected to hold on
roughly half of new cells. Treat the hold rate as descriptive; a departure-date cluster bound is
the PR 7 replacement. Cells with fewer than 100 test alerts or under 5 % recall are nominal only.
Cell rows relabel every test row at the cell's headroom; the pooled `cell-threshold`
precision/recall use each row's assigned headroom. {hold_note}

### Development thresholds

{development_hold_note}

{development_threshold_table}

### Evaluation thresholds

{threshold_table}

### Precision-recall by TTD band

`P@Rxx` is the best precision at or above recall `xx`, pooled over the assigned-headroom scores
(not a single cell threshold).

#### Development

{development_pr_table}

#### Evaluation

{pr_table}

## Development importance

Grouped permutation importance on the pooled development test blocks with each fold's own model
and calibrator: up to 20,000 rows stratified across all development departure dates (about
{result.importance[0]["rows"] if result.importance else 0} rows from
{result.importance[0]["departures"] if result.importance else 0} dates here), five repeats, delta
log loss. The sample is allocated equally per departure date, so the mean is date-weighted, not
the pooled-block mean; permutation is global across dates. `std`/`min`/`max` are the permutation
spread across repeats; `date std` is the spread of the per-date mean deltas. The `limit` family is
the user's headroom, the label's own parameter; read it as a sanity check, not a market driver.
Within-date permutation and a date-level interval are PR 7 refinements.

### Feature families

{importance_table}

### Single features (top 15)

{feature_importance_table}

## Sparse-era folds

{sparse_table}

Sparse-era folds cover 24 h-7 d and are thin at the 5 % sample; read them as point estimates.
The 3-6 September snapshot gap truncates sparse-0831's calibration window; sparse-0907's test
window starts on 15 September and is thin at the 5 % sample.

The cutoffs straddle the late-July scrape-cadence ramp and the 13-21 July outage, so
{train_note} The fixed cutoff list excludes 20 July; gates never skip a fold.

## Decision value

Decision value uses the next-day check at 20-28 h. An alert means "book now"; no alert means "wait
one day". The saving is the check fare minus today's fare, so positive means waiting costs more.
The primary comparison is **waiting** (the current product notifies only once the fare reaches the
limit). At low headroom and 1-3 d the policy is roughly break-even against booking now; its
interval includes zero. From 20 % headroom up it loses several euros against booking now. Even the
perfect breach oracle is negative against booking now from 20 % up near departure. A random alert
at low headroom captures most of the waiting value; at 20-30 % headroom it captures only a
minority. The model's lift is the remaining part. The oracle columns are point estimates; the
policy columns carry the cluster intervals. The alert is protection against crossing the limit,
not a buy-or-wait oracle. Read the euro columns rather than a fixed headline number.

### Development decision value

{development_decision_table}

### Evaluation decision value

{decision_table}

## Warnings

{warnings}
"""


def _ci(values: Any, digits: int = 4) -> str:
    """Format a two-sided interval."""
    if not isinstance(values, list) or len(values) != 2:
        return "—"
    return f"{_fmt(values[0], digits)}..{_fmt(values[1], digits)}"


def _value_range(values: Any, digits: int = 4) -> str:
    """Format the minimum and maximum of a value list, whatever its length."""
    if not isinstance(values, list) or not values:
        return "—"
    return f"{_fmt(min(values), digits)}..{_fmt(max(values), digits)}"


def write_backtest_artifacts(
    out_dir: Path,
    result: BacktestResult,
    config: TrainingConfig,
    spec: FeatureSpec,
    *,
    runner: str = "local",
    runtime: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Write backtest artifacts."""
    predictions_dir = out_dir / "predictions"
    predictions_dir.mkdir(parents=True, exist_ok=True)
    predictions_path = predictions_dir / "backtest.parquet"
    _write_predictions(predictions_path, result)
    dataset_manifest = json.loads((out_dir / "dataset_manifest.json").read_text(encoding="utf-8"))
    manifest_view = {
        "runner": runner,
        "git_sha": dataset_manifest.get("git_sha"),
        "git_dirty": dataset_manifest.get("git_dirty"),
        "git_untracked": dataset_manifest.get("git_untracked", []),
        "silver_build_id": dataset_manifest.get("silver_build_id"),
        "dataset_reused": dataset_manifest.get("reused", False),
        "dataset_reuse_key": dataset_manifest.get("reuse_key"),
        "dataset_cache_key": dataset_manifest.get("dataset_cache_key"),
        "run_code_sha": result.code_sha,
        "run_code_dirty": result.code_dirty,
        "dataset_git_sha": dataset_manifest.get("git_sha"),
        "dataset_git_dirty": dataset_manifest.get("git_dirty"),
        "warnings": dataset_manifest.get("warnings", []),
    }
    recipe_payload = {
        **result.recipe.payload(),
        "sha256": result.recipe.sha256(),
        "selection": result.selection,
        "selection_table_sha256": table_sha256(result.selection) if result.selection else None,
    }
    (out_dir / "recipe.json").write_text(json.dumps(recipe_payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    backtest_payload = {
        "protocol": {
            "kind": config.protocol.kind,
            "embargo_hours": config.protocol.embargo_hours,
            "block_days": config.protocol.block_days,
            "cutoffs": [
                {"cutoff": fold.cutoff.isoformat(), "role": fold.role, "name": fold.name}
                for fold in config.protocol.cutoffs
            ],
        },
        "recipe": recipe_payload,
        "evaluated_blocks": list(result.evaluated_blocks),
        "per_fold": result.per_fold,
        "pooled": result.pooled,
        "headroom": result.headroom,
        "headroom_ttd": result.headroom_ttd,
        "sparse": result.sparse,
        "development_pooled": result.development_pooled,
        "development_headroom": result.development_headroom,
        "development_headroom_ttd": result.development_headroom_ttd,
        "calibration_cells": result.calibration_cells,
        "development_calibration_cells": result.development_calibration_cells,
        "threshold_cells": result.threshold_cells,
        "development_threshold_cells": result.development_threshold_cells,
        "threshold_hold_rate": result.threshold_hold_rate,
        "development_threshold_hold_rate": result.development_threshold_hold_rate,
        "pr_curves": result.pr_curves,
        "development_pr_curves": result.development_pr_curves,
        "selection": result.selection,
        "decision_value": result.decision_value,
        "development_decision_value": result.development_decision_value,
        "importance": result.importance,
        "warnings": [*result.warnings, *dataset_manifest.get("warnings", [])],
        "runtime_seconds": result.runtime_seconds,
        "peak_rss_kb": result.peak_rss_kb,
    }
    (out_dir / "backtest.json").write_text(
        json.dumps(backtest_payload, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8"
    )
    (out_dir / "report.md").write_text(_report(result, config, manifest_view), encoding="utf-8")
    artifacts = [predictions_path, out_dir / "recipe.json", out_dir / "backtest.json", out_dir / "report.md"]
    artifacts.extend(
        path
        for path in (
            out_dir / "forward_predictions.parquet",
            out_dir / "forward_input.parquet",
            out_dir / "forward_smoke.json",
            out_dir / "dataset_manifest.json",
            out_dir / "profile.json",
            out_dir / "column_roles.json",
        )
        if path.is_file()
    )
    runtime = runtime or {}
    manifest = {
        "runner": runner,
        "git_sha": dataset_manifest.get("git_sha"),
        "git_dirty": dataset_manifest.get("git_dirty"),
        "git_untracked": dataset_manifest.get("git_untracked", []),
        "silver_build_id": dataset_manifest.get("silver_build_id"),
        "recipe_sha256": result.recipe.sha256(),
        "config_sha256": config.hash(),
        "feature_spec_sha256": hashlib.sha256(json.dumps(list(spec.names)).encode()).hexdigest(),
        "sample": {"sample_rate": config.sample.sample_rate, "seed": config.sample.seed},
        "dataset_sha256": hashlib.sha256(
            json.dumps(dataset_manifest.get("dataset_files", []), sort_keys=True).encode("utf-8")
        ).hexdigest(),
        "evaluated_blocks": list(result.evaluated_blocks),
        "runtime": runtime,
        "cache": {
            "dir": result.cache_dir,
            "enabled": result.cache_enabled,
            "code_sha": result.code_sha,
            "code_dirty": result.code_dirty,
            "fit_code_sha": result.fit_code_sha,
            "recipe_from_cache": result.recipe_from_cache,
            "fold_cache_hits": result.fold_cache_hits,
            "folds_refit": result.folds_refit,
        },
        "git_dirty_end": dataset_manifest.get("git_dirty_end"),
        "run_code_sha": result.code_sha,
        "dataset_git_sha": dataset_manifest.get("git_sha"),
        "dataset_reused": dataset_manifest.get("reused", False),
        "dataset_reuse_key": dataset_manifest.get("reuse_key"),
        "dataset_cache_key": dataset_manifest.get("dataset_cache_key"),
        "artifacts": {
            path.relative_to(out_dir).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in artifacts
        },
        "warnings": [*result.warnings, *dataset_manifest.get("warnings", [])],
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return {
        "run_id": out_dir.name,
        "rows": sum(row["rows"] for row in result.per_fold),
        "evaluated_blocks": list(result.evaluated_blocks),
        "recipe": recipe_payload,
        "pooled_brier": result.pooled.get("brier"),
        "pooled_bss": result.pooled.get("bss"),
        "runtime": runtime,
    }
