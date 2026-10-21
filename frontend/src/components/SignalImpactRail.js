// SignalImpactRail.js
// -----------------------------------------------------------------------------
// The Signals panel on the Recommendations screen, fed by
// GET /api/signal-impact/today: one row per signal live at the store today -
// its feed's icon and colour, what it is and when, what the weekly fit found
// it does to this store's drink families, and the cards it reached.
//
// "I want to see which external signals exist and their impact on the
// recommendations." The old rail listed the signals and stopped; the cards
// said nothing about them; and an owner looking at sixteen live signals and
// ten silent cards concluded the engine ignores the feeds. It examines every
// one. Most are refused for want of data - a home game that has happened
// seven times cannot be measured against a 20-day floor - and this rail says
// so in words, per signal, so "not yet measurable" is a thing the owner can
// read rather than an absence they have to interpret.
//
// NEVER IMPLY AN EFFECT. The row's impact line is the server's state word and
// sentence (lib/signalsToday.js): a measured effect carries its number and
// interval; a refused one carries the reason and NO number; a signal the fit
// has not seen says so. Nothing here derives a figure.
//
// FALLS BACK, never blanks. If the request fails or returns no active signal,
// the caller's snapshot-only rendering (the old rail) is shown instead, with
// its own count, so a backend behind this endpoint still shows the signals.
// -----------------------------------------------------------------------------

import React, { useState, useEffect, useMemo } from 'react';
import { Radar, ArrowRight, Package, ChevronDown } from 'lucide-react';
import { DOMAIN_META } from './SignalsModal';
import './SignalImpactRail.css';

// The server's domain words. 'internal' is a stock fact a card cited (the
// LLM-era keys), shown for what it is rather than dressed as a feed.
const INTERNAL_META = { label: 'Your stock', icon: Package, color: '#90909C' };
const STATE_WORD = {
  measured: 'Measured',
  not_yet_measurable: 'Not yet measurable',
  not_fitted: 'Not fitted',
};
const TYPE_TAG = {
  reorder: 'Reorder', pre_stock: 'Pre-stock', cold_box: 'Cold box', stock_new: 'Stock new',
  bundle: 'Bundle', liquidate: 'Liquidate', markdown: 'Markdown', promote: 'Promote',
  endcap: 'Endcap', win_back: 'Win-back', reprice: 'Reprice',
};

// 'YYYY-MM-DD' or 'YYYY-MM-DD..YYYY-MM-DD' -> 'Fri, Oct 23' / 'Oct 20 - Oct 22'.
// Components form, not a string: a bare ISO string parses as UTC midnight and
// shifts a day west of Greenwich.
function fmtDay(iso, withWeekday) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString('en-US', withWeekday
    ? { weekday: 'short', month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric' });
}
export function fmtWhen(when) {
  if (!when) return null;
  const [a, b] = String(when).split('..');
  if (b && b !== a) return `${fmtDay(a, false)} - ${fmtDay(b, false)}`;
  return fmtDay(a, true);
}

/** Fetch the day's signals. Exposed for tests; the component calls it. */
export async function fetchSignalsToday(base, headers) {
  const res = await fetch(`${base}/api/signal-impact/today`, { headers });
  if (!res.ok) throw new Error(`/api/signal-impact/today ${res.status}`);
  const body = await res.json();
  return body && body.data ? body.data : null;
}

function SignalRow({ sig, nameOf, onCardJump }) {
  const [open, setOpen] = useState(false);
  const meta = sig.domain === 'internal' ? INTERNAL_META : (DOMAIN_META[sig.domain] || INTERNAL_META);
  const Icon = meta.icon;
  const when = fmtWhen(sig.when);
  const n = (sig.cards || []).length;
  return (
    <li className={`sir-row sir-${sig.state}`} style={{ '--sig': meta.color }}>
      <span className="sir-icon" title={meta.label}><Icon size={14} /></span>
      <div className="sir-body">
        <div className="sir-top">
          <span className="sir-label" title={sig.label}>{sig.label}</span>
          {when && <span className="sir-when">{when}</span>}
        </div>
        <p className="sir-impact">
          <strong className="sir-state">{STATE_WORD[sig.state] || sig.state}</strong>
          {sig.state_reason ? <> · {sig.state_reason}</> : null}
        </p>
        {n > 0 ? (
          <>
            <button type="button" className="sir-cards" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
              <ChevronDown size={12} className={open ? 'sir-chev-open' : ''} />
              {n} card{n === 1 ? '' : 's'}
            </button>
            {open && (
              <ul className="sir-cardlist">
                {sig.cards.map((c) => (
                  <li key={c.id}>
                    <button type="button" className="sir-card" onClick={() => onCardJump && onCardJump(c.id)} title="Show this card">
                      <span className="sir-card-type">{TYPE_TAG[c.action_type] || c.action_type || 'Card'}</span>
                      <span className="sir-card-name">{nameOf(c)}</span>
                      <span className="sir-card-via">{c.via === 'cited' ? 'named on the card' : 'measured on its family'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <span className="sir-nocards">No card rests on it today</span>
        )}
      </div>
    </li>
  );
}

/**
 * @param {object} props
 * @param {string} props.base         API origin (no trailing /api)
 * @param {object} props.headers      auth headers
 * @param {object[]} props.cards      the screen's cards, for product names by id
 * @param {function} props.onViewAll  opens SignalsModal
 * @param {function} props.onCardJump (id) => scroll to / highlight the card
 * @param {function} props.renderFallback  () => the snapshot-only rail
 * @param {number} props.fallbackCount     the snapshot-only count for the header
 */
export default function SignalImpactRail({ base, headers, cards, onViewAll, onCardJump, renderFallback, fallbackCount }) {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    fetchSignalsToday(base, headers)
      .then((d) => { if (alive) setData(d); })
      .catch(() => { if (alive) { setData(null); setFailed(true); } });
    return () => { alive = false; };
  }, [base, headers]);

  // Product names come from the cards the screen already holds (getLatest
  // enriches them from the warehouse); the server's `product` is the SKU.
  const nameOf = useMemo(() => {
    const byId = new Map((cards || []).map((c) => [String(c.id), c]));
    return (c) => {
      const card = byId.get(String(c.id));
      const lead = card && card.products && card.products[0];
      return (lead && lead.product_name) || c.product || (card && card.primary_skus && card.primary_skus[0]) || 'this product';
    };
  }, [cards]);

  const active = data && Array.isArray(data.active) ? data.active : [];
  const live = !failed && active.length > 0;
  const measured = active.filter((s) => s.state === 'measured').length;

  return (
    <section className="rh-panel sir-panel">
      <header className="rh-panel-head">
        <span className="rh-panel-title"><Radar size={15} /> Signals informing today’s recommendations</span>
        <span className="rh-panel-count">{live ? active.length : (fallbackCount || 0)} active</span>
      </header>
      {live ? (
        <>
          <p className="sir-lede">
            {measured > 0
              ? `${measured} of ${active.length} measured against your sales; the rest were checked and cannot be measured yet.`
              : `All ${active.length} checked against your sales; none can be measured yet - each row says why.`}
            {data.cards_total > 0 ? ` ${data.cards_with_signal} of ${data.cards_total} cards rest on one.` : ''}
          </p>
          <ul className="sir-list">
            {active.map((sig) => (
              <SignalRow key={sig.signal_key} sig={sig} nameOf={nameOf} onCardJump={onCardJump} />
            ))}
          </ul>
          <button type="button" className="rh-plan-viewall" onClick={onViewAll}>View all signals <ArrowRight size={13} /></button>
        </>
      ) : (
        renderFallback ? renderFallback() : null
      )}
    </section>
  );
}
