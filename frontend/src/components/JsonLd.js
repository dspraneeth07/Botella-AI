// JsonLd.js
// -----------------------------------------------------------------------------
// Renders a <script type="application/ld+json"> tag containing the supplied
// schema.org structured data. React strips <script> tags from JSX by default,
// so this component uses dangerouslySetInnerHTML - safe here because the
// data is always passed in as a JS object we control (never user input).
//
// Usage:
//
//   <JsonLd data={{
//     "@context": "https://schema.org",
//     "@type": "FAQPage",
//     "mainEntity": [
//       { "@type": "Question", "name": "...", "acceptedAnswer": { ... } }
//     ]
//   }} />
//
// The script is injected via React's render, so it lives inside the SEO
// page component and disappears when the user navigates away. That's
// exactly what we want - FAQPage schema should only exist on pages that
// actually contain those FAQs.
// -----------------------------------------------------------------------------

import React from 'react';

function JsonLd({ data }) {
  if (!data) return null;
  // JSON.stringify with 0-indent so the rendered HTML is compact.
  const json = JSON.stringify(data);
  return (
    <script
      type="application/ld+json"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: json }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience builders - every SEO page constructs its FAQ schema the same way,
// so we centralise the boilerplate here. Pass an array of { q, a } objects.
// ─────────────────────────────────────────────────────────────────────────────

export function buildFaqSchema(faqs) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(({ q, a }) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: {
        '@type': 'Answer',
        text: a,
      },
    })),
  };
}

// Breadcrumb builder - generic helper so each page can publish its own
// breadcrumb without retyping the @context boilerplate.
export function buildBreadcrumbSchema(crumbs) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.name,
      item: c.url,
    })),
  };
}

export default JsonLd;
