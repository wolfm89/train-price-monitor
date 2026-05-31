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
  last_scraped_at?: string; // ISO 8601 UTC
  ttd_tier: TtdTier;
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
  train_type: string;
  train_number: string;
  transfers: number;
  duration_minutes: number;
  days_to_departure: number;
  fare_lowest_eur: number;
  load_factor: string | null;
}
