"""The holiday calendar contract used by the P2.1 training builder."""

import copy
import json
from datetime import UTC, date, datetime
from importlib.resources import files
from pathlib import Path

import duckdb
import pytest

from tpm_analytics import calendar
from tpm_analytics.silver._duck import asset_dir


def _row(rows: list[tuple[object, ...]], state: str, day: str) -> dict[str, object]:
    """Return one state/date row as a column mapping."""
    wanted = date.fromisoformat(day)
    for row in rows:
        if row[0] == state and row[1] == wanted:
            return dict(zip(calendar.DAILY_COLUMNS, row, strict=True))
    raise AssertionError(f"no calendar row for {state} {day}")


def test_state_mapping_covers_the_station_dimension() -> None:
    """Every station state maps to an ISO state code."""
    stations = json.loads((asset_dir("data") / "stations.json").read_text(encoding="utf-8"))["stations"]
    assert {calendar.state_code(station["state"]) for station in stations} <= set(calendar.STATE_CODES)
    assert set(calendar.STATE_CODES) == set(calendar.STATE_CODES_BY_NAME.values())


def test_unknown_state_is_rejected() -> None:
    """An unknown state raises a calendar error."""
    with pytest.raises(calendar.CalendarError, match="unknown German state"):
        calendar.state_code("Atlantis")


def test_calendar_metadata_and_counts() -> None:
    """The packaged calendar has the expected metadata and coverage."""
    data = calendar.load_calendar()
    payload = json.loads((asset_dir("data") / "calendar.json").read_text(encoding="utf-8"))
    assert data.schema_version == 1
    assert data.coverage_start == date(2026, 1, 1)
    assert data.coverage_end == date(2028, 12, 31)
    assert len(data.states) == 16
    assert data.public_holidays
    assert data.school_holidays
    assert payload["source"]["license"] == "ODbL-1.0"
    assert payload["source"]["license_url"].startswith("https://opendatacommons.org/licenses/odbl/")
    assert payload["source"]["attribution"]
    assert any(item["name"] == "Friedensfest" for item in payload["excluded"]["local_holidays"])
    assert payload["excluded"]["school_holiday_exceptions"]


def test_packaged_calendar_is_available() -> None:
    """The calendar JSON is part of the installed package."""
    assert files("tpm_analytics").joinpath("data", "calendar.json").is_file()


def test_dataset_version_is_exposed() -> None:
    """The dataset version is available for the training manifest."""
    assert calendar.dataset_version() == calendar.load_calendar().calendar_version


def test_public_holiday_fixtures() -> None:
    """Known public holidays and local exclusions behave as documented."""
    rows = calendar.daily_rows("2026-01-01", "2026-01-06")
    assert _row(rows, "BY", "2026-01-01")["is_public_holiday"] is True
    assert _row(rows, "BY", "2026-01-06")["is_public_holiday"] is True
    assert _row(rows, "BE", "2026-01-06")["is_public_holiday"] is False

    rows = calendar.daily_rows("2026-03-08", "2026-03-08")
    assert _row(rows, "BE", "2026-03-08")["is_public_holiday"] is True

    rows = calendar.daily_rows("2026-08-08", "2026-08-15")
    assert _row(rows, "BY", "2026-08-08")["is_public_holiday"] is False  # Augsburg-local
    assert _row(rows, "BY", "2026-08-15")["is_public_holiday"] is True  # documented approximation

    rows = calendar.daily_rows("2026-11-18", "2026-11-18")
    assert _row(rows, "SN", "2026-11-18")["is_public_holiday"] is True


def test_school_holiday_windows() -> None:
    """School-break start and end windows include the three boundary days."""
    rows = calendar.daily_rows("2026-07-30", "2026-09-18")
    before = _row(rows, "BY", "2026-07-30")
    first = _row(rows, "BY", "2026-08-03")
    last = _row(rows, "BY", "2026-09-14")
    after = _row(rows, "BY", "2026-09-18")
    assert before["is_school_holiday"] is False
    assert first["is_school_holiday"] is True
    assert first["school_holiday_type"] == "summer"
    assert first["school_holiday_day"] == 0
    for day in ("2026-07-31", "2026-08-01", "2026-08-02", "2026-08-03"):
        assert _row(rows, "BY", day)["is_school_holiday_start_window"] is True, day
    for day in ("2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17"):
        assert _row(rows, "BY", day)["is_school_holiday_end_window"] is True, day
    assert last["is_school_holiday"] is True
    assert last["days_until_school_holiday_end"] == 0
    assert after["is_school_holiday"] is False
    assert after["is_school_holiday_end_window"] is False
    assert _row(rows, "BY", "2026-07-30")["is_school_holiday_start_window"] is False


def test_cross_year_school_holiday_retains_its_start() -> None:
    """A Christmas break crossing the year boundary keeps its start date."""
    rows = calendar.daily_rows("2026-01-01", "2026-01-08")
    row = _row(rows, "BY", "2026-01-01")
    assert row["is_school_holiday"] is True
    assert row["school_holiday_type"] == "christmas"
    assert row["school_holiday_day"] == 10  # 2025-12-22 -> 2026-01-01
    assert row["days_until_school_holiday_end"] == 4
    for day in ("2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"):
        assert _row(rows, "BY", day)["is_school_holiday_end_window"] is True, day


def test_whitsun_and_bridge_day() -> None:
    """Whitsun is classified and the bridge-day heuristic is conservative."""
    rows = calendar.daily_rows("2026-05-25", "2026-05-26")
    assert _row(rows, "BY", "2026-05-26")["school_holiday_type"] == "whitsun"

    rows = calendar.daily_rows("2026-05-15", "2026-05-15")
    assert _row(rows, "BY", "2026-05-15")["is_bridge_day"] is True

    rows = calendar.daily_rows("2026-04-07", "2026-04-07")
    assert _row(rows, "BY", "2026-04-07")["is_bridge_day"] is False  # Tuesday after Easter Monday
    rows = calendar.daily_rows("2026-04-30", "2026-04-30")
    assert _row(rows, "BY", "2026-04-30")["is_bridge_day"] is False  # Thursday before 1 May


def test_hamburg_spring_break_is_easter() -> None:
    """Hamburg's March Frühjahrsferien is an Easter/spring break, not winter."""
    row = _row(calendar.daily_rows("2026-03-02", "2026-03-02"), "HH", "2026-03-02")
    assert row["school_holiday_type"] == "easter"


def test_school_types_are_bounded() -> None:
    """School-break types use the documented vocabulary."""
    data = calendar.load_calendar()
    kinds = {holiday.kind for holiday in data.school_holidays}
    assert kinds <= {"summer", "christmas", "easter", "autumn", "winter", "whitsun", "other"}
    assert "whitsun" in kinds


def test_coverage_guard() -> None:
    """Ranges outside the committed coverage fail loudly."""
    calendar.assert_covered("2026-01-01", "2028-12-31")
    with pytest.raises(calendar.CalendarCoverageError):
        calendar.assert_covered("2025-12-31", "2026-01-01")
    with pytest.raises(calendar.CalendarCoverageError):
        calendar.assert_covered("2028-12-31", "2029-01-01")
    with pytest.raises(calendar.CalendarError):
        calendar.assert_covered("2026-02-01", "2026-01-01")


def test_daily_rows_have_the_documented_shape() -> None:
    """Daily rows match the documented column order and types."""
    rows = calendar.daily_rows("2026-01-01", "2026-01-01")
    assert len(rows) == len(calendar.STATE_CODES)
    assert all(len(row) == len(calendar.DAILY_COLUMNS) for row in rows)


def test_register_calendar_and_route_join() -> None:
    """DuckDB registration and the route join return the expected features."""
    connection = duckdb.connect()
    calendar.register_calendar(connection, "2026-01-01", "2026-12-31")
    connection.execute(
        "CREATE TABLE routes (route_id VARCHAR, origin_state VARCHAR, dest_state VARCHAR, departure_date DATE)"
    )
    connection.executemany(
        "INSERT INTO routes VALUES (?, ?, ?, ?)",
        [
            ("same", "Bayern", "Bayern", date(2026, 8, 3)),
            ("cross", "Bayern", "Berlin", date(2026, 1, 6)),
            ("bridge", "Bayern", "Bayern", date(2026, 5, 15)),
            ("plain", "Berlin", "Berlin", date(2026, 3, 2)),
            ("late", "Bayern", "Bayern", date(2026, 9, 14)),
        ],
    )
    calendar.register_route_states(connection, "routes")
    sql = calendar.route_calendar_sql("routes")
    result = connection.execute(sql).fetchall()
    columns = [description[0] for description in connection.description]
    rows = {row[0]: dict(zip(columns, row, strict=True)) for row in result}

    assert rows["same"]["origin_school_holiday"] is True
    assert rows["same"]["dest_school_holiday"] is True
    assert rows["same"]["both_school_holiday"] is True
    assert rows["same"]["either_school_holiday_start_window"] is True
    assert rows["same"]["is_state_match"] is True
    assert rows["cross"]["origin_public_holiday"] is True
    assert rows["cross"]["dest_public_holiday"] is False
    assert rows["cross"]["either_public_holiday"] is True
    assert rows["bridge"]["either_bridge_day"] is True
    assert rows["plain"]["either_school_holiday"] is False
    assert rows["late"]["origin_school_holiday_day"] == 14  # clipped from 42
    assert rows["late"]["origin_days_until_school_holiday_end"] == 0
    assert rows["late"]["min_days_to_public_holiday"] <= 14
    assert rows["same"]["calendar_missing"] is False
    assert rows["same"]["origin_state_missing"] is False


def test_aware_datetime_uses_the_berlin_date() -> None:
    """A UTC datetime just before midnight maps to the next Berlin calendar date."""
    moment = datetime(2026, 1, 5, 23, 30, tzinfo=UTC)
    rows = calendar.daily_rows(moment, moment)
    assert _row(rows, "BY", "2026-01-06")["is_public_holiday"] is True


def test_route_join_reports_missing_dates() -> None:
    """A route outside the registered calendar range is flagged, not silently false."""
    connection = duckdb.connect()
    calendar.register_calendar(connection, "2026-01-01", "2026-12-31")
    connection.execute(
        "CREATE TABLE routes (route_id VARCHAR, origin_state VARCHAR, dest_state VARCHAR, departure_date DATE)"
    )
    connection.execute("INSERT INTO routes VALUES ('out', 'Bayern', 'Berlin', DATE '2027-06-01')")
    calendar.register_route_states(connection, "routes")
    row = connection.execute(calendar.route_calendar_sql("routes")).fetchone()
    assert row is not None
    columns = [description[0] for description in connection.description]
    result = dict(zip(columns, row, strict=True))
    assert result["calendar_missing"] is True
    assert result["date_missing"] is True


def test_missing_next_holidays_stay_null() -> None:
    """Two missing next-holiday distances must not produce a valid 14-day value."""
    connection = duckdb.connect()
    calendar.register_calendar(connection, "2028-01-01", "2028-12-31")
    connection.execute(
        "CREATE TABLE routes (route_id VARCHAR, origin_state VARCHAR, dest_state VARCHAR, departure_date DATE)"
    )
    connection.execute("INSERT INTO routes VALUES ('after-last', 'Bayern', 'Berlin', DATE '2028-12-27')")
    calendar.register_route_states(connection, "routes")
    row = connection.execute(calendar.route_calendar_sql("routes")).fetchone()
    assert row is not None
    columns = [description[0] for description in connection.description]
    result = dict(zip(columns, row, strict=True))
    assert result["min_days_to_public_holiday"] is None
    assert result["calendar_missing"] is False


def test_route_state_validation_rejects_unknown_names() -> None:
    """Unknown route state names fail before the SQL join can produce false features."""
    connection = duckdb.connect()
    connection.execute("CREATE TABLE routes (origin_state VARCHAR, dest_state VARCHAR)")
    connection.execute("INSERT INTO routes VALUES ('Bavaria', 'Berlin')")
    with pytest.raises(calendar.CalendarError, match="unknown German state"):
        calendar.register_route_states(connection, "routes")
    assert calendar.state_code("BY") == "BY"
    assert calendar.state_code("DE-BY") == "BY"
    assert calendar.state_code("Bayern ") == "BY"


def test_missing_state_year_is_rejected(tmp_path: Path) -> None:
    """A partial source extraction must not load as a complete calendar."""
    payload = json.loads((asset_dir("data") / "calendar.json").read_text(encoding="utf-8"))
    payload["school_holidays"] = [row for row in payload["school_holidays"] if row["state"] != "HE"]
    path = tmp_path / "calendar.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(calendar.CalendarError, match="missing school holidays for HE"):
        calendar.load_calendar(path)


def test_invalid_calendar_values_are_rejected(tmp_path: Path) -> None:
    """The loader rejects bogus categorical values, versions and duplicate states."""
    base = json.loads((asset_dir("data") / "calendar.json").read_text(encoding="utf-8"))
    mutations = [
        ("bad scope", lambda payload: payload["public_holidays"][0].update(scope="Galactic")),
        ("bad type", lambda payload: payload["school_holidays"][0].update(type="summr")),
        ("empty version", lambda payload: payload.update(calendar_version="")),
        ("duplicate state", lambda payload: payload["states"].append(payload["states"][0])),
    ]
    for label, mutate in mutations:
        payload = copy.deepcopy(base)
        mutate(payload)
        path = tmp_path / f"{label}.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        with pytest.raises(calendar.CalendarError):
            calendar.load_calendar(path)


def test_runtime_module_has_no_network_import() -> None:
    """The runtime module has no network imports."""
    source = Path(calendar.__file__).read_text(encoding="utf-8")
    assert "urllib" not in source
    assert "requests" not in source
    assert "http://" not in source
    assert "https://" not in source
