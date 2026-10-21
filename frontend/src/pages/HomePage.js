// HomePage.js
// -----------------------------------------------------------------------------
// botella.ai homepage - the category-claim page for Retail AI.
//
// Architecture (modelled on how category-leader enterprise AI sites are built):
//   ticker -> hero (category claim) -> trust bar -> what we do (4 pillars)
//   -> the platform (dark register) -> proof numbers -> flagship vertical
//   -> origins / Botella AI Labs (dark register) -> insights hub -> FAQ
//   -> closing conversion + kinetic mantra -> footer
//
// The landing page sells exactly one thing: Retail AI. The other Botella AI
// Labs products live on /company, where they are context rather than a
// competing pitch.
//
// Everything on this page is either sourced from Botella AI Labs' own product
// copy or from the existing botella.ai site. No invented logos, customer
// counts, awards, analyst ratings or testimonials - where proof is thin the
// design gets quieter rather than louder.
// -----------------------------------------------------------------------------

import React, { useEffect, useRef } from 'react';
import { useLocation, Link } from 'react-router-dom';
import useSEO from '../utils/useSEO';
import SiteHeader from '../components/SiteHeader';
import SiteFooter from '../components/SiteFooter';
import { useDemoPopup } from '../components/DemoPopupContext';
import JsonLd, { buildFaqSchema } from '../components/JsonLd';
import BackToTop from '../components/BackToTop';
import ShelfSignal from '../components/ShelfSignal';
import AdvisorAvatar from '../components/AdvisorAvatar';
import useBxReveal from '../utils/useBxReveal';
import { BLOG_POSTS } from '../data/blogPosts';
import '../components/SiteHeader.css';
import '../components/SiteFooter.css';
import '../styles/brand.css';
import './HomePage.css';
import './AdvisorsPage.css';

/* ── The four capability pillars. Outcome verbs only - no feature jargon. ── */
const PILLARS = [
  {
    n: '01',
    t: 'Inventory Intelligence',
    d: 'Botella watches every SKU. It flags what is running out, what has stopped moving, and what deserves the shelf space instead.',
    to: '/ai-inventory-management-liquor-stores',
    tone: 'violet',
  },
  {
    n: '02',
    t: 'Demand Signal',
    d: 'Surface the patterns already sitting inside your sales history - what sells when, in which basket, at which price.',
    to: '/liquor-store-sales-analytics-insights',
    tone: 'cyan',
  },
  {
    n: '03',
    t: 'Customer Engagement',
    d: 'Email, WhatsApp and social outreach that fires on real purchase behaviour instead of a marketing calendar.',
    to: '/customer-insights-liquor-stores',
    tone: 'jade',
  },
  {
    n: '04',
    t: 'Margin Command',
    d: 'See profit by product, category and hour. Know which shelf earns, which one leaks, and what to do about it today.',
    to: '/margin-optimization-liquor-stores',
    tone: 'fuchsia',
  },
];

/* ── What the platform connects / automates / surfaces. ─────────────────── */
const PLATFORM_LAYERS = [
  {
    k: 'Connects',
    items: ['Point of sale', 'Inventory & stock ledger', 'Sales history', 'Customer records', 'Supplier catalog'],
  },
  {
    k: 'Automates',
    items: ['Reorder alerts', 'Customer follow-ups', 'Marketing & social posts', 'Daily and weekly reporting', 'Operational task lists'],
  },
  {
    k: 'Surfaces',
    items: ['Dead stock', 'Peak trading hours', 'Margin leaks', 'Top customers', 'Category performance'],
  },
];

/* ── Advisors shown in the homepage strip. Full detail lives on /advisors;
      keep this in step with ADVISORS in pages/AdvisorsPage.js. ─────────────── */
const HOME_ADVISORS = [
  { name: 'Anirudh Reddy', img: '/advisors/anirudh-reddy.jpg' },
  { name: 'AJ Stetz', img: '/advisors/aj-stetz.jpg' },
];

/* ── Research pillars from Botella AI Labs, translated into buyer benefit. ─ */
const LABS_PILLARS = [
  {
    t: 'Local-first AI',
    d: 'Intelligence that can run where the data already lives. Your store data does not have to leave your store to be useful.',
  },
  {
    t: 'Privacy-first AI',
    d: 'Customer records stay yours. Architecture designed around what should never be shipped to a third party.',
  },
  {
    t: 'Energy-efficient LLMs',
    d: 'Frontier capability engineered to run lean - on modest hardware, and on a retailer budget.',
  },
  {
    t: 'On-device AI',
    d: 'Built to work at the counter, not only in a datacentre. Latency you feel and uptime you can trust.',
  },
];

/* ── The conversations Retail AI has to own. Each pill routes to the page or
      article that actually covers it - no dead links. ──────────────────── */
const INSIGHT_TOPICS = [
  { t: 'Dead Stock', to: '/ai-inventory-management-liquor-stores' },
  { t: 'Demand Volatility', to: '/liquor-store-sales-analytics-insights' },
  { t: 'Pricing Power', to: '/margin-optimization-liquor-stores' },
  { t: 'Customer Retention', to: '/customer-insights-liquor-stores' },
  { t: 'Shelf Productivity', to: '/ai-product-recommendations-liquor-stores' },
  { t: 'AI in the Aisle', to: '/ai-agent-for-liquor-stores' },
];

/* ── FAQ - preserved from the existing site so the FAQPage rich result and
      the visible copy stay in lockstep. ──────────────────────────────────── */
const HOME_FAQS = [
  {
    q: 'What is Retail AI?',
    a: 'Retail AI is artificial intelligence applied to the operating decisions of a physical store - what to stock, what to reorder, what to promote, who to talk to, and where margin is being made or lost. Botella delivers it as one platform rather than a set of disconnected reports.',
  },
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
    a: 'Botella AI identifies trends, surfaces patterns in demand, and alerts you before products run out.',
  },
  {
    q: 'Can Botella AI improve liquor store sales?',
    a: 'Yes. It identifies trends, recommends profitable products, automates follow-ups, and improves customer engagement.',
  },
];

function HomePage() {
  const location = useLocation();
  const { openDemoPopup } = useDemoPopup();

  useSEO({
    title: 'Botella | The Retail AI Company',
    description:
      'Botella is the Retail AI platform - one AI operating system that automates inventory, surfaces demand patterns, engages customers and protects margin. Proven in liquor and beverage retail. Built by Botella AI Labs.',
    canonical: 'https://botella.ai/',
  });

  // Scroll reveals for every .bx-reveal element on the page.
  useBxReveal();

  // Deep links from other pages arrive as /#section - wait a tick for the
  // section to mount, then scroll to it.
  useEffect(() => {
    if (!location.hash) return;
    const id = location.hash.replace('#', '');
    const t = setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
    }, 90);
    return () => clearTimeout(t);
  }, [location.hash]);

  const mantraRef = useRef(null);

  const openPopup = (e) => {
    e.preventDefault();
    openDemoPopup();
  };

  const posts = BLOG_POSTS.slice(0, 4);

  return (
    <div className="lp bx">
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <JsonLd data={buildFaqSchema(HOME_FAQS)} />

      <SiteHeader />

      {/* ══════════════════════════════════════════════════════════════════
          HERO - the category claim. One H1, one subhead, one primary CTA,
          and the signature visual. Nothing else competes for attention.
         ══════════════════════════════════════════════════════════════════ */}
      <header className="hp-hero" id="main-content" tabIndex={-1}>
        <div className="hp-hero-glow" aria-hidden="true" />
        <div className="bx-wrap hp-hero-inner">
          <div className="hp-hero-copy">
            <span className="bx-eyebrow bx-rise" style={{ '--bx-delay': '0.05s' }}>
              Retail AI
            </span>

            <h1 className="bx-display hp-hero-h1 bx-rise" style={{ '--bx-delay': '0.12s' }}>
              Leading the AI<br />
              Future of <span className="bx-em">Retail</span>
            </h1>

            <p className="bx-lead hp-hero-sub bx-rise" style={{ '--bx-delay': '0.24s' }}>
              One AI operating system for the store floor. Botella automates
              inventory, surfaces the demand hiding in your own data, engages
              every customer, and defends margin - shelf by shelf, hour by hour.
            </p>

            <div className="hp-hero-cta bx-rise" style={{ '--bx-delay': '0.34s' }}>
              <button type="button" className="bx-btn bx-btn-primary" onClick={openPopup}>
                See Botella in Action
              </button>
              <Link to="/platform" className="bx-btn bx-btn-ghost">
                Explore the Platform
                <span className="bx-link-arrow" aria-hidden="true">→</span>
              </Link>
            </div>

            <p className="hp-hero-foot bx-rise" style={{ '--bx-delay': '0.44s' }}>
              <span className="bx-dot bx-dot-pulse hp-live-dot" aria-hidden="true" />
              In production today across liquor and beverage retail. Built by{' '}
              <a href="https://botellalabs.ai" target="_blank" rel="noopener noreferrer">Botella AI Labs</a>
            </p>
          </div>

          {/* SIGNATURE ELEMENT - the live store-intelligence visualization.
              Reused once more inside the Platform section, and nowhere else. */}
          <div className="hp-hero-visual bx-rise" style={{ '--bx-delay': '0.3s' }}>
            <ShelfSignal />
          </div>
        </div>
      </header>

      {/* ══════════════════════════════════════════════════════════════════
          TRUST BAR - proof before explanation. Honest proof: what is true
          about how the product is built and deployed, not borrowed logos.
         ══════════════════════════════════════════════════════════════════ */}
      <section className="hp-trust" aria-label="Why retailers trust Botella">
        <div className="bx-wrap hp-trust-inner">
          <p className="hp-trust-claim bx-reveal">
            Retail AI, running in real stores - not in a pitch deck.
          </p>
          <ul className="hp-trust-list">
            {[
              ['Live in production', 'Running against real store data every day.'],
              ['Frontier AI research', 'Built inside an AI research lab, not assembled from APIs.'],
              ['Privacy-first by design', 'Your sales and customer data stay yours.'],
              ['Live in under a week', 'Connected, analysing and automating in days.'],
            ].map(([t, d], i) => (
              <li key={t} className="bx-reveal" style={{ '--bx-delay': `${i * 0.07}s` }}>
                <span className="hp-trust-t">{t}</span>
                <span className="hp-trust-d">{d}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════════
          WHAT WE DO - one unifying sentence, then exactly four pillars.
         ══════════════════════════════════════════════════════════════════ */}
      <section className="bx-sec hp-pillars" id="what-we-do">
        <div className="bx-wrap">
          <div className="hp-sec-head bx-reveal">
            <span className="bx-eyebrow">What Botella Does</span>
            <h2 className="bx-h2">
              Botella unifies inventory, sales, customers and supplier data into
              one system that <span className="bx-em">acts</span>.
            </h2>
            <p className="bx-lead hp-sec-lead">
              Most retail software reports what already happened. Botella reads
              the same data and does the next thing - the reorder, the message,
              the price check, the report - so the store runs proactively
              instead of reactively.
            </p>
          </div>

          <div className="hp-pillar-grid">
            {PILLARS.map((p, i) => (
              <Link
                key={p.t}
                to={p.to}
                className={`hp-pillar bx-reveal hp-tone-${p.tone}`}
                style={{ '--bx-delay': `${i * 0.08}s` }}
              >
                <span className="hp-pillar-n">{p.n}</span>
                <h3 className="bx-h3 hp-pillar-t">{p.t}</h3>
                <p className="hp-pillar-d">{p.d}</p>
                <span className="bx-link hp-pillar-link">
                  Go deeper <span className="bx-link-arrow" aria-hidden="true">→</span>
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════════
          THE PLATFORM - dark register. One name, one narrative.
         ══════════════════════════════════════════════════════════════════ */}
      <section className="bx-sec bx-sec-dark hp-platform" id="platform">
        <div className="bx-wrap">
          <div className="hp-platform-head bx-reveal">
            <span className="bx-eyebrow">The Platform</span>
            <h2 className="bx-h2">
              Botella - the AI operating system<br />for <span className="bx-em">retail</span>.
            </h2>
            <p className="bx-lead">
              One platform, one name, one place the whole store is understood.
              Botella connects to the systems you already run, learns the shape
              of your business from your own history, and then works the floor
              with you - every day, without being asked.
            </p>
          </div>

          <div className="hp-platform-body">
            <div className="hp-platform-layers">
              {PLATFORM_LAYERS.map((layer, i) => (
                <div key={layer.k} className="hp-layer bx-reveal" style={{ '--bx-delay': `${i * 0.1}s` }}>
                  <div className="hp-layer-k">{layer.k}</div>
                  <ul className="hp-layer-list">
                    {layer.items.map((it) => (
                      <li key={it}>{it}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            <div className="hp-platform-visual bx-reveal">
              <ShelfSignal variant="console" />
            </div>
          </div>

          <div className="hp-platform-foot bx-reveal">
            <p className="hp-platform-quote">
              An agent is not useful because it is an agent. It is useful because
              it does one part of your operation reliably, end to end.
            </p>
            <Link to="/platform" className="bx-btn bx-btn-ghost">
              Inside the platform
              <span className="bx-link-arrow" aria-hidden="true">→</span>
            </Link>
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════════
          NUMBERS - the outcomes retailers running Botella report.
         ══════════════════════════════════════════════════════════════════ */}
      <section className="bx-sec bx-sec-tint hp-numbers" id="results">
        <div className="bx-wrap">
          <div className="hp-sec-head hp-sec-head-center bx-reveal">
            <span className="bx-eyebrow">Results</span>
            <h2 className="bx-h2">What changes when the store <span className="bx-em">knows first</span>.</h2>
          </div>
          <div className="hp-num-grid">
            {[
              { n: '30%', l: 'Average reduction in stockouts' },
              { n: '15%', l: 'Average margin improvement' },
              { n: '40%', l: 'Less time spent on admin work' },
              { n: 'Day 1', l: 'Useful from the first connection' },
            ].map((m, i) => (
              <div key={m.l} className="hp-num bx-reveal" style={{ '--bx-delay': `${i * 0.08}s` }}>
                <div className="hp-num-n">{m.n}</div>
                <div className="hp-num-l">{m.l}</div>
              </div>
            ))}
          </div>
          <p className="hp-num-note bx-reveal">
            Outcomes reported by liquor retailers running Botella. Your numbers
            depend on your catalog, your data and your trading pattern.
          </p>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════════
          FLAGSHIP VERTICAL - where Retail AI runs today.
         ══════════════════════════════════════════════════════════════════ */}
      <section className="bx-sec hp-vertical" id="verticals">
        <div className="bx-wrap">
          <div className="hp-vert-grid">
            <div className="hp-vert-lead bx-reveal">
              <span className="bx-eyebrow">Flagship Vertical</span>
              <h2 className="bx-h2">
                Liquor &amp; beverage retail is where Retail AI <span className="bx-em">runs today</span>.
              </h2>
              <p className="bx-lead">
                Thousands of SKUs. Thin margins. Demand that swings on a
                holiday, a heatwave or a fixture list. Liquor retail is the
                hardest operating problem on the high street - which is exactly
                why we built here first, and why the platform that survives it
                travels well.
              </p>
              <div className="hp-vert-cta">
                <Link to="/ai-agent-for-liquor-stores" className="bx-btn bx-btn-primary bx-btn-sm">
                  See the liquor retail build
                </Link>
                <Link to="/ai-for-liquor-retailers" className="bx-link">
                  For multi-store retailers <span className="bx-link-arrow" aria-hidden="true">→</span>
                </Link>
              </div>
            </div>

            <ul className="hp-vert-map">
              <li className="hp-vert-card is-live bx-reveal">
                <span className="bx-pill bx-pill-live">
                  <span className="bx-dot bx-dot-pulse" aria-hidden="true" />In production
                </span>
                <h3 className="bx-h3">Liquor &amp; Beverage Retail</h3>
                <p>
                  Single stores and multi-store operators. Inventory, demand,
                  customers, marketing and margin - all running on Botella.
                </p>
              </li>
              <li className="hp-vert-card bx-reveal" style={{ '--bx-delay': '0.1s' }}>
                <span className="bx-pill bx-pill-soon">Category-agnostic core</span>
                <h3 className="bx-h3">The rest of physical retail</h3>
                <p>
                  The platform reads any catalog with SKUs, sales history and
                  customers. If that describes your shelves, the same engine
                  applies. Tell us the vertical and we will scope a pilot.
                </p>
                <button type="button" className="bx-link hp-vert-link" onClick={openPopup}>
                  Scope a pilot <span className="bx-link-arrow" aria-hidden="true">→</span>
                </button>
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════════
          ORIGINS - built by Botella AI Labs. Dark register, cinematic.
         ══════════════════════════════════════════════════════════════════ */}
      <section className="bx-sec bx-sec-dark hp-origins" id="origins">
        <div className="hp-origins-grain" aria-hidden="true" />
        <div className="bx-wrap">
          <div className="hp-origins-head bx-reveal">
            <span className="bx-eyebrow">Origins</span>
            <h2 className="bx-h2">
              Built by <span className="bx-em">Botella AI Labs</span>.
            </h2>
            <p className="bx-lead hp-origins-lead">
              Botella did not start as retail software. It started as an AI
              research and technology company building frontier AI, agentic
              systems, products and datasets - then pointed that work at the
              hardest problem we could find: the physical store.
            </p>
          </div>

          <div className="hp-origins-grid">
            {LABS_PILLARS.map((p, i) => (
              <div key={p.t} className="hp-origin bx-reveal" style={{ '--bx-delay': `${i * 0.08}s` }}>
                <h3 className="bx-h3">{p.t}</h3>
                <p>{p.d}</p>
              </div>
            ))}
          </div>

          <div className="hp-origins-foot bx-reveal">
            <blockquote className="hp-proof">
              Botella AI is a product we designed and built from our own research
              and direct customer feedback, now running in production. A real
              example of how we work.
              <cite>Botella AI Labs</cite>
            </blockquote>
            <div className="hp-origins-actions">
              <Link to="/company" className="bx-btn bx-btn-ghost bx-btn-sm">Our story</Link>
              <a
                href="https://botellalabs.ai"
                target="_blank"
                rel="noopener noreferrer"
                className="bx-link"
              >
                botellalabs.ai <span className="bx-link-arrow" aria-hidden="true">↗</span>
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════════
          ADVISORS - the people guiding Botella. A compact strip that hands off
          to the full /advisors page.
         ══════════════════════════════════════════════════════════════════ */}
      <section className="bx-sec hp-advisors" id="advisors">
        <div className="bx-wrap bx-wrap-narrow hp-advisors-inner bx-reveal">
          <span className="bx-eyebrow">Advisors</span>
          <h2 className="bx-h2">Guided by people who have <span className="bx-em">done it</span>.</h2>
          <p className="bx-lead hp-advisors-lead">
            Operators and builders who have scaled products, teams and retail
            businesses help keep Botella honest and close to the people it is
            built for.
          </p>
          <div className="hp-advisors-faces">
            {HOME_ADVISORS.map((a) => (
              <div key={a.name} className="hp-advisor-face">
                <AdvisorAvatar name={a.name} img={a.img} />
                <span className="hp-advisor-name">{a.name}</span>
              </div>
            ))}
          </div>
          <Link to="/advisors" className="bx-btn bx-btn-ghost bx-btn-sm">Meet the board</Link>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════════
          THINK AHEAD - the category's conversations.
         ══════════════════════════════════════════════════════════════════ */}
      <section className="bx-sec bx-sec-tint hp-insights" id="insights">
        <div className="bx-wrap">
          <div className="hp-sec-head bx-reveal">
            <span className="bx-eyebrow">Think Ahead</span>
            <h2 className="bx-h2">The questions retail is <span className="bx-em">asking now</span>.</h2>
          </div>

          <div className="hp-topics bx-reveal">
            {INSIGHT_TOPICS.map((t) => (
              <Link key={t.t} to={t.to} className="bx-pill hp-topic">{t.t}</Link>
            ))}
          </div>

          <div className="hp-post-grid">
            {posts.map((p, i) => (
              <Link
                key={p.slug}
                to={`/blog/${p.slug}`}
                className="hp-post bx-reveal"
                style={{ '--bx-delay': `${i * 0.07}s` }}
              >
                <span className="hp-post-cat">{p.category}</span>
                <h3 className="bx-h3 hp-post-t">{p.title}</h3>
                <p className="hp-post-x">{p.excerpt}</p>
                <span className="hp-post-meta">{p.readMins} min read</span>
              </Link>
            ))}
          </div>

          <div className="hp-insights-foot bx-reveal">
            <Link to="/blog" className="bx-btn bx-btn-ghost bx-btn-sm">
              All insights <span className="bx-link-arrow" aria-hidden="true">→</span>
            </Link>
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════════
          FAQ
         ══════════════════════════════════════════════════════════════════ */}
      <section className="bx-sec hp-faq" id="faq">
        <div className="bx-wrap hp-faq-grid">
          <div className="hp-faq-head bx-reveal">
            <span className="bx-eyebrow">FAQ</span>
            <h2 className="bx-h2">Straight <span className="bx-em">answers</span>.</h2>
            <p className="bx-lead">
              Still have a question? <button type="button" className="hp-inline-btn" onClick={openPopup}>Ask us directly</button>.
            </p>
          </div>
          <dl className="hp-faq-list">
            {HOME_FAQS.map((f, i) => (
              <div key={f.q} className="hp-faq-item bx-reveal" style={{ '--bx-delay': `${i * 0.05}s` }}>
                <dt>{f.q}</dt>
                <dd>{f.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════════
          CLOSING CONVERSION + KINETIC MANTRA
         ══════════════════════════════════════════════════════════════════ */}
      <section className="bx-sec bx-sec-dark hp-close" id="demo">
        <div className="bx-wrap hp-close-inner">
          <div className="bx-reveal">
            <span className="bx-eyebrow">Live Look</span>
            <h2 className="bx-h2 hp-close-h">
              See Botella <span className="bx-em">in action</span>.
            </h2>
            <p className="bx-lead">
              Thirty minutes, your data, your shelves. We connect Botella to a
              slice of your store and show you what it finds before you decide
              anything.
            </p>
            <div className="hp-close-cta">
              <button type="button" className="bx-btn bx-btn-primary" onClick={openPopup}>
                Book a demo
              </button>
              <Link to="/contact" className="bx-btn bx-btn-ghost">Talk to the team</Link>
            </div>
            <p className="hp-close-note">
              No commitment &middot; 30-day free trial &middot; Setup in under a week
            </p>
          </div>
        </div>

        {/* Kinetic brand mantra - the page's signature motion moment. */}
        <div className="hp-mantra" ref={mantraRef} aria-hidden="true">
          <div className="hp-mantra-track">
            {Array.from({ length: 6 }).map((_, i) => (
              <span key={i} className="hp-mantra-word">
                Know First<span className="hp-mantra-sep">*</span>
              </span>
            ))}
          </div>
        </div>
        <p className="hp-mantra-sr">Know first. Act first.</p>
      </section>

      <SiteFooter />
      <BackToTop />
    </div>
  );
}

export default HomePage;
