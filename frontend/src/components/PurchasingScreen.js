// PurchasingScreen.js - Purchasing (§7.2)
// -----------------------------------------------------------------------------
// The Buying Report as a dedicated, lightweight reference screen. Renders the
// shell instantly and loads the (cached) buying data async - no more sticking
// on the heavy StoreAgent panel. Three tabs: Reorder · Out of stock · Clear.
// Reference only: sorted, exportable, no row actions (§4.1). Neutral wording
// ("order needed", "qty to cover") - never "recommend" on a reference screen.
// -----------------------------------------------------------------------------

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ShoppingCart, Download } from 'lucide-react';
import './ReferenceScreen.css';
import { retrievalError } from '../storeagent/retrieval';
import RetrievalNotice from './RetrievalNotice';
import MetricInfo from './MetricInfo';
import { markRecommendations } from '../utils/crossLink';
import { cardsBySku, rowFigures } from '../utils/cover';
import { useCellTitles } from '../utils/useCellTitles';

const money = (v) => '$' + Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const num = (v) => (v == null ? 'n/a' : Number(v).toLocaleString('en-US'));
// Ten, not eight: a page of results should be a round number, and eight left
// the table visibly shorter than the space allotted to it.
const ROWS_PER_PAGE = 10;

// D3: velocity buckets from units_90 (units sold in the last 90 days). The
// payload carries no velocity field, so this is derived - the thresholds are
// stated here rather than hidden in the markup.
function velocityOf(r) {
  const u = Number(r.units_90) || 0;
  if (u === 0) return r.last_sold ? 'dead' : 'never';
  if (u >= 90) return 'fast';
  if (u >= 30) return 'normal';
  return 'slow';
}
const VELOCITY_TABS = [['all', 'All'], ['fast', 'Fast'], ['normal', 'Normal'], ['slow', 'Slow'], ['dead', 'Dead'], ['never', 'Never sold']];

const truncate = (s, n) => (!s ? '' : (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s)));

// D1: an "Order by" date - coloured red ≤3 days, amber ≤7, neutral beyond.
// Replaces the raw "true risk" internal field that leaked into the Next-step
// column.
//
// WHERE THE DATE AND THE QUANTITY COME FROM (utils/cover.js rowFigures). A row
// whose SKU has an active recommendation shows the CARD'S quantity and the
// CARD'S stored order-by date - the engine decided both once (migration 042),
// and this tab reads them rather than recomputing. A row with no card keeps
// this tab's quantity and the shared cover arithmetic on the engine's declared
// lead. The maths moved to utils/cover.js so the cards run the SAME
// calculation; a private copy here, with a lead of three against the card's
// seven, is what let the two screens print Oct 22 and Oct 19 for Weber Ranch
// 1L on the same morning.
const fmtDate = (d) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const FROM_CARD_TITLE = 'From your recommendation: the same quantity and order-by date the Recommendations card shows for this product.';
const proxClass = (days) => (days <= 3 ? 'ref-due-red' : days <= 7 ? 'ref-due-amber' : 'ref-due-later');

export default function PurchasingScreen({ authToken, apiUrl, onNavigate }) {
  const [data, setData] = useState(null);
  const [coveredSkus, setCoveredSkus] = useState(() => new Set());
  // SKU -> the card that covers it, so a row can show the card's own quantity
  // and date instead of a rival answer from this tab's formula.
  const [cardBySku, setCardBySku] = useState(() => new Map());
  const [recCount, setRecCount] = useState(0);
  const [recIds, setRecIds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('reorder');
  // D3: velocity filter, applied across Reorder / Out of stock / Clear.
  const [velocity, setVelocity] = useState('all');
  const [page, setPage] = useState(0);
  // C1: arrived-from-a-recommendation context (rows to highlight + return path).
  const [highlight, setHighlight] = useState(() => {
    try { const raw = sessionStorage.getItem('botella_ref_highlight'); if (raw) { sessionStorage.removeItem('botella_ref_highlight'); return JSON.parse(raw); } } catch { /* no-op */ }
    return null;
  });
  const hiSkus = useMemo(() => new Set((highlight?.skus || []).map(String)), [highlight]);
  const firstHiRef = React.useRef(null);
  const base = useMemo(() => (apiUrl || '').replace(/\/api\/?$/, ''), [apiUrl]);
  const headers = useMemo(() => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}`, 'ngrok-skip-browser-warning': 'true' }), [authToken]);

  const fetchAll = useCallback(async () => {
    setLoading(true); setError(null);
    const get = async (p) => { const r = await fetch(`${base}${p}`, { headers }); if (r.status === 401) { localStorage.removeItem('botella_token'); window.location.href = '/login'; throw new Error('unauth'); } if (!r.ok) throw await retrievalError(r, `${p} ${r.status}`); return r.json(); };
    try {
      const [b, l] = await Promise.allSettled([get('/api/storeagent/buying'), get('/api/recommendations/latest')]);
      if (b.status === 'fulfilled') setData(b.value); else throw b.reason;
      if (l.status === 'fulfilled') {
        const recs = (l.value?.recommendations || []).filter((r) => ['reorder', 'pre_stock', 'liquidate', 'markdown'].includes(r.action_type));
        // D2: cover every SKU a recommendation touches - both its primary_skus
        // and its full products[] list (Jim Beam's 3 SKUs, cold-box/endcap SKUs).
        const s = new Set();
        recs.forEach((r) => {
          (r.primary_skus || []).forEach((sku) => s.add(String(sku)));
          (r.products || []).forEach((p) => { if (p && p.sku) s.add(String(p.sku)); });
        });
        setCoveredSkus(s); setCardBySku(cardsBySku(recs)); setRecCount(recs.length); setRecIds(recs.map((r) => r.id));
      }
    } catch (e) { setError(e); }
    finally { setLoading(false); }
  }, [base, headers]);

  useEffect(() => { if (authToken) fetchAll().catch(() => {}); }, [authToken, fetchAll]);
  // C1: scroll the first covered row into view once the table has data.
  useEffect(() => { if (highlight && firstHiRef.current) firstHiRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [highlight, data]);

  const buying = data?.buying || {};
  const lost = data?.lost_sales || {};
  const reorder = buying.buy_list || [];
  const outOfStock = lost.items || [];
  const clear = buying.dont_buy_list || [];

  const exportCsv = (rows, cols, name) => {
    const head = cols.map((c) => c.label).join(',');
    const lines = rows.map((r) => cols.map((c) => `"${String(c.val(r) ?? '').replace(/"/g, '""')}"`).join(','));
    const blob = new Blob(['﻿' + [head, ...lines].join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  };
  const covered = (sku) => coveredSkus.has(String(sku));
  // The row's "Qty to cover" and "Order by": the covering card's where one
  // exists, this tab's formula otherwise. One call per row, used by the sort,
  // the cells and the CSV so none of the three can disagree.
  const figuresFor = useCallback((r) => rowFigures(r, cardBySku.get(String(r.sku))), [cardBySku]);
  // syncgo carries no supplier for some tenants, so the column rendered "n/a"
  // on every row and cost the product name the width it needed. Drop it when
  // it has nothing to say; keep it the moment one row does.
  const hasSupplier = useMemo(
    () => reorder.some((r) => r.supplier && String(r.supplier).trim() && String(r.supplier).trim().toLowerCase() !== 'n/a'),
    [reorder],
  );

  const TABS = [['reorder', 'Reorder', reorder.length], ['out-of-stock', 'Out of stock', outOfStock.length], ['clear', 'Clear', clear.length]];

  // D3: the velocity control filters whichever tab is showing, and its counts
  // describe that tab - so switching tabs re-counts rather than going stale.
  const activeRows = tab === 'reorder' ? reorder : tab === 'out-of-stock' ? outOfStock : clear;
  const velocityCounts = useMemo(() => {
    const out = { all: activeRows.length, fast: 0, normal: 0, slow: 0, dead: 0, never: 0 };
    activeRows.forEach((r) => { out[velocityOf(r)] += 1; });
    return out;
  }, [activeRows]);
  const filteredRows = useMemo(() => {
    const rows = velocity === 'all' ? activeRows : activeRows.filter((r) => velocityOf(r) === velocity);
    // The footer says "sorted by order-by date" and, until now, nothing sorted:
    // the buy list arrived in the API's order, so Dec 5 sat above Sep 15 under
    // a line promising the opposite. Soonest first, rows with no measurable
    // velocity (and therefore no honest date) last rather than at the top.
    if (tab !== 'reorder') return rows;
    return rows.slice().sort((a, b) => {
      const da = figuresFor(a).orderBy; const db = figuresFor(b).orderBy;
      const ka = da ? da.dueInDays : Infinity;
      const kb = db ? db.dueInDays : Infinity;
      return ka - kb;
    });
  }, [activeRows, velocity, tab, figuresFor]);
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / ROWS_PER_PAGE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = filteredRows.slice(safePage * ROWS_PER_PAGE, safePage * ROWS_PER_PAGE + ROWS_PER_PAGE);
  const firstShown = filteredRows.length === 0 ? 0 : safePage * ROWS_PER_PAGE + 1;
  const lastShown = Math.min(filteredRows.length, (safePage + 1) * ROWS_PER_PAGE);
  const SORT_NOTE = { reorder: 'order-by date', 'out-of-stock': 'lost revenue', clear: 'capital tied up' }[tab];

  // A tooltip on any cell whose text is clipped - measured, not guessed.
  useCellTitles(null, [data, tab, page, velocity]);

  return (
    <div className="ref-page">
      <header className="ref-head">
        <h1 className="ref-title"><ShoppingCart size={20} /> Purchasing</h1>
        <p className="ref-sub">Build this week’s order and decide what to clear.</p>
      </header>

      {loading ? (
        <div className="ref-skel-tiles">{[0, 1, 2].map((i) => <div key={i} className="ref-skel-tile" />)}</div>
      ) : error ? (
        <RetrievalNotice sample="purchasing" error={error} label="Buying recommendations" onRetry={fetchAll} />
      ) : (
        <>
          {/* Header totals (§7.2.1) */}
          <div className="ref-tiles" style={{ gridTemplateColumns: 'repeat(3, minmax(0,1fr))' }}>
            <div className="ref-tile ref-tile-ac"><span className="ref-tile-label">Order needed to cover demand<MetricInfo label="Order needed to cover demand" sqlKey="buying.buy_total_value" info="What it would cost you, at your own cost price, to bring every product on the reorder list back up to the quantity that covers demand until your next delivery. It is a shopping list total, not a bill - nothing has been ordered." /></span><span className="ref-tile-value">{money(buying.buy_total_value)}</span><span className="ref-tile-note">at cost · {num(buying.buy_sku_count)} SKUs · {num(buying.buy_units_total)} units</span></div>
            <div className="ref-tile ref-tile-rd"><span className="ref-tile-label">Daily lost sales (est.)<MetricInfo label="Daily lost sales (est.)" sqlKey="buying.ongoing_daily_loss" info="Revenue you are missing each day that fast movers stay out of stock, from how quickly each one was selling before it ran out. It keeps accruing until the shelf is refilled." /></span><span className="ref-tile-value">{money(lost.ongoing_daily_loss)}</span><span className="ref-tile-note">{num(lost.stockout_sku_count)} fast movers out of stock</span></div>
            <div className="ref-tile ref-tile-am"><span className="ref-tile-label">Capital in dead stock<MetricInfo label="Capital in dead stock" sqlKey="buying.dont_buy_capital_tied" info="What you already paid for stock that has not sold recently. The money is spent, but it is sitting on a shelf instead of turning over - clearing it is what frees it up." /></span><span className="ref-tile-value">{money(buying.dont_buy_capital_tied)}</span><span className="ref-tile-note">{num(buying.dont_buy_sku_count)} products with no recent sales</span></div>
          </div>

          {recCount > 0 && (
            <div className="ref-reco-line"><span><strong>{recCount}</strong> active recommendation{recCount === 1 ? '' : 's'} cover rows in this report, marked ● Recommended.</span>
              <button type="button" className="ref-reco-link" onClick={() => { markRecommendations(recIds, 'Purchasing'); onNavigate && onNavigate('recommendations'); }}>{recCount} recommendations →</button>
            </div>
          )}

          {/* Tabs */}
          <div className="ref-subtabs">
            {TABS.map(([k, label, n]) => (
              <button key={k} type="button" className={`ref-subtab ${tab === k ? 'is-on' : ''}`} onClick={() => { setTab(k); setPage(0); }}>{label} <span className="ref-subtab-count">{n}</span></button>
            ))}
            {/* D3 · V23: velocity as one joined segmented control, right of the tabs. */}
            <div className="ref-velocity">
              <span className="ref-velocity-label">Velocity</span>
              <div className="ref-segmented" role="tablist" aria-label="Velocity">
                {VELOCITY_TABS.map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={velocity === k}
                    className={`ref-segmented-btn ${velocity === k ? 'is-on' : ''}`}
                    onClick={() => { setVelocity(k); setPage(0); }}
                  >
                    {label}{k !== 'all' && <span className="ref-segmented-count">{num(velocityCounts[k])}</span>}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <section className="ref-card">
            <header className="ref-card-head">
              <div className="ref-card-titles">
                <span className="ref-card-title">
                  {tab === 'reorder' ? 'Reorder list' : tab === 'out-of-stock' ? 'Out of stock: lost revenue' : 'Clear: no recent sales'}
                  <MetricInfo
                    label={tab === 'reorder' ? 'Reorder list' : tab === 'out-of-stock' ? 'Out of stock: lost revenue' : 'Clear: no recent sales'}
                    sqlKey={tab === 'reorder' ? 'buying.buy_list' : tab === 'out-of-stock' ? 'buying.lost_sales' : 'buying.dont_buy_list'}
                    info={tab === 'reorder'
                      ? 'Quantities needed to cover demand until your next delivery, worked out from your own sales velocity and what is on hand. Estimates, not commitments.'
                      : tab === 'out-of-stock'
                        ? 'Fast movers with nothing on the shelf, and the revenue each one is losing while it stays out.'
                        : 'Products with no recent sales, and the capital they are tying up.'}
                  />
                </span>
                {tab === 'reorder' && (
                  <p className="ref-card-sub">
                    Quantities needed to cover demand until your next delivery, from your sales velocity and stock on hand.
                    <span className="ref-est-note">Quantities are estimates.</span>
                  </p>
                )}
              </div>
              <button type="button" className="ref-btn" onClick={() => {
                if (tab === 'reorder') exportCsv(reorder, [{ label: 'Product', val: (r) => r.product_name }, { label: 'Supplier', val: (r) => r.supplier }, { label: 'On hand', val: (r) => r.on_hand }, { label: 'Sold 90d', val: (r) => r.units_90 }, { label: 'Qty to cover', val: (r) => figuresFor(r).qty }, { label: 'Order by', val: (r) => { const o = figuresFor(r).orderBy; return o ? o.iso : ''; } }, { label: 'Source', val: (r) => (figuresFor(r).qtySource === 'card' ? 'recommendation' : 'buying formula') }], 'botella-reorder.csv');
                else if (tab === 'out-of-stock') exportCsv(outOfStock, [{ label: 'Product', val: (r) => r.product_name }, { label: 'Lost revenue', val: (r) => r.lost_revenue || r.lost_revenue_90d }], 'botella-out-of-stock.csv');
                else exportCsv(clear, [{ label: 'Product', val: (r) => r.product_name }, { label: 'On hand', val: (r) => r.on_hand }, { label: 'Capital tied', val: (r) => r.capital_tied }], 'botella-clear.csv');
              }}><Download size={14} /> Export CSV</button>
            </header>
            <div className="ref-table-wrap">
              {tab === 'reorder' && (
                <table className="ref-table">
                  <thead><tr><th>Product</th>{hasSupplier && <th>Supplier</th>}<th className="ref-num">On hand</th><th className="ref-num">Sold 90d</th><th className="ref-num">Qty to cover</th><th>Order by</th><th></th></tr></thead>
                  <tbody>
                    {pageRows.map((r, i) => {
                      const hi = hiSkus.has(String(r.sku));
                      const isFirstHi = hi && !pageRows.slice(0, i).some((x) => hiSkus.has(String(x.sku)));
                      return (
                      <tr key={r.sku || i} className={hi ? 'ref-row-hi' : ''} ref={isFirstHi ? firstHiRef : null}>
                        <td className="ref-name" title={r.product_name}>{truncate(r.product_name, 40)}</td>
                        {hasSupplier && <td title={r.supplier || ''}>{r.supplier || 'n/a'}</td>}<td className="ref-num">{num(r.on_hand)}</td><td className="ref-num">{num(r.units_90)}</td>
                        {(() => {
                          const f = figuresFor(r);
                          const fromCard = f.qtySource === 'card';
                          const o = f.orderBy;
                          return (
                            <>
                              {/* The provenance stays on the hover title; the
                                  second line it used to print ("from your
                                  recommendation") made those rows taller than
                                  the rest of the table (22 Oct 2026). */}
                              <td className="ref-num ref-strong" title={fromCard ? FROM_CARD_TITLE : undefined}>
                                {num(f.qty)}
                              </td>
                              <td title={o && o.source === 'engine' ? FROM_CARD_TITLE : undefined}>
                                {o ? <span className={`ref-due ${proxClass(o.dueInDays)}`}>{fmtDate(o.date)}</span> : <span className="ref-due ref-due-later">n/a</span>}
                              </td>
                            </>
                          );
                        })()}
                        <td>{covered(r.sku) && <span className="ref-reco-mark" title={FROM_CARD_TITLE}><span className="ref-reco-dot" /> Recommended</span>}</td>
                      </tr>
                      ); })}
                  </tbody>
                </table>
              )}
              {tab === 'out-of-stock' && (
                <table className="ref-table">
                  <thead><tr><th>Product</th><th className="ref-num">Days out</th><th className="ref-num">Lost revenue (est.)</th><th></th></tr></thead>
                  <tbody>
                    {pageRows.map((r, i) => (
                      <tr key={r.sku || i}>
                        <td className="ref-name" title={r.product_name}>{truncate(r.product_name, 40)}</td>
                        <td className="ref-num">{num(r.days_out)}</td>
                        <td className="ref-num ref-bad">{money(r.lost_revenue || r.lost_revenue_90d || 0)}</td>
                        <td>{covered(r.sku) && <span className="ref-reco-mark"><span className="ref-reco-dot" /> Recommended</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {tab === 'clear' && (
                <table className="ref-table">
                  <thead><tr><th>Product</th><th className="ref-num">On hand</th><th className="ref-num">Capital tied</th><th>Why</th><th></th></tr></thead>
                  <tbody>
                    {pageRows.map((r, i) => (
                      <tr key={r.sku || i}>
                        <td className="ref-name" title={r.product_name}>{truncate(r.product_name, 40)}</td>
                        <td className="ref-num">{num(r.on_hand)}</td>
                        <td className="ref-num">{money(r.capital_tied || 0)}</td>
                        <td title={r.reason || (r.weeks_of_cover ? `${r.weeks_of_cover} weeks of cover at the current rate` : 'No sales in the trailing window')}>{r.reason || (r.weeks_of_cover ? `${r.weeks_of_cover}w cover` : 'no recent sales')}</td>
                        <td>{covered(r.sku) && <span className="ref-reco-mark"><span className="ref-reco-dot" /> Recommended</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <footer className="ref-tfoot">
              <span className="ref-tfoot-showing">
                {filteredRows.length === 0
                  ? 'No rows match this filter'
                  : `Showing ${num(firstShown)}-${num(lastShown)} of ${num(filteredRows.length)} · sorted by ${SORT_NOTE}`}
              </span>
              <span className="ref-tfoot-pager">
                <button type="button" className="ref-pager-btn" disabled={safePage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>&larr; Prev</button>
                <span className="ref-pager-pos">{safePage + 1} / {pageCount}</span>
                <button type="button" className="ref-pager-btn" disabled={safePage >= pageCount - 1} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}>Next &rarr;</button>
              </span>
            </footer>
          </section>

          <button type="button" className="ref-reco-link" style={{ marginBottom: 16 }} onClick={() => onNavigate && onNavigate('market')}>Products carried by comparable stores you don’t stock → Market Comparison</button>
        </>
      )}

      <div className="ref-disclaimer"><strong>Important:</strong> Recommendations, projections and estimates are generated automatically from your store’s data and third-party signals (weather, events, comparable-store benchmarks). They may be incomplete or inaccurate, are provided for informational purposes only, and do not constitute financial, legal or business advice. Verify against your own records before making purchasing, pricing, staffing or other business decisions. Botella is not responsible for decisions made in reliance on this information.</div>
    </div>
  );
}
