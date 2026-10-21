// MarginOptimizationPage.js
// -----------------------------------------------------------------------------
// /margin-optimization-liquor-stores
//
// Body content rewritten to match the v3 SEO doc verbatim. Only the obvious
// sed-artifact phrases have been cleaned to read as natural English.
// Visual structure preserved.
// -----------------------------------------------------------------------------

import React from 'react';
import ContentLayout from '../../components/ContentLayout';
import ScreenshotFrame from '../../components/ScreenshotFrame';
import { useDemoPopup } from '../../components/DemoPopupContext';
import useSEO from '../../utils/useSEO';

function MarginOptimizationPage() {
  const { openDemoPopup } = useDemoPopup();

  useSEO({
    title: 'Margin Optimization & Profit Intelligence for Liquor Stores | Botella AI',
    description:
      'Increase profits with AI-driven margin optimization for liquor stores. Identify high-margin products and improve pricing strategies.',
    canonical: 'https://botella.ai/margin-optimization-liquor-stores',
  });

  return (
    <ContentLayout>
      <div className="cp-rich page-margin page-reverse">

        {/* ── HERO ─────────────────────────────────────────────────── */}
        <section className="cp-hero-split">
          <h1>Margin Optimization and <i>Profit Intelligence</i> for Liquor Stores</h1>
          <div className="cp-hero-text">
            <p className="cp-hero-body">
              Revenue alone does not determine success in liquor retail -
              profitability does.
            </p>
            <p className="cp-hero-body">
              Many liquor store owners focus on increasing sales but lack
              visibility into which products actually generate profit.
              High-volume products may drive revenue but contribute little
              to margins, while certain products deliver strong profits but
              are under-promoted.
            </p>
            <p className="cp-hero-body">
              Botella AI provides margin optimization and profit
              intelligence for liquor stores, helping you understand where
              your profits come from and how to maximize them.
            </p>
            <div className="cp-hero-cta">
              <button type="button" className="cp-btn-fill" onClick={openDemoPopup}>
                Book a Free Demo
              </button>
              <a href="#features" className="cp-btn-line">See Features →</a>
            </div>
          </div>

          {/* Real product screenshot - Botella profit margin by category. */}
          <div className="cp-hero-visual">
            <ScreenshotFrame
              src="/screenshots/margin-by-category.png"
              alt="Botella AI reports screen showing profit margin by product category"
              ratio="1760 / 1100"   /* margin-by-category.png is 1760x1100 */
            />
          </div>
        </section>

        {/* ── THE HIDDEN PROFIT PROBLEM ────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>The Hidden <i>Profit Problem</i></h2>
            <p>Liquor stores often struggle with</p>
          </div>

          <ul className="cp-bullet-list">
            <li>Selling high-volume, low-margin products</li>
            <li>Ignoring high-margin items due to lack of visibility</li>
            <li>Inefficient pricing strategies</li>
            <li>Poor product mix decisions</li>
          </ul>

          <p className="cp-section-foot">
            Without clear margin insights, it is difficult to optimize
            profitability.
          </p>
        </section>

        {/* ── WHAT IS PROFIT INTELLIGENCE ──────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>What is <i>Profit Intelligence?</i></h2>
            <p>
              Profit intelligence involves analyzing revenue, cost, and
              margin data to understand the true profitability of each
              product, category, and customer segment.
            </p>
            <p>
              Botella AI goes beyond basic reporting by identifying patterns
              and opportunities to improve margins.
            </p>
          </div>
        </section>

        {/* ── HOW BOTELLA OPTIMIZES MARGINS ────────────────────────── */}
        <section className="cp-section-v2" id="features">
          <div className="cp-section-head">
            <h2>How Botella AI <i>Optimizes Margins</i></h2>
          </div>

          <div className="cp-feat-grid">
            <div className="cp-feat-card">
              <h3>Product-Level Margin Analysis</h3>
              <p>See exactly how much profit each product generates.</p>
            </div>
            <div className="cp-feat-card">
              <h3>Category Profit Insights</h3>
              <p>Understand which categories drive the most profit.</p>
            </div>
            <div className="cp-feat-card">
              <h3>High-Margin Product Identification</h3>
              <p>Identify products that should be promoted more aggressively.</p>
            </div>
            <div className="cp-feat-card">
              <h3>Pricing Optimization</h3>
              <p>Adjust pricing based on performance and demand.</p>
            </div>
          </div>
        </section>

        {/* ── REAL-WORLD EXAMPLE ──────────────────────────────────── */}
        <div className="cp-pull">
          <p className="cp-pull-text">
            <strong>Botella AI might reveal</strong> a premium whiskey
            generating 35% margin but low sales; a popular beer that sells
            high volume but low profit; a category with declining margins.
            This helps you rebalance your strategy.
          </p>
        </div>

        {/* ── BENEFITS OF MARGIN OPTIMIZATION ─────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Benefits of <i>Margin Optimization</i></h2>
          </div>

          <div className="cp-feat-grid">
            <div className="cp-feat-card">
              <h3>Increase Profitability</h3>
              <p>Focus on products that generate higher margins.</p>
            </div>
            <div className="cp-feat-card">
              <h3>Improve Product Mix</h3>
              <p>Balance between high-volume and high-margin products.</p>
            </div>
            <div className="cp-feat-card">
              <h3>Better Pricing Decisions</h3>
              <p>Optimize pricing without losing competitiveness.</p>
            </div>
            <div className="cp-feat-card">
              <h3>Smarter Promotions</h3>
              <p>Promote products that maximize profit, not just sales.</p>
            </div>
          </div>
        </section>

        {/* ── WHY TRADITIONAL REPORTING FAILS ──────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Why Traditional <i>Reporting Fails</i></h2>
            <p>Most systems focus on revenue, not profitability.</p>
            <p><strong>They lack</strong></p>
          </div>

          <ul className="cp-bullet-list">
            <li>Product-level margin insights</li>
            <li>Actionable recommendations</li>
            <li>Real-time analysis</li>
          </ul>

          <p className="cp-section-foot">Botella AI fills this gap.</p>
        </section>

        {/* ── WHO SHOULD USE ──────────────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Who Should <i>Use This</i></h2>
          </div>

          <ul className="cp-bullet-list">
            <li>Store owners focused on profitability</li>
            <li>Retailers managing large product catalogs</li>
            <li>Businesses looking to scale margins</li>
          </ul>
        </section>

        {/* ── FINAL CTA ────────────────────────────────────────────── */}
        <section className="cp-final-cta">
          <h2>Turn Revenue <i>into Profit with AI</i></h2>
          <p>
            Botella AI helps liquor stores move beyond revenue tracking to
            true profit optimization.
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

export default MarginOptimizationPage;
