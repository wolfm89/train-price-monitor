"""Build the training panel and write one Parquet file per split.

The pipeline stays in SQL until the model matrix: DuckDB handles the 100M-row scan, the exact
forward-looking label window (a numeric ``RANGE`` frame over epoch hours), the route-day
cross-section and the calendar join. Every step is a view so DuckDB can keep the plan lazy.
"""

from __future__ import annotations

import hashlib
import json
import platform
import subprocess
import time
from dataclasses import asdict, dataclass, field, replace
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

import duckdb

from tpm_analytics import calendar
from tpm_analytics.silver._duck import read_parquet, sql_string
from tpm_analytics.training.bands import JOURNEY_BANDS, ttd_band_case
from tpm_analytics.training.config import TrainingConfig
from tpm_analytics.training.features import AUDIT_COLUMNS, feature_spec
from tpm_analytics.training.sources import SourceSpec


class DatasetError(RuntimeError):
    """The dataset cannot be built from this source or configuration."""


@dataclass(frozen=True)
class SplitStats:
    split: str
    rows: int
    series: int
    route_days: int
    labelled: int
    positives: int
    positive_rate: float


@dataclass(frozen=True)
class DatasetStats:
    run_id: str
    rows: int
    labelled_rows: int
    series: int
    route_days: int
    splits: tuple[SplitStats, ...]
    duration_seconds: float
    warnings: tuple[str, ...] = ()
    profile: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["splits"] = [asdict(item) for item in self.splits]
        return payload


def _hash_bucket(expression: str, buckets: int) -> str:
    """Return a stable bucket for ``expression``: the first 8 SHA-256 hex digits modulo ``buckets``."""
    return f"CAST((('0x' || substr(sha256({expression}), 1, 8))::UBIGINT % {buckets}) AS INTEGER)"


def _headroom_case(column: str, grid: tuple[int, ...]) -> str:
    whens = " ".join(f"WHEN {index} THEN {value}" for index, value in enumerate(grid))
    return f"CASE {column} {whens} END"


def _scalar(connection: duckdb.DuckDBPyConnection, sql: str) -> int:
    row = connection.execute(sql).fetchone()
    if row is None:
        raise DatasetError(f"query returned no row: {sql[:80]}")
    return int(row[0])


def _source_count(connection: duckdb.DuckDBPyConnection, source_sql: str) -> int:
    return _scalar(connection, f"SELECT count(*) FROM {source_sql}")


def _dict_rows(connection: duckdb.DuckDBPyConnection, sql: str) -> list[dict[str, Any]]:
    cursor = connection.execute(sql)
    columns = [item[0] for item in cursor.description or []]
    return [dict(zip(columns, row, strict=True)) for row in cursor.fetchall()]


def _git_state() -> tuple[str | None, bool]:
    """Return the checkout's HEAD and dirty flag.

    ``git status`` runs at the repository root, so a change in any module marks the run dirty.
    The flag is conservative: a clean flag means the whole checkout matches HEAD, and a
    false-positive dirty flag is preferred over claiming provenance the run cannot prove.
    Unknown git state (a wheel outside a checkout) is returned as ``(None, False)``.
    """
    root = Path(__file__).resolve().parents[3]
    try:
        sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
        dirty = bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=root, text=True).strip())
        return sha or None, dirty
    except OSError, subprocess.CalledProcessError:
        return None, False


def _lock_sha256() -> str | None:
    """Hash the repository lockfile; ``None`` when the package runs outside a source checkout."""
    path = Path(__file__).resolve().parents[3] / "uv.lock"
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def _package_versions() -> dict[str, str | None]:
    names = ("numpy", "scikit-learn", "scipy", "pyarrow", "joblib")
    result: dict[str, str | None] = {"python": platform.python_version(), "duckdb": duckdb.__version__}
    for name in names:
        try:
            result[name.replace("-", "_")] = version(name)
        except PackageNotFoundError:
            result[name.replace("-", "_")] = None
    return result


def _duckdb_settings(connection: duckdb.DuckDBPyConnection) -> dict[str, str | None]:
    """Record the effective DuckDB limits so an out-of-memory build is diagnosable."""
    settings: dict[str, str | None] = {}
    for name in ("memory_limit", "max_temp_directory_size", "threads"):
        try:
            row = connection.execute(f"SELECT current_setting('{name}')").fetchone()
        except duckdb.Error:
            settings[name] = None
        else:
            settings[name] = None if row is None else str(row[0])
    return settings


def _content_digest(connection: duckdb.DuckDBPyConnection, split: str, columns: tuple[str, ...]) -> dict[str, Any]:
    """Return an order-independent digest for one split.

    Each row is hashed over all output columns and reduced to its first 64 bits. The row count,
    the sum and the XOR of those values identify the split's content regardless of file order,
    while the Parquet byte hash in ``dataset_files`` still pins the physical layout.
    """
    payload = ", ".join(f"coalesce(CAST({column} AS VARCHAR), '<null>')" for column in columns)
    hash_expression = f"CAST(('0x' || substr(sha256(concat_ws('|', {payload})), 1, 16)) AS UBIGINT)"
    row = connection.execute(
        f"SELECT count(*), sum({hash_expression}), bit_xor({hash_expression}) FROM sampled WHERE split = '{split}'"
    ).fetchone()
    if row is None:
        raise DatasetError(f"no content digest for split {split}")
    return {
        "rows": int(row[0]),
        "sum64": int(row[1] or 0),
        "xor64": int(row[2] or 0),
    }


def _final_columns(calendar_set: str) -> tuple[str, ...]:
    spec = feature_spec(calendar_set)
    return tuple(dict.fromkeys((*AUDIT_COLUMNS, *spec.names)))


def _create_views(
    connection: duckdb.DuckDBPyConnection,
    source_sql: str,
    config: TrainingConfig,
    calendar_set: str,
) -> None:
    splits = config.splits
    label = config.label
    resample = config.resample
    grid = label.headroom_pct
    bucket_expr = _hash_bucket("concat_ws('|', series_key, CAST(observed_at AS VARCHAR))", len(grid))
    headroom_expr = _headroom_case("bucket", grid)
    route_day_hash_expr = _hash_bucket(
        f"concat_ws('|', {config.sample.seed}, route_id, CAST(departure_date AS VARCHAR))", 10000
    )

    connection.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW base_all AS
        SELECT
            observed_at,
            observed_at AS snapshot_at,
            service_class,
            route_id,
            train_number,
            departure_planned,
            arrival_planned,
            departure_date,
            departure_weekday,
            departure_hour_local,
            duration_minutes,
            transfers_actual,
            load_factor_ordinal,
            fare_lowest_eur AS price_eur,
            distance_km,
            origin_state,
            dest_state,
            origin_station_category,
            dest_station_category,
            train_type,
            observation_era,
            scrapes_per_route_day_final,
            schema_version,
            journey_id,
            'v1:' || sha256(concat_ws('|',
                route_id,
                coalesce(train_number, ''),
                service_class,
                CAST(epoch(departure_planned) / 900 AS BIGINT),
                CAST(epoch(arrival_planned) / 900 AS BIGINT),
                coalesce(transfers_actual, -1)
            )) AS series_key,
            date_diff('second', observed_at, departure_planned) / 3600.0 AS hours_to_departure,
            {route_day_hash_expr} AS route_day_hash
        FROM {source_sql}
        WHERE fare_lowest_eur IS NOT NULL
          AND departure_date <= DATE '{splits.test_end.isoformat()}'
          AND observed_at < departure_planned
        """
    )
    v2_rows = _scalar(
        connection,
        f"""
        SELECT count(*) FROM {source_sql}
        WHERE fare_lowest_eur IS NOT NULL
          AND observed_at < departure_planned
          AND (
            departure_date <= DATE '{splits.train_end.isoformat()}'
            OR departure_date BETWEEN DATE '{splits.validation_select_start.isoformat()}'
                AND DATE '{splits.validation_select_end.isoformat()}'
            OR departure_date BETWEEN DATE '{splits.validation_calibrate_start.isoformat()}'
                AND DATE '{splits.validation_calibrate_end.isoformat()}'
            OR departure_date BETWEEN DATE '{splits.test_start.isoformat()}'
                AND DATE '{splits.test_end.isoformat()}'
          )
          AND (schema_version != 1 OR journey_id IS NOT NULL)
        """,
    )
    if v2_rows:
        raise DatasetError(f"{v2_rows} v2 rows fall inside the baseline splits; this baseline is v1-only")
    threshold = max(1, round(config.sample.sample_rate * 10000))
    if config.sample.max_route_days is None:
        connection.execute(
            f"CREATE OR REPLACE TEMP VIEW base_sampled AS SELECT * FROM base_all WHERE route_day_hash < {threshold}"
        )
    else:
        connection.execute(
            f"CREATE OR REPLACE TEMP VIEW selected_route_days AS "
            f"SELECT route_id, departure_date, route_day_hash FROM ("
            f"SELECT DISTINCT route_id, departure_date, route_day_hash FROM base_all "
            f"WHERE route_day_hash < {threshold}"
            f") ORDER BY route_day_hash, route_id, departure_date LIMIT {config.sample.max_route_days}"
        )
        connection.execute(
            "CREATE OR REPLACE TEMP VIEW base_sampled AS "
            "SELECT b.* FROM base_all b JOIN selected_route_days s "
            "USING (route_id, departure_date)"
        )
    connection.execute(
        """
        CREATE OR REPLACE TEMP VIEW scrape_grid AS
        SELECT DISTINCT route_id, departure_date, observed_at
        FROM base_sampled
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW scrape_grid_all AS
        SELECT DISTINCT route_id, departure_date, observed_at
        FROM {source_sql}
        WHERE departure_date <= DATE '{config.splits.test_end.isoformat()}'
          AND observed_at < departure_planned
          AND schema_version = 1
        """
    )
    connection.execute(
        """
        CREATE OR REPLACE TEMP VIEW cross_section AS
        SELECT
            *,
            CASE
                WHEN count(*) OVER (
                    PARTITION BY route_id, departure_date, service_class, observed_at
                ) >= 3
                THEN percent_rank() OVER (
                    PARTITION BY route_id, departure_date, service_class, observed_at
                    ORDER BY price_eur
                )
            END AS price_rank_route_day
        FROM base_sampled
        """
    )
    connection.execute(
        """
        CREATE OR REPLACE TEMP VIEW dedup_candidates AS
        SELECT
            *,
            row_number() OVER (
                PARTITION BY series_key, observed_at
                ORDER BY price_eur DESC, load_factor_ordinal DESC NULLS LAST,
                         train_number, departure_planned, arrival_planned, transfers_actual
            ) AS dedup_rank
        FROM base_sampled
        """
    )
    connection.execute(
        """
        CREATE OR REPLACE TEMP VIEW dedup AS
        SELECT series_key, observed_at, price_eur, load_factor_ordinal
        FROM dedup_candidates
        WHERE dedup_rank = 1
        """
    )
    connection.execute(
        """
        CREATE OR REPLACE TEMP VIEW history AS
        SELECT series_key, observed_at, price_eur, load_factor_ordinal
        FROM dedup
        """
    )
    connection.execute(
        """
        CREATE OR REPLACE TEMP VIEW raw_features AS
        SELECT
            *,
            price_eur - min(price_eur) OVER (
                PARTITION BY series_key ORDER BY observed_at
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ) AS price_vs_series_min,
            price_eur / median(price_eur) OVER (
                PARTITION BY series_key ORDER BY observed_at
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ) AS price_vs_series_median,
            min(price_eur) OVER (
                PARTITION BY series_key ORDER BY epoch(observed_at) / 3600.0
                RANGE BETWEEN 168 PRECEDING AND CURRENT ROW
            ) AS price_min_7d,
            max(price_eur) OVER (
                PARTITION BY series_key ORDER BY epoch(observed_at) / 3600.0
                RANGE BETWEEN 168 PRECEDING AND CURRENT ROW
            ) AS price_max_7d,
            date_diff('second', min(observed_at) OVER (PARTITION BY series_key), observed_at) / 3600.0
                AS history_depth_h
        FROM dedup
        """
    )
    # Start the label window an epsilon after the snapshot so a row never contributes to its own
    # label; duplicate timestamps are already collapsed by dedup, so any positive offset works.
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW future AS
        SELECT
            series_key,
            observed_at,
            max(price_eur) OVER (
                PARTITION BY series_key
                ORDER BY epoch(observed_at) / 3600.0
                RANGE BETWEEN 0.000001 FOLLOWING AND {label.horizon_hours} FOLLOWING
            ) AS future_max_fare_24h,
            count(*) OVER (
                PARTITION BY series_key
                ORDER BY epoch(observed_at) / 3600.0
                RANGE BETWEEN 0.000001 FOLLOWING AND {label.horizon_hours} FOLLOWING
            ) AS future_observations,
            max(observed_at) OVER (
                PARTITION BY series_key
                ORDER BY epoch(observed_at) / 3600.0
                RANGE BETWEEN 0.000001 FOLLOWING AND {label.horizon_hours} FOLLOWING
            ) AS future_last_observed_at
        FROM dedup
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW resampled AS
        SELECT
            *,
            CASE WHEN hours_to_departure > {resample.outer_threshold_hours} THEN '12h' ELSE '1h' END
                AS bin_regime,
            CASE
                WHEN hours_to_departure > {resample.outer_threshold_hours}
                    THEN CAST(floor(hours_to_departure / {resample.outer_bin_hours}) AS BIGINT)
                ELSE CAST(floor(hours_to_departure / {resample.inner_bin_hours}) AS BIGINT)
            END AS bin_index,
            CASE WHEN hours_to_departure > {resample.outer_threshold_hours}
                THEN {resample.outer_bin_hours} ELSE {resample.inner_bin_hours} END AS bin_width_hours,
            row_number() OVER (
                PARTITION BY
                    series_key,
                    CASE WHEN hours_to_departure > {resample.outer_threshold_hours} THEN '12h' ELSE '1h' END,
                    CASE
                        WHEN hours_to_departure > {resample.outer_threshold_hours}
                            THEN floor(hours_to_departure / {resample.outer_bin_hours})
                        ELSE floor(hours_to_departure / {resample.inner_bin_hours})
                    END
                ORDER BY observed_at DESC, price_eur DESC, load_factor_ordinal DESC NULLS LAST,
                         train_number DESC, departure_planned DESC, arrival_planned DESC,
                         transfers_actual DESC NULLS LAST
            ) AS rn
        FROM cross_section
        """
    )
    connection.execute(
        """
        CREATE OR REPLACE TEMP TABLE snapshot AS
        SELECT
            r.* EXCLUDE (rn),
            f.future_max_fare_24h,
            f.future_observations,
            f.future_last_observed_at,
            (f.future_max_fare_24h IS NOT NULL) AS label_observed
        FROM resampled r
        LEFT JOIN future f USING (series_key, observed_at)
        WHERE r.rn = 1
        """
    )
    # One superset join against the route-day scrape grid; every check window is a filtered pick
    # from these candidates, so the grid is joined once instead of four times (R2-1).
    connection.execute(
        """
        CREATE OR REPLACE TEMP TABLE check_candidates AS
        SELECT
            n.series_key,
            n.snapshot_at,
            g.observed_at AS check_at,
            abs(date_diff('microsecond', n.snapshot_at + INTERVAL 24 HOUR, g.observed_at)) AS distance_us
        FROM snapshot n
        JOIN scrape_grid g
          ON g.route_id = n.route_id
         AND g.departure_date = n.departure_date
        WHERE g.observed_at BETWEEN n.snapshot_at + INTERVAL 20 HOUR
                                AND n.snapshot_at + INTERVAL 28 HOUR
          AND g.observed_at < n.departure_planned
        """
    )
    # The 20-24 h point stays the crossed-back diagnostic. The lower bound is already 20 h.
    connection.execute(
        """
        CREATE OR REPLACE TEMP TABLE check_points AS
        SELECT
            series_key,
            snapshot_at,
            check_at,
            date_diff('second', snapshot_at + INTERVAL 24 HOUR, check_at) / 3600.0 AS check_lag_h
        FROM (
            SELECT *, row_number() OVER (
                PARTITION BY series_key, snapshot_at ORDER BY distance_us, check_at
            ) AS rn
            FROM check_candidates
            WHERE check_at <= snapshot_at + INTERVAL 24 HOUR
        )
        WHERE rn = 1
        """
    )
    connection.execute(
        """
        CREATE OR REPLACE TEMP TABLE check_points_narrow AS
        SELECT
            series_key,
            snapshot_at,
            check_at,
            date_diff('second', snapshot_at + INTERVAL 24 HOUR, check_at) / 3600.0 AS check_lag_h
        FROM (
            SELECT *, row_number() OVER (
                PARTITION BY series_key, snapshot_at ORDER BY distance_us, check_at
            ) AS rn
            FROM check_candidates
            WHERE check_at BETWEEN snapshot_at + INTERVAL 22 HOUR
                               AND snapshot_at + INTERVAL 24 HOUR
        )
        WHERE rn = 1
        """
    )
    connection.execute(
        """
        CREATE OR REPLACE TEMP TABLE check_points_2028 AS
        SELECT
            series_key,
            snapshot_at,
            check_at,
            date_diff('second', snapshot_at + INTERVAL 24 HOUR, check_at) / 3600.0 AS check_lag_h
        FROM (
            SELECT *, row_number() OVER (
                PARTITION BY series_key, snapshot_at ORDER BY distance_us, check_at
            ) AS rn
            FROM check_candidates
        )
        WHERE rn = 1
        """
    )
    connection.execute(
        """
        CREATE OR REPLACE TEMP TABLE check_points_2226 AS
        SELECT
            series_key,
            snapshot_at,
            check_at,
            date_diff('second', snapshot_at + INTERVAL 24 HOUR, check_at) / 3600.0 AS check_lag_h
        FROM (
            SELECT *, row_number() OVER (
                PARTITION BY series_key, snapshot_at ORDER BY distance_us, check_at
            ) AS rn
            FROM check_candidates
            WHERE check_at BETWEEN snapshot_at + INTERVAL 22 HOUR
                               AND snapshot_at + INTERVAL 26 HOUR
        )
        WHERE rn = 1
        """
    )
    # Price each distinct (series, check) once; the four windows share most check points.
    connection.execute(
        """
        CREATE OR REPLACE TEMP TABLE check_prices AS
        SELECT d.series_key, d.observed_at AS check_at, d.price_eur
        FROM dedup d
        JOIN (
            SELECT series_key, check_at FROM check_points
            UNION
            SELECT series_key, check_at FROM check_points_narrow
            UNION
            SELECT series_key, check_at FROM check_points_2028
            UNION
            SELECT series_key, check_at FROM check_points_2226
        ) p
          ON p.series_key = d.series_key
         AND p.check_at = d.observed_at
        """
    )
    connection.execute(
        """
        CREATE OR REPLACE TEMP VIEW coverage_events AS
        SELECT
            n.series_key,
            n.snapshot_at,
            g.observed_at AS s,
            lag(g.observed_at, 1, n.snapshot_at) OVER (
                PARTITION BY n.series_key, n.snapshot_at ORDER BY g.observed_at
            ) AS previous_s
        FROM snapshot n
        JOIN scrape_grid g
          ON g.route_id = n.route_id
         AND g.departure_date = n.departure_date
        WHERE g.observed_at > n.snapshot_at
          AND g.observed_at <= n.snapshot_at + INTERVAL 24 HOUR
          AND g.observed_at < n.departure_planned
        """
    )
    connection.execute(
        """
        CREATE OR REPLACE TEMP VIEW coverage_stats AS
        SELECT
            series_key,
            snapshot_at,
            date_diff('second', max(s), any_value(snapshot_at) + INTERVAL 24 HOUR) / 3600.0 AS cov_tail_h,
            greatest(
                max(date_diff('second', previous_s, s)),
                date_diff('second', max(s), any_value(snapshot_at) + INTERVAL 24 HOUR)
            ) / 3600.0 AS cov_max_gap_h
        FROM coverage_events
        GROUP BY series_key, snapshot_at
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW snapshot_diag AS
        SELECT
            n.*,
            c.check_at,
            c.check_lag_h,
            cn.check_at AS check_at_narrow,
            cn.check_lag_h AS check_lag_narrow_h,
            c28.check_at AS check_at_2028,
            c28.check_lag_h AS check_lag_2028_h,
            c26.check_at AS check_at_2226,
            c26.check_lag_h AS check_lag_2226_h,
            d.price_eur AS check_price_eur,
            dn.price_eur AS check_price_narrow_eur,
            d28.price_eur AS check_price_2028_eur,
            d26.price_eur AS check_price_2226_eur,
            cv.cov_tail_h,
            cv.cov_max_gap_h,
            CASE
                WHEN hours_to_departure BETWEEN 24 AND 168 THEN coalesce(
                    cv.cov_tail_h <= {config.report.r24_max_tail_hours}
                    AND cv.cov_max_gap_h <= {config.report.r24_max_gap_hours},
                    FALSE
                )
                ELSE NULL
            END AS r24_covered
        FROM snapshot n
        LEFT JOIN check_points c USING (series_key, snapshot_at)
        LEFT JOIN check_points_narrow cn USING (series_key, snapshot_at)
        LEFT JOIN check_points_2028 c28 USING (series_key, snapshot_at)
        LEFT JOIN check_points_2226 c26 USING (series_key, snapshot_at)
        LEFT JOIN check_prices d ON d.series_key = n.series_key AND d.check_at = c.check_at
        LEFT JOIN check_prices dn ON dn.series_key = n.series_key AND dn.check_at = cn.check_at
        LEFT JOIN check_prices d28 ON d28.series_key = n.series_key AND d28.check_at = c28.check_at
        LEFT JOIN check_prices d26 ON d26.series_key = n.series_key AND d26.check_at = c26.check_at
        LEFT JOIN coverage_stats cv USING (series_key, snapshot_at)
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW labelled AS
        SELECT
            *,
            {bucket_expr} AS bucket
        FROM snapshot_diag
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW split_rows AS
        SELECT
            * EXCLUDE (bucket),
            {headroom_expr} AS headroom_pct,
            price_eur * (1 + ({headroom_expr}) / 100.0) AS limit_eur,
            CASE
                WHEN future_max_fare_24h IS NULL THEN NULL
                WHEN future_max_fare_24h >= price_eur * (1 + ({headroom_expr}) / 100.0)
                THEN 1 ELSE 0
            END AS breached_in_24h,
            CASE
                WHEN check_price_eur IS NULL OR price_eur IS NULL THEN NULL
                WHEN check_price_eur >= price_eur * (1 + ({headroom_expr}) / 100.0) THEN 1 ELSE 0
            END AS breached_at_check,
            CASE
                WHEN check_price_narrow_eur IS NULL OR price_eur IS NULL THEN NULL
                WHEN check_price_narrow_eur >= price_eur * (1 + ({headroom_expr}) / 100.0) THEN 1 ELSE 0
            END AS breached_at_check_narrow,
            CASE
                WHEN check_price_2028_eur IS NULL OR price_eur IS NULL THEN NULL
                WHEN check_price_2028_eur >= price_eur * (1 + ({headroom_expr}) / 100.0) THEN 1 ELSE 0
            END AS breached_at_check_2028,
            CASE
                WHEN check_price_2226_eur IS NULL OR price_eur IS NULL THEN NULL
                WHEN check_price_2226_eur >= price_eur * (1 + ({headroom_expr}) / 100.0) THEN 1 ELSE 0
            END AS breached_at_check_2226,
            CASE
                WHEN future_max_fare_24h IS NULL OR check_price_eur IS NULL THEN NULL
                WHEN future_max_fare_24h >= price_eur * (1 + ({headroom_expr}) / 100.0)
                 AND check_price_eur < price_eur * (1 + ({headroom_expr}) / 100.0) THEN 1 ELSE 0
            END AS crossed_and_came_back,
            {ttd_band_case("hours_to_departure")} AS ttd_band,
            strftime(observed_at, '%G-W%V') AS observation_week,
            CASE
                WHEN departure_date <= DATE '{splits.train_end.isoformat()}' THEN 'train'
                WHEN departure_date BETWEEN DATE '{splits.validation_select_start.isoformat()}'
                    AND DATE '{splits.validation_select_end.isoformat()}' THEN 'validation_select'
                WHEN departure_date BETWEEN DATE '{splits.validation_calibrate_start.isoformat()}'
                    AND DATE '{splits.validation_calibrate_end.isoformat()}' THEN 'validation_calibrate'
                WHEN departure_date BETWEEN DATE '{splits.test_start.isoformat()}'
                    AND DATE '{splits.test_end.isoformat()}' THEN 'test'
                ELSE NULL
            END AS split,
            observed_at + INTERVAL '{label.horizon_hours} HOUR' AS label_window_end,
            date_diff('second', observed_at, future_last_observed_at) / 3600.0 AS future_span_h,
            CAST(TRUE AS BOOLEAN) AS fare_available
        FROM labelled
        """
    )
    connection.execute(
        """
        CREATE OR REPLACE TEMP VIEW features_base AS
        SELECT
            *,
            lag(price_eur) OVER (PARTITION BY series_key ORDER BY observed_at) AS prev_price
        FROM split_rows
        """
    )
    connection.execute(
        """
        CREATE OR REPLACE TEMP VIEW features_window AS
        SELECT
            p.* EXCLUDE (prev_price),
            r.price_vs_series_min,
            r.price_vs_series_median,
            r.price_min_7d,
            r.price_max_7d,
            r.history_depth_h,
            CAST(
                sum(
                    CASE
                        WHEN p.prev_price IS NOT NULL
                         AND abs(p.price_eur - p.prev_price) / nullif(p.prev_price, 0) > 0.05
                        THEN 1 ELSE 0
                    END
                ) OVER (
                    PARTITION BY p.series_key ORDER BY epoch(p.observed_at) / 3600.0
                    RANGE BETWEEN 24 PRECEDING AND CURRENT ROW
                ) AS DOUBLE
            ) AS price_jumps_24h
        FROM features_base p
        JOIN raw_features r USING (series_key, observed_at)
        """
    )
    connection.execute(
        """
        CREATE OR REPLACE TEMP VIEW with_history AS
        SELECT
            p.*,
            h.observed_at AS ref_at,
            date_diff('second', h.observed_at, p.observed_at) / 3600.0 AS ref_gap_h,
            h.price_eur AS ref_price,
            h.load_factor_ordinal AS ref_load_factor
        FROM features_window p
        ASOF LEFT JOIN history h
            ON p.series_key = h.series_key
            AND (p.observed_at - INTERVAL 23 HOUR) >= h.observed_at
        """
    )
    connection.execute(
        """
        CREATE OR REPLACE TEMP VIEW panel AS
        SELECT
            * EXCLUDE (ref_at, ref_gap_h, ref_price, ref_load_factor),
            CASE
                WHEN ref_gap_h BETWEEN 23 AND 36
                THEN price_eur - ref_price
            END AS price_change_24h,
            CASE
                WHEN ref_gap_h BETWEEN 23 AND 36
                THEN (price_eur - ref_price) / nullif(ref_gap_h, 0)
            END AS price_velocity_24h,
            CASE
                WHEN ref_gap_h BETWEEN 23 AND 36
                THEN load_factor_ordinal - ref_load_factor
            END AS load_factor_change_24h
        FROM (
            SELECT
                *,
                (price_eur - price_max_7d) / nullif(price_max_7d, 0) AS price_drawdown_7d,
                (price_eur - price_min_7d) / nullif(price_min_7d, 0) AS price_runup_7d
            FROM with_history
        )
        """
    )
    connection.execute(
        """
        CREATE OR REPLACE TEMP VIEW panel_features AS
        SELECT
            *,
            (price_rank_route_day IS NULL) AS price_rank_missing,
            (price_change_24h IS NULL) AS price_change_24h_missing,
            (load_factor_change_24h IS NULL) AS load_factor_change_24h_missing,
            (load_factor_ordinal IS NULL) AS load_factor_missing,
            (transfers_actual IS NULL) AS transfers_missing
        FROM panel
        """
    )

    if calendar_set == "none":
        connection.execute("CREATE OR REPLACE TEMP VIEW panel_calendar AS SELECT * FROM panel_features")
    else:
        date_range = connection.execute(
            "SELECT min(departure_date), max(departure_date) FROM panel_features WHERE split IS NOT NULL"
        ).fetchone()
        if date_range is None or date_range[0] is None or date_range[1] is None:
            raise DatasetError("no rows fall inside the configured splits")
        calendar.register_calendar(connection, date_range[0], date_range[1])
        calendar.register_route_states(connection, "panel_features")
        connection.execute(
            f"CREATE OR REPLACE TEMP VIEW panel_calendar AS {calendar.route_calendar_sql('panel_features')}"
        )
        missing = _scalar(
            connection,
            "SELECT count(*) FROM panel_calendar WHERE calendar_missing",
        )
        if missing:
            raise DatasetError(f"{missing} panel rows have no calendar coverage")

    connection.execute(
        f"CREATE OR REPLACE TEMP TABLE sampled AS SELECT * FROM panel_calendar "
        f"WHERE hours_to_departure BETWEEN {label.min_hours_to_departure} AND {label.max_hours_to_departure}"
    )
    null_splits = _scalar(connection, "SELECT count(*) FROM sampled WHERE split IS NULL")
    if null_splits:
        raise DatasetError(f"{null_splits} rows fall between configured splits; make the split dates contiguous")


def _split_stats(connection: duckdb.DuckDBPyConnection) -> tuple[SplitStats, ...]:
    rows = connection.execute(
        """
        SELECT
            split,
            count(*) AS rows,
            count(DISTINCT series_key) AS series,
            count(DISTINCT route_id || '|' || CAST(departure_date AS VARCHAR)) AS route_days,
            sum(CASE WHEN label_observed THEN 1 ELSE 0 END) AS labelled,
            sum(CASE WHEN label_observed THEN breached_in_24h ELSE 0 END) AS positives,
            avg(CASE WHEN label_observed THEN breached_in_24h END) AS positive_rate
        FROM sampled
        WHERE split IS NOT NULL
        GROUP BY split
        ORDER BY split
        """
    ).fetchall()
    return tuple(
        SplitStats(
            split=str(row[0]),
            rows=int(row[1]),
            series=int(row[2]),
            route_days=int(row[3]),
            labelled=int(row[4]),
            positives=int(row[5]),
            positive_rate=0.0 if row[6] is None else float(row[6]),
        )
        for row in rows
    )


def _label_window_profile(
    connection: duckdb.DuckDBPyConnection, group_column: str, group_alias: str
) -> list[dict[str, Any]]:
    """Coverage and next-day prevalence by TTD band and one grouping column."""
    return _dict_rows(
        connection,
        f"""
        SELECT
            split,
            {group_column} AS {group_alias},
            ttd_band AS band,
            count(*) AS rows,
            count(*) FILTER (WHERE check_at_2028 IS NOT NULL) AS check_eligible_2028,
            count(*) FILTER (WHERE check_price_2028_eur IS NOT NULL) AS check_priced_2028,
            avg(breached_at_check_2028) FILTER (WHERE breached_at_check_2028 IS NOT NULL) AS next_day_2028_rate,
            count(*) FILTER (WHERE check_at_2226 IS NOT NULL) AS check_eligible_2226,
            count(*) FILTER (WHERE check_price_2226_eur IS NOT NULL) AS check_priced_2226,
            avg(breached_at_check_2226) FILTER (WHERE breached_at_check_2226 IS NOT NULL) AS next_day_2226_rate
        FROM sampled
        WHERE split IS NOT NULL
        GROUP BY split, {group_column}, ttd_band
        ORDER BY split, {group_column}, ttd_band
        """,
    )


def _profile(connection: duckdb.DuckDBPyConnection) -> dict[str, Any]:
    headroom = connection.execute(
        """
        SELECT
            split,
            headroom_pct,
            count(*) AS rows,
            sum(CASE WHEN label_observed THEN 1 ELSE 0 END) AS labelled,
            sum(CASE WHEN label_observed THEN breached_in_24h ELSE 0 END) AS positives,
            avg(CASE WHEN label_observed THEN breached_in_24h END) AS positive_rate
        FROM sampled
        WHERE split IS NOT NULL
        GROUP BY split, headroom_pct
        ORDER BY split, headroom_pct
        """
    ).fetchall()
    era = connection.execute(
        """
        SELECT split, observation_era, count(*) AS rows
        FROM sampled
        WHERE split IS NOT NULL
        GROUP BY split, observation_era
        ORDER BY split, observation_era
        """
    ).fetchall()
    coverage = connection.execute(
        """
        SELECT
            split,
            avg(CASE WHEN label_observed THEN 1 ELSE 0 END) AS labelled_share,
            avg(CASE WHEN future_observations = 1 THEN 1 ELSE 0 END) AS one_observation_share,
            avg(CASE WHEN future_observations >= 2 THEN 1 ELSE 0 END) AS two_plus_share,
            avg(r24_covered::INT) AS r24_share
        FROM sampled
        WHERE split IS NOT NULL
        GROUP BY split
        ORDER BY split
        """
    ).fetchall()
    cohort = _dict_rows(
        connection,
        """
        SELECT
            split,
            count(*) AS rows,
            sum(CASE WHEN label_observed THEN 1 ELSE 0 END) AS labelled,
            sum(CASE WHEN check_at IS NOT NULL THEN 1 ELSE 0 END) AS check_eligible,
            sum(CASE WHEN check_at IS NOT NULL AND check_price_eur IS NOT NULL THEN 1 ELSE 0 END) AS check_priced,
            sum(CASE WHEN check_at IS NOT NULL AND check_price_eur IS NULL THEN 1 ELSE 0 END) AS check_censored,
            sum(CASE WHEN future_observations >= 2 THEN 1 ELSE 0 END) AS two_plus,
            avg(CASE WHEN label_observed THEN 1 ELSE 0 END) AS labelled_share,
            avg(CASE WHEN label_observed THEN breached_in_24h END) AS prevalence,
            avg(CASE WHEN label_observed AND future_observations >= 2 THEN breached_in_24h END) AS two_plus_prevalence,
            avg(CASE WHEN check_at IS NOT NULL THEN breached_at_check END) AS check_prevalence
        FROM sampled
        WHERE split IS NOT NULL
        GROUP BY split
        ORDER BY split
        """,
    )
    ttd = connection.execute(
        """
        SELECT
            split,
            ttd_band,
            count(*) AS rows,
            sum(CASE WHEN label_observed THEN 1 ELSE 0 END) AS labelled,
            avg(CASE WHEN label_observed THEN breached_in_24h END) AS positive_rate
        FROM sampled
        WHERE split IS NOT NULL
        GROUP BY split, ttd_band
        ORDER BY split, ttd_band
        """
    ).fetchall()
    label = _dict_rows(
        connection,
        """
        SELECT
            split,
            ttd_band AS band,
            count(*) AS rows,
            count(*) FILTER (WHERE label_observed) AS labelled,
            count(*) FILTER (WHERE check_at IS NOT NULL) AS check_eligible,
            count(*) FILTER (WHERE check_at IS NOT NULL AND check_price_eur IS NOT NULL) AS check_priced,
            count(*) FILTER (WHERE check_at IS NOT NULL AND check_price_eur IS NULL) AS check_censored,
            count(*) FILTER (WHERE check_at_2028 IS NOT NULL) AS check_eligible_2028,
            count(*) FILTER (WHERE check_price_2028_eur IS NOT NULL) AS check_priced_2028,
            avg(breached_at_check_2028) FILTER (WHERE breached_at_check_2028 IS NOT NULL) AS next_day_2028_rate,
            count(*) FILTER (WHERE check_at_2226 IS NOT NULL) AS check_eligible_2226,
            count(*) FILTER (WHERE check_price_2226_eur IS NOT NULL) AS check_priced_2226,
            avg(breached_at_check_2226) FILTER (WHERE breached_at_check_2226 IS NOT NULL) AS next_day_2226_rate,
            count(*) FILTER (WHERE future_observations = 1) AS one_observations,
            count(*) FILTER (WHERE future_observations >= 2) AS two_plus,
            avg(breached_in_24h) FILTER (WHERE label_observed) AS within_day_rate,
            avg(breached_in_24h) FILTER (
                WHERE label_observed AND check_price_eur IS NOT NULL
            ) AS priced_within_day_rate,
            avg(breached_in_24h) FILTER (WHERE label_observed AND future_observations = 1) AS one_prevalence,
            avg(breached_in_24h) FILTER (WHERE label_observed AND future_observations >= 2) AS two_plus_prevalence,
            median(future_span_h) FILTER (WHERE future_observations = 1) AS median_single_lag_h,
            quantile_cont(future_span_h, 0.1) FILTER (WHERE future_observations = 1) AS p10_single_lag_h,
            quantile_cont(future_span_h, 0.9) FILTER (WHERE future_observations = 1) AS p90_single_lag_h,
            avg(breached_at_check) FILTER (WHERE breached_at_check IS NOT NULL) AS next_day_rate,
            avg(breached_at_check_narrow) FILTER (WHERE breached_at_check_narrow IS NOT NULL) AS narrow_rate,
            avg(crossed_and_came_back) FILTER (WHERE crossed_and_came_back IS NOT NULL) AS crossed_back_rate,
            avg(breached_in_24h) FILTER (
                WHERE label_observed AND check_at IS NOT NULL AND check_price_eur IS NULL
            ) AS censored_within_day_rate,
            count(*) FILTER (WHERE price_change_24h > 0.005 * price_eur) AS dearer,
            count(*) FILTER (WHERE price_change_24h < -0.005 * price_eur) AS cheaper,
            count(*) FILTER (WHERE check_price_2028_eur > price_eur * 1.005) AS forward_dearer,
            count(*) FILTER (WHERE check_price_2028_eur < price_eur * 0.995) AS forward_cheaper,
            count(*) FILTER (
                WHERE price_change_24h IS NOT NULL
                  AND abs(price_change_24h) <= 0.005 * price_eur
            ) AS unchanged
        FROM sampled
        WHERE split IS NOT NULL
        GROUP BY split, ttd_band
        ORDER BY split, ttd_band
        """,
    )
    label_era = _label_window_profile(connection, "observation_era", "era")
    label_week = _label_window_profile(connection, "observation_week", "week")
    a29 = _dict_rows(
        connection,
        """
        SELECT
            split,
            ttd_band AS band,
            count(*) AS rows,
            avg(CASE WHEN future_max_fare_24h >= price_eur * 1.05 THEN 1.0 ELSE 0.0 END) AS within_day_rate,
            avg(CASE WHEN check_price_eur >= price_eur * 1.05 THEN 1.0 ELSE 0.0 END) AS next_day_rate,
            avg(
                CASE
                    WHEN future_max_fare_24h >= price_eur * 1.05
                     AND check_price_eur < price_eur * 1.05 THEN 1.0 ELSE 0.0
                END
            ) AS crossed_back_rate
        FROM sampled
        WHERE split IS NOT NULL AND label_observed AND check_price_eur IS NOT NULL
        GROUP BY split, ttd_band
        ORDER BY split, ttd_band
        """,
    )
    unlabelled = connection.execute(
        """
        SELECT
            split,
            ttd_band,
            observation_era,
            observation_week,
            count(*) AS rows,
            avg(CASE WHEN label_observed THEN 0.0 ELSE 1.0 END) AS unlabelled_share
        FROM sampled
        WHERE split IS NOT NULL
        GROUP BY split, ttd_band, observation_era, observation_week
        ORDER BY split, ttd_band, observation_era, observation_week
        """
    ).fetchall()
    coverage_r24 = connection.execute(
        """
        SELECT
            split,
            ttd_band,
            count(*) AS rows,
            count(cov_tail_h) AS eligible,
            avg(r24_covered::INT) AS covered_share,
            avg(cov_tail_h) AS mean_tail_h,
            avg(cov_max_gap_h) AS mean_gap_h,
            median(cov_max_gap_h) AS median_gap_h
        FROM sampled
        WHERE split IS NOT NULL
        GROUP BY split, ttd_band
        ORDER BY split, ttd_band
        """
    ).fetchall()
    max_row = connection.execute("SELECT max(departure_date) FROM sampled").fetchone()
    if max_row is None or max_row[0] is None:
        raise DatasetError("no panel rows for journey diagnostics")
    max_departure = str(max_row[0])
    two_plus_week = connection.execute(
        """
        SELECT
            split,
            ttd_band,
            observation_week,
            count(*) AS rows,
            avg(CASE WHEN future_observations >= 2 THEN 1.0 ELSE 0.0 END) AS two_plus_share
        FROM sampled
        WHERE split IS NOT NULL AND ttd_band = '14-30d'
        GROUP BY split, ttd_band, observation_week
        ORDER BY split, observation_week
        """
    ).fetchall()
    journey_row = connection.execute(
        f"""
        WITH series_obs AS (
            SELECT DISTINCT
                series_key,
                route_id,
                departure_date,
                observed_at,
                train_number,
                departure_planned,
                service_class
            FROM base_sampled
            WHERE departure_date <= DATE '{max_departure}'
        ),
        series_info AS (
            SELECT
                series_key,
                min(route_id) AS route_id,
                min(departure_date) AS departure_date,
                min(train_number) AS train_number,
                min(departure_planned) AS departure_planned,
                min(service_class) AS service_class,
                min(observed_at) AS first_obs,
                max(observed_at) AS last_obs,
                count(*) AS observations
            FROM series_obs
            GROUP BY series_key
        ),
        new_series AS MATERIALIZED (
            SELECT
                o.series_key,
                o.route_id,
                o.departure_date,
                o.observed_at AS first_obs,
                o.train_number,
                o.service_class,
                o.departure_planned
            FROM series_obs o
            JOIN series_info i USING (series_key)
            WHERE o.observed_at = i.first_obs
        ),
        eligible AS (
            SELECT *
            FROM series_info
            WHERE observations >= 3
        ),
        next_scrape AS (
            SELECT
                s.*,
                min(g.observed_at) AS next_s
            FROM eligible s
            JOIN scrape_grid_all g
              ON g.route_id = s.route_id
             AND g.departure_date = s.departure_date
             AND g.observed_at > s.last_obs
             AND g.observed_at < s.departure_planned
            WHERE s.last_obs <= s.departure_planned - INTERVAL 24 HOUR
            GROUP BY
                s.series_key,
                s.route_id,
                s.departure_date,
                s.train_number,
                s.departure_planned,
                s.service_class,
                s.first_obs,
                s.last_obs,
                s.observations
        ),
        classified AS (
            SELECT
                n.*,
                CASE
                    WHEN EXISTS (
                        SELECT 1 FROM new_series ns
                        WHERE ns.route_id = n.route_id
                          AND ns.departure_date = n.departure_date
                          AND ns.first_obs = n.next_s
                          AND ns.train_number IS NOT DISTINCT FROM n.train_number
                          AND ns.service_class = n.service_class
                          AND abs(date_diff('second', ns.departure_planned, n.departure_planned)) <= 900
                    ) THEN 'same_train'
                    WHEN EXISTS (
                        SELECT 1 FROM new_series ns
                        WHERE ns.route_id = n.route_id
                          AND ns.departure_date = n.departure_date
                          AND ns.first_obs = n.next_s
                          AND abs(date_diff('second', ns.departure_planned, n.departure_planned)) <= 3600
                    ) THEN 'other_train'
                    ELSE 'none'
                END AS successor,
                CASE
                    WHEN EXISTS (
                        SELECT 1 FROM new_series ns
                        WHERE ns.route_id = n.route_id
                          AND ns.departure_date = n.departure_date
                          AND ns.first_obs = n.next_s
                          AND ns.train_number IS NOT DISTINCT FROM n.train_number
                          AND ns.service_class = n.service_class
                          AND abs(date_diff('second', ns.departure_planned, n.departure_planned)) <= 3600
                    ) THEN 'same_train'
                    WHEN EXISTS (
                        SELECT 1 FROM new_series ns
                        WHERE ns.route_id = n.route_id
                          AND ns.departure_date = n.departure_date
                          AND ns.first_obs = n.next_s
                          AND abs(date_diff('second', ns.departure_planned, n.departure_planned)) <= 3600
                    ) THEN 'other_train'
                    ELSE 'none'
                END AS successor_60,
                {ttd_band_case("date_diff('second', last_obs, departure_planned) / 3600.0", JOURNEY_BANDS)} AS ttd_band,
                strftime(last_obs, '%G-W%V') AS observation_week
            FROM next_scrape n
        )
        SELECT
            (SELECT count(*) FROM eligible) AS total_journeys,
            (
                SELECT count(*) FROM eligible
                WHERE last_obs <= departure_planned - INTERVAL 24 HOUR
            ) AS at_risk,
            count(*) AS disappeared,
            ttd_band,
            observation_week,
            successor,
            successor_60,
            count(*) AS journeys
        FROM classified
        GROUP BY GROUPING SETS ((ttd_band, observation_week, successor, successor_60), ())
        ORDER BY GROUPING(ttd_band), ttd_band, observation_week, successor, successor_60
        """
    ).fetchall()
    journey_totals = next((row for row in journey_row if row[3] is None), None)
    journey_groups = [row for row in journey_row if row[3] is not None]
    total_journeys = int(journey_totals[0]) if journey_totals else 0
    at_risk = int(journey_totals[1]) if journey_totals else 0
    disappeared = sum(int(row[2]) for row in journey_groups)
    return {
        "headroom": [
            {
                "split": str(row[0]),
                "headroom_pct": int(row[1]),
                "rows": int(row[2]),
                "labelled": int(row[3]),
                "positives": int(row[4]),
                "positive_rate": 0.0 if row[5] is None else float(row[5]),
            }
            for row in headroom
        ],
        "era": [{"split": str(row[0]), "observation_era": str(row[1]), "rows": int(row[2])} for row in era],
        "coverage": [
            {
                "split": str(row[0]),
                "labelled_share": float(row[1] or 0.0),
                "one_observation_share": float(row[2] or 0.0),
                "two_plus_share": float(row[3] or 0.0),
                "r24_share": None if row[4] is None else float(row[4]),
            }
            for row in coverage
        ],
        "cohort": cohort,
        "ttd": [
            {
                "split": str(row[0]),
                "band": str(row[1]),
                "rows": int(row[2]),
                "labelled": int(row[3]),
                "positive_rate": None if row[4] is None else float(row[4]),
            }
            for row in ttd
        ],
        "label": label,
        "label_era": label_era,
        "label_week": label_week,
        "a29": a29,
        "unlabelled": [
            {
                "split": str(row[0]),
                "band": str(row[1]),
                "era": str(row[2]),
                "week": str(row[3]),
                "rows": int(row[4]),
                "unlabelled_share": float(row[5] or 0.0),
            }
            for row in unlabelled
        ],
        "coverage_r24": [
            {
                "split": str(row[0]),
                "band": str(row[1]),
                "rows": int(row[2]),
                "eligible": int(row[3]),
                "covered_share": None if row[4] is None else float(row[4]),
                "mean_tail_h": None if row[5] is None else round(float(row[5]), 6),
                "mean_gap_h": None if row[6] is None else round(float(row[6]), 6),
                "median_gap_h": None if row[7] is None else round(float(row[7]), 6),
            }
            for row in coverage_r24
        ],
        "two_plus_week": [
            {
                "split": str(row[0]),
                "band": str(row[1]),
                "week": str(row[2]),
                "rows": int(row[3]),
                "two_plus_share": float(row[4] or 0.0),
            }
            for row in two_plus_week
        ],
        "journey": {
            "total_journeys": total_journeys,
            "at_risk": at_risk,
            "disappeared": disappeared,
            "share": 0.0 if total_journeys == 0 else disappeared / total_journeys,
            "share_at_risk": 0.0 if at_risk == 0 else disappeared / at_risk,
            "groups": [
                {
                    "band": str(row[3]),
                    "week": str(row[4]),
                    "successor": str(row[5]),
                    "successor_60": str(row[6]),
                    "journeys": int(row[7]),
                }
                for row in journey_groups
            ],
        },
    }


def _quality_gates(
    stats: DatasetStats,
    profile: dict[str, Any],
    config: TrainingConfig,
) -> None:
    for split in stats.splits:
        if split.rows == 0:
            raise DatasetError(f"split {split.split} is empty")
        coverage = split.labelled / split.rows
        if coverage < config.report.min_label_coverage:
            raise DatasetError(
                f"split {split.split} has {coverage:.1%} labelled rows; floor is {config.report.min_label_coverage:.0%}"
            )
    for item in profile["headroom"]:
        if item["split"] not in {"validation_select", "test"}:
            continue
        if config.report.min_headroom_positives <= 0:
            continue
        if item["positives"] < config.report.min_headroom_positives:
            raise DatasetError(
                f"split {item['split']} headroom {item['headroom_pct']}% has "
                f"{item['positives']} positives; floor is {config.report.min_headroom_positives}"
            )


def build_dataset(
    connection: duckdb.DuckDBPyConnection,
    source: SourceSpec,
    config: TrainingConfig,
    out_dir: Path,
    *,
    run_id: str,
    write_splits: bool = True,
    cli_argv: tuple[str, ...] | None = None,
    threads: int | None = None,
) -> DatasetStats:
    """Build the panel, profile it and write the Parquet splits."""
    started = time.perf_counter()
    out_dir = out_dir.resolve()
    dataset_dir = out_dir / "dataset"
    calendar_set = config.calendar.feature_set
    spec = feature_spec(calendar_set)
    source_sql = read_parquet(source.glob, union_by_name=False)
    source_rows = _source_count(connection, source_sql)
    if source_rows == 0:
        raise DatasetError(f"source {source.label} contains no rows")

    _create_views(connection, source_sql, config, calendar_set)

    columns = _final_columns(calendar_set)
    missing = set(columns) - {row[0] for row in connection.execute("DESCRIBE SELECT * FROM sampled").fetchall()}
    if missing:
        raise DatasetError(f"sampled panel is missing columns: {sorted(missing)}")
    selected = ", ".join(columns)
    split_names = ("train", "validation_select", "validation_calibrate", "test")
    splits = _split_stats(connection)
    profile = _profile(connection)
    if {item.split for item in splits} != set(split_names):
        raise DatasetError(f"missing split(s): {sorted({item.split for item in splits})}")

    total_rows = sum(item.rows for item in splits)
    labelled_rows = sum(item.labelled for item in splits)
    series = _scalar(connection, "SELECT count(DISTINCT series_key) FROM sampled WHERE split IS NOT NULL")
    route_days = _scalar(
        connection,
        "SELECT count(DISTINCT route_id || '|' || CAST(departure_date AS VARCHAR)) "
        "FROM sampled WHERE split IS NOT NULL",
    )
    stats = DatasetStats(
        run_id=run_id,
        rows=total_rows,
        labelled_rows=labelled_rows,
        series=series,
        route_days=route_days,
        splits=splits,
        duration_seconds=round(time.perf_counter() - started, 3),
        profile=profile,
    )
    _quality_gates(stats, profile, config)
    warnings: list[str] = []
    if source.build_id is None:
        warnings.append("source is a glob, not a pointer; build id is unknown")
    if total_rows > 5_000_000:
        warnings.append(f"panel has {total_rows} rows; above the 5M target, reduce sample_rate")
    if total_rows < 2_000_000:
        warnings.append(f"panel has {total_rows} rows; below the 2M target, raise sample_rate")
    stats = replace(stats, warnings=tuple(warnings))
    git_sha, git_dirty = _git_state()

    # Digest before writing: a failed gate or digest query must not leave plausible Parquet files.
    digests = {split: _content_digest(connection, split, columns) for split in split_names} if write_splits else {}
    dataset_files: list[dict[str, Any]] = []
    if write_splits:
        dataset_dir.mkdir(parents=True, exist_ok=True)
        for split in split_names:
            target = dataset_dir / f"{split}.parquet"
            connection.execute(
                f"COPY (SELECT {selected} FROM sampled WHERE split = '{split}' "
                f"ORDER BY series_key, snapshot_at, bin_regime, bin_index) "
                f"TO '{sql_string(target.as_posix())}' (FORMAT parquet, COMPRESSION zstd)"
            )
            dataset_files.append(
                {
                    "split": split,
                    "path": f"dataset/{target.name}",
                    "bytes": target.stat().st_size,
                    "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                    **digests[split],
                }
            )

    manifest = {
        "manifest_version": 2,
        "run_id": run_id,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": source.label,
        "source_rows": source_rows,
        "git_sha": git_sha,
        "git_dirty": git_dirty,
        "uv_lock_sha256": _lock_sha256(),
        "cli_argv": list(cli_argv or ()),
        "threads": threads,
        "duckdb_settings": _duckdb_settings(connection),
        "feature_spec_sha256": hashlib.sha256(json.dumps(list(spec.names)).encode()).hexdigest(),
        "silver_build_id": source.build_id,
        "silver_manifest_sha256": source.manifest_sha256,
        "config_sha256": config.hash(),
        "calendar_version": calendar.dataset_version(),
        "calendar_feature_set": calendar_set,
        "features": list(spec.names),
        "resample": {
            "outer_bin_hours": config.resample.outer_bin_hours,
            "outer_threshold_hours": config.resample.outer_threshold_hours,
            "inner_bin_hours": config.resample.inner_bin_hours,
        },
        "sampler": {
            "kind": "route_day_sha256",
            "seed": config.sample.seed,
            "sample_rate": config.sample.sample_rate,
            "max_route_days": config.sample.max_route_days,
        },
        "dataset_files": dataset_files,
        "splits": {
            "train_end": config.splits.train_end.isoformat(),
            "validation_select": [
                config.splits.validation_select_start.isoformat(),
                config.splits.validation_select_end.isoformat(),
            ],
            "validation_calibrate": [
                config.splits.validation_calibrate_start.isoformat(),
                config.splits.validation_calibrate_end.isoformat(),
            ],
            "test": [config.splits.test_start.isoformat(), config.splits.test_end.isoformat()],
        },
        "sample": {
            "sample_rate": config.sample.sample_rate,
            "max_route_days": config.sample.max_route_days,
            "seed": config.sample.seed,
        },
        "label": {
            "horizon_hours": config.label.horizon_hours,
            "headroom_pct": list(config.label.headroom_pct),
            "min_hours_to_departure": config.label.min_hours_to_departure,
            "max_hours_to_departure": config.label.max_hours_to_departure,
        },
        "stats": stats.to_dict(),
        "package_versions": _package_versions(),
        "warnings": list(warnings),
    }
    (out_dir / "dataset_manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8"
    )
    (out_dir / "profile.json").write_text(
        json.dumps(stats.to_dict(), indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8"
    )
    return stats
