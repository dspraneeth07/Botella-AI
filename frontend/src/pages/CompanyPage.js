// CompanyPage.js
// -----------------------------------------------------------------------------
// /company - Origins. The credibility layer.
//
// Botella is a product of Botella AI Labs, an AI research and technology
// company building frontier AI, agentic systems, products, datasets and AI
// solutions. This page tells that story the way an enterprise buyer reads it:
// this product stands on real research, and the research themes - local-first,
// privacy-first, on-device, energy-efficient - are commercial advantages for a
// retailer, not lab trivia.
//
// Every product status and every service description here is stated exactly as
// Botella AI Labs states it.
// -----------------------------------------------------------------------------

import React from 'react';
import { Link } from 'react-router-dom';
import useSEO from '../utils/useSEO';
import SiteHeader from '../components/SiteHeader';
import SiteFooter from '../components/SiteFooter';
import BackToTop from '../components/BackToTop';
import { useDemoPopup } from '../components/DemoPopupContext';
import useBxReveal from '../utils/useBxReveal';
import useScrollTop from '../utils/useScrollTop';
import '../components/SiteHeader.css';
import '../components/SiteFooter.css';
import '../styles/brand.css';
import './HomePage.css';
import './SubPage.css';

const PILLARS = [
  {
    t: 'Local-first AI',
    lab: 'Intelligence that runs where the data already lives.',
    buyer: 'Your store data does not have to leave your store to be useful.',
  },
  {
    t: 'Privacy-first AI',
    lab: 'Systems designed around what should never be shipped to a third party.',
    buyer: 'Customer records stay yours. Nothing is harvested to train someone else.',
  },
  {
    t: 'Energy-efficient LLMs',
    lab: 'Frontier capability engineered to run lean.',
    buyer: 'Real AI on modest hardware and a retail budget - not a datacentre bill.',
  },
  {
    t: 'On-device AI',
    lab: 'Inference at the edge, not only in the cloud.',
    buyer: 'Works at the counter. Latency you feel, uptime you can trust.',
  },
];

const PRODUCTS = [
  {
    name: 'Botella AI',
    status: 'In production',
    live: true,
    d: 'An AI operating system for liquor retail that automates inventory, customer engagement and daily operations using real-time store data. It analyzes inventory, sales trends and customer behaviour to automate the work that eats a store owner’s day - restocking alerts, customer follow-ups, marketing and performance reporting - so the store runs proactively instead of reactively.',
  },
  {
    name: 'FlowOS',
    status: 'In production',
    live: true,
    d: 'A platform for building and deploying AI-powered agents and workflows, pairing a visual builder with built-in API and MCP servers that turn every workflow into a tool for any stack. Full source-code access, an interactive playground for step-by-step testing, and multi-agent orchestration with conversation management and retrieval - shipped as an API, MCP server or exportable JSON.',
  },
  {
    name: 'Aura',
    status: 'Coming soon',
    live: false,
    d: 'Your AI marketing team, always on. An autonomous marketing agent that tracks the trends and competitors in your space, drafts on-brand content and publishes it, so marketing runs every day without adding headcount.',
  },
  {
    name: 'AirDrive',
    status: 'Coming soon',
    live: false,
    d: 'AirDrive is in development. We will share what it does and who it is for closer to launch.',
  },
];

const SERVICES = [
  {
    n: '01',
    t: 'AI Agent Development',
    d: 'Agents scoped to a specific business function - customer operations, internal workflows, data analysis, decision support - built on your data, your systems and your constraints, not a generic template.',
    note: 'An agent is not useful because it is an agent. It is useful because it does one part of your operation reliably, end to end.',
  },
  {
    n: '02',
    t: 'Agentic Solutions',
    d: 'Multi-agent systems for operations that involve several coordinated decisions: one agent monitoring, one analyzing, one executing - with verifiable reasoning chains and clear points of human oversight.',
    note: 'Architected the way we architect our own research, not as an opaque pipeline.',
  },
  {
    n: '03',
    t: 'AI-Integrated Product & Platform Development',
    d: 'Software and SaaS platforms with AI capability engineered in from the architecture stage. We scope the intelligence layer as a core requirement on day one, not an API call added late.',
    note: 'We design the system and the intelligence layer together.',
  },
];

const ENGAGE = [
  ['Scope', 'We start with your actual operational requirement, not a product pitch. What decision, workflow or system needs to change?'],
  ['Design', 'We architect the solution - agent, multi-agent system or platform - against your constraints: data, infrastructure, privacy and compute.'],
  ['Build & Deploy', 'We build and deploy into your environment, held to the same efficiency and auditability standards as our own research.'],
  ['Support', 'Every engagement includes ongoing support as requirements evolve. This is not a handoff-and-disappear model.'],
];

function CompanyPage() {
  const { openDemoPopup } = useDemoPopup();
  useScrollTop();
  useBxReveal();

  useSEO({
    title: 'Our Story | Built by Botella AI Labs',
    description:
      'Botella is built by Botella AI Labs, an AI research and technology company working on frontier AI, agentic systems, datasets and local-first, privacy-first, energy-efficient AI.',
    canonical: 'https://botella.ai/company',
  });

  const demo = (e) => { e.preventDefault(); openDemoPopup(); };

  return (
    <div className="lp bx">
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <SiteHeader />

      {/* HERO */}
      <header className="sp-hero sp-hero-center" id="main-content" tabIndex={-1}>
        <div className="hp-hero-glow" aria-hidden="true" />
        <div className="bx-wrap bx-wrap-narrow">
          <span className="bx-eyebrow bx-rise" style={{ '--bx-delay': '0.05s' }}>Origins</span>
          <h1 className="bx-h1 bx-rise" style={{ '--bx-delay': '0.12s' }}>
            Built by <span className="bx-em">Botella AI Labs</span>.
          </h1>
          <p className="bx-lead bx-rise" style={{ '--bx-delay': '0.22s' }}>
            Botella did not start as retail software. It started as an AI
            research and technology company building frontier AI, agentic
            systems, products, datasets and AI solutions - and then pointed that
            work at the hardest operating problem we could find: the physical
            store.
          </p>
          <div className="sp-hero-cta bx-rise" style={{ '--bx-delay': '0.3s' }}>
            <a
              className="bx-btn bx-btn-primary"
              href="https://botellalabs.ai"
              target="_blank"
              rel="noopener noreferrer"
            >
              Visit Botella AI Labs <span aria-hidden="true">↗</span>
            </a>
            <Link to="/platform" className="bx-btn bx-btn-ghost">See the platform</Link>
          </div>
        </div>
      </header>

      {/* RESEARCH PILLARS */}
      <section className="bx-sec bx-sec-dark">
        <div className="bx-wrap">
          <div className="hp-sec-head bx-reveal">
            <span className="bx-eyebrow">Research</span>
            <h2 className="bx-h2">Four convictions, and what they mean <span className="bx-em">for your store</span>.</h2>
          </div>
          <div className="sp-pillar-grid">
            {PILLARS.map((p, i) => (
              <article key={p.t} className="sp-pillar bx-reveal" style={{ '--bx-delay': `${i * 0.08}s` }}>
                <h3 className="bx-h3">{p.t}</h3>
                <p className="sp-pillar-lab">{p.lab}</p>
                <p className="sp-pillar-buyer">{p.buyer}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* PROOF */}
      <section className="bx-sec">
        <div className="bx-wrap bx-wrap-narrow sp-quote bx-reveal">
          <blockquote className="hp-proof">
            Botella AI is a product we designed and built from our own research
            and direct customer feedback, now running in production. A real
            example of how we work.
            <cite>Botella AI Labs</cite>
          </blockquote>
        </div>
      </section>

      {/* PRODUCTS */}
      <section className="bx-sec bx-sec-tint">
        <div className="bx-wrap">
          <div className="hp-sec-head bx-reveal">
            <span className="bx-eyebrow">Products</span>
            <h2 className="bx-h2">What the Labs <span className="bx-em">ships</span>.</h2>
          </div>
          <div className="sp-prod-list">
            {PRODUCTS.map((p, i) => (
              <article key={p.name} className="sp-prod bx-reveal" style={{ '--bx-delay': `${i * 0.06}s` }}>
                <div className="sp-prod-l">
                  <h3 className="bx-h3">{p.name}</h3>
                  <span className={`hp-labs-status ${p.live ? 'is-live' : ''}`}>
                    {p.live && <span className="bx-dot" aria-hidden="true" />}
                    {p.status}
                  </span>
                </div>
                <p className="sp-prod-d">{p.d}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* SERVICES */}
      <section className="bx-sec">
        <div className="bx-wrap">
          <div className="hp-sec-head bx-reveal">
            <span className="bx-eyebrow">Services</span>
            <h2 className="bx-h2">Frontier capability, applied to <span className="bx-em">your problem</span>.</h2>
            <p className="bx-lead hp-sec-lead">
              Not every organization needs a research lab, but every organization
              can benefit from what one produces. We do not sell fixed packages -
              we scope, design and build around what your organization actually
              needs.
            </p>
          </div>
          <div className="sp-svc-grid">
            {SERVICES.map((s, i) => (
              <article key={s.t} className="sp-svc bx-reveal" style={{ '--bx-delay': `${i * 0.08}s` }}>
                <span className="sp-step-n">{s.n}</span>
                <h3 className="bx-h3">{s.t}</h3>
                <p>{s.d}</p>
                <p className="sp-svc-note">{s.note}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ENGAGEMENT */}
      <section className="bx-sec bx-sec-dark">
        <div className="bx-wrap">
          <div className="hp-sec-head bx-reveal">
            <span className="bx-eyebrow">How we engage</span>
            <h2 className="bx-h2">Process, <span className="bx-em">not a menu</span>.</h2>
          </div>
          <ol className="sp-steps">
            {ENGAGE.map(([t, d], i) => (
              <li key={t} className="sp-step bx-reveal" style={{ '--bx-delay': `${i * 0.08}s` }}>
                <span className="sp-step-n">{`0${i + 1}`}</span>
                <h3 className="bx-h3">{t}</h3>
                <p>{d}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* CTA */}
      <section className="bx-sec sp-cta">
        <div className="bx-wrap bx-wrap-narrow sp-cta-inner bx-reveal">
          <span className="bx-eyebrow">Have a requirement in mind?</span>
          <h2 className="bx-h2">Every engagement starts with a <span className="bx-em">conversation</span>.</h2>
          <p className="bx-lead">
            Not a menu of pre-built packages. Tell us your requirement and we
            will scope a pilot around it.
          </p>
          <div className="sp-hero-cta">
            <button type="button" className="bx-btn bx-btn-primary" onClick={demo}>Book a pilot call</button>
            <Link to="/contact" className="bx-btn bx-btn-ghost">Contact us</Link>
          </div>
        </div>
      </section>

      <SiteFooter />
      <BackToTop />
    </div>
  );
}

export default CompanyPage;
