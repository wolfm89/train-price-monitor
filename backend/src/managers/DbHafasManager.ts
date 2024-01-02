import { HafasClient, Journey, Journeys, Station } from 'hafas-client';
import createClient from 'hafas-client';
import dbProfile from 'hafas-client/p/db';

const userAgent = 'https://github.com/wolfm89/train-price-monitor';

export class DbHafasManager {
  private client!: HafasClient;

  constructor() {
    this.client = createClient(dbProfile, userAgent);
  }

  async queryJourneys(from: string, to: string, departure: Date): Promise<Journeys> {
    return await this.client.journeys(from, to, { departure: departure });
  }

  async requeryJourney(refreshToken: string): Promise<Journey> {
    if (refreshToken === undefined) {
      throw new Error('refreshToken is undefined');
    }
    return await this.client.refreshJourney!(refreshToken, {
      subStops: false,
      entrances: false,
    });
  }

  async queryLocations(query: string): Promise<readonly (Station | createClient.Stop | createClient.Location)[]> {
    return await this.client.locations(query, {
      results: 5,
      addresses: false,
      poi: false,
      subStops: false,
      entrances: false,
      linesOfStops: false,
    });
  }
}
