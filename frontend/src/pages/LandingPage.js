import React, { useEffect, useRef } from 'react';
import { useLocation, Link } from 'react-router-dom';
import useSEO from '../utils/useSEO';
import SiteHeader from '../components/SiteHeader';
import SiteFooter from '../components/SiteFooter';
import { useDemoPopup } from '../components/DemoPopupContext';
import JsonLd, { buildFaqSchema } from '../components/JsonLd';
import BackToTop from '../components/BackToTop';
import CustomCursor from '../components/CustomCursor';
import RotatingWord from '../components/RotatingWord';
import '../components/SiteHeader.css';
import '../components/SiteFooter.css';
import './LandingPage.css';

// Rotating phrases in the hero headline - "Best AI Agent for ___".
const HERO_WORDS = [
  'Liquor Stores',
  'Inventory Management',
  'Customer Insights',
  'Sales Analytics',
  'Margin Optimization',
  'AI Recommendation',
];

// Home page FAQ - sourced verbatim from the v2 SEO brief.
// Lives here as a module-level constant so it can be:
//   1. Rendered in the visible FAQ section (the existing .map below).
//   2. Re-used to build the FAQPage JSON-LD schema for Google rich results.
const HOME_FAQS = [
  {
    q: 'What is an AI agent for liquor stores?',
    a: 'An AI agent analyzes store data and automates operational decisions like inventory management, customer engagement, and product recommendations.',
  },
  {
    q: 'What is the best AI software for liquor stores?',
    a: 'Botella AI is built specifically for liquor stores, combining inventory automation, demand forecasting, customer intelligence, and operational automation.',
  },
  {
    q: 'Can Botella AI automate customer communication?',
    a: 'Yes. Botella AI automatically sends emails, WhatsApp messages, reminders, and promotional updates.',
  },
  {
    q: 'How does AI reduce stockouts?',
    // Softened per v3 doc - "predicts future demand" replaced with "identifies
    // trends and surfaces patterns" to avoid implying ML-forecasting claims.
    a: 'Botella AI identifies trends, surfaces patterns in demand, and alerts you before products run out.',
  },
  {
    q: 'Can Botella AI improve liquor store sales?',
    a: 'Yes. It identifies trends, recommends profitable products, automates follow-ups, and improves customer engagement.',
  },
];

function LandingPage() {
  const location = useLocation();

  // SEO - sourced from "Botella AI - SEO Changes & New Landing Pages (v3)" doc.
  // Description softened per v3 guidance to avoid implying ML/prediction claims -
  // "surface demand patterns" replaces the previous "predicts demand" phrasing.
  useSEO({
    title: 'Best AI Agent for Liquor Stores | Botella AI',
    description:
      'Botella AI helps liquor stores automate inventory, surface demand patterns, engage customers, and increase margins using artificial intelligence.',
    canonical: 'https://botella.ai/',
  });

  // If we land on the home page with a hash (e.g. /#lp-metrics from another
  // page's nav), wait one tick for the DOM to mount, then scroll.
  // Note: theme state + login routing are now handled inside SiteHeader,
  // so this component no longer needs to track theme.
  useEffect(() => {
    if (location.hash) {
      const id = location.hash.replace('#', '');
      // Small delay so the target section has actually rendered.
      setTimeout(() => {
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
      }, 80);
    }
  }, [location.hash]);

  const observerRef = useRef(null);

  // The "Book a Free Demo" / "Try Botella Now" / "Send an Email" buttons
  // all open the shared DemoPopup (lives at App root via DemoPopupProvider).
  // Same popup that fires from every SEO page - single source of truth.
  const { openDemoPopup } = useDemoPopup();
  const openPopup = (e) => {
    e.preventDefault();
    openDemoPopup();
  };

  const smoothScroll = (e, id) => {
    e.preventDefault();
    document.querySelector(id)?.scrollIntoView({ behavior: 'smooth' });
  };

  // Intersection observer for fade-in animations
  useEffect(() => {
    observerRef.current = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('lp-visible');
          }
        });
      },
      { threshold: 0.1, rootMargin: '0px 0px -40px 0px' }
    );

    document.querySelectorAll('.lp-animate').forEach((el) => {
      observerRef.current.observe(el);
    });

    return () => observerRef.current?.disconnect();
  }, []);

  return (
    <div className="lp">
      {/* Keyboard / screen-reader bypass - first focusable element on the
          page. Tab → Enter jumps past the nav straight into the hero. */}
      <a href="#main-content" className="skip-link">Skip to main content</a>

      {/* FAQPage structured data for Google rich results. Pulled from
          the same HOME_FAQS constant rendered visibly below, so the
          visible + invisible content can never drift apart. */}
      <JsonLd data={buildFaqSchema(HOME_FAQS)} />

      {/* HEADER - shared SiteHeader (same on home + every SEO page) */}
      <SiteHeader />

      {/* HERO - SEO H1 + new subheading + new intro paragraph per SEO brief */}
      <section className="lp-hero" id="main-content" tabIndex={-1}>
        <div className="lp-hero-tag">AI Agent for Liquor Stores</div>
        <h1>Best AI Agent for<br /><RotatingWord words={HERO_WORDS} /></h1>
        {/* Hero sub + intro paragraph rewritten per v3 SEO doc to soften
            prediction claims. Old "Predict demand, automate reordering" line
            replaced with operational-visibility framing the marketing team
            can defensibly back without implying ML/forecasting capabilities. */}
        <p className="lp-hero-sub">
          Simplify liquor store operations with AI-powered automation.
          Streamline customer engagement, store communication, and operational
          visibility in one platform.
        </p>
        <p>
          Botella AI is an intelligent AI agent built specifically for liquor
          stores. It helps organize store activity into clear operational
          insights and automated workflows - customer communication, marketing,
          follow-ups, and daily operational tasks using real-time store data.
          From surfacing store performance trends to automating customer
          communication, Botella helps you run your liquor store effortlessly.
        </p>
        <div className="lp-btns">
          <a href="#" className="lp-btn-fill" onClick={openPopup}>Book a Free Demo</a>
          <a href="#features" className="lp-btn-line" onClick={(e) => smoothScroll(e, '#lp-features')}>See Features →</a>
        </div>
      </section>

      {/* PROVEN RESULTS - heading-only intro, then a 4-metric horizontal bar.
          The qualitative pill bullets were removed; the numbers now stand on
          their own. */}
      <section className="lp-metrics-header lp-animate">
        <h2>Proven Results for Liquor Stores Using AI</h2>
      </section>
      <div className="lp-metrics-bar">
        {[
          { n: '30%',   l: 'Avg reduction in stockouts' },
          { n: 'Day 1', l: 'Ready, no training needed' },
          { n: '40%',   l: 'Less time on admin tasks' },
          { n: '15%',   l: 'Avg margin improvement' },
        ].map((m, i) => (
          <div className="lp-mbar lp-animate" key={i} style={{ transitionDelay: `${i * 0.08}s` }}>
            <div className="lp-mbar-n">{m.n}</div>
            <div className="lp-mbar-l">{m.l}</div>
          </div>
        ))}
      </div>

      {/* FEATURES - section heading + eyebrow updated to v3 wording:
          eyebrow "What Botella AI Does" and "Operational tools built for
          liquor retail" headline replace the older "Everything your store
          needs to run better" framing. */}
      <section className="lp-sec" id="lp-features">
        <div className="lp-eyebrow">What Botella AI Does</div>
        <h2>Operational tools built<br /><i>for liquor retail.</i></h2>

        {/* Feature titles renamed per SEO brief (keyword-rich; same icons + body copy).
            Each card now links to its dedicated feature page for both UX + SEO. */}
        <div className="lp-feat-grid">
          {[
            { t: 'AI Inventory Management for Liquor Stores',          d: 'Real-time stock visibility, low-stock alerts, dead stock detection, and inventory optimization.', to: '/ai-inventory-management-liquor-stores' },
            { t: 'Customer Insights & Purchase Behavior Analytics',    d: 'Understand customer preferences, identify VIP buyers, and improve retention.', to: '/customer-insights-liquor-stores' },
            { t: 'Liquor Store Sales Analytics & Insights',            d: 'Track top-selling products, category performance, peak hours, and revenue trends.', to: '/liquor-store-sales-analytics-insights' },
            { t: 'Margin Optimization & Profit Intelligence',          d: 'Know exactly which products generate profit and optimize pricing.', to: '/margin-optimization-liquor-stores' },
            { t: 'AI Product Recommendations for Liquor Stores',       d: 'Help staff recommend the right products to increase upsells and cross-sells.', to: '/ai-product-recommendations-liquor-stores' },
          ].map((f, i) => (
            <Link
              to={f.to}
              className="lp-feat lp-animate lp-feat-link"
              key={i}
              style={{ transitionDelay: `${i * 0.08}s` }}
            >
              <div className="lp-feat-t">{f.t}</div>
              <div className="lp-feat-d">{f.d}</div>
              <div className="lp-feat-more">Learn more →</div>
            </Link>
          ))}
        </div>
      </section>

      {/* PRODUCT SHOWCASE - tabbed explorer of real Botella screens. */}

      {/* BOTELLA AUTOMATES THE WORK - new section in v2 SEO brief.
          6 cards covering the automation surface beyond inventory:
          social media · email · WhatsApp · follow-ups · journey · ops. */}
      <section className="lp-sec lp-automate-sec">
        <div className="lp-eyebrow">Automation</div>
        <h2>Botella AI automates the work<br /><i>behind your store.</i></h2>
        <p className="lp-sec-desc">
          Managing a liquor store involves dozens of repetitive operational
          tasks. Botella handles them automatically.
        </p>

        <div className="lp-automate-grid">
          {[
            {
              t: 'Social Media Automation',
              d: 'Automatically posts holiday wishes, offers, promotions, and store announcements.',
            },
            {
              t: 'Email Automation',
              d: 'Sends customer promotions, updates, reminders, and campaigns automatically.',
            },
            {
              t: 'WhatsApp Customer Messaging',
              d: 'Delivers automated alerts, updates, and engagement messages directly to customers.',
            },
            {
              t: 'Smart Follow-Up Reminders',
              d: 'Never miss customer outreach opportunities.',
            },
            {
              t: 'Customer Journey Monitoring',
              d: 'Tracks customer interactions and identifies retention opportunities.',
            },
            {
              t: 'Operational Task Automation',
              d: 'Botella handles the repetitive work, so your team can focus on selling.',
            },
          ].map((a, i) => (
            <div className="lp-automate-card lp-animate" key={i} style={{ transitionDelay: `${i * 0.06}s` }}>
              <div className="lp-automate-t">{a.t}</div>
              <div className="lp-automate-d">{a.d}</div>
            </div>
          ))}
        </div>
      </section>

      {/* WHY + FAQ - pain-points (left) and FAQ (right) placed side-by-side. */}
      <div className="lp-whyfaq-split">
      <section className="lp-sec lp-why-sec">
        <div className="lp-eyebrow">Why AI</div>
        <h2>Why Liquor Stores<br /><i>Need an AI Agent.</i></h2>
        <p className="lp-sec-desc">Without AI, liquor stores often struggle with:</p>

        <div className="lp-why-grid">
          {[
            'Frequent stockouts',
            'Excess dead inventory',
            'Missed customer retention opportunities',
            'Manual reporting and analysis',
            'Inconsistent follow-ups',
            'Missed marketing opportunities',
            'Lost upsell potential',
          ].map((t, i) => (
            <div className="lp-why-card lp-animate" key={i} style={{ transitionDelay: `${i * 0.06}s` }}>
              <div className="lp-why-t">{t}</div>
            </div>
          ))}
        </div>

        <div className="lp-why-foot-card lp-animate">
          <div>
            <p>Botella AI serves as your real-time operational visibility platform, helping your store run proactively rather than reactively.</p>
          </div>
        </div>
      </section>

      {/* FAQ - moved here to sit beside the "Why" section. */}
      <section className="lp-sec lp-faq-sec">
        <div className="lp-eyebrow">FAQs</div>
        <h2>Frequently Asked<br /><i>Questions.</i></h2>
        <div className="lp-faqs">
          {HOME_FAQS.map((f, i) => (
            <div className="lp-faq lp-animate" key={i} style={{ transitionDelay: `${i * 0.08}s` }}>
              <h3>{f.q}</h3>
              <p>{f.a}</p>
            </div>
          ))}
        </div>
      </section>
      </div>

      {/* COMPARISON TABLE - Botella AI vs Traditional POS.
          Reworked to use checkmark + X icons instead of plain text,
          plus the Botella column gets a subtle highlight so it draws
          the eye. */}
      <section className="lp-sec lp-compare-sec">
        <div className="lp-eyebrow">Comparison</div>
        <h2>Botella AI vs<br /><i>Traditional Liquor Store Software.</i></h2>
        <div className="lp-compare-wrap lp-animate">
          <table className="lp-compare">
            <thead>
              <tr>
                <th>Feature</th>
                <th className="lp-compare-us">
                  <span className="lp-compare-brand">Botella AI</span>
                </th>
                <th>Traditional POS</th>
              </tr>
            </thead>
            <tbody>
              {/* Comparison rows trimmed to match the v3 SEO doc's 6-row
                  table. Auto Reordering removed because that standalone page
                  no longer exists. Real-time Alerts dropped since it's not
                  in the v3 list - it's covered by WhatsApp Messaging anyway. */}
              {[
                { f: 'Demand Prediction',    b: 'yes',      p: 'no'    },
                { f: 'Customer Insights',    b: 'advanced', p: 'basic' },
                { f: 'Social Automation',    b: 'yes',      p: 'no'    },
                { f: 'WhatsApp Messaging',   b: 'yes',      p: 'no'    },
                { f: 'AI Recommendations',   b: 'yes',      p: 'no'    },
                { f: 'Follow-Up Automation', b: 'yes',      p: 'no'    },
              ].map((row, i) => (
                <tr key={i}>
                  <td className="lp-compare-feat">{row.f}</td>
                  <td className="lp-compare-us">
                    {row.b === 'yes' ? (
                      <span className="lp-compare-check">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                        <span>Yes</span>
                      </span>
                    ) : (
                      <span className="lp-compare-badge lp-compare-adv">Advanced</span>
                    )}
                  </td>
                  <td>
                    {row.p === 'no' ? (
                      <span className="lp-compare-x">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                        <span>No</span>
                      </span>
                    ) : (
                      <span className="lp-compare-badge lp-compare-basic">Basic</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* STORE METRICS */}
      <section className="lp-metrics-sec" id="lp-metrics">
        <div className="lp-metrics-inner">
          <div className="lp-eyebrow">Store Intelligence</div>
          <h2>Numbers that <i>actually matter.</i></h2>
          <p className="lp-sec-desc">Botella AI surfaces the key insights store owners need instantly.</p>

          {/* Trimmed to the 6 entries explicitly listed in the v3 SEO doc
              (removed "Reorder Forecast" and "Stock Accuracy" - not in
              the doc). Each card uses the doc's exact label + short
              description. */}
          <div className="lp-m-grid">
            {[
              { v: '$', l: 'Revenue Per Day',      d: 'Track performance in real time.' },
              { v: '%', l: 'Gross Margin',         d: 'Understand profitability by product and category.' },
              { v: '↑', l: 'Top Selling Products', d: 'See what drives revenue.' },
              { v: '↓', l: 'Dead Stock Alerts',    d: 'Identify products that need action.' },
              { v: '○', l: 'Peak Hours',           d: 'Optimize staffing and operations.' },
              { v: '★', l: 'Top Customers',        d: 'Know who drives repeat revenue.' },
            ].map((m, i) => (
              <div className="lp-m-card lp-animate" key={i} style={{ transitionDelay: `${i * 0.06}s` }}>
                <div className="lp-m-val">{m.v}</div>
                <div className="lp-m-label">{m.l}</div>
                <div className="lp-m-desc">{m.d}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* WHATSAPP & EMAIL - heading + intro updated to v3 "Automatic Updates"
          framing. v3 lists exactly which alert types you'll receive - surfacing
          that list above the card visuals makes the value prop concrete. */}
      <section className="lp-notif-sec">
        <div className="lp-eyebrow">Automatic Updates</div>
        <h2>Your store updates you.<br /><i>Not the other way around.</i></h2>
        <p className="lp-sec-desc">
          Botella sends AI-powered alerts through WhatsApp and email - so you
          always know what's happening, even when you're not there. Receive
          daily revenue summaries, low-stock alerts, dead-stock notifications,
          reorder recommendations, margin insights, and customer engagement
          updates. No manual checking required.
        </p>
        {/* SEO line added per brief */}
        <p className="lp-seo-line">AI-powered alerts via WhatsApp and email for liquor store owners.</p>

        <div className="lp-notif-grid">

          {/* ─────────────────────────────────────────────────────────
              WHATSAPP CARD - styled to look like an actual WhatsApp
              chat conversation with Botella. The header mirrors
              WhatsApp's contact bar (avatar + name + "online" status),
              the body uses WhatsApp's dark-theme chat colours regardless
              of site theme so it reads as "this is what you'd see in
              WhatsApp", and each message is a real left-aligned
              incoming bubble with timestamp + blue read-ticks.
             ────────────────────────────────────────────────────── */}
          <div className="lp-notif-card lp-wa-card lp-animate">
            <div className="lp-wa-header">
              {/* Official WhatsApp glyph - green circle with phone-in-bubble */}
              <svg className="lp-wa-logo" viewBox="0 0 32 32" aria-hidden="true">
                <circle cx="16" cy="16" r="16" fill="#25D366" />
                <path fill="#fff" d="M22.5 9.5C20.78 7.78 18.5 6.8 16.05 6.8c-5.21 0-9.45 4.24-9.45 9.44 0 1.66.44 3.29 1.27 4.72L6.36 25.5l4.77-1.25a9.42 9.42 0 0 0 4.51 1.15h.01c5.2 0 9.48-4.24 9.48-9.44 0-2.52-1.02-4.89-2.8-6.67l.17.21zm-6.45 14.52h-.01a7.85 7.85 0 0 1-4-1.09l-.29-.17-2.97.78.79-2.89-.19-.3a7.83 7.83 0 0 1-1.2-4.18c0-4.33 3.53-7.85 7.86-7.85 2.1 0 4.07.82 5.55 2.3a7.81 7.81 0 0 1 2.3 5.55c0 4.33-3.52 7.85-7.85 7.85h.01zm4.31-5.88c-.24-.12-1.4-.69-1.61-.77-.22-.08-.37-.12-.53.12-.16.24-.61.77-.75.93-.14.16-.27.18-.51.06-.24-.12-1-.37-1.9-1.17-.7-.63-1.18-1.4-1.32-1.64-.14-.24-.01-.37.1-.49.11-.11.24-.27.36-.41.12-.14.16-.24.24-.39.08-.16.04-.3-.02-.41-.06-.12-.53-1.28-.73-1.76-.19-.46-.39-.4-.53-.4-.14 0-.3-.02-.46-.02a.87.87 0 0 0-.63.3c-.22.24-.82.8-.82 1.96 0 1.16.85 2.28 1 2.44.14.16 1.67 2.56 4.04 3.58.57.25 1 .4 1.35.5.56.18 1.08.15 1.49.1.45-.07 1.4-.57 1.6-1.13.2-.55.2-1.02.14-1.13-.06-.1-.22-.16-.46-.27z"/>
              </svg>
              <div className="lp-wa-contact">
                <div className="lp-wa-name">Botella</div>
                <div className="lp-wa-status"><span className="lp-wa-dot" />online</div>
              </div>
              <div className="lp-wa-tag">Daily · 8 AM</div>
            </div>

            <div className="lp-wa-chat">
              <div className="lp-wa-day">TODAY</div>

              {/* Message 1 - morning digest */}
              <div className="lp-wa-bubble">
                <div className="lp-wa-bubble-title">☀️ Good morning - here's your store summary</div>
                <div className="lp-wa-bubble-body">
                  Yesterday's revenue: <strong>$4,820</strong> (+12% vs last Tuesday)<br /><br />
                  🏆 Top seller: Bud Light 12pk - 94 units<br />
                  ⚠️ Low stock: Jim Beam 750ml - 6 bottles<br />
                  💀 Dead stock: Barefoot Merlot - 42 days idle<br /><br />
                  <strong>Push today:</strong> Jack Daniel's 375ml - high margin
                </div>
                <div className="lp-wa-bubble-meta">
                  <span>8:02 AM</span>
                  <svg className="lp-wa-ticks" viewBox="0 0 18 11" aria-hidden="true">
                    <path d="M11.071.653a.457.457 0 0 0-.304-.108.46.46 0 0 0-.343.158L5.062 7.012 2.838 4.788a.457.457 0 0 0-.643 0l-.642.643a.457.457 0 0 0 0 .643l3.111 3.111a.457.457 0 0 0 .679 0L11.4 1.95a.457.457 0 0 0-.043-.66l-.286-.638z" fill="#53bdeb"/>
                    <path d="M15.071.653a.457.457 0 0 0-.304-.108.46.46 0 0 0-.343.158L9.062 7.012l-.434-.434-.643.643 1.077 1.077a.457.457 0 0 0 .679 0L15.4 1.95a.457.457 0 0 0-.043-.66l-.286-.638z" fill="#53bdeb"/>
                  </svg>
                </div>
              </div>

              {/* Message 2 - reorder alert */}
              <div className="lp-wa-bubble">
                <div className="lp-wa-bubble-title">⚠️ Reorder Alert</div>
                <div className="lp-wa-bubble-body">
                  Maker's Mark 750ml will run out in ~3 days at current pace. Want me to draft a PO?
                </div>
                <div className="lp-wa-bubble-meta">
                  <span>2:14 PM</span>
                  <svg className="lp-wa-ticks" viewBox="0 0 18 11" aria-hidden="true">
                    <path d="M11.071.653a.457.457 0 0 0-.304-.108.46.46 0 0 0-.343.158L5.062 7.012 2.838 4.788a.457.457 0 0 0-.643 0l-.642.643a.457.457 0 0 0 0 .643l3.111 3.111a.457.457 0 0 0 .679 0L11.4 1.95a.457.457 0 0 0-.043-.66l-.286-.638z" fill="#53bdeb"/>
                    <path d="M15.071.653a.457.457 0 0 0-.304-.108.46.46 0 0 0-.343.158L9.062 7.012l-.434-.434-.643.643 1.077 1.077a.457.457 0 0 0 .679 0L15.4 1.95a.457.457 0 0 0-.043-.66l-.286-.638z" fill="#53bdeb"/>
                  </svg>
                </div>
              </div>
            </div>
          </div>

          {/* ─────────────────────────────────────────────────────────
              EMAIL CARD - styled to look like a Gmail inbox preview
              list. Top bar shows the official Gmail multi-colour M
              logo + "Inbox" label, then a list of two email previews
              (avatar + sender + subject + snippet + timestamp) that
              mirror the real Gmail row layout.
             ────────────────────────────────────────────────────── */}
          <div className="lp-notif-card lp-em-card lp-animate" style={{ transitionDelay: '0.1s' }}>
            <div className="lp-em-header">
              {/* Official Gmail glyph - multi-colour envelope/M */}
              <svg className="lp-em-logo" viewBox="0 0 256 193" aria-hidden="true">
                <path fill="#4285F4" d="M58.182 192.05V93.14L27.507 65.077 0 49.504v125.091c0 9.658 7.825 17.455 17.455 17.455h40.727z"/>
                <path fill="#34A853" d="M197.818 192.05h40.727c9.659 0 17.455-7.826 17.455-17.455V49.505l-31.156 17.837-27.026 25.798v98.91z"/>
                <path fill="#EA4335" d="M58.182 93.14l-4.174-38.647 4.174-36.989L128 69.868l69.818-52.364 4.669 34.992-4.669 40.644L128 145.504z"/>
                <path fill="#FBBC04" d="M197.818 17.504V93.14L256 49.504V26.231c0-21.585-24.64-33.89-41.89-20.945l-16.292 12.218z"/>
                <path fill="#C5221F" d="M0 49.504l26.759 20.07L58.182 93.14V17.504L41.89 5.286C24.61-7.66 0 4.646 0 26.23v23.273z"/>
              </svg>
              <div className="lp-em-platform">
                <div className="lp-em-platform-name">Inbox</div>
                <div className="lp-em-platform-sub">2 new from Botella</div>
              </div>
              <div className="lp-em-tag">Weekly · Monday</div>
            </div>

            <div className="lp-em-list">
              {/* Email 1 - weekly business review */}
              <div className="lp-em-row">
                <div className="lp-em-avatar" aria-hidden="true">B</div>
                <div className="lp-em-content">
                  <div className="lp-em-row-top">
                    <span className="lp-em-sender">Botella Weekly</span>
                    <span className="lp-em-time">9:00 AM</span>
                  </div>
                  <div className="lp-em-subject">📊 Weekly Business Review - Week 10</div>
                  <div className="lp-em-preview">
                    Revenue <strong>$28,400</strong> (+8%). Gross margin <strong>24.3%</strong> (up from 22.1%). Best category: Premium Whisky. Recommendation: bundle Barefoot Pinot with cheese to clear slow stock.
                  </div>
                </div>
              </div>

              {/* Email 2 - monthly P&L */}
              <div className="lp-em-row">
                <div className="lp-em-avatar" aria-hidden="true">B</div>
                <div className="lp-em-content">
                  <div className="lp-em-row-top">
                    <span className="lp-em-sender">Botella Reports</span>
                    <span className="lp-em-time">Feb 1</span>
                  </div>
                  <div className="lp-em-subject">📅 Monthly P&amp;L Snapshot - February</div>
                  <div className="lp-em-preview">
                    Revenue $42,000 · COGS $32,000 · Gross profit $10,000 · Margin <strong>23.8%</strong>. Sent on the 1st of every month.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* SMART SELLING - Per v3 doc this section is just the heading +
          two short paragraphs + a tagline. The 5 example suggestion
          cards that lived here previously have been removed because
          they're not in the doc and the user requested doc-only copy. */}
      <section className="lp-suggest-sec">
        <div className="lp-suggest-inner">
          <div className="lp-eyebrow">Smart Selling</div>
          <h2>Botella tells your staff<br /><i>what to sell.</i></h2>
          <p className="lp-sec-desc">
            Botella highlights product and sales trends to help staff make
            better day-to-day selling decisions. Your staff always knows
            what to push.
          </p>
          <p className="lp-seo-line">AI-driven recommendations help increase liquor store sales and margins.</p>
        </div>
      </section>

      {/* SETUP STEPS - copy updated to v3 wording. Step 4 was explicitly
          flagged in the v3 doc with an "Avoid implying ML adaptation" note,
          so we removed the "predicting demand" language from step 4 and
          replaced it with a more defensible "ongoing operational insights"
          framing. */}
      <section className="lp-sec">
        <div className="lp-eyebrow">Setup</div>
        <h2>Running in <i>one week.</i></h2>
        <div className="lp-steps">
          {[
            { n: '01', t: 'Connect Your System', d: 'We connect Botella to your store data.' },
            { n: '02', t: 'Botella Connects to Your Store Data', d: 'It analyzes products, customers, and sales history.' },
            { n: '03', t: 'Automation Starts', d: 'Receive insights and automated workflows immediately.' },
            { n: '04', t: 'Delivers Ongoing Operational Insights', d: 'Stay informed as your store data changes day-to-day.' },
          ].map((s, i) => (
            <div className="lp-animate" key={i} style={{ transitionDelay: `${i * 0.1}s` }}>
              <div className="lp-step-n">{s.n}</div>
              <div className="lp-step-t">{s.t}</div>
              <div className="lp-step-d">{s.d}</div>
            </div>
          ))}
        </div>
      </section>

      {/* FAQ section moved up to sit beside "Why" - see .lp-whyfaq-split above. */}

      {/* BOTTOM SPLIT - "What is Botella AI?" (left) + GET STARTED CTA (right)
          sit side-by-side so the value-prop checklist is literally adjacent
          to the demo-booking buttons. Collapses to a single column on mobile. */}
      <div className="lp-bottom-split">
        <section className="lp-sec lp-whatis-sec">
          <div className="lp-whatis-inner">
            <h2>What is Botella AI?</h2>
            <p className="lp-whatis-lead">
              Botella AI is an AI-powered operating system for liquor stores. It
              analyzes your inventory, sales trends, customer behavior, and
              operational data to automate the decisions and tasks that usually
              require manual effort.
            </p>
            <p className="lp-whatis-sublead">Botella helps liquor store owners:</p>
            <ul className="lp-whatis-list">
              <li><span className="lp-whatis-check" aria-hidden="true">✓</span><span>Surface inventory movement trends</span></li>
              <li><span className="lp-whatis-check" aria-hidden="true">✓</span><span>Highlight products needing attention</span></li>
              <li><span className="lp-whatis-check" aria-hidden="true">✓</span><span>Simplify store performance visibility</span></li>
              <li><span className="lp-whatis-check" aria-hidden="true">✓</span><span>Automate customer outreach</span></li>
              <li><span className="lp-whatis-check" aria-hidden="true">✓</span><span>Streamline operational communication</span></li>
            </ul>
            <p className="lp-whatis-footnote">Botella AI acts as an operational assistant for modern liquor stores.</p>
          </div>
        </section>

        {/* FINAL CTA - heading copy matches the v3 SEO doc verbatim
            ("Let Botella Run the Work. You Run the Store."). */}
        <section className="lp-final-cta-sec" id="lp-contact">
          <div className="lp-final-cta-inner">
            <div className="lp-eyebrow">Get Started</div>
            <h2>Let Botella run the work.<br /><i>You run the store.</i></h2>
            <p>
              Stop managing everything manually. Let Botella AI automate inventory,
              customer engagement, marketing, and operational decisions - so your
              liquor store runs smarter and hassle-free.
            </p>
            <div className="lp-btns">
              <a href="#" className="lp-btn-fill" onClick={openPopup}>Book a Free Demo</a>
              <a href="#" className="lp-btn-line" onClick={openPopup}>Try Botella Now</a>
            </div>
            <p className="lp-cta-note">No commitment · 30-day free trial · Setup in under a week</p>
          </div>
        </section>
      </div>

      {/* FOOTER - shared SiteFooter component (multi-column nav + legal bar).
          Replaces the old single-line footer. See components/SiteFooter.js. */}
      <SiteFooter />
      <BackToTop />
      <CustomCursor />

      {/* Email popup is rendered by DemoPopupProvider at the App root.
          It opens whenever any "Book a Free Demo" / CTA button fires
          openDemoPopup() - see the buttons throughout this file. */}
    </div>
  );
}

export default LandingPage;
