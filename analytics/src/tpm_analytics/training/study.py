"""Reproducible feature-family study on the development folds.

The study is deliberately narrow: one pre-registered definition per family, the frozen PR 6
recipe, and development folds only. A family is kept only if the PR 6 replacement rule accepts it
at full availability and a coverage stress test does not make it significantly worse near
departure. No evaluation or sparse-era fold is read.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import duckdb
import numpy as np

from tpm_analytics.silver._duck import sql_string
from tpm_analytics.training.analog import analog_feature_names, create_analog_features
from tpm_analytics.training.bands import band_labels, ttd_band_case
from tpm_analytics.training.config import TrainingConfig
from tpm_analytics.training.features import (
    CALENDAR_FEATURES,
    CORE_FEATURES,
    FeatureSpec,
    study_feature_spec,
)
from tpm_analytics.training.identity import series_key_sql
from tpm_analytics.training.model import (
    EARLY_STOPPING_DAYS,
    EARLY_STOPPING_PATIENCE,
    EARLY_STOPPING_TOLERANCE,
    Array,
    FittedModel,
    ModelError,
    TabularData,
    _ttd_array,
    concat_tabular,
    fit_calibrator,
    fit_candidate,
)
from tpm_analytics.training.protocol import assert_purged, fold_masks, fold_slices
from tpm_analytics.training.selection import development_folds, paired_bootstrap, replacement_rule

STUDY_VERSION = 1
STRESS_SEED_OFFSET = 17


@dataclass(frozen=True)
class StudyArm:
    """One candidate feature subset and the arm it is compared with."""

    name: str
    features: tuple[str, ...]
    reference: str | None
    kind: str


def _core_names() -> tuple[str, ...]:
    """Return the frozen core feature names."""
    return tuple(feature.name for feature in CORE_FEATURES)


def study_arms(analog_offsets: tuple[int, ...]) -> tuple[StudyArm, ...]:
    """Return the pre-registered arms in the frozen order."""
    base = _core_names()
    analog_d1 = analog_feature_names((1,))
    analog_d7 = analog_feature_names((7,))
    arms = [
        StudyArm("base", base, None, "base"),
        StudyArm("analog_d1", base + analog_d1, "base", "analog"),
        StudyArm("analog_d1_d7", base + analog_d1 + analog_d7, "analog_d1", "analog"),
        StudyArm(
            "calendar_public",
            base + tuple(feature.name for feature in CALENDAR_FEATURES["public"]),
            "base",
            "calendar",
        ),
        StudyArm(
            "calendar_public_school",
            base + tuple(feature.name for feature in CALENDAR_FEATURES["public_school"]),
            "base",
            "calendar",
        ),
        StudyArm(
            "calendar_full",
            base + tuple(feature.name for feature in CALENDAR_FEATURES["full"]),
            "base",
            "calendar",
        ),
    ]
    if analog_offsets != (1, 7):
        # The fixed arm order is part of the plan. A config with other offsets is a different study.
        raise ModelError(f"the feature study is pre-registered for offsets (1, 7), not {analog_offsets}")
    return tuple(arms)


def _arm_spec(panel_spec: FeatureSpec, arm: StudyArm) -> FeatureSpec:
    """Return the feature spec for one arm, preserving the study spec's declaration order."""
    wanted = set(arm.features)
    features = tuple(feature for feature in panel_spec.features if feature.name in wanted)
    missing = wanted - {feature.name for feature in features}
    if missing:
        raise ModelError(f"arm {arm.name} uses columns missing from the study panel: {sorted(missing)}")
    return FeatureSpec("none", features)


def _pooled_scores(
    panel: TabularData,
    config: TrainingConfig,
    panel_spec: FeatureSpec,
    arms: tuple[StudyArm, ...],
) -> tuple[dict[str, list[Array]], dict[str, list[tuple[FittedModel, Any, TabularData, FeatureSpec]]]]:
    """Fit every arm on each development fold and return pooled scores and fitted state."""
    folds = development_folds([fold for fold in config.protocol.cutoffs if fold.role == "development"])
    scores: dict[str, list[Array]] = {arm.name: [] for arm in arms}
    fitted: dict[str, list[tuple[FittedModel, Any, TabularData, FeatureSpec]]] = {arm.name: [] for arm in arms}
    specs = {arm.name: _arm_spec(panel_spec, arm) for arm in arms}
    for fold in folds:
        masks = fold_masks(panel, fold, config.protocol)
        assert_purged(panel, fold, config.protocol, masks)
        train, calibrate, test = fold_slices(panel, masks)
        for arm in arms:
            spec = specs[arm.name]
            train_arm = train.select(spec.names)
            calibrate_arm = calibrate.select(spec.names)
            test_arm = test.select(spec.names)
            model = fit_candidate("hist_gradient_boosting", train_arm, spec, config)
            calibrator = fit_calibrator(
                model.predict(calibrate_arm),
                calibrate.y,
                "temperature",
                min_positives=config.calibration.min_positives,
            )
            scores[arm.name].append(calibrator.predict(model.predict(test_arm)))
            fitted[arm.name].append((model, calibrator, test_arm, spec))
    return scores, fitted


def _pooled_test(panel: TabularData, config: TrainingConfig) -> tuple[Array, Array, Array, TabularData]:
    """Return the pooled development test labels, dates, bands and panel."""
    folds = development_folds([fold for fold in config.protocol.cutoffs if fold.role == "development"])
    labels: list[Array] = []
    clusters: list[Array] = []
    bands: list[Array] = []
    parts: list[TabularData] = []
    for fold in folds:
        masks = fold_masks(panel, fold, config.protocol)
        test = panel.subset(masks.test)
        parts.append(test)
        labels.append(test.y)
        clusters.append(np.asarray(test.departure_date, dtype=str))
        bands.append(_ttd_array(test))
    return np.concatenate(labels), np.concatenate(clusters), np.concatenate(bands), concat_tabular(parts)


def _band_order(band: str) -> int:
    """Return the headline-band order, with unknown bands last."""
    labels = band_labels()
    return labels.index(band) if band in labels else len(labels)


def _interval(
    labels: Array,
    challenger: Array,
    incumbent: Array,
    clusters: Array,
    *,
    replicates: int,
    seed: int,
) -> dict[str, Any] | None:
    """Return a paired cluster-bootstrap interval, or None when there are too few clusters."""
    if len(np.unique(clusters)) < 2:
        return None
    return paired_bootstrap(labels, challenger, incumbent, clusters, replicates=replicates, seed=seed)


def _band_intervals(
    labels: Array,
    challenger: Array,
    incumbent: Array,
    clusters: Array,
    bands: Array,
    *,
    replicates: int,
    seed: int,
) -> list[dict[str, Any]]:
    """Return one paired interval per headline TTD band."""
    rows: list[dict[str, Any]] = []
    for index, band in enumerate(band_labels()):
        mask = bands == band
        if not mask.any():
            continue
        interval = _interval(
            labels[mask],
            challenger[mask],
            incumbent[mask],
            clusters[mask],
            replicates=replicates,
            seed=seed + index,
        )
        rows.append({"band": band, "rows": int(mask.sum()), **(interval or {})})
    return rows


def _finite(values: Array) -> Array:
    """Return a mask of finite numeric values."""
    return np.isfinite(np.asarray(values, dtype=np.float64))


def _is_missing(value: Any) -> bool:
    """Return whether a categorical value is the loader's missing sentinel."""
    if value is None:
        return True
    if isinstance(value, bytes):
        return value in {b"__missing__", b""}
    return value in {"__missing__", ""}


def _present(values: Array) -> Array:
    """Return a mask of non-missing values for numeric, boolean or categorical columns."""
    if values.dtype.kind == "S":
        return np.asarray([bytes(value) not in {b"__missing__", b""} for value in values], dtype=bool)
    if values.dtype.kind in {"U", "O"}:
        return np.asarray([not _is_missing(value) for value in values], dtype=bool)
    return _finite(values)


def _availability_rows(
    data: TabularData,
    arms: tuple[StudyArm, ...],
    panel_spec: FeatureSpec,
    *,
    source: str,
) -> list[dict[str, Any]]:
    """Return family availability by TTD band and observation era."""
    bands = _ttd_array(data)
    eras = np.asarray(data.observation_era, dtype=str)
    rows: list[dict[str, Any]] = []
    specs = {arm.name: _arm_spec(panel_spec, arm) for arm in arms}
    core = set(_core_names())
    for arm in arms:
        spec = specs[arm.name]
        present = np.ones(len(data), dtype=bool)
        price = np.ones(len(data), dtype=bool)
        rise = np.ones(len(data), dtype=bool)
        for feature in spec.features:
            if feature.name in core:
                continue
            present &= _present(data.features[feature.name])
            if feature.name.endswith("_price_ratio"):
                price &= _present(data.features[feature.name])
            if feature.name.endswith("_next_ratio"):
                rise &= _present(data.features[feature.name])
        for band in band_labels():
            band_mask = bands == band
            if not band_mask.any():
                continue
            for era in sorted(set(eras[band_mask].tolist())):
                mask = band_mask & (eras == era)
                rows.append(
                    {
                        "source": source,
                        "arm": arm.name,
                        "band": band,
                        "era": era,
                        "rows": int(mask.sum()),
                        "present": (float(np.mean(present[mask])) if arm.kind == "analog" and mask.any() else None),
                        "price": float(np.mean(price[mask])) if arm.kind == "analog" and mask.any() else None,
                        "rise": float(np.mean(rise[mask])) if arm.kind == "analog" and mask.any() else None,
                    }
                )
    return rows


def mask_family(
    data: TabularData,
    names: tuple[str, ...],
    targets: dict[str, dict[str, float]],
    bands: Array,
    rng: np.random.Generator,
) -> TabularData:
    """Drop a family's columns at random per TTD band to match the target availability.

    ``names`` must be ordered as four columns per offset: price ratio, lead gap, next ratio and
    rise lead gap. The price and rise pairs carry separate targets. The keep count is exact up to
    rounding, so a fixture can assert the masked share within one percentage point.
    """
    if len(names) % 4 != 0:
        raise ModelError("analog masking needs four columns per offset")
    features = dict(data.features)
    for offset_index in range(len(names) // 4):
        price_pair = names[offset_index * 4 : offset_index * 4 + 2]
        rise_pair = names[offset_index * 4 + 2 : offset_index * 4 + 4]
        for band, band_targets in targets.items():
            band_mask = bands == band
            if not band_mask.any():
                continue
            band_rows = int(band_mask.sum())
            present_price = _present(features[price_pair[0]]) & band_mask
            present_rise = _present(features[rise_pair[0]]) & band_mask
            desired_price = min(round(float(band_targets["price"]) * band_rows), int(present_price.sum()))
            keep_price = np.zeros(len(data), dtype=bool)
            if desired_price > 0:
                keep_price[rng.choice(np.flatnonzero(present_price), size=desired_price, replace=False)] = True
            # The rise analog is chosen from the price candidates, so a rise row must also keep
            # its price. Cap the rise target at the price keep set.
            eligible_rise = present_rise & keep_price
            desired_rise = min(round(float(band_targets["rise"]) * band_rows), int(eligible_rise.sum()))
            keep_rise = np.zeros(len(data), dtype=bool)
            if desired_rise > 0:
                keep_rise[rng.choice(np.flatnonzero(eligible_rise), size=desired_rise, replace=False)] = True
            for name in price_pair:
                values = np.array(features[name], copy=True)
                missing = b"__missing__" if values.dtype.kind == "S" else "__missing__"
                values[present_price & ~keep_price] = np.nan if values.dtype.kind == "f" else missing
                features[name] = values
            for name in rise_pair:
                values = np.array(features[name], copy=True)
                missing = b"__missing__" if values.dtype.kind == "S" else "__missing__"
                values[present_rise & ~keep_rise] = np.nan if values.dtype.kind == "f" else missing
                features[name] = values
    return replace(data, features=features)


def _masked_scores(
    fitted: list[tuple[FittedModel, Any, TabularData, FeatureSpec]],
    arm: StudyArm,
    targets: dict[str, dict[str, float]],
    config: TrainingConfig,
) -> Array:
    """Score the already-fitted arm on test blocks masked to the target availability."""
    names = tuple(name for name in arm.features if name.startswith("analog_"))
    scores: list[Array] = []
    for fold_index, (model, calibrator, test, spec) in enumerate(fitted):
        bands = _ttd_array(test)
        rng = np.random.default_rng(config.seed + STRESS_SEED_OFFSET + fold_index)
        masked = mask_family(test, names, targets, bands, rng)
        scores.append(calibrator.predict(model.predict(masked.select(spec.names))))
    return np.concatenate(scores)


def coverage_profile(
    connection: duckdb.DuckDBPyConnection,
    source_sql: str,
    *,
    days: int = 28,
) -> dict[str, Any]:
    """Measure the D-1 scrape coverage over the latest ``days`` of silver.

    Grid-level: the D-1 route-day has some scrape 12-36 h before the snapshot. The specific train
    and fare may still be missing, so this is an upper bound on the analog feature's availability.
    """
    end = connection.execute(f"SELECT max(observed_at) FROM {source_sql}").fetchone()
    if end is None or end[0] is None:
        raise ModelError("the source has no observations")
    end_at = end[0]
    if isinstance(end_at, str):
        end_at = datetime.fromisoformat(end_at)
    start_at = end_at - timedelta(days=days)
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE coverage_src AS
        SELECT
            route_id,
            departure_date,
            observed_at,
            schema_version,
            date_diff('second', observed_at, departure_planned) / 3600.0 AS hours_to_departure
        FROM {source_sql}
        WHERE observed_at BETWEEN TIMESTAMP '{start_at.isoformat(sep=" ")}'
                               AND TIMESTAMP '{end_at.isoformat(sep=" ")}'
          AND observed_at < departure_planned
          AND schema_version IN (1, 2)
          AND fare_lowest_eur IS NOT NULL
          AND date_diff('second', observed_at, departure_planned) BETWEEN 86400 AND 2592000
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE coverage_grid AS
        SELECT DISTINCT route_id, departure_date, observed_at
        FROM {source_sql}
        WHERE observed_at BETWEEN TIMESTAMP '{(start_at - timedelta(hours=36)).isoformat(sep=" ")}'
                               AND TIMESTAMP '{end_at.isoformat(sep=" ")}'
          AND observed_at < departure_planned
          AND schema_version IN (1, 2)
        """
    )
    rows = connection.execute(
        f"""
        WITH hits AS (
            SELECT
                {ttd_band_case("hours_to_departure")} AS band,
                schema_version,
                EXISTS (
                    SELECT 1 FROM coverage_grid g
                    WHERE g.route_id = coverage_src.route_id
                      AND g.departure_date = coverage_src.departure_date - 1
                      AND g.observed_at BETWEEN coverage_src.observed_at - INTERVAL 36 HOUR
                                             AND coverage_src.observed_at - INTERVAL 12 HOUR
                ) AS hit
            FROM coverage_src
        )
        SELECT
            band,
            count(*) AS rows,
            avg(hit::INT) AS share,
            avg(CASE WHEN schema_version = 1 THEN hit::INT END) AS share_v1
        FROM hits
        GROUP BY band
        ORDER BY band
        """
    ).fetchall()
    return {
        "window_start": start_at.isoformat(),
        "window_end": end_at.isoformat(),
        "days": days,
        "rows": sum(int(row[1]) for row in rows),
        "bands": sorted(
            [
                {
                    "band": str(row[0]),
                    "rows": int(row[1]),
                    "share": float(row[2]),
                    "share_v1": None if row[3] is None else float(row[3]),
                }
                for row in rows
            ],
            key=lambda item: _band_order(str(item["band"])),
        ),
        "missing_bands": sorted(set(band_labels()) - {str(row[0]) for row in rows}),
    }


def forward_analog_availability(
    connection: duckdb.DuckDBPyConnection,
    forward_path: Path,
    source_sql: str,
    offsets: tuple[int, ...],
) -> dict[str, Any]:
    """Measure actual analog availability on a forward Parquet, by TTD band."""
    path = sql_string(forward_path.as_posix())
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE study_forward AS
        SELECT
            f.series_key,
            f.snapshot_at,
            f.bin_regime,
            f.bin_index,
            f.route_id,
            f.service_class,
            f.departure_planned,
            f.departure_date,
            f.hours_to_departure,
            f.price_eur,
            f.ttd_band,
            f.observation_era
        FROM read_parquet('{path}') f
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE study_forward_train AS
        SELECT {series_key_sql()} AS series_key, observed_at, min(train_number) AS train_number
        FROM {source_sql}
        WHERE schema_version = 1
          AND (route_id, departure_date) IN (
              SELECT DISTINCT route_id, departure_date FROM study_forward
          )
        GROUP BY 1, 2
        """
    )
    connection.execute(
        """
        CREATE OR REPLACE TEMP TABLE study_forward_full AS
        SELECT f.*, t.train_number
        FROM study_forward f
        LEFT JOIN study_forward_train t
          ON t.series_key = f.series_key AND t.observed_at = f.snapshot_at
        """
    )
    create_analog_features(connection, source_sql, "study_forward_full", offsets)
    price = " AND ".join(f"a.analog_d{offset}_price_ratio IS NOT NULL" for offset in offsets)
    rise = " AND ".join(f"a.analog_d{offset}_next_ratio IS NOT NULL" for offset in offsets)
    extra = ""
    if 1 in offsets and 7 in offsets:
        extra = """,
            avg(CASE WHEN a.analog_d1_price_ratio IS NOT NULL THEN 1.0 ELSE 0.0 END) AS d1_price,
            avg(CASE WHEN a.analog_d1_next_ratio IS NOT NULL THEN 1.0 ELSE 0.0 END) AS d1_rise,
            avg(CASE WHEN a.analog_d1_price_ratio IS NOT NULL
                       AND a.analog_d7_price_ratio IS NOT NULL THEN 1.0 ELSE 0.0 END) AS d1d7_price,
            avg(CASE WHEN a.analog_d1_next_ratio IS NOT NULL
                       AND a.analog_d7_next_ratio IS NOT NULL THEN 1.0 ELSE 0.0 END) AS d1d7_rise"""
    rows = connection.execute(
        f"""
        SELECT
            f.ttd_band AS band,
            count(*) AS rows,
            avg(CASE WHEN {price} THEN 1.0 ELSE 0.0 END) AS price,
            avg(CASE WHEN {rise} THEN 1.0 ELSE 0.0 END) AS rise{extra}
        FROM study_forward_full f
        JOIN analog_features a USING (series_key, snapshot_at, bin_regime, bin_index)
        GROUP BY f.ttd_band
        ORDER BY f.ttd_band
        """
    ).fetchall()
    bands = []
    for row in rows:
        item: dict[str, Any] = {
            "band": str(row[0]),
            "rows": int(row[1]),
            "price": float(row[2]),
            "rise": float(row[3]),
        }
        if len(row) > 4:
            item.update(
                {
                    "d1_price": float(row[4]),
                    "d1_rise": float(row[5]),
                    "d1d7_price": float(row[6]),
                    "d1d7_rise": float(row[7]),
                }
            )
        bands.append(item)
    return {
        "forward_path": str(forward_path),
        "forward_sha256": hashlib.sha256(forward_path.read_bytes()).hexdigest(),
        "rows": sum(int(row[1]) for row in rows),
        "bands": sorted(bands, key=lambda item: _band_order(str(item["band"]))),
    }


def _stress_targets(
    forward: dict[str, Any] | None, coverage: dict[str, Any], arm_name: str = "analog_d1"
) -> tuple[dict[str, dict[str, float]], str, dict[str, str]]:
    """Return the per-band stress target, its overall source and the per-band sources.

    The forward set supplies the 1-7 d actual analog availability; the coverage profile fills the
    7-30 d bands the forward build does not contain. The D-1 arm uses the D-1 availability.
    """
    targets: dict[str, dict[str, float]] = {}
    sources: dict[str, str] = {}
    if forward is not None:
        price_key = "d1d7_price" if arm_name == "analog_d1_d7" else "d1_price"
        rise_key = "d1d7_rise" if arm_name == "analog_d1_d7" else "d1_rise"
        for row in forward.get("bands", []):
            price = row.get(price_key, row.get("price"))
            rise = row.get(rise_key, row.get("rise"))
            if price is not None and rise is not None:
                band = str(row["band"])
                targets[band] = {"price": float(price), "rise": float(rise)}
                sources[band] = "forward_set"
    for row in coverage.get("bands", []):
        band = str(row["band"])
        if band in targets or band == "unknown":
            continue
        share_v1 = row.get("share_v1")
        share = float(share_v1 if share_v1 is not None else row["share"])
        targets[band] = {"price": share, "rise": share}
        sources[band] = "coverage_profile_v1" if share_v1 is not None else "coverage_profile"
    if not sources:
        return {}, "none", {}
    if all(source == "forward_set" for source in sources.values()):
        return targets, "forward_set", sources
    if any(source == "forward_set" for source in sources.values()):
        return targets, "forward_set+coverage_profile", sources
    return targets, "coverage_profile", sources


def _study_report(result: dict[str, Any]) -> str:
    """Render the feature study as Markdown."""
    lines = [
        "# Feature study (PR 6b)",
        "",
        "Development folds only. Every arm refits the frozen PR 6 recipe (histogram gradient",
        "boosting plus temperature calibration); the calibrator is not re-selected per arm.",
        "",
        "## Method",
        "",
        f"- Run: {result.get('run_id') or '—'}",
        f"- Development folds: {', '.join(result['folds'])}",
        f"- Paired cluster bootstrap: {result['settings']['replicates']} replicates, "
        f"seed {result['settings']['seed']}, cluster {result['settings']['cluster']}",
        f"- Coverage window: {result['coverage']['window_start']} to {result['coverage']['window_end']} "
        f"({result['coverage']['days']} days, {result['coverage']['rows']} rows)",
        f"- Stress target: {result['stress']['target_source']} (seed offset {STRESS_SEED_OFFSET})",
        "- The coverage profile is a grid-level, observation-weighted upper bound over v1+v2; the",
        "  stress target prefers the actual forward-set analog availability and fills the missing",
        "  7-30 d bands from the coverage profile.",
        "- The stress scores the dense-era-trained model without retraining; masking is random within",
        "  a band, while real missingness clusters by route and time. The PR 7 sparse-era folds are",
        "  the real check.",
        "",
        "## Families",
        "",
        "| Family | Compared with | Δ log loss [95 % CI] | Δ Brier [95 % CI] | PR 6 rule | Stress | Decision |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for item in result["families"]:
        interval = item.get("comparison") or {}
        lines.append(
            "| {name} | {reference} | {ll} | {brier} | {rule} | {stress} | {decision} |".format(
                name=item["name"],
                reference=item.get("reference") or "—",
                ll=_delta_text(interval, "log_loss"),
                brier=_delta_text(interval, "brier"),
                rule="pass" if item.get("rule_passed") else "fail",
                stress=item.get("stress_status") or "—",
                decision=item["decision"],
            )
        )
    lines.extend(["", "### Per-band comparisons", ""])
    lines.extend(
        [
            "| Family | Band | Rows | Δ log loss [95 % CI] | Δ Brier [95 % CI] |",
            "| --- | --- | --- | --- | --- |",
        ]
    )
    for item in result["families"]:
        for row in item.get("bands", []):
            lines.append(
                f"| {item['name']} | {row['band']} | {row['rows']} | "
                f"{_delta_text(row, 'log_loss')} | {_delta_text(row, 'brier')} |"
            )
    lines.extend(
        [
            "",
            "## Availability",
            "",
            "| Source | Family | TTD band | Era | Rows | Present | Price analog | Rise analog |",
            "| --- | --- | --- | --- | --- | --- | --- | --- |",
        ]
    )
    for row in result["availability"]["panel"]:
        lines.append(
            f"| panel | {row['arm']} | {row['band']} | {row['era']} | {row['rows']} | "
            f"{_pct(row.get('present'))} | {_pct(row.get('price'))} | {_pct(row.get('rise'))} |"
        )
    for row in result["availability"]["coverage"]:
        lines.append(f"| coverage | — | {row['band']} | — | {row['rows']} | {_pct(row['share'])} | — | — |")
    forward = result["availability"].get("forward")
    if forward:
        lines.extend(
            [
                "",
                "Forward-set analog availability. The first two columns are the D-1 feature; the",
                "joint columns require both D-1 and D-7.",
                "",
                "| TTD band | Rows | D-1 price | D-1 rise | Joint price | Joint rise |",
                "| --- | --- | --- | --- | --- | --- |",
            ]
        )
        for row in forward["bands"]:
            lines.append(
                f"| {row['band']} | {row['rows']} | {_pct(row.get('d1_price'))} | "
                f"{_pct(row.get('d1_rise'))} | {_pct(row.get('price'))} | {_pct(row.get('rise'))} |"
            )
    lines.extend(["", "## Decisions", ""])
    for item in result["families"]:
        lines.append(f"- **{item['name']}:** {item['reason']}")
    lines.extend(["", "## Verdict", ""])
    analog = next((item for item in result["families"] if item["name"] == "analog_d1"), None)
    near_failed = bool(
        analog
        and analog.get("stress")
        and analog["stress"].get("near_1_7d")
        and analog["stress"]["near_1_7d"]["log_loss"][0] > 0.0
    )
    target = result["stress"]["target_source"]
    if analog is not None and analog["rule_passed"] and analog["stress_status"] == "fail" and near_failed:
        lines.append(
            "I1 helps at full availability but makes near-departure predictions worse at the measured "
            f"stress availability ({target}); it stays off."
        )
    elif analog is not None and analog["decision"] == "keep":
        lines.append("I1 passes both checks; add it to the recipe and run one evaluation scoring run.")
    kept = [item["name"] for item in result["families"] if item["decision"] == "keep"]
    if kept:
        lines.append("")
        lines.append(f"Families to add: {', '.join(kept)}; run one evaluation scoring run.")
    else:
        lines.append("")
        lines.append("No family was added; the PR 6 recipe is unchanged by this study.")
    calendar = result.get("calendar_coverage") or {}
    if calendar.get("public_holiday_rows") == 0:
        lines.append("")
        lines.append(
            "The public-calendar arm is a null test: the development test window has no public "
            "holiday. The school-calendar result is summer-only."
        )
    provenance = result.get("provenance") or {}
    if provenance:
        lines.extend(
            [
                "",
                "## Provenance",
                "",
                f"- Git: {provenance.get('git_sha') or '—'} (dirty: {provenance.get('git_dirty')})",
                f"- Silver: {provenance.get('silver_build_id') or '—'} "
                f"(manifest {str(provenance.get('silver_manifest_sha256') or '—')[:12]})",
                f"- Config: {str(provenance.get('config_sha256') or '—')[:12]}",
                f"- Dataset: {str(provenance.get('dataset_manifest_sha256') or '—')[:12]} "
                f"(reused: {provenance.get('dataset_reused')})",
                f"- Sample rate: {provenance.get('sample_rate')}; strict chains: {provenance.get('strict_chains')}",
                f"- Forward input: {provenance.get('forward_path') or '—'} "
                f"(sha256 {str(provenance.get('forward_sha256') or '—')[:12]})",
            ]
        )
    return "\n".join(lines) + "\n"


def _interval_text(interval: Any) -> str:
    """Format a paired delta interval."""
    if not interval:
        return "—"
    return f"[{float(interval[0]):+.5f}, {float(interval[1]):+.5f}]"


def _delta_text(comparison: dict[str, Any], metric: str) -> str:
    """Format a mean delta next to its interval."""
    interval = comparison.get(metric)
    if not interval:
        return "—"
    mean = comparison.get(f"mean_{metric}")
    prefix = f"{float(mean):+.5f} " if mean is not None else ""
    return prefix + _interval_text(interval)


def _pct(value: Any) -> str:
    """Format a share as a percentage."""
    return "—" if value is None else f"{float(value):.1%}"


def run_feature_study(
    panel: TabularData,
    config: TrainingConfig,
    *,
    coverage: dict[str, Any],
    forward: dict[str, Any] | None = None,
    run_id: str | None = None,
    provenance: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Run the pre-registered feature study and return its JSON-serialisable result."""
    panel_spec = study_feature_spec(config.features.analog_departure_offsets_days)
    arms = study_arms(tuple(config.features.analog_departure_offsets_days))
    labels, clusters, bands, test_panel = _pooled_test(panel, config)
    public_holiday = np.asarray(test_panel.features["origin_public_holiday"], dtype=bool) | np.asarray(
        test_panel.features["dest_public_holiday"], dtype=bool
    )
    calendar_coverage = {
        "development_test_rows": len(test_panel),
        "public_holiday_rows": int(public_holiday.sum()),
        "public_holiday_share": float(np.mean(public_holiday)),
    }
    raw_scores, fitted = _pooled_scores(panel, config, panel_spec, arms)
    scores = {name: np.concatenate(parts) for name, parts in raw_scores.items()}
    replicates = config.report.bootstrap_replicates
    seed = config.seed + 201
    families: list[dict[str, Any]] = []
    decisions: dict[str, str] = {}
    for index, arm in enumerate(arms):
        if arm.reference is None:
            continue
        interval = _interval(
            labels,
            scores[arm.name],
            scores[arm.reference],
            clusters,
            replicates=replicates,
            seed=seed + index,
        )
        rule_passed, rule_reason = replacement_rule(interval or {})
        band_intervals = _band_intervals(
            labels,
            scores[arm.name],
            scores[arm.reference],
            clusters,
            bands,
            replicates=replicates,
            seed=seed + 100 + index,
        )
        item: dict[str, Any] = {
            "name": arm.name,
            "kind": arm.kind,
            "reference": arm.reference,
            "features": list(arm.features),
            "comparison": interval,
            "bands": band_intervals,
            "rule_passed": bool(rule_passed),
            "rule_reason": rule_reason,
            "stress": None,
            "stress_status": "not_applicable" if arm.kind == "calendar" else "not_run",
            "informative": True,
        }
        if arm.kind == "calendar":
            item["informative"] = arm.name != "calendar_public" or calendar_coverage["public_holiday_rows"] > 0
        if arm.kind == "analog" and arm.name == "analog_d1":
            targets, target_source, target_sources = _stress_targets(forward, coverage, arm.name)
            forward_near = any(target_sources.get(band) == "forward_set" for band in ("1-3d", "3-5d", "5-7d"))
            stressed = _masked_scores(fitted[arm.name], arm, targets, config)
            overall = _interval(
                labels,
                stressed,
                scores[arm.reference],
                clusters,
                replicates=replicates,
                seed=seed + 300 + index,
            )
            near = np.isin(bands, ["1-3d", "3-5d", "5-7d"])
            near_interval = _interval(
                labels[near],
                stressed[near],
                scores[arm.reference][near],
                clusters[near],
                replicates=replicates,
                seed=seed + 400 + index,
            )
            ok = bool(
                forward_near
                and overall
                and overall["log_loss"][0] <= 0.0
                and overall["mean_log_loss"] <= 0.0
                and near_interval
                and near_interval["log_loss"][0] <= 0.0
                and near_interval["mean_log_loss"] <= 0.0
            )
            item["stress"] = {
                "target_source": target_source,
                "target_sources": target_sources,
                "targets": targets,
                "forward_near": forward_near,
                "overall": overall,
                "near_1_7d": near_interval,
                "passed": ok,
            }
            item["stress_status"] = "pass" if ok else "fail"
        stress_ok = item["stress_status"] in {"pass", "not_applicable", "not_run"}
        keep = bool(item["rule_passed"] and stress_ok and item["stress_status"] != "not_run")
        item["decision"] = "keep" if keep else "drop"
        if keep and arm.kind == "calendar":
            item["reason"] = "passes the PR 6 replacement rule; calendar features have no coverage skew"
        elif keep:
            item["reason"] = "passes the PR 6 replacement rule and the coverage stress test"
        elif not item["informative"]:
            item["reason"] = "no public holiday in the development test window; this is a null test"
        elif not item["rule_passed"]:
            item["reason"] = f"PR 6 rule failed: {rule_reason}"
        elif item["stress_status"] == "fail":
            item["reason"] = "the coverage stress test is significantly worse at 1-7 d or overall"
        elif arm.name == "analog_d1_d7":
            item["reason"] = (
                "combined D-1 + D-7 stress is not run; the nested arm fails the full-availability rule "
                "or needs a D-7 fallback test in PR 7"
            )
        else:
            item["reason"] = "no stress result"
        families.append(item)
        decisions[arm.name] = item["decision"]
    availability = {
        "panel": _availability_rows(test_panel, arms, panel_spec, source="development_test"),
        "coverage": coverage.get("bands", []),
        "forward": forward,
        "coverage_window": {
            "start": coverage.get("window_start"),
            "end": coverage.get("window_end"),
            "days": coverage.get("days"),
        },
    }
    targets, target_source, target_sources = _stress_targets(forward, coverage, "analog_d1")
    return {
        "version": STUDY_VERSION,
        "run_id": run_id,
        "folds": [fold.name for fold in config.protocol.cutoffs if fold.role == "development"],
        "settings": {
            "replicates": replicates,
            "seed": seed,
            "cluster": "departure_date",
            "recipe": {
                "model": "hist_gradient_boosting",
                "calibration": "temperature",
                "model_settings": {
                    "max_iter": config.model.max_iter,
                    "learning_rate": config.model.learning_rate,
                    "max_leaf_nodes": config.model.max_leaf_nodes,
                    "random_state": config.model.random_state,
                },
                "calibration_folds": config.calibration.folds,
                "calibration_min_positives": config.calibration.min_positives,
                "early_stopping": {
                    "days": EARLY_STOPPING_DAYS,
                    "patience": EARLY_STOPPING_PATIENCE,
                    "tolerance": EARLY_STOPPING_TOLERANCE,
                },
            },
            "stress_target_source": target_source,
        },
        "coverage": coverage,
        "stress": {
            "target_source": target_source,
            "target_sources": target_sources,
            "targets": targets,
            "seed": config.seed,
            "seed_offset": STRESS_SEED_OFFSET,
        },
        "families": families,
        "decisions": decisions,
        "availability": availability,
        "calendar_coverage": calendar_coverage,
        "provenance": provenance or {},
        "no_family_added": not any(item["decision"] == "keep" for item in families),
    }


def write_feature_study(out_dir: Path, result: dict[str, Any]) -> dict[str, Any]:
    """Write ``feature_study.json`` and ``feature_study.md`` and return their paths and hashes."""
    payload = (json.dumps(result, indent=2, sort_keys=True, default=str) + "\n").encode("utf-8")
    json_path = out_dir / "feature_study.json"
    json_path.write_bytes(payload)
    report = _study_report(result)
    report_path = out_dir / "feature_study.md"
    report_path.write_text(report, encoding="utf-8")
    return {
        "feature_study": json_path.name,
        "feature_study_sha256": hashlib.sha256(payload).hexdigest(),
        "feature_study_report": report_path.name,
        "decisions": result["decisions"],
    }
