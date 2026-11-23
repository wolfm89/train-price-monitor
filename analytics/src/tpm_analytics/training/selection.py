"""Development-fold selection of the model family and the calibration method.

The selection is a paired cluster bootstrap over the development folds only. A more complex
choice replaces a simpler one only when the 95 % interval of the delta log loss is entirely below
zero and the delta Brier interval is not entirely above zero. The rule, not the fitted values, is
part of the recipe hash.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

import numpy as np

from tpm_analytics.training.config import FoldConfig, TrainingConfig
from tpm_analytics.training.features import FeatureSpec
from tpm_analytics.training.model import (
    Array,
    FittedModel,
    ModelError,
    TabularData,
    _cross_fitted,
    _matrix,
    _metrics,
    fit_candidate,
    fit_climatology,
    fit_encoder,
)
from tpm_analytics.training.protocol import assert_purged, fold_masks

MODEL_ORDER: tuple[str, ...] = ("base_rate", "logistic", "hist_gradient_boosting")
# Sigmoid and temperature share a complexity rank; pooled log loss breaks the tie.
CALIBRATION_RANK: dict[str, int] = {"sigmoid": 0, "temperature": 0, "isotonic": 1, "covariate": 2}
SELECTION_REPLICATES = 2000
SELECTION_ALPHA = 0.05
SELECTION_CLUSTER = "departure_date"


@dataclass(frozen=True)
class SelectionOutcome:
    """The selected recipe ingredients, models and the full selection table."""

    model: str
    calibration: str
    models: dict[str, FittedModel]
    table: dict[str, Any]


def development_folds(folds: Iterable[FoldConfig]) -> tuple[FoldConfig, ...]:
    """Return the development folds, refusing any other role."""
    checked = tuple(folds)
    if not checked:
        raise ModelError("recipe selection needs at least one development fold")
    for fold in checked:
        if fold.role != "development":
            raise ModelError(f"recipe selection may only use development folds, not {fold.name} ({fold.role})")
    return checked


def _clip(values: Array) -> Array:
    """Clip probabilities away from exactly zero and one."""
    return np.clip(np.asarray(values, dtype=np.float64), 1e-6, 1.0 - 1e-6)


def _per_row_log_loss(y: Array, probabilities: Array) -> Array:
    """Return the log loss contribution of every row."""
    clipped = _clip(probabilities)
    return -(y * np.log(clipped) + (1.0 - y) * np.log(1.0 - clipped))


def _per_row_brier(y: Array, probabilities: Array) -> Array:
    """Return the Brier contribution of every row."""
    return (_clip(probabilities) - y) ** 2


def paired_bootstrap(
    labels: Array,
    challenger: Array,
    incumbent: Array,
    clusters: Array,
    *,
    replicates: int = SELECTION_REPLICATES,
    seed: int = 42,
    alpha: float = SELECTION_ALPHA,
) -> dict[str, Any]:
    """Cluster-bootstrap the paired delta log loss and delta Brier (challenger - incumbent)."""
    unique, inverse = np.unique(clusters, return_inverse=True)
    if len(unique) < 2:
        raise ModelError("paired bootstrap needs at least two departure-date clusters")
    log_loss = np.bincount(
        inverse,
        weights=_per_row_log_loss(labels, challenger) - _per_row_log_loss(labels, incumbent),
        minlength=len(unique),
    )
    brier = np.bincount(
        inverse,
        weights=_per_row_brier(labels, challenger) - _per_row_brier(labels, incumbent),
        minlength=len(unique),
    )
    counts = np.bincount(inverse, minlength=len(unique))
    rng = np.random.default_rng(seed)
    sampled = rng.integers(0, len(unique), size=(replicates, len(unique)))
    totals = counts[sampled].sum(axis=1)
    log_loss_values = log_loss[sampled].sum(axis=1) / totals
    brier_values = brier[sampled].sum(axis=1) / totals
    return {
        "log_loss": [
            float(np.percentile(log_loss_values, 100.0 * alpha / 2.0)),
            float(np.percentile(log_loss_values, 100.0 * (1.0 - alpha / 2.0))),
        ],
        "brier": [
            float(np.percentile(brier_values, 100.0 * alpha / 2.0)),
            float(np.percentile(brier_values, 100.0 * (1.0 - alpha / 2.0))),
        ],
        "mean_log_loss": float(log_loss.sum() / counts.sum()),
        "mean_brier": float(brier.sum() / counts.sum()),
        "clusters": len(unique),
        "replicates": int(replicates),
    }


def replacement_rule(interval: dict[str, Any]) -> tuple[bool, str]:
    """Apply the frozen replacement rule to a paired interval."""
    log_loss = interval.get("log_loss") or [0.0, 0.0]
    brier = interval.get("brier") or [0.0, 0.0]
    if float(log_loss[1]) >= 0.0:
        return False, "log-loss interval is not entirely below zero"
    if float(brier[0]) > 0.0:
        return False, "Brier interval lies entirely above zero"
    return True, "log loss improves and Brier does not worsen"


def _ranked(models: tuple[str, ...]) -> tuple[str, ...]:
    """Return the configured models in the frozen complexity order."""
    return tuple(sorted(models, key=lambda name: (MODEL_ORDER.index(name) if name in MODEL_ORDER else 99, name)))


def _calibration_selection(
    methods: tuple[str, ...],
    labels: Array,
    scores: dict[str, Array],
    clusters: Array,
    *,
    replicates: int,
    seed: int,
    alpha: float,
) -> tuple[str, list[dict[str, Any]]]:
    """Choose the calibration method for one model by the frozen rule."""
    available = [method for method in methods if method in scores]
    if not available:
        raise ModelError("no configured calibration method has scores")
    simplest = min(available, key=lambda method: (CALIBRATION_RANK.get(method, 99), method))
    # Among equally simple methods (sigmoid and temperature) the lower pooled log loss wins.
    base_rank = CALIBRATION_RANK.get(simplest, 99)
    same_rank = [method for method in available if CALIBRATION_RANK.get(method, 99) == base_rank]
    incumbent = min(same_rank, key=lambda method: (_metrics(labels, scores[method])["log_loss"] or 0.0, method))
    chosen = incumbent
    compare: list[dict[str, Any]] = []
    for challenger in sorted(available, key=lambda method: (CALIBRATION_RANK.get(method, 99), method)):
        if CALIBRATION_RANK.get(challenger, 99) <= CALIBRATION_RANK.get(incumbent, 99):
            continue
        interval = paired_bootstrap(
            labels,
            scores[challenger],
            scores[incumbent],
            clusters,
            replicates=replicates,
            seed=seed,
            alpha=alpha,
        )
        accepted, reason = replacement_rule(interval)
        compare.append(
            {
                "incumbent": incumbent,
                "challenger": challenger,
                "accepted": bool(accepted),
                "reason": reason,
                **interval,
            }
        )
        if accepted:
            incumbent = challenger
            chosen = challenger
    return chosen, compare


def _model_selection(
    models: tuple[str, ...],
    labels: Array,
    scores: dict[tuple[str, str], Array],
    calibration: dict[str, str],
    clusters: Array,
    *,
    replicates: int,
    seed: int,
    alpha: float,
) -> tuple[str, list[dict[str, Any]]]:
    """Choose the model family by walking the complexity order."""
    ranked = _ranked(models)
    compare: list[dict[str, Any]] = []
    incumbent = ranked[0]
    chosen = incumbent
    for challenger in ranked[1:]:
        interval = paired_bootstrap(
            labels,
            scores[(challenger, calibration[challenger])],
            scores[(incumbent, calibration[incumbent])],
            clusters,
            replicates=replicates,
            seed=seed,
            alpha=alpha,
        )
        accepted, reason = replacement_rule(interval)
        compare.append(
            {
                "incumbent": incumbent,
                "challenger": challenger,
                "accepted": bool(accepted),
                "reason": reason,
                **interval,
            }
        )
        if accepted:
            incumbent = challenger
            chosen = challenger
    return chosen, compare


def select_outcome(
    panel: TabularData,
    config: TrainingConfig,
    spec: FeatureSpec,
    *,
    replicates: int = SELECTION_REPLICATES,
    alpha: float = SELECTION_ALPHA,
) -> SelectionOutcome:
    """Fit every candidate on the development folds and select model and calibration."""
    folds = development_folds([fold for fold in config.protocol.cutoffs if fold.role == "development"])
    methods = tuple(config.calibration.methods)
    models = tuple(config.model.candidates)
    grouped_scores: dict[tuple[str, str], list[Array]] = {(name, method): [] for name in models for method in methods}
    labels: list[Array] = []
    clusters: list[Array] = []
    climatology_scores: list[Array] = []
    fitted: dict[tuple[str, str], FittedModel] = {}
    for fold in folds:
        masks = fold_masks(panel, fold, config.protocol)
        assert_purged(panel, fold, config.protocol, masks)
        train = panel.subset(masks.train)
        calibrate = panel.subset(masks.calibrate)
        encoder = fit_encoder(train, spec)
        matrix = _matrix(train, spec, encoder)
        labels.append(calibrate.y)
        clusters.append(calibrate.departure_date)
        climatology_scores.append(fit_climatology(train).predict(calibrate))
        for name in models:
            model = fit_candidate(name, train, spec, config, encoder=encoder, matrix=matrix)
            fitted[(fold.name, name)] = model
            raw = model.predict(calibrate)
            for method in methods:
                if name == "base_rate" and method != "sigmoid":
                    # Calibrating a constant score is a no-op; keep one row per model.
                    continue
                grouped_scores[(name, method)].append(
                    _cross_fitted(raw, calibrate.y, calibrate.departure_date, method, config)
                )
    pooled_labels = np.concatenate(labels)
    pooled_clusters = np.concatenate(clusters)
    rows: list[dict[str, Any]] = []
    pooled_scores: dict[tuple[str, str], Array] = {}
    for (name, method), parts in grouped_scores.items():
        if not parts:
            continue
        pooled = np.concatenate(parts)
        pooled_scores[(name, method)] = pooled
        metrics = _metrics(pooled_labels, pooled)
        rows.append({"model": name, "calibration": method, "rows": len(pooled_labels), **metrics})
    climate_metrics = _metrics(pooled_labels, np.concatenate(climatology_scores))
    rows.append(
        {
            "model": "climatology",
            "calibration": "none",
            "rows": len(pooled_labels),
            "selectable": False,
            **climate_metrics,
        }
    )
    climate_log_loss = climate_metrics["log_loss"] or 0.0
    for row in rows:
        if row.get("selectable", True):
            row["beats_climatology"] = bool((row["log_loss"] or 0.0) < climate_log_loss)
    calibration_choice: dict[str, str] = {}
    calibration_compare: dict[str, list[dict[str, Any]]] = {}
    for index, name in enumerate(models):
        scores = {method: pooled for (candidate, method), pooled in pooled_scores.items() if candidate == name}
        chosen, compare = _calibration_selection(
            methods,
            pooled_labels,
            scores,
            pooled_clusters,
            replicates=replicates,
            seed=config.seed + 1 + index,
            alpha=alpha,
        )
        calibration_choice[name] = chosen
        calibration_compare[name] = compare
    chosen_model, model_compare = _model_selection(
        models,
        pooled_labels,
        pooled_scores,
        calibration_choice,
        pooled_clusters,
        replicates=replicates,
        seed=config.seed + 101,
        alpha=alpha,
    )
    table = {
        "rule": {
            "replicates": int(replicates),
            "alpha": float(alpha),
            "cluster": SELECTION_CLUSTER,
            "model_order": list(models),
            "calibration_order": list(methods),
            "calibration_rank": {method: CALIBRATION_RANK.get(method, 99) for method in methods},
        },
        "folds": [fold.name for fold in folds],
        "rows": sorted(rows, key=lambda row: (str(row["model"]), str(row["calibration"]))),
        "calibration_choice": calibration_choice,
        "calibration_comparisons": calibration_compare,
        "model_choice": chosen_model,
        "model_comparisons": model_compare,
        "chosen": {"model": chosen_model, "calibration": calibration_choice[chosen_model]},
    }
    return SelectionOutcome(
        model=chosen_model,
        calibration=calibration_choice[chosen_model],
        models={fold.name: fitted[(fold.name, chosen_model)] for fold in folds},
        table=table,
    )


def selection_settings(table: dict[str, Any]) -> dict[str, Any]:
    """Return the hashed rule settings (never the fitted selection table)."""
    rule = table.get("rule", {})
    return {
        "replicates": rule.get("replicates"),
        "alpha": rule.get("alpha"),
        "cluster": rule.get("cluster"),
        "model_order": rule.get("model_order"),
        "calibration_order": rule.get("calibration_order"),
        "calibration_rank": rule.get("calibration_rank"),
    }


def table_sha256(table: dict[str, Any]) -> str:
    """Return a deterministic hash of a selection table for reproducibility checks."""
    return hashlib.sha256(json.dumps(table, sort_keys=True, default=str).encode("utf-8")).hexdigest()
