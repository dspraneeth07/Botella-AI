import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Loader, ChevronDown } from 'lucide-react';
import EffectivenessCase, { signedMoney } from './EffectivenessCase';
import { retrievalError } from '../storeagent/retrieval';
import RetrievalNotice from './RetrievalNotice';
import './EffectivenessLedger.css';

// ── The list engine - every measured call, openable ─────────────────────────
//   GET /api/recommendations/effectiveness/ledger?window=&days=&verdict=&
//       sort=&limit=&offset=
// The backend runs the exact query + holdout exclusion the report uses, so the
// two can never disagree. The parent owns the segment tabs (Wins / Misses /
// All) - this component maps them to verdict filters. Sort is fixed to
// $ impact: the biggest measured stories first. Row expansion reuses the
// EffectivenessCase component + the parent's evaluation cache; votes are the
// parent's shared store (same one the feedback drawer writes).
// If the endpoint 404s (older backend), onUnsupported() flips the page back to
// the report's built-in top/bottom lists - graceful degradation, never a hole.

const PAGE_SIZE = 30;

const SEGMENT_VERDICT = { wins: 'winner', misses: 'underperformer' };

function ledgerQuery(windowDays, sinceDays, segment, offset) {
  const p = new URLSearchParams({
    window: String(windowDays),
    days: String(sinceDays),
    sort: 'impact',
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  const verdict = SEGMENT_VERDICT[segment];
  if (verdict) p.set('verdict', verdict);
  return p.toString();
}

const EMPTY_COPY = {
  wins: 'No wins measured in this range yet.',
  misses: 'No misses in this range. Nothing to hide.',
  all: 'No measured calls in this range yet.',
};

export default function EffectivenessLedger({
  authed, windowDays, sinceDays, segment, summary,
  expandedIds, evalCache, onToggleCase, onRetryCase, onUnsupported,
  votes, onVote,
}) {
  const [data, setData] = useState({ status: 'loading', rows: [], total: 0 });
  const [more, setMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  // Monotonic fetch sequence: any segment/window change invalidates in-flight
  // pages so a slow response can never clobber a newer one.
  const seqRef = useRef(0);

  useEffect(() => {
    let alive = true;
    const seq = ++seqRef.current;
    setData({ status: 'loading', rows: [], total: 0 });
    setMoreError(false);
    (async () => {
      try {
        const res = await authed(
          `/api/recommendations/effectiveness/ledger?${ledgerQuery(windowDays, sinceDays, segment, 0)}`
        );
        if (!alive || seq !== seqRef.current) return;
        if (res.status === 404) { onUnsupported(); return; } // older backend - parent falls back
        // CLASSIFIED, not a fresh sentence: retrievalError reads the envelope
        // and says whether this is an outage (Retry) or a store whose data is
        // not there (no Retry, contact us). The old plain Error threw that
        // distinction away and left a Retry button that could never work.
        if (!res.ok) throw await retrievalError(res, 'Unable to load the calls.');
        const body = await res.json();
        if (!alive || seq !== seqRef.current) return;
        if (body.available === false) {
          setData({ status: 'ready', rows: [], total: 0, reason: body.reason || null });
        } else {
          setData({ status: 'ready', rows: body.rows || [], total: body.total || 0 });
        }
      } catch (err) {
        if (alive && seq === seqRef.current) {
          setData({ status: 'error', rows: [], total: 0, error: err, message: err.message });
        }
      }
    })();
    return () => { alive = false; };
  }, [authed, windowDays, sinceDays, segment, onUnsupported, refreshKey]);

  // "Show more": next offset appended onto the same result set (deduped by
  // rec_id in case rows shifted server-side between pages).
  const loadMore = useCallback(async () => {
    const seq = seqRef.current;
    setMore(true);
    setMoreError(false);
    try {
      const res = await authed(
        `/api/recommendations/effectiveness/ledger?${ledgerQuery(windowDays, sinceDays, segment, data.rows.length)}`
      );
      if (seq !== seqRef.current) return;
      if (!res.ok) throw new Error('page failed');
      const body = await res.json();
      if (seq !== seqRef.current) return;
      setData((d) => {
        const seen = new Set(d.rows.map((r) => r.rec_id));
        return {
          ...d,
          total: body.total ?? d.total,
          rows: [...d.rows, ...(body.rows || []).filter((r) => !seen.has(r.rec_id))],
        };
      });
    } catch {
      if (seq === seqRef.current) setMoreError(true);
    } finally {
      setMore(false);
    }
  }, [authed, windowDays, sinceDays, segment, data.rows.length]);

  const rows = data.rows;
  const dollarRows = rows.filter((r) => r.revenue_impact != null);
  const shownSum = dollarRows.reduce((a, r) => a + Number(r.revenue_impact), 0);
  const shownCents = Math.round(shownSum * 100);
  const totalCents = summary?.revenue_impact != null
    ? Math.round(Number(summary.revenue_impact) * 100)
    : null;

  // THE ESTATE TOTAL IS SPLIT BY WHO CAUSED IT, not summed raw.
  //
  // This footer printed `summary.revenue_impact`: the sum of
  // (sold - expected) x price over EVERY evaluated call. On the QA instance that
  // reads about -$71,000, and it is not a measurement of the engine losing
  // money. Two things make it meaningless as a single number:
  //
  //   1. It includes underperformers THE OWNER NEVER ACTED ON. If no stock was
  //      ordered, the product falling short of its own trailing baseline is the
  //      product's own behaviour - following the advice cost the store nothing
  //      there. `recommendationEvalService` computes `missed_unacted` precisely
  //      so the UI can "never blame Botella for a miss the owner didn't act on",
  //      and this line was ignoring it.
  //   2. A reorder card never claims to sell ABOVE trend; it claims to avoid a
  //      stockout. Charging it the full negative deviation is the same unit
  //      error the Gate A promise check made, where a card that forecast 31.4
  //      units and sold 30.0 scored -8%.
  //
  // So the three figures the service already separates are shown separately. No
  // new aggregate is invented and nothing is hidden: the unacted total is still
  // printed, labelled as excluded, because suppressing it would be its own kind
  // of dishonesty.
  const d = summary?.dollars;
  const split = d && typeof d === 'object' ? {
    won: d.won,
    missedActed: d.missed_acted,
    missedUnacted: d.missed_unacted,
    missedUnactedCount: d.missed_unacted_count,
  } : null;

  return (
    <div className="el-list">
      {data.status === 'loading' && (
        <div className="el-skeletons" role="status" aria-label="Loading the calls">
          <div className="el-skel" /><div className="el-skel" /><div className="el-skel" /><div className="el-skel" />
        </div>
      )}
      {data.status === 'error' && (
        <RetrievalNotice sample="ledger"
          error={data.error}
          label="The measured calls"
          onRetry={() => setRefreshKey((k) => k + 1)}
          errorClassName="el-msg"
          fallback={data.message || 'Unable to load the calls.'}
        />
      )}
      {data.status === 'ready' && rows.length === 0 && (
        <p className="el-quiet">
          {data.reason ? `Unavailable: ${data.reason}` : (EMPTY_COPY[segment] || EMPTY_COPY.all)}
        </p>
      )}

      {data.status === 'ready' && rows.length > 0 && (
        <div className="el-rows">
          {rows.map((r) => (
            <EffectivenessCase
              key={r.rec_id}
              rec={r}
              expanded={expandedIds.has(r.rec_id)}
              onToggle={() => onToggleCase(r.rec_id)}
              evalState={evalCache[r.rec_id]}
              onRetry={() => onRetryCase(r.rec_id)}
              reportWindow={windowDays}
              authed={authed}
              userVote={votes && r.rec_id in votes ? votes[r.rec_id] : r.user_vote}
              onVote={onVote ? (next) => onVote(r.rec_id, next) : undefined}
            />
          ))}
        </div>
      )}

      {data.status === 'ready' && rows.length > 0 && (
        <div className="el-footer">
          <span>
            Showing {rows.length} of {data.total} call{data.total === 1 ? '' : 's'}
            {dollarRows.length > 0 && <> · {signedMoney(shownSum)} measured on these</>}
            {split && summary?.evaluated != null ? (
              <>
                {split.won != null && <> · {signedMoney(split.won)} on the calls that worked</>}
                {split.missedActed != null && (
                  <> · {signedMoney(split.missedActed)} on misses the owner acted on</>
                )}
                {split.missedUnacted != null && split.missedUnactedCount > 0 && (
                  <em className="el-quiet">
                    {' '}· {signedMoney(split.missedUnacted)} on {split.missedUnactedCount} miss
                    {split.missedUnactedCount === 1 ? '' : 'es'} with no owner action, excluded
                  </em>
                )}
              </>
            ) : totalCents != null && shownCents !== totalCents && summary?.evaluated != null && (
              <>, of {signedMoney(summary.revenue_impact)} across all {summary.evaluated} calls</>
            )}
          </span>
          <span className="el-footer-actions">
            {moreError && <em className="el-more-error">Couldn&rsquo;t load more. Try again.</em>}
            {rows.length < data.total && (
              <button type="button" className="el-more" onClick={loadMore} disabled={more}>
                {more ? <Loader size={12} className="el-spin" /> : <ChevronDown size={13} />} Show more
              </button>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
