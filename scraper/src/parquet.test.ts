import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parquetMetadata, parquetReadObjects } from 'hyparquet';
import { rowsToParquet } from './parquet.js';
import type { ParquetRow } from './types.js';

const baseRow: ParquetRow = {
  observed_at: new Date('2026-11-10T10:00:00Z'),
  service_class: 2,
  route_id: 'route-salzburg-flensburg',
  origin_eva: '8000105',
  origin_name: 'München Hbf',
  dest_eva: '8011160',
  dest_name: 'Berlin Hbf',
  departure_planned: new Date('2026-11-11T08:00:00Z'),
  arrival_planned: new Date('2026-11-11T12:00:00Z'),
  train_type: 'ICE',
  train_number: 'ICE 123',
  transfers: 0,
  duration_minutes: 240,
  days_to_departure: 0.9,
  fare_lowest_eur: 59.99,
  load_factor: null,
};

const secondRow: ParquetRow = {
  ...baseRow,
  service_class: 1,
  route_id: 'route-aachen-frankfurt',
  origin_name: 'Aachen Hbf',
  dest_name: 'Frankfurt(Oder)',
  train_type: 'RE',
  train_number: 'RE 1',
  transfers: 2,
  duration_minutes: 370,
  days_to_departure: 2.25,
  fare_lowest_eur: 99.5,
  load_factor: 'high',
};

describe('rowsToParquet', () => {
  it('writes the expected column order and physical types', () => {
    const metadata = parquetMetadata(rowsToParquet([baseRow]));
    const columns = metadata.schema.slice(1).map((column) => ({
      name: column.name,
      type: column.type,
      converted: column.converted_type,
    }));

    assert.deepEqual(columns, [
      { name: 'observed_at', type: 'INT64', converted: 'TIMESTAMP_MILLIS' },
      { name: 'service_class', type: 'INT32', converted: undefined },
      { name: 'route_id', type: 'BYTE_ARRAY', converted: 'UTF8' },
      { name: 'origin_eva', type: 'BYTE_ARRAY', converted: 'UTF8' },
      { name: 'origin_name', type: 'BYTE_ARRAY', converted: 'UTF8' },
      { name: 'dest_eva', type: 'BYTE_ARRAY', converted: 'UTF8' },
      { name: 'dest_name', type: 'BYTE_ARRAY', converted: 'UTF8' },
      { name: 'departure_planned', type: 'INT64', converted: 'TIMESTAMP_MILLIS' },
      { name: 'arrival_planned', type: 'INT64', converted: 'TIMESTAMP_MILLIS' },
      { name: 'train_type', type: 'BYTE_ARRAY', converted: 'UTF8' },
      { name: 'train_number', type: 'BYTE_ARRAY', converted: 'UTF8' },
      { name: 'transfers', type: 'INT32', converted: undefined },
      { name: 'duration_minutes', type: 'INT32', converted: undefined },
      { name: 'days_to_departure', type: 'DOUBLE', converted: undefined },
      { name: 'fare_lowest_eur', type: 'DOUBLE', converted: undefined },
      { name: 'load_factor', type: 'BYTE_ARRAY', converted: 'UTF8' },
    ]);
  });

  it('round-trips every field, including nullable load factors', async () => {
    const rows = await parquetReadObjects({ file: rowsToParquet([baseRow, secondRow]) });

    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { ...baseRow });
    assert.deepEqual(rows[1], { ...secondRow });
  });

  it('preserves millisecond timestamps', async () => {
    const withMillis: ParquetRow = {
      ...baseRow,
      observed_at: new Date('2026-11-10T10:00:00.123Z'),
      departure_planned: new Date('2026-11-11T08:00:00.456Z'),
      arrival_planned: new Date('2026-11-11T12:00:00.789Z'),
    };

    const [row] = await parquetReadObjects({ file: rowsToParquet([withMillis]) });
    assert.equal(row.observed_at.getTime(), withMillis.observed_at.getTime());
    assert.equal(row.departure_planned.getTime(), withMillis.departure_planned.getTime());
    assert.equal(row.arrival_planned.getTime(), withMillis.arrival_planned.getTime());
  });

  it('serializes an empty batch to a valid Parquet file with no rows', async () => {
    const buffer = rowsToParquet([]);
    assert.ok(buffer.byteLength > 0);
    assert.deepEqual(await parquetReadObjects({ file: buffer }), []);
  });
});
