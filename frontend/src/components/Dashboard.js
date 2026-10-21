// Dashboard.js
// -----------------------------------------------------------------------------
// The answer, and only the answer.
//
// This page used to open with a band of numbers and then scroll through every
// chart the app had, which made it a report an owner had to read rather than a
// decision they could act on. The charts now live on the Statistics page; what
// is left is three things:
//
// Two columns. The left is the work: the four numbers, then the prioritised
// task list behind them. The right is the context: what changed since
// yesterday, given the full half.
//
//   KpiGrid             four numbers, 2x2, each one a jump into the detail
//   TasksByPriority     how much is queued, and the ones to start with
//   StoreIntelligence   what changed since yesterday - owns the right half
//
// Nothing here invents data: it all comes from /api/dashboard, plus the two
// panels' own calls to /api/recommendations/latest and /api/summary.
// -----------------------------------------------------------------------------

import React, { useState, useEffect, useCallback } from 'react';
import { Wine, BarChart3, ArrowUpRight } from 'lucide-react';
import { formatLocalDate } from '../utils/date';
import { KpiGrid, TasksByPriority, StoreIntelligence, ReviewCta } from './DashPanels';
import ActiveSignalsButton from './SignalsModal';
import './Dashboard.css';
import { retrievalError } from '../storeagent/retrieval';
import RetrievalNotice from './RetrievalNotice';
import './DashPanels.css';
import { displayStoreName } from '../utils/storeIdentity';

function fmtDate(dateStr) {
  if (!dateStr) return 'N/A';
  // Parse a bare YYYY-MM-DD as LOCAL midnight so the day doesn't shift in
  // negative-offset timezones (was `new Date(str)` → UTC → off-by-one).
  return formatLocalDate(dateStr, { month: 'long', day: 'numeric', year: 'numeric' });
}

function Dashboard({ authToken, apiUrl, onNavigate, onAnalyse }) {
  const [data, setData] = useState(null);
  // The recommendations run carries the signal snapshot the market column
  // reads. TasksByPriority already fetches that run, so it hands the snapshot
  // up rather than the page fetching the same endpoint twice.
  const [snapshot, setSnapshot] = useState(null);
  const go = useCallback((view) => { if (onNavigate) onNavigate(view); }, [onNavigate]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [, setRefreshing] = useState(false); // refresh button removed; kept so fetch can no-op the flag

  const storeName = displayStoreName('Your Store');

  const fetchDashboard = useCallback(async (isRefresh) => {
    try {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);

      const base = (apiUrl || '').replace(/\/api\/?$/, '');
      const res = await fetch(`${base}/api/dashboard`, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
          'ngrok-skip-browser-warning': 'true',
        },
      });
      if (res.status === 401) {
        // Token expired - redirect to login
        localStorage.removeItem('botella_token');
        window.location.href = '/login';
        return;
      }
      if (!res.ok) throw await retrievalError(res, 'Unable to load dashboard. Please try again.');
      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [authToken, apiUrl]);

  useEffect(() => {
    if (authToken) fetchDashboard(false);
  }, [authToken, fetchDashboard]);

  // The hand-off behind every "Ask AI how to execute" button: opens a fresh
  // chat that asks for the step-by-step plan. ChatPage owns the prompt; the
  // dashboard only supplies what the plan is about.
  const handleExecute = useCallback((rec, leadName) => {
    if (onAnalyse) onAnalyse(rec.rationale, leadName, rec.category, 'execute');
    else go('suggestions');
  }, [onAnalyse, go]);

  // "Market analysis" opens the real Market Intelligence report - a tab inside
  // Store Intelligence - rather than the coming-soon placeholder page. Uses the
  // same one-shot sessionStorage handshake the startup digest already uses to
  // land on a Store Intelligence tab.
  const openMarketIntelligence = useCallback(() => {
    try {
      sessionStorage.setItem('botella_open_storeagent', '1');
      sessionStorage.setItem('botella_storeagent_tab', 'pricing_market');
    } catch {
      /* sessionStorage unavailable - the tab still opens on its default */
    }
    go('suggestions');
  }, [go]);

  // ---- Skeleton loading (shimmer in the shape of the real page) ----
  if (loading && !data) {
    return (
      <div className="dash-container">
        <div className="dash-header">
          <div className="dash-header-left">
            <div className="dash-skel dash-skel-icon" />
            <div>
              <div className="dash-skel" style={{ width: 160, height: 20, marginBottom: 6 }} />
              <div className="dash-skel" style={{ width: 200, height: 12 }} />
            </div>
          </div>
        </div>

        <div className="dash-answer-row">
          <div className="dash-answer-left">
            <div className="dp-kpi-grid">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="dp-kpi glass" style={{ animationDelay: `${i * 60}ms` }}>
                  <div className="dash-skel" style={{ width: 120, height: 26, marginBottom: 10 }} />
                  <div className="dash-skel" style={{ width: 86, height: 13, marginBottom: 9 }} />
                  <div className="dash-skel" style={{ width: 140, height: 9 }} />
                </div>
              ))}
            </div>
            <div className="dp-panel glass">
              <div className="dash-skel" style={{ width: 170, height: 18, marginBottom: 18 }} />
              {[0, 1].map((i) => (
                <div
                  key={i}
                  className="dash-skel"
                  style={{ width: '100%', height: 132, borderRadius: 14, marginBottom: 12 }}
                />
              ))}
            </div>
            <div className="dash-skel" style={{ width: '100%', height: 52, borderRadius: 999 }} />
          </div>
          <div className="dash-answer-right">
            <div className="dp-panel glass">
              <div className="dash-skel" style={{ width: 200, height: 18, marginBottom: 18 }} />
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="dash-skel"
                  style={{ width: '100%', height: 96, borderRadius: 12, marginBottom: 12 }}
                />
              ))}
              <div className="dash-skel" style={{ width: '100%', height: 300, borderRadius: 12 }} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---- Error (no data at all) ----
  if (error && !data) {
    return (
      <div className="dash-container">
        <RetrievalNotice sample="dashboard" error={error} label="Your dashboard" onRetry={() => fetchDashboard(false)} errorClassName="dash-error" fallback="Unable to load dashboard. Please try again." />
      </div>
    );
  }

  const kpis = data?.kpis || {};
  const inventory = data?.inventory || {};

  return (
    <div className="dash-container">
      {/* Error banner (when data exists but a refresh failed) */}
      {error && (
        <RetrievalNotice sample="dashboard" error={error} label="Your dashboard" onRetry={() => fetchDashboard(true)} errorClassName="dash-error" fallback="Unable to load dashboard. Please try again." />
      )}

      {/* Header */}
      <div className="dash-header">
        <div className="dash-header-left">
          <div className="dash-header-icon"><Wine size={20} /></div>
          <div>
            <h2>{storeName}</h2>
            {data?.latestSaleDate && (
              <div className="dash-header-date">Data through {fmtDate(data.latestSaleDate)}</div>
            )}
          </div>
        </div>
        <div className="dash-header-actions">
          <ActiveSignalsButton snapshot={snapshot} variant="pill" />
          <button type="button" className="app-btn dash-stats-link" onClick={() => go('statistics')}>
            <BarChart3 size={15} />
            <span>Full statistics</span>
            <ArrowUpRight size={13} />
          </button>
        </div>
      </div>

      {/* ── ANSWER ROW ─────────────────────────────────────────────────
          Left is the work: the four numbers, then the prioritised task list
          behind them. Right is the context: what changed across the store.
          Every KPI tile is a jump into Statistics. */}
      <div className="dash-answer-row">
        {/* Left is the work: the numbers, then the tasks to start with, then
            the hand-off into the full list. */}
        <div className="dash-answer-left">
          <KpiGrid
            kpis={kpis}
            inventory={inventory}
            revenueTrend={data?.revenueTrend || []}
            onOpen={go}
            apiUrl={apiUrl}
            authToken={authToken}
          />

          <TasksByPriority
            authToken={authToken}
            apiUrl={apiUrl}
            onSeeAll={() => go('suggestions')}
            onSnapshot={setSnapshot}
            onTakeAction={handleExecute}
          />

          {/* Reads as the answer to the task list above it, rather than
              as a caption on the numbers it used to sit beneath. */}
          <ReviewCta onReview={() => go('suggestions')} />
        </div>

        {/* Right is the context: what changed across the store. */}
        <div className="dash-answer-right">
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

      <div className="dash-footer">
        Powered by Botella
      </div>
    </div>
  );
}

export default Dashboard;
