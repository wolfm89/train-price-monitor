"""The station dimension must cover everything the scraper can produce."""

from __future__ import annotations

import json
from pathlib import Path

ANALYTICS_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ANALYTICS_ROOT.parent


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def dimension() -> list[dict]:
    return load(ANALYTICS_ROOT / "data" / "stations.json")["stations"]


def scraper_catalogue() -> list[dict]:
    catalogue = load(REPO_ROOT / "scraper" / "stations.json")
    return [station for tier in catalogue.values() for station in tier]


def test_every_scraper_station_has_a_dimension_row() -> None:
    known = {station["eva"] for station in dimension()}
    missing = {station["eva"] for station in scraper_catalogue()} - known
    assert not missing, f"station dimension is missing {sorted(missing)}"


def test_evas_are_unique() -> None:
    evas = [station["eva"] for station in dimension()]
    assert len(evas) == len(set(evas))


def test_dimension_has_the_full_field_set() -> None:
    for station in dimension():
        assert set(station) == {"eva", "name", "lat", "lon", "state", "category"}
        assert station["eva"].isdigit()
        assert 47 < station["lat"] < 55
        assert 5 < station["lon"] < 15
        assert 1 <= station["category"] <= 7
        assert station["state"]
