/** App routes that must never appear in search results. */
export const NOINDEX_APP_ROUTES = ['/search', '/journeys', '/profile', '/forgot-password', '/reset-password'];

/**
 * CloudFront viewer-response function that adds `X-Robots-Tag: noindex` to the
 * private app routes. The SPA also sets a robots meta tag once it mounts, but
 * the response header covers crawlers that do not execute JavaScript and is
 * independent of the client-side redirect for signed-out visitors.
 */
export function noindexAppRoutesCode(): string {
  return `
function handler(event) {
  var response = event.response;
  var uri = event.request.uri;
  var routes = ${JSON.stringify(NOINDEX_APP_ROUTES)};
  for (var i = 0; i < routes.length; i++) {
    if (uri === routes[i] || uri.indexOf(routes[i] + '/') === 0) {
      response.headers['x-robots-tag'] = { value: 'noindex, nofollow' };
      break;
    }
  }
  return response;
}
`;
}
