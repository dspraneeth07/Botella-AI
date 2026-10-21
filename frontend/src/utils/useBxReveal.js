// useBxReveal.js
// -----------------------------------------------------------------------------
// Scroll-reveal for the brand system. Every element carrying `.bx-reveal` gets
// `.is-in` added the first time it enters the viewport, which fires the single
// rise-and-fade transition defined in styles/brand.css.
//
// Deliberately one-shot: elements are unobserved once revealed, so scrolling
// back up never replays the animation (that reads as a gimmick, not a system).
//
// Respects prefers-reduced-motion by revealing everything immediately - the
// CSS already neutralises the transform, this just avoids the observer work.
// -----------------------------------------------------------------------------

import { useEffect } from 'react';

export default function useBxReveal(deps = []) {
  useEffect(() => {
    const nodes = Array.from(document.querySelectorAll('.bx-reveal:not(.is-in)'));
    if (!nodes.length) return undefined;

    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduced || typeof IntersectionObserver === 'undefined') {
      nodes.forEach((n) => n.classList.add('is-in'));
      return undefined;
    }

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
    );

    nodes.forEach((n) => io.observe(n));
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
