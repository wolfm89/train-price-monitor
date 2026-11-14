"""Facts about the source data that the transform and the gate must agree on."""

from __future__ import annotations

# The DB timetable changed at local midnight on this date. Departures before it are 2025-12.
TIMETABLE_BOUNDARY = "2026-12-13"
TIMETABLE_PREVIOUS = "2025-12"
TIMETABLE_CURRENT = "2026-12"

# The last departure date the current boundary covers. DB changes timetable in mid-December and
# mid-June; when data reaches this date, review the boundary above and move both dates.
TIMETABLE_REVIEW_AFTER = "2027-06-13"

# Observation-era cutoffs. `dense` is the pre-fix era that scraped whole days every minute;
# `sparse` runs until the poller fix deployed; `post-fix` starts with the first batch it wrote.
DENSE_ERA_CUTOFF = "2026-09-01 00:00:00"
OBSERVATION_ERA_CUTOFF = "2026-11-13 18:15:49"

# The compactor's de-duplication key (scraper/src/rows.ts, parquetRowKey). Silver collapses rows
# that share it, and the gate checks the same columns, so both live here.
DEDUPE_KEY: tuple[str, ...] = (
    "observed_at",
    "route_id",
    "service_class",
    "departure_planned",
    "arrival_planned",
    "train_numbers",
    "fare_lowest_eur",
    "journey_id",
)

# A build may drop duplicates, but never a meaningful share of the corpus. The historical corpus
# has 1,146 duplicates in 107M rows (0.001 %); 0.1 % is a generous ceiling.
MAX_DUPLICATE_SHARE = 0.001
MAX_DUPLICATE_ABSOLUTE = 1000
