"""Model comparison, calibration and evaluation for the baseline.

No pandas: DuckDB returns numpy arrays, the feature spec keeps an allowlist, and every candidate
uses the same ordinal matrix. Calibration is fitted on validation-calibrate only, never on the
selection slice or the test set.
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import duckdb
import numpy as np
from numpy.typing import NDArray
from scipy.optimize import minimize_scalar
from scipy.special import expit
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    average_precision_score,
    brier_score_loss,
    log_loss,
    precision_recall_curve,
    roc_auc_score,
)
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, OrdinalEncoder, StandardScaler

from tpm_analytics.silver._duck import sql_string
from tpm_analytics.training.config import TrainingConfig
from tpm_analytics.training.features import BOOLEAN, CATEGORICAL, NUMERIC, FeatureSpec

Array = NDArray[Any]


class ModelError(RuntimeError):
    """The model matrix or a candidate cannot be trained."""


@dataclass(frozen=True)
class TabularData:
    features: dict[str, Array]
    y: Array
    series: Array
    route_day: Array
    price: Array
    future_max: Array
    future_observations: Array
    headroom: Array
    departure_date: Array

    def __len__(self) -> int:
        return len(self.y)

    def subset(self, indices: Array) -> TabularData:
        return TabularData(
            features={name: values[indices] for name, values in self.features.items()},
            y=self.y[indices],
            series=self.series[indices],
            route_day=self.route_day[indices],
            price=self.price[indices],
            future_max=self.future_max[indices],
            future_observations=self.future_observations[indices],
            headroom=self.headroom[indices],
            departure_date=self.departure_date[indices],
        )

    def select(self, names: tuple[str, ...]) -> TabularData:
        return TabularData(
            features={name: self.features[name] for name in names},
            y=self.y,
            series=self.series,
            route_day=self.route_day,
            price=self.price,
            future_max=self.future_max,
            future_observations=self.future_observations,
            headroom=self.headroom,
            departure_date=self.departure_date,
        )


def _filled(values: Any, fill: float) -> Array:
    if isinstance(values, np.ma.MaskedArray):
        return np.asarray(values.astype(np.float32).filled(fill), dtype=np.float32)
    return np.asarray(values, dtype=np.float32)


def _categorical(values: Any) -> Array:
    if isinstance(values, np.ma.MaskedArray):
        values = values.astype(object).filled("__missing__")
    array = np.asarray(values, dtype=object)
    flat = [
        "__missing__" if value is None or (isinstance(value, float) and np.isnan(value)) else str(value)
        for value in array.ravel()
    ]
    return np.asarray(flat, dtype=object).reshape(array.shape)


def load_split(path: Path, spec: FeatureSpec) -> TabularData:
    """Load a Parquet split into numpy arrays, preserving nulls as NaN/missing categories."""
    columns = ", ".join(
        (
            *spec.names,
            "breached_in_24h",
            "series_key",
            "route_id || '|' || CAST(departure_date AS VARCHAR) AS route_day",
            "price_eur",
            "future_max_fare_24h",
            "future_observations",
            "headroom_pct",
            "departure_date",
            "snapshot_at",
            "bin_regime",
            "bin_index",
        )
    )
    connection = duckdb.connect()
    try:
        rows = connection.execute(
            f"SELECT {columns} FROM read_parquet('{sql_string(path.as_posix())}') "
            "WHERE label_observed "
            "ORDER BY series_key, snapshot_at, bin_regime, bin_index"
        ).fetchnumpy()
    finally:
        connection.close()
    if len(rows["breached_in_24h"]) == 0:
        raise ModelError(f"{path} has no labelled rows")
    features: dict[str, Array] = {}
    for feature in spec.features:
        values = rows[feature.name]
        if feature.kind == CATEGORICAL:
            features[feature.name] = _categorical(values)
        elif feature.kind == BOOLEAN:
            features[feature.name] = _filled(values, 0.0)
        else:
            features[feature.name] = _filled(values, np.nan)
    future_max = _filled(rows["future_max_fare_24h"], np.nan)
    if np.isnan(future_max).any():
        raise ModelError(f"{path} has labelled rows with no future maximum")
    return TabularData(
        features=features,
        y=np.asarray(rows["breached_in_24h"], dtype=np.int8),
        series=np.asarray(rows["series_key"], dtype=str),
        route_day=np.asarray(rows["route_day"], dtype=str),
        price=_filled(rows["price_eur"], np.nan),
        future_max=future_max,
        future_observations=np.asarray(rows["future_observations"], dtype=np.int16),
        headroom=np.asarray(rows["headroom_pct"], dtype=np.int16),
        departure_date=np.asarray(rows["departure_date"], dtype=str),
    )


def _cat_matrix(data: TabularData, spec: FeatureSpec) -> Array:
    categories = [data.features[feature.name] for feature in spec.features if feature.kind == CATEGORICAL]
    if not categories:
        raise ModelError("the feature spec has no categorical columns")
    return np.column_stack(categories)


def fit_encoder(data: TabularData, spec: FeatureSpec) -> OrdinalEncoder:
    encoder = OrdinalEncoder(
        handle_unknown="use_encoded_value",
        unknown_value=-1,
        encoded_missing_value=-1,
    )
    encoder.fit(_cat_matrix(data, spec))
    return encoder


def _matrix(data: TabularData, spec: FeatureSpec, encoder: OrdinalEncoder, headroom: int | None = None) -> Array:
    cat = encoder.transform(_cat_matrix(data, spec)).astype(np.float32) + 1.0
    cat[cat < 1] = 0.0
    cat_lookup = {
        feature.name: cat[:, index]
        for index, feature in enumerate(feature for feature in spec.features if feature.kind == CATEGORICAL)
    }
    columns: list[Array] = []
    for feature in spec.features:
        if feature.kind == CATEGORICAL:
            columns.append(cat_lookup[feature.name])
        elif feature.name == "headroom_pct" and headroom is not None:
            columns.append(np.full(len(data), float(headroom), dtype=np.float32))
        elif feature.kind == BOOLEAN:
            columns.append(np.asarray(data.features[feature.name], dtype=np.float32))
        else:
            columns.append(np.asarray(data.features[feature.name], dtype=np.float32))
    return np.column_stack(columns).astype(np.float32, copy=False)


def _indices(spec: FeatureSpec, kinds: tuple[str, ...]) -> list[int]:
    return [index for index, feature in enumerate(spec.features) if feature.kind in kinds]


def _usable_columns(
    matrix: Array,
    categorical: list[int],
    names: tuple[str, ...],
) -> tuple[tuple[int, ...], tuple[str, ...]]:
    """Drop columns with no usable split; HistGB cannot bin a constant/all-null feature."""
    usable: list[int] = []
    dropped: list[str] = []
    categorical_set = set(categorical)
    for index in range(matrix.shape[1]):
        column = matrix[:, index]
        values = column if index in categorical_set else column[~np.isnan(column)]
        if np.unique(values).size >= 2:
            usable.append(index)
        else:
            dropped.append(names[index])
    return tuple(usable), tuple(dropped)


@dataclass
class FittedModel:
    name: str
    estimator: Any
    encoder: OrdinalEncoder
    spec: FeatureSpec
    selected: tuple[int, ...] | None = None
    dropped: tuple[str, ...] = ()

    def predict(self, data: TabularData, headroom: int | None = None) -> Array:
        matrix = _matrix(data, self.spec, self.encoder, headroom)
        if self.selected is not None:
            matrix = matrix[:, list(self.selected)]
        probabilities = self.estimator.predict_proba(matrix)[:, 1]
        return np.asarray(probabilities, dtype=np.float64)


class BaseRateModel:
    def __init__(self, rate: float) -> None:
        self.rate = float(rate)

    def predict_proba(self, matrix: Array) -> Array:
        return np.column_stack([np.full(len(matrix), 1.0 - self.rate), np.full(len(matrix), self.rate)])


def fit_candidate(name: str, data: TabularData, spec: FeatureSpec, config: TrainingConfig) -> FittedModel:
    encoder = fit_encoder(data, spec)
    matrix = _matrix(data, spec, encoder)
    if name == "base_rate":
        estimator: Any = BaseRateModel(float(np.mean(data.y)))
    elif name == "logistic":
        numeric = _indices(spec, (NUMERIC, BOOLEAN))
        categorical = _indices(spec, (CATEGORICAL,))
        preprocess = ColumnTransformer(
            [
                (
                    "numeric",
                    Pipeline(
                        [
                            ("impute", SimpleImputer(strategy="median", add_indicator=True, keep_empty_features=True)),
                            ("scale", StandardScaler()),
                        ]
                    ),
                    numeric,
                ),
                (
                    "categorical",
                    OneHotEncoder(handle_unknown="ignore", sparse_output=False, dtype=np.float32),
                    categorical,
                ),
            ]
        )
        estimator = Pipeline(
            [
                ("preprocess", preprocess),
                (
                    "classifier",
                    LogisticRegression(
                        max_iter=config.model.max_iter,
                        random_state=config.model.random_state,
                    ),
                ),
            ]
        )
        estimator.fit(matrix, data.y)
    elif name == "hist_gradient_boosting":
        categorical = _indices(spec, (CATEGORICAL,))
        selected, dropped = _usable_columns(matrix, categorical, spec.names)
        if not selected:
            raise ModelError("no feature has two distinct values")
        remapped = [position for position, index in enumerate(selected) if index in set(categorical)]
        monotonic = [0] * len(selected)
        headroom_index = spec.names.index("headroom_pct")
        if headroom_index in selected:
            monotonic[selected.index(headroom_index)] = -1
        estimator = HistGradientBoostingClassifier(
            max_iter=config.model.max_iter,
            learning_rate=config.model.learning_rate,
            max_leaf_nodes=config.model.max_leaf_nodes,
            early_stopping=False,
            categorical_features=remapped,
            monotonic_cst=monotonic,
            random_state=config.model.random_state,
        )
        estimator.fit(matrix[:, list(selected)], data.y)
        return FittedModel(
            name=name,
            estimator=estimator,
            encoder=encoder,
            spec=spec,
            selected=selected,
            dropped=dropped,
        )
    elif name == "lightgbm":
        try:
            lightgbm = importlib.import_module("lightgbm")
        except ImportError as error:
            raise ModelError(
                "lightgbm is not installed; install it separately, it is not in the train group"
            ) from error
        LGBMClassifier = lightgbm.LGBMClassifier
        estimator = LGBMClassifier(
            n_estimators=config.model.max_iter,
            learning_rate=config.model.learning_rate,
            num_leaves=config.model.max_leaf_nodes,
            random_state=config.model.random_state,
            monotone_constraints=[-1 if feature.name == "headroom_pct" else 0 for feature in spec.features],
            verbosity=-1,
        )
        estimator.fit(matrix, data.y)
    else:
        raise ModelError(f"unknown model {name!r}")
    return FittedModel(name=name, estimator=estimator, encoder=encoder, spec=spec)


class ScoreCalibrator:
    """A calibrator over raw probabilities, fitted on a held-out slice."""

    def __init__(self, method: str, model: Any, temperature: float | None = None) -> None:
        self.method = method
        self.model = model
        self.temperature = temperature

    def predict(self, raw: Array) -> Array:
        clipped = np.clip(raw, 1e-6, 1.0 - 1e-6)
        if self.method == "temperature":
            if self.temperature is None:
                raise ModelError("temperature calibrator has no fitted temperature")
            logits = np.log(clipped / (1.0 - clipped))
            values = expit(logits / float(self.temperature))
        elif self.method == "isotonic":
            values = self.model.predict(clipped)
        else:
            values = self.model.predict_proba(clipped.reshape(-1, 1))[:, 1]
        return np.asarray(np.clip(values, 1e-3, 1.0 - 1e-3), dtype=np.float64)


def fit_calibrator(raw: Array, y: Array, method: str, *, min_positives: int) -> ScoreCalibrator:
    clipped = np.clip(raw, 1e-6, 1.0 - 1e-6)
    positives = int(np.sum(y))
    if method == "isotonic" and positives < min_positives:
        method = "sigmoid"
    if method == "sigmoid":
        model = LogisticRegression(C=1e6, solver="lbfgs", max_iter=1000)
        model.fit(clipped.reshape(-1, 1), y)
        return ScoreCalibrator("sigmoid", model)
    if method == "isotonic":
        model = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
        model.fit(clipped, y)
        return ScoreCalibrator("isotonic", model)
    if method == "temperature":
        logits = np.log(clipped / (1.0 - clipped))

        def loss(log_temperature: float) -> float:
            probabilities = np.clip(expit(logits / np.exp(log_temperature)), 1e-9, 1.0 - 1e-9)
            return float(-np.mean(y * np.log(probabilities) + (1 - y) * np.log(1.0 - probabilities)))

        result = minimize_scalar(loss, bounds=(-3.0, 3.0), method="bounded")
        return ScoreCalibrator("temperature", None, float(np.exp(result.x)))
    raise ModelError(f"unknown calibration method {method!r}")


def _metric_value(value: float | None, default: float = 1.0) -> float:
    return default if value is None else float(value)


def _metrics(y: Array, probabilities: Array) -> dict[str, float | None]:
    clipped = np.clip(probabilities, 1e-9, 1.0 - 1e-9)
    both = len(np.unique(y)) == 2
    brier = float(brier_score_loss(y, clipped))
    base_rate = float(np.mean(y))
    reference = base_rate * (1.0 - base_rate)
    return {
        "brier": brier,
        "log_loss": float(log_loss(y, clipped, labels=[0, 1])),
        "bss": 1.0 - brier / reference if reference > 0 else None,
        "roc_auc": float(roc_auc_score(y, clipped)) if both else None,
        "average_precision": float(average_precision_score(y, clipped)) if both else None,
        "positive_rate": base_rate,
    }


def _cross_fitted(raw: Array, y: Array, groups: Array, method: str, config: TrainingConfig) -> Array:
    unique = np.unique(groups)
    folds = min(config.calibration.folds, len(unique))
    if folds < 2:
        return fit_calibrator(raw, y, method, min_positives=config.calibration.min_positives).predict(raw)
    splitter = GroupKFold(n_splits=folds)
    predicted = np.full(len(raw), np.nan, dtype=np.float64)
    for fit_idx, predict_idx in splitter.split(raw, y, groups):
        calibrator = fit_calibrator(
            raw[fit_idx],
            y[fit_idx],
            method,
            min_positives=config.calibration.min_positives,
        )
        predicted[predict_idx] = calibrator.predict(raw[predict_idx])
    if np.isnan(predicted).any():
        raise ModelError("cross-fitted calibration left rows without a prediction")
    return predicted


@dataclass(frozen=True)
class Evaluation:
    chosen_model: str
    calibration_method: str
    threshold: float
    threshold_precision_floor_met: bool
    candidates: dict[str, dict[str, float | None]]
    test: dict[str, Any]
    test_all: dict[str, Any] | None
    test_tier: str
    test_tier_rows: int
    evaluation_split: str
    test_evaluated: bool
    calibration_prevalence: float
    dropped_features: tuple[str, ...]
    calibration: tuple[Array, Array, Array]
    headroom: tuple[dict[str, Any], ...]
    importance: tuple[dict[str, Any], ...]
    bootstrap: dict[str, list[float]]
    split_sizes: dict[str, int]

    def to_dict(self) -> dict[str, Any]:
        return {
            "chosen_model": self.chosen_model,
            "calibration_method": self.calibration_method,
            "threshold": self.threshold,
            "threshold_precision_floor_met": self.threshold_precision_floor_met,
            "candidates": self.candidates,
            "test": self.test,
            "test_all": self.test_all,
            "test_tier": self.test_tier,
            "test_tier_rows": self.test_tier_rows,
            "evaluation_split": self.evaluation_split,
            "test_evaluated": self.test_evaluated,
            "calibration_prevalence": self.calibration_prevalence,
            "dropped_features": list(self.dropped_features),
            "calibration": {
                "prob_pred": [float(value) for value in self.calibration[0]],
                "prob_true": [float(value) for value in self.calibration[1]],
                "counts": [int(value) for value in self.calibration[2]],
            },
            "headroom": list(self.headroom),
            "importance": list(self.importance),
            "bootstrap": self.bootstrap,
            "split_sizes": self.split_sizes,
        }


def _threshold(y: Array, probabilities: Array, floor: float) -> tuple[float, bool]:
    precision, recall, thresholds = precision_recall_curve(y, probabilities)
    eligible = np.where(precision[:-1] >= floor)[0]
    if len(eligible):
        best = eligible[np.argmax(recall[eligible])]
        return float(thresholds[best]), True
    if len(thresholds):
        f1 = 2.0 * precision[:-1] * recall[:-1] / np.maximum(precision[:-1] + recall[:-1], 1e-12)
        return float(thresholds[int(np.argmax(f1))]), False
    return 0.5, False


def _decision_metrics(y: Array, probabilities: Array, threshold: float) -> dict[str, float]:
    predicted = probabilities >= threshold
    true_positive = int(np.sum((predicted == 1) & (y == 1)))
    false_positive = int(np.sum((predicted == 1) & (y == 0)))
    false_negative = int(np.sum((predicted == 0) & (y == 1)))
    precision = true_positive / max(true_positive + false_positive, 1)
    recall = true_positive / max(true_positive + false_negative, 1)
    return {"precision_at_threshold": float(precision), "recall_at_threshold": float(recall)}


def _calibration_curve(y: Array, probabilities: Array, bins: int) -> tuple[Array, Array, Array]:
    """Quantile bins with predicted/observed/count from the same bin edges."""
    edges = np.unique(np.quantile(probabilities, np.linspace(0.0, 1.0, bins + 1)))
    if len(edges) < 2:
        return (
            np.asarray([float(np.mean(probabilities))]),
            np.asarray([float(np.mean(y))]),
            np.asarray([len(y)]),
        )
    index = np.clip(np.searchsorted(edges[1:-1], probabilities, side="right"), 0, len(edges) - 2)
    counts = np.bincount(index, minlength=len(edges) - 1)
    predicted = np.bincount(index, weights=probabilities, minlength=len(edges) - 1)
    observed = np.bincount(index, weights=y, minlength=len(edges) - 1)
    non_empty = counts > 0
    return (
        np.asarray(predicted[non_empty] / counts[non_empty]),
        np.asarray(observed[non_empty] / counts[non_empty]),
        counts[non_empty].astype(np.int64),
    )


def _permutation_importance(
    model: FittedModel,
    calibrator: ScoreCalibrator,
    data: TabularData,
    spec: FeatureSpec,
    *,
    seed: int,
    sample: int = 5_000,
    repeats: int = 2,
) -> tuple[dict[str, Any], ...]:
    """Brier increase from shuffling one feature in the deployed calibrated pipeline."""
    rng = np.random.default_rng(seed)
    if len(data) > sample:
        indices = rng.choice(len(data), size=sample, replace=False)
        data = data.subset(indices)
    baseline = float(brier_score_loss(data.y, np.clip(calibrator.predict(model.predict(data)), 1e-9, 1.0 - 1e-9)))
    scores: list[dict[str, Any]] = []
    for feature in spec.features:
        values = np.asarray(data.features[feature.name]).copy()
        increases: list[float] = []
        for _ in range(repeats):
            rng.shuffle(values)
            shuffled = TabularData(
                features={**data.features, feature.name: values},
                y=data.y,
                series=data.series,
                route_day=data.route_day,
                price=data.price,
                future_max=data.future_max,
                future_observations=data.future_observations,
                headroom=data.headroom,
                departure_date=data.departure_date,
            )
            probabilities = np.clip(calibrator.predict(model.predict(shuffled)), 1e-9, 1.0 - 1e-9)
            increases.append(float(brier_score_loss(data.y, probabilities)) - baseline)
        scores.append({"feature": feature.name, "importance": float(np.mean(increases))})
    return tuple(sorted(scores, key=lambda item: item["importance"], reverse=True))


def _bootstrap(y: Array, probabilities: Array, groups: Array, replicates: int, seed: int) -> dict[str, list[float]]:
    """Grouped bootstrap over the configured cluster, using per-cluster sufficient statistics.

    Concatenating row indices for every replicate is O(rows x replicates); this version is
    O(clusters x replicates) and gives the same weighted Brier/log-loss.
    """
    unique, inverse = np.unique(groups, return_inverse=True)
    clipped = np.clip(probabilities, 1e-9, 1.0 - 1e-9)
    brier_sum = np.bincount(inverse, weights=(clipped - y) ** 2, minlength=len(unique))
    logloss_sum = np.bincount(
        inverse,
        weights=-(y * np.log(clipped) + (1 - y) * np.log(1.0 - clipped)),
        minlength=len(unique),
    )
    counts = np.bincount(inverse, minlength=len(unique))
    rng = np.random.default_rng(seed)
    brier: list[float] = []
    logloss: list[float] = []
    for _ in range(replicates):
        sampled = rng.integers(0, len(unique), size=len(unique))
        total = counts[sampled].sum()
        brier.append(float(brier_sum[sampled].sum() / total))
        logloss.append(float(logloss_sum[sampled].sum() / total))
    return {
        "brier": [float(np.percentile(brier, 2.5)), float(np.percentile(brier, 97.5))],
        "log_loss": [float(np.percentile(logloss, 2.5)), float(np.percentile(logloss, 97.5))],
    }


def train_and_evaluate(
    splits: dict[str, TabularData],
    spec: FeatureSpec,
    config: TrainingConfig,
    *,
    evaluate_test: bool = False,
) -> tuple[Evaluation, dict[str, FittedModel], ScoreCalibrator]:
    train = splits["train"]
    validation_select = splits["validation_select"]
    validation_calibrate = splits["validation_calibrate"]
    test = splits["test"]
    series_sets = {name: set(data.series.tolist()) for name, data in splits.items()}
    names = list(series_sets)
    for index, left in enumerate(names):
        for right in names[index + 1 :]:
            overlap = series_sets[left] & series_sets[right]
            if overlap:
                raise ModelError(f"series crosses splits {left}/{right}: {next(iter(overlap))}")
    candidates: dict[str, FittedModel] = {}
    candidate_metrics: dict[str, dict[str, float | None]] = {}
    for name in config.model.candidates:
        model = fit_candidate(name, train, spec, config)
        candidates[name] = model
        raw = model.predict(validation_select)
        if name == "base_rate":
            candidate_metrics[name] = _metrics(validation_select.y, raw)
        else:
            calibrated = _cross_fitted(
                raw,
                validation_select.y,
                validation_select.route_day,
                next(iter(config.calibration.methods)),
                config,
            )
            candidate_metrics[name] = _metrics(validation_select.y, calibrated)

    logistic = candidate_metrics.get("logistic")
    best = min(candidate_metrics, key=lambda name: _metric_value(candidate_metrics[name]["brier"]))
    chosen = best
    if best != "logistic" and logistic is not None:
        margin = max(0.002, 0.02 * _metric_value(logistic["brier"], 0.0))
        tree = candidate_metrics[best]
        pr_gain = _metric_value(tree["average_precision"], 0.0) - _metric_value(logistic["average_precision"], 0.0)
        if _metric_value(tree["brier"]) > _metric_value(logistic["brier"]) - margin and pr_gain < 0.01:
            chosen = "logistic"
    if (
        "base_rate" in candidate_metrics
        and chosen == "logistic"
        and logistic is not None
        and _metric_value(logistic["brier"]) > _metric_value(candidate_metrics["base_rate"]["brier"]) - 0.001
    ):
        chosen = "base_rate"

    model = candidates[chosen]
    cal_evidence = validation_calibrate.future_observations >= 2
    cal_data = validation_calibrate.subset(cal_evidence) if int(cal_evidence.sum()) >= 100 else validation_calibrate
    raw_cal = model.predict(cal_data)
    method_scores: dict[str, dict[str, float | None]] = {}
    oof_predictions: dict[str, Array] = {}
    for method in config.calibration.methods:
        oof = _cross_fitted(
            raw_cal,
            cal_data.y,
            cal_data.route_day,
            method,
            config,
        )
        oof_predictions[method] = oof
        method_scores[method] = _metrics(cal_data.y, oof)
    requested_method = min(method_scores, key=lambda name: float(method_scores[name]["brier"] or 1.0))
    calibrator = fit_calibrator(
        raw_cal,
        cal_data.y,
        requested_method,
        min_positives=config.calibration.min_positives,
    )
    threshold, threshold_met = _threshold(
        cal_data.y,
        oof_predictions[requested_method],
        config.report.threshold_precision_floor,
    )
    calibration_method = calibrator.method

    eval_data = test if evaluate_test else cal_data
    evaluation_split = "test" if evaluate_test else "validation_calibrate"
    test_all = None
    if evaluate_test:
        raw_cal_all = model.predict(validation_calibrate)
        all_calibrator = fit_calibrator(
            raw_cal_all,
            validation_calibrate.y,
            calibration_method,
            min_positives=config.calibration.min_positives,
        )
        test_all = _metrics(test.y, all_calibrator.predict(model.predict(test)))

    evidence = eval_data.future_observations >= 2
    evidence_rows = int(evidence.sum())
    if evidence_rows >= 100:
        eval_rows = eval_data.subset(evidence)
        test_tier = "two_plus_observations"
    else:
        eval_rows = eval_data
        test_tier = "all_labelled_rows"
    test_tier_rows = len(eval_rows)
    calibrated_eval = (
        calibrator.predict(model.predict(eval_rows))
        if evaluate_test
        else (
            oof_predictions[requested_method][evidence]
            if len(eval_rows) != len(cal_data)
            else oof_predictions[requested_method]
        )
    )
    test_metrics = _metrics(eval_rows.y, calibrated_eval)
    train_rate = float(np.mean(train.y))
    reference = float(np.mean((eval_rows.y - train_rate) ** 2))
    test_metrics["bss_train"] = 1.0 - _metric_value(test_metrics["brier"]) / reference if reference > 0 else None
    test_metrics["threshold"] = threshold
    test_metrics.update(_decision_metrics(eval_rows.y, calibrated_eval, threshold))
    test_metrics["precision_floor_met_on_evaluation"] = bool(
        _metric_value(test_metrics["precision_at_threshold"], 0.0) >= config.report.threshold_precision_floor
    )
    test_metrics["headroom_monotonic"] = bool(
        all(
            np.all(model.predict(eval_rows, headroom=left) >= model.predict(eval_rows, headroom=right))
            for left, right in zip(config.label.headroom_pct, config.label.headroom_pct[1:], strict=False)
        )
    )

    headroom = []
    for value in config.label.headroom_pct:
        y_headroom = (eval_rows.future_max >= eval_rows.price * (1.0 + value / 100.0)).astype(np.int8)
        probabilities = calibrator.predict(model.predict(eval_rows, headroom=value))
        item = _metrics(y_headroom, probabilities)
        item["headroom_pct"] = value
        item["mean_probability"] = float(np.mean(probabilities))
        item["calibration_gap"] = float(np.mean(probabilities) - np.mean(y_headroom))
        decisions = _decision_metrics(y_headroom, probabilities, threshold)
        item["precision_at_threshold"] = decisions["precision_at_threshold"]
        item["recall_at_threshold"] = decisions["recall_at_threshold"]
        train_headroom = train.y[train.headroom == value]
        train_rate_h = float(np.mean(train_headroom)) if len(train_headroom) else train_rate
        reference_h = float(np.mean((y_headroom - train_rate_h) ** 2))
        item["bss_train"] = 1.0 - item["brier"] / reference_h if reference_h > 0 and item["brier"] is not None else None
        headroom.append(item)

    prob_pred, prob_true, counts = _calibration_curve(eval_rows.y, calibrated_eval, config.report.calibration_bins)
    groups = eval_rows.departure_date if config.report.bootstrap_cluster == "departure_date" else eval_rows.route_day
    bootstrap = _bootstrap(
        eval_rows.y,
        calibrated_eval,
        groups,
        config.report.bootstrap_replicates,
        config.seed,
    )
    importance = _permutation_importance(model, calibrator, validation_select, spec, seed=config.seed)
    evaluation = Evaluation(
        chosen_model=chosen,
        calibration_method=calibration_method,
        threshold=threshold,
        threshold_precision_floor_met=threshold_met,
        candidates=candidate_metrics,
        test=test_metrics,
        test_all=test_all,
        test_tier=test_tier,
        test_tier_rows=test_tier_rows,
        evaluation_split=evaluation_split,
        test_evaluated=evaluate_test,
        calibration_prevalence=float(np.mean(cal_data.y)),
        dropped_features=tuple(sorted({name for fitted in candidates.values() for name in fitted.dropped})),
        calibration=(prob_pred, prob_true, counts),
        headroom=tuple(headroom),
        importance=importance,
        bootstrap=bootstrap,
        split_sizes={name: len(data) for name, data in splits.items()},
    )
    return evaluation, candidates, calibrator
