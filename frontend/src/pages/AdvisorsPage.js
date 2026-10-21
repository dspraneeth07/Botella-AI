// AdvisorsPage.js
// -----------------------------------------------------------------------------
// /advisors - Board of Advisors. The credibility layer, made human.
//
// Sits under Company in the nav, alongside /company (Our Story). Where the
// Company page tells you the research the product stands on, this page tells
// you the people guiding it. Same bx design system as the rest of the public
// site (SiteHeader / SiteFooter chrome, bx-* type + reveal animations).
//
// PHOTOS: each advisor's headshot lives in /public/advisors/<slug>.jpg and is
// referenced by `img` below. If the file is not present the <Avatar> falls
// back to a branded initials tile, so the page never shows a broken image
// while photos are still being gathered. Drop a correctly named file into
// public/advisors/ to light up a real photo (see public/advisors/README.txt).
//
// BIOS: role/bio copy is intentionally neutral placeholder text. Replace the
// `role` and `bio` fields with each advisor's real title and background - the
// LinkedIn link carries the authoritative detail in the meantime.
// -----------------------------------------------------------------------------

import React from 'react';
import { Link } from 'react-router-dom';
import useSEO from '../utils/useSEO';
import SiteHeader from '../components/SiteHeader';
import SiteFooter from '../components/SiteFooter';
import BackToTop from '../components/BackToTop';
import AdvisorAvatar from '../components/AdvisorAvatar';
import { useDemoPopup } from '../components/DemoPopupContext';
import useBxReveal from '../utils/useBxReveal';
import useScrollTop from '../utils/useScrollTop';
import '../components/SiteHeader.css';
import '../components/SiteFooter.css';
import '../styles/brand.css';
import './HomePage.css';
import './SubPage.css';
import './AdvisorsPage.css';

// One entry per advisor. Add a third by appending an object here - the grid
// reflows on its own, no layout change needed. `img` is optional; omit it (or
// leave the file absent) to fall back to the initials avatar.
const ADVISORS = [
  {
    name: 'Anirudh Reddy',
    role: 'Advisor',                       // TODO: replace with real title
    bio: 'Strategic advisor to Botella AI, guiding product direction and go-to-market for AI in retail.', // TODO: real bio
    img: '/advisors/anirudh-reddy.jpg',
    linkedin: 'https://www.linkedin.com/in/reddyanirudh/',
  },
  {
    name: 'AJ Stetz',
    role: 'Advisor',                       // TODO: replace with real title
    bio: 'Advisor to Botella AI on scaling operations and commercial strategy.', // TODO: real bio
    img: '/advisors/aj-stetz.jpg',         // placeholder until a headshot is added
    linkedin: 'https://www.linkedin.com/in/aj-stetz-36a34437',
  },
];

function AdvisorsPage() {
  const { openDemoPopup } = useDemoPopup();
  useScrollTop();
  useBxReveal();

  useSEO({
    title: 'Board of Advisors | Botella AI',
    description:
      'The advisors guiding Botella AI - the AI operating system for liquor and beverage retail, built by Botella AI Labs.',
    canonical: 'https://botella.ai/advisors',
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
          <span className="bx-eyebrow bx-rise" style={{ '--bx-delay': '0.05s' }}>Advisors</span>
          <h1 className="bx-h1 bx-rise" style={{ '--bx-delay': '0.12s' }}>
            The people <span className="bx-em">guiding Botella</span>.
          </h1>
          <p className="bx-lead bx-rise" style={{ '--bx-delay': '0.22s' }}>
            Botella is built by Botella AI Labs and shaped by operators and
            builders who have scaled products, teams and retail businesses. Our
            board of advisors keeps the work honest, ambitious and close to the
            people it is built for.
          </p>
        </div>
      </header>

      {/* ADVISOR GRID */}
      <section className="bx-sec">
        <div className="bx-wrap">
          <div className="hp-sec-head bx-reveal">
            <span className="bx-eyebrow">Board of Advisors</span>
            <h2 className="bx-h2">Experience behind <span className="bx-em">the product</span>.</h2>
          </div>

          <div className="adv-grid">
            {ADVISORS.map((a, i) => (
              <article
                key={a.name}
                className="adv-card bx-reveal"
                style={{ '--bx-delay': `${i * 0.08}s` }}
              >
                <AdvisorAvatar name={a.name} img={a.img} />
                <div className="adv-card-body">
                  <h3 className="adv-name">{a.name}</h3>
                  <p className="adv-role">{a.role}</p>
                  <p className="adv-bio">{a.bio}</p>
                  {a.linkedin && (
                    <a
                      className="adv-linkedin"
                      href={a.linkedin}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`${a.name} on LinkedIn`}
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
                        <path
                          fill="currentColor"
                          d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.13 1.45-2.13 2.94v5.67H9.35V9h3.42v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.55V9h3.57v11.45zM22.22 0H1.77C.8 0 0 .78 0 1.73v20.53C0 23.22.8 24 1.77 24h20.45c.98 0 1.78-.78 1.78-1.74V1.73C24 .78 23.2 0 22.22 0z"
                        />
                      </svg>
                      <span>LinkedIn</span>
                      <span className="bx-link-arrow" aria-hidden="true">↗</span>
                    </a>
                  )}
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="bx-sec sp-cta">
        <div className="bx-wrap bx-wrap-narrow sp-cta-inner bx-reveal">
          <span className="bx-eyebrow">Building something ambitious?</span>
          <h2 className="bx-h2">Come build it <span className="bx-em">with us</span>.</h2>
          <p className="bx-lead">
            Whether you run a store, a chain, or a team that wants frontier AI
            applied to a real operating problem - we would like to talk.
          </p>
          <div className="sp-hero-cta">
            <button type="button" className="bx-btn bx-btn-primary" onClick={demo}>Book a call</button>
            <Link to="/company" className="bx-btn bx-btn-ghost">Our story</Link>
          </div>
        </div>
      </section>

      <SiteFooter />
      <BackToTop />
    </div>
  );
}

export default AdvisorsPage;
