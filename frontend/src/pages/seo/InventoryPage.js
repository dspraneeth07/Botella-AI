// InventoryPage.js
// -----------------------------------------------------------------------------
// /ai-inventory-management-liquor-stores
//
// Body content rewritten to match the v3 SEO doc verbatim. Only the obvious
// sed-artifact phrases ("identify trends surface patterns highlight changes…")
// have been cleaned to read as natural English. Visual structure preserved.
// -----------------------------------------------------------------------------

import React from 'react';
import ContentLayout from '../../components/ContentLayout';
import ScreenshotFrame from '../../components/ScreenshotFrame';
import { useDemoPopup } from '../../components/DemoPopupContext';
import JsonLd, { buildFaqSchema } from '../../components/JsonLd';
import useSEO from '../../utils/useSEO';

const INVENTORY_FAQS = [
  {
    q: 'What is AI inventory management for liquor stores?',
    a: 'AI inventory management uses artificial intelligence to analyze sales and stock data to identify trends, surface patterns in demand, optimize inventory levels, and support decisions.',
  },
  {
    q: 'How does AI reduce stockouts?',
    a: 'AI surfaces patterns in your sales trends and alerts you in advance when products are likely to run out - so you can reorder in time.',
  },
  {
    q: 'Can AI help reduce dead stock?',
    a: 'Yes - AI identifies slow-moving products and provides recommendations to clear them efficiently.',
  },
  {
    q: 'Is AI better than traditional inventory software?',
    a: 'AI is more advanced because it uses trend identification, pattern detection, and automation instead of manual tracking and static reports.',
  },
];

function InventoryPage() {
  const { openDemoPopup } = useDemoPopup();

  useSEO({
    title: 'AI Inventory Management for Liquor Stores | Botella AI',
    description:
      'AI inventory management for liquor stores. Surface demand patterns, automate reordering, reduce dead stock, and improve margins with Botella AI.',
    canonical: 'https://botella.ai/ai-inventory-management-liquor-stores',
  });

  return (
    <ContentLayout>
      <JsonLd data={buildFaqSchema(INVENTORY_FAQS)} />
      <div className="cp-rich page-inventory">

        {/* ── HERO ─────────────────────────────────────────────────── */}
        <section className="cp-hero-split">
          <h1>AI Inventory Management <i>for Liquor Stores</i></h1>
          <div className="cp-hero-text">
            <p className="cp-hero-body">
              Inventory is the backbone of every liquor store. Whether you
              operate a single location or multiple stores across the United
              States, your ability to manage stock effectively directly
              impacts your revenue, cash flow, and customer satisfaction.
            </p>
            <p className="cp-hero-body">
              Yet, most liquor stores still rely on manual tracking,
              spreadsheets, or basic POS systems that only show current
              stock levels, not what will happen next.
            </p>
            <p className="cp-hero-body">
              Botella AI introduces AI inventory management for liquor
              stores, enabling real-time visibility, demand pattern insights,
              and automated reordering decisions. Instead of reacting to
              stock issues after they occur, you can prevent them before
              they impact your business.
            </p>
            <div className="cp-hero-cta">
              <button type="button" className="cp-btn-fill" onClick={openDemoPopup}>
                Book a Free Demo
              </button>
              <a href="#features" className="cp-btn-line">See Features →</a>
            </div>
          </div>

          {/* Real product screenshot - Botella inventory health (low stock + values). */}
          <div className="cp-hero-visual">
            <ScreenshotFrame
              src="/screenshots/inventory-purchasing.png"
              alt="Botella AI purchasing screen: what to reorder, what is out of stock, and the capital tied up in dead stock"
              ratio="1760 / 1100"   /* inventory-purchasing.png is 1760x1100 */
            />
          </div>
        </section>

        {/* ── WHY CHALLENGING ──────────────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Why Inventory Management is So <i>Challenging for Liquor Stores</i></h2>
            <p>
              Liquor stores face a unique set of inventory challenges that
              traditional retail systems are not designed to handle.
            </p>
            <p>
              A typical liquor store carries hundreds or thousands of SKUs
              across different categories such as whiskey, vodka, wine,
              beer, and ready-to-drink products. Each category behaves
              differently in terms of demand, seasonality, and customer
              preferences.
            </p>
            <p><strong>Common challenges include</strong></p>
          </div>

          <ul className="cp-bullet-list">
            <li>Stockouts of high-demand products, leading to lost sales and frustrated customers</li>
            <li>Overstocking slow-moving products that tie up capital</li>
            <li>Dead stock that sits unsold for weeks or months</li>
            <li>Difficulty surfacing demand patterns during holidays, weekends, and local events</li>
            <li>Manual inventory tracking errors and inefficiencies</li>
          </ul>

          <p className="cp-section-foot">
            These issues not only reduce profitability but also create
            operational stress for store owners and staff.
          </p>
        </section>

        {/* ── WHAT IS AI INVENTORY MANAGEMENT ──────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>What is AI Inventory Management <i>for Liquor Stores?</i></h2>
            <p>
              AI inventory management for liquor stores uses artificial
              intelligence to analyze historical sales data, inventory
              movement, and customer behavior to optimize stock decisions.
            </p>
            <p>
              Unlike traditional liquor inventory software, AI does not
              just report what has happened - it identifies trends,
              surfaces patterns about what will happen, and recommends
              actions accordingly.
            </p>
            <p><strong>Botella AI continuously processes your store's data to answer critical questions such as</strong></p>
          </div>

          <ul className="cp-bullet-list">
            <li>Which products will run out soon?</li>
            <li>What should you reorder and when?</li>
            <li>Which products are not selling and need attention?</li>
            <li>How can you balance stock levels across categories?</li>
          </ul>

          <p className="cp-section-foot">
            This transforms inventory management from a reactive task into
            a proactive, data-driven system.
          </p>
        </section>

        {/* ── HOW BOTELLA AI TRANSFORMS ────────────────────────────── */}
        <section className="cp-section-v2" id="features">
          <div className="cp-section-head">
            <h2>How Botella AI Transforms <i>Liquor Inventory Management</i></h2>
            <p>
              Botella AI acts as an intelligent inventory assistant that
              works in real time, helping you make smarter decisions every
              day.
            </p>
          </div>

          <div className="cp-feat-grid">
            <div className="cp-feat-card">
              <h3>Real-Time Inventory Visibility</h3>
              <p>
                Botella AI provides a live view of your stock levels across
                all products. This ensures you always know what is available,
                what is running low, and what needs attention.
              </p>
            </div>
            <div className="cp-feat-card">
              <h3>Demand Pattern Insights</h3>
              <p>
                Using AI demand insights, Botella AI surfaces patterns in
                future sales based on historical data, seasonal patterns,
                and customer behavior. This allows you to prepare for
                demand before it happens.
              </p>
            </div>
            <div className="cp-feat-card">
              <h3>Dead Stock Detection</h3>
              <p>
                Botella AI identifies products that have not sold within a
                specific timeframe (e.g., 30, 60, or 90 days). This helps
                you take action to clear slow-moving inventory and free up
                cash.
              </p>
            </div>
            <div className="cp-feat-card">
              <h3>Low Stock Alerts</h3>
              <p>
                Receive alerts when products are about to run out, so you
                can reorder in time and avoid lost sales.
              </p>
            </div>
            <div className="cp-feat-card">
              <h3>Inventory Optimization Insights</h3>
              <p>
                Botella AI provides actionable recommendations to improve
                stock balance, reduce waste, and increase efficiency.
              </p>
            </div>
          </div>
        </section>

        {/* ── WHY TRADITIONAL FALLS SHORT ──────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Why Traditional Liquor Inventory Systems <i>Fall Short</i></h2>
            <p>
              Most liquor stores use POS systems or inventory software that
              are designed for general retail. These systems focus on
              tracking transactions rather than optimizing inventory.
            </p>
            <p><strong>Limitations of traditional systems include</strong></p>
          </div>

          <ul className="cp-bullet-list">
            <li>No demand forecasting capabilities</li>
            <li>Manual reordering processes</li>
            <li>Limited visibility into product performance</li>
            <li>No automated alerts for stock issues</li>
            <li>Lack of actionable recommendations</li>
          </ul>

          <p className="cp-section-foot">
            Botella AI goes beyond traditional systems by adding an
            intelligence layer that continuously analyzes data and guides
            decision-making.
          </p>
        </section>

        {/* ── BUSINESS IMPACT ─────────────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Business Impact of <i>AI Inventory Management</i></h2>
            <p>
              Implementing AI inventory management in a liquor store leads
              to measurable improvements across operations.
            </p>
          </div>

          <div className="cp-feat-grid">
            <div className="cp-feat-card">
              <h3>Reduced Stockouts</h3>
              <p>
                By surfacing demand patterns and alerting you before
                products run out, Botella AI ensures you always have the
                right products in stock.
              </p>
            </div>
            <div className="cp-feat-card">
              <h3>Improved Cash Flow</h3>
              <p>
                Reducing excess inventory and dead stock frees up capital
                that can be reinvested into high-performing products.
              </p>
            </div>
            <div className="cp-feat-card">
              <h3>Increased Sales</h3>
              <p>
                Better product availability and smarter stocking decisions
                lead to higher revenue.
              </p>
            </div>
            <div className="cp-feat-card">
              <h3>Time Savings</h3>
              <p>
                Automating inventory decisions reduces the time spent on
                manual tracking and reporting.
              </p>
            </div>
            <div className="cp-feat-card">
              <h3>Higher Profit Margins</h3>
              <p>
                Optimizing product mix and inventory levels improves overall
                profitability.
              </p>
            </div>
          </div>
        </section>

        {/* ── SEASONALITY ──────────────────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>How AI Handles <i>Seasonality and Demand Spikes</i></h2>
            <p>
              One of the biggest challenges in liquor retail is managing
              seasonal demand.
            </p>
            <p>
              Products like bourbon, champagne, and beer often experience
              spikes during holidays, sporting events, and local
              celebrations.
            </p>
            <p>
              Botella AI uses historical data and trend analysis to
              anticipate these spikes and adjust inventory recommendations
              accordingly.
            </p>
          </div>

          <ul className="cp-bullet-list">
            <li>Increased whiskey demand during the winter months</li>
            <li>Higher beer sales during weekends and sporting events</li>
            <li>Seasonal spikes in champagne during holidays</li>
          </ul>

          <p className="cp-section-foot">
            This ensures your store is always prepared for demand
            fluctuations.
          </p>
        </section>

        {/* ── WHO SHOULD USE ──────────────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Who Should Use <i>AI Inventory Management?</i></h2>
            <p>Botella AI is designed for</p>
          </div>

          <ul className="cp-bullet-list">
            <li>Independent liquor store owners</li>
            <li>Multi-location liquor retailers</li>
            <li>Alcohol retail chains in the USA</li>
            <li>Store owners looking to scale operations efficiently</li>
          </ul>

          <p className="cp-section-foot">
            Whether you run a single store or manage multiple locations,
            AI inventory management provides the insights needed to grow.
          </p>
        </section>

        {/* ── REAL-TIME ALERTS ─────────────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Real-Time Alerts <i>and Automation</i></h2>
            <p>
              Botella AI keeps you updated with automated alerts via
              WhatsApp and email, including
            </p>
          </div>

          <ul className="cp-bullet-list">
            <li>Low stock notifications</li>
            <li>Reorder recommendations</li>
            <li>Dead stock alerts</li>
            <li>Inventory performance summaries</li>
          </ul>

          <p className="cp-section-foot">
            This ensures you always stay informed without needing to
            manually check reports.
          </p>
        </section>

        {/* ── FAQ ──────────────────────────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Frequently <i>Asked Questions</i></h2>
          </div>
          <div className="cp-faq-grid">
            {INVENTORY_FAQS.map((f, i) => (
              <div className="cp-faq-card" key={i}>
                <h3>{f.q}</h3>
                <p>{f.a}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── FINAL CTA ────────────────────────────────────────────── */}
        <section className="cp-final-cta">
          <h2>Optimize Your Liquor Store <i>Inventory with AI</i></h2>
          <p>
            Inventory management does not have to be reactive or
            time-consuming. With Botella AI, liquor stores can move from
            manual tracking to intelligent, automated inventory management
            powered by AI.
          </p>
          <p>
            If you want to reduce stockouts, improve cash flow, and make
            smarter inventory decisions, Botella AI provides the tools to
            do it. Book a demo to see how AI inventory management can
            transform your liquor store operations.
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

export default InventoryPage;
