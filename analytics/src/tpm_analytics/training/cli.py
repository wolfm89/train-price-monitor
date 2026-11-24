"""Command-line entry point for the baseline training builder."""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import resource
import shutil
import sys
import tempfile
import time
from dataclasses import asdict, replace
from pathlib import Path
from typing import Any

import duckdb
import pyarrow

from tpm_analytics import calendar
from tpm_analytics.silver._duck import connect, read_parquet
from tpm_analytics.training import backtest as backtest_protocol
from tpm_analytics.training import model as training_model
from tpm_analytics.training.config import DEFAULT_CONFIG_PATH, TrainingConfig, load_config
from tpm_analytics.training.dataset import DatasetStats, SplitStats, _git_state, build_dataset
from tpm_analytics.training.features import CALENDAR_SETS, FeatureSpec, feature_spec, study_feature_spec
from tpm_analytics.training.report import write_report
from tpm_analytics.training.sources import resolve_source
from tpm_analytics.training.study import (
    coverage_profile,
    forward_analog_availability,
    run_feature_study,
    study_arms,
    write_feature_study,
)


def _parser() -> argparse.ArgumentParser:
    """Build the training command-line parser."""
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
    parser.add_argument(
        "--forward",
        action="store_true",
        help="build the unscored forward Parquet only; no labels or check fares",
    )
    parser.add_argument(
        "--strict-chains",
        action="store_true",
        help="drop ambiguous journey-chain links; use for the identity sensitivity run",
    )
    parser.add_argument(
        "--feature-study",
        action="store_true",
        help="run the reproducible feature-family study on the development folds only",
    )
    parser.add_argument(
        "--forward-availability",
        type=Path,
        default=None,
        help="forward Parquet used to measure actual analog availability for the stress test",
    )
    parser.add_argument(
        "--evaluate-test",
        action="store_true",
        help="score test-split metrics; in backtest mode score the evaluation and sparse-era folds",
    )
    parser.add_argument(
        "--score-forward",
        type=Path,
        default=None,
        help="score an unscored forward Parquet with the forward fold; no labels or metrics",
    )
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=None,
        help="resume backtest folds from per-fold checkpoints in this directory",
    )
    parser.add_argument(
        "--dataset-cache-dir",
        type=Path,
        default=None,
        help="reuse a matching dataset build from this directory when the code is clean",
    )
    parser.add_argument(
        "--no-dataset-cache",
        action="store_true",
        help="always build a fresh dataset, even when a matching cached build exists",
    )
    parser.add_argument("--log-level", default="INFO")
    return parser


def _dataset_code_hash() -> str:
    """Dataset code hash."""
    root = Path(__file__).resolve().parents[1]
    excluded = {"backtest.py", "cli.py", "model.py", "report.py", "selection.py", "study.py", "__init__.py"}
    files = sorted(
        path for path in (root / "training").glob("*.py") if path.name not in excluded and path.name != "protocol.py"
    )
    files.extend((root / "calendar.py", root / "silver" / "_duck.py"))
    files.append(root / "data" / "calendar.json")
    lock = root.parent.parent / "uv.lock"
    if lock.is_file():
        files.append(lock)
    digest = hashlib.sha256()
    for path in files:
        digest.update(path.relative_to(root.parent.parent).as_posix().encode("utf-8"))
        digest.update(path.read_bytes())
    return digest.hexdigest()


def _dataset_config_payload(config: TrainingConfig) -> dict[str, Any]:
    """Dataset config payload."""
    return {
        "seed": config.seed,
        "splits": asdict(config.splits),
        "label": asdict(config.label),
        "resample": asdict(config.resample),
        "sample": asdict(config.sample),
        "calendar": asdict(config.calendar),
        "features": asdict(config.features),
        "r24_max_tail_hours": config.report.r24_max_tail_hours,
        "r24_max_gap_hours": config.report.r24_max_gap_hours,
        "min_eligible_rows": config.report.min_eligible_rows,
        "min_split_positives": config.report.min_split_positives,
        "min_headroom_positives": config.report.min_headroom_positives,
        "min_band_positives": config.report.min_band_positives,
        "min_sparse_band_positives": config.report.min_sparse_band_positives,
        "forward_start": config.protocol.forward_start.isoformat(),
        "forward_end": config.protocol.forward_end.isoformat(),
        "forward_min_hours_to_departure": config.protocol.forward_min_hours_to_departure,
        "forward_max_hours_to_departure": config.protocol.forward_max_hours_to_departure,
    }


def _dataset_cache_key(
    config: TrainingConfig,
    source_uri: str,
    code_sha: str,
    strict_chains: bool,
    source: Any,
    *,
    study: bool = False,
) -> str:
    """Dataset cache key."""
    payload = {
        "version": 2,
        "dataset_code_sha": code_sha,
        "dataset_config_sha256": hashlib.sha256(
            json.dumps(_dataset_config_payload(config), sort_keys=True, default=str).encode("utf-8")
        ).hexdigest(),
        "source": source_uri,
        "strict_chains": strict_chains,
        "study": study,
        "source_build_id": getattr(source, "build_id", None),
        "source_manifest_sha256": getattr(source, "manifest_sha256", None),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()


def _restore_dataset(
    cache_root: Path,
    key: str,
    work_dir: Path,
    *,
    run_id: str,
    cli_argv: tuple[str, ...],
    strict_chains: bool,
    source: Any,
) -> DatasetStats | None:
    """Restore a verified cached dataset into the work directory."""
    entry = cache_root / key
    manifest_path = entry / "dataset_manifest.json"
    profile_path = entry / "profile.json"
    if not manifest_path.is_file() or not profile_path.is_file() or not (entry / "DONE").is_file():
        return None
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("manifest_version") != 3:
            return None
        if not manifest.get("dataset_files"):
            return None
        if manifest.get("dataset_cache_key") != key:
            return None
        if manifest.get("calendar_version") != calendar.dataset_version():
            return None
        if manifest.get("strict_chains") != strict_chains:
            return None
        if manifest.get("silver_build_id") != getattr(source, "build_id", None):
            return None
        if manifest.get("silver_manifest_sha256") != getattr(source, "manifest_sha256", None):
            return None
        for item in manifest.get("dataset_files", []):
            path = entry / item["path"]
            if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != item["sha256"]:
                return None
        roles = entry / "column_roles.json"
        if not roles.is_file() or hashlib.sha256(roles.read_bytes()).hexdigest() != manifest.get("column_roles_sha256"):
            return None
        profile = entry / "profile.json"
        if (
            not profile.is_file()
            or not manifest.get("profile_sha256")
            or hashlib.sha256(profile.read_bytes()).hexdigest() != manifest["profile_sha256"]
        ):
            return None
    except OSError, ValueError, TypeError, KeyError, AttributeError:
        return None
    try:
        payload = json.loads(profile_path.read_text(encoding="utf-8"))
        splits = tuple(SplitStats(**item) for item in payload.pop("splits"))
        stats = DatasetStats(**payload, splits=splits)
    except OSError, ValueError, TypeError, KeyError, AttributeError:
        return None
    shutil.copytree(entry / "dataset", work_dir / "dataset", dirs_exist_ok=True)
    for name in ("dataset_manifest.json", "profile.json", "column_roles.json"):
        src = entry / name
        if src.is_file():
            shutil.copy2(src, work_dir / name)
    manifest["original_run_id"] = manifest.get("run_id")
    manifest["run_id"] = run_id
    manifest["cli_argv"] = list(cli_argv)
    manifest["reused"] = True
    manifest["reuse_key"] = key
    manifest["dataset_cache_key"] = key
    (work_dir / "dataset_manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8"
    )
    return replace(stats, run_id=run_id)


def _mark_dataset_cache(work_dir: Path, key: str) -> None:
    """Mark dataset cache."""
    path = work_dir / "dataset_manifest.json"
    manifest = json.loads(path.read_text(encoding="utf-8"))
    manifest["dataset_cache_key"] = key
    path.write_text(json.dumps(manifest, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8")


def _store_dataset(cache_root: Path, key: str, work_dir: Path) -> None:
    """Copy a completed dataset build into the cache."""
    entry = cache_root / key
    if entry.exists() and (entry / "DONE").is_file():
        return
    if entry.exists():
        shutil.rmtree(entry)
    entry.mkdir(parents=True, exist_ok=True)
    shutil.copytree(work_dir / "dataset", entry / "dataset", dirs_exist_ok=True)
    for name in ("dataset_manifest.json", "profile.json", "column_roles.json"):
        source = work_dir / name
        if source.is_file():
            shutil.copy2(source, entry / name)
    (entry / "DONE").write_text("ok\n", encoding="utf-8")


def _run_id(config: TrainingConfig, explicit: str | None) -> str:
    """Return the configured or generated run id."""
    if explicit:
        return explicit
    return time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + config.hash()[:8]


def _load_splits(out_dir: Path, spec: FeatureSpec) -> dict[str, training_model.TabularData]:
    """Load and return splits."""
    return {
        name: training_model.load_split(out_dir / "dataset" / f"{name}.parquet", spec)
        for name in ("train", "validation_select", "validation_calibrate", "test")
    }


def _peak_rss_kb() -> int:
    """Return the process peak resident set size in KiB."""
    value = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    return value if sys.platform != "darwin" else value // 1024


def main(argv: list[str] | None = None) -> int:
    """Run the command-line entry point."""
    args = _parser().parse_args(argv)
    run_started = time.perf_counter()
    work_dir: Path | None = None
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
        if args.feature_study:
            if args.evaluate_test:
                raise ValueError("--feature-study is development-only; do not combine it with --evaluate-test")
            if config.protocol.kind != "backtest":
                raise ValueError("--feature-study requires the backtest config")
            if args.profile or args.forward or args.score_forward is not None or args.cache_dir is not None:
                raise ValueError(
                    "--feature-study cannot be combined with --profile, --forward, --score-forward or --cache-dir"
                )
            if args.calendar_features is not None:
                raise ValueError("--feature-study fixes the calendar arms; do not pass --calendar-features")
            if args.forward_availability is not None and not args.forward_availability.is_file():
                raise ValueError(f"forward availability file not found: {args.forward_availability}")
        if args.forward_availability is not None and not args.feature_study:
            raise ValueError("--forward-availability requires --feature-study")
        study_offsets = tuple(config.features.analog_departure_offsets_days)
        if args.feature_study:
            if args.forward_availability is None:
                raise ValueError(
                    "--feature-study needs --forward-availability: the keep decision uses the "
                    "measured forward-set analog availability, not the grid upper bound"
                )
            study_offsets = tuple(sorted(set(study_offsets)))
            study_arms(study_offsets)
        if (
            config.protocol.kind == "static_split"
            and config.features.analog_departures_enabled
            and not args.feature_study
        ):
            raise ValueError("features.analog_departures is study-only; the static path keeps its legacy spec")
        if args.score_forward is not None and config.protocol.kind != "backtest":
            raise ValueError("--score-forward requires a backtest config")
        if args.cache_dir is not None and config.protocol.kind != "backtest":
            raise ValueError("--cache-dir requires a backtest config")
        primary_set = config.calendar.feature_set
        build_set = "full" if args.feature_study else primary_set
        build_config = replace(config, calendar=replace(config.calendar, feature_set=build_set))
        if args.feature_study:
            build_config = replace(
                build_config,
                features=replace(config.features, analog_departures_enabled=True),
            )
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
        out_dir.parent.mkdir(parents=True, exist_ok=True)
        work_dir = Path(tempfile.mkdtemp(prefix=f".{out_dir.name}.", suffix=".tmp", dir=out_dir.parent))
        os.chmod(work_dir, 0o755)
        temp_dir = work_dir / ".duckdb-tmp"
        configured_extensions = os.environ.get("DUCKDB_EXTENSION_DIR")
        if configured_extensions is None and Path(".duckdb-extensions").is_dir():
            configured_extensions = str(Path(".duckdb-extensions").resolve())
        extensions = Path(configured_extensions) if configured_extensions else None
        threads = min(8, os.cpu_count() or 4)
        code_sha, code_dirty, _ = _git_state()
        dataset_key: str | None = None
        dataset_reused = False
        original_build_seconds: float | None = None
        stats: DatasetStats | None = None
        cache_root: Path | None = None
        if (
            not args.profile
            and not args.forward
            and not args.no_dataset_cache
            and code_sha is not None
            and code_dirty is False
            and getattr(source, "build_id", None) is not None
            and getattr(source, "manifest_sha256", None) is not None
        ):
            cache_root = args.dataset_cache_dir or (DEFAULT_CONFIG_PATH.parent.parent / "artifacts/.cache/datasets")
            dataset_key = _dataset_cache_key(
                build_config, source_uri, _dataset_code_hash(), args.strict_chains, source, study=args.feature_study
            )
            restore_started = time.perf_counter()
            stats = _restore_dataset(
                cache_root,
                dataset_key,
                work_dir,
                run_id=run_id,
                cli_argv=tuple(sys.argv),
                strict_chains=args.strict_chains,
                source=source,
            )
            dataset_reused = stats is not None
            if stats is not None:
                original_build_seconds = stats.duration_seconds
                stats = replace(stats, duration_seconds=round(time.perf_counter() - restore_started, 3))
        connection = connect(
            temp_directory=temp_dir,
            threads=threads,
            memory_limit=os.environ.get("TRAIN_DUCKDB_MEMORY_LIMIT", "6GB"),
            max_temp_size=os.environ.get("TRAIN_DUCKDB_MAX_TEMP_SIZE", "20GB"),
            extensions=extensions,
            secret=source.s3_secret,
        )
        study_context: dict[str, Any] | None = None
        try:
            if stats is None:
                stats = build_dataset(
                    connection,
                    source,
                    build_config,
                    work_dir,
                    run_id=run_id,
                    write_splits=not args.profile and not args.forward,
                    cli_argv=tuple(sys.argv),
                    threads=threads,
                    strict_chains=args.strict_chains,
                    forward=args.forward,
                    study=args.feature_study,
                )
                if cache_root is not None and dataset_key is not None and not args.profile and not args.forward:
                    try:
                        _mark_dataset_cache(work_dir, dataset_key)
                        _store_dataset(cache_root, dataset_key, work_dir)
                    except (OSError, ValueError, TypeError, KeyError) as error:
                        logging.getLogger(__name__).warning("dataset cache write skipped: %s", error)
        finally:
            connection.close()
            shutil.rmtree(temp_dir, ignore_errors=True)
        if args.feature_study:
            # A fresh connection drops the build's temp tables before the coverage scans.
            study_temp = work_dir / ".study-tmp"
            study_temp.mkdir(parents=True, exist_ok=True)
            context_connection = connect(
                temp_directory=study_temp,
                threads=threads,
                memory_limit=os.environ.get("TRAIN_DUCKDB_MEMORY_LIMIT", "6GB"),
                max_temp_size=os.environ.get("TRAIN_DUCKDB_MAX_TEMP_SIZE", "20GB"),
                extensions=extensions,
                secret=source.s3_secret,
            )
            try:
                source_sql = read_parquet(source.glob, union_by_name=False)
                coverage = coverage_profile(context_connection, source_sql)
                forward = (
                    forward_analog_availability(
                        context_connection,
                        args.forward_availability,
                        source_sql,
                        study_offsets,
                    )
                    if args.forward_availability is not None
                    else None
                )
                study_context = {"coverage": coverage, "forward": forward}
            finally:
                context_connection.close()
                shutil.rmtree(study_temp, ignore_errors=True)
        if args.profile or args.forward:
            os.replace(work_dir, out_dir)
            print(json.dumps(stats.to_dict(), indent=2, sort_keys=True, default=str))
            return 0
        if args.feature_study:
            if study_context is None:
                raise ValueError("the feature study context was not computed")
            study_spec = study_feature_spec(study_offsets)
            panel = backtest_protocol.load_panel(work_dir, study_spec)
            dataset_manifest = json.loads((work_dir / "dataset_manifest.json").read_text(encoding="utf-8"))
            dataset_digest = hashlib.sha256(
                json.dumps(dataset_manifest.get("dataset_files", []), sort_keys=True).encode("utf-8")
            ).hexdigest()
            forward = study_context["forward"]
            provenance = {
                "run_id": run_id,
                "git_sha": code_sha,
                "git_dirty": code_dirty,
                "git_untracked": dataset_manifest.get("git_untracked"),
                "dataset_git_sha": dataset_manifest.get("git_sha"),
                "dataset_git_dirty": dataset_manifest.get("git_dirty"),
                "silver_build_id": dataset_manifest.get("silver_build_id"),
                "silver_manifest_sha256": dataset_manifest.get("silver_manifest_sha256"),
                "config_sha256": dataset_manifest.get("config_sha256"),
                "dataset_manifest_sha256": dataset_digest,
                "dataset_cache_key": dataset_key,
                "dataset_reused": dataset_reused,
                "sample_rate": dataset_manifest.get("sample", {}).get("sample_rate"),
                "strict_chains": dataset_manifest.get("strict_chains"),
                "forward_path": forward.get("forward_path") if forward else None,
                "forward_sha256": forward.get("forward_sha256") if forward else None,
            }
            result = run_feature_study(
                panel,
                config,
                coverage=study_context["coverage"],
                forward=forward,
                run_id=run_id,
                provenance=provenance,
            )
            total_seconds = round(time.perf_counter() - run_started, 3)
            peak_rss_kb = _peak_rss_kb()
            summary = write_feature_study(work_dir, result)
            (work_dir / "study_runtime.json").write_text(
                json.dumps(
                    {
                        "wall_seconds": total_seconds,
                        "peak_rss_kb": peak_rss_kb,
                        "run_id": run_id,
                        "git_sha": code_sha,
                        "git_dirty": code_dirty,
                        "dataset_seconds": (
                            original_build_seconds
                            if dataset_reused and original_build_seconds is not None
                            else stats.duration_seconds
                        ),
                        "dataset_source": "cache" if dataset_reused else "build",
                    },
                    indent=2,
                    sort_keys=True,
                )
                + "\n",
                encoding="utf-8",
            )
            # Publish the artifacts before the console summary, so a summary bug cannot delete a
            # completed study.
            os.replace(work_dir, out_dir)
            summary.update(
                {
                    "out": str(out_dir),
                    "run_id": run_id,
                    "rows": stats.rows,
                    "labelled_rows": stats.labelled_rows,
                    "wall_seconds": total_seconds,
                    "peak_rss_kb": peak_rss_kb,
                    "dataset_reused": dataset_reused,
                    "dataset_cache_key": dataset_key,
                    "no_family_added": result["no_family_added"],
                    "folds": result["folds"],
                }
            )
            print(json.dumps(summary, indent=2, sort_keys=True, default=str))
            return 0
        analog_offsets = (
            config.features.analog_departure_offsets_days if config.features.analog_departures_enabled else ()
        )
        spec = feature_spec(primary_set, analog_offsets=analog_offsets)
        if config.protocol.kind == "backtest":
            panel = backtest_protocol.load_panel(work_dir, spec)
            dataset_manifest = json.loads((work_dir / "dataset_manifest.json").read_text(encoding="utf-8"))
            dataset_sha256 = hashlib.sha256(
                json.dumps(dataset_manifest.get("dataset_files", []), sort_keys=True).encode("utf-8")
            ).hexdigest()
            result = backtest_protocol.run_backtest(
                panel,
                config,
                spec,
                evaluate_test=args.evaluate_test,
                cache_dir=args.cache_dir,
                dataset_sha256=dataset_sha256,
            )
            if args.score_forward is not None:
                backtest_protocol.score_forward_artifact(
                    work_dir,
                    panel,
                    config,
                    result.recipe,
                    spec,
                    args.score_forward,
                )
            total_seconds = round(time.perf_counter() - run_started, 3)
            runtime = {
                "wall_seconds": total_seconds,
                "dataset_seconds": stats.duration_seconds,
                "dataset_source": "cache" if dataset_reused else "build",
                "original_build_seconds": original_build_seconds,
                "fit_seconds": round(max(0.0, total_seconds - stats.duration_seconds), 3),
                "peak_rss_kb": _peak_rss_kb(),
            }
            result.runtime_seconds = total_seconds
            result.peak_rss_kb = int(runtime["peak_rss_kb"])
            summary = backtest_protocol.write_backtest_artifacts(
                work_dir,
                result,
                config,
                spec,
                runtime=runtime,
            )
            os.replace(work_dir, out_dir)
            summary.update(
                {
                    "out": str(out_dir),
                    "run_id": run_id,
                    "labelled_rows": stats.labelled_rows,
                    "dataset_rows": stats.rows,
                    "dataset_reused": dataset_reused,
                    "dataset_cache_key": dataset_key,
                }
            )
            print(json.dumps(summary, indent=2, sort_keys=True, default=str))
            return 0
        full_splits = _load_splits(work_dir, feature_spec(build_set))
        splits = {name: data.select(spec.names) for name, data in full_splits.items()}
        evaluation, fitted, calibrator = training_model.train_and_evaluate(
            splits,
            spec,
            config,
            evaluate_test=args.evaluate_test,
        )
        training_model.write_evaluation_artifacts(work_dir, evaluation, fitted, calibrator, spec, config)
        runtime = {
            "wall_seconds": round(time.perf_counter() - run_started, 3),
            "peak_rss_kb": _peak_rss_kb(),
        }
        write_report(
            work_dir,
            stats,
            evaluation,
            spec,
            config.to_dict(),
            runner="local",
            build_config=build_config.to_dict(),
            runtime=runtime,
        )
        os.replace(work_dir, out_dir)
        summary = {
            "run_id": run_id,
            "out": str(out_dir),
            "rows": stats.rows,
            "labelled_rows": stats.labelled_rows,
            "chosen_model": evaluation.chosen_model,
            "calibration": evaluation.calibration_method,
            "evaluation_split": evaluation.evaluation_split,
            "evaluation_on_test": evaluation.evaluation_on_test,
            "predictions": f"predictions/{evaluation.prediction_split}.parquet",
            "model_file": "model.joblib",
            "brier": evaluation.metrics["brier"],
            "log_loss": evaluation.metrics["log_loss"],
            **runtime,
        }
        print(json.dumps(summary, indent=2, sort_keys=True, default=str))
        return 0
    except (OSError, RuntimeError, ValueError, duckdb.Error, pyarrow.ArrowException) as error:
        if work_dir is not None:
            shutil.rmtree(work_dir, ignore_errors=True)
        print(f"error: {error}", file=sys.stderr)
        return 2
    except BaseException:
        if work_dir is not None:
            shutil.rmtree(work_dir, ignore_errors=True)
        raise


if __name__ == "__main__":
    raise SystemExit(main())
