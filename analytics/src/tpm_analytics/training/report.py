"""Human- and machine-readable evaluation artefacts."""

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
    """Format a report value."""
    if value is None:
        return "—"
    if isinstance(value, float):
        return f"{value:.{digits}f}"
    return str(value)


def _table(headers: list[str], rows: list[list[Any]]) -> str:
    """Render a Markdown table from headers and rows."""
    if any(len(row) != len(headers) for row in rows):
        raise ValueError("table row width does not match the header width")
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    lines.extend("| " + " | ".join(_fmt(cell) for cell in row) + " |" for row in rows)
    return "\n".join(lines)


def _gated_dataset_payload(stats: DatasetStats, evaluation_on_test: bool) -> dict[str, Any]:
    """Mirror the dataset in ``metrics.json`` with test rows removed from a validation-only run.

    Split-keyed lists and the aggregate totals are gated; corpus-level diagnostics that do not
    carry a split key (chain, duplicate and scrape-cadence audits) stay whole. ``profile.json``
    and ``dataset_manifest.json`` keep the descriptive test aggregates.
    """
    payload = stats.to_dict()
    if evaluation_on_test:
        return payload
    payload["splits"] = [item for item in payload.get("splits", []) if item.get("split") != "test"]
    # Keep the aggregate totals consistent with the retained splits. Series and route-days cannot
    # span a split because the split follows the chain departure date.
    payload["rows"] = sum(int(item.get("rows", 0)) for item in payload["splits"])
    payload["labelled_rows"] = sum(int(item.get("labelled", 0)) for item in payload["splits"])
    payload["series"] = sum(int(item.get("series", 0)) for item in payload["splits"])
    payload["route_days"] = sum(int(item.get("route_days", 0)) for item in payload["splits"])
    profile = payload.get("profile")
    if isinstance(profile, dict):
        for key, value in list(profile.items()):
            if isinstance(value, list):
                profile[key] = [item for item in value if not (isinstance(item, dict) and item.get("split") == "test")]
    return payload


def _warnings(stats: DatasetStats, evaluation: Evaluation) -> list[str]:
    """Return report warning rows for the dataset and evaluation."""
    warning_items = list(stats.warnings)
    positives = float(evaluation.metrics.get("positive_rate") or 0.0)
    if not evaluation.metrics.get("precision_floor_met_on_evaluation"):
        warning_items.append("precision floor missed on the evaluated split")
    if evaluation.evaluation_on_test and abs(positives - evaluation.calibration_prevalence) > 0.02:
        warning_items.append(
            "prevalence shift between calibration and evaluation: "
            f"{evaluation.calibration_prevalence:.3f} vs {positives:.3f}"
        )
    if not numpy.isfinite(evaluation.train_prevalence):
        warning_items.append("no training rows match the evaluation population; BSS vs train is unavailable")
    elif abs(positives - evaluation.train_prevalence) > 0.02:
        warning_items.append(
            f"prevalence shift between train and evaluation: {evaluation.train_prevalence:.3f} vs {positives:.3f}"
        )
    if not evaluation.metrics.get("headroom_monotonic"):
        warning_items.append("calibrated breach probability is not monotone across headroom")
    if evaluation.calibration_constant:
        warning_items.append("calibration labels are single-class; the shipped calibrator is constant")
    chain = stats.profile.get("chain", {})
    if (
        not chain.get("strict")
        and (chain.get("ambiguous_predecessors") or chain.get("ambiguous_successors"))
        and not any(item.startswith("ambiguous chain candidates") for item in warning_items)
    ):
        warning_items.append(
            "ambiguous chain candidates: "
            f"{chain.get('ambiguous_predecessors', 0)} predecessors / "
            f"{chain.get('ambiguous_successors', 0)} successors; run --strict-chains"
        )
    for split in stats.splits:
        if not evaluation.evaluation_on_test and split.split == "test":
            continue
        share = split.labelled / split.eligible if split.eligible else 0.0
        if share < 0.9:
            warning_items.append(f"{split.split} has only {share:.1%} of eligible rows labelled")
    if evaluation.dropped_features:
        warning_items.append(f"constant/all-null features dropped: {', '.join(evaluation.dropped_features)}")
    return warning_items


def _report(
    stats: DatasetStats,
    evaluation: Evaluation,
    spec: FeatureSpec,
    config: dict[str, Any],
    runner: str,
    provenance_lines: str = "",
) -> str:
    """Render the backtest report as Markdown."""
    total_chains = sum(item.chains for item in stats.splits)
    split_rows = [
        [
            item.split,
            item.rows,
            item.series,
            item.chains,
            item.route_days,
            item.eligible,
            item.labelled,
            item.positives,
            item.positive_rate,
        ]
        for item in stats.splits
        if evaluation.evaluation_on_test or item.split != "test"
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

    def _p(value: Any) -> str:
        """Format a probability as a percentage."""
        return "—" if value is None else f"{float(value):.1%}"

    def _share(numerator: Any, denominator: Any) -> str:
        """Format a share as a percentage or em dash."""
        if numerator is None or not denominator:
            return "—"
        return _p(float(numerator) / float(denominator))

    def _ci(values: Any, digits: int = 2) -> str:
        """Format a two-sided interval."""
        if not isinstance(values, list) or len(values) != 2:
            return "—"
        return f"{_fmt(values[0], digits)}..{_fmt(values[1], digits)}"

    coverage_rows = [
        [
            item["split"],
            _p(item.get("eligible_share")),
            _p(item.get("labelled_share")),
            _p(item.get("censor_share")),
            _p(item.get("r24_share")),
            _p(item.get("within_24h_r24_rate")),
        ]
        for item in stats.profile.get("coverage", [])
        if evaluation.evaluation_on_test or item["split"] != "test"
    ]
    early_window_rows = [
        [item["split"], item["rows"], item["eligible"], _share(item.get("eligible"), item["rows"])]
        for item in stats.profile.get("early_window", [])
        if evaluation.evaluation_on_test or item["split"] != "test"
    ]
    era_rows = [
        [item["split"], item["observation_era"], item["rows"]]
        for item in stats.profile.get("era", [])
        if evaluation.evaluation_on_test or item["split"] != "test"
    ]

    cohort_rows = [
        [
            item["split"],
            item["rows"],
            item["eligible"],
            item["labelled"],
            item["censored"],
            item["no_check"],
            item["not_listed"],
            _p(item.get("eligible_share")),
            _p(item.get("labelled_share")),
            _p(item.get("censor_share")),
            _p(item.get("prevalence")),
        ]
        for item in stats.profile.get("cohort", [])
        if evaluation.evaluation_on_test or item["split"] != "test"
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
        if item["band"] in {"1-3d", "3-5d", "5-7d"} and (evaluation.evaluation_on_test or item["split"] != "test")
    ]
    label_items = [
        item for item in stats.profile.get("label", []) if evaluation.evaluation_on_test or item["split"] != "test"
    ]
    label_rows = [
        [
            item["split"],
            item["band"],
            item["rows"],
            item["eligible"],
            _share(item["eligible"], item["rows"]),
            item["labelled"],
            item["censored"],
            _p(item.get("prevalence")),
            _fmt(item.get("median_check_lag_h"), 1),
            _fmt(item.get("p10_check_lag_h"), 1),
            _fmt(item.get("p90_check_lag_h"), 1),
            _p(item.get("within_24h_r24_rate")),
            _p(item.get("next_day_2024_rate")),
            _p(item.get("next_day_2226_rate")),
            _p(item.get("crossed_back_rate")),
            item.get("dearer", 0),
            item.get("cheaper", 0),
            item.get("unchanged", 0),
        ]
        for item in label_items
    ]
    label_era_rows = [
        [
            item["split"],
            item["era"],
            item["band"],
            item["rows"],
            _share(item.get("eligible"), item["rows"]),
            _share(item.get("labelled"), item["rows"]),
            _p(item.get("prevalence")),
        ]
        for item in stats.profile.get("label_era", [])
        if evaluation.evaluation_on_test or item["split"] != "test"
    ]
    label_week_rows = [
        [
            item["split"],
            item["week"],
            item["band"],
            item["rows"],
            _share(item.get("eligible"), item["rows"]),
            _share(item.get("labelled"), item["rows"]),
            _p(item.get("prevalence")),
        ]
        for item in stats.profile.get("label_week", [])
        if evaluation.evaluation_on_test or item["split"] != "test"
    ]
    a18_rows = [
        [
            item["split"],
            item["bin_regime"],
            item["rows"],
            item["bins"],
            item["collision_bins"],
            item["collision_rows"],
            _share(item.get("collision_rows"), item["rows"]),
        ]
        for item in stats.profile.get("a18", [])
        if evaluation.evaluation_on_test or item["split"] != "test"
    ]
    a19_rows = [
        [
            item["split"],
            item["rows"],
            item["rows_23_30d"],
            item["rows_23_30d_short_history"],
            _share(item.get("rows_23_30d_short_history"), item.get("rows_23_30d")),
            item["rows_history_beyond_720"],
            _share(item.get("rows_history_beyond_720"), item["rows"]),
        ]
        for item in stats.profile.get("a19", [])
        if evaluation.evaluation_on_test or item["split"] != "test"
    ]
    a24_rows = [
        [
            item["split"],
            item["band"],
            item["era"],
            item["rows"],
            item["missing_at_check"],
            item["miss_one"],
            item["miss_all"],
            _share(item.get("miss_one"), item["rows"]),
            _share(item.get("miss_all"), item["rows"]),
        ]
        for item in stats.profile.get("a24", [])
        if evaluation.evaluation_on_test or item["split"] != "test"
    ]
    censored_band_rows = [
        [
            item["split"],
            item["band"],
            item["labelled_rows"],
            item["not_listed"],
            item["censored_observed"],
            _p(item.get("censored_within_day_rate")),
            _p(item.get("labelled_within_day_rate")),
        ]
        for item in stats.profile.get("censored_band", [])
        if item.get("not_listed") and (evaluation.evaluation_on_test or item["split"] != "test")
    ]
    a26_rows = [
        [
            item["split"],
            item["band"],
            item["era"],
            item["rows"],
            item["scrape_10_16"],
            _share(item.get("scrape_10_16"), item["rows"]),
        ]
        for item in stats.profile.get("a26", [])
        if evaluation.evaluation_on_test or item["split"] != "test"
    ]
    a29_rows = [
        [
            item["split"],
            item["band"],
            item["rows"],
            _p(item.get("within_day_rate")),
            _p(item.get("next_day_rate")),
            _p(item.get("crossed_back_rate")),
        ]
        for item in stats.profile.get("a29", [])
        if evaluation.evaluation_on_test or item["split"] != "test"
    ]
    tier_rows = [
        [
            item["split"],
            item["band"],
            item["tier"],
            item["rows"],
            item["labelled"],
            _p(item.get("prevalence")),
        ]
        for item in stats.profile.get("tier", [])
        if evaluation.evaluation_on_test or item["split"] != "test"
    ]
    journey = stats.profile.get("journey", {})
    journey_groups: dict[tuple[str, str, str], int] = {}
    journey_60_groups: dict[tuple[str, str, str], int] = {}
    for item in journey.get("groups", []):
        key = (item["band"], "15 min", item["successor"])
        journey_groups[key] = journey_groups.get(key, 0) + item["journeys"]
        key_60 = (item["band"], "60 min", item["successor_60"])
        journey_60_groups[key_60] = journey_60_groups.get(key_60, 0) + item["journeys"]
    journey_rows = []
    for band in sorted({key[0] for key in journey_groups}):
        for rule in ("15 min", "60 min"):
            groups = journey_60_groups if rule == "60 min" else journey_groups
            total = sum(groups.get((band, rule, successor), 0) for successor in ("same_train", "other_train", "none"))
            journey_rows.append(
                [
                    band,
                    rule,
                    _share(groups.get((band, rule, "same_train"), 0), total),
                    _share(groups.get((band, rule, "other_train"), 0), total),
                    _share(groups.get((band, rule, "none"), 0), total),
                    total,
                ]
            )
    journey_week_groups: dict[str, dict[str, int]] = {}
    for item in journey.get("groups", []):
        bucket = journey_week_groups.setdefault(
            item["week"], {"total": 0, "same_train": 0, "other_train": 0, "none": 0}
        )
        bucket["total"] += item["journeys"]
        bucket[item["successor_60"]] += item["journeys"]
    journey_week_rows = [
        [week, counts["total"], counts["same_train"], counts["other_train"], counts["none"]]
        for week, counts in sorted(journey_week_groups.items())
    ]
    chain = stats.profile.get("chain", {})
    chain_rows = [
        [
            "yes" if chain.get("strict") else "no",
            chain.get("series", 0),
            chain.get("base_series", 0),
            chain.get("split_series", 0),
            chain.get("at_risk_series", 0),
            chain.get("at_risk_series_3plus", 0),
            chain.get("candidate_links", 0),
            chain.get("links", 0),
            chain.get("links_3plus", 0),
            chain.get("chains", 0),
            chain.get("identities", 0),
            chain.get("singleton_chains", 0),
            chain.get("linked_series", 0),
            chain.get("largest_chain", 0),
            _p(chain.get("link_rate")),
            _p(chain.get("link_rate_3plus")),
            _p(chain.get("series_link_rate")),
            chain.get("ambiguous_predecessors", 0),
            chain.get("ambiguous_successors", 0),
            chain.get("strict_dropped", 0),
            chain.get("unused_candidates", 0),
            chain.get("overlap_candidates", 0),
        ]
    ]
    chain_size_rows = [[size, count] for size, count in chain.get("size_histogram", []) if int(size) > 1]
    chain_v2 = stats.profile.get("chain_v2")
    chain_v2_rows = (
        [
            [
                f"{chain_v2['departure_window'][0]}..{chain_v2['departure_window'][1]}",
                chain_v2["v1_series"],
                chain_v2["v1_identities"],
                chain_v2["v1_linked_chains"],
                chain_v2["v2_journeys"],
                chain_v2["no_v1_counterpart"],
                _p(chain_v2["no_v1_counterpart_share"]),
                chain_v2["overlap_journeys"],
                chain_v2["matched_journeys"],
                _p(chain_v2["unmatched_share"]),
                chain_v2["split_journeys"],
                chain_v2["parallel_split_journeys"],
                chain_v2["sequential_split_journeys"],
                _p(chain_v2["split_rate"]),
                chain_v2["matched_series"],
                chain_v2["merged_series"],
                chain_v2["same_itinerary_merges"],
                chain_v2["different_itinerary_merges"],
                _p(chain_v2["merge_rate"]),
            ]
        ]
        if chain_v2
        else []
    )
    scrape_gap_rows = [
        [
            item["era"],
            item["band"],
            item["scrapes"],
            _fmt(item.get("median_gap_h"), 1),
            _p(item.get("without_24h_share")),
        ]
        for item in stats.profile.get("scrape_gap", [])
    ]
    duplicate = stats.profile.get("duplicates", {})
    duplicate_rows = [
        [
            duplicate.get("rows", 0),
            duplicate.get("duplicate_groups", 0),
            duplicate.get("duplicate_rows", 0),
            duplicate.get("extra_duplicate_rows", 0),
            _p(duplicate.get("extra_duplicate_share")),
            duplicate.get("cross_sections_ge3", 0),
            duplicate.get("cross_sections_ge3_after_dedup", 0),
            duplicate.get("dependent_cross_sections", 0),
        ]
    ]
    unlabelled_agg: dict[tuple[str, str, str], list[float]] = {}
    for item in stats.profile.get("unlabelled", []):
        if not evaluation.evaluation_on_test and item["split"] == "test":
            continue
        key = (item["split"], item["band"], item["era"])
        bucket = unlabelled_agg.setdefault(key, [0.0, 0.0])
        bucket[0] += item["rows"]
        bucket[1] += item["unlabelled"]
    unlabelled_rows = [
        [split, band, era, int(rows), _share(share, rows)]
        for (split, band, era), (rows, share) in sorted(unlabelled_agg.items())
    ]
    weekly_agg: dict[tuple[str, str], list[float]] = {}
    for item in stats.profile.get("unlabelled", []):
        if not evaluation.evaluation_on_test and item["split"] == "test":
            continue
        key = (item["split"], item["week"])
        bucket = weekly_agg.setdefault(key, [0.0, 0.0])
        bucket[0] += item["rows"]
        bucket[1] += item["unlabelled"]
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
            _ci(item.get("brier_ci"), 4),
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
            item["rows"],
            item["alert_rows"],
            _p(item["alert_share"]),
            _fmt(item["saving_vs_always_wait_eur"], 2),
            _fmt(item["lift_vs_random_eur"], 2),
            _p(item["saving_vs_always_wait_pct"]),
            _fmt(item["saving_vs_always_book_eur"], 2),
            _p(item["saving_vs_always_book_pct"]),
            _fmt(item["conditional_saving_when_alert_eur"], 2),
            _fmt(item["cost_of_waiting_eur"], 2),
            _ci(item["ci_saving_vs_wait_eur"], 3),
            _ci(item["ci_saving_vs_book_eur"], 3),
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
    model_metrics = evaluation.metrics
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
    early_window_table = _table(["split", "24-48 h rows", "eligible", "eligible share"], early_window_rows)
    cohort_table = _table(
        [
            "split",
            "rows",
            "eligible",
            "labelled",
            "censored",
            "no check",
            "not listed",
            "eligible share",
            "labelled share",
            "censor share",
            "prevalence",
        ],
        cohort_rows,
    )
    label_table = _table(
        [
            "split",
            "TTD band",
            "rows",
            "eligible",
            "eligible share",
            "labelled",
            "censored",
            "prevalence",
            "median check lag h",
            "p10 h",
            "p90 h",
            "within-24 h R24",
            "next-day 20-24",
            "next-day 22-26",
            "crossed back",
            "dearer",
            "cheaper",
            "unchanged",
        ],
        label_rows,
    )
    label_era_table = _table(
        ["split", "era", "TTD band", "rows", "eligible share", "labelled share", "prevalence"],
        label_era_rows,
    )
    label_week_table = _table(
        ["split", "week", "TTD band", "rows", "eligible share", "labelled share", "prevalence"],
        label_week_rows,
    )
    a29_table = _table(
        ["split", "TTD band", "rows", "within-day 5%", "next-day 5% (20-28 h)", "crossed back 5% (20-24 h)"],
        a29_rows,
    )
    journey_table = _table(["TTD band", "rule", "same train", "other train", "none", "journeys"], journey_rows)
    journey_week_table = _table(["week", "journeys", "same train (60 min)", "other train", "none"], journey_week_rows)
    chain_table = _table(
        [
            "strict",
            "series",
            "base series",
            "split series",
            "at risk",
            "at risk (3+ obs)",
            "candidate links",
            "links",
            "links (3+ obs)",
            "linked chains",
            "identities",
            "singleton chains",
            "linked series",
            "largest chain",
            "link rate",
            "link rate (3+ obs)",
            "series link rate",
            "ambiguous predecessors",
            "ambiguous successors",
            "strict-dropped",
            "unused candidates",
            "overlap candidates",
        ],
        chain_rows,
    )
    chain_size_table = _table(["linked chain size", "chains"], chain_size_rows)
    chain_v2_table = _table(
        [
            "departure window",
            "v1 series",
            "v1 identities",
            "v1 linked chains",
            "v2 journeys",
            "no v1 counterpart",
            "share",
            "overlap journeys",
            "matched",
            "unmatched overlap",
            "split journeys",
            "parallel splits",
            "sequential splits",
            "split rate",
            "matched series",
            "merged series",
            "same-itinerary merges",
            "different-itinerary merges",
            "merge rate",
        ],
        chain_v2_rows,
    )
    chain_v2_section = (
        "The v2 handover audit compares the v1 chains with the v2 `journey_id` sequence, per "
        "`(journey_id, service_class)` because the v2 id does not distinguish service class. "
        "v1 and v2 never share a scrape, so this is a **handover diagnostic, not a link-precision "
        "check**; the sequential splits are possible missed links. A v2-internal `journey_id` "
        "precision/recall audit is scheduled for a later training stage. `no v1 counterpart` counts sequences "
        "whose departure has no earlier v1 series at all; the unmatched share uses only the "
        "overlap. A v2 sequence that matches several chains is a split; a chain matched by several "
        "v2 sequences is a merge. The v2 id hashes the full vehicle itinerary while the v1 series "
        "key includes arrival and transfers, so part of the split/merge rate is itinerary "
        "granularity; the parallel/sequential and same/different itinerary columns show how "
        "much.\n\n" + chain_v2_table
        if chain_v2
        else "No v2 rows are present in the source; the v2 handover audit is omitted."
    )
    scrape_gap_table = _table(
        ["era", "TTD band", "scrapes", "median gap (h)", "without 24 h successor"],
        scrape_gap_rows,
    )
    duplicate_table = _table(
        [
            "pre-resampling rows",
            "duplicate groups",
            "rows in duplicate groups",
            "extra duplicate rows",
            "extra duplicate share",
            "cross-sections >=3",
            "cross-sections >=3 after dedup",
            "dependent cross-sections",
        ],
        duplicate_rows,
    )
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
    a18_table = _table(
        ["split", "bin", "rows", "bins", "collision bins", "rows in collisions", "collision row share"],
        a18_rows,
    )
    a19_table = _table(
        ["split", "rows", "rows 23-30 d", "23-30 d with <7 d history", "share", "history beyond 720 h", "share"],
        a19_rows,
    )
    a24_table = _table(
        [
            "split",
            "TTD band",
            "era",
            "R24 rows",
            "missing at check",
            "miss one",
            "miss all",
            "miss-one share",
            "miss-all share",
        ],
        a24_rows,
    )
    censored_band_table = _table(
        [
            "split",
            "TTD band",
            "labelled rows",
            "not listed",
            "observed within-24 h",
            "censored within-day",
            "labelled within-day",
        ],
        censored_band_rows,
    )
    a26_table = _table(
        ["split", "TTD band", "era", "rows", "scrape 10-16 h ahead", "share"],
        a26_rows,
    )
    tier_table = _table(["split", "TTD band", "tier", "rows", "labelled", "prevalence"], tier_rows)
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
            "Brier 95% CI",
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
            "rows",
            "alerts",
            "alert share",
            "saving vs wait €",
            "lift vs random €",
            "saving vs wait %",
            "saving vs book €",
            "saving vs book %",
            "conditional € / alert",
            "cost of waiting €",
            "95% CI vs wait",
            "95% CI vs book",
        ],
        decision_rows,
    )
    pooled_decision_rows = [
        [
            item["band"],
            item["rows"],
            item["alert_rows"],
            _p(item["alert_share"]),
            _fmt(item["saving_vs_always_wait_eur"], 2),
            _fmt(item["lift_vs_random_eur"], 2),
            _fmt(item["saving_vs_always_book_eur"], 2),
            _ci(item["ci_saving_vs_wait_eur"], 3),
            _ci(item["ci_saving_vs_book_eur"], 3),
        ]
        for item in evaluation.decision_value_pooled
    ]
    pooled_decision_table = _table(
        [
            "TTD band",
            "rows",
            "alerts",
            "alert share",
            "saving vs wait €",
            "lift vs random €",
            "saving vs book €",
            "95% CI vs wait",
            "95% CI vs book",
        ],
        pooled_decision_rows,
    )
    book_cis = [
        item["ci_saving_vs_book_eur"] for item in evaluation.decision_value if item.get("ci_saving_vs_book_eur")
    ]
    book_worse = sum(1 for interval in book_cis if interval[1] < 0.0)
    book_better = sum(1 for interval in book_cis if interval[0] > 0.0)
    wait_better = sum(
        1
        for item in evaluation.decision_value
        if item.get("ci_saving_vs_wait_eur") and item["ci_saving_vs_wait_eur"][0] > 0.0
    )
    percell_lifts = [item["lift_vs_random_eur"] for item in evaluation.decision_value]
    lift_positive = sum(1 for value in percell_lifts if value > 0.0)
    decision_summary = (
        f"Under per-headroom diagnostic calibration, the alert policy is significantly more expensive "
        f"than always booking now in {book_worse} of {len(book_cis)} band x headroom cells and "
        f"significantly cheaper in {book_better}; against always waiting it is significantly cheaper "
        f"in {wait_better} cells. The lift over a random alert policy at the same alert share is "
        f"positive in {lift_positive} of {len(percell_lifts)} cells."
    )
    pooled_book = [item["ci_saving_vs_book_eur"] for item in evaluation.decision_value_pooled]
    pooled_wait = [item["ci_saving_vs_wait_eur"] for item in evaluation.decision_value_pooled]
    pooled_book_worse = sum(1 for interval in pooled_book if interval and interval[1] < 0.0)
    pooled_book_better = sum(1 for interval in pooled_book if interval and interval[0] > 0.0)
    pooled_wait_better = sum(1 for interval in pooled_wait if interval and interval[0] > 0.0)
    pooled_lifts = [item["lift_vs_random_eur"] for item in evaluation.decision_value_pooled]
    pooled_lift_positive = sum(1 for value in pooled_lifts if value > 0.0)
    pooled_decision_summary = (
        f"With the shipped pooled calibrator, the policy is significantly more expensive than always "
        f"booking now in {pooled_book_worse} of {len(pooled_book)} bands and significantly cheaper in "
        f"{pooled_book_better}; against always waiting it is significantly cheaper in "
        f"{pooled_wait_better} bands. The lift over a random alert policy at the same alert share is "
        f"positive in {pooled_lift_positive} of {len(pooled_lifts)} bands."
    )
    journey_total = int(journey.get("total_journeys", 0))
    journey_at_risk = int(journey.get("at_risk", 0))
    journey_disappeared = int(journey.get("disappeared", 0))
    journey_share = _p(journey.get("share"))
    journey_share_at_risk = _p(journey.get("share_at_risk"))
    journey_end_observation = int(journey.get("end_of_observation_at_risk", 0))
    journey_share_end_observation = _p(journey.get("share_end_of_observation"))
    journey_none = sum(item["journeys"] for item in journey.get("groups", []) if item["successor"] == "none")
    journey_none_60 = sum(item["journeys"] for item in journey.get("groups", []) if item["successor_60"] == "none")
    warning_items = _warnings(stats, evaluation)
    warnings = "\n".join(f"- {warning}" for warning in warning_items) or "- none"
    dataset_scope = (
        "includes it because `--evaluate-test` was used"
        if evaluation.evaluation_on_test
        else "omits it in this validation-only run"
    )
    sample = config["sample"]
    resample = config["resample"]
    sample_line = (
        f"- Sample: {float(sample['sample_rate']):.1%} of route-days (seed {sample['seed']}); resampled "
        f"at {resample['inner_bin_hours']} h inside {resample['outer_threshold_hours']} h and "
        f"{resample['outer_bin_hours']} h outside. Counts are sample counts; bootstrap CIs are "
        "conditional on the sampled route-days."
    )
    split_caveat = (
        "The test split is a future-departure cohort, not a future-era holdout. "
        "The report shows era composition for the evaluated splits; test rows are omitted unless "
        "`--evaluate-test`."
    )
    split = config["splits"]
    split_line = (
        f"- Splits: train <= {split['train_end']}; "
        f"validation-select {split['validation_select_start']}..{split['validation_select_end']}; "
        f"validation-calibrate {split['validation_calibrate_start']}..{split['validation_calibrate_end']}; "
        f"test {split['test_start']}..{split['test_end']}"
    )
    calibration_label = evaluation.calibration_method + (
        " (constant; single-class calibration labels)" if evaluation.calibration_constant else ""
    )
    model_line = (
        f"- Model: `{evaluation.chosen_model}`; calibration: `{calibration_label}`; "
        f"threshold: {evaluation.threshold:.4f}; precision floor met on validation-calibrate: "
        f"{'yes' if evaluation.threshold_precision_floor_met else 'no (F1 fallback)'}"
    )
    ttd_line = (
        f"- TTD domain: {config['label']['min_hours_to_departure']}-{config['label']['max_hours_to_departure']} hours"
    )
    label_line = (
        f"- Label: `{config['label']['estimand']}`; the chain fare at the route-day check closest to "
        f"t+{config['label']['horizon_hours']} h in {config['label']['check_window_hours'][0]}-"
        f"{config['label']['check_window_hours'][1]} h, compared in integer cents. Censored rows are not scored."
    )
    population_line = (
        f"- Evaluation population: `{evaluation.evaluation_tier}` "
        f"({evaluation.evaluation_tier_rows:,} rows); calibration rows: {evaluation.calibration_rows:,}"
    )
    brier_ci = evaluation.bootstrap.get("brier", [])
    logloss_ci = evaluation.bootstrap.get("log_loss", [])
    brier_line = f"- Brier: **{_fmt(evaluation.metrics.get('brier'))}** " + (
        f"(grouped bootstrap 95% CI {_fmt(brier_ci[0])}-{_fmt(brier_ci[1])})"
        if len(brier_ci) == 2
        else "(no 95% CI; fewer than two departure-date clusters)"
    )
    logloss_line = f"- Log loss: **{_fmt(evaluation.metrics.get('log_loss'))}** " + (
        f"(95% CI {_fmt(logloss_ci[0])}-{_fmt(logloss_ci[1])})"
        if len(logloss_ci) == 2
        else "(no 95% CI; fewer than two departure-date clusters)"
    )
    bss_line = (
        f"- Brier skill score vs the slice base rate: {_fmt(evaluation.metrics.get('bss'))}\n"
        f"- Brier skill score vs the **train** base rate: {_fmt(evaluation.metrics.get('bss_train'))}\n"
        f"- Brier skill score vs climatology: {_fmt(evaluation.metrics.get('bss_climatology'))}\n"
        f"- Train prevalence (all train rows): {_fmt(evaluation.train_prevalence)}"
    )
    metrics_all_line = (
        "- One population: training, calibration, threshold and evaluation use every eligible row "
        "with a known next-day check fare; the evidence tier is a diagnostic table only."
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
    eval_label = "Test" if evaluation.evaluation_on_test else "Validation-calibrate"
    threshold_caveat = (
        "- Validation precision and recall use the same validation-calibrate rows that selected the "
        "threshold; they are optimistic.\n"
        if not evaluation.evaluation_on_test
        else ""
    )
    known_limitations = (
        "## Known limitations\n\n"
        "- The label is the chain's fare at one route-day check 20-28 h after the snapshot. "
        "Eligibility depends on the route-day scrape grid, not on the journey's own fare; `no_check` "
        "rows are unrelated to the fare. `not_listed` censoring is not neutral: in the long-horizon "
        "bands (14-30 d and 7-14 d) the within-24 h breach rate before vanishing is higher than the "
        "labelled rate (see the censoring table), so the next-day prevalence is probably understated "
        "by about 0.1-0.3 points. At 1-5 d the censored rate is lower (train 3-5 d 13.0 % vs "
        "29.5 %), so prevalence there may be slightly overstated.\n"
        "- The 7-30 d next-day coverage remains sparse on the current v1 schedule; the paired "
        "next-day scraper is a separate plan and is not part of this run.\n"
        "- Test snapshots overlap validation-calibrate weeks unless the run used a later forward "
        "set; the September departure cohort has been evaluated before this run.\n"
        "- These are development figures, not a production estimate. The product's hourly refresher "
        "and 7-30 d booking window are not fully represented.\n"
        "- Pooled metrics include headroom identification; per-headroom rows are the diagnostic view.\n"
        f"{threshold_caveat}"
        "- One eligible population is used for training, selection, calibration, threshold and "
        "evaluation; the future evidence tier is a diagnostic stratum only.\n"
        "- Test-split label and model diagnostics are gated by `--evaluate-test`. Journey "
        "disappearance, chains, duplicates and scrape cadence are dataset-wide; the scrape-cadence "
        "table includes test departures and runs through the last v1 departure. The v2 handover "
        "cohort is after the test window.\n"
        "- Dataset counts use the configured route-day sample; the chain, duplicate and "
        "scrape-cadence sections state their own pre-resampling or full-corpus scope. Bootstrap "
        "intervals resample departure dates within the sample.\n"
        "- The before/after comparison against the earlier within-24 h label is unpaired: the next-day "
        "point label is a different estimand from the within-24 h maximum, so the lower Brier is not "
        "a model improvement.\n"
        "- Per-headroom metrics use a per-headroom out-of-fold recalibration; the shipped model "
        "uses the pooled calibrator, so earlier per-headroom numbers are not like-for-like. "
        "The near-zero gap and slope near 1 follow from cross-fitting by route-day on the same "
        "evaluation rows.\n"
        "- No model serving contract, no real user limits, and no season outside the current corpus."
    )
    return f"""# Baseline training report

> Generated by the local training builder. This is an offline evaluation, not a deployed model.

## Run

- Runner: `{runner}`
- Rows: **{stats.rows:,}** total, **{stats.labelled_rows:,}** labelled
- Header totals include the test split; the Dataset table {dataset_scope}.
- Series: **{stats.series:,}**; chains: **{total_chains:,}**; route-days: **{stats.route_days:,}**
- Calendar feature set: `{spec.calendar_set}`
{model_line}
{split_line}
{sample_line}
{ttd_line}
{label_line}
{population_line}
{provenance_lines}
- {split_caveat}

## Dataset

{
        _table(
            ["split", "rows", "series", "chains", "route-days", "eligible", "labelled", "positives", "positive rate"],
            split_rows,
        )
    }

### Eligibility and label coverage

{
        _table(
            ["split", "eligible share", "labelled share", "censored share", "R24 share", "within-24 h rate (R24)"],
            coverage_rows,
        )
    }

A row is **eligible** when its route-day scrape grid has a check between 20 h and 28 h after the
snapshot, before departure. The label is the chain's fare at the check closest to `t + 24 h`; a
missing chain at that scrape censors the row (`not_listed`) rather than becoming a negative. The
R24 columns are defined only for 24 h-7 d and use the separate within-24 h maximum diagnostic.

The 24-48 h end of the domain has lower eligibility because the next-day check must still be before
departure:

{early_window_table}

### Observation-era composition

{_table(["split", "era", "rows"], era_rows)}

### Cohort and eligibility

{cohort_table}

### Next-day label diagnostics

{label_table}

`eligible` counts rows with a check scrape; `labelled` counts eligible rows whose chain has a fare
at that scrape; `censored` is `eligible - labelled`. `median/p10/p90 check lag` is the offset from
`t + 24 h`. `within-24 h (R24)` is the separate within-day maximum diagnostic on R24-covered
24 h-7 d rows. `next-day 20-24` and `next-day 22-26` are separate window diagnostics; the 20-24 h point is the
active crossed-back and decision-value check.
`crossed back` is the share of R24-covered rows whose within-day maximum breached but the 20-24 h
point did not. `dearer`/`cheaper`/`unchanged` use a +/-0.5 % band around the current fare and cover
only rows with a backward 23-36 h reference. When several rows share the check scrape, same-key
collisions take the highest fare; distinct-series collisions prefer the later-starting series, then
price, load factor and deterministic keys. About 0.07 % of labelled rows are affected.

By observation era:

{label_era_table}

By observation week:

{label_week_table}

A week with a 0 % eligible share is a scrape outage (for example 2026-W29); its rows are
`no_check`, not negatives.

### Resampling collisions

First-in-bin selection keeps the earliest observation in each chain x bin. The collision table
still counts how many bins hold more than one observation, so the rule change is separable from
the duplicate-key audit. Counts are pre-resampling and include all TTD bands, so they are larger
than the Dataset table.

{a18_table}

### History depth

`rows 23-30 d` are training-domain rows in the last week before departure; the share with less
than 7 d of chain history is the short-history diagnostic. `history beyond 720 h` counts rows
whose chain history starts more than 30 d before the snapshot; those observations are allowed by
the history rule and are outside the model domain.

{a19_table}

### Missing at the check

On R24-covered 24 h-7 d rows, `miss one` means the chain is absent at the check but observed at
another scrape in the following 24 h; `miss all` means it is absent from every scrape in that
window. The shares use all R24-covered rows in the band and era.

{a24_table}

### Censoring diagnostic

`not_listed` is not neutral: before a chain vanishes at the check, its within-24 h breach rate can
be higher than the labelled rate. The table shows both rates by band; weekly detail is in
`profile.json` under `censored_outcome`.

{censored_band_table}

### Scrape 10-16 h ahead

The share of snapshots with a route-day scrape 10-16 h later, by band and era. It is the
operational check on the next-day label's near-term coverage.

{a26_table}

### Within-24 h diagnostic (fixed 5 %)

`next-day` uses the 20-28 h check; `crossed back` uses the 20-24 h point so it stays inside the
within-24 h maximum.

{a29_table}

Prevalence by future evidence tier (diagnostic only; the tier is no longer a population):

{tier_table}

### Journey disappearance (series-level, pre-chain diagnostic)

This section uses the pre-chain `series_key`, the whole sampled panel (all TTD bands, before
resampling) and a three-observation threshold. It is a series-level diagnostic; the chain table
below is the identity used by the label and the model.

- Series with at least 3 observations: **{journey_total:,}**
- At risk (last observation more than 24 h before departure): **{journey_at_risk:,}**
- Observed to disappear at the next route-day scrape: **{journey_disappeared:,}** of all series
  ({journey_share}); {journey_share_at_risk} of at-risk. The remaining {journey_end_observation:,}
  at-risk series ({journey_share_end_observation}) had no later scrape before departure and are at
  the end of observation, so they are not evidence of disappearance.
- Successor `none`: **{journey_none:,}** under the 15-minute rule and **{journey_none_60:,}** under
  the 60-minute rule (no new series started at the next route-day scrape within that window)
- `same train` requires a new series (`first_obs`) at the next scrape with the same class and train
  number and a planned departure within 15 minutes; the 60-minute rule is the wider comparison and
  counts departures shifted by 15-60 minutes that the 15-minute rule classifies as `other train`
- This section is corpus-level and includes test-split departures; it is not gated by
  `--evaluate-test`.

{journey_table}

By observation week (60-minute rule):

{journey_week_table}

### Journey identity chains

A chain links a series that stops appearing to the next series with the same route, class and
first-train number, a planned departure within 15 minutes and its first observation at the next
route-day scrape. Links are one-to-one; the matcher maximises the number of links and prefers
the closest departure, but a crossing pattern may use a predecessor's second-closest candidate to
keep the matching maximum. `link rate` is links divided by series that have a next route-day scrape
before departure; `series link rate` divides by all series. The chain id is used for the label
window, the history features and the split assignment. `linked chains` counts components with at
least two series; `identities` also counts singleton series. `strict` builds drop every candidate
whose predecessor or successor has more than one candidate. `unused candidates` includes strict
drops and fully matched conflicts; `overlap candidates` are re-keys that appear in the same scrape
as the predecessor's last observation and are deliberately not chained.

Links are decided causally: a series that is absent at a route-day scrape and has a matching
successor there continues into that successor. If the old itinerary later returns, it becomes a
new incarnation of the same series key (`#r` suffix), so no link depends on observations after the
scrape that decides it. Split detection iterates to a fixed point, so a returning successor can
also close the predecessor's gap; a split is committed only when the matcher accepts the
continuation. This run has {chain.get("links", 0):,} links and
{chain.get("split_series", 0):,} base series split into later incarnations.

This table and the duplicate table use the pre-resampling `base_sampled` panel (all TTD bands) and
include test departures. They are not the 24 h-30 d model domain.

{chain_table}

{chain_size_table}

{chain_v2_section}

### Same-scrape key audit

{duplicate_table}

`rows in duplicate groups` includes the first row of each same-scrape `(series_key, observed_at)`
group; `extra duplicate rows` and `extra duplicate share` count only the redundant rows. The
denominator is the pre-resampling sampled panel. `dependent cross-sections` are route-day x class x
scrape cross-sections that reach the three-peer threshold before dedup and fall below it after.
`price_rank_route_day` counts every journey in the scrape before resampling. The 15-minute series
buckets are rounded, so the bucket centres are at `:00 / :15 / :30 / :45` and the edges at
`:07:30 / :22:30 / :37:30 / :52:30`.

### Route-day scrape cadence

{scrape_gap_table}

This is a pre-fix, full-corpus, v1-only baseline through the last v1 departure, not the route-day
sample and not the current schedule. The dense medians reproduce the old tier intervals; the
current schedule is NEAR 24 h, MID 8 d and FAR 16 d. With the full v1 grid the sparse 7-30 d row
is about 181 h with 78 % without a 24 h successor. The band is the time from the scrape to noon UTC
on the departure date.
`without 24 h successor` counts the last scrape of a route-day or a gap above 24 h; the median
excludes the null last-scrape gap.

### Unlabelled shares

{unlabelled_table}

Highest weekly unlabelled shares:

{weekly_table}

### Within-24 h coverage (R24)

R24 is defined only for 24 h-7 d. It requires the last scrape within
{config["report"]["r24_max_tail_hours"]} h of `t + 24 h` and no gap above
{config["report"]["r24_max_gap_hours"]} h. The 7-30 d coverage figure is no longer printed; this
table covers the 1-7 d bands only. `coverage known` counts rows with a scrape in the 24 h window;
`R24 covered` averages over all rows in the band, so rows with no scrape count as not covered.

{r24_table}

## Model comparison (cross-fitted validation-select)

{_table(["model", "Brier", "log loss", "ROC-AUC", "average precision", "positive rate"], candidate_rows)}

Candidate calibration method: `{evaluation.candidate_calibration_method}`; the final model uses
`{calibration_label}`.

### Train-split diagnostics (in-sample)

{_table(["model", "Brier", "log loss", "ROC-AUC", "average precision", "positive rate"], candidate_train_rows)}

### Climatology baseline

{clim_table}

## {eval_label} metrics

{brier_line}
{logloss_line}
{bss_line}
- ROC-AUC: {_fmt(evaluation.metrics.get("roc_auc"))}; average precision:
  {_fmt(evaluation.metrics.get("average_precision"))}
- Prevalence: {_fmt(evaluation.metrics.get("positive_rate"))}
- Precision at threshold: {_fmt(evaluation.metrics.get("precision_at_threshold"))}
- Recall at threshold: {_fmt(evaluation.metrics.get("recall_at_threshold"))}
- Headroom monotonic (shipped pooled calibrator): {evaluation.metrics.get("headroom_monotonic")}
- Headroom monotonic (raw scores): {evaluation.metrics.get("headroom_monotonic_raw")}
- Evaluation population: `{evaluation.evaluation_tier}` ({evaluation.evaluation_tier_rows:,} rows)
- Precision floor met on evaluation: {evaluation.metrics.get("precision_floor_met_on_evaluation")}
{metrics_all_line}

### Bootstrap intervals and paired Brier differences

{_table(["cluster count"], [[evaluation.bootstrap_clusters]])}

{interval_table}

{paired_table}

Negative Brier differences mean the model is better than the baseline.

## Per-headroom evaluation metrics

Per-headroom rows use a separate out-of-fold calibration fitted on that headroom's labels; the
shipped model uses the pooled calibrator. These are diagnostic and are not directly comparable with
the pooled-calibrator table. The near-zero calibration gap and slope near 1 follow from
cross-fitting by route-day on the same evaluation rows: same-date shocks appear in both the fit and
predict folds. The diagnostic probabilities rise with headroom on
{_p(evaluation.metrics.get("headroom_diagnostic_nonmonotone_share"))} of rows; the shipped pooled
calibrator is monotone: {evaluation.metrics.get("headroom_monotonic")}.

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

### Decision value (per-headroom diagnostic calibration, 20-24 h check)

{decision_table}

Positive saving means the alert policy costs less than the baseline; negative means it costs
more. `%` columns divide summed euros by summed fares; the conditional saving is the mean euro
saving over alerted rows and is not a ratio. `cost of waiting` is the unconditional cost of always
waiting one day. `lift vs random` subtracts the expected saving of a random alert policy with the
same alert share (`alert share x cost of waiting`) from the model's saving versus waiting. This table
uses per-headroom out-of-fold calibration and is diagnostic; the shipped model uses the pooled
calibrator. It uses the 20-24 h check, inside the 24 h maximum.

{decision_summary}

Shipped pooled policy (one row per TTD band):

{pooled_decision_table}

{pooled_decision_summary}

## Calibration

{_table(["predicted", "observed", "count"], cal_rows)}

The intercept is the joint Cox intercept from the slope/intercept fit, not calibration-in-the-large;
ECE uses equal-mass bins.

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
    build_config: dict[str, Any] | None = None,
    runtime: dict[str, Any] | None = None,
) -> None:
    """Write the static evaluation report and return its summary."""
    out_dir.mkdir(parents=True, exist_ok=True)
    dataset_manifest = json.loads((out_dir / "dataset_manifest.json").read_text(encoding="utf-8"))
    digests = ", ".join(
        f"{item['split']}:{item.get('sum64')}:{item.get('xor64')}" for item in dataset_manifest.get("dataset_files", [])
    )
    evaluation_hash = hashlib.sha256(json.dumps(config, sort_keys=True, default=str).encode()).hexdigest()
    git_sha = dataset_manifest.get("git_sha") or "unknown"
    chain_mode = "strict" if dataset_manifest.get("chains", {}).get("strict") else "default"
    provenance_lines = (
        f"- Git: `{git_sha}` (dirty: "
        f"{'unknown' if dataset_manifest.get('git_dirty') is None else dataset_manifest.get('git_dirty')})\n"
        f"- Silver build: `{dataset_manifest.get('silver_build_id')}`\n"
        f"- Build config hash: `{dataset_manifest.get('config_sha256')}`\n"
        f"- Evaluation config hash: `{evaluation_hash}`\n"
        f"- Chain mode: `{chain_mode}`\n"
        f"- Dataset digests: `{digests}`"
    )
    (out_dir / "report.md").write_text(
        _report(stats, evaluation, spec, config, runner, provenance_lines),
        encoding="utf-8",
    )
    payload = {
        "run_id": stats.run_id,
        "runner": runner,
        "config": config,
        "dataset": _gated_dataset_payload(stats, evaluation.evaluation_on_test),
        "feature_spec": {"calendar_set": spec.calendar_set, "features": list(spec.names)},
        "evaluation": evaluation.to_dict(),
        "evaluation_on_test": evaluation.evaluation_on_test,
        "evaluation_split": evaluation.evaluation_split,
    }
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
    manifest["evaluation_on_test"] = evaluation.evaluation_on_test
    manifest["evaluation_split"] = evaluation.evaluation_split
    manifest["runtime"] = runtime or {}
    manifest["model"] = {
        "chosen": evaluation.chosen_model,
        "calibration": evaluation.calibration_method,
        "threshold": evaluation.threshold,
        "candidates": evaluation.candidates,
        "metrics": evaluation.metrics,
        "bootstrap": evaluation.bootstrap,
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
        "column_roles.json",
        "profile.json",
        "report.md",
        "metrics.json",
        "calibration.csv",
        f"predictions/{evaluation.prediction_split}.parquet",
        "model.joblib",
    ]
    missing_artifacts = [relative for relative in manifest["artifacts"] if not (out_dir / relative).is_file()]
    if missing_artifacts:
        raise RuntimeError(f"report artifacts are missing: {missing_artifacts}")
    manifest["artifact_sha256"] = {
        relative: hashlib.sha256((out_dir / relative).read_bytes()).hexdigest() for relative in manifest["artifacts"]
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8"
    )
