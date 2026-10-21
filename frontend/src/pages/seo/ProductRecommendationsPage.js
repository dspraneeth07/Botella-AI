// ProductRecommendationsPage.js
// -----------------------------------------------------------------------------
// /ai-product-recommendations-liquor-stores
//
// Body content rewritten to match the v3 SEO doc verbatim. Only the obvious
// sed-artifact phrases have been cleaned to read as natural English.
// The "Real Outputs" promo gallery was removed because the v3 doc does not
// reference it. Visual structure (hero + sections + final CTA) preserved.
// -----------------------------------------------------------------------------

import React from 'react';
import ContentLayout from '../../components/ContentLayout';
import { useDemoPopup } from '../../components/DemoPopupContext';
import useSEO from '../../utils/useSEO';

function ProductRecommendationsPage() {
  const { openDemoPopup } = useDemoPopup();

  useSEO({
    title: 'AI Product Recommendations for Liquor Stores | Increase Sales | Botella AI',
    description:
      'Boost sales with AI product recommendations for liquor stores. Improve upselling, cross-selling, and customer experience.',
    canonical: 'https://botella.ai/ai-product-recommendations-liquor-stores',
  });

  return (
    <ContentLayout>
      <div className="cp-rich page-recommend">

        {/* ── HERO ─────────────────────────────────────────────────── */}
        <section className="cp-hero-split">
          <h1>AI Product Recommendations <i>for Liquor Stores</i></h1>
          <div className="cp-hero-text">
            <p className="cp-hero-body">
              In liquor retail, every customer interaction is an opportunity
              to increase revenue. However, most stores rely on staff
              intuition rather than data when recommending products.
            </p>
            <p className="cp-hero-body">
              This results in inconsistent selling and missed opportunities.
            </p>
            <p className="cp-hero-body">
              Botella AI provides AI product recommendations for liquor
              stores, enabling data-driven upselling and cross-selling that
              improve both customer experience and sales performance.
            </p>
            <div className="cp-hero-cta">
              <button type="button" className="cp-btn-fill" onClick={openDemoPopup}>
                Book a Free Demo
              </button>
              <a href="#features" className="cp-btn-line">See Features →</a>
            </div>
          </div>

          {/* Flat recommendation-panel mock - communicates the page's three
              feature groups (upsell, cross-sell, bundle) with static rows
              and confidence bars. No 3D, no animation. */}
          <div className="cp-hero-visual">
            <div className="pr-mock">
              <div className="pr-mock-head">
                <div className="pr-mock-title">
                  <span className="pr-mock-spark" aria-hidden="true">✦</span>
                  AI Recommendations
                </div>
                <span className="pr-mock-pill">Live</span>
              </div>
              <div className="pr-mock-context">
                <strong>Customer:</strong> Regular bourbon buyer · weekly · $32 avg
              </div>
              <ul className="pr-mock-list">
                <li className="pr-mock-item">
                  <div className="pr-mock-item-head">
                    <div className="pr-mock-item-name">Single-malt scotch · $58</div>
                    <span className="pr-mock-item-tag pr-mock-item-tag-upsell">Upsell</span>
                  </div>
                  <div className="pr-mock-item-row">
                    <div className="pr-mock-bar">
                      <span className="pr-mock-bar-fill" style={{ width: '92%' }} />
                    </div>
                    <div className="pr-mock-metric">4× rate</div>
                  </div>
                </li>
                <li className="pr-mock-item">
                  <div className="pr-mock-item-head">
                    <div className="pr-mock-item-name">Mixers · ginger ale, coke</div>
                    <span className="pr-mock-item-tag pr-mock-item-tag-cross">Cross-sell</span>
                  </div>
                  <div className="pr-mock-item-row">
                    <div className="pr-mock-bar">
                      <span className="pr-mock-bar-fill" style={{ width: '74%' }} />
                    </div>
                    <div className="pr-mock-metric">+$8 avg</div>
                  </div>
                </li>
                <li className="pr-mock-item">
                  <div className="pr-mock-item-head">
                    <div className="pr-mock-item-name">Premium glassware set</div>
                    <span className="pr-mock-item-tag pr-mock-item-tag-bundle">Bundle</span>
                  </div>
                  <div className="pr-mock-item-row">
                    <div className="pr-mock-bar">
                      <span className="pr-mock-bar-fill" style={{ width: '58%' }} />
                    </div>
                    <div className="pr-mock-metric">+22% AOV</div>
                  </div>
                </li>
              </ul>
            </div>
          </div>
        </section>

        {/* ── THE PROBLEM WITH TRADITIONAL SELLING ─────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>The Problem with <i>Traditional Selling</i></h2>
            <p>Staff often recommend products based on</p>
          </div>

          <ul className="cp-bullet-list">
            <li>Personal preference</li>
            <li>Limited knowledge</li>
            <li>Guesswork</li>
          </ul>

          <p className="cp-section-foot">This leads to</p>

          <ul className="cp-bullet-list">
            <li>Missed upsell opportunities</li>
            <li>Lower average order value</li>
            <li>Inconsistent customer experience</li>
          </ul>
        </section>

        {/* ── HOW AI IMPROVES RECOMMENDATIONS ──────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>How AI <i>Improves Recommendations</i></h2>
            <p>Botella AI analyzes</p>
          </div>

          <ul className="cp-bullet-list">
            <li>Customer purchase history</li>
            <li>Product popularity</li>
            <li>Margin data</li>
            <li>Seasonal trends</li>
          </ul>

          <p className="cp-section-foot">
            It then provides recommendations tailored to each situation.
          </p>
        </section>

        {/* ── KEY FEATURES ─────────────────────────────────────────── */}
        <section className="cp-section-v2" id="features">
          <div className="cp-section-head">
            <h2>Key <i>Features</i></h2>
          </div>

          <div className="cp-feat-grid">
            <div className="cp-feat-card">
              <h3>Upsell Recommendations</h3>
              <p>Suggest higher-value alternatives to increase revenue.</p>
            </div>
            <div className="cp-feat-card">
              <h3>Cross-Sell Suggestions</h3>
              <p>Recommend complementary products to increase basket size.</p>
            </div>
            <div className="cp-feat-card">
              <h3>Context-Aware Suggestions</h3>
              <p>Adjust recommendations based on time, demand, and trends.</p>
            </div>
          </div>
        </section>

        {/* ── REAL-WORLD EXAMPLE ──────────────────────────────────── */}
        <div className="cp-pull">
          <p className="cp-pull-text">
            <strong>Botella AI might suggest</strong> recommending a
            premium whiskey to a regular bourbon buyer; bundling wine with
            snacks; promoting high-margin products during peak hours.
          </p>
        </div>

        {/* ── BENEFITS ─────────────────────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2><i>Benefits</i></h2>
          </div>

          <div className="cp-feat-grid">
            <div className="cp-feat-card">
              <h3>Increase Average Order Value</h3>
              <p>Customers spend more per visit.</p>
            </div>
            <div className="cp-feat-card">
              <h3>Improve Customer Experience</h3>
              <p>Relevant recommendations improve satisfaction.</p>
            </div>
            <div className="cp-feat-card">
              <h3>Boost Sales Performance</h3>
              <p>More effective selling leads to higher revenue.</p>
            </div>
          </div>
        </section>

        {/* ── WHY AI IS BETTER ─────────────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Why AI <i>is Better</i></h2>
            <p>AI provides</p>
          </div>

          <ul className="cp-bullet-list">
            <li>Data-driven recommendations</li>
            <li>Consistency across staff</li>
            <li>Real-time adaptability</li>
          </ul>
        </section>

        {/* ── WHO SHOULD USE ──────────────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Who Should <i>Use This</i></h2>
          </div>

          <ul className="cp-bullet-list">
            <li>Liquor stores focused on increasing sales</li>
            <li>Retailers training staff</li>
            <li>Multi-location businesses</li>
          </ul>
        </section>

        {/* ── FINAL CTA ────────────────────────────────────────────── */}
        <section className="cp-final-cta">
          <h2>Sell Smarter <i>with AI</i></h2>
          <p>
            Botella AI turns every interaction into a growth opportunity.
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

export default ProductRecommendationsPage;
