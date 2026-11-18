"""Build the training panel and write one Parquet file per split.

The pipeline stays in SQL until the model matrix: DuckDB handles the 100M-row scan, the exact
forward-looking label window (a numeric ``RANGE`` frame over epoch hours), the route-day
cross-section and the calendar join. Every step is a view so DuckDB can keep the plan lazy.
"""

from __future__ import annotations

import hashlib
import json
import platform
import time
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path
from typing import Any

import duckdb

from tpm_analytics import calendar
from tpm_analytics.silver._duck import read_parquet, sql_string
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
          AND date_diff('second', observed_at, departure_planned) / 3600.0
              <= {label.max_hours_to_departure + 36}
        """
    )
    v2_rows = _scalar(
        connection,
        "SELECT count(*) FROM base_all WHERE ("
        f"departure_date <= DATE '{splits.train_end.isoformat()}' "
        f"OR departure_date BETWEEN DATE '{splits.validation_select_start.isoformat()}' "
        f"AND DATE '{splits.validation_select_end.isoformat()}' "
        f"OR departure_date BETWEEN DATE '{splits.validation_calibrate_start.isoformat()}' "
        f"AND DATE '{splits.validation_calibrate_end.isoformat()}' "
        f"OR departure_date BETWEEN DATE '{splits.test_start.isoformat()}' "
        f"AND DATE '{splits.test_end.isoformat()}') "
        "AND (schema_version != 1 OR journey_id IS NOT NULL)",
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
            f"CREATE OR REPLACE TEMP VIEW base_sampled AS "
            f"SELECT * FROM base_all WHERE route_day_hash IN ("
            f"SELECT route_day_hash FROM (SELECT DISTINCT route_day_hash FROM base_all) "
            f"ORDER BY route_day_hash LIMIT {config.sample.max_route_days})"
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
        CREATE OR REPLACE TEMP VIEW dedup AS
        SELECT
            series_key,
            observed_at,
            max(price_eur) AS price_eur,
            max(load_factor_ordinal) AS load_factor_ordinal
        FROM base_sampled
        GROUP BY series_key, observed_at
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
                ORDER BY observed_at DESC, price_eur DESC, load_factor_ordinal DESC NULLS LAST
            ) AS rn
        FROM cross_section
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW snapshot AS
        SELECT
            r.* EXCLUDE (rn),
            f.future_max_fare_24h,
            f.future_observations,
            f.future_last_observed_at,
            (f.future_max_fare_24h IS NOT NULL) AS label_observed
        FROM resampled r
        LEFT JOIN future f USING (series_key, observed_at)
        WHERE r.rn = 1
          AND r.hours_to_departure BETWEEN {label.min_hours_to_departure} AND {label.max_hours_to_departure}
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW labelled AS
        SELECT
            *,
            {bucket_expr} AS bucket
        FROM snapshot
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
            lag(price_eur) OVER (PARTITION BY series_key ORDER BY observed_at) AS prev_price,
            min(observed_at) OVER (PARTITION BY series_key) AS first_observed_at
        FROM split_rows
        """
    )
    connection.execute(
        """
        CREATE OR REPLACE TEMP VIEW features_window AS
        SELECT
            * EXCLUDE (prev_price, first_observed_at),
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
            sum(
                CASE
                    WHEN prev_price IS NOT NULL
                     AND abs(price_eur - prev_price) / nullif(prev_price, 0) > 0.05
                    THEN 1 ELSE 0
                END
            ) OVER (
                PARTITION BY series_key ORDER BY epoch(observed_at) / 3600.0
                RANGE BETWEEN 24 PRECEDING AND CURRENT ROW
            ) AS price_jumps_24h,
            date_diff('second', first_observed_at, observed_at) / 3600.0 AS history_depth_h
        FROM features_base
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
            AND (p.observed_at - INTERVAL 24 HOUR) >= h.observed_at
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

    connection.execute("CREATE OR REPLACE TEMP TABLE sampled AS SELECT * FROM panel_calendar")
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
            avg(CASE WHEN future_observations >= 2 THEN 1 ELSE 0 END) AS two_plus_share
        FROM sampled
        WHERE split IS NOT NULL
        GROUP BY split
        ORDER BY split
        """
    ).fetchall()
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
            }
            for row in coverage
        ],
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
) -> DatasetStats:
    """Build the panel, profile it and write the Parquet splits."""
    started = time.perf_counter()
    out_dir = out_dir.resolve()
    dataset_dir = out_dir / "dataset"
    dataset_dir.mkdir(parents=True, exist_ok=True)
    calendar_set = config.calendar.feature_set
    spec = feature_spec(calendar_set)
    source_sql = read_parquet(source.glob, union_by_name=False)
    source_rows = _source_count(connection, source_sql)
    if source_rows == 0:
        raise DatasetError(f"source {source.label} contains no rows")

    _create_views(connection, source_sql, config, calendar_set)

    v2 = _scalar(
        connection,
        "SELECT count(*) FROM base_all WHERE ("
        f"departure_date <= DATE '{config.splits.train_end.isoformat()}' "
        f"OR departure_date BETWEEN DATE '{config.splits.validation_select_start.isoformat()}' "
        f"AND DATE '{config.splits.validation_select_end.isoformat()}' "
        f"OR departure_date BETWEEN DATE '{config.splits.validation_calibrate_start.isoformat()}' "
        f"AND DATE '{config.splits.validation_calibrate_end.isoformat()}' "
        f"OR departure_date BETWEEN DATE '{config.splits.test_start.isoformat()}' "
        f"AND DATE '{config.splits.test_end.isoformat()}') "
        "AND (schema_version != 1 OR journey_id IS NOT NULL)",
    )
    if v2:
        raise DatasetError(f"{v2} v2 rows fall inside the baseline splits; this baseline is v1-only")

    columns = _final_columns(calendar_set)
    missing = set(columns) - {row[0] for row in connection.execute("DESCRIBE SELECT * FROM sampled").fetchall()}
    if missing:
        raise DatasetError(f"sampled panel is missing columns: {sorted(missing)}")
    selected = ", ".join(columns)
    dataset_files: list[dict[str, Any]] = []
    if write_splits:
        for split in ("train", "validation_select", "validation_calibrate", "test"):
            target = dataset_dir / f"{split}.parquet"
            connection.execute(
                f"COPY (SELECT {selected} FROM sampled WHERE split = '{split}') "
                f"TO '{sql_string(target.as_posix())}' (FORMAT parquet, COMPRESSION zstd)"
            )
            dataset_files.append(
                {
                    "split": split,
                    "path": f"dataset/{target.name}",
                    "bytes": target.stat().st_size,
                    "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                }
            )
    splits = _split_stats(connection)
    profile = _profile(connection)
    if {item.split for item in splits} != {
        "train",
        "validation_select",
        "validation_calibrate",
        "test",
    }:
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

    manifest = {
        "manifest_version": 1,
        "run_id": run_id,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": source.label,
        "source_rows": source_rows,
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
        "package_versions": {
            "python": platform.python_version(),
            "duckdb": duckdb.__version__,
        },
        "warnings": list(warnings),
    }
    (out_dir / "dataset_manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8"
    )
    (out_dir / "profile.json").write_text(
        json.dumps(stats.to_dict(), indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8"
    )
    return stats
