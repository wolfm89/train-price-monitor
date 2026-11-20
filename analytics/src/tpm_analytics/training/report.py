"""Human- and machine-readable evaluation artefacts."""

from __future__ import annotations

import csv
import hashlib
import json
import platform
from pathlib import Path
from typing import Any

import numpy
import sklearn

from tpm_analytics.training.dataset import DatasetStats
from tpm_analytics.training.features import FeatureSpec
from tpm_analytics.training.model import Evaluation


def _fmt(value: Any, digits: int = 4) -> str:
    if value is None:
        return "—"
    if isinstance(value, float):
        return f"{value:.{digits}f}"
    return str(value)


def _table(headers: list[str], rows: list[list[Any]]) -> str:
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    lines.extend("| " + " | ".join(_fmt(cell) for cell in row) + " |" for row in rows)
    return "\n".join(lines)


def _warnings(stats: DatasetStats, evaluation: Evaluation) -> list[str]:
    warning_items = list(stats.warnings)
    positives = float(evaluation.test.get("positive_rate") or 0.0)
    if not evaluation.test.get("precision_floor_met_on_evaluation"):
        warning_items.append("precision floor missed on the evaluated split")
    if evaluation.test_evaluated and abs(positives - evaluation.calibration_prevalence) > 0.02:
        warning_items.append(
            "prevalence shift between calibration and evaluation: "
            f"{evaluation.calibration_prevalence:.3f} vs {positives:.3f}"
        )
    if not numpy.isfinite(evaluation.train_prevalence):
        warning_items.append("no training rows match the evaluated tier; BSS vs train is unavailable")
    elif abs(positives - evaluation.train_prevalence) > 0.02:
        warning_items.append(
            f"prevalence shift between train and evaluation: {evaluation.train_prevalence:.3f} vs {positives:.3f}"
        )
    if not evaluation.test.get("headroom_monotonic"):
        warning_items.append("calibrated breach probability is not monotone across headroom")
    for split in stats.splits:
        share = split.labelled / split.rows if split.rows else 0.0
        if share < 0.9:
            warning_items.append(f"{split.split} has only {share:.1%} labelled rows")
    if evaluation.dropped_features:
        warning_items.append(f"constant/all-null features dropped: {', '.join(evaluation.dropped_features)}")
    return warning_items


def _report(
    stats: DatasetStats,
    evaluation: Evaluation,
    spec: FeatureSpec,
    config: dict[str, Any],
    runner: str,
    ablation: dict[str, Any] | None = None,
    provenance_lines: str = "",
) -> str:
    split_rows = [
        [item.split, item.rows, item.series, item.route_days, item.labelled, item.positives, item.positive_rate]
        for item in stats.splits
    ]
    candidate_rows = [
        [name, *[metrics.get(key) for key in ("brier", "log_loss", "roc_auc", "average_precision", "positive_rate")]]
        for name, metrics in evaluation.candidates.items()
    ]
    candidate_train_rows = [
        [name, *[metrics.get(key) for key in ("brier", "log_loss", "roc_auc", "average_precision", "positive_rate")]]
        for name, metrics in evaluation.candidate_train.items()
    ]
    headroom_rows = [
        [
            item["headroom_pct"],
            item["brier"],
            item["log_loss"],
            item["roc_auc"],
            item["average_precision"],
            item["positive_rate"],
            item["mean_probability"],
            item["calibration_gap"],
            item["bss_train"],
            item["precision_at_threshold"],
            item["recall_at_threshold"],
        ]
        for item in evaluation.headroom
    ]
    cal_rows = [
        [prob, true, count]
        for prob, true, count in zip(
            evaluation.calibration[0], evaluation.calibration[1], evaluation.calibration[2], strict=True
        )
    ]
    coverage_rows = [
        [item["split"], item["labelled_share"], item["one_observation_share"], item["two_plus_share"]]
        for item in stats.profile.get("coverage", [])
    ]
    era_rows = [[item["split"], item["observation_era"], item["rows"]] for item in stats.profile.get("era", [])]

    def _p(value: Any) -> str:
        return "—" if value is None else f"{float(value):.1%}"

    cohort_rows = [
        [
            item["split"],
            item["rows"],
            item["labelled"],
            item["check_eligible"],
            item.get("check_priced", "—"),
            item.get("check_censored", "—"),
            item["two_plus"],
            _p(item["labelled_share"]),
            _p(item["prevalence"]),
            _p(item.get("two_plus_prevalence")),
            _p(item["check_prevalence"]),
        ]
        for item in stats.profile.get("cohort", [])
    ]
    r24_rows = [
        [
            item["split"],
            item["band"],
            item["rows"],
            item["eligible"],
            _p(item["covered_share"]),
            _fmt(item["mean_tail_h"], 1),
            _fmt(item["mean_gap_h"], 1),
            _fmt(item["median_gap_h"], 1),
        ]
        for item in stats.profile.get("coverage_r24", [])
    ]
    label_rows = [
        [
            item["split"],
            item["band"],
            item["labelled"],
            item["check_eligible"],
            item.get("check_priced", "—"),
            item.get("check_censored", "—"),
            _p(item["within_day_rate"]),
            _p(item.get("priced_within_day_rate")),
            _p(item["next_day_rate"]),
            _p(item["narrow_rate"]),
            _p(item["crossed_back_rate"]),
            _p(item.get("censored_within_day_rate")),
            item["dearer"],
            item["cheaper"],
            item["unchanged"],
        ]
        for item in stats.profile.get("label", [])
    ]
    tier_rows = [
        [
            item["split"],
            item["band"],
            item["one_observations"],
            _p(item["one_prevalence"]),
            item["two_plus"],
            _p(item["two_plus_prevalence"]),
        ]
        for item in stats.profile.get("label", [])
    ]
    lag_rows = [
        [
            item["split"],
            item["band"],
            _fmt(item["median_single_lag_h"], 1),
            _fmt(item["p10_single_lag_h"], 1),
            _fmt(item["p90_single_lag_h"], 1),
        ]
        for item in stats.profile.get("label", [])
    ]
    two_plus_week_rows = [
        [item["split"], item["week"], item["rows"], _p(item["two_plus_share"])]
        for item in stats.profile.get("two_plus_week", [])
    ]
    journey = stats.profile.get("journey", {})
    journey_groups: dict[tuple[str, str], int] = {}
    for item in journey.get("groups", []):
        key = (item["band"], item["successor"])
        journey_groups[key] = journey_groups.get(key, 0) + item["journeys"]
    journey_rows = [[band, successor, count] for (band, successor), count in sorted(journey_groups.items())]
    unlabelled_agg: dict[tuple[str, str, str], list[float]] = {}
    for item in stats.profile.get("unlabelled", []):
        key = (item["split"], item["band"], item["era"])
        bucket = unlabelled_agg.setdefault(key, [0.0, 0.0])
        bucket[0] += item["rows"]
        bucket[1] += item["rows"] * item["unlabelled_share"]
    unlabelled_rows = [
        [split, band, era, int(rows), _p(share / rows if rows else None)]
        for (split, band, era), (rows, share) in sorted(unlabelled_agg.items())
    ]
    weekly_agg: dict[tuple[str, str], list[float]] = {}
    for item in stats.profile.get("unlabelled", []):
        key = (item["split"], item["week"])
        bucket = weekly_agg.setdefault(key, [0.0, 0.0])
        bucket[0] += item["rows"]
        bucket[1] += item["rows"] * item["unlabelled_share"]
    weekly_rows = sorted(
        (
            [split, week, int(rows), share / rows if rows else 0.0]
            for (split, week), (rows, share) in weekly_agg.items()
        ),
        key=lambda row: float(row[3]),
        reverse=True,
    )[:12]
    weekly_rows = [[row[0], row[1], row[2], _p(row[3])] for row in weekly_rows]
    headroom_ttd_rows = [
        [
            item["ttd_band"],
            item["headroom_pct"],
            item.get("train_rows"),
            item.get("positive_rate"),
            _fmt(item.get("brier")),
            _fmt(item.get("log_loss")),
            _fmt(item.get("bss")),
            _fmt(item.get("bss_train")),
            _fmt(item.get("bss_climatology")),
            _fmt(item.get("roc_auc")),
            _fmt(item.get("average_precision")),
            _fmt(item.get("roc_auc_raw")),
        ]
        for item in evaluation.headroom_ttd
    ]
    strata_rows = [
        [
            item["dimension"],
            item["value"],
            item["rows"],
            item.get("train_rows"),
            _p(item.get("positive_rate")),
            _fmt(item.get("brier")),
            _fmt(item.get("bss")),
            _fmt(item.get("bss_train")),
            _fmt(item.get("roc_auc")),
            _fmt(item.get("average_precision")),
            _fmt(item.get("calibration_gap"), 4),
        ]
        for item in evaluation.strata
    ]
    strata_compare_rows = [
        [
            item["dimension"],
            item["value"],
            item["validation_rows"],
            item["test_rows"],
            _fmt(item["validation_brier"]),
            _fmt(item["test_brier"]),
            _fmt(item["validation_bss"]),
            _fmt(item["test_bss"]),
        ]
        for item in evaluation.strata_compare
    ]
    headroom_cal_rows = [
        [
            item["headroom_pct"],
            _fmt(item.get("calibration_slope"), 3),
            _fmt(item.get("calibration_intercept"), 3),
            _fmt(item.get("ece"), 4),
        ]
        for item in evaluation.headroom
    ]
    calibration_group_rows = [
        [
            item["headroom_pct"],
            item["ttd_band"],
            item["era"],
            item["rows"],
            _fmt(item.get("slope"), 3),
            _fmt(item.get("intercept"), 3),
            _fmt(item.get("ece"), 4),
        ]
        for item in evaluation.calibration_groups
    ]
    reliability_rows = [
        [group["headroom_pct"], group["ttd_band"], group["era"], _fmt(pred), _fmt(obs), count]
        for group in evaluation.calibration_groups
        for pred, obs, count in zip(group["prob_pred"], group["prob_true"], group["counts"], strict=True)
    ]
    decision_rows = [
        [
            item["band"],
            item["headroom_pct"],
            item["alert_rows"],
            _p(item["alert_share"]),
            _fmt(item["policy_saving_eur"], 2),
            _p(item["policy_saving_pct"]),
            _fmt(item["conditional_saving_eur"], 2),
            _fmt(item["ci_eur"][0], 2) + ".." + _fmt(item["ci_eur"][1], 2) if item["ci_eur"] else "—",
            _fmt(item["always_wait_eur"], 2),
            _p(item["always_wait_pct"]),
        ]
        for item in evaluation.decision_value
    ]
    interval_labels = {
        "brier": "Brier",
        "log_loss": "log loss",
        "bss": "BSS",
        "roc_auc": "ROC-AUC",
        "average_precision": "average precision",
        "precision": "precision",
        "recall": "recall",
    }
    interval_values = dict(evaluation.intervals)
    interval_values["brier"] = evaluation.bootstrap.get("brier", interval_values.get("brier", []))
    interval_values["log_loss"] = evaluation.bootstrap.get("log_loss", interval_values.get("log_loss", []))
    interval_rows = [
        [interval_labels.get(key, key), _fmt(values[0]), _fmt(values[1])]
        for key, values in interval_values.items()
        if len(values) == 2
    ]
    paired_rows = []
    for name, label in (("vs_climatology", "model - climatology"), ("vs_logistic", "model - logistic")):
        point = evaluation.paired.get(f"{name}_brier_point")
        interval = evaluation.paired.get(f"{name}_brier", [])
        paired_rows.append(
            [
                label,
                _fmt(point),
                _fmt(interval[0]) if len(interval) == 2 else "—",
                _fmt(interval[1]) if len(interval) == 2 else "—",
            ]
        )
    model_metrics = evaluation.test
    clim_metrics = evaluation.climatology
    clim_rows = [
        [
            name,
            _fmt(metrics.get("brier")),
            _fmt(metrics.get("bss")),
            _fmt(metrics.get("bss_train")),
            _fmt(metrics.get("roc_auc")),
            _fmt(metrics.get("average_precision")),
        ]
        for name, metrics in (("model", model_metrics), ("climatology", clim_metrics))
    ]
    cohort_table = _table(
        [
            "split",
            "rows",
            "labelled",
            "check eligible",
            "check priced",
            "check censored",
            "two-plus",
            "labelled share",
            "prevalence",
            "two-plus prevalence",
            "check prevalence",
        ],
        cohort_rows,
    )
    label_table = _table(
        [
            "split",
            "TTD band",
            "labelled",
            "check eligible",
            "check priced",
            "check censored",
            "within-day all",
            "within-day priced",
            "next-day point",
            "22-24 h point",
            "crossed back",
            "censored within-day",
            "dearer",
            "cheaper",
            "unchanged",
        ],
        label_rows,
    )
    tier_table = _table(
        ["split", "TTD band", "one future scrape", "one prevalence", "two or more", "two-plus prevalence"], tier_rows
    )
    lag_table = _table(["split", "TTD band", "median single lag h", "p10 h", "p90 h"], lag_rows)
    two_plus_week_table = _table(["split", "week", "rows", "two-plus share"], two_plus_week_rows)
    journey_table = _table(["TTD band", "successor", "journeys"], journey_rows)
    unlabelled_table = _table(["split", "TTD band", "era", "rows", "unlabelled"], unlabelled_rows)
    weekly_table = _table(["split", "week", "rows", "unlabelled"], weekly_rows)
    r24_table = _table(
        [
            "split",
            "TTD band",
            "rows",
            "coverage known",
            "R24 covered",
            "mean tail h",
            "mean max gap h",
            "median gap h",
        ],
        r24_rows,
    )
    clim_table = _table(["score", "Brier", "BSS slice", "BSS train", "ROC-AUC", "average precision"], clim_rows)
    interval_table = _table(["metric", "2.5 %", "97.5 %"], interval_rows)
    paired_table = _table(["comparison", "Brier difference", "2.5 %", "97.5 %"], paired_rows)
    headroom_ttd_table = _table(
        [
            "TTD band",
            "headroom %",
            "train rows",
            "positive rate",
            "Brier",
            "log loss",
            "BSS slice",
            "BSS train",
            "BSS clim",
            "ROC-AUC",
            "avg precision",
            "ROC-AUC raw",
        ],
        headroom_ttd_rows,
    )
    strata_table = _table(
        [
            "dimension",
            "value",
            "rows",
            "train rows",
            "prevalence",
            "Brier",
            "BSS",
            "BSS train",
            "ROC-AUC",
            "avg precision",
            "calibration gap",
        ],
        strata_rows,
    )
    strata_compare_table = (
        _table(
            [
                "dimension",
                "value",
                "validation rows",
                "test rows",
                "validation Brier",
                "test Brier",
                "validation BSS",
                "test BSS",
            ],
            strata_compare_rows,
        )
        if strata_compare_rows
        else "- Test was not evaluated; no like-for-like table."
    )
    headroom_cal_table = _table(["headroom %", "slope", "intercept", "ECE"], headroom_cal_rows)
    calibration_group_table = _table(
        ["headroom %", "TTD band", "era", "rows", "slope", "intercept", "ECE"], calibration_group_rows
    )
    reliability_table = _table(["headroom %", "TTD band", "era", "predicted", "observed", "count"], reliability_rows)
    decision_table = _table(
        [
            "TTD band",
            "headroom %",
            "alerts",
            "alert share",
            "policy € / snapshot",
            "policy % / snapshot",
            "conditional € / alert",
            "policy 95% CI €",
            "always wait €",
            "always wait %",
        ],
        decision_rows,
    )
    journey_total = int(journey.get("total_journeys", 0))
    journey_at_risk = int(journey.get("at_risk", 0))
    journey_disappeared = int(journey.get("disappeared", 0))
    journey_share = _p(journey.get("share"))
    journey_share_at_risk = _p(journey.get("share_at_risk"))
    journey_none = sum(item["journeys"] for item in journey.get("groups", []) if item["successor"] == "none")
    warning_items = _warnings(stats, evaluation)
    warnings = "\n".join(f"- {warning}" for warning in warning_items) or "- none"
    ablation_section = ""
    if ablation:
        rows = [
            [
                name,
                item["validation_brier"],
                item["validation_log_loss"],
                item["validation_roc_auc"],
            ]
            for name, item in ablation.items()
        ]
        ablation_section = "\n## Calendar ablation\n\n" + _table(
            ["feature set", "validation Brier", "validation log loss", "validation ROC-AUC"], rows
        )
    split_caveat = (
        "The test split is a future-departure cohort, not a future-era holdout. "
        "The report shows era composition; do not read the test metric as era generalization."
    )
    split = config["splits"]
    split_line = (
        f"- Splits: train <= {split['train_end']}; "
        f"validation-select {split['validation_select_start']}..{split['validation_select_end']}; "
        f"validation-calibrate {split['validation_calibrate_start']}..{split['validation_calibrate_end']}; "
        f"test {split['test_start']}..{split['test_end']}"
    )
    model_line = (
        f"- Model: `{evaluation.chosen_model}`; calibration: `{evaluation.calibration_method}`; "
        f"threshold: {evaluation.threshold:.4f}; precision floor met on validation-calibrate: "
        f"{'yes' if evaluation.threshold_precision_floor_met else 'no (F1 fallback)'}"
    )
    ttd_line = (
        f"- TTD domain: {config['label']['min_hours_to_departure']}-{config['label']['max_hours_to_departure']} hours"
    )
    brier_line = (
        f"- Brier: **{_fmt(evaluation.test.get('brier'))}** (grouped bootstrap 95% CI "
        f"{_fmt(evaluation.bootstrap['brier'][0])}-{_fmt(evaluation.bootstrap['brier'][1])})"
    )
    logloss_line = (
        f"- Log loss: **{_fmt(evaluation.test.get('log_loss'))}** (95% CI "
        f"{_fmt(evaluation.bootstrap['log_loss'][0])}-{_fmt(evaluation.bootstrap['log_loss'][1])})"
    )
    bss_line = (
        f"- Brier skill score vs the slice base rate: {_fmt(evaluation.test.get('bss'))}\n"
        f"- Brier skill score vs the **train** base rate: {_fmt(evaluation.test.get('bss_train'))}\n"
        f"- Brier skill score vs climatology: {_fmt(evaluation.test.get('bss_climatology'))}\n"
        f"- Train prevalence of the evaluated subset: {_fmt(evaluation.train_prevalence)}"
    )
    test_all_line = (
        (
            f"- All labelled rows (including one-observation windows): "
            f"Brier {_fmt(evaluation.test_all.get('brier'))}, "
            f"ROC-AUC {_fmt(evaluation.test_all.get('roc_auc'))}. "
            f"The headline uses {evaluation.test_tier.replace('_', ' ')}."
        )
        if evaluation.test_all is not None
        else (
            "- Test was not evaluated; model metrics are validation-calibrate only. "
            "Test cohort diagnostics above are descriptive."
        )
    )
    headroom_headers = [
        "headroom %",
        "Brier",
        "log loss",
        "ROC-AUC",
        "average precision",
        "positive rate",
        "mean prob",
        "gap",
        "BSS train",
        "precision",
        "recall",
    ]
    risk_bands = "The threshold is a reporting choice, not a product decision."
    eval_label = "Test" if evaluation.test_evaluated else "Validation-calibrate"
    threshold_caveat = (
        "- Validation precision and recall use the same validation-calibrate rows that selected the "
        "threshold; they are optimistic.\n"
        if not evaluation.test_evaluated
        else ""
    )
    known_limitations = (
        "## Known limitations\n\n"
        "- The label is the maximum over scraped observations in the next 24 h; for most rows it is "
        "one scrape about 13 h ahead. The >=2-scrape tier is selected on future information and its "
        "mix follows scraper operations.\n"
        "- Test snapshots overlap validation-calibrate weeks unless the run used a later forward "
        "set; the September departure cohort has been evaluated before this run.\n"
        "- These are development figures, not a production estimate. The product's hourly refresher "
        "and 7-30 d booking window are not fully represented.\n"
        "- Pooled metrics include headroom identification; per-headroom rows are the primary view.\n"
        f"{threshold_caveat}"
        "- The headline uses the two-or-more-scrape tier while the model comparison table uses all "
        "validation-select rows.\n"
        "- Dataset diagnostics for the test cohort are descriptive; test model metrics are written "
        "only with `--evaluate-test`.\n"
        "- No model serving contract, no real user limits, and no season outside the current corpus."
    )
    return f"""# Baseline training report

> Generated by the local training builder. This is an offline evaluation, not a deployed model.

## Run

- Runner: `{runner}`
- Rows: **{stats.rows:,}** total, **{stats.labelled_rows:,}** labelled
- Series: **{stats.series:,}**; route-days: **{stats.route_days:,}**
- Calendar feature set: `{spec.calendar_set}`
{model_line}
{split_line}
{ttd_line}
{provenance_lines}
- {split_caveat}

## Dataset

{_table(["split", "rows", "series", "route-days", "labelled", "positives", "positive rate"], split_rows)}

### Label coverage

{_table(["split", "labelled share", "one future observation", "two or more"], coverage_rows)}

### Observation-era composition

{_table(["split", "era", "rows"], era_rows)}

### Cohort and eligibility

{cohort_table}

### Label and check-window diagnostics

{label_table}

`crossed back` is the share whose within-day maximum breached but the next-day point did not.
`dearer`/`cheaper`/`unchanged` use a +/-0.5 % band around the current fare and cover only rows with
a 23-36 h reference; `check priced` is the denominator for the next-day rate.

Prevalence by evidence tier:

{tier_table}

Single future scrape lag:

{lag_table}

14-30 d snapshots with two or more future scrapes, by observation week:

{two_plus_week_table}

### Journey disappearance

- Journeys with at least 3 observations: **{journey_total:,}**
- At risk (last observation more than 24 h before departure): **{journey_at_risk:,}**
- Disappeared while the route-day was still scraped: **{journey_disappeared:,}** of all journeys
  ({journey_share}); {journey_share_at_risk} of at-risk
- Successor `none`: **{journey_none:,}** (a later scrape existed but contained no priced journey)

{journey_table}

### Unlabelled shares

{unlabelled_table}

Highest weekly unlabelled shares:

{weekly_table}

### Within-24 h coverage (R24)

R24 requires the last scrape within {config["report"]["r24_max_tail_hours"]} h of `t + 24 h`
and no gap above {config["report"]["r24_max_gap_hours"]} h.

{r24_table}

## Model comparison (cross-fitted validation-select)

{_table(["model", "Brier", "log loss", "ROC-AUC", "average precision", "positive rate"], candidate_rows)}

Candidate calibration method: `{evaluation.candidate_calibration_method}`; the final model uses
`{evaluation.calibration_method}`.

### Train-split diagnostics (in-sample)

{_table(["model", "Brier", "log loss", "ROC-AUC", "average precision", "positive rate"], candidate_train_rows)}
{ablation_section}

### Climatology baseline

{clim_table}

## {eval_label} metrics

{brier_line}
{logloss_line}
{bss_line}
- ROC-AUC: {_fmt(evaluation.test.get("roc_auc"))}; average precision: {_fmt(evaluation.test.get("average_precision"))}
- Prevalence: {_fmt(evaluation.test.get("positive_rate"))}
- Precision at threshold: {_fmt(evaluation.test.get("precision_at_threshold"))}
- Recall at threshold: {_fmt(evaluation.test.get("recall_at_threshold"))}
- Headroom monotonic: {evaluation.test.get("headroom_monotonic")}
- Evaluation tier: `{evaluation.test_tier}` ({evaluation.test_tier_rows} rows)
- Precision floor met on evaluation: {evaluation.test.get("precision_floor_met_on_evaluation")}
{test_all_line}

{risk_bands}

### Bootstrap intervals and paired Brier differences

{interval_table}

{paired_table}

Negative Brier differences mean the model is better than the baseline.

## Per-headroom evaluation metrics

{_table(headroom_headers, headroom_rows)}

### Per-headroom x TTD band

{headroom_ttd_table}

### Strata

{strata_table}

### Like-for-like validation vs test (only with --evaluate-test)

{strata_compare_table}

### Calibration statistics

{headroom_cal_table}

Per-headroom x TTD band x era:

{calibration_group_table}

Reliability by headroom, TTD band and era:

{reliability_table}

### Decision value (diagnostic on the current label)

{decision_table}

## Calibration

{_table(["predicted", "observed", "count"], cal_rows)}

## Permutation importance (validation-select sample)

{_table(["feature", "Brier increase"], [[item["feature"], item["importance"]] for item in evaluation.importance[:15]])}

{known_limitations}

## Warnings

{warnings}
"""


def write_report(
    out_dir: Path,
    stats: DatasetStats,
    evaluation: Evaluation,
    spec: FeatureSpec,
    config: dict[str, Any],
    *,
    runner: str,
    ablation: dict[str, Any] | None = None,
    build_config: dict[str, Any] | None = None,
) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    dataset_manifest = json.loads((out_dir / "dataset_manifest.json").read_text(encoding="utf-8"))
    digests = ", ".join(
        f"{item['split']}:{item.get('sum64')}:{item.get('xor64')}" for item in dataset_manifest.get("dataset_files", [])
    )
    evaluation_hash = hashlib.sha256(json.dumps(config, sort_keys=True, default=str).encode()).hexdigest()
    provenance_lines = (
        f"- Git: `{dataset_manifest.get('git_sha')}` (dirty: {dataset_manifest.get('git_dirty')})\n"
        f"- Silver build: `{dataset_manifest.get('silver_build_id')}`\n"
        f"- Build config hash: `{dataset_manifest.get('config_sha256')}`\n"
        f"- Evaluation config hash: `{evaluation_hash}`\n"
        f"- Dataset digests: `{digests}`"
    )
    (out_dir / "report.md").write_text(
        _report(stats, evaluation, spec, config, runner, ablation, provenance_lines),
        encoding="utf-8",
    )
    payload = {
        "run_id": stats.run_id,
        "runner": runner,
        "config": config,
        "dataset": stats.to_dict(),
        "feature_spec": {"calendar_set": spec.calendar_set, "features": list(spec.names)},
        "evaluation": evaluation.to_dict(),
        "test_evaluated": evaluation.test_evaluated,
        "evaluation_split": evaluation.evaluation_split,
    }
    if ablation is not None:
        payload["ablation"] = ablation
    (out_dir / "metrics.json").write_text(
        json.dumps(payload, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8"
    )
    with (out_dir / "calibration.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["prob_pred", "prob_true", "count"])
        for prob, true, count in zip(
            evaluation.calibration[0], evaluation.calibration[1], evaluation.calibration[2], strict=True
        ):
            writer.writerow([float(prob), float(true), int(count)])
    manifest = dict(dataset_manifest)
    manifest.pop("config_sha256", None)
    manifest["build_config"] = build_config or config
    manifest["build_config_sha256"] = dataset_manifest.get("config_sha256")
    manifest["evaluation_config"] = config
    manifest["evaluation_config_sha256"] = hashlib.sha256(
        json.dumps(config, sort_keys=True, default=str).encode()
    ).hexdigest()
    manifest["test_evaluated"] = evaluation.test_evaluated
    manifest["evaluation_split"] = evaluation.evaluation_split
    manifest["model"] = {
        "chosen": evaluation.chosen_model,
        "calibration": evaluation.calibration_method,
        "threshold": evaluation.threshold,
        "candidates": evaluation.candidates,
        "metrics": evaluation.test,
        "bootstrap": evaluation.bootstrap,
        "ablation": ablation,
        "runner": runner,
        "dropped_features": list(evaluation.dropped_features),
        "predictions": f"predictions/{evaluation.prediction_split}.parquet",
        "model_file": "model.joblib",
        "package_versions": {
            "python": platform.python_version(),
            "numpy": numpy.__version__,
            "scikit_learn": sklearn.__version__,
        },
    }
    manifest["artifacts"] = [
        "dataset/train.parquet",
        "dataset/validation_select.parquet",
        "dataset/validation_calibrate.parquet",
        "dataset/test.parquet",
        "dataset_manifest.json",
        "profile.json",
        "report.md",
        "metrics.json",
        "calibration.csv",
        f"predictions/{evaluation.prediction_split}.parquet",
        "model.joblib",
    ]
    manifest["artifact_sha256"] = {
        relative: hashlib.sha256((out_dir / relative).read_bytes()).hexdigest()
        for relative in manifest["artifacts"]
        if (out_dir / relative).is_file()
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8"
    )
