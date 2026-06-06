import { parquetWriteBuffer } from 'hyparquet-writer';
import { type ParquetRow } from './types.js';

/**
 * Serialize an array of ParquetRow objects to a Parquet ArrayBuffer.
 * hyparquet-writer is column-oriented; we transpose rows → columns here.
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
      { name: 'fare_lowest_eur', type: 'DOUBLE', data: Float64Array.from(rows.map((r) => r.fare_lowest_eur)) },
      {
        name: 'load_factor',
        type: 'STRING',
        nullable: true,
        data: rows.map((r) => r.load_factor),
      },
    ],
  });
}
