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
    """One feature in the model allowlist."""

    name: str
    kind: str
    nullable: bool = False
    source: str = "silver"


# The names keep the historical "series" wording. Since the journey-identity change, the history
# and label partitions are the journey chain, not the itinerary-keyed series.
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


def analog_features(offsets: tuple[int, ...]) -> tuple[Feature, ...]:
    """Return the analog-departure columns for the requested day offsets."""
    features: list[Feature] = []
    for offset in offsets:
        features.extend(
            (
                Feature(f"analog_d{offset}_price_ratio", NUMERIC, nullable=True, source="analog departure"),
                Feature(f"analog_d{offset}_lead_gap_h", NUMERIC, nullable=True, source="analog departure"),
                Feature(f"analog_d{offset}_next_ratio", NUMERIC, nullable=True, source="analog departure"),
                Feature(f"analog_d{offset}_rise_lead_gap_h", NUMERIC, nullable=True, source="analog departure"),
            )
        )
    return tuple(features)


# Grouped permutation importance reports these families; every feature belongs to exactly one.
FEATURE_FAMILIES: dict[str, tuple[str, ...]] = {
    "price_level": (
        "price_eur",
        "price_rank_route_day",
        "price_rank_missing",
    ),
    # The user's headroom is the label's own parameter, not a market driver; keep it separate so
    # the price-level family is not read as causal.
    "limit": ("headroom_pct",),
    "price_history": (
        "price_vs_series_min",
        "price_vs_series_median",
        "price_change_24h",
        "price_change_24h_missing",
        "price_velocity_24h",
        "price_jumps_24h",
        "price_min_7d",
        "price_max_7d",
        "price_drawdown_7d",
        "price_runup_7d",
    ),
    "load_factor": (
        "load_factor_ordinal",
        "load_factor_missing",
        "load_factor_change_24h",
        "load_factor_change_24h_missing",
    ),
    "timing": (
        "hours_to_departure",
        "departure_weekday",
        "departure_hour_local",
    ),
    "route": (
        "service_class",
        "distance_km",
        "train_type",
        "duration_minutes",
        "transfers_actual",
        "transfers_missing",
        "origin_state",
        "dest_state",
        "origin_station_category",
        "dest_station_category",
    ),
    "calendar": tuple(feature.name for feature in PUBLIC_CALENDAR + SCHOOL_CALENDAR + FULL_CALENDAR),
    "analog_d1": tuple(feature.name for feature in analog_features((1,))),
    "analog_d7": tuple(feature.name for feature in analog_features((7,))),
}


def family_members() -> dict[str, tuple[str, ...]]:
    """Return the feature families with every feature in exactly one family."""
    return dict(FEATURE_FAMILIES)


def feature_family(name: str) -> str:
    """Return the family of one feature name."""
    for family, names in FEATURE_FAMILIES.items():
        if name in names:
            return family
    raise ValueError(f"feature {name!r} is not assigned to a family")


CALENDAR_FEATURES: dict[str, tuple[Feature, ...]] = {
    "none": (),
    "public": PUBLIC_CALENDAR,
    "public_school": PUBLIC_CALENDAR + SCHOOL_CALENDAR,
    "full": PUBLIC_CALENDAR + SCHOOL_CALENDAR + FULL_CALENDAR,
}


@dataclass(frozen=True)
class FeatureSpec:
    """The ordered feature allowlist for a calendar set."""

    calendar_set: str
    features: tuple[Feature, ...]

    def __post_init__(self) -> None:
        """Validate that the feature allowlist is internally consistent."""
        if self.calendar_set not in CALENDAR_SETS:
            raise ValueError(f"unknown calendar feature set {self.calendar_set!r}")
        names = [feature.name for feature in self.features]
        if len(names) != len(set(names)):
            raise ValueError("feature names must be unique")

    @property
    def names(self) -> tuple[str, ...]:
        """Return feature names in declaration order."""
        return tuple(feature.name for feature in self.features)


def feature_spec(calendar_set: str, *, analog_offsets: tuple[int, ...] = ()) -> FeatureSpec:
    """Return the allowlisted feature specification for a calendar set and analog offsets."""
    if calendar_set not in CALENDAR_FEATURES:
        raise ValueError(f"unknown calendar feature set {calendar_set!r}")
    return FeatureSpec(
        calendar_set,
        CORE_FEATURES + CALENDAR_FEATURES[calendar_set] + analog_features(analog_offsets),
    )


def study_feature_spec(analog_offsets: tuple[int, ...]) -> FeatureSpec:
    """Return the superset spec built for the feature study.

    The study build contains every candidate family; each arm selects its own active subset from
    the same panel. ``calendar_set = full`` is the widest calendar set.
    """
    return FeatureSpec("full", CORE_FEATURES + CALENDAR_FEATURES["full"] + analog_features(analog_offsets))


LABEL_COLUMNS = (
    "limit_eur",
    "price_cents",
    "check_price_cents",
    "breached_next_day",
    "eligible",
    "censor_reason",
    "fare_lost",
    "label_observed",
    "future_max_fare_24h",
    "future_max_fare_24h_cents",
    "future_observations",
    "future_last_observed_at",
    "future_span_h",
    "breached_within_24h",
    "label_window_end",
    "check_at",
    "check_lag_h",
    "check_price_eur",
    "check_at_2024",
    "check_lag_2024_h",
    "check_price_2024_eur",
    "check_price_2024_cents",
    "breached_at_check_2024",
    "check_at_2226",
    "check_lag_2226_h",
    "check_price_2226_eur",
    "check_price_2226_cents",
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


def column_roles(spec: FeatureSpec, candidates: tuple[Feature, ...] = ()) -> dict[str, Any]:
    """Return the feature/label/audit role of every output column.

    The Parquet files keep one flat schema for compatibility with DuckDB and the model loader.
    The sidecar makes the non-feature columns explicit so a new join or diagnostic cannot quietly
    enter the model matrix. ``candidates`` are columns present in the dataset for a feature study
    but outside the default model allowlist.
    """
    features = list(spec.names)
    candidate_names = [feature.name for feature in candidates if feature.name not in spec.names]
    if len(candidate_names) != len(set(candidate_names)):
        raise ValueError("candidate feature names must be unique")
    allowed_overlaps = {"headroom_pct", "hours_to_departure", "service_class"}
    overlaps = (set(LABEL_COLUMNS) | set(AUDIT_COLUMNS)) & set(features)
    unexpected = overlaps - allowed_overlaps
    if unexpected:
        raise ValueError(f"label/audit columns collide with features: {sorted(unexpected)}")
    label_overlaps = (set(LABEL_COLUMNS) | set(AUDIT_COLUMNS)) & set(candidate_names)
    if label_overlaps:
        raise ValueError(f"label/audit columns collide with candidate features: {sorted(label_overlaps)}")
    labels = [name for name in LABEL_COLUMNS if name not in features and name not in candidate_names]
    audit = [
        name for name in AUDIT_COLUMNS if name not in features and name not in candidate_names and name not in labels
    ]
    return {
        "version": 2,
        "features": features,
        "candidate_feature": candidate_names,
        "labels": labels,
        "audit": audit,
    }
