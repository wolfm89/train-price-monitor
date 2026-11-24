import assert from 'node:assert/strict';

import type { StoredJourney } from '../model/trainPriceMonitor';
import { getJourneyMonitor } from './user';

const stored: StoredJourney = {
  userId: 'user-1',
  id: 'journey-1',
  limitPrice: 50,
  refreshToken: 'refresh-token',
  expires: '2030-01-15T08:00:00.000Z',
  fromId: '8011160',
  toId: '8000261',
  departure: '2030-01-15T09:00:00.000Z',
  firstClass: false,
  deutschlandTicketDiscount: true,
  cachedPrice: 42,
  cachedDeparture: '2030-01-15T09:00:00.000Z',
  cachedArrival: '2030-01-15T13:00:00.000Z',
  cachedMeans: '["ICE"]',
  cachedFrom: 'Berlin Hbf',
  cachedTo: 'München Hbf',
  lastCheckedAt: '2026-11-24T00:00:00.000Z',
};

const monitor = getJourneyMonitor(stored);
assert.equal(monitor.fromId, '8011160', 'watchlist exposes the origin station ID');
assert.equal(monitor.toId, '8000261', 'watchlist exposes the destination station ID');
assert.equal(monitor.unavailable, false);
assert.equal(monitor.from, 'Berlin Hbf');
assert.equal(monitor.to, 'München Hbf');
assert.deepEqual(monitor.journey?.means, ['ICE']);

// A row that never refreshed has no snapshot, but its IDs are still on the
// entity and should not disappear from the API shape.
const legacy = getJourneyMonitor({ ...stored, lastCheckedAt: undefined });
assert.equal(legacy.unavailable, true);
assert.equal(legacy.journey, undefined);
assert.equal(legacy.fromId, '8011160');
assert.equal(legacy.toId, '8000261');

process.stdout.write('getJourneyMonitor checks passed\n');
