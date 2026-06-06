import type { HafasClient, Journey, JourneysOptions } from 'hafas-client';
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

interface NormalizableStop {
  abfahrt?: TimeFields;
  ankunft?: TimeFields;
  abfahrtsZeitpunkt?: unknown;
  abgangsDatum?: string;
  ezAbfahrtsZeitpunkt?: unknown;
  ezAbgangsDatum?: string;
  ankunftsZeitpunkt?: unknown;
  ankunftsDatum?: string;
  ezAnkunftsZeitpunkt?: unknown;
  ezAnkunftsDatum?: string;
}

interface NormalizableLeg extends NormalizableStop {
  halte?: NormalizableStop[];
  stops?: NormalizableStop[];
}

function normalizeStopTimes(obj: NormalizableStop): void {
  const abfahrt = obj.abfahrt;
  const ankunft = obj.ankunft;

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

function normalizeLegTimes(pt: NormalizableLeg): void {
  normalizeStopTimes(pt);
  const stops = pt.halte ?? pt.stops ?? [];
  for (const stop of stops) {
    normalizeStopTimes(stop);
  }
}

const customDbProfile = {
  ...dbProfile,
  parseJourneyLeg: (ctx: unknown, pt: unknown, date: unknown, fallbackLocations: unknown) => {
    normalizeLegTimes(pt as NormalizableLeg);
    return originalParseJourneyLeg(ctx, pt, date, fallbackLocations);
  },
  parseStopover: (ctx: unknown, st: unknown, date: unknown) => {
    normalizeStopTimes(st as NormalizableStop);
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
  const opts: JourneysOptions & { bestprice?: boolean } = {
    departure: noon,
    bestprice: true,
    tickets: true,
    firstClass,
  };
  const result = await client.journeys(originEva, destEva, opts);

  return (result.journeys ?? []) as Journey[];
}
