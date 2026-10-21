import React, { useState, useEffect, useRef } from 'react';
import { X, ThumbsUp, ThumbsDown, Sparkles, Check } from 'lucide-react';
import { CATEGORY_META, fallbackCat } from './SuggestionsPage';
import './EffectivenessFeedback.css';

// ── Feedback drawer - recent calls the store hasn't rated yet ───────────────
// A half-screen slide-over from the right. The PARENT prefetches
// GET /api/recommendations/latest in the background on page mount and passes
// it in as `latest`, so opening the drawer is instant: cached rows render
// immediately, and a cold open shows skeleton rows instead of nothing (the
// endpoint's warehouse enrichment can take seconds). Votes go through the
// parent's shared vote store (POST /:id/vote), so a thumb cast here shows up
// on the case rows too. One thumb is plenty; the parent marks the session
// satisfied on the first vote, but the owner can rate them all.

function gist(text, n = 150) {
  const t = String(text || '').trim();
  return t.length > n ? `${t.slice(0, n).trimEnd()}…` : t;
}

function FeedbackRow({ rec, vote, onVote }) {
  const meta = CATEGORY_META[rec.category] || fallbackCat;
  const Icon = meta.icon;
  const names = (rec.products || [])
    .map((p) => p.product_name || p.sku)
    .filter(Boolean)
    .slice(0, 3)
    .join(', ');
  const cast = (dir) => onVote(vote === dir ? 'none' : dir);
  return (
    <div className={`ef-row ${vote ? 'ef-row-voted' : ''}`}>
      <div className="ef-row-main">
        <span className="ef-cat" style={{ '--chip': meta.color }}>
          <Icon size={11} /> {meta.label}
        </span>
        {names && <span className="ef-names">{names}</span>}
        <p className="ef-gist">{gist(rec.rationale)}</p>
      </div>
      <div className="ef-row-vote">
        {vote && <span className="ef-noted"><Check size={12} /> noted</span>}
        <button
          type="button"
          className={`ef-vote ${vote === 'up' ? 'ef-vote-on-up' : ''}`}
          title={vote === 'up' ? 'Remove your rating' : 'Good call'}
          aria-pressed={vote === 'up'}
          onClick={() => cast('up')}
        >
          <ThumbsUp size={14} />
        </button>
        <button
          type="button"
          className={`ef-vote ${vote === 'down' ? 'ef-vote-on-down' : ''}`}
          title={vote === 'down' ? 'Remove your rating' : 'Off the mark'}
          aria-pressed={vote === 'down'}
          onClick={() => cast('down')}
        >
          <ThumbsDown size={14} />
        </button>
      </div>
    </div>
  );
}

// latest: { status: 'loading'|'ready'|'error', rows } - prefetched by the
// parent. votes/onVote: the page's shared vote store; votes[id] overrides the
// fetched user_vote. onClose(): dismiss (parent stamps the session flag).
export default function EffectivenessFeedback({ latest, votes, onVote, onClose }) {
  // The ask list is captured ONCE, when data is first ready - rows must not
  // vanish from under the owner as they vote them down the list.
  const [askIds, setAskIds] = useState(null);
  const closeRef = useRef(null);

  useEffect(() => {
    if (latest.status !== 'ready' || askIds != null) return;
    setAskIds(latest.rows
      .filter((r) => (r.id in votes ? votes[r.id] : r.user_vote) == null)
      .map((r) => r.id));
  }, [latest, askIds, votes]);

  // Escape closes; focus lands on the close button when the panel opens.
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows = askIds ? latest.rows.filter((r) => askIds.includes(r.id)) : null;
  const voted = rows
    ? rows.filter((r) => (r.id in votes ? votes[r.id] : r.user_vote) != null).length
    : 0;

  return (
    <div className="ef-overlay" onClick={onClose} role="presentation">
      <aside
        className="ef-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Rate recent recommendations"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ef-head">
          <Sparkles size={16} />
          <div>
            <h3>How were the recent calls?</h3>
            <p>One thumb is plenty; it sharpens what Botella suggests next. Rate them all if you feel like it.</p>
          </div>
          <button type="button" ref={closeRef} className="ef-close" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <div className="ef-rows">
          {latest.status === 'loading' && (
            <div className="ef-skeletons" role="status" aria-label="Loading the recent calls">
              <div className="ef-skel" /><div className="ef-skel" /><div className="ef-skel" />
            </div>
          )}
          {latest.status === 'error' && (
            <p className="ef-quiet">Couldn&rsquo;t load the recent calls just now. Try again in a moment.</p>
          )}
          {latest.status === 'ready' && rows && rows.length === 0 && (
            <p className="ef-quiet">You&rsquo;ve rated all the recent calls. Thank you.</p>
          )}
          {latest.status === 'ready' && rows && rows.map((rec) => (
            <FeedbackRow
              key={rec.id}
              rec={rec}
              vote={rec.id in votes ? votes[rec.id] : rec.user_vote}
              onVote={(next) => onVote(rec.id, next)}
            />
          ))}
        </div>

        <footer className="ef-foot">
          <span className="ef-progress">
            {rows && rows.length > 0 && (voted > 0
              ? `${voted} of ${rows.length} rated. Thank you.`
              : `${rows.length} recent call${rows.length === 1 ? '' : 's'} unrated`)}
          </span>
          <button type="button" className="ef-done" onClick={onClose}>
            {voted > 0 ? 'Done' : 'Maybe later'}
          </button>
        </footer>
      </aside>
    </div>
  );
}
