# Collection quality queries

Repeatable measurements for the scraper's near-departure coverage. Used as the
before/after evidence for the `next_scrape_at` clamp (P0.5 of the price-dataset
ML readiness plan).

## Parquet queries (DuckDB)

The `duckdb` package is already in `stats/.venv` (gitignored, not part of CI).
Copy at least eight days of partitions so every departure date has a complete
final week:

```bash
cd /path/to/train-price-monitor
BUCKET=scraperstack-scraperdata3c3ebe1a-so7ufvhfsa5u
rm -rf /tmp/tpm-prices && mkdir -p /tmp/tpm-prices
aws s3 cp --recursive "s3://$BUCKET/prices/" /tmp/tpm-prices/

stats/.venv/bin/python - <<'PY'
import duckdb
duckdb.sql("SET VARIABLE coverage_path = '/tmp/tpm-prices/prices/**/*.parquet'")
for name in ('final_week_coverage', 'collection_throughput', 'last_observation_gap'):
    print(f"\n== {name} ==")
    duckdb.sql(open(f'scraper/queries/{name}.sql').read()).show()
PY
```

`final_week_coverage` only reports departure dates with at least seven days of
data behind them, so a short copy does not produce misleading 0 % rows.
`last_observation_gap` reports the four days after the last observed day, where
the gap between the last sample and departure is measurable rather than censored.

## CloudWatch Logs Insights

Log group: `ScraperStack-PollerLogs*`. Adjust the range to the period under test.

Targets selected per day (the scheduler's actual demand):

```
fields targets
| filter message = "Poller started"
| stats count() as runs, avg(targets) as avg_targets, sum(targets) as total_targets by bin(1d)
```

Expired targets deleted without a scrape:

```
fields expiredRemoved
| filter message = "Poller started"
| stats sum(expiredRemoved) as expired, sum(targets) as targets by bin(1d)
```

Tier mix of successful scrapes:

```
fields newTier
| filter message = "Target scraped"
| stats count() as n by newTier, bin(1d)
```

Transport health (must stay clean after the clamp doubles the call volume):

```
fields transport.directOk, transport.directThrottled, transport.failed, transport.breakerOpened
| filter message = "Poller finished"
| stats avg(transport.directOk) as ok, avg(transport.directThrottled) as throttled,
        avg(transport.failed) as failed, avg(transport.breakerOpened) as breaker by bin(1d)
```

## Reading the numbers

Measured on 2026-11-13 over the seven daily partitions 6–12 Nov, before the clamp:

| Metric                                                         | Before    | Target                                   |
| -------------------------------------------------------------- | --------- | ---------------------------------------- |
| target-scrapes / day                                           | 830–1,000 | >= 1,400 (design ~1,654, capacity 2,400) |
| `expiredRemoved` / day                                         | ~137      | <= 5                                     |
| route-days departing +1 d whose last observation is < 2 d old  | 18 %      | >= 60 %                                  |
| route-days departing +2 d whose last observation is 7–9 d old  | 62 %      | <= 10 %                                  |
| route-days departing +3 d whose last observation is >= 7 d old | 94 %      | <= 10 %                                  |
