// MetricInfo.js
// -----------------------------------------------------------------------------
// The two affordances that sit beside a figure:
//
//   ⓘ  "What this means" - plain-English definition of the metric.
//      Shown in EVERY environment. A number a store owner cannot interpret is
//      not much use to them.
//
//   ⛁  "Show the query" - the exact SQL that reproduces the figure.
//      STAGING ONLY (utils/env.js). The query names warehouse tables and shows
//      how the metric is derived; it is for us when a number looks wrong, not
//      for the store owner.
//
// This replaces two things:
//
//   * The native `title=""` attributes the rebuilt screens were using. A title
//     is hover-only (so it does not exist on touch), takes about a second to
//     appear, cannot be styled, and gets truncated by the OS. For a definition
//     someone actually needs to read, that is not a tooltip, it is a rumour.
//
//   * The copies of this that live inside storeagent/ui.js, which the rebuilt
//     screens could not reach.
// -----------------------------------------------------------------------------

import React, { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Info, Database, X } from 'lucide-react';
import { checkSqlFor, useCheckSqlReady } from '../storeagent/checkSql';
import { CAN_REVEAL_SQL } from '../utils/env';
import './MetricInfo.css';

/* ── "What this means" ────────────────────────────────────────────────────── */

export function InfoTip({ text, label }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const popRef = useRef(null);
  const close = useCallback(() => setOpen(false), []);

  // The popover is PORTALLED to <body> rather than rendered next to its
  // trigger. Every place these icons belong is inside something that clips:
  // .rh-figures sets overflow:hidden for its rounded corners, the table
  // wrappers set overflow:auto to scroll wide columns, and a card can sit in a
  // stacking context that a z-index cannot climb out of. Rendered in flow, a
  // definition opening from the last tile in a row was simply cut in half.
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return undefined;
    const place = () => {
      const b = btnRef.current;
      if (!b) return;
      const r = b.getBoundingClientRect();
      const w = popRef.current ? popRef.current.offsetWidth : 300;
      const h = popRef.current ? popRef.current.offsetHeight : 120;
      const M = 10;
      // Centre on the trigger, then clamp inside the viewport, so an icon at
      // the right edge of the screen still gets a whole popover.
      let left = r.left + r.width / 2 - w / 2;
      left = Math.max(M, Math.min(left, window.innerWidth - w - M));
      // Below by default; flip above only when below genuinely does not fit.
      const below = r.bottom + 8;
      const top = (below + h > window.innerHeight - M && r.top - 8 - h > M)
        ? r.top - 8 - h
        : below;
      setPos({ top, left, arrow: r.left + r.width / 2 - left });
    };
    place();
    // Re-place rather than follow: a scroll or resize while open moves the
    // trigger, and a popover left behind is worse than one that closes.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  // Click-outside and Escape. Bound only while open, so there is no document
  // listener for the ~always that nothing is showing.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (btnRef.current && btnRef.current.contains(e.target)) return;
      if (popRef.current && popRef.current.contains(e.target)) return;
      close();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  if (!text) return null;

  return (
    <span className="mi-wrap">
      <button
        ref={btnRef}
        type="button"
        className={`mi-btn ${open ? 'is-open' : ''}`}
        aria-label={label ? `What "${label}" means` : 'What this means'}
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); setOpen((o) => !o); }}
      >
        <Info size={13} />
      </button>
      {open && createPortal(
        <div
          ref={popRef}
          className="mi-pop"
          role="tooltip"
          // Hidden until measured, so the first paint is not a flash at 0,0.
          style={pos
            ? { top: pos.top, left: pos.left, '--mi-arrow': `${pos.arrow}px` }
            : { top: 0, left: 0, visibility: 'hidden' }}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="mi-pop-title">What this means</span>
          <span className="mi-pop-text">{text}</span>
        </div>,
        document.body,
      )}
    </span>
  );
}

/* ── "Show the query" - staging only ──────────────────────────────────────── */

export function SqlPeek({ sqlKey, label }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // The queries arrive in a separate chunk. Without this the control would
  // decide it has nothing to show during the first render and never look again.
  useCheckSqlReady();

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Two independent gates, both of which must pass: the build must be staging,
  // AND there must actually be a verified query for this key.
  if (!CAN_REVEAL_SQL) return null;
  const sql = typeof sqlKey === 'string' ? checkSqlFor(sqlKey) : null;
  if (!sql) return null;

  const copy = () => {
    try {
      navigator.clipboard.writeText(sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  };

  return (
    <>
      <button
        type="button"
        className="mi-btn mi-btn-sql"
        aria-label={`Show the query behind ${label || 'this figure'}`}
        title="Staging only: the query behind this figure"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
      >
        <Database size={13} />
      </button>
      {/* Portalled for the same reason as the popover, plus one more: this
          control renders INSIDE the KPI label, which is uppercase and letter-
          spaced, and a <pre> full of SQL inherited all of it. Query text in
          small-caps is exactly as unreadable as it sounds. */}
      {open && createPortal(
        <div className="mi-sql-scrim" onClick={() => setOpen(false)} role="dialog" aria-modal="true">
          <div className="mi-sql" onClick={(e) => e.stopPropagation()}>
            <div className="mi-sql-head">
              <div className="mi-sql-titles">
                <div className="mi-sql-title">{label || sqlKey}</div>
                <div className="mi-sql-sub">
                  The verified query that reproduces this figure for your store.
                  <span className="mi-sql-env">staging only</span>
                </div>
              </div>
              <div className="mi-sql-actions">
                <button type="button" className="mi-sql-btn" onClick={copy}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <button type="button" className="mi-sql-btn" onClick={() => setOpen(false)} aria-label="Close">
                  <X size={14} />
                </button>
              </div>
            </div>
            <pre className="mi-sql-pre">{sql}</pre>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

/**
 * Both together, which is how a figure almost always wants them.
 *
 *   <MetricInfo label="Capital in dead stock"
 *               info="What you have paid for stock that has not sold recently."
 *               sqlKey="buying.dont_buy_capital_tied" />
 */
export default function MetricInfo({ info, sqlKey, label }) {
  if (!info && !sqlKey) return null;
  return (
    <span className="mi-group">
      <InfoTip text={info} label={label} />
      <SqlPeek sqlKey={sqlKey} label={label} />
    </span>
  );
}
