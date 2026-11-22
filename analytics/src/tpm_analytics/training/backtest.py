"""Additive rolling-origin backtest protocol.

The dataset is built once; each fold selects rows by ``snapshot_at`` and ``label_window_end``. The
recipe is frozen on the development folds, then refitted on each evaluation fold without any
selection. Evaluation and sparse-era folds are scored only with ``--evaluate-test``.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import pickle
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
from tpm_analytics.training.config import FoldConfig, ProtocolConfig, TrainingConfig
from tpm_analytics.training.dataset import DatasetError, _git_state
from tpm_analytics.training.features import BOOLEAN, CATEGORICAL, FeatureSpec
from tpm_analytics.training.labels import breach
from tpm_analytics.training.model import (
    Array,
    ClimatologyModel,
    FittedModel,
    ModelError,
    TabularData,
    _bootstrap,
    _bootstrap_metrics,
    _categorical,
    _choose_candidate,
    _cross_fitted,
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

MIN_CELL_ROWS = 20
_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class ForwardScorer:
    model: FittedModel
    calibrator: Any
    threshold: float
    climatology: ClimatologyModel
    train_rate: float


@dataclass(frozen=True)
class Recipe:
    model: str
    calibration: str
    threshold_floor: float
    model_settings: dict[str, Any]

    def payload(self) -> dict[str, Any]:
        return {
            "model": self.model,
            "calibration": self.calibration,
            "threshold_floor": self.threshold_floor,
            "model_settings": self.model_settings,
        }

    def sha256(self) -> str:
        return hashlib.sha256(json.dumps(self.payload(), sort_keys=True).encode()).hexdigest()


@dataclass
class FoldResult:
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
    train_rows: int = 0
    calibrate_rows: int = 0
    train: TabularData | None = None
    calibrate: TabularData | None = None


@dataclass
class BacktestResult:
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
    recipe_from_cache: bool = False
    fold_cache_hits: int = 0
    folds_refit: int = 0


def load_panel(out_dir: Path, spec: FeatureSpec) -> TabularData:
    paths = [
        out_dir / "dataset" / f"{name}.parquet"
        for name in ("train", "validation_select", "validation_calibrate", "test")
    ]
    return load_splits(paths, spec)


def load_forward(path: Path, spec: FeatureSpec) -> TabularData:
    """Load the label-free forward Parquet for prediction only."""
    columns = ", ".join(
        dict.fromkeys((*spec.names, "series_key", "chain_id", "snapshot_at", "departure_date", "headroom_pct"))
    )
    connection = duckdb.connect()
    try:
        rows = connection.execute(
            f"SELECT {columns} FROM read_parquet('{sql_string(path.as_posix())}') ORDER BY series_key, snapshot_at"
        ).fetchnumpy()
    finally:
        connection.close()
    features: dict[str, Array] = {}
    for feature in spec.features:
        values = rows[feature.name]
        if feature.kind == CATEGORICAL:
            features[feature.name] = _categorical(values)
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
    model_config = replace(config.model, **recipe.model_settings)
    fold_config = replace(config, model=model_config)
    model = fit_candidate(recipe.model, train, spec, fold_config)
    climatology = fit_climatology(train)
    raw_cal = model.predict(calibrate)
    oof = _cross_fitted(raw_cal, calibrate.y, calibrate.departure_date, recipe.calibration, config)
    calibrator = fit_calibrator(
        raw_cal,
        calibrate.y,
        recipe.calibration,
        min_positives=config.calibration.min_positives,
    )
    threshold, _ = _threshold(calibrate.y, oof, recipe.threshold_floor)
    return ForwardScorer(
        model=model,
        calibrator=calibrator,
        threshold=threshold,
        climatology=climatology,
        train_rate=float(np.mean(train.y)),
    )


def score_forward(forward: TabularData, scorer: ForwardScorer) -> Array:
    """Return the calibrated forward probability at each row's assigned headroom."""
    return scorer.calibrator.predict(scorer.model.predict(forward))


def forward_fold(protocol: ProtocolConfig) -> FoldConfig:
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
    fold = forward_fold(config.protocol)
    masks = fold_masks(panel, fold, config.protocol)
    assert_purged(panel, fold, config.protocol, masks)
    train = panel.subset(masks.train)
    calibrate = panel.subset(masks.calibrate)
    if len(train) == 0 or len(calibrate) == 0:
        raise ModelError(f"{fold.name}: empty train or calibration block")
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
    table = pa.table(
        {
            "fold": [fold.name] * len(forward),
            "series_key": np.asarray(forward.series, dtype=str),
            "chain_id": np.asarray(forward.chain if forward.chain is not None else forward.series, dtype=str),
            "snapshot_at": np.asarray(forward.snapshot_at, dtype=str),
            "departure_date": np.asarray(forward.departure_date, dtype=str),
            "headroom_pct": forward.headroom.astype(np.int16),
            "score": probabilities,
            "threshold": np.full(len(forward), scorer.threshold, dtype=np.float64),
        }
    )
    pq.write_table(table, predictions_path, compression="zstd")
    sibling = forward_path.parent / "forward_manifest.json"
    missingness: dict[str, float] = {}
    if sibling.is_file():
        missingness = json.loads(sibling.read_text(encoding="utf-8")).get("feature_missingness", {})
    smoke = {
        "fold": fold.name,
        "rows": len(forward),
        "min_score": float(probabilities.min()),
        "max_score": float(probabilities.max()),
        "finite": bool(np.all(np.isfinite(probabilities))),
        "threshold": scorer.threshold,
        "recipe_sha256": recipe.sha256(),
        "feature_missingness": missingness,
        "labels": False,
        "metrics": False,
    }
    (out_dir / "forward_smoke.json").write_text(json.dumps(smoke, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return smoke


def _model_settings(config: TrainingConfig) -> dict[str, Any]:
    return {
        "max_iter": config.model.max_iter,
        "learning_rate": config.model.learning_rate,
        "max_leaf_nodes": config.model.max_leaf_nodes,
        "random_state": config.model.random_state,
    }


def _fold_slices(
    panel: TabularData, fold: FoldConfig, config: TrainingConfig
) -> tuple[FoldMasks, TabularData, TabularData, TabularData]:
    masks = fold_masks(panel, fold, config.protocol)
    assert_purged(panel, fold, config.protocol, masks)
    train, calibrate, test = fold_slices(panel, masks)
    return masks, train, calibrate, test


def _fold_metrics(
    test: TabularData, calibrated: Array, climatology: Array, train_rate: float
) -> dict[str, float | None]:
    metrics = _metrics(test.y, calibrated)
    reference = float(np.mean((test.y - climatology) ** 2))
    metrics["bss_climatology"] = 1.0 - float(metrics["brier"] or 0.0) / reference if reference > 0 else None
    reference_train = float(np.mean((test.y - train_rate) ** 2))
    metrics["bss_train"] = 1.0 - float(metrics["brier"] or 0.0) / reference_train if reference_train > 0 else None
    return metrics


def select_recipe_bundle(
    panel: TabularData, config: TrainingConfig, spec: FeatureSpec
) -> tuple[Recipe, dict[str, FittedModel]]:
    """Choose model family and calibration method on the development folds only."""
    development = [item for item in config.protocol.cutoffs if item.role == "development"]
    if not development:
        raise ModelError("the backtest has no development folds")
    if any(item.role != "development" for item in development):
        raise ModelError("recipe selection must use development folds only")
    first_method = next(iter(config.calibration.methods))
    candidate_scores: dict[str, list[dict[str, float | None]]] = {name: [] for name in config.model.candidates}
    fitted: dict[tuple[str, str], FittedModel] = {}
    for fold in development:
        _, train, calibrate, _ = _fold_slices(panel, fold, config)
        for name in config.model.candidates:
            model = fit_candidate(name, train, spec, config)
            fitted[(fold.name, name)] = model
            raw = model.predict(calibrate)
            if name == "base_rate":
                candidate_scores[name].append(_metrics(calibrate.y, raw))
            else:
                oof = _cross_fitted(raw, calibrate.y, calibrate.departure_date, first_method, config)
                candidate_scores[name].append(_metrics(calibrate.y, oof))
    averaged: dict[str, dict[str, float | None]] = {
        name: {
            key: float(np.mean([float(item[key] or 0.0) for item in values])) for key in ("brier", "average_precision")
        }
        for name, values in candidate_scores.items()
    }
    chosen = _choose_candidate(averaged)
    method_scores: dict[str, list[float]] = {method: [] for method in config.calibration.methods}
    for fold in development:
        _, _, calibrate, _ = _fold_slices(panel, fold, config)
        model = fitted[(fold.name, chosen)]
        raw = model.predict(calibrate)
        for method in config.calibration.methods:
            oof = _cross_fitted(raw, calibrate.y, calibrate.departure_date, method, config)
            method_scores[method].append(float(_metrics(calibrate.y, oof)["brier"] or 1.0))
    calibration = min(method_scores, key=lambda name: float(np.mean(method_scores[name])))
    recipe = Recipe(
        model=chosen,
        calibration=calibration,
        threshold_floor=config.report.threshold_precision_floor,
        model_settings=_model_settings(config),
    )
    return recipe, {name: model for (name, candidate), model in fitted.items() if candidate == chosen}


def select_recipe(panel: TabularData, config: TrainingConfig, spec: FeatureSpec) -> Recipe:
    return select_recipe_bundle(panel, config, spec)[0]


def _check_fold_gates(
    fold: FoldConfig,
    train: TabularData,
    calibrate: TabularData,
    test: TabularData,
    config: TrainingConfig,
) -> None:
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
    started = time.perf_counter()
    _check_fold_gates(fold, train, calibrate, test, config)
    # The recipe, not the live config, supplies the model family and settings. A later config
    # change cannot silently re-tune an evaluation fold.
    model_config = replace(config.model, **recipe.model_settings)
    fold_config = replace(config, model=model_config)
    model = fitted_model or fit_candidate(recipe.model, train, spec, fold_config)
    climatology = fit_climatology(train)
    cal_matrix = model.transform(calibrate)
    test_matrix = model.transform(test)
    raw_cal = model.predict_matrix(cal_matrix)
    oof_cal = _cross_fitted(raw_cal, calibrate.y, calibrate.departure_date, recipe.calibration, config)
    calibrator = fit_calibrator(
        raw_cal,
        calibrate.y,
        recipe.calibration,
        min_positives=config.calibration.min_positives,
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
            min_positives=config.calibration.min_positives,
        )
        raw_headroom = model.predict_matrix(model.with_headroom(test_matrix, headroom))
        raw_probabilities[headroom] = raw_headroom
        probabilities[headroom] = calibrator_headroom.predict(raw_headroom)
        climate_by_headroom[headroom] = climatology.predict(test, headroom=headroom)
        labels[headroom] = breach(test.price_cents, test.check_price_cents, headroom)
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
    )


def _bss_paired_ci(
    labels: Array,
    model: Array,
    climatology: Array,
    groups: Array,
    replicates: int,
    seed: int,
) -> list[float]:
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
    return seed + headroom * 1000 + sum((index + 1) * ord(char) for index, char in enumerate(band))


def _headroom_rows(
    pooled: TabularData, folds: tuple[FoldResult, ...], config: TrainingConfig
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
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
    try:
        sha, dirty, _ = _git_state()
    except Exception:
        return None, None
    return sha, dirty


def _recipe_cache_path(cache_dir: Path) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir / "recipe.json"


def _load_cached_recipe(
    cache_dir: Path | None,
    config: TrainingConfig,
    dataset_sha256: str | None,
    code_sha: str | None,
    code_dirty: bool | None,
) -> Recipe | None:
    if cache_dir is None:
        return None
    path = _recipe_cache_path(cache_dir)
    if not path.is_file():
        return None
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("config_sha256") != config.hash():
        return None
    if dataset_sha256 is not None and payload.get("dataset_sha256") != dataset_sha256:
        return None
    if code_sha is None or code_dirty is not False or payload.get("code_sha") != code_sha:
        return None
    return Recipe(
        model=payload["model"],
        calibration=payload["calibration"],
        threshold_floor=float(payload["threshold_floor"]),
        model_settings=payload["model_settings"],
    )


def _save_cached_recipe(
    cache_dir: Path | None,
    config: TrainingConfig,
    recipe: Recipe,
    dataset_sha256: str | None,
    code_sha: str | None,
) -> None:
    if cache_dir is None:
        return
    payload = {
        **recipe.payload(),
        "config_sha256": config.hash(),
        "dataset_sha256": dataset_sha256,
        "code_sha": code_sha,
    }
    _recipe_cache_path(cache_dir).write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _cache_paths(cache_dir: Path, fold: FoldConfig) -> tuple[Path, Path]:
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
) -> FoldResult | None:
    if cache_dir is None:
        return None
    data_path, meta_path = _cache_paths(cache_dir, fold)
    if not data_path.is_file() or not meta_path.is_file():
        return None
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    if meta.get("recipe_sha256") != recipe.sha256() or meta.get("config_sha256") != config.hash():
        return None
    if dataset_sha256 is not None and meta.get("dataset_sha256") != dataset_sha256:
        return None
    if code_sha is None or code_dirty is not False or meta.get("code_sha") != code_sha:
        return None
    with data_path.open("rb") as handle:
        loaded = pickle.load(handle)
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
) -> None:
    if cache_dir is None:
        return
    data_path, meta_path = _cache_paths(cache_dir, fold)
    tmp_path = data_path.with_suffix(".tmp")
    with tmp_path.open("wb") as handle:
        pickle.dump(result, handle)
    os.replace(tmp_path, data_path)
    meta_path.write_text(
        json.dumps(
            {
                "fold": fold.name,
                "recipe_sha256": recipe.sha256(),
                "config_sha256": config.hash(),
                "dataset_sha256": dataset_sha256,
                "code_sha": code_sha,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )


def _pooled_summary(
    folds: tuple[FoldResult, ...], config: TrainingConfig
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
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
        float(np.mean([item.threshold for item in folds])),
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
    started = time.perf_counter()
    code_sha, code_dirty = _code_identity()
    cache_enabled = cache_dir is not None and code_sha is not None and code_dirty is False
    active_cache = cache_dir if cache_enabled else None
    folds = scored_folds(config.protocol, evaluate_test=evaluate_test)
    if not folds:
        raise ModelError("no scored folds")
    cached_recipe = _load_cached_recipe(active_cache, config, dataset_sha256, code_sha, code_dirty)
    recipe_from_cache = cached_recipe is not None
    if cached_recipe is not None:
        _LOGGER.info("backtest: using cached recipe %s / %s", cached_recipe.model, cached_recipe.calibration)
        recipe = cached_recipe
        development_models: dict[str, FittedModel] = {}
    else:
        _LOGGER.info("backtest: selecting recipe on development folds")
        recipe, development_models = select_recipe_bundle(panel, config, spec)
        _save_cached_recipe(active_cache, config, recipe, dataset_sha256, code_sha)
        _LOGGER.info("backtest: recipe %s / %s", recipe.model, recipe.calibration)
    results: list[FoldResult] = []
    for fold in folds:
        cached = _load_cached_fold(active_cache, fold, recipe, config, dataset_sha256, code_sha, code_dirty)
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
        _save_cached_fold(active_cache, fold, recipe, config, result, dataset_sha256, code_sha)
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
            "runtime_seconds": item.runtime_seconds,
            "from_cache": item.from_cache,
        }
        for item in results
    ]
    warnings: list[str] = []
    if not evaluation:
        warnings.append("evaluation folds were not scored; pass --evaluate-test to score them")
    pooled_metrics: dict[str, Any] = {}
    headroom_rows: list[dict[str, Any]] = []
    headroom_ttd: list[dict[str, Any]] = []
    decision_value: list[dict[str, Any]] = []
    pooled: TabularData | None = None
    if evaluation:
        pooled = concat_tabular([item.test for item in evaluation])
        calibrated = np.concatenate([item.calibrated for item in evaluation])
        climatology = np.concatenate([item.climatology for item in evaluation])
        train_rate = np.concatenate([np.full(len(item.test), item.train_rate, dtype=np.float64) for item in evaluation])
        pooled_metrics.update(_metrics(pooled.y, calibrated))
        reference = float(np.mean((pooled.y - climatology) ** 2))
        pooled_metrics["bss_climatology"] = (
            1.0 - float(pooled_metrics["brier"] or 0.0) / reference if reference > 0 else None
        )
        reference_train = float(np.mean((pooled.y - train_rate) ** 2))
        pooled_metrics["bss_train"] = (
            1.0 - float(pooled_metrics["brier"] or 0.0) / reference_train if reference_train > 0 else None
        )
        pooled_metrics["bootstrap_clusters"] = len(np.unique(pooled.departure_date))
        pooled_metrics["bootstrap"] = _bootstrap(
            pooled.y,
            calibrated,
            pooled.departure_date,
            config.report.bootstrap_replicates,
            config.seed,
        )
        pooled_metrics["intervals"] = _bootstrap_metrics(
            pooled.y,
            calibrated,
            pooled.departure_date,
            config.report.metric_bootstrap_replicates,
            config.seed + 1,
            float(np.mean([item.threshold for item in evaluation])),
        )
        headroom_rows, headroom_ttd = _headroom_rows(pooled, evaluation, config)
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
        recipe_from_cache=recipe_from_cache,
        fold_cache_hits=sum(1 for item in results if item.from_cache),
        folds_refit=sum(1 for item in results if not item.from_cache),
    )


def _fmt(value: Any, digits: int = 4) -> str:
    if value is None:
        return "—"
    if isinstance(value, float):
        return f"{value:.{digits}f}"
    return str(value)


def _p(value: Any) -> str:
    return "—" if value is None else f"{float(value):.1%}"


def _yes(value: Any) -> str:
    return "—" if value is None else ("yes" if float(value) >= 1.0 else "no")


def _table(headers: list[str], rows: list[list[Any]]) -> str:
    if any(len(row) != len(headers) for row in rows):
        raise ValueError("backtest table row width does not match the header width")
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    lines.extend("| " + " | ".join(_fmt(cell) for cell in row) + " |" for row in rows)
    return "\n".join(lines)


def _text(values: Array) -> list[str]:
    if values.dtype.kind in {"S", "U"}:
        return values.astype(str).tolist()
    if np.issubdtype(values.dtype, np.datetime64):
        text = np.datetime_as_string(values, unit="s").astype(str)
        return np.char.replace(text, "T", " ").tolist()
    return values.tolist()


def _dates(values: Array) -> list[str]:
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
            ("snapshot_at", pa.string()),
            ("departure_date", pa.string()),
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
            for headroom in sorted(item.probabilities):
                writer.write_table(
                    pa.table(
                        {
                            "fold": [item.fold.name] * count,
                            "role": [item.fold.role] * count,
                            "series_key": _text(series),
                            "chain_id": _text(chain[order]),
                            "snapshot_at": _text(snapshot),
                            "departure_date": _dates(departure),
                            "ttd_band": bands[order].tolist(),
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
                ["average precision", _fmt(pooled.get("average_precision"))],
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
- Git: `{dataset_manifest.get("git_sha")}` (dirty: {dataset_manifest.get("git_dirty")})
- Silver build: `{dataset_manifest.get("silver_build_id")}`
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

> `BSS` is 1 - Brier / base-rate Brier; `BSS clim` is 1 - model Brier / fold-climatology Brier.

## Folds

{fold_table}

{spread_note}

## Development folds

Development folds choose the recipe and are the only folds PR 6 may select on. Their tables use
the same per-headroom diagnostic calibration as the evaluation tables.

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
it; they are not directly comparable with the pooled-calibrator headline.

{headroom_table}

## Per-headroom x TTD band

{headroom_ttd_table}

## Sparse-era folds

{sparse_table}

Sparse-era folds cover 24 h-7 d and are thin at the 5 % sample; read them as point estimates.
The 3-6 September snapshot gap is why sparse-0907 has fewer rows and very few 5-7 d test
positives.

The cutoffs straddle the late-July scrape-cadence ramp and the 14-21 July outage, so
{train_note} The 20 July cutoff is excluded by rule.

## Decision value

Decision value uses the 20-24 h crossed-back check on a subset of test rows; it is a diagnostic,
not a headline metric.

{decision_table}

## Warnings

{warnings}
"""


def _ci(values: Any, digits: int = 4) -> str:
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
        "warnings": dataset_manifest.get("warnings", []),
    }
    recipe_payload = {**result.recipe.payload(), "sha256": result.recipe.sha256()}
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
        path for path in (out_dir / "forward_predictions.parquet", out_dir / "forward_smoke.json") if path.is_file()
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
        "evaluated_blocks": list(result.evaluated_blocks),
        "runtime": runtime,
        "cache": {
            "dir": result.cache_dir,
            "enabled": result.cache_enabled,
            "code_sha": result.code_sha,
            "code_dirty": result.code_dirty,
            "recipe_from_cache": result.recipe_from_cache,
            "fold_cache_hits": result.fold_cache_hits,
            "folds_refit": result.folds_refit,
        },
        "git_dirty_end": dataset_manifest.get("git_dirty_end"),
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
