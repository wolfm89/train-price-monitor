import { formatBerlinWallClock } from './berlinTime';
import type { LoyaltyCardInput } from './travelPreferences';

export interface BahnDeTicketLinkInput {
  from?: string | null;
  to?: string | null;
  fromId?: string | null;
  toId?: string | null;
  departure?: string | Date | null;
  firstClass?: boolean | null;
  deutschlandTicketDiscount?: boolean | null;
  ageGroup?: string | null;
  loyaltyCard?: LoyaltyCardInput | null;
}

const BAHN_DE_SEARCH_URL = 'https://www.bahn.de/buchung/fahrplan/suche';
const ADULT_NO_CARD = '13:16:KLASSENLOS:1';
const ALL_PRODUCTS = '00,01,02,03,04,05,06,07,08,09';

function isPresent(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Returns the EVA number when the stored ID is one, or extracts it from a full DB station ID. */
function evaNumber(rawId: string | null | undefined): string | null {
  if (!isPresent(rawId)) return null;
  const id = rawId.trim();
  if (/^\d+$/.test(id)) return id;
  return /(?:^|@)L=(\d+)(?:@|$)/.exec(id)?.[1] ?? null;
}

/**
 * Builds the station ID accepted by bahn.de's `soid`/`zoid` parameters.
 *
 * The DB Vendo parser exposes the EVA number as a station's `id`; full
 * `A=1@O=...@L=<eva>...` IDs are accepted too in case a stored row has one.
 * Full IDs pass through unchanged; any ID with an `@L=<eva>` segment is rebuilt
 * with the station name. The name-only `O=<name>` form is the last resort when
 * no usable ID is stored.
 */
function stationId(rawId: string | null | undefined, name: string, now: Date): string {
  if (isPresent(rawId)) {
    const id = rawId.trim();
    if (id.startsWith('A=') && id.includes('@')) return id;
    const eva = evaNumber(id);
    if (eva) {
      const timestamp = Math.floor(now.getTime() / 1000);
      return `A=1@O=${name}@X=@Y=@U=80@L=${eva}@B=1@p=${timestamp}@`;
    }
  }
  return `O=${name}`;
}

/**
 * Builds the `r` (traveller) parameter for bahn.de.
 *
 * `r` is `<traveller type>:<discount>:<discount class>:<count>`. DB does not
 * publish the numeric IDs, so only the combinations we can verify are handled:
 * adult with no card, and BahnCard 25/50. Anything else returns `null`, which
 * hides the link rather than opening a search with a materially different fare
 * from the one the user is watching.
 */
function travellerParameter(input: BahnDeTicketLinkInput): string | null {
  const ageGroup = input.ageGroup ?? 'ADULT';
  if (ageGroup !== 'ADULT') return null;

  const card = input.loyaltyCard;
  if (!card) return ADULT_NO_CARD;

  if (card.type === 'BAHNCARD' && (card.discount === 25 || card.discount === 50)) {
    const discountId = card.discount === 25 ? 17 : 23;
    const discountClass = card.class === 1 ? 'KLASSE_1' : 'KLASSE_2';
    return `13:${discountId}:${discountClass}:1`;
  }

  return null;
}

/**
 * Builds a bahn.de booking deep link for a watched journey.
 *
 * The link opens the connection search with the origin, destination, departure
 * and travel class prefilled. It is a pure URL: nothing leaves the browser until
 * the user clicks it. Returns `null` when the snapshot lacks the route or
 * departure needed to build a useful search, the departure is in the past, or
 * the saved traveller preferences cannot be represented faithfully.
 */
export function buildBahnDeTicketUrl(input: BahnDeTicketLinkInput, now: Date = new Date()): string | null {
  const from = input.from?.trim();
  const to = input.to?.trim();
  if (!from || !to || !input.departure) return null;

  const safeNow = Number.isNaN(now.getTime()) ? new Date() : now;
  const departure = input.departure instanceof Date ? input.departure : new Date(input.departure);
  const departureWallClock = formatBerlinWallClock(departure);
  if (!departureWallClock || departure.getTime() <= safeNow.getTime()) return null;

  const traveller = travellerParameter(input);
  if (!traveller) return null;

  const originId = stationId(input.fromId, from, safeNow);
  const destinationId = stationId(input.toId, to, safeNow);
  const originEva = evaNumber(input.fromId);
  const destinationEva = evaNumber(input.toId);

  const parameters: Array<[string, string]> = [
    ['sts', 'true'],
    ['so', from],
    ['zo', to],
    ['kl', input.firstClass === true ? '1' : '2'],
    ['r', traveller],
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
