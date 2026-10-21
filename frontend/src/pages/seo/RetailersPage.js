// RetailersPage.js
// -----------------------------------------------------------------------------
// /ai-for-liquor-retailers
//
// Body content rewritten to match the v3 SEO doc verbatim. Only the obvious
// sed-artifact phrases ("identify trends surface patterns highlight changes…")
// have been cleaned to read as natural English; all other copy is the doc's
// exact wording. Visual structure (hero, sections, final CTA) is preserved.
// -----------------------------------------------------------------------------

import React from 'react';
import ContentLayout from '../../components/ContentLayout';
import { useDemoPopup } from '../../components/DemoPopupContext';
import useSEO from '../../utils/useSEO';

function RetailersPage() {
  const { openDemoPopup } = useDemoPopup();

  useSEO({
    title: 'AI Software for Liquor Retailers in the USA | Botella AI',
    description:
      'AI software for liquor retailers in the USA. Optimize inventory, surface demand patterns, and increase margins with Botella AI.',
    canonical: 'https://botella.ai/ai-for-liquor-retailers',
  });

  return (
    <ContentLayout>
      <div className="cp-rich page-retailers page-centered">

        {/* ── HERO ─────────────────────────────────────────────────── */}
        <section className="cp-hero-split">
          <h1>AI Software for <i>Liquor Retailers</i></h1>
          <div className="cp-hero-text">
            <p className="cp-hero-body">
              Running a liquor retail business in the United States is no
              longer just about stocking shelves and processing transactions.
              Today's liquor retailers operate in a highly competitive
              environment where margins are tight, customer preferences change
              quickly, and demand fluctuates based on seasonality, events, and
              local trends.
            </p>
            <p className="cp-hero-body">
              Most liquor stores still rely on traditional POS systems or
              manual spreadsheets. These tools provide basic reporting but
              fail to answer the most important question: what should I do
              next to improve my business?
            </p>
            <p className="cp-hero-body">
              Botella AI is designed to solve that gap. It is an AI software
              platform built specifically for liquor retailers, enabling
              store owners to move from reactive decision-making to more
              organized and efficient daily store operations.
            </p>
            <div className="cp-hero-cta">
              <button type="button" className="cp-btn-fill" onClick={openDemoPopup}>
                Book a Free Demo
              </button>
              <a href="#features" className="cp-btn-line">See Features →</a>
            </div>
          </div>

          {/* Multi-store constellation visualization - preserved from v2 build. */}
          <div className="cp-hero-visual">
            <div className="hv hv-retailers">
              <div className="hv-store">
                <span className="dot" />
                <h5>Manhattan Wines</h5>
                <div className="meta">5th Ave · NYC</div>
                <div className="rev">$6,240</div>
              </div>
              <div className="hv-store">
                <span className="dot" />
                <h5>Brooklyn Bottle</h5>
                <div className="meta">Flatbush · NYC</div>
                <div className="rev">$5,180</div>
              </div>
              <div className="hv-store">
                <span className="dot" />
                <h5>Queens Liquor</h5>
                <div className="meta">Astoria · NYC</div>
                <div className="rev">$3,400</div>
              </div>
            </div>
          </div>
        </section>

        {/* ── THE REAL CHALLENGES ──────────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>The Real Challenges <i>Liquor Retailers Face</i></h2>
            <p>
              Liquor retail has a unique operational complexity that generic
              retail tools cannot handle effectively.
            </p>
            <p>
              A single store may manage thousands of SKUs across spirits,
              wine, beer, and ready-to-drink products. Each category behaves
              differently, with its own demand cycles and customer segments.
            </p>
          </div>

          <ul className="cp-bullet-list">
            <li>Frequent stockouts of high-demand products like bourbon or premium tequila</li>
            <li>Dead stock that ties up cash and shelf space</li>
            <li>Limited understanding of customer purchasing behavior</li>
            <li>Difficulty identifying which products actually drive profit</li>
            <li>Time-consuming manual reporting processes</li>
          </ul>

          <p className="cp-section-foot">
            These issues directly impact revenue, margins, and operational efficiency.
          </p>
        </section>

        {/* ── HOW AI IS CHANGING LIQUOR RETAIL ─────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>How AI is <i>Changing Liquor Retail</i></h2>
            <p>
              AI for liquor retailers introduces a fundamentally different
              way of operating. Instead of relying on past reports, Botella
              organizes store data into actionable operational visibility
              and identifies patterns that humans cannot easily detect.
            </p>
          </div>

          <ul className="cp-bullet-list">
            <li>Sales transactions</li>
            <li>Inventory movement</li>
            <li>Customer purchase behavior</li>
            <li>Product performance trends</li>
          </ul>

          <p className="cp-section-foot">
            This allows the system to generate real-time recommendations,
            not just insights.
          </p>

          <ul className="cp-bullet-list">
            <li>It helps surface inventory patterns and highlights products that may need review.</li>
            <li>It can identify which products are underperforming.</li>
            <li>It can suggest which items to promote based on margin and demand.</li>
          </ul>
        </section>

        {/* ── CORE CAPABILITIES ───────────────────────────────────── */}
        <section className="cp-section-v2" id="features">
          <div className="cp-section-head">
            <h2>Core Capabilities of <i>Botella AI for Retailers</i></h2>
          </div>

          <div className="cp-feat-grid">
            <div className="cp-feat-card">
              <h3>AI Inventory Management</h3>
              <p>
                Botella AI tracks inventory in real time and identifies both
                fast-moving and slow-moving products. It ensures you maintain
                optimal stock levels without over-ordering.
              </p>
            </div>
            <div className="cp-feat-card">
              <h3>Inventory Monitoring</h3>
              <p>
                Using historical data and trends, Botella AI surfaces demand
                patterns at the product level. This helps retailers prepare
                for peak periods and avoid lost sales.
              </p>
            </div>
            <div className="cp-feat-card">
              <h3>Customer Intelligence</h3>
              <p>
                Botella AI identifies repeat customers, high-value buyers,
                and purchasing patterns. This enables more personalized
                selling and better customer retention.
              </p>
            </div>
            <div className="cp-feat-card">
              <h3>Store Performance Visibility</h3>
              <p>
                The system recommends which products to push based on margin,
                stock availability, and customer demand.
              </p>
            </div>
            <div className="cp-feat-card">
              <h3>Operational Automation</h3>
              <p>
                Routine operational monitoring becomes easier and more
                centralized, saving time and reducing errors.
              </p>
            </div>
          </div>
        </section>

        {/* ── BENEFITS FOR LIQUOR RETAILERS ───────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Benefits for <i>Liquor Retailers</i></h2>
            <p>Retailers using AI-driven software like Botella AI experience:</p>
          </div>

          <ul className="cp-bullet-list">
            <li>Reduced stockouts and improved product availability</li>
            <li>Higher margins through better product selection</li>
            <li>Increased sales through smarter recommendations</li>
            <li>Less time spent on manual analysis</li>
            <li>Better visibility into overall business performance</li>
          </ul>
        </section>

        {/* ── WHO THIS IS DESIGNED FOR ────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Who This is <i>Designed For</i></h2>
          </div>

          <div className="cp-feat-grid">
            <div className="cp-feat-card">
              <h3>Independent Liquor Store Owners</h3>
            </div>
            <div className="cp-feat-card">
              <h3>Multi-location Liquor Retailers</h3>
            </div>
            <div className="cp-feat-card">
              <h3>Alcohol Retail Chains</h3>
            </div>
            <div className="cp-feat-card">
              <h3>Convenience Stores Selling Alcohol</h3>
            </div>
          </div>
        </section>

        {/* ── FINAL CTA ────────────────────────────────────────────── */}
        <section className="cp-final-cta">
          <h2>The Future of Liquor Retail is <i>Data-Driven</i></h2>
          <p>
            As the liquor retail industry becomes more competitive, the
            stores that succeed will be the ones that leverage data
            effectively.
          </p>
          <p>
            Botella AI provides the intelligence layer that modern liquor
            retailers need, helping them operate smarter, faster, and more
            profitably.
          </p>
          <div className="cp-final-cta-actions">
            <button type="button" className="cp-btn-fill" onClick={openDemoPopup}>
              Book a Free Demo
            </button>
            <a href="mailto:info@botella.ai" className="cp-btn-line">info@botella.ai</a>
          </div>
        </section>

      </div>
    </ContentLayout>
  );
}

export default RetailersPage;
