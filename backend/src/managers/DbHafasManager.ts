import type { HafasClient, Journey, JourneyWithRealtimeData, Journeys, Station } from 'hafas-client';
import { createClient } from 'db-vendo-client';
import { profile as dbProfile } from 'db-vendo-client/p/db/index.js';
import Logger from '../lib/logger';
import { LoyaltyCardData, toHafasLoyaltyCard, toHafasAgeGroup } from '../lib/loyaltyCards';

interface SimpleStation {
  type: string;
  id: string;
  name: string;
  weight: number;
}

export interface PricingOptions {
  firstClass?: boolean;
  loyaltyCards?: LoyaltyCardData[];
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

let stationCachePromise: Promise<SimpleStation[]> | null = null;

async function loadStationCache(): Promise<SimpleStation[]> {
  const dbHafasStations = await import('db-hafas-stations');
  const stations: SimpleStation[] = [];
  for await (const station of dbHafasStations.readSimplifiedStations()) {
    stations.push(station as SimpleStation);
  }
  return stations;
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

  if (pricingOptions.loyaltyCards && pricingOptions.loyaltyCards.length > 0) {
    // db-vendo-client supports array of loyalty cards for multi-traveller scenarios
    // For single traveller with multiple cards, the API uses the first card
    const hafasCards = pricingOptions.loyaltyCards.map(toHafasLoyaltyCard);
    opts.loyaltyCard = hafasCards.length === 1 ? hafasCards[0] : hafasCards;
  }

  if (pricingOptions.ageGroup) {
    opts.ageGroup = toHafasAgeGroup(pricingOptions.ageGroup);
  }

  if (pricingOptions.deutschlandTicketDiscount !== undefined) {
    opts.deutschlandTicketDiscount = pricingOptions.deutschlandTicketDiscount;
  }

  if (pricingOptions.products) {
    // Only pass products if at least one is explicitly set to false
    const hasFiltering = Object.values(pricingOptions.products).some((v) => v === false);
    if (hasFiltering) {
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
 * Manages interactions with the Hafas API for Deutsche Bahn operations.
 */
export class DbHafasManager {
  private client!: HafasClient;

  /**
   * Constructs a new DbHafasManager instance.
   */
  constructor() {
    this.client = createClient(dbProfile, userAgent, { enrichStations: false });
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
