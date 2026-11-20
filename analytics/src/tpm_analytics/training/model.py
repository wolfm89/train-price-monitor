"""Model comparison, calibration and evaluation for the baseline.

No pandas: DuckDB returns numpy arrays, the feature spec keeps an allowlist, and every candidate
uses the same ordinal matrix. Calibration is fitted on validation-calibrate only, never on the
selection slice or the test set.
"""

from __future__ import annotations

import hashlib
import importlib
import itertools
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import duckdb
import joblib
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
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
from tpm_analytics.training.bands import CLIMATOLOGY_BANDS, band_labels, ttd_band
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
    snapshot_at: Array
    observation_era: Array
    observation_week: Array
    check_price: Array

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
            snapshot_at=self.snapshot_at[indices],
            observation_era=self.observation_era[indices],
            observation_week=self.observation_week[indices],
            check_price=self.check_price[indices],
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
            snapshot_at=self.snapshot_at,
            observation_era=self.observation_era,
            observation_week=self.observation_week,
            check_price=self.check_price,
        )


def _train_prevalence(train: TabularData, tier: str) -> float:
    """Event rate on the same population as the evaluated tier."""
    rows = train.subset(train.future_observations >= 2) if tier == "two_plus_observations" else train
    return float(np.mean(rows.y)) if len(rows) else float("nan")


def _bss_train(brier: float | None, labels: Array, train_rate: float) -> float | None:
    """Brier skill against a constant predictor at the matching train prevalence."""
    if brier is None:
        return None
    reference = float(np.mean((labels - train_rate) ** 2))
    return 1.0 - float(brier) / reference if reference > 0 else None


def _filled(values: Any, fill: float) -> Array:
    if isinstance(values, np.ma.MaskedArray):
        return np.asarray(values.astype(np.float32).filled(fill), dtype=np.float32)
    return np.asarray(values, dtype=np.float32)


def _filled64(values: Any, fill: float) -> Array:
    if isinstance(values, np.ma.MaskedArray):
        return np.asarray(values.astype(np.float64).filled(fill), dtype=np.float64)
    return np.asarray(values, dtype=np.float64)


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
            "observation_era",
            "strftime(snapshot_at, '%G-W%V') AS observation_week",
            "check_price_eur",
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
    future_max = _filled64(rows["future_max_fare_24h"], np.nan)
    if np.isnan(future_max).any():
        raise ModelError(f"{path} has labelled rows with no future maximum")
    return TabularData(
        features=features,
        y=np.asarray(rows["breached_in_24h"], dtype=np.int8),
        series=np.asarray(rows["series_key"], dtype=str),
        route_day=np.asarray(rows["route_day"], dtype=str),
        price=_filled64(rows["price_eur"], np.nan),
        future_max=future_max,
        future_observations=np.asarray(rows["future_observations"], dtype=np.int16),
        headroom=np.asarray(rows["headroom_pct"], dtype=np.int16),
        departure_date=np.asarray(rows["departure_date"], dtype=str),
        snapshot_at=np.asarray(rows["snapshot_at"], dtype=str),
        observation_era=_categorical(rows["observation_era"]),
        observation_week=_categorical(rows["observation_week"]),
        check_price=_filled64(rows["check_price_eur"], np.nan),
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


@dataclass(frozen=True)
class ClimatologyModel:
    """Smoothed train prevalence by TTD band, headroom and service class."""

    cells: dict[tuple[str, int, str], float]
    band_headroom: dict[tuple[str, int], float]
    headroom: dict[int, float]
    global_rate: float

    def predict(self, data: TabularData, headroom: int | None = None) -> Array:
        hours = np.asarray(data.features["hours_to_departure"], dtype=np.float64)
        bands = [ttd_band(float(value), CLIMATOLOGY_BANDS) for value in hours]
        heads = data.headroom if headroom is None else np.full(len(data), int(headroom), dtype=np.int16)
        classes = np.asarray(data.features["service_class"], dtype=str)
        values = np.empty(len(data), dtype=np.float64)
        for index, (band, head, service_class) in enumerate(zip(bands, heads, classes, strict=True)):
            key = (band, int(head), str(service_class))
            values[index] = self.cells.get(
                key,
                self.band_headroom.get(
                    (band, int(head)),
                    self.headroom.get(int(head), self.global_rate),
                ),
            )
        return values


def fit_climatology(data: TabularData, *, strength: float = 50.0) -> ClimatologyModel:
    """Fit a hierarchical prevalence baseline with a Beta-style prior on thin cells."""
    hours = np.asarray(data.features["hours_to_departure"], dtype=np.float64)
    bands = [ttd_band(float(value), CLIMATOLOGY_BANDS) for value in hours]
    heads = np.asarray(data.headroom, dtype=np.int64)
    classes = np.asarray(data.features["service_class"], dtype=str)
    global_count = len(data)
    global_positives = int(np.sum(data.y))
    global_rate = (global_positives + 1.0) / (global_count + 2.0)
    head_counts: dict[int, list[int]] = {}
    band_counts: dict[tuple[str, int], list[int]] = {}
    cell_counts: dict[tuple[str, int, str], list[int]] = {}
    for band, head, service_class, target in zip(bands, heads, classes, data.y, strict=True):
        head_counts.setdefault(int(head), [0, 0])
        head_counts[int(head)][0] += 1
        head_counts[int(head)][1] += int(target)
        band_counts.setdefault((band, int(head)), [0, 0])
        band_counts[(band, int(head))][0] += 1
        band_counts[(band, int(head))][1] += int(target)
        cell_counts.setdefault((band, int(head), str(service_class)), [0, 0])
        cell_counts[(band, int(head), str(service_class))][0] += 1
        cell_counts[(band, int(head), str(service_class))][1] += int(target)
    head_rate = {
        head: (positive + strength * global_rate) / (count + strength)
        for head, (count, positive) in head_counts.items()
    }
    band_rate = {
        key: (positive + strength * head_rate.get(key[1], global_rate)) / (count + strength)
        for key, (count, positive) in band_counts.items()
    }
    cell_rate = {
        key: (positive + strength * band_rate.get((key[0], key[1]), global_rate)) / (count + strength)
        for key, (count, positive) in cell_counts.items()
    }
    return ClimatologyModel(
        cells=cell_rate,
        band_headroom=band_rate,
        headroom=head_rate,
        global_rate=global_rate,
    )


class ScoreCalibrator:
    """A calibrator over raw probabilities, fitted on a held-out slice."""

    def __init__(self, method: str, model: Any, temperature: float | None = None) -> None:
        self.method = method
        self.model = model
        self.temperature = temperature

    def predict(self, raw: Array) -> Array:
        clipped = np.clip(raw, 1e-6, 1.0 - 1e-6)
        if self.method == "constant":
            return np.full(len(clipped), float(self.model), dtype=np.float64)
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
    if len(np.unique(y)) < 2:
        return ScoreCalibrator("constant", float(np.mean(y)))
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


def _cross_fitted_with_folds(
    raw: Array,
    y: Array,
    groups: Array,
    method: str,
    config: TrainingConfig,
) -> tuple[Array, Array]:
    """Fit the calibrator out-of-fold and return predictions plus fold ids."""
    unique = np.unique(groups)
    folds = min(config.calibration.folds, len(unique))
    if folds < 2:
        raise ModelError("cross-fitting needs at least two groups; refusing to score in-sample")
    splitter = GroupKFold(n_splits=folds)
    predicted = np.full(len(raw), np.nan, dtype=np.float64)
    fold_ids = np.full(len(raw), -1, dtype=np.int16)
    for fold, (fit_idx, predict_idx) in enumerate(splitter.split(raw, y, groups)):
        calibrator = fit_calibrator(
            raw[fit_idx],
            y[fit_idx],
            method,
            min_positives=config.calibration.min_positives,
        )
        predicted[predict_idx] = calibrator.predict(raw[predict_idx])
        fold_ids[predict_idx] = fold
    if np.isnan(predicted).any():
        raise ModelError("cross-fitted calibration left rows without a prediction")
    return predicted, fold_ids


def _cross_fitted(raw: Array, y: Array, groups: Array, method: str, config: TrainingConfig) -> Array:
    return _cross_fitted_with_folds(raw, y, groups, method, config)[0]


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
    train_prevalence: float
    dropped_features: tuple[str, ...]
    calibration: tuple[Array, Array, Array]
    headroom: tuple[dict[str, Any], ...]
    importance: tuple[dict[str, Any], ...]
    bootstrap: dict[str, list[float]]
    split_sizes: dict[str, int]
    calibration: tuple[Array, Array, Array] = field(compare=False)
    candidate_train: dict[str, dict[str, float | None]] = field(default_factory=dict)
    candidate_calibration_method: str = ""
    headroom_ttd: tuple[dict[str, Any], ...] = ()
    strata: tuple[dict[str, Any], ...] = ()
    strata_compare: tuple[dict[str, Any], ...] = ()
    calibration_stats: dict[str, float | None] = field(default_factory=dict)
    calibration_groups: tuple[dict[str, Any], ...] = ()
    climatology: dict[str, Any] = field(default_factory=dict)
    decision_value: tuple[dict[str, Any], ...] = ()
    intervals: dict[str, list[float]] = field(default_factory=dict)
    paired: dict[str, Any] = field(default_factory=dict)
    prediction_series: Array | None = field(default=None, repr=False, compare=False)
    prediction_snapshot_at: Array | None = field(default=None, repr=False, compare=False)
    prediction_route_day: Array | None = field(default=None, repr=False, compare=False)
    prediction_headroom: Array | None = field(default=None, repr=False, compare=False)
    prediction_raw: Array | None = field(default=None, repr=False, compare=False)
    prediction_raw_pooled: Array | None = field(default=None, repr=False, compare=False)
    prediction_calibration_fold: Array | None = field(default=None, repr=False, compare=False)
    prediction_calibration_mode: str = field(default="", repr=False, compare=False)
    prediction_calibrated: Array | None = field(default=None, repr=False, compare=False)
    prediction_y: Array | None = field(default=None, repr=False, compare=False)
    prediction_split: str = field(default="", repr=False, compare=False)

    def to_dict(self) -> dict[str, Any]:
        return {
            "chosen_model": self.chosen_model,
            "calibration_method": self.calibration_method,
            "threshold": self.threshold,
            "threshold_precision_floor_met": self.threshold_precision_floor_met,
            "candidates": self.candidates,
            "candidate_train": self.candidate_train,
            "candidate_calibration_method": self.candidate_calibration_method,
            "metrics": {"split": self.evaluation_split, "values": self.test},
            "test_all": self.test_all,
            "test_tier": self.test_tier,
            "test_tier_rows": self.test_tier_rows,
            "test_evaluated": self.test_evaluated,
            "calibration_prevalence": self.calibration_prevalence,
            "train_prevalence": self.train_prevalence,
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
            "headroom_ttd": list(self.headroom_ttd),
            "strata": list(self.strata),
            "strata_compare": list(self.strata_compare),
            "calibration_stats": self.calibration_stats,
            "calibration_groups": list(self.calibration_groups),
            "climatology": self.climatology,
            "decision_value": list(self.decision_value),
            "intervals": self.intervals,
            "paired": self.paired,
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
                snapshot_at=data.snapshot_at,
                observation_era=data.observation_era,
                observation_week=data.observation_week,
                check_price=data.check_price,
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


def _ttd_array(data: TabularData) -> Array:
    hours = np.asarray(data.features["hours_to_departure"], dtype=np.float64)
    return np.asarray([ttd_band(float(value)) for value in hours], dtype=str)


def _calibration_stats(y: Array, probabilities: Array, bins: int) -> dict[str, float | None]:
    """Return logistic calibration slope/intercept and expected calibration error."""
    clipped = np.clip(probabilities, 1e-9, 1.0 - 1e-9)
    slope: float | None = None
    intercept: float | None = None
    if len(np.unique(y)) == 2 and len(np.unique(clipped)) > 1:
        logits = np.log(clipped / (1.0 - clipped))
        if float(np.std(logits)) > 1e-12:
            model = LogisticRegression(C=1e6, solver="lbfgs", max_iter=1000)
            model.fit(logits.reshape(-1, 1), y)
            slope = float(model.coef_[0][0])
            intercept = float(model.intercept_[0])
    predicted, observed, counts = _calibration_curve(y, clipped, bins)
    total = float(counts.sum())
    ece = float(np.sum(counts / total * np.abs(predicted - observed))) if total > 0 else None
    return {"slope": slope, "intercept": intercept, "ece": ece}


def _bootstrap_metrics(
    y: Array,
    probabilities: Array,
    groups: Array,
    replicates: int,
    seed: int,
    threshold: float,
) -> dict[str, list[float]]:
    """Cluster bootstrap for the headline metrics that cannot use sufficient statistics."""
    unique, inverse = np.unique(groups, return_inverse=True)
    if len(unique) < 2 or len(y) < 2:
        return {}
    clusters = [np.flatnonzero(inverse == index) for index in range(len(unique))]
    rng = np.random.default_rng(seed)
    collected: dict[str, list[float]] = {
        key: [] for key in ("brier", "log_loss", "bss", "roc_auc", "average_precision", "precision", "recall")
    }
    for _ in range(replicates):
        sampled = rng.integers(0, len(unique), size=len(unique))
        indices = np.concatenate([clusters[index] for index in sampled])
        yy = y[indices]
        pp = np.clip(probabilities[indices], 1e-9, 1.0 - 1e-9)
        both = len(np.unique(yy)) == 2
        brier = float(brier_score_loss(yy, pp))
        base = float(np.mean(yy))
        collected["brier"].append(brier)
        collected["log_loss"].append(float(log_loss(yy, pp, labels=[0, 1])))
        collected["bss"].append(1.0 - brier / (base * (1.0 - base)) if 0.0 < base < 1.0 else np.nan)
        collected["roc_auc"].append(float(roc_auc_score(yy, pp)) if both else np.nan)
        collected["average_precision"].append(float(average_precision_score(yy, pp)) if both else np.nan)
        decisions = _decision_metrics(yy, pp, threshold)
        collected["precision"].append(decisions["precision_at_threshold"])
        collected["recall"].append(decisions["recall_at_threshold"])
    result: dict[str, list[float]] = {}
    for key, values in collected.items():
        array = np.asarray(values, dtype=np.float64)
        array = array[np.isfinite(array)]
        result[key] = [float(np.percentile(array, 2.5)), float(np.percentile(array, 97.5))] if len(array) else []
    return result


def _bootstrap_paired(
    y: Array,
    model_probabilities: Array,
    baseline_probabilities: Array,
    groups: Array,
    replicates: int,
    seed: int,
) -> list[float]:
    """Cluster bootstrap of the Brier difference (model minus baseline)."""
    unique, inverse = np.unique(groups, return_inverse=True)
    if len(unique) < 2:
        return []
    difference = (np.clip(model_probabilities, 1e-9, 1.0 - 1e-9) - y) ** 2 - (
        np.clip(baseline_probabilities, 1e-9, 1.0 - 1e-9) - y
    ) ** 2
    sums = np.bincount(inverse, weights=difference, minlength=len(unique))
    counts = np.bincount(inverse, minlength=len(unique))
    rng = np.random.default_rng(seed)
    values = []
    for _ in range(replicates):
        sampled = rng.integers(0, len(unique), size=len(unique))
        values.append(float(sums[sampled].sum() / counts[sampled].sum()))
    return [float(np.percentile(values, 2.5)), float(np.percentile(values, 97.5))]


def _cluster_mean_ci(values: Array, groups: Array, replicates: int, seed: int) -> list[float]:
    unique, inverse = np.unique(groups, return_inverse=True)
    if len(unique) < 2 or len(values) == 0:
        return []
    sums = np.bincount(inverse, weights=values, minlength=len(unique))
    counts = np.bincount(inverse, minlength=len(unique))
    rng = np.random.default_rng(seed)
    means = []
    for _ in range(replicates):
        sampled = rng.integers(0, len(unique), size=len(unique))
        total = counts[sampled].sum()
        means.append(float(sums[sampled].sum() / total) if total else np.nan)
    array = np.asarray(means, dtype=np.float64)
    array = array[np.isfinite(array)]
    return [float(np.percentile(array, 2.5)), float(np.percentile(array, 97.5))] if len(array) else []


def _stratum_metrics(y: Array, probabilities: Array, train_y: Array, threshold: float) -> dict[str, float | None]:
    metrics = _metrics(y, probabilities)
    train_rate = float(np.mean(train_y)) if len(train_y) else float("nan")
    metrics["bss_train"] = _bss_train(metrics["brier"], y, train_rate) if np.isfinite(train_rate) else None
    decisions = _decision_metrics(y, probabilities, threshold)
    metrics["precision_at_threshold"] = decisions["precision_at_threshold"]
    metrics["recall_at_threshold"] = decisions["recall_at_threshold"]
    metrics["mean_probability"] = float(np.mean(probabilities))
    metrics["calibration_gap"] = float(np.mean(probabilities) - np.mean(y))
    return metrics


def _strata_rows(
    data: TabularData,
    probabilities: Array,
    train_data: TabularData,
    threshold: float,
) -> list[dict[str, Any]]:
    """Metrics by TTD band, era, observation week and service class."""
    dimensions = {
        "ttd_band": _ttd_array(data),
        "era": np.asarray(data.observation_era, dtype=str),
        "week": np.asarray(data.observation_week, dtype=str),
        "service_class": np.asarray(data.features["service_class"], dtype=str),
        "evidence_tier": np.where(data.future_observations >= 2, "two_plus", "one"),
    }
    train_dimensions = {
        "ttd_band": _ttd_array(train_data),
        "era": np.asarray(train_data.observation_era, dtype=str),
        "week": np.asarray(train_data.observation_week, dtype=str),
        "service_class": np.asarray(train_data.features["service_class"], dtype=str),
        "evidence_tier": np.where(train_data.future_observations >= 2, "two_plus", "one"),
    }
    rows: list[dict[str, Any]] = []
    for dimension, values in dimensions.items():
        for value in sorted(set(values.tolist())):
            mask = values == value
            if int(mask.sum()) < 20:
                continue
            train_mask = train_dimensions[dimension] == value
            train_y = train_data.y[train_mask]
            item = _stratum_metrics(data.y[mask], probabilities[mask], train_y, threshold)
            rows.append(
                {
                    "dimension": dimension,
                    "value": str(value),
                    "rows": int(mask.sum()),
                    "train_rows": int(train_mask.sum()),
                    **item,
                }
            )
    return rows


def _decision_value_rows(
    data: TabularData,
    headroom_values: tuple[int, ...],
    probabilities: list[Array],
    bands: Array,
    threshold: float,
    replicates: int,
    seed: int,
) -> list[dict[str, Any]]:
    """Diagnostic value of alerting now versus booking now or at the next check."""
    rows: list[dict[str, Any]] = []
    for headroom, probabilities_at_headroom in zip(headroom_values, probabilities, strict=True):
        for band in band_labels():
            mask = (bands == band) & np.isfinite(data.check_price) & np.isfinite(data.price) & (data.price > 0)
            if int(mask.sum()) < 20:
                continue
            price = data.price[mask]
            check = data.check_price[mask]
            alert = probabilities_at_headroom[mask] >= threshold
            saving = check - price
            if int(alert.sum()) == 0:
                continue
            policy = np.where(alert, saving, 0.0)
            policy_ci = _cluster_mean_ci(policy, data.departure_date[mask], replicates, seed)
            difference_ci = _cluster_mean_ci(policy - saving, data.departure_date[mask], replicates, seed + 1)
            rows.append(
                {
                    "headroom_pct": int(headroom),
                    "band": band,
                    "rows": int(mask.sum()),
                    "alert_rows": int(alert.sum()),
                    "alert_share": float(alert.mean()),
                    "policy_saving_eur": float(np.mean(policy)),
                    "policy_saving_pct": float(np.sum(policy) / np.sum(price)),
                    "conditional_saving_eur": float(np.mean(saving[alert])),
                    "conditional_saving_pct": float(np.mean(saving[alert] / price[alert])),
                    "policy_vs_wait_eur": float(np.mean(policy - saving)),
                    "policy_vs_wait_pct": float(np.sum(policy - saving) / np.sum(price)),
                    "ci_eur": policy_ci,
                    "difference_ci_eur": difference_ci,
                    "always_wait_eur": float(np.mean(saving)),
                    "always_wait_pct": float(np.sum(saving) / np.sum(price)),
                    "always_book_eur": 0.0,
                }
            )
    return rows


def _canonical(data: TabularData) -> TabularData:
    order = np.lexsort(
        (
            np.asarray(data.snapshot_at, dtype=str),
            np.asarray(data.series, dtype=str),
        )
    )
    return data.subset(order)


def _select(values: Array, mask: Array | None) -> Array:
    return values[mask] if mask is not None else values


def _fit_candidates(
    train: TabularData,
    validation_select: TabularData,
    spec: FeatureSpec,
    config: TrainingConfig,
) -> tuple[dict[str, FittedModel], dict[str, dict[str, float | None]], dict[str, dict[str, float | None]]]:
    candidates: dict[str, FittedModel] = {}
    metrics: dict[str, dict[str, float | None]] = {}
    train_metrics: dict[str, dict[str, float | None]] = {}
    calibration_method = next(iter(config.calibration.methods))
    for name in config.model.candidates:
        model = fit_candidate(name, train, spec, config)
        candidates[name] = model
        train_metrics[name] = _metrics(train.y, model.predict(train))
        raw = model.predict(validation_select)
        if name == "base_rate":
            metrics[name] = _metrics(validation_select.y, raw)
        else:
            metrics[name] = _metrics(
                validation_select.y,
                _cross_fitted(raw, validation_select.y, validation_select.route_day, calibration_method, config),
            )
    return candidates, metrics, train_metrics


def _choose_candidate(candidate_metrics: dict[str, dict[str, float | None]]) -> str:
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
    return chosen


def _fit_final_calibration(
    model: FittedModel,
    validation_calibrate: TabularData,
    config: TrainingConfig,
) -> tuple[TabularData, ScoreCalibrator, str, dict[str, Array], float, bool]:
    evidence = validation_calibrate.future_observations >= 2
    cal_data = (
        validation_calibrate.subset(evidence)
        if int(evidence.sum()) >= config.report.min_tier_rows
        else validation_calibrate
    )
    raw_cal = model.predict(cal_data)
    method_scores: dict[str, dict[str, float | None]] = {}
    oof_predictions: dict[str, Array] = {}
    for method in config.calibration.methods:
        oof_predictions[method] = _cross_fitted(raw_cal, cal_data.y, cal_data.route_day, method, config)
        method_scores[method] = _metrics(cal_data.y, oof_predictions[method])
    requested = min(method_scores, key=lambda name: float(method_scores[name]["brier"] or 1.0))
    calibrator = fit_calibrator(
        raw_cal,
        cal_data.y,
        requested,
        min_positives=config.calibration.min_positives,
    )
    method = calibrator.method
    if method not in oof_predictions:
        oof_predictions[method] = _cross_fitted(raw_cal, cal_data.y, cal_data.route_day, method, config)
    threshold, threshold_met = _threshold(
        cal_data.y,
        oof_predictions[method],
        config.report.threshold_precision_floor,
    )
    return cal_data, calibrator, method, oof_predictions, threshold, threshold_met


def _calibrated_scores(
    fit_raw: Array,
    fit_y: Array,
    groups: Array,
    apply_raw: Array,
    method: str,
    config: TrainingConfig,
    evaluate_test: bool,
) -> tuple[Array, Array, str]:
    """Return calibrated scores, fold ids and the calibration mode for one population."""
    if evaluate_test:
        calibrator = fit_calibrator(
            fit_raw,
            fit_y,
            method,
            min_positives=config.calibration.min_positives,
        )
        return calibrator.predict(apply_raw), np.full(len(apply_raw), -1, dtype=np.int16), "full"
    predicted, folds = _cross_fitted_with_folds(fit_raw, fit_y, groups, method, config)
    if len(apply_raw) != len(predicted):
        raise ModelError("out-of-fold calibration applied to a different population")
    return predicted, folds, "oof"


def _headroom_diagnostics(
    eval_rows: TabularData,
    cal_data: TabularData,
    train_eval: TabularData,
    model: FittedModel,
    climatology: ClimatologyModel,
    calibration_method: str,
    config: TrainingConfig,
    bands_eval: Array,
    bands_train: Array,
    eval_mask: Array | None,
    threshold: float,
    evaluate_test: bool,
) -> tuple[
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[Array],
    list[Array],
    list[Array],
    list[Array],
]:
    headroom: list[dict[str, Any]] = []
    headroom_ttd: list[dict[str, Any]] = []
    probabilities_by_headroom: list[Array] = []
    raw_by_headroom: list[Array] = []
    folds_by_headroom: list[Array] = []
    y_by_headroom: list[Array] = []
    select = (lambda values: _select(values, eval_mask)) if not evaluate_test else (lambda values: values)
    for value in config.label.headroom_pct:
        y_headroom = (eval_rows.future_max >= eval_rows.price * (1.0 + value / 100.0)).astype(np.int8)
        y_cal_headroom = (cal_data.future_max >= cal_data.price * (1.0 + value / 100.0)).astype(np.int8)
        raw_cal_headroom = model.predict(cal_data, headroom=value)
        raw_apply = model.predict(eval_rows, headroom=value) if evaluate_test else raw_cal_headroom
        calibrated, folds, _ = _calibrated_scores(
            raw_cal_headroom,
            y_cal_headroom,
            cal_data.route_day,
            raw_apply,
            calibration_method,
            config,
            evaluate_test,
        )
        probabilities = select(calibrated)
        raw_headroom = select(raw_apply)
        folds_eval = select(folds)
        clim_raw_headroom = climatology.predict(cal_data, headroom=value)
        clim_apply = climatology.predict(eval_rows, headroom=value) if evaluate_test else clim_raw_headroom
        clim_calibrated, _, _ = _calibrated_scores(
            clim_raw_headroom,
            y_cal_headroom,
            cal_data.route_day,
            clim_apply,
            calibration_method,
            config,
            evaluate_test,
        )
        clim_headroom = select(clim_calibrated)
        item = _metrics(y_headroom, probabilities)
        item["headroom_pct"] = value
        item["mean_probability"] = float(np.mean(probabilities))
        item["calibration_gap"] = float(np.mean(probabilities) - np.mean(y_headroom))
        decisions = _decision_metrics(y_headroom, probabilities, threshold)
        item["precision_at_threshold"] = decisions["precision_at_threshold"]
        item["recall_at_threshold"] = decisions["recall_at_threshold"]
        train_headroom = train_eval.y[train_eval.headroom == value]
        item["train_rows"] = len(train_headroom)
        item["bss_train"] = (
            _bss_train(item["brier"], y_headroom, float(np.mean(train_headroom))) if len(train_headroom) else None
        )
        clim_reference = float(np.mean((y_headroom - clim_headroom) ** 2))
        item["bss_climatology"] = (
            1.0 - item["brier"] / clim_reference if item["brier"] is not None and clim_reference > 0 else None
        )
        calibration = _calibration_stats(y_headroom, probabilities, config.report.calibration_bins)
        item["calibration_slope"] = calibration["slope"]
        item["calibration_intercept"] = calibration["intercept"]
        item["ece"] = calibration["ece"]
        probabilities_by_headroom.append(probabilities)
        raw_by_headroom.append(raw_headroom)
        folds_by_headroom.append(folds_eval)
        y_by_headroom.append(y_headroom)
        headroom.append(item)
        for band in band_labels():
            mask = bands_eval == band
            if int(mask.sum()) < 20:
                continue
            band_metrics: dict[str, Any] = dict(_metrics(y_headroom[mask], probabilities[mask]))
            train_mask = (bands_train == band) & (train_eval.headroom == value)
            band_metrics["train_rows"] = int(train_mask.sum())
            band_metrics["bss_train"] = (
                _bss_train(band_metrics["brier"], y_headroom[mask], float(np.mean(train_eval.y[train_mask])))
                if int(train_mask.sum())
                else None
            )
            clim_band_reference = float(np.mean((y_headroom[mask] - clim_headroom[mask]) ** 2))
            band_metrics["bss_climatology"] = (
                1.0 - band_metrics["brier"] / clim_band_reference
                if band_metrics["brier"] is not None and clim_band_reference > 0
                else None
            )
            band_metrics["roc_auc_raw"] = (
                float(roc_auc_score(y_headroom[mask], raw_headroom[mask]))
                if len(np.unique(y_headroom[mask])) == 2
                else None
            )
            band_metrics["headroom_pct"] = value
            band_metrics["ttd_band"] = band
            headroom_ttd.append(band_metrics)
    return headroom, headroom_ttd, probabilities_by_headroom, raw_by_headroom, folds_by_headroom, y_by_headroom


def _calibration_groups(
    eval_rows: TabularData,
    headroom_probabilities: list[Array],
    y_headroom_arrays: list[Array],
    bands_eval: Array,
    config: TrainingConfig,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for value_index, value in enumerate(config.label.headroom_pct):
        for band in band_labels():
            for era in sorted(set(np.asarray(eval_rows.observation_era, dtype=str).tolist())):
                mask = (bands_eval == band) & (np.asarray(eval_rows.observation_era, dtype=str) == era)
                if int(mask.sum()) < 20:
                    continue
                predicted, observed, counts = _calibration_curve(
                    y_headroom_arrays[value_index][mask],
                    headroom_probabilities[value_index][mask],
                    config.report.calibration_bins,
                )
                stats = _calibration_stats(
                    y_headroom_arrays[value_index][mask],
                    headroom_probabilities[value_index][mask],
                    config.report.calibration_bins,
                )
                rows.append(
                    {
                        "headroom_pct": value,
                        "ttd_band": band,
                        "era": era,
                        "rows": int(mask.sum()),
                        "prob_pred": [float(item) for item in predicted],
                        "prob_true": [float(item) for item in observed],
                        "counts": [int(item) for item in counts],
                        **stats,
                    }
                )
    return rows


def _strata_comparison(
    strata: list[dict[str, Any]],
    cal_data: TabularData,
    oof_predictions: Array,
    train_eval: TabularData,
    threshold: float,
) -> list[dict[str, Any]]:
    validation = {
        (item["dimension"], item["value"]): item
        for item in _strata_rows(cal_data, oof_predictions, train_eval, threshold)
    }
    test = {(item["dimension"], item["value"]): item for item in strata}
    rows: list[dict[str, Any]] = []
    for key, test_item in test.items():
        validation_item = validation.get(key)
        if validation_item is None:
            continue
        rows.append(
            {
                "dimension": key[0],
                "value": key[1],
                "validation_rows": validation_item["rows"],
                "test_rows": test_item["rows"],
                "validation_brier": validation_item["brier"],
                "test_brier": test_item["brier"],
                "validation_bss": validation_item["bss"],
                "test_bss": test_item["bss"],
            }
        )
    return rows


def train_and_evaluate(
    splits: dict[str, TabularData],
    spec: FeatureSpec,
    config: TrainingConfig,
    *,
    evaluate_test: bool = False,
) -> tuple[Evaluation, dict[str, FittedModel], ScoreCalibrator]:
    """Fit the candidate models and evaluate the configured cohort.

    ``train`` fits the candidates; ``validation_select`` compares and selects them;
    ``validation_calibrate`` fits the final calibrator and supplies the default evaluation rows.
    ``test`` is read only when ``evaluate_test`` is true, and is then the reported split. The
    returned tuple holds the evaluation payload, all fitted candidates and the calibrator that
    belongs to the selected model.
    """
    splits = {name: _canonical(data) for name, data in splits.items()}
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

    candidates, candidate_metrics, candidate_train_metrics = _fit_candidates(train, validation_select, spec, config)
    chosen = _choose_candidate(candidate_metrics)
    model = candidates[chosen]
    cal_data, calibrator, calibration_method, oof_predictions, threshold, threshold_met = _fit_final_calibration(
        model, validation_calibrate, config
    )

    eval_data = test if evaluate_test else cal_data
    evaluation_split = "test" if evaluate_test else "validation_calibrate"
    test_all = None
    if evaluate_test:
        all_calibrator = fit_calibrator(
            model.predict(validation_calibrate),
            validation_calibrate.y,
            calibration_method,
            min_positives=config.calibration.min_positives,
        )
        test_all = _metrics(test.y, all_calibrator.predict(model.predict(test)))

    evidence = eval_data.future_observations >= 2
    if int(evidence.sum()) >= config.report.min_tier_rows:
        eval_rows = eval_data.subset(evidence)
        test_tier = "two_plus_observations"
        eval_mask: Array | None = evidence
    else:
        eval_rows = eval_data
        test_tier = "all_labelled_rows"
        eval_mask = None
    train_eval = train.subset(train.future_observations >= 2) if test_tier == "two_plus_observations" else train
    raw_eval_source = model.predict(eval_data)
    calibrated_eval = (
        calibrator.predict(raw_eval_source)
        if evaluate_test
        else _select(oof_predictions[calibration_method], eval_mask)
    )
    raw_pooled_eval = _select(raw_eval_source, eval_mask)
    bands_eval = _ttd_array(eval_rows)
    bands_train = _ttd_array(train_eval)

    test_metrics = _metrics(eval_rows.y, calibrated_eval)
    train_rate = _train_prevalence(train, test_tier)
    test_metrics["bss_train"] = _bss_train(test_metrics["brier"], eval_rows.y, train_rate)
    test_metrics["threshold"] = threshold
    test_metrics.update(_decision_metrics(eval_rows.y, calibrated_eval, threshold))
    test_metrics["precision_floor_met_on_evaluation"] = bool(
        _metric_value(test_metrics["precision_at_threshold"], 0.0) >= config.report.threshold_precision_floor
    )

    climatology = fit_climatology(train)
    clim_raw_cal = climatology.predict(cal_data)
    clim_calibrated, _, _ = _calibrated_scores(
        clim_raw_cal,
        cal_data.y,
        cal_data.route_day,
        climatology.predict(eval_data),
        calibration_method,
        config,
        evaluate_test,
    )
    clim_eval = _select(clim_calibrated, eval_mask)
    climatology_metrics: dict[str, Any] = dict(_metrics(eval_rows.y, clim_eval))
    climatology_metrics["bss_train"] = _bss_train(climatology_metrics["brier"], eval_rows.y, train_rate)
    climatology_metrics["method"] = calibration_method
    clim_reference = float(np.mean((eval_rows.y - clim_eval) ** 2))
    test_metrics["bss_climatology"] = (
        1.0 - _metric_value(test_metrics["brier"]) / clim_reference if clim_reference > 0 else None
    )

    headroom, headroom_ttd, headroom_probabilities, raw_headroom_probabilities, fold_assignments, y_headroom_arrays = (
        _headroom_diagnostics(
            eval_rows,
            cal_data,
            train_eval,
            model,
            climatology,
            calibration_method,
            config,
            bands_eval,
            bands_train,
            eval_mask,
            threshold,
            evaluate_test,
        )
    )
    test_metrics["headroom_monotonic"] = bool(
        all(np.all(left >= right) for left, right in itertools.pairwise(headroom_probabilities))
    )
    prob_pred, prob_true, counts = _calibration_curve(eval_rows.y, calibrated_eval, config.report.calibration_bins)
    calibration_stats = _calibration_stats(eval_rows.y, calibrated_eval, config.report.calibration_bins)
    calibration_groups = _calibration_groups(
        eval_rows,
        headroom_probabilities,
        y_headroom_arrays,
        bands_eval,
        config,
    )

    groups = eval_rows.departure_date if config.report.bootstrap_cluster == "departure_date" else eval_rows.route_day
    bootstrap = _bootstrap(
        eval_rows.y,
        calibrated_eval,
        groups,
        config.report.bootstrap_replicates,
        config.seed,
    )
    intervals = _bootstrap_metrics(
        eval_rows.y,
        calibrated_eval,
        groups,
        config.report.metric_bootstrap_replicates,
        config.seed + 1,
        threshold,
    )
    positive_rate = float(np.mean(eval_rows.y))
    if bootstrap.get("brier"):
        reference = positive_rate * (1.0 - positive_rate)
        if reference > 0:
            intervals["bss"] = [
                1.0 - bootstrap["brier"][1] / reference,
                1.0 - bootstrap["brier"][0] / reference,
            ]

    paired: dict[str, Any] = {
        "vs_climatology_brier_point": float(
            np.mean((np.clip(calibrated_eval, 1e-9, 1.0 - 1e-9) - eval_rows.y) ** 2)
            - np.mean((np.clip(clim_eval, 1e-9, 1.0 - 1e-9) - eval_rows.y) ** 2)
        ),
        "vs_climatology_brier": _bootstrap_paired(
            eval_rows.y,
            calibrated_eval,
            clim_eval,
            groups,
            config.report.metric_bootstrap_replicates,
            config.seed + 2,
        ),
    }
    if "logistic" in candidates:
        logistic_raw_cal = candidates["logistic"].predict(cal_data)
        logistic_calibrated, _, _ = _calibrated_scores(
            logistic_raw_cal,
            cal_data.y,
            cal_data.route_day,
            candidates["logistic"].predict(eval_data),
            calibration_method,
            config,
            evaluate_test,
        )
        logistic_eval = _select(logistic_calibrated, eval_mask)
        paired["vs_logistic_brier_point"] = float(
            np.mean((np.clip(calibrated_eval, 1e-9, 1.0 - 1e-9) - eval_rows.y) ** 2)
            - np.mean((np.clip(logistic_eval, 1e-9, 1.0 - 1e-9) - eval_rows.y) ** 2)
        )
        paired["vs_logistic_brier"] = _bootstrap_paired(
            eval_rows.y,
            calibrated_eval,
            logistic_eval,
            groups,
            config.report.metric_bootstrap_replicates,
            config.seed + 3,
        )
    else:
        paired["vs_logistic_brier_point"] = None
        paired["vs_logistic_brier"] = []

    strata = _strata_rows(eval_rows, calibrated_eval, train_eval, threshold)
    strata_compare = (
        _strata_comparison(
            strata,
            cal_data,
            oof_predictions[calibration_method],
            train_eval,
            threshold,
        )
        if evaluate_test
        else []
    )
    decision_value = _decision_value_rows(
        eval_rows,
        config.label.headroom_pct,
        headroom_probabilities,
        bands_eval,
        threshold,
        config.report.metric_bootstrap_replicates,
        config.seed + 4,
    )
    importance = _permutation_importance(model, calibrator, validation_select, spec, seed=config.seed)
    prediction_headroom = np.repeat(np.asarray(config.label.headroom_pct, dtype=np.int16), len(eval_rows))
    evaluation = Evaluation(
        chosen_model=chosen,
        calibration_method=calibration_method,
        threshold=threshold,
        threshold_precision_floor_met=threshold_met,
        candidates=candidate_metrics,
        candidate_train=candidate_train_metrics,
        candidate_calibration_method=next(iter(config.calibration.methods)),
        test=test_metrics,
        test_all=test_all,
        test_tier=test_tier,
        test_tier_rows=len(eval_rows),
        evaluation_split=evaluation_split,
        test_evaluated=evaluate_test,
        calibration_prevalence=float(np.mean(cal_data.y)),
        train_prevalence=train_rate,
        dropped_features=tuple(sorted({name for fitted in candidates.values() for name in fitted.dropped})),
        calibration=(prob_pred, prob_true, counts),
        headroom=tuple(headroom),
        importance=importance,
        bootstrap=bootstrap,
        split_sizes={name: len(data) for name, data in splits.items()},
        headroom_ttd=tuple(headroom_ttd),
        strata=tuple(strata),
        strata_compare=tuple(strata_compare),
        calibration_stats=calibration_stats,
        calibration_groups=tuple(calibration_groups),
        climatology=climatology_metrics,
        decision_value=tuple(decision_value),
        intervals=intervals,
        paired=paired,
        prediction_series=np.tile(eval_rows.series, len(config.label.headroom_pct)),
        prediction_snapshot_at=np.tile(eval_rows.snapshot_at, len(config.label.headroom_pct)),
        prediction_route_day=np.tile(eval_rows.route_day, len(config.label.headroom_pct)),
        prediction_headroom=prediction_headroom,
        prediction_raw=np.concatenate(raw_headroom_probabilities),
        prediction_raw_pooled=np.tile(raw_pooled_eval, len(config.label.headroom_pct)),
        prediction_calibration_fold=np.concatenate(fold_assignments),
        prediction_calibration_mode="full" if evaluate_test else "oof",
        prediction_calibrated=np.concatenate(headroom_probabilities),
        prediction_y=np.concatenate(y_headroom_arrays),
        prediction_split=evaluation_split,
    )
    return evaluation, candidates, calibrator


def write_evaluation_artifacts(
    out_dir: Path,
    evaluation: Evaluation,
    fitted: dict[str, FittedModel],
    calibrator: ScoreCalibrator,
    spec: FeatureSpec,
    config: TrainingConfig,
) -> None:
    """Persist the calibrated model and per-headroom predictions as local artifacts."""
    required = (
        evaluation.prediction_series,
        evaluation.prediction_snapshot_at,
        evaluation.prediction_route_day,
        evaluation.prediction_headroom,
        evaluation.prediction_raw,
        evaluation.prediction_calibrated,
        evaluation.prediction_y,
    )
    if any(value is None for value in required):
        raise ModelError("evaluation has no prediction arrays to persist")
    series = evaluation.prediction_series
    snapshots = evaluation.prediction_snapshot_at
    route_days = evaluation.prediction_route_day
    headrooms = evaluation.prediction_headroom
    raw_scores = evaluation.prediction_raw
    raw_pooled = evaluation.prediction_raw_pooled
    calibration_folds = evaluation.prediction_calibration_fold
    calibrated_scores = evaluation.prediction_calibrated
    labels = evaluation.prediction_y
    if (
        series is None
        or snapshots is None
        or route_days is None
        or headrooms is None
        or raw_scores is None
        or raw_pooled is None
        or calibration_folds is None
        or calibrated_scores is None
        or labels is None
    ):
        raise ModelError("evaluation has no prediction arrays to persist")
    predictions_dir = out_dir / "predictions"
    predictions_dir.mkdir(parents=True, exist_ok=True)
    table = pa.table(
        {
            "series_key": series,
            "snapshot_at": snapshots,
            "route_day": route_days,
            "headroom_pct": headrooms,
            "raw_score": raw_scores,
            "raw_score_pooled": raw_pooled,
            "calibration_fold": calibration_folds,
            "calibration_mode": [evaluation.prediction_calibration_mode] * len(labels),
            "calibrated_score": calibrated_scores,
            "label": labels,
            "split": [evaluation.prediction_split] * len(labels),
        }
    )
    pq.write_table(table, predictions_dir / f"{evaluation.prediction_split}.parquet", compression="zstd")
    dataset_manifest = json.loads((out_dir / "dataset_manifest.json").read_text(encoding="utf-8"))
    joblib.dump(
        {
            "git_sha": dataset_manifest.get("git_sha"),
            "git_dirty": dataset_manifest.get("git_dirty"),
            "silver_build_id": dataset_manifest.get("silver_build_id"),
            "run_id": dataset_manifest.get("run_id"),
            "config_sha256": dataset_manifest.get("config_sha256"),
            "model": fitted[evaluation.chosen_model],
            "calibrator": calibrator,
            "feature_spec": list(spec.names),
            "calendar_set": spec.calendar_set,
            "chosen_model": evaluation.chosen_model,
            "calibration_method": evaluation.calibration_method,
            "calibration_mode": evaluation.prediction_calibration_mode,
            "threshold": evaluation.threshold,
            "threshold_precision_floor_met": evaluation.threshold_precision_floor_met,
            "dropped_features": list(evaluation.dropped_features),
            "config": {key: value for key, value in config.to_dict().items() if key != "source"},
        },
        out_dir / "model.joblib",
    )


def load_model(path: Path, expected_sha256: str) -> dict[str, Any]:
    """Load a model artifact only after its manifest hash matches."""
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != expected_sha256:
        raise ModelError(f"model artifact hash mismatch: {digest} != {expected_sha256}")
    payload = joblib.load(path)
    if not isinstance(payload, dict):
        raise ModelError("model artifact is not a dictionary")
    return payload
