// CustomersScreen.js - Customers (§7.4)
// -----------------------------------------------------------------------------
// A dedicated, lightweight reference screen (replaces deep-linking into the
// heavy StoreAgent panel - part of the "sticking" lag). Renders the shell
// INSTANTLY and loads the (cached) customer-radar data async.
//
// Reference only: sorted, exportable, no row actions (§4.1). Reads the same
// `customer_radar` payload the StoreAgent customers capability produces, so the
// figures match everywhere. When the store has no per-person CRM link yet, it
// shows the engagement early-state instead of empty tables.
// -----------------------------------------------------------------------------

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Users, Download } from 'lucide-react';
import './ReferenceScreen.css';
import { retrievalError } from '../storeagent/retrieval';
import { sentence } from '../utils/sentence';
import RetrievalNotice from './RetrievalNotice';
import MetricInfo from './MetricInfo';
import { markRecommendations } from '../utils/crossLink';
import { MASK_CUSTOMER_IDENTITY, maskName } from '../utils/features';
import { useTablePage } from '../utils/useTablePage';
import TablePager from './TablePager';
import { useCellTitles } from '../utils/useCellTitles';

const money = (v) => '$' + Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const num = (v) => (v == null ? 'n/a' : Number(v).toLocaleString('en-US'));
const truncate = (s, n) => (!s ? '' : (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s)));

const SEGMENT_META = {
  champion: { label: 'Champions', desc: 'Your highest-value regulars', rank: 0 },
  loyal: { label: 'Loyal', desc: 'Frequent, dependable shoppers', rank: 1 },
  regular: { label: 'Regulars', desc: 'Steady, repeat visitors', rank: 2 },
  promising: { label: 'Promising', desc: 'Early, growing relationships', rank: 3 },
  new: { label: 'New', desc: 'Recently acquired', rank: 4 },
  occasional: { label: 'Occasional', desc: 'Infrequent visitors', rank: 5 },
  one_time: { label: 'One-time', desc: 'Visited once', rank: 5.5 },
  one_timer: { label: 'One-time', desc: 'Visited once', rank: 5.5 },
  at_risk: { label: 'At risk', desc: 'Slipping from their pattern', rank: 6 },
  lapsed: { label: 'Lapsed', desc: 'Overdue for a visit', rank: 7 },
  lost: { label: 'Lost', desc: 'No visit in a long time', rank: 8 },
};
const humanize = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const segMeta = (k) => SEGMENT_META[k] || { label: humanize(k), desc: '', rank: 50 };
// Identity is masked while the product is being demoed to prospects - these
// are a real store's customers with their real annual spend. See
// utils/features.js for why, and for the switch that must flip before a store
// actually uses win-back (you cannot phone "S.J.").
const custName = (c) => {
  const raw = c.name || null;
  if (MASK_CUSTOMER_IDENTITY) {
    const initials = raw ? maskName(raw) : null;
    return initials || `Customer ${String(c.customer_id || '').slice(0, 4)}`;
  }
  return raw || `Customer ${String(c.customer_id || '').slice(0, 8)}`;
};
// How many times past its usual interval a regular is (F1/F2 "22× usual gap").
// Matches Purchasing's page size, so the two reference screens page alike.
const WB_ROWS_PER_PAGE = 10;

const gapMult = (c) => (c.cadence_days > 0 && c.days_since_last != null ? Math.round(c.days_since_last / c.cadence_days) : 0);

export default function CustomersScreen({ authToken, apiUrl, onNavigate }) {
  const [r, setR] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [coveredCust, setCoveredCust] = useState(() => new Set());
  const [recCount, setRecCount] = useState(0);
  const [recIds, setRecIds] = useState([]);
  const base = useMemo(() => (apiUrl || '').replace(/\/api\/?$/, ''), [apiUrl]);
  const headers = useMemo(() => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}`, 'ngrok-skip-browser-warning': 'true' }), [authToken]);

  const fetchData = useCallback(async () => {
    setLoading(true); setError(null);
    const get = async (p) => { const r = await fetch(`${base}${p}`, { headers }); if (r.status === 401) { localStorage.removeItem('botella_token'); window.location.href = '/login'; throw new Error('unauth'); } if (!r.ok) throw await retrievalError(r, `${p} ${r.status}`); return r.json(); };
    try {
      const [c, l] = await Promise.allSettled([get('/api/storeagent/customers'), get('/api/recommendations/latest')]);
      // Rethrow the CLASSIFIED rejection: wrapping it in a fresh Error here
      // is what threw away "your store has no customer tables" and left only
      // a sentence with a Retry button that could never work.
      if (c.status !== 'fulfilled') throw c.reason;
      setR(c.value?.customer_radar || c.value?.customers?.customer_radar || null);
      // F1: mark customers a win-back recommendation covers.
      if (l.status === 'fulfilled') {
        const recs = (l.value?.recommendations || []).filter((r) => r.action_type === 'win_back');
        const s = new Set();
        recs.forEach((r) => (r.primary_skus || []).forEach((k) => s.add(String(k))));
        setCoveredCust(s); setRecCount(recs.length); setRecIds(recs.map((r) => r.id));
      }
    } catch (e) {
      setError(e);
    } finally { setLoading(false); }
  }, [base, headers]);

  useEffect(() => { if (authToken) fetchData(); }, [authToken, fetchData]);

  const winBack = useMemo(() => (r?.win_back || []).slice().sort((a, b) => (b.annual_value || 0) - (a.annual_value || 0)), [r]);
  // The table showed the first 12 of 504 with no way to reach the rest - and
  // the 13th-most-valuable lapsed regular is exactly as callable as the 12th.
  const [wbPage, setWbPage] = useState(0);
  const wbPageCount = Math.max(1, Math.ceil(winBack.length / WB_ROWS_PER_PAGE));
  const wbSafePage = Math.min(wbPage, wbPageCount - 1);
  const wbRows = winBack.slice(wbSafePage * WB_ROWS_PER_PAGE, (wbSafePage + 1) * WB_ROWS_PER_PAGE);
  const wbFirst = winBack.length === 0 ? 0 : wbSafePage * WB_ROWS_PER_PAGE + 1;
  const wbLast = Math.min(winBack.length, (wbSafePage + 1) * WB_ROWS_PER_PAGE);
  const top = useMemo(() => (r?.top_customers || []).slice().sort((a, b) => (b.spend || 0) - (a.spend || 0)), [r]);
  // Declared AFTER `top`: a const is in its temporal dead zone until its own
  // line runs, so reading it above threw on every render of this screen.
  const topPage = useTablePage(top);
  const segs = useMemo(() => Object.entries(r?.segments || {}).sort((a, b) => {
    const ra = segMeta(a[0]).rank, rb = segMeta(b[0]).rank;
    return ra !== rb ? ra - rb : b[1] - a[1];
  }), [r]);

  const exportCsv = (rows, cols, name) => {
    const head = cols.map((c) => c.label).join(',');
    const lines = rows.map((row) => cols.map((c) => `"${String(c.val(row) ?? '').replace(/"/g, '""')}"`).join(','));
    const blob = new Blob(['﻿' + [head, ...lines].join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  };

  const available = r && r.available;

  // A tooltip on any cell whose text is clipped - measured, not guessed.
  useCellTitles(null, [r, topPage.page, wbPage]);

  return (
    <div className="ref-page">
      <header className="ref-head">
        <h1 className="ref-title"><Users size={20} /> Customers</h1>
        <p className="ref-sub">Who’s slipping away and who to reach first{available && r.total_customers != null ? ` · ${num(r.total_customers)} contactable customers` : ''} · evidence: last 90 days</p>
      </header>

      {loading ? (
        <div className="ref-skel-tiles">{[0, 1, 2, 3].map((i) => <div key={i} className="ref-skel-tile" />)}</div>
      ) : error ? (
        <RetrievalNotice sample="customers" error={error} label="Customer insights" onRetry={fetchData} />
      ) : !available ? (
        <CustomersEarlyState r={r} />
      ) : (
        <>
          {r.coverage === 'partial' && (
            <div className="ref-reco-line" style={{ background: 'var(--act)' }}>
              Based on the {num(r.total_customers)} customers your POS individually tracks. Sales rung up without a customer on the ticket aren’t included, so treat these as your floor.
            </div>
          )}

          {/* Header tiles (§7.4.1) */}
          {/* F2: three tiles - base count moved to the subtitle; no duplicate. */}
          <div className="ref-tiles" style={{ gridTemplateColumns: 'repeat(3, minmax(0,1fr))' }}>
            <div className="ref-tile ref-tile-rd"><span className="ref-tile-label">Visit pattern broken<MetricInfo label="Visit pattern broken" sqlKey="customers.at_risk_count" info="Regulars who shopped on a steady rhythm and are now well past their own usual gap between visits. It is measured per customer, so a fortnightly shopper and a monthly one are each judged against their own habit." /></span><span className="ref-tile-value">{num(r.at_risk_count)}</span><span className="ref-tile-note">regulars well past their usual interval</span></div>
            <div className="ref-tile ref-tile-am"><span className="ref-tile-label">Projected annual revenue at risk (est.)<MetricInfo label="Projected annual revenue at risk (est.)" sqlKey="customers.annual_revenue_at_risk" info="What a year of spending from those customers was worth, based on what each one actually spent with you. It is the worst case - the amount on the table if none of them ever come back." /></span><span className="ref-tile-value">{money(r.annual_revenue_at_risk)}</span><span className="ref-tile-note">if none of them return</span></div>
            <div className="ref-tile ref-tile-gr"><span className="ref-tile-label">Contactable<MetricInfo label="Contactable" sqlKey="customers.win_back" info="How many of the at-risk regulars have a phone number or email saved against them, so you can actually reach out. The rest are only visible as a pattern in your sales." /></span><span className="ref-tile-value">{num(winBack.length)} of {num(r.at_risk_count)}</span><span className="ref-tile-note">phone or email on file</span></div>
          </div>

          {/* Segments */}
          {segs.length > 0 && (
            <section className="ref-card">
              <header className="ref-card-head"><span className="ref-card-title">Customer segments<MetricInfo label="Customer segments" info="Your identified customers grouped by how much they spend and how often they come in. Only customers linked to a sale at the till appear here - walk-in cash sales cannot be attributed to anyone." /></span></header>
              <div className="ref-seg-grid">
                {segs.map(([k, v]) => {
                  const m = segMeta(k);
                  return (
                    <div key={k} className="ref-seg">
                      <span className="ref-seg-count">{num(v)}</span>
                      <span className="ref-seg-label">{m.label}</span>
                      {m.desc && <span className="ref-seg-desc">{m.desc}</span>}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* F1: active win-back recommendations line (§6.9) */}
          {recCount > 0 && (
            <div className="ref-reco-line"><span><strong>{recCount}</strong> active win-back recommendation{recCount === 1 ? '' : 's'} cover customers in this report, marked ● Recommended.</span>
              <button type="button" className="ref-reco-link" onClick={() => { markRecommendations(recIds, 'Customers'); onNavigate && onNavigate('recommendations'); }}>{recCount} recommendations →</button>
            </div>
          )}

          {/* Win-back table */}
          {winBack.length > 0 && (
            <section className="ref-card">
              <header className="ref-card-head">
                <span className="ref-card-title">At-risk regulars to win back<MetricInfo label="At-risk regulars to win back" sqlKey="customers.win_back" info="Regulars who are overdue against their own visit rhythm and have a phone number or email on file. Sorted by what they were worth, so the top of the list is where a call is best spent." /></span>
                <button type="button" className="ref-btn" onClick={() => exportCsv(winBack, [
                  { label: 'Customer', val: (c) => custName(c) }, { label: 'Visits', val: (c) => c.visits },
                  { label: 'Annual value', val: (c) => c.annual_value }, { label: 'Days since last', val: (c) => c.days_since_last },
                  { label: 'Visits normally every (days)', val: (c) => Math.round(c.cadence_days || 0) }, { label: 'Preferred category', val: (c) => c.favorite_category },
                  { label: 'Next step', val: (c) => (gapMult(c) >= 3 ? 'Call now - pattern broken' : 'Win-back offer') },
                ], 'botella-win-back.csv')}><Download size={14} /> Export CSV</button>
              </header>
              <div className="ref-table-wrap">
                <table className="ref-table">
                  <thead><tr><th>Customer</th><th className="ref-num">Visits</th><th className="ref-num">Annual value</th><th className="ref-num">Last seen</th><th className="ref-num">Visit rhythm<MetricInfo label="Visit rhythm" info="How often this customer normally shops, and how far past that they are now. &quot;every 30d · 2x overdue&quot; means they usually come every 30 days and it has been about 60. Measured per customer, so a weekly shopper and a monthly one are each judged against their own habit." /></th><th>Preferred category</th><th>Next step</th><th></th></tr></thead>
                  <tbody>
                    {wbRows.map((c, i) => { const gm = gapMult(c); const callNow = gm >= 3; return (
                      <tr key={c.customer_id || i}>
                        <td className="ref-name" title={custName(c)}>{truncate(custName(c), 30)}</td>
                        <td className="ref-num">{num(c.visits)}</td>
                        <td className="ref-num ref-good ref-strong">{money(c.annual_value)}</td>
                        <td className="ref-num">{num(c.days_since_last)}d ago</td>
                        <td className="ref-num">{c.cadence_days ? `every ${Math.round(c.cadence_days)}d${gm > 1 ? ` · ${gm}× overdue` : ''}` : 'n/a'}</td>
                        <td title={c.favorite_category || ''}>{c.favorite_category ? <span className="ref-chip">{c.favorite_category}</span> : 'n/a'}</td>
                        <td><span className={`ref-next ${callNow ? 'ref-next-call' : 'ref-next-offer'}`}><span className="ref-next-dot" /> {callNow ? 'Call now · pattern broken' : 'Win-back offer'}</span></td>
                        <td>{coveredCust.has(String(c.customer_id)) && <span className="ref-reco-mark"><span className="ref-reco-dot" /> Recommended</span>}</td>
                      </tr>
                    ); })}
                  </tbody>
                </table>
              </div>
              <footer className="ref-tfoot">
                <span className="ref-tfoot-showing">
                  {winBack.length === 0
                    ? 'No contactable regulars'
                    : `Showing ${num(wbFirst)}-${num(wbLast)} of ${num(winBack.length)} · most valuable first`}
                </span>
                <span className="ref-tfoot-pager">
                  <button type="button" className="ref-pager-btn" disabled={wbSafePage === 0} onClick={() => setWbPage((p) => Math.max(0, p - 1))}>&larr; Prev</button>
                  <span className="ref-pager-pos">{wbSafePage + 1} / {wbPageCount}</span>
                  <button type="button" className="ref-pager-btn" disabled={wbSafePage >= wbPageCount - 1} onClick={() => setWbPage((p) => Math.min(wbPageCount - 1, p + 1))}>Next &rarr;</button>
                </span>
              </footer>
            </section>
          )}

          {/* Top customers */}
          {top.length > 0 && (
            <section className="ref-card">
              <header className="ref-card-head">
                <span className="ref-card-title">Top customers<MetricInfo label="Top customers" sqlKey="customers.top_customers" info="Your highest-spending identified customers over the period, with what they spend and how often they visit. Useful for knowing who to protect before they show up on the at-risk list." /></span>
                <button type="button" className="ref-btn" onClick={() => exportCsv(top, [
                  { label: 'Customer', val: (c) => custName(c) }, { label: 'Lifetime spend', val: (c) => c.spend },
                  { label: 'Visits', val: (c) => c.visits }, { label: 'Days since last', val: (c) => c.days_since_last }, { label: 'Segment', val: (c) => c.segment },
                ], 'botella-top-customers.csv')}><Download size={14} /> Export CSV</button>
              </header>
              <div className="ref-table-wrap">
                <table className="ref-table">
                  <thead><tr><th>Customer</th><th className="ref-num">Lifetime spend</th><th className="ref-num">Visits</th><th className="ref-num">Last seen</th><th>Segment</th></tr></thead>
                  <tbody>
                    {topPage.pageRows.map((c, i) => (
                      <tr key={c.customer_id || i} className={c.at_risk ? 'ref-row-warn' : ''}>
                        <td className="ref-name" title={custName(c)}>{truncate(custName(c), 30)}</td>
                        <td className="ref-num ref-strong">{money(c.spend)}</td>
                        <td className="ref-num">{num(c.visits)}</td>
                        <td className="ref-num">{num(c.days_since_last)}d ago</td>
                        <td><span className="ref-chip">{segMeta(c.segment).label}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <TablePager {...topPage} sortNote="highest annual value first" emptyNote="No customers to show" />
            </section>
          )}
        </>
      )}

      <div className="ref-disclaimer">
        <strong>Important:</strong> Recommendations, projections and estimates are generated automatically from your store’s data and third-party signals. They may be incomplete or inaccurate, are provided for informational purposes only, and do not constitute financial, legal or business advice. Figures cover customers your POS individually tracks over the last 90 days; anonymous sales aren’t included. Verify against your own records before making business decisions. Botella is not responsible for decisions made in reliance on this information.
      </div>
    </div>
  );
}

// Early state: the store hasn't linked customers to sales yet, so show the
// anonymous engagement patterns that ARE available instead of an empty screen.
function CustomersEarlyState({ r }) {
  const eng = r?.engagement;
  if (!eng) {
    // TWO DIFFERENT ABSENCES, and they need different sentences.
    //
    // With a payload, the store IS connected and simply has not linked
    // customers to tickets - something the owner can change at the counter,
    // which is what the message says.
    //
    // With NO payload the capability produced nothing for this store at all:
    // the data is not reaching us, and telling them to link customers at
    // checkout sends them to fix something that is not broken at their end.
    // That case names us instead, because the connection is ours to check.
    if (!r) {
      return (
        <div className="ref-empty">
          <Users size={26} />
          <p><strong>Customer data is not available for this store.</strong></p>
          <p>
            Your point-of-sale has not sent the customer records this screen is
            built from, so there is nothing to show yet. If you expect to see
            this, contact <strong>Botella AI Labs</strong> and we will check the
            connection for your store.
          </p>
        </div>
      );
    }
    return (
      <div className="ref-empty">
        <Users size={26} />
        <p>{sentence(r.reason) || 'Customer insights need per-person data. Link customers to sales at checkout to unlock win-back and VIP insights.'}</p>
      </div>
    );
  }
  const book = eng.contact_book || {};
  const days = eng.by_day || [];
  const maxRev = Math.max(1, ...days.map((d) => d.revenue || 0));
  const bestDay = days.reduce((a, b) => ((b.revenue || 0) > (a?.revenue || 0) ? b : a), null);
  const DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const fmtHour = (h) => `${h % 12 === 0 ? 12 : h % 12}${h >= 12 ? 'pm' : 'am'}`;
  const peakHours = (eng.top_hours || []).map((x) => fmtHour(x.hour)).join(', ');
  return (
    <>
      <div className="ref-reco-line" style={{ background: 'var(--act)' }}>
        Link customers to sales during checkout to unlock win-back and VIP insights.
        {book.contacts >= 100 && <> Your POS already has <strong>{num(book.contacts)}</strong> saved profiles ready to link.</>}
      </div>
      <div className="ref-tiles" style={{ gridTemplateColumns: 'repeat(3, minmax(0,1fr))' }}>
        <div className="ref-tile ref-tile-ac"><span className="ref-tile-label">Busiest day<MetricInfo label="Busiest day" info="The weekday that took the most money over the last 90 days, totalled across every sale. Useful for staffing and for timing a promotion." /></span><span className="ref-tile-value">{bestDay ? DAY[(bestDay.dow || 1) - 1] : 'No data'}</span><span className="ref-tile-note">by revenue, last 90 days</span></div>
        <div className="ref-tile ref-tile-ac"><span className="ref-tile-label">Average ticket<MetricInfo label="Average ticket" info="Total revenue divided by the number of sales over the last 90 days - what a typical visit is worth. Moving this by a dollar is usually worth more than any single product win." /></span><span className="ref-tile-value">{money(eng.avg_ticket)}</span><span className="ref-tile-note">last 90 days</span></div>
        <div className="ref-tile ref-tile-am"><span className="ref-tile-label">Single-item trips<MetricInfo label="Single-item trips" info="The share of sales in the last 90 days that contained exactly one product. A high share means customers come in for one thing and leave, which is what bundling and placement work on." /></span><span className="ref-tile-value">{eng.single_item_pct != null ? `${eng.single_item_pct}%` : 'No data'}</span><span className="ref-tile-note">one product per visit</span></div>
      </div>
      {days.length > 0 && (
        <section className="ref-card">
          <header className="ref-card-head"><span className="ref-card-title">When your customers shop<MetricInfo label="When your customers shop" info="Revenue by weekday over the last 90 days, with the busiest hours called out. This is every sale, not just identified customers, so it holds even before you link customers at the till." /></span>{peakHours && <span className="ref-tile-note">Peak hours: {peakHours}</span>}</header>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {days.map((d) => (
              <div key={d.dow} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span className="ref-tile-label" style={{ width: 34, flexShrink: 0 }}>{DAY[(d.dow || 1) - 1]}</span>
                <div style={{ flex: 1, height: 8, background: 'var(--elev)', borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ width: `${Math.round(((d.revenue || 0) / maxRev) * 100)}%`, height: '100%', background: 'var(--ac)' }} />
                </div>
                <span className="ref-num" style={{ width: 90, textAlign: 'right', flexShrink: 0, fontSize: 12 }}>{money(d.revenue)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
