import type { HafasClient, Journey } from 'hafas-client';
import { createClient } from 'db-vendo-client';
import { profile as dbProfile } from 'db-vendo-client/p/dbweb/index.js';
import { parseJourneyLeg as originalParseJourneyLeg } from 'db-vendo-client/parse/journey-leg.js';
import { parseStopover as originalParseStopover } from 'db-vendo-client/parse/stopover.js';

const USER_AGENT = 'https://github.com/wolfm89/train-price-monitor';

// ---------------------------------------------------------------------------
// normalizeStopTimes — identical to DbHafasManager.ts in the backend.
//
// The dbweb /angebote/tagesbestpreis endpoint returns departure/arrival times
// as nested objects: { abfahrt: { sollzeit: "...", istzeit: "..." } }
// The db-vendo-client parser expects flat string fields. This normalizer maps
// the nested form to the flat form that the parser understands.
// ---------------------------------------------------------------------------

interface TimeFields {
  sollzeit?: string;
  istzeit?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeStopTimes(obj: Record<string, any>): void {
  const abfahrt = obj.abfahrt as TimeFields | undefined;
  const ankunft = obj.ankunft as TimeFields | undefined;

  if (!obj.abfahrtsZeitpunkt && !obj.abgangsDatum && abfahrt?.sollzeit) {
    obj.abgangsDatum = abfahrt.sollzeit;
  }
  if (!obj.ezAbfahrtsZeitpunkt && !obj.ezAbgangsDatum && abfahrt?.istzeit) {
    obj.ezAbgangsDatum = abfahrt.istzeit;
  }
  if (!obj.ankunftsZeitpunkt && !obj.ankunftsDatum && ankunft?.sollzeit) {
    obj.ankunftsDatum = ankunft.sollzeit;
  }
  if (!obj.ezAnkunftsZeitpunkt && !obj.ezAnkunftsDatum && ankunft?.istzeit) {
    obj.ezAnkunftsDatum = ankunft.istzeit;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeLegTimes(pt: Record<string, any>): void {
  normalizeStopTimes(pt);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stops = (pt.halte || pt.stops || []) as Record<string, any>[];
  for (const stop of stops) {
    normalizeStopTimes(stop);
  }
}

const customDbProfile = {
  ...dbProfile,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parseJourneyLeg: (ctx: any, pt: any, date: any, fallbackLocations: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    normalizeLegTimes(pt as Record<string, any>);
    return originalParseJourneyLeg(ctx, pt, date, fallbackLocations);
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parseStopover: (ctx: any, st: any, date: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    normalizeStopTimes(st as Record<string, any>);
    return originalParseStopover(ctx, st, date);
  },
};

// Singleton client — reused across Lambda invocations in the same container.
let _client: HafasClient | null = null;

export function getClient(): HafasClient {
  if (!_client) {
    _client = createClient(customDbProfile, USER_AGENT, { enrichStations: false });
  }
  return _client;
}

/**
 * Fetch all journeys for a route+day using the tagesbestpreis (bestprice) endpoint.
 * A single call covers the full calendar day — no pagination required.
 *
 * @param originEva - Origin station EVA number
 * @param destEva   - Destination station EVA number
 * @param date      - Departure date (time component is ignored; noon UTC is used)
 * @param firstClass - true for 1st class, false for 2nd class
 * @returns Array of journeys for the full day (typically ~30–40 trains)
 */
export async function fetchDayJourneys(
  originEva: string,
  destEva: string,
  date: Date,
  firstClass: boolean
): Promise<Journey[]> {
  // Use noon UTC on the target date — bestprice returns all trains regardless
  const noon = new Date(date);
  noon.setUTCHours(12, 0, 0, 0);

  const client = getClient();
  // bestprice is a db-vendo-client extension not present in @types/hafas-client
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const opts: any = { departure: noon, bestprice: true, tickets: true, firstClass };
  const result = await client.journeys(originEva, destEva, opts);

  return (result.journeys ?? []) as Journey[];
}
