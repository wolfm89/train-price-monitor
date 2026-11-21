"""Profile-only audits for the journey-identity change.

These queries answer the review questions that do not belong in the model matrix: route-day scrape
cadence, duplicate keys in one scrape, and how the v1 chains compare with the v2 ``journey_id``
sequence in the overlap. All of them are descriptive; none feeds a feature or a label.
"""

from __future__ import annotations

from typing import Any

import duckdb

from tpm_analytics.training.chains import build_chain_map
from tpm_analytics.training.identity import series_key_sql
from tpm_analytics.training.sources import SourceSpec


def duplicate_audit(connection: duckdb.DuckDBPyConnection) -> dict[str, Any]:
    """Count same-scrape rows and the cross-sections that lose their 3-peer status after dedup."""
    row = connection.execute(
        """
        WITH pairs AS (
            SELECT series_key, observed_at, count(*) AS rows
            FROM base_sampled
            GROUP BY series_key, observed_at
        ),
        totals AS (
            SELECT count(*) AS rows FROM base_sampled
        ),
        duplicates AS (
            SELECT count(*) AS groups, coalesce(sum(rows), 0) AS rows
            FROM pairs
            WHERE rows > 1
        ),
        pre_cross AS (
            SELECT route_id, departure_date, service_class, observed_at, count(*) AS peers
            FROM base_sampled
            GROUP BY route_id, departure_date, service_class, observed_at
        ),
        post_cross AS (
            SELECT route_id, departure_date, service_class, observed_at, count(*) AS peers
            FROM dedup_candidates
            WHERE dedup_rank = 1
            GROUP BY route_id, departure_date, service_class, observed_at
        )
        SELECT
            totals.rows,
            duplicates.groups,
            duplicates.rows,
            (SELECT count(*) FROM pre_cross WHERE peers >= 3) AS pre_ge3,
            (SELECT count(*) FROM post_cross WHERE peers >= 3) AS post_ge3,
            (
                SELECT count(*)
                FROM pre_cross p
                LEFT JOIN post_cross q USING (route_id, departure_date, service_class, observed_at)
                WHERE p.peers >= 3 AND coalesce(q.peers, 0) < 3
            ) AS dependent
        FROM totals, duplicates
        """
    ).fetchone()
    if row is None:
        return {
            "rows": 0,
            "duplicate_groups": 0,
            "duplicate_rows": 0,
            "duplicate_share": 0.0,
            "cross_sections_ge3": 0,
            "cross_sections_ge3_after_dedup": 0,
            "dependent_cross_sections": 0,
        }
    rows = int(row[0])
    duplicate_rows = int(row[2])
    return {
        "rows": rows,
        "duplicate_groups": int(row[1]),
        "duplicate_rows": duplicate_rows,
        "duplicate_share": duplicate_rows / rows if rows else 0.0,
        "cross_sections_ge3": int(row[3]),
        "cross_sections_ge3_after_dedup": int(row[4]),
        "dependent_cross_sections": int(row[5]),
    }


def scrape_gap_audit(connection: duckdb.DuckDBPyConnection) -> list[dict[str, Any]]:
    """Median route-day scrape gap and the share without a scrape within 24 h (A3)."""
    rows = connection.execute(
        """
        WITH ordered AS (
            SELECT
                observation_era,
                observed_at,
                departure_date,
                lead(observed_at) OVER (
                    PARTITION BY route_id, departure_date ORDER BY observed_at
                ) AS next_observed_at
            FROM scrape_grid_all
        ),
        banded AS (
            SELECT
                observation_era AS era,
                CASE
                    WHEN date_diff('second', observed_at, departure_date + INTERVAL 12 HOUR) / 3600.0 < 168
                        THEN '<7d'
                    WHEN date_diff('second', observed_at, departure_date + INTERVAL 12 HOUR) / 3600.0 < 720
                        THEN '7-30d'
                    ELSE '>30d'
                END AS band,
                date_diff('second', observed_at, next_observed_at) / 3600.0 AS gap_h
            FROM ordered
        )
        SELECT
            era,
            band,
            count(*) AS scrapes,
            median(gap_h) AS median_gap_h,
            avg(CASE WHEN gap_h IS NULL OR gap_h > 24 THEN 1.0 ELSE 0.0 END) AS without_24h_share
        FROM banded
        GROUP BY era, band
        ORDER BY era, band
        """
    ).fetchall()
    return [
        {
            "era": str(row[0]),
            "band": str(row[1]),
            "scrapes": int(row[2]),
            "median_gap_h": None if row[3] is None else float(row[3]),
            "without_24h_share": None if row[4] is None else float(row[4]),
        }
        for row in rows
    ]


def _overlap_bounds(connection: duckdb.DuckDBPyConnection, source_sql: str) -> tuple[str, str] | None:
    row = connection.execute(
        f"""
        SELECT min(departure_date), max(departure_date)
        FROM {source_sql}
        WHERE schema_version = 2
          AND fare_lowest_eur IS NOT NULL
          AND observed_at < departure_planned
        """
    ).fetchone()
    if row is None or row[0] is None or row[1] is None:
        return None
    return str(row[0]), str(row[1])


def v2_chain_audit(
    connection: duckdb.DuckDBPyConnection,
    source: SourceSpec,
    source_sql: str,
) -> dict[str, Any] | None:
    """Compare v1 chains with v2 ``journey_id`` sequences on the overlap cohort.

    The v2 id is stable across planned-time shifts and does not distinguish service class, so the
    comparison is per ``(journey_id, service_class)``. A v2 sequence that matches several chains is
    a split; a chain that matches several v2 sequences is a merge.
    """
    bounds = _overlap_bounds(connection, source_sql)
    if bounds is None:
        return None
    start, end = bounds
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW v2audit_base AS
        SELECT
            observed_at,
            route_id,
            train_number,
            service_class,
            departure_planned,
            arrival_planned,
            departure_date,
            transfers_actual,
            observation_era,
            {series_key_sql()} AS series_key
        FROM {source_sql}
        WHERE schema_version = 1
          AND fare_lowest_eur IS NOT NULL
          AND departure_date BETWEEN DATE '{start}' AND DATE '{end}'
          AND observed_at < departure_planned
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW v2audit_grid AS
        SELECT DISTINCT route_id, departure_date, observed_at
        FROM {source_sql}
        WHERE schema_version = 1
          AND fare_lowest_eur IS NOT NULL
          AND departure_date BETWEEN DATE '{start}' AND DATE '{end}'
          AND observed_at < departure_planned
        """
    )
    chain_stats = build_chain_map(
        connection,
        base_view="v2audit_base",
        grid_view="v2audit_grid",
        prefix="v2audit",
        map_table="v2audit_map",
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE v2_journeys AS
        SELECT journey_id, service_class, route_id, train_number, departure_planned, departure_date, first_obs
        FROM (
            SELECT
                journey_id,
                service_class,
                route_id,
                train_number,
                departure_planned,
                departure_date,
                observed_at AS first_obs,
                row_number() OVER (
                    PARTITION BY journey_id, service_class ORDER BY observed_at
                ) AS rn
            FROM {source_sql}
            WHERE schema_version = 2
              AND fare_lowest_eur IS NOT NULL
              AND observed_at < departure_planned
        )
        WHERE rn = 1
        """
    )
    connection.execute(
        """
        CREATE OR REPLACE TEMP TABLE v2_matches AS
        SELECT DISTINCT v.journey_id, v.service_class, m.chain_id
        FROM v2_journeys v
        JOIN v2audit_series s
          ON s.route_id = v.route_id
         AND s.service_class = v.service_class
         AND s.train_number IS NOT DISTINCT FROM v.train_number
         AND abs(date_diff('second', s.departure_planned, v.departure_planned)) <= 900
         AND s.last_obs < v.first_obs
        JOIN v2audit_map m USING (series_key)
        """
    )
    totals = connection.execute(
        """
        SELECT
            (SELECT count(*) FROM v2_journeys) AS journeys,
            (SELECT count(*) FROM (SELECT DISTINCT journey_id, service_class FROM v2_matches)) AS matched,
            (
                SELECT count(*) FROM (
                    SELECT journey_id, service_class
                    FROM v2_matches
                    GROUP BY journey_id, service_class
                    HAVING count(DISTINCT chain_id) > 1
                )
            ) AS split_journeys,
            (
                SELECT count(*) FROM (
                    SELECT chain_id
                    FROM v2_matches
                    GROUP BY chain_id
                    HAVING count(DISTINCT journey_id || '|' || CAST(service_class AS VARCHAR)) > 1
                )
            ) AS merged_chains,
            (SELECT count(DISTINCT chain_id) FROM v2_matches) AS matched_chains
        """
    ).fetchone()
    if totals is None:
        return None
    journeys, matched, split_journeys, merged_chains, matched_chains = (int(value) for value in totals)
    return {
        "departure_window": [start, end],
        "v1_chains": chain_stats.chains,
        "v2_journeys": journeys,
        "matched_journeys": matched,
        "unmatched_share": 0.0 if journeys == 0 else 1.0 - matched / journeys,
        "split_journeys": split_journeys,
        "split_rate": 0.0 if matched == 0 else split_journeys / matched,
        "matched_chains": matched_chains,
        "merged_chains": merged_chains,
        "merge_rate": 0.0 if matched_chains == 0 else merged_chains / matched_chains,
    }
