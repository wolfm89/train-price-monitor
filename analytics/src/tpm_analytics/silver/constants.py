"""Facts about the source data that the transform and the gate must agree on.

Two hand-maintained dates that used to live in separate files: the SQL labels a departure with
``TIMETABLE_BOUNDARY`` and the gate fails the build once departures reach ``TIMETABLE_REVIEW_AFTER``.
Keeping them in one module means updating the boundary cannot silently leave the guard behind.
"""

from __future__ import annotations

# The DB timetable changed at local midnight on this date. Departures before it are 2025-12.
TIMETABLE_BOUNDARY = "2026-12-13"

# The last departure date the current boundary covers. DB changes timetable in mid-December and
# mid-June; when data reaches this date, review the boundary above and move both dates.
TIMETABLE_REVIEW_AFTER = "2027-06-13"
