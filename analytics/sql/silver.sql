-- Bronze Parquet → silver Parquet.
--
-- The three placeholders are substituted by tpm_analytics.silver.build before execution:
--   {{BRONZE_SOURCE}}  table expression over the bronze glob (adds missing v2 columns as NULL)
--   {{STATIONS_PATH}}  station dimension JSON
--   {{TARGET}}         output directory for this build
--
-- One row in, one row out: the transform never filters. Every derived column is documented in
-- analytics/README.md and asserted by tpm_analytics.silver.quality.

COPY (
    WITH bronze AS (
        SELECT * FROM {{BRONZE_SOURCE}}
    ),

    stations_raw AS (
        SELECT unnest(stations) AS station
        FROM read_json_auto('{{STATIONS_PATH}}')
    ),

    stations AS (
        SELECT
            station.eva::VARCHAR AS eva,
            station.lat::DOUBLE AS lat,
            station.lon::DOUBLE AS lon,
            station.state::VARCHAR AS state,
            station.category::INTEGER AS category
        FROM stations_raw
    ),

    -- Scrapes are keyed by route and departure day; every row of that pair shares the count.
    route_day_density AS (
        SELECT
            route_id,
            CAST(departure_planned AS DATE) AS departure_date,
            COUNT(DISTINCT observed_at) AS scrapes_per_route_day
        FROM bronze
        GROUP BY route_id, departure_date
    ),

    normalised AS (
        SELECT
            b.* EXCLUDE (schema_version),
            COALESCE(b.schema_version, 1) AS schema_version
        FROM bronze b
    ),

    enriched AS (
        SELECT
            n.*,
            -- v1 counted every vehicle leg, footways included, so it is always even.
            CAST(CASE WHEN n.schema_version = 1 THEN n.transfers // 2 ELSE n.transfers END AS INTEGER)
                AS transfers_actual,
            COALESCE(
                n.load_factor_ordinal,
                CASE n.load_factor
                    WHEN 'low' THEN 1
                    WHEN 'low-to-medium' THEN 1
                    WHEN 'high' THEN 2
                    WHEN 'very-high' THEN 3
                    WHEN 'exceptionally-high' THEN 4
                END
            ) AS load_factor_ordinal_filled,
            CAST(n.departure_planned AS DATE) AS departure_date,
            CAST(dayofweek(n.departure_planned) AS INTEGER) AS departure_weekday,
            CAST(
                EXTRACT(hour FROM timezone('Europe/Berlin', n.departure_planned AT TIME ZONE 'UTC'))
                AS INTEGER
            ) AS departure_hour_local,
            o.lat AS origin_lat,
            o.lon AS origin_lon,
            o.state AS origin_state,
            o.category AS origin_station_category,
            d.lat AS dest_lat,
            d.lon AS dest_lon,
            d.state AS dest_state,
            d.category AS dest_station_category
        FROM normalised n
        LEFT JOIN stations o ON o.eva = n.origin_eva
        LEFT JOIN stations d ON d.eva = n.dest_eva
    )

    SELECT
        observed_at,
        service_class,
        enriched.route_id,
        origin_eva,
        origin_name,
        dest_eva,
        dest_name,
        departure_planned,
        arrival_planned,
        train_type,
        train_number,
        train_numbers,
        transfers,
        duration_minutes,
        days_to_departure,
        fare_lowest_eur,
        load_factor,
        load_factor_ordinal_filled AS load_factor_ordinal,
        journey_id,
        schema_version,
        source_profile,
        query_mode,
        transfers_actual,
        enriched.departure_date,
        departure_weekday,
        departure_hour_local,
        departure_weekday IN (0, 6) AS is_weekend,
        2 * 6371.0088 * asin(
            sqrt(
                pow(sin(radians(dest_lat - origin_lat) / 2), 2)
                + cos(radians(origin_lat))
                  * cos(radians(dest_lat))
                  * pow(sin(radians(dest_lon - origin_lon) / 2), 2)
            )
        ) AS distance_km,
        origin_state,
        dest_state,
        origin_station_category,
        dest_station_category,
        CASE
            WHEN departure_planned < TIMESTAMP '2026-12-13 00:00:00' THEN '2025-12'
            ELSE '2026-12'
        END AS timetable_period,
        CASE
            WHEN observed_at < TIMESTAMP '2026-09-01 00:00:00' THEN 'dense'
            WHEN observed_at < TIMESTAMP '2026-11-13 18:00:00' THEN 'sparse'
            ELSE 'post-fix'
        END AS observation_era,
        density.scrapes_per_route_day,
        CAST(EXTRACT(year FROM enriched.departure_date) AS INTEGER) AS departure_year,
        CAST(EXTRACT(month FROM enriched.departure_date) AS INTEGER) AS departure_month
    FROM enriched
    LEFT JOIN route_day_density density
        ON density.route_id = enriched.route_id
       AND density.departure_date = enriched.departure_date
) TO '{{TARGET}}' (
    FORMAT parquet,
    PARTITION_BY (departure_year, departure_month),
    COMPRESSION zstd
);
