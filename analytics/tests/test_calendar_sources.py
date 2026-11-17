"""Cross-check the committed calendar against independent sources."""

import json
from datetime import date, timedelta
from pathlib import Path

import holidays

from tpm_analytics import calendar

FIXTURES = Path(__file__).parent / "fixtures"


def _row(rows: list[tuple[object, ...]], state: str, day: date) -> dict[str, object]:
    """Return one state/date row as a column mapping."""
    for row in rows:
        if row[0] == state and row[1] == day:
            return dict(zip(calendar.DAILY_COLUMNS, row, strict=True))
    raise AssertionError(f"no calendar row for {state} {day}")


def test_public_holidays_match_python_holidays() -> None:
    """Public holidays match python-holidays except the documented Bavaria case."""
    data = calendar.load_calendar()
    years = list(range(data.coverage_start.year, data.coverage_end.year + 1))
    # Mariä Himmelfahrt is municipality-dependent in Bavaria; OpenHolidays returns it for the
    # state, while python-holidays intentionally omits it.
    allowed = {("BY", date(year, 8, 15)) for year in years}
    for code in calendar.STATE_CODES:
        expected = set(holidays.country_holidays("DE", subdiv=code, years=years).keys())
        actual = {holiday.day for holiday in data.public_holidays if holiday.state == code}
        unexpected = actual - expected - {day for state, day in allowed if state == code}
        missing = expected - actual
        assert not unexpected, f"{code}: OpenHolidays has extra public holidays {sorted(unexpected)}"
        assert not missing, f"{code}: OpenHolidays is missing public holidays {sorted(missing)}"


def test_school_summer_matches_the_kmk_table() -> None:
    """Summer-break boundaries match the KMK table for all states."""
    fixture = json.loads((FIXTURES / "kmk_summer_2026_27.json").read_text(encoding="utf-8"))
    rows = calendar.daily_rows("2027-06-01", "2027-09-30")
    for item in fixture["summer"]:
        state = item["state"]
        start = date.fromisoformat(item["start"])
        end = date.fromisoformat(item["end"])
        assert _row(rows, state, start)["is_school_holiday"] is True, f"{state} start {start}"
        assert _row(rows, state, end)["is_school_holiday"] is True, f"{state} end {end}"
        assert _row(rows, state, start - timedelta(days=1))["is_school_holiday"] is False, f"{state} day before {start}"
        assert _row(rows, state, end + timedelta(days=1))["is_school_holiday"] is False, f"{state} day after {end}"


def test_school_autumn_matches_the_kmk_table() -> None:
    """Autumn-break starts and ends match the KMK table for all states."""
    fixture = json.loads((FIXTURES / "kmk_summer_2026_27.json").read_text(encoding="utf-8"))
    rows = calendar.daily_rows("2026-09-01", "2026-11-10")
    for item in fixture["autumn"]:
        state = item["state"]
        start = date.fromisoformat(item["start"])
        end = date.fromisoformat(item["end"])
        assert _row(rows, state, start)["is_school_holiday"] is True, f"{state} start {start}"
        assert _row(rows, state, end)["is_school_holiday"] is True, f"{state} end {end}"
        assert _row(rows, state, start - timedelta(days=1))["is_school_holiday"] is False, f"{state} day before {start}"


def test_school_christmas_and_easter_match_kmk() -> None:
    """Christmas and Easter ranges match the KMK table for all states."""
    fixture = json.loads((FIXTURES / "kmk_summer_2026_27.json").read_text(encoding="utf-8"))
    rows = calendar.daily_rows("2026-09-01", "2027-09-30")
    for period in ("christmas", "easter"):
        for item in fixture[period]:
            state = item["state"]
            start = date.fromisoformat(item["start"])
            end = date.fromisoformat(item["end"])
            assert _row(rows, state, start)["is_school_holiday"] is True, f"{state} {period} start {start}"
            assert _row(rows, state, end)["is_school_holiday"] is True, f"{state} {period} end {end}"
            assert _row(rows, state, start - timedelta(days=1))["is_school_holiday"] is False, (
                f"{state} {period} day before {start}"
            )


def test_schleswig_holstein_autumn_uses_the_mainland_range() -> None:
    """The North Frisian island exception must not move the state-wide autumn start."""
    rows = calendar.daily_rows("2026-09-01", "2026-10-31")
    assert _row(rows, "SH", date(2026, 10, 5))["is_school_holiday"] is False
    start = _row(rows, "SH", date(2026, 10, 12))
    assert start["is_school_holiday"] is True
    assert start["school_holiday_day"] == 0
    assert start["is_school_holiday_start_window"] is True
    assert _row(rows, "SH", date(2026, 10, 24))["is_school_holiday"] is True
    assert _row(rows, "SH", date(2026, 10, 25))["is_school_holiday"] is False
