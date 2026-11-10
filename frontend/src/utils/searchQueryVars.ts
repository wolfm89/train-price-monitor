import type { JourneySearchOptions } from '../components/SearchMask';

export interface SearchQueryVars {
  from: string;
  to: string;
  departure: string;
  earlierThan?: string;
  laterThan?: string;
  options?: JourneySearchOptions;
}

export type PageDirection = 'earlier' | 'later';

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
