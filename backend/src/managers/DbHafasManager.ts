import type { HafasClient, Journey, JourneyWithRealtimeData, Journeys, Station } from 'hafas-client';
import { createClient } from 'db-vendo-client';
import { profile as dbnavProfile } from 'db-vendo-client/p/dbnav/index.js';
import Logger from '../lib/logger';

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
    this.client = createClient(dbnavProfile, userAgent);
  }

  /**
   * Queries journeys from the Hafas API based on the provided parameters.
   * @param from - The departure station or location.
   * @param to - The destination station or location.
   * @param departure - The departure date and time.
   * @param results - The maximum number of results to retrieve (default is 3).
   * @returns A promise that resolves to the retrieved journeys.
   */
  async queryJourneys(from: string, to: string, departure: Date, results: number = 3): Promise<Journeys> {
    return await this.client.journeys(from, to, { departure, results, tickets: true });
  }

  /**
   * Refreshes a journey using the provided refresh token and optional parameters.
   * @param refreshToken - The refresh token associated with the journey.
   * @returns A promise that resolves to the refreshed journey.
   */
  async requeryJourney(refreshToken: string): Promise<Journey | undefined> {
    if (refreshToken === undefined) {
      throw new Error('refreshToken is undefined');
    }

    let result: JourneyWithRealtimeData | undefined;
    try {
      result = await this.client.refreshJourney!(refreshToken, {
        tickets: true,
      });
    } catch {
      Logger.error('Error refreshing journey');
      return undefined;
    }

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
      const journeys = await this.queryJourneys(from, to, departure, n);
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
  async queryLocations(query: string): Promise<readonly Station[]> {
    return (await this.client.locations(query, {
      results: 5,
      addresses: false,
      poi: false,
    })) as readonly Station[];
  }
}
