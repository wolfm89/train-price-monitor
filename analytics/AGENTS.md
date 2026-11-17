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

Update `README.md` for schema, quality or runbook changes and
[docs/configuration.md](../docs/configuration.md) for new environment variables.
