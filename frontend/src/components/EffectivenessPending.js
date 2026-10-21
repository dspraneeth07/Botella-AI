import React, { useState } from 'react';
import {
  Clock, Tag, HelpCircle, PackageX, Check, AlertTriangle, ChevronDown,
} from 'lucide-react';
import { CATEGORY_META, ACTION_LABELS, fallbackCat } from './SuggestionsPage';
import { evidenceToSentences } from './EffectivenessCase';
import RetrievalNotice from './RetrievalNotice';
import './EffectivenessPending.css';

// ── "Awaiting your action" card ─────────────────────────────────────────────
// Rows come from GET /api/recommendations/pending-actions: current recs whose
// observable action hasn't been detected yet. The endpoint walks the warehouse
// (~5-7s, server-cached), so the parent loads it in the background and this
// card shows a shimmer skeleton meanwhile - it never blocks the tab's paint.
//
// Honesty split, never conflated:
//   action_taken === false → "…- we checked." (proven; copy names WHAT was
//     checked, per detector: orders/stock for reorders, price for markdowns,
//     the catalog registry for stock_new)
//   action_taken === null  → "We can't see this one. Did you do it?" (unknown)
// Only the null rows get "I did this / Not yet" buttons (POST /:id/action-claim
// {claim:'did'|'did_not'}) - an answer helps us measure; it never overrides
// hard register evidence.
//
// Since migration 039 each row also carries `action_claim` and
// `fulfilment_state`. A row the owner already marked done ('did') is shown as
// "Marked done - awaiting confirmation" and is NEVER asked again; a 'did_not'
// is shown as "you said not yet" with the offer still open. The backend has
// already dropped confirmed and dismissed cards from this list.

const COLLAPSE_AT = 8;

// The proven-false status line, honest about which detector proved it (see
// backend detectAction): markdown/liquidate are proven by the PRICE holding,
// stock_new by the catalog registry - "no order on the books" would claim a
// purchase-order check that never happened for those.
function checkedCopy(actionType) {
  if (actionType === 'markdown' || actionType === 'liquidate') {
    return "Price hasn't moved. We checked.";
  }
  if (actionType === 'stock_new') {
    return "Hasn't appeared in your catalog. We checked your product registry.";
  }
  return 'No order or restock on the books. We checked.';
}

function PendingRow({ row, onClaim }) {
  const meta = CATEGORY_META[row.category] || fallbackCat;
  const Icon = meta.icon;
  const actionLabel = ACTION_LABELS[row.action_type] || String(row.action_type || '').replace(/_/g, ' ');
  // Real product names when the backend ships them (additive `products`
  // field); raw SKUs on older backends or uncataloged products (stock_new).
  const names = (row.products?.length
    ? row.products.map((p) => p.product_name || p.sku)
    : (row.primary_skus || []));
  const nameText = names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3} more` : '');
  // Hover detail on the "we checked" line: the detector's own plain-English trail.
  const evidenceTitle = evidenceToSentences(row.evidence, row.action_taken).join(' ');
  // The owner's word on this row: the optimistic flip the parent writes
  // (claim_state) first, else what the server already holds (action_claim).
  const claim = row.claim_state || row.action_claim || null;

  return (
    <div className="epd-row">
      <div className="epd-line">
        <span className="epd-cat" style={{ '--chip': meta.color }}>
          <Icon size={11} /> {meta.label}
        </span>
        <span className="epd-name">
          <span className="epd-action">{actionLabel}:</span> {nameText || 'this call'}
        </span>
        {row.days_left != null && (
          <span
            className={`epd-days ${row.days_left <= 2 ? 'epd-days-urgent' : ''}`}
            title={row.valid_through ? `Valid through ${row.valid_through}` : undefined}
          >
            {row.days_left <= 0 ? 'ends today' : `${row.days_left}d left`}
          </span>
        )}
      </div>

      {row.rationale_gist && <p className="epd-gist">{row.rationale_gist}</p>}
      {row.quantity_hint && (
        <p className="epd-qty"><Tag size={11} /> {row.quantity_hint}</p>
      )}

      <div className="epd-status">
        {claim === 'did' ? (
          // Marked done, by the owner. The data has not confirmed it (a
          // confirmed card never reaches this list), so it is shown as the
          // owner's word, and not asked again.
          <span className="epd-thanks" title={row.fulfilment_summary || undefined}>
            <Check size={12} /> Marked done{row.fulfilment_state === 'confirmed' ? '' : ' - awaiting confirmation from your orders, stock or price'}.
          </span>
        ) : row.action_taken === false ? (
          <>
            <span className="epd-checked" title={evidenceTitle || undefined}>
              <PackageX size={12} /> {checkedCopy(row.action_type)}
            </span>
            {claim === 'did_not' && <span className="epd-unknown">You said not yet.</span>}
          </>
        ) : (
          <>
            <span className="epd-unknown">
              <HelpCircle size={12} />
              {claim === 'did_not'
                ? ' You said not yet. Done since?'
                : " We can't see this one. Did you do it?"}
            </span>
            <span className="epd-actions">
              <button type="button" className="epd-btn epd-btn-yes" onClick={() => onClaim(row.rec_id, 'did')}>
                I did this
              </button>
              {claim !== 'did_not' && (
                <button type="button" className="epd-btn" onClick={() => onClaim(row.rec_id, 'did_not')}>
                  Not yet
                </button>
              )}
            </span>
          </>
        )}
        {row.claim_error && (
          <span className="epd-error"><AlertTriangle size={11} /> Couldn't save that. Try again.</span>
        )}
      </div>
    </div>
  );
}

// state: { status: 'loading'|'ready'|'error'|'unavailable', rows: [...] }
// onClaim(recId, 'did'|'did_not') - parent owns the optimistic update/rollback.
// embedded: rendered inside the page's unified calls list (the "Waiting on
// you" tab) - no card chrome or heading of its own, just the rows plus the
// one-line why-answer note.
// onRetry: re-fetch after a failed load (the notice offers it only for an
// outage, never for a store whose data is not there).
export default function EffectivenessPending({ state, onClaim, onRetry, embedded = false }) {
  const [showAll, setShowAll] = useState(false);
  if (!state || state.status === 'unavailable') return null;

  const rows = state.rows || [];
  const visible = showAll || rows.length <= COLLAPSE_AT ? rows : rows.slice(0, COLLAPSE_AT);

  return (
    <div className={embedded ? 'epd-embedded' : 'epd-card'}>
      {!embedded && (
        <h4>
          <Clock size={14} /> Awaiting your action
          {state.status === 'ready' && rows.length > 0 && <span className="epd-count">{rows.length}</span>}
        </h4>
      )}
      <p className="epd-sub">
        Answering helps us measure what worked; hard evidence from your register always outranks a self-report.
      </p>

      {state.status === 'loading' && (
        <div className="epd-skeletons" aria-label="Checking for pending actions" role="status">
          <div className="epd-skel" /><div className="epd-skel" /><div className="epd-skel" />
        </div>
      )}
      {state.status === 'error' && (
        // The READING, not a quiet shrug: an outage gets Retry; a store whose
        // warehouse has no sales tables is told so and offered our contact.
        <RetrievalNotice sample="pending"
          error={state.error}
          label="Pending actions"
          onRetry={onRetry}
          errorClassName="epd-quiet"
          fallback="Couldn't check your pending actions just now."
        />
      )}
      {state.status === 'ready' && rows.length === 0 && (
        <p className="epd-quiet">Nothing is waiting on you right now.</p>
      )}

      {state.status === 'ready' && visible.map((row) => (
        <PendingRow key={row.rec_id} row={row} onClaim={onClaim} />
      ))}

      {state.status === 'ready' && rows.length > COLLAPSE_AT && (
        <button type="button" className="epd-more" onClick={() => setShowAll((v) => !v)}>
          <ChevronDown size={13} className={showAll ? 'epd-flip' : ''} />
          {showAll ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  );
}
