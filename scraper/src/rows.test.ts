import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Journey, Leg } from 'hafas-client';
import { parquetReadObjects } from 'hyparquet';

import { rowsToParquet } from './parquet.js';
import {
  buildRows,
  extractLoadFactor,
  fromParquetRecord,
  journeyIdFor,
  legacyLoadFactorOrdinal,
  parquetRowKey,
} from './rows.js';

const observedAt = new Date('2026-11-10T10:00:00Z');

function trainLeg(options: {
  dep: string;
  arr: string;
  name?: string;
  product?: string;
  tripId?: string;
  loadFactor?: string;
}): Leg {
  return {
    tripId: options.tripId,
    plannedDeparture: options.dep,
    plannedArrival: options.arr,
    line: { type: 'line', name: options.name ?? 'ICE 1', product: options.product ?? 'ICE' },
    loadFactor: options.loadFactor,
  } as Leg;
}

function walkLeg(dep: string, arr: string): Leg {
  return { plannedDeparture: dep, plannedArrival: arr, walking: true } as Leg;
}

function journey(legs: Leg[], amount?: number): Journey {
  return { legs, price: amount === undefined ? undefined : { amount } } as unknown as Journey;
}

function rows(legs: Leg[], amount: number | undefined, serviceClass: 1 | 2 = 2) {
  return buildRows(
    [journey(legs, amount)],
    serviceClass,
    '8011160-8000261',
    '8011160',
    'Berlin Hbf',
    '8000261',
    'München Hbf',
    observedAt
  );
}

describe('extractLoadFactor', () => {
  it('maps the four db-vendo levels and takes the maximum', () => {
    const legs = [
      trainLeg({ dep: '2026-11-12T08:00:00Z', arr: '2026-11-12T09:00:00Z', loadFactor: 'low-to-medium' }),
      trainLeg({ dep: '2026-11-12T09:10:00Z', arr: '2026-11-12T10:00:00Z', loadFactor: 'high' }),
    ];
    assert.deepEqual(extractLoadFactor(legs), { loadFactor: 'high', ordinal: 2 });
    assert.deepEqual(extractLoadFactor([]), { loadFactor: null, ordinal: null });
    assert.deepEqual(extractLoadFactor([trainLeg({ dep: '2026-11-12T08:00:00Z', arr: '2026-11-12T09:00:00Z' })]), {
      loadFactor: null,
      ordinal: null,
    });
  });

  it('keeps exceptionally-high as level 4 instead of collapsing it to low', () => {
    const legs = [
      trainLeg({ dep: '2026-11-12T08:00:00Z', arr: '2026-11-12T09:00:00Z', loadFactor: 'exceptionally-high' }),
    ];
    assert.deepEqual(extractLoadFactor(legs), { loadFactor: 'exceptionally-high', ordinal: 4 });
  });
});

describe('buildRows', () => {
  it('labels the journey from the first train leg and counts only train legs as transfers', () => {
    const legs = [
      walkLeg('2026-11-12T08:00:00Z', '2026-11-12T08:10:00Z'),
      trainLeg({ dep: '2026-11-12T08:20:00Z', arr: '2026-11-12T10:00:00Z', name: 'ICE 1', product: 'ICE' }),
      trainLeg({ dep: '2026-11-12T10:20:00Z', arr: '2026-11-12T11:00:00Z', name: 'RE 2', product: 'RE' }),
      walkLeg('2026-11-12T11:00:00Z', '2026-11-12T11:10:00Z'),
    ];

    const [row] = rows(legs, 49.99);
    assert.equal(row.transfers, 1);
    assert.equal(row.train_type, 'ICE');
    assert.equal(row.train_number, 'ICE 1');
    assert.equal(row.train_numbers, 'ICE 1;RE 2');
    assert.equal(row.departure_planned.toISOString(), '2026-11-12T08:00:00.000Z');
    assert.equal(row.duration_minutes, 190);
    assert.equal(row.fare_available, true);
    assert.equal(row.fare_lowest_eur, 49.99);
    assert.equal(row.schema_version, 2);
    assert.equal(row.source_profile, 'dbweb');
    assert.equal(row.query_mode, 'bestprice');
  });

  it('keeps an unpriced journey with fare_available=false', () => {
    const [row] = rows([trainLeg({ dep: '2026-11-12T08:00:00Z', arr: '2026-11-12T10:00:00Z' })], undefined);
    assert.ok(row, 'the row must not be dropped');
    assert.equal(row.fare_available, false);
    assert.equal(row.fare_lowest_eur, null);
  });

  it('derives the same journey_id for both service classes', () => {
    const legs = [trainLeg({ dep: '2026-11-12T08:00:00Z', arr: '2026-11-12T10:00:00Z', name: 'ICE 1' })];
    const [second] = rows(legs, 49.99, 2);
    const [first] = rows(legs, 79.99, 1);

    assert.equal(second.journey_id, first.journey_id);
    assert.match(second.journey_id, /^[0-9a-f]{40}$/);
    assert.equal(second.journey_id, journeyIdFor('8011160-8000261', legs));
  });

  it('distinguishes connections that share their first train', () => {
    const shared = trainLeg({ dep: '2026-11-12T08:00:00Z', arr: '2026-11-12T09:00:00Z', name: 'ICE 100' });
    const viaHannover = [
      shared,
      trainLeg({ dep: '2026-11-12T09:20:00Z', arr: '2026-11-12T12:00:00Z', name: 'ICE 200' }),
    ];
    const viaLeipzig = [
      shared,
      trainLeg({ dep: '2026-11-12T09:30:00Z', arr: '2026-11-12T11:40:00Z', name: 'ICE 300' }),
    ];

    const [a] = rows(viaHannover, 49.99);
    const [b] = rows(viaLeipzig, 49.99);
    assert.notEqual(a.journey_id, b.journey_id);
  });

  it('scopes the journey_id to the route', () => {
    const legs = [trainLeg({ dep: '2026-11-12T08:00:00Z', arr: '2026-11-12T10:00:00Z', name: 'ICE 100' })];
    const [own] = rows(legs, 49.99);
    const [other] = buildRows(
      [journey(legs, 49.99)],
      2,
      '8011160-8000105',
      '8011160',
      'Berlin Hbf',
      '8000105',
      'Frankfurt(Main)Hbf',
      observedAt
    );
    assert.notEqual(own.journey_id, other.journey_id);
  });

  it('keys two unpriced connections with different onward trains apart', () => {
    const shared = trainLeg({ dep: '2026-11-12T08:00:00Z', arr: '2026-11-12T09:00:00Z', name: 'ICE 100' });
    const viaHannover = [
      shared,
      trainLeg({ dep: '2026-11-12T09:20:00Z', arr: '2026-11-12T12:00:00Z', name: 'ICE 200' }),
    ];
    const viaLeipzig = [
      shared,
      trainLeg({ dep: '2026-11-12T09:30:00Z', arr: '2026-11-12T11:40:00Z', name: 'ICE 300' }),
    ];

    const [a] = rows(viaHannover, undefined);
    const [b] = rows(viaLeipzig, undefined);
    assert.notEqual(parquetRowKey(a), parquetRowKey(b));

    const [again] = rows(viaHannover, undefined);
    assert.equal(parquetRowKey(a), parquetRowKey(again));
  });

  it('skips journeys that already departed', () => {
    const legs = [trainLeg({ dep: '2026-11-10T08:00:00Z', arr: '2026-11-10T10:00:00Z' })];
    assert.deepEqual(rows(legs, 49.99), []);
  });

  it('skips journeys with no train leg', () => {
    assert.deepEqual(rows([walkLeg('2026-11-12T08:00:00Z', '2026-11-12T08:10:00Z')], 49.99), []);
  });
});

describe('fromParquetRecord', () => {
  const v1Record = {
    observed_at: '2026-10-01T10:00:00Z',
    service_class: 2,
    route_id: '8011160-8000261',
    origin_eva: '8011160',
    origin_name: 'Berlin Hbf',
    dest_eva: '8000261',
    dest_name: 'München Hbf',
    departure_planned: '2026-10-05T08:00:00Z',
    arrival_planned: '2026-10-05T12:00:00Z',
    train_type: 'ICE',
    train_number: 'ICE 591',
    transfers: 2,
    duration_minutes: 240,
    days_to_departure: 4.9,
    fare_lowest_eur: 59.99,
    load_factor: 'low',
  };

  it('defaults every v2 column on a v1 record', () => {
    const row = fromParquetRecord(v1Record);
    assert.equal(row.schema_version, 1);
    assert.equal(row.train_numbers, 'ICE 591');
    assert.equal(row.fare_available, true);
    assert.equal(row.load_factor, 'low');
    assert.equal(row.load_factor_ordinal, 1);
    assert.equal(row.source_profile, 'dbweb');
    assert.equal(row.query_mode, 'bestprice');
    assert.equal(row.timetable_version, 'unknown');
    assert.match(row.journey_id, /^[0-9a-f]{40}$/);
    // v1 `transfers` is preserved (2× the real count); silver normalises it.
    assert.equal(row.transfers, 2);
  });

  it('preserves v2 values unchanged', () => {
    const row = fromParquetRecord({
      ...v1Record,
      train_numbers: 'ICE 591;RE 1',
      transfers: 1,
      fare_lowest_eur: null,
      fare_available: false,
      load_factor: 'very-high',
      load_factor_ordinal: 3,
      journey_id: 'trip-1',
      schema_version: 2,
      source_profile: 'dbweb',
      query_mode: 'bestprice',
      timetable_version: '2026-12',
    });

    assert.equal(row.schema_version, 2);
    assert.equal(row.train_numbers, 'ICE 591;RE 1');
    assert.equal(row.fare_lowest_eur, null);
    assert.equal(row.fare_available, false);
    assert.equal(row.load_factor_ordinal, 3);
    assert.equal(row.journey_id, 'trip-1');
    assert.equal(row.timetable_version, '2026-12');
  });

  it('maps the legacy load-factor vocabulary', () => {
    assert.equal(legacyLoadFactorOrdinal('low'), 1);
    assert.equal(legacyLoadFactorOrdinal('high'), 2);
    assert.equal(legacyLoadFactorOrdinal('very-high'), 3);
    assert.equal(legacyLoadFactorOrdinal(null), null);
    // `low-to-medium` only exists from v2 on and must map to level 1.
    assert.equal(legacyLoadFactorOrdinal('low-to-medium'), 1);
  });
});

describe('compactor round-trip', () => {
  it('preserves a v2 row through serialize, parse and normalise', async () => {
    const legs = [
      walkLeg('2026-11-12T08:00:00Z', '2026-11-12T08:10:00Z'),
      trainLeg({
        dep: '2026-11-12T08:20:00Z',
        arr: '2026-11-12T10:00:00Z',
        name: 'ICE 1',
        loadFactor: 'very-high',
      }),
      trainLeg({ dep: '2026-11-12T10:20:00Z', arr: '2026-11-12T11:00:00Z', name: 'RE 2' }),
    ];
    const [built] = rows(legs, 49.99);
    const [parsed] = await parquetReadObjects({ file: rowsToParquet([built]) });
    const normalized = fromParquetRecord(parsed as Record<string, unknown>);

    assert.deepEqual(normalized, built);
    assert.equal(normalized.load_factor, 'very-high');
    assert.equal(normalized.load_factor_ordinal, 3);
    assert.equal(normalized.schema_version, 2);
  });
});
