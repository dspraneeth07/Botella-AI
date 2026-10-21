// SiteHeader.js
// -----------------------------------------------------------------------------
// The single shared top chrome for every public page (home + platform + company
// + all SEO/content pages).
//
// Structure, top to bottom:
//   1. A slim ticker strip - what is live in Retail AI. Status only, no
//      invented news, and no other-product cross-selling.
//   2. The nav bar: wordmark, Platform, Solutions (a two-column mega menu split
//      By Need and By Vertical), Company, Insights, Contact - then a persistent
//      "See Botella in Action" CTA, the theme switch and Login.
//   3. A full-screen mobile menu with the same information architecture.
//
// Login routing and the theme switch behave exactly as before; the signed-in
// app is untouched by this file.
// -----------------------------------------------------------------------------

import React, { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useDemoPopup } from './DemoPopupContext';
import Wordmark from './Wordmark';
import ThemeSwitch from './ThemeSwitch';
import { useTheme } from '../utils/useTheme';

/* ── Menu data ─────────────────────────────────────────────────────────── */

const BY_NEED = [
  { to: '/ai-inventory-management-liquor-stores', t: 'Inventory Intelligence', d: 'Stock visibility, low-stock and dead-stock alerts' },
  { to: '/liquor-store-sales-analytics-insights', t: 'Demand Signal', d: 'Trends, peak hours and category performance' },
  { to: '/customer-insights-liquor-stores', t: 'Customer Engagement', d: 'Purchase behaviour, VIPs and retention' },
  { to: '/margin-optimization-liquor-stores', t: 'Margin Command', d: 'Profit by product, category and hour' },
  { to: '/ai-product-recommendations-liquor-stores', t: 'Recommendations', d: 'What your staff should push today' },
];

const BY_VERTICAL = [
  { to: '/ai-agent-for-liquor-stores', t: 'Liquor & Beverage Retail', d: 'The flagship vertical - in production', live: true },
  { to: '/ai-for-liquor-retailers', t: 'Multi-Store Retailers', d: 'Chains and multi-location operators' },
];

// Contact is NOT here: it already has its own top-level nav item, so listing it
// again inside Company gave the same destination two entries in one bar.
const COMPANY_LINKS = [
  { to: '/company', t: 'Our Story', d: 'Built by Botella AI Labs' },
  { to: '/advisors', t: 'Board of Advisors', d: 'The people guiding Botella' },
];

const TICKER = [
  'Botella - the AI operating system for retail - in production',
  'Liquor & beverage retail: live in stores today',
  'Local-first, privacy-first, energy-efficient AI',
  'Built by Botella AI Labs - frontier AI research and agentic systems',
];

/* Every route that lives under a given menu, so the trigger can light up. */
const NEED_PATHS = BY_NEED.map((i) => i.to);
const VERTICAL_PATHS = BY_VERTICAL.map((i) => i.to);
const SOLUTION_PATHS = [...NEED_PATHS, ...VERTICAL_PATHS];
const COMPANY_PATHS = COMPANY_LINKS.map((i) => i.to);

function SiteHeader() {
  const location = useLocation();
  const { openDemoPopup } = useDemoPopup();

  const { preference: themePreference, resolved: themeResolved, setPreference: setThemePreference } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const [openDd, setOpenDd] = useState(null);
  const [scrolled, setScrolled] = useState(false);
  const [mobileGroups, setMobileGroups] = useState(() => new Set(['solutions']));
  const navRef = useRef(null);

  // useTheme stamps <html data-theme>, persists the preference and follows the
  // OS under 'system'. The marketing site and the signed-in app read the same
  // hook, so they can never disagree about the theme.

  // Condense the bar once the page has scrolled past the hero fold.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Close everything on navigation.
  useEffect(() => {
    setOpenDd(null);
    setMenuOpen(false);
  }, [location.pathname]);

  // Lock body scroll while the mobile sheet is open.
  useEffect(() => {
    document.body.style.overflow = menuOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [menuOpen]);

  // Escape + click-outside close the desktop mega menu.
  useEffect(() => {
    if (!openDd) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpenDd(null); };
    const onOutside = (e) => {
      if (navRef.current && !navRef.current.contains(e.target)) setOpenDd(null);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('touchstart', onOutside, { passive: true });
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('touchstart', onOutside);
    };
  }, [openDd]);

  const toggleDd = (name) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    setOpenDd((c) => (c === name ? null : name));
  };
  const toggleMobileGroup = (group) => {
    setMobileGroups((curr) => {
      const next = new Set(curr);
      if (next.has(group)) next.delete(group); else next.add(group);
      return next;
    });
  };

  const path = location.pathname;
  const isActive = (p) => path === p;
  const inSolutions = SOLUTION_PATHS.includes(path);
  const inCompany = COMPANY_PATHS.includes(path);
  const inInsights = path === '/blog' || path.startsWith('/blog/');

  const demo = (e) => {
    e.preventDefault();
    setMenuOpen(false);
    setOpenDd(null);
    openDemoPopup();
  };

  return (
    <>
      {/* ── Ticker ────────────────────────────────────────────────────── */}
      <div className="sh-ticker" role="complementary" aria-label="Botella AI Labs product status">
        <div className="sh-ticker-inner">
          <span className="sh-ticker-label">
            <span className="sh-ticker-dot" aria-hidden="true" />
            From the Labs
          </span>
          <div className="sh-ticker-viewport">
            <div className="sh-ticker-track">
              {[...TICKER, ...TICKER].map((t, i) => (
                <span className="sh-ticker-item" key={i}>
                  {t}
                  <span className="sh-ticker-sep" aria-hidden="true">/</span>
                </span>
              ))}
            </div>
          </div>
          <a
            className="sh-ticker-link"
            href="https://botellalabs.ai"
            target="_blank"
            rel="noopener noreferrer"
          >
            botellalabs.ai <span aria-hidden="true">↗</span>
          </a>
        </div>
      </div>

      {/* ── Nav bar ───────────────────────────────────────────────────── */}
      <nav className={`sh-nav ${scrolled ? 'is-scrolled' : ''} ${menuOpen ? 'is-menu-open' : ''}`} ref={navRef}>
        <div className="sh-nav-inner">
          <Link to="/" className="sh-wordmark" aria-label="botella.ai home">
            <Wordmark size="nav" />
          </Link>

          <div className="sh-links">
            <Link to="/platform" className={isActive('/platform') ? 'sh-link sh-link-active' : 'sh-link'}>
              Platform
            </Link>

            {/* Solutions - two-column mega menu */}
            <div className={`sh-dd ${openDd === 'solutions' ? 'is-open' : ''}`}>
              <button
                type="button"
                className={`sh-dd-trigger ${inSolutions ? 'is-active' : ''}`}
                onClick={toggleDd('solutions')}
                aria-haspopup="true"
                aria-expanded={openDd === 'solutions'}
              >
                Solutions
                <span className="sh-caret" aria-hidden="true" />
              </button>
              <div className="sh-mega">
                <div className="sh-mega-inner">
                  <div className="sh-mega-col">
                    <div className="sh-mega-k">By Need</div>
                    {BY_NEED.map((i) => (
                      <Link key={i.to} to={i.to} className={isActive(i.to) ? 'sh-mega-item is-current' : 'sh-mega-item'}>
                        <span className="sh-mega-t">{i.t}</span>
                        <span className="sh-mega-d">{i.d}</span>
                      </Link>
                    ))}
                  </div>
                  <div className="sh-mega-col">
                    <div className="sh-mega-k">By Vertical</div>
                    {BY_VERTICAL.map((i) => (
                      <Link key={i.to} to={i.to} className={isActive(i.to) ? 'sh-mega-item is-current' : 'sh-mega-item'}>
                        <span className="sh-mega-t">
                          {i.t}
                          {i.live && <span className="sh-mega-live">Live</span>}
                        </span>
                        <span className="sh-mega-d">{i.d}</span>
                      </Link>
                    ))}
                    <div className="sh-mega-promo">
                      <span className="sh-mega-promo-k">Retail AI</span>
                      <p>
                        One platform for the store floor. Proven in liquor and
                        beverage retail, built for the rest of physical retail.
                      </p>
                      <button type="button" className="sh-mega-promo-btn" onClick={demo}>
                        See Botella in action <span aria-hidden="true">→</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Company */}
            <div className={`sh-dd ${openDd === 'company' ? 'is-open' : ''}`}>
              <button
                type="button"
                className={`sh-dd-trigger ${inCompany ? 'is-active' : ''}`}
                onClick={toggleDd('company')}
                aria-haspopup="true"
                aria-expanded={openDd === 'company'}
              >
                Company
                <span className="sh-caret" aria-hidden="true" />
              </button>
              <div className="sh-mega sh-mega-sm">
                <div className="sh-mega-inner">
                  <div className="sh-mega-col">
                    <div className="sh-mega-k">Company</div>
                    {COMPANY_LINKS.map((i) => (
                      <Link key={i.to} to={i.to} className={isActive(i.to) ? 'sh-mega-item is-current' : 'sh-mega-item'}>
                        <span className="sh-mega-t">{i.t}</span>
                        <span className="sh-mega-d">{i.d}</span>
                      </Link>
                    ))}
                    <a
                      className="sh-mega-item"
                      href="https://botellalabs.ai"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <span className="sh-mega-t">Botella AI Labs <span aria-hidden="true">↗</span></span>
                      <span className="sh-mega-d">The research company behind the platform</span>
                    </a>
                  </div>
                </div>
              </div>
            </div>

            <Link to="/blog" className={inInsights ? 'sh-link sh-link-active' : 'sh-link'}>
              Insights
            </Link>
            <Link to="/contact" className={isActive('/contact') ? 'sh-link sh-link-active' : 'sh-link'}>
              Contact
            </Link>
          </div>

          <div className="sh-right">
            {/* The same three-way control the signed-in app uses, so the
                theme choice looks and behaves identically on both sides of
                login. The old knob toggle had no way to express "follow my
                system setting". */}
            <ThemeSwitch
              preference={themePreference}
              resolved={themeResolved}
              onChange={setThemePreference}
              className="sh-theme"
            />

            <Link to="/login" className="sh-login">Login</Link>

            <button type="button" className="sh-cta" onClick={demo}>
              See Botella in Action
            </button>

            <button
              className="sh-mobile-btn"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
            >
              <span className={`sh-burger ${menuOpen ? 'is-x' : ''}`} aria-hidden="true">
                <i /><i /><i />
              </span>
            </button>
          </div>
        </div>
      </nav>

      {/* ── Mobile sheet ──────────────────────────────────────────────── */}
      {menuOpen && (
        <div className="sh-mobile-menu">
          <div className="sh-mobile-scroll">
            <Link to="/platform" className="sh-mobile-flat" onClick={() => setMenuOpen(false)}>Platform</Link>

            <div className={`sh-mobile-group ${mobileGroups.has('solutions') ? 'is-open' : ''}`}>
              <button type="button" className="sh-mobile-toggle" onClick={() => toggleMobileGroup('solutions')} aria-expanded={mobileGroups.has('solutions')}>
                Solutions <span className="sh-mobile-chevron" aria-hidden="true">›</span>
              </button>
              <div className="sh-mobile-items">
                <span className="sh-mobile-k">By Need</span>
                {BY_NEED.map((i) => (
                  <Link key={i.to} to={i.to} onClick={() => setMenuOpen(false)} className={isActive(i.to) ? 'is-current' : ''}>{i.t}</Link>
                ))}
                <span className="sh-mobile-k">By Vertical</span>
                {BY_VERTICAL.map((i) => (
                  <Link key={i.to} to={i.to} onClick={() => setMenuOpen(false)} className={isActive(i.to) ? 'is-current' : ''}>{i.t}</Link>
                ))}
              </div>
            </div>

            <div className={`sh-mobile-group ${mobileGroups.has('company') ? 'is-open' : ''}`}>
              <button type="button" className="sh-mobile-toggle" onClick={() => toggleMobileGroup('company')} aria-expanded={mobileGroups.has('company')}>
                Company <span className="sh-mobile-chevron" aria-hidden="true">›</span>
              </button>
              <div className="sh-mobile-items">
                {COMPANY_LINKS.map((i) => (
                  <Link key={i.to} to={i.to} onClick={() => setMenuOpen(false)} className={isActive(i.to) ? 'is-current' : ''}>{i.t}</Link>
                ))}
                <a href="https://botellalabs.ai" target="_blank" rel="noopener noreferrer">Botella AI Labs ↗</a>
              </div>
            </div>

            <Link to="/blog" className="sh-mobile-flat" onClick={() => setMenuOpen(false)}>Insights</Link>
            <Link to="/contact" className="sh-mobile-flat" onClick={() => setMenuOpen(false)}>Contact</Link>
            <Link to="/login" className="sh-mobile-flat" onClick={() => setMenuOpen(false)}>Login</Link>

            <button type="button" className="sh-mobile-cta" onClick={demo}>
              See Botella in Action
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export default SiteHeader;
