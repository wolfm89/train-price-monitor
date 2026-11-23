"""Time-to-departure bands shared by the dataset diagnostics and the evaluation report."""

from __future__ import annotations

import math

# Headline bands from the review plan. Bounds are hours before departure, lower-inclusive.
HEADLINE_BANDS: tuple[tuple[str, int, int], ...] = (
    ("1-3d", 24, 72),
    ("3-5d", 72, 120),
    ("5-7d", 120, 168),
    ("7-14d", 168, 336),
    ("14-30d", 336, 720),
)

# Journey diagnostics include disappearances earlier than the 30-day model domain.
JOURNEY_BANDS: tuple[tuple[str, int, int], ...] = (*HEADLINE_BANDS, (">30d", 720, 87_600))

# Finer bands below 48 h for the climatology baseline; the remaining bands match the headline.
CLIMATOLOGY_BANDS: tuple[tuple[str, int, int], ...] = (
    ("24-48h", 24, 48),
    ("2-3d", 48, 72),
    ("3-5d", 72, 120),
    ("5-7d", 120, 168),
    ("7-14d", 168, 336),
    ("14-30d", 336, 720),
)


def ttd_band(hours: float, bands: tuple[tuple[str, int, int], ...] = HEADLINE_BANDS) -> str:
    """Return the band label for one hours-to-departure value."""
    if not math.isfinite(hours):
        return "unknown"
    for index, (label, low, high) in enumerate(bands):
        if low <= hours < high or (index == len(bands) - 1 and hours == high):
            return label
    return "unknown"


def ttd_band_case(column: str, bands: tuple[tuple[str, int, int], ...] = HEADLINE_BANDS) -> str:
    """Return a SQL CASE expression that maps a numeric hours column to a band label."""
    whens = []
    for index, (label, low, high) in enumerate(bands):
        operator = "<=" if index == len(bands) - 1 else "<"
        whens.append(f"WHEN {column} >= {low} AND {column} {operator} {high} THEN '{label}'")
    return "CASE " + " ".join(whens) + " ELSE 'unknown' END"


def band_labels(bands: tuple[tuple[str, int, int], ...] = HEADLINE_BANDS) -> tuple[str, ...]:
    """Return the labels of the supplied TTD bands."""
    return tuple(label for label, _, _ in bands)
