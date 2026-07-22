"""Central configuration: filesystem paths and canonical SQL building blocks.

Keeping paths and the derived-column definitions in one module is what keeps the
notebooks DRY — every notebook and the mart builder consume the exact same
``prices`` view definition from here.
"""

from __future__ import annotations

from pathlib import Path

# ---------------------------------------------------------------------------
# Paths (resolved relative to this package, so they are independent of cwd)
# ---------------------------------------------------------------------------
PACKAGE_DIR: Path = Path(__file__).resolve().parent
STATS_DIR: Path = PACKAGE_DIR.parent
DATA_DIR: Path = STATS_DIR / "data" / "scraper"
MARTS_DIR: Path = STATS_DIR / "marts"

#: Glob matching every locally-synced daily compaction file.
DATA_GLOB: str = str(DATA_DIR / "daily_*.parquet")

# ---------------------------------------------------------------------------
# Domain constants
# ---------------------------------------------------------------------------
#: Lower-bound boundaries (in days-to-departure) for the booking-curve buckets.
#: Each observation is assigned to the greatest boundary <= its days_to_departure.
DTD_BUCKETS: tuple[int, ...] = (0, 1, 2, 3, 5, 7, 10, 14, 21, 30, 45, 60, 90)


def _dtd_bucket_case(column: str = "days_to_departure") -> str:
    """Build a CASE expression mapping ``days_to_departure`` onto DTD_BUCKETS."""
    # Pair each boundary with the next one to form half-open [lo, hi) ranges.
    lines: list[str] = []
    for lo, hi in zip(DTD_BUCKETS, DTD_BUCKETS[1:], strict=False):
        lines.append(f"WHEN {column} < {hi} THEN {lo}")
    lines.append(f"ELSE {DTD_BUCKETS[-1]}")
    body = "\n    ".join(lines)
    return f"CASE\n    {body}\n  END"


def prices_view_sql(glob: str = DATA_GLOB, *, view_name: str = "prices") -> str:
    """Return the canonical ``CREATE VIEW`` statement for the raw price feed.

    The view exposes every raw column plus reusable derived dimensions so that
    notebooks express analysis purely in SQL without repeating boilerplate.
    """
    # DuckDB string literal — escape embedded single quotes defensively.
    glob_literal = glob.replace("'", "''")
    return f"""
CREATE OR REPLACE VIEW {view_name} AS
SELECT
  observed_at,
  service_class,
  route_id,
  origin_eva,
  origin_name,
  dest_eva,
  dest_name,
  departure_planned,
  arrival_planned,
  train_type,
  train_number,
  transfers,
  duration_minutes,
  days_to_departure,
  fare_lowest_eur,
  load_factor,
  origin_name || ' \u2192 ' || dest_name AS route_label,
  CASE service_class WHEN 1 THEN '1st' WHEN 2 THEN '2nd'
       ELSE CAST(service_class AS VARCHAR) END AS class_label,
  COALESCE(load_factor, 'unknown') AS load_factor_norm,
  isodow(departure_planned) AS dep_isodow,
  dayname(departure_planned) AS dep_dayname,
  hour(departure_planned) AS dep_hour,
  date_trunc('day', departure_planned) AS departure_date,
  {_dtd_bucket_case()} AS dtd_bucket,
  CASE WHEN duration_minutes > 0
       THEN fare_lowest_eur / duration_minutes END AS price_per_min
FROM read_parquet('{glob_literal}', union_by_name = true)
""".strip()
