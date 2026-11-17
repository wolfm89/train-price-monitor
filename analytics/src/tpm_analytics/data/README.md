# Holiday calendar data

`calendar.json` is the committed German public-holiday and school-holiday dataset used by the
analytics training builder. It is generated from the [OpenHolidays API](https://www.openholidaysapi.org/en/)
and must not be hand-edited.

| Property     | Value                                                                             |
| ------------ | --------------------------------------------------------------------------------- |
| Format       | JSON (`schema_version: 1`)                                                        |
| Coverage     | 2026-01-01 through 2028-12-31                                                     |
| States       | All 16 German federal states                                                      |
| Contents     | Public-holiday state/date rows and school-holiday ranges (counts are in the JSON) |
| Version      | `calendar_version` in the file (for example `2026-11-17`)                         |
| Data licence | ODbL-1.0; the code remains GPL-3.0                                                |

## Usage

```python
from tpm_analytics import calendar

data = calendar.load_calendar()
calendar.assert_covered("2026-01-01", "2028-12-31")
calendar.register_calendar(connection, "2026-01-01", "2028-12-31")
calendar.register_route_states(connection, "routes")
sql = calendar.route_calendar_sql("routes")
```

`load_calendar()` validates the file and its per-state/year completeness. `register_calendar`
creates the daily `calendar_daily` table and the `calendar_states` lookup; `register_route_states`
validates the route state names before the SQL join, so an unknown state cannot silently become a
false feature.

## Schema

`calendar_daily` is the daily state/date table. The canonical column list is
`tpm_analytics.calendar.DAILY_COLUMNS`.

| Group          | Columns                                                                                                                                                                                    | Notes                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Identity       | `state_code`, `date`                                                                                                                                                                       | German local calendar date                                                       |
| Public holiday | `is_public_holiday`, `public_holiday_name`, `public_holiday_scope`, `days_to_next_public_holiday`, `days_since_prev_public_holiday`, `is_public_holiday_window`                            | Null distance means no event inside the coverage window                          |
| School holiday | `is_school_holiday`, `school_holiday_name`, `school_holiday_type`, `school_holiday_day`, `days_until_school_holiday_end`, `is_school_holiday_start_window`, `is_school_holiday_end_window` | Start window: 3 days before the first day; end window: 3 days after the last day |
| Bridge day     | `is_bridge_day`                                                                                                                                                                            | Conservative weekend-adjacent case only                                          |

`route_calendar_sql` adds origin, destination, either and both variants for public and school
holidays, school type/day, bounded distances (0–14), `either_bridge_day`, `is_state_match`, and
`calendar_missing`/state/date missing flags.

## Sources and filters

- **Public holidays:** national holidays expand to all 16 states; state-specific holidays stay with
  their state. Local holidays such as Augsburg's Friedensfest are recorded under
  `excluded.local_holidays` and are not used for state-level features.
- **Mariä Himmelfahrt:** included for Bavaria as a documented municipality-dependent approximation;
  Saarland's is a full statutory holiday.
- **School holidays:** where OpenHolidays exposes school-type groups, only general schools are used
  (`*-ABS` / "Allgemeinbildende Schulen"). North Frisian island/Halligen exception ranges are
  excluded and recorded under `excluded.school_holiday_exceptions`; the state-wide range wins.
  Remaining overlapping ranges are resolved by the longest range when the daily table is built.
- **School-break types:** `summer`, `christmas`, `easter`, `autumn`, `winter`, `whitsun` and
  `other`; the raw name is retained.
- **Refresh trigger:** after KMK publishes the next school year (usually in autumn), regenerate,
  review the diff against the official table, and extend the coverage before scoring reaches the
  end date.

## Regeneration

From `analytics/`:

```bash
uv run python scripts/build_calendar.py
uv run python scripts/build_calendar.py --check
```

Or from the repository root:

```bash
mise run //analytics:calendar
mise run //analytics:calendar:check
```

Review the diff, run `uv run pytest` plus the `python-holidays` and KMK cross-checks, and commit the
code and data together. `--check` compares the holiday rows, coverage, states and source metadata,
but ignores `calendar_version` and `retrieved_at`; it is a source-drift check, not a freshness
check. Pass `--version` when rewriting the dataset if a specific manifest version is needed.

## Licence

The data is a derivative database of the OpenHolidays API data and is licensed under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).

Contains information from OpenHolidays API, which is made available under the Open Database
License (ODbL): https://www.openholidaysapi.org/en/

The repository code remains GPL-3.0. The data file is not relicensed under GPL-3.0. See the
repository `NOTICE` and the packaged `NOTICE` in this directory.
