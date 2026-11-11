import { describe, expect, it } from 'vitest';
import { DEFAULT_TITLE, SITE_URL, pageMeta } from './seo';

describe('pageMeta', () => {
  it('marks the landing page as indexable with a self-referencing canonical', () => {
    expect(pageMeta('/')).toEqual({
      title: DEFAULT_TITLE,
      noindex: false,
      canonical: `${SITE_URL}/`,
    });
  });

  it('treats a trailing slash on the landing page as the root path', () => {
    expect(pageMeta('//')).toEqual(pageMeta('/'));
  });

  it('marks app routes as noindex and gives each a descriptive title', () => {
    expect(pageMeta('/journeys')).toEqual({
      title: 'Your journeys – Train Price Monitor',
      noindex: true,
      canonical: `${SITE_URL}/journeys`,
    });
    expect(pageMeta('/search').noindex).toBe(true);
    expect(pageMeta('/profile').noindex).toBe(true);
  });

  it('marks unknown paths as noindex so the SPA fallback is not indexed', () => {
    expect(pageMeta('/no-such-page')).toEqual({
      title: DEFAULT_TITLE,
      noindex: true,
      canonical: `${SITE_URL}/no-such-page`,
    });
  });
});
