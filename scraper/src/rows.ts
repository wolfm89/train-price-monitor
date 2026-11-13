import { createHash } from 'node:crypto';
import type { Journey, Leg, Line } from 'hafas-client';

import { type ParquetRow } from './types.js';

/** Bumped whenever the Parquet schema changes. v1 rows have no column at all. */
export const SCHEMA_VERSION = 2;

const SOURCE_PROFILE = 'dbweb';
const QUERY_MODE = 'bestprice';

/** db-vendo-client adds this to `Line`; the shared types do not know it. */
type TrainLine = Line & { productName?: string };

/**
 * Load-factor vocabulary from `db-vendo-client/parse/load-factor.js` (`stufe`
 * 1–4). There is no `medium`, and `exceptionally-high` must not collapse into
 * `low` the way the v1 extractor did.
 */
const LOAD_FACTOR_RANK: Record<string, number> = {
  'low-to-medium': 1,
  high: 2,
  'very-high': 3,
  'exceptionally-high': 4,
};

/** Secondary-resolution ISO timestamp, the reference used for the journey hash. */
export function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** A leg on a vehicle (train, bus, …), as opposed to a footway between platforms. */
export function isVehicleLeg(leg: Leg): boolean {
  return leg.walking !== true && leg.line !== undefined;
}

export function vehicleLegsOf(legs: Leg[]): Leg[] {
  return legs.filter(isVehicleLeg);
}

/**
 * A vehicle leg that runs on rails. The db-vendo product table maps trains
 * (incl. S-Bahn/U-Bahn/tram) to `mode: 'train'` and buses, ferries and taxis to
 * their own modes. An unknown product (`mode` undefined) is kept as rail rather
 * than silently dropped.
 */
export function isRailLeg(leg: Leg): boolean {
  if (!isVehicleLeg(leg)) return false;
  const mode = (leg.line as TrainLine | undefined)?.mode;
  return mode === 'train' || mode === undefined;
}

export function railLegsOf(legs: Leg[]): Leg[] {
  return legs.filter(isRailLeg);
}

/**
 * Dominant load factor over a journey's legs, with its ordinal. Unknown values
 * (stufe 0/99) contribute nothing and leave the pair null.
 */
export function extractLoadFactor(legs: Leg[]): { loadFactor: string | null; ordinal: number | null } {
  let loadFactor: string | null = null;
  let ordinal = 0;

  for (const leg of legs) {
    const factor = leg.loadFactor;
    if (!factor) continue;
    const rank = LOAD_FACTOR_RANK[factor];
    if (rank === undefined || rank <= ordinal) continue;
    loadFactor = factor;
    ordinal = rank;
  }

  return { loadFactor, ordinal: loadFactor === null ? null : ordinal };
}

/** Station/stop id of a leg endpoint, falling back to the stop's station. */
function pointId(point: Leg['origin']): string {
  if (!point) return '?';
  if (point.type === 'stop') return point.id ?? point.station?.id ?? '?';
  return point.id ?? '?';
}

/**
 * Stable, class-independent identity for one connection: a hash of the route
 * and the ordered vehicle legs. A leg contributes its `tripId` when the API
 * provides one (which encodes the run and date), otherwise its line name and
 * planned departure, plus the boarding and alighting station. The station pair
 * is what separates A→X→D from A→Y→D when both trains serve X and Y; planned
 * times are deliberately not mixed in when a trip id exists, because DB shifts
 * them routinely and that must not mint a new identity.
 *
 * A first-leg `tripId` alone is not enough — it identifies a train run, not the
 * origin-to-destination itinerary.
 */
export function journeyIdFor(routeId: string, legs: Leg[]): string {
  const itinerary = vehicleLegsOf(legs)
    .map((leg) => {
      const line = leg.line as TrainLine | undefined;
      const stops = `@${pointId(leg.origin)}>${pointId(leg.destination)}`;
      if (leg.tripId) return `t:${leg.tripId}${stops}`;

      const departure = leg.plannedDeparture ? isoSeconds(new Date(leg.plannedDeparture)) : '?';
      return `n:${line?.name ?? '?'}@${departure}${stops}`;
    })
    .join('>');

  return createHash('sha1').update(`${routeId}|${itinerary}`).digest('hex');
}

/**
 * Build ParquetRow entries from a list of journeys returned by the API, one row
 * per journey. Journeys without a price are kept with a null fare: a vanished
 * fare is a signal, not missing data.
 */
export function buildRows(
  journeys: Journey[],
  serviceClass: 1 | 2,
  routeId: string,
  originEva: string,
  originName: string,
  destEva: string,
  destName: string,
  observedAt: Date
): ParquetRow[] {
  const rows: ParquetRow[] = [];

  for (const j of journeys) {
    const legs = (j.legs ?? []) as Leg[];
    if (legs.length === 0) continue;

    const vehicleLegs = vehicleLegsOf(legs);
    const railLegs = railLegsOf(legs);
    // Bus-only journeys (e.g. a full rail-replacement service) are not train
    // prices; keeping them would write an empty train_numbers.
    if (railLegs.length === 0) continue;

    // The identity hash formats every vehicle leg's planned departure. A
    // malformed onward leg must not throw and discard the whole target.
    if (
      vehicleLegs.some(
        (leg) => leg.plannedDeparture !== undefined && Number.isNaN(new Date(leg.plannedDeparture).getTime())
      )
    ) {
      continue;
    }

    const firstLeg = legs[0];
    const lastLeg = legs[legs.length - 1];

    const depPlanned = firstLeg.plannedDeparture ? new Date(firstLeg.plannedDeparture) : null;
    const arrPlanned = lastLeg.plannedArrival ? new Date(lastLeg.plannedArrival) : null;
    if (!depPlanned || !arrPlanned) continue;
    // `new Date('garbage')` is truthy with a NaN time; it would poison the
    // duration and days-to-departure and throw in the journey hash.
    if (Number.isNaN(depPlanned.getTime()) || Number.isNaN(arrPlanned.getTime())) continue;
    // The day's response can still contain journeys that already left; writing
    // them would put a negative days_to_departure into the dataset.
    if (depPlanned.getTime() <= observedAt.getTime()) continue;

    const durationMinutes = Math.round((arrPlanned.getTime() - depPlanned.getTime()) / 60_000);
    const daysToDeparture = (depPlanned.getTime() - observedAt.getTime()) / (24 * 60 * 60 * 1000);

    // Label from the first rail leg; a connection that starts with a
    // rail-replacement bus is still a train journey.
    const labelLine = railLegs[0].line as TrainLine | undefined;
    const trainType = labelLine?.productName ?? labelLine?.product ?? 'UNKNOWN';
    const trainNumber = labelLine?.name ?? 'UNKNOWN';
    const trainNumbers = railLegs.map((leg) => (leg.line as TrainLine | undefined)?.name ?? 'UNKNOWN').join(';');

    // DB returns 0 or no amount when nothing is bookable; both mean unpriced.
    const amount = j.price?.amount;
    const fare = typeof amount === 'number' && Number.isFinite(amount) && amount > 0 ? amount : null;
    const { loadFactor, ordinal } = extractLoadFactor(legs);

    rows.push({
      observed_at: observedAt,
      service_class: serviceClass,
      route_id: routeId,
      origin_eva: originEva,
      origin_name: originName,
      dest_eva: destEva,
      dest_name: destName,
      departure_planned: depPlanned,
      arrival_planned: arrPlanned,
      train_type: trainType,
      train_number: trainNumber,
      train_numbers: trainNumbers,
      transfers: Math.max(0, vehicleLegs.length - 1),
      duration_minutes: durationMinutes,
      days_to_departure: daysToDeparture,
      fare_lowest_eur: fare,
      load_factor: loadFactor,
      load_factor_ordinal: ordinal,
      journey_id: journeyIdFor(routeId, legs),
      schema_version: SCHEMA_VERSION,
      source_profile: SOURCE_PROFILE,
      query_mode: QUERY_MODE,
    });
  }

  return rows;
}

/** Ordinal for a v1 row, where `low` means stufe 1 and stufe 4 was lost. */
export function legacyLoadFactorOrdinal(loadFactor: string | null): number | null {
  if (loadFactor === null) return null;
  if (loadFactor === 'low') return 1;
  return LOAD_FACTOR_RANK[loadFactor] ?? null;
}

/**
 * De-duplication key for one observation of one connection during compaction.
 * `journey_id` separates connections whose rail legs, times and fare match but
 * whose feeder vehicles differ; the remaining fields cover v1 rows, which have
 * no id.
 */
export function parquetRowKey(row: ParquetRow): string {
  // JSON keeps null, '' and 0 distinct and removes the free-text delimiter
  // ambiguity of a flat string join (`train_numbers` can contain anything).
  return JSON.stringify([
    row.observed_at.getTime(),
    row.route_id,
    row.service_class,
    row.departure_planned.getTime(),
    row.arrival_planned.getTime(),
    row.train_numbers,
    row.fare_lowest_eur,
    row.journey_id,
  ]);
}

/**
 * Rebuild a ParquetRow from a parsed file record. Rows written before schema v2
 * have none of the new columns, so every one of them is defaulted here rather
 * than by the compactor caller.
 *
 * `journey_id` is null for v1 rows on purpose: v1 only stored the first leg, so
 * any derived id would be ambiguous and would look like a v2 identity.
 */
export function fromParquetRecord(record: Record<string, unknown>): ParquetRow {
  const toDate = (value: unknown, field: string): Date => {
    if (value === undefined || value === null) throw new Error(`Missing ${field} in Parquet row`);
    const date = new Date(value as string | number);
    if (Number.isNaN(date.getTime())) throw new Error(`Invalid ${field} in Parquet row: ${JSON.stringify(value)}`);
    return date;
  };
  const requiredNumber = (value: unknown, field: string): number => {
    if (value === undefined || value === null) throw new Error(`Missing ${field} in Parquet row`);
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`Invalid ${field} in Parquet row: ${JSON.stringify(value)}`);
    return parsed;
  };
  const requiredString = (value: unknown, field: string): string => {
    if (value === undefined || value === null) throw new Error(`Missing ${field} in Parquet row`);
    return String(value);
  };
  const optionalString = (value: unknown, fallback: string): string =>
    value === undefined || value === null ? fallback : String(value);

  const routeId = requiredString(record.route_id, 'route_id');
  const trainNumber = requiredString(record.train_number, 'train_number');
  const loadFactor = record.load_factor ? String(record.load_factor) : null;
  const storedOrdinal = record.load_factor_ordinal;
  const fare = record.fare_lowest_eur;
  const storedJourneyId = record.journey_id;
  const schemaVersion =
    record.schema_version === undefined || record.schema_version === null
      ? 1
      : requiredNumber(record.schema_version, 'schema_version');

  return {
    observed_at: toDate(record.observed_at, 'observed_at'),
    service_class: requiredNumber(record.service_class, 'service_class'),
    route_id: routeId,
    origin_eva: requiredString(record.origin_eva, 'origin_eva'),
    origin_name: requiredString(record.origin_name, 'origin_name'),
    dest_eva: requiredString(record.dest_eva, 'dest_eva'),
    dest_name: requiredString(record.dest_name, 'dest_name'),
    departure_planned: toDate(record.departure_planned, 'departure_planned'),
    arrival_planned: toDate(record.arrival_planned, 'arrival_planned'),
    train_type: requiredString(record.train_type, 'train_type'),
    train_number: trainNumber,
    train_numbers: optionalString(record.train_numbers, trainNumber),
    transfers: requiredNumber(record.transfers, 'transfers'),
    duration_minutes: requiredNumber(record.duration_minutes, 'duration_minutes'),
    days_to_departure: requiredNumber(record.days_to_departure, 'days_to_departure'),
    fare_lowest_eur: fare === undefined || fare === null ? null : requiredNumber(fare, 'fare_lowest_eur'),
    load_factor: loadFactor,
    load_factor_ordinal:
      storedOrdinal === undefined || storedOrdinal === null
        ? legacyLoadFactorOrdinal(loadFactor)
        : requiredNumber(storedOrdinal, 'load_factor_ordinal'),
    journey_id: storedJourneyId === undefined || storedJourneyId === null ? null : String(storedJourneyId),
    schema_version: schemaVersion,
    source_profile: optionalString(record.source_profile, SOURCE_PROFILE),
    query_mode: optionalString(record.query_mode, QUERY_MODE),
  };
}
