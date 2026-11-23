"""Build the training panel and write one Parquet file per split.

The pipeline stays in SQL until the model matrix: DuckDB handles the 100M-row scan, the exact
forward-looking label window (a numeric ``RANGE`` frame over epoch hours), the route-day
cross-section and the calendar join. Most steps are views so DuckDB can keep the plan lazy; the
sampled panel, chain map, scrape grid, snapshot and check tables are materialised where they are
reused.
"""

from __future__ import annotations

import glob
import hashlib
import json
import logging
import platform
import resource
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, field, replace
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

import duckdb

from tpm_analytics import calendar
from tpm_analytics.silver._duck import read_parquet, sql_string
from tpm_analytics.training.audits import duplicate_audit, scrape_gap_audit, v2_chain_audit
from tpm_analytics.training.bands import JOURNEY_BANDS, ttd_band_case
from tpm_analytics.training.chains import ChainStats, build_chain_map
from tpm_analytics.training.config import TrainingConfig
from tpm_analytics.training.features import AUDIT_COLUMNS, LABEL_COLUMNS, column_roles, feature_spec
from tpm_analytics.training.identity import (
    LINK_TOLERANCE_SECONDS,
    SAME_SCRAPE_ORDER,
    berlin_week_sql,
    series_key_sql,
)
from tpm_analytics.training.labels import breach_sql, price_cents_sql
from tpm_analytics.training.sources import SourceSpec


class DatasetError(RuntimeError):
    """The dataset cannot be built from this source or configuration."""


_LOGGER = logging.getLogger(__name__)


def _phase(name: str, started: float) -> float:
    """Log one build phase and return a new start timestamp."""
    finished = time.perf_counter()
    _LOGGER.info("%s: %.1f s", name, finished - started)
    return finished


@dataclass(frozen=True)
class SplitStats:
    split: str
    rows: int
    series: int
    route_days: int
    eligible: int
    labelled: int
    positives: int
    positive_rate: float
    chains: int = 0


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


def _peak_rss_kb() -> int:
    """Return the process peak RSS in KiB (Linux/macOS units normalised to KiB)."""
    value = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    return value if sys.platform != "darwin" else value // 1024


def _git_state(root: Path | None = None) -> tuple[str | None, bool | None, tuple[str, ...]]:
    """Return the checkout's HEAD, dirty flag and untracked paths outside ``analytics/``.

    Tracked changes anywhere in the checkout, and untracked files under ``analytics/``, make the
    run dirty. Untracked files elsewhere (for example a user's scratch document) are recorded in
    the manifest as ``git_untracked`` but do not make the run dirty, so provenance never requires
    moving someone else's files. Unknown git state returns ``(None, None, ())``.
    """
    root = root or Path(__file__).resolve().parents[4]
    try:
        sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
        tracked = subprocess.check_output(
            ["git", "status", "--porcelain", "--untracked-files=no"], cwd=root, text=True
        ).strip()
        untracked = tuple(
            path
            for path in subprocess.check_output(
                ["git", "ls-files", "--others", "--exclude-standard"], cwd=root, text=True
            ).splitlines()
            if path and not path.startswith("analytics/")
        )
        analytics_untracked = subprocess.check_output(
            ["git", "ls-files", "--others", "--exclude-standard", "--", "analytics"], cwd=root, text=True
        ).strip()
        dirty = bool(tracked) or bool(analytics_untracked)
        return sha or None, dirty, untracked
    except OSError, subprocess.CalledProcessError:
        return None, None, ()


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


def _source_inventory(connection: duckdb.DuckDBPyConnection, source: SourceSpec) -> list[dict[str, Any]]:
    """List the scanned Parquet files so a glob source is localisable.

    Local files get a size and SHA-256; S3 keys get the row count from Parquet metadata. The S3
    listing does not issue one HEAD request per object, so sizes and ETags stay out of the manifest.
    """
    if source.glob.startswith("s3://"):
        try:
            rows = connection.execute(
                f"SELECT file_name, num_rows FROM parquet_file_metadata('{sql_string(source.glob)}')"
            ).fetchall()
        except duckdb.Error:
            return []
        return [{"path": str(row[0]), "rows": int(row[1])} for row in rows]
    files = sorted(glob.glob(source.glob, recursive=True))
    inventory: list[dict[str, Any]] = []
    for name in files:
        path = Path(name)
        if not path.is_file():
            continue
        inventory.append(
            {
                "path": path.resolve().as_posix(),
                "bytes": path.stat().st_size,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
        )
    return inventory


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
    return tuple(dict.fromkeys((*AUDIT_COLUMNS, *LABEL_COLUMNS, *spec.names)))


def _forward_columns(calendar_set: str) -> tuple[str, ...]:
    """Forward features plus the grid-only check columns; no label or check fare."""
    spec = feature_spec(calendar_set)
    return tuple(dict.fromkeys((*AUDIT_COLUMNS, "eligible", "check_at", "check_lag_h", *spec.names)))


def _create_views(
    connection: duckdb.DuckDBPyConnection,
    source_sql: str,
    config: TrainingConfig,
    calendar_set: str,
    *,
    strict_chains: bool = False,
    forward: bool = False,
) -> ChainStats:
    splits = config.splits
    protocol = config.protocol
    label = config.label
    resample = config.resample
    grid = label.headroom_pct
    bucket_expr = _hash_bucket("concat_ws('|', series_key, CAST(observed_at AS VARCHAR))", len(grid))
    headroom_expr = _headroom_case("bucket", grid)
    route_day_hash_expr = _hash_bucket(
        f"concat_ws('|', {config.sample.seed}, route_id, CAST(departure_date AS VARCHAR))", 10000
    )

    departure_filter = (
        f"departure_date BETWEEN DATE '{protocol.forward_start.isoformat()}' "
        f"AND DATE '{protocol.forward_end.isoformat()}' AND schema_version = 1"
        if forward
        else f"departure_date <= DATE '{splits.test_end.isoformat()}'"
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
            {series_key_sql()} AS series_key,
            date_diff('second', observed_at, departure_planned) / 3600.0 AS hours_to_departure,
            {route_day_hash_expr} AS route_day_hash
        FROM {source_sql}
        WHERE fare_lowest_eur IS NOT NULL
          AND {departure_filter}
          AND observed_at < departure_planned
        """
    )
    v2_rows = (
        0
        if forward
        else _scalar(
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
    )
    if v2_rows:
        raise DatasetError(f"{v2_rows} v2 rows fall inside the baseline splits; this baseline is v1-only")
    threshold = max(1, round(config.sample.sample_rate * 10000))
    if forward:
        forward_threshold = max(1, round(protocol.forward_sample_rate * 10000))
        connection.execute(
            f"CREATE OR REPLACE TEMP VIEW base_sampled_view AS SELECT * FROM base_all "
            f"WHERE route_day_hash < {forward_threshold}"
        )
    elif config.sample.max_route_days is None:
        connection.execute(
            f"CREATE OR REPLACE TEMP VIEW base_sampled_view AS SELECT * FROM base_all "
            f"WHERE route_day_hash < {threshold}"
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
            "CREATE OR REPLACE TEMP VIEW base_sampled_view AS "
            "SELECT b.* FROM base_all b JOIN selected_route_days s "
            "USING (route_id, departure_date)"
        )
    # The chain map, cross-section, dedup and profile audits all read this panel. Materialise it
    # once instead of re-scanning and re-hashing the source for each consumer.
    connection.execute("CREATE OR REPLACE TEMP TABLE base_sampled AS SELECT * FROM base_sampled_view")
    connection.execute(
        """
        CREATE OR REPLACE TEMP TABLE scrape_grid AS
        SELECT DISTINCT route_id, departure_date, observed_at
        FROM base_sampled
        """
    )
    phase_started = time.perf_counter()
    chain_stats = build_chain_map(
        connection,
        base_view="base_sampled",
        grid_view="scrape_grid",
        prefix="chain",
        map_table="chain_map",
        strict=strict_chains,
    )
    phase_started = _phase("chain map", phase_started)
    connection.execute(
        """
        CREATE OR REPLACE TEMP TABLE base_chained AS
        SELECT b.*, m.chain_id, m.chain_departure_date
        FROM base_sampled b
        JOIN chain_map_rows m USING (series_key, observed_at)
        """
    )
    base_rows = _scalar(connection, "SELECT count(*) FROM base_sampled")
    chained_rows = _scalar(connection, "SELECT count(*) FROM base_chained")
    if chained_rows != base_rows:
        raise DatasetError(
            f"chain row map changed the panel row count: {base_rows} sampled rows, {chained_rows} chained rows"
        )
    if not forward:
        connection.execute(
            f"""
            CREATE OR REPLACE TEMP TABLE scrape_grid_all AS
            SELECT
                route_id,
                departure_date,
                observed_at,
                min(observation_era) AS observation_era
            FROM {source_sql}
            WHERE observed_at < departure_planned
              AND schema_version = 1
            GROUP BY route_id, departure_date, observed_at
            """
        )
    phase_started = _phase("base chained", phase_started)
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
        FROM base_chained
        """
    )
    phase_started = _phase("cross section", phase_started)
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW dedup_candidates AS
        SELECT
            *,
            row_number() OVER (
                PARTITION BY series_key, observed_at
                ORDER BY {SAME_SCRAPE_ORDER}
            ) AS dedup_rank
        FROM base_chained
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
        CREATE OR REPLACE TEMP TABLE chain_dedup AS
        SELECT chain_id, observed_at, price_eur, load_factor_ordinal, series_key
        FROM (
            SELECT
                c.chain_id,
                d.observed_at,
                d.price_eur,
                d.load_factor_ordinal,
                d.series_key,
                row_number() OVER (
                    PARTITION BY c.chain_id, d.observed_at
                    ORDER BY c.series_first_obs DESC, d.price_eur DESC,
                             d.load_factor_ordinal DESC NULLS LAST, d.series_key
                ) AS chain_rank
            FROM dedup d
            JOIN chain_map_rows c USING (series_key, observed_at)
        )
        WHERE chain_rank = 1
        """
    )
    connection.execute(
        """
        CREATE OR REPLACE TEMP VIEW history AS
        SELECT chain_id, observed_at, price_eur, load_factor_ordinal
        FROM chain_dedup
        """
    )
    phase_started = _phase("dedup and history", phase_started)
    connection.execute(
        """
        CREATE OR REPLACE TEMP VIEW raw_features AS
        SELECT
            *,
            price_eur - min(price_eur) OVER (
                PARTITION BY chain_id ORDER BY observed_at
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ) AS price_vs_series_min,
            price_eur / median(price_eur) OVER (
                PARTITION BY chain_id ORDER BY observed_at
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ) AS price_vs_series_median,
            min(price_eur) OVER (
                PARTITION BY chain_id ORDER BY epoch(observed_at) / 3600.0
                RANGE BETWEEN 168 PRECEDING AND CURRENT ROW
            ) AS price_min_7d,
            max(price_eur) OVER (
                PARTITION BY chain_id ORDER BY epoch(observed_at) / 3600.0
                RANGE BETWEEN 168 PRECEDING AND CURRENT ROW
            ) AS price_max_7d,
            date_diff('second', min(observed_at) OVER (PARTITION BY chain_id), observed_at) / 3600.0
                AS history_depth_h
        FROM chain_dedup
        """
    )
    phase_started = _phase("raw features", phase_started)
    # Exact timestamp bounds: ``EXCLUDE CURRENT ROW`` starts the frame strictly after the snapshot
    # without an epsilon. Duplicate timestamps are already collapsed by dedup.
    if not forward:
        connection.execute(
            f"""
            CREATE OR REPLACE TEMP VIEW future AS
        SELECT
            chain_id,
            observed_at,
            max(price_eur) OVER (
                PARTITION BY chain_id
                ORDER BY epoch(observed_at) / 3600.0
                RANGE BETWEEN CURRENT ROW AND {label.horizon_hours} FOLLOWING
                EXCLUDE CURRENT ROW
            ) AS future_max_fare_24h,
            count(*) OVER (
                PARTITION BY chain_id
                ORDER BY epoch(observed_at) / 3600.0
                RANGE BETWEEN CURRENT ROW AND {label.horizon_hours} FOLLOWING
                EXCLUDE CURRENT ROW
            ) AS future_observations,
            max(observed_at) OVER (
                PARTITION BY chain_id
                ORDER BY epoch(observed_at) / 3600.0
                RANGE BETWEEN CURRENT ROW AND {label.horizon_hours} FOLLOWING
                EXCLUDE CURRENT ROW
            ) AS future_last_observed_at
        FROM chain_dedup
        """
        )
    phase_started = _phase("future window", phase_started)
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
                    chain_id,
                    CASE WHEN hours_to_departure > {resample.outer_threshold_hours} THEN '12h' ELSE '1h' END,
                    CASE
                        WHEN hours_to_departure > {resample.outer_threshold_hours}
                            THEN floor(hours_to_departure / {resample.outer_bin_hours})
                        ELSE floor(hours_to_departure / {resample.inner_bin_hours})
                    END
                ORDER BY observed_at ASC, price_eur DESC, load_factor_ordinal DESC NULLS LAST,
                         train_number, departure_planned, arrival_planned,
                         transfers_actual NULLS LAST, series_key
            ) AS rn
        FROM cross_section
        """
    )
    if forward:
        connection.execute(
            """
            CREATE OR REPLACE TEMP TABLE snapshot AS
            SELECT r.* EXCLUDE (rn)
            FROM resampled r
            WHERE r.rn = 1
            """
        )
    else:
        connection.execute(
            """
            CREATE OR REPLACE TEMP TABLE snapshot AS
            SELECT
                r.* EXCLUDE (rn),
                f.future_max_fare_24h,
                f.future_observations,
                f.future_last_observed_at
            FROM resampled r
            LEFT JOIN future f ON f.chain_id = r.chain_id AND f.observed_at = r.observed_at
            WHERE r.rn = 1
            """
        )
    phase_started = _phase("resample and snapshot", phase_started)
    if forward:
        connection.execute(
            """
            CREATE OR REPLACE TEMP TABLE check_candidates AS
            SELECT
                n.series_key,
                n.snapshot_at,
                n.chain_id,
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
        connection.execute(
            f"""
            CREATE OR REPLACE TEMP TABLE check_points AS
            SELECT
                series_key,
                snapshot_at,
                chain_id,
                check_at,
                date_diff('second', snapshot_at + INTERVAL 24 HOUR, check_at) / 3600.0 AS check_lag_h
            FROM (
                SELECT *, row_number() OVER (
                    PARTITION BY series_key, snapshot_at ORDER BY distance_us, check_at
                ) AS rn
                FROM check_candidates
                WHERE check_at BETWEEN snapshot_at + INTERVAL {label.check_window_hours[0]} HOUR
                                   AND snapshot_at + INTERVAL {label.check_window_hours[1]} HOUR
            )
            WHERE rn = 1
            """
        )
        connection.execute(
            """
            CREATE OR REPLACE TEMP VIEW snapshot_forward AS
            SELECT
                n.*,
                c.check_at,
                c.check_lag_h,
                (c.check_at IS NOT NULL) AS eligible
            FROM snapshot n
            LEFT JOIN check_points c USING (series_key, snapshot_at)
            """
        )
        connection.execute(
            f"""
            CREATE OR REPLACE TEMP VIEW labelled AS
            SELECT
                *,
                {bucket_expr} AS bucket
            FROM snapshot_forward
            """
        )
        connection.execute(
            f"""
            CREATE OR REPLACE TEMP VIEW split_rows AS
            SELECT
                * EXCLUDE (bucket),
                {headroom_expr} AS headroom_pct,
                {ttd_band_case("hours_to_departure")} AS ttd_band,
                {berlin_week_sql("observed_at")} AS observation_week,
                'forward' AS split,
                CAST(TRUE AS BOOLEAN) AS fare_available
            FROM labelled
            """
        )
    else:
        # One superset join against the route-day scrape grid; the check windows are filtered picks
        # from these candidates, so the grid is joined once instead of three times.
        connection.execute(
            """
            CREATE OR REPLACE TEMP TABLE check_candidates AS
            SELECT
                n.series_key,
                n.snapshot_at,
                n.chain_id,
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
        # The primary next-day check is the scrape closest to ``t + 24 h``; a tie goes to the earlier
        # scrape. The 20-24 h point is the crossed-back and decision-value diagnostic; the 22-26 h
        # point stays the PR 2 sensitivity diagnostic.
        for name, lower, upper in (
            ("check_points", label.check_window_hours[0], label.check_window_hours[1]),
            ("check_points_2024", 20, 24),
            ("check_points_2226", 22, 26),
        ):
            connection.execute(
                f"""
                CREATE OR REPLACE TEMP TABLE {name} AS
                SELECT
                    series_key,
                    snapshot_at,
                    chain_id,
                    check_at,
                    date_diff('second', snapshot_at + INTERVAL 24 HOUR, check_at) / 3600.0 AS check_lag_h
                FROM (
                    SELECT *, row_number() OVER (
                        PARTITION BY series_key, snapshot_at ORDER BY distance_us, check_at
                    ) AS rn
                    FROM check_candidates
                    WHERE check_at BETWEEN snapshot_at + INTERVAL {lower} HOUR
                                       AND snapshot_at + INTERVAL {upper} HOUR
                )
                WHERE rn = 1
                """
            )
        # Price each distinct (chain, check) once; the three windows share most check points.
        connection.execute(
            """
            CREATE OR REPLACE TEMP TABLE check_prices AS
            SELECT d.chain_id, d.observed_at AS check_at, d.price_eur
            FROM chain_dedup d
            JOIN (
                SELECT chain_id, check_at FROM check_points
                UNION
                SELECT chain_id, check_at FROM check_points_2024
                UNION
                SELECT chain_id, check_at FROM check_points_2226
            ) p
              ON p.chain_id = d.chain_id
             AND p.check_at = d.observed_at
            """
        )
        phase_started = _phase("check and label views", phase_started)
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
                c24.check_at AS check_at_2024,
                c24.check_lag_h AS check_lag_2024_h,
                c26.check_at AS check_at_2226,
                c26.check_lag_h AS check_lag_2226_h,
                d.price_eur AS check_price_eur,
                d24.price_eur AS check_price_2024_eur,
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
            LEFT JOIN check_points_2024 c24 USING (series_key, snapshot_at)
            LEFT JOIN check_points_2226 c26 USING (series_key, snapshot_at)
            LEFT JOIN check_prices d ON d.chain_id = n.chain_id AND d.check_at = c.check_at
            LEFT JOIN check_prices d24 ON d24.chain_id = n.chain_id AND d24.check_at = c24.check_at
            LEFT JOIN check_prices d26 ON d26.chain_id = n.chain_id AND d26.check_at = c26.check_at
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
            CREATE OR REPLACE TEMP VIEW priced AS
            SELECT
                *,
                {price_cents_sql("price_eur")} AS price_cents,
                {price_cents_sql("check_price_eur")} AS check_price_cents,
                {price_cents_sql("check_price_2024_eur")} AS check_price_2024_cents,
                {price_cents_sql("check_price_2226_eur")} AS check_price_2226_cents,
                {price_cents_sql("future_max_fare_24h")} AS future_max_fare_24h_cents
            FROM labelled
            """
        )
        connection.execute(
            f"""
            CREATE OR REPLACE TEMP VIEW split_rows AS
            SELECT
                * EXCLUDE (bucket),
                {headroom_expr} AS headroom_pct,
                price_eur * (1 + ({headroom_expr}) / 100.0) AS limit_eur,
                price_cents,
                check_price_cents,
                CASE
                    WHEN check_price_cents IS NULL THEN NULL
                    ELSE CAST({breach_sql("check_price_cents", "price_cents", headroom_expr)} AS INTEGER)
                END AS breached_next_day,
                (check_at IS NOT NULL) AS eligible,
                CASE
                    WHEN check_at IS NULL THEN 'no_check'
                    WHEN check_price_cents IS NULL THEN 'not_listed'
                    ELSE NULL
                END AS censor_reason,
                CAST(FALSE AS BOOLEAN) AS fare_lost,
                (check_at IS NOT NULL AND check_price_cents IS NOT NULL) AS label_observed,
                CASE
                    WHEN future_max_fare_24h_cents IS NULL THEN NULL
                    ELSE CAST({breach_sql("future_max_fare_24h_cents", "price_cents", headroom_expr)} AS INTEGER)
                END AS breached_within_24h,
                CASE
                    WHEN check_price_2024_cents IS NULL THEN NULL
                    ELSE CAST({breach_sql("check_price_2024_cents", "price_cents", headroom_expr)} AS INTEGER)
                END AS breached_at_check_2024,
                CASE
                    WHEN check_price_2226_cents IS NULL THEN NULL
                    ELSE CAST({breach_sql("check_price_2226_cents", "price_cents", headroom_expr)} AS INTEGER)
                END AS breached_at_check_2226,
                CASE
                    WHEN future_max_fare_24h_cents IS NULL OR check_price_2024_cents IS NULL THEN NULL
                    WHEN {breach_sql("future_max_fare_24h_cents", "price_cents", headroom_expr)}
                     AND NOT {breach_sql("check_price_2024_cents", "price_cents", headroom_expr)}
                    THEN 1 ELSE 0
                END AS crossed_and_came_back,
                {ttd_band_case("hours_to_departure")} AS ttd_band,
                {berlin_week_sql("observed_at")} AS observation_week,
                CASE
                    WHEN chain_departure_date <= DATE '{splits.train_end.isoformat()}' THEN 'train'
                    WHEN chain_departure_date BETWEEN DATE '{splits.validation_select_start.isoformat()}'
                        AND DATE '{splits.validation_select_end.isoformat()}' THEN 'validation_select'
                    WHEN chain_departure_date BETWEEN DATE '{splits.validation_calibrate_start.isoformat()}'
                        AND DATE '{splits.validation_calibrate_end.isoformat()}' THEN 'validation_calibrate'
                    WHEN chain_departure_date BETWEEN DATE '{splits.test_start.isoformat()}'
                        AND DATE '{splits.test_end.isoformat()}' THEN 'test'
                    ELSE NULL
                END AS split,
                check_at AS label_window_end,
                date_diff('second', observed_at, future_last_observed_at) / 3600.0 AS future_span_h,
                CAST(TRUE AS BOOLEAN) AS fare_available
            FROM priced
            """
        )
        phase_started = _phase("label and split rows", phase_started)
    connection.execute(
        """
        CREATE OR REPLACE TEMP VIEW features_base AS
        SELECT
            *,
            lag(price_eur) OVER (PARTITION BY chain_id ORDER BY observed_at, series_key) AS prev_price
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
                    PARTITION BY p.chain_id ORDER BY epoch(p.observed_at) / 3600.0
                    RANGE BETWEEN 24 PRECEDING AND CURRENT ROW
                ) AS DOUBLE
            ) AS price_jumps_24h
        FROM features_base p
        JOIN raw_features r USING (chain_id, observed_at)
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
            ON p.chain_id = h.chain_id
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

    hours_min, hours_max = (
        (config.protocol.forward_min_hours_to_departure, config.protocol.forward_max_hours_to_departure)
        if forward
        else (label.min_hours_to_departure, label.max_hours_to_departure)
    )
    connection.execute(
        f"CREATE OR REPLACE TEMP TABLE sampled AS SELECT * FROM panel_calendar "
        f"WHERE hours_to_departure BETWEEN {hours_min} AND {hours_max}"
    )
    _phase("features and sampled panel", phase_started)
    null_splits = _scalar(connection, "SELECT count(*) FROM sampled WHERE split IS NULL")
    if null_splits:
        raise DatasetError(f"{null_splits} rows fall between configured splits; make the split dates contiguous")
    return chain_stats


def _split_stats(connection: duckdb.DuckDBPyConnection) -> tuple[SplitStats, ...]:
    rows = connection.execute(
        """
        SELECT
            split,
            count(*) AS rows,
            count(DISTINCT series_key) AS series,
            count(DISTINCT chain_id) AS chains,
            count(DISTINCT route_id || '|' || CAST(departure_date AS VARCHAR)) AS route_days,
            sum(CASE WHEN eligible THEN 1 ELSE 0 END) AS eligible,
            sum(CASE WHEN label_observed THEN 1 ELSE 0 END) AS labelled,
            sum(CASE WHEN label_observed THEN breached_next_day ELSE 0 END) AS positives,
            avg(CASE WHEN label_observed THEN breached_next_day END) AS positive_rate
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
            chains=int(row[3]),
            route_days=int(row[4]),
            eligible=int(row[5]),
            labelled=int(row[6]),
            positives=int(row[7]),
            positive_rate=0.0 if row[8] is None else float(row[8]),
        )
        for row in rows
    )


def _label_window_profile(
    connection: duckdb.DuckDBPyConnection, group_column: str, group_alias: str
) -> list[dict[str, Any]]:
    """Eligibility, censoring and next-day prevalence by TTD band and one grouping column."""
    return _dict_rows(
        connection,
        f"""
        SELECT
            split,
            {group_column} AS {group_alias},
            ttd_band AS band,
            count(*) AS rows,
            count(*) FILTER (WHERE eligible) AS eligible,
            count(*) FILTER (WHERE label_observed) AS labelled,
            count(*) FILTER (WHERE eligible AND NOT label_observed) AS censored,
            avg(breached_next_day) FILTER (WHERE label_observed) AS prevalence
        FROM sampled
        WHERE split IS NOT NULL
        GROUP BY split, {group_column}, ttd_band
        ORDER BY split, {group_column}, ttd_band
        """,
    )


def _profile(
    connection: duckdb.DuckDBPyConnection,
    chain_stats: ChainStats,
    source_sql: str,
    config: TrainingConfig,
) -> dict[str, Any]:
    headroom = connection.execute(
        """
        SELECT
            split,
            headroom_pct,
            count(*) AS rows,
            sum(CASE WHEN eligible THEN 1 ELSE 0 END) AS eligible,
            sum(CASE WHEN label_observed THEN 1 ELSE 0 END) AS labelled,
            sum(CASE WHEN label_observed THEN breached_next_day ELSE 0 END) AS positives,
            avg(CASE WHEN label_observed THEN breached_next_day END) AS positive_rate
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
            avg(CASE WHEN eligible THEN 1 ELSE 0 END) AS eligible_share,
            avg(CASE WHEN label_observed THEN 1 ELSE 0 END) AS labelled_share,
            avg(CASE WHEN eligible AND NOT label_observed THEN 1 ELSE 0 END) AS censor_share,
            avg(r24_covered::INT) AS r24_share,
            avg(CASE WHEN r24_covered AND label_observed THEN breached_within_24h END) AS within_24h_r24_rate
        FROM sampled
        WHERE split IS NOT NULL
        GROUP BY split
        ORDER BY split
        """
    ).fetchall()
    early_window = _dict_rows(
        connection,
        """
        SELECT
            split,
            count(*) AS rows,
            count(*) FILTER (WHERE eligible) AS eligible
        FROM sampled
        WHERE split IS NOT NULL AND hours_to_departure BETWEEN 24 AND 48
        GROUP BY split
        ORDER BY split
        """,
    )
    cohort = _dict_rows(
        connection,
        """
        SELECT
            split,
            count(*) AS rows,
            count(*) FILTER (WHERE eligible) AS eligible,
            count(*) FILTER (WHERE label_observed) AS labelled,
            count(*) FILTER (WHERE eligible AND NOT label_observed) AS censored,
            count(*) FILTER (WHERE censor_reason = 'no_check') AS no_check,
            count(*) FILTER (WHERE censor_reason = 'not_listed') AS not_listed,
            count(*) FILTER (WHERE fare_lost) AS fare_lost,
            avg(CASE WHEN eligible THEN 1 ELSE 0 END) AS eligible_share,
            avg(CASE WHEN label_observed THEN 1 ELSE 0 END) AS labelled_share,
            avg(CASE WHEN label_observed THEN breached_next_day END) AS prevalence,
            avg(CASE WHEN eligible AND NOT label_observed THEN 1 ELSE 0 END) AS censor_share
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
            sum(CASE WHEN eligible THEN 1 ELSE 0 END) AS eligible,
            sum(CASE WHEN label_observed THEN 1 ELSE 0 END) AS labelled,
            sum(CASE WHEN label_observed THEN breached_next_day ELSE 0 END) AS positives,
            avg(CASE WHEN label_observed THEN breached_next_day END) AS positive_rate
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
            count(*) FILTER (WHERE eligible) AS eligible,
            count(*) FILTER (WHERE label_observed) AS labelled,
            count(*) FILTER (WHERE eligible AND NOT label_observed) AS censored,
            count(*) FILTER (WHERE censor_reason = 'not_listed') AS not_listed,
            count(*) FILTER (WHERE fare_lost) AS fare_lost,
            avg(breached_next_day) FILTER (WHERE label_observed) AS prevalence,
            median(check_lag_h) FILTER (WHERE eligible) AS median_check_lag_h,
            quantile_cont(check_lag_h, 0.1) FILTER (WHERE eligible) AS p10_check_lag_h,
            quantile_cont(check_lag_h, 0.9) FILTER (WHERE eligible) AS p90_check_lag_h,
            avg(breached_within_24h) FILTER (WHERE label_observed AND r24_covered) AS within_24h_r24_rate,
            avg(breached_at_check_2024) FILTER (WHERE breached_at_check_2024 IS NOT NULL) AS next_day_2024_rate,
            avg(breached_at_check_2226) FILTER (WHERE breached_at_check_2226 IS NOT NULL) AS next_day_2226_rate,
            avg(crossed_and_came_back) FILTER (
                WHERE crossed_and_came_back IS NOT NULL AND r24_covered
            ) AS crossed_back_rate,
            count(*) FILTER (WHERE future_observations = 1) AS one_observations,
            count(*) FILTER (WHERE future_observations >= 2) AS two_plus,
            avg(breached_next_day) FILTER (WHERE label_observed AND future_observations = 1) AS one_prevalence,
            avg(breached_next_day) FILTER (WHERE label_observed AND future_observations >= 2) AS two_plus_prevalence,
            median(future_span_h) FILTER (WHERE future_observations = 1) AS median_single_lag_h,
            quantile_cont(future_span_h, 0.1) FILTER (WHERE future_observations = 1) AS p10_single_lag_h,
            quantile_cont(future_span_h, 0.9) FILTER (WHERE future_observations = 1) AS p90_single_lag_h,
            count(*) FILTER (WHERE price_change_24h > 0.005 * price_eur) AS dearer,
            count(*) FILTER (WHERE price_change_24h < -0.005 * price_eur) AS cheaper,
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
        f"""
        SELECT
            split,
            ttd_band AS band,
            count(*) AS rows,
            avg(CASE WHEN {breach_sql("future_max_fare_24h_cents", "price_cents", "5")}
                THEN 1.0 ELSE 0.0 END) AS within_day_rate,
            avg(CASE WHEN {breach_sql("check_price_cents", "price_cents", "5")}
                THEN 1.0 ELSE 0.0 END) AS next_day_rate,
            avg(CASE WHEN {breach_sql("check_price_2024_cents", "price_cents", "5")}
                THEN 1.0 ELSE 0.0 END) AS next_day_2024_rate,
            avg(CASE WHEN {breach_sql("future_max_fare_24h_cents", "price_cents", "5")}
                      AND NOT {breach_sql("check_price_2024_cents", "price_cents", "5")}
                THEN 1.0 ELSE 0.0 END) AS crossed_back_rate
        FROM sampled
        WHERE split IS NOT NULL
          AND label_observed
          AND r24_covered
          AND future_max_fare_24h_cents IS NOT NULL
          AND check_price_2024_cents IS NOT NULL
        GROUP BY split, ttd_band
        ORDER BY split, ttd_band
        """,
    )
    a18 = _dict_rows(
        connection,
        f"""
        WITH split_rows AS (
            SELECT
                CASE
                    WHEN chain_departure_date <= DATE '{config.splits.train_end.isoformat()}' THEN 'train'
                    WHEN chain_departure_date BETWEEN DATE '{config.splits.validation_select_start.isoformat()}'
                        AND DATE '{config.splits.validation_select_end.isoformat()}' THEN 'validation_select'
                    WHEN chain_departure_date BETWEEN DATE '{config.splits.validation_calibrate_start.isoformat()}'
                        AND DATE '{config.splits.validation_calibrate_end.isoformat()}' THEN 'validation_calibrate'
                    WHEN chain_departure_date BETWEEN DATE '{config.splits.test_start.isoformat()}'
                        AND DATE '{config.splits.test_end.isoformat()}' THEN 'test'
                    ELSE NULL
                END AS split,
                bin_regime,
                bin_index,
                chain_id,
                count(*) OVER (PARTITION BY chain_id, bin_regime, bin_index) AS bin_rows
            FROM resampled
        )
        SELECT
            split,
            bin_regime,
            count(*) AS rows,
            count(*) FILTER (WHERE bin_rows > 1) AS collision_rows,
            count(DISTINCT CASE WHEN bin_rows > 1
                THEN chain_id || '|' || bin_regime || '|' || CAST(bin_index AS VARCHAR) END) AS collision_bins,
            count(DISTINCT chain_id || '|' || bin_regime || '|' || CAST(bin_index AS VARCHAR)) AS bins
        FROM split_rows
        WHERE split IS NOT NULL
        GROUP BY split, bin_regime
        ORDER BY split, bin_regime
        """,
    )
    a19 = _dict_rows(
        connection,
        """
        SELECT
            split,
            count(*) AS rows,
            count(*) FILTER (WHERE hours_to_departure BETWEEN 552 AND 720) AS rows_23_30d,
            count(*) FILTER (WHERE hours_to_departure BETWEEN 552 AND 720 AND history_depth_h < 168)
                AS rows_23_30d_short_history,
            count(*) FILTER (WHERE history_depth_h > 720) AS rows_history_beyond_720
        FROM sampled
        WHERE split IS NOT NULL
        GROUP BY split
        ORDER BY split
        """,
    )
    a24 = _dict_rows(
        connection,
        """
        WITH covered AS (
            SELECT
                s.split,
                s.ttd_band,
                s.observation_era,
                s.chain_id,
                s.snapshot_at,
                s.check_at,
                s.label_observed,
                count(d.observed_at) AS window_observations
            FROM sampled s
            LEFT JOIN chain_dedup d
              ON d.chain_id = s.chain_id
             AND d.observed_at > s.snapshot_at
             AND d.observed_at <= s.snapshot_at + INTERVAL 24 HOUR
            WHERE s.split IS NOT NULL
              AND s.eligible
              AND s.r24_covered
            GROUP BY s.split, s.ttd_band, s.observation_era, s.chain_id, s.snapshot_at, s.check_at, s.label_observed
        )
        SELECT
            split,
            ttd_band AS band,
            observation_era AS era,
            count(*) AS rows,
            count(*) FILTER (WHERE NOT label_observed) AS missing_at_check,
            count(*) FILTER (WHERE NOT label_observed AND window_observations > 0) AS miss_one,
            count(*) FILTER (WHERE NOT label_observed AND window_observations = 0) AS miss_all
        FROM covered
        GROUP BY split, ttd_band, observation_era
        ORDER BY split, ttd_band, observation_era
        """,
    )
    censored_band = _dict_rows(
        connection,
        """
        SELECT
            split,
            ttd_band AS band,
            count(*) FILTER (WHERE label_observed) AS labelled_rows,
            count(*) FILTER (WHERE censor_reason = 'not_listed') AS not_listed,
            count(*) FILTER (
                WHERE censor_reason = 'not_listed' AND breached_within_24h IS NOT NULL
            ) AS censored_observed,
            avg(breached_within_24h) FILTER (
                WHERE censor_reason = 'not_listed' AND breached_within_24h IS NOT NULL
            ) AS censored_within_day_rate,
            avg(breached_within_24h) FILTER (
                WHERE label_observed AND breached_within_24h IS NOT NULL
            ) AS labelled_within_day_rate
        FROM sampled
        WHERE split IS NOT NULL
        GROUP BY split, ttd_band
        ORDER BY split, ttd_band
        """,
    )
    censored_outcome = _dict_rows(
        connection,
        """
        SELECT
            split,
            ttd_band AS band,
            observation_week AS week,
            count(*) FILTER (WHERE label_observed) AS labelled_rows,
            count(*) FILTER (WHERE censor_reason = 'not_listed') AS not_listed,
            count(*) FILTER (
                WHERE censor_reason = 'not_listed' AND breached_within_24h IS NOT NULL
            ) AS censored_observed,
            avg(breached_within_24h) FILTER (
                WHERE censor_reason = 'not_listed' AND breached_within_24h IS NOT NULL
            ) AS censored_within_day_rate,
            avg(breached_within_24h) FILTER (
                WHERE label_observed AND breached_within_24h IS NOT NULL
            ) AS labelled_within_day_rate
        FROM sampled
        WHERE split IS NOT NULL
        GROUP BY split, ttd_band, observation_week
        ORDER BY split, ttd_band, observation_week
        """,
    )
    a26 = _dict_rows(
        connection,
        """
        WITH matched AS (
            SELECT DISTINCT
                s.split,
                s.ttd_band,
                s.observation_era,
                s.series_key,
                s.snapshot_at,
                (g.observed_at IS NOT NULL) AS has_scrape
            FROM sampled s
            LEFT JOIN scrape_grid g
              ON g.route_id = s.route_id
             AND g.departure_date = s.departure_date
             AND g.observed_at BETWEEN s.snapshot_at + INTERVAL 10 HOUR
                                    AND s.snapshot_at + INTERVAL 16 HOUR
             AND g.observed_at < s.departure_planned
            WHERE s.split IS NOT NULL
        )
        SELECT
            split,
            ttd_band AS band,
            observation_era AS era,
            count(*) AS rows,
            count(*) FILTER (WHERE has_scrape) AS scrape_10_16
        FROM matched
        GROUP BY split, ttd_band, observation_era
        ORDER BY split, ttd_band, observation_era
        """,
    )
    tier = _dict_rows(
        connection,
        """
        SELECT
            split,
            ttd_band AS band,
            CASE WHEN future_observations >= 2 THEN 'two_plus' ELSE 'one_or_none' END AS tier,
            count(*) AS rows,
            count(*) FILTER (WHERE label_observed) AS labelled,
            avg(breached_next_day) FILTER (WHERE label_observed) AS prevalence
        FROM sampled
        WHERE split IS NOT NULL
        GROUP BY split, ttd_band, tier
        ORDER BY split, ttd_band, tier
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
            count(*) FILTER (WHERE NOT label_observed) AS unlabelled,
            count(*) FILTER (WHERE censor_reason = 'no_check') AS no_check,
            count(*) FILTER (WHERE censor_reason = 'not_listed') AS not_listed
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
                count(DISTINCT observed_at) AS observations
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
                          AND ns.train_number IS NOT NULL
                          AND ns.train_number = n.train_number
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
                          AND ns.train_number IS NOT NULL
                          AND ns.train_number = n.train_number
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
                {berlin_week_sql("last_obs")} AS observation_week
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
        "chain": chain_stats.to_dict(),
        "chain_v2": v2_chain_audit(connection, source_sql, strict=chain_stats.strict),
        "duplicates": duplicate_audit(connection),
        "scrape_gap": scrape_gap_audit(connection),
        "headroom": [
            {
                "split": str(row[0]),
                "headroom_pct": int(row[1]),
                "rows": int(row[2]),
                "eligible": int(row[3]),
                "labelled": int(row[4]),
                "positives": int(row[5]),
                "positive_rate": 0.0 if row[6] is None else float(row[6]),
            }
            for row in headroom
        ],
        "era": [{"split": str(row[0]), "observation_era": str(row[1]), "rows": int(row[2])} for row in era],
        "coverage": [
            {
                "split": str(row[0]),
                "eligible_share": float(row[1] or 0.0),
                "labelled_share": float(row[2] or 0.0),
                "censor_share": float(row[3] or 0.0),
                "r24_share": None if row[4] is None else float(row[4]),
                "within_24h_r24_rate": None if row[5] is None else float(row[5]),
            }
            for row in coverage
        ],
        "cohort": cohort,
        "early_window": early_window,
        "ttd": [
            {
                "split": str(row[0]),
                "band": str(row[1]),
                "rows": int(row[2]),
                "eligible": int(row[3]),
                "labelled": int(row[4]),
                "positives": int(row[5]),
                "positive_rate": None if row[6] is None else float(row[6]),
            }
            for row in ttd
        ],
        "label": label,
        "label_era": label_era,
        "label_week": label_week,
        "a18": a18,
        "a19": a19,
        "a24": a24,
        "censored_band": censored_band,
        "censored_outcome": censored_outcome,
        "a26": a26,
        "a29": a29,
        "tier": tier,
        "unlabelled": [
            {
                "split": str(row[0]),
                "band": str(row[1]),
                "era": str(row[2]),
                "week": str(row[3]),
                "rows": int(row[4]),
                "unlabelled": int(row[5]),
                "no_check": int(row[6]),
                "not_listed": int(row[7]),
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
        "journey": {
            "total_journeys": total_journeys,
            "at_risk": at_risk,
            "disappeared": disappeared,
            "at_risk_with_next_scrape": disappeared,
            "end_of_observation_at_risk": max(0, at_risk - disappeared),
            "share": 0.0 if total_journeys == 0 else disappeared / total_journeys,
            "share_at_risk": 0.0 if at_risk == 0 else disappeared / at_risk,
            "share_end_of_observation": 0.0 if at_risk == 0 else max(0, at_risk - disappeared) / at_risk,
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
    """Gate every split on eligible rows and positives, not on a future-selected coverage floor."""
    for split in stats.splits:
        if split.rows == 0:
            raise DatasetError(f"split {split.split} is empty")
        if split.eligible < config.report.min_eligible_rows:
            raise DatasetError(
                f"split {split.split} has {split.eligible} eligible rows; floor is {config.report.min_eligible_rows}"
            )
        if split.positives < config.report.min_split_positives:
            raise DatasetError(
                f"split {split.split} has {split.positives} positives; floor is {config.report.min_split_positives}"
            )
    gated_splits = {"validation_select", "validation_calibrate", "test"}
    for item in profile["headroom"]:
        if item["split"] not in gated_splits:
            continue
        if config.report.min_headroom_positives <= 0:
            continue
        if item["positives"] < config.report.min_headroom_positives:
            raise DatasetError(
                f"split {item['split']} headroom {item['headroom_pct']}% has "
                f"{item['positives']} positives; floor is {config.report.min_headroom_positives}"
            )
    for item in profile["ttd"]:
        if item["split"] not in gated_splits:
            continue
        if config.report.min_band_positives <= 0:
            continue
        if item["positives"] < config.report.min_band_positives:
            raise DatasetError(
                f"split {item['split']} band {item['band']} has "
                f"{item['positives']} positives; floor is {config.report.min_band_positives}"
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
    strict_chains: bool = False,
    forward: bool = False,
) -> DatasetStats:
    """Build the panel, profile it and write the Parquet splits."""
    # Provenance is the checkout state when the build starts, not when it happens to finish.
    git_sha, git_dirty, git_untracked = _git_state()
    started = time.perf_counter()
    out_dir = out_dir.resolve()
    dataset_dir = out_dir / "dataset"
    calendar_set = config.calendar.feature_set
    spec = feature_spec(calendar_set)
    source_sql = read_parquet(source.glob, union_by_name=False)
    source_rows = _source_count(connection, source_sql)
    if source_rows == 0:
        raise DatasetError(f"source {source.label} contains no rows")

    build_started = time.perf_counter()
    chain_stats = _create_views(
        connection,
        source_sql,
        config,
        calendar_set,
        strict_chains=strict_chains,
        forward=forward,
    )
    build_started = _phase("dataset views", build_started)

    columns = _forward_columns(calendar_set) if forward else _final_columns(calendar_set)
    missing = set(columns) - {row[0] for row in connection.execute("DESCRIBE SELECT * FROM sampled").fetchall()}
    if missing:
        raise DatasetError(f"sampled panel is missing columns: {sorted(missing)}")
    selected = ", ".join(columns)
    if forward:
        rows = _scalar(connection, "SELECT count(*) FROM sampled")
        if rows == 0:
            raise DatasetError("forward panel is empty; check the departure window and source")
        series = _scalar(connection, "SELECT count(DISTINCT series_key) FROM sampled")
        route_days = _scalar(
            connection,
            "SELECT count(DISTINCT route_id || '|' || CAST(departure_date AS VARCHAR)) FROM sampled",
        )
        bounds = connection.execute("SELECT min(departure_date), max(departure_date) FROM sampled").fetchone()
        coverage = _dict_rows(
            connection,
            """
            SELECT ttd_band AS band, count(*) AS rows, sum(CASE WHEN eligible THEN 1 ELSE 0 END) AS eligible
            FROM sampled
            GROUP BY ttd_band
            ORDER BY ttd_band
            """,
        )
        route_days_total = _scalar(
            connection,
            "SELECT count(DISTINCT route_id || '|' || CAST(departure_date AS VARCHAR)) FROM base_all",
        )
        sampled_route_days = _scalar(
            connection,
            "SELECT count(DISTINCT route_id || '|' || CAST(departure_date AS VARCHAR)) FROM base_sampled",
        )
        domain_route_days = _scalar(
            connection,
            f"""
            SELECT count(DISTINCT route_id || '|' || CAST(departure_date AS VARCHAR))
            FROM base_all
            WHERE hours_to_departure BETWEEN {config.protocol.forward_min_hours_to_departure}
                AND {config.protocol.forward_max_hours_to_departure}
            """,
        )
        departure_dates = _scalar(connection, "SELECT count(DISTINCT departure_date) FROM sampled")
        missing_dates = [
            str(row[0])
            for row in connection.execute(
                f"""
                SELECT CAST(day AS DATE)
                FROM generate_series(
                    DATE '{config.protocol.forward_start.isoformat()}',
                    DATE '{config.protocol.forward_end.isoformat()}',
                    INTERVAL 1 DAY
                ) AS calendar(day)
                EXCEPT
                SELECT departure_date FROM sampled
                ORDER BY 1
                """
            ).fetchall()
        ]
        null_counts = connection.execute(
            "SELECT "
            + ", ".join(f'sum(CASE WHEN "{name}" IS NULL THEN 1 ELSE 0 END)' for name in spec.names)
            + " FROM sampled"
        ).fetchone()
        if null_counts is None:
            raise DatasetError("forward feature missingness query returned no row")
        feature_missingness = {
            name: round(float(count or 0) / rows, 6) for name, count in zip(spec.names, null_counts, strict=True)
        }
        out_dir.mkdir(parents=True, exist_ok=True)
        forward_path = out_dir / "forward.parquet"
        connection.execute(
            f"COPY (SELECT {selected} FROM sampled "
            f"ORDER BY series_key, snapshot_at, bin_regime, bin_index) "
            f"TO '{sql_string(forward_path.as_posix())}' (FORMAT parquet, COMPRESSION zstd)"
        )
        roles_payload = {
            "version": 1,
            "features": list(spec.names),
            "audit": [name for name in AUDIT_COLUMNS if name not in set(spec.names)],
            "grid": ["eligible", "check_at", "check_lag_h"],
        }
        roles_bytes = (json.dumps(roles_payload, indent=2, sort_keys=True) + "\n").encode("utf-8")
        roles_path = out_dir / "forward_column_roles.json"
        roles_path.write_bytes(roles_bytes)
        source_inventory = _source_inventory(connection, source)
        git_sha_end, git_dirty_end, git_untracked_end = _git_state()
        forward_manifest = {
            "forward": True,
            "run_id": run_id,
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "source": source.label,
            "source_rows": source_rows,
            "source_inventory": source_inventory,
            "git_sha": git_sha,
            "git_dirty": git_dirty,
            "git_untracked": list(git_untracked),
            "config_sha256": config.hash(),
            "feature_spec_sha256": hashlib.sha256(json.dumps(list(spec.names)).encode()).hexdigest(),
            "column_roles": roles_path.name,
            "column_roles_sha256": hashlib.sha256(roles_bytes).hexdigest(),
            "columns": list(columns),
            "departure_start": config.protocol.forward_start.isoformat(),
            "departure_end": config.protocol.forward_end.isoformat(),
            "min_hours_to_departure": config.protocol.forward_min_hours_to_departure,
            "max_hours_to_departure": config.protocol.forward_max_hours_to_departure,
            "forward_sample_rate": config.protocol.forward_sample_rate,
            "rows": rows,
            "series": series,
            "route_days": route_days,
            "route_days_total": route_days_total,
            "sampled_route_days": sampled_route_days,
            "route_days_with_domain_rows": domain_route_days,
            "departure_dates": departure_dates,
            "missing_departure_dates": missing_dates,
            "missing_departure_reason": ("13-18 October scraper outage" if missing_dates else None),
            "feature_missingness": feature_missingness,
            "departure_bounds": None if bounds is None else [str(bounds[0]), str(bounds[1])],
            "coverage": coverage,
            "chains": chain_stats.to_dict(),
            "git_sha_end": git_sha_end,
            "git_dirty_end": git_dirty_end,
            "git_untracked_end": list(git_untracked_end),
            "runtime_seconds": round(time.perf_counter() - started, 3),
            "peak_rss_kb": _peak_rss_kb(),
            "threads": threads,
            "cli_argv": list(cli_argv or ()),
            "duckdb_settings": _duckdb_settings(connection),
            "artifact_sha256": hashlib.sha256(forward_path.read_bytes()).hexdigest(),
        }
        (out_dir / "forward_manifest.json").write_text(
            json.dumps(forward_manifest, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8"
        )
        return DatasetStats(
            run_id=run_id,
            rows=rows,
            labelled_rows=0,
            series=series,
            route_days=route_days,
            splits=(),
            duration_seconds=round(time.perf_counter() - started, 3),
            profile={"forward": forward_manifest},
        )
    split_names = ("train", "validation_select", "validation_calibrate", "test")
    splits = _split_stats(connection)
    profile = _profile(connection, chain_stats, source_sql, config)
    build_started = _phase("profile audits", build_started)
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
    if not chain_stats.strict and (chain_stats.ambiguous_predecessors or chain_stats.ambiguous_successors):
        warnings.append(
            "ambiguous chain candidates: "
            f"{chain_stats.ambiguous_predecessors} predecessors / "
            f"{chain_stats.ambiguous_successors} successors; run --strict-chains"
        )
    source_inventory = _source_inventory(connection, source)
    if not source_inventory:
        warnings.append("source inventory is empty; the scanned file set is not localisable")
    git_sha_end, git_dirty_end, git_untracked_end = _git_state()
    if (git_sha_end, git_dirty_end, git_untracked_end) != (git_sha, git_dirty, git_untracked):
        warnings.append("git state changed during the run; the manifest keeps the start state")
    stats = replace(stats, warnings=tuple(warnings))

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

    roles_payload = column_roles(spec)
    roles_bytes = (json.dumps(roles_payload, indent=2, sort_keys=True) + "\n").encode("utf-8")
    manifest = {
        "manifest_version": 3,
        "run_id": run_id,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": source.label,
        "source_rows": source_rows,
        "source_inventory": source_inventory,
        "dataset_peak_rss_kb": _peak_rss_kb(),
        "git_sha": git_sha,
        "git_dirty": git_dirty,
        "git_untracked": list(git_untracked),
        "git_sha_end": git_sha_end,
        "git_dirty_end": git_dirty_end,
        "git_untracked_end": list(git_untracked_end),
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
        "column_roles": "column_roles.json",
        "column_roles_sha256": hashlib.sha256(roles_bytes).hexdigest(),
        "chains": {
            "strict": chain_stats.strict,
            "link_tolerance_seconds": LINK_TOLERANCE_SECONDS,
            "base_series": chain_stats.base_series,
            "split_series": chain_stats.split_series,
            "links": chain_stats.links,
            "link_rate": chain_stats.link_rate,
        },
        "strict_chains": strict_chains,
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
            "estimand": config.label.estimand,
            "horizon_hours": config.label.horizon_hours,
            "check_window_hours": list(config.label.check_window_hours),
            "headroom_pct": list(config.label.headroom_pct),
            "min_hours_to_departure": config.label.min_hours_to_departure,
            "max_hours_to_departure": config.label.max_hours_to_departure,
        },
        "stats": stats.to_dict(),
        "package_versions": _package_versions(),
        "warnings": list(warnings),
    }
    profile_bytes = (json.dumps(stats.to_dict(), indent=2, sort_keys=True, default=str) + "\n").encode("utf-8")
    manifest["profile_sha256"] = hashlib.sha256(profile_bytes).hexdigest()
    _phase("splits and manifest", build_started)
    (out_dir / "column_roles.json").write_bytes(roles_bytes)
    (out_dir / "dataset_manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8"
    )
    (out_dir / "profile.json").write_bytes(profile_bytes)
    return stats
