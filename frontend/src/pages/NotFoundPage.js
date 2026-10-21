// NotFoundPage.js
// -----------------------------------------------------------------------------
// Catch-all route - rendered when no other <Route> matches the URL. Uses the
// same SiteHeader + SiteFooter as every other public page so users stay
// oriented and can navigate out via the nav, footer, or the suggested links
// below. Passes noindex:true to useSEO so Google won't list 404s in results.
// -----------------------------------------------------------------------------

import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import ContentLayout from '../components/ContentLayout';
import { useDemoPopup } from '../components/DemoPopupContext';
import useSEO from '../utils/useSEO';
import './NotFoundPage.css';

function NotFoundPage() {
  const location = useLocation();
  const { openDemoPopup } = useDemoPopup();

  useSEO({
    title: 'Page Not Found | Botella AI',
    description:
      "The page you're looking for doesn't exist. Browse our AI agent, features, or solutions for liquor stores.",
    noindex: true, // do not index 404s in search engines
  });

  // The 6 most useful destinations to suggest. Ordered by what visitors
  // who land on a broken URL are most likely actually looking for.
  const suggestions = [
    { to: '/',                                              em: '🏠', t: 'Home',                        d: 'Botella AI - overview + book a demo' },
    { to: '/ai-agent-for-liquor-stores',                    em: '🤖', t: 'AI Agent for Liquor Stores',  d: 'The flagship product page' },
    { to: '/ai-for-liquor-retailers',                       em: '🏪', t: 'For Retailers',               d: 'Independent + multi-location stores' },
    { to: '/ai-inventory-management-liquor-stores',         em: '📦', t: 'AI Inventory Management',    d: 'Real-time stock + dead stock detection' },
    { to: '/liquor-store-sales-analytics-insights',         em: '📊', t: 'Sales Analytics',            d: 'Top products + peak hour analysis' },
  ];

  return (
    <ContentLayout>
      <div className="nfp">
        {/* Large gradient "404" - uses the brand gradient (same colours
            as the wordmark) so the page feels like part of Botella, not
            a generic browser error. */}
        <div className="nfp-code" aria-hidden="true">404</div>

        <h1 className="nfp-title">Page not found</h1>

        <p className="nfp-msg">
          We can't find <code className="nfp-path">{location.pathname}</code>.
          It may have moved, been renamed, or never existed. Try one of these
          instead:
        </p>

        <div className="nfp-actions">
          <Link to="/" className="nfp-btn nfp-btn-primary">
            ← Back to Home
          </Link>
          <button
            type="button"
            className="nfp-btn nfp-btn-secondary"
            onClick={openDemoPopup}
          >
            Book a Demo
          </button>
        </div>

        <div className="nfp-suggestions">
          <h2 className="nfp-suggestions-label">Popular destinations</h2>
          <div className="nfp-grid">
            {suggestions.map((s) => (
              <Link to={s.to} key={s.to} className="nfp-card">
                <span className="nfp-card-em" aria-hidden="true">{s.em}</span>
                <span className="nfp-card-body">
                  <strong>{s.t}</strong>
                  <em>{s.d}</em>
                </span>
                <span className="nfp-card-arrow" aria-hidden="true">→</span>
              </Link>
            ))}
          </div>
        </div>

        <p className="nfp-help">
          Still stuck? <a href="mailto:info@botella.ai">Email us at info@botella.ai</a>
          {' '}and we'll point you in the right direction.
        </p>
      </div>
    </ContentLayout>
  );
}

export default NotFoundPage;
