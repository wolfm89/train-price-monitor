-- How close to departure the last observation sits, for departures just beyond
-- the end of the data window.
--
-- This is the direct signature of the scheduling regression: without the clamp,
-- a MID target scraped 8 days out is rescheduled past departure, so its last
-- observation stays at 7-9 days and the whole final week is unsampled.
--
-- Only departure dates within a few days after the last observed day are
-- reported; later ones are censored by the end of the data.
--
--   stats/.venv/bin/python -c "import duckdb; duckdb.sql(open('scraper/queries/last_observation_gap.sql').read()).show()"

WITH s AS (
  SELECT * FROM read_parquet(COALESCE(getvariable('coverage_path'), 'data/*.parquet'))
),
bounds AS (
  SELECT max(observed_at::DATE) AS last_day FROM s
),
cells AS (
  SELECT
    route_id,
    departure_planned::DATE AS departure_date,
    max(observed_at) AS last_observed_at
  FROM s
  GROUP BY 1, 2
),
gaps AS (
  SELECT
    departure_date,
    date_diff('hour', last_observed_at, departure_date::TIMESTAMP + INTERVAL 12 HOUR) AS gap_hours
  FROM cells
)
SELECT
  g.departure_date,
  count(*) AS route_days,
  round(100.0 * count(*) FILTER (WHERE gap_hours < 48) / count(*), 1) AS pct_lt_2d,
  round(100.0 * count(*) FILTER (WHERE gap_hours >= 48 AND gap_hours < 72) / count(*), 1) AS pct_2_3d,
  round(100.0 * count(*) FILTER (WHERE gap_hours >= 72 AND gap_hours < 168) / count(*), 1) AS pct_3_7d,
  round(100.0 * count(*) FILTER (WHERE gap_hours >= 168 AND gap_hours < 216) / count(*), 1) AS pct_7_9d,
  round(100.0 * count(*) FILTER (WHERE gap_hours >= 216) / count(*), 1) AS pct_ge_9d
FROM gaps g, bounds b
WHERE g.departure_date BETWEEN b.last_day AND b.last_day + INTERVAL 3 DAY
GROUP BY 1
ORDER BY 1;
