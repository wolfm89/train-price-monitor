/**
 * CloudFront viewer-response function that adds `X-Robots-Tag: noindex` to the
 * SPA routes rewritten by the viewer-request function. The request header is
 * set there, so this function only has to check for its presence.
 *
 * The SPA also sets a robots meta tag once it mounts; the response header
 * covers crawlers that do not execute JavaScript.
 */
export function noindexSpaRoutesCode(): string {
  return `
function handler(event) {
  var response = event.response;
  if (event.request.headers['x-tpm-original-uri']) {
    response.headers['x-robots-tag'] = { value: 'noindex, nofollow' };
  }
  return response;
}
`;
}
