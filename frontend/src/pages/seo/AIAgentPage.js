// AIAgentPage.js
// -----------------------------------------------------------------------------
// /ai-agent-for-liquor-stores
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

// Page FAQs - used both in the visible FAQ section + FAQPage JSON-LD.
const AI_AGENT_FAQS = [
  {
    q: 'What is the best AI agent for liquor stores?',
    a: 'Botella AI is one of the best AI agents for liquor stores because it combines inventory management, demand pattern insights, customer insights, and automation into a single platform.',
  },
  {
    q: 'How does AI help liquor stores increase sales?',
    a: 'AI identifies trends, recommends high-margin products, and helps staff upsell effectively, leading to increased revenue.',
  },
  {
    q: 'Can AI reduce stockouts in liquor stores?',
    a: 'Yes - AI surfaces demand patterns based on historical data and alerts store owners before products run out.',
  },
  {
    q: 'Is AI inventory management better than traditional methods?',
    a: 'Yes - AI uses trend identification, pattern detection, and automation, making it more accurate and efficient than manual tracking.',
  },
];

function AIAgentPage() {
  const { openDemoPopup } = useDemoPopup();

  useSEO({
    title: 'Best AI Agent for Liquor Stores | Inventory, Sales & Automation | Botella AI',
    description:
      'AI agent for liquor stores to automate inventory, surface demand patterns, and increase margins. Discover how Botella AI improves operations and sales.',
    canonical: 'https://botella.ai/ai-agent-for-liquor-stores',
  });

  return (
    <ContentLayout>
      <JsonLd data={buildFaqSchema(AI_AGENT_FAQS)} />
      <div className="cp-rich page-aiagent">

        {/* ── HERO ─────────────────────────────────────────────────── */}
        <section className="cp-hero-split">
          <h1>Best AI Agent for <i>Liquor Stores</i></h1>
          <div className="cp-hero-text">
            <p className="cp-hero-body">
              Running a liquor store today requires constant, high-stakes
              decision-making from managing inventory and avoiding stockouts
              to understanding customer behavior and maximizing margins.
              Every day, store owners must decide what to reorder, what to
              promote, and how to optimize operations.
            </p>
            <p className="cp-hero-body">
              Most liquor stores still rely on manual processes, spreadsheets,
              or basic POS systems. These tools provide data, but they do not
              provide direction. As a result, many decisions are based on
              guesswork, leading to missed revenue opportunities, excess
              inventory, and operational inefficiencies.
            </p>
            <p className="cp-hero-body">
              Botella AI is an AI agent for liquor stores designed to
              eliminate guesswork and replace it with real-time, data-driven
              decision-making. It analyzes your sales, inventory, and
              customer data continuously to surface store activity insights
              that help teams act faster and operate more efficiently.
            </p>
            <p className="cp-hero-body">
              If you are looking for the best AI agent for liquor stores,
              Botella AI combines inventory management, analytics, and
              automation into a single intelligent system that works in
              real time.
            </p>
            <div className="cp-hero-cta">
              <button type="button" className="cp-btn-fill" onClick={openDemoPopup}>
                Book a Free Demo
              </button>
              <a href="#features" className="cp-btn-line">See Features →</a>
            </div>
          </div>

          {/* Real product screenshot - Botella chat answering a live data question. */}
          <div className="cp-hero-visual">
            <ScreenshotFrame
              src="/screenshots/chat-dead-stock.png"
              alt="Botella AI answering a question about dead stock with figures from the store's own sales data"
              ratio="1760 / 1100"   /* chat-dead-stock.png is 1760x1100 */
            />
          </div>
        </section>

        {/* ── WHAT IS AN AI AGENT ──────────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>What is an <i>AI Agent for Liquor Stores?</i></h2>
            <p>
              An AI agent for liquor stores is a system that uses artificial
              intelligence to analyze store data and automatically recommend
              or execute decisions that improve performance.
            </p>
            <p>
              Unlike traditional liquor store software or POS systems, which
              focus on recording transactions, an AI agent acts as a workflow
              and visibility layer that works alongside your existing systems.
            </p>
            <p><strong>It does not just show reports, it answers critical operational questions such as</strong></p>
          </div>

          <ul className="cp-bullet-list">
            <li>What products will run out soon?</li>
            <li>Which products may need operational review?</li>
            <li>Which products should your staff promote?</li>
            <li>Which items are reducing your margins?</li>
          </ul>

          <p className="cp-section-foot">
            Botella AI functions as a real-time decision engine, continuously
            organizing store activity into clearer operational visibility and
            improving recommendations over time.
          </p>
        </section>

        {/* ── WHY LIQUOR STORES NEED AI ─────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Why Liquor Stores <i>Need AI</i></h2>
            <p>
              Liquor retail is a data-heavy business, but most stores are
              not fully utilizing that data.
            </p>
            <p><strong>Without AI, store owners face several challenges</strong></p>
          </div>

          <ul className="cp-bullet-list">
            <li>Stockouts of high-demand products, leading to lost sales</li>
            <li>Dead stock that sits unsold and ties up capital</li>
            <li>Limited visibility into customer preferences and buying behavior</li>
            <li>Missed upselling and cross-selling opportunities</li>
            <li>Hours spent manually reviewing reports and spreadsheets</li>
          </ul>

          <p className="cp-section-foot">
            These challenges are not caused by lack of data - they are
            caused by lack of actionable insights. AI for liquor stores
            solves this by analyzing patterns across thousands of
            transactions and identifying opportunities in real time.
            Botella AI turns raw data into clear, prioritized recommendations
            so store owners can make faster, smarter decisions with
            confidence.
          </p>
        </section>

        {/* ── HOW BOTELLA AI WORKS ─────────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>How Botella AI Works <i>as an AI Agent</i></h2>
            <p>
              Botella AI connects to your existing POS or inventory system
              and continuously processes your store data.
            </p>
          </div>

          <ul className="cp-bullet-list">
            <li>Sales trends across products and categories</li>
            <li>Inventory movement and stock levels</li>
            <li>Customer purchase behavior</li>
            <li>Seasonal and time-based demand patterns</li>
          </ul>

          <p className="cp-section-foot">
            Using this data, it generates real-time insights and
            recommendations that help you optimize operations.
          </p>

          <ul className="cp-bullet-list">
            <li>It can identify when a product will run out based on sales velocity</li>
            <li>It can suggest which products to promote based on margin and demand</li>
            <li>It can identify slow-moving inventory before it becomes dead stock</li>
          </ul>

          <p className="cp-section-foot">
            This allows you to act proactively instead of reacting to
            problems after they occur.
          </p>
        </section>

        {/* ── AI-POWERED FEATURES ──────────────────────────────────── */}
        <section className="cp-section-v2" id="features">
          <div className="cp-section-head">
            <h2>AI-Powered Features for <i>Liquor Store Management</i></h2>
          </div>

          <div className="cp-feat-grid">
            <div className="cp-feat-card">
              <h3>AI Inventory Management for Liquor Stores</h3>
              <p>
                Botella AI provides real-time inventory visibility, low-stock
                alerts, and dead stock detection. It ensures you always
                maintain the right balance of products without overstocking
                or running out.
              </p>
            </div>
            <div className="cp-feat-card">
              <h3>Customer Insights and Purchase Behavior Analytics</h3>
              <p>
                Botella AI identifies your most valuable customers, tracks
                purchase patterns, and highlights trends. This enables
                better personalization and improved customer retention.
              </p>
            </div>
            <div className="cp-feat-card">
              <h3>Liquor Store Analytics and Sales Insights</h3>
              <p>
                Track top-performing products, peak sales hours, and category
                trends with real-time analytics designed specifically for
                liquor retail.
              </p>
            </div>
            <div className="cp-feat-card">
              <h3>Margin Optimization and Profit Intelligence</h3>
              <p>
                Botella AI shows which products generate the highest profit
                and which ones underperform, helping you optimize pricing
                and product mix.
              </p>
            </div>
            <div className="cp-feat-card">
              <h3>AI Product Recommendations for Staff</h3>
              <p>
                Botella AI provides real-time suggestions on what products
                to promote based on stock levels, margins, and customer
                behavior, improving upselling and overall sales performance.
              </p>
            </div>
          </div>
        </section>

        {/* ── COMPARISON TABLE ─────────────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Botella AI vs <i>Traditional Liquor Store Software</i></h2>
            <p>
              Traditional liquor store software focuses on tracking
              transactions and generating reports. Botella AI goes beyond
              reporting by acting as an intelligent assistant that drives
              decisions.
            </p>
          </div>

          <div className="cp-compare-pair">
            <div className="cp-compare-col good">
              <span className="cp-compare-lbl">Botella AI</span>
              <ul>
                <li>Demand Insights - Yes</li>
                <li>Customer Insights - Advanced</li>
                <li>Real-Time Alerts - Yes</li>
                <li>AI Recommendations - Yes</li>
              </ul>
            </div>
            <div className="cp-compare-col bad">
              <span className="cp-compare-lbl">Traditional POS</span>
              <ul>
                <li>Demand Insights - No</li>
                <li>Customer Insights - Basic</li>
                <li>Real-Time Alerts - No</li>
                <li>AI Recommendations - No</li>
              </ul>
            </div>
          </div>

          <p className="cp-section-foot">
            Botella AI does not replace your POS system; it enhances it by
            adding intelligence and automation.
          </p>
        </section>

        {/* ── BENEFITS ─────────────────────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Benefits of Using an <i>AI Agent in Liquor Stores</i></h2>
            <p>
              Using an AI agent like Botella AI leads to measurable
              improvements across your business.
            </p>
          </div>

          <div className="cp-feat-grid">
            <div className="cp-feat-card">
              <h3>Reduce Stockouts</h3>
              <p>Surface demand patterns and restock before products run out.</p>
            </div>
            <div className="cp-feat-card">
              <h3>Increase Margins</h3>
              <p>Focus on high-profit products and optimize pricing strategies.</p>
            </div>
            <div className="cp-feat-card">
              <h3>Save Time</h3>
              <p>Automate repetitive tasks like reporting and inventory decisions.</p>
            </div>
            <div className="cp-feat-card">
              <h3>Improve Customer Experience</h3>
              <p>Deliver better recommendations based on real customer behavior.</p>
            </div>
            <div className="cp-feat-card">
              <h3>Make Faster Decisions</h3>
              <p>Access real-time insights without manual analysis.</p>
            </div>
          </div>
        </section>

        {/* ── REAL-TIME ALERTS ─────────────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Real-Time Alerts <i>and Automation</i></h2>
            <p>
              Botella AI keeps you informed without requiring constant
              monitoring.
            </p>
            <p><strong>It sends automated updates via WhatsApp and email, including:</strong></p>
          </div>

          <ul className="cp-bullet-list">
            <li>Daily revenue summaries</li>
            <li>Low stock alerts</li>
            <li>Dead stock notifications</li>
            <li>AI-driven recommendations</li>
          </ul>

          <p className="cp-section-foot">
            This allows you to stay in control of your store even when you
            are not physically present.
          </p>
        </section>

        {/* ── SETUP AND IMPLEMENTATION ─────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Setup <i>and Implementation</i></h2>
            <p>
              Getting started with Botella AI is simple and does not
              require complex setup.
            </p>
          </div>

          <ul className="cp-bullet-list">
            <li>Connect your existing POS or inventory system</li>
            <li>Botella AI analyzes your historical sales and inventory data</li>
            <li>Start receiving insights and recommendations immediately</li>
            <li>The system continuously improves as it adapts to your workflows</li>
          </ul>

          <p className="cp-section-foot">
            Most liquor stores can be fully operational within a week.
          </p>
        </section>

        {/* ── FAQ ──────────────────────────────────────────────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Frequently <i>Asked Questions</i></h2>
          </div>
          <div className="cp-faq-grid">
            {AI_AGENT_FAQS.map((f, i) => (
              <div className="cp-faq-card" key={i}>
                <h3>{f.q}</h3>
                <p>{f.a}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── FINAL CTA ────────────────────────────────────────────── */}
        <section className="cp-final-cta">
          <h2>See Botella AI <i>in Action</i></h2>
          <p>
            Botella AI is built specifically for liquor stores looking to
            modernize operations with AI. From inventory management to
            sales optimization, it provides everything needed to run a
            smarter, more efficient, and more profitable store.
          </p>
          <p>
            Book a demo to see how Botella AI can help you automate your
            liquor store operations, reduce stockouts, and increase margins
            using AI.
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

export default AIAgentPage;
