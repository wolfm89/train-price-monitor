"""The station dimension must cover everything the scraper can produce."""

from __future__ import annotations

import json
from pathlib import Path

from tpm_analytics.silver._duck import asset_dir

REPO_ROOT = Path(__file__).resolve().parents[2]


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def dimension() -> list[dict]:
    return load(asset_dir("data") / "stations.json")["stations"]


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
    problems = []
    for station in dimension():
        if set(station) != {"eva", "name", "lat", "lon", "state", "category"}:
            problems.append(f"{station.get('name')}: unexpected fields {sorted(station)}")
        if not str(station["eva"]).isdigit():
            problems.append(f"{station['name']}: eva {station['eva']} is not numeric")
        if not 47 < station["lat"] < 55 or not 5 < station["lon"] < 15:
            problems.append(f"{station['name']}: coordinates outside Germany")
        if not 1 <= station["category"] <= 7:
            problems.append(f"{station['name']}: category {station['category']} outside 1..7")
        if not station["state"]:
            problems.append(f"{station['name']}: empty state")
    assert not problems, "\n".join(problems)
