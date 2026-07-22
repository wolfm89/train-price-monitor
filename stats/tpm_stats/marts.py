"""Build small pre-aggregated marts for fast dashboards and future publishing.

Run via ``mise run //stats:marts`` (or ``python -m tpm_stats.marts``).

The marts are derived from the same canonical ``prices`` view used by the
notebooks, so aggregation logic never diverges from exploration logic. Each
mart is written to ``marts/mart_<name>.parquet`` and is tiny (KBs–few MB),
which keeps the up-to-a-year scope instant and stays browser-friendly for a
later WASM publish.
"""

from __future__ import annotations

import logging

from .config import MARTS_DIR
from .db import get_connection

logger = logging.getLogger("tpm_stats.marts")

#: name -> SELECT statement (each grouped to a small, dashboard-ready grain).
MART_QUERIES: dict[str, str] = {
    # Booking curve: fare statistics by route/class/train type across lead-time buckets.
    "booking_curve": """
        SELECT
          route_id,
          any_value(route_label)      AS route_label,
          service_class,
          any_value(class_label)      AS class_label,
          train_type,
          dtd_bucket,
          count(*)                    AS n_obs,
          min(fare_lowest_eur)        AS min_fare,
          quantile_cont(fare_lowest_eur, 0.5) AS median_fare,
          avg(fare_lowest_eur)        AS avg_fare,
          max(fare_lowest_eur)        AS max_fare
        FROM prices
        GROUP BY route_id, service_class, train_type, dtd_bucket
    """,
    # Route comparison: value metrics per route/class/train type.
    "route_comparison": """
        SELECT
          route_id,
          any_value(route_label)      AS route_label,
          service_class,
          any_value(class_label)      AS class_label,
          train_type,
          count(*)                    AS n_obs,
          min(fare_lowest_eur)        AS min_fare,
          quantile_cont(fare_lowest_eur, 0.5) AS median_fare,
          avg(fare_lowest_eur)        AS avg_fare,
          avg(duration_minutes)       AS avg_duration_min,
          avg(transfers)              AS avg_transfers,
          avg(price_per_min)          AS avg_price_per_min
        FROM prices
        GROUP BY route_id, service_class, train_type
    """,
    # Demand: fare vs capacity load factor and lead time.
    "demand_load": """
        SELECT
          load_factor_norm,
          service_class,
          any_value(class_label)      AS class_label,
          dtd_bucket,
          count(*)                    AS n_obs,
          avg(fare_lowest_eur)        AS avg_fare,
          quantile_cont(fare_lowest_eur, 0.5) AS median_fare
        FROM prices
        GROUP BY load_factor_norm, service_class, dtd_bucket
    """,
    # Temporal: fare by departure day-of-week and hour-of-day.
    "temporal": """
        SELECT
          dep_isodow,
          any_value(dep_dayname)      AS dep_dayname,
          dep_hour,
          service_class,
          any_value(class_label)      AS class_label,
          count(*)                    AS n_obs,
          avg(fare_lowest_eur)        AS avg_fare,
          quantile_cont(fare_lowest_eur, 0.5) AS median_fare
        FROM prices
        GROUP BY dep_isodow, dep_hour, service_class
    """,
}


def build_marts() -> list[str]:
    """Materialise every mart to ``marts/mart_<name>.parquet``. Returns paths."""
    MARTS_DIR.mkdir(parents=True, exist_ok=True)
    conn = get_connection(attach_marts=False)
    written: list[str] = []
    for name, select_sql in MART_QUERIES.items():
        out = MARTS_DIR / f"mart_{name}.parquet"
        literal = str(out).replace("'", "''")
        conn.execute(f"COPY ({select_sql}) TO '{literal}' (FORMAT PARQUET)")
        rows = conn.execute(f"SELECT count(*) FROM read_parquet('{literal}')").fetchone()[0]
        logger.info("wrote %s (%s rows)", out.name, rows)
        written.append(str(out))
    return written


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    paths = build_marts()
    logger.info("Built %d marts in %s", len(paths), MARTS_DIR)


if __name__ == "__main__":
    main()
