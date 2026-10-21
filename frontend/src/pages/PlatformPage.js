// PlatformPage.js
// -----------------------------------------------------------------------------
// /platform - the one-platform narrative in full.
//
// The homepage claims the category; this page proves the machinery behind it:
// what Botella connects to, what it does on its own, how it reports back, how
// long it takes to stand up, and how it differs from the POS a store already
// owns. Same brand system, same header and footer as every other public page.
// -----------------------------------------------------------------------------

import React from 'react';
import { Link } from 'react-router-dom';
import useSEO from '../utils/useSEO';
import SiteHeader from '../components/SiteHeader';
import SiteFooter from '../components/SiteFooter';
import BackToTop from '../components/BackToTop';
import ShelfSignal from '../components/ShelfSignal';
import { useDemoPopup } from '../components/DemoPopupContext';
import useBxReveal from '../utils/useBxReveal';
import useScrollTop from '../utils/useScrollTop';
import '../components/SiteHeader.css';
import '../components/SiteFooter.css';
import '../styles/brand.css';
import './HomePage.css';
import './SubPage.css';

const STEPS = [
  { n: '01', t: 'Connect', d: 'Botella connects to the systems the store already runs - point of sale, stock ledger, sales history, customer records.' },
  { n: '02', t: 'Learn', d: 'It reads your catalog and your trading pattern. Not a generic model of retail - the shape of your business, from your own data.' },
  { n: '03', t: 'Act', d: 'Reorder alerts, customer follow-ups, marketing posts and daily task lists start firing automatically, on real signals.' },
  { n: '04', t: 'Report', d: 'Every morning and every week, the store reports to you - on WhatsApp and by email - before you have to go looking.' },
];

const CAPABILITIES = [
  {
    t: 'Inventory Intelligence',
    to: '/ai-inventory-management-liquor-stores',
    d: 'Real-time stock visibility, low-stock alerts, dead stock detection and reorder recommendations across the whole catalog.',
    tone: 'violet',
  },
  {
    t: 'Demand Signal',
    to: '/liquor-store-sales-analytics-insights',
    d: 'Top sellers, category performance, peak trading hours and revenue trends - the patterns already sitting in your sales history.',
    tone: 'cyan',
  },
  {
    t: 'Customer Engagement',
    to: '/customer-insights-liquor-stores',
    d: 'Purchase behaviour, VIP identification and retention signals, wired straight into automated outreach.',
    tone: 'jade',
  },
  {
    t: 'Margin Command',
    to: '/margin-optimization-liquor-stores',
    d: 'Profit by product, category and hour, so pricing and shelf space decisions stop being guesswork.',
    tone: 'fuchsia',
  },
  {
    t: 'Recommendations',
    to: '/ai-product-recommendations-liquor-stores',
    d: 'What your staff should be pushing today - the high-margin, high-velocity products that move the number.',
    tone: 'plum',
  },
];

const AUTOMATIONS = [
  ['Social media', 'Posts holiday wishes, offers, promotions and store announcements automatically.'],
  ['Email campaigns', 'Sends customer promotions, updates, reminders and campaigns without a marketing calendar.'],
  ['WhatsApp messaging', 'Delivers alerts, updates and engagement messages straight to customers.'],
  ['Follow-ups', 'Never lets a customer outreach opportunity quietly expire.'],
  ['Customer journeys', 'Tracks interactions and surfaces retention opportunities as they appear.'],
  ['Daily operations', 'Handles the repetitive work so the team can spend the day selling.'],
];

const COMPARE = [
  ['Demand pattern detection', true, false],
  ['Customer insights', 'Advanced', 'Basic'],
  ['Social automation', true, false],
  ['WhatsApp messaging', true, false],
  ['AI recommendations', true, false],
  ['Follow-up automation', true, false],
];

function Cell({ v, us }) {
  if (v === true) {
    return (
      <span className={`sp-yes ${us ? 'is-us' : ''}`}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        Yes
      </span>
    );
  }
  if (v === false) {
    return (
      <span className="sp-no">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
        No
      </span>
    );
  }
  return <span className={`sp-badge ${us ? 'is-us' : ''}`}>{v}</span>;
}

function PlatformPage() {
  const { openDemoPopup } = useDemoPopup();
  useScrollTop();
  useBxReveal();

  useSEO({
    title: 'The Botella Platform | The AI Operating System for Retail',
    description:
      'Botella is one AI operating system for retail: it connects to your POS and inventory, automates reordering, marketing and customer follow-up, and reports on margin every day.',
    canonical: 'https://botella.ai/platform',
  });

  const demo = (e) => { e.preventDefault(); openDemoPopup(); };

  return (
    <div className="lp bx">
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <SiteHeader />

      {/* HERO */}
      <header className="sp-hero" id="main-content" tabIndex={-1}>
        <div className="hp-hero-glow" aria-hidden="true" />
        <div className="bx-wrap sp-hero-inner">
          <div>
            <span className="bx-eyebrow bx-rise" style={{ '--bx-delay': '0.05s' }}>The Platform</span>
            <h1 className="bx-h1 bx-rise" style={{ '--bx-delay': '0.12s' }}>
              Botella - the AI operating<br />system for <span className="bx-em">retail</span>.
            </h1>
            <p className="bx-lead bx-rise" style={{ '--bx-delay': '0.22s' }}>
              One platform where the whole store is understood. Botella connects
              to the systems you already run, learns your business from your own
              history, then works the floor with you - every day, without being
              asked.
            </p>
            <div className="sp-hero-cta bx-rise" style={{ '--bx-delay': '0.32s' }}>
              <button type="button" className="bx-btn bx-btn-primary" onClick={demo}>
                See Botella in Action
              </button>
              <Link to="/contact" className="bx-btn bx-btn-ghost">Talk to the team</Link>
            </div>
          </div>
          <div className="bx-rise" style={{ '--bx-delay': '0.28s' }}>
            <ShelfSignal variant="console" />
          </div>
        </div>
      </header>

      {/* HOW IT WORKS */}
      <section className="bx-sec bx-sec-tint">
        <div className="bx-wrap">
          <div className="hp-sec-head bx-reveal">
            <span className="bx-eyebrow">How it works</span>
            <h2 className="bx-h2">Connect. Learn. Act. <span className="bx-em">Report</span>.</h2>
          </div>
          <ol className="sp-steps">
            {STEPS.map((s, i) => (
              <li key={s.n} className="sp-step bx-reveal" style={{ '--bx-delay': `${i * 0.08}s` }}>
                <span className="sp-step-n">{s.n}</span>
                <h3 className="bx-h3">{s.t}</h3>
                <p>{s.d}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* CAPABILITIES */}
      <section className="bx-sec">
        <div className="bx-wrap">
          <div className="hp-sec-head bx-reveal">
            <span className="bx-eyebrow">Capabilities</span>
            <h2 className="bx-h2">Five surfaces, <span className="bx-em">one system</span>.</h2>
            <p className="bx-lead hp-sec-lead">
              Every capability reads the same data and writes back to the same
              place. That is the difference between a platform and a folder full
              of dashboards.
            </p>
          </div>
          <div className="sp-cap-grid">
            {CAPABILITIES.map((c, i) => (
              <Link
                key={c.t}
                to={c.to}
                className={`hp-pillar bx-reveal hp-tone-${c.tone}`}
                style={{ '--bx-delay': `${i * 0.07}s` }}
              >
                <h3 className="bx-h3 hp-pillar-t">{c.t}</h3>
                <p className="hp-pillar-d">{c.d}</p>
                <span className="bx-link hp-pillar-link">
                  Go deeper <span className="bx-link-arrow" aria-hidden="true">→</span>
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* AUTOMATION */}
      <section className="bx-sec bx-sec-dark">
        <div className="bx-wrap">
          <div className="hp-sec-head bx-reveal">
            <span className="bx-eyebrow">Automation</span>
            <h2 className="bx-h2">The work that happens <span className="bx-em">without you</span>.</h2>
            <p className="bx-lead hp-sec-lead">
              Running a store means dozens of small repetitive operational tasks
              a day. Botella takes them.
            </p>
          </div>
          <ul className="sp-auto-grid">
            {AUTOMATIONS.map(([t, d], i) => (
              <li key={t} className="sp-auto bx-reveal" style={{ '--bx-delay': `${i * 0.06}s` }}>
                <span className="sp-auto-t">{t}</span>
                <span className="sp-auto-d">{d}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* REPORTING */}
      <section className="bx-sec">
        <div className="bx-wrap sp-report">
          <div className="bx-reveal">
            <span className="bx-eyebrow">Reporting</span>
            <h2 className="bx-h2">Your store updates <span className="bx-em">you</span>.</h2>
            <p className="bx-lead">
              Daily revenue summaries, low-stock alerts, dead-stock
              notifications, reorder recommendations, margin insights and
              customer engagement updates - delivered on WhatsApp and by email.
              No manual checking required.
            </p>
          </div>
          <div className="sp-report-card bx-reveal">
            <div className="sp-report-head">
              <span className="sp-report-live"><span className="bx-dot bx-dot-pulse" />Daily digest</span>
              <span className="bx-mono">8:02 AM</span>
            </div>
            <div className="sp-report-body">
              <p><strong>Yesterday:</strong> $4,820 revenue, up 12% on last Tuesday.</p>
              <p><strong>Top seller:</strong> 94 units, single SKU.</p>
              <p><strong>Running out:</strong> 6 bottles left on a fast mover - reorder drafted.</p>
              <p><strong>Idle stock:</strong> one SKU untouched for 42 days - bundle suggested.</p>
              <p><strong>Push today:</strong> the highest-margin item your customers are already buying.</p>
            </div>
          </div>
        </div>
      </section>

      {/* COMPARISON */}
      <section className="bx-sec bx-sec-tint">
        <div className="bx-wrap">
          <div className="hp-sec-head hp-sec-head-center bx-reveal">
            <span className="bx-eyebrow">Comparison</span>
            <h2 className="bx-h2">Botella vs a <span className="bx-em">traditional POS</span>.</h2>
          </div>
          <div className="sp-table-wrap bx-reveal">
            <table className="sp-table">
              <thead>
                <tr>
                  <th scope="col">Capability</th>
                  <th scope="col" className="is-us">Botella</th>
                  <th scope="col">Traditional POS</th>
                </tr>
              </thead>
              <tbody>
                {COMPARE.map(([f, b, p]) => (
                  <tr key={f}>
                    <th scope="row">{f}</th>
                    <td className="is-us"><Cell v={b} us /></td>
                    <td><Cell v={p} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="bx-sec bx-sec-dark sp-cta">
        <div className="bx-wrap bx-wrap-narrow sp-cta-inner bx-reveal">
          <span className="bx-eyebrow">Get started</span>
          <h2 className="bx-h2">Running in <span className="bx-em">one week</span>.</h2>
          <p className="bx-lead">
            Connect the store, let Botella read the data, and start receiving
            insight and automation immediately. Most stores are live in days.
          </p>
          <div className="sp-hero-cta">
            <button type="button" className="bx-btn bx-btn-primary" onClick={demo}>Book a demo</button>
            <Link to="/company" className="bx-btn bx-btn-ghost">Who builds this</Link>
          </div>
          <p className="hp-close-note">No commitment &middot; 30-day free trial &middot; Setup in under a week</p>
        </div>
      </section>

      <SiteFooter />
      <BackToTop />
    </div>
  );
}

export default PlatformPage;
