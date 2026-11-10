interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const BERLIN_TIME_ZONE = 'Europe/Berlin';

const berlinFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: BERLIN_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function wallClockInBerlin(instant: Date): WallClock {
  const values: Record<string, number> = {};
  for (const part of berlinFormatter.formatToParts(instant)) {
    if (part.type !== 'literal') {
      values[part.type] = Number(part.value);
    }
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

/** Berlin's UTC offset (CET +01:00, CEST +02:00) at the given instant, in ms. */
function berlinOffsetMs(instant: Date): number {
  const wallClock = wallClockInBerlin(instant);
  const asUtc = Date.UTC(
    wallClock.year,
    wallClock.month - 1,
    wallClock.day,
    wallClock.hour,
    wallClock.minute,
    wallClock.second
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

function wallClockMatches(instant: Date, expected: WallClock): boolean {
  const actual = wallClockInBerlin(instant);
  return (
    actual.year === expected.year &&
    actual.month === expected.month &&
    actual.day === expected.day &&
    actual.hour === expected.hour &&
    actual.minute === expected.minute &&
    actual.second === expected.second
  );
}

/**
 * Interprets a `YYYY-MM-DD` day and an `HH:MM` time as Berlin wall-clock time
 * and returns the matching instant.
 *
 * The railway schedule and the DB API use German local time, so a search made
 * from another timezone must not be shifted by the device offset. `Intl` supplies
 * the CET/CEST offset for the selected date, so no new dependency is needed.
 * Returns an invalid `Date` for malformed input or a wall-clock time that does
 * not exist (the spring DST gap), which keeps the form's future-date validation
 * from accepting it.
 */
export function berlinWallTimeToDate(day: string, time: string): Date {
  const dayMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time.trim());
  if (!dayMatch || !timeMatch) return new Date(NaN);

  const expected: WallClock = {
    year: Number(dayMatch[1]),
    month: Number(dayMatch[2]),
    day: Number(dayMatch[3]),
    hour: Number(timeMatch[1]),
    minute: Number(timeMatch[2]),
    second: Number(timeMatch[3] ?? 0),
  };

  const naiveUtc = Date.UTC(
    expected.year,
    expected.month - 1,
    expected.day,
    expected.hour,
    expected.minute,
    expected.second
  );
  // The offset depends on the instant, and the instant depends on the offset:
  // apply it twice so dates close to a DST transition converge.
  let instant = naiveUtc - berlinOffsetMs(new Date(naiveUtc));
  instant = naiveUtc - berlinOffsetMs(new Date(instant));

  const result = new Date(instant);
  return wallClockMatches(result, expected) ? result : new Date(NaN);
}

/** Same as {@link berlinWallTimeToDate}, as an ISO-8601 UTC string (`''` if invalid). */
export function berlinWallTimeToIso(day: string, time: string): string {
  const date = berlinWallTimeToDate(day, time);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}
