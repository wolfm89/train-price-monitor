# Analytics

Silver-layer builds for the Train Price Monitor price dataset.

Bronze (`s3://<scraper-bucket>/prices/`) is the scraper's Parquet output, partitioned by observation
day. The compactor rewrites a day's `batch_*` files into one `daily_*` file, so bronze is
append-and-rewrite, not immutable. The build counts bronze before the transform and again before
publishing, so a compactor run that swaps files mid-build fails the run instead of producing a
dataset that matches neither version. Silver is the conformed snapshot the model work reads:
typed, with v1/v2 semantics normalised, station context joined and departure-month partitions.
Every run rebuilds it from scratch, so the same input produces the same rows; row order and file
split are not stable, and each build needs its own target directory and room on disk for the output
plus the spill directory (both live next to the target).

## Scope of this module (v1)

Shipped here:

- `src/tpm_analytics/sql/silver.sql` — the one deterministic transform.
- `src/tpm_analytics/silver/build.py` — DuckDB session, transform execution, local Parquet output.
- `src/tpm_analytics/silver/quality.py` — the gates that must pass before a build is published.
- `tests/` — fixture-based tests over v1-only, v2-only and mixed bronze files.

Not here yet: the S3 writer, the build manifest and `_latest.json` pointer, the Lambda handler, the
`AnalyticsStack`, and the Dockerfile. Until then the module reads **local paths only** — it cannot
open `s3://`.

The SQL and the station dimension live inside the package (`src/tpm_analytics/{sql,data}`), so a
built wheel is self-contained and the future image only has to copy `tpm_analytics/`.

DuckDB is pinned at 2.0.0. The transform uses `COPY … RETURN_STATS`, so the row and partition counts
come from the writer; the gate then re-counts the rows from disk and checks the partition count
against the directory tree.

## Local commands

```bash
cd analytics
uv sync --frozen        # create .venv from the lockfile (uv also provisions Python 3.13)
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

The output is Hive-partitioned by `departure_year`/`departure_month`, ZSTD-compressed. The build
writes into a hidden sibling directory, runs the quality gate, and only then renames it into place,
so a rejected build leaves no target behind. `--stations` overrides the station dimension and
`--no-verify` skips the gate (debug only, prints a warning). Exit code 2 means the build was
refused: an existing target, a failed gate, an empty corpus, a URI instead of a path, or a
DuckDB/OS error. argparse also exits 2 for a usage error. Linux and macOS are supported;
Windows is untested.

## Column contract

Silver has the 22 bronze columns plus the columns below. Each file carries 35 columns; the
partition columns `departure_year`/`departure_month` exist only in the directory path, so a hive read
yields 37.

| Column                                             | Rule                                                                                                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transfers_raw`                                    | the bronze `transfers` value, kept for provenance; **v1 counts vehicle legs (2× the changes), v2 counts changes**                                             |
| `transfers_actual`                                 | `transfers_raw // 2` for v1, `transfers_raw` for v2                                                                                                           |
| `load_factor_ordinal`                              | stored ordinal when present, else derived from `load_factor` (`low`/`low-to-medium`=1, `high`=2, `very-high`=3, `exceptionally-high`=4)                       |
| `departure_date`                                   | `CAST(departure_local AS DATE)`                                                                                                                               |
| `departure_weekday`                                | `dayofweek(departure_local)`, 0 = Sunday … 6 = Saturday                                                                                                       |
| `departure_hour_local`                             | hour of `departure_local`                                                                                                                                     |
| `is_weekend`                                       | weekday 0 or 6                                                                                                                                                |
| `distance_km`                                      | haversine between the station coordinates, R = 6371.0088 km                                                                                                   |
| `origin_state`, `dest_state`                       | federal state from the station dimension                                                                                                                      |
| `origin_station_category`, `dest_station_category` | DB station category (1–7)                                                                                                                                     |
| `timetable_period`                                 | `2025-12` before 2026-12-13 local, `2026-12` after                                                                                                            |
| `observation_era`                                  | `dense` before 2026-09-01, `sparse` before 2026-11-13 18:15:49 UTC, `post-fix` after                                                                          |
| `scrapes_per_route_day`                            | distinct `observed_at` per `(route_id, local departure date)` over the **whole corpus alive at build time** — a dataset property, not a point-in-time feature |

`departure_local` is `timezone('Europe/Berlin', departure_planned AT TIME ZONE 'UTC')`. Every
calendar attribute and the timetable period use it, because the DB timetable runs on local time: a
00:30 CET departure is 23:30 UTC the day before. Silver timestamps are microsecond precision
(DuckDB's `TIMESTAMP`); bronze is millisecond.

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
- `timetable_period` is derived from the departure date, not from the deploy. `TIMETABLE_BOUNDARY`
  and `TIMETABLE_REVIEW_AFTER` both live in `silver/constants.py`; the build fails once departures
  reach the end of the reviewed period, so a forgotten December or June edit cannot silently
  mislabel a year of data.
