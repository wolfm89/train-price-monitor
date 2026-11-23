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

The `train` group adds numpy, scikit-learn, scipy, joblib and pyarrow. CI installs it for the
analytics job and the manual pre-commit `ty` hook; `uv export --no-dev` must keep it out of the
Lambda image.

The training CLI defaults to DuckDB `memory_limit=6GB` and `max_temp_size=20GB`; override them with
`TRAIN_DUCKDB_MEMORY_LIMIT` and `TRAIN_DUCKDB_MAX_TEMP_SIZE`. Both effective values are recorded in
`dataset_manifest.json` under `duckdb_settings`. The 20 GB temp default is sized for the 5 %
route-day sample; raise it for the 10/25/50 % learning-curve runs.

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
- The default protocol is **backtest**; static is the legacy `config/training-static.json` path.
  A fold trains on `label_window_end <= cutoff - 24 h`, calibrates on the following 7 days and
  tests the week after; purge on `label_window_end`, never on `snapshot_at`. The recipe is frozen
  on development folds and refitted on evaluation folds without selection. Evaluation and
  sparse-era folds are scored only with `--evaluate-test`; the scored blocks go in the manifest and
  the parent-plan ledger. A series may span a backtest cutoff because labels are purged and features
  are past-only. The static `splits` block still bounds the panel at `test_end`; it is not used
  for backtest scoring. `--ablation` requires `config/training-static.json`. `--cache-dir` resumes completed folds and the frozen recipe by config, dataset digest and fit-code hash;
  checkpoints hold report state only, never the train or calibration panels. A cache-free 5 %
  backtest peaks near 6.47 GB (4.03 GB with the dataset cache); 10 % has not been measured, so
  raise memory before scaling.
- **Recipe selection is development-only.** `training/selection.py` performs a joint search over
  every model x calibration pair on the development folds and refuses any other role. Comparison
  is a paired departure-date cluster bootstrap (2,000 replicates) on delta log loss (primary) and
  delta Brier. A more complex choice replaces a simpler one only when the log-loss 95 % interval is
  entirely below zero and the Brier interval is not entirely above zero. Complexity order is
  `base_rate < logistic < hist_gradient_boosting` and
  `sigmoid = temperature < isotonic < covariate`; climatology is a reference row, never selectable.
  The full table goes to `recipe.json`; only the rule settings enter the recipe hash.
- **Calibration.** Four methods: sigmoid, temperature, isotonic and covariate (logistic on
  logit(score), TTD-band dummies, band x logit interactions and log(1 + headroom)). The covariate
  calibrator must be monotone in score in every band and non-increasing in headroom; otherwise it
  falls back to isotonic and the requested/fitted methods are recorded per fold. All outputs are
  clipped to `[1e-6, 1 - 1e-6]`. Per-headroom tables use the selected calibrator at each headroom;
  the per-headroom isotonic is a diagnostic column. The static path keeps its three legacy
  methods so its reference run stays byte-identical.
- **Thresholds.** One per headroom x TTD band on the calibration block's out-of-fold scores: the
  highest recall whose one-sided 95 % Wilson lower bound on precision is at least
  `threshold_precision_floor` with at least `threshold_min_alerts` (30) alerts. A cell with no
  qualifying point does not alert. Pooled precision and recall use each row's own fold and cell
  threshold; never substitute the mean threshold.
- **Decision value and importance.** Decision value uses the primary 20-28 h `check_at` and
  compares the alert policy with waiting (the current product, primary) and booking now, plus a
  random alert, both perfect-breach oracles and perfect timing. Grouped permutation importance uses
  each development fold's own model and calibrator on the pooled test blocks; families live in
  `features.py` and every feature must belong to exactly one.
- **Early stopping.** HGB holds out the last 7 days of the fold's training rows by `snapshot_at`,
  stops when the holdout log loss has not improved by 1e-4 for 50 iterations, and refits on all
  training rows with the chosen iteration count. The holdout never touches calibration. The cap
  is the recipe's `max_iter` (at most 400).
- `--forward` builds the unscored forward Parquet with grid columns (`eligible`, `check_at`,
  `check_lag_h`) and no label or check-fare columns. The smoke build uses a 5 % route-day sample
  (`protocol.forward.sample_rate`) because the all-route build exceeds the memory ceiling.
  `--score-forward PATH` smoke-scores it with the 14 September refit; no labels or metrics.
- The automatic dataset cache lives in `artifacts/.cache/datasets` and is keyed by config, source
  build/manifest identity, strict-chain mode, dataset-code hash and a clean tree. Use
  `--no-dataset-cache` for an independent build; reuse verifies every split, profile and column-role
  hash.
- The label is the **next-day fare**: the chain's fare at the route-day check closest to
  `t + 24 h` inside 20-28 h and before departure. Eligibility depends only on the route-day scrape
  grid. A chain missing at the check is censored (`censor_reason = 'not_listed'`), not a negative;
  `fare_lost` is reserved for v2 listed-without-fare events and is false in the v1 baseline.
  `label_window_end` is the check time and is at most `t + 28 h`.
- Fares are compared as integer cents with the one shared definition in
  `training/labels.py`: `check_cents * 100 >= price_cents * (100 + headroom)`. A fare exactly on
  the limit counts as reached. Never reintroduce euro-float label comparisons.
- The label domain is `24 h <= hours_to_departure <= 30 d`. `future_max_fare_24h`,
  `future_observations` and `breached_within_24h` are diagnostics only, reported on R24-covered
  24 h-7 d rows; they are not the training target. Never train on `future_*`, `label_*`,
  `breached_*` or `limit_eur`.
- Snapshots keep the **first observation per bin** (12 h outside 48 h, 1 h inside), with a
  deterministic tie-break. Do not switch back to the last observation.
- One population: every eligible row with a known next-day check fare is used for training,
  selection, calibration, threshold and evaluation. `future_observations >= 2` is a diagnostic
  stratum only; do not restore a tier-selected headline.
- The model matrix is an allowlist from `features.py`, not "all columns minus exclusions". Null
  numerics must arrive as `NaN` plus indicators, never as zero; a test covers the DuckDB→numpy
  handoff.
- Sample whole **route-days**, not rows or individual series, so the route-day cross-section stays
  intact. Cross-sectional features are computed from the sampled route-days; never sample individual
  series or rows.
- Calibrate on `validation_calibrate`, never on `validation_select` or test. Test is reported once.
- Dataset gates use minimum eligible rows and positives per split, headroom and TTD band. The old
  future-selected `min_label_coverage` floor is retired; do not bring it back.
- Training artifacts are local and ignored. Downloaded silver goes under `analytics/.data/`; never
  commit it or upload the dataset to S3 from this module.
- The test split is a future-departure cohort. Do not describe it as an era holdout or use it to
  claim post-fix generalization. Test metrics are written only with `--evaluate-test`; the default
  and `--ablation` report validation only. `--evaluate-test` gates the test label and model tables;
  journey disappearance is corpus-level and includes test departures. `profile.json` and
  `dataset_manifest.json` keep descriptive test aggregates for the dataset build.
- **Journey identity.** The series key follows the itinerary (route, first train, class,
  15-minute departure and arrival buckets, and the exact transfer count). When a series stops
  appearing, the chain links it to
  the next series with the same route, class and first-train number, a planned departure within
  15 minutes and its first observation at the next route-day scrape. Links are one-to-one; the
  matcher maximises the number of links and prefers the closest departure, but a crossing pattern
  may use a predecessor's second-closest candidate to keep the matching maximum. The chain id, not
  `series_key`, is the identity for the label window, the history features and the split assignment.
  An arrival change therefore continues the journey; a different train or a departure shift above
  15 minutes does not. `--strict-chains` drops every candidate whose predecessor or successor has
  more than one candidate; it is the sensitivity run, not the default, and its Brier difference is
  within refit noise.
- The link decision is causal. A series that is absent at a route-day scrape and has a matching
  successor there continues into the successor; if the old itinerary later returns, the return is
  a new incarnation of the same series key (`#r` suffix). No link depends on observations after
  the scrape that decides it. `split_series` counts base series split into at least one later
  incarnation.
- Split detection iterates to a fixed point: a successor that is itself a later incarnation can
  also trigger the split of an earlier series. A split is committed only for a continuation the
  one-to-one matcher accepts; a candidate that loses a competing match, or is dropped by strict
  mode, leaves the predecessor's return in its earlier incarnation. No link uses observations
  after the scrape that decides it.
- The v2 handover audit matches the first incarnation of each v1 series; later incarnations are
  not separate counterpart rows. Do not read its unmatched count as a link-precision measure.
- The 15-minute series buckets are rounded, so their centres are at `:00 / :15 / :30 / :45` and
  their edges at `:07:30 / :22:30 / :37:30 / :52:30`. A departure shift that crosses an edge
  starts a new series. `price_rank_route_day` ranks every priced journey in
  the route-day x class x scrape cross-section before resampling; route-day sampling keeps the
  whole cross-section. `column_roles.json` records which output columns are features, labels or
  audit so a new diagnostic cannot quietly enter the model matrix.
- `observation_week` is the Europe/Berlin ISO week. `identity.berlin_week_sql` implements the EU
  DST rule directly because DuckDB's ICU timezone functions need `pytz` in the Python client.
- `check_at` is the primary 20-28 h next-day check; `check_at_2024` is the crossed-back and
  decision-value diagnostic; `check_at_2226` is the legacy window sensitivity. `check_lag_h`,
  `cov_tail_h`, `cov_max_gap_h`, `check_price_eur`, `check_price_cents`, `breached_next_day`,
  `eligible`, `censor_reason`, `fare_lost`, `price_cents` and the check/label diagnostics are
  label columns, not model features. They may use future scrapes only for evaluation, never
  inside the feature matrix.
- The climatology score is a baseline, not a selectable production candidate. Keep it out of
  `model.candidates` unless a future plan changes that decision.
- `predictions/<split>.parquet` and `model.joblib` are local artifacts. Never load or trust a model
  file you did not produce; they are not uploaded. Verify `model.joblib` against
  `manifest.json.artifact_sha256` before loading; the hash proves integrity, not authenticity,
  because the expected value ships in the same directory.
- In predictions, `raw_score` is the model score at that row's headroom, `raw_score_pooled` is the
  assigned-headroom score used to fit the calibrator, and `calibration_mode`/`calibration_fold`
  say whether `calibrated_score` is out-of-fold (`oof`) or a full refit (`full`). Do not fit a new
  calibrator to `raw_score` and expect the stored calibrated score.
- A clean rerun must match the per-split content digests in `dataset_manifest.json`. Do not remove
  the total `ORDER BY` in the Parquet writer.
- `git_dirty` covers tracked changes anywhere in the checkout and untracked files under
  `analytics/`. Untracked files elsewhere are recorded in `git_untracked` and do not make the run
  dirty. Never move or delete a user's file to get a clean flag.

Update `README.md` for schema, quality or runbook changes and
[docs/configuration.md](../docs/configuration.md) for new environment variables.
