import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeNextScrapeAt, computeTtdTier, dueKey, scheduleBounds, tierRank, TIER_QUERY_ORDER } from './ttd.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function withRandom<T>(value: number, fn: () => T): T {
  const original = Math.random;
  Math.random = () => value;
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

describe('computeTtdTier', () => {
  const noon = new Date('2026-01-01T12:00:00Z');

  it('uses noon UTC on the departure date as the reference point', () => {
    // 30 days exactly is still MID; the next moment is FAR.
    assert.equal(computeTtdTier('2026-01-31', noon), 'MID');
    assert.equal(computeTtdTier('2026-01-31', new Date('2026-01-01T11:59:59Z')), 'FAR');
    assert.equal(computeTtdTier('2026-02-01', noon), 'FAR');
  });

  it('treats the 7-day boundary as MID', () => {
    assert.equal(computeTtdTier('2026-01-08', noon), 'MID');
    assert.equal(computeTtdTier('2026-01-07', noon), 'NEAR');
  });

  it('tiers past departures as NEAR', () => {
    assert.equal(computeTtdTier('2025-12-31', noon), 'NEAR');
  });

  it('measures from the current instant, not just the current date', () => {
    const lateEvening = new Date('2026-01-01T23:59:59Z');
    assert.equal(computeTtdTier('2026-01-09', lateEvening), 'MID');
    assert.equal(computeTtdTier('2026-01-08', lateEvening), 'NEAR');
  });
});

describe('computeNextScrapeAt', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  // Far enough out that the departure clamp never applies.
  const farDeparture = '2026-03-01';

  it('spaces NEAR scrapes 24 hours apart, with +/- 3 hours of jitter', () => {
    assert.equal(
      withRandom(0.5, () => computeNextScrapeAt('NEAR', now, farDeparture)).getTime(),
      now.getTime() + 24 * HOUR_MS
    );
    assert.equal(
      withRandom(0, () => computeNextScrapeAt('NEAR', now, farDeparture)).getTime(),
      now.getTime() + 21 * HOUR_MS
    );
    assert.equal(
      withRandom(1, () => computeNextScrapeAt('NEAR', now, farDeparture)).getTime(),
      now.getTime() + 27 * HOUR_MS
    );
  });

  it('spaces MID scrapes 8 days apart, with +/- 1 day of jitter', () => {
    assert.equal(
      withRandom(0.5, () => computeNextScrapeAt('MID', now, farDeparture)).getTime(),
      now.getTime() + 8 * DAY_MS
    );
    assert.equal(
      withRandom(0, () => computeNextScrapeAt('MID', now, farDeparture)).getTime(),
      now.getTime() + 7 * DAY_MS
    );
    assert.equal(
      withRandom(1, () => computeNextScrapeAt('MID', now, farDeparture)).getTime(),
      now.getTime() + 9 * DAY_MS
    );
  });

  it('spaces FAR scrapes 16 days apart, with +/- 2 days of jitter', () => {
    assert.equal(
      withRandom(0.5, () => computeNextScrapeAt('FAR', now, farDeparture)).getTime(),
      now.getTime() + 16 * DAY_MS
    );
    assert.equal(
      withRandom(0, () => computeNextScrapeAt('FAR', now, farDeparture)).getTime(),
      now.getTime() + 14 * DAY_MS
    );
    assert.equal(
      withRandom(1, () => computeNextScrapeAt('FAR', now, farDeparture)).getTime(),
      now.getTime() + 18 * DAY_MS
    );
  });

  it('never schedules a scrape in the past', () => {
    const next = withRandom(0, () => computeNextScrapeAt('NEAR', now, farDeparture));
    assert.ok(next.getTime() > now.getTime());
  });
});

describe('computeNextScrapeAt departure clamp', () => {
  it('pulls an eight-day MID scrape back to the edge of the near window', () => {
    const now = new Date('2026-01-01T12:00:00Z'); // exactly 8.0 days out
    const next = withRandom(0.5, () => computeNextScrapeAt('MID', now, '2026-01-09'));
    // Seven days before departure noon, plus the one-minute entry margin.
    assert.equal(next.toISOString(), '2026-01-02T12:01:00.000Z');
  });

  it('clamps a 7.5-day MID scrape that would otherwise land past departure', () => {
    const now = new Date('2026-01-02T00:00:00Z');
    const next = withRandom(0.5, () => computeNextScrapeAt('MID', now, '2026-01-09'));
    assert.equal(next.toISOString(), '2026-01-02T12:01:00.000Z');
  });

  it('leaves a NEAR scrape inside the window at the normal cadence', () => {
    const now = new Date('2026-01-03T12:00:00Z'); // 6 days out
    const next = withRandom(0.5, () => computeNextScrapeAt('NEAR', now, '2026-01-09'));
    assert.equal(next.toISOString(), '2026-01-04T12:00:00.000Z');
  });

  it('keeps NEAR jitter while the result stays before the hard stop', () => {
    const now = new Date('2026-01-03T12:00:00Z');
    assert.equal(
      withRandom(0, () => computeNextScrapeAt('NEAR', now, '2026-01-09')).toISOString(),
      '2026-01-04T09:00:00.000Z'
    );
    assert.equal(
      withRandom(1, () => computeNextScrapeAt('NEAR', now, '2026-01-09')).toISOString(),
      '2026-01-04T15:00:00.000Z'
    );
  });

  it('stops 90 minutes before departure, including the late jitter edge', () => {
    const now = new Date('2026-01-08T12:00:00Z'); // 1 day out
    const { hardStop } = scheduleBounds('2026-01-09');
    assert.equal(hardStop.toISOString(), '2026-01-09T10:30:00.000Z');
    assert.equal(
      withRandom(0.5, () => computeNextScrapeAt('NEAR', now, '2026-01-09')).toISOString(),
      '2026-01-09T10:30:00.000Z'
    );
    assert.equal(
      withRandom(1, () => computeNextScrapeAt('NEAR', now, '2026-01-09')).toISOString(),
      '2026-01-09T10:30:00.000Z'
    );
  });

  it('does not spin once the hard stop has passed', () => {
    const now = new Date('2026-01-09T11:00:00Z');
    const next = computeNextScrapeAt('NEAR', now, '2026-01-09');
    assert.equal(next.toISOString(), '2026-01-10T11:00:00.000Z');
  });

  it('never schedules after the hard stop, for any tier, date and jitter', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    for (let day = 1; day <= 40; day++) {
      const departure = new Date(now.getTime() + day * DAY_MS).toISOString().slice(0, 10);
      const { hardStop } = scheduleBounds(departure);
      for (const tier of ['NEAR', 'MID', 'FAR'] as const) {
        for (const random of [0, 0.25, 0.5, 0.75, 1]) {
          const next = withRandom(random, () => computeNextScrapeAt(tier, now, departure));
          assert.ok(
            next.getTime() <= hardStop.getTime(),
            `${tier} departing ${departure} (jitter ${random}) -> ${next.toISOString()} > ${hardStop.toISOString()}`
          );
        }
      }
    }
  });
});

describe('dueKey and tier ordering', () => {
  const nextScrapeAt = new Date('2026-01-02T12:00:00.000Z');

  it('prefixes the ByDue key with the tier rank', () => {
    assert.equal(dueKey('NEAR', nextScrapeAt), '0#2026-01-02T12:00:00.000Z');
    assert.equal(dueKey('MID', nextScrapeAt), '1#2026-01-02T12:00:00.000Z');
    assert.equal(dueKey('FAR', nextScrapeAt), '2#2026-01-02T12:00:00.000Z');
  });

  it('accepts an already serialized timestamp without changing it', () => {
    assert.equal(dueKey('MID', '2026-01-02T12:00:00.000Z'), '1#2026-01-02T12:00:00.000Z');
  });

  it('serves NEAR before MID before FAR', () => {
    assert.deepEqual(TIER_QUERY_ORDER, ['NEAR', 'MID', 'FAR']);
    assert.equal(tierRank('NEAR'), 0);
    assert.equal(tierRank('MID'), 1);
    assert.equal(tierRank('FAR'), 2);
  });
});
