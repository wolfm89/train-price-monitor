"""Journey identity chains for the v1 baseline.

The series key follows the itinerary: route, first-train number, class and 15-minute buckets for
the planned departure, arrival and transfer count. When the itinerary is re-keyed (usually because
the arrival moved), the fare history and the label window split. A chain links a series that stops
appearing to the series with the same route, class and first-train number whose planned departure
is within 15 minutes and whose first observation is the next route-day scrape.

Links are one-to-one. Candidate pairs are assigned in departure-distance order, so the closest
departure wins; equal distances fall back to the series keys for a deterministic result. The chain
id is the lexicographically smallest series key in the component.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import duckdb
import pyarrow as pa

from tpm_analytics.training.identity import LINK_TOLERANCE_SECONDS


@dataclass(frozen=True)
class ChainStats:
    """Counts and rates for one chain build."""

    strict: bool
    series: int
    at_risk_series: int
    at_risk_series_3plus: int
    candidate_links: int
    ambiguous_predecessors: int
    ambiguous_successors: int
    dropped_candidates: int
    links: int
    chains: int
    linked_series: int
    largest_chain: int
    link_rate: float
    link_rate_3plus: float
    series_link_rate: float
    size_histogram: tuple[tuple[int, int], ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "strict": self.strict,
            "series": self.series,
            "at_risk_series": self.at_risk_series,
            "at_risk_series_3plus": self.at_risk_series_3plus,
            "candidate_links": self.candidate_links,
            "ambiguous_predecessors": self.ambiguous_predecessors,
            "ambiguous_successors": self.ambiguous_successors,
            "dropped_candidates": self.dropped_candidates,
            "links": self.links,
            "chains": self.chains,
            "linked_series": self.linked_series,
            "largest_chain": self.largest_chain,
            "link_rate": self.link_rate,
            "link_rate_3plus": self.link_rate_3plus,
            "series_link_rate": self.series_link_rate,
            "size_histogram": [[size, count] for size, count in self.size_histogram],
        }


def _scalar(connection: duckdb.DuckDBPyConnection, sql: str) -> int:
    row = connection.execute(sql).fetchone()
    if row is None:
        raise RuntimeError(f"query returned no row: {sql[:80]}")
    return int(row[0])


def _pyarrow_table(rows: list[tuple[str, str]], names: tuple[str, ...]) -> pa.Table:
    return pa.table({name: [row[index] for row in rows] for index, name in enumerate(names)})


class _UnionFind:
    def __init__(self) -> None:
        self._parent: dict[str, str] = {}

    def find(self, value: str) -> str:
        parent = self._parent.setdefault(value, value)
        while parent != value:
            self._parent[value] = self._parent[parent]
            value = parent
            parent = self._parent[value]
        return value

    def union(self, left: str, right: str) -> None:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root == right_root:
            return
        if left_root < right_root:
            self._parent[right_root] = left_root
        else:
            self._parent[left_root] = right_root


def _match_candidates(
    connection: duckdb.DuckDBPyConnection,
    prefix: str,
) -> list[tuple[str, str]]:
    rows = connection.execute(
        f"""
        SELECT predecessor, successor, departure_delta_s
        FROM {prefix}_candidates
        ORDER BY departure_delta_s, predecessor, successor
        """
    ).fetchall()
    used_predecessors: set[str] = set()
    used_successors: set[str] = set()
    links: list[tuple[str, str]] = []
    for predecessor, successor, _ in rows:
        if predecessor in used_predecessors or successor in used_successors:
            continue
        used_predecessors.add(predecessor)
        used_successors.add(successor)
        links.append((str(predecessor), str(successor)))
    return links


def _chain_components(links: list[tuple[str, str]]) -> dict[str, str]:
    union = _UnionFind()
    for predecessor, successor in links:
        union.union(predecessor, successor)
    components: dict[str, list[str]] = {}
    for series_key in union._parent:
        components.setdefault(union.find(series_key), []).append(series_key)
    mapping: dict[str, str] = {}
    for members in components.values():
        chain_id = min(members)
        for series_key in members:
            mapping[series_key] = chain_id
    return mapping


def build_chain_map(
    connection: duckdb.DuckDBPyConnection,
    *,
    base_view: str,
    grid_view: str,
    prefix: str,
    map_table: str,
    strict: bool = False,
) -> ChainStats:
    """Build one chain map from ``base_view`` and return its audit counts.

    ``base_view`` must expose ``series_key``, ``route_id``, ``departure_date``, ``train_number``,
    ``service_class``, ``departure_planned`` and ``observed_at``. ``grid_view`` must expose the
    distinct route-day scrapes as ``route_id, departure_date, observed_at``.
    """
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE {prefix}_series AS
        SELECT
            series_key,
            min(route_id) AS route_id,
            min(departure_date) AS departure_date,
            min(train_number) AS train_number,
            min(service_class) AS service_class,
            min(departure_planned) AS departure_planned,
            min(observed_at) AS first_obs,
            max(observed_at) AS last_obs,
            count(*) AS observations
        FROM {base_view}
        GROUP BY series_key
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE {prefix}_next AS
        SELECT s.*, min(g.observed_at) AS next_s
        FROM {prefix}_series s
        JOIN {grid_view} g
          ON g.route_id = s.route_id
         AND g.departure_date = s.departure_date
         AND g.observed_at > s.last_obs
         AND g.observed_at < s.departure_planned
        GROUP BY ALL
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE {prefix}_candidates AS
        SELECT
            n.series_key AS predecessor,
            ns.series_key AS successor,
            abs(date_diff('second', ns.departure_planned, n.departure_planned)) AS departure_delta_s
        FROM {prefix}_next n
        JOIN {prefix}_series ns
          ON ns.route_id = n.route_id
         AND ns.departure_date = n.departure_date
         AND ns.first_obs = n.next_s
         AND ns.service_class = n.service_class
         AND ns.train_number IS NOT DISTINCT FROM n.train_number
         AND abs(date_diff('second', ns.departure_planned, n.departure_planned)) <= {LINK_TOLERANCE_SECONDS}
        """
    )
    series = _scalar(connection, f"SELECT count(*) FROM {prefix}_series")
    at_risk = _scalar(connection, f"SELECT count(*) FROM {prefix}_next")
    at_risk_3plus = _scalar(
        connection,
        f"SELECT count(*) FROM {prefix}_next n JOIN {prefix}_series s USING (series_key) WHERE s.observations >= 3",
    )
    candidates = _scalar(connection, f"SELECT count(*) FROM {prefix}_candidates")
    ambiguous_predecessors = _scalar(
        connection,
        f"SELECT count(*) FROM (SELECT predecessor FROM {prefix}_candidates GROUP BY predecessor HAVING count(*) > 1)",
    )
    ambiguous_successors = _scalar(
        connection,
        f"SELECT count(*) FROM (SELECT successor FROM {prefix}_candidates GROUP BY successor HAVING count(*) > 1)",
    )
    if strict:
        connection.execute(
            f"""
            DELETE FROM {prefix}_candidates
            WHERE predecessor IN (
                SELECT predecessor FROM {prefix}_candidates GROUP BY predecessor HAVING count(*) > 1
            )
               OR successor IN (
                SELECT successor FROM {prefix}_candidates GROUP BY successor HAVING count(*) > 1
            )
            """
        )
    remaining = _scalar(connection, f"SELECT count(*) FROM {prefix}_candidates")
    links = _match_candidates(connection, prefix)
    connection.register(f"{prefix}_link_data", _pyarrow_table(links, ("predecessor", "successor")))
    connection.execute(f"CREATE OR REPLACE TEMP TABLE {prefix}_links AS SELECT * FROM {prefix}_link_data")
    mapping = _chain_components(links)
    connection.register(
        f"{prefix}_component_data",
        _pyarrow_table(
            [(series_key, chain_id) for series_key, chain_id in mapping.items()],
            ("series_key", "chain_id"),
        ),
    )
    connection.execute(f"CREATE OR REPLACE TEMP TABLE {prefix}_components AS SELECT * FROM {prefix}_component_data")
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE {prefix}_map_base AS
        SELECT s.series_key, coalesce(c.chain_id, s.series_key) AS chain_id
        FROM {prefix}_series s
        LEFT JOIN {prefix}_components c USING (series_key)
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE {map_table} AS
        SELECT m.series_key, m.chain_id, d.chain_departure_date
        FROM {prefix}_map_base m
        JOIN (
            SELECT m.chain_id, min(s.departure_date) AS chain_departure_date
            FROM {prefix}_map_base m
            JOIN {prefix}_series s USING (series_key)
            GROUP BY m.chain_id
        ) d USING (chain_id)
        """
    )
    sizes: dict[str, int] = {}
    for chain_id in mapping.values():
        sizes[chain_id] = sizes.get(chain_id, 0) + 1
    histogram: dict[int, int] = {}
    for size in sizes.values():
        histogram[size] = histogram.get(size, 0) + 1
    linked_series = sum(sizes.values())
    return ChainStats(
        strict=strict,
        series=series,
        at_risk_series=at_risk,
        at_risk_series_3plus=at_risk_3plus,
        candidate_links=candidates,
        ambiguous_predecessors=ambiguous_predecessors,
        ambiguous_successors=ambiguous_successors,
        dropped_candidates=candidates - remaining,
        links=len(links),
        chains=len(sizes),
        linked_series=linked_series,
        largest_chain=max(sizes.values(), default=0),
        link_rate=len(links) / at_risk if at_risk else 0.0,
        link_rate_3plus=len(links) / at_risk_3plus if at_risk_3plus else 0.0,
        series_link_rate=linked_series / series if series else 0.0,
        size_histogram=tuple(sorted(histogram.items())),
    )
