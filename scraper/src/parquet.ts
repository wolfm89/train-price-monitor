import { parquetWriteBuffer } from 'hyparquet-writer';
import { type ParquetRow } from './types.js';

/**
 * Serialize an array of ParquetRow objects to a Parquet ArrayBuffer.
 * hyparquet-writer is column-oriented; we transpose rows → columns here.
 *
 * Column order is stable: new columns are appended so readers that only know
 * the v1 prefix keep working.
 */
export function rowsToParquet(rows: ParquetRow[]): ArrayBuffer {
  return parquetWriteBuffer({
    columnData: [
      { name: 'observed_at', type: 'TIMESTAMP', data: rows.map((r) => r.observed_at) },
      { name: 'service_class', type: 'INT32', data: Int32Array.from(rows.map((r) => r.service_class)) },
      { name: 'route_id', type: 'STRING', data: rows.map((r) => r.route_id) },
      { name: 'origin_eva', type: 'STRING', data: rows.map((r) => r.origin_eva) },
      { name: 'origin_name', type: 'STRING', data: rows.map((r) => r.origin_name) },
      { name: 'dest_eva', type: 'STRING', data: rows.map((r) => r.dest_eva) },
      { name: 'dest_name', type: 'STRING', data: rows.map((r) => r.dest_name) },
      {
        name: 'departure_planned',
        type: 'TIMESTAMP',
        data: rows.map((r) => r.departure_planned),
      },
      { name: 'arrival_planned', type: 'TIMESTAMP', data: rows.map((r) => r.arrival_planned) },
      { name: 'train_type', type: 'STRING', data: rows.map((r) => r.train_type) },
      { name: 'train_number', type: 'STRING', data: rows.map((r) => r.train_number) },
      { name: 'transfers', type: 'INT32', data: Int32Array.from(rows.map((r) => r.transfers)) },
      { name: 'duration_minutes', type: 'INT32', data: Int32Array.from(rows.map((r) => r.duration_minutes)) },
      { name: 'days_to_departure', type: 'DOUBLE', data: Float64Array.from(rows.map((r) => r.days_to_departure)) },
      {
        name: 'fare_lowest_eur',
        type: 'DOUBLE',
        nullable: true,
        data: rows.map((r) => r.fare_lowest_eur),
      },
      {
        name: 'load_factor',
        type: 'STRING',
        nullable: true,
        data: rows.map((r) => r.load_factor),
      },
      // Schema v2 appends every new column so the v1 prefix keeps its order.
      { name: 'train_numbers', type: 'STRING', data: rows.map((r) => r.train_numbers) },
      { name: 'fare_available', type: 'BOOLEAN', data: rows.map((r) => r.fare_available) },
      {
        name: 'load_factor_ordinal',
        type: 'INT32',
        nullable: true,
        data: rows.map((r) => r.load_factor_ordinal),
      },
      { name: 'journey_id', type: 'STRING', data: rows.map((r) => r.journey_id) },
      { name: 'schema_version', type: 'INT32', data: Int32Array.from(rows.map((r) => r.schema_version)) },
      { name: 'source_profile', type: 'STRING', data: rows.map((r) => r.source_profile) },
      { name: 'query_mode', type: 'STRING', data: rows.map((r) => r.query_mode) },
      { name: 'timetable_version', type: 'STRING', data: rows.map((r) => r.timetable_version) },
    ],
  });
}
