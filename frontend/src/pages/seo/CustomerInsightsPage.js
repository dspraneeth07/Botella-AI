// CustomerInsightsPage.js
// -----------------------------------------------------------------------------
// /customer-insights-liquor-stores
//
// Body content rewritten to match the v3 SEO doc verbatim. Only the obvious
// sed-artifact phrases have been cleaned to read as natural English.
// Visual structure preserved.
// -----------------------------------------------------------------------------

import React from 'react';
import ContentLayout from '../../components/ContentLayout';
import { useDemoPopup } from '../../components/DemoPopupContext';
import JsonLd, { buildFaqSchema } from '../../components/JsonLd';
import useSEO from '../../utils/useSEO';

const CUSTOMER_INSIGHTS_FAQS = [
  {
    q: 'What are customer insights in liquor stores?',
    a: 'Customer insights involve analyzing purchase data to understand customer behavior, preferences, and trends.',
  },
  {
    q: 'How does purchase behavior analytics increase sales?',
    a: 'It helps identify what customers want and enables better recommendations, increasing both sales and customer satisfaction.',
  },
  {
    q: 'Can AI identify high-value customers?',
    a: 'Yes - AI analyzes spending patterns and frequency to identify top customers.',
  },
  {
    q: 'Is customer analytics useful for small liquor stores?',
    a: 'Yes - even small stores can benefit by understanding customer preferences and improving sales strategies.',
  },
];

function CustomerInsightsPage() {
  const { openDemoPopup } = useDemoPopup();

  useSEO({
    title: 'Customer Insights & Purchase Behavior Analytics for Liquor Stores | Botella AI',
    description:
      'Understand customer behavior in liquor stores using AI. Identify top customers, track purchase patterns, and increase sales with Botella AI.',
    canonical: 'https://botella.ai/customer-insights-liquor-stores',
  });

  return (
    <ContentLayout>
      <JsonLd data={buildFaqSchema(CUSTOMER_INSIGHTS_FAQS)} />
      <div className="cp-rich page-customers page-reverse">

        {/* ── HERO ─────────────────────────────────────────────────── */}
        <section className="cp-hero-split">
          <h1>Customer Insights and <i>Purchase Behavior Analytics</i> for Liquor Stores</h1>
          <div className="cp-hero-text">
            <p className="cp-hero-body">
              Understanding your customers is one of the most powerful ways
              to grow a liquor store. Every purchase tells a story about
              what customers prefer, how often they visit, and what
              influences their buying decisions.
            </p>
            <p className="cp-hero-body">
              However, most liquor stores in the United States do not fully
              leverage this data. Customer information often remains locked
              inside POS systems, making it difficult to extract meaningful
              insights.
            </p>
            <p className="cp-hero-body">
              Botella AI provides advanced customer insights and purchase
              behavior analytics for liquor stores, helping you understand
              who your customers are, what they buy, and how to increase
              their lifetime value. Instead of relying on assumptions, you
              can use real data to make smarter decisions.
            </p>
            <div className="cp-hero-cta">
              <button type="button" className="cp-btn-fill" onClick={openDemoPopup}>
                Book a Free Demo
              </button>
              <a href="#features" className="cp-btn-line">See Features →</a>
            </div>
          </div>

          {/* Flat dashboard mock - communicates the page's four feature
              groups (segmentation, CLV, visit frequency, behavioural trends)
              with static rows. No 3D, no animation, no orbit. */}
          <div className="cp-hero-visual">
            <div className="ci-mock">
              <div className="ci-mock-head">
                <div className="ci-mock-title">
                  <span className="ci-mock-dot" aria-hidden="true" />
                  Customer Insights
                </div>
                <span className="ci-mock-pill">Live</span>
              </div>
              <ul className="ci-mock-list">
                <li className="ci-mock-row">
                  <span className="ci-mock-avatar ci-mock-avatar-1">JD</span>
                  <div className="ci-mock-row-main">
                    <div className="ci-mock-row-name">James D.</div>
                    <div className="ci-mock-row-tag">Whiskey · weekly</div>
                  </div>
                  <div className="ci-mock-row-metric">$890<span>/mo</span></div>
                </li>
                <li className="ci-mock-row">
                  <span className="ci-mock-avatar ci-mock-avatar-2">AL</span>
                  <div className="ci-mock-row-main">
                    <div className="ci-mock-row-name">Alex L. <span className="ci-mock-badge">VIP</span></div>
                    <div className="ci-mock-row-tag">Premium · daily</div>
                  </div>
                  <div className="ci-mock-row-metric">$2.1k<span>/mo</span></div>
                </li>
                <li className="ci-mock-row">
                  <span className="ci-mock-avatar ci-mock-avatar-3">MR</span>
                  <div className="ci-mock-row-main">
                    <div className="ci-mock-row-name">Maria R.</div>
                    <div className="ci-mock-row-tag">Wine · monthly</div>
                  </div>
                  <div className="ci-mock-row-metric">12<span> visits</span></div>
                </li>
                <li className="ci-mock-row">
                  <span className="ci-mock-avatar ci-mock-avatar-4">SK</span>
                  <div className="ci-mock-row-main">
                    <div className="ci-mock-row-name">Sam K.</div>
                    <div className="ci-mock-row-tag">Beer · weekends</div>
                  </div>
                  <div className="ci-mock-row-metric">$340<span>/mo</span></div>
                </li>
              </ul>
              <div className="ci-mock-foot">
                <div className="ci-mock-foot-label">Top segment</div>
                <div className="ci-mock-foot-bar">
                  <span className="ci-mock-foot-fill" style={{ width: '24%' }} />
                </div>
                <div className="ci-mock-foot-value">High-value · 24%</div>
              </div>
            </div>
          </div>
        </section>

        {/* ── WHY CUSTOMER INSIGHTS MATTER ─────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Why Customer Insights <i>Matter in Liquor Retail</i></h2>
            <p>
              Liquor retail is not just about products; it is about customer
              relationships and buying behavior.
            </p>
            <p>
              Two customers may walk into your store and purchase completely
              different items based on preferences, price sensitivity, and
              occasion. Without analyzing this behavior, it becomes difficult
              to personalize the experience or maximize sales.
            </p>
            <p><strong>Common challenges faced by liquor stores include</strong></p>
          </div>

          <ul className="cp-bullet-list">
            <li>No visibility into repeat customers vs one-time buyers</li>
            <li>Lack of understanding of customer preferences</li>
            <li>Missed upselling and cross-selling opportunities</li>
            <li>Inability to identify high-value customers</li>
            <li>Generic promotions that do not drive results</li>
          </ul>

          <p className="cp-section-foot">
            Customer insights solve these challenges by turning raw
            transaction data into actionable intelligence.
          </p>
        </section>

        {/* ── WHAT IS PURCHASE BEHAVIOR ANALYTICS ──────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>What is Purchase Behavior Analytics <i>for Liquor Stores?</i></h2>
            <p>
              Purchase behavior analytics involves analyzing customer
              transactions to understand patterns, preferences, and trends.
            </p>
            <p><strong>For liquor stores, this includes</strong></p>
          </div>

          <ul className="cp-bullet-list">
            <li>What products do customers buy together</li>
            <li>How frequently do customers visit</li>
            <li>Which categories are most popular among different customer segments</li>
            <li>How purchasing behavior changes over time</li>
          </ul>

          <p className="cp-section-foot">
            Botella AI uses AI to process this data and provide clear
            insights that help improve both sales and customer experience.
          </p>
        </section>

        {/* ── HOW BOTELLA AI TRANSFORMS CUSTOMER DATA ──────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>How Botella AI Transforms <i>Customer Data into Insights</i></h2>
            <p>
              Botella AI acts as a real-time analytics engine that
              continuously analyzes customer behavior and identifies
              patterns.
            </p>
            <p><strong>It answers key business questions such as</strong></p>
          </div>

          <ul className="cp-bullet-list">
            <li>Who are your most valuable customers?</li>
            <li>What products do they prefer?</li>
            <li>Which are repeat engagement trends?</li>
            <li>What products are frequently purchased together?</li>
          </ul>

          <p className="cp-section-foot">
            These insights allow liquor store owners to make targeted,
            data-driven decisions.
          </p>
        </section>

        {/* ── KEY FEATURES ─────────────────────────────────────────── */}
        <section className="cp-section-v2" id="features">
          <div className="cp-section-head">
            <h2>Key Features of <i>Customer Insights &amp; Analytics</i></h2>
          </div>

          <div className="cp-feat-grid">
            <div className="cp-feat-card">
              <h3>Customer Segmentation</h3>
              <p>
                Botella AI automatically segments customers based on
                behavior, purchase frequency, and spending patterns.
                For example: high-value customers, occasional buyers,
                new customers, and category-specific buyers (e.g., whiskey
                lovers, wine buyers). This segmentation helps tailor
                promotions and recommendations.
              </p>
            </div>
            <div className="cp-feat-card">
              <h3>Purchase History Tracking</h3>
              <p>
                Track detailed purchase history for each customer,
                including products purchased, frequency of visits, and
                average spend per visit. This helps identify trends and
                customer engagement patterns.
              </p>
            </div>
            <div className="cp-feat-card">
              <h3>Basket Analysis (What Customers Buy Together)</h3>
              <p>
                Botella AI analyzes which products are frequently purchased
                together. For example: whiskey + mixers, wine + snacks,
                beer + party supplies. This helps create bundling strategies
                and improve cross-selling.
              </p>
            </div>
            <div className="cp-feat-card">
              <h3>Customer Lifetime Value (CLV) Insights</h3>
              <p>
                Understand how much revenue each customer generates over
                time. This allows you to focus on retaining high-value
                customers and identify opportunities to increase repeat
                purchases.
              </p>
            </div>
            <div className="cp-feat-card">
              <h3>Behavioral Trends and Patterns</h3>
              <p>
                Botella AI identifies patterns such as weekend vs weekday
                purchasing behavior, seasonal preferences, and product
                switching trends. These insights help optimize inventory
                and marketing strategies.
              </p>
            </div>
          </div>
        </section>

        {/* ── DRIVE REVENUE GROWTH ─────────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>How Customer Insights <i>Drive Revenue Growth</i></h2>
            <p>
              Customer insights are directly linked to increased revenue
              and better business performance.
            </p>
          </div>

          <div className="cp-feat-grid">
            <div className="cp-feat-card">
              <h3>Better Upselling</h3>
              <p>Knowing customer preferences allows staff to recommend higher-value products that align with their tastes.</p>
            </div>
            <div className="cp-feat-card">
              <h3>Improved Cross-Selling</h3>
              <p>Basket analysis helps suggest complementary products, increasing the total bill value.</p>
            </div>
            <div className="cp-feat-card">
              <h3>Higher Customer Retention</h3>
              <p>Understanding customer behavior helps create better experiences, encouraging repeat visits.</p>
            </div>
            <div className="cp-feat-card">
              <h3>More Effective Promotions</h3>
              <p>Targeted promotions based on customer segments perform significantly better than generic campaigns.</p>
            </div>
          </div>
        </section>

        {/* ── REAL-WORLD EXAMPLE ──────────────────────────────────── */}
        <div className="cp-pull">
          <p className="cp-pull-text">
            <strong>Instead of guessing what to recommend, Botella AI might identify:</strong>{' '}
            customers who buy premium whiskey are likely to upgrade to single malt;
            customers who purchase wine frequently also respond well to bundled offers;
            certain customers visit every Friday evening and prefer specific brands.
            These insights allow you to take precise actions that increase sales.
          </p>
        </div>

        {/* ── WHY TRADITIONAL FAILS ────────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Why Traditional Systems Fail <i>at Customer Insights</i></h2>
            <p>
              Most POS systems collect customer data but do not analyze it
              effectively.
            </p>
            <p><strong>Limitations include</strong></p>
          </div>

          <ul className="cp-bullet-list">
            <li>No automatic segmentation</li>
            <li>No predictive insights</li>
            <li>No behavior analysis</li>
            <li>No actionable recommendations</li>
          </ul>

          <p className="cp-section-foot">
            Botella AI transforms raw data into meaningful insights that
            can be used immediately.
          </p>
        </section>

        {/* ── BENEFITS ─────────────────────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Benefits of Customer Insights <i>for Liquor Stores</i></h2>
          </div>

          <ul className="cp-bullet-list">
            <li>Increase average order value</li>
            <li>Improve customer retention</li>
            <li>Deliver personalized recommendations</li>
            <li>Make smarter stocking decisions</li>
            <li>Optimize marketing strategies</li>
          </ul>
        </section>

        {/* ── WHO SHOULD USE ──────────────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Who Should Use <i>Customer Analytics?</i></h2>
            <p>This solution is ideal for</p>
          </div>

          <ul className="cp-bullet-list">
            <li>Liquor store owners looking to increase repeat customers</li>
            <li>Multi-location retailers analyzing customer trends</li>
            <li>Stores aiming to improve upselling and cross-selling</li>
          </ul>
        </section>

        {/* ── REAL-TIME ALERTS ─────────────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Real-Time Alerts <i>and Insights</i></h2>
            <p>
              Botella AI delivers customer insights directly to your
              WhatsApp or email, including:
            </p>
          </div>

          <ul className="cp-bullet-list">
            <li>Top customers of the week</li>
            <li>Customer trends and changes</li>
            <li>Product recommendation insights</li>
            <li>Behavioral alerts</li>
          </ul>

          <p className="cp-section-foot">
            This ensures you always stay informed without manual analysis.
          </p>
        </section>

        {/* ── FAQ ──────────────────────────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Frequently <i>Asked Questions</i></h2>
          </div>
          <div className="cp-faq-grid">
            {CUSTOMER_INSIGHTS_FAQS.map((f, i) => (
              <div className="cp-faq-card" key={i}>
                <h3>{f.q}</h3>
                <p>{f.a}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── FINAL CTA ────────────────────────────────────────────── */}
        <section className="cp-final-cta">
          <h2>Turn Customer Data <i>into Growth with AI</i></h2>
          <p>
            Your customers are already telling you what they want - through
            their purchases. Botella AI helps you listen, understand, and
            act on that data.
          </p>
          <p>
            With AI-powered customer insights and purchase behavior
            analytics, you can improve customer relationships, increase
            sales, and make smarter decisions every day. Book a demo to
            see how Botella AI can help you unlock the full value of your
            customer data.
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

export default CustomerInsightsPage;
