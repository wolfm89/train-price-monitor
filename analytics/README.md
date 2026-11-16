# Analytics

Silver-layer builds for the Train Price Monitor price dataset.

Bronze (`s3://<scraper-bucket>/prices/`) is the scraper's Parquet output, partitioned by observation
day. The compactor rewrites a day's `batch_*` files into one `daily_*` file, so bronze is
append-and-rewrite, not immutable. The build lists the objects once and reads exactly that
snapshot, so a batch the poller appends mid-build is simply not part of that build; the manifest
records the same list. Silver is the conformed snapshot the model work reads:
typed, with v1/v2 semantics normalised, station context joined and departure-month partitions.
Every run rebuilds it from scratch, so the same input produces the same rows; row order and file
split are not stable, and each build needs its own target directory and room on disk for the output
plus the spill directory (both live next to the target). Duplicate observations are removed using
the compactor's key and reported in the build stats.

## Scope of this module (v1)

Shipped here:

- `src/tpm_analytics/sql/silver.sql` — the one deterministic transform.
- `src/tpm_analytics/silver/build.py` — DuckDB session, transform execution, local Parquet output.
- `src/tpm_analytics/silver/quality.py` — the gates that must pass before a build is published.
- `tests/` — fixture-based tests over v1-only, v2-only and mixed bronze files.

The S3 writer, manifest, pointer and Lambda handler are implemented (`publish.py`, `manifest.py`,
`handler.py`). The `AnalyticsStack` adds the image Lambda, the weekly EventBridge Scheduler trigger,
the least-privilege IAM, the failure SNS path and the `silver/` lifecycle rule; see [Deployment](#deployment).
The handler lists the bronze keys once and builds from that snapshot, so the poller's 15-minute
appends cannot change the corpus under a nine-minute build.

The CLI still writes to a local directory. Reading `s3://` requires S3 credentials passed to
`run_build`; the Lambda handler supplies them from its execution role.

The SQL and the station dimension live inside the package (`src/tpm_analytics/{sql,data}`), so a
built wheel is self-contained and the image only has to copy `tpm_analytics/`.

DuckDB is pinned at 2.0.0. The transform uses `COPY … RETURN_STATS`, so the row and partition counts
come from the writer; the gate then re-counts the rows from disk and checks the partition count
against the directory tree.

## Local commands

```bash
cd analytics
uv sync --frozen        # create .venv from the lockfile (uv also provisions Python 3.15)
uv run pytest           # fixture tests
uv run ruff check .     # lint
uv run ruff format .    # format
uv run ty check         # type check
uv build                # wheel + sdist, assets included
```

Or via mise from anywhere in the repo:

```bash
mise run //analytics:test
mise run //analytics:lint
mise run //analytics:typecheck
mise run //analytics:build
```

## Running the transform locally

```bash
uv run python -m tpm_analytics.silver.build \
  --source '/path/to/bronze/prices/**/*.parquet' \
  --target /tmp/silver
```

The output is Hive-partitioned by `departure_year`/`departure_month`, ZSTD-compressed. ZSTD is the
measured choice: on a 4.4M-row partition it produced 127 MB against 169 MB for snappy, 142 MB for
gzip and 171 MB for lz4, at 5.9 s write time versus 4.6 s for snappy; full-column reads were equal
within noise. Storage and upload dominate a weekly batch, so the smaller file wins. The build
writes into a hidden sibling directory, runs the quality gate, and only then renames it into place,
so a rejected build leaves no target behind. `--stations` overrides the station dimension and
`--no-verify` skips the gate (debug only, prints a warning). Exit code 2 means the build was
refused: an existing target, a failed gate, an empty corpus, a URI instead of a path, or a
DuckDB/OS error. argparse also exits 2 for a usage error. Linux and macOS are supported;
Windows is untested.

## Scale (measured 2026-11-14)

The full history is 107,129,248 bronze rows in 226 files (1.7 GB) and produces 2.9 GB of silver in
8 departure-month partitions. On a workstation with 8 GB for DuckDB and 4 threads the build takes
8m45s, peaks at 8.5 GB RSS and removes 1,146 duplicate observations.

The Lambda is sized for that corpus: 10,240 MB memory, 10,240 MB ephemeral storage, 900 s,
`memory_limit=8GB`, `threads=4` (the measured configuration), `SILVER_MAX_TEMP_SIZE=5GB` so spill and output share the 10 GB
`/tmp` without colliding. Those numbers come from a workstation run; measure the first Lambda run
before trusting the schedule. If the corpus outgrows it, split the build by departure month.

```bash
uv run python -m tpm_analytics.silver.build \
  --source '/data/prices/**/*.parquet' --target /data/silver \
  --threads 4 --memory-limit 8GB
```

Re-run this before an engine upgrade and before the stack lands. It is not part of CI.

## Publishing

The Lambda handler builds into a local temp directory, verifies it, and publishes:

```
silver/builds/<build id>/departure_year=YYYY/departure_month=MM/*.parquet
silver/builds/<build id>/_manifest.json
silver/_latest.json
```

- The **manifest** records `build_id`, the source glob and the exact object list that was read,
  rows in/out, duplicates removed, partitions, duration, transform version, DuckDB version,
  SHA-256 of the SQL, station dimension and constants, the handler warnings, and every output
  file with its size. The bucket
  comes from the store that wrote the bytes, so it cannot disagree with them. An empty
  `TRANSFORM_VERSION` falls back to the SQL hash, so provenance is never blank.
- The **pointer** is written last, after the manifest is read back and every file is present with
  the recorded size. The pointer write is the commit point: an exception before it deletes the
  half-written build; a pointer PUT that errors is assumed to have landed and the build is kept.
  A killed process (timeout, OOM) cannot clean up: it leaves a prefix without a manifest.
  Retention reclaims such a prefix once it is older than an hour, which is long after any
  in-flight upload could still be running.
- **Retention** keeps the newest two builds (`SILVER_KEEP`, minimum 2 so one cycle of readers
  always survives), only counts ids that match the build-id format and have a readable,
  consistent manifest, never deletes the build the pointer names, and only deletes a complete
  build once it is a day old. A manifest that cannot be read is never deleted.
- **Refusals:** a corpus that shrank by more than 10 % against the pointed-at build, more than
  0.01 % removed rows, or removed rows that are not exactly the duplicates in bronze.
- The handler ignores the event: source, bucket, prefix, sizing and the alert topic come from the
  environment (`SILVER_BUCKET`, `SILVER_PREFIX`, `BRONZE_SOURCE`, `SILVER_THREADS`,
  `SILVER_MEMORY_LIMIT`, `SILVER_MAX_TEMP_SIZE`, `SILVER_KEEP`, `TRANSFORM_VERSION`,
  `ALERT_TOPIC_ARN`, `LOG_GROUP_NAME`), so an invocation cannot disable the gate. `TRANSFORM_VERSION`
  is the commit SHA in CI; empty falls back to `sql-<hash>`. Any handler exception publishes a
  `silver_build_failed` message with the build id and stage and is re-raised; a handled failure does
  not move the pointer.

For local S3 reads, install the extension once and point DuckDB at it:
from `analytics/`, `mise run //analytics:httpfs` then
`DUCKDB_EXTENSION_DIR=.duckdb-extensions` (the script and the variable are CWD-relative).
The Lambda image bakes the same extension into `/opt/duckdb/extensions`.

`tests/test_publish.py` and `tests/test_handler.py` exercise the whole path against a local
`ObjectStore`, and `tests/test_storage.py` covers the S3 implementation with botocore's
`Stubber`. The tests never write to AWS.

## Deployment

`AnalyticsStack` deploys `analytics/Dockerfile` as an x86_64 Lambda: 10,240 MB memory, 900 s,
10,240 MB `/tmp`, no VPC, reserved concurrency 1. EventBridge Scheduler runs it every Sunday at
03:30 UTC, after the 03:00 compactor. It reads bronze from `prices/`, writes `silver/` and keeps the
newest two builds. IAM is prefix-scoped: list `prices/*` and `silver/*`, read `prices/*`,
read/write/delete/abort on `silver/*`, and publish to the alert topic; it cannot write or delete
bronze.

The function environment is set by CDK: `SILVER_BUCKET`, `SILVER_PREFIX`, `BRONZE_SOURCE`,
`SILVER_THREADS`, `SILVER_MEMORY_LIMIT`, `SILVER_MAX_TEMP_SIZE`, `SILVER_KEEP`, `TRANSFORM_VERSION`,
`ALERT_TOPIC_ARN` and `LOG_GROUP_NAME`. `AWS_REGION` is reserved by Lambda. CI sets
`TRANSFORM_VERSION` to the commit SHA; an empty value records `sql-<hash>`.

Deploy paused first, so the first run cannot race verification:

```bash
cd ../infrastructure
CDK_ANALYTICS_PAUSED=1 npx cdk deploy AnalyticsStack
aws lambda invoke --function-name "$(aws cloudformation describe-stacks --stack-name AnalyticsStack \
  --query "Stacks[0].Outputs[?OutputKey=='SilverFunctionName'].OutputValue" --output text)" \
  --payload '{}' --cli-binary-format raw-in-base64-out /tmp/silver.json
cat /tmp/silver.json
```

`CDK_APP_NAME`, `CDK_DOMAIN_NAME` and `CDK_SES_FROM_EMAIL` must be set (CI supplies them from
repository secrets).

Verify `silver/_latest.json` and `silver/builds/<id>/_manifest.json`, record duration, memory, rows
and partitions, then deploy without `CDK_ANALYTICS_PAUSED` to enable the schedule. For the forced
failure, temporarily point `BRONZE_SOURCE` at an empty prefix, invoke once, confirm the Pushover
alert and the unchanged pointer, then restore the environment.

A failed run publishes `silver_build_failed` with the build id and stage to `ALERT_TOPIC_ARN`. The
pointer is only moved by a verified build; if the pointer PUT itself errors, check
`silver/_latest.json` before rolling anything back. A bad pointer can be rolled back to the previous
build (kept for at least a day). From `infrastructure/`, run `cdk gc --unstable=gc --type=ecr` at
least monthly so tagged image assets do not accumulate in ECR.

## Column contract

Silver has the 22 bronze columns plus the columns below. Each file carries 37 columns; the
partition columns `departure_year`/`departure_month` exist only in the directory path, so a hive read
yields 39.

| Column                                             | Rule                                                                                                                                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transfers_raw`                                    | the bronze `transfers` value, kept for provenance; **v1 counts vehicle legs (2× the changes), v2 counts changes**                                                                       |
| `transfers_actual`                                 | `transfers_raw // 2` for v1, `transfers_raw` for v2                                                                                                                                     |
| `load_factor_ordinal`                              | stored ordinal when present, else derived from `load_factor` (`low`/`low-to-medium`=1, `high`=2, `very-high`=3, `exceptionally-high`=4)                                                 |
| `departure_date`                                   | `CAST(departure_local AS DATE)`                                                                                                                                                         |
| `departure_weekday`                                | ISO: `isodow - 1`, **0 = Monday … 6 = Sunday**                                                                                                                                          |
| `departure_hour_local`                             | hour of `departure_local`                                                                                                                                                               |
| `departure_iso_week`, `departure_iso_year`         | ISO-8601 week and week-year of `departure_local`; weeks start on Monday                                                                                                                 |
| `is_weekend`                                       | `departure_weekday >= 5` (Saturday or Sunday)                                                                                                                                           |
| `distance_km`                                      | haversine between the station coordinates, R = 6371.0088 km                                                                                                                             |
| `origin_state`, `dest_state`                       | federal state from the station dimension                                                                                                                                                |
| `origin_station_category`, `dest_station_category` | DB station category (1–7)                                                                                                                                                               |
| `timetable_period`                                 | `2025-12` before 2026-12-13 local, `2026-12` after                                                                                                                                      |
| `observation_era`                                  | `dense` before 2026-09-01, `sparse` before 2026-11-13 18:15:49 UTC, `post-fix` after                                                                                                    |
| `scrapes_per_route_day_final`                      | distinct `observed_at` per `(route_id, local departure date)` over the **whole corpus alive at build time** — a final-corpus property: using it as a covariate leaks later observations |

`departure_local` is `timezone('Europe/Berlin', departure_planned AT TIME ZONE 'UTC')`. Every
calendar attribute and the timetable period use it, because the DB timetable runs on local time: a
00:30 CET departure is 23:30 UTC the day before. Silver timestamps are millisecond precision
(`TIMESTAMP_MS`), matching bronze; the data is minute-scale, so finer precision buys nothing.

## Station dimension

`src/tpm_analytics/data/stations.json` holds one row per station in the scraper's route catalogue
(`scraper/stations.json`): `eva`, `name`, `lat`, `lon`, `state`, `category`.

Coordinates, federal state and DB station category come from
[`db-stations`](https://github.com/derhuerst/db-stations) 5.0.2. The underlying station data was
published by Deutsche Bahn under
[CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/); this file is a subset of 14 stations
with renamed fields and the category and federal state extracted, which is the attribution and
change notice the licence requires.
`tests/test_station_dimension.py` fails if the scraper catalogue contains a station that is missing
here, so the two files cannot drift apart silently. Keep retired stations in the dimension: bronze
never forgets them, and a missing row fails every future rebuild.

## Semantics the transform encodes

- `schema_version` is `1` when the column is absent or null (files written before schema v2).
- v1 `load_factor` only had three buckets. `low` really means "neither high nor very-high", so it
  also swallowed the rare `exceptionally-high`; mapping it to ordinal 1 is the same approximation
  the scraper's own `legacyLoadFactorOrdinal` makes.
- v1 dropped journeys without a fare, v2 keeps them with `fare_lowest_eur IS NULL`. Comparing fare
  distributions across eras therefore mixes a selection effect with the era effect.
- `journey_id` is null for every v1 row; it is never re-derived. `train_numbers`, `source_profile`
  and `query_mode` are backfilled for v1 rows with the same defaults the compactor uses
  (`train_number`, `dbweb`, `bestprice`).
- Duplicate observations (same compactor key) are collapsed to one row. The historical corpus has
  1,146 such rows, from days whose batch files outlived their daily file.
- Odd v1 `transfers` values (370 rows in the historical corpus) become a NULL `transfers_actual`:
  the old poller counted every leg including footways, and an odd count cannot be halved exactly.
- `timetable_period` is derived from the departure date, not from the deploy. `TIMETABLE_BOUNDARY`
  and `TIMETABLE_REVIEW_AFTER` both live in `silver/constants.py`; the build fails once departures
  reach the end of the reviewed period, so a forgotten December or June edit cannot silently
  mislabel a year of data.
