import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeNextScrapeAt, computeTtdTier, dueKey, tierRank, TIER_QUERY_ORDER } from './ttd.js';

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

  it('spaces NEAR scrapes 24 hours apart, with +/- 3 hours of jitter', () => {
    assert.equal(withRandom(0.5, () => computeNextScrapeAt('NEAR', now)).getTime(), now.getTime() + 24 * HOUR_MS);
    assert.equal(withRandom(0, () => computeNextScrapeAt('NEAR', now)).getTime(), now.getTime() + 21 * HOUR_MS);
    assert.equal(withRandom(1, () => computeNextScrapeAt('NEAR', now)).getTime(), now.getTime() + 27 * HOUR_MS);
  });

  it('spaces MID scrapes 8 days apart, with +/- 1 day of jitter', () => {
    assert.equal(withRandom(0.5, () => computeNextScrapeAt('MID', now)).getTime(), now.getTime() + 8 * DAY_MS);
    assert.equal(withRandom(0, () => computeNextScrapeAt('MID', now)).getTime(), now.getTime() + 7 * DAY_MS);
    assert.equal(withRandom(1, () => computeNextScrapeAt('MID', now)).getTime(), now.getTime() + 9 * DAY_MS);
  });

  it('spaces FAR scrapes 16 days apart, with +/- 2 days of jitter', () => {
    assert.equal(withRandom(0.5, () => computeNextScrapeAt('FAR', now)).getTime(), now.getTime() + 16 * DAY_MS);
    assert.equal(withRandom(0, () => computeNextScrapeAt('FAR', now)).getTime(), now.getTime() + 14 * DAY_MS);
    assert.equal(withRandom(1, () => computeNextScrapeAt('FAR', now)).getTime(), now.getTime() + 18 * DAY_MS);
  });

  it('never schedules a scrape in the past', () => {
    const next = withRandom(0, () => computeNextScrapeAt('NEAR', now));
    assert.ok(next.getTime() > now.getTime());
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
