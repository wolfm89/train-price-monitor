"""Fold masks and the gate for the additive backtest protocol.

The panel is built once; a fold selects rows by ``snapshot_at`` and ``label_window_end``. Purging
on the label end (the check time), never on the snapshot, is the point of the protocol.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time

import numpy as np

from tpm_analytics.training.config import FoldConfig, ProtocolConfig
from tpm_analytics.training.model import Array, ModelError, TabularData

DATETIME = "datetime64[ms]"


@dataclass(frozen=True)
class FoldMasks:
    train: Array
    calibrate: Array
    test: Array

    def count(self) -> tuple[int, int, int]:
        return int(self.train.sum()), int(self.calibrate.sum()), int(self.test.sum())


def _datetime(values: Array) -> Array:
    return np.asarray(values, dtype=DATETIME)


def _at(value: datetime) -> np.datetime64:
    return np.datetime64(value, "ms")


def fold_masks(panel: TabularData, fold: FoldConfig, protocol: ProtocolConfig) -> FoldMasks:
    """Return the purged train, calibration and test masks for one fold."""
    if panel.label_window_end is None:
        raise ModelError("the panel has no label_window_end; rebuild it with the next-day label")
    label_end = _datetime(panel.label_window_end)
    snapshot = _datetime(panel.snapshot_at)
    cutoff = _at(datetime.combine(fold.cutoff, time.min))
    embargo = np.timedelta64(protocol.embargo_hours, "h")
    block = np.timedelta64(protocol.block_days, "D")
    train = label_end <= cutoff - embargo
    calibrate = (snapshot >= cutoff) & (label_end <= cutoff + block)
    test = (snapshot >= cutoff + block + embargo) & (label_end <= cutoff + 2 * block + embargo)
    if fold.role in {"sparse_era", "forward"}:
        # Train on the dense era at every lead time; calibrate and score only the short-lead domain.
        hours = np.asarray(panel.features["hours_to_departure"], dtype=np.float64)
        if fold.role == "forward":
            lower = float(protocol.forward_min_hours_to_departure)
            upper = float(protocol.forward_max_hours_to_departure)
            domain = (hours >= lower) & (hours <= upper)
        else:
            domain = (hours >= 24.0) & (hours < float(protocol.sparse_era_max_hours_to_departure))
        calibrate &= domain
        test &= domain
    return FoldMasks(train=train, calibrate=calibrate, test=test)


def scored_folds(protocol: ProtocolConfig, *, evaluate_test: bool) -> tuple[FoldConfig, ...]:
    """Development folds always; evaluation/sparse-era folds only with the explicit test flag."""
    folds: list[FoldConfig] = []
    for fold in protocol.cutoffs:
        if fold.role == "development" or (fold.role in {"evaluation", "sparse_era"} and evaluate_test):
            folds.append(fold)
    return tuple(folds)


def fold_slices(panel: TabularData, masks: FoldMasks) -> tuple[TabularData, TabularData, TabularData]:
    train = panel.subset(masks.train)
    calibrate = panel.subset(masks.calibrate)
    test = panel.subset(masks.test)
    if len(train) == 0 or len(calibrate) == 0 or len(test) == 0:
        raise ModelError(f"empty fold block: train={len(train)}, calibrate={len(calibrate)}, test={len(test)}")
    return train, calibrate, test


def assert_purged(panel: TabularData, fold: FoldConfig, protocol: ProtocolConfig, masks: FoldMasks) -> None:
    """Fail loudly if a mask lets a label or a test snapshot cross the purge boundary."""
    label_end = _datetime(panel.label_window_end) if panel.label_window_end is not None else None
    snapshot = _datetime(panel.snapshot_at)
    if label_end is None:
        raise ModelError("the panel has no label_window_end")
    cutoff = _at(datetime.combine(fold.cutoff, time.min))
    embargo = np.timedelta64(protocol.embargo_hours, "h")
    block = np.timedelta64(protocol.block_days, "D")
    if masks.train.any() and label_end[masks.train].max() > cutoff - embargo:
        raise ModelError(f"{fold.name}: a training label matures after the purge line")
    if masks.calibrate.any() and label_end[masks.calibrate].max() > cutoff + block:
        raise ModelError(f"{fold.name}: a calibration label matures after its block")
    if masks.test.any() and snapshot[masks.test].min() < cutoff + block + embargo:
        raise ModelError(f"{fold.name}: a test snapshot starts before the purge line")
    if masks.test.any() and label_end[masks.test].max() > cutoff + 2 * block + embargo:
        raise ModelError(f"{fold.name}: a test label matures after its block")
    if (
        (masks.train & masks.calibrate).any()
        or (masks.train & masks.test).any()
        or (masks.calibrate & masks.test).any()
    ):
        raise ModelError(f"{fold.name}: fold blocks overlap")
