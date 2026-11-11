/**
 * CloudFront viewer-request function for the site.
 *
 * Two jobs:
 * 1. Send requests for any host other than the custom domain (in practice the
 *    distribution's `*.cloudfront.net` name) to the custom domain with a
 *    permanent redirect, preserving the path and the raw query string.
 * 2. Route the known SPA pages to `/index.html` before the origin lookup. The
 *    S3 origin would otherwise return 403/404 and CloudFront's error fallback
 *    would serve the landing page; viewer-response functions do not run for
 *    origin errors, so the noindex header would be lost. The original URI is
 *    kept in a request header for the viewer-response function.
 *
 * Unknown paths are intentionally not rewritten. They fall through to the
 * origin so CloudFront can return the real 404 page instead of a soft 200.
 */
const APP_ROUTES = ['/search', '/journeys', '/profile', '/forgot-password', '/reset-password'];

export function viewerRequestCode(domainName: string): string {
  const canonicalHost = JSON.stringify(domainName);
  const appRoutes = JSON.stringify(APP_ROUTES);
  return `
function handler(event) {
  var request = event.request;
  var host = request.headers.host ? request.headers.host.value.toLowerCase() : '';
  // rawQueryString() returns the query exactly as CloudFront received it
  // (without the leading "?"), so already-encoded values are not re-encoded.
  var query = request.rawQueryString();
  var suffix = query === undefined ? '' : '?' + query;

  if (host !== ${canonicalHost}) {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: {
        location: { value: 'https://' + ${canonicalHost} + request.uri + suffix }
      }
    };
  }

  // Keep /index.html from competing with the canonical landing page.
  if (request.uri === '/index.html') {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: { location: { value: 'https://' + ${canonicalHost} + '/' + suffix } }
    };
  }

  var uri = request.uri;
  var normalized = uri.length > 1 && uri.charAt(uri.length - 1) === '/' ? uri.slice(0, -1) : uri;
  if (${appRoutes}.indexOf(normalized) !== -1) {
    request.headers['x-tpm-original-uri'] = { value: uri };
    request.uri = '/index.html';
  }
  return request;
}
`;
}
