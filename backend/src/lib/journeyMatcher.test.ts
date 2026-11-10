import assert from 'node:assert/strict';
import type { Journey } from 'hafas-client';
import { findMatchingJourney, MAX_DEPARTURE_DIFFERENCE_MS } from './journeyMatcher';

interface JourneyOptions {
  refreshToken?: string;
  fromId?: string;
  toId?: string;
  departure?: string;
  lineName?: string;
}

function makeJourney(options: JourneyOptions = {}): Journey {
  return {
    refreshToken: options.refreshToken ?? 'token',
    legs: [
      {
        origin: { id: options.fromId ?? 'from' },
        destination: { id: options.toId ?? 'to' },
        plannedDeparture: options.departure ?? '2026-11-10T10:00:00Z',
        line: options.lineName ? { name: options.lineName } : undefined,
      },
    ],
  } as unknown as Journey;
}

const target = {
  fromId: 'from',
  toId: 'to',
  departure: new Date('2026-11-10T10:00:00Z'),
  lineName: 'ICE 1',
};

// An exact reconstruction token is always accepted, even with a shifted departure.
const exact = makeJourney({
  refreshToken: 'exact-token',
  departure: '2026-11-10T18:00:00Z',
  lineName: 'ICE 1',
});
assert.equal(findMatchingJourney([exact], { ...target, refreshToken: 'exact-token' })?.refreshToken, 'exact-token');

// Same route and line within the tolerance is accepted.
const near = makeJourney({ refreshToken: 'near', departure: '2026-11-10T10:02:00Z', lineName: 'ICE 1' });
assert.equal(findMatchingJourney([near], target)?.refreshToken, 'near');

// Exactly at the tolerance is accepted; one minute beyond is not.
const boundary = makeJourney({
  refreshToken: 'boundary',
  departure: new Date(target.departure.getTime() + MAX_DEPARTURE_DIFFERENCE_MS).toISOString(),
  lineName: 'ICE 1',
});
assert.equal(findMatchingJourney([boundary], target)?.refreshToken, 'boundary');

const tooLate = makeJourney({
  refreshToken: 'too-late',
  departure: new Date(target.departure.getTime() + MAX_DEPARTURE_DIFFERENCE_MS + 60_000).toISOString(),
  lineName: 'ICE 1',
});
assert.equal(findMatchingJourney([tooLate], target), undefined);

// A different train on the same route is rejected.
const differentTrain = makeJourney({ refreshToken: 'other', departure: '2026-11-10T11:00:00Z', lineName: 'ICE 1' });
assert.equal(findMatchingJourney([differentTrain], target), undefined);

// Same time but a different line is rejected.
const differentLine = makeJourney({ refreshToken: 'other-line', departure: '2026-11-10T10:00:00Z', lineName: 'RE 2' });
assert.equal(findMatchingJourney([differentLine], target), undefined);

// A candidate without a line cannot satisfy a known line target.
const noLine = makeJourney({ refreshToken: 'no-line', departure: '2026-11-10T10:00:00Z' });
assert.equal(findMatchingJourney([noLine], target), undefined);

// A different route is rejected even when the departure matches.
const differentRoute = makeJourney({
  refreshToken: 'other-route',
  fromId: 'somewhere-else',
  departure: '2026-11-10T10:00:00Z',
  lineName: 'ICE 1',
});
assert.equal(findMatchingJourney([differentRoute], target), undefined);

// An invalid target departure cannot be used for a fallback match.
const invalidTarget = { ...target, departure: new Date('not-a-date') };
assert.equal(findMatchingJourney([near], invalidTarget), undefined);
assert.equal(
  findMatchingJourney([exact], { ...invalidTarget, refreshToken: 'exact-token' })?.refreshToken,
  'exact-token'
);

process.stdout.write('journeyMatcher checks passed\n');
