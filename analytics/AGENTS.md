# Analytics — Agent Guide

Python 3.15 silver-layer builds over the scraper's bronze Parquet. DuckDB performs the transform; a
weekly Lambda publishes the result and a quality report. This is the only Python module. The root
[`AGENTS.md`](../AGENTS.md) still applies; this file adds the analytics-specific rules.

## Commands

```bash
uv sync --frozen     # create .venv from uv.lock; uv manages the interpreter
uv run pytest        # fixture tests over v1-only, v2-only and mixed bronze files
uv run ty check      # type check (Astral ty)
uv run ruff check .  # lint
uv run ruff format . # format
uv build             # wheel + sdist with assets
```

Training uses an optional group; the Lambda image must not install it:

```bash
uv sync --group train
uv run --group train pytest
uv run --group train ty check
mise run //analytics:train -- --source .data/silver/<build>
mise run //analytics:train:ablation -- --source .data/silver/<build>
```

The `train` group adds numpy, scikit-learn and scipy only. CI installs it for the analytics job and the
manual pre-commit `ty` hook; `uv export --no-dev` must keep it out of the Lambda image.

S3 credentials are frozen into a temporary DuckDB secret for the run. IAM Identity Center role
sessions default to one hour; for a long scan, download the silver build to `analytics/.data/` and
run locally instead of holding an S3 scan open.

From the repository root: `mise run //analytics:test`, `mise run //analytics:lint`,
`mise run //analytics:typecheck`, `mise run //analytics:build` and `mise run //analytics:format`.
Use `uv` and the committed `uv.lock`; never `pip install` ad hoc and never add a
`requirements.txt`.

## Silver contract

- `src/tpm_analytics/sql/silver.sql` is the one deterministic transform. Every run rebuilds from
  the bronze key list it captured, so the same list produces the same rows; row order and file split
  are not stable. Later poller appends are excluded, but a concurrent compactor delete of a listed
  batch is not; the 03:00 → 03:30 schedule normally leaves a 30-minute gap.
- Normalise v1/v2 semantics before adding features: `transfers_raw` keeps the bronze value while
  `transfers_actual` halves v1 counts; load factors use ordinals; v1 defaults are backfilled;
  duplicates use the compactor key.
- All calendar fields and `timetable_period` use `Europe/Berlin` local time. The timetable boundary
  is a hand-maintained constant in `src/tpm_analytics/silver/constants.py`
  (`TIMETABLE_BOUNDARY` / `TIMETABLE_REVIEW_AFTER`). `silver.sql` receives it as a template value,
  and `quality.py` fails the build once departures reach the end of the reviewed period.
- The column contract and v1/v2 edge cases are documented in `README.md`; keep it in sync when a
  column or rule changes.
- Station context (`src/tpm_analytics/data/stations.json`) must cover every station in
  `../scraper/stations.json`; a test enforces this. Keep retired stations in the dimension.

## Quality and publishing

- The quality **gate** is blocking: a structural or data-contract failure stops the build before the
  pointer moves. The weekly quality **report** is diagnostic: a threshold breach publishes one
  normal-priority `silver_quality_failed` warning and does not roll back a verified build.
- `silver/_latest.json` is the commit point. Write the manifest and all files first, verify them,
  then move the pointer. Retention keeps the newest two builds; reports are kept indefinitely.
- Do not weaken the refusal rules (corpus shrink, removed-row rate, duplicate accounting) or make
  the gate skippable from the invocation event. `--no-verify` is debug-only for the local CLI.
- The Lambda ignores the event: bucket, prefix, sizing, alert topic and log group come from the
  environment, so an invocation cannot disable the gate.

## Runtime

- The deployed Lambda is x86_64, 10,240 MB memory, 10,240 MB ephemeral storage, 900 s timeout, no
  VPC and reserved concurrency 1. The schedule is `tpm-silver-weekly`, Sunday 03:30 UTC.
- `CDK_ANALYTICS_PAUSED=1` deploys the schedule disabled. CI defaults to paused when the repository
  variable is unset; set `CDK_ANALYTICS_PAUSED=0` only after first-run checks. `TRANSFORM_VERSION`
  (CI sets it from `CDK_TRANSFORM_VERSION`, truncated to 12 characters) is recorded in the manifest;
  an empty value falls back to `sql-<hash>`.
- The handler sets the root logger level explicitly because the Lambda runtime installs its handler
  before the module is imported. Keep `logging.getLogger().setLevel(...)` and respect
  `AWS_LAMBDA_LOG_LEVEL`; `basicConfig` alone is not enough.
- Invoke the deployed function with `aws lambda invoke --invocation-type Event`. A synchronous invoke
  can outlive the CLI connection and start a duplicate build.

## Tests

`uv run pytest` runs the pyarrow fixtures and the publish/handler path against a local object store.
Tests never write to AWS. When you change a query, add or update a fixture that covers v1-only,
v2-only and mixed-schema input.

## Holiday calendar

- `src/tpm_analytics/data/calendar.json` is generated from OpenHolidays; do not hand-edit it. The
  data is ODbL-1.0 while the code is GPL-3.0; preserve the `NOTICE`, `data/NOTICE` and
  `data/README.md` files.
- `src/tpm_analytics/calendar.py` is the runtime loader/join. It must not import networking code or
  read the JSON at import time; keep the coverage/state validation and tests.
- Regenerate with `mise run //analytics:calendar`, check drift with `:check`, and run the
  `python-holidays`/KMK cross-checks before committing. Refresh after KMK publishes the next school
  year.
- Schema, filters (local and North Frisian/Halligen exceptions), columns and feature definitions:
  `src/tpm_analytics/data/README.md`.
- Adding a station state or calendar year updates the data and tests, not the poller or Lambda.

## Baseline training

- The baseline is **v1-only**. `journey_id` starts with schema v2 on 2026-11-13; a v2 row inside a
  baseline split fails the build. Do not mix v1 and v2 series keys in one split.
- The label domain is `24 h <= hours_to_departure <= 30 d`. The dataset stores
  `future_max_fare_24h`, `future_observations` and `label_window_end`; every headroom label is
  derived from that evidence. Never train on `future_*`, `label_*` or `limit_eur`.
- The model matrix is an allowlist from `features.py`, not "all columns minus exclusions". Null
  numerics must arrive as `NaN` plus indicators, never as zero; a test covers the DuckDB→numpy
  handoff.
- Sample whole **route-days**, not rows or individual series, so the route-day cross-section stays
  intact. Cross-sectional features are computed from the sampled route-days; never sample individual
  series or rows.
- Calibrate on `validation_calibrate`, never on `validation_select` or test. Test is reported once.
- Training artifacts are local and ignored. Downloaded silver goes under `analytics/.data/`; never
  commit it or upload the dataset to S3 from this module.
- The test split is a future-departure cohort. Do not describe it as an era holdout or use it to
  claim post-fix generalization. Test metrics are written only with `--evaluate-test`; the default
  and `--ablation` report validation only.
- `check_at` (20-24 h for the PR 2 diagnostics, so the point stays inside the 24 h maximum), `check_lag_h`, `cov_tail_h`, `cov_max_gap_h`, `check_price_eur` and the
  label diagnostics are audit columns, not model features. They may use future scrapes only for
  evaluation, never inside the feature matrix.
- The climatology score is a baseline, not a selectable production candidate. Keep it out of
  `model.candidates` unless a future plan changes that decision.
- `predictions/<split>.parquet` and `model.joblib` are local artifacts. Never load or trust a model
  file you did not produce; they are not uploaded. Verify `model.joblib` against
  `manifest.json.artifact_sha256` before loading.
- In predictions, `raw_score` is the model score at that row's headroom, `raw_score_pooled` is the
  assigned-headroom score used to fit the calibrator, and `calibration_mode`/`calibration_fold`
  say whether `calibrated_score` is out-of-fold (`oof`) or a full refit (`full`). Do not fit a new
  calibrator to `raw_score` and expect the stored calibrated score.
- A clean rerun must match the per-split content digests in `dataset_manifest.json`. Do not remove
  the total `ORDER BY` in the Parquet writer.

Update `README.md` for schema, quality or runbook changes and
[docs/configuration.md](../docs/configuration.md) for new environment variables.
