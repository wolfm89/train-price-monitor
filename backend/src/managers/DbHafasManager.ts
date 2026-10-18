import type { HafasClient, Journey, JourneyWithRealtimeData, Journeys, Station } from 'hafas-client';
import { createClient } from 'db-vendo-client';
import { profile as dbProfile } from 'db-vendo-client/p/dbweb/index.js';
import { parseJourneyLeg as originalParseJourneyLeg } from 'db-vendo-client/parse/journey-leg.js';
import { parseStopover as originalParseStopover } from 'db-vendo-client/parse/stopover.js';
import Logger from '../lib/logger';
import { LoyaltyCardData, toHafasLoyaltyCard, toHafasAgeGroup } from '../lib/loyaltyCards';

interface SimpleStation {
  type: string;
  id: string;
  name: string;
  weight: number;
}

/**
 * The dbweb /angebote/recon endpoint returns departure/arrival times as nested objects:
 *   { abfahrt: { sollzeit: "2026-05-25T18:36:00", istzeit: "..." }, ... }
 * But the db-vendo-client parser expects flat string fields. It accepts either the older
 * `abfahrtsZeitpunkt`/`ezAbfahrtsZeitpunkt` names or the newer `abgangsDatum`/`ezAbgangsDatum`
 * names (via `||` fallback). This normalizer sets the newer names:
 *   { abgangsDatum: "2026-05-25T18:36:00", ezAbgangsDatum: "...",
 *     ankunftsDatum: "2026-05-25T20:10:00", ezAnkunftsDatum: "..." }
 *
 * See: https://github.com/public-transport/db-vendo-client/blob/main/parse/journey-leg.js
 */
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

export interface PricingOptions {
  firstClass?: boolean;
  loyaltyCard?: LoyaltyCardData;
  ageGroup?: string;
  deutschlandTicketDiscount?: boolean;
  products?: Record<string, boolean>;
  transfers?: number;
  transferTime?: number;
  bike?: boolean;
}

export interface QueryJourneysOptions extends PricingOptions {
  results?: number;
  earlierThan?: string;
  laterThan?: string;
}

// Station index for autocomplete, generated from db-hafas-stations by
// scripts/build-station-index.mjs and bundled at build time. The package itself
// (13.5 MB NDJSON, 133 MB on disk) is a devDependency and never ships: reading it
// with a streaming parser cost ~1.1 s on the first `locations` call in every cold
// environment, versus ~20 ms for this file. Tuples are [id, name, weight]; the
// generator documents which stations are kept.
import stationIndex from '../stations/stations.json';

type StationTuple = [string, string, number];

let stationCachePromise: Promise<SimpleStation[]> | null = null;

function loadStationCache(): Promise<SimpleStation[]> {
  return Promise.resolve(
    (stationIndex as StationTuple[]).map(([id, name, weight]) => ({ type: 'station', id, name, weight }))
  );
}

function getStationCache(): Promise<SimpleStation[]> {
  if (!stationCachePromise) {
    stationCachePromise = loadStationCache();
  }
  return stationCachePromise;
}

function buildHafasOptions(pricingOptions?: PricingOptions): Record<string, unknown> {
  if (!pricingOptions) return {};

  const opts: Record<string, unknown> = {};

  if (pricingOptions.firstClass !== undefined) {
    opts.firstClass = pricingOptions.firstClass;
  }

  if (pricingOptions.loyaltyCard) {
    opts.loyaltyCard = toHafasLoyaltyCard(pricingOptions.loyaltyCard);
  }

  if (pricingOptions.ageGroup) {
    opts.ageGroup = toHafasAgeGroup(pricingOptions.ageGroup);
  }

  if (pricingOptions.deutschlandTicketDiscount !== undefined) {
    opts.deutschlandTicketDiscount = pricingOptions.deutschlandTicketDiscount;
  }

  if (pricingOptions.products && Object.keys(pricingOptions.products).length > 0) {
    // The vendo API classifies both RE (regionalExpress) and RB (regional) trains
    // under the same 'REGIONAL' product key. When the user selects RE, we must
    // also include RB so the vendo API correctly matches all regional trains.
    if (pricingOptions.products.regionalExpress === true && pricingOptions.products.regional !== true) {
      opts.products = { ...pricingOptions.products, regional: true };
    } else {
      opts.products = pricingOptions.products;
    }
  }

  if (pricingOptions.transfers !== undefined) {
    opts.transfers = pricingOptions.transfers;
  }

  if (pricingOptions.transferTime !== undefined) {
    opts.transferTime = pricingOptions.transferTime;
  }

  if (pricingOptions.bike !== undefined) {
    opts.bike = pricingOptions.bike;
  }

  return opts;
}

const userAgent = 'https://github.com/wolfm89/train-price-monitor';

/**
 * Rebuilds the /angebote/recon request so it honours the Deutschland-Ticket options.
 *
 * db-vendo-client's dbweb profile hardcodes `deutschlandTicketVorhanden: false`
 * and `nurDeutschlandTicketVerbindungen: false` in `formatRefreshJourneyReq`,
 * ignoring `opt.deutschlandTicketDiscount` — unlike `formatJourneysReq`, which
 * passes it through. A refreshed journey is therefore priced as if the traveller
 * had no Deutschland-Ticket, so any itinerary containing a regional leg comes
 * back more expensive than the search that produced it (observed on
 * Karlsruhe→Schwerin: 77.24 EUR on refresh versus 67.49 EUR in search for the
 * identical connection, the difference being the RE leg the D-Ticket covers).
 *
 * That inflated price is what the watchlist shows and what price alerts compare
 * against, so it both misreports the fare and triggers alerts that should not
 * fire. Patch the request here rather than the price afterwards, so search and
 * refresh ask DB the same question.
 *
 * See db-vendo-client/p/dbweb/journeys-req.js (formatRefreshJourneyReq).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatRefreshJourneyReqWithDeutschlandTicket(ctx: any, refreshToken: string): any {
  const { profile, opt } = ctx;

  // The polyline variant carries no pricing at all, so it needs no patching.
  if (!opt.tickets) {
    return (dbProfile as unknown as Record<string, (c: unknown, t: string) => unknown>).formatRefreshJourneyReq(
      ctx,
      refreshToken
    );
  }

  return {
    endpoint: profile.refreshJourneysEndpointTickets,
    body: {
      ctxRecon: refreshToken,
      deutschlandTicketVorhanden: Boolean(opt.deutschlandTicketDiscount),
      nurDeutschlandTicketVerbindungen: Boolean(opt.deutschlandTicketConnectionsOnly),
      reservierungsKontingenteVorhanden: false,
      ...profile.formatTravellers(ctx),
    },
    method: 'post',
  };
}

/**
 * Custom dbweb profile that normalizes /angebote/recon response times.
 * Wraps parseJourneyLeg and parseStopover to map nested time objects
 * (abfahrt.sollzeit / ankunft.sollzeit) to flat fields expected by the parser.
 */
const customDbProfile: typeof dbProfile & {
  parseJourneyLeg: typeof originalParseJourneyLeg;
  parseStopover: typeof originalParseStopover;
  // Not part of hafas-client's Profile type, but db-vendo-client's profiles
  // implement it and createClient calls it.
  formatRefreshJourneyReq: typeof formatRefreshJourneyReqWithDeutschlandTicket;
} = {
  ...dbProfile,
  formatRefreshJourneyReq: formatRefreshJourneyReqWithDeutschlandTicket,
  parseJourneyLeg: (ctx, pt, date, fallbackLocations) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    normalizeLegTimes(pt as Record<string, any>);
    return originalParseJourneyLeg(ctx, pt, date, fallbackLocations);
  },
  parseStopover: (ctx, st, date) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    normalizeStopTimes(st as Record<string, any>);
    return originalParseStopover(ctx, st, date);
  },
};

/**
 * Manages interactions with the Hafas API for Deutsche Bahn operations.
 */
export class DbHafasManager {
  private client!: HafasClient;

  /**
   * Constructs a new DbHafasManager instance.
   */
  constructor() {
    this.client = createClient(customDbProfile, userAgent, { enrichStations: false });
  }

  /**
   * Queries journeys from the Hafas API based on the provided parameters.
   * @param from - The departure station or location.
   * @param to - The destination station or location.
   * @param departure - The departure date and time.
   * @param options - Optional query options including pagination and pricing.
   * @returns A promise that resolves to the retrieved journeys.
   */
  async queryJourneys(from: string, to: string, departure: Date, options?: QueryJourneysOptions): Promise<Journeys> {
    const { results = 3, earlierThan, laterThan, ...pricingOpts } = options ?? {};
    if (earlierThan && laterThan) {
      throw new Error('earlierThan and laterThan are mutually exclusive');
    }

    const hafasOpts = buildHafasOptions(pricingOpts);

    if (earlierThan) {
      return await this.client.journeys(from, to, { earlierThan, results, tickets: true, ...hafasOpts });
    }
    if (laterThan) {
      return await this.client.journeys(from, to, { laterThan, results, tickets: true, ...hafasOpts });
    }
    return await this.client.journeys(from, to, { departure, results, tickets: true, ...hafasOpts });
  }

  /**
   * Exercises the DB path without caring about the result, to keep the vendor
   * browser session usable.
   *
   * Called by the scheduled keep-warm invocation (see backend.ts). Session setup
   * costs ~8-10 s in a fresh Lambda execution environment and roughly a third of
   * new vendor sessions are blocked and have to be replaced, so a search issued
   * right after the environment was recycled pays 10-20 s. Keeping one
   * environment — and therefore one session — alive off the request path means a
   * user's search never pays that.
   *
   * A real journeys query (rather than a synthetic probe) is deliberate: it runs
   * the same code path a search does, so success proves the session is usable.
   */
  async warmUp(): Promise<void> {
    await this.queryJourneys('8000191', '8011160', new Date(Date.now() + 3 * 86_400_000), { results: 1 });
  }

  /**
   * Refreshes a journey using the provided refresh token and pricing options.
   * @param refreshToken - The refresh token associated with the journey.
   * @param pricingOptions - Optional pricing options (loyalty card, class, age, D-Ticket).
   * @returns A promise that resolves to the refreshed journey.
   */
  async requeryJourney(refreshToken: string, pricingOptions?: PricingOptions): Promise<Journey | undefined> {
    if (refreshToken === undefined) {
      throw new Error('refreshToken is undefined');
    }

    const hafasOpts = buildHafasOptions(pricingOptions);

    const result: JourneyWithRealtimeData | undefined = await this.client.refreshJourney!(refreshToken, {
      tickets: true,
      ...hafasOpts,
    });

    if (!result) {
      return undefined;
    }

    const refreshedJourney = result.journey;

    if (refreshedJourney.legs === undefined || refreshedJourney.legs.length === 0) {
      throw new Error('refreshedJourney.legs is undefined or empty');
    }

    if (refreshedJourney.price) {
      Logger.info('Price was found in refreshed journey');
      return refreshedJourney;
    }

    const from = refreshedJourney.legs[0].origin!.id!;
    const to = refreshedJourney.legs[refreshedJourney.legs.length - 1].destination!.id!;
    const departure = new Date(refreshedJourney.legs[0].plannedDeparture!);

    for (const n of [1, 5]) {
      const journeys = await this.queryJourneys(from, to, departure, { results: n, ...pricingOptions });
      if (journeys.journeys === undefined || journeys.journeys.length === 0) {
        break;
      }

      const filteredJourneys = journeys.journeys.filter((journey: Journey) => journey.refreshToken === refreshToken);
      if (filteredJourneys.length > 0) {
        const price = filteredJourneys[0].price;
        if (price) {
          Logger.info('Price was found through new journeys query');
          refreshedJourney.price = price;
          break;
        }
      }
    }
    if (!refreshedJourney.price) {
      Logger.warn('Price was not found for journey');
    }

    return refreshedJourney;
  }

  /**
   * Queries locations from the Hafas API based on the provided query string.
   * @param query - The query string specifying the location.
   * @returns A promise that resolves to the retrieved locations.
   */
  async queryLocations(query: string, results: number = 5): Promise<readonly Station[]> {
    const stations = await getStationCache();
    const lowerQuery = query.toLowerCase();
    return stations
      .filter((s) => s.name.toLowerCase().includes(lowerQuery))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, results) as unknown as readonly Station[];
  }

  /**
   * Looks up a station by its HAFAS station ID from the in-memory station cache.
   * @param id - The HAFAS station ID to look up.
   * @returns A promise that resolves to the matching station, or undefined if not found.
   */
  async getStationById(id: string): Promise<SimpleStation | undefined> {
    const stations = await getStationCache();
    return stations.find((s) => s.id === id);
  }
}
