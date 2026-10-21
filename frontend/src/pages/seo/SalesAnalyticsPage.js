// SalesAnalyticsPage.js
// -----------------------------------------------------------------------------
// /liquor-store-sales-analytics-insights
//
// Body content rewritten to match the v3 SEO doc verbatim. Only the obvious
// sed-artifact phrases have been cleaned to read as natural English.
// Visual structure preserved.
// -----------------------------------------------------------------------------

import React from 'react';
import ContentLayout from '../../components/ContentLayout';
import ScreenshotFrame from '../../components/ScreenshotFrame';
import { useDemoPopup } from '../../components/DemoPopupContext';
import JsonLd, { buildFaqSchema } from '../../components/JsonLd';
import useSEO from '../../utils/useSEO';

const SALES_ANALYTICS_FAQS = [
  {
    q: 'What is liquor store sales analytics?',
    a: 'It is the process of analyzing sales data to understand product performance, trends, and business insights.',
  },
  {
    q: 'How does AI improve sales analytics?',
    a: 'AI automates data analysis, identifies patterns, and provides actionable insights instead of just reports.',
  },
  {
    q: 'Can analytics increase liquor store revenue?',
    a: 'Yes - by identifying high-performing products and trends, analytics helps optimize sales strategies.',
  },
  {
    q: 'Is this useful for small liquor stores?',
    a: 'Yes - even small stores benefit from understanding their data and improving decision-making.',
  },
];

function SalesAnalyticsPage() {
  const { openDemoPopup } = useDemoPopup();

  useSEO({
    title: 'Liquor Store Sales Analytics & Insights Software | Botella AI',
    description:
      'Advanced liquor store analytics software. Track sales, identify top products, analyze trends, and increase margins with AI-powered insights from Botella AI.',
    canonical: 'https://botella.ai/liquor-store-sales-analytics-insights',
  });

  return (
    <ContentLayout>
      <JsonLd data={buildFaqSchema(SALES_ANALYTICS_FAQS)} />
      <div className="cp-rich page-analytics page-magazine">

        {/* ── HERO ─────────────────────────────────────────────────── */}
        <section className="cp-hero-split">
          <h1>Liquor Store Sales Analytics and <i>Insights Software</i></h1>
          <div className="cp-hero-text">
            <p className="cp-hero-body">
              Liquor store owners generate large amounts of data every day -
              from sales transactions and product performance to customer
              behavior and inventory movement. However, most of this data
              remains underutilized.
            </p>
            <p className="cp-hero-body">
              Traditional POS systems provide reports, but they rarely
              deliver actionable insights. They tell you what happened, but
              not why it happened or what to do next.
            </p>
            <p className="cp-hero-body">
              Botella AI provides advanced liquor store sales analytics and
              insights, transforming raw data into clear, actionable
              intelligence. It helps store owners understand performance,
              identify opportunities, and make smarter decisions that drive
              growth.
            </p>
            <div className="cp-hero-cta">
              <button type="button" className="cp-btn-fill" onClick={openDemoPopup}>
                Book a Free Demo
              </button>
              <a href="#features" className="cp-btn-line">See Features →</a>
            </div>
          </div>

          {/* Real product screenshot - Botella sales-analytics dashboard. */}
          <div className="cp-hero-visual">
            <ScreenshotFrame
              src="/screenshots/analytics-reports.png"
              alt="Botella AI reports screen with total sales, gross margin, revenue trend and category breakdown"
              ratio="1760 / 1100"   /* analytics-reports.png is 1760x1100 */
            />
          </div>
        </section>

        {/* ── WHY SALES ANALYTICS MATTERS ──────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Why Sales Analytics <i>Matters in Liquor Retail</i></h2>
            <p>
              Liquor retail is a data-rich environment, but without proper
              analysis, that data has little value.
            </p>
            <p>
              Every product sold, every transaction, and every customer
              interaction contributes to patterns that can reveal:
            </p>
          </div>

          <ul className="cp-bullet-list">
            <li>Which products drive the most revenue</li>
            <li>Which categories perform best during specific times</li>
            <li>When your store experiences peak traffic</li>
            <li>Which products are declining in performance</li>
          </ul>

          <p className="cp-section-foot">Without analytics, these patterns remain hidden. This leads to:</p>

          <ul className="cp-bullet-list">
            <li>Missed revenue opportunities</li>
            <li>Poor product selection decisions</li>
            <li>Inefficient staffing during peak hours</li>
            <li>Lack of clarity on what drives profit</li>
          </ul>

          <p className="cp-section-foot">Sales analytics helps turn data into decisions.</p>
        </section>

        {/* ── WHAT IS LIQUOR STORE SALES ANALYTICS ─────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>What is <i>Liquor Store Sales Analytics?</i></h2>
            <p>
              Liquor store sales analytics involves analyzing transaction
              data to understand performance across products, categories,
              time periods, and customer segments.
            </p>
            <p>
              With AI-powered analytics, this goes beyond basic reporting.
            </p>
            <p><strong>Botella AI answers key business questions such as:</strong></p>
          </div>

          <ul className="cp-bullet-list">
            <li>What are my top-selling products today, this week, or this month?</li>
            <li>Which products generate the highest margins?</li>
            <li>What time of day does my store perform best?</li>
            <li>Which categories are growing or declining?</li>
          </ul>

          <p className="cp-section-foot">
            This level of insight enables store owners to operate with
            precision rather than guesswork.
          </p>
        </section>

        {/* ── HOW BOTELLA AI TRANSFORMS SALES DATA ─────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>How Botella AI Transforms <i>Sales Data into Insights</i></h2>
            <p>
              Botella AI continuously analyzes your store's sales data in
              real time and surfaces the most important metrics
              automatically.
            </p>
            <p>
              Instead of digging through reports, you receive clear,
              prioritized insights that highlight what matters most.
            </p>
            <p><strong>For example:</strong></p>
          </div>

          <ul className="cp-bullet-list">
            <li>A sudden spike in beer sales on weekends</li>
            <li>Declining performance in a specific wine category</li>
            <li>High-margin products that are under-promoted</li>
            <li>Peak hours that require better staffing</li>
          </ul>

          <p className="cp-section-foot">
            This allows you to act immediately and improve performance.
          </p>
        </section>

        {/* ── CORE FEATURES ────────────────────────────────────────── */}
        <section className="cp-section-v2" id="features">
          <div className="cp-section-head">
            <h2>Core Features of <i>Liquor Store Sales Analytics</i></h2>
          </div>

          <div className="cp-feat-grid">
            <div className="cp-feat-card">
              <h3>Real-Time Sales Tracking</h3>
              <p>
                Botella AI provides a live view of your store's performance,
                including daily revenue, transaction volume, and product
                sales. This ensures you always know how your store is
                performing at any given moment.
              </p>
            </div>
            <div className="cp-feat-card">
              <h3>Top-Selling Products Analysis</h3>
              <p>
                Identify which products are driving the most sales, both by
                volume and value. This helps you prioritize high-performing
                products, adjust shelf placement, and improve product
                visibility.
              </p>
            </div>
            <div className="cp-feat-card">
              <h3>Category Performance Insights</h3>
              <p>
                Analyze how different categories (whiskey, vodka, wine,
                beer) perform over time. This allows you to identify growth
                opportunities, adjust inventory strategies, and optimize
                product mix.
              </p>
            </div>
            <div className="cp-feat-card">
              <h3>Peak Hour and Day Analysis</h3>
              <p>
                Understand when your store is busiest. Botella AI identifies
                peak hours during the day, high-traffic days of the week,
                and seasonal demand spikes. This helps improve staffing and
                store operations.
              </p>
            </div>
            <div className="cp-feat-card">
              <h3>Revenue and Margin Insights</h3>
              <p>
                Track not just revenue, but profitability. Botella AI shows
                revenue trends over time, margin by product and category,
                and profit contribution of different items. This helps you
                focus on what actually drives profit.
              </p>
            </div>
            <div className="cp-feat-card">
              <h3>Trend Detection and Performance Alerts</h3>
              <p>
                Botella AI surfaces noticeable shifts in store performance
                and alerts you. For example: declining sales of a specific
                product, a sudden increase in demand for a category, or
                emerging trends in customer preferences.
              </p>
            </div>
          </div>
        </section>

        {/* ── WHY TRADITIONAL POS REPORTS ARE NOT ENOUGH ───────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Why Traditional POS Reports <i>Are Not Enough</i></h2>
            <p>
              Most POS systems provide static reports that require manual
              interpretation.
            </p>
            <p><strong>Limitations include:</strong></p>
          </div>

          <ul className="cp-bullet-list">
            <li>Data is not analyzed automatically</li>
            <li>No real-time insights</li>
            <li>No prioritization of important metrics</li>
            <li>No actionable recommendations</li>
          </ul>

          <p className="cp-section-foot">
            Store owners often spend hours reviewing reports without gaining
            clear direction. Botella AI solves this by delivering insights,
            not just data.
          </p>
        </section>

        {/* ── DRIVES BETTER DECISIONS ──────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>How Sales Analytics <i>Drives Better Decisions</i></h2>
            <p>
              With AI-powered analytics, liquor store owners can make
              smarter decisions across all areas of the business.
            </p>
          </div>

          <div className="cp-feat-grid">
            <div className="cp-feat-card">
              <h3>Inventory Decisions</h3>
              <p>Stock more of what sells and reduce slow-moving products.</p>
            </div>
            <div className="cp-feat-card">
              <h3>Pricing Strategy</h3>
              <p>Adjust pricing based on performance and margin insights.</p>
            </div>
            <div className="cp-feat-card">
              <h3>Product Placement</h3>
              <p>Highlight high-performing and high-margin products.</p>
            </div>
            <div className="cp-feat-card">
              <h3>Staffing Optimization</h3>
              <p>Schedule staff based on peak hours and demand patterns.</p>
            </div>
          </div>
        </section>

        {/* ── REAL-WORLD EXAMPLE ──────────────────────────────────── */}
        <div className="cp-pull">
          <p className="cp-pull-text">
            <strong>Instead of manually analyzing reports, Botella AI might identify:</strong>{' '}
            premium whiskey sales are increasing by 20% month-over-month;
            beer sales spike every Friday evening; a high-margin product is
            underperforming due to low visibility; a specific category is
            declining and needs attention. These insights allow immediate
            action that improves performance.
          </p>
        </div>

        {/* ── BENEFITS ─────────────────────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Benefits of <i>Liquor Store Analytics Software</i></h2>
          </div>

          <ul className="cp-bullet-list">
            <li>Increase revenue through better product decisions</li>
            <li>Improve margins with data-driven insights</li>
            <li>Save time by automating analysis</li>
            <li>Identify trends early</li>
            <li>Make faster, more confident decisions</li>
          </ul>
        </section>

        {/* ── WHO SHOULD USE ──────────────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Who Should Use <i>Sales Analytics?</i></h2>
            <p>Botella AI is ideal for:</p>
          </div>

          <ul className="cp-bullet-list">
            <li>Liquor store owners seeking better visibility</li>
            <li>Multi-location retailers analyzing performance across stores</li>
            <li>Businesses looking to scale using data</li>
          </ul>
        </section>

        {/* ── REAL-TIME ALERTS ─────────────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Real-Time Alerts <i>and Reporting</i></h2>
            <p>
              Botella AI delivers insights directly to your WhatsApp and
              email, including:
            </p>
          </div>

          <ul className="cp-bullet-list">
            <li>Daily sales summaries</li>
            <li>Weekly performance reports</li>
            <li>Trend alerts</li>
            <li>Product performance insights</li>
          </ul>

          <p className="cp-section-foot">
            This ensures you always stay informed without manual effort.
          </p>
        </section>

        {/* ── FAQ ──────────────────────────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Frequently <i>Asked Questions</i></h2>
          </div>
          <div className="cp-faq-grid">
            {SALES_ANALYTICS_FAQS.map((f, i) => (
              <div className="cp-faq-card" key={i}>
                <h3>{f.q}</h3>
                <p>{f.a}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── FINAL CTA ────────────────────────────────────────────── */}
        <section className="cp-final-cta">
          <h2>Turn Sales Data <i>into Growth with AI</i></h2>
          <p>
            Your liquor store already generates valuable data every day.
            The difference is whether you use it effectively.
          </p>
          <p>
            Botella AI helps you move from basic reporting to intelligent
            decision-making. With AI-powered liquor store sales analytics
            and insights, you can increase revenue, improve margins, and
            run your business with confidence. Book a demo to see how
            Botella AI can transform your store's performance.
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

export default SalesAnalyticsPage;
