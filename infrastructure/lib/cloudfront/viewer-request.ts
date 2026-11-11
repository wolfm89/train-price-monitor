/**
 * CloudFront viewer-request function for the site.
 *
 * Two jobs:
 * 1. Send requests for any host other than the custom domain (in practice the
 *    distribution's `*.cloudfront.net` name) to the custom domain with a
 *    permanent redirect, preserving the path and query string.
 * 2. Rewrite extensionless SPA routes to `/index.html` before the origin lookup.
 *    The S3 origin would otherwise return 403/404 and CloudFront's error
 *    fallback would serve index.html; viewer-response functions do not run for
 *    origin errors, so the noindex header would be lost. The original URI is
 *    kept in a request header for the viewer-response function.
 */
export function viewerRequestCode(domainName: string): string {
  const canonicalHost = JSON.stringify(domainName);
  return `
function serializeQuery(querystring) {
  var parts = [];
  var keys = Object.keys(querystring);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var parameter = querystring[key];
    var values = parameter.multiValue || [{ value: parameter.value }];
    for (var j = 0; j < values.length; j++) {
      var value = values[j].value;
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value === undefined ? '' : value));
    }
  }
  return parts.length > 0 ? '?' + parts.join('&') : '';
}

function handler(event) {
  var request = event.request;
  var host = request.headers.host ? request.headers.host.value.toLowerCase() : '';
  if (host !== ${canonicalHost}) {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: {
        location: { value: 'https://' + ${canonicalHost} + request.uri + serializeQuery(request.querystring) }
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
