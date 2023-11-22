import { createClient, HafasClient, Journeys } from 'hafas-client';
import { profile as dbProfile } from 'hafas-client/p/db/index.js';

const userAgent = 'https://github.com/wolfm89/train-price-monitor';

export class DbHafasManager {
  private client!: HafasClient;

  constructor() {
    this.client = createClient(dbProfile, userAgent);
  }

  async queryJourneys(from: string, to: string, departure: Date): Promise<Journeys> {
    return await this.client.journeys(from, to, { departure: departure });
  }
}
