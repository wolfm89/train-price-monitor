import { describe, expect, it } from 'vitest';
import { withPageDirection } from './searchQueryVars';
import type { SearchQueryVars } from './searchQueryVars';

const options = {
  firstClass: true,
  bike: true,
  products: { nationalExpress: true, regional: false },
  loyaltyCard: { type: 'BAHNCARD', discount: 25, class: 1 },
};

const activeSearch: SearchQueryVars = {
  from: '8000105',
  to: '8000261',
  departure: '2026-11-15T09:00:00.000Z',
  options,
};

describe('withPageDirection', () => {
  it('preserves the search options when paging to later trains', () => {
    const next = withPageDirection(activeSearch, 'later', 'later-token');

    expect(next).toEqual({ ...activeSearch, laterThan: 'later-token', earlierThan: undefined });
    expect(next?.options).toEqual(options);
  });

  it('preserves the search options when paging to earlier trains', () => {
    const next = withPageDirection(activeSearch, 'earlier', 'earlier-token');

    expect(next).toEqual({ ...activeSearch, earlierThan: 'earlier-token', laterThan: undefined });
    expect(next?.options).toEqual(options);
  });

  it('replaces the opposite cursor rather than sending both', () => {
    const withEarlier: SearchQueryVars = { ...activeSearch, earlierThan: 'old-earlier' };
    const next = withPageDirection(withEarlier, 'later', 'new-later');

    expect(next?.earlierThan).toBeUndefined();
    expect(next?.laterThan).toBe('new-later');
  });

  it('does not mutate the active query variables', () => {
    const snapshot = structuredClone(activeSearch);
    withPageDirection(activeSearch, 'later', 'later-token');

    expect(activeSearch).toEqual(snapshot);
  });

  it('returns null when there is no active search', () => {
    expect(withPageDirection(null, 'later', 'later-token')).toBeNull();
  });
});
