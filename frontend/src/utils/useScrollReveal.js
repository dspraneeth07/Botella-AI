// useScrollReveal.js
// -----------------------------------------------------------------------------
// Smooth "fade + rise into view" scroll reveal for the SEO + blog pages
// (the landing page already has its own `.lp-animate` reveal). Called from
// ContentLayout, so it covers every page rendered through it.
//
// It tags a curated set of below-the-fold content blocks with `.cp-reveal`
// (opacity 0 + translateY, see ContentLayout.css), then an IntersectionObserver
// adds `.is-revealed` as each scrolls into view. Direct siblings that both
// reveal (e.g. cards in a grid) get a small staggered delay. Honors
// prefers-reduced-motion (everything shows immediately, no animation).
// -----------------------------------------------------------------------------

import { useEffect } from 'react';

const SELECTOR = [
  '.cp-section-v2',
  '.cp-pull',
  '.cp-final-cta',
  '.blog-featured',
  '.blog-grid > .blog-card',
  '.blog-post-figure',
  '.blog-faqs',
  '.blog-cta',
  '.blog-related',
].join(', ');

export default function useScrollReveal(dep) {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;

    const els = Array.from(document.querySelectorAll(SELECTOR));
    if (!els.length) return undefined;

    els.forEach((el) => el.classList.add('cp-reveal'));

    // light stagger for sibling blocks that both reveal (e.g. a card grid)
    els.forEach((el) => {
      const parent = el.parentElement;
      if (!parent) return;
      const sibs = Array.from(parent.children).filter((c) => c.classList.contains('cp-reveal'));
      const idx = sibs.indexOf(el);
      if (idx > 0) el.style.transitionDelay = `${Math.min(idx * 0.07, 0.42)}s`;
    });

    const io = new IntersectionObserver(
      (entries, obs) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('is-revealed');
            obs.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -60px 0px' }
    );

    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [dep]);
}
