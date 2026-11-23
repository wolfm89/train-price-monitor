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
from tpm_analytics.training.bands import HEADLINE_BANDS
from tpm_analytics.training.config import MODEL_NAMES, FoldConfig, ProtocolConfig, TrainingConfig
from tpm_analytics.training.dataset import DatasetError, _git_state
from tpm_analytics.training.features import BOOLEAN, CATEGORICAL, LABEL_COLUMNS, FeatureSpec
from tpm_analytics.training.labels import breach
from tpm_analytics.training.model import (
    Array,
    FittedModel,
    ModelError,
    TabularData,
    _bootstrap,
    _bootstrap_metrics,
    _calibration_stats,
    _compact_category,
    _cross_fitted,
    _decision_metrics,
    _filled,
    _metrics,
    _pooled_decision_value_rows,
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
from tpm_analytics.training.selection import select_outcome, selection_settings

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
    selection_settings: dict[str, Any] = field(default_factory=dict)

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
            "selection_settings": self.selection_settings,
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
    raw_cal = model.predict(calibrate)
    oof = _cross_fitted(raw_cal, calibrate.y, calibrate.departure_date, recipe.calibration, fold_config)
    calibrator = fit_calibrator(
        raw_cal,
        calibrate.y,
        recipe.calibration,
        min_positives=recipe.calibration_min_positives,
    )
    threshold, _ = _threshold(calibrate.y, oof, recipe.threshold_floor)
    return ForwardScorer(
        model=model,
        calibrator=calibrator,
        threshold=threshold,
    )


def score_forward(forward: TabularData, scorer: ForwardScorer) -> Array:
    """Return the calibrated forward probability at each row's assigned headroom."""
    return scorer.calibrator.predict(scorer.model.predict(forward))


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
        selection_settings=selection_settings(outcome.table),
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
    raw_cal = model.predict_matrix(cal_matrix)
    oof_cal = _cross_fitted(raw_cal, calibrate.y, calibrate.departure_date, recipe.calibration, fold_config)
    calibrator = fit_calibrator(
        raw_cal,
        calibrate.y,
        recipe.calibration,
        min_positives=recipe.calibration_min_positives,
    )
    threshold, threshold_met = _threshold(calibrate.y, oof_cal, recipe.threshold_floor)
    raw = model.predict_matrix(test_matrix)
    calibrated = calibrator.predict(raw)
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
    for headroom in config.label.headroom_pct:
        raw_cal_headroom = model.predict_matrix(model.with_headroom(cal_matrix, headroom))
        y_cal = breach(calibrate.price_cents, calibrate.check_price_cents, headroom)
        calibrator_headroom = fit_calibrator(
            raw_cal_headroom,
            y_cal,
            recipe.calibration,
            min_positives=recipe.calibration_min_positives,
        )
        raw_headroom = model.predict_matrix(model.with_headroom(test_matrix, headroom))
        raw_probabilities[headroom] = raw_headroom
        probabilities[headroom] = calibrator_headroom.predict(raw_headroom)
        climate_by_headroom[headroom] = climatology.predict(test, headroom=headroom)
        labels[headroom] = breach(test.price_cents, test.check_price_cents, headroom)
    ordered = [probabilities[headroom] for headroom in config.label.headroom_pct]
    headroom_monotonic = bool(all(np.all(left >= right) for left, right in itertools.pairwise(ordered)))
    calibration_stats = _calibration_stats(test.y, calibrated, config.report.calibration_bins)
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
    return Recipe(
        model=payload["model"],
        calibration=payload["calibration"],
        threshold_floor=float(payload["threshold_floor"]),
        model_settings=payload["model_settings"],
        calibration_folds=int(payload.get("calibration_folds", config.calibration.folds)),
        calibration_min_positives=int(payload.get("calibration_min_positives", config.calibration.min_positives)),
        selection_settings=payload.get("selection_settings") or {},
    )


def _save_cached_recipe(
    cache_dir: Path | None,
    config: TrainingConfig,
    recipe: Recipe,
    dataset_sha256: str | None,
    code_sha: str | None,
    fit_code_sha: str,
) -> None:
    """Persist cached recipe."""
    if cache_dir is None:
        return
    payload = {
        **recipe.payload(),
        "config_sha256": config.hash(),
        "dataset_sha256": dataset_sha256,
        "code_sha": code_sha,
        "fit_code_sha": fit_code_sha,
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
    metrics["intervals"] = _bootstrap_metrics(
        pooled.y,
        calibrated,
        pooled.departure_date,
        config.report.metric_bootstrap_replicates,
        config.seed + 1,
        np.concatenate([np.full(len(item.test), item.threshold) for item in folds]),
    )
    headroom, headroom_ttd = _headroom_rows(pooled, folds, config)
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
        development_models: dict[str, FittedModel] = {}
    else:
        _LOGGER.info("backtest: selecting recipe on development folds")
        recipe, development_models, selection_table = select_recipe_bundle(panel, config, spec)
        _save_cached_recipe(active_cache, config, recipe, dataset_sha256, code_sha, fit_code_sha)
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
            "headroom_monotonic": item.headroom_monotonic,
            "calibration_stats": item.calibration_stats,
            "early_stopping": item.early_stopping,
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
        for item in evaluation:
            decision_value.extend(
                {
                    "fold": item.fold.name,
                    **row,
                }
                for row in _pooled_decision_value_rows(
                    item.test,
                    item.calibrated,
                    _ttd_array(item.test),
                    item.threshold,
                    config.report.metric_bootstrap_replicates,
                    config.seed + 2,
                )
            )
    development_results = tuple(item for item in results if item.fold.role == "development")
    development_pooled: dict[str, Any] = {}
    development_headroom: list[dict[str, Any]] = []
    development_headroom_ttd: list[dict[str, Any]] = []
    if development_results:
        development_pooled, development_headroom, development_headroom_ttd = _pooled_summary(
            development_results, config
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
        decision_value=decision_value,
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
                ["prevalence", _p(pooled.get("positive_rate"))],
            ],
        )
    else:
        pooled_table = "Evaluation folds were not scored."
    headroom_table = (
        _table(
            ["headroom %", "prevalence", "Brier", "log loss", "BSS", "BSS clim", "BSS clim CI", "AUC", "AP"],
            [
                [
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
    decision_table = (
        _table(
            [
                "fold",
                "TTD band",
                "rows",
                "alert share",
                "saving vs wait EUR",
                "95 % CI vs wait",
                "saving vs book EUR",
                "95 % CI vs book",
            ],
            [
                [
                    item.get("fold"),
                    item.get("band"),
                    item.get("rows"),
                    _p(item.get("alert_share")),
                    _fmt(item.get("saving_vs_always_wait_eur"), 2),
                    _ci(item.get("ci_saving_vs_wait_eur")),
                    _fmt(item.get("saving_vs_always_book_eur"), 2),
                    _ci(item.get("ci_saving_vs_book_eur")),
                ]
                for item in result.decision_value
            ],
        )
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
        f"precision and recall use the mean fold threshold."
        if interval_rows
        else ""
    )
    all_warnings = [*result.warnings, *dataset_manifest.get("warnings", [])]
    warnings = "\n".join(f"- {warning}" for warning in all_warnings) or "- none"
    recipe_line = (
        f"- Recipe: model `{result.recipe.model}`, calibration `{result.recipe.calibration}`, "
        f"threshold floor {result.recipe.threshold_floor}"
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
                ["prevalence", _p(development.get("positive_rate"))],
            ],
        )
        if development
        else "Development folds were not scored."
    )
    development_headroom_table = (
        _table(
            ["headroom %", "prevalence", "Brier", "log loss", "BSS", "BSS clim", "BSS clim CI", "AUC", "AP"],
            [
                [
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
                for item in result.development_headroom
            ],
        )
        if result.development_headroom
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
            "threshold",
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
- Recipe hash: `{result.recipe.sha256()}`
- Evaluated blocks: {", ".join(result.evaluated_blocks)}
- Cache: {result.cache_dir or "none"}; enabled: {result.cache_enabled}
  code: {result.code_sha} (dirty: {result.code_dirty})
  recipe cached: {result.recipe_from_cache}; fold hits: {result.fold_cache_hits}; refits: {result.folds_refit}
- Wall: {result.runtime_seconds:.1f} s; peak RSS: {result.peak_rss_kb} KiB

**Label:** the chain's fare at the route-day check closest to `t + 24 h` inside 20-28 h and before
departure, in the 24 h-30 d domain. Rows are the labelled subset; a missing check is censored
(`not_listed`), not a negative.

**What is clean:** the evaluation weeks were part of earlier development, and the current recipe
was chosen with them in view. They are a fair yardstick for choices made from this protocol on.
The October-November forward set is the only untouched data. These are different populations and
protocols from the static validation split; a higher Brier here is not a model regression.

> `BSS` is 1 - Brier / base-rate Brier; `BSS clim` is 1 - model Brier / fold-climatology Brier;
> `BSS train` uses each fold's train prevalence. The BSS interval re-estimates prevalence in each
> resample. The climatology is the smoothed train prevalence; unlike the static report it is not
> passed through the model calibrator.

## Folds

{fold_table}

{diagnostics_table}

{spread_note}

{precision_note}

{fit_note}

## Development folds

Development folds choose the recipe and are the only folds the next selection step may use. Their
tables use the same per-headroom diagnostic calibration as the evaluation tables.

{development_table}

### Development per-headroom

{development_headroom_table}

### Development per-headroom x TTD band

{development_headroom_ttd_table}

## Pooled evaluation

{pooled_table}

{intervals_note}

{interval_table}

## Per-headroom

Per-headroom rows relabel each test row at a fixed headroom and fit a separate calibration for
it; they are not directly comparable with the pooled-calibrator headline. `BSS clim CI` uses 400
departure-date cluster-bootstrap replicates.

{headroom_table}

## Per-headroom x TTD band

{headroom_ttd_table}

## Sparse-era folds

{sparse_table}

Sparse-era folds cover 24 h-7 d and are thin at the 5 % sample; read them as point estimates.
The 3-6 September snapshot gap truncates sparse-0831's calibration window; sparse-0907's test
window starts on 15 September and is thin at the 5 % sample.

The cutoffs straddle the late-July scrape-cadence ramp and the 13-21 July outage, so
{train_note} The fixed cutoff list excludes 20 July; gates never skip a fold.

## Decision value

Decision value uses the 20-24 h crossed-back check on a subset of test rows; it is a diagnostic,
not a headline metric.

{decision_table}

## Warnings

{warnings}
"""


def _ci(values: Any, digits: int = 4) -> str:
    """Format a two-sided interval."""
    if not isinstance(values, list) or len(values) != 2:
        return "—"
    return f"{_fmt(values[0], digits)}..{_fmt(values[1], digits)}"


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
        "selection": result.selection,
        "decision_value": result.decision_value,
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
