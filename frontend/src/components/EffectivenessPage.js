import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Target, Loader, Clock, Users, ListChecks,
  TrendingUp, ThumbsUp,
} from 'lucide-react';
import EffectivenessCase, { signedMoney as money, InfoTip, LIFT_TIP } from './EffectivenessCase';
import EffectivenessLedger from './EffectivenessLedger';
import EffectivenessPending from './EffectivenessPending';
import EffectivenessFeedback from './EffectivenessFeedback';
import EffectivenessTrust from './EffectivenessTrust';
import ActionCheckBar from './ActionCheckBar';
import { CATEGORY_META } from './SuggestionsPage';
import { formatLocalDate } from '../utils/date';
import './EffectivenessPage.css';
import { retrievalError } from '../storeagent/retrieval';
import RetrievalNotice from './RetrievalNotice';

// ── Recommendation Effectiveness - did Botella's advice actually work? ───────
// Reads the evaluation data produced by the backend's daily measurement pass:
//   GET /api/recommendations/effectiveness?window=N&days=D
//   GET /api/recommendations/:id/evaluation      (lazy, per expanded case)
//   GET /api/recommendations/pending-actions     (slow - loads in background)
//   POST /api/recommendations/:id/vote           (thumbs - the review loop)
//   POST /api/recommendations/:id/action-claim   (owner answers on unknowns)
// Everything shown here is MEASURED (sales vs the product's own baseline,
// detected restocks/markdowns, shrunk thumbs votes) - nothing is projected.
//
// The page is a 30-second read, top to bottom:
//   1. Hero - dollars EARNED BY THE CALLS THAT WORKED (misses get their own
//      honest line: acted-on misses are worth a review; un-acted misses cost
//      the store nothing).
//   2. Up to three one-sentence insights.
//   3. One list of calls - All · Wins · Misses · Waiting on you - where every
//      row opens into its full case file, with a thumbs review on the verdict.
// A half-screen feedback drawer slides in from the right once per session with
// the recent, still-unrated recommendations.

const SINCE_DAYS = 90; // how far back recommendations count (?days=)
const FB_SESSION_KEY = 'botella_fb_drawer_done';

const pct = (x) => (x == null ? '-' : `${Math.round(x * 100)}%`);
// money = signedMoney from EffectivenessCase: cent-precise, explicit +/- sign
// (Dashboard.js fmtMoney convention - measured impacts can run negative).
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const catLabel = (key) => CATEGORY_META[key]?.label || String(key).replace(/_/g, ' ');

const sessionFlag = {
  get: () => { try { return sessionStorage.getItem(FB_SESSION_KEY) === '1'; } catch { return true; } },
  set: () => { try { sessionStorage.setItem(FB_SESSION_KEY, '1'); } catch { /* private mode */ } },
};

// ── Hero - what the advice EARNED, never a blame-y net ──────────────────────
// The headline is the winners' measured dollars (summary.dollars.won). Misses
// get their own line that separates the acted-on ones (a real cost - worth the
// owner's review, because a miss can be the weather's fault, not the advice's)
// from the never-acted ones (the product fell short of its own baseline on its
// own; following Botella cost nothing there). On older backends without the
// split, a NEGATIVE net total is never shown as the headline - the win
// fraction carries the hero instead.
function Hero({ s, windowDays, dataThrough, onReviewMisses }) {
  const d = s.dollars;
  const measurable = s.measurable || 0;
  const winners = s.winners || 0;
  const wonDollars = d?.won != null ? Number(d.won) : null;
  const legacyDollars = d == null && s.revenue_impact != null && Number(s.revenue_impact) >= 0
    ? Number(s.revenue_impact)
    : null;
  const heroDollars = wonDollars != null ? wonDollars : legacyDollars;

  // CONFIRMED BY DATA (039). `acted_as_recommended` counts only cards a
  // purchases-feed row, an invoice, a stock inflow, a price drop or a
  // catalogue arrival confirmed; the owner's unconfirmed "marked done" is
  // `claimed` and gets its own sentence, never folded into "you acted on".
  const confirmed = s.confirmed ?? s.acted_as_recommended ?? 0;
  const claimed = s.claimed ?? 0;
  let acted;
  if (s.action_observable === 0 && confirmed === 0) {
    acted = 'We couldn’t yet see you act on any of these calls, and we never guess.';
  } else if (confirmed === 0) {
    acted = `None of the ${plural(s.action_observable, 'call')} we could check showed action on your side yet.`;
  } else {
    acted = `Your data confirms you acted on ${confirmed} of the ${plural(Math.max(s.action_observable || 0, confirmed), 'call')} we could check; ${s.acted_and_won} of those paid off.`;
  }
  if (claimed > 0) {
    acted += ` You marked ${claimed} more as done; your orders, stock and prices have not confirmed ${claimed === 1 ? 'it' : 'them'} yet.`;
  }

  const missedActedCost = d?.missed_acted != null && Number(d.missed_acted) < 0 ? Number(d.missed_acted) : null;
  const showMisses = (s.underperformers || 0) > 0;

  return (
    <div className="ep-hero">
      {heroDollars != null ? (
        <>
          <div className="ep-hero-num">{money(heroDollars)}</div>
          <div className="ep-hero-cap">
            {wonDollars != null
              ? 'earned by the calls that worked, measured at your register'
              : 'measured at your register across every measured call'}
            <InfoTip text={'Each call is compared to the same product’s own sales in the 28 days before it. These dollars are the measured difference at your register, never a projection.'} />
          </div>
        </>
      ) : (
        <>
          <div className="ep-hero-num">{winners} of {measurable}</div>
          <div className="ep-hero-cap">measured calls worked over the {windowDays}-day window</div>
        </>
      )}
      {measurable > 0 && (
        <div className="ep-hero-meterrow">
          <div className="ep-hero-meter" aria-hidden="true">
            <span className="ep-hero-meterfill" style={{ width: `${Math.round((winners / measurable) * 100)}%` }} />
          </div>
          <span className="ep-hero-meterlabel">
            {winners} of {plural(measurable, 'measured call')} worked
            {s.avg_lift != null && <> · avg lift {s.avg_lift}x<InfoTip text={LIFT_TIP} /></>}
          </span>
        </div>
      )}
      <p className="ep-hero-acted">{acted}</p>

      {showMisses && (
        <p className="ep-hero-misses">
          {plural(s.underperformers, 'call')} missed.
          {missedActedCost != null && (
            <> {money(missedActedCost)} measured on the {d.missed_acted_count === 1 ? 'one' : plural(d.missed_acted_count, 'one')} you acted on. Open {d.missed_acted_count === 1 ? 'it' : 'them'} and tell us what happened; a miss isn’t always the advice’s fault.</>
          )}
          {d != null && d.missed_unacted_count > 0 && (
            <> {d.missed_unacted_count === s.underperformers
              ? 'You never acted on any of them, so they cost you nothing'
              : `The other ${d.missed_unacted_count} you never acted on cost you nothing`}: the products just fell short of their own pace.</>
          )}
          <button type="button" className="ep-hero-review" onClick={onReviewMisses}>
            Review the misses
          </button>
        </p>
      )}

      {dataThrough && (
        <p className="ep-hero-fresh">
          Measured through {formatLocalDate(dataThrough, { month: 'long', day: 'numeric' })} · baseline: each product’s own previous 28 days.
        </p>
      )}
    </div>
  );
}

// ── Insights - at most three one-sentence cards, strongest first ────────────
function buildInsights(report, pending, onWaiting) {
  const out = [];
  const rows = pending.status === 'ready' ? pending.rows : [];
  if (rows.length > 0) {
    const nearest = rows.reduce(
      (m, r) => (r.days_left != null && (m == null || r.days_left < m) ? r.days_left : m),
      null,
    );
    const tail = nearest != null
      ? `; the nearest ends ${nearest <= 0 ? 'today' : `in ${plural(nearest, 'day')}`}`
      : '';
    out.push({
      key: 'waiting',
      icon: Clock,
      onClick: onWaiting,
      text: `${plural(rows.length, 'call')} ${rows.length === 1 ? 'is' : 'are'} waiting on you${tail}.`,
    });
  }

  // Follow-through by CONFIRMED action (039): `confirmed` is the data's word,
  // `not_followed` a measured absence. The legacy acted / not_acted names are
  // the same buckets on this backend and the fallback on an older one.
  const ft = report.followthrough;
  const done = ft?.confirmed ?? ft?.acted;
  const skipped = ft?.not_followed ?? ft?.not_acted;
  if (done?.n >= 3) {
    let t = `Calls your data confirms you acted on worked ${pct(done.winners / done.n)} of the time`;
    if (skipped?.n >= 3) t += `; the ones not followed, ${pct(skipped.winners / skipped.n)}`;
    out.push({ key: 'ft', icon: ListChecks, text: `${t}.` });
  }

  const groups = (report.by_category || []).filter((g) => g.recs >= 3);
  if (groups.length > 0) {
    const best = groups.reduce((a, b) => ((b.winners || 0) / b.recs > (a.winners || 0) / a.recs ? b : a));
    if ((best.winners || 0) / best.recs >= 0.5) {
      out.push({
        key: 'best',
        icon: TrendingUp,
        text: `${catLabel(best.key)} calls are your strongest: ${best.winners} of ${best.recs} worked.`,
      });
    }
  }

  if (report.holdout) {
    out.push({
      key: 'holdout',
      icon: Target,
      text: `Shown calls lifted ${report.holdout.shown_avg_lift}x vs ${report.holdout.holdout_avg_lift}x when we held them back. The advice itself is doing work.`,
    });
  }

  const net = report.network;
  if (net?.this_store_win_rate != null && net?.avg_win_rate != null) {
    out.push({
      key: 'network',
      icon: Users,
      text: net.this_store_win_rate >= net.avg_win_rate
        ? `You’re ahead of the network: ${pct(net.this_store_win_rate)} of your calls work vs ${pct(net.avg_win_rate)} across stores.`
        : `Room to grow: ${pct(net.this_store_win_rate)} of your calls work vs ${pct(net.avg_win_rate)} across stores.`,
    });
  }

  return out.slice(0, 3);
}

function InsightRow({ insights }) {
  if (!insights.length) return null;
  return (
    <div className="ep-insights">
      {insights.map(({ key, icon: Icon, text, onClick }) => (onClick ? (
        <button key={key} type="button" className="ep-insight ep-insight-btn" onClick={onClick}>
          <Icon size={15} /><span>{text}</span>
        </button>
      ) : (
        <div key={key} className="ep-insight">
          <Icon size={15} /><span>{text}</span>
        </div>
      )))}
    </div>
  );
}

// ── The calls - one list, four ways to slice it ─────────────────────────────
const SEGMENTS = [
  { id: 'all', label: 'All' },
  { id: 'wins', label: 'Wins' },
  { id: 'misses', label: 'Misses' },
  { id: 'waiting', label: 'Waiting on you' },
];

export default function EffectivenessPage({ authToken, apiUrl }) {
  const [report, setReport] = useState(null);
  // pending: { status: 'loading'|'ready'|'error'|'unavailable', rows, run_generated_at }
  const [pending, setPending] = useState({ status: 'loading', rows: [], run_generated_at: null });
  const [windowDays, setWindowDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Which slice of the list is showing. 'waiting' renders the pending rows;
  // the rest map to ledger verdict filters.
  const [segment, setSegment] = useState('all');
  // Case-file expansion state + per-rec evaluation cache, lifted here so both
  // survive window/segment switches (the cache holds ALL windows per rec).
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const [evalCache, setEvalCache] = useState({}); // rec_id → {status, windows?, message?}
  const [ledgerSupported, setLedgerSupported] = useState(true);
  // The ONE vote store: rec_id → 'up'|'down'|null, layered over whatever
  // user_vote the rows arrived with. Case rows and the feedback drawer both
  // read and write it, so a thumb cast anywhere shows everywhere.
  const [votes, setVotes] = useState({});
  // Recent recs for the feedback drawer, PREFETCHED in the background on mount
  // (the /latest warehouse enrichment can take seconds) so opening the drawer
  // is instant. latest: { status: 'loading'|'ready'|'error', rows }.
  const [latest, setLatest] = useState({ status: 'loading', rows: [] });
  // Feedback drawer: auto-opens once per session, but only once the prefetch
  // has landed AND there is something unrated to ask about; reopenable from
  // the header button anytime.
  const [showFeedback, setShowFeedback] = useState(false);
  const autoOpenRef = useRef(!sessionFlag.get());
  const callsRef = useRef(null);

  const base = apiUrl.replace(/\/api\/?$/, '');
  const authed = useCallback((path, opts = {}) => fetch(`${base}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
      'ngrok-skip-browser-warning': 'true',
      ...(opts.headers || {}),
    },
  }), [base, authToken]);

  // The report is analytics-only and fast (~ms) - it re-fetches per window.
  // pending-actions walks the warehouse (seconds), so it loads ONCE, in the
  // background, without blocking the first paint.
  // Monotonic fetch sequence (same seqRef pattern as the ledger): rapid window
  // switches race their responses, and without the guard a stale slow response
  // - or its late rejection - would clobber the newer one.
  const reportSeqRef = useRef(0);
  const fetchReport = useCallback(async (w) => {
    if (!authToken) return;
    const seq = ++reportSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const repRes = await authed(`/api/recommendations/effectiveness?window=${w}&days=${SINCE_DAYS}`);
      if (seq !== reportSeqRef.current) return;
      if (!repRes.ok) throw await retrievalError(repRes, 'Unable to load effectiveness data.');
      const body = await repRes.json();
      if (seq !== reportSeqRef.current) return;
      setReport(body);
    } catch (err) {
      if (seq === reportSeqRef.current) setError(err);
    } finally {
      if (seq === reportSeqRef.current) setLoading(false);
    }
  }, [authToken, authed]);

  useEffect(() => { fetchReport(windowDays); }, [fetchReport, windowDays]);

  // pending-actions, as its own callable so a failed load can be retried from
  // the notice. The error is CLASSIFIED (retrievalError) so the notice can
  // tell an outage from a store whose data is not there.
  const pendingSeqRef = useRef(0);
  const fetchPending = useCallback(async () => {
    if (!authToken) return;
    const seq = ++pendingSeqRef.current;
    setPending((p) => ({ ...p, status: 'loading', error: null }));
    try {
      const r = await authed('/api/recommendations/pending-actions');
      if (seq !== pendingSeqRef.current) return;
      if (!r.ok) throw await retrievalError(r, 'Unable to check your pending actions.');
      const data = await r.json();
      if (seq !== pendingSeqRef.current) return;
      if (!data || data.available === false) {
        setPending({ status: 'unavailable', rows: [], run_generated_at: null });
      } else {
        setPending({ status: 'ready', rows: data.pending || [], run_generated_at: data.run_generated_at || null });
      }
    } catch (err) {
      if (seq === pendingSeqRef.current) setPending({ status: 'error', rows: [], run_generated_at: null, error: err });
    }
  }, [authToken, authed]);
  useEffect(() => { fetchPending(); }, [fetchPending]);

  useEffect(() => {
    if (!authToken) return;
    let alive = true;
    authed('/api/recommendations/latest')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('latest failed'))))
      .then((data) => { if (alive) setLatest({ status: 'ready', rows: data?.recommendations || [] }); })
      .catch(() => { if (alive) setLatest({ status: 'error', rows: [] }); });
    return () => { alive = false; };
  }, [authToken, authed]);

  // Once-per-session auto-open: wait for the prefetch, open only when there
  // are unrated calls to show (never an empty or still-loading drawer).
  useEffect(() => {
    if (!autoOpenRef.current || latest.status === 'loading') return;
    autoOpenRef.current = false;
    if (latest.status === 'ready' && latest.rows.some((r) => r.user_vote == null)) {
      setShowFeedback(true);
    } else {
      sessionFlag.set();
    }
  }, [latest]);

  // Lazy per-case detail: every evaluated window for one rec. Fetched on first
  // expand only, then cached for the session.
  const loadEvaluation = useCallback(async (recId) => {
    setEvalCache((c) => ({ ...c, [recId]: { status: 'loading' } }));
    try {
      const res = await authed(`/api/recommendations/${recId}/evaluation`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message || 'Unable to load the measurement detail.');
      }
      const data = await res.json();
      setEvalCache((c) => ({ ...c, [recId]: { status: 'ready', windows: data.windows || [] } }));
    } catch (err) {
      setEvalCache((c) => ({ ...c, [recId]: { status: 'error', message: err.message } }));
    }
  }, [authed]);

  const toggleCase = useCallback((recId) => {
    const opening = !expandedIds.has(recId);
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(recId)) next.delete(recId); else next.add(recId);
      return next;
    });
    if (opening && !evalCache[recId]) loadEvaluation(recId);
  }, [expandedIds, evalCache, loadEvaluation]);

  // Owner claim on a can't-see pending row: optimistic flip, rollback on
  // error, and the server's answer folded back (039): a 'did' comes back
  // 'claimed' - or 'confirmed', when the data already held the evidence, in
  // which case the card is no longer pending at all and leaves the list.
  const handleClaim = useCallback(async (recId, claim) => {
    const mark = (fields) => setPending((p) => ({
      ...p,
      rows: (p.rows || []).map((r) => (r.rec_id === recId ? { ...r, ...fields } : r)),
    }));
    mark({ claim_state: claim, claim_error: false });
    try {
      const res = await authed(`/api/recommendations/${recId}/action-claim`, {
        method: 'POST',
        body: JSON.stringify({ claim }),
      });
      if (!res.ok) throw new Error('claim failed');
      const body = await res.json().catch(() => null);
      if (body && body.fulfilment_state === 'confirmed') {
        setPending((p) => ({ ...p, rows: (p.rows || []).filter((r) => r.rec_id !== recId) }));
      } else if (body) {
        mark({
          action_claim: body.action_claim ?? claim,
          fulfilment_state: body.fulfilment_state ?? null,
          fulfilment_summary: body.fulfilment_summary ?? null,
        });
      }
    } catch {
      mark({ claim_state: null, claim_error: true });
    }
  }, [authed]);

  // Thumbs on one rec ('up' | 'down' | 'none' retracts): optimistic flip,
  // rollback on error, folded back from the server's fresh vote shape. Any
  // real vote satisfies the once-per-session feedback ask.
  const handleVote = useCallback(async (recId, next) => {
    let prevEntry;
    let hadEntry = false;
    setVotes((v) => {
      hadEntry = recId in v;
      prevEntry = v[recId];
      return { ...v, [recId]: next === 'none' ? null : next };
    });
    try {
      const res = await authed(`/api/recommendations/${recId}/vote`, {
        method: 'POST',
        body: JSON.stringify({ vote: next }),
      });
      if (!res.ok) throw new Error('vote failed');
      const fresh = await res.json().catch(() => null);
      if (fresh && 'user_vote' in fresh) {
        setVotes((v) => ({ ...v, [recId]: fresh.user_vote }));
      }
      if (next !== 'none') sessionFlag.set();
    } catch {
      setVotes((v) => {
        const copy = { ...v };
        if (hadEntry) copy[recId] = prevEntry; else delete copy[recId];
        return copy;
      });
    }
  }, [authed]);

  const onLedgerUnsupported = useCallback(() => setLedgerSupported(false), []);
  const dismissFeedback = useCallback(() => {
    sessionFlag.set();
    setShowFeedback(false);
  }, []);

  const jumpToSegment = useCallback((id) => {
    setSegment(id);
    requestAnimationFrame(() => {
      callsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, []);
  const jumpToWaiting = useCallback(() => jumpToSegment('waiting'), [jumpToSegment]);
  const jumpToMisses = useCallback(() => jumpToSegment('misses'), [jumpToSegment]);

  if (loading && !report) {
    return <div className="ep-center"><Loader className="ep-spin" size={22} /><p>Measuring…</p></div>;
  }
  if (error) {
    return (
      <RetrievalNotice sample="effectiveness" error={error} label="Effectiveness" onRetry={() => fetchReport(windowDays)} errorClassName="ep-center" fallback="Unable to load effectiveness data." />
    );
  }
  if (!report || report.available === false) {
    return (
      <div className="ep-center">
        <Target size={22} />
        <p>Effectiveness tracking isn’t provisioned yet{report?.reason ? `: ${report.reason}` : '.'}</p>
      </div>
    );
  }

  const s = report.summary;
  const windows = report.windows_configured || [7, 30, 60, 90];
  const nothingYet = s.evaluated === 0;
  const pendingCount = pending.status === 'ready' ? pending.rows.length : null;
  const waitingHidden = pending.status === 'unavailable';
  // With no verdicts yet the only meaningful slice is Waiting; with the
  // pending feed unavailable, Waiting can't render - fall back to All.
  const activeSegment = nothingYet
    ? 'waiting'
    : (waitingHidden && segment === 'waiting' ? 'all' : segment);
  const insights = nothingYet ? [] : buildInsights(report, pending, jumpToWaiting);

  const segmentCount = (id) => {
    if (id === 'wins') return s.winners;
    if (id === 'misses') return s.underperformers;
    if (id === 'waiting') return pendingCount;
    return s.evaluated;
  };

  const caseRow = (r) => (
    <EffectivenessCase
      key={r.rec_id}
      rec={r}
      expanded={expandedIds.has(r.rec_id)}
      onToggle={() => toggleCase(r.rec_id)}
      evalState={evalCache[r.rec_id]}
      onRetry={() => loadEvaluation(r.rec_id)}
      reportWindow={report.window_days}
      authed={authed}
      userVote={r.rec_id in votes ? votes[r.rec_id] : r.user_vote}
      onVote={(next) => handleVote(r.rec_id, next)}
    />
  );

  // Older-backend fallback (no /ledger endpoint): the report's built-in top /
  // bottom lists sliced by segment.
  const fallbackRows = activeSegment === 'wins'
    ? (report.top || [])
    : activeSegment === 'misses'
      ? (report.bottom || [])
      : [...(report.top || []), ...(report.bottom || [])];

  return (
    <div className="ep-root">
      {/* At most one "did you do this?" micro-question per visit - feeds the
          Effectiveness stats where physical actions can't be detected. */}
      <ActionCheckBar authToken={authToken} apiUrl={apiUrl} />

      <div className="ep-head">
        <div className="ep-title">
          <Target size={18} />
          <div>
            <h3>Did the advice work?</h3>
            <p>Every recommendation, measured against what actually sold.</p>
          </div>
        </div>
        <div className="ep-head-controls">
          <button
            type="button"
            className="ep-rate-btn"
            title="Rate the recent recommendations"
            onClick={() => setShowFeedback(true)}
          >
            <ThumbsUp size={13} /> Rate recent calls
          </button>
          <div className="ep-windows" role="tablist" aria-label="Evaluation window">
            <span className="ep-history-label">measured over</span>
            {windows.map((w) => (
              <button
                key={w}
                type="button"
                role="tab"
                aria-selected={w === report.window_days}
                className={`ep-window ${w === report.window_days ? 'ep-window-active' : ''}`}
                onClick={() => setWindowDays(w)}
              >{w}d</button>
            ))}
          </div>
        </div>
      </div>

      {nothingYet ? (
        <div className="ep-empty">
          <Clock size={18} />
          <p>
            No {report.window_days}-day verdicts yet. A recommendation is only scored once a full
            {' '}{report.window_days} days of sales data exist after it was made; verdicts appear
            automatically as your sales sync catches up. Nothing here is ever guessed from partial data.
          </p>
        </div>
      ) : (
        <>
          <Hero
            s={s}
            windowDays={report.window_days}
            dataThrough={report.data_through_max}
            onReviewMisses={jumpToMisses}
          />
          <InsightRow insights={insights} />
          {/* Where the calls land, by category / signal / action - with
              "confirmed done by your data" and "marked done, unconfirmed"
              counted apart (039). This component existed and was imported
              nowhere; the report always carried its rows. No drill: the list
              below has no category/signal filter control yet, and a row that
              pretended to filter it would be worse than a read-only one. */}
          <EffectivenessTrust
            byCategory={report.by_category}
            bySignal={report.by_signal}
            byAction={report.by_action_type}
            onDrill={null}
          />
        </>
      )}

      {(!nothingYet || (pendingCount != null && pendingCount > 0)) && (
        <div ref={callsRef} className="ep-calls">
          <div className="ep-tabs" role="tablist" aria-label="Which calls to show">
            {SEGMENTS.filter((t) => !(t.id === 'waiting' && waitingHidden))
              .filter((t) => !nothingYet || t.id === 'waiting')
              .map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={activeSegment === t.id}
                  className={`ep-tab ${activeSegment === t.id ? 'ep-tab-active' : ''}`}
                  onClick={() => setSegment(t.id)}
                >
                  {t.label}
                  {segmentCount(t.id) != null && <span className="ep-tab-count">{segmentCount(t.id)}</span>}
                </button>
              ))}
          </div>

          {activeSegment === 'waiting' ? (
            <EffectivenessPending state={pending} onClaim={handleClaim} onRetry={fetchPending} embedded />
          ) : ledgerSupported ? (
            <EffectivenessLedger
              authed={authed}
              windowDays={report.window_days}
              sinceDays={report.since_days || SINCE_DAYS}
              segment={activeSegment}
              summary={s}
              expandedIds={expandedIds}
              evalCache={evalCache}
              onToggleCase={toggleCase}
              onRetryCase={loadEvaluation}
              onUnsupported={onLedgerUnsupported}
              votes={votes}
              onVote={handleVote}
            />
          ) : (
            <div className="ep-fallback-rows">
              {fallbackRows.length === 0
                ? <p className="ep-quiet">Nothing here for this slice yet.</p>
                : fallbackRows.map(caseRow)}
            </div>
          )}
        </div>
      )}

      {showFeedback && (
        <EffectivenessFeedback
          latest={latest}
          votes={votes}
          onVote={handleVote}
          onClose={dismissFeedback}
        />
      )}
    </div>
  );
}
