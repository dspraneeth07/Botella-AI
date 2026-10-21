// SummarySections.js
// -----------------------------------------------------------------------------
// The Summary body, as a data-driven presentational component so it can render
// on its own page (InsightSummary) AND inside the merged Command Center without
// duplicating the logic or fetching twice.
//
// It takes already-fetched data and renders, in order:
//   1. HERO              - measured margin earned (holdout-honest) or, while the
//                          ledger is learning, "opportunity identified".
//   2. COUNTERS          - saved / open moves / gross margin / capital to free.
//   3. NEW FOR YOU       - new SKUs winning at nearby stores (cross-store net).
//   4. MISSED OPPORTUNITY- below-cost, stockout exposure, dead capital, moves.
//   5. CATEGORY COMPARE  - each category vs the store's own blended margin.
//
// Props: { dash, eff, recs, onRecommendations, onChat }. Styling lives in
// InsightSummary.css (the ins-* classes), imported by the host page.
// -----------------------------------------------------------------------------

import React, { useState, useEffect, useMemo } from 'react';
import { SHOW_CARD_CONFIDENCE } from '../utils/features';
import {
  Sparkles, TrendingUp, PackagePlus, AlertTriangle, ArrowRight,
  Coins, ShieldAlert, Boxes, Trophy, Radar,
} from 'lucide-react';

/* ── Formatters ──────────────────────────────────────────────────────────── */
const fmtMoney = (v) => '$' + Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const fmtNum = (v) => Number(v || 0).toLocaleString('en-US');
const fmtCompact = (v) => {
  const n = Number(v || 0);
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
};
const truncate = (s, n) => (!s ? '' : (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s)));
const firstSentence = (s) => {
  if (!s) return '';
  const m = String(s).match(/^.*?[.!?](\s|$)/);
  return truncate((m ? m[0] : String(s)).trim(), 150);
};
const ACTION_LABEL = {
  pre_stock: 'Pre-stock', endcap: 'Endcap', cold_box: 'Cold box', bundle: 'Bundle',
  markdown: 'Markdown', reorder: 'Reorder', liquidate: 'Liquidate', promote: 'Promote',
  stock_new: 'Stock new',
};

/* Rolling count-up for the hero figure (respects reduced-motion). */
function useCountUp(target, ms = 900) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !target) { setN(target || 0); return undefined; }
    let raf; const t0 = performance.now();
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / ms);
      setN(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return n;
}

/* Derive every figure the Summary body needs, once. Exposed as a hook so a host
   (the Command Center) can render the pieces in a different arrangement - e.g.
   the counter boxes under the KPI grid - without recomputing or duplicating. */
export function useSummaryData({ dash, eff, recs = [] }) {
  const kpis = dash?.kpis || {};
  const alerts = dash?.alerts || {};
  const inventory = dash?.inventory || {};
  const categories = useMemo(() => dash?.categoryBreakdown || [], [dash]);
  const effSummary = eff?.available ? (eff.summary || {}) : null;

  const savedDollars = effSummary
    ? (effSummary.margin_impact ?? effSummary.dollars?.won ?? effSummary.revenue_impact ?? null)
    : null;
  const winners = effSummary?.winners ?? 0;
  const actedWon = effSummary?.acted_and_won ?? 0;
  const network = eff?.network || null;
  const ledgerLive = savedDollars != null && savedDollars > 0;

  const newArrivals = useMemo(
    () => recs.filter((r) => r.category === 'new_arrival' || r.action_type === 'stock_new').slice(0, 4),
    [recs],
  );

  const deadStockValue = useMemo(
    () => (inventory.overstocked || []).reduce((s, it) => s + Number(it.onHand || 0) * Number(it.cost || 0), 0),
    [inventory],
  );

  const opportunities = useMemo(() => {
    const list = [];
    if (alerts.belowCostCount > 0) {
      list.push({ key: 'belowcost', tone: 'red', icon: <ShieldAlert size={15} />,
        title: `${fmtNum(alerts.belowCostCount)} product${alerts.belowCostCount === 1 ? '' : 's'} selling below cost`,
        detail: 'Every sale of these loses money. A price fix stops the bleed immediately.', stat: null });
    }
    if (alerts.outOfStockCount > 0) {
      list.push({ key: 'stockout', tone: 'amber', icon: <AlertTriangle size={15} />,
        title: `${fmtNum(alerts.outOfStockCount)} out of stock`,
        detail: alerts.restockCost ? `${fmtMoney(alerts.restockCost)} to restock. Every day out is a lost sale.` : 'Each day out of stock is a sale walking out the door.',
        stat: alerts.restockCost ? fmtCompact(alerts.restockCost) : null });
    }
    if (deadStockValue > 0) {
      list.push({ key: 'dead', tone: 'blue', icon: <Boxes size={15} />,
        title: `${fmtCompact(deadStockValue)} sitting in dead stock`,
        detail: 'Capital frozen on the shelf. Clear it and put the cash back to work.', stat: fmtCompact(deadStockValue) });
    }
    const moves = recs
      .filter((r) => ['markdown', 'liquidate', 'reorder', 'pre_stock', 'promote'].includes(r.action_type))
      .slice(0, 3)
      .map((r) => {
        const lead = (r.products && r.products[0]) || {};
        const name = lead.product_name || (r.primary_skus && r.primary_skus[0]) || 'this product';
        return { key: `rec-${r.id}`, tone: 'blue', icon: <TrendingUp size={15} />,
          title: `${ACTION_LABEL[r.action_type] || 'Act'}: ${truncate(name, 40)}`,
          detail: firstSentence(r.rationale),
          // The raw `confidence` field, withdrawn from the owner's view
          // (SHOW_CARD_CONFIDENCE, features.js): not a probability.
          stat: SHOW_CARD_CONFIDENCE && r.confidence ? `${Math.round(r.confidence * 100)}%` : null };
      });
    return [...list, ...moves].slice(0, 5);
  }, [alerts, deadStockValue, recs]);

  const catCompare = useMemo(() => {
    const rows = categories
      .map((c) => ({
        category: c.category,
        revenue: Number(c.revenue || 0),
        profit: Number(c.profit || 0),
        margin: c.revenue ? (Number(c.profit || 0) / Number(c.revenue)) * 100 : null,
      }))
      .filter((r) => r.revenue > 0)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 8);
    const totRev = rows.reduce((s, r) => s + r.revenue, 0);
    const totProf = rows.reduce((s, r) => s + r.profit, 0);
    const avgMargin = totRev ? (totProf / totRev) * 100 : null;
    const maxRev = rows.reduce((m, r) => Math.max(m, r.revenue), 0) || 1;
    const marginKnown = rows.some((r) => r.margin != null) && totProf !== 0;
    return { rows, avgMargin, maxRev, marginKnown };
  }, [categories]);

  const counters = useMemo(() => {
    const c = [];
    c.push({ key: 'saved', tone: 'teal', icon: <Trophy size={16} />,
      label: ledgerLive ? 'Margin earned so far' : 'Opportunities identified',
      value: ledgerLive ? fmtCompact(savedDollars) : fmtNum(recs.length),
      meta: ledgerLive ? `${fmtNum(winners)} proven winner${winners === 1 ? '' : 's'}` : 'ready to act on now' });
    c.push({ key: 'moves', tone: 'blue', icon: <Sparkles size={16} />,
      label: 'Open moves', value: fmtNum(recs.length),
      meta: newArrivals.length ? `${fmtNum(newArrivals.length)} new to your shelf` : 'waiting for you' });
    if (kpis.grossMarginPct != null) {
      c.push({ key: 'margin', tone: 'blue', icon: <Coins size={16} />,
        label: 'Gross margin', value: `${Number(kpis.grossMarginPct).toFixed(1)}%`,
        meta: alerts.belowCostCount ? `${fmtNum(alerts.belowCostCount)} below-cost to fix` : 'last 90 days' });
    }
    if (deadStockValue > 0) {
      c.push({ key: 'capital', tone: 'teal', icon: <Boxes size={16} />,
        label: 'Capital to free', value: fmtCompact(deadStockValue), meta: 'frozen in dead stock' });
    }
    return c.slice(0, 4);
  }, [ledgerLive, savedDollars, winners, recs, newArrivals, kpis, alerts, deadStockValue]);

  return {
    ledgerLive, savedDollars, winners, actedWon, network,
    recsLen: recs.length, newArrivals, alerts, deadStockValue,
    opportunities, catCompare, counters,
  };
}

/* ── Hero (measured impact / opportunity found) ──────────────────────────── */
export function SummaryHero({ data, onRecommendations }) {
  const { ledgerLive, savedDollars, winners, actedWon, network, recsLen, newArrivals, alerts, deadStockValue } = data;
  const savedDisplay = useCountUp(ledgerLive ? savedDollars : 0);
  const goRecs = () => onRecommendations && onRecommendations();
  return (
      <section className={`ins-hero ${ledgerLive ? 'is-live' : 'is-learning'}`}>
        <div className="ins-hero-glow" aria-hidden="true" />
        <div className="ins-hero-l">
          <span className="ins-hero-kicker">
            {ledgerLive ? <><Trophy size={14} /> Measured Impact, Last 30 Days</> : <><Sparkles size={14} /> Identified Opportunities</>}
          </span>
          {ledgerLive ? (
            <>
              <div className="ins-hero-value">{fmtMoney(savedDisplay)}</div>
              <p className="ins-hero-sub">in gross margin your Botella recommendations have <strong>provably earned</strong>, measured against each product’s own baseline, with the wins you can’t take credit for stripped out.</p>
              <div className="ins-hero-chips">
                <span className="ins-chip"><Trophy size={12} /> {fmtNum(winners)} proven winners</span>
                {actedWon > 0 && <span className="ins-chip"><TrendingUp size={12} /> {fmtNum(actedWon)} acted &amp; won</span>}
                {network?.this_store_win_rate != null && network?.avg_win_rate != null && (
                  <span className="ins-chip">{Math.round(network.this_store_win_rate * 100)}% win rate vs {Math.round(network.avg_win_rate * 100)}% network</span>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="ins-hero-value">{fmtNum(recsLen)}<span className="ins-hero-unit"> moves</span></div>
              <p className="ins-hero-sub">waiting for you right now. As you act on them, Botella measures what each one earns against its own baseline, and this number becomes <strong>dollars proven</strong>, the one figure no POS can ever show you.</p>
              <div className="ins-hero-chips">
                {newArrivals.length > 0 && <span className="ins-chip"><PackagePlus size={12} /> {fmtNum(newArrivals.length)} new SKUs to stock</span>}
                {alerts.belowCostCount > 0 && <span className="ins-chip"><ShieldAlert size={12} /> {fmtNum(alerts.belowCostCount)} below-cost to fix</span>}
                {deadStockValue > 0 && <span className="ins-chip"><Boxes size={12} /> {fmtCompact(deadStockValue)} to free</span>}
              </div>
            </>
          )}
        </div>
        <button type="button" className="ins-hero-cta" onClick={goRecs}>
          <Sparkles size={16} /> Review your moves <ArrowRight size={15} />
        </button>
      </section>
  );
}

/* ── Opportunity counters (the 4 boxes) ──────────────────────────────────── */
export function SummaryCounters({ counters }) {
  if (!counters || counters.length === 0) return null;
  return (
    <div className="ins-counters">
      {counters.map((c) => (
        <div key={c.key} className={`ins-counter ins-tone-${c.tone}`}>
          <span className="ins-counter-icon">{c.icon}</span>
          <div className="ins-counter-body">
            <div className="ins-counter-value">{c.value}</div>
            <div className="ins-counter-label">{c.label}</div>
            <div className="ins-counter-meta">{c.meta}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── New-for-you + Missed opportunity + Category comparison ──────────────── */
export function SummaryFindings({ data, onRecommendations, onChat }) {
  const { newArrivals, opportunities, catCompare } = data;
  const goRecs = () => onRecommendations && onRecommendations();
  return (
    <>
      {/* NEW FOR YOU  +  MISSED OPPORTUNITY */}
      <div className="ins-grid">
        <section className="ins-card">
          <header className="ins-card-head">
            <div className="ins-card-titles">
              <span className="ins-kicker ins-kicker-teal"><PackagePlus size={13} /> Assortment Opportunities</span>
              <h3>Top sellers at nearby stores you don’t stock</h3>
            </div>
          </header>
          {newArrivals.length === 0 ? (
            <div className="ins-empty">
              <Radar size={22} />
              <p>No new-arrival signals for your area yet. This fills in as nearby stores add products and Botella spots what’s moving.</p>
            </div>
          ) : (
            <ul className="ins-newlist">
              {newArrivals.map((r) => {
                const lead = (r.products && r.products[0]) || {};
                const name = lead.product_name || (r.primary_skus && r.primary_skus[0]) || 'New product';
                return (
                  <li key={r.id} className="ins-newitem">
                    <span className="ins-newbadge"><PackagePlus size={14} /></span>
                    <div className="ins-newbody">
                      <div className="ins-newtop">
                        <span className="ins-newname" title={name}>{truncate(name, 40)}</span>
                        {SHOW_CARD_CONFIDENCE && r.confidence != null && <span className="ins-conf">{Math.round(r.confidence * 100)}%</span>}
                      </div>
                      <p className="ins-newwhy">{firstSentence(r.rationale) || 'Selling well at stores near you.'}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <button type="button" className="ins-card-cta" onClick={goRecs}>See the full assortment plan <ArrowRight size={14} /></button>
        </section>

        <section className="ins-card">
          <header className="ins-card-head">
            <div className="ins-card-titles">
              <span className="ins-kicker ins-kicker-red"><AlertTriangle size={13} /> Revenue at Risk</span>
              <h3>Top Revenue Opportunities Missed</h3>
            </div>
          </header>
          {opportunities.length === 0 ? (
            <div className="ins-empty">
              <TrendingUp size={22} />
              <p>Nothing urgent leaking today. No below-cost lines, stockouts or dead stock detected. Nicely run.</p>
            </div>
          ) : (
            <ul className="ins-opplist">
              {opportunities.map((o) => (
                <li key={o.key} className={`ins-oppitem ins-opp-${o.tone}`}>
                  <span className="ins-oppicon">{o.icon}</span>
                  <div className="ins-oppbody">
                    <div className="ins-opptop">
                      <span className="ins-opptitle">{o.title}</span>
                      {o.stat && <span className="ins-oppstat">{o.stat}</span>}
                    </div>
                    <p className="ins-oppdetail">{o.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="ins-card-cta" onClick={onChat ? () => onChat() : goRecs}>
            Ask Botella how to fix these <ArrowRight size={14} />
          </button>
        </section>
      </div>

      {/* 5. CATEGORY COMPARISON */}
      {catCompare.rows.length > 0 && (
        <section className="ins-card ins-cat">
          <header className="ins-card-head">
            <div className="ins-card-titles">
              <span className="ins-kicker"><TrendingUp size={13} /> Category Performance</span>
              <h3>Margin contribution by category</h3>
            </div>
            {catCompare.marginKnown && catCompare.avgMargin != null && (
              <span className="ins-cat-avg">Store margin <strong>{catCompare.avgMargin.toFixed(1)}%</strong></span>
            )}
          </header>
          <div className="ins-cat-rows">
            {catCompare.rows.map((r) => {
              const over = catCompare.avgMargin != null && r.margin != null ? r.margin - catCompare.avgMargin : null;
              const tone = over == null ? 'flat' : over >= 0 ? 'good' : 'bad';
              return (
                <div key={r.category} className="ins-cat-row">
                  <span className="ins-cat-name" title={r.category}>{truncate(r.category, 22)}</span>
                  <span className="ins-cat-bar-wrap">
                    <span className="ins-cat-bar" style={{ width: `${Math.max(4, (r.revenue / catCompare.maxRev) * 100)}%` }} />
                  </span>
                  <span className="ins-cat-rev">{fmtMoney(r.revenue)}</span>
                  {catCompare.marginKnown ? (
                    <span className={`ins-cat-margin ins-margin-${tone}`}>
                      {r.margin != null ? `${r.margin.toFixed(0)}%` : 'n/a'}
                      {over != null && Math.abs(over) >= 0.5 && (<em>{over >= 0 ? '▲' : '▼'} {Math.abs(over).toFixed(0)}</em>)}
                    </span>
                  ) : <span className="ins-cat-margin ins-margin-flat">n/a</span>}
                </div>
              );
            })}
          </div>
          {!catCompare.marginKnown && (
            <p className="ins-cat-note">Margin comparison unlocks once product costs are recorded. Each category is then scored against your own blended margin.</p>
          )}
        </section>
      )}
    </>
  );
}

/* Default: the whole Summary body in its canonical order - used by the
   standalone Summary page. The Command Center composes the parts itself. */
export default function SummarySections({ dash, eff, recs = [], onRecommendations, onChat }) {
  const data = useSummaryData({ dash, eff, recs });
  return (
    <>
      <SummaryHero data={data} onRecommendations={onRecommendations} />
      <SummaryCounters counters={data.counters} />
      <SummaryFindings data={data} onRecommendations={onRecommendations} onChat={onChat} />
    </>
  );
}
