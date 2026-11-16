"""Shared result types, so the publisher does not depend on the DuckDB engine."""

from dataclasses import dataclass


@dataclass(frozen=True, kw_only=True)
class BuildStats:
    """What one silver build produced."""

    source: str
    source_files: tuple[str, ...]
    target: str
    rows_in: int
    rows_out: int
    duplicates_removed: int
    partitions: int
    duration_seconds: float
    verified: bool
