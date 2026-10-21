// useScrollTop.js
// -----------------------------------------------------------------------------
// Jump to the top of the document whenever the route changes. React Router
// preserves scroll position between routes, which otherwise drops visitors
// halfway down a page they have never seen.
//
// ContentLayout already does this for the SEO pages; the standalone brand
// pages (Platform, Company) use this hook instead.
// -----------------------------------------------------------------------------

import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

export default function useScrollTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [pathname]);
}
