"""The feature allowlist shared by the dataset builder, preprocessing and report.

The SQL builder produces these columns; this module is the single list of names the model may use.
It deliberately does not generate SQL: a mismatch is an error rather than a silent extra column.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from tpm_analytics.training.config import CALENDAR_SETS

NUMERIC = "numeric"
CATEGORICAL = "categorical"
BOOLEAN = "boolean"


@dataclass(frozen=True)
class Feature:
    name: str
    kind: str
    nullable: bool = False
    source: str = "silver"


CORE_FEATURES: tuple[Feature, ...] = (
    Feature("price_eur", NUMERIC, source="resampled fare"),
    Feature("headroom_pct", NUMERIC, source="synthetic limit"),
    Feature("price_rank_route_day", NUMERIC, nullable=True, source="route-day cross-section"),
    Feature("price_rank_missing", BOOLEAN, source="route-day cross-section"),
    Feature("price_vs_series_min", NUMERIC, source="running series history"),
    Feature("price_vs_series_median", NUMERIC, source="running series history"),
    Feature("price_change_24h", NUMERIC, nullable=True, source="as-of 24 h"),
    Feature("price_change_24h_missing", BOOLEAN, source="as-of 24 h"),
    Feature("price_velocity_24h", NUMERIC, nullable=True, source="as-of 24 h"),
    Feature("price_jumps_24h", NUMERIC, source="resampled grid"),
    Feature("price_min_7d", NUMERIC, source="trailing 7 days"),
    Feature("price_max_7d", NUMERIC, source="trailing 7 days"),
    Feature("price_drawdown_7d", NUMERIC, source="trailing 7 days"),
    Feature("price_runup_7d", NUMERIC, source="trailing 7 days"),
    Feature("load_factor_ordinal", CATEGORICAL, nullable=True, source="current"),
    Feature("load_factor_missing", BOOLEAN, source="current"),
    Feature("load_factor_change_24h", NUMERIC, nullable=True, source="as-of 24 h"),
    Feature("load_factor_change_24h_missing", BOOLEAN, source="as-of 24 h"),
    Feature("hours_to_departure", NUMERIC, source="known"),
    Feature("departure_weekday", CATEGORICAL, source="known"),
    Feature("departure_hour_local", NUMERIC, source="known"),
    Feature("service_class", CATEGORICAL, source="known"),
    Feature("distance_km", NUMERIC, source="silver"),
    Feature("train_type", CATEGORICAL, source="silver"),
    Feature("duration_minutes", NUMERIC, source="silver"),
    Feature("transfers_actual", NUMERIC, nullable=True, source="silver"),
    Feature("transfers_missing", BOOLEAN, source="silver"),
    Feature("origin_state", CATEGORICAL, source="silver"),
    Feature("dest_state", CATEGORICAL, source="silver"),
    Feature("origin_station_category", CATEGORICAL, source="silver"),
    Feature("dest_station_category", CATEGORICAL, source="silver"),
)

PUBLIC_CALENDAR: tuple[Feature, ...] = (
    Feature("origin_public_holiday", BOOLEAN, source="calendar"),
    Feature("dest_public_holiday", BOOLEAN, source="calendar"),
    Feature("min_days_to_public_holiday", NUMERIC, nullable=True, source="calendar"),
    Feature("origin_public_holiday_window", BOOLEAN, source="calendar"),
    Feature("dest_public_holiday_window", BOOLEAN, source="calendar"),
    Feature("is_state_match", BOOLEAN, source="calendar"),
)

SCHOOL_CALENDAR: tuple[Feature, ...] = (
    Feature("origin_school_holiday", BOOLEAN, source="calendar"),
    Feature("dest_school_holiday", BOOLEAN, source="calendar"),
    Feature("origin_school_holiday_type", CATEGORICAL, nullable=True, source="calendar"),
    Feature("dest_school_holiday_type", CATEGORICAL, nullable=True, source="calendar"),
    Feature("origin_school_holiday_day", NUMERIC, nullable=True, source="calendar"),
    Feature("dest_school_holiday_day", NUMERIC, nullable=True, source="calendar"),
    Feature("origin_days_until_school_holiday_end", NUMERIC, nullable=True, source="calendar"),
    Feature("dest_days_until_school_holiday_end", NUMERIC, nullable=True, source="calendar"),
    Feature("either_school_holiday_start_window", BOOLEAN, source="calendar"),
    Feature("either_school_holiday_end_window", BOOLEAN, source="calendar"),
)

FULL_CALENDAR: tuple[Feature, ...] = (
    Feature("either_bridge_day", BOOLEAN, source="calendar"),
    Feature("origin_public_holiday_scope", CATEGORICAL, nullable=True, source="calendar"),
    Feature("dest_public_holiday_scope", CATEGORICAL, nullable=True, source="calendar"),
)

CALENDAR_FEATURES: dict[str, tuple[Feature, ...]] = {
    "none": (),
    "public": PUBLIC_CALENDAR,
    "public_school": PUBLIC_CALENDAR + SCHOOL_CALENDAR,
    "full": PUBLIC_CALENDAR + SCHOOL_CALENDAR + FULL_CALENDAR,
}


@dataclass(frozen=True)
class FeatureSpec:
    calendar_set: str
    features: tuple[Feature, ...]

    def __post_init__(self) -> None:
        if self.calendar_set not in CALENDAR_SETS:
            raise ValueError(f"unknown calendar feature set {self.calendar_set!r}")
        names = [feature.name for feature in self.features]
        if len(names) != len(set(names)):
            raise ValueError("feature names must be unique")

    @property
    def names(self) -> tuple[str, ...]:
        return tuple(feature.name for feature in self.features)


def feature_spec(calendar_set: str) -> FeatureSpec:
    if calendar_set not in CALENDAR_FEATURES:
        raise ValueError(f"unknown calendar feature set {calendar_set!r}")
    return FeatureSpec(calendar_set, CORE_FEATURES + CALENDAR_FEATURES[calendar_set])


LABEL_COLUMNS = (
    "limit_eur",
    "breached_in_24h",
    "label_observed",
    "future_max_fare_24h",
    "future_observations",
    "future_last_observed_at",
    "future_span_h",
    "label_window_end",
    "check_at",
    "check_lag_h",
    "check_at_narrow",
    "check_lag_narrow_h",
    "check_at_2028",
    "check_lag_2028_h",
    "check_at_2226",
    "check_lag_2226_h",
    "check_price_eur",
    "check_price_narrow_eur",
    "check_price_2028_eur",
    "check_price_2226_eur",
    "breached_at_check",
    "breached_at_check_narrow",
    "breached_at_check_2028",
    "breached_at_check_2226",
    "crossed_and_came_back",
    "cov_tail_h",
    "cov_max_gap_h",
    "r24_covered",
)

AUDIT_COLUMNS = (
    "series_key",
    "chain_id",
    "chain_departure_date",
    "journey_id",
    "service_class",
    "route_id",
    "departure_planned",
    "departure_date",
    "snapshot_at",
    "hours_to_departure",
    "headroom_pct",
    "ttd_band",
    "observation_week",
    "bin_regime",
    "bin_index",
    "bin_width_hours",
    "history_depth_h",
    "observation_era",
    "scrapes_per_route_day_final",
    "fare_available",
    "split",
)


def column_roles(spec: FeatureSpec) -> dict[str, Any]:
    """Return the feature/label/audit role of every output column.

    The Parquet files keep one flat schema for compatibility with DuckDB and the model loader.
    The sidecar makes the non-feature columns explicit so a new join or diagnostic cannot quietly
    enter the model matrix.
    """
    features = list(spec.names)
    labels = [name for name in LABEL_COLUMNS if name not in features]
    audit = [name for name in AUDIT_COLUMNS if name not in features and name not in labels]
    return {"version": 1, "features": features, "labels": labels, "audit": audit}
