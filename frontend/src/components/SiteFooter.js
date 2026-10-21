// SiteFooter.js
// -----------------------------------------------------------------------------
// Mega footer - the sitemap of the public site. Signals depth: Platform,
// Solutions by Need, Verticals, Company (including the parent research lab),
// Insights, then a legal bar and a closing mission line.
//
// Shared by every public page via LandingPage / ContentLayout.
// -----------------------------------------------------------------------------

import React from 'react';
import { Link } from 'react-router-dom';
import Wordmark from './Wordmark';

const COLUMNS = [
  {
    h: 'Platform',
    links: [
      { t: 'Overview', to: '/platform' },
      { t: 'AI Agent for Liquor Stores', to: '/ai-agent-for-liquor-stores' },
      { t: 'See Botella in action', to: '/contact' },
      { t: 'Customer login', to: '/login' },
    ],
  },
  {
    h: 'Solutions by Need',
    links: [
      { t: 'Inventory Intelligence', to: '/ai-inventory-management-liquor-stores' },
      { t: 'Demand Signal', to: '/liquor-store-sales-analytics-insights' },
      { t: 'Customer Engagement', to: '/customer-insights-liquor-stores' },
      { t: 'Margin Command', to: '/margin-optimization-liquor-stores' },
      { t: 'AI Recommendations', to: '/ai-product-recommendations-liquor-stores' },
    ],
  },
  {
    h: 'Verticals',
    links: [
      { t: 'Liquor & Beverage Retail', to: '/ai-agent-for-liquor-stores' },
      { t: 'Multi-Store Retailers', to: '/ai-for-liquor-retailers' },
    ],
  },
  {
    h: 'Company',
    links: [
      { t: 'Our Story', to: '/company' },
      { t: 'Board of Advisors', to: '/advisors' },
      { t: 'Botella AI Labs', href: 'https://botellalabs.ai' },
      { t: 'Contact', to: '/contact' },
      { t: 'info@botella.ai', href: 'mailto:info@botella.ai' },
    ],
  },
  {
    h: 'Insights',
    links: [
      { t: 'All articles', to: '/blog' },
      { t: 'Inventory', to: '/blog/ai-inventory-management-for-liquor-stores' },
      { t: 'Sales analytics', to: '/blog/how-liquor-stores-use-sales-analytics' },
      { t: 'Margins', to: '/blog/how-liquor-stores-increase-margins-without-raising-prices' },
      { t: 'Sitemap', href: '/sitemap.xml' },
    ],
  },
];

const SOCIALS = [
  {
    label: 'LinkedIn',
    href: 'https://www.linkedin.com/company/botellaai/',
    d: 'M19 0h-14C2.24 0 0 2.24 0 5v14c0 2.76 2.24 5 5 5h14c2.76 0 5-2.24 5-5V5c0-2.76-2.24-5-5-5zM7 19H4V9h3v10zM5.5 7.7c-.97 0-1.75-.79-1.75-1.76S4.53 4.2 5.5 4.2s1.75.78 1.75 1.74S6.47 7.7 5.5 7.7zM20 19h-3v-5.6c0-1.34-.5-2.1-1.55-2.1-1.13 0-1.95.77-1.95 2.1V19h-3V9h2.9v1.36c.7-1.13 1.94-1.5 3.05-1.5 2.39 0 3.55 1.58 3.55 4.36V19z',
  },
  {
    label: 'Instagram',
    href: 'https://www.instagram.com/botella_ai/',
    d: 'M12 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.81.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.42.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.81-.41 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.42.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.81-.25-2.23-.41-.56-.22-.96-.48-1.38-.9-.42-.42-.68-.82-.9-1.38-.16-.42-.36-1.06-.41-2.23C2.17 15.58 2.16 15.2 2.16 12s.01-3.58.07-4.85c.05-1.17.25-1.81.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.16 1.06-.36 2.23-.41C8.42 2.17 8.8 2.16 12 2.16zm0-2.16C8.74 0 8.33.01 7.05.07 5.78.13 4.9.33 4.14.63c-.79.31-1.46.72-2.13 1.38C1.35 2.68.94 3.35.63 4.14.33 4.9.13 5.78.07 7.05.01 8.33 0 8.74 0 12s.01 3.67.07 4.95c.06 1.27.26 2.15.56 2.91.31.79.72 1.46 1.38 2.13.66.66 1.34 1.07 2.13 1.38.76.3 1.64.5 2.91.56C8.33 23.99 8.74 24 12 24s3.67-.01 4.95-.07c1.27-.06 2.15-.26 2.91-.56.79-.31 1.46-.72 2.13-1.38.66-.66 1.07-1.34 1.38-2.13.3-.76.5-1.64.56-2.91.06-1.28.07-1.69.07-4.95s-.01-3.67-.07-4.95c-.06-1.27-.26-2.15-.56-2.91-.31-.79-.72-1.46-1.38-2.13C21.32 1.35 20.65.94 19.86.63 19.1.33 18.22.13 16.95.07 15.67.01 15.26 0 12 0zm0 5.84A6.16 6.16 0 1 0 12 18.16 6.16 6.16 0 0 0 12 5.84zm0 10.16A4 4 0 1 1 12 8a4 4 0 0 1 0 8zm6.41-11.85a1.44 1.44 0 1 0 0 2.88 1.44 1.44 0 0 0 0-2.88z',
  },
  {
    label: 'Facebook',
    href: 'https://www.facebook.com/profile.php?id=61589625410754',
    d: 'M24 12c0-6.63-5.37-12-12-12S0 5.37 0 12c0 5.99 4.39 10.95 10.13 11.85V15.47H7.08V12h3.05V9.36c0-3.01 1.79-4.67 4.53-4.67 1.31 0 2.69.23 2.69.23v2.96h-1.51c-1.49 0-1.96.93-1.96 1.88V12h3.33l-.53 3.47h-2.8v8.38C19.61 22.95 24 17.99 24 12z',
  },
  {
    label: 'YouTube',
    href: 'https://youtube.com/@botellaai?si=lbBlGhP7NW-cmA_W',
    d: 'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z',
  },
];

function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="sf">
      {/* Mission line - bigger than the product. */}
      <div className="sf-mission">
        <div className="sf-mission-inner">
          <p>
            Putting frontier AI behind <em>every counter</em>.
          </p>
        </div>
      </div>

      <div className="sf-inner">
        <div className="sf-brand">
          <Link to="/" className="sf-wordmark" aria-label="botella.ai home">
            <Wordmark size="footer" />
          </Link>
          <p className="sf-tagline">
            The Retail AI platform. One AI operating system that automates
            inventory, surfaces demand, engages customers and protects margin.
          </p>
          <p className="sf-parent">
            A product of{' '}
            <a href="https://botellalabs.ai" target="_blank" rel="noopener noreferrer">
              Botella AI Labs
            </a>{' '}
            - frontier AI research, agentic systems and datasets.
          </p>
          <div className="sf-socials">
            {SOCIALS.map((s) => (
              <a key={s.label} href={s.href} target="_blank" rel="noopener noreferrer" aria-label={s.label}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d={s.d} />
                </svg>
              </a>
            ))}
          </div>
        </div>

        <div className="sf-cols">
          {COLUMNS.map((col) => (
            <div className="sf-col" key={col.h}>
              <h4>{col.h}</h4>
              {col.links.map((l) =>
                l.to ? (
                  <Link key={l.t} to={l.to}>{l.t}</Link>
                ) : (
                  <a
                    key={l.t}
                    href={l.href}
                    target={l.href.startsWith('mailto:') ? undefined : '_blank'}
                    rel="noopener noreferrer"
                  >
                    {l.t}
                  </a>
                )
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="sf-bottom">
        <div className="sf-bottom-inner">
          <span className="sf-copy">© {year} Botella AI. All rights reserved.</span>
          <div className="sf-legal">
            <Link to="/privacy-policy">Privacy Policy</Link>
            <span className="sf-sep">·</span>
            <Link to="/terms-and-conditions">Terms and Conditions</Link>
            <span className="sf-sep">·</span>
            <Link to="/contact">Contact</Link>
          </div>
          <span className="sf-built">Retail AI, built in the aisle</span>
        </div>
      </div>
    </footer>
  );
}

export default SiteFooter;
