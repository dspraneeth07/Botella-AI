// ContentLayout.js
// -----------------------------------------------------------------------------
// Shared shell for every SEO content / landing page that isn't the main home
// page. Uses the same SiteHeader + SiteFooter that the home page does, so
// the entire public site has a unified chrome. The page-specific content is
// rendered inside <main className="cp">.
// -----------------------------------------------------------------------------

import React, { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import SiteHeader from './SiteHeader';
import SiteFooter from './SiteFooter';
import BackToTop from './BackToTop';
import CustomCursor from './CustomCursor';
import useScrollReveal from '../utils/useScrollReveal';
import './SiteHeader.css';
import './SiteFooter.css';
import '../pages/LandingPage.css';
import './ContentLayout.css';
import './PageEffects.css';
import '../styles/brand.css';
import '../styles/legacy-skin.css';

function ContentLayout({ children }) {
  const location = useLocation();

  // Scroll to top whenever the user navigates between SEO pages.
  // Without this, react-router preserves scroll position from the
  // previous page and visitors land halfway down the new article.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [location.pathname]);

  // Smooth fade + rise reveal for content blocks as they scroll into view.
  useScrollReveal(location.pathname);

  return (
    <div className="lp">
      {/* Keyboard / screen-reader bypass - first focusable element on
          the page. Tab → Enter jumps past the nav straight into <main>. */}
      <a href="#main-content" className="skip-link">Skip to main content</a>

      <SiteHeader />

      {/* Content - id="main-content" is the skip-link target */}
      <main className="cp" id="main-content" tabIndex={-1}>{children}</main>

      <SiteFooter />
      <BackToTop />
      <CustomCursor />
    </div>
  );
}

export default ContentLayout;
