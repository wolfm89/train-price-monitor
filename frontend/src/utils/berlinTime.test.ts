import { describe, expect, it } from 'vitest';
import { berlinWallTimeToDate, berlinWallTimeToIso } from './berlinTime';

describe('berlinWallTimeToDate', () => {
  it('interprets a winter wall-clock time as CET (+01:00)', () => {
    expect(berlinWallTimeToIso('2026-01-15', '14:00')).toBe('2026-01-15T13:00:00.000Z');
  });

  it('interprets a summer wall-clock time as CEST (+02:00)', () => {
    expect(berlinWallTimeToIso('2026-07-15', '14:00')).toBe('2026-07-15T12:00:00.000Z');
  });

  it('handles a wall-clock time that falls on the previous UTC day', () => {
    expect(berlinWallTimeToIso('2026-01-15', '00:30')).toBe('2026-01-14T23:30:00.000Z');
  });

  it('uses the summer offset from the spring transition onward', () => {
    expect(berlinWallTimeToIso('2026-03-29', '03:30')).toBe('2026-03-29T01:30:00.000Z');
  });

  it('uses the winter offset after the autumn transition', () => {
    expect(berlinWallTimeToIso('2026-10-25', '03:30')).toBe('2026-10-25T02:30:00.000Z');
  });

  it('rejects a wall-clock time that does not exist in the spring DST gap', () => {
    expect(Number.isNaN(berlinWallTimeToDate('2026-03-29', '02:30').getTime())).toBe(true);
  });

  it('accepts an ambiguous autumn time as one of its two instants', () => {
    const iso = berlinWallTimeToIso('2026-10-25', '02:30');
    expect(['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z']).toContain(iso);
  });

  it('returns an invalid date and an empty string for malformed input', () => {
    expect(Number.isNaN(berlinWallTimeToDate('', '').getTime())).toBe(true);
    expect(Number.isNaN(berlinWallTimeToDate('15.01.2026', '14:00').getTime())).toBe(true);
    expect(Number.isNaN(berlinWallTimeToDate('2026-01-15', '2pm').getTime())).toBe(true);
    expect(berlinWallTimeToIso('', '')).toBe('');
  });
});
