// InsightSummary.js
// -----------------------------------------------------------------------------
// The Summary page - a dashboard that leads with what a POS CANNOT show. The
// body (hero, counters, new-for-you, missed-opportunity, category comparison)
// lives in <SummarySections> so it can be reused inside the merged Command
// Center; this file owns the fetch, the page shell, header and footer.
//
// Data (each degrades on its own): /api/dashboard, /api/recommendations/
// effectiveness, /api/recommendations/latest.
// -----------------------------------------------------------------------------

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ArrowUpRight, Radar, Loader } from 'lucide-react';
import ActiveSignalsButton from './SignalsModal';
import SummarySections from './SummarySections';
import './InsightSummary.css';
import { retrievalError } from '../storeagent/retrieval';
import RetrievalNotice from './RetrievalNotice';

export default function InsightSummary({ authToken, apiUrl, onRecommendations, onChat }) {
  const [dash, setDash] = useState(null);
  const [eff, setEff] = useState(null);
  const [recs, setRecs] = useState([]);
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const base = useMemo(() => (apiUrl || '').replace(/\/api\/?$/, ''), [apiUrl]);
  const authHeaders = useMemo(() => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${authToken}`,
    'ngrok-skip-browser-warning': 'true',
  }), [authToken]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    const get = async (path) => {
      const res = await fetch(`${base}${path}`, { headers: authHeaders });
      if (res.status === 401) { localStorage.removeItem('botella_token'); window.location.href = '/login'; throw new Error('unauth'); }
      if (!res.ok) throw await retrievalError(res, `${path} ${res.status}`);
      return res.json();
    };
    const [d, e, l] = await Promise.allSettled([
      get('/api/dashboard'),
      get('/api/recommendations/effectiveness?window=30'),
      get('/api/recommendations/latest'),
    ]);
    if (d.status === 'fulfilled') setDash(d.value);
    else { // Rethrow the CLASSIFIED rejection rather than a fresh sentence: the
      // wrapping is what threw away "this store has no such tables" and
      // left only a message beside a Retry button that could never work.
      setError(d.reason); setLoading(false); return; }
    setEff(e.status === 'fulfilled' ? e.value : null);
    setRecs(l.status === 'fulfilled' ? (l.value?.recommendations || []) : []);
    setSnapshot(l.status === 'fulfilled' ? (l.value?.run?.signal_snapshot || null) : null);
    setLoading(false);
  }, [base, authHeaders]);

  useEffect(() => { if (authToken) fetchAll().catch(() => {}); }, [authToken, fetchAll]);

  if (loading && !dash) {
    return (
      <div className="ins-page">
        <div className="ins-hero ins-hero-skel"><Loader size={22} className="ins-spin" /><span>Reading your store…</span></div>
        <div className="ins-counters">{[0, 1, 2, 3].map((i) => <div key={i} className="ins-counter ins-skel" />)}</div>
        <div className="ins-grid">{[0, 1].map((i) => <div key={i} className="ins-card ins-skel" style={{ minHeight: 260 }} />)}</div>
      </div>
    );
  }
  if (error && !dash) {
    return (
      <div className="ins-page">
        <RetrievalNotice sample="insights" error={error} label="Your store summary" onRetry={fetchAll} errorClassName="ins-error" fallback="Unable to load your store summary. Please try again." />
      </div>
    );
  }

  const goRecs = () => onRecommendations && onRecommendations();

  return (
    <div className="ins-page">
      <div className="ins-head">
        <div>
          <span className="ins-eyebrow"><Radar size={13} /> Summary</span>
          <h1 className="ins-title">What Botella sees that your POS can’t</h1>
        </div>
        <div className="ins-head-actions">
          <ActiveSignalsButton snapshot={snapshot} variant="pill" />
          <button type="button" className="ins-ghost" onClick={goRecs}>
            All recommendations <ArrowUpRight size={14} />
          </button>
        </div>
      </div>

      <SummarySections dash={dash} eff={eff} recs={recs} onRecommendations={onRecommendations} onChat={onChat} />

      <p className="ins-foot">
        <Radar size={12} /> Live from your store data. The “measured impact” figure is holdout-honest. The effectiveness ledger only counts wins it can prove against each product’s own baseline.
      </p>
    </div>
  );
}
