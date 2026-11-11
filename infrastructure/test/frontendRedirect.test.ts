import { redirectToCustomDomainCode } from '../lib/cloudfront/redirect-to-custom-domain';

interface CloudFrontRequestEvent {
  request: {
    headers: { host?: { value: string } };
    uri: string;
    querystring: string;
  };
}

interface CloudFrontRedirect {
  statusCode: number;
  statusDescription: string;
  headers: { location: { value: string } };
}

type Result = CloudFrontRequestEvent | CloudFrontRedirect;

const code = redirectToCustomDomainCode('tpm.wolfgangmoser.eu');
const run = new Function('event', `${code}\nreturn handler(event);`) as (event: CloudFrontRequestEvent) => Result;

function event(host: string, uri = '/', querystring = ''): CloudFrontRequestEvent {
  return { request: { headers: { host: { value: host } }, uri, querystring } };
}

describe('CloudFront host redirect', () => {
  test('passes requests for the custom domain through unchanged', () => {
    const request = event('tpm.wolfgangmoser.eu', '/journeys', 'a=1');

    expect(run(request)).toBe(request.request);
  });

  test('301s the CloudFront domain to the custom domain, keeping path and query', () => {
    expect(run(event('d18p9lp3h4c6yx.cloudfront.net', '/journeys', 'a=1&b=2'))).toEqual({
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: { location: { value: 'https://tpm.wolfgangmoser.eu/journeys?a=1&b=2' } },
    });
  });

  test('redirects an uppercase host and omits an empty query string', () => {
    expect(run(event('D18P9LP3H4C6YX.CLOUDFRONT.NET'))).toEqual({
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: { location: { value: 'https://tpm.wolfgangmoser.eu/' } },
    });
  });
});
