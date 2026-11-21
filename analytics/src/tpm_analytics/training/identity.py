"""Shared journey-identity definitions for the training builder."""

from __future__ import annotations

LINK_TOLERANCE_SECONDS = 900


def berlin_local_sql(column: str) -> str:
    """Return ``column`` shifted from UTC to Europe/Berlin wall time.

    DuckDB's ICU timezone functions need ``pytz`` in the Python client, which the training group
    does not install. The EU rule since 1996 is exact for this corpus: summer time starts at
    01:00 UTC on the last Sunday of March and ends at 01:00 UTC on the last Sunday of October.
    """
    year = f"year({column})"
    start = (
        f"date_trunc('week', date_trunc('month', make_date({year}, 3, 1)) + INTERVAL '1 month') "
        "- INTERVAL '1 day' + INTERVAL '1 hour'"
    )
    end = (
        f"date_trunc('week', date_trunc('month', make_date({year}, 10, 1)) + INTERVAL '1 month') "
        "- INTERVAL '1 day' + INTERVAL '1 hour'"
    )
    summer = f"{column} + INTERVAL '2 hours'"
    winter = f"{column} + INTERVAL '1 hour'"
    return f"CASE WHEN {column} >= {start} AND {column} < {end} THEN {summer} ELSE {winter} END"


def berlin_week_sql(column: str) -> str:
    """Return the ISO week of ``column`` in Europe/Berlin local time."""
    return f"strftime({berlin_local_sql(column)}, '%G-W%V')"


def series_key_sql() -> str:
    """Return the v1 itinerary key expression.

    The key follows the itinerary, not the train: it includes the arrival and transfer count, and
    both planned times are floored to 15-minute buckets. A re-keyed itinerary therefore starts a
    new series; :mod:`tpm_analytics.training.chains` links it back to its predecessor.
    """
    return (
        "'v1:' || sha256(concat_ws('|', "
        "route_id, coalesce(train_number, ''), service_class, "
        "CAST(epoch(departure_planned) / 900 AS BIGINT), "
        "CAST(epoch(arrival_planned) / 900 AS BIGINT), "
        "coalesce(transfers_actual, -1)))"
    )
