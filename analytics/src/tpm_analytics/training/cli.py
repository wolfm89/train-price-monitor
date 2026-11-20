"""Command-line entry point for the baseline training builder."""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import sys
import time
from dataclasses import replace
from pathlib import Path
from typing import Any

import duckdb

from tpm_analytics.silver._duck import connect
from tpm_analytics.training import model as training_model
from tpm_analytics.training.config import DEFAULT_CONFIG_PATH, TrainingConfig, load_config
from tpm_analytics.training.dataset import build_dataset
from tpm_analytics.training.features import CALENDAR_SETS, FeatureSpec, feature_spec
from tpm_analytics.training.report import write_report
from tpm_analytics.training.sources import resolve_source


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m tpm_analytics.training.cli",
        description="Build the baseline training set, train the candidates and write a report.",
    )
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH, help="training JSON")
    parser.add_argument("--source", default=None, help="S3 pointer, Parquet glob or local directory")
    parser.add_argument("--out", type=Path, default=None, help="artifact directory (default: output_root/run_id)")
    parser.add_argument("--run-id", default=None, help="explicit run id; default: UTC timestamp + config hash")
    parser.add_argument("--calendar-features", choices=CALENDAR_SETS, default=None)
    parser.add_argument("--profile", action="store_true", help="build and profile without training")
    parser.add_argument("--ablation", action="store_true", help="compare the four calendar feature sets")
    parser.add_argument(
        "--evaluate-test",
        action="store_true",
        help="score the untouched test split once; default reports validation only",
    )
    parser.add_argument("--log-level", default="INFO")
    return parser


def _run_id(config: TrainingConfig, explicit: str | None) -> str:
    if explicit:
        return explicit
    return time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + config.hash()[:8]


def _load_splits(out_dir: Path, spec: FeatureSpec) -> dict[str, training_model.TabularData]:
    return {
        name: training_model.load_split(out_dir / "dataset" / f"{name}.parquet", spec)
        for name in ("train", "validation_select", "validation_calibrate", "test")
    }


def _ablation(
    full: dict[str, training_model.TabularData],
    config: TrainingConfig,
    primary_set: str,
    primary: training_model.Evaluation,
) -> dict[str, Any]:
    results: dict[str, Any] = {
        primary_set: {
            "chosen_model": primary.chosen_model,
            "calibration": primary.calibration_method,
            "validation_brier": primary.test.get("brier"),
            "validation_log_loss": primary.test.get("log_loss"),
            "validation_roc_auc": primary.test.get("roc_auc"),
        }
    }
    for calendar_set in CALENDAR_SETS:
        if calendar_set == primary_set:
            continue
        spec = feature_spec(calendar_set)
        splits = {name: data.select(spec.names) for name, data in full.items()}
        evaluation, _, _ = training_model.train_and_evaluate(splits, spec, config, evaluate_test=False)
        results[calendar_set] = {
            "chosen_model": evaluation.chosen_model,
            "calibration": evaluation.calibration_method,
            "validation_brier": evaluation.test.get("brier"),
            "validation_log_loss": evaluation.test.get("log_loss"),
            "validation_roc_auc": evaluation.test.get("roc_auc"),
        }
    return results


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    logging.basicConfig(level=getattr(logging, str(args.log_level).upper(), logging.INFO))
    try:
        config = load_config(args.config)
        if args.source is not None:
            config = replace(config, source=args.source)
        source_uri = config.source
        if source_uri is None:
            raise ValueError("no source: pass --source or set source in the config")
        if args.calendar_features is not None:
            config = replace(config, calendar=replace(config.calendar, feature_set=args.calendar_features))
        if args.ablation and args.evaluate_test:
            raise ValueError("--ablation is validation-only; do not combine it with --evaluate-test")
        primary_set = config.calendar.feature_set
        build_set = "full" if args.ablation else primary_set
        build_config = replace(config, calendar=replace(config.calendar, feature_set=build_set))
        source = resolve_source(source_uri)
        run_id = _run_id(config, args.run_id)
        if args.out is not None:
            out_dir = args.out
        else:
            config_root = DEFAULT_CONFIG_PATH.parent.parent
            out_dir = config_root / config.output_root / run_id
        out_dir = out_dir.resolve()
        if out_dir.exists() and any(out_dir.iterdir()):
            raise FileExistsError(f"{out_dir} is not empty; use a new --run-id or --out")
        out_dir.mkdir(parents=True, exist_ok=True)
        temp_dir = out_dir / ".duckdb-tmp"
        configured_extensions = os.environ.get("DUCKDB_EXTENSION_DIR")
        if configured_extensions is None and Path(".duckdb-extensions").is_dir():
            configured_extensions = str(Path(".duckdb-extensions").resolve())
        extensions = Path(configured_extensions) if configured_extensions else None
        threads = min(8, os.cpu_count() or 4)
        connection = connect(
            temp_directory=temp_dir,
            threads=threads,
            memory_limit=os.environ.get("TRAIN_DUCKDB_MEMORY_LIMIT", "6GB"),
            max_temp_size=os.environ.get("TRAIN_DUCKDB_MAX_TEMP_SIZE", "8GB"),
            extensions=extensions,
            secret=source.s3_secret,
        )
        try:
            stats = build_dataset(
                connection,
                source,
                build_config,
                out_dir,
                run_id=run_id,
                write_splits=not args.profile,
                cli_argv=tuple(sys.argv),
                threads=threads,
            )
        finally:
            connection.close()
            shutil.rmtree(temp_dir, ignore_errors=True)
        if args.profile:
            print(json.dumps(stats.to_dict(), indent=2, sort_keys=True, default=str))
            return 0
        spec = feature_spec(primary_set)
        full_splits = _load_splits(out_dir, feature_spec(build_set))
        splits = {name: data.select(spec.names) for name, data in full_splits.items()}
        evaluation, fitted, calibrator = training_model.train_and_evaluate(
            splits,
            spec,
            config,
            evaluate_test=args.evaluate_test and not args.ablation,
        )
        ablation = _ablation(full_splits, config, primary_set, evaluation) if args.ablation else None
        training_model.write_evaluation_artifacts(out_dir, evaluation, fitted, calibrator, spec, config)
        write_report(
            out_dir,
            stats,
            evaluation,
            spec,
            config.to_dict(),
            runner="local",
            ablation=ablation,
            build_config=build_config.to_dict(),
        )
        summary = {
            "run_id": run_id,
            "out": str(out_dir),
            "rows": stats.rows,
            "labelled_rows": stats.labelled_rows,
            "chosen_model": evaluation.chosen_model,
            "calibration": evaluation.calibration_method,
            "evaluation_split": evaluation.evaluation_split,
            "test_evaluated": evaluation.test_evaluated,
            "predictions": f"predictions/{evaluation.prediction_split}.parquet",
            "model_file": "model.joblib",
            "brier": evaluation.test["brier"],
            "log_loss": evaluation.test["log_loss"],
            "ablation": ablation,
        }
        print(json.dumps(summary, indent=2, sort_keys=True, default=str))
        return 0
    except (OSError, RuntimeError, ValueError, duckdb.Error) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
