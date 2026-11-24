import { formatBerlinWallClock } from './berlinTime';

export interface BahnDeTicketLinkInput {
  from?: string | null;
  to?: string | null;
  fromId?: string | null;
  toId?: string | null;
  departure?: string | Date | null;
  firstClass?: boolean | null;
  deutschlandTicketDiscount?: boolean | null;
}

const BAHN_DE_SEARCH_URL = 'https://www.bahn.de/buchung/fahrplan/suche';
const NO_LOYALTY_CARD = '13:16:KLASSENLOS:1';
const ALL_PRODUCTS = '00,01,02,03,04,05,06,07,08,09';

function isPresent(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Returns the EVA number when the stored ID is one, or extracts it from a full DB station ID. */
function evaNumber(rawId: string | null | undefined): string | null {
  if (!isPresent(rawId)) return null;
  const id = rawId.trim();
  if (/^\d+$/.test(id)) return id;
  return /@L=(\d+)/.exec(id)?.[1] ?? null;
}

/**
 * Builds the station ID accepted by bahn.de's `soid`/`zoid` parameters.
 *
 * The watchlist stores HAFAS station IDs (normally EVA numbers), while DB's
 * frontend wants the full `A=1@O=...@L=<eva>...` string. Full IDs are passed
 * through unchanged; EVA numbers are wrapped with the station name and an empty
 * coordinate pair, which DB accepts. The name-only `O=<name>` form is the last
 * resort when no usable ID is stored.
 */
function stationId(rawId: string | null | undefined, name: string, now: Date): string {
  if (isPresent(rawId)) {
    const id = rawId.trim();
    if (id.startsWith('A=') && id.includes('@')) return id;
    if (/^\d+$/.test(id)) {
      const timestamp = Math.floor(now.getTime() / 1000);
      return `A=1@O=${name}@X=@Y=@U=80@L=${id}@B=1@p=${timestamp}@`;
    }
  }
  return `O=${name}`;
}

/**
 * Builds a bahn.de booking deep link for a watched journey.
 *
 * The link opens the connection search with the origin, destination, departure
 * and travel class prefilled. It is a pure URL: nothing leaves the browser until
 * the user clicks it. Returns `null` when the snapshot lacks the route or
 * departure needed to build a useful search.
 */
export function buildBahnDeTicketUrl(input: BahnDeTicketLinkInput, now: Date = new Date()): string | null {
  const from = input.from?.trim();
  const to = input.to?.trim();
  if (!from || !to || !input.departure) return null;

  const departure = input.departure instanceof Date ? input.departure : new Date(input.departure);
  const departureWallClock = formatBerlinWallClock(departure);
  if (!departureWallClock) return null;

  const originId = stationId(input.fromId, from, now);
  const destinationId = stationId(input.toId, to, now);
  const originEva = evaNumber(input.fromId);
  const destinationEva = evaNumber(input.toId);

  const parameters: Array<[string, string]> = [
    ['sts', 'true'],
    ['so', from],
    ['zo', to],
    ['kl', input.firstClass === true ? '1' : '2'],
    ['r', NO_LOYALTY_CARD],
    ['soid', originId],
    ['zoid', destinationId],
    ['sot', 'ST'],
    ['zot', 'ST'],
    ...(originEva ? ([['soei', originEva]] as Array<[string, string]>) : []),
    ...(destinationEva ? ([['zoei', destinationEva]] as Array<[string, string]>) : []),
    ['hd', departureWallClock],
    ['hza', 'D'],
    ['hz', '[]'],
    ['ar', 'false'],
    ['s', 'false'],
    ['d', 'false'],
    ['vm', ALL_PRODUCTS],
    ['fm', 'false'],
    ['bp', 'false'],
    ['dlt', 'false'],
    ['dltv', input.deutschlandTicketDiscount === true ? 'true' : 'false'],
  ];

  const fragment = parameters.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return `${BAHN_DE_SEARCH_URL}#${fragment}`;
}
