import { describe, expect, it } from 'vitest';
import { fromSearchParams, toSearchParams, withPageDirection } from './searchQueryVars';
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

describe('search URL serialization', () => {
  it('round-trips every search field', () => {
    const search: SearchQueryVars = {
      from: '8000105',
      to: '8000261',
      departure: '2026-11-15T08:00:00.000Z',
      fromName: 'Berlin Hbf',
      toName: 'München Hbf',
      laterThan: 'later-token',
      options,
    };

    expect(fromSearchParams(toSearchParams(search))).toEqual(search);
  });

  it('omits empty values', () => {
    const params = toSearchParams({
      from: '8000105',
      to: '8000261',
      departure: '2026-11-15T08:00:00.000Z',
    });

    expect(params.get('fromName')).toBeNull();
    expect(params.get('options')).toBeNull();
    expect(params.get('earlier')).toBeNull();
    expect(params.get('later')).toBeNull();
  });

  it('returns null when a required field is missing', () => {
    expect(fromSearchParams(new URLSearchParams('from=8000105&to=8000261'))).toBeNull();
  });

  it('ignores malformed options JSON and unknown keys', () => {
    const malformed = fromSearchParams(
      new URLSearchParams('from=1&to=2&departure=2026-11-15T08:00:00.000Z&options=%7Bnot-json')
    );
    expect(malformed?.options).toBeUndefined();

    const sanitized = fromSearchParams(
      new URLSearchParams(
        'from=1&to=2&departure=2026-11-15T08:00:00.000Z&options=%7B%22firstClass%22%3Atrue%2C%22unknown%22%3A%22x%22%2C%22products%22%3A%7B%22nationalExpress%22%3Afalse%2C%22bogus%22%3Atrue%7D%7D'
      )
    );
    expect(sanitized?.options).toEqual({ firstClass: true, products: { nationalExpress: false } });
  });

  it('keeps a loyalty card that only has a type', () => {
    const search = fromSearchParams(
      toSearchParams({
        from: '1',
        to: '2',
        departure: '2026-11-15T08:00:00.000Z',
        options: { loyaltyCard: { type: 'VORTEILSCARD' } },
      })
    );
    expect(search?.options?.loyaltyCard).toEqual({ type: 'VORTEILSCARD' });
  });

  it('keeps earlier and later cursors mutually exclusive', () => {
    const search = fromSearchParams(
      new URLSearchParams('from=1&to=2&departure=2026-11-15T08:00:00.000Z&earlier=old&later=new')
    );
    expect(search?.earlierThan).toBeUndefined();
    expect(search?.laterThan).toBe('new');
  });
});
