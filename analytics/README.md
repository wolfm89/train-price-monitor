# Analytics

Silver-layer builds for the Train Price Monitor price dataset.

Bronze (`s3://<scraper-bucket>/prices/`) is immutable Parquet written by the scraper, partitioned by
observation day. Silver is the conformed snapshot the model work reads: typed, with v1/v2 semantics
normalised, station context joined and departure-date partitions. It is rebuilt from scratch on every
run, so a run is deterministic and a re-run is always safe.

## Scope of this module (v1)

Shipped here:

- `sql/silver.sql` — the one deterministic transform.
- `src/tpm_analytics/silver/build.py` — DuckDB session, transform execution, local Parquet output.
- `src/tpm_analytics/silver/quality.py` — the gates that must pass before a build is published.
- `tests/` — fixture-based tests over v1-only, v2-only and mixed bronze files.

Not here yet: the S3 writer, the build manifest and `_latest.json` pointer, the Lambda handler, the
`AnalyticsStack`. They follow in the next change; until then the module runs against a local
directory.

## Local commands

```bash
cd analytics
uv sync                 # create .venv from the lockfile
uv run pytest           # fixture tests
uv run ruff check .     # lint
uv run ruff format .    # format
uv run ty check         # type check
```

Or via mise from anywhere in the repo:

```bash
mise run //analytics:test
mise run //analytics:lint
mise run //analytics:typecheck
```

## Running the transform locally

```bash
uv run python -m tpm_analytics.silver.build \
  --source '/path/to/bronze/prices/**/*.parquet' \
  --target /tmp/silver
```

The output is Hive-partitioned by `departure_year`/`departure_month`, ZSTD-compressed, one directory
per build. `--stations` overrides the station dimension; the default is `data/stations.json`.

## Station dimension

`data/stations.json` holds one row per station in the scraper's route catalogue (`scraper/stations.json`):
`eva`, `name`, `lat`, `lon`, `state`, `category`.

Coordinates, federal state and DB station category come from
[`db-stations`](https://github.com/derhuerst/db-stations) 5.0.2, which is published under
CC-BY-4.0 and ODbL. `tests/test_station_dimension.py` fails if the scraper catalogue contains a
station that is missing here, so the two files cannot drift apart silently.

## Semantics the transform encodes

- `schema_version` is `1` when the column is absent (files written before schema v2).
- v1 rows measured `transfers` as vehicle legs (footways included), so `transfers / 2` recovers the
  number of changes. v2 rows store the changes directly.
- v1 stored a collapsed three-value vocabulary (`low`, `high`, `very-high`) and no ordinal; the rank
  is derived from that vocabulary. v2 stores the DB vocabulary and the ordinal directly.
- `fare_lowest_eur IS NULL` means "no fare offered" and only occurs in v2 rows.
- `journey_id` is null for every v1 row; it is never re-derived.
- `timetable_period` is derived from the departure date, not from the deploy: the DB timetable
  changed on 2026-12-13.
