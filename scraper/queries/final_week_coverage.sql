-- Final-week coverage of the collected price series.
--
-- The regression this measures: route-days whose last observation is 7-9 days
-- before departure, i.e. no sample inside the window a 24 h breach model needs.
--
-- Run after copying at least 8 days of partitions locally (see README.md):
--   stats/.venv/bin/python -c "import duckdb; duckdb.sql(open('scraper/queries/final_week_coverage.sql').read()).show()"
--
-- Override the input glob without editing this file:
--   SET VARIABLE coverage_path = 'some/other/*.parquet';   (before running)

WITH s AS (
  SELECT * FROM read_parquet(COALESCE(getvariable('coverage_path'), 'data/*.parquet'))
),
bounds AS (
  SELECT min(observed_at::DATE) AS first_day, max(observed_at::DATE) AS last_day FROM s
),
cells AS (
  SELECT
    route_id,
    departure_planned::DATE AS departure_date,
    min(days_to_departure) AS min_ttd,
    count(DISTINCT observed_at) AS scrapes
  FROM s
  GROUP BY 1, 2
)
SELECT
  c.departure_date,
  count(*) AS route_days,
  round(100.0 * count(*) FILTER (WHERE c.min_ttd <= 7) / count(*), 1) AS pct_final_week,
  round(100.0 * count(*) FILTER (WHERE c.min_ttd <= 1) / count(*), 1) AS pct_final_day,
  round(median(c.scrapes) FILTER (WHERE c.min_ttd <= 7), 1) AS median_scrapes_final_week
FROM cells c, bounds b
WHERE c.departure_date >= b.first_day + INTERVAL 7 DAY
  AND c.departure_date <= b.last_day
GROUP BY 1
ORDER BY 1;
