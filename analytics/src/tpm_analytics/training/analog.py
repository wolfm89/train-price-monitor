"""Analog-departure features: the same train on an earlier departure.

The analog is the same route, class and first-train number on ``D - k`` with a planned departure
within 15 minutes of the snapshot's time of day, observed at or before the snapshot time. The
price analog is the observation whose lead time is closest to the snapshot's within 12 hours; the
rise analog is the closest-lead observation whose own next-day point (20-28 h after its
observation, closest to +24 h) is also at or before the snapshot time.

Only observations at or before ``t`` are read, so the feature is exactly causal. The analog
route-days are read from the full silver source, not the sampled panel: the D-1 route-day is
usually not in the 5 % sample.
"""

import duckdb

from tpm_analytics.training.identity import SAME_SCRAPE_ORDER, berlin_local_sql, series_key_sql

ANALOG_LEAD_WINDOW_HOURS = 12
ANALOG_DEPARTURE_TOLERANCE_MINUTES = 15
ANALOG_NEXT_WINDOW_HOURS = (20, 28)
_KEYS = "series_key, snapshot_at, bin_regime, bin_index"


def analog_feature_names(offsets: tuple[int, ...]) -> tuple[str, ...]:
    """Return the four column names produced for each day offset."""
    names: list[str] = []
    for offset in offsets:
        names.extend(
            (
                f"analog_d{offset}_price_ratio",
                f"analog_d{offset}_lead_gap_h",
                f"analog_d{offset}_next_ratio",
                f"analog_d{offset}_rise_lead_gap_h",
            )
        )
    return tuple(names)


def _create_analog_source(
    connection: duckdb.DuckDBPyConnection,
    source_sql: str,
    snapshot_table: str,
    offsets: tuple[int, ...],
) -> None:
    """Materialise the unsampled silver observations for the snapshot's analog route-days."""
    route_days = " UNION ".join(
        f"SELECT route_id, departure_date - {offset} AS departure_date FROM {snapshot_table}" for offset in offsets
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE analog_source AS
        SELECT * FROM (
            SELECT
                observed_at,
                route_id,
                service_class,
                train_number,
                departure_planned,
                arrival_planned,
                transfers_actual,
                load_factor_ordinal,
                departure_date,
                fare_lowest_eur AS price_eur,
                date_diff('second', observed_at, departure_planned) / 3600.0 AS hours_to_departure,
                CAST(epoch({berlin_local_sql("departure_planned")}) AS BIGINT) % 86400 AS dep_second,
                {series_key_sql()} AS series_key
            FROM {source_sql}
            WHERE schema_version = 1
              AND fare_lowest_eur IS NOT NULL
              AND observed_at < departure_planned
              AND (route_id, departure_date) IN ({route_days})
        )
        QUALIFY row_number() OVER (
            PARTITION BY series_key, observed_at ORDER BY {SAME_SCRAPE_ORDER}
        ) = 1
        """
    )


def _create_offset_views(connection: duckdb.DuckDBPyConnection, snapshot_table: str, offset: int) -> None:
    """Create the candidate, price, next-day and rise tables for one offset."""
    lead_window = ANALOG_LEAD_WINDOW_HOURS
    tolerance_seconds = ANALOG_DEPARTURE_TOLERANCE_MINUTES * 60
    next_low, next_high = ANALOG_NEXT_WINDOW_HOURS
    # The same journey observed at or before t whose lead is within +-12 h of the snapshot's.
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE analog_d{offset}_cand AS
        SELECT
            s.series_key,
            s.snapshot_at,
            s.bin_regime,
            s.bin_index,
            s.route_id,
            s.service_class,
            s.departure_planned,
            CAST(epoch({berlin_local_sql("s.departure_planned")}) AS BIGINT) % 86400 AS snapshot_dep_second,
            a.observed_at AS analog_at,
            a.departure_planned AS analog_departure,
            a.train_number AS analog_train,
            a.series_key AS analog_series_key,
            a.dep_second AS analog_dep_second,
            a.price_eur AS analog_price,
            a.hours_to_departure - s.hours_to_departure AS lead_gap_h,
            LEAST(
                abs(a.dep_second - CAST(epoch({berlin_local_sql("s.departure_planned")}) AS BIGINT) % 86400),
                86400 - abs(a.dep_second - CAST(epoch({berlin_local_sql("s.departure_planned")}) AS BIGINT) % 86400)
            ) AS dep_second_gap
        FROM {snapshot_table} s
        JOIN analog_source a
          ON a.route_id = s.route_id
         AND a.service_class = s.service_class
         AND coalesce(a.train_number, '') = coalesce(s.train_number, '')
         AND a.departure_date = s.departure_date - {offset}
         AND LEAST(
                abs(a.dep_second - CAST(epoch({berlin_local_sql("s.departure_planned")}) AS BIGINT) % 86400),
                86400 - abs(a.dep_second - CAST(epoch({berlin_local_sql("s.departure_planned")}) AS BIGINT) % 86400)
             ) <= {tolerance_seconds}
         AND a.observed_at <= s.snapshot_at
         AND abs(a.hours_to_departure - s.hours_to_departure) <= {lead_window}
        """
    )
    # Closest lead, then the larger lead, then the closest circular departure time, lowest price,
    # then the analog's series key.
    tie_break = "abs(lead_gap_h), lead_gap_h DESC, dep_second_gap, analog_price, analog_series_key"
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE analog_d{offset}_price AS
        SELECT * EXCLUDE (rn)
        FROM (
            SELECT *, row_number() OVER (PARTITION BY {_KEYS} ORDER BY {tie_break}) AS rn
            FROM analog_d{offset}_cand
        )
        WHERE rn = 1
        """
    )
    # The analog's own next-day point: 20-28 h after its observation, closest to +24 h, at or
    # before the snapshot time. It must come from the analog journey, not another train. Two
    # equidistant scrapes keep the higher fare, matching the panel's same-scrape canonical row.
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE analog_d{offset}_next AS
        SELECT * EXCLUDE (rn)
        FROM (
            SELECT
                c.*,
                n.price_eur AS next_price,
                row_number() OVER (
                    PARTITION BY c.series_key, c.snapshot_at, c.bin_regime, c.bin_index,
                                 c.analog_at, c.analog_departure, c.analog_series_key
                    ORDER BY
                        abs(date_diff('second', c.analog_at + INTERVAL 24 HOUR, n.observed_at)),
                        n.observed_at,
                        n.price_eur DESC
                ) AS rn
            FROM analog_d{offset}_cand c
            JOIN analog_source n
              ON n.route_id = c.route_id
             AND n.service_class = c.service_class
             AND coalesce(n.train_number, '') = coalesce(c.analog_train, '')
             AND n.series_key = c.analog_series_key
             AND n.departure_planned = c.analog_departure
             AND n.observed_at BETWEEN c.analog_at + INTERVAL {next_low} HOUR
                                    AND c.analog_at + INTERVAL {next_high} HOUR
             AND n.observed_at <= c.snapshot_at
        )
        WHERE rn = 1
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE analog_d{offset}_rise AS
        SELECT * EXCLUDE (rn)
        FROM (
            SELECT *, row_number() OVER (PARTITION BY {_KEYS} ORDER BY {tie_break}) AS rn
            FROM analog_d{offset}_next
        )
        WHERE rn = 1
        """
    )


def create_analog_features(
    connection: duckdb.DuckDBPyConnection,
    source_sql: str,
    snapshot_table: str,
    offsets: tuple[int, ...],
) -> tuple[str, ...]:
    """Create ``analog_features`` keyed like the snapshot table and return its feature columns.

    ``snapshot_table`` must expose ``series_key``, ``snapshot_at``, ``bin_regime``, ``bin_index``,
    ``route_id``, ``service_class``, ``train_number``, ``departure_planned``, ``departure_date``,
    ``hours_to_departure`` and ``price_eur``.
    """
    if not offsets:
        return ()
    _create_analog_source(connection, source_sql, snapshot_table, offsets)
    select_parts: list[str] = [_KEYS]
    joins: list[str] = []
    columns: list[str] = []
    for offset in offsets:
        _create_offset_views(connection, snapshot_table, offset)
        select_parts.extend(
            (
                f"s.price_eur / price_d{offset}.analog_price AS analog_d{offset}_price_ratio",
                f"price_d{offset}.lead_gap_h AS analog_d{offset}_lead_gap_h",
                f"rise_d{offset}.next_price / rise_d{offset}.analog_price AS analog_d{offset}_next_ratio",
                f"rise_d{offset}.lead_gap_h AS analog_d{offset}_rise_lead_gap_h",
            )
        )
        joins.append(
            f"LEFT JOIN analog_d{offset}_price price_d{offset} USING ({_KEYS}) "
            f"LEFT JOIN analog_d{offset}_rise rise_d{offset} USING ({_KEYS})"
        )
        columns.extend(
            (
                f"analog_d{offset}_price_ratio",
                f"analog_d{offset}_lead_gap_h",
                f"analog_d{offset}_next_ratio",
                f"analog_d{offset}_rise_lead_gap_h",
            )
        )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE analog_features AS
        SELECT {", ".join(select_parts)}
        FROM {snapshot_table} s
        {" ".join(joins)}
        """
    )
    return tuple(columns)
