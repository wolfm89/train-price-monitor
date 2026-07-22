# Stats — local data investigation & visualization

A reproducible, git-tracked workspace for finding patterns in the scraper's price data.
It pairs **DuckDB** (SQL engine over the Parquet files) with **[marimo](https://marimo.io)**
reactive notebooks — a single, fully open-source (Apache-2.0) tool that is:

- **Code-first but no-code to use** — analysis is SQL in `mo.sql` cells; consumers drive it
  with dropdowns/sliders via `mise run //stats:app`.
- **Git-versionable** — notebooks are plain `.py` files (diffable, reviewable).
- **Free to publish later** — marimo exports to a static WASM site (deferred for now).

## Layout

```
stats/
  pyproject.toml            # uv project; deps: marimo[sql], duckdb, polars, altair
  mise.toml                 # tasks: install · fetch · marts · edit · app · lint
  tpm_stats/                # shared package (the single source of truth)
    config.py               # paths + canonical `prices` view (derived columns, DTD buckets)
    db.py                   # get_connection() → DuckDB with `prices` (+ mart views)
    marts.py                # pre-aggregated mart_*.parquet builder
  scripts/fetch.sh          # sync daily_*.parquet from S3 (last-N-days or date range)
  notebooks/                # one notebook per analysis goal (see below)
  data/scraper/             # local raw daily_*.parquet  (gitignored)
  marts/                    # small aggregated parquet     (gitignored)
```

`data/` and `marts/` are **gitignored** — raw Parquet can reach gigabytes for a year of data.

## Quick start

```bash
mise run //stats:install                      # create venv + install deps (uv)

# Get data locally (needs AWS creds + SCRAPER_BUCKET_NAME, or pass --bucket):
mise run //stats:fetch --days 30              # last 30 days, up to yesterday
mise run //stats:fetch --from 2026-05-01 --to 2026-05-31   # explicit date range

mise run //stats:edit 01_booking_curve        # reactive editor (author/explore)
mise run //stats:app  01_booking_curve         # read-only interactive app (no code shown)
```

> Already have files? Just drop `daily_YYYY-MM-DD.parquet` into `data/scraper/` and skip `fetch`.

### Optional performance layer

For large windows (up to a year ≈ ~490M rows), pre-aggregate once:

```bash
mise run //stats:marts                         # writes marts/mart_*.parquet (KBs–few MB)
```

Mart views (`mart_booking_curve`, `mart_route_comparison`, …) are auto-registered by
`get_connection()` and queryable from any notebook alongside the raw `prices` view.

## Notebooks

| Notebook              | Question it answers                                           |
| --------------------- | ------------------------------------------------------------- |
| `00_overview`         | Coverage, completeness, distributions, scrape cadence         |
| `01_booking_curve`    | How fares move with lead time → best time to book per route   |
| `02_route_comparison` | Cheapest / best-value routes & train types (€, €/min)         |
| `03_demand_load`      | Load factor (`low`/`high`/`very-high`) vs. fare and lead time |
| `04_temporal`         | Day-of-week and hour-of-day price patterns                    |
| `05_anomalies`        | Z-score outliers, price jumps, scrape gaps                    |

## How the data layer works

Every notebook calls `get_connection()` from `tpm_stats.db`, which registers one DuckDB
view, **`prices`**, defined in `tpm_stats/config.py`. Beyond the raw scraper columns it adds
reusable derived dimensions so notebooks stay DRY:

- `route_label` (`Origin → Dest`), `class_label` (`1st`/`2nd`)
- `load_factor_norm` (nulls → `unknown`)
- `dep_isodow`, `dep_dayname`, `dep_hour`, `departure_date`
- `dtd_bucket` — lead time bucketed to `{0,1,2,3,5,7,10,14,21,30,45,60,90}`
- `price_per_min` — fare ÷ duration

Change a derived column once in `config.py` and every notebook + mart updates.

## Data source

Files come from the scraper's S3 bucket
(`prices/year=YYYY/month=MM/day=DD/daily_<epoch>_<rand>.parquet`, see `scraper/src/compactor.ts`).
`fetch.sh` picks the newest `daily_` object per partition and saves it as
`data/scraper/daily_YYYY-MM-DD.parquet`. Set `AWS_ENDPOINT_URL` to target the local Floci
emulator instead of AWS.

## Conventions

- Python ≥ 3.12, managed with **uv**; lint/format with **ruff** (`mise run //stats:lint`).
- Notebooks are validated headlessly with `marimo export html` (executes every cell).
- Keep analysis in SQL where possible; reserve Python for charts (Altair) and UI widgets.
