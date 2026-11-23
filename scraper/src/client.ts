import type { HafasClient, Journey, JourneysOptions } from 'hafas-client';
import { createClient } from 'db-vendo-client';
import { profile as dbProfile } from 'db-vendo-client/p/dbnav/index.js';

const USER_AGENT = 'https://github.com/wolfm89/train-price-monitor';

// Singleton client — reused across Lambda invocations in the same container.
let _client: HafasClient | null = null;

export function getClient(): HafasClient {
  if (!_client) {
    _client = createClient(dbProfile, USER_AGENT, { enrichStations: false });
  }
  return _client;
}

/**
 * Fetch all journeys for a route+day using the tagesbestpreis (bestprice) endpoint.
 * A single call covers the full calendar day — no pagination required.
 *
 * Uses the DB Navigator API (`app.services-bahn.de`) rather than the bahn.de web
 * API (`int.bahn.de`): since 2026-11-23 the web booking API answers every AWS
 * Lambda egress IP with `403 OPS_BLOCKED`, while the Navigator API still serves
 * the same daily prices. The Navigator request needs its `X-Correlation-ID`
 * header, which the shared transport forwards.
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
  // bestprice is a db-vendo-client extension not present in @types/hafas-client.
  // The two Deutschland-Ticket flags must be explicit booleans; the Navigator
  // API rejects an empty `fahrverguenstigungen` object with `VALIDIERUNG`.
  const opts: JourneysOptions & {
    bestprice?: boolean;
    deutschlandTicketDiscount?: boolean;
    deutschlandTicketConnectionsOnly?: boolean;
  } = {
    departure: noon,
    bestprice: true,
    tickets: true,
    firstClass,
    deutschlandTicketDiscount: false,
    deutschlandTicketConnectionsOnly: false,
  };
  const result = await client.journeys(originEva, destEva, opts);

  return (result.journeys ?? []) as Journey[];
}
