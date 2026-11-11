/**
 * CloudFront viewer-request function that sends requests for any host other
 * than the custom domain (in practice the distribution's `*.cloudfront.net`
 * name) to the custom domain with a permanent redirect.
 *
 * Keeping a single host avoids duplicate content between the CloudFront domain
 * and `tpm.wolfgangmoser.eu` and is attached to every cache behavior.
 */
export function redirectToCustomDomainCode(domainName: string): string {
  const canonicalHost = JSON.stringify(domainName);
  return `
function handler(event) {
  var request = event.request;
  var host = request.headers.host ? request.headers.host.value.toLowerCase() : '';
  if (host === ${canonicalHost}) {
    return request;
  }
  var query = request.querystring ? '?' + request.querystring : '';
  return {
    statusCode: 301,
    statusDescription: 'Moved Permanently',
    headers: {
      location: { value: 'https://' + ${canonicalHost} + request.uri + query }
    }
  };
}
`;
}
