import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Journey, Leg } from 'hafas-client';
import { parquetReadObjects } from 'hyparquet';

import { rowsToParquet } from './parquet.js';
import {
  buildRows,
  extractLoadFactor,
  fromParquetRecord,
  isRailLeg,
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
  from?: string;
  to?: string;
}): Leg {
  return {
    tripId: options.tripId,
    plannedDeparture: options.dep,
    plannedArrival: options.arr,
    origin: { type: 'station', id: options.from ?? 'A', name: 'Origin' },
    destination: { type: 'station', id: options.to ?? 'D', name: 'Destination' },
    line: { type: 'line', name: options.name ?? 'ICE 1', product: options.product ?? 'ICE' },
    loadFactor: options.loadFactor,
  } as Leg;
}

function walkLeg(dep: string, arr: string): Leg {
  return { plannedDeparture: dep, plannedArrival: arr, walking: true } as Leg;
}

function busLeg(dep: string, arr: string, name = 'SEV 1', from = 'A', to = 'X'): Leg {
  return {
    plannedDeparture: dep,
    plannedArrival: arr,
    origin: { type: 'station', id: from, name: 'Origin' },
    destination: { type: 'station', id: to, name: 'Destination' },
    line: { type: 'line', name, product: 'BUS', mode: 'bus' },
  } as Leg;
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

describe('isRailLeg', () => {
  it('accepts trains and rejects buses, ferries and unknown non-rail modes', () => {
    assert.equal(isRailLeg(trainLeg({ dep: '2026-11-12T08:00:00Z', arr: '2026-11-12T09:00:00Z' })), true);
    assert.equal(isRailLeg(busLeg('2026-11-12T08:00:00Z', '2026-11-12T09:00:00Z')), false);

    const ferry = {
      plannedDeparture: '2026-11-12T08:00:00Z',
      plannedArrival: '2026-11-12T09:00:00Z',
      line: { type: 'line', name: 'F 1', product: 'ferry', mode: 'watercraft' },
    } as Leg;
    assert.equal(isRailLeg(ferry), false);

    const unknownProduct = {
      plannedDeparture: '2026-11-12T08:00:00Z',
      plannedArrival: '2026-11-12T09:00:00Z',
      line: { type: 'line', name: 'X 1' },
    } as Leg;
    assert.equal(isRailLeg(unknownProduct), true, 'an unmapped product stays rail');
  });
});

describe('buildRows', () => {
  it('labels the journey from the first rail leg and counts vehicle legs as transfers', () => {
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
    assert.equal(row.fare_lowest_eur, 49.99);
    assert.equal(row.schema_version, 2);
    assert.equal(row.source_profile, 'dbweb');
    assert.equal(row.query_mode, 'bestprice');
  });

  it('labels from the rail leg when a bus feeds the train, but counts the bus as a transfer', () => {
    const legs = [
      busLeg('2026-11-12T08:00:00Z', '2026-11-12T08:40:00Z'),
      trainLeg({ dep: '2026-11-12T08:50:00Z', arr: '2026-11-12T11:00:00Z', name: 'ICE 9', product: 'ICE' }),
    ];

    const [row] = rows(legs, 39.9);
    assert.equal(row.transfers, 1);
    assert.equal(row.train_type, 'ICE');
    assert.equal(row.train_number, 'ICE 9');
    assert.equal(row.train_numbers, 'ICE 9');
  });

  it('keeps an unpriced journey with a null fare', () => {
    const [row] = rows([trainLeg({ dep: '2026-11-12T08:00:00Z', arr: '2026-11-12T10:00:00Z' })], undefined);
    assert.ok(row, 'the row must not be dropped');
    assert.equal(row.fare_lowest_eur, null);
  });

  it('derives the same journey_id for both service classes', () => {
    const legs = [trainLeg({ dep: '2026-11-12T08:00:00Z', arr: '2026-11-12T10:00:00Z', name: 'ICE 1' })];
    const [second] = rows(legs, 49.99, 2);
    const [first] = rows(legs, 79.99, 1);

    assert.equal(second.journey_id, first.journey_id);
    assert.ok(second.journey_id);
    assert.match(second.journey_id, /^[0-9a-f]{40}$/);
    assert.equal(second.journey_id, journeyIdFor('8011160-8000261', legs));
  });

  it('keeps the journey_id stable across planned-time shifts when a tripId exists', () => {
    const legsAt = (dep: string, arr: string) => [
      trainLeg({ dep: '2026-11-12T08:00:00Z', arr: '2026-11-12T09:00:00Z', tripId: 'trip-a' }),
      trainLeg({ dep, arr, tripId: 'trip-b' }),
    ];

    const [before] = rows(legsAt('2026-11-12T09:20:00Z', '2026-11-12T12:00:00Z'), 49.99);
    const [after] = rows(legsAt('2026-11-12T09:25:00Z', '2026-11-12T12:05:00Z'), 49.99);
    assert.equal(before.journey_id, after.journey_id);
  });

  it('falls back to line and departure when a leg has no tripId', () => {
    const legsAt = (dep: string) => [trainLeg({ dep, arr: '2026-11-12T12:00:00Z', name: 'ICE 1' })];

    const [before] = rows(legsAt('2026-11-12T08:00:00Z'), 49.99);
    const [after] = rows(legsAt('2026-11-12T08:05:00Z'), 49.99);
    assert.notEqual(before.journey_id, after.journey_id);
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

  it('distinguishes the same trains when the change station differs', () => {
    const viaX = [
      trainLeg({
        dep: '2026-11-12T08:00:00Z',
        arr: '2026-11-12T09:00:00Z',
        name: 'ICE 100',
        tripId: 'trip-1',
        from: 'A',
        to: 'X',
      }),
      trainLeg({
        dep: '2026-11-12T09:10:00Z',
        arr: '2026-11-12T12:00:00Z',
        name: 'ICE 200',
        tripId: 'trip-2',
        from: 'X',
        to: 'D',
      }),
    ];
    const viaY = [
      trainLeg({
        dep: '2026-11-12T08:00:00Z',
        arr: '2026-11-12T09:00:00Z',
        name: 'ICE 100',
        tripId: 'trip-1',
        from: 'A',
        to: 'Y',
      }),
      trainLeg({
        dep: '2026-11-12T09:10:00Z',
        arr: '2026-11-12T12:00:00Z',
        name: 'ICE 200',
        tripId: 'trip-2',
        from: 'Y',
        to: 'D',
      }),
    ];

    const [a] = rows(viaX, 49.99);
    const [b] = rows(viaY, 49.99);
    assert.notEqual(a.journey_id, b.journey_id);
  });

  it('keys equal-time connections with different feeder buses apart', () => {
    const make = (busName: string) => [
      busLeg('2026-11-12T08:00:00Z', '2026-11-12T08:40:00Z', busName, 'A', 'X'),
      trainLeg({
        dep: '2026-11-12T09:00:00Z',
        arr: '2026-11-12T12:00:00Z',
        name: 'ICE 100',
        tripId: 'trip-1',
        from: 'X',
        to: 'D',
      }),
    ];

    const [a] = rows(make('BUS 1'), 49.99);
    const [b] = rows(make('BUS 2'), 49.99);
    assert.notEqual(a.journey_id, b.journey_id);
    assert.notEqual(parquetRowKey(a), parquetRowKey(b));
  });

  it('skips journeys that already departed', () => {
    const legs = [trainLeg({ dep: '2026-11-10T08:00:00Z', arr: '2026-11-10T10:00:00Z' })];
    assert.deepEqual(rows(legs, 49.99), []);
  });

  it('skips journeys with no rail leg', () => {
    assert.deepEqual(rows([walkLeg('2026-11-12T08:00:00Z', '2026-11-12T08:10:00Z')], 49.99), []);
    assert.deepEqual(
      rows([busLeg('2026-11-12T08:00:00Z', '2026-11-12T09:00:00Z')], 49.99),
      [],
      'a bus-only replacement service is not a train price'
    );
  });

  it('skips journeys with an invalid planned departure or arrival', () => {
    assert.deepEqual(rows([trainLeg({ dep: 'not-a-date', arr: '2026-11-12T10:00:00Z' })], 49.99), []);
    assert.deepEqual(rows([trainLeg({ dep: '2026-11-12T08:00:00Z', arr: 'not-a-date' })], 49.99), []);
  });

  it('skips a journey whose onward leg has an invalid departure', () => {
    const legs = [
      trainLeg({ dep: '2026-11-12T08:00:00Z', arr: '2026-11-12T09:00:00Z', name: 'ICE 100' }),
      {
        ...trainLeg({ dep: '2026-11-12T09:10:00Z', arr: '2026-11-12T12:00:00Z', name: 'ICE 200' }),
        plannedDeparture: 'not-a-date',
      } as Leg,
    ];

    // The hash formats the onward departure; it must not throw and lose the target.
    assert.deepEqual(rows(legs, 49.99), []);
  });

  it('falls back to the stop station id when the stop has no id', () => {
    const viaStop = (stationId: string): Leg =>
      ({
        plannedDeparture: '2026-11-12T08:00:00Z',
        plannedArrival: '2026-11-12T10:00:00Z',
        origin: { type: 'stop', station: { type: 'station', id: stationId } },
        destination: { type: 'station', id: 'D' },
        line: { type: 'line', name: 'ICE 1', product: 'ICE' },
      }) as Leg;

    const [a] = rows([viaStop('X')], 49.99);
    const [b] = rows([viaStop('Y')], 49.99);
    assert.notEqual(a.journey_id, b.journey_id);
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
    assert.equal(row.load_factor, 'low');
    assert.equal(row.load_factor_ordinal, 1);
    assert.equal(row.source_profile, 'dbweb');
    assert.equal(row.query_mode, 'bestprice');
    assert.equal(row.timetable_version, 'unknown');
    // v1 never stored the itinerary; a derived id would look authoritative.
    assert.equal(row.journey_id, null);
    // v1 `transfers` is preserved (2× the real count); silver normalises it.
    assert.equal(row.transfers, 2);
  });

  it('preserves v2 values unchanged', () => {
    const row = fromParquetRecord({
      ...v1Record,
      train_numbers: 'ICE 591;RE 1',
      transfers: 1,
      fare_lowest_eur: null,
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

  it('rejects non-finite required values instead of writing NaN or zero', () => {
    assert.throws(
      () => fromParquetRecord({ ...v1Record, days_to_departure: 'not-a-number' }),
      /Invalid days_to_departure/
    );
    assert.throws(() => fromParquetRecord({ ...v1Record, fare_lowest_eur: 'NaN' }), /Invalid fare_lowest_eur/);
    assert.throws(() => fromParquetRecord({ ...v1Record, observed_at: 'nope' }), /Invalid observed_at/);
    assert.throws(() => fromParquetRecord({ ...v1Record, service_class: undefined }), /Missing service_class/);
  });

  it('rejects null required values instead of coercing them', () => {
    // Number(null) === 0 and new Date(null) === 1970-01-01 would otherwise look valid.
    assert.throws(() => fromParquetRecord({ ...v1Record, days_to_departure: null }), /Missing days_to_departure/);
    assert.throws(() => fromParquetRecord({ ...v1Record, observed_at: null }), /Missing observed_at/);
    assert.throws(() => fromParquetRecord({ ...v1Record, service_class: null }), /Missing service_class/);
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
