// CommandCenter.js
// -----------------------------------------------------------------------------
// The merged "everything in one page" view - Dashboard + Summary on one
// world-class surface. A prototype to judge before retiring the two originals.
//
// Layout, top to bottom:
//   • Header               - store, data-through, Full statistics
//   • KPI row              - KpiGrid  +  a compact, scrollable, domain-grouped
//                            Active Signals card BESIDE it
//   • Summary body         - the blue effectiveness hero, opportunity counters,
//                            New-for-you, Missed opportunity, Category compare
//                            (all of it, via <SummarySections>)
//   • Tasks in Priority    +  Store Intelligence / Market Intelligence
//
// Reuses the real panels (KpiGrid, TasksByPriority, StoreIntelligence,
// ReviewCta), the shared Summary body (<SummarySections>) and the Live-Signals
// clustering (buildSignalDomains) - no logic duplicated, no double-fetch.
//
// Data: /api/dashboard + /api/recommendations/effectiveness + /latest.
// -----------------------------------------------------------------------------

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { BarChart3, ArrowUpRight, Wine, Loader, Radar } from 'lucide-react';
import { KpiGrid, TasksByPriority, StoreIntelligence, ReviewCta } from './DashPanels';
import ActiveSignalsButton, { buildSignalDomains } from './SignalsModal';
import { useSummaryData, SummaryHero, SummaryCounters, SummaryFindings } from './SummarySections';
import { formatLocalDate } from '../utils/date';
import './DashPanels.css';
import './InsightSummary.css';
import './CommandCenter.css';
import { retrievalError } from '../storeagent/retrieval';
import RetrievalNotice from './RetrievalNotice';
import { displayStoreName } from '../utils/storeIdentity';

const fmtDate = (d) => (d ? formatLocalDate(d, { month: 'long', day: 'numeric', year: 'numeric' }) : null);

/* Compact, scrollable Active Signals card - grouped by domain, sits beside the
   KPIs. "View all" opens the full clustered modal via <ActiveSignalsButton>. */
function SignalsCard({ snapshot }) {
  const { domains, total } = useMemo(() => buildSignalDomains(snapshot), [snapshot]);
  return (
    <section className="cc-signals">
      <header className="cc-signals-head">
        <span className="cc-signals-title">
          <span className="cc-signals-pulse" aria-hidden="true"><Radar size={14} /></span>
          Active signals
        </span>
        <span className="cc-signals-count">{total}</span>
      </header>
      {total === 0 ? (
        <div className="cc-signals-empty">No external signals active. Today’s picks are inventory-driven.</div>
      ) : (
        <div className="cc-signals-scroll">
          {domains.map((d) => (
            <div key={d.id} className="cc-sig-group">
              <div className="cc-sig-group-head" style={{ '--sig': d.color }}>
                <span className="cc-sig-group-icon"><d.icon size={13} /></span>
                <span className="cc-sig-group-label">{d.label}</span>
                <span className="cc-sig-group-count">{d.items.length}</span>
              </div>
              {d.items.map((it, i) => (
                <div key={i} className="cc-sig-item" style={{ '--sig': d.color }}>
                  <span className="cc-sig-dot" aria-hidden="true" />
                  <span className="cc-sig-text" title={it.detail || it.title}>{it.title}</span>
                  {it.when && <span className="cc-sig-when">{it.when}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="cc-signals-foot">
        <ActiveSignalsButton snapshot={snapshot} variant="pill" className="cc-signals-viewall" />
      </div>
    </section>
  );
}

export default function CommandCenter({ authToken, apiUrl, onNavigate, onAnalyse }) {
  const [data, setData] = useState(null);
  const [eff, setEff] = useState(null);
  const [recs, setRecs] = useState([]);
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const go = useCallback((view) => { if (onNavigate) onNavigate(view); }, [onNavigate]);
  const storeName = displayStoreName('Your Store');

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    const base = (apiUrl || '').replace(/\/api\/?$/, '');
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
      'ngrok-skip-browser-warning': 'true',
    };
    const get = async (path) => {
      const res = await fetch(`${base}${path}`, { headers });
      if (res.status === 401) { localStorage.removeItem('botella_token'); window.location.href = '/login'; throw new Error('unauth'); }
      if (!res.ok) throw await retrievalError(res, `${path} ${res.status}`);
      return res.json();
    };
    const [d, e, l] = await Promise.allSettled([
      get('/api/dashboard'),
      get('/api/recommendations/effectiveness?window=30'),
      get('/api/recommendations/latest'),
    ]);
    if (d.status === 'fulfilled') setData(d.value);
    else { // Rethrow the CLASSIFIED rejection rather than a fresh sentence: the
      // wrapping is what threw away "this store has no such tables" and
      // left only a message beside a Retry button that could never work.
      setError(d.reason); setLoading(false); return; }
    setEff(e.status === 'fulfilled' ? e.value : null);
    setRecs(l.status === 'fulfilled' ? (l.value?.recommendations || []) : []);
    setSnapshot(l.status === 'fulfilled' ? (l.value?.run?.signal_snapshot || null) : null);
    setLoading(false);
  }, [authToken, apiUrl]);

  useEffect(() => { if (authToken) fetchAll().catch(() => {}); }, [authToken, fetchAll]);

  const handleExecute = useCallback((rec, leadName) => {
    if (onAnalyse) onAnalyse(rec.rationale, leadName, rec.category, 'execute');
    else go('suggestions');
  }, [onAnalyse, go]);

  const openMarketIntelligence = useCallback(() => {
    try {
      sessionStorage.setItem('botella_open_storeagent', '1');
      sessionStorage.setItem('botella_storeagent_tab', 'pricing_market');
    } catch { /* sessionStorage unavailable */ }
    go('suggestions');
  }, [go]);

  const kpis = data?.kpis || {};
  const inventory = data?.inventory || {};
  // Derive the Summary figures once; the counter boxes render under the KPIs,
  // the hero + findings render as the "what Botella found" block below.
  const summary = useSummaryData({ dash: data, eff, recs });

  if (loading && !data) {
    return (
      <div className="cc-page">
        <div className="cc-loading"><Loader size={22} className="cc-spin" /><span>Bringing your store together…</span></div>
      </div>
    );
  }
  if (error && !data) {
    return (
      <div className="cc-page">
        <RetrievalNotice sample="commandCenter" error={error} label="Your store" onRetry={fetchAll} errorClassName="cc-error" fallback="Unable to load your store. Please try again." />
      </div>
    );
  }

  return (
    <div className="cc-page">
      {/* HEADER */}
      <div className="cc-head">
        <div className="cc-head-left">
          <div className="cc-head-icon"><Wine size={20} /></div>
          <div>
            <h1 className="cc-title">{storeName}</h1>
            {data?.latestSaleDate && <p className="cc-sub">Command Center · Data through {fmtDate(data.latestSaleDate)}</p>}
          </div>
        </div>
        <div className="cc-head-actions">
          <button type="button" className="app-btn cc-stats-link" onClick={() => go('statistics')}>
            <BarChart3 size={15} /><span>Full statistics</span><ArrowUpRight size={13} />
          </button>
        </div>
      </div>

      {/* TOP - the left column (KPIs → hero → 4 boxes, all the same width) with
          the expanded Active Signals card spanning beside it. The hero and the
          4 boxes are sized to the KPI column, NOT the full page width. */}
      <div className="cc-kpi-row">
        <div className="cc-kpi-main">
          <KpiGrid
            kpis={kpis}
            inventory={inventory}
            revenueTrend={data?.revenueTrend || []}
            onOpen={go}
            apiUrl={apiUrl}
            authToken={authToken}
          />
          <SummaryHero data={summary} onRecommendations={() => go('suggestions')} />
          <SummaryCounters counters={summary.counters} />
        </div>
        <SignalsCard snapshot={snapshot} />
      </div>

      {/* Tasks by Priority beside Store Intelligence. */}
      <div className="cc-cols2">
        <div className="cc-col">
          <TasksByPriority
            authToken={authToken}
            apiUrl={apiUrl}
            onSeeAll={() => go('suggestions')}
            onSnapshot={setSnapshot}
            onTakeAction={handleExecute}
          />
          <ReviewCta onReview={() => go('suggestions')} />
        </div>
        <div className="cc-col">
          <StoreIntelligence
            authToken={authToken}
            apiUrl={apiUrl}
            dashboard={data}
            snapshot={snapshot}
            onOpenMarket={openMarketIntelligence}
            onAsk={() => go('chat')}
          />
        </div>
      </div>

      {/* Below that: New SKUs beside Missed opportunity, then category. */}
      <SummaryFindings data={summary} onRecommendations={() => go('suggestions')} onChat={() => go('chat')} />

      <p className="cc-foot">All figures are live from your store data.</p>
    </div>
  );
}
