import React, { useState, useEffect, useCallback } from 'react';
import {
  ChevronDown, Lightbulb, TrendingUp, Award, CheckCircle2, XCircle,
  HelpCircle, Loader, RefreshCw, AlertTriangle, Tag, ExternalLink, Info,
  ThumbsUp, ThumbsDown,
} from 'lucide-react';
import {
  ResponsiveContainer, ComposedChart, Area, XAxis, YAxis, Tooltip,
  ReferenceLine, ReferenceArea,
} from 'recharts';
import {
  CATEGORY_META, ACTION_LABELS, fallbackCat, SIGNAL_KIND_META,
} from './SuggestionsPage';
import { formatLocalDate } from '../utils/date';
import './EffectivenessCase.css';

// ── One recommendation's case file ──────────────────────────────────────────
// The expandable row used by the Effectiveness tab's ledger (and the legacy
// Best/Worst lists on older backends). Collapsed: one scannable line - verdict
// chip, gist, expected → sold, lift, realized $, partial marker. Expanded: the
// four-beat story of the call, per evaluation window:
//   RECOMMENDED → YOU ACTED → SALES ANSWERED → VERDICT
// Data comes from GET /api/recommendations/:id/evaluation, fetched lazily by
// the parent on first expand and cached there (evalState prop). Everything
// shown is MEASURED; the honesty rules for action_taken are hard:
//   null  → "we can't tell whether you did this"  (never rounded up to yes)
//   false → "no action showed up - we checked"    (provably not done)

export const VERDICT_META = {
  winner:            { label: 'Worked',          color: 'var(--green, #2FBF97)' },
  underperformer:    { label: 'Underperformed',  color: 'var(--yellow, #F0ABFC)' },
  neutral:           { label: 'Neutral',         color: 'var(--accent-light, #B79CFF)' },
  insufficient_data: { label: 'Not measurable',  color: 'var(--text-muted, #8e94ad)' },
};

const price = (n) => `$${Number(n).toFixed(2)}`;
// Signed, cent-precise dollars (Dashboard.js's fmtMoney convention) - these
// are MEASURED impacts that can run negative, so the sign is always explicit.
// Shared by EffectivenessPage's Verdict Line and the ledger's footer.
export const signedMoney = (n) => {
  if (n == null) return null;
  const v = Number(n);
  const abs = Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${v < 0 ? '-' : '+'}$${abs}`;
};
// expected_units is a real (e.g. 3.21) - one decimal reads naturally, whole
// numbers stay whole.
const fmtUnits = (n) => {
  if (n == null) return null;
  const v = Number(n);
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};
// Bare 'YYYY-MM-DD' strings parse as LOCAL midnight via utils/date - never
// `new Date(str)` (UTC shift). Short forms for chips and chart ticks.
const shortDate = (d) => (d ? formatLocalDate(d, { month: 'short', day: 'numeric' }) : '');
const dayOfWeek = (d) => (d ? formatLocalDate(d, { weekday: 'short' }) : '');
const keyLabel = (key) => String(key || '').replace(/_/g, ' ');
// Snapshot URLs originate from external news feeds and are stored verbatim -
// only ever link out to real web schemes; anything else (javascript:, data:,
// ...) degrades to the plain non-link chip.
const safeHref = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u.trim()) ? u.trim() : null);

// ── De-jargoning tooltips (shared with EffectivenessPage) ───────────────────
// Hover or keyboard-focus reveals the bubble; screen readers get the same
// text via the button's aria-label. Styles live in EffectivenessCase.css so
// the tip travels with every component that imports from this module.
export function InfoTip({ text }) {
  return (
    <span className="ep-tip">
      <button type="button" className="ep-tip-btn" aria-label={text}>
        <Info size={11} />
      </button>
      <span className="ep-tip-bubble" role="tooltip" aria-hidden="true">{text}</span>
    </span>
  );
}

export const LIFT_TIP = 'Lift compares units sold after a call to the same product’s own previous 4 weeks: 2x means it sold at twice its usual pace. Averages cap outliers at 5x.';
export const SCORE_TIP = 'The score blends three measured things: how it sold vs its own baseline (most of the weight), whether we saw you act on it, and your thumbs vote. It runs 0 to 1; 0.6 and up is a winner, 0.4 and under an underperformer.';

// action_evidence is JSONB (arrives parsed), but tolerate a string copy.
function parseEvidence(e) {
  if (!e) return null;
  if (typeof e === 'string') {
    try { return JSON.parse(e); } catch { return null; }
  }
  return typeof e === 'object' ? e : null;
}

// Detector honesty notes → plain words. Unknown notes pass through verbatim -
// the backend already writes them in plain English.
function plainNote(note, at) {
  const n = String(note || '');
  if (/inflow detected but not attributable/i.test(n)) {
    return `Stock did come in${at}, but too late for us to tie it to this window.`;
  }
  if (/restock before capture would be invisible/i.test(n)) {
    return `Our stock snapshot arrived late${at}, so a restock before it would be invisible to us.`;
  }
  if (/cut before capture would be invisible/i.test(n)) {
    return `Our price snapshot arrived late${at}, so a price cut before it would be invisible to us.`;
  }
  return n;
}

/**
 * Translate detector evidence JSON into plain-English sentences.
 * Shapes handled (see backend detectAction() / evaluateTenant()):
 *   { detector:'owner_reported', claim }
 *   { detector:'unobservable', action_type }
 *   { detector:'stock_new', note }
 *   { detector:'catalog_registry', upc, arrived:{sku,first_seen}|null, note? }
 *   { skus:[{ sku, taken, detector:'purchase_orders'|'stock_delta'|'price'|'none', ...numbers, note? }] }
 */
export function evidenceToSentences(evidence, actionTaken) {
  const ev = parseEvidence(evidence);
  if (!ev) return [];
  const out = [];

  if (ev.detector === 'owner_reported') {
    out.push(ev.claim === 'did'
      ? 'You told us you did this, counted as owner-reported. Hard register evidence would outrank it.'
      : "You told us you didn't get to this one.");
    return out;
  }
  if (ev.detector === 'unobservable') {
    const move = ACTION_LABELS[ev.action_type] || String(ev.action_type || 'this move').replace(/_/g, ' ');
    out.push(`"${move}" happens on the shop floor; no register data can show it, so only you can tell us.`);
    return out;
  }
  if (ev.detector === 'stock_new') {
    out.push(/no reference_upc/i.test(String(ev.note || ''))
      ? "We couldn't track this product: no barcode was recorded for it."
      : plainNote(ev.note, ''));
    return out.filter(Boolean);
  }
  if (ev.detector === 'catalog_registry') {
    if (ev.arrived && actionTaken === true) {
      out.push(`You started carrying it on ${formatLocalDate(ev.arrived.first_seen, { month: 'long', day: 'numeric' })}; it appeared in your catalog.`);
    } else if (ev.arrived) {
      out.push(`It appeared in your catalog on ${formatLocalDate(ev.arrived.first_seen, { month: 'long', day: 'numeric' })}, after this window closed.`);
    } else {
      out.push('It never appeared in your catalog. We checked your product registry.');
    }
    return out;
  }

  const skus = Array.isArray(ev.skus) ? ev.skus : null;
  if (skus) {
    const many = skus.length > 1;
    for (const s of skus) {
      const at = many && s.sku ? ` for ${s.sku}` : '';
      if (s.detector === 'purchase_orders') {
        const u = s.purchased_units;
        out.push(`We saw a purchase order for ${u} unit${u === 1 ? '' : 's'}${at} after this call.`);
      } else if (s.detector === 'invoice') {
        // An uploaded invoice with a line a person matched to this product -
        // a document, dated; it says what was ordered and when, not that the
        // goods are on the shelf. Named by number when the document has one.
        const u = s.invoice_units;
        const day = Array.isArray(s.invoice_dates) && s.invoice_dates[0]
          ? ` dated ${formatLocalDate(s.invoice_dates[0], { month: 'long', day: 'numeric' })}` : '';
        const no = Array.isArray(s.invoice_nos) && s.invoice_nos[0] ? ` #${s.invoice_nos[0]}` : '';
        out.push(`Your uploaded invoice${no}${day} lists ${u} unit${Number(u) === 1 ? '' : 's'}${at}; a line you matched to this product.`);
      } else if (s.detector === 'stock_delta') {
        if (s.taken === true) {
          out.push(`Stock went up by ${s.net_inflow} units${at}, more than the ${s.threshold} we'd expect from sales alone.`);
        } else if (s.taken === false) {
          out.push(`Stock didn't rise beyond normal selling${at} (net inflow ${s.net_inflow}, restock bar ${s.threshold}). We checked.`);
        } else if (s.note) {
          out.push(plainNote(s.note, at));
        } else {
          out.push(`We couldn't read the stock movement${at}.`);
        }
      } else if (s.detector === 'price') {
        const then = Number(s.effective_price_then);
        const now = Number(s.effective_price_now);
        if (s.taken === true) {
          const drop = then > 0 ? Math.round((1 - now / then) * 100) : null;
          out.push(`Price dropped from ${price(then)} to ${price(now)}${drop != null ? ` (${drop}%)` : ''}${at} after the call.`);
        } else if (s.taken === false) {
          out.push(`Price held at ${price(now)}${at}; no markdown showed up, and we checked.`);
        } else if (s.note) {
          out.push(plainNote(s.note, at));
        }
      } else {
        out.push(`We had no stock or price data${at} to check this against.`);
      }
    }
  }
  return out;
}

// Lead line for the YOU ACTED beat. The copy rules are non-negotiable:
//
//   "You did this."  ONLY when the data confirmed it (migration 039) - the
//                    card's fulfilment_state is 'confirmed', or, for a window
//                    row on an older card, action_taken is TRUE from a real
//                    detector. Never from an owner report: a click is not a
//                    purchase order.
//   claimed          the owner said 'did' and nothing has confirmed it: said
//                    in the owner's words, as the owner's word.
//   no               a detector with full visibility saw nothing; when the
//                    owner had said 'did', the line says both.
//   unknown          otherwise.
//
// `ctx` is optional for callers that only have the window row:
//   { fulfilment: rec.fulfilment_state, claim: ev.claim | rec.action_claim,
//     detector: ev.detector }
export function actionLead(taken, ctx = {}) {
  const { fulfilment, claim, detector } = ctx || {};
  const ownerReported = detector === 'owner_reported';
  if (fulfilment === 'confirmed' || (taken === true && !ownerReported && fulfilment !== 'claimed')) {
    return { tone: 'yes', text: 'You did this.' };
  }
  if (fulfilment === 'claimed' || (taken === true && ownerReported) || (claim === 'did' && taken == null)) {
    return { tone: 'claimed', text: 'You marked this done; your data has not shown it yet.' };
  }
  if (taken === false) {
    return claim === 'did'
      ? { tone: 'no', text: 'You marked this done, but no action showed up in your data. We checked.' }
      : { tone: 'no', text: 'No action showed up. We checked.' };
  }
  return { tone: 'unknown', text: "We can't tell whether you did this." };
}

// ── "Why this call" trigger chips (GET /:id/case, Phase 2) ──────────────────
// detail is the RAW snapshot entry for the cited signal - ANY field may be
// null, and unresolved keys are guaranteed to occur (snapshots are trimmed to
// ~10 entries; keys like 'area_winner' never have entries). Everything
// degrades to a plain bare-key chip, never a hole.
export function describeTrigger(t) {
  if (!t || !t.key) return null;
  const d = t.detail;
  const meta = SIGNAL_KIND_META[t.kind];
  const bare = { icon: Tag, color: null, label: keyLabel(t.key), title: `Cited signal: ${keyLabel(t.key)}` };
  if (!d || !meta) return bare;

  if (t.kind === 'weather') {
    let label;
    if (t.key === 'cold_snap') {
      label = d.low_f != null
        ? `Cold snap: ${Math.round(d.low_f)}°F${d.low_date ? ` ${dayOfWeek(d.low_date)}` : ''}`
        : (d.summary || 'Cold snap');
    } else if (t.key === 'severe_weather') {
      label = (Array.isArray(d.alerts) && d.alerts.length) ? d.alerts[0] : (d.summary || 'Severe weather');
    } else {
      label = d.high_f != null
        ? `Heatwave: ${Math.round(d.high_f)}°F${d.high_date ? ` ${dayOfWeek(d.high_date)}` : ''}`
        : (d.summary || keyLabel(t.key));
    }
    const title = [
      d.summary,
      d.window_start && d.window_end ? `outlook ${shortDate(d.window_start)} - ${shortDate(d.window_end)}` : null,
    ].filter(Boolean).join(' · ');
    return { icon: meta.icon, color: meta.color, label, title: title || label };
  }
  if (t.kind === 'sports') {
    const when = dayOfWeek(d.date);
    let label = d.home && d.away
      ? `${d.home} home vs ${d.away}${when ? ` ${when}` : ''}`
      : keyLabel(t.key);
    if (d.games > 1) label += `, ${d.games} games`;
    const title = [
      d.venue,
      d.date ? shortDate(d.date) : null,
      d.games > 1 && d.end_date ? `through ${shortDate(d.end_date)}` : null,
    ].filter(Boolean).join(' · ');
    return { icon: meta.icon, color: meta.color, label, title: title || label };
  }
  if (t.kind === 'event') {
    const bits = [];
    if (d.draw) bits.push(`${d.draw} draw`);
    if (d.distance_mi != null) bits.push(`${d.distance_mi}mi`);
    if (d.nights > 1) bits.push(`${d.nights} nights`);
    const label = d.name
      ? `${d.name}${bits.length ? ` (${bits.join(', ')})` : ''}`
      : keyLabel(t.key);
    const title = [d.venue, d.date ? shortDate(d.date) : null, d.note].filter(Boolean).join(' · ');
    return { icon: meta.icon, color: meta.color, label, title: title || label };
  }
  if (t.kind === 'holiday') {
    const label = d.name
      ? `${d.name}${d.date ? `, ${shortDate(d.date)}` : ''}`
      : keyLabel(t.key);
    const title = d.days_away != null ? `${d.days_away} days away when this was called` : label;
    return { icon: meta.icon, color: meta.color, label, title };
  }
  if (t.kind === 'news') {
    const label = d.headline || keyLabel(t.key);
    const title = [d.source, d.impact ? keyLabel(d.impact) : null, d.description].filter(Boolean).join(' · ');
    return { icon: meta.icon, color: meta.color, label, title: title || label, href: safeHref(d.url) };
  }
  if (t.kind === 'trend') {
    const label = d.term ? `${d.term} trending` : keyLabel(t.key);
    const src = d.source || '';
    const n = d.mentions || 1;
    const sourceBits = [];
    if (src.includes('reddit') && src.includes('youtube')) {
      sourceBits.push(`${n} top posts and videos this week (Reddit + YouTube)`);
    } else if (src.includes('reddit')) {
      sourceBits.push(`${n} Reddit post${n === 1 ? '' : 's'}${d.score ? `, ${d.score} upvotes` : ''}`);
    } else if (src.includes('youtube')) {
      sourceBits.push(`${n} YouTube video${n === 1 ? '' : 's'}${d.score ? `, ${d.score.toLocaleString()} views` : ''}`);
    }
    if (d.momentum === 'rising') {
      sourceBits.push(`search interest rising${d.interest != null ? ` (${d.interest}/100)` : ''}`);
    }
    const title = [d.note, sourceBits.join(' · '), d.evidence].filter(Boolean).join(' · ');
    return { icon: meta.icon, color: meta.color, label, title: title || label };
  }
  return bare;
}

function TriggerChips({ caseFile, category }) {
  if (!caseFile) return null;
  const chips = (caseFile.resolved_triggers || []).map(describeTrigger).filter(Boolean);
  // Bundle calls are often triggered by the pairing itself, not an external
  // signal - when the rationale talks about products selling together, say so.
  const rationale = String(caseFile.rec?.rationale || '');
  if (category === 'bundle' && /pair|go(es)?\s+(well\s+)?with|together|combo|bundle|alongside/i.test(rationale)) {
    chips.push({
      icon: CATEGORY_META.bundle.icon,
      color: CATEGORY_META.bundle.color,
      label: 'sells-together signal',
      title: 'These products tend to sell together at your register; the pairing itself is the trigger.',
    });
  }
  if (!chips.length) return null;
  return (
    <div className="ec-triggers">
      <span className="ec-triggers-tag">Why this call</span>
      <div className="ec-trigger-chips">
        {chips.map((c, i) => {
          const Icon = c.icon;
          const style = c.color ? { '--chip': c.color } : undefined;
          return c.href ? (
            <a
              key={`${c.label}-${i}`}
              className="ec-trig"
              style={style}
              href={c.href}
              target="_blank"
              rel="noopener noreferrer"
              title={c.title || c.label}
            >
              <Icon size={12} /><span>{c.label}</span><ExternalLink size={10} />
            </a>
          ) : (
            <span key={`${c.label}-${i}`} className="ec-trig" style={style} title={c.title || c.label}>
              <Icon size={12} /><span>{c.label}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ── Sales trace - the register's answer, drawn (GET /:id/sales-trace) ───────
// Emphasis form: the after-period rides the accent hue, the 28-day baseline is
// deliberately the de-emphasis gray (context, not a competing series). Colors
// arrive via CSS variables in EffectivenessCase.css (theme-aware); the hex
// props are the app palette's own values as a fallback only.
function TraceTip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  const p = payload.find((e) => e.value != null) || payload[0];
  if (p.value == null) return null;
  return (
    <div className="est-tip">
      <span className="est-tip-dim">{shortDate(label)}</span>
      <strong>{p.value} unit{p.value === 1 ? '' : 's'}</strong>
      <span className="est-tip-dim">{p.dataKey === 'base' ? 'before the call' : 'after the call'}</span>
    </div>
  );
}

function SalesTraceChart({ state, onRetry }) {
  if (!state) return null; // no fetcher wired (older parent) - nothing to draw
  if (state.status === 'unavailable') return null; // endpoint 404 (older backend)
  if (state.status === 'loading') {
    return <div className="est-skel" role="status" aria-label="Loading the sales chart" />;
  }
  if (state.status === 'error') {
    // Warehouse outage surfaces as a 5xx from the endpoint - a real error
    // state, distinct from "no data" (which is a 200 with empty series).
    return (
      <div className="est-error">
        <AlertTriangle size={13} />
        <span>{state.message || "Couldn't read the register for this chart."}</span>
        {onRetry && (
          <button type="button" className="ec-retry" onClick={onRetry}>
            <RefreshCw size={12} /> Retry
          </button>
        )}
      </div>
    );
  }

  const t = state.data;
  if (!t || !t.data_through || (!t.baseline?.length && !t.after?.length)) {
    return <p className="ec-dim">No register data recorded yet to draw this one.</p>;
  }
  const rows = [
    ...t.baseline.map((p) => ({ day: p.day, base: p.units })),
    ...t.after.map((p) => ({ day: p.day, after: p.units })),
  ];
  const first = rows[0].day;
  const last = rows[rows.length - 1].day;
  const ticks = [...new Set([first, t.rec_date, last])].filter((d) => d >= first && d <= last);
  const rate = Number(t.expected_daily_rate) || 0;
  const rateLabel = rate >= 10 ? String(Math.round(rate)) : String(Math.round(rate * 10) / 10);
  // Validity shading: only the measured days the call was still valid for -
  // clamped to the charted range, never drawn past the data frontier.
  const validEnd = t.valid_through && t.valid_through > t.rec_date
    ? (t.valid_through < last ? t.valid_through : last)
    : null;
  const showValidity = validEnd != null && t.after.length > 0 && validEnd > t.rec_date;

  return (
    <div className="est-wrap">
      <div className="est-legend" aria-hidden="true">
        <span className="est-key est-key-base">28d before</span>
        <span className="est-key est-key-after">after the call</span>
        {rate > 0 && <span className="est-key est-key-exp">expected pace {rateLabel}/day</span>}
        {showValidity && <span className="est-key est-key-valid">valid window</span>}
      </div>
      <ResponsiveContainer width="100%" height={128} className="est-chart">
        <ComposedChart data={rows} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
          {showValidity && (
            <ReferenceArea
              x1={t.rec_date}
              x2={validEnd}
              className="est-valid"
              fill="#8B5CF6"
              fillOpacity={0.07}
              strokeOpacity={0}
            />
          )}
          <XAxis
            dataKey="day"
            ticks={ticks}
            interval={0}
            tickFormatter={shortDate}
            tick={{ fontSize: 10 }}
            tickLine={false}
            axisLine={{ strokeWidth: 1 }}
            height={18}
          />
          <YAxis
            width={26}
            allowDecimals={false}
            tickCount={3}
            domain={[0, 'auto']}
            tick={{ fontSize: 10 }}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip content={<TraceTip />} isAnimationActive={false} />
          <Area
            type="monotone"
            dataKey="base"
            name="before"
            className="est-base"
            stroke="#8e94ad"
            strokeWidth={2}
            fill="#8e94ad"
            fillOpacity={0.08}
            dot={false}
            activeDot={{ r: 3 }}
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="after"
            name="after"
            className="est-after"
            stroke="#8B5CF6"
            strokeWidth={2}
            fill="#8B5CF6"
            fillOpacity={0.12}
            dot={false}
            activeDot={{ r: 3 }}
            isAnimationActive={false}
          />
          {rate > 0 && (
            <ReferenceLine
              y={rate}
              className="est-exp"
              stroke="#8e94ad"
              strokeDasharray="4 3"
              strokeWidth={1}
              ifOverflow="extendDomain"
            />
          )}
          <ReferenceLine x={t.rec_date} className="est-rec" stroke="#8B5CF6" strokeWidth={1} />
        </ComposedChart>
      </ResponsiveContainer>
      {t.skus && t.skus.length > 1 && (
        <p className="ec-dim">Summed across {t.skus.length} products.</p>
      )}
    </div>
  );
}

// ── Your take - the review affordance on the verdict beat ───────────────────
// One thumbs pair per rec (clicking the active thumb retracts). The vote is a
// real input: it nudges this call's score AND flows back to the generator, so
// a miss the owner considers unfair (weather flipped, a supplier fell through)
// gets said out loud instead of silently counting against Botella.
function CaseReview({ verdict, userVote, onVote }) {
  if (!onVote) return null;
  const lead = verdict === 'underperformer'
    ? 'Miss felt unfair? Maybe weather flipped or a supplier fell through. Tell us:'
    : 'Was this call right?';
  const cast = (dir) => onVote(userVote === dir ? 'none' : dir);
  return (
    <div className="ec-review">
      <span className="ec-review-lead">{lead}</span>
      <span className="ec-review-btns">
        <button
          type="button"
          className={`ec-vote ${userVote === 'up' ? 'ec-vote-on-up' : ''}`}
          title={userVote === 'up' ? 'Remove your rating' : 'Good call'}
          aria-pressed={userVote === 'up'}
          onClick={() => cast('up')}
        >
          <ThumbsUp size={13} />
        </button>
        <button
          type="button"
          className={`ec-vote ${userVote === 'down' ? 'ec-vote-on-down' : ''}`}
          title={userVote === 'down' ? 'Remove your rating' : 'Not a fair call'}
          aria-pressed={userVote === 'down'}
          onClick={() => cast('down')}
        >
          <ThumbsDown size={13} />
        </button>
      </span>
      <span className="ec-review-note">
        {userVote
          ? 'Noted. Folded into this call’s score, and Botella learns from it.'
          : 'Your take nudges this call’s score and steers what gets suggested next.'}
      </span>
    </div>
  );
}

// ── The four-beat timeline for one evaluated window ─────────────────────────
function CaseTimeline({ rec, w, caseFile, trace, onTraceRetry, userVote, onVote }) {
  const ev = parseEvidence(w.action_evidence) || {};
  const cat = CATEGORY_META[rec.category] || fallbackCat;
  const actionLabel = ACTION_LABELS[rec.action_type] || String(rec.action_type || '').replace(/_/g, ' ');
  // Case file (Phase 2): real product names and the FULL rationale when the
  // /case endpoint answered; sku list + 180-char gist otherwise (older backend
  // or fetch still in flight) - the beat never waits on it.
  const products = (caseFile?.rec?.products?.length
    ? caseFile.rec.products.map((p) => p.product_name || p.sku)
    : (rec.primary_skus || [])).join(', ');
  const rationale = caseFile?.rec?.rationale || rec.rationale_gist;

  // Beat 2 - YOU ACTED. The card's fulfilment state (039) outranks this one
  // window's action_taken: a card confirmed on the 30-day window reads "You
  // did this" on its 7-day row too, and an owner's claim reads as a claim.
  const topDetector = ev.detector || (Array.isArray(ev.skus) && ev.skus[0] ? ev.skus[0].detector : null);
  const lead = actionLead(w.action_taken, {
    fulfilment: rec.fulfilment_state, claim: ev.claim ?? rec.action_claim ?? null, detector: topDetector,
  });
  const sentences = evidenceToSentences(ev, w.action_taken);
  const ActedIcon = lead.tone === 'yes' ? CheckCircle2 : lead.tone === 'no' ? XCircle : HelpCircle;

  // Beat 3 - SALES ANSWERED.
  const expected = w.expected_units != null ? Number(w.expected_units) : null;
  const lift = w.lift != null ? Number(w.lift) : null;
  const salesLines = [];
  if (expected != null && expected > 0) {
    salesLines.push(
      `${w.units_sold ?? 0} sold vs ${fmtUnits(expected)} expected from its own recent pace`
      + (lift != null ? ` (${lift}x${lift > 5 ? ', an outlier; averages cap it at 5x' : ''})` : '')
      + '.'
    );
  } else if (ev.zero_baseline) {
    salesLines.push(`${w.units_sold ?? 0} sold with no prior sales history: pure upside.`);
  } else {
    salesLines.push(`${w.units_sold ?? 0} sold, but there was no sales history to compare against, not enough to call it.`);
  }
  if (w.units_in_validity != null) {
    salesLines.push(`${w.units_in_validity} of those landed inside the recommendation's valid dates.`);
  }

  // Beat 4 - VERDICT: which components actually weighed in.
  const vMeta = VERDICT_META[w.verdict] || VERDICT_META.neutral;
  const verdictSentence = {
    winner: 'This call worked: sales beat the product’s own baseline.',
    underperformer: 'This call missed: sales fell short of the product’s own pace.',
    neutral: 'Neutral: nothing decisive either way.',
    insufficient_data: 'No verdict yet: not enough measurable data.',
  }[w.verdict] || 'Neutral: nothing decisive either way.';
  const weighed = [];
  if (w.outcome_score != null) weighed.push('how it sold vs its own baseline');
  if (w.action_taken === true) weighed.push('that you acted on it');
  if (w.action_taken === false) weighed.push('that no action was seen');
  if (w.vote_component != null) {
    // Phase-1 backends also ship the raw counts; older ones omit them.
    const counts = (w.vote_ups != null || w.vote_downs != null)
      ? `: ${w.vote_ups || 0} up, ${w.vote_downs || 0} down`
      : '';
    weighed.push(Number(w.vote_component) >= 0.5
      ? `your thumbs-up (a small nudge${counts})`
      : `your thumbs-down (a small nudge${counts})`);
  }

  return (
    <ol className="ec-timeline">
      <li className="ec-beat">
        <span className="ec-beat-icon ec-bi-rec"><Lightbulb size={13} /></span>
        <div className="ec-beat-body">
          <span className="ec-beat-tag">Recommended</span>
          <p className="ec-beat-main">
            {actionLabel} · {cat.label}
            {products ? <> · <strong>{products}</strong></> : null}
          </p>
          {rec.created_at && (
            <p className="ec-dim">{formatLocalDate(rec.created_at, { month: 'short', day: 'numeric', year: 'numeric' })}</p>
          )}
          {rationale && <p className="ec-gist">{rationale}</p>}
          <TriggerChips caseFile={caseFile} category={rec.category} />
        </div>
      </li>

      <li className="ec-beat">
        <span className={`ec-beat-icon ec-bi-${lead.tone}`}><ActedIcon size={13} /></span>
        <div className="ec-beat-body">
          <span className="ec-beat-tag">You acted</span>
          <p className="ec-beat-main">{lead.text}</p>
          {sentences.map((s, i) => <p key={i} className="ec-evidence">{s}</p>)}
        </div>
      </li>

      <li className="ec-beat">
        <span className="ec-beat-icon ec-bi-sales"><TrendingUp size={13} /></span>
        <div className="ec-beat-body">
          <span className="ec-beat-tag">Sales answered</span>
          {salesLines.map((s, i) => (
            <p key={i} className="ec-beat-main">
              {s}
              {i === 0 && lift != null && <InfoTip text={LIFT_TIP} />}
            </p>
          ))}
          <SalesTraceChart state={trace} onRetry={onTraceRetry} />
          {ev.partial && (
            <p className="ec-partial">
              Partial read: covers {ev.partial.covered_days} of {ev.partial.of_days} days so far; it firms up as data arrives.
            </p>
          )}
          {w.data_through && (
            <p className="ec-dim">Measured through {formatLocalDate(w.data_through, { month: 'short', day: 'numeric' })}.</p>
          )}
        </div>
      </li>

      <li className="ec-beat">
        <span className="ec-beat-icon ec-bi-verdict" style={{ '--vc': vMeta.color }}><Award size={13} /></span>
        <div className="ec-beat-body">
          <span className="ec-beat-tag">Verdict</span>
          <p className="ec-beat-main">
            <span className="ec-chip" style={{ '--vc': vMeta.color }}>{vMeta.label}</span>
            {' '}{verdictSentence}
          </p>
          {weighed.length > 0 && <p className="ec-dim">Weighed from {weighed.join(', ')}.</p>}
          {w.revenue_impact != null && (
            <p className="ec-dim">
              Measured at the register: {signedMoney(w.revenue_impact)}
              {w.margin_impact != null && <> · margin {signedMoney(w.margin_impact)}</>}
            </p>
          )}
          {w.final_score != null && (
            <p className="ec-dim">score {Number(w.final_score).toFixed(2)}<InfoTip text={SCORE_TIP} /></p>
          )}
          <CaseReview verdict={w.verdict} userVote={userVote} onVote={onVote} />
        </div>
      </li>
    </ol>
  );
}

// ── The expandable row ──────────────────────────────────────────────────────
// rec: a row from the effectiveness report's top/bottom lists (rec_id,
// category, action_type, primary_skus, rationale_gist, created_at, units_sold,
// expected_units, lift, action_taken, acted_as_recommended, verdict).
// evalState: undefined | {status:'loading'} | {status:'error', message}
//          | {status:'ready', windows:[...]}  - owned/cached by the parent.
// authed: the page's authenticated fetch helper (optional). When present, the
// first expand ALSO lazy-fetches the Phase-2 case file (/:id/case → full
// rationale + trigger chips) and the sales trace (/:id/sales-trace, per
// window). Both degrade silently when the endpoints 404 (older backend).
// userVote: the store's current thumbs on this rec ('up'|'down'|null) - the
// parent owns it (shared with the feedback drawer). onVote(next) casts/flips/
// retracts via POST /:id/vote; absent on older backends → no review UI.
export default function EffectivenessCase({
  rec, expanded, onToggle, evalState, onRetry, reportWindow, authed, userVote, onVote,
}) {
  const meta = VERDICT_META[rec.verdict] || VERDICT_META.neutral;
  const [pickedWindow, setPickedWindow] = useState(null);
  // Phase-2 lazy detail, cached per mounted row for the session:
  // caseState: null | {status:'loading'|'ready'|'unavailable', data?}
  // traceCache: window_days → {status:'loading'|'ready'|'error'|'unavailable', data?, message?}
  const [caseState, setCaseState] = useState(null);
  const [traceCache, setTraceCache] = useState({});

  const windows = evalState?.status === 'ready' ? evalState.windows : [];
  const active = (pickedWindow != null && windows.find((w) => w.window_days === pickedWindow))
    || windows.find((w) => w.window_days === reportWindow)
    || windows[0]
    || null;
  const traceWindow = active?.window_days ?? reportWindow ?? 30;

  const loadCase = useCallback(async () => {
    setCaseState({ status: 'loading' });
    try {
      const res = await authed(`/api/recommendations/${rec.rec_id}/case`);
      if (!res.ok) { setCaseState({ status: 'unavailable' }); return; } // 404 = older backend / holdout - degrade to the gist
      setCaseState({ status: 'ready', data: await res.json() });
    } catch {
      setCaseState({ status: 'unavailable' }); // never block the timeline on the case file
    }
  }, [authed, rec.rec_id]);

  const loadTrace = useCallback(async (w) => {
    setTraceCache((c) => ({ ...c, [w]: { status: 'loading' } }));
    try {
      const res = await authed(`/api/recommendations/${rec.rec_id}/sales-trace?window=${w}`);
      if (res.status === 404) { setTraceCache((c) => ({ ...c, [w]: { status: 'unavailable' } })); return; }
      if (!res.ok) {
        // Warehouse outage arrives as a 5xx envelope - a real error, retryable.
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message || "Couldn't read the register for this chart.");
      }
      const data = await res.json();
      setTraceCache((c) => ({ ...c, [w]: { status: 'ready', data } }));
    } catch (err) {
      setTraceCache((c) => ({ ...c, [w]: { status: 'error', message: err.message } }));
    }
  }, [authed, rec.rec_id]);

  // Fetch on first expand only - nothing loads while the row sits collapsed.
  useEffect(() => {
    if (!expanded || !authed || caseState) return;
    loadCase();
  }, [expanded, authed, caseState, loadCase]);
  useEffect(() => {
    if (!expanded || !authed || traceCache[traceWindow]) return;
    loadTrace(traceWindow);
  }, [expanded, authed, traceWindow, traceCache, loadTrace]);

  const caseFile = caseState?.status === 'ready' ? caseState.data : null;
  const traceState = authed ? (traceCache[traceWindow] || { status: 'loading' }) : null;

  return (
    <div className={`ec-row ${expanded ? 'ec-row-open' : ''}`} style={{ '--vc': meta.color }}>
      <button
        type="button"
        className="ec-summary"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className="ec-chip">{meta.label}</span>
        <ChevronDown size={15} className="ec-chevron" />
        <span className="ec-summary-gist">{rec.rationale_gist}</span>
        <span className="ec-summary-meta">
          {rec.expected_units != null && rec.units_sold != null && (
            <em>{fmtUnits(rec.expected_units)} expected → {rec.units_sold} sold</em>
          )}
          {rec.lift != null && <em>{Number(rec.lift)}x</em>}
          {rec.revenue_impact != null && (
            <em className={`ec-money ${Number(rec.revenue_impact) < 0 ? 'ec-money-neg' : ''}`}>
              {signedMoney(rec.revenue_impact)}
            </em>
          )}
          {rec.acted_as_recommended && (
            <em className="ec-acted"><CheckCircle2 size={12} /> you did this</em>
          )}
          {rec.fulfilment_state === 'claimed' && (
            <em className="ec-claimed" title="You marked this done; your data has not confirmed it yet.">
              <HelpCircle size={12} /> marked done
            </em>
          )}
          {rec.fulfilment_state === 'not_followed' && (
            <em className="ec-notfollowed" title="We checked, and no action showed up in your data before the window closed.">
              <XCircle size={12} /> not followed
            </em>
          )}
          {rec.evidence_partial && (
            <em
              className="ec-partial-mark"
              title={`Partial window: covers ${rec.evidence_partial.covered_days} of ${rec.evidence_partial.of_days} days so far`}
            >partial</em>
          )}
          {rec.created_at && (
            <em className="ec-date">{formatLocalDate(rec.created_at, { month: 'short', day: 'numeric' })}</em>
          )}
        </span>
      </button>

      {expanded && (
        <div className="ec-detail">
          {(!evalState || evalState.status === 'loading') && (
            <div className="ec-wait"><Loader size={14} className="ec-spin" /> Pulling the measurements…</div>
          )}
          {evalState?.status === 'error' && (
            <div className="ec-wait">
              <AlertTriangle size={14} />
              <span>{evalState.message || 'Unable to load the measurement detail.'}</span>
              {onRetry && (
                <button type="button" className="ec-retry" onClick={onRetry}>
                  <RefreshCw size={12} /> Retry
                </button>
              )}
            </div>
          )}
          {evalState?.status === 'ready' && windows.length === 0 && (
            <div className="ec-wait">No measured windows yet; verdicts appear as sales data catches up.</div>
          )}
          {evalState?.status === 'ready' && active && (
            <>
              {windows.length > 1 && (
                <div className="ec-windows" role="group" aria-label="Measured windows">
                  {windows.map((w) => {
                    const partial = Boolean(parseEvidence(w.action_evidence)?.partial);
                    const isActive = w.window_days === active.window_days;
                    return (
                      <button
                        key={w.window_days}
                        type="button"
                        aria-pressed={isActive}
                        className={`ec-window ${isActive ? 'ec-window-active' : ''}`}
                        onClick={() => setPickedWindow(w.window_days)}
                      >
                        {w.window_days}d{partial && <em className="ec-window-partial">partial</em>}
                      </button>
                    );
                  })}
                </div>
              )}
              <CaseTimeline
                rec={rec}
                w={active}
                caseFile={caseFile}
                trace={traceState}
                onTraceRetry={() => loadTrace(traceWindow)}
                userVote={userVote}
                onVote={onVote}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
