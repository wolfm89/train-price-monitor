import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JOURNEY_TTL_MARGIN_DAYS,
  NOTIFICATION_RETENTION_DAYS,
  journeyTtl,
  notificationTtl,
  planTtlBackfill,
} from './backfill-ttl-lib.mjs';

const DAY = 24 * 60 * 60;
const epoch = (iso) => Date.parse(iso) / 1000;

test('a journey expires a safety margin after its own expiry', () => {
  assert.equal(
    journeyTtl('2026-12-01T10:00:00.000Z'),
    epoch('2026-12-01T10:00:00.000Z') + JOURNEY_TTL_MARGIN_DAYS * DAY
  );
  assert.equal(journeyTtl('not a date'), undefined);
});

test('a notification is kept for the retention period, but not shorter than its journey', () => {
  const created = '2026-11-01T00:00:00.000Z';
  assert.equal(notificationTtl(created), epoch(created) + NOTIFICATION_RETENTION_DAYS * DAY);
  // Journey ends long after the retention period: the notification lives as long as the journey.
  assert.equal(notificationTtl(created, '2027-06-01T00:00:00.000Z'), journeyTtl('2027-06-01T00:00:00.000Z'));
  // Journey ends soon: the retention period wins.
  assert.equal(
    notificationTtl(created, '2026-11-05T00:00:00.000Z'),
    epoch(created) + NOTIFICATION_RETENTION_DAYS * DAY
  );
  assert.equal(notificationTtl(undefined), undefined);
});

test('plans a ttl only for journeys and notifications without one', () => {
  const items = [
    { pk: 'USER#u1', sk: 'METADATA#' },
    { pk: 'USER#u1', sk: 'JOURNEY#j1', expires: '2027-06-01T00:00:00.000Z' },
    { pk: 'USER#u1', sk: 'JOURNEY#j2', expires: '2026-12-01T00:00:00.000Z', ttl: 123 },
    {
      pk: 'USER#u1',
      sk: 'NOTIFICATION#n1',
      timestamp: '2026-11-01T00:00:00.000Z',
      data: JSON.stringify({ journeyId: 'j1' }),
    },
    { pk: 'USER#u1', sk: 'NOTIFICATION#n2', timestamp: '2026-11-01T00:00:00.000Z', data: '{not json' },
    { pk: 'USER#u2', sk: 'NOTIFICATION#n3', timestamp: '2026-11-01T00:00:00.000Z', data: '{"journeyId":"j1"}' },
    { pk: 'USER#u2', sk: 'JOURNEY#j3' },
  ];

  const { updates, skipped } = planTtlBackfill(items);

  assert.deepEqual(updates, [
    { pk: 'USER#u1', sk: 'JOURNEY#j1', ttl: journeyTtl('2027-06-01T00:00:00.000Z') },
    { pk: 'USER#u1', sk: 'NOTIFICATION#n1', ttl: journeyTtl('2027-06-01T00:00:00.000Z') },
    { pk: 'USER#u1', sk: 'NOTIFICATION#n2', ttl: notificationTtl('2026-11-01T00:00:00.000Z') },
    // Same journey id, but another user's partition: not linked.
    { pk: 'USER#u2', sk: 'NOTIFICATION#n3', ttl: notificationTtl('2026-11-01T00:00:00.000Z') },
  ]);
  assert.deepEqual(
    skipped.map((entry) => entry.sk),
    ['JOURNEY#j3']
  );
});
