// MarketComparisonScreen.js - Market Comparison (§7.3)
// -----------------------------------------------------------------------------
// A dedicated, lightweight reference screen (replaces deep-linking into the
// heavy StoreAgent panel - that was the "sticking at market intelligence" lag).
// It renders the shell INSTANTLY and loads the comparable-store data async, so
// navigating here is snappy even while the (cached) market payload arrives.
//
// Reference only: sorted, exportable, no row actions. Evidence is the last
// 90 days; projections are per year, shown as ranges marked (est.) (§4.5-4.6).
// -----------------------------------------------------------------------------

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Store, Download, Loader } from 'lucide-react';
import './ReferenceScreen.css';
import { retrievalError } from '../storeagent/retrieval';
import RetrievalNotice from './RetrievalNotice';
import MetricInfo from './MetricInfo';
import { markRecommendations } from '../utils/crossLink';
import { useTablePage } from '../utils/useTablePage';
import TablePager from './TablePager';
import { useCellTitles } from '../utils/useCellTitles';

const money = (v) => '$' + Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const money2 = (v) => '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (v) => Number(v || 0).toLocaleString('en-US');
const truncate = (s, n) => (!s ? '' : (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s)));
// A projected figure shown as a ±15% range (§4.5 - single precision reads as a report).
// E1: projected ranges are whole numbers - "118-160", never "118.15-159.85".
const range = (v, fmt = num) => { const a = Number(v || 0); return `${fmt(Math.round(a * 0.85))}-${fmt(Math.round(a * 1.15)).replace('$', '')}`; };
const confFor = (peerStores) => (peerStores >= 20 ? 'Good' : peerStores >= 8 ? 'Fair' : 'Low');

export default function MarketComparisonScreen({ authToken, apiUrl, onNavigate }) {
  const [mk, setMk] = useState(null);
  const [coveredSkus, setCoveredSkus] = useState(() => new Set());
  const [recCount, setRecCount] = useState(0);
  const [recIds, setRecIds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const base = useMemo(() => (apiUrl || '').replace(/\/api\/?$/, ''), [apiUrl]);
  const headers = useMemo(() => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}`, 'ngrok-skip-browser-warning': 'true' }), [authToken]);

  const fetchMarket = useCallback(async () => {
    setLoading(true); setError(null);
    const get = async (p) => { const r = await fetch(`${base}${p}`, { headers }); if (r.status === 401) { localStorage.removeItem('botella_token'); window.location.href = '/login'; throw new Error('unauth'); } if (!r.ok) throw await retrievalError(r, `${p} ${r.status}`); return r.json(); };
    try {
      // The real backend capability is `market` - `pricing_market` is only a
      // UI-composite name in the legacy StoreAgent panel, not an API route.
      const [m, l] = await Promise.allSettled([get('/api/storeagent/market'), get('/api/recommendations/latest')]);
      if (m.status !== 'fulfilled') throw m.reason;
      setMk(m.value?.market || m.value?.pricing_market?.market || m.value || null);
      // E2: mark rows covered by assortment/pricing recommendations.
      if (l.status === 'fulfilled') {
        const recs = (l.value?.recommendations || []).filter((r) => ['stock_new', 'promote', 'reprice', 'endcap', 'bundle'].includes(r.action_type));
        // Collect every identifier a recommendation can carry, not just SKUs.
        // The assortment table lists products the store does NOT stock, so those
        // rows have a UPC and no local SKU - and a stock_new recommendation
        // anchors on `reference_upc` for exactly that reason. Matching on SKU
        // alone could therefore never mark a single assortment row, which is why
        // the banner counted five and the table highlighted none.
        const s = new Set();
        const add = (v) => { if (v != null && String(v).trim()) s.add(String(v).trim()); };
        recs.forEach((r) => {
          (r.primary_skus || []).forEach(add);
          add(r.reference_upc);
          (r.products || []).forEach((p) => { add(p.sku); add(p.upc); });
        });
        setCoveredSkus(s); setRecCount(recs.length); setRecIds(recs.map((r) => r.id));
      }
    } catch (e) {
      setError(e);
    } finally { setLoading(false); }
  }, [base, headers]);

  useEffect(() => { if (authToken) fetchMarket(); }, [authToken, fetchMarket]);

  const opps = useMemo(() => (mk?.opportunities || []).slice(), [mk]);
  const pricing = useMemo(() => [...(mk?.priced_above || []), ...(mk?.priced_below || [])], [mk]);
  // Both tables were cut with a bare slice and said nothing about the rest.
  const oppPage = useTablePage(opps);
  const priPage = useTablePage(pricing);

  const covered = (row) => [row.upc, row.sku, row.product_no]
    .some((v) => v != null && coveredSkus.has(String(v).trim()));
  // E2: projected $/yr change if a product were priced at the state average.
  // A product already outselling comparable stores has "no volume gap".
  const pricedChange = (x) => {
    const peerPerStore = x.peer_stores > 0 && x.area_units != null ? x.area_units / x.peer_stores : null;
    if (peerPerStore == null || x.my_units == null) return { gap: false, text: 'n/a' };
    // Not "no volume gap" - that named the internal condition, not the finding.
    // The store is already selling this at or above comparable stores, so the
    // price is not what is holding the product back and a cut buys nothing.
    if (x.my_units >= peerPerStore) {
      return { gap: false, text: 'Already selling at or above comparable stores' };
    }
    const extraUnitsYr = (peerPerStore - x.my_units) * (365 / 90);
    const price = Number(x.area_price || x.my_price || 0);
    const lo = Math.round(extraUnitsYr * 0.85), hi = Math.round(extraUnitsYr * 1.15);
    // "+3-5 sales / yr · +$73-122 / yr" read as though it might be a percentage,
    // and neither half said what it counted. Name both units: bottles sold, and
    // the money those bottles bring in.
    return { gap: true, text: `+${lo}-${hi} units / yr · +${money(lo * price)}-${money(hi * price).replace('$', '')} revenue / yr` };
  };

  const exportCsv = (rows, cols, name) => {
    const head = cols.map((c) => c.label).join(',');
    const lines = rows.map((r) => cols.map((c) => `"${String(c.val(r) ?? '').replace(/"/g, '""')}"`).join(','));
    const blob = new Blob(['﻿' + [head, ...lines].join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  };

  // Match the legacy Market view's gate exactly: `available` is the single flag.
  const available = !!(mk && mk.available);

  // A tooltip on any cell whose text is clipped - measured, not guessed.
  useCellTitles(null, [mk, oppPage.page, priPage.page]);

  return (
    <div className="ref-page">
      <header className="ref-head">
        <h1 className="ref-title"><Store size={20} /> Market Comparison</h1>
        <p className="ref-sub">Your assortment and pricing against comparable stores · evidence: last 90 days · projections: per year</p>
      </header>

      {loading ? (
        <div className="ref-skel-tiles">{[0, 1, 2, 3].map((i) => <div key={i} className="ref-skel-tile" />)}</div>
      ) : error ? (
        <RetrievalNotice sample="market" error={error} label="Market comparison" onRetry={fetchMarket} />
      ) : !available ? (
        <div className="ref-empty">
          <Store size={26} />
          <p>{mk?.reason || 'Comparable-store data is being assembled for your area. It needs your store’s location and enough comparable stores nearby.'}</p>
        </div>
      ) : (
        <>
          {/* Tiles (§7.3.1) */}
          <div className="ref-tiles">
            <div className="ref-tile ref-tile-ac">
              <span className="ref-tile-label">Assortment gaps<MetricInfo label="Assortment gaps" sqlKey="market.opportunities" info="Products that sell well for comparable stores in your state but that you do not stock. The projected figure is what they earn for those stores, scaled to your size - a reason to try one, not a promise." /></span>
              <span className="ref-tile-value">{num(mk.opportunity_count ?? opps.length)}</span>
              <span className="ref-tile-note">projected {money(mk.total_revenue_opportunity || mk.total_projected_profit || 0)} / yr if stocked <em>(est.)</em></span>
            </div>
            <div className="ref-tile ref-tile-ac">
              <span className="ref-tile-label">Priced above state average<MetricInfo label="Priced above state average" sqlKey="market.priced_above" info="Products where your shelf price is higher than the average across comparable stores in your state. Being above is not automatically wrong; it matters where your volume has also dropped." /></span>
              <span className="ref-tile-value">{num((mk.priced_above || []).length)}</span>
              <span className="ref-tile-note">{mk.revenue_exposed_total ? `${money(mk.revenue_exposed_total)} / yr recoverable if matched (est.)` : 'review for volume loss'}</span>
            </div>
            <div className="ref-tile ref-tile-ac">
              <span className="ref-tile-label">Priced below state average<MetricInfo label="Priced below state average" sqlKey="market.priced_below" info="Products where your shelf price is lower than the state average. Where those are already selling well, the gap is margin you are leaving behind rather than a competitive edge." /></span>
              <span className="ref-tile-value">{num((mk.priced_below || []).length)}</span>
              <span className="ref-tile-note">{mk.margin_left_total ? `${money(mk.margin_left_total)} margin left (est.)` : 'margin opportunity'}</span>
            </div>
            <div className="ref-tile ref-tile-ac">
              <span className="ref-tile-label">Assortment coverage<MetricInfo label="Assortment coverage" sqlKey="market.regional_assortment" info="Of everything that sells across comparable stores in your state, the share you carry at all. Low coverage means shoppers are finding things elsewhere that you never stocked." /></span>
              <span className="ref-tile-value">{mk.assortment_coverage_pct != null ? `${mk.assortment_coverage_pct}%` : 'No data'}</span>
              <span className="ref-tile-note">of what sells in your state</span>
            </div>
          </div>

          {/* Active recommendations from this report (§6.9) */}
          {recCount > 0 && (
            <div className="ref-reco-line"><span><strong>{recCount}</strong> active recommendation{recCount === 1 ? '' : 's'} cover rows in this report, marked ● Recommended.</span>
              <button type="button" className="ref-reco-link" onClick={() => { markRecommendations(recIds, 'Market Comparison'); onNavigate && onNavigate('recommendations'); }}>{recCount} recommendations →</button>
            </div>
          )}

          {/* Assortment-gap table (§7.3.3) */}
          <section className="ref-card">
            <header className="ref-card-head">
              <div><span className="ref-card-title">Products carried by comparable stores you don’t stock<MetricInfo label="Assortment gaps" sqlKey="market.opportunities" info="Products that comparable stores in your state sell well and you do not carry at all. Comparable means similar size and mix, not simply nearby. The projection scales their sales to your store, so treat it as a reason to try one case, not a forecast." /></span> <span className="ref-est-label">Projections are estimates, not guarantees</span></div>
              <button type="button" className="ref-btn" disabled={!opps.length} onClick={() => exportCsv(opps, [
                { label: 'Product', val: (o) => o.product_name }, { label: 'Comparable stores sell (units/90d)', val: (o) => o.peer_units },
                { label: 'Projected units/yr', val: (o) => o.est_annual_units }, { label: 'Projected revenue/yr', val: (o) => o.est_annual_revenue },
              ], 'botella-assortment-gaps.csv')}><Download size={14} /> Export CSV</button>
            </header>
            <div className="ref-table-wrap">
              <table className="ref-table">
                <thead><tr><th>Product</th><th className="ref-num">Comparable stores sell (90d)</th><th className="ref-num">Projected units / yr</th><th>Confidence</th><th className="ref-num">Projected revenue / yr</th><th></th></tr></thead>
                <tbody>
                  {oppPage.pageRows.map((o, i) => (
                    <tr key={o.upc || i}>
                      <td className="ref-name" title={o.product_name}>{truncate(o.product_name, 40)}</td>
                      <td className="ref-num">{num(o.peer_units)} units</td>
                      <td className="ref-num">{range(o.est_annual_units)} · at {money2(o.avg_price)}</td>
                      <td>{confFor(o.peer_stores || 0)}</td>
                      <td className="ref-num ref-strong">{money(Math.round(o.est_annual_revenue * 0.85))}-{money(Math.round(o.est_annual_revenue * 1.15)).replace('$', '')}</td>
                      <td>{covered(o) && <span className="ref-reco-mark"><span className="ref-reco-dot" /> Recommended</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <TablePager {...oppPage} sortNote="biggest projected revenue first" emptyNote="Nothing to compare yet" />
          </section>

          {/* Pricing table (§7.3.5) */}
          <section className="ref-card">
            <header className="ref-card-head">
              <div><span className="ref-card-title">Pricing compared with the state average<MetricInfo label="Pricing compared with the state average" sqlKey="market.head_to_head" info="Products you and comparable stores both sell, with your shelf price against their average. The gap alone is not a verdict - what matters is whether your volume moved with it." /></span> <span className="ref-est-label">Projections are estimates, not guarantees</span></div>
              <button type="button" className="ref-btn" disabled={!pricing.length} onClick={() => exportCsv(pricing, [
                { label: 'Product', val: (x) => x.product_name }, { label: 'Your price', val: (x) => x.my_price }, { label: 'State average', val: (x) => x.area_price },
                { label: 'Your units 90d', val: (x) => x.my_units }, { label: 'Comparable units 90d', val: (x) => x.area_units },
              ], 'botella-pricing.csv')}><Download size={14} /> Export CSV</button>
            </header>
            <div className="ref-table-wrap">
              <table className="ref-table">
                <thead><tr><th>Product</th><th className="ref-num">Your price</th><th className="ref-num">State average</th><th className="ref-num">Gap</th><th>You vs comparable</th><th className="ref-col-wide">If priced at state average<MetricInfo label="If priced at state average" info="What this product could add in a year if you moved its price to the state average. Not a percentage - two plain counts. &quot;+3-5 units / yr&quot; is extra bottles sold, estimated from how many more comparable stores sell of it. &quot;+$73-122 revenue / yr&quot; is what those extra bottles ring up at the state-average price, before cost. Both are ranges because both are projections. Where a row reads &quot;Already selling at or above comparable stores&quot; there is no volume gap to close, so a price cut buys nothing." /></th><th></th></tr></thead>
                <tbody>
                  {priPage.pageRows.map((x, i) => {
                    const gap = x.area_price ? Math.round(((x.my_price - x.area_price) / x.area_price) * 100) : null;
                    return (
                      <tr key={i}>
                        <td className="ref-name" title={x.product_name}>{truncate(x.product_name, 40)}</td>
                        <td className="ref-num">{money2(x.my_price)}</td>
                        <td className="ref-num">{money2(x.area_price)}</td>
                        <td className={`ref-num ${gap > 0 ? 'ref-bad' : gap < 0 ? 'ref-good' : ''}`}>{gap != null ? `${gap > 0 ? '+' : ''}${gap}%` : 'n/a'}</td>
                        <td className="ref-num">{num(x.my_units)} vs {num(x.area_units)}</td>
                        {(() => { const pc = pricedChange(x); return <td className={`ref-num ${pc.gap ? 'ref-good ref-strong' : ''}`} style={pc.gap ? {} : { color: 'var(--mu)' }}>{pc.text}</td>; })()}
                        <td>{covered(x) && <span className="ref-reco-mark"><span className="ref-reco-dot" /> Recommended</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <TablePager {...priPage} sortNote="biggest price gap first" emptyNote="Nothing to compare yet" />
          </section>
        </>
      )}

      <div className="ref-disclaimer">
        <strong>Important:</strong> Recommendations, projections and estimates are generated automatically from your store’s data and third-party signals (weather, events, comparable-store benchmarks). They may be incomplete or inaccurate, are provided for informational purposes only, and do not constitute financial, legal or business advice. Verify against your own records before making purchasing, pricing, staffing or other business decisions. Botella is not responsible for decisions made in reliance on this information.
      </div>
    </div>
  );
}
