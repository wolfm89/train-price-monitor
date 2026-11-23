"""Model comparison, calibration and evaluation for the baseline.

No pandas: DuckDB returns numpy arrays, the feature spec keeps an allowlist, and every candidate
uses the same ordinal matrix. Calibration is fitted on validation-calibrate only, never on the
selection slice or the test set.
"""

from __future__ import annotations

import hashlib
import itertools
import json
import time
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
from sklearn.base import BaseEstimator, TransformerMixin
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
from sklearn.preprocessing import OneHotEncoder, OrdinalEncoder, SplineTransformer, StandardScaler

from tpm_analytics.silver._duck import sql_string
from tpm_analytics.training.bands import CLIMATOLOGY_BANDS, HEADLINE_BANDS, band_labels
from tpm_analytics.training.config import MODEL_NAMES, TrainingConfig
from tpm_analytics.training.features import BOOLEAN, CATEGORICAL, FeatureSpec
from tpm_analytics.training.identity import berlin_week_sql
from tpm_analytics.training.labels import breach, cents

Array = NDArray[Any]


class ModelError(RuntimeError):
    """The model matrix or a candidate cannot be trained."""


@dataclass(frozen=True)
class TabularData:
    """A row-aligned training panel with features, labels and provenance columns."""

    features: dict[str, Array]
    y: Array
    series: Array
    route_day: Array
    price: Array
    check_price: Array
    future_max: Array
    future_observations: Array
    headroom: Array
    departure_date: Array
    snapshot_at: Array
    observation_era: Array
    observation_week: Array
    price_cents: Array | None = None
    check_price_cents: Array | None = None
    check_price_2024: Array | None = None
    label_window_end: Array | None = None
    chain: Array | None = None

    def __len__(self) -> int:
        """Return the number of rows in the panel."""
        return len(self.y)

    def subset(self, indices: Array) -> TabularData:
        """Return a row subset of the panel."""
        return TabularData(
            features={name: values[indices] for name, values in self.features.items()},
            y=self.y[indices],
            series=self.series[indices],
            route_day=self.route_day[indices],
            price=self.price[indices],
            check_price=self.check_price[indices],
            price_cents=self.price_cents[indices] if self.price_cents is not None else None,
            check_price_cents=(self.check_price_cents[indices] if self.check_price_cents is not None else None),
            check_price_2024=self.check_price_2024[indices] if self.check_price_2024 is not None else None,
            label_window_end=self.label_window_end[indices] if self.label_window_end is not None else None,
            future_max=self.future_max[indices],
            future_observations=self.future_observations[indices],
            headroom=self.headroom[indices],
            departure_date=self.departure_date[indices],
            snapshot_at=self.snapshot_at[indices],
            observation_era=self.observation_era[indices],
            observation_week=self.observation_week[indices],
            chain=self.chain[indices] if self.chain is not None else None,
        )

    def select(self, names: tuple[str, ...]) -> TabularData:
        """Return the panel with the selected feature columns."""
        return TabularData(
            features={name: self.features[name] for name in names},
            y=self.y,
            series=self.series,
            route_day=self.route_day,
            price=self.price,
            check_price=self.check_price,
            price_cents=self.price_cents,
            check_price_cents=self.check_price_cents,
            check_price_2024=self.check_price_2024,
            label_window_end=self.label_window_end,
            future_max=self.future_max,
            future_observations=self.future_observations,
            headroom=self.headroom,
            departure_date=self.departure_date,
            snapshot_at=self.snapshot_at,
            observation_era=self.observation_era,
            observation_week=self.observation_week,
            chain=self.chain,
        )


def concat_tabular(parts: list[TabularData]) -> TabularData:
    """Concatenate split panels into one row-aligned table for a multi-fold run."""
    if not parts:
        raise ModelError("cannot concatenate an empty panel list")
    features = {name: np.concatenate([part.features[name] for part in parts]) for name in parts[0].features}

    def array(name: str) -> Array:
        """Concatenate one column across all parts."""
        return np.concatenate([getattr(part, name) for part in parts])

    def optional(name: str) -> Array | None:
        """Concatenate an optional column across all parts."""
        values = [getattr(part, name) for part in parts]
        return None if any(value is None for value in values) else np.concatenate(values)

    return TabularData(
        features=features,
        y=array("y"),
        series=array("series"),
        route_day=array("route_day"),
        price=array("price"),
        check_price=array("check_price"),
        future_max=array("future_max"),
        future_observations=array("future_observations"),
        headroom=array("headroom"),
        departure_date=array("departure_date"),
        snapshot_at=array("snapshot_at"),
        observation_era=array("observation_era"),
        observation_week=array("observation_week"),
        price_cents=optional("price_cents"),
        check_price_cents=optional("check_price_cents"),
        check_price_2024=optional("check_price_2024"),
        label_window_end=optional("label_window_end"),
        chain=optional("chain"),
    )


def _train_prevalence(train: TabularData) -> float:
    """Event rate on the one eligible training population."""
    return float(np.mean(train.y)) if len(train) else float("nan")


def _bss_train(brier: float | None, labels: Array, train_rate: float) -> float | None:
    """Brier skill against a constant predictor at the matching train prevalence."""
    if brier is None:
        return None
    reference = float(np.mean((labels - train_rate) ** 2))
    return 1.0 - float(brier) / reference if reference > 0 else None


def _filled(values: Any, fill: float) -> Array:
    """Convert a nullable numeric column to float64 with a fill value."""
    if isinstance(values, np.ma.MaskedArray):
        return np.asarray(values.astype(np.float32).filled(fill), dtype=np.float32)
    return np.asarray(values, dtype=np.float32)


def _filled64(values: Any, fill: float) -> Array:
    """Convert a nullable column to float64 with a fill value."""
    if isinstance(values, np.ma.MaskedArray):
        return np.asarray(values.astype(np.float64).filled(fill), dtype=np.float64)
    return np.asarray(values, dtype=np.float64)


def _categorical(values: Any) -> Array:
    """Convert categorical values to strings, mapping missing to a sentinel."""
    if isinstance(values, np.ma.MaskedArray):
        values = values.astype(object).filled("__missing__")
    array = np.asarray(values, dtype=object)
    flat = [
        "__missing__" if value is None or (isinstance(value, float) and np.isnan(value)) else str(value)
        for value in array.ravel()
    ]
    return np.asarray(flat, dtype=object).reshape(array.shape)


def _encode_text(values: Any) -> Array:
    """Encode strings as fixed-width UTF-8 bytes."""
    flat = [("" if value is None else str(value)).encode("utf-8") for value in np.asarray(values, dtype=object).ravel()]
    width = max((len(value) for value in flat), default=1)
    return np.asarray(flat, dtype=f"S{width}")


def _compact_text(values: Any) -> Array:
    """Store string ids as fixed-width UTF-8 bytes, which cost a quarter of Python str objects."""
    return _encode_text(values)


def _compact_category(values: Any) -> Array:
    """Encode categorical strings as UTF-8 bytes."""
    return _encode_text(_categorical(values))


def _compact_datetime(values: Any, unit: str) -> Array:
    """Convert values to a compact datetime dtype."""
    return np.asarray(values, dtype=f"datetime64[{unit}]")


def _split_columns(spec: FeatureSpec) -> str:
    """Return the ordered columns loaded from a split Parquet."""
    return ", ".join(
        dict.fromkeys(
            (
                *spec.names,
                "breached_next_day",
                "price_cents",
                "check_price_cents",
                "series_key",
                "chain_id",
                "route_id || '|' || CAST(departure_date AS VARCHAR) AS route_day",
                "price_eur",
                "check_price_eur",
                "check_price_2024_eur",
                "label_window_end",
                "future_max_fare_24h",
                "future_observations",
                "headroom_pct",
                "departure_date",
                "snapshot_at",
                "observation_era",
                f"{berlin_week_sql('snapshot_at')} AS observation_week",
                "bin_regime",
                "bin_index",
            )
        )
    )


def _tabular(rows: dict[str, Any], spec: FeatureSpec, *, compact: bool, source: str) -> TabularData:
    """Build a training panel from DuckDB result columns."""
    if len(rows["breached_next_day"]) == 0:
        raise ModelError(f"{source} has no labelled rows")
    features: dict[str, Array] = {}
    for feature in spec.features:
        values = rows[feature.name]
        if feature.kind == CATEGORICAL:
            features[feature.name] = _compact_category(values) if compact else _categorical(values)
        elif feature.kind == BOOLEAN:
            features[feature.name] = _filled(values, 0.0)
        else:
            features[feature.name] = _filled(values, np.nan)
    future_max = _filled64(rows["future_max_fare_24h"], np.nan)
    price_cents = cents(rows["price_eur"])
    check_price_cents = cents(rows["check_price_eur"])
    headroom = np.asarray(rows["headroom_pct"], dtype=np.int16)
    expected = breach(price_cents, check_price_cents, headroom)
    actual = np.asarray(rows["breached_next_day"], dtype=np.int8)
    if not np.array_equal(expected, actual):
        mismatches = int(np.sum(expected != actual))
        raise ModelError(f"{source} has {mismatches} label rows that disagree with the integer-cent definition")
    return TabularData(
        features=features,
        y=actual,
        series=_compact_text(rows["series_key"]) if compact else np.asarray(rows["series_key"], dtype=str),
        route_day=_compact_text(rows["route_day"]) if compact else np.asarray(rows["route_day"], dtype=str),
        price=_filled64(rows["price_eur"], np.nan),
        price_cents=price_cents,
        check_price=_filled64(rows["check_price_eur"], np.nan),
        check_price_cents=check_price_cents,
        check_price_2024=_filled64(rows["check_price_2024_eur"], np.nan),
        label_window_end=(
            _compact_datetime(rows["label_window_end"], "ms")
            if compact
            else np.asarray(rows["label_window_end"], dtype=str)
        ),
        future_max=future_max,
        future_observations=np.asarray(rows["future_observations"], dtype=np.int16),
        headroom=headroom,
        departure_date=(
            _compact_datetime(rows["departure_date"], "D") if compact else np.asarray(rows["departure_date"], dtype=str)
        ),
        snapshot_at=(
            _compact_datetime(rows["snapshot_at"], "ms") if compact else np.asarray(rows["snapshot_at"], dtype=str)
        ),
        observation_era=_compact_category(rows["observation_era"])
        if compact
        else _categorical(rows["observation_era"]),
        observation_week=(
            _compact_category(rows["observation_week"]) if compact else _categorical(rows["observation_week"])
        ),
        chain=_compact_text(rows["chain_id"]) if compact else np.asarray(rows["chain_id"], dtype=str),
    )


def load_splits(paths: list[Path], spec: FeatureSpec) -> TabularData:
    """Load the four splits in one query into the compact backtest panel."""
    columns = _split_columns(spec)
    selects = [
        f"SELECT {columns}, {index} AS split_order FROM read_parquet('{sql_string(path.as_posix())}') "
        "WHERE label_observed"
        for index, path in enumerate(paths)
    ]
    query = " UNION ALL ".join(selects) + " ORDER BY split_order, series_key, snapshot_at, bin_regime, bin_index"
    connection = duckdb.connect()
    try:
        rows = connection.execute(query).fetchnumpy()
    finally:
        connection.close()
    return _tabular(rows, spec, compact=True, source="panel")


def load_split(path: Path, spec: FeatureSpec) -> TabularData:
    """Load a Parquet split into numpy arrays, preserving nulls as NaN/missing categories.

    Only rows whose next-day check fare is known are loaded: the training, calibration and
    evaluation populations are identical. The stored label is verified against the shared
    integer-cent definition, so a SQL/Python drift fails the run instead of training silently.
    """
    connection = duckdb.connect()
    try:
        rows = connection.execute(
            f"SELECT {_split_columns(spec)} FROM read_parquet('{sql_string(path.as_posix())}') "
            "WHERE label_observed "
            "ORDER BY series_key, snapshot_at, bin_regime, bin_index"
        ).fetchnumpy()
    finally:
        connection.close()
    return _tabular(rows, spec, compact=False, source=str(path))


def _cat_matrix(data: TabularData, spec: FeatureSpec) -> Array:
    """Stack categorical feature columns for the encoder."""
    categories = [data.features[feature.name] for feature in spec.features if feature.kind == CATEGORICAL]
    if not categories:
        raise ModelError("the feature spec has no categorical columns")
    return np.column_stack(categories)


def fit_encoder(data: TabularData, spec: FeatureSpec) -> OrdinalEncoder:
    """Fit the ordinal encoder on the training panel."""
    encoder = OrdinalEncoder(
        handle_unknown="use_encoded_value",
        unknown_value=-1,
        encoded_missing_value=-1,
    )
    encoder.fit(_cat_matrix(data, spec))
    return encoder


def _matrix(data: TabularData, spec: FeatureSpec, encoder: OrdinalEncoder, headroom: int | None = None) -> Array:
    """Build the numeric model matrix, optionally overriding headroom."""
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
    """Return feature positions for the requested kinds."""
    return [index for index, feature in enumerate(spec.features) if feature.kind in kinds]


def _usable_columns(
    matrix: Array,
    categorical: list[int],
    names: tuple[str, ...],
    *,
    rows: Array | None = None,
) -> tuple[tuple[int, ...], tuple[str, ...]]:
    """Drop columns with no usable split; HistGB cannot bin a constant/all-null feature."""
    usable: list[int] = []
    dropped: list[str] = []
    categorical_set = set(categorical)
    view = matrix if rows is None else matrix[rows]
    for index in range(view.shape[1]):
        column = view[:, index]
        values = column if index in categorical_set else column[~np.isnan(column)]
        if values.size >= 2 and np.any(values != values[0]):
            usable.append(index)
        else:
            dropped.append(names[index])
    return tuple(usable), tuple(dropped)


EARLY_STOPPING_DAYS = 7
EARLY_STOPPING_MAX_ITER = 400
EARLY_STOPPING_PATIENCE = 50
EARLY_STOPPING_TOLERANCE = 1e-4
LOGISTIC_RELATIVE_FEATURES = ("price_change_24h", "price_velocity_24h")
LOGISTIC_SPLINE_KNOTS = 6


@dataclass
class FittedModel:
    """A fitted estimator together with its feature encoder and selected columns."""

    name: str
    estimator: Any
    encoder: OrdinalEncoder
    spec: FeatureSpec
    selected: tuple[int, ...] | None = None
    dropped: tuple[str, ...] = ()
    early_stopping: dict[str, Any] | None = None

    def transform(self, data: TabularData) -> Array:
        """Build the model matrix for the panel."""
        matrix = _matrix(data, self.spec, self.encoder)
        if self.selected is not None:
            matrix = matrix[:, list(self.selected)]
        return matrix

    def with_headroom(self, matrix: Array, headroom: int) -> Array:
        """Return a copy of the matrix with a different headroom column."""
        index = next(
            (position for position, feature in enumerate(self.spec.features) if feature.name == "headroom_pct"),
            None,
        )
        if index is None:
            return matrix
        if self.selected is not None:
            if index not in self.selected:
                return matrix
            index = self.selected.index(index)
        adjusted = matrix.copy()
        adjusted[:, index] = float(headroom)
        return adjusted

    def predict_matrix(self, matrix: Array) -> Array:
        """Return probabilities for an already encoded matrix."""
        probabilities = self.estimator.predict_proba(matrix)[:, 1]
        return np.asarray(probabilities, dtype=np.float64)

    def predict(self, data: TabularData, headroom: int | None = None) -> Array:
        """Return model probabilities for the supplied rows."""
        matrix = _matrix(data, self.spec, self.encoder, headroom)
        if self.selected is not None:
            matrix = matrix[:, list(self.selected)]
        return self.predict_matrix(matrix)


class BaseRateModel:
    """A constant-probability baseline."""

    def __init__(self, rate: float) -> None:
        """Initialise the instance."""
        self.rate = float(rate)

    def predict_proba(self, matrix: Array) -> Array:
        """Return class probabilities for the supplied matrix."""
        return np.column_stack([np.full(len(matrix), 1.0 - self.rate), np.full(len(matrix), self.rate)])


class LogisticPrep(BaseEstimator, TransformerMixin):
    """Numeric transforms and categorical encoding for the upgraded logistic candidate.

    The headroom enters as ``log(1 + headroom)``, hours to departure as a natural spline, and the
    absolute 24 h fare changes as fractions of the current fare. Median imputation with missing
    indicators and one-hot categories follow the shared matrix.
    """

    def __init__(self, spec: FeatureSpec) -> None:
        """Initialise the transformer for one feature specification."""
        self.spec = spec

    def _numeric(self, matrix: Array) -> Array:
        """Build the numeric block, expanding the spline and relative fares."""
        blocks: list[Array] = []
        price_index = self.spec.names.index("price_eur") if "price_eur" in self.spec.names else None
        price = matrix[:, price_index].astype(np.float64) if price_index is not None else None
        for index in self.numeric_:
            name = self.spec.names[index]
            column = np.asarray(matrix[:, index], dtype=np.float64)
            if index == self.hours_index_:
                blocks.append(np.asarray(self.spline_.transform(column.reshape(-1, 1)), dtype=np.float64))
            elif name == "headroom_pct":
                blocks.append(np.log1p(np.clip(column, 0.0, None)).reshape(-1, 1))
            elif name in LOGISTIC_RELATIVE_FEATURES and price is not None:
                relative = np.full(len(column), np.nan, dtype=np.float64)
                valid = np.isfinite(column) & np.isfinite(price) & (price > 0)
                relative[valid] = column[valid] / price[valid]
                blocks.append(relative.reshape(-1, 1))
            else:
                blocks.append(column.reshape(-1, 1))
        if not blocks:
            return np.empty((len(matrix), 0), dtype=np.float64)
        return np.column_stack(blocks)

    def fit(self, matrix: Array, y: Array | None = None) -> LogisticPrep:
        """Fit the spline, imputer, scaler and category encoder."""
        self.numeric_ = [index for index, feature in enumerate(self.spec.features) if feature.kind != CATEGORICAL]
        self.categorical_ = [index for index, feature in enumerate(self.spec.features) if feature.kind == CATEGORICAL]
        self.hours_index_ = self.spec.names.index("hours_to_departure")
        self.spline_ = SplineTransformer(
            n_knots=LOGISTIC_SPLINE_KNOTS,
            degree=3,
            include_bias=False,
            extrapolation="linear",
        )
        self.spline_.fit(np.asarray(matrix[:, self.hours_index_], dtype=np.float64).reshape(-1, 1))
        numeric = self._numeric(matrix)
        self.imputer_ = SimpleImputer(strategy="median", add_indicator=True, keep_empty_features=True)
        self.scaler_ = StandardScaler()
        self.scaler_.fit(self.imputer_.fit_transform(numeric))
        self.encoder_ = OneHotEncoder(handle_unknown="ignore", sparse_output=False, dtype=np.float32)
        self.encoder_.fit(np.asarray(matrix[:, self.categorical_], dtype=np.float64))
        return self

    def transform(self, matrix: Array) -> Array:
        """Apply the fitted transforms and return a dense matrix."""
        numeric = self.scaler_.transform(self.imputer_.transform(self._numeric(matrix)))
        parts = [numeric]
        if self.categorical_:
            categories = np.asarray(matrix[:, self.categorical_], dtype=np.float64)
            parts.append(self.encoder_.transform(categories))
        return np.asarray(np.hstack(parts), dtype=np.float32)


def _log_loss_at(y: Array, probabilities: Array) -> float:
    """Return the clipped binary log loss for one probability vector."""
    clipped = np.clip(probabilities, 1e-9, 1.0 - 1e-9)
    return float(-np.mean(y * np.log(clipped) + (1.0 - y) * np.log(1.0 - clipped)))


def _early_stopping_plan(losses: list[float]) -> tuple[int, int]:
    """Return the best iteration and the iteration where patience would stop."""
    if not losses:
        return 1, 1
    best = int(np.argmin(losses)) + 1
    stop = len(losses)
    for index in range(best - 1, len(losses)):
        if index + 1 - best >= EARLY_STOPPING_PATIENCE and losses[index] > losses[best - 1] - EARLY_STOPPING_TOLERANCE:
            stop = index + 1
            break
    return best, stop


def _holdout_mask(snapshot_at: Array) -> Array | None:
    """Return the last training week's rows, or None when it is too small to judge."""
    snapshot = np.asarray(snapshot_at, dtype="datetime64[ms]")
    if len(snapshot) < 200:
        return None
    holdout = snapshot > snapshot.max() - np.timedelta64(EARLY_STOPPING_DAYS, "D")
    if int(holdout.sum()) < 100 or int((~holdout).sum()) < 100:
        return None
    return holdout


def _fit_hgb_with_early_stopping(
    matrix: Array,
    y: Array,
    snapshot_at: Array,
    *,
    estimator_settings: dict[str, Any],
    monotonic: list[int],
    categorical: list[int],
    max_iter: int,
) -> tuple[Any, dict[str, Any]]:
    """Fit HGB on all but the last training week, pick the iteration, then refit on all rows."""
    started = time.perf_counter()
    limit = min(EARLY_STOPPING_MAX_ITER, int(max_iter))
    holdout = _holdout_mask(snapshot_at)
    if holdout is None or len(np.unique(y[holdout])) < 2:
        empty = np.zeros(len(matrix), dtype=bool)
        estimator = HistGradientBoostingClassifier(
            max_iter=limit,
            early_stopping=False,
            categorical_features=categorical,
            monotonic_cst=monotonic,
            **estimator_settings,
        ).fit(matrix, y)
        return estimator, {
            "fallback": True,
            "iterations": limit,
            "holdout_rows": int(empty.sum() if holdout is None else holdout.sum()),
            "fit_seconds": round(time.perf_counter() - started, 3),
            "refit_seconds": 0.0,
        }
    probe = HistGradientBoostingClassifier(
        max_iter=limit,
        early_stopping=False,
        categorical_features=categorical,
        monotonic_cst=monotonic,
        **estimator_settings,
    ).fit(matrix[~holdout], y[~holdout])
    fit_seconds = time.perf_counter() - started
    losses = [_log_loss_at(y[holdout], stage[:, 1]) for stage in probe.staged_predict_proba(matrix[holdout])]
    best, stop = _early_stopping_plan(losses)
    refit_started = time.perf_counter()
    estimator = HistGradientBoostingClassifier(
        max_iter=best,
        early_stopping=False,
        categorical_features=categorical,
        monotonic_cst=monotonic,
        **estimator_settings,
    ).fit(matrix, y)
    refit_seconds = time.perf_counter() - refit_started
    return estimator, {
        "fallback": False,
        "iterations": best,
        "stop_iteration": stop,
        "holdout_rows": int(holdout.sum()),
        "holdout_log_loss": float(losses[best - 1]),
        "train_log_loss": _log_loss_at(y, estimator.predict_proba(matrix)[:, 1]),
        "fit_seconds": round(fit_seconds, 3),
        "refit_seconds": round(refit_seconds, 3),
    }


def fit_candidate(
    name: str,
    data: TabularData,
    spec: FeatureSpec,
    config: TrainingConfig,
    *,
    encoder: OrdinalEncoder | None = None,
    matrix: Array | None = None,
) -> FittedModel:
    """Fit one candidate model on the training panel."""
    if name not in MODEL_NAMES:
        raise ModelError(f"unknown model {name!r}; supported: {', '.join(MODEL_NAMES)}")
    encoder = fit_encoder(data, spec) if encoder is None else encoder
    matrix = _matrix(data, spec, encoder) if matrix is None else matrix
    if name == "base_rate":
        estimator: Any = BaseRateModel(float(np.mean(data.y)))
    elif name == "logistic":
        estimator = Pipeline(
            [
                ("preprocess", LogisticPrep(spec)),
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
        holdout = _holdout_mask(data.snapshot_at)
        if holdout is not None:
            probe_selected, _ = _usable_columns(matrix, categorical, spec.names, rows=~holdout)
            keep = set(probe_selected)
            selected = tuple(index for index in selected if index in keep)
            if not selected:
                raise ModelError("no feature has two distinct values")
            dropped = tuple(name for index, name in enumerate(spec.names) if index not in set(selected))
        remapped = [position for position, index in enumerate(selected) if index in set(categorical)]
        monotonic = [0] * len(selected)
        headroom_index = spec.names.index("headroom_pct")
        if headroom_index in selected:
            monotonic[selected.index(headroom_index)] = -1
        estimator, early_stopping = _fit_hgb_with_early_stopping(
            matrix[:, list(selected)],
            data.y,
            data.snapshot_at,
            estimator_settings={
                "learning_rate": config.model.learning_rate,
                "max_leaf_nodes": config.model.max_leaf_nodes,
                "random_state": config.model.random_state,
            },
            monotonic=monotonic,
            categorical=remapped,
            max_iter=config.model.max_iter,
        )
        return FittedModel(
            name=name,
            estimator=estimator,
            encoder=encoder,
            spec=spec,
            selected=selected,
            dropped=dropped,
            early_stopping=early_stopping,
        )
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
        """Return model probabilities for the supplied rows."""
        hours = np.asarray(data.features["hours_to_departure"], dtype=np.float64)
        heads = np.asarray(
            data.headroom if headroom is None else np.full(len(data), int(headroom), dtype=np.int16),
            dtype=np.int64,
        )
        classes = np.asarray(data.features["service_class"], dtype=str)
        labels = np.asarray([band[0] for band in CLIMATOLOGY_BANDS], dtype=object)
        band_positions = {str(label): index for index, label in enumerate(labels)}
        max_head = max(100, int(heads.max()) if len(heads) else 100)
        head_values = np.full(max_head + 1, self.global_rate, dtype=np.float64)
        for head, rate in self.headroom.items():
            if 0 <= head <= max_head:
                head_values[head] = rate
        band_head_values = np.repeat(head_values[None, :], len(labels), axis=0)
        for (band, head), rate in self.band_headroom.items():
            if band in band_positions and 0 <= head <= max_head:
                band_head_values[band_positions[band], head] = rate
        class_labels, class_inverse = np.unique(classes, return_inverse=True)
        cell_values = np.repeat(band_head_values[:, :, None], len(class_labels) + 1, axis=2)
        class_positions = {str(label): index for index, label in enumerate(class_labels)}
        for (band, head, service_class), rate in self.cells.items():
            if band in band_positions and 0 <= head <= max_head and service_class in class_positions:
                cell_values[band_positions[band], head, class_positions[service_class]] = rate
        band_index = _band_index(hours, CLIMATOLOGY_BANDS)
        clipped_bands = np.clip(band_index, 0, len(labels) - 1)
        clipped_heads = np.clip(heads, 0, max_head)
        values = cell_values[clipped_bands, clipped_heads, class_inverse]
        valid = (
            np.isfinite(hours) & (hours >= float(CLIMATOLOGY_BANDS[0][1])) & (hours <= float(CLIMATOLOGY_BANDS[-1][2]))
        )
        if not np.all(valid):
            fallback = np.asarray(
                [
                    self.band_headroom.get(
                        ("unknown", int(head)),
                        self.headroom.get(int(head), self.global_rate),
                    )
                    for head in heads[~valid]
                ],
                dtype=np.float64,
            )
            values[~valid] = fallback
        return values


def fit_climatology(data: TabularData, *, strength: float = 50.0) -> ClimatologyModel:
    """Fit a hierarchical prevalence baseline with a Beta-style prior on thin cells."""
    hours = np.asarray(data.features["hours_to_departure"], dtype=np.float64)
    bands = _band_labels(hours, CLIMATOLOGY_BANDS)
    heads = np.asarray(data.headroom, dtype=np.int64)
    classes = np.asarray(data.features["service_class"], dtype=str)
    global_count = len(data)
    global_positives = int(np.sum(data.y))
    global_rate = (global_positives + 1.0) / (global_count + 2.0)

    head_keys, head_inverse = np.unique(heads, return_inverse=True)
    head_counts = np.bincount(head_inverse, minlength=len(head_keys))
    head_positives = np.bincount(head_inverse, weights=data.y, minlength=len(head_keys))
    head_rate = {
        int(key): (int(positive) + strength * global_rate) / (int(count) + strength)
        for key, count, positive in zip(head_keys, head_counts, head_positives, strict=True)
    }

    band_values, band_inverse = np.unique(bands, return_inverse=True)
    band_head = band_inverse * len(head_keys) + head_inverse
    band_counts = np.bincount(band_head, minlength=len(band_values) * len(head_keys))
    band_positives = np.bincount(band_head, weights=data.y, minlength=len(band_values) * len(head_keys))
    band_rate: dict[tuple[str, int], float] = {}
    for band_position, band in enumerate(band_values):
        for head_position, head in enumerate(head_keys):
            index = band_position * len(head_keys) + head_position
            band_rate[(str(band), int(head))] = (int(band_positives[index]) + strength * head_rate[int(head)]) / (
                int(band_counts[index]) + strength
            )

    class_labels, class_inverse = np.unique(classes, return_inverse=True)
    cell = (band_inverse * len(head_keys) + head_inverse) * len(class_labels) + class_inverse
    cell_counts = np.bincount(cell, minlength=len(band_values) * len(head_keys) * len(class_labels))
    cell_positives = np.bincount(cell, weights=data.y, minlength=len(band_values) * len(head_keys) * len(class_labels))
    cell_rate: dict[tuple[str, int, str], float] = {}
    for band_position, band in enumerate(band_values):
        for head_position, head in enumerate(head_keys):
            for class_position, service_class in enumerate(class_labels):
                index = (band_position * len(head_keys) + head_position) * len(class_labels) + class_position
                cell_rate[(str(band), int(head), str(service_class))] = (
                    int(cell_positives[index]) + strength * band_rate[(str(band), int(head))]
                ) / (int(cell_counts[index]) + strength)

    return ClimatologyModel(
        cells=cell_rate,
        band_headroom=band_rate,
        headroom=head_rate,
        global_rate=global_rate,
    )


CALIBRATION_EPS = 1e-6
# The static legacy path keeps its three original methods so its byte-identity check stays valid;
# the covariate calibrator is a backtest candidate only.
STATIC_CALIBRATION_METHODS = ("sigmoid", "isotonic", "temperature")
_COVARIATE_BANDS = tuple(label for label, _, _ in HEADLINE_BANDS)


def _logit(values: Array) -> Array:
    """Return the logit of clipped probabilities."""
    clipped = np.clip(np.asarray(values, dtype=np.float64), CALIBRATION_EPS, 1.0 - CALIBRATION_EPS)
    return np.log(clipped / (1.0 - clipped))


class CovariateCalibrator:
    """A logistic calibrator on the score, the TTD band and the headroom.

    The score enters as a logit, the band as dummies (the first band is the reference) with
    band x logit interactions, and the headroom as ``log(1 + headroom)``. One calibrator therefore
    serves every headroom and every distance to departure.
    """

    def design(self, raw: Array, hours: Array, headroom: Array) -> Array:
        """Return the covariate design matrix."""
        score = _logit(raw)
        bands = _band_labels(np.asarray(hours, dtype=np.float64), HEADLINE_BANDS)
        dummies = np.column_stack([bands == label for label in _COVARIATE_BANDS[1:]]).astype(np.float64)
        head = np.full(len(score), np.nan) if headroom is None else np.asarray(headroom, dtype=np.float64)
        return np.column_stack(
            [
                score,
                dummies,
                dummies * score[:, None],
                np.log1p(np.clip(head, 0.0, None)),
            ]
        )

    def fit(self, raw: Array, y: Array, hours: Array, headroom: Array) -> CovariateCalibrator:
        """Fit the logistic regression on the calibration block."""
        self.model = LogisticRegression(C=1e6, solver="lbfgs", max_iter=1000)
        self.model.fit(self.design(raw, hours, headroom), y)
        return self

    def predict(self, raw: Array, hours: Array, headroom: Array) -> Array:
        """Return calibrated probabilities for the supplied rows."""
        return np.asarray(self.model.predict_proba(self.design(raw, hours, headroom))[:, 1], dtype=np.float64)


def _band_midpoints() -> dict[str, float]:
    """Return one representative hour value for every headline band."""
    return {label: (low + high) / 2.0 for label, low, high in HEADLINE_BANDS}


def _covariate_constraints(calibrator: CovariateCalibrator, headroom: Array) -> tuple[bool, str]:
    """Check monotonicity in score per band and non-increase in headroom."""
    heads = np.asarray(headroom, dtype=np.float64)
    reference_head = float(np.median(heads)) if len(heads) else 5.0
    scores = np.linspace(0.01, 0.99, 41)
    for label, hours in _band_midpoints().items():
        values = calibrator.predict(scores, np.full(len(scores), hours), np.full(len(scores), reference_head))
        if np.any(np.diff(values) < -1e-9):
            return False, f"not monotone in score in band {label}"
    steps = np.asarray([1.0, 5.0, 10.0, 20.0, 30.0])
    reference_score = float(np.median(scores))
    for label, hours in _band_midpoints().items():
        values = calibrator.predict(
            np.full(len(steps), reference_score),
            np.full(len(steps), hours),
            steps,
        )
        if np.any(np.diff(values) > 1e-9):
            return False, f"not non-increasing in headroom in band {label}"
    return True, ""


class ScoreCalibrator:
    """A calibrator over raw probabilities, fitted on a held-out slice."""

    def __init__(
        self,
        method: str,
        model: Any,
        temperature: float | None = None,
        *,
        requested: str | None = None,
        fallback: bool = False,
        fallback_reason: str | None = None,
    ) -> None:
        """Initialise the instance."""
        self.method = method
        self.model = model
        self.temperature = temperature
        self.requested = requested or method
        self.fallback = fallback
        self.fallback_reason = fallback_reason

    def predict(self, raw: Array, *, hours: Array | None = None, headroom: Array | None = None) -> Array:
        """Return calibrated probabilities for the supplied rows."""
        clipped = np.clip(raw, CALIBRATION_EPS, 1.0 - CALIBRATION_EPS)
        if self.method == "constant":
            values = np.full(len(clipped), float(self.model), dtype=np.float64)
        elif self.method == "temperature":
            if self.temperature is None:
                raise ModelError("temperature calibrator has no fitted temperature")
            values = expit(_logit(clipped) / float(self.temperature))
        elif self.method == "isotonic":
            values = self.model.predict(clipped)
        elif self.method == "covariate":
            if hours is None or headroom is None:
                raise ModelError("the covariate calibrator needs hours_to_departure and headroom")
            values = self.model.predict(clipped, np.asarray(hours, dtype=np.float64), headroom)
        else:
            values = self.model.predict_proba(clipped.reshape(-1, 1))[:, 1]
        return np.asarray(np.clip(values, CALIBRATION_EPS, 1.0 - CALIBRATION_EPS), dtype=np.float64)


def fit_calibrator(
    raw: Array,
    y: Array,
    method: str,
    *,
    min_positives: int,
    hours: Array | None = None,
    headroom: Array | None = None,
) -> ScoreCalibrator:
    """Fit and return a probability calibrator with the requested and fitted method."""
    clipped = np.clip(raw, CALIBRATION_EPS, 1.0 - CALIBRATION_EPS)
    requested = method
    if len(np.unique(y)) < 2:
        return ScoreCalibrator(
            "constant",
            float(np.mean(y)),
            requested=requested,
            fallback=True,
            fallback_reason="single-class calibration block",
        )
    positives = int(np.sum(y))
    if method == "isotonic" and positives < min_positives:
        method = "sigmoid"
        fallback = True
        fallback_reason = f"isotonic needs {min_positives} positives, got {positives}"
    else:
        fallback = False
        fallback_reason = None
    if method == "sigmoid":
        model = LogisticRegression(C=1e6, solver="lbfgs", max_iter=1000)
        model.fit(clipped.reshape(-1, 1), y)
        return ScoreCalibrator(
            "sigmoid", model, requested=requested, fallback=fallback, fallback_reason=fallback_reason
        )
    if method == "isotonic":
        model = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
        model.fit(clipped, y)
        return ScoreCalibrator("isotonic", model, requested=requested)
    if method == "temperature":
        logits = _logit(clipped)

        def loss(log_temperature: float) -> float:
            """Return the calibration loss for one temperature."""
            probabilities = np.clip(expit(logits / np.exp(log_temperature)), 1e-9, 1.0 - 1e-9)
            return float(-np.mean(y * np.log(probabilities) + (1 - y) * np.log(1.0 - probabilities)))

        result = minimize_scalar(loss, bounds=(-3.0, 3.0), method="bounded")
        return ScoreCalibrator("temperature", None, float(np.exp(result.x)), requested=requested)
    if method == "covariate":
        if hours is None or headroom is None:
            raise ModelError("the covariate calibrator needs hours_to_departure and headroom")
        calibrator = CovariateCalibrator().fit(clipped, y, hours, headroom)
        monotone, reason = _covariate_constraints(calibrator, np.asarray(headroom, dtype=np.float64))
        if not monotone:
            model = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
            model.fit(clipped, y)
            return ScoreCalibrator(
                "isotonic",
                model,
                requested=requested,
                fallback=True,
                fallback_reason=reason,
            )
        return ScoreCalibrator("covariate", calibrator, requested=requested)
    raise ModelError(f"unknown calibration method {method!r}")


def _metric_value(value: float | None, default: float = 1.0) -> float:
    """Return a metric value, or a fallback for None."""
    return default if value is None else float(value)


def _metrics(y: Array, probabilities: Array) -> dict[str, float | None]:
    """Compute Brier, log loss, skill, AUC and AP."""
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


def _cross_fitted_detailed(
    raw: Array,
    y: Array,
    groups: Array,
    method: str,
    config: TrainingConfig,
    *,
    hours: Array | None = None,
    headroom: Array | None = None,
) -> tuple[Array, Array, tuple[dict[str, Any], ...]]:
    """Fit the calibrator out-of-fold and return predictions, fold ids and fitted methods."""
    unique = np.unique(groups)
    folds = min(config.calibration.folds, len(unique))
    if folds < 2:
        raise ModelError("cross-fitting needs at least two groups; refusing to score in-sample")
    splitter = GroupKFold(n_splits=folds)
    predicted = np.full(len(raw), np.nan, dtype=np.float64)
    fold_ids = np.full(len(raw), -1, dtype=np.int16)
    methods: list[dict[str, Any]] = []
    for fold, (fit_idx, predict_idx) in enumerate(splitter.split(raw, y, groups)):
        calibrator = fit_calibrator(
            raw[fit_idx],
            y[fit_idx],
            method,
            min_positives=config.calibration.min_positives,
            hours=None if hours is None else hours[fit_idx],
            headroom=None if headroom is None else headroom[fit_idx],
        )
        predicted[predict_idx] = calibrator.predict(
            raw[predict_idx],
            hours=None if hours is None else hours[predict_idx],
            headroom=None if headroom is None else headroom[predict_idx],
        )
        fold_ids[predict_idx] = fold
        methods.append(
            {
                "fold": fold,
                "requested": calibrator.requested,
                "fitted": calibrator.method,
                "fallback": calibrator.fallback,
                "fallback_reason": calibrator.fallback_reason,
            }
        )
    if np.isnan(predicted).any():
        raise ModelError("cross-fitted calibration left rows without a prediction")
    return predicted, fold_ids, tuple(methods)


def _cross_fitted_with_folds(
    raw: Array,
    y: Array,
    groups: Array,
    method: str,
    config: TrainingConfig,
    *,
    hours: Array | None = None,
    headroom: Array | None = None,
) -> tuple[Array, Array]:
    """Fit the calibrator out-of-fold and return predictions plus fold ids."""
    predicted, fold_ids, _ = _cross_fitted_detailed(raw, y, groups, method, config, hours=hours, headroom=headroom)
    return predicted, fold_ids


def _cross_fitted(
    raw: Array,
    y: Array,
    groups: Array,
    method: str,
    config: TrainingConfig,
    *,
    hours: Array | None = None,
    headroom: Array | None = None,
) -> Array:
    """Return out-of-fold calibrated predictions by group."""
    return _cross_fitted_with_folds(raw, y, groups, method, config, hours=hours, headroom=headroom)[0]


def _hours(data: TabularData) -> Array:
    """Return hours to departure as a float array."""
    return np.asarray(data.features["hours_to_departure"], dtype=np.float64)


@dataclass(frozen=True)
class Evaluation:
    """The fitted model, calibration and evaluation diagnostics for the static path."""

    chosen_model: str
    calibration_method: str
    threshold: float
    threshold_precision_floor_met: bool
    candidates: dict[str, dict[str, float | None]]
    metrics: dict[str, Any]
    metrics_all: dict[str, Any] | None
    evaluation_tier: str
    evaluation_tier_rows: int
    calibration_rows: int
    evaluation_split: str
    evaluation_on_test: bool
    calibration_prevalence: float
    train_prevalence: float
    dropped_features: tuple[str, ...]
    headroom: tuple[dict[str, Any], ...]
    importance: tuple[dict[str, Any], ...]
    bootstrap: dict[str, list[float]]
    split_sizes: dict[str, int]
    calibration: tuple[Array, Array, Array] = field(compare=False)
    calibration_constant: bool = False
    candidate_train: dict[str, dict[str, float | None]] = field(default_factory=dict)
    candidate_calibration_method: str = ""
    headroom_ttd: tuple[dict[str, Any], ...] = ()
    strata: tuple[dict[str, Any], ...] = ()
    strata_compare: tuple[dict[str, Any], ...] = ()
    calibration_stats: dict[str, float | None] = field(default_factory=dict)
    calibration_groups: tuple[dict[str, Any], ...] = ()
    climatology: dict[str, Any] = field(default_factory=dict)
    decision_value: tuple[dict[str, Any], ...] = ()
    decision_value_pooled: tuple[dict[str, Any], ...] = ()
    intervals: dict[str, list[float]] = field(default_factory=dict)
    paired: dict[str, Any] = field(default_factory=dict)
    bootstrap_clusters: int = 0
    prediction_series: Array | None = field(default=None, repr=False, compare=False)
    prediction_chain: Array | None = field(default=None, repr=False, compare=False)
    prediction_snapshot_at: Array | None = field(default=None, repr=False, compare=False)
    prediction_route_day: Array | None = field(default=None, repr=False, compare=False)
    prediction_headroom: Array | None = field(default=None, repr=False, compare=False)
    prediction_raw: Array | None = field(default=None, repr=False, compare=False)
    prediction_raw_pooled: Array | None = field(default=None, repr=False, compare=False)
    prediction_calibration_fold: Array | None = field(default=None, repr=False, compare=False)
    prediction_calibration_mode: str = field(default="", repr=False, compare=False)
    prediction_calibrated: Array | None = field(default=None, repr=False, compare=False)
    prediction_y: Array | None = field(default=None, repr=False, compare=False)
    prediction_assigned_headroom: Array | None = field(default=None, repr=False, compare=False)
    prediction_calibrated_pooled: Array | None = field(default=None, repr=False, compare=False)
    prediction_departure_date: Array | None = field(default=None, repr=False, compare=False)
    prediction_ttd_band: Array | None = field(default=None, repr=False, compare=False)
    prediction_split: str = field(default="", repr=False, compare=False)

    def to_dict(self) -> dict[str, Any]:
        """Return a serialisable dictionary representation."""
        return {
            "chosen_model": self.chosen_model,
            "calibration_method": self.calibration_method,
            "calibration_constant": self.calibration_constant,
            "threshold": self.threshold,
            "threshold_precision_floor_met": self.threshold_precision_floor_met,
            "candidates": self.candidates,
            "candidate_train": self.candidate_train,
            "candidate_calibration_method": self.candidate_calibration_method,
            "metrics": {"split": self.evaluation_split, "values": self.metrics},
            "metrics_all": self.metrics_all,
            "evaluation_tier": self.evaluation_tier,
            "evaluation_tier_rows": self.evaluation_tier_rows,
            "calibration_rows": self.calibration_rows,
            "evaluation_on_test": self.evaluation_on_test,
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
            "split_sizes": {
                name: size for name, size in self.split_sizes.items() if self.evaluation_on_test or name != "test"
            },
            "headroom_ttd": list(self.headroom_ttd),
            "strata": list(self.strata),
            "strata_compare": list(self.strata_compare),
            "calibration_stats": self.calibration_stats,
            "calibration_groups": list(self.calibration_groups),
            "climatology": self.climatology,
            "decision_value": list(self.decision_value),
            "decision_value_pooled": list(self.decision_value_pooled),
            "intervals": self.intervals,
            "paired": self.paired,
            "bootstrap_clusters": self.bootstrap_clusters,
        }


WILSON_ONE_SIDED_Z = 1.6448536269514722


def _wilson_lower(successes: int, total: int, z: float = WILSON_ONE_SIDED_Z) -> float:
    """Return the one-sided Wilson lower bound of a proportion."""
    if total <= 0:
        return 0.0
    proportion = successes / total
    denominator = 1.0 + z * z / total
    centre = proportion + z * z / (2.0 * total)
    margin = z * np.sqrt(proportion * (1.0 - proportion) / total + z * z / (4.0 * total * total))
    return float(max(0.0, (centre - margin) / denominator))


def _cell_threshold(
    y: Array,
    probabilities: Array,
    floor: float,
    min_alerts: int,
) -> dict[str, Any]:
    """Choose the highest-recall threshold whose Wilson lower bound meets the precision floor."""
    labels = np.asarray(y, dtype=np.int8)
    scores = np.asarray(probabilities, dtype=np.float64)
    positives = int(np.sum(labels))
    row: dict[str, Any] = {
        "threshold": None,
        "alerts": 0,
        "precision": None,
        "recall": None,
        "wilson_lower": None,
        "qualified": False,
        "rows": len(labels),
        "positives": positives,
        "floor": float(floor),
        "min_alerts": int(min_alerts),
    }
    if len(labels) == 0 or positives == 0:
        return row
    order = np.argsort(-scores, kind="stable")
    sorted_scores = scores[order]
    sorted_labels = labels[order]
    # Every distinct score is a candidate cut; ties enter together so the result is deterministic.
    boundaries = np.flatnonzero(np.r_[sorted_scores[1:] != sorted_scores[:-1], True])
    true_positive = 0
    false_positive = 0
    best: tuple[float, float, int, float, float] | None = None
    for index in boundaries:
        true_positive = int(np.sum(sorted_labels[: index + 1] == 1))
        false_positive = int(index + 1 - true_positive)
        alerts = true_positive + false_positive
        if alerts < min_alerts:
            continue
        precision = true_positive / alerts
        lower = _wilson_lower(true_positive, alerts)
        recall = true_positive / positives
        if lower < floor:
            continue
        threshold = float(sorted_scores[index])
        candidate = (recall, threshold, alerts, precision, lower)
        if best is None or candidate[:2] > best[:2]:
            best = candidate
    if best is None:
        return row
    recall, threshold, alerts, precision, lower = best
    row.update(
        {
            "threshold": float(threshold),
            "alerts": int(alerts),
            "precision": float(precision),
            "recall": float(recall),
            "wilson_lower": float(lower),
            "qualified": True,
        }
    )
    return row


def _threshold(y: Array, probabilities: Array, floor: float) -> tuple[float, bool]:
    """Choose a threshold meeting the precision floor or maximising F1."""
    classes = np.unique(y)
    if len(classes) < 2:
        return (0.0, True) if classes[0] == 1 else (0.5, False)
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
    """Compute precision and recall at a threshold."""
    predicted = probabilities >= threshold
    true_positive = int(np.sum((predicted == 1) & (y == 1)))
    false_positive = int(np.sum((predicted == 1) & (y == 0)))
    false_negative = int(np.sum((predicted == 0) & (y == 1)))
    precision = true_positive / max(true_positive + false_positive, 1)
    recall = true_positive / max(true_positive + false_negative, 1)
    return {"precision_at_threshold": float(precision), "recall_at_threshold": float(recall)}


def _pr_curve_points(y: Array, probabilities: Array, targets: tuple[float, ...]) -> list[dict[str, float]]:
    """Return the best precision at or above every recall target."""
    precision, recall, _ = precision_recall_curve(y, probabilities)
    points: list[dict[str, float]] = []
    for target in targets:
        mask = recall >= target
        if not mask.any():
            continue
        points.append({"recall": float(target), "precision": float(np.max(precision[mask]))})
    return points


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
    if len(unique) < 2:
        return {}
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


def _band_index(hours: Array, bands: tuple[tuple[str, int, int], ...]) -> Array:
    """Return the TTD band index for each duration."""
    edges = np.asarray([band[1] for band in bands], dtype=np.float64)
    return np.searchsorted(edges, hours, side="right") - 1


def _band_labels(hours: Array, bands: tuple[tuple[str, int, int], ...]) -> Array:
    """Return TTD band labels, marking out-of-domain durations unknown."""
    index = _band_index(hours, bands)
    labels = np.asarray([band[0] for band in bands], dtype=object)
    valid = (
        np.isfinite(hours)
        & (hours >= float(bands[0][1]))
        & (hours <= float(bands[-1][2]))
        & (index >= 0)
        & (index < len(bands))
    )
    result = np.full(len(hours), "unknown", dtype=object)
    result[valid] = labels[index[valid]]
    return result


def _ttd_array(data: TabularData) -> Array:
    """Return the headline TTD band for each row."""
    hours = np.asarray(data.features["hours_to_departure"], dtype=np.float64)
    return _band_labels(hours, HEADLINE_BANDS).astype(str)


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


def _bootstrap_replicate(
    y: Array,
    probabilities: Array,
    clusters: list[Array],
    sampled: Array,
    threshold: float | Array,
) -> tuple[float, float, float, float, float, float, float]:
    """Bootstrap replicate."""
    indices = np.concatenate([clusters[index] for index in sampled])
    yy = y[indices]
    pp = np.clip(probabilities[indices], 1e-9, 1.0 - 1e-9)
    both = len(np.unique(yy)) == 2
    brier = float(brier_score_loss(yy, pp))
    base = float(np.mean(yy))
    bss = 1.0 - brier / (base * (1.0 - base)) if 0.0 < base < 1.0 else np.nan
    predicted = pp >= float(threshold) if np.isscalar(threshold) else pp >= np.asarray(threshold)[indices]
    true_positive = int(np.sum(predicted & (yy == 1)))
    false_positive = int(np.sum(predicted & (yy == 0)))
    false_negative = int(np.sum(~predicted & (yy == 1)))
    precision = true_positive / max(true_positive + false_positive, 1)
    recall = true_positive / max(true_positive + false_negative, 1)
    return (
        brier,
        float(log_loss(yy, pp, labels=[0, 1])),
        bss,
        float(roc_auc_score(yy, pp)) if both else np.nan,
        float(average_precision_score(yy, pp)) if both else np.nan,
        float(precision),
        float(recall),
    )


def _bootstrap_metrics(
    y: Array,
    probabilities: Array,
    groups: Array,
    replicates: int,
    seed: int,
    threshold: float | Array,
) -> dict[str, list[float]]:
    """Cluster bootstrap for the headline metrics that cannot use sufficient statistics."""
    unique, inverse = np.unique(groups, return_inverse=True)
    if len(unique) < 2 or len(y) < 2:
        return {}
    clusters = [np.flatnonzero(inverse == index) for index in range(len(unique))]
    rng = np.random.default_rng(seed)
    samples = [rng.integers(0, len(unique), size=len(unique)) for _ in range(replicates)]
    workers = min(6, joblib.cpu_count() or 1)
    if replicates < 8 or workers == 1:
        rows = [_bootstrap_replicate(y, probabilities, clusters, sampled, threshold) for sampled in samples]
    else:
        rows = joblib.Parallel(n_jobs=workers, prefer="threads")(
            joblib.delayed(_bootstrap_replicate)(y, probabilities, clusters, sampled, threshold) for sampled in samples
        )
    collected: dict[str, list[float]] = {
        key: [] for key in ("brier", "log_loss", "bss", "roc_auc", "average_precision", "precision", "recall")
    }
    for row in rows:
        for key, value in zip(collected, row, strict=True):
            collected[key].append(value)
    result: dict[str, list[float]] = {}
    for key, values in collected.items():
        if key in {"brier", "log_loss"}:
            continue
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
    """Return a cluster-bootstrap interval for a mean."""
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
    """Compute metrics for one report stratum."""
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
        "evidence_tier": np.where(data.future_observations >= 2, "two_plus", "one_or_none"),
    }
    train_dimensions = {
        "ttd_band": _ttd_array(train_data),
        "era": np.asarray(train_data.observation_era, dtype=str),
        "week": np.asarray(train_data.observation_week, dtype=str),
        "service_class": np.asarray(train_data.features["service_class"], dtype=str),
        "evidence_tier": np.where(train_data.future_observations >= 2, "two_plus", "one_or_none"),
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


def _decision_row(
    *,
    band: str,
    headroom_pct: int | None,
    price: Array,
    saving: Array,
    alert: Array,
    groups: Array,
    replicates: int,
    seed: int,
    labels: Array | None = None,
) -> dict[str, Any]:
    """One decision-value row for an alert mask and a set of check prices.

    ``saving`` is the check fare minus today's fare: positive when waiting costs more. An alert
    means booking now, so the policy saves the rise on alerted rows and nothing elsewhere.
    """
    saving_vs_wait = np.where(alert, saving, 0.0)
    saving_vs_book = -np.where(alert, 0.0, saving)
    row: dict[str, Any] = {
        "band": band,
        "rows": len(price),
        "alert_rows": int(alert.sum()),
        "alert_share": float(alert.mean()),
        "saving_vs_always_wait_eur": float(np.mean(saving_vs_wait)),
        "random_alert_saving_vs_wait_eur": float(alert.mean() * np.mean(saving)),
        "lift_vs_random_eur": float(np.mean(saving_vs_wait) - alert.mean() * np.mean(saving)),
        "saving_vs_always_wait_pct": float(np.sum(saving_vs_wait) / np.sum(price)),
        "saving_vs_always_book_eur": float(np.mean(saving_vs_book)),
        "saving_vs_always_book_pct": float(np.sum(saving_vs_book) / np.sum(price)),
        "conditional_saving_when_alert_eur": float(np.mean(saving[alert])) if alert.any() else None,
        "cost_of_waiting_eur": float(np.mean(saving)),
        "cost_of_waiting_pct": float(np.sum(saving) / np.sum(price)),
        "ci_saving_vs_wait_eur": _cluster_mean_ci(saving_vs_wait, groups, replicates, seed),
        "ci_saving_vs_book_eur": _cluster_mean_ci(saving_vs_book, groups, replicates, seed + 1),
    }
    if headroom_pct is not None:
        row["headroom_pct"] = int(headroom_pct)
    if labels is not None:
        truth = np.asarray(labels, dtype=np.int8)
        perfect = truth == 1
        row["perfect_breach_rows"] = int(perfect.sum())
        row["perfect_breach_vs_wait_eur"] = float(np.mean(np.where(perfect, saving, 0.0)))
        row["perfect_breach_vs_book_eur"] = float(np.mean(-np.where(perfect, 0.0, saving)))
        row["perfect_timing_vs_book_eur"] = float(np.mean(np.maximum(-saving, 0.0)))
    return row


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
            check_price = data.check_price_2024 if data.check_price_2024 is not None else data.check_price
            mask = (bands == band) & np.isfinite(check_price) & np.isfinite(data.price) & (data.price > 0)
            if int(mask.sum()) < 20:
                continue
            alert = probabilities_at_headroom[mask] >= threshold
            rows.append(
                _decision_row(
                    band=band,
                    headroom_pct=headroom,
                    price=data.price[mask],
                    saving=check_price[mask] - data.price[mask],
                    alert=alert,
                    groups=data.departure_date[mask],
                    replicates=replicates,
                    seed=seed,
                )
            )
    return rows


def _pooled_decision_value_rows(
    data: TabularData,
    probabilities: Array,
    bands: Array,
    threshold: float,
    replicates: int,
    seed: int,
) -> list[dict[str, Any]]:
    """Decision value of the shipped pooled calibrator, one row per TTD band."""
    rows: list[dict[str, Any]] = []
    for band in band_labels():
        check_price = data.check_price_2024 if data.check_price_2024 is not None else data.check_price
        mask = (bands == band) & np.isfinite(check_price) & np.isfinite(data.price) & (data.price > 0)
        if int(mask.sum()) < 20:
            continue
        alert = probabilities[mask] >= threshold
        rows.append(
            _decision_row(
                band=band,
                headroom_pct=None,
                price=data.price[mask],
                saving=check_price[mask] - data.price[mask],
                alert=alert,
                groups=data.departure_date[mask],
                replicates=replicates,
                seed=seed,
            )
        )
    return rows


def _canonical(data: TabularData) -> TabularData:
    """Return rows in canonical series and time order."""
    identity = data.chain if data.chain is not None else data.series
    order = np.lexsort(
        (
            np.asarray(data.snapshot_at, dtype=str),
            np.asarray(identity, dtype=str),
        )
    )
    return data.subset(order)


def _fit_candidates(
    train: TabularData,
    validation_select: TabularData,
    spec: FeatureSpec,
    config: TrainingConfig,
) -> tuple[dict[str, FittedModel], dict[str, dict[str, float | None]], dict[str, dict[str, float | None]]]:
    """Fit all configured candidates on the static training split."""
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
    """Choose a candidate using Brier and a logistic tie-break."""
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
) -> tuple[TabularData, ScoreCalibrator, str, bool, dict[str, Array], float, bool]:
    """Cross-fit, choose and fit the final static calibrator."""
    cal_data = validation_calibrate
    raw_cal = model.predict(cal_data)
    method_scores: dict[str, dict[str, float | None]] = {}
    oof_predictions: dict[str, Array] = {}
    for method in config.calibration.methods:
        if method not in STATIC_CALIBRATION_METHODS:
            continue
        oof_predictions[method] = _cross_fitted(raw_cal, cal_data.y, cal_data.route_day, method, config)
        method_scores[method] = _metrics(cal_data.y, oof_predictions[method])

    def _brier_key(name: str) -> float:
        """Return the Brier score used to rank calibration methods."""
        value = method_scores[name]["brier"]
        return 1.0 if value is None else float(value)

    requested = min(method_scores, key=_brier_key)
    calibrator = fit_calibrator(
        raw_cal,
        cal_data.y,
        requested,
        min_positives=config.calibration.min_positives,
    )
    # Preserve the requested method only for the single-class constant calibrator; otherwise
    # record the effective method (for example an isotonic-to-sigmoid fallback) and use its
    # matching out-of-fold predictions.
    calibration_constant = calibrator.method == "constant"
    method = requested if calibration_constant else calibrator.method
    if method not in oof_predictions:
        oof_predictions[method] = _cross_fitted(raw_cal, cal_data.y, cal_data.route_day, method, config)
    threshold, threshold_met = _threshold(
        cal_data.y,
        oof_predictions[method],
        config.report.threshold_precision_floor,
    )
    return cal_data, calibrator, method, calibration_constant, oof_predictions, threshold, threshold_met


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
    """Headroom diagnostics."""
    headroom: list[dict[str, Any]] = []
    headroom_ttd: list[dict[str, Any]] = []
    probabilities_by_headroom: list[Array] = []
    raw_by_headroom: list[Array] = []
    folds_by_headroom: list[Array] = []
    y_by_headroom: list[Array] = []
    for value in config.label.headroom_pct:
        y_headroom = breach(eval_rows.price_cents, eval_rows.check_price_cents, value)
        y_cal_headroom = breach(cal_data.price_cents, cal_data.check_price_cents, value)
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
        probabilities = calibrated
        raw_headroom = raw_apply
        folds_eval = folds
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
        clim_headroom = clim_calibrated
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
            band_bootstrap = _bootstrap(
                y_headroom[mask],
                probabilities[mask],
                eval_rows.departure_date[mask],
                config.report.metric_bootstrap_replicates,
                config.seed + value,
            )
            band_metrics["brier_ci"] = band_bootstrap.get("brier", [])
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
    """Calibration groups."""
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
    """Strata comparison."""
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
    test_split = splits["test"]
    identity_sets = {
        name: set((data.chain if data.chain is not None else data.series).tolist()) for name, data in splits.items()
    }
    names = list(identity_sets)
    for index, left in enumerate(names):
        for right in names[index + 1 :]:
            overlap = identity_sets[left] & identity_sets[right]
            if overlap:
                raise ModelError(f"chain crosses splits {left}/{right}: {next(iter(overlap))}")

    candidates, candidate_metrics, candidate_train_metrics = _fit_candidates(train, validation_select, spec, config)
    chosen = _choose_candidate(candidate_metrics)
    model = candidates[chosen]
    (
        cal_data,
        calibrator,
        calibration_method,
        calibration_constant,
        oof_predictions,
        threshold,
        threshold_met,
    ) = _fit_final_calibration(model, validation_calibrate, config)

    eval_data = test_split if evaluate_test else cal_data
    evaluation_split = "test" if evaluate_test else "validation_calibrate"
    metrics_all = None
    # One population: every eligible snapshot with a known next-day check fare. The old
    # two-or-more-scrape tier is a diagnostic stratum only.
    evaluation_tier = "all_labelled_rows"
    eval_rows = eval_data
    train_eval = train
    raw_eval_source = model.predict(eval_data)
    calibrated_eval = calibrator.predict(raw_eval_source) if evaluate_test else oof_predictions[calibration_method]
    raw_pooled_eval = raw_eval_source
    bands_eval = _ttd_array(eval_rows)
    bands_train = _ttd_array(train_eval)

    metrics = _metrics(eval_rows.y, calibrated_eval)
    train_rate = _train_prevalence(train)
    metrics["bss_train"] = _bss_train(metrics["brier"], eval_rows.y, train_rate)
    metrics["threshold"] = threshold
    metrics.update(_decision_metrics(eval_rows.y, calibrated_eval, threshold))
    metrics["precision_floor_met_on_evaluation"] = bool(
        _metric_value(metrics["precision_at_threshold"], 0.0) >= config.report.threshold_precision_floor
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
    clim_eval = clim_calibrated
    climatology_metrics: dict[str, Any] = dict(_metrics(eval_rows.y, clim_eval))
    climatology_metrics["bss_train"] = _bss_train(climatology_metrics["brier"], eval_rows.y, train_rate)
    climatology_metrics["method"] = calibration_method
    clim_reference = float(np.mean((eval_rows.y - clim_eval) ** 2))
    metrics["bss_climatology"] = 1.0 - _metric_value(metrics["brier"]) / clim_reference if clim_reference > 0 else None

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
            threshold,
            evaluate_test,
        )
    )
    shipped_headroom = [
        calibrator.predict(model.predict(eval_rows, headroom=value)) for value in config.label.headroom_pct
    ]
    metrics["headroom_monotonic"] = bool(
        all(np.all(left >= right) for left, right in itertools.pairwise(shipped_headroom))
    )
    metrics["headroom_monotonic_raw"] = bool(
        all(np.all(left >= right) for left, right in itertools.pairwise(raw_headroom_probabilities))
    )
    diagnostic_stack = np.vstack(headroom_probabilities)
    metrics["headroom_diagnostic_nonmonotone_share"] = float(
        np.mean(np.any(np.diff(diagnostic_stack, axis=0) > 0, axis=0))
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
        logistic_eval = logistic_calibrated
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
    if evaluate_test:
        strata_compare = _strata_comparison(
            strata, cal_data, oof_predictions[calibration_method], train_eval, threshold
        )
    else:
        strata_compare = []
    decision_value = _decision_value_rows(
        eval_rows,
        config.label.headroom_pct,
        headroom_probabilities,
        bands_eval,
        threshold,
        config.report.metric_bootstrap_replicates,
        config.seed + 4,
    )
    decision_value_pooled = _pooled_decision_value_rows(
        eval_rows,
        calibrated_eval,
        bands_eval,
        threshold,
        config.report.metric_bootstrap_replicates,
        config.seed + 5,
    )
    importance = _permutation_importance(model, calibrator, validation_select, spec, seed=config.seed)
    prediction_headroom = np.repeat(np.asarray(config.label.headroom_pct, dtype=np.int16), len(eval_rows))
    evaluation = Evaluation(
        chosen_model=chosen,
        calibration_method=calibration_method,
        calibration_constant=calibration_constant,
        threshold=threshold,
        threshold_precision_floor_met=threshold_met,
        candidates=candidate_metrics,
        candidate_train=candidate_train_metrics,
        candidate_calibration_method=next(iter(config.calibration.methods)),
        metrics=metrics,
        metrics_all=metrics_all,
        evaluation_tier=evaluation_tier,
        evaluation_tier_rows=len(eval_rows),
        calibration_rows=len(cal_data),
        evaluation_split=evaluation_split,
        evaluation_on_test=evaluate_test,
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
        decision_value_pooled=tuple(decision_value_pooled),
        intervals=intervals,
        paired=paired,
        bootstrap_clusters=len(np.unique(groups)),
        prediction_series=np.tile(eval_rows.series, len(config.label.headroom_pct)),
        prediction_chain=np.tile(
            eval_rows.chain if eval_rows.chain is not None else eval_rows.series,
            len(config.label.headroom_pct),
        ),
        prediction_snapshot_at=np.tile(eval_rows.snapshot_at, len(config.label.headroom_pct)),
        prediction_route_day=np.tile(eval_rows.route_day, len(config.label.headroom_pct)),
        prediction_headroom=prediction_headroom,
        prediction_raw=np.concatenate(raw_headroom_probabilities),
        prediction_raw_pooled=np.tile(raw_pooled_eval, len(config.label.headroom_pct)),
        prediction_calibration_fold=np.concatenate(fold_assignments),
        prediction_calibration_mode="full" if evaluate_test else "oof",
        prediction_calibrated=np.concatenate(headroom_probabilities),
        prediction_assigned_headroom=np.tile(eval_rows.headroom, len(config.label.headroom_pct)),
        prediction_calibrated_pooled=np.tile(calibrated_eval, len(config.label.headroom_pct)),
        prediction_departure_date=np.tile(eval_rows.departure_date, len(config.label.headroom_pct)),
        prediction_ttd_band=np.tile(bands_eval, len(config.label.headroom_pct)),
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
        evaluation.prediction_chain,
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
    chains = evaluation.prediction_chain
    snapshots = evaluation.prediction_snapshot_at
    route_days = evaluation.prediction_route_day
    headrooms = evaluation.prediction_headroom
    raw_scores = evaluation.prediction_raw
    raw_pooled = evaluation.prediction_raw_pooled
    calibration_folds = evaluation.prediction_calibration_fold
    calibrated_scores = evaluation.prediction_calibrated
    assigned_headroom = evaluation.prediction_assigned_headroom
    calibrated_pooled = evaluation.prediction_calibrated_pooled
    departure_date = evaluation.prediction_departure_date
    ttd_band = evaluation.prediction_ttd_band
    labels = evaluation.prediction_y
    if (
        series is None
        or chains is None
        or snapshots is None
        or route_days is None
        or headrooms is None
        or raw_scores is None
        or raw_pooled is None
        or calibration_folds is None
        or calibrated_scores is None
        or assigned_headroom is None
        or calibrated_pooled is None
        or departure_date is None
        or ttd_band is None
        or labels is None
    ):
        raise ModelError("evaluation has no prediction arrays to persist")
    predictions_dir = out_dir / "predictions"
    predictions_dir.mkdir(parents=True, exist_ok=True)
    table = pa.table(
        {
            "series_key": series,
            "chain_id": chains,
            "snapshot_at": pa.array(np.asarray(snapshots, dtype="datetime64[us]")),
            "route_day": route_days,
            "headroom_pct": headrooms,
            "raw_score": raw_scores,
            "raw_score_pooled": raw_pooled,
            "calibration_fold": calibration_folds,
            "calibration_mode": [evaluation.prediction_calibration_mode] * len(labels),
            "calibrated_score": calibrated_scores,
            "assigned_headroom": assigned_headroom,
            "calibrated_score_pooled": calibrated_pooled,
            "departure_date": pa.array(np.asarray(departure_date, dtype="datetime64[D]")).cast(pa.date32()),
            "ttd_band": ttd_band,
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
            "calibration_constant": evaluation.calibration_constant,
            "calibration_mode": evaluation.prediction_calibration_mode,
            "threshold": evaluation.threshold,
            "threshold_precision_floor_met": evaluation.threshold_precision_floor_met,
            "dropped_features": list(evaluation.dropped_features),
            "config": {key: value for key, value in config.to_dict().items() if key != "source"},
            "joblib_version": joblib.__version__,
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
