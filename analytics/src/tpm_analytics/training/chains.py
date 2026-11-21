"""Journey identity chains for the v1 baseline.

The series key follows the itinerary: route, first-train number, class, 15-minute buckets for the
planned departure and arrival, and the exact transfer count. When the itinerary is re-keyed (usually because
the arrival moved), the fare history and the label window split. A chain links a series that stops
appearing to the series with the same route, class and first-train number whose planned departure
is within 15 minutes and whose first observation is the next route-day scrape.

Links are one-to-one. The matcher maximises the number of links and tries the closest departure
first; in a crossing pattern it may give a predecessor its second-closest candidate to keep the
matching maximum. Equal distances fall back to the series keys for a deterministic result. The chain
id is the lexicographically smallest series key in the component.

The link decision is causal: a series that is absent at a route-day scrape and has a matching
successor at that scrape is continued into the successor. If the old itinerary later returns, the
return is a new incarnation of the same series key (suffixed ``#r``), so a link never depends on
observations after the scrape that decides it. This is the rule an online refresher can apply.
"""

from __future__ import annotations

import logging
import time
from collections import deque
from dataclasses import dataclass
from typing import Any

import duckdb
import pyarrow as pa

from tpm_analytics.training.identity import LINK_TOLERANCE_SECONDS, SAME_SCRAPE_ORDER

_LOGGER = logging.getLogger(__name__)


def _phase(name: str, started: float) -> float:
    finished = time.perf_counter()
    _LOGGER.info("chain %s: %.1f s", name, finished - started)
    return finished


@dataclass(frozen=True)
class ChainStats:
    """Counts and rates for one chain build."""

    strict: bool
    series: int
    base_series: int
    split_series: int
    at_risk_series: int
    at_risk_series_3plus: int
    candidate_links: int
    ambiguous_predecessors: int
    ambiguous_successors: int
    strict_dropped: int
    unused_candidates: int
    overlap_candidates: int
    links: int
    links_3plus: int
    chains: int
    identities: int
    singleton_chains: int
    linked_series: int
    largest_chain: int
    link_rate: float | None
    link_rate_3plus: float | None
    series_link_rate: float | None
    size_histogram: tuple[tuple[int, int], ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "strict": self.strict,
            "series": self.series,
            "base_series": self.base_series,
            "split_series": self.split_series,
            "at_risk_series": self.at_risk_series,
            "at_risk_series_3plus": self.at_risk_series_3plus,
            "candidate_links": self.candidate_links,
            "ambiguous_predecessors": self.ambiguous_predecessors,
            "ambiguous_successors": self.ambiguous_successors,
            "strict_dropped": self.strict_dropped,
            "unused_candidates": self.unused_candidates,
            "overlap_candidates": self.overlap_candidates,
            "links": self.links,
            "links_3plus": self.links_3plus,
            "chains": self.chains,
            "identities": self.identities,
            "singleton_chains": self.singleton_chains,
            "linked_series": self.linked_series,
            "largest_chain": self.largest_chain,
            "link_rate": self.link_rate,
            "link_rate_3plus": self.link_rate_3plus,
            "series_link_rate": self.series_link_rate,
            "size_histogram": [[size, count] for size, count in self.size_histogram],
        }


def _scalar(connection: duckdb.DuckDBPyConnection, sql: str) -> int:
    rows = connection.execute(sql).fetchall()
    if not rows:
        raise RuntimeError(f"query returned no row: {sql[:80]}")
    return int(rows[0][0])


def _optional_rate(numerator: int, denominator: int) -> float | None:
    return None if denominator == 0 else numerator / denominator


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
    """Return a maximum-cardinality one-to-one matching, closest departure first.

    A crossing pattern may give a predecessor its second-closest candidate to keep the matching
    maximum; that is the documented exception to the closest-first preference.
    """
    rows = connection.execute(
        f"""
        SELECT predecessor, successor, departure_delta_s
        FROM {prefix}_candidates
        ORDER BY departure_delta_s, predecessor, successor
        """
    ).fetchall()
    adjacency: dict[str, list[str]] = {}
    deltas: dict[tuple[str, str], int] = {}
    for predecessor, successor, delta in rows:
        left = str(predecessor)
        right = str(successor)
        adjacency.setdefault(left, []).append(right)
        deltas[(left, right)] = int(delta)

    pair_left: dict[str, str] = {}
    pair_right: dict[str, str] = {}
    distance: dict[str, int] = {}

    def bfs() -> bool:
        queue: deque[str] = deque()
        for left in adjacency:
            if left not in pair_left:
                distance[left] = 0
                queue.append(left)
            else:
                distance[left] = -1
        found = False
        while queue:
            left = queue.popleft()
            for right in adjacency[left]:
                matched = pair_right.get(right)
                if matched is None:
                    found = True
                elif distance.get(matched, -1) < 0:
                    distance[matched] = distance[left] + 1
                    queue.append(matched)
        return found

    def dfs(left: str) -> bool:
        for right in adjacency[left]:
            matched = pair_right.get(right)
            if matched is None or (distance.get(matched) == distance[left] + 1 and dfs(matched)):
                pair_left[left] = right
                pair_right[right] = left
                return True
        distance[left] = -1
        return False

    while bfs():
        for left in adjacency:
            if left not in pair_left:
                dfs(left)
    return sorted(pair_left.items(), key=lambda item: (deltas[item], item[0], item[1]))


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
    """Build one causal chain map from ``base_view`` and return its audit counts.

    ``base_view`` must expose ``series_key``, ``route_id``, ``departure_date``, ``train_number``,
    ``service_class``, ``departure_planned`` and ``observed_at``. ``grid_view`` must expose the
    distinct route-day scrapes as ``route_id, departure_date, observed_at``.

    A series is split into incarnations at a gap where it is absent at the next route-day scrape
    and a matching successor starts there. That split is decided from observations at or before
    the gap scrape, never from a later return. ``map_table`` keeps one row per original series key
    (its first incarnation) for series-level audits; ``<map_table>_rows`` maps every observed row.
    """
    phase_started = time.perf_counter()
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE {prefix}_canonical AS
        SELECT * FROM (
            SELECT
                *,
                row_number() OVER (
                    PARTITION BY series_key, observed_at
                    ORDER BY {SAME_SCRAPE_ORDER}
                ) AS canonical_rank
            FROM {base_view}
        )
        WHERE canonical_rank = 1
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE {prefix}_base_series AS
        SELECT
            series_key,
            min(route_id) AS route_id,
            min(departure_date) AS departure_date,
            min(train_number) AS train_number,
            min(service_class) AS service_class,
            min(departure_planned) AS departure_planned,
            arg_min(departure_planned, observed_at) AS first_departure,
            arg_max(departure_planned, observed_at) AS last_departure,
            min(observed_at) AS first_obs,
            max(observed_at) AS last_obs,
            count(DISTINCT observed_at) AS observations
        FROM {prefix}_canonical
        GROUP BY series_key
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE {prefix}_obs AS
        SELECT
            series_key,
            observed_at,
            arg_max(departure_planned, observed_at) AS departure_planned
        FROM {prefix}_canonical
        GROUP BY series_key, observed_at
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE {prefix}_grid_points AS
        SELECT
            route_id,
            departure_date,
            observed_at,
            lead(observed_at) OVER (
                PARTITION BY route_id, departure_date ORDER BY observed_at
            ) AS next_s
        FROM {grid_view}
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE {prefix}_obs_gap AS
        SELECT
            o.series_key,
            o.observed_at,
            o.departure_planned,
            s.route_id,
            s.departure_date,
            s.train_number,
            s.service_class,
            s.last_departure,
            lead(o.observed_at) OVER (PARTITION BY o.series_key ORDER BY o.observed_at) AS next_obs,
            CASE WHEN gp.next_s < s.last_departure THEN gp.next_s END AS next_s
        FROM {prefix}_obs o
        JOIN {prefix}_base_series s USING (series_key)
        LEFT JOIN {prefix}_grid_points gp
          ON gp.route_id = s.route_id
         AND gp.departure_date = s.departure_date
         AND gp.observed_at = o.observed_at
        """
    )
    phase_started = _phase("observations and gaps", phase_started)
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE {prefix}_split_points AS
        SELECT DISTINCT g.series_key, g.observed_at AS gap_obs
        FROM {prefix}_obs_gap g
        JOIN {prefix}_base_series ns
          ON ns.route_id = g.route_id
         AND ns.departure_date = g.departure_date
         AND ns.first_obs = g.next_s
         AND ns.service_class IS NOT DISTINCT FROM g.service_class
         AND ns.train_number IS NOT NULL
         AND ns.train_number = g.train_number
         AND abs(date_diff('second', ns.first_departure, g.departure_planned)) <= {LINK_TOLERANCE_SECONDS}
        WHERE g.next_s IS NOT NULL
          AND (g.next_obs IS NULL OR g.next_s < g.next_obs)
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE {prefix}_obs_rekeyed AS
        SELECT
            o.series_key AS base_series_key,
            o.observed_at,
            CASE
                WHEN o.incarnation_rank = 0 THEN o.series_key
                ELSE o.series_key || '#r' || CAST(o.incarnation_rank AS VARCHAR)
            END AS series_key,
            o.incarnation_rank
        FROM (
            SELECT
                o.series_key,
                o.observed_at,
                count(sp.gap_obs) FILTER (WHERE sp.gap_obs < o.observed_at) AS incarnation_rank
            FROM {prefix}_obs o
            LEFT JOIN {prefix}_split_points sp ON sp.series_key = o.series_key
            GROUP BY o.series_key, o.observed_at
        ) o
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE {prefix}_series AS
        SELECT
            r.series_key,
            min(c.route_id) AS route_id,
            min(c.departure_date) AS departure_date,
            min(c.train_number) AS train_number,
            min(c.service_class) AS service_class,
            min(c.departure_planned) AS departure_planned,
            arg_min(c.departure_planned, r.observed_at) AS first_departure,
            arg_max(c.departure_planned, r.observed_at) AS last_departure,
            min(r.observed_at) AS first_obs,
            max(r.observed_at) AS last_obs,
            count(DISTINCT r.observed_at) AS observations
        FROM {prefix}_obs_rekeyed r
        JOIN {prefix}_canonical c
          ON c.series_key = r.base_series_key
         AND c.observed_at = r.observed_at
        GROUP BY r.series_key
        """
    )
    phase_started = _phase("rekeyed series", phase_started)
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE {prefix}_next AS
        SELECT s.*, min(g.observed_at) AS next_s
        FROM {prefix}_series s
        JOIN {grid_view} g
          ON g.route_id = s.route_id
         AND g.departure_date = s.departure_date
         AND g.observed_at > s.last_obs
         AND g.observed_at < s.last_departure
        GROUP BY ALL
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE {prefix}_candidates AS
        SELECT
            n.series_key AS predecessor,
            ns.series_key AS successor,
            abs(date_diff('second', ns.first_departure, n.last_departure)) AS departure_delta_s
        FROM {prefix}_next n
        JOIN {prefix}_series ns
          ON ns.route_id = n.route_id
         AND ns.departure_date = n.departure_date
         AND ns.first_obs = n.next_s
         AND ns.service_class IS NOT DISTINCT FROM n.service_class
         AND ns.train_number IS NOT NULL
         AND ns.train_number = n.train_number
         AND abs(date_diff('second', ns.first_departure, n.last_departure)) <= {LINK_TOLERANCE_SECONDS}
        """
    )
    series = _scalar(connection, f"SELECT count(*) FROM {prefix}_series")
    base_series = _scalar(connection, f"SELECT count(*) FROM {prefix}_base_series")
    split_series = _scalar(
        connection,
        f"SELECT count(*) FROM (SELECT base_series_key FROM {prefix}_obs_rekeyed "
        f"GROUP BY base_series_key HAVING count(DISTINCT incarnation_rank) > 1)",
    )
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
    links_3plus = _scalar(
        connection,
        f"SELECT count(*) FROM {prefix}_links l "
        f"JOIN {prefix}_series s ON s.series_key = l.predecessor WHERE s.observations >= 3",
    )
    overlap_candidates = _scalar(
        connection,
        f"""
        SELECT count(*)
        FROM {prefix}_series n
        JOIN {prefix}_series ns
          ON ns.route_id = n.route_id
         AND ns.departure_date = n.departure_date
         AND ns.service_class IS NOT DISTINCT FROM n.service_class
         AND ns.train_number IS NOT NULL
         AND ns.train_number = n.train_number
         AND ns.series_key <> n.series_key
         AND ns.first_obs = n.last_obs
         AND abs(date_diff('second', ns.first_departure, n.last_departure)) <= {LINK_TOLERANCE_SECONDS}
        """,
    )
    phase_started = _phase("candidates and matching", phase_started)
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
        CREATE OR REPLACE TEMP TABLE {prefix}_chain_info AS
        SELECT m.chain_id, min(s.departure_date) AS chain_departure_date, min(s.first_obs) AS chain_first_obs
        FROM {prefix}_map_base m
        JOIN {prefix}_series s USING (series_key)
        GROUP BY m.chain_id
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE {map_table}_rows AS
        SELECT
            r.base_series_key AS series_key,
            r.observed_at,
            m.chain_id,
            i.chain_departure_date,
            i.chain_first_obs,
            s.first_obs AS series_first_obs
        FROM {prefix}_obs_rekeyed r
        JOIN {prefix}_map_base m USING (series_key)
        JOIN {prefix}_chain_info i USING (chain_id)
        JOIN {prefix}_series s ON s.series_key = r.series_key
        """
    )
    connection.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE {map_table} AS
        SELECT DISTINCT
            r.series_key,
            m.chain_id,
            i.chain_departure_date,
            i.chain_first_obs,
            s.first_obs AS series_first_obs
        FROM {prefix}_obs_rekeyed r
        JOIN {prefix}_map_base m USING (series_key)
        JOIN {prefix}_chain_info i USING (chain_id)
        JOIN {prefix}_series s ON s.series_key = r.series_key
        WHERE r.incarnation_rank = 0
        """
    )
    _phase("chain maps", phase_started)
    sizes: dict[str, int] = {}
    for chain_id in mapping.values():
        sizes[chain_id] = sizes.get(chain_id, 0) + 1
    histogram: dict[int, int] = {}
    for size in sizes.values():
        histogram[size] = histogram.get(size, 0) + 1
    linked_series = sum(sizes.values())
    linked_chains = len(sizes)
    identities = series - linked_series + linked_chains
    return ChainStats(
        strict=strict,
        series=series,
        base_series=base_series,
        split_series=split_series,
        at_risk_series=at_risk,
        at_risk_series_3plus=at_risk_3plus,
        candidate_links=candidates,
        ambiguous_predecessors=ambiguous_predecessors,
        ambiguous_successors=ambiguous_successors,
        strict_dropped=candidates - remaining,
        unused_candidates=candidates - len(links),
        overlap_candidates=overlap_candidates,
        links=len(links),
        links_3plus=links_3plus,
        chains=linked_chains,
        identities=identities,
        singleton_chains=series - linked_series,
        linked_series=linked_series,
        largest_chain=max(sizes.values(), default=0),
        link_rate=_optional_rate(len(links), at_risk),
        link_rate_3plus=_optional_rate(links_3plus, at_risk_3plus),
        series_link_rate=_optional_rate(linked_series, series),
        size_histogram=tuple(sorted(histogram.items())),
    )
