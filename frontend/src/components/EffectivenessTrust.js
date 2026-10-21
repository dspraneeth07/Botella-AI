import React, { useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { CATEGORY_META, ACTION_LABELS } from './SuggestionsPage';
import './EffectivenessTrust.css';

// ── Trust ledger: where the calls land, by category / signal / action ──────
// Replaces the three breakdown tables with one plain-language list:
//   "Weather - 12 made · you acted on 8 · 7 worked · avg lift 1.6x"
// with a small bar (green = worked share, yellow = underperformed share).
// Rows cover MEASURABLE calls only - the backend groups them that way - and
// the acted / acted_won counts ship only from Phase-1 backends: when absent
// the follow-through fragment is hidden, never shown as a zero.
// Since migration 039 `acted` is CONFIRMED BY DATA (a feed row, an invoice,
// a stock inflow, a price drop, a catalogue arrival); the owner's unconfirmed
// word arrives as `claimed` and a measured absence as `not_followed`, and each
// is printed on its own, never folded into "you acted on".
// Clicking a category or signal row drills the ledger below into those calls;
// action types have no ledger filter (yet), so those rows stay read-only.

const TABS = [
  { id: 'category', label: 'Category' },
  { id: 'signal', label: 'Signal' },
  { id: 'action', label: 'Action' },
];

const rowLabel = (tab, key) => {
  if (tab === 'category') return CATEGORY_META[key]?.label || String(key).replace(/_/g, ' ');
  if (tab === 'action') return ACTION_LABELS[key] || String(key).replace(/_/g, ' ');
  return String(key).replace(/_/g, ' ');
};

function TrustRow({ row, label, onClick }) {
  const winShare = row.recs ? (row.winners || 0) / row.recs : 0;
  const offShare = row.recs ? (row.underperformers || 0) / row.recs : 0;
  const bits = [`${row.recs} made`];
  if (row.acted != null) bits.push(`${row.acted} confirmed done by your data`);
  if (row.claimed) bits.push(`${row.claimed} marked done, unconfirmed`);
  if (row.not_followed) bits.push(`${row.not_followed} not followed`);
  bits.push(`${row.winners || 0} worked`);
  if (row.avg_lift != null) bits.push(`avg lift ${row.avg_lift}x`);
  const title = row.acted_won != null && row.acted > 0
    ? `Of the ${row.acted} your data confirms you acted on, ${row.acted_won} worked.`
    : undefined;
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      {...(onClick ? { type: 'button', onClick } : {})}
      className={`et-row ${onClick ? 'et-row-click' : ''}`}
      title={title}
    >
      <span className="et-line">
        <span className="et-name">{label}</span>
        <span className="et-stats">{bits.join(' · ')}</span>
      </span>
      <span className="et-bar" aria-hidden="true">
        <span className="et-bar-win" style={{ width: `${Math.round(winShare * 100)}%` }} />
        <span className="et-bar-off" style={{ width: `${Math.round(offShare * 100)}%` }} />
      </span>
    </Tag>
  );
}

// byCategory/bySignal/byAction: the report's group rows
// ({key, recs, winners, underperformers, acted?, acted_won?, avg_score, avg_lift}).
// onDrill({category}|{signal}) applies the matching ledger filter; null when
// the ledger endpoint is unsupported (older backend) - rows go read-only.
export default function EffectivenessTrust({ byCategory, bySignal, byAction, onDrill }) {
  const [tab, setTab] = useState('category');
  const sets = { category: byCategory || [], signal: bySignal || [], action: byAction || [] };
  if (!sets.category.length && !sets.signal.length && !sets.action.length) return null;
  const rows = sets[tab];
  const drillFor = (key) => {
    if (!onDrill) return undefined;
    if (tab === 'category') return () => onDrill({ category: key });
    if (tab === 'signal') return () => onDrill({ signal: key });
    return undefined; // no ledger filter for action types
  };
  return (
    <div className="et-card">
      <div className="et-head">
        <h4><BarChart3 size={14} /> Trust ledger: where the calls land</h4>
        <div className="et-tabs" role="tablist" aria-label="Group calls by">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`et-tab ${tab === t.id ? 'et-tab-active' : ''}`}
              onClick={() => setTab(t.id)}
            >{t.label}</button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="et-quiet">Nothing measured in this grouping yet.</p>
      ) : rows.slice(0, 10).map((r) => (
        <TrustRow key={r.key} row={r} label={rowLabel(tab, r.key)} onClick={drillFor(r.key)} />
      ))}
      <p className="et-foot">
        Measurable calls only. Avg lift compares each product to its own previous 4 weeks
        (outliers capped at 5x).
        {onDrill && tab !== 'action' && ' Click a row to see those calls in the list above.'}
        {tab === 'action' && ' Action rows can’t filter the ledger yet.'}
      </p>
    </div>
  );
}
