/**
 * CloudFront viewer-request function for the site.
 *
 * Two jobs:
 * 1. Send requests for any host other than the custom domain (in practice the
 *    distribution's `*.cloudfront.net` name) to the custom domain with a
 *    permanent redirect, preserving the path and the raw query string.
 * 2. Rewrite extensionless SPA routes to `/index.html` before the origin lookup.
 *    The S3 origin would otherwise return 403/404 and CloudFront's error
 *    fallback would serve index.html; viewer-response functions do not run for
 *    origin errors, so the noindex header would be lost. The original URI is
 *    kept in a request header for the viewer-response function.
 */
export function viewerRequestCode(domainName: string): string {
  const canonicalHost = JSON.stringify(domainName);
  return `
function handler(event) {
  var request = event.request;
  var host = request.headers.host ? request.headers.host.value.toLowerCase() : '';
  if (host !== ${canonicalHost}) {
    // rawQueryString() returns the query exactly as CloudFront received it
    // (without the leading "?"), so already-encoded values are not re-encoded.
    var query = request.rawQueryString();
    var suffix = query === undefined ? '' : '?' + query;
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: {
        location: { value: 'https://' + ${canonicalHost} + request.uri + suffix }
      }
    };
  }

  var uri = request.uri;
  if (uri !== '/' && uri.indexOf('.') === -1 && uri.indexOf('/assets/') !== 0) {
    request.headers['x-tpm-original-uri'] = { value: uri };
    request.uri = '/index.html';
  }
  return request;
}
`;
}
