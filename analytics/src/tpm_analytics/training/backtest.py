"""Additive rolling-origin backtest protocol.

The dataset is built once; each fold selects rows by ``snapshot_at`` and ``label_window_end``. The
recipe is frozen on the development folds, then refitted on each evaluation fold without any
selection. Evaluation and sparse-era folds are scored only with ``--evaluate-test``.
"""

from __future__ import annotations

import hashlib
import json
import logging
import pickle
import time
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

import duckdb
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from tpm_analytics.silver._duck import sql_string
from tpm_analytics.training.config import FoldConfig, TrainingConfig
from tpm_analytics.training.dataset import DatasetError
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
    load_split,
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
    train: TabularData
    calibrate: TabularData
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
    warnings: tuple[str, ...] = ()
    runtime_seconds: float = 0.0
    peak_rss_kb: int = 0


def load_panel(out_dir: Path, spec: FeatureSpec) -> TabularData:
    parts = [
        load_split(out_dir / "dataset" / f"{name}.parquet", spec)
        for name in ("train", "validation_select", "validation_calibrate", "test")
    ]
    return concat_tabular(parts)


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
    oof = _cross_fitted(raw_cal, calibrate.y, calibrate.route_day, recipe.calibration, config)
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
                oof = _cross_fitted(raw, calibrate.y, calibrate.route_day, first_method, config)
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
            oof = _cross_fitted(raw, calibrate.y, calibrate.route_day, method, config)
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
    for name, block in (("calibrate", calibrate), ("test", test)):
        bands = _ttd_array(block)
        for band in sorted(set(bands.tolist())):
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
    raw_cal = model.predict(calibrate)
    oof_cal = _cross_fitted(raw_cal, calibrate.y, calibrate.route_day, recipe.calibration, config)
    calibrator = fit_calibrator(
        raw_cal,
        calibrate.y,
        recipe.calibration,
        min_positives=config.calibration.min_positives,
    )
    threshold, threshold_met = _threshold(calibrate.y, oof_cal, recipe.threshold_floor)
    raw = model.predict(test)
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
        raw_cal_headroom = model.predict(calibrate, headroom=headroom)
        y_cal = breach(calibrate.price_cents, calibrate.check_price_cents, headroom)
        calibrator_headroom = fit_calibrator(
            raw_cal_headroom,
            y_cal,
            recipe.calibration,
            min_positives=config.calibration.min_positives,
        )
        raw_headroom = model.predict(test, headroom=headroom)
        raw_probabilities[headroom] = raw_headroom
        probabilities[headroom] = calibrator_headroom.predict(raw_headroom)
        climate_by_headroom[headroom] = climatology.predict(test, headroom=headroom)
        labels[headroom] = breach(test.price_cents, test.check_price_cents, headroom)
    return FoldResult(
        fold=fold,
        train=train,
        calibrate=calibrate,
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
    label_sums = np.bincount(inverse, weights=labels, minlength=len(unique))
    counts = np.bincount(inverse, minlength=len(unique))
    rng = np.random.default_rng(seed)
    values: list[float] = []
    for _ in range(replicates):
        sampled = rng.integers(0, len(unique), size=len(unique))
        total = counts[sampled].sum()
        model_b = model_sums[sampled].sum() / total
        clim_b = clim_sums[sampled].sum() / total
        rate = label_sums[sampled].sum() / total
        reference = rate * (1.0 - rate)
        if reference <= 0:
            continue
        values.append((1.0 - model_b / reference) - (1.0 - clim_b / reference))
    if not values:
        return []
    return [float(np.percentile(values, 2.5)), float(np.percentile(values, 97.5))]


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
        for band in sorted(set(bands.tolist())):
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
                config.seed + headroom + len(band),
            )
            cell["headroom_pct"] = headroom
            cell["ttd_band"] = band
            headroom_ttd.append(cell)
    return headroom_rows, headroom_ttd


def _cache_paths(cache_dir: Path, fold: FoldConfig) -> tuple[Path, Path]:
    folder = cache_dir / "folds"
    folder.mkdir(parents=True, exist_ok=True)
    return folder / f"{fold.name}.pkl", folder / f"{fold.name}.json"


def _load_cached_fold(
    cache_dir: Path | None, fold: FoldConfig, recipe: Recipe, config: TrainingConfig
) -> FoldResult | None:
    if cache_dir is None:
        return None
    data_path, meta_path = _cache_paths(cache_dir, fold)
    if not data_path.is_file() or not meta_path.is_file():
        return None
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    if meta.get("recipe_sha256") != recipe.sha256() or meta.get("config_sha256") != config.hash():
        return None
    with data_path.open("rb") as handle:
        return pickle.load(handle)


def _save_cached_fold(
    cache_dir: Path | None,
    fold: FoldConfig,
    recipe: Recipe,
    config: TrainingConfig,
    result: FoldResult,
) -> None:
    if cache_dir is None:
        return
    data_path, meta_path = _cache_paths(cache_dir, fold)
    with data_path.open("wb") as handle:
        pickle.dump(result, handle)
    meta_path.write_text(
        json.dumps(
            {
                "fold": fold.name,
                "recipe_sha256": recipe.sha256(),
                "config_sha256": config.hash(),
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )


def run_backtest(
    panel: TabularData,
    config: TrainingConfig,
    spec: FeatureSpec,
    *,
    evaluate_test: bool,
    cache_dir: Path | None = None,
) -> BacktestResult:
    started = time.perf_counter()
    folds = scored_folds(config.protocol, evaluate_test=evaluate_test)
    if not folds:
        raise ModelError("no scored folds")
    _LOGGER.info("backtest: selecting recipe on development folds")
    recipe, development_models = select_recipe_bundle(panel, config, spec)
    _LOGGER.info("backtest: recipe %s / %s", recipe.model, recipe.calibration)
    results: list[FoldResult] = []
    for fold in folds:
        cached = _load_cached_fold(cache_dir, fold, recipe, config)
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
        _save_cached_fold(cache_dir, fold, recipe, config, result)
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
            "rows": len(item.test),
            "positive_rate": item.metrics.get("positive_rate"),
            "brier": item.metrics.get("brier"),
            "bss": item.metrics.get("bss"),
            "bss_climatology": item.bss_climatology,
            "bss_train": item.bss_train,
            "roc_auc": item.metrics.get("roc_auc"),
            "average_precision": item.metrics.get("average_precision"),
            "threshold": item.threshold,
            "alert_share": item.metrics.get("alert_share"),
            "runtime_seconds": item.runtime_seconds,
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
    return BacktestResult(
        recipe=recipe,
        folds=tuple(results),
        pooled=pooled_metrics,
        per_fold=per_fold,
        headroom=headroom_rows,
        headroom_ttd=headroom_ttd,
        sparse=[row for row in per_fold if row["role"] == "sparse_era"],
        decision_value=decision_value,
        evaluated_blocks=tuple(item.fold.name for item in results),
        warnings=tuple(warnings),
        runtime_seconds=time.perf_counter() - started,
        peak_rss_kb=0,
    )


def _fmt(value: Any, digits: int = 4) -> str:
    if value is None:
        return "—"
    if isinstance(value, float):
        return f"{value:.{digits}f}"
    return str(value)


def _p(value: Any) -> str:
    return "—" if value is None else f"{float(value):.1%}"


def _table(headers: list[str], rows: list[list[Any]]) -> str:
    if any(len(row) != len(headers) for row in rows):
        raise ValueError("backtest table row width does not match the header width")
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    lines.extend("| " + " | ".join(_fmt(cell) for cell in row) + " |" for row in rows)
    return "\n".join(lines)


def _prediction_table(result: BacktestResult) -> pa.Table:
    columns: dict[str, list[Any]] = {
        name: []
        for name in (
            "fold",
            "role",
            "series_key",
            "chain_id",
            "snapshot_at",
            "departure_date",
            "ttd_band",
            "assigned_headroom",
            "headroom_pct",
            "raw_score",
            "calibrated_score",
            "calibrated_score_pooled",
            "label",
            "fold_threshold",
        )
    }
    for item in result.folds:
        bands = _ttd_array(item.test)
        for headroom in sorted(item.probabilities):
            count = len(item.test)
            columns["fold"].extend([item.fold.name] * count)
            columns["role"].extend([item.fold.role] * count)
            columns["series_key"].extend(item.test.series.tolist())
            columns["chain_id"].extend(
                item.test.chain.tolist() if item.test.chain is not None else item.test.series.tolist()
            )
            columns["snapshot_at"].extend(item.test.snapshot_at.tolist())
            columns["departure_date"].extend(item.test.departure_date.tolist())
            columns["ttd_band"].extend(bands.tolist())
            columns["assigned_headroom"].extend(item.test.headroom.tolist())
            columns["headroom_pct"].extend([headroom] * count)
            columns["raw_score"].extend(item.raw_probabilities[headroom].tolist())
            columns["calibrated_score"].extend(item.probabilities[headroom].tolist())
            columns["calibrated_score_pooled"].extend(item.calibrated.tolist())
            columns["label"].extend(item.labels[headroom].tolist())
            columns["fold_threshold"].extend([item.threshold] * count)
    return pa.table(columns)


def _report(result: BacktestResult, config: TrainingConfig, dataset_manifest: dict[str, Any]) -> str:
    sparse = [row for row in result.per_fold if row["role"] == "sparse_era"]
    fold_rows = [
        [
            row["fold"],
            row["role"],
            row["cutoff"],
            row["rows"],
            _p(row.get("positive_rate")),
            _fmt(row.get("brier")),
            _fmt(row.get("bss")),
            _fmt(row.get("bss_climatology")),
            _fmt(row.get("roc_auc")),
            _fmt(row.get("average_precision")),
            _fmt(row.get("threshold")),
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
                ["BSS", _fmt(pooled.get("bss"))],
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
            ["headroom %", "prevalence", "Brier", "BSS", "BSS clim", "BSS diff CI", "AUC", "AP"],
            [
                [
                    item["headroom_pct"],
                    _p(item.get("positive_rate")),
                    _fmt(item.get("brier")),
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
            ["TTD band", "headroom %", "prevalence", "Brier", "BSS", "BSS clim", "BSS diff CI", "AUC", "AP"],
            [
                [
                    item["ttd_band"],
                    item["headroom_pct"],
                    _p(item.get("positive_rate")),
                    _fmt(item.get("brier")),
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
            ["fold", "TTD band", "rows", "alert share", "saving vs wait EUR", "saving vs book EUR"],
            [
                [
                    item.get("fold"),
                    item.get("band"),
                    item.get("rows"),
                    _p(item.get("alert_share")),
                    _fmt(item.get("saving_vs_always_wait_eur"), 2),
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
    interval_rows = [[name, _fmt(values[0]), _fmt(values[1])] for name, values in intervals.items() if len(values) == 2]
    interval_table = _table(["metric", "2.5 %", "97.5 %"], interval_rows) if interval_rows else ""
    warnings = "\n".join(f"- {warning}" for warning in result.warnings) or "- none"
    recipe_line = (
        f"- Recipe: model `{result.recipe.model}`, calibration `{result.recipe.calibration}`, "
        f"threshold floor {result.recipe.threshold_floor}"
    )
    fold_table = _table(
        [
            "fold",
            "role",
            "cutoff",
            "test rows",
            "prevalence",
            "Brier",
            "BSS",
            "BSS clim",
            "AUC",
            "AP",
            "threshold",
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
- Protocol: `backtest`; embargo {config.protocol.embargo_hours} h; block {config.protocol.block_days} d
{recipe_line}
- Recipe hash: `{result.recipe.sha256()}`
- Evaluated blocks: {", ".join(result.evaluated_blocks)}
- Wall: {result.runtime_seconds:.1f} s; peak RSS: {result.peak_rss_kb} KiB

**What is clean:** the evaluation weeks were part of earlier development, and the current recipe
was chosen with them in view. They are a fair yardstick for choices made from this protocol on.
The October-November forward set is the only untouched data.

## Folds

{fold_table}

## Pooled evaluation

{pooled_table}

{interval_table}

## Per-headroom

{headroom_table}

## Per-headroom x TTD band

{headroom_ttd_table}

## Sparse-era folds

{sparse_table}

Sparse-era folds cover 24 h-7 d and are thin at the 5 % sample; read them as point estimates.

## Decision value

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
    pq.write_table(_prediction_table(result), predictions_path, compression="zstd")
    dataset_manifest = json.loads((out_dir / "dataset_manifest.json").read_text(encoding="utf-8"))
    manifest_view = {
        "runner": runner,
        "git_sha": dataset_manifest.get("git_sha"),
        "git_dirty": dataset_manifest.get("git_dirty"),
        "git_untracked": dataset_manifest.get("git_untracked", []),
        "silver_build_id": dataset_manifest.get("silver_build_id"),
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
        "decision_value": result.decision_value,
        "warnings": list(result.warnings),
        "runtime_seconds": result.runtime_seconds,
        "peak_rss_kb": result.peak_rss_kb,
    }
    (out_dir / "backtest.json").write_text(
        json.dumps(backtest_payload, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8"
    )
    (out_dir / "report.md").write_text(_report(result, config, manifest_view), encoding="utf-8")
    artifacts = [predictions_path, out_dir / "recipe.json", out_dir / "backtest.json", out_dir / "report.md"]
    runtime = runtime or {}
    manifest = {
        "runner": runner,
        "git_sha": dataset_manifest.get("git_sha"),
        "git_dirty": dataset_manifest.get("git_dirty"),
        "git_untracked": dataset_manifest.get("git_untracked", []),
        "silver_build_id": dataset_manifest.get("silver_build_id"),
        "recipe_sha256": result.recipe.sha256(),
        "evaluated_blocks": list(result.evaluated_blocks),
        "runtime": runtime,
        "artifacts": {
            path.relative_to(out_dir).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in artifacts
        },
        "warnings": list(result.warnings),
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return {
        "run_id": out_dir.name,
        "rows": len(result.folds[-1].test) if result.folds else 0,
        "evaluated_blocks": list(result.evaluated_blocks),
        "recipe": recipe_payload,
        "pooled_brier": result.pooled.get("brier"),
        "pooled_bss": result.pooled.get("bss"),
        "runtime": runtime,
    }
