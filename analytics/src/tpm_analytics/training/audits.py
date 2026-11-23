"""Profile-only audits for the journey-identity change.

These queries answer the review questions that do not belong in the model matrix: route-day scrape
cadence, duplicate keys in one scrape, and how the v1 chains compare with the v2 ``journey_id``
sequence in the overlap. All of them are descriptive; none feeds a feature or a label.
"""

from __future__ import annotations

from typing import Any

import duckdb

from tpm_analytics.training.chains import build_chain_map
from tpm_analytics.training.identity import LINK_TOLERANCE_SECONDS, series_key_sql


def duplicate_audit(connection: duckdb.DuckDBPyConnection) -> dict[str, Any]:
    """Count same-scrape rows and the cross-sections that lose their 3-peer status after dedup."""
    row = connection.execute(
        """
        WITH pairs AS (
            SELECT series_key, observed_at, count(*) AS rows
            FROM base_sampled
            GROUP BY series_key, observed_at
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
            (SELECT sum(rows) FROM pairs),
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
        FROM duplicates
        """
    ).fetchone()
    if row is None:
        return {
            "rows": 0,
            "duplicate_groups": 0,
            "duplicate_rows": 0,
            "extra_duplicate_rows": 0,
            "duplicate_share": 0.0,
            "extra_duplicate_share": 0.0,
            "cross_sections_ge3": 0,
            "cross_sections_ge3_after_dedup": 0,
            "dependent_cross_sections": 0,
        }
    rows = int(row[0])
    duplicate_groups = int(row[1])
    duplicate_rows = int(row[2])
    extra_duplicate_rows = max(0, duplicate_rows - duplicate_groups)
    return {
        "rows": rows,
        "duplicate_groups": duplicate_groups,
        "duplicate_rows": duplicate_rows,
        "extra_duplicate_rows": extra_duplicate_rows,
        "duplicate_share": duplicate_rows / rows if rows else 0.0,
        "extra_duplicate_share": extra_duplicate_rows / rows if rows else 0.0,
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
                    WHEN date_diff('second', observed_at, departure_date + INTERVAL 12 HOUR) / 3600.0 <= 720
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
        ORDER BY era, CASE band WHEN '<7d' THEN 0 WHEN '7-30d' THEN 1 ELSE 2 END
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
    """Return the shared departure bounds of two splits."""
    rows = connection.execute(
        f"""
        SELECT min(departure_date), max(departure_date)
        FROM {source_sql}
        WHERE schema_version = 2
          AND journey_id IS NOT NULL
          AND fare_lowest_eur IS NOT NULL
          AND observed_at < departure_planned
        """
    ).fetchall()
    if not rows or rows[0][0] is None or rows[0][1] is None:
        return None
    return str(rows[0][0]), str(rows[0][1])


def v2_chain_audit(
    connection: duckdb.DuckDBPyConnection,
    source_sql: str,
    *,
    strict: bool = False,
) -> dict[str, Any] | None:
    """Compare v1 chains with v2 ``journey_id`` sequences on the true overlap cohort.

    The v2 id is stable across planned-time shifts and does not distinguish service class, so the
    comparison is per ``(journey_id, service_class)``. This is a **handover diagnostic**, not a
    link-precision check: v1 and v2 never share a scrape, so it cannot show whether a link is
    correct. The v2 id hashes the full vehicle itinerary, while the v1 series key includes arrival
    and transfers, so some splits and merges are itinerary granularity rather than identity errors.
    The breakdown separates parallel from sequential splits and same-itinerary from
    different-itinerary merges; a v2-internal ``journey_id`` precision/recall audit is scheduled for
    a later training stage once several weeks of v2 data exist.
    """
    bounds = _overlap_bounds(connection, source_sql)
    if bounds is None:
        return None
    start, end = bounds
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE v2audit_base AS
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
            fare_lowest_eur AS price_eur,
            load_factor_ordinal,
            {series_key_sql()} AS series_key
        FROM {source_sql}
        WHERE schema_version = 1
          AND fare_lowest_eur IS NOT NULL
          AND departure_date BETWEEN DATE '{start}' AND DATE '{end}'
          AND observed_at < departure_planned
        """
    )
    connection.execute(
        """
        CREATE OR REPLACE TEMP TABLE v2audit_grid AS
        SELECT DISTINCT route_id, departure_date, observed_at
        FROM v2audit_base
        """
    )
    chain_stats = build_chain_map(
        connection,
        base_view="v2audit_base",
        grid_view="v2audit_grid",
        prefix="v2audit",
        map_table="v2audit_map",
        strict=strict,
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE v2_journeys AS
        SELECT
            journey_id,
            service_class,
            route_id,
            train_number,
            departure_planned,
            departure_date,
            arrival_planned,
            transfers_actual,
            first_obs,
            {series_key_sql()} AS itinerary_key
        FROM (
            SELECT
                journey_id,
                service_class,
                route_id,
                train_number,
                departure_planned,
                departure_date,
                arrival_planned,
                transfers_actual,
                observed_at AS first_obs,
                row_number() OVER (
                    PARTITION BY journey_id, service_class ORDER BY observed_at
                ) AS rn
            FROM {source_sql}
            WHERE schema_version = 2
              AND journey_id IS NOT NULL
              AND fare_lowest_eur IS NOT NULL
              AND observed_at < departure_planned
        )
        WHERE rn = 1
        """
    )
    connection.execute(
        """
        CREATE OR REPLACE TEMP TABLE v2_candidates AS
        SELECT DISTINCT v.journey_id, v.service_class
        FROM v2_journeys v
        JOIN v2audit_series s
          ON s.route_id = v.route_id
         AND s.departure_date = v.departure_date
         AND s.service_class = v.service_class
         AND s.train_number IS NOT NULL
         AND v.train_number IS NOT NULL
         AND s.train_number = v.train_number
         AND s.last_obs < v.first_obs
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE v2_matches AS
        SELECT DISTINCT
            v.journey_id,
            v.service_class,
            m.chain_id,
            v.arrival_planned,
            v.transfers_actual,
            v.itinerary_key
        FROM v2_journeys v
        JOIN v2audit_series s
          ON s.route_id = v.route_id
         AND s.departure_date = v.departure_date
         AND s.service_class = v.service_class
         AND s.train_number IS NOT NULL
         AND v.train_number IS NOT NULL
         AND s.train_number = v.train_number
         AND abs(date_diff('second', s.last_departure, v.departure_planned)) <= {LINK_TOLERANCE_SECONDS}
         AND s.last_obs < v.first_obs
        JOIN v2audit_map m USING (series_key)
        """
    )
    connection.execute(
        """
        CREATE OR REPLACE TEMP TABLE v2_chain_windows AS
        SELECT m.chain_id, min(s.first_obs) AS first_obs, max(s.last_obs) AS last_obs
        FROM v2audit_series s
        JOIN v2audit_map m USING (series_key)
        GROUP BY m.chain_id
        """
    )
    totals = connection.execute(
        """
        WITH split_parallel AS (
            SELECT count(*) AS journeys
            FROM (
                SELECT a.journey_id, a.service_class
                FROM v2_matches a
                JOIN v2_matches b
                  ON a.journey_id = b.journey_id
                 AND a.service_class = b.service_class
                 AND a.chain_id < b.chain_id
                JOIN v2_chain_windows wa ON wa.chain_id = a.chain_id
                JOIN v2_chain_windows wb ON wb.chain_id = b.chain_id
                WHERE wa.first_obs <= wb.last_obs AND wb.first_obs <= wa.last_obs
                GROUP BY a.journey_id, a.service_class
            )
        ),
        merged_detail AS (
            SELECT
                chain_id,
                count(DISTINCT journey_id || '|' || CAST(service_class AS VARCHAR)) AS journeys,
                count(DISTINCT itinerary_key) AS itineraries
            FROM v2_matches
            GROUP BY chain_id
            HAVING count(DISTINCT journey_id || '|' || CAST(service_class AS VARCHAR)) > 1
        )
        SELECT
            (SELECT count(*) FROM v2_journeys) AS journeys,
            (SELECT count(*) FROM v2_candidates) AS overlap_journeys,
            (SELECT count(*) FROM (SELECT DISTINCT journey_id, service_class FROM v2_matches)) AS matched,
            (
                SELECT count(*) FROM (
                    SELECT journey_id, service_class
                    FROM v2_matches
                    GROUP BY journey_id, service_class
                    HAVING count(DISTINCT chain_id) > 1
                )
            ) AS split_journeys,
            (SELECT journeys FROM split_parallel) AS parallel_split_journeys,
            (SELECT count(DISTINCT chain_id) FROM v2_matches) AS matched_series,
            (SELECT count(*) FROM merged_detail) AS merged_series,
            (SELECT count(*) FROM merged_detail WHERE itineraries = 1) AS same_itinerary_merges
        """
    ).fetchone()
    if totals is None:
        return None
    (
        journeys,
        overlap_journeys,
        matched,
        split_journeys,
        parallel_split_journeys,
        matched_series,
        merged_series,
        same_itinerary_merges,
    ) = (int(value) for value in totals)
    no_v1_counterpart = journeys - overlap_journeys
    unmatched_overlap = overlap_journeys - matched
    return {
        "departure_window": [start, end],
        "strict": strict,
        "v1_series": chain_stats.series,
        "v1_linked_chains": chain_stats.chains,
        "v1_identities": chain_stats.identities,
        "v2_journeys": journeys,
        "no_v1_counterpart": no_v1_counterpart,
        "no_v1_counterpart_share": 0.0 if journeys == 0 else no_v1_counterpart / journeys,
        "overlap_journeys": overlap_journeys,
        "matched_journeys": matched,
        "unmatched_overlap": unmatched_overlap,
        "unmatched_share": 0.0 if overlap_journeys == 0 else unmatched_overlap / overlap_journeys,
        "split_journeys": split_journeys,
        "parallel_split_journeys": parallel_split_journeys,
        "sequential_split_journeys": split_journeys - parallel_split_journeys,
        "split_rate": 0.0 if matched == 0 else split_journeys / matched,
        "matched_series": matched_series,
        "merged_series": merged_series,
        "same_itinerary_merges": same_itinerary_merges,
        "different_itinerary_merges": merged_series - same_itinerary_merges,
        "merge_rate": 0.0 if matched_series == 0 else merged_series / matched_series,
    }
