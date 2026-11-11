/** Canonical origin of the public site, used for canonical and Open Graph URLs. */
export const SITE_URL = 'https://tpm.wolfgangmoser.eu';

export const DEFAULT_TITLE = 'Train Price Monitor – Deutsche Bahn price alerts';

const ROUTE_TITLES: Record<string, string> = {
  '/search': 'Search journeys – Train Price Monitor',
  '/journeys': 'Your journeys – Train Price Monitor',
  '/profile': 'Your profile – Train Price Monitor',
  '/forgot-password': 'Reset your password – Train Price Monitor',
  '/reset-password': 'Choose a new password – Train Price Monitor',
};

export interface PageMeta {
  title: string;
  /** Only the public landing page is meant to appear in search results. */
  noindex: boolean;
  canonical: string;
}

function normalizePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

export function pageMeta(pathname: string): PageMeta {
  const path = normalizePath(pathname);
  const isLandingPage = path === '/';
  return {
    title: ROUTE_TITLES[path] ?? DEFAULT_TITLE,
    noindex: !isLandingPage,
    canonical: `${SITE_URL}${isLandingPage ? '/' : path}`,
  };
}
