// EffectivenessScreen.js - Effectiveness (§7.6)
// -----------------------------------------------------------------------------
// The measured impact of the recommendations the owner acted on. One page, NO
// internal tabs (B1), reading the SAME query as the home tile (B5). Below the
// launch threshold it shows the early "being measured" state; once enough
// recommendations are measured the scorecard switches on.
//
// Data: GET /api/recommendations/effectiveness?window=30 → { available, summary,
// top[], bottom[], learning{proven,avoid}, data_through_max }.
//       GET /api/recommendations/latest → the in-flight cards, each with its
//       fulfilment_state / action_claim (migration 039) - the ledger's status.
//       GET /api/recommendations/:id/evaluation → the windows the evaluator has
//       scored for each in-flight card - the ledger's measurement column.
// "Acted on" throughout means CONFIRMED BY THE STORE'S DATA, never a click.
// -----------------------------------------------------------------------------

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Trophy } from 'lucide-react';
import './ReferenceScreen.css';
import { retrievalError } from '../storeagent/retrieval';
import RetrievalNotice from './RetrievalNotice';
import { withStatus, subscribe, reconcile } from '../utils/recStatus';
import MetricInfo from './MetricInfo';

const money = (v) => '$' + Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const moneyK = (v) => { const n = Number(v || 0); return Math.abs(n) >= 1000 ? `$${(n / 1000).toFixed(1)}K` : money(n); };
const num = (v) => (v == null ? 'n/a' : Number(v).toLocaleString('en-US'));
const truncate = (s, n) => (!s ? '' : (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s)));
const TYPE = { reorder: 'Reorder', pre_stock: 'Pre-stock', cold_box: 'Cold box', stock_new: 'Stock new', bundle: 'Bundle', liquidate: 'Liquidate', markdown: 'Markdown', promote: 'Promote', endcap: 'Endcap', win_back: 'Win-back', reprice: 'Reprice' };

const THRESHOLD = 10; // launch gating (B5): scorecard appears once ≥10 measured.

// A row's display label - action + product. Effectiveness rows carry the SKU and
// a rationale gist, not a clean product name, so we lead with the action tag.
const rowLabel = (r) => `${TYPE[r.action_type] || 'Act'}${(r.primary_skus && r.primary_skus[0]) ? ` · ${r.primary_skus[0]}` : ''}`;
const sellThrough = (r) => {
  if (r.expected_units > 0 && r.units_sold != null) return Math.round((r.units_sold / r.expected_units) * 100);
  if (r.lift != null) return Math.round((r.lift + 1) * 100);
  return null;
};
// Ledger rows come from /latest, which carries real product names (unlike the
// effectiveness rows rowLabel handles), so name the recommendation properly.
const labelOf = (r) => {
  const lead = (r.products && r.products[0]) || {};
  const name = lead.product_name || (r.primary_skus && r.primary_skus[0]) || 'recommendation';
  const extra = (r.products || []).length - 1;
  return `${TYPE[r.action_type] || 'Act'} ${name}${extra > 0 ? ` + ${extra} more` : ''}`;
};
const fmtDay = (d) => (d ? d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : 'n/a');
const fmtShort = (d) => (d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'n/a');

// Dedupe by rec_id (B4): the same recommendation must never appear twice.
const dedupe = (rows) => { const seen = new Set(); return (rows || []).filter((r) => (r.rec_id != null && !seen.has(r.rec_id)) && seen.add(r.rec_id)); };

export default function EffectivenessScreen({ authToken, apiUrl, onNavigate }) {
  const [rep, setRep] = useState(null);
  const [win, setWin] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const base = useMemo(() => (apiUrl || '').replace(/\/api\/?$/, ''), [apiUrl]);

  // V30: the early state needs the recommendations already in flight - the ones
  // accepted, marked done or confirmed but not yet scored. The rows come from
  // /latest and SINCE 039 so does their status: fulfilment_state and
  // action_claim on each card, reconciled into recStatus, never localStorage
  // alone. The measurement windows come from /:id/evaluation per in-flight
  // card, so "window closes" and "measured" are the evaluator's dates, not a
  // browser clock plus thirty days.
  const [recs, setRecs] = useState([]);
  const [recsError, setRecsError] = useState(null);
  const [statusVer, setStatusVer] = useState(0);
  useEffect(() => subscribe(() => setStatusVer((n) => n + 1)), []);

  const authHeaders = useMemo(() => ({
    'Content-Type': 'application/json', Authorization: `Bearer ${authToken}`, 'ngrok-skip-browser-warning': 'true',
  }), [authToken]);

  const fetchRecs = useCallback(async () => {
    setRecsError(null);
    try {
      const res = await fetch(`${base}/api/recommendations/latest`, { headers: authHeaders });
      // A failed /latest is an ERROR with a reading, not an empty ledger.
      if (!res.ok) throw await retrievalError(res, 'Unable to load your recommendations.');
      const body = await res.json();
      const cards = body?.recommendations || [];
      reconcile(cards);
      setRecs(cards);
    } catch (e) {
      setRecs([]);
      setRecsError(e);
    }
  }, [base, authHeaders]);
  useEffect(() => { if (authToken) fetchRecs(); }, [authToken, fetchRecs]);

  // Per in-flight card, its evaluated windows (/:id/evaluation): rec id →
  // { status: 'loading'|'ready'|'error', windows }. Fetched once per card
  // that is marked done or confirmed; an accepted card has nothing to
  // measure yet and is not fetched.
  const [evals, setEvals] = useState({});
  useEffect(() => {
    if (!authToken) return undefined;
    const wanted = withStatus(recs).filter((r) => r._status === 'claimed' || r._status === 'completed');
    const missing = wanted.filter((r) => !evals[r.id]);
    if (!missing.length) return undefined;
    let alive = true;
    setEvals((e) => ({ ...e, ...Object.fromEntries(missing.map((r) => [r.id, { status: 'loading', windows: [] }])) }));
    Promise.allSettled(missing.map(async (r) => {
      const res = await fetch(`${base}/api/recommendations/${r.id}/evaluation`, { headers: authHeaders });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      return [r.id, body?.windows || []];
    })).then((results) => {
      if (!alive) return;
      setEvals((e) => {
        const next = { ...e };
        results.forEach((out, i) => {
          const id = missing[i].id;
          next[id] = out.status === 'fulfilled'
            ? { status: 'ready', windows: out.value[1] }
            : { status: 'error', windows: [] };
        });
        return next;
      });
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recs, statusVer, authToken, base, authHeaders]);

  const fetchRep = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`${base}/api/recommendations/effectiveness?window=${win}`, {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}`, 'ngrok-skip-browser-warning': 'true' },
      });
      if (res.status === 401) { localStorage.removeItem('botella_token'); window.location.href = '/login'; return; }
      if (!res.ok) throw await retrievalError(res, 'Unable to load effectiveness.');
      setRep(await res.json());
    } catch (e) { setError(e); }
    finally { setLoading(false); }
  }, [authToken, base, win]);

  useEffect(() => { if (authToken) fetchRep(); }, [authToken, fetchRep]);

  // A card is scored on the evaluator's windows after the CARD'S date (its
  // run), not thirty days after a click: the 30-day window is the one the
  // fulfilment machine decides on, so that is the one the ledger reports.
  //   fulfilment  confirmed | claimed | waiting (accepted, nothing claimed)
  //   measure     measured (30d window final) | measuring (partial, N of 30
  //               days seen) | not yet (no window evaluable) | unknown (the
  //               evaluation read failed)
  const WINDOW_DAYS = 30;
  const ledger = useMemo(() => {
    const rows = withStatus(recs).filter((r) => ['accepted', 'claimed', 'completed'].includes(r._status));
    return rows.map((r) => {
      const meta = r._statusMeta || {};
      const issued = r.created_at ? new Date(r.created_at) : null;
      const closes = issued ? new Date(issued.getTime() + WINDOW_DAYS * 86400000) : null;
      const ev = evals[r.id];
      const w30 = ev?.status === 'ready' ? ev.windows.find((w) => Number(w.window_days) === WINDOW_DAYS) : null;
      const partial = w30?.action_evidence?.partial || null;
      let measure;
      if (!ev || ev.status === 'loading') measure = r._status === 'accepted' ? 'not yet' : 'loading';
      else if (ev.status === 'error') measure = 'unknown';
      else if (w30 && !partial) measure = 'measured';
      else if (w30 && partial) measure = `measuring · ${partial.covered_days} of ${partial.of_days} days`;
      else measure = 'not yet';
      return {
        id: r.id,
        label: labelOf(r),
        fulfilment: r._status === 'completed' ? 'confirmed' : r._status === 'claimed' ? 'claimed' : 'waiting',
        summary: r.fulfilment_summary || meta.summary || null,
        accepted: meta.accepted_at ? new Date(meta.accepted_at) : null,
        claimed: meta.claimed_at ? new Date(meta.claimed_at) : (r.action_claim_at && r.action_claim === 'did' ? new Date(r.action_claim_at) : null),
        confirmed: r.fulfilment_confirmed_at ? new Date(r.fulfilment_confirmed_at) : (meta.confirmed_at ? new Date(meta.confirmed_at) : null),
        closes,
        dataThrough: w30?.data_through || null,
        measure,
      };
    }).sort((a, b) => (a.closes?.getTime() || Infinity) - (b.closes?.getTime() || Infinity));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recs, statusVer, evals]);

  const inProgress = ledger.filter((r) => r.measure !== 'measured').length;
  const firstResults = ledger.find((r) => r.fulfilment !== 'waiting' && r.measure !== 'measured')?.closes || null;

  const s = rep?.summary || {};
  const measured = s.measurable ?? s.evaluated ?? 0;
  // `s.dollars` is an OBJECT ({ won, missed_acted, ... }); this line used to
  // read it as a number and the headline printed "$NaN measured revenue". The
  // figure the hero wants is the winners' measured dollars.
  const revenue = (s.dollars && typeof s.dollars === 'object' ? s.dollars.won : s.dollars) ?? s.revenue_impact ?? 0;
  // CONFIRMED BY DATA (039). Never the owner's click.
  const acted = s.confirmed ?? s.acted_as_recommended ?? 0;
  const claimedCount = s.claimed ?? 0;

  // NO ORDER EVIDENCE AT ALL, which is not the same as a bad month.
  //
  // This store's POS never sends purchase orders, so not one card can be
  // confirmed as acted on - and the headline below was summing the
  // ungradeable remainder into "$-71,125 - 0 confirmed done by your data".
  // An owner reads that as Botella grading their buying. It is a statement
  // about a missing feed and belongs in the notice that says so.
  //
  // Both halves are required. A silent feed with some confirmations (the
  // engine can also infer a delivery from a stock rise) still has something
  // real to report, and hiding it would be the opposite mistake.
  const noOrderEvidence = Boolean(rep?.purchase_feed?.silent) && acted === 0;
  const gated = measured < THRESHOLD; // early state (B5)
  const top = useMemo(() => dedupe(rep?.top), [rep]);
  const bottom = useMemo(() => dedupe(rep?.bottom), [rep]);
  const proven = rep?.learning?.proven || [];
  const caution = rep?.learning?.avoid || [];
  const dataThrough = rep?.data_through_max ? new Date(rep.data_through_max + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;

  return (
    <div className="ref-page">
      <header className="ref-head">
        <h1 className="ref-title"><Trophy size={20} /> Effectiveness</h1>
        <p className="ref-sub">Measured impact of the recommendations you acted on{dataThrough ? ` · data through ${dataThrough}` : ''}</p>
      </header>

      {loading ? (
        <div className="ref-skel-tiles">{[0, 1, 2].map((i) => <div key={i} className="ref-skel-tile" />)}</div>
      ) : error ? (
        <RetrievalNotice sample="effectiveness" error={error} label="Effectiveness report" onRetry={fetchRep} />
      ) : !rep?.available ? (
        <div className="ref-empty"><Trophy size={26} /><p>{rep?.reason || 'Effectiveness isn’t available for this store yet.'}</p></div>
      ) : noOrderEvidence ? (
        <RetrievalNotice
          missing
          sample="effectiveness"
          label="Measured effectiveness"
          reason={rep?.purchase_feed?.reason}
        />
      ) : gated ? (
        /* Early state (B5) - being measured, first results date, quiet preview. */
        <>
          <h2 className="eff-headline">Botella is measuring your first recommendations</h2>

          {/* V30: progress card - when the first results land, how far along the
              store is, and a ten-slot meter reading measured / in progress. */}
          <section className="ref-card eff-progress">
            <div className="eff-progress-head">
              <span className="eff-progress-title">
                {firstResults ? `First results on ${fmtDay(firstResults)}` : 'First results once you mark a recommendation done'}
              </span>
              <span className="eff-progress-caption">
                {num(measured)} of {THRESHOLD} measured
                {inProgress > 0 ? ` · ${num(inProgress)} in progress` : ''}
                {` · the full scorecard opens at ${THRESHOLD}`}
              </span>
            </div>
            <div className="eff-meter" role="img" aria-label={`${measured} of ${THRESHOLD} measured, ${inProgress} in progress`}>
              {Array.from({ length: THRESHOLD }, (_, i) => (
                <span
                  key={i}
                  className={`eff-slot ${i < measured ? 'is-measured' : i < measured + inProgress ? 'is-progress' : ''}`}
                />
              ))}
            </div>
            <p className="eff-progress-note">
              Every recommendation is measured against your own sales for {WINDOW_DAYS} days after it was made: the
              quantity Botella suggested against what actually sold, and the revenue it produced. Marking one done is
              your word; it reads Completed only when your orders, invoices, stock or prices confirm it.
              Measurements appear here as each window closes.
            </p>
          </section>

          {/* V30: the ledger - what is in flight, what the data says about it,
              and when each one is scored. Status and dates are the SERVER's. */}
          <section className="ref-card">
            <header className="ref-card-head">
              <div className="ref-card-titles">
                <span className="ref-card-title">Recommendations being measured · {num(ledger.length)}<MetricInfo label="Recommendations being measured" info="Recommendations you accepted, marked done or that your data confirmed, with the date each one is scored. Scoring waits for a full 30-day sales window after the recommendation, so a recent one sits here until there is enough evidence to judge it. 'Confirmed' means your own orders, invoices, stock or prices show you followed it; 'Marked done' is your word, still being checked." /></span>
                <p className="ref-card-sub">Accepted, marked done and confirmed recommendations, and when each one is scored.</p>
              </div>
            </header>
            {recsError ? (
              <RetrievalNotice sample="recommendations" error={recsError} label="Your recommendations" onRetry={fetchRecs} errorClassName="ref-empty" fallback="Unable to load your recommendations." />
            ) : ledger.length === 0 ? (
              <div className="ref-empty">
                <p>Nothing is being measured yet. Accept a recommendation on AI Recommendations, then mark it done once you have acted on it; your data confirms it from there.</p>
              </div>
            ) : (
              <div className="ref-table-wrap">
                <table className="ref-table">
                  <thead><tr><th>Recommendation</th><th>Followed?</th><th>Accepted</th><th>Marked done</th><th>Window closes</th><th>Measurement</th></tr></thead>
                  <tbody>
                    {ledger.map((r) => (
                      <tr key={r.id}>
                        <td className="ref-strong" title={r.summary || undefined}>{r.label}</td>
                        <td>
                          <span className={`eff-status eff-status-${r.fulfilment === 'confirmed' ? 'measured' : r.fulfilment === 'claimed' ? 'measuring' : 'waiting'}`} title={r.summary || undefined}>
                            <span className="eff-status-dot" />
                            {r.fulfilment === 'confirmed' ? `Confirmed by your data${r.confirmed ? ` · ${fmtShort(r.confirmed)}` : ''}`
                              : r.fulfilment === 'claimed' ? 'Marked done · checking your data'
                                : 'Accepted · not marked done'}
                          </span>
                        </td>
                        <td>{fmtShort(r.accepted)}</td>
                        <td>{fmtShort(r.claimed)}</td>
                        <td>{fmtShort(r.closes)}</td>
                        <td>
                          <span className={`eff-status eff-status-${r.measure === 'measured' ? 'measured' : r.measure.startsWith('measuring') ? 'measuring' : 'waiting'}`}>
                            <span className="eff-status-dot" />
                            {r.measure === 'measured' ? `Measured${r.dataThrough ? ` through ${fmtShort(new Date(`${r.dataThrough}T00:00:00`))}` : ''}`
                              : r.measure === 'loading' ? 'Checking…'
                                : r.measure === 'unknown' ? 'Measurement unavailable'
                                  : r.measure === 'not yet' ? 'Not yet measurable'
                                    : r.measure.replace('measuring', 'Measuring')}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className="ref-disclaimer ref-disclaimer-inline">
            <strong>Measured from your sales data.</strong> Sell-through and revenue are measured from sales; forecast accuracy against ordered quantities requires recorded purchase orders.
          </div>
        </>
      ) : (
        <>
          {/* Headline (B3) */}
          <h2 className="eff-headline">
            {moneyK(revenue)} measured revenue · {num(acted)} recommendations confirmed done by your data{claimedCount > 0 ? ` (${num(claimedCount)} more marked done, unconfirmed)` : ''}: {num(s.winners)} outperformed, {num(s.neutral)} as expected, {num(s.underperformers)} underperformed
          </h2>

          {/* Single statement replacing the four blank tiles (B2) */}
          <div className="eff-statement">
            <strong>Measured from your sales data.</strong> Sell-through and revenue are measured from sales; forecast accuracy against ordered quantities requires recorded purchase orders.
            <button type="button" className="ref-reco-link" onClick={() => onNavigate && onNavigate('purchasing')}>How to record purchase orders →</button>
          </div>

          {/* Period switch */}
          <div className="ref-subtabs" style={{ marginTop: 4 }}>
            {[30, 60, 90].map((w) => (
              <button key={w} type="button" className={`ref-subtab ${win === w ? 'is-on' : ''}`} onClick={() => setWin(w)}>{w} days</button>
            ))}
          </div>

          {/* Top performers / Needs review (B3, B4) */}
          <div className="eff-two">
            <section className="ref-card">
              <header className="ref-card-head"><span className="ref-card-title">Top performers<MetricInfo label="Top performers" info="Recommendations whose outcome beat what was projected, measured on sales after you acted. These are the patterns worth repeating." /></span></header>
              <div className="ref-table-wrap">
                <table className="ref-table">
                  <thead><tr><th>Recommendation</th><th className="ref-num">Units sold</th><th className="ref-num">Sell-through</th><th className="ref-num">Revenue</th></tr></thead>
                  <tbody>
                    {top.length === 0 ? <tr><td colSpan={4} className="ref-name" style={{ color: 'var(--mu)' }}>No measured winners yet.</td></tr>
                      : top.map((r) => (
                        <tr key={r.rec_id}>
                          <td className="ref-name" title={r.rationale_gist}>{truncate(rowLabel(r), 34)}</td>
                          <td className="ref-num">{num(r.units_sold)}</td>
                          <td className="ref-num ref-good">{sellThrough(r) != null ? `${sellThrough(r)}%` : 'n/a'}</td>
                          <td className="ref-num ref-strong">{r.revenue_impact != null ? money(r.revenue_impact) : 'n/a'}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="ref-card">
              <header className="ref-card-head"><span className="ref-card-title">Needs review<MetricInfo label="Needs review" info="Recommendations that did not deliver what was projected. Usually one of three things: the product moved for a reason we could not see, the quantity was wrong, or it was never actually put on the shelf." /></span></header>
              <div className="ref-table-wrap">
                <table className="ref-table">
                  <thead><tr><th>Recommendation</th><th className="ref-num">Units sold</th><th className="ref-num">Sell-through</th><th className="ref-num">Revenue</th></tr></thead>
                  <tbody>
                    {bottom.length === 0 ? <tr><td colSpan={4} className="ref-name" style={{ color: 'var(--mu)' }}>Nothing underperformed.</td></tr>
                      : bottom.map((r) => (
                        <tr key={r.rec_id}>
                          <td className="ref-name" title={r.rationale_gist}>{truncate(rowLabel(r), 34)}</td>
                          <td className="ref-num">{num(r.units_sold)}</td>
                          <td className="ref-num ref-bad">{sellThrough(r) != null ? `${sellThrough(r)}%` : 'n/a'}</td>
                          <td className="ref-num">{r.revenue_impact != null ? money(r.revenue_impact) : 'n/a'}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          {/* Reliability by product (B3) */}
          {(proven.length > 0 || caution.length > 0) && (
            <section className="ref-card">
              <header className="ref-card-head"><span className="ref-card-title">Reliability by product<MetricInfo label="Reliability by product" info="How often the recommended quantity actually sold through within its window, per product. A product that keeps missing is one where our read of its demand is off, and worth telling us about." /></span>
                <span className="ref-tile-note">how often the recommended quantity sold through within its window</span>
              </header>
              <div className="eff-two">
                <div>
                  <div className="eff-rel-head eff-rel-proven">Proven: continue reordering</div>
                  {proven.slice(0, 6).map((p, i) => (
                    <div key={i} className="eff-rel-row"><span className="ref-name">{truncate(p.name || p.sku, 34)}</span><span className="ref-num ref-good">{p.score_pct != null ? `${Math.round(p.score_pct)}%` : ''}</span></div>
                  ))}
                  {proven.length === 0 && <div className="eff-rel-row" style={{ color: 'var(--mu)' }}>None yet.</div>}
                </div>
                <div>
                  <div className="eff-rel-head eff-rel-caution">Caution: review before reordering</div>
                  {caution.slice(0, 6).map((p, i) => (
                    <div key={i} className="eff-rel-row"><span className="ref-name">{truncate(p.name || p.sku, 34)}</span><span className="ref-num ref-bad">{p.score_pct != null ? `${Math.round(p.score_pct)}%` : ''}</span></div>
                  ))}
                  {caution.length === 0 && <div className="eff-rel-row" style={{ color: 'var(--mu)' }}>None yet.</div>}
                </div>
              </div>
            </section>
          )}
        </>
      )}

      <div className="ref-disclaimer">
        <strong>Important:</strong> Figures are measured from your store’s recorded sales after each recommendation’s window closes. Verify against your own records.
      </div>
    </div>
  );
}
