"""Unit tests for the calendar generator's normalization rules."""

import importlib.util
from datetime import date
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "build_calendar.py"
SPEC = importlib.util.spec_from_file_location("build_calendar", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load {SCRIPT}")
build_calendar = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build_calendar)


def _name(text: str) -> list[dict[str, str]]:
    """Build a German holiday-name payload."""
    return [{"language": "DE", "text": text}]


def _item(
    start: str,
    end: str,
    name: str,
    *,
    nationwide: bool = False,
    subdivisions: list[dict[str, str]] | None = None,
    groups: list[dict[str, object]] | None = None,
    tags: list[str] | None = None,
    comment: str | None = None,
) -> dict[str, object]:
    """Build a minimal OpenHolidays item."""
    return {
        "id": f"{name}-{start}",
        "startDate": start,
        "endDate": end,
        "name": _name(name),
        "nationwide": nationwide,
        "subdivisions": subdivisions or [],
        "groups": groups or [],
        "tags": tags or [],
        "comment": comment,
    }


def test_public_holidays_expand_nationwide_and_exclude_local() -> None:
    """Nationwide holidays expand and local holidays are excluded."""
    rows, excluded = build_calendar.normalize_public(
        [
            _item("2026-01-01", "2026-01-01", "Neujahr", nationwide=True),
            _item(
                "2026-01-06",
                "2026-01-06",
                "Heilige Drei Könige",
                subdivisions=[{"code": "DE-BY", "shortName": "BY"}],
            ),
            _item(
                "2026-08-08",
                "2026-08-08",
                "Friedensfest",
                subdivisions=[{"code": "DE-BY-AU", "shortName": "BY-AU"}],
            ),
        ],
        date(2026, 1, 1),
        date(2026, 12, 31),
    )
    assert ("BY", "2026-01-01", "Neujahr", "National") in {
        (row["state"], row["date"], row["name"], row["scope"]) for row in rows
    }
    assert ("BE", "2026-01-01", "Neujahr", "National") in {
        (row["state"], row["date"], row["name"], row["scope"]) for row in rows
    }
    assert ("BY", "2026-01-06", "Heilige Drei Könige", "Regional") in {
        (row["state"], row["date"], row["name"], row["scope"]) for row in rows
    }
    assert all(row["date"] != "2026-01-06" or row["state"] != "BE" for row in rows)
    assert excluded == [
        {"state": "BY-AU", "start": "2026-08-08", "end": "2026-08-08", "name": "Friedensfest", "place": "Augsburg"}
    ]


def test_school_holidays_keep_general_schools_and_drop_vocational_groups() -> None:
    """Only general-school ranges survive group filtering."""
    rows = build_calendar.normalize_school(
        [
            _item(
                "2027-07-05",
                "2027-08-14",
                "Sommerferien",
                subdivisions=[{"code": "DE-MV", "shortName": "MV"}],
                groups=[
                    {
                        "shortName": "MV-ABS",
                        "name": [{"language": "DE", "text": "Allgemeinbildende Schulen"}],
                    }
                ],
            ),
            _item(
                "2027-07-12",
                "2027-08-28",
                "Sommerferien",
                subdivisions=[{"code": "DE-MV", "shortName": "MV"}],
                groups=[
                    {
                        "shortName": "MV-BBS",
                        "name": [{"language": "DE", "text": "Berufliche Schulen"}],
                    }
                ],
            ),
        ],
        date(2027, 1, 1),
        date(2027, 12, 31),
    )
    assert rows[0] == [
        {"state": "MV", "start": "2027-07-05", "end": "2027-08-14", "name": "Sommerferien", "type": "summer"}
    ]
    assert rows[1] == []


def test_school_types_are_normalized() -> None:
    """School-break names map to normalized types."""
    assert build_calendar.school_type("Sommerferien") == "summer"
    assert build_calendar.school_type("Weihnachtsferien") == "christmas"
    assert build_calendar.school_type("Osterferien") == "easter"
    assert build_calendar.school_type("Herbstferien") == "autumn"
    assert build_calendar.school_type("Winterferien") == "winter"
    assert build_calendar.school_type("Pfingstferien") == "whitsun"
    assert build_calendar.school_type("Frühjahrsferien", date(2026, 2, 16)) == "winter"
    assert build_calendar.school_type("Frühjahrsferien", date(2026, 3, 2)) == "easter"
    assert build_calendar.school_type("Buß- und Bettag") == "other"


def test_school_ranges_intersecting_the_window_are_kept() -> None:
    """Ranges crossing the coverage boundary are retained."""
    rows, exceptions = build_calendar.normalize_school(
        [
            _item(
                "2025-12-22",
                "2026-01-05",
                "Weihnachtsferien",
                subdivisions=[{"code": "DE-BY", "shortName": "BY"}],
            )
        ],
        date(2026, 1, 1),
        date(2026, 12, 31),
    )
    assert rows[0]["start"] == "2025-12-22"
    assert rows[0]["end"] == "2026-01-05"
    assert exceptions == []


def test_school_holiday_exception_ranges_are_excluded() -> None:
    """Island/Halligen exception ranges are recorded but not used as state-wide breaks."""
    rows, exceptions = build_calendar.normalize_school(
        [
            _item(
                "2026-10-12",
                "2026-10-24",
                "Herbstferien",
                subdivisions=[{"code": "DE-SH", "shortName": "SH"}],
            ),
            _item(
                "2026-10-05",
                "2026-10-24",
                "Herbstferien",
                subdivisions=[{"code": "DE-SH", "shortName": "SH"}],
                tags=["Exception"],
                comment="Inseln Sylt, Föhr, Amrum, Helgoland und die Halligen",
            ),
        ],
        date(2026, 1, 1),
        date(2026, 12, 31),
    )
    assert rows == [
        {"state": "SH", "start": "2026-10-12", "end": "2026-10-24", "name": "Herbstferien", "type": "autumn"}
    ]
    assert exceptions == [
        {
            "state": "SH",
            "start": "2026-10-05",
            "end": "2026-10-24",
            "name": "Herbstferien",
            "comment": "Inseln Sylt, Föhr, Amrum, Helgoland und die Halligen",
        }
    ]


def test_main_rejects_a_reversed_range() -> None:
    """The CLI refuses to write an empty reversed calendar."""
    with pytest.raises(SystemExit):
        build_calendar.main(["--from", "2026-06-01", "--to", "2026-01-01"])


def test_main_check_requires_an_existing_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """A missing output is reported before any network request is made."""
    monkeypatch.setattr(build_calendar, "_fetch", lambda *args, **kwargs: pytest.fail("network called"))
    assert build_calendar.main(["--check", "--output", str(tmp_path / "missing.json")]) == 1


def test_comparable_ignores_generation_timestamps() -> None:
    """The drift check ignores the retrieval date and version, not the data."""
    first = {
        "calendar_version": "2026-01-01",
        "source": {"retrieved_at": "2026-01-01", "license": "ODbL-1.0"},
        "public_holidays": [],
    }
    second = {
        "calendar_version": "2026-02-01",
        "source": {"retrieved_at": "2026-02-01", "license": "ODbL-1.0"},
        "public_holidays": [],
    }
    assert build_calendar.comparable(first) == build_calendar.comparable(second)
