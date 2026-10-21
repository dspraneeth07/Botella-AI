// usePageView.js
// -----------------------------------------------------------------------------
// Fires a synthetic pageview on every React Router route change so that
// Google Analytics 4 (gtag) and Google Tag Manager (dataLayer) both pick
// up SPA navigations.
//
// Without this hook, GA4 + GTM only fire ONE pageview - the initial page
// load. Every subsequent client-side route change (clicking a <Link>) is
// invisible to analytics, which makes funnel + landing-page reports look
// drastically wrong.
//
// Usage - mount this once inside <BrowserRouter>:
//
//   function PageViewTracker() {
//     usePageView();
//     return null;
//   }
//
//   <BrowserRouter>
//     <App>
//       <PageViewTracker />
//       <Routes>...</Routes>
//     </App>
//   </BrowserRouter>
// -----------------------------------------------------------------------------

import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

export default function usePageView() {
  const location = useLocation();

  // Skip the very first call - `gtag('config', ...)` and the initial GTM
  // script in index.html already record the first pageview. Without this
  // guard, the first page is counted twice.
  const isFirstRenderRef = useRef(true);

  useEffect(() => {
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      return;
    }

    const path = location.pathname + location.search;
    // Give the page a tick to update document.title (the useSEO hook
    // updates it on the same render) before firing the pageview.
    const timer = setTimeout(() => {
      const pageTitle = document.title;
      const pageLocation = window.location.href;

      // ── Google Analytics 4 (gtag.js) ────────────────────────────────
      // Use `config` with `page_path` - the recommended SPA pattern.
      if (typeof window.gtag === 'function') {
        try {
          // Re-config GA4 with the new page (also fires a page_view event).
          window.gtag('config', 'G-R69CLRQEKW', {
            page_path: path,
            page_location: pageLocation,
            page_title: pageTitle,
          });
        } catch (e) {
          // Swallow - analytics failures must never affect the page.
        }
      }

      // ── Google Tag Manager (dataLayer) ──────────────────────────────
      // Push a virtual pageview event so any GTM tag listening for
      // `event: 'pageview'` picks up the SPA navigation.
      if (typeof window.dataLayer !== 'undefined') {
        try {
          window.dataLayer.push({
            event: 'pageview',
            page: path,
            page_path: path,
            page_location: pageLocation,
            page_title: pageTitle,
          });
        } catch (e) {
          // Swallow analytics errors.
        }
      }

      // ── Microsoft Clarity ───────────────────────────────────────────
      // Clarity auto-detects SPA route changes via its own routing
      // observer, but calling `clarity('event', 'route-change')` is a
      // belt-and-braces signal that's harmless when not present.
      if (typeof window.clarity === 'function') {
        try {
          window.clarity('event', 'route-change');
        } catch (e) {
          // Swallow.
        }
      }
    }, 0);

    return () => clearTimeout(timer);
  }, [location.pathname, location.search]);
}
