import { NOINDEX_APP_ROUTES, noindexAppRoutesCode } from '../lib/cloudfront/noindex-app-routes';

interface ResponseEvent {
  request: { uri: string };
  response: { headers: Record<string, { value: string }>; statusCode?: number };
}

const run = new Function('event', `${noindexAppRoutesCode()}\nreturn handler(event);`) as (
  event: ResponseEvent
) => ResponseEvent['response'];

function event(uri: string, headers: Record<string, { value: string }> = {}): ResponseEvent {
  return { request: { uri }, response: { headers } };
}

describe('CloudFront app-route noindex', () => {
  test.each(NOINDEX_APP_ROUTES)('adds X-Robots-Tag to %s', (route) => {
    expect(run(event(route)).headers['x-robots-tag']).toEqual({ value: 'noindex, nofollow' });
  });

  test('matches nested paths and keeps the original response headers', () => {
    const response = run(event('/journeys/123', { 'content-type': { value: 'text/html' } }));

    expect(response.headers['x-robots-tag']).toEqual({ value: 'noindex, nofollow' });
    expect(response.headers['content-type']).toEqual({ value: 'text/html' });
  });

  test('leaves the landing page and other paths indexable', () => {
    expect(run(event('/')).headers['x-robots-tag']).toBeUndefined();
    expect(run(event('/journeysomething')).headers['x-robots-tag']).toBeUndefined();
    expect(run(event('/sitemap.xml')).headers['x-robots-tag']).toBeUndefined();
  });
});
