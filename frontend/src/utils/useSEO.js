// useSEO.js
// -----------------------------------------------------------------------------
// Lightweight per-route SEO hook. We don't pull in react-helmet because the
// site is a small CRA app and the only things we need to swap on navigation
// are <title>, <meta name="description">, and <link rel="canonical">.
//
// Usage:
//   useSEO({
//     title: 'Best AI Agent for Liquor Stores | Botella AI',
//     description: 'Botella AI is an AI agent for liquor stores...',
//     canonical: 'https://botella.ai/ai-agent-for-liquor-stores',
//   });
// -----------------------------------------------------------------------------

import { useEffect } from 'react';

function upsertMeta(name, content) {
  if (!content) return;
  let tag = document.querySelector(`meta[name="${name}"]`);
  if (!tag) {
    tag = document.createElement('meta');
    tag.setAttribute('name', name);
    document.head.appendChild(tag);
  }
  tag.setAttribute('content', content);
}

function upsertProperty(property, content) {
  if (!content) return;
  let tag = document.querySelector(`meta[property="${property}"]`);
  if (!tag) {
    tag = document.createElement('meta');
    tag.setAttribute('property', property);
    document.head.appendChild(tag);
  }
  tag.setAttribute('content', content);
}

function upsertCanonical(href) {
  if (!href) return;
  let tag = document.querySelector('link[rel="canonical"]');
  if (!tag) {
    tag = document.createElement('link');
    tag.setAttribute('rel', 'canonical');
    document.head.appendChild(tag);
  }
  tag.setAttribute('href', href);
}

// Default Open Graph image used on every page that doesn't pass a custom
// `image` prop. 1200x630 PNG generated from public/_build_og_image.py.
const DEFAULT_OG_IMAGE = 'https://botella.ai/og-image.png';

export default function useSEO({ title, description, canonical, image, noindex }) {
  useEffect(() => {
    if (title) document.title = title;
    if (description) upsertMeta('description', description);
    if (canonical) upsertCanonical(canonical);

    // Open Graph + Twitter - same title/desc, helps social sharing previews
    if (title) {
      upsertProperty('og:title', title);
      upsertMeta('twitter:title', title);
    }
    if (description) {
      upsertProperty('og:description', description);
      upsertMeta('twitter:description', description);
    }
    if (canonical) upsertProperty('og:url', canonical);
    // Always set an OG image - use the per-page override if provided,
    // otherwise fall back to the brand default.
    const ogImage = image || DEFAULT_OG_IMAGE;
    upsertProperty('og:image', ogImage);
    upsertProperty('og:image:width', '1200');
    upsertProperty('og:image:height', '630');
    upsertMeta('twitter:image', ogImage);
    upsertProperty('og:type', 'website');
    upsertMeta('twitter:card', 'summary_large_image');

    // Robots - 404 / error / login pages should pass noindex so search
    // engines don't list them. Real content pages omit this and inherit
    // the site-wide default (indexable).
    if (noindex) {
      upsertMeta('robots', 'noindex, nofollow');
    } else {
      // Reset to indexable when navigating from a noindex page to a real
      // one - otherwise the noindex meta tag would persist.
      const existing = document.querySelector('meta[name="robots"]');
      if (existing) existing.setAttribute('content', 'index, follow');
    }
  }, [title, description, canonical, image, noindex]);
}
