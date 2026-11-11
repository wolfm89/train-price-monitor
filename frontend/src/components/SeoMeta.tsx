import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { pageMeta } from '../utils/seo';

function ensureMetaTag(name: string): HTMLMetaElement {
  let tag = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!tag) {
    tag = document.createElement('meta');
    tag.name = name;
    document.head.appendChild(tag);
  }
  return tag;
}

function ensureCanonicalLink(): HTMLLinkElement {
  let link = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'canonical';
    document.head.appendChild(link);
  }
  return link;
}

/**
 * Keeps title, robots and canonical in sync with client-side navigation.
 *
 * index.html already carries the correct tags for the landing page; the app
 * routes (search, journeys, profile, password reset) are private utility pages
 * and must not be indexed, so they get noindex once mounted. Crawlers that do
 * not execute JavaScript only ever see the landing page's indexable metadata.
 */
export default function SeoMeta() {
  const { pathname } = useLocation();

  useEffect(() => {
    const meta = pageMeta(pathname);
    document.title = meta.title;
    ensureMetaTag('robots').content = meta.noindex ? 'noindex, nofollow' : 'index, follow, max-image-preview:large';
    ensureCanonicalLink().href = meta.canonical;
  }, [pathname]);

  return null;
}
