"""Generate the committed German holiday calendar from OpenHolidays.

The runtime never calls the API: this script is run manually when a new school year or holiday
change is published, the resulting JSON is reviewed and committed, and the analytics code reads it
from the package data directory.

Usage:
    uv run python scripts/build_calendar.py
    uv run python scripts/build_calendar.py --check
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterable
from datetime import date, timedelta
from pathlib import Path
from typing import Any

BASE_URL = "https://openholidaysapi.org"
DEFAULT_FROM = date(2026, 1, 1)
DEFAULT_TO = date(2028, 12, 31)
OUTPUT = Path(__file__).resolve().parents[1] / "src" / "tpm_analytics" / "data" / "calendar.json"

STATE_NAMES = {
    "BW": "Baden-Württemberg",
    "BY": "Bayern",
    "BE": "Berlin",
    "BB": "Brandenburg",
    "HB": "Bremen",
    "HH": "Hamburg",
    "HE": "Hessen",
    "MV": "Mecklenburg-Vorpommern",
    "NI": "Niedersachsen",
    "NW": "Nordrhein-Westfalen",
    "RP": "Rheinland-Pfalz",
    "SL": "Saarland",
    "SN": "Sachsen",
    "ST": "Sachsen-Anhalt",
    "SH": "Schleswig-Holstein",
    "TH": "Thüringen",
}

LOCAL_PLACES = {"BY-AU": "Augsburg"}

SOURCE = {
    "name": "OpenHolidays API",
    "url": "https://www.openholidaysapi.org/en/",
    "data_url": "https://github.com/openpotato/openholidaysapi.data",
    "license": "ODbL-1.0",
    "license_url": "https://opendatacommons.org/licenses/odbl/1-0/",
    "attribution": "Contains information from OpenHolidays API, made available under the Open Database License (ODbL).",
}


def _fetch(path: str, params: dict[str, str]) -> list[dict[str, Any]]:
    """Fetch and decode a JSON list from the OpenHolidays API."""
    query = urllib.parse.urlencode(params)
    request = urllib.request.Request(
        f"{BASE_URL}/{path}?{query}",
        headers={
            "Accept": "text/json",
            "User-Agent": "train-price-monitor-calendar/1.0 (+https://github.com/wolfm89/train-price-monitor)",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = json.load(response)
    except (urllib.error.HTTPError, urllib.error.URLError) as error:
        raise RuntimeError(f"OpenHolidays request failed for {path}: {error}") from error
    if not isinstance(payload, list):
        raise ValueError(f"unexpected {path} response: {type(payload).__name__}")
    return payload


def _chunks(start: date, end: date) -> Iterable[tuple[date, date]]:
    """The API accepts at most three years per request."""
    current = start
    while current <= end:
        chunk_end = min(date(current.year + 2, 12, 31), end)
        yield current, chunk_end
        current = chunk_end + timedelta(days=1)


def _date_range(start: date, end: date) -> Iterable[date]:
    """Yield every date from start through end, inclusive."""
    current = start
    while current <= end:
        yield current
        current += timedelta(days=1)


def _names(item: dict[str, Any]) -> str:
    """Return the German holiday name or names as one string."""
    names = [name["text"] for name in item.get("name", []) if name.get("language") == "DE"]
    if not names:
        names = [name["text"] for name in item.get("name", [])]
    if not names:
        raise ValueError(f"holiday {item.get('id')} has no name")
    return "; ".join(names)


def _comment(item: dict[str, Any]) -> str:
    """Return a human-readable comment from the API representation."""
    comment = item.get("comment") or ""
    if isinstance(comment, str):
        return comment
    return " ".join(str(part.get("text") or "") for part in comment if part.get("text"))


def _state_code(subdivision: dict[str, Any]) -> str | None:
    """Return a state code for a subdivision, or None for a local unit."""
    code = str(subdivision.get("code") or "")
    short = str(subdivision.get("shortName") or "")
    candidate = short or code.removeprefix("DE-")
    if candidate in STATE_NAMES:
        return candidate
    return None


def normalize_public(
    items: Iterable[dict[str, Any]], start: date, end: date
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    """Expand public holidays to state/date rows and list local exclusions."""
    rows: set[tuple[str, str, str, str]] = set()
    excluded: set[tuple[str, str, str, str, str]] = set()
    for item in items:
        holiday_start = date.fromisoformat(item["startDate"])
        holiday_end = date.fromisoformat(item["endDate"])
        if holiday_end < start or holiday_start > end:
            continue
        name = _names(item)
        nationwide = bool(item.get("nationwide"))
        scope = "National" if nationwide else "Regional"
        subdivisions = item.get("subdivisions", [])
        if not nationwide and not subdivisions:
            raise ValueError(f"regional holiday without subdivisions: {item.get('id')}")
        states: set[str] = set(STATE_NAMES) if nationwide else set()
        local: set[str] = set()
        for subdivision in subdivisions:
            code = _state_code(subdivision)
            if code is None:
                local.add(str(subdivision.get("shortName") or subdivision.get("code") or "unknown"))
            else:
                states.add(code)
        for state in states:
            for day in _date_range(holiday_start, holiday_end):
                rows.add((state, day.isoformat(), name, scope))
        for place in local:
            excluded.add((place, item["startDate"], item["endDate"], name, LOCAL_PLACES.get(place, "")))
    return [dict(zip(("state", "date", "name", "scope"), row, strict=True)) for row in sorted(rows)], [
        {"state": row[0], "start": row[1], "end": row[2], "name": row[3], "place": row[4]} for row in sorted(excluded)
    ]


def school_type(name: str, start: date | None = None) -> str:
    """Map a school-break name to a normalized type."""
    normalized = name.lower()
    if "sommer" in normalized:
        return "summer"
    if "weihnacht" in normalized:
        return "christmas"
    if "oster" in normalized:
        return "easter"
    if "herbst" in normalized:
        return "autumn"
    if "pfingst" in normalized:
        return "whitsun"
    if "frühjahr" in normalized:
        # Frühjahrsferien is a February winter break in Bavaria but a March spring break in Hamburg.
        return "winter" if start is not None and start.month <= 2 else "easter"
    if any(word in normalized for word in ("winter", "halbjahr", "fastnacht")):
        return "winter"
    return "other"


def _is_general_school_group(group: dict[str, Any]) -> bool:
    """Return whether an OpenHolidays group represents general schools."""
    short = str(group.get("shortName") or "")
    if short.endswith("-ABS"):
        return True
    names = " ".join(str(name.get("text") or "") for name in group.get("name", []))
    return "allgemeinbildende" in names.lower() or "general school" in names.lower()


def _applies_to_general_schools(item: dict[str, Any]) -> bool:
    """Return whether an item applies to general schools or has no group."""
    groups = item.get("groups", [])
    if not groups:
        return True
    return any(_is_general_school_group(group) for group in groups)


def normalize_school(
    items: Iterable[dict[str, Any]], start: date, end: date
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    """Normalize school holidays to state/range rows."""
    rows: set[tuple[str, str, str, str, str]] = set()
    exceptions: set[tuple[str, str, str, str, str]] = set()
    for item in items:
        if not _applies_to_general_schools(item):
            continue
        holiday_start = date.fromisoformat(item["startDate"])
        holiday_end = date.fromisoformat(item["endDate"])
        if holiday_end < start or holiday_start > end:
            continue
        name = _names(item)
        is_exception = "Exception" in (item.get("tags") or [])
        comment = _comment(item)
        for subdivision in item.get("subdivisions", []):
            code = _state_code(subdivision)
            if code is None:
                continue
            if is_exception:
                exceptions.add((code, holiday_start.isoformat(), holiday_end.isoformat(), name, comment))
                continue
            rows.add((code, holiday_start.isoformat(), holiday_end.isoformat(), name, school_type(name, holiday_start)))
    return (
        [
            {"state": state, "start": first, "end": last, "name": name, "type": kind}
            for state, first, last, name, kind in sorted(rows)
        ],
        [
            {"state": state, "start": first, "end": last, "name": name, "comment": comment}
            for state, first, last, name, comment in sorted(exceptions)
        ],
    )


def _validate_completeness(
    public_rows: list[dict[str, str]], school_rows: list[dict[str, str]], from_date: date, to_date: date
) -> None:
    """Require every state to have public and school data in every covered year."""
    for year in range(from_date.year, to_date.year + 1):
        year_start = date(year, 1, 1)
        year_end = date(year, 12, 31)
        for code in STATE_NAMES:
            if not any(row["state"] == code and row["date"].startswith(str(year)) for row in public_rows):
                raise ValueError(f"no public holidays for {code} in {year}")
            if not any(
                row["state"] == code
                and date.fromisoformat(row["start"]) <= year_end
                and date.fromisoformat(row["end"]) >= year_start
                for row in school_rows
            ):
                raise ValueError(f"no school holidays for {code} in {year}")


def build(from_date: date, to_date: date, version: str | None = None) -> dict[str, Any]:
    """Fetch OpenHolidays data and build the calendar payload."""
    subdivisions = _fetch("Subdivisions", {"countryIsoCode": "DE"})
    available = {code for item in subdivisions if (code := _state_code(item)) is not None}
    missing = set(STATE_NAMES) - available
    extra = available - set(STATE_NAMES)
    if missing or extra:
        raise ValueError(f"unexpected German subdivisions: missing={sorted(missing)} extra={sorted(extra)}")

    public: list[dict[str, Any]] = []
    school: list[dict[str, Any]] = []
    for chunk_start, chunk_end in _chunks(from_date, to_date):
        params = {
            "countryIsoCode": "DE",
            "languageIsoCode": "DE",
            "validFrom": chunk_start.isoformat(),
            "validTo": chunk_end.isoformat(),
        }
        public.extend(_fetch("PublicHolidays", params))
        school.extend(_fetch("SchoolHolidays", params))

    public_rows, excluded = normalize_public(public, from_date, to_date)
    school_rows, school_exceptions = normalize_school(school, from_date, to_date)
    _validate_completeness(public_rows, school_rows, from_date, to_date)
    return {
        "schema_version": 1,
        "calendar_version": version or date.today().isoformat(),
        "source": {
            **SOURCE,
            "retrieved_at": date.today().isoformat(),
            "school_holiday_filter": (
                "general schools where groups are present; state-wide ranges; island/Halligen exceptions excluded"
            ),
        },
        "coverage": {"from": from_date.isoformat(), "to": to_date.isoformat()},
        "states": [{"code": code, "name": name} for code, name in STATE_NAMES.items()],
        "public_holidays": public_rows,
        "school_holidays": school_rows,
        "excluded": {
            "local_holidays": excluded,
            "school_holiday_exceptions": school_exceptions,
        },
    }


def comparable(payload: dict[str, Any]) -> dict[str, Any]:
    """Ignore the generation timestamps when checking for source drift."""
    comparable_payload = {key: value for key, value in payload.items() if key != "calendar_version"}
    comparable_payload["source"] = {
        key: value for key, value in comparable_payload["source"].items() if key != "retrieved_at"
    }
    return comparable_payload


def main(argv: list[str] | None = None) -> int:
    """Run the command-line entry point."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--from", dest="from_date", type=date.fromisoformat, default=DEFAULT_FROM)
    parser.add_argument("--to", dest="to_date", type=date.fromisoformat, default=DEFAULT_TO)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--version", help="calendar_version value; defaults to today")
    parser.add_argument("--check", action="store_true", help="compare against the committed file")
    args = parser.parse_args(argv)

    if args.from_date > args.to_date:
        parser.error("--from must not be after --to")
    if args.check and not args.output.exists():
        print(f"{args.output} does not exist", file=sys.stderr)
        return 1

    try:
        payload = build(args.from_date, args.to_date, args.version)
    except (RuntimeError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    if args.check:
        try:
            current = json.loads(args.output.read_text(encoding="utf-8"))
            current_comparable = comparable(current)
        except (OSError, json.JSONDecodeError, KeyError, TypeError) as error:
            print(f"{args.output} is not a valid calendar: {error}", file=sys.stderr)
            return 1
        if current_comparable != comparable(payload):
            print(f"{args.output} is out of date; rerun without --check", file=sys.stderr)
            return 1
        print(f"{args.output} is up to date")
        return 0

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {args.output} ({len(payload['public_holidays'])} public, {len(payload['school_holidays'])} school)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
