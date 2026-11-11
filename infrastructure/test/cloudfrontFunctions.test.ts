import { viewerRequestCode } from '../lib/cloudfront/viewer-request';
import { noindexSpaRoutesCode } from '../lib/cloudfront/viewer-response';

interface ViewerRequest {
  method: string;
  headers: Record<string, { value: string }>;
  uri: string;
  rawQueryString: () => string | undefined;
}

interface ViewerRequestEvent {
  request: ViewerRequest;
}

interface RedirectResponse {
  statusCode: number;
  statusDescription: string;
  headers: { location: { value: string } };
}

type ViewerRequestResult = ViewerRequest | RedirectResponse;

function request(host: string, uri = '/', rawQueryString: string | undefined = undefined): ViewerRequestEvent {
  return {
    request: {
      method: 'GET',
      headers: { host: { value: host } },
      uri,
      rawQueryString: () => rawQueryString,
    },
  };
}

const runViewerRequest = new Function(
  'event',
  `${viewerRequestCode('tpm.wolfgangmoser.eu')}\nreturn handler(event);`
) as (event: ViewerRequestEvent) => ViewerRequestResult;

describe('CloudFront viewer request', () => {
  test('passes requests for the custom domain through unchanged', () => {
    const event = request('tpm.wolfgangmoser.eu', '/');

    expect(runViewerRequest(event)).toBe(event.request);
    expect(event.request.headers['x-tpm-original-uri']).toBeUndefined();
  });

  test('301s the CloudFront domain to the custom domain without a query string', () => {
    expect(runViewerRequest(request('d18p9lp3h4c6yx.cloudfront.net', '/journeys'))).toEqual({
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: { location: { value: 'https://tpm.wolfgangmoser.eu/journeys' } },
    });
  });

  test('preserves an already-encoded query string exactly, without double encoding', () => {
    expect(
      runViewerRequest(request('d18p9lp3h4c6yx.cloudfront.net', '/search', 'from=M%C3%BCnchen%20Hbf&to=Berlin%20Hbf'))
    ).toEqual({
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: {
        location: {
          value: 'https://tpm.wolfgangmoser.eu/search?from=M%C3%BCnchen%20Hbf&to=Berlin%20Hbf',
        },
      },
    });
  });

  test('preserves repeated query parameters', () => {
    expect(runViewerRequest(request('d18p9lp3h4c6yx.cloudfront.net', '/search', 'tag=a&tag=b'))).toEqual({
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: { location: { value: 'https://tpm.wolfgangmoser.eu/search?tag=a&tag=b' } },
    });
  });

  test('keeps a bare question mark and redirects an uppercase host', () => {
    expect(runViewerRequest(request('D18P9LP3H4C6YX.CLOUDFRONT.NET', '/', ''))).toEqual({
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: { location: { value: 'https://tpm.wolfgangmoser.eu/?' } },
    });
  });

  test('rewrites an extensionless SPA route and records the original URI', () => {
    const event = request('tpm.wolfgangmoser.eu', '/journeys');

    expect(runViewerRequest(event)).toBe(event.request);
    expect(event.request.uri).toBe('/index.html');
    expect(event.request.headers['x-tpm-original-uri']).toEqual({ value: '/journeys' });
  });

  test('rewrites nested SPA routes but leaves files and assets alone', () => {
    const nested = request('tpm.wolfgangmoser.eu', '/journeys/123');
    runViewerRequest(nested);
    expect(nested.request.uri).toBe('/index.html');

    for (const uri of ['/sitemap.xml', '/robots.txt', '/logo-hero.webp', '/assets/index-abc.js']) {
      const event = request('tpm.wolfgangmoser.eu', uri);
      runViewerRequest(event);
      expect(event.request.uri).toBe(uri);
      expect(event.request.headers['x-tpm-original-uri']).toBeUndefined();
    }
  });
});

interface ViewerResponseEvent {
  request: { headers: Record<string, { value: string }> };
  response: { headers: Record<string, { value: string }>; statusCode?: number };
}

const runViewerResponse = new Function('event', `${noindexSpaRoutesCode()}\nreturn handler(event);`) as (
  event: ViewerResponseEvent
) => ViewerResponseEvent['response'];

function responseEvent(originalUri?: string): ViewerResponseEvent {
  return {
    request: { headers: originalUri ? { 'x-tpm-original-uri': { value: originalUri } } : {} },
    response: { headers: { 'content-type': { value: 'text/html' } } },
  };
}

describe('CloudFront viewer response', () => {
  test('adds X-Robots-Tag to a rewritten SPA route without dropping existing headers', () => {
    const response = runViewerResponse(responseEvent('/journeys'));

    expect(response.headers['x-robots-tag']).toEqual({ value: 'noindex, nofollow' });
    expect(response.headers['content-type']).toEqual({ value: 'text/html' });
  });

  test('leaves the landing page and static files indexable', () => {
    expect(runViewerResponse(responseEvent()).headers['x-robots-tag']).toBeUndefined();
  });
});
