import type { JourneySearchOptions, ProductFilter } from '../components/SearchMask';
import type { LoyaltyCardInput } from './travelPreferences';

export interface SearchQueryVars {
  from: string;
  to: string;
  departure: string;
  fromName?: string;
  toName?: string;
  earlierThan?: string;
  laterThan?: string;
  options?: JourneySearchOptions;
}

export type PageDirection = 'earlier' | 'later';

const PRODUCT_KEYS: (keyof ProductFilter)[] = [
  'nationalExpress',
  'national',
  'regionalExpress',
  'regional',
  'suburban',
  'bus',
  'ferry',
  'subway',
  'tram',
  'taxi',
];

const MAX_OPTIONS_LENGTH = 2000;

/**
 * Builds the variables for an earlier/later page while preserving every
 * property of the active search — most importantly `options` (class, products,
 * transfers, bike, discount cards). Pagination used to be a place where those
 * filters could silently disappear.
 */
export function withPageDirection(
  previous: SearchQueryVars | null,
  direction: PageDirection,
  reference: string
): SearchQueryVars | null {
  if (!previous) return previous;
  return direction === 'earlier'
    ? { ...previous, earlierThan: reference, laterThan: undefined }
    : { ...previous, laterThan: reference, earlierThan: undefined };
}

/** Serializes a search into a shareable URL. Unknown values are omitted. */
export function toSearchParams(vars: SearchQueryVars | null): URLSearchParams {
  const params = new URLSearchParams();
  if (!vars) return params;

  if (vars.from) params.set('from', vars.from);
  if (vars.to) params.set('to', vars.to);
  if (vars.departure) params.set('departure', vars.departure);
  if (vars.fromName) params.set('fromName', vars.fromName);
  if (vars.toName) params.set('toName', vars.toName);
  if (vars.earlierThan) params.set('earlier', vars.earlierThan);
  if (vars.laterThan) params.set('later', vars.laterThan);
  if (vars.options && Object.keys(vars.options).length > 0) {
    params.set('options', JSON.stringify(vars.options));
  }
  return params;
}

function parseOptions(raw: string | null): JourneySearchOptions | undefined {
  if (!raw || raw.length > MAX_OPTIONS_LENGTH) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;

  const source = parsed as Record<string, unknown>;
  const options: JourneySearchOptions = {};

  if (typeof source.firstClass === 'boolean') options.firstClass = source.firstClass;
  if (typeof source.transfers === 'number' && Number.isFinite(source.transfers)) options.transfers = source.transfers;
  if (typeof source.transferTime === 'number' && Number.isFinite(source.transferTime)) {
    options.transferTime = source.transferTime;
  }
  if (typeof source.bike === 'boolean') options.bike = source.bike;
  if (typeof source.results === 'number' && Number.isFinite(source.results)) options.results = source.results;
  if (typeof source.ageGroup === 'string' && source.ageGroup) options.ageGroup = source.ageGroup;
  if (typeof source.deutschlandTicketDiscount === 'boolean') {
    options.deutschlandTicketDiscount = source.deutschlandTicketDiscount;
  }

  if (source.products && typeof source.products === 'object' && !Array.isArray(source.products)) {
    const rawProducts = source.products as Record<string, unknown>;
    const products: ProductFilter = {};
    for (const key of PRODUCT_KEYS) {
      if (typeof rawProducts[key] === 'boolean') products[key] = rawProducts[key];
    }
    if (Object.keys(products).length > 0) options.products = products;
  }

  if (source.loyaltyCard && typeof source.loyaltyCard === 'object' && !Array.isArray(source.loyaltyCard)) {
    const card = source.loyaltyCard as Record<string, unknown>;
    const discount = card.discount;
    const cardClass = card.class;
    if (
      typeof card.type === 'string' &&
      (discount == null || (typeof discount === 'number' && Number.isFinite(discount))) &&
      (cardClass == null || (typeof cardClass === 'number' && Number.isFinite(cardClass)))
    ) {
      const parsedCard: LoyaltyCardInput = { type: card.type };
      if (typeof discount === 'number') parsedCard.discount = discount;
      if (typeof cardClass === 'number') parsedCard.class = cardClass;
      options.loyaltyCard = parsedCard;
    }
  }

  return Object.keys(options).length > 0 ? options : undefined;
}

/** Parses a search from the URL. Returns null when the required fields are missing. */
export function fromSearchParams(params: URLSearchParams): SearchQueryVars | null {
  const from = params.get('from')?.trim() ?? '';
  const to = params.get('to')?.trim() ?? '';
  const departure = params.get('departure')?.trim() ?? '';
  if (!from || !to || !departure) return null;

  const earlier = params.get('earlier')?.trim() || undefined;
  const later = params.get('later')?.trim() || undefined;
  const options = parseOptions(params.get('options'));

  return {
    from,
    to,
    departure,
    ...(params.get('fromName')?.trim() ? { fromName: params.get('fromName')!.trim() } : {}),
    ...(params.get('toName')?.trim() ? { toName: params.get('toName')!.trim() } : {}),
    ...(earlier && !later ? { earlierThan: earlier } : {}),
    ...(later ? { laterThan: later } : {}),
    ...(options ? { options } : {}),
  };
}
