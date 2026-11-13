-- Collection throughput per observation day, derived from the Parquet data.
--
-- `target_scrapes` is the number of (run, route, departure date) triples, i.e.
-- one scrape of one route-day. The scheduler needs ~1,650/day; the pre-clamp
-- production rate was ~830.
--
--   stats/.venv/bin/python -c "import duckdb; duckdb.sql(open('scraper/queries/collection_throughput.sql').read()).show()"

WITH s AS (
  SELECT * FROM read_parquet(COALESCE(getvariable('coverage_path'), 'data/*.parquet'))
)
SELECT
  observed_at::DATE AS observation_day,
  count(DISTINCT observed_at) AS runs,
  count(*) AS rows_written,
  count(DISTINCT route_id || '|' || departure_planned::DATE || '|' || observed_at) AS target_scrapes,
  round(count(*) * 1.0 / count(DISTINCT observed_at)) AS rows_per_run
FROM s
GROUP BY 1
ORDER BY 1;
