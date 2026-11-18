"""Human- and machine-readable evaluation artefacts."""

from __future__ import annotations

import csv
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


def _report(
    stats: DatasetStats,
    evaluation: Evaluation,
    spec: FeatureSpec,
    config: dict[str, Any],
    runner: str,
    ablation: dict[str, Any] | None = None,
) -> str:
    split_rows = [
        [item.split, item.rows, item.series, item.route_days, item.labelled, item.positives, item.positive_rate]
        for item in stats.splits
    ]
    candidate_rows = [
        [name, *[metrics.get(key) for key in ("brier", "log_loss", "roc_auc", "pr_auc", "positive_rate")]]
        for name, metrics in evaluation.candidates.items()
    ]
    headroom_rows = [
        [
            item["headroom_pct"],
            item["brier"],
            item["log_loss"],
            item["roc_auc"],
            item["pr_auc"],
            item["positive_rate"],
            item["mean_probability"],
            item["calibration_gap"],
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
    warnings = "\n".join(f"- {warning}" for warning in stats.warnings) or "- none"
    ablation_section = ""
    if ablation:
        rows = [
            [name, item["validation_brier"], item["test_brier"], item["test_log_loss"], item["test_roc_auc"]]
            for name, item in ablation.items()
        ]
        ablation_section = "\n## Calendar ablation\n\n" + _table(
            ["feature set", "validation Brier", "test Brier", "test log loss", "test ROC-AUC"], rows
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
        f"- Brier skill score vs the **train** base rate: {_fmt(evaluation.test.get('bss_train'))}"
    )
    test_all_line = (
        f"- All labelled rows (including one-observation windows): "
        f"Brier {_fmt(evaluation.test_all.get('brier'))}, "
        f"ROC-AUC {_fmt(evaluation.test_all.get('roc_auc'))}. "
        f"The headline uses two or more future observations."
    )
    headroom_headers = [
        "headroom %",
        "Brier",
        "log loss",
        "ROC-AUC",
        "PR-AUC",
        "positive rate",
        "mean prob",
        "gap",
        "precision",
        "recall",
    ]
    risk_bands = (
        "Risk bands: `< 0.15` low, `0.15-0.35` watch, `>= 0.35` high. "
        "The threshold is a reporting choice, not a product decision."
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
- {split_caveat}

## Dataset

{_table(["split", "rows", "series", "route-days", "labelled", "positives", "positive rate"], split_rows)}

### Label coverage

{_table(["split", "labelled share", "one future observation", "two or more"], coverage_rows)}

### Observation-era composition

{_table(["split", "era", "rows"], era_rows)}

## Model comparison (cross-fitted validation-select)

{_table(["model", "Brier", "log loss", "ROC-AUC", "PR-AUC", "positive rate"], candidate_rows)}
{ablation_section}

## Test metrics

{brier_line}
{logloss_line}
{bss_line}
- ROC-AUC: {_fmt(evaluation.test.get("roc_auc"))}; PR-AUC: {_fmt(evaluation.test.get("pr_auc"))}
- Precision at threshold: {_fmt(evaluation.test.get("precision_at_threshold"))}
- Recall at threshold: {_fmt(evaluation.test.get("recall_at_threshold"))}
- Headroom monotonic: {evaluation.test.get("headroom_monotonic")}
{test_all_line}
- Precision floor met on test: {evaluation.test.get("precision_floor_met_on_test")}

{risk_bands}

## Per-headroom test metrics

{_table(headroom_headers, headroom_rows)}

## Calibration

{_table(["predicted", "observed", "count"], cal_rows)}

## Permutation importance (validation-select sample)

{_table(["feature", "Brier increase"], [[item["feature"], item["importance"]] for item in evaluation.importance[:15]])}

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
) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "report.md").write_text(_report(stats, evaluation, spec, config, runner, ablation), encoding="utf-8")
    payload = {
        "run_id": stats.run_id,
        "runner": runner,
        "dataset": stats.to_dict(),
        "feature_spec": {"calendar_set": spec.calendar_set, "features": list(spec.names)},
        "evaluation": evaluation.to_dict(),
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
    dataset_manifest = json.loads((out_dir / "dataset_manifest.json").read_text(encoding="utf-8"))
    manifest = dict(dataset_manifest)
    manifest["model"] = {
        "chosen": evaluation.chosen_model,
        "calibration": evaluation.calibration_method,
        "threshold": evaluation.threshold,
        "candidates": evaluation.candidates,
        "test": evaluation.test,
        "bootstrap": evaluation.bootstrap,
        "ablation": ablation,
        "runner": runner,
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
        "report.md",
        "metrics.json",
        "calibration.csv",
    ]
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8"
    )
