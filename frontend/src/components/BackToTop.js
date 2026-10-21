// BackToTop.js
// -----------------------------------------------------------------------------
// Floating "back to top" button. Fixed to the bottom-right of the viewport,
// hidden near the top of the page and fades in once the user has scrolled
// down ~400px. Clicking it smooth-scrolls back to the top.
//
// Rendered inside the marketing shell (LandingPage + ContentLayout) so it
// appears on the home page and every SEO page, which scroll the window.
// -----------------------------------------------------------------------------

import React, { useState, useEffect } from 'react';
import './BackToTop.css';

function BackToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setVisible((window.scrollY || window.pageYOffset || 0) > 400);
    onScroll(); // sync on mount in case the page is already scrolled
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const toTop = () => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
  };

  return (
    <button
      type="button"
      className={`back-to-top${visible ? ' is-visible' : ''}`}
      onClick={toTop}
      aria-label="Back to top"
      title="Back to top"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 19V5" />
        <path d="M5 12l7-7 7 7" />
      </svg>
    </button>
  );
}

export default BackToTop;
