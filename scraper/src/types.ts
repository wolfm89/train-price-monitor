export type TtdTier = 'FAR' | 'MID' | 'NEAR';

export interface ScheduleItem {
  pk: string; // ROUTE#{route_id}#DATE#{YYYY-MM-DD}
  sk: string; // SCHEDULE
  route_id: string;
  departure_date: string; // YYYY-MM-DD
  origin_eva: string;
  dest_eva: string;
  status: 'PENDING';
  next_scrape_at: string; // ISO 8601 UTC
  due_key: string; // `<tier rank>#<next_scrape_at>`; sort key of the ByDue index
  last_scraped_at?: string; // ISO 8601 UTC
  ttd_tier: TtdTier; // tier at next_scrape_at (matches the due_key rank), not at last_scraped_at
  scrape_count: number;
  created_at: string; // ISO 8601 UTC
  ttl: number; // Unix epoch seconds for DynamoDB TTL
}

export interface ParquetRow {
  observed_at: Date; // UTC timestamp (written as TIMESTAMP_MILLIS INT64)
  service_class: number; // 1 = first class, 2 = second class
  route_id: string;
  origin_eva: string;
  origin_name: string;
  dest_eva: string;
  dest_name: string;
  departure_planned: Date; // UTC timestamp (written as TIMESTAMP_MILLIS INT64)
  arrival_planned: Date; // UTC timestamp (written as TIMESTAMP_MILLIS INT64)
  train_type: string; // first train leg
  train_number: string; // first train leg
  train_numbers: string; // every train leg, `;`-joined
  transfers: number; // train legs − 1 (footways excluded, from schema v2 on)
  duration_minutes: number;
  days_to_departure: number;
  fare_lowest_eur: number | null; // null when no fare was offered
  fare_available: boolean;
  load_factor: string | null; // db-vendo vocabulary, not v1's collapsed `low`
  load_factor_ordinal: number | null; // 1 = low-to-medium … 4 = exceptionally-high
  journey_id: string; // tripId, or a hash of route + departure + train number
  schema_version: number; // 1 for rows written before schema v2, 2 from this change
  source_profile: string; // dbweb
  query_mode: string; // bestprice
  timetable_version: string; // DB annual timetable, `unknown` until set
}
