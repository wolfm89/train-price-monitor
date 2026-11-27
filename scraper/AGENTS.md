# Scraper — Agent Guide

Independent serverless pipeline that collects Deutsche Bahn fares into Parquet on S3. It shares the
DB transport and `../shared/runtime-config.json` with the web app. The root
[`AGENTS.md`](../AGENTS.md) still applies; this file adds the scraper-specific rules.

## Commands

```bash
npm install
npm run build        # esbuild bundles to dist/{poller,hydrator,compactor}
npm run typecheck
npm run lint
npm test             # tsx --test over *.test.ts
```

From the repository root: `mise run //scraper:test`. `mise run //infrastructure:deploy-scraper` is a
human-only AWS deploy (it builds the bundles first); the Floci deploy below is allowed.

## Pipeline invariants

- **Hydrator** runs at 02:00 UTC and seeds `ROUTE#<route>#DATE#<date>` targets for the next 60 days
  with conditional writes. `HYDRATOR_FULL_SEED=1` backfills `due_key` on old rows; a full seed writes
  ~8,400 items against a 5 WCU table and can exceed the 15-minute timeout unless capacity is raised.
- **Poller** runs every 15 minutes. It queries each `ByDue` tier in NEAR → MID → FAR order
  (paginated, up to 5 pages per tier), up to 20 targets, makes two bestprice calls per target (first
  and second class) and reschedules each target. It uses the DB Navigator API (`dbnav`,
  `app.services-bahn.de`) through the configured DB proxy, not the bahn.de web API.
- `due_key` is `<tier rank>#<next_scrape_at>`; the index is `status` + `due_key`. Keep the prefix and
  the tier order when changing scheduling, otherwise near departures stop winning.
- Targets whose departure day has passed are deleted instead of scraped.
- TTD intervals are FAR (over 30 days) 16 d ± 2 d, MID (7–30 days) 8 d ± 1 d, NEAR (under 7 days)
  24 h ± 3 h. Keep jitter and the final-window clamp unless you re-measure DB load.
- **Compactor** runs at 03:00 UTC, merges the previous day's `batch_*` files into `daily_*`, verifies
  row counts and content fingerprints, then deletes the sources. Re-merging existing daily data
  makes retries safe.

## DB pacing and throttling

- The poller runs at 3.5 s between request starts with at most 2 in flight, in a batch of 20 targets
  (40 calls) every 15 minutes. That is about 1,920 scrapes a day against the ~1,654 the TTD intervals
  need, so the backlog drains.
- Raise `SCRAPER_BATCH_SIZE` only while the `transport` counters in the "Poller finished" log show
  zero `blocks` and no batch aborts. A few `directThrottled` retries are normal through the proxy;
  `TPM-Scraper-PollerThrottledByDb` fires when `blocks` is non-zero in two runs. `breakerOpened` is
  diagnostic and can also count consecutive 429s.
- The poller uses the same regional DB proxies and fingerprint rotation as the backend. On
  `DbThrottledError` it ends the batch and leaves the rest for the next run.
- Do not raise concurrency or reduce the gap to make a deadline; it gets the IP a longer ban.

## Packaging and data

- Bundles are `--format=esm`. AWS SDK packages are external (provided by the Node.js 24 runtime).
- The poller needs the CJS `require()` shim banner for `qs` → `object-inspect` calling
  `require('util')`. Removing it breaks the bundle at runtime.
- `src/routes.ts` derives 140 directed routes from `stations.json` at module load; there is no
  generation step. Extend coverage by editing `stations.json` (the T1/T2 station sets), then update
  `expected_route_count` in `../analytics/src/tpm_analytics/data/silver-config.json` and the station
  dimension in `../analytics/src/tpm_analytics/data/stations.json`.
- Parquet schema v2 adds columns and changes `transfers` semantics. Readers must branch on
  `schema_version`, not on file date. **V2 is one-way for the compactor:** before rolling back the
  scraper stack, purge or quarantine every `batch_*` **and** `daily_*` file that can contain v2
  rows. The pre-v2 compactor turns a v2 null fare into `0.00` and drops the v2 columns.

## Local development and operations

```bash
docker compose up -d floci
mise run //infrastructure:deploy-local-scraper
mise run //scraper:run-hydrator
mise run //scraper:run-poller
```

The local stack uses `scraper-data-local` and a 3-day lookahead. `CDK_SCRAPER_PAUSED=1` disables the
poller and hydrator schedules (the compactor stays on) and also disables the poller alarm actions, so
a deliberate pause never pages.

Update `README.md` for route, schema or scheduling changes, and
[docs/operations.md](../docs/operations.md) when a runbook changes.
