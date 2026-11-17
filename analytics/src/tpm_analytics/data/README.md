# Calendar data

`calendar.json` is the committed German public-holiday and school-holiday calendar used by the
analytics training builder. It is generated from the [OpenHolidays API](https://www.openholidaysapi.org/en/)
and must not be hand-edited.

## Licence

The data is a derivative database of the OpenHolidays API data and is licensed under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).

Contains information from OpenHolidays API, which is made available under the Open Database
License (ODbL): https://www.openholidaysapi.org/en/

The repository code remains GPL-3.0. The data file is not relicensed under GPL-3.0. See the
repository `NOTICE`.

## Coverage and filters

- Coverage: 2026-01-01 through 2028-12-31, including school breaks that start before or end after
  the window.
- Public holidays: national holidays are expanded to all 16 states; state-specific holidays are
  kept for their state. Local holidays such as Augsburg's Friedensfest are recorded under
  `excluded.local_holidays` and are not used for state-level features.
- `Mariä Himmelfahrt` is included for Bavaria as a documented state-level approximation; it is
  municipality-dependent. Saarland's `Mariä Himmelfahrt` is a full statutory holiday.
- School holidays: where OpenHolidays exposes school-type groups, only general schools are used
  (`*-ABS` / "Allgemeinbildende Schulen"). North Frisian island/Halligen exception ranges are
  excluded and recorded under `excluded.school_holiday_exceptions`; the state-wide range wins.
  Remaining overlapping ranges are resolved by the longest range when the daily table is built.
- School-break types are normalized to `summer`, `christmas`, `easter`, `autumn`, `winter`,
  `whitsun` and `other`; the raw name is retained.

## Daily table

`tpm_analytics.calendar.DAILY_COLUMNS` defines the table produced by `register_calendar`:

`state_code`, `date`, `is_public_holiday`, `public_holiday_name`, `public_holiday_scope`,
`days_to_next_public_holiday`, `days_since_prev_public_holiday`, `is_public_holiday_window`,
`is_school_holiday`, `school_holiday_name`, `school_holiday_type`, `school_holiday_day`,
`days_until_school_holiday_end`, `is_school_holiday_start_window`,
`is_school_holiday_end_window`, `is_bridge_day`.

A null distance means there is no such event inside the coverage window. The start window covers
three days before through the first day of every school break; the end window covers the last day
through three days after. `is_bridge_day` is the conservative weekend-adjacent case only.

`route_calendar_sql` adds origin/destination/either/both flags, school type and day windows, bounded
distances (0–14), `either_bridge_day`, `is_state_match`, and `calendar_missing`/state/date missing
flags. Call `register_route_states` before the join so unknown state names fail instead of becoming
false features.

## Regeneration

From `analytics/`:

```bash
uv run python scripts/build_calendar.py
uv run python scripts/build_calendar.py --check
```

Review the diff, run `uv run pytest` plus the source cross-checks, and commit the code and data
together. Extend the coverage before the training/scoring range reaches the end date.

`--check` compares the holiday rows, coverage, states and source metadata, but ignores
`calendar_version` and `retrieved_at`; it is a source-drift check, not a freshness check. Pass
`--version` when rewriting the dataset if you need a specific manifest version.
