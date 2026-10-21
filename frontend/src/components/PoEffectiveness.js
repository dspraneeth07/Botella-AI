// PoEffectiveness.js
// -----------------------------------------------------------------------------
// The Purchase-Order recommendation effectiveness report - the owner-facing view
// of services/poEffectivenessService.js. Answers, for the Buying report's
// "reorder SKU X, quantity N" suggestions:
//   • Acceptance rate   - how often a suggestion actually became a PO
//   • Forecast accuracy - how close the recommended quantity was to what was ordered
//   • Revenue impact    - the dollars the acted-on suggestions earned
//   • Sell-through / turnover - did the stock we told you to buy actually move
//   • Winners vs underperformers, and the proven/avoid feedback lists
//
// Reads /api/po-effectiveness/report (+ learning). Degrades to a "measuring"
// state while windows are still open - never invents a number.
// -----------------------------------------------------------------------------

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Target, TrendingUp, CheckCircle2, Crosshair, Coins, Boxes, AlertTriangle,
  Loader, ThumbsUp, ThumbsDown, PackageCheck,
} from 'lucide-react';
import './PoEffectiveness.css';
import { retrievalError } from '../storeagent/retrieval';
import RetrievalNotice from './RetrievalNotice';

const pct = (v) => (v == null ? 'n/a' : `${Math.round(v * 100)}%`);
const money = (v) => (v == null ? 'n/a' : '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }));
const num = (v) => (v == null ? '0' : Number(v).toLocaleString('en-US'));
const truncate = (s, n) => (!s ? '' : (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s)));

const VERDICT_META = {
  winner: { label: 'Winner', cls: 'good' },
  neutral: { label: 'Neutral', cls: 'flat' },
  underperformer: { label: 'Underperformer', cls: 'bad' },
  insufficient_data: { label: 'Not yet measurable', cls: 'flat' },
};

export default function PoEffectiveness({ authToken, apiUrl }) {
  const [report, setReport] = useState(null);
  const [winDays, setWinDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [seeding, setSeeding] = useState(false);
  const [seedNote, setSeedNote] = useState(null);

  const base = useMemo(() => (apiUrl || '').replace(/\/api\/?$/, ''), [apiUrl]);

  const fetchReport = useCallback(async (win) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${base}/api/po-effectiveness/report?window=${win}&days=365`, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
          'ngrok-skip-browser-warning': 'true',
        },
      });
      if (res.status === 401) { localStorage.removeItem('botella_token'); window.location.href = '/login'; return; }
      if (!res.ok) throw await retrievalError(res, 'Unable to load the PO effectiveness report.');
      setReport(await res.json());
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [authToken, base]);

  useEffect(() => { if (authToken) fetchReport(winDays); }, [authToken, winDays, fetchReport]);

  // Seed the report from the store's own history (velocity-based reorder points,
  // back-dated so their windows are closed, scored against real purchases/sales).
  const backfill = useCallback(async () => {
    setSeeding(true);
    setSeedNote(null);
    try {
      const res = await fetch(`${base}/api/po-effectiveness/backfill`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
          'ngrok-skip-browser-warning': 'true',
        },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message || 'Backfill failed.');
      setSeedNote(`Seeded ${body.seeded || 0} recommendations from your history.`);
      await fetchReport(winDays);
    } catch (err) {
      setSeedNote(err.message || 'Backfill failed.');
    } finally {
      setSeeding(false);
    }
  }, [authToken, base, winDays, fetchReport]);

  const s = report?.summary || {};
  const windows = report?.windows_configured || [30, 60, 90];

  if (loading && !report) {
    return (
      <div className="poe-page">
        <div className="poe-loading"><Loader size={20} className="poe-spin" /><span>Measuring your purchase-order recommendations…</span></div>
      </div>
    );
  }
  if (error && !report) {
    return (
      <div className="poe-page">
        <RetrievalNotice sample="poEffectiveness" error={error} label="Purchase-order effectiveness" onRetry={() => fetchReport(winDays)} errorClassName="poe-error" fallback="Unable to load the PO effectiveness report." />
      </div>
    );
  }

  const notReady = !report?.available || (s.evaluated || 0) === 0;

  // This whole tab is ABOUT purchase orders, so a store whose POS never
  // sends them has no version of this screen - acceptance and forecast
  // accuracy both need the order. It gets the notice and the worked
  // example instead of rows of nulls and a 0% acceptance rate that reads
  // as every card ignored.
  const noOrderEvidence = Boolean(report?.purchase_feed?.silent)
    && (s.acted || 0) === 0;

  if (noOrderEvidence) {
    return (
      <div className="poe-page">
        <RetrievalNotice
          missing
          sample="poEffectiveness"
          label="Purchase-order effectiveness"
          reason={report?.purchase_feed?.reason}
        />
      </div>
    );
  }

  return (
    <div className="poe-page">
      {/* Header + window selector */}
      <div className="poe-head">
        <div>
          <span className="poe-eyebrow"><Target size={13} /> Purchase Order Effectiveness</span>
          <h1 className="poe-title">Reorder Recommendation Performance</h1>
          <p className="poe-sub">
            How your buying recommendations performed after you acted: acceptance, forecast accuracy, and sell-through.
          </p>
        </div>
        <div className="poe-windows" role="tablist" aria-label="Evaluation window">
          {windows.map((w) => (
            <button key={w} type="button" role="tab" aria-selected={winDays === w}
              className={`poe-win ${winDays === w ? 'is-on' : ''}`} onClick={() => setWinDays(w)}>
              {w}d
            </button>
          ))}
        </div>
      </div>

      {notReady ? (
        <div className="poe-empty">
          <PackageCheck size={30} />
          <h3>Not enough history yet</h3>
          <p>
            A recommendation is scored only once its {winDays}-day window has closed against your sales. Generate the
            report from your purchase history to see it now.
          </p>
          <button type="button" className="poe-seed-btn" onClick={backfill} disabled={seeding}>
            {seeding ? <Loader size={15} className="poe-spin" /> : <PackageCheck size={15} />}
            {seeding ? 'Reconstructing from your history…' : 'Generate report from my history'}
          </button>
          {seedNote && <p className="poe-seed-note">{seedNote}</p>}
        </div>
      ) : (
        <>
          {/* KPI band. Acceptance + forecast accuracy need a recorded PO feed;
              where the store has none we say so rather than print a hollow 0%. */}
          <div className="poe-kpis">
            <Kpi icon={<CheckCircle2 size={18} />} tone="teal" label="Acceptance rate"
              value={s.has_po_data ? pct(s.acceptance_rate) : 'No data'}
              meta={s.has_po_data ? `${num(s.acted)} of ${num(s.evaluated)} acted on` : 'no purchase-order feed'} />
            <Kpi icon={<Crosshair size={18} />} tone="blue" label="Forecast accuracy"
              value={s.has_po_data ? pct(s.forecast_accuracy) : 'No data'}
              meta={s.has_po_data ? 'recommended vs. ordered qty' : 'needs recorded purchase orders'} />
            <Kpi icon={<Coins size={18} />} tone="teal" label="Revenue impact"
              value={money(s.revenue_impact)} meta={s.gross_margin != null ? `${money(s.gross_margin)} gross margin` : 'from recommended SKUs'} />
            <Kpi icon={<Boxes size={18} />} tone="blue" label="Avg sell-through"
              value={pct(s.avg_sell_through)} meta={s.avg_turnover != null ? `${s.avg_turnover}× annual turns` : 'of the recommended quantity'} />
          </div>

          {/* Verdict split */}
          <div className="poe-verdicts">
            <span className="poe-vpill poe-good"><TrendingUp size={13} /> {num(s.winners)} winners</span>
            <span className="poe-vpill poe-flat">{num(s.neutral)} neutral</span>
            <span className="poe-vpill poe-bad"><AlertTriangle size={13} /> {num(s.underperformers)} underperformers</span>
            <span className="poe-vpill poe-muted">{num(s.insufficient_data)} not yet measurable</span>
          </div>

          {/* Winners / underperformers */}
          <div className="poe-grid">
            <RecList title="Top Performers" kicker="Winners" icon={<TrendingUp size={13} />} tone="good" rows={report.top} />
            <RecList title="Underperformers" kicker="Needs Review" icon={<AlertTriangle size={13} />} tone="bad" rows={report.bottom} />
          </div>

          {/* Feedback / learning */}
          {report.learning && (report.learning.proven?.length > 0 || report.learning.avoid?.length > 0) && (
            <section className="poe-card poe-learn">
              <header className="poe-card-head">
                <span className="poe-kicker"><Target size={13} /> Feedback loop</span>
                <h3>Proven vs. avoid, by SKU</h3>
              </header>
              <div className="poe-learn-cols">
                <div>
                  <div className="poe-learn-h poe-good"><ThumbsUp size={13} /> Proven: keep reordering</div>
                  {report.learning.proven.length === 0 ? <p className="poe-learn-empty">Nothing proven yet.</p> : (
                    <ul className="poe-learn-list">
                      {report.learning.proven.slice(0, 8).map((r) => (
                        <li key={`p-${r.sku}`}><span className="poe-learn-name" title={r.product_name || r.sku}>{truncate(r.product_name || r.sku, 34)}</span><span className="poe-learn-score poe-good">{pct(r.avg_score)}</span></li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <div className="poe-learn-h poe-bad"><ThumbsDown size={13} /> Avoid: buy with caution</div>
                  {report.learning.avoid.length === 0 ? <p className="poe-learn-empty">Nothing flagged yet.</p> : (
                    <ul className="poe-learn-list">
                      {report.learning.avoid.slice(0, 8).map((r) => (
                        <li key={`a-${r.sku}`}><span className="poe-learn-name" title={r.product_name || r.sku}>{truncate(r.product_name || r.sku, 34)}</span><span className="poe-learn-score poe-bad">{pct(r.avg_score)}</span></li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </section>
          )}

          <p className="poe-foot">
            {report.window_days}-day window · scored only after the window closes against your sales · metrics shown where data supports them.
          </p>
        </>
      )}
    </div>
  );
}

function Kpi({ icon, tone, label, value, meta }) {
  return (
    <div className={`poe-kpi poe-tone-${tone}`}>
      <div className="poe-kpi-top"><span className="poe-kpi-label">{label}</span><span className="poe-kpi-icon">{icon}</span></div>
      <div className="poe-kpi-value">{value}</div>
      <div className="poe-kpi-meta">{meta}</div>
    </div>
  );
}

function RecList({ title, kicker, icon, tone, rows }) {
  return (
    <section className="poe-card">
      <header className="poe-card-head">
        <span className={`poe-kicker poe-kicker-${tone}`}>{icon} {kicker}</span>
        <h3>{title}</h3>
      </header>
      {(!rows || rows.length === 0) ? (
        <div className="poe-list-empty">Nothing here for this window yet.</div>
      ) : (
        <ul className="poe-reclist">
          {rows.map((r) => {
            const v = VERDICT_META[r.verdict] || VERDICT_META.neutral;
            return (
              <li key={r.id} className="poe-recitem">
                <div className="poe-rec-main">
                  <span className="poe-rec-name" title={r.product_name || r.sku}>{truncate(r.product_name || r.sku, 32)}</span>
                  <span className={`poe-rec-verdict poe-${v.cls}`}>{v.label}</span>
                </div>
                <div className="poe-rec-stats">
                  <span title="Recommended → actual order quantity">rec {num(r.recommended_qty)} → ord {r.actual_qty == null ? 'n/a' : num(r.actual_qty)}</span>
                  <span title="Sell-through">sell-thru {pct(r.sell_through)}</span>
                  <span className="poe-rec-rev" title="Revenue impact">{money(r.revenue_impact)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
