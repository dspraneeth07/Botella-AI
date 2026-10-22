// RecommendationsHome.js
// -----------------------------------------------------------------------------
// AI Recommendations - the home (§7.1). The only screen with actions.
//
//   greeting  →  reconciling headline  →  4 key figures  →  ranked cards
//   (Open / Accepted / Completed tabs)  |  sticky right rail
//   (Signals · Effectiveness to date · Your plan)
//
// Frontend-first: reads the existing endpoints and fills the fields the spec
// marks NEW (value, cost, deadline.reason) with transparent (est.) heuristics.
// When the API emits those fields, prefer them (see rec.value / rec.deadline
// handling below).
//
// STATUS IS THE SERVER'S (migration 039). The tabs are Open / Accepted /
// Marked done / Completed, derived from each card's fulfilment_state,
// action_claim and user_vote by utils/recStatus. "Completed" is shown ONLY
// when the data confirmed the card - a purchases-feed row, a matched invoice,
// a stock inflow, a price drop, a catalogue arrival. The owner's "Mark
// complete" is a CLAIM: the card moves to "Marked done - checking your data"
// and stays there until the data confirms it (Completed) or refutes it (Not
// followed). localStorage is only the optimistic overlay between a click and
// the next fetch.
// -----------------------------------------------------------------------------

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Sparkles, Loader, ChevronDown,
  ArrowRight, Check, ClipboardList, Trophy, Package,
  CloudSun, MapPin, CalendarDays, Newspaper, Coins, TrendingUp,
  Hourglass, PackageX, Radar,
} from 'lucide-react';
import { buildSignalDomains, SignalsModal } from './SignalsModal';
import { mainFold } from '../utils/mainFold';
// `counts` is NOT imported: a local const of the same name at line ~217
// shadows it, so the import has been dead and CRA has been warning about it.
import { setStatus, getStatus, withStatus, subscribe, DISMISS_REASONS,
  claimForDismissal, reconcile, applyServerState } from '../utils/recStatus';
import './RecommendationsHome.css';
import { retrievalError } from '../storeagent/retrieval';
import RetrievalNotice from './RetrievalNotice';
import { greetingName } from '../utils/storeIdentity';
import { SHOW_CARD_CONFIDENCE, SHOW_EFFECTIVENESS, SHOW_FOLDED_RECOMMENDATIONS, isDemoAccount } from '../utils/features';
import { coverOf, coverFromEngine, deadlineFromCard, bySku, rateLabel, coverPhrase } from '../utils/cover';
import { takeRecommendationHighlight } from '../utils/crossLink';
import MetricInfo from './MetricInfo';
import { useDialog } from './Dialog';
import { CAN_GENERATE_INSIGHTS, ENV_LABEL, IS_INTERNAL } from '../utils/env';
import {
  cardConfidence, cardProvenance, confidenceNote, constraintNote, evidenceSentence,
  isLive,
  provenanceIsMissing, quantityWithReason,
} from '../utils/recommendationVoice';

/* ── formatters ─────────────────────────────────────────────────────────── */
/* Placeholders for a value the store has not supplied. Two of them, because a
   figure tile has room for a short sentence and a table cell does not - and
   neither is a dash: a dash in a numeric column reads as a value (a minus, a
   range, a zero) rather than as an absence. */
const NO_DATA = 'No data';
const NOT_AVAILABLE = 'n/a';

const fmtMoney = (v) => '$' + Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const fmtNum = (v) => Number(v || 0).toLocaleString('en-US');
const firstSentence = (s) => {
  if (!s) return '';
  const m = String(s).match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : String(s)).trim();
};
const truncate = (s, n) => (!s ? '' : (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s)));

const TYPE_TAG = {
  reorder: 'Reorder', pre_stock: 'Pre-stock', cold_box: 'Cold box', stock_new: 'Stock new',
  bundle: 'Bundle', liquidate: 'Liquidate', markdown: 'Markdown', promote: 'Promote',
  endcap: 'Endcap', win_back: 'Win-back', reprice: 'Reprice',
};
// How many cards the Open tab leads with. The rest fold; nothing is discarded.
// 10, not 5, since the hybrid slate (22 Oct 2026): the engine's reorders now
// share the list with the model's weather, game-day, news, bundle and trending
// cards, and with the fold withheld (SHOW_FOLDED_RECOMMENDATIONS) a limit of
// five hid the second card of every kind. The validator caps the daily slate
// at ten plus four trending cards, so fourteen here shows every admitted card.
const MAIN_CARD_LIMIT = 14;

const VALUE_KIND_LABEL = {
  sales_protected: 'sales protected', projected_sales: 'projected sales',
  projected_margin: 'projected margin', cash_freed: 'cash freed',
};
// Verb for the deadline line, by action type (A7): Order by / Move by /
// Start by / Reassess by - never a generic "Set by".
const DEADLINE_VERB = {
  reorder: 'Order by', pre_stock: 'Order by', stock_new: 'Start by',
  markdown: 'Move by', liquidate: 'Move by', promote: 'Start by',
  endcap: 'Start by', cold_box: 'Start by', bundle: 'Start by',
  win_back: 'Reach out by', reprice: 'Reassess by',
};

/* ── Confidence, in words, from the CALIBRATED value only (sheet 18) ─────────
 *
 * Returns null - not a default band - when a card carries no calibrated
 * confidence. A card that made no confidence claim must not be given one by
 * the renderer; the caller shows nothing instead.
 */
const CONF_BANDS = [
  [0.85, 4, 'Very confident'],
  [0.65, 3, 'Confident'],
  [0.45, 2, 'Fairly confident'],
  [0.25, 1, 'Not very confident'],
  [0.0, 1, 'A long shot'],
];
function confidenceDisplay(rec) {
  const word = cardConfidence(rec);
  if (!word) return null;
  const value = Number(rec.calibrated_confidence);
  const band = CONF_BANDS.find(([floor]) => value >= floor);
  return { seg: band ? band[1] : 1, word };
}

/* ── There is no value heuristic any more, and that is deliberate ──────────
 *
 * This file used to carry `avgPrice`, `estUnits` and `valueOf` - a fallback
 * that invented a dollar figure when the server sent none. `estUnits` worked
 * by regex-scraping the first number out of the rationale PROSE; `valueOf`
 * multiplied it by an average price and a flat 25% or 50%.
 *
 * It produced, on a live card, "$2,470 in projected sales over 30 days" for a
 * bottle that had sold nothing in 90 open days - directly above its own
 * rationale saying it sells about one every twelve weeks.
 *
 * The money now comes from the server, bounded by MEASURED demand
 * (recommendationGateService.estimateProfit), or it does not come at all.
 * `groundedValue` returns `unmeasured` and the card prints no figure. An
 * absent number is a smaller problem than a confident wrong one.
 */
/* ── deadline (§4.4) ─────────────────────────────────────────────────────── */

function deadlineOf(rec) {
  const iso = (rec.deadline && rec.deadline.date) || rec.valid_through || null;
  const reason = (rec.deadline && rec.deadline.reason) || null;
  let proximity = 'later'; let daysLeft = null;
  if (iso) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const d = new Date(iso + 'T00:00:00');
    daysLeft = Math.round((d - today) / 86400000);
    // A7: a passed deadline reads as overdue, not just "later".
    proximity = daysLeft < 0 ? 'overdue' : daysLeft <= 3 ? 'urgent' : daysLeft <= 7 ? 'soon' : 'later';
  }
  return { iso, reason, proximity, daysLeft };
}
const fmtDate = (iso) => (iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : null);

/* ── Sparkline (§6.2) - real series only; renders nothing without data ─────── */
function Sparkline({ series, kind = 'line', tone = 'ac' }) {
  const pts = (series || []).filter((n) => Number.isFinite(n));
  if (pts.length < 3) return null; // never fabricate a trend
  const W = 96, H = 30, n = pts.length;
  const min = Math.min(...pts), max = Math.max(...pts), span = max - min || 1;
  const x = (i) => (i / (n - 1)) * W;
  const y = (v) => H - 2 - ((v - min) / span) * (H - 4);
  if (kind === 'bars') {
    const bw = Math.max(1.5, (W / n) * 0.62);
    return (
      <svg className="rh-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        {pts.map((v, i) => (
          <rect key={i} x={x(i) - bw / 2} y={y(v)} width={bw} height={Math.max(1, H - 2 - y(v))} rx="1" className={`rh-spark-bar rh-spark-${tone}`} />
        ))}
      </svg>
    );
  }
  const d = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${d} L${W},${H} L0,${H} Z`;
  return (
    <svg className="rh-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={area} className={`rh-spark-area rh-spark-${tone}`} />
      <path d={d} className={`rh-spark-line rh-spark-${tone}`} fill="none" />
    </svg>
  );
}
const median = (arr) => { const a = (arr || []).filter(Number.isFinite).slice().sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };

/* ── evidence chips (§6.3) ───────────────────────────────────────────────────
   PER RECOMMENDATION, from that rec's OWN signals_cited - never the global
   signal set (that made every card show the same chips). Each cited key is
   classified into a source domain the same way the backend resolver does:
   weather keys → weather, *_home_game → sports, event_* → events, trend_* →
   social, plus a key→domain map built from the run's signal_snapshot for
   holidays/events/news/social entries carrying a .key. */
const SOURCE_ICON = { your_sales: Package, events: MapPin, weather: CloudSun, holiday: CalendarDays, sports: Trophy, social: TrendingUp, news: Newspaper, comparable: Trophy };
const WEATHER_KEYS = new Set(['heat_advisory', 'cold_snap', 'severe_weather']);

// key (lowercased) → domain, from the snapshot entries that carry a .key.
function buildKeyDomain(snapshot) {
  const m = {};
  const s = snapshot || {};
  const put = (arr, dom) => (arr || []).forEach((e) => { const k = (e && e.key ? String(e.key) : '').toLowerCase(); if (k) m[k] = dom; });
  put(s.holidays, 'holiday'); put(s.events, 'events'); put(s.news, 'news');
  put(s.social, 'social'); put(s.sports, 'sports');
  return m;
}

function domainOfKey(k, keyDomain) {
  if (WEATHER_KEYS.has(k) || k.includes('weather') || k.includes('heat') || k.includes('cold_snap')) return 'weather';
  if (k.endsWith('_home_game') || k.startsWith('sport')) return 'sports';
  if (k.startsWith('event_') || k === 'events' || k.includes('concert') || k.includes('festival')) return 'events';
  if (k.startsWith('trend_') || k.includes('social')) return 'social';
  if (k.startsWith('news')) return 'news';
  if (k.startsWith('holiday') || k.endsWith('_day')) return 'holiday';
  return keyDomain[k] || null; // fall back to the snapshot-derived map
}

// A8: turn an internal cited key into a human display name, resolved against
// the run snapshot ("event_buddy_guy_moody" → "Buddy Guy 90 · ACL Live · Fri").
function humanizeKey(k) {
  return String(k || '').replace(/^event_/, '').replace(/_home_game$/, ' home game').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
function resolveSignalLabel(rawKey, snapshot) {
  const k = String(rawKey || '').toLowerCase();
  const s = snapshot || {};
  if (WEATHER_KEYS.has(k) || k.includes('heat') || k.includes('cold_snap') || k.includes('weather')) {
    const w = s.weather; const t = w && (w.high_f ?? w.current_f);
    return t != null ? `Weather · ${Math.round(t)}°` : 'Weather';
  }
  if (k.includes('understock')) return 'Understock';
  if (k.includes('overstock')) return 'Overstock';
  const byKey = (arr) => (arr || []).find((e) => e && String(e.key || '').toLowerCase() === k);
  const e = byKey(s.events) || byKey(s.holidays) || byKey(s.news) || byKey(s.social) || byKey(s.sports);
  if (e) {
    const parts = [e.title || e.name || e.headline || e.term || humanizeKey(k)];
    const venue = e.venue && (typeof e.venue === 'string' ? e.venue : e.venue.name);
    if (venue) parts.push(venue);
    const when = e.label || (e.when && e.when.label) || (e.date ? fmtDate(String(e.date).slice(0, 10)) : null);
    if (when) parts.push(when);
    return parts.filter(Boolean).join(' · ');
  }
  return humanizeKey(k);
}

function evidenceFor(rec, keyDomain) {
  const ev = [{ source: 'your_sales', label: 'Your sales' }];
  const counts = { events: 0, weather: 0, holiday: 0, sports: 0, social: 0, news: 0 };
  (rec.signals_cited || []).forEach((raw) => {
    const k = String(typeof raw === 'string' ? raw : (raw && (raw.key || raw.kind)) || '').toLowerCase();
    if (!k) return;
    const dom = domainOfKey(k, keyDomain);
    if (dom && counts[dom] != null) counts[dom] += 1;
  });
  const LABEL = {
    events: `Events ×${counts.events}`, weather: 'Weather', holiday: 'Holiday',
    sports: `Sports ×${counts.sports}`, social: 'Trending', news: 'News',
  };
  // Order matters: strongest evidence first, capped so the row stays one line.
  ['events', 'weather', 'holiday', 'sports', 'social', 'news'].forEach((dom) => {
    if (counts[dom] > 0) ev.push({ source: dom === 'holiday' ? 'holiday' : dom, label: LABEL[dom] });
  });
  return ev.slice(0, 5);
}

/* =============================================================================
   PAGE
   ============================================================================= */
export default function RecommendationsHome({ authToken, apiUrl, onNavigate, onAnalyse }) {
  const dialog = useDialog();
  // Internal-only: trigger the recommendation run that normally happens
  // overnight, so a tester does not have to wait a day to see the effect of a
  // data change. Stripped from production builds (utils/env.js).
  const [generating, setGenerating] = useState(false);
  const [dash, setDash] = useState(null);
  const [recsRaw, setRecsRaw] = useState([]);
  const [gate, setGate] = useState(null);
  const [run, setRun] = useState(null);
  const [eff, setEff] = useState(null);
  const [buying, setBuying] = useState(null); // A5: same source as the Purchasing tiles
  // Arrived from "N recommendations →" on a report screen. See utils/crossLink.
  const [fromReport] = useState(() => takeRecommendationHighlight());
  const hiIds = useMemo(() => new Set((fromReport?.ids || []).map(String)), [fromReport]);
  const firstHiRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('open');
  // A failed /latest is an ERROR, not an empty list (039). It used to become
  // [] and the screen read "No open recommendations. Nicely run." over a dead
  // endpoint - eighty-two stores read exactly that when the wrong server was
  // on port 3000. The classified error renders a RetrievalNotice instead.
  const [recsError, setRecsError] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [dismissing, setDismissing] = useState(null); // rec id showing reason menu
  const [showFolded, setShowFolded] = useState(false); // A3 collapsed low-value group
  const [signalsOpen, setSignalsOpen] = useState(false);
  const [typeFilter, setTypeFilter] = useState('all'); // §10 type filter (replaces priority filter)
  // ONE open menu rather than a boolean per dropdown. Two independent
  // booleans let both menus stand open at once (and neither closed when you
  // clicked away), which is what put two overlapping panels on the screen.
  // Modelling it as "which menu is open, if any" makes that state
  // unrepresentable instead of merely discouraged.
  const [openMenu, setOpenMenu] = useState(null);   // 'type' | null
  const menuBarRef = useRef(null);
  // There is no sort control any more. "Top priority" ordered by soonest
  // deadline, which put an $85 promote above two $2,000 reorders purely because
  // its start date was five days earlier - the top of the list stopped being
  // the most valuable thing on it. One order now: money, descending.

  // Dismiss on a click anywhere outside the control, and on Escape. Bound only
  // while a menu is actually open, so there is no listener on the document for
  // the 99% of the time nothing is showing. `pointerdown` rather than `click`:
  // it fires before focus moves, so the menu is gone by the time whatever was
  // clicked underneath reacts.
  useEffect(() => {
    if (!openMenu) return undefined;
    const onDown = (e) => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target)) setOpenMenu(null);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpenMenu(null); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [openMenu]);
  const [statusVer, setStatusVer] = useState(0); // bumps on every status change

  const base = useMemo(() => (apiUrl || '').replace(/\/api\/?$/, ''), [apiUrl]);
  const headers = useMemo(() => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}`, 'ngrok-skip-browser-warning': 'true' }), [authToken]);

  const fetchAll = useCallback(async () => {
    setLoading(true); setError(null);
    const get = async (p) => {
      const res = await fetch(`${base}${p}`, { headers });
      if (res.status === 401) { localStorage.removeItem('botella_token'); window.location.href = '/login'; throw new Error('unauth'); }
      if (!res.ok) throw await retrievalError(res, `${p} ${res.status}`);
      return res.json();
    };
    // The effectiveness call feeds one consumer, the tile below. With the tile
    // withdrawn it is a round trip on every home load whose result is dropped,
    // so skip it rather than fetch and discard. Resolving to null keeps the
    // destructure and setEff() below unchanged when the flag comes back on.
    const [d, l, e, b] = await Promise.allSettled([
      get('/api/dashboard'),
      get('/api/recommendations/latest'),
      SHOW_EFFECTIVENESS ? get('/api/recommendations/effectiveness?window=30') : Promise.resolve(null),
      get('/api/storeagent/buying'),
    ]);
    if (d.status === 'fulfilled') setDash(d.value);
    else { // Rethrow the CLASSIFIED rejection rather than a fresh sentence: the
      // wrapping is what threw away "this store has no such tables" and
      // left only a message beside a Retry button that could never work.
      setError(d.reason); setLoading(false); return; }
    if (l.status === 'fulfilled') {
      const cards = l.value?.recommendations || [];
      // THE SERVER OVERRIDES THE OVERLAY on every fetch: each card's
      // fulfilment_state / action_claim / user_vote becomes its status, and
      // whatever this browser believed is replaced (utils/recStatus).
      reconcile(cards);
      setRecsRaw(cards);
      setRecsError(null);
    } else {
      setRecsRaw([]);
      setRecsError(l.reason);
    }
    // The gate block, so the screen can agree with the server about which
    // cards it is allowed to show. The server already withholds under
    // enforcement; this is the second check, not the only one.
    setGate(l.status === 'fulfilled' ? (l.value?.gate || null) : null);
    setRun(l.status === 'fulfilled' ? (l.value?.run || null) : null);
    setEff(e.status === 'fulfilled' ? e.value : null);
    setBuying(b.status === 'fulfilled' ? b.value : null); // A5: tiles reconcile with Purchasing
    setLoading(false);
  }, [base, headers]);

  useEffect(() => { if (authToken) fetchAll().catch(() => {}); }, [authToken, fetchAll]);
  useEffect(() => subscribe(() => setStatusVer((n) => n + 1)), []);
  // A11: publish the Open count so the sidebar nav badge can show it.
  const openCount = useMemo(() => withStatus(recsRaw).filter((r) => (r._status || 'open') === 'open').length, [recsRaw, statusVer]);
  useEffect(() => { try { localStorage.setItem('botella_open_rec_count', String(openCount)); window.dispatchEvent(new Event('botella-open-count')); } catch { /* no-op */ } }, [openCount]);

  // Bring the first marked card into view once the cards exist. Depends on
  // recsRaw, not mount: the list is empty on the first paint.
  useEffect(() => {
    if (hiIds.size && firstHiRef.current) {
      firstHiRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [hiIds, recsRaw]);

  const snapshot = run?.signal_snapshot || null;
  const domainCounts = useMemo(() => {
    const out = { events: 0, weather: 0, holidays: 0, sports: 0, news: 0, social: 0 };
    buildSignalDomains(snapshot).domains.forEach((dm) => { out[dm.id] = dm.items.length; });
    return out;
  }, [snapshot]);
  // key → domain map for per-card evidence chips (A2 fix).
  const keyDomain = useMemo(() => buildKeyDomain(snapshot), [snapshot]);

  // The buy list, indexed by SKU. This is the SAME payload the Purchasing tab
  // renders, so anything a card derives from it agrees with that table by
  // construction rather than by luck.
  const skuFacts = useMemo(
    () => bySku([...(buying?.buying?.buy_list || []), ...(buying?.lost_sales?.items || [])]),
    [buying],
  );

  // Aggregate the real stock position across a recommendation's products.
  // Returns null when NONE of them appear in the buy list, which is the signal
  // that we have no measured velocity for this card and must not imply one.
  const factsFor = useCallback((rec) => {
    const skus = (rec.primary_skus || []).map(String);
    const rows = skus.map((s) => skuFacts.get(s)).filter(Boolean);

    // THE ENGINE'S OWN RATE WINS, where it sent one.
    //
    // The buy list carries a 90-DAY average. For a product whose sales have
    // just collapsed that is not a current rate: Ironroot Industrial Luciano
    // sold 221 units in 90 days and NINE in the last 28, and the card read
    // "selling about 17 a week ... gone within a day" off the first figure.
    // The engine chose it on the second - a 28-day window over open days,
    // shrunk toward the SKU's own long run - and that is the number the card
    // should quote, because it is the number the decision was taken on.
    //
    // Falls back to the buy list when the engine sent nothing, which is every
    // row the LLM path produced and every estate that has not run migration
    // 022. The fallback is the old behaviour exactly.
    //
    // THE ARITHMETIC IS NOT HERE. This branch used to carry its own copy -
    // `Math.round(daysCover - 7)` and a hand-rolled date string - while
    // utils/cover.js, which the Purchasing tab imports, used a lead of three.
    // Weber Ranch 1L, 19 October 2026: "Order by Mon, Oct 19" on the card and
    // "Thu, Oct 22" on the row for the same bottle. `coverFromEngine` is the
    // one implementation; the lead is the card's own where the engine sent one
    // (measured for the vendor), the shared LEAD_DAYS otherwise. The deadline
    // the card PRINTS prefers the server's stored `order_by` anyway (see
    // deadlineFor); this cover is for the sentence and the value.
    const engineRate = Number(rec.engine_daily_rate);
    if (Number.isFinite(engineRate) && engineRate > 0) {
      const onHandEng = Number.isFinite(Number(rec.engine_on_hand))
        ? Number(rec.engine_on_hand)
        : rows.reduce((n, r) => n + (Number(r.on_hand) || 0), 0);
      const cover = coverFromEngine({
        daily: engineRate,
        onHand: onHandEng,
        daysCover: rec.engine_days_cover,
        leadDays: rec.lead_time_days,
      });
      const prices = (rec.products || []).map((x) => Number(x.price || 0)).filter(Boolean);
      return {
        rows,
        onHand: onHandEng,
        units90: rows.reduce((n, r) => n + (Number(r.units_90) || 0), 0),
        price: prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : 0,
        cover: cover ? { ...cover, measured: 'engine' } : null,
      };
    }

    if (!rows.length) return null;
    const onHand = rows.reduce((n, r) => n + (Number(r.on_hand) || 0), 0);
    const units90 = rows.reduce((n, r) => n + (Number(r.units_90) || 0), 0);
    const c = coverOf({ on_hand: onHand, units_90: units90 });
    const prices = (rec.products || []).map((p) => Number(p.price || 0)).filter(Boolean);
    const price = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
    return { rows, onHand, units90, price, cover: c };
  }, [skuFacts]);

  // A3: sanity-cap the heuristic value. Until the engine sends rec.value, a
  // reorder's "units × price" can read as a whole month of revenue on one SKU.
  //
  // `kpis.revenue` is the LATEST DAY's takings, not the month's - routes/
  // dashboard.js builds it from the most recent completed sales day. Reading it
  // as monthly made the cap `max(2000, oneDay * 0.2)`, and on a ~$6k day that is
  // 2000 every time: four of ten cards printed exactly "$2,000", which is what
  // a clamped constant looks like when it reaches a customer. Sum the daily
  // trend instead, which is the figure the cap was always meant to be 20% of.
  const monthlyRev = useMemo(() => {
    const t = (dash?.revenueTrend || []).map((r) => Number(r.revenue) || 0).filter((n) => n > 0);
    if (!t.length) return 0;
    const last30 = t.slice(-30);
    // Scale up when the series is shorter than a month rather than under-capping.
    return last30.reduce((a, b) => a + b, 0) * (30 / last30.length);
  }, [dash]);
  const perCap = monthlyRev > 0 ? monthlyRev * 0.2 : Infinity;
  const LOW_VALUE_FLOOR = 50;

  // Value, preferring MEASURED velocity over the model's quantity_hint.
  // A hint is a sentence the model wrote; units_90 is what the register rang up.
  const groundedValue = useCallback((rec) => {
    if (rec.value && rec.value.amount != null) return rec.value;
    const f = factsFor(rec);
    const A = rec.action_type;
    const stockDriven = ['reorder', 'pre_stock', 'cold_box', 'endcap', 'bundle', 'promote'].includes(A);
    if (stockDriven && f && f.price > 0) {
      if (!f.cover) {
        // In the catalogue, never sold. There is no honest 30-day projection for
        // a bottle with no demand behind it - an endcap for one of these was
        // being valued at the cap itself. Rank it last and print nothing.
        return { amount: 0, kind: 'unmeasured', horizon_days: 30, estimate: true, unmeasured: true };
      }
      const units30 = f.cover.daily * 30;
      const gross = units30 * f.price;
      const amount = ['promote', 'stock_new'].includes(A) ? gross * 0.25 : gross;
      return {
        amount: Math.round(amount),
        kind: A === 'reorder' ? 'sales_protected' : ['promote', 'stock_new'].includes(A) ? 'projected_margin' : 'projected_sales',
        horizon_days: 30, estimate: true, range: true, measured: true,
      };
    }
    // NO FALLBACK TO AN INVENTED FIGURE.
    //
    // This used to `return valueOf(rec)` - a heuristic that multiplied the
    // FIRST NUMBER SCRAPED OUT OF THE RATIONALE SENTENCE by an average price
    // and a flat 25% or 50%. On a live Bethany card it produced "$2,470 in
    // projected sales over 30 days" for a Bruichladdich Octomore that sold
    // ZERO in 90 open days - on the same card whose own text said it sells
    // about one every twelve weeks. The number was the shelf value wearing a
    // forecast's label.
    //
    // A card we cannot value honestly now says so and ranks last. The server
    // sends `rec.value` when it can compute one (bounded by measured demand,
    // see recommendationGateService.estimateProfit); when it cannot, neither
    // can we, and printing a number anyway is the single fastest way to lose
    // an owner's trust in every other card on the screen.
    return { amount: 0, kind: 'unmeasured', horizon_days: 30, estimate: true, unmeasured: true };
  }, [factsFor]);

  const amountOf = useCallback((r) => Math.min(groundedValue(r).amount || 0, perCap), [perCap, groundedValue]);
  const v30 = useCallback((r) => { const v = groundedValue(r); return Math.min(v.amount || 0, perCap) * (30 / Math.max(1, v.horizon_days || 30)); }, [perCap, groundedValue]);
  // THE ORDER IS EXPECTED MARGIN, THEN THE ENGINE'S RANK. There is no
  // confidence tiebreak any more. The one this replaced read
  // `calibrated_confidence`, a field no card the API returns carries, so it
  // was inert in practice - but as code it said "then by confidence", and the
  // reviewer's measurement (features.js, SHOW_CARD_CONFIDENCE) is that the
  // figure sorts cards the wrong way round on the forward test. The engine's
  // rank is already expected net margin per dollar (slate.compose) over the
  // deterministic tiers, so falling through to it keeps the order on money.

  // The "Why" line for a stock recommendation, written from the register rather
  // than from the model.
  //
  // The model's prose was contradicting the card it sat on and the Purchasing
  // table next door: "about 22 bottles a week ... empty by September 20" for a
  // bottle selling 2.2 a week with 83 days of cover, beside an order-by date
  // computed from the real figure. Both numbers cannot be right, and the wrong
  // one was the one a store owner would act on.
  //
  // So the velocity, the stock on hand and the timing come from the buy list.
  // The model keeps the half it is actually good at - the reason this product
  // matters right now, which is the trailing clause of its own sentence.
  const whyFor = useCallback((rec) => {
    const fallback = firstSentence(rec.rationale) || 'Signal-aware stocking recommendation.';
    const f = factsFor(rec);
    if (!['reorder', 'pre_stock'].includes(rec.action_type) || !f || !f.cover) return fallback;

    const name = (rec.products && rec.products[0] && rec.products[0].product_name)
      || (rec.primary_skus && rec.primary_skus[0]) || 'This product';
    const rate = rateLabel(f.cover.weekly);
    const phrase = coverPhrase(f.cover.daysCover);
    const stock = f.onHand === 0
      ? 'none on hand'
      : `${f.onHand} on hand`;
    const head = rate
      ? `${name} is selling about ${rate} and you have ${stock} - ${phrase}.`
      : `${name}: ${stock}.`;

    // Keep the model's reasoning ONLY where it is not making a numeric claim of
    // its own. A sentence carrying digits is the one that contradicted the
    // table, so it is dropped rather than reconciled.
    const why = firstSentence(rec.rationale) || '';
    const tail = why && !/\d/.test(why) && why.length < 160 ? ` ${why}` : '';
    return `${head}${tail}`;
  }, [factsFor]);

  // The deadline the card prints. THE SERVER'S date first: the engine computes
  // `order_by` once, with the lead time the card quotes, and stores it
  // (migration 042), so Purchasing can show the same day for the same SKU -
  // the two screens agree because they read one number. Measured cover next,
  // for a card from before 042. The model's `valid_through` only where we have
  // no velocity to compute from - see utils/cover.js for why the model's own
  // date is not trusted.
  const deadlineFor = useCallback((rec) => {
    if (['reorder', 'pre_stock'].includes(rec.action_type)) {
      const stored = deadlineFromCard(rec);
      if (stored) {
        return {
          iso: stored.iso,
          reason: null,
          daysLeft: stored.dueInDays,
          proximity: stored.dueInDays <= 3 ? 'urgent' : stored.dueInDays <= 7 ? 'soon' : 'later',
          measured: true,
          source: 'engine',
        };
      }
      const f = factsFor(rec);
      if (f && f.cover) {
        const { dueInDays, iso } = f.cover;
        return {
          iso,
          reason: null,
          daysLeft: dueInDays,
          proximity: dueInDays <= 3 ? 'urgent' : dueInDays <= 7 ? 'soon' : 'later',
          measured: true,
          source: 'cover',
        };
      }
    }
    return deadlineOf(rec);
  }, [factsFor]);

  // statusVer is a dep: status lives in localStorage, so a change there (accept,
  // dismiss, complete) must re-derive these lists even though recsRaw is unchanged.
  // A4: ONE default order - highest estimated value first, confidence as tiebreak.
  // `isLive` HAS A CALLER NOW, and only one that is safe to have.
  //
  // It had none, which made it decoration. But applying it unconditionally
  // would empty the screen: in shadow mode - the current default - every card
  // carries gate_state 'shadow', so "show only live cards" means "show
  // nothing". That is the outage the gate's own comments warn about, and it is
  // why this is conditioned on the server saying enforcement is ON.
  //
  // Under enforcement the server has already withheld the cards it should; this
  // agrees with it rather than replacing it. Two checks that can only ever
  // remove the same cards is defence in depth. A check that could remove cards
  // the server kept would be a second opinion, which is the thing to avoid.
  const recs = useMemo(
    () => withStatus(recsRaw)
      .filter((r) => (gate && gate.enforced ? isLive(r) : true))
      .slice().sort((a, b) => (amountOf(b) - amountOf(a)) || ((a.rank || 99) - (b.rank || 99))),
    [recsRaw, statusVer, amountOf, gate],
  );
  const byStatus = useMemo(() => ({
    open: recs.filter((r) => r._status === 'open'),
    accepted: recs.filter((r) => r._status === 'accepted'),
    // The owner's word, awaiting the data's (039).
    claimed: recs.filter((r) => r._status === 'claimed'),
    // The data's word: confirmed only.
    completed: recs.filter((r) => r._status === 'completed'),
  }), [recs]);
  // A3: open cards worth >= floor AND inside the top MAIN_CARD_LIMIT by value;
  // everything else folds into the one collapsed group below.
  //
  // Ten cards was too many to triage, especially when four of them carried the
  // same capped figure. byStatus.open is already sorted by value, so the cut is
  // just a slice - the rest are one click away, not gone.
  const openMain = useMemo(() => {
    // THE FLOOR SHORTENS A LONG LIST. IT MUST NOT EMPTY A SHORT ONE.
    //
    // Observed on Bethany, 29 September 2026: the header read "3 open
    // recommendations" and the panel underneath it read "No open
    // recommendations. Nicely run." - at the same time, on the same screen.
    // All three cards valued at $0, so none cleared the floor, so every one of
    // them folded into "3 more recommendations - lower estimated value" and
    // the main list rendered its empty state.
    //
    // A $0 estimate is mostly not a worthless card, it is an UNVALUED one:
    // `groundedValue` returns `unmeasured` rather than invent a figure, and
    // markdown is not in its stockDriven list at all. Telling an owner they
    // have nothing to do while holding three things for them to do is worse
    // than showing a card without a dollar figure on it.
    //
    // So: when nothing clears the floor, fall back to ranked order. The list
    // is capped either way, so this cannot flood the screen.
    const cleared = byStatus.open.filter((r) => amountOf(r) >= LOW_VALUE_FLOOR);
    // THE FLOOR MUST NOT HIDE A WHOLE ACTION TYPE EITHER. A markdown, bundle,
    // stock_new, pre_stock or cold_box card is valued at $0 here - not because
    // it is worthless but because `groundedValue` will not invent a figure
    // for it - so it never clears the floor, and the reservation below could
    // not reach it from `cleared` alone. Reserved types are drawn from every
    // open card; the floor still shortens the reorder-heavy tail.
    const belowFloorTypes = byStatus.open.filter((r) => r.action_type && r.action_type !== 'reorder'
      && !cleared.some((c) => c.action_type === r.action_type));
    const eligible = cleared.length ? [...cleared, ...belowFloorTypes] : byStatus.open;
    // SEATS BY VALUE, ONE PER ACTION TYPE GUARANTEED (utils/mainFold.js).
    //
    // "Do not show me only reorder." The pure value cut put five reorders in
    // the fold every morning and sank every markdown, bundle, stock_new,
    // pre_stock and cold_box card - all $0 to the browser - into "lower
    // estimated value". Each distinct non-reorder type present in the slate
    // now gets its highest-ranked card a seat, taken from the lowest-value
    // reorder; the total stays at MAIN_CARD_LIMIT and the list is still read
    // in value order.
    if (!hiIds.size) return mainFold(eligible, MAIN_CARD_LIMIT);
    // Linked-to cards lead, and they are pulled from ALL open recommendations
    // rather than from the ones clearing the value floor.
    //
    // Drawing them from `eligible` was the earlier bug: a recommendation worth
    // less than the floor sat in the folded group, so following "5
    // recommendations →" from Market Comparison could still land you on a list
    // showing three of the five - the two cheap ones stayed folded and marked
    // nothing. A card the reader explicitly asked to see outranks its own
    // estimated value; the floor exists to keep the list short, not to overrule
    // a direct request.
    const hit = byStatus.open.filter((r) => hiIds.has(String(r.id)));
    const rest = eligible.filter((r) => !hiIds.has(String(r.id)));
    return [...hit, ...mainFold(rest, Math.max(0, MAIN_CARD_LIMIT - hit.length))];
  }, [byStatus.open, amountOf, hiIds]);
  const openFolded = useMemo(() => {
    const keep = new Set(openMain.map((r) => r.id));
    return byStatus.open.filter((r) => !keep.has(r.id));
  }, [byStatus.open, openMain]);

  // WHAT THE OPEN TAB COUNTS IS WHAT THE OPEN TAB SHOWS. With the folded group
  // withdrawn (SHOW_FOLDED_RECOMMENDATIONS, utils/features.js) the cards that
  // would have folded are not on the screen at all, and a headline reading
  // "8 open recommendations" over a list of five is the contradiction the
  // 29 September fix removed in the other direction. So the count, the tab
  // badge, the headline value and the this-week figure all read from the
  // visible set when the fold is hidden, and from every open card when it is
  // shown (where the folded group accounts for the difference).
  const openVisible = SHOW_FOLDED_RECOMMENDATIONS ? byStatus.open : openMain;
  const c = {
    open: openVisible.length, accepted: byStatus.accepted.length,
    claimed: byStatus.claimed.length, completed: byStatus.completed.length,
  };

  // Headline: sum of OPEN values normalised to 30 days, capped - reconciles with
  // the list (A3).
  const openValue30 = useMemo(() => openVisible.reduce((s, r) => s + v30(r), 0), [openVisible, v30]);
  const needDecisionThisWeek = useMemo(
    () => openVisible.filter((r) => { const dl = deadlineFor(r); return dl.daysLeft != null && dl.daysLeft <= 7; }).length,
    [openVisible, deadlineFor],
  );

  // This API reports failures as { error: { code, message } }, so reading
  // `body.error` as a string produced the literal text "[object Object]" in the
  // dialog - which told the person nothing at all. Take the message, and keep
  // the code, because the code is the part that says WHERE it broke.
  const describeApiError = (body, status) => {
    const e = body && body.error;
    if (e && typeof e === 'object') {
      return [e.message, e.code ? `(${e.code})` : ''].filter(Boolean).join(' ');
    }
    if (typeof e === 'string' && e) return e;
    if (typeof body?.message === 'string' && body.message) return body.message;
    return `The server returned HTTP ${status}.`;
  };

  const generateInsights = async () => {
    if (generating) return;               // the run is expensive; one at a time
    setGenerating(true);
    try {
      const r = await fetch(`${base}/api/recommendations/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}`, 'ngrok-skip-browser-warning': 'true' },
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.ok === false) throw new Error(describeApiError(body, r.status));
      await fetchAll();
      const n = body.count != null ? body.count : (body.recommendations != null ? body.recommendations : null);
      await dialog.alert({
        title: 'Insights regenerated',
        message: n != null
          ? `The run finished and produced ${n} recommendation${n === 1 ? '' : 's'}. The screen below is showing the new set.`
          : 'The run finished. The screen below is showing the new set.',
        confirmLabel: 'Got it',
      });
    } catch (e) {
      // Name the layer, and only offer advice that fits it. These failures look
      // alike in a dialog and mean entirely different things:
      //
      //   REC_SERVICE_TIMEOUT   the service ran and was still working. Telling
      //                         someone to check whether it is running is wrong,
      //                         and they will find it running and be no wiser.
      //   node_api_error        the run started; the service could not call BACK
      //                         into this API. The far end is fine.
      //   UNREACHABLE / HTTP_*  we never got a usable answer out of it.
      const msg = e.message || '';
      const timedOut = /TIMEOUT/i.test(msg);
      const callback = /node_api_error/i.test(msg);
      const unreachable = !timedOut && !callback && /UNREACHABLE|HTTP_4\d\d|HTTP_5\d\d|REC_SERVICE/i.test(msg);

      const advice = timedOut
        ? ' Nothing is broken - a run legitimately takes over a minute. Try again;'
          + ' if it keeps timing out, raise REC_SERVICE_TIMEOUT_MS in backend/.env.'
        : callback
          ? ' The service started the run but could not call back into this API.'
            + ' Check NODE_API_BASE_URL in the Python service\'s .env - it must reach'
            + ' this backend, and host.docker.internal only works inside a container.'
          : unreachable
            ? ' This usually means the recommendation service is not reachable at'
              + ' REC_SERVICE_URL - check that it is running and that nothing else has'
              + ' taken its port. Run: npm run doctor --prefix backend'
            : '';

      await dialog.alert({
        title: 'Could not generate insights',
        message: `The recommendation run did not complete. ${msg}`.trim() + advice,
        tone: 'danger',
      });
    } finally {
      setGenerating(false);
    }
  };

  // ── Owner actions reach the SERVER, not just this browser ────────────────
  //
  // Accept and Dismiss used to write to localStorage and stop there. That made
  // every owner decision invisible to the thing that needs it most: the
  // evaluator fills `action_taken` from detectors where it can, and where it
  // cannot the owner's own answer is the only evidence that a card was ever
  // acted on. A card marked done in one browser was unmeasured everywhere
  // else, and lost entirely when the owner changed device or cleared storage.
  //
  // HOW EACH ACTION MAPS, and why. Both endpoints already existed.
  //
  //   Complete  -> action-claim 'did'. A CLAIM (migration 039): the card moves
  //                to "Marked done - checking your data", the route
  //                re-evaluates that rec at once (force, onlyRecId) and
  //                answers with the state the data reached. A store whose
  //                purchases feed already holds the order sees Completed on
  //                the same click; one whose feed is silent sees Marked done
  //                with a sentence saying so. "Completed" is never written
  //                here on the owner's word.
  //   Dismiss   -> action-claim 'dismissed' WITH the reason in the body (the
  //                row keeps it as dismiss_reason), EXCEPT for "Already
  //                done", which means the action WAS taken and is sent as
  //                'did' - still with the reason, so it reads "Marked done"
  //                with "Already done" on the row, never Completed. Treating
  //                it as a dismissal would file a completed action as a
  //                refusal and leave the shelf movement unexplained.
  //   Accept    -> vote 'up'. Accepting is the owner endorsing the card; it
  //                is not a claim about what happened, so it must not become
  //                an action-claim. The vote also flows back to the engine
  //                through the recommendation history feed.
  //   Reopen    -> from Accepted: vote 'none'. From Marked done: action-claim
  //                'none', which RETRACTS the claim (and clears the vote too,
  //                so the card lands in Open). A Completed card has no
  //                Reopen: the data decided it.
  //
  // The local write stays, and stays FIRST, because it is the optimistic UI.
  // The server's response is then folded in (applyServerState) so the card
  // shows what the data decided; a failed call reverts the local write: a
  // status that looks saved and is not is worse than one that visibly did
  // not save, since the owner would never know to try again.
  // `action` is the bare route name ('vote' | 'action-claim'): the URL is
  // `${rec.id}/${action}`, two segments, so scripts/check-routes can collapse
  // it to /:id/<param> and match it against the backend's routes.
  const syncAction = useCallback(async (rec, action, body, revertTo) => {
    try {
      const res = await fetch(`${base}/api/recommendations/${rec.id}/${action}`, {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      if (res.status === 401) {
        localStorage.removeItem('botella_token');
        window.location.href = '/login';
        return null;
      }
      if (!res.ok) throw new Error(`${res.status}`);
      const payload = await res.json().catch(() => ({}));
      return payload || {};
    } catch {
      if (revertTo) setStatus(rec.id, revertTo.status, revertTo.meta || {});
      await dialog.alert({
        title: 'That did not save',
        message: 'Your decision was not recorded on the server, so it will not '
          + 'be measured. Check your connection and try again.',
      });
      return null;
    }
  }, [base, headers, dialog]);

  // Actions (A6: complete is a claim the data confirms; accepted/claimed can move back)
  const accept = (r) => {
    const prev = getStatus(r.id);
    setStatus(r.id, 'accepted');
    syncAction(r, 'vote', { vote: 'up' }, prev);
  };
  const complete = async (r) => {
    const ok = await dialog.confirm({
      title: 'Mark this as done?',
      message: 'It will show as "Marked done" while we check your own data - orders, '
        + 'invoices, stock and prices. It becomes Completed when that data confirms '
        + 'what you did, and the Effectiveness screen measures it against your sales '
        + 'for the next 30 days.',
      confirmLabel: 'Yes, mark it done',
      cancelLabel: 'Not yet',
    });
    if (!ok) return;
    const prev = getStatus(r.id);
    setStatus(r.id, 'claimed');
    const body = await syncAction(r, 'action-claim', { claim: 'did' }, prev);
    if (body) applyServerState(r.id, body);
  };
  const reopen = async (r) => {
    const prev = getStatus(r.id);
    setStatus(r.id, 'open');
    if (prev.status === 'claimed' || prev.action_claim === 'did') {
      // Retract the claim; the row goes back to pending unless the data has
      // since confirmed it (in which case the server says so and the card
      // reads Completed again on the next fetch).
      const body = await syncAction(r, 'action-claim', { claim: 'none' }, prev);
      if (body) applyServerState(r.id, { ...body, user_vote: null });
      syncAction(r, 'vote', { vote: 'none' }, null);
      return;
    }
    syncAction(r, 'vote', { vote: 'none' }, prev);
  };
  const doDismiss = async (r, reason) => {
    const prev = getStatus(r.id);
    const claim = claimForDismissal(reason);
    // "Already done" is a claim, and shows as one.
    setStatus(r.id, claim === 'did' ? 'claimed' : 'dismissed', { reason });
    setDismissing(null);
    const body = await syncAction(r, 'action-claim', { claim, reason }, prev);
    if (body) applyServerState(r.id, body);
  };
  const executionPlan = (r) => {
    const lead = (r.products && r.products[0]) || {};
    const name = lead.product_name || (r.primary_skus && r.primary_skus[0]) || 'this product';
    if (onAnalyse) onAnalyse(r.rationale, name, r.category, 'execute');
    else onNavigate && onNavigate('ask');
  };

  /* greeting */
  const now = new Date();
  const greetName = greetingName();
  const dataThrough = dash?.latestSaleDate ? new Date(dash.latestSaleDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;
  const refreshedAt = run?.generated_at ? new Date(run.generated_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const todayLabel = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  /* key figures (§6.2) - four calm tiles (A5): label · value · one line · link.
     No sparklines. Out-of-stock and dead-stock read from the SAME buying query
     the Purchasing tiles use, so the two screens always agree. */
  const kpis = dash?.kpis || {};
  const buy = buying?.buying || {};
  const lost = buying?.lost_sales || {};
  const trend = (dash?.revenueTrend || []).map((r) => Number(r.revenue) || 0);
  const latestRev = trend.length ? trend[trend.length - 1] : (kpis.revenue || 0);
  const typicalRev = median(trend.slice(0, -1));
  const salesDeltaPct = typicalRev > 0 ? Math.round(((latestRev - typicalRev) / typicalRev) * 100) : null;
  const latestLabel = dash?.latestSaleDate ? new Date(dash.latestSaleDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null;
  const keyFigures = [
    { label: `Sales, latest day${latestLabel ? ` (${latestLabel})` : ''}`, value: fmtMoney(latestRev), tone: 'ac',
      info: 'Total takings on the most recent day your POS has finished reporting - not today, which is still in progress. The comparison is against a typical day of the same weekday.',
      // NO sqlKey, deliberately. overview.revenue_30d is a THIRTY-DAY total and
      // this tile is ONE DAY - pointing the reveal at it showed ~$118k behind a
      // figure reading $3,293. An icon that opens the wrong query is worse than
      // no icon, because the person who clicks it is the person trying to work
      // out why a number looks wrong. There is no per-day query in sql_checks
      // yet; when there is, put its key here.
      delta: salesDeltaPct != null ? { text: `${Math.abs(salesDeltaPct)}% vs a typical day`, up: salesDeltaPct >= 0, good: salesDeltaPct >= 0 } : null,
      note: 'the most recent completed sales day', linkLabel: 'Reports', link: 'reports' },
    { label: 'Gross margin', value: kpis.grossMarginPct != null ? `${Number(kpis.grossMarginPct).toFixed(1)}%` : NO_DATA, empty: kpis.grossMarginPct == null, tone: 'ac',
      info: 'What you keep of every dollar taken, after what the stock cost you, over the last 90 days. Only products with a known cost price are counted, so it describes the part of your range your POS has cost data for.',
      sqlKey: 'overview.gross_margin_pct',
      note: 'last 90 days, where cost is known', linkLabel: 'Reports', link: 'reports' },
    { label: 'Fast movers out of stock', value: fmtNum(lost.stockout_sku_count ?? 0), tone: 'rd',
      info: 'Products your customers buy often that you currently have none of. "Fast" is a high bar - a wider count of everything out of stock that has sold at all recently runs several times higher, and BottleSense reports that one. This tile is the short list worth chasing today; the lost-sales figure beside it is what those specific gaps cost per day.',
      sqlKey: 'buying.stockout_sku_count',
      note: lost.ongoing_daily_loss ? `${fmtMoney(lost.ongoing_daily_loss)} / day in lost sales (est.)` : 'revenue lost while out', linkLabel: 'Purchasing › Out of stock', link: 'purchasing' },
    { label: 'Capital in dead stock', value: buy.dont_buy_capital_tied != null ? fmtMoney(buy.dont_buy_capital_tied) : NO_DATA, empty: buy.dont_buy_capital_tied == null, tone: 'gr',
      info: 'Money sitting in stock that is not moving, counting only what is worth acting on: more than one on hand, a known cost, and something that sold at some point before. A wider count of every stocked product with no sale in 90 days runs higher, because it includes single bottles, uncosted lines and products that never sold - Ask Botella can give you both.',
      sqlKey: 'buying.dont_buy_capital_tied',
      note: `${fmtNum(buy.dont_buy_sku_count ?? 0)} products worth clearing`, linkLabel: 'Purchasing › Clear', link: 'purchasing' },
  ];

  if (loading && !dash) {
    return <div className="rh-page"><div className="rh-loading"><Loader size={22} className="rh-spin" /><span>Reviewing your store…</span></div></div>;
  }
  if (error && !dash) {
    return <div className="rh-page"><RetrievalNotice sample="recommendations" error={error} label="Your store" onRetry={fetchAll} errorClassName="rh-error" fallback="Unable to load your store. Please try again." /></div>;
  }

  const typesPresent = Array.from(new Set(recs.map((r) => r.action_type).filter(Boolean)));
  // Open tab shows the main (≥ floor) cards; folded low-value ones live in the
  // collapsed group below. Other tabs show their full set. Already value-sorted.
  const list = (tab === 'open' ? openMain : (byStatus[tab] || []))
    .filter((r) => typeFilter === 'all' || r.action_type === typeFilter)
    .slice()
    .sort((a, b) => (amountOf(b) - amountOf(a))
      || ((a.rank || 99) - (b.rank || 99)));
  const quiet = byStatus.open.length === 0;

  return (
    <div className="rh-page">
      <div className="rh-cols">
        {/* MAIN COLUMN */}
        <div className="rh-main">
          {/* GREETING (§4.8) */}
          <header className="rh-greeting">
            <span className="rh-eyebrow">
              AI Recommendations · {todayLabel} · refreshed {refreshedAt}{dataThrough ? ` · data through ${dataThrough}` : ''}
            </span>
            <h1 className="rh-hello">Welcome back{greetName ? `, ${greetName}` : ''}.</h1>
            <p className="rh-review">Here is what deserves your attention today.</p>
      {/* EVIDENCE STATE, SPOKEN (sheet 18 rule 2).
          A statement about the SHOP, so it is said once at the top rather than
          repeated on every card. "You're an emerging store - I'm using your
          data where I can and similar shops where I can't" is a sentence an
          owner can agree with or argue with. own_weight 0.31 is neither. */}
      {evidenceSentence(run && run.evidence_state) && (
        <p className="rh-evidence">{evidenceSentence(run.evidence_state)}</p>
      )}
            {/* Internal tooling, beside the line that states when the run last
                happened - the only place on this screen where "regenerate"
                means anything. Absent entirely from production builds, and
                from the tenants we demo on: the demo runs a QA build so it
                shows the newest work, which also put an env badge and a
                "Testers only" button on the first screen a prospect sees.
                See utils/features.js. */}
            {CAN_GENERATE_INSIGHTS && !isDemoAccount() && (
              <div className="rh-devbar">
                <span className="rh-devbar-tag">{ENV_LABEL}</span>
                <button
                  type="button"
                  className="rh-devbar-btn"
                  onClick={generateInsights}
                  disabled={generating}
                  title="Run the recommendation job now instead of waiting for tonight"
                >
                  {generating
                    ? <><Loader size={13} className="rh-spin" /> Generating…</>
                    : <><Sparkles size={13} /> Generate Insights</>}
                </button>
                <span className="rh-devbar-note">
                  {generating
                    ? 'This takes a minute or two - the run reads your full sales history.'
                    : 'Runs the nightly job now. Testers only; not shown to stores.'}
                </span>
                {/* WHICH ENGINE THIS RUNS, said out loud.
                    The button posts to /api/recommendations/generate, which
                    calls the Python service's /run-recommendations. That path
                    now selects through app/pipeline - temporal reversion, the
                    deficit, the materiality and confidence gates. No model
                    chooses anything; it writes the prose after the decision is
                    fixed, and every numeral is checked against the computed
                    figures. Verified with the Anthropic key exhausted: the run
                    returns 200 and completes.

                    This note used to say the opposite, correctly, before the
                    migration. It is kept rather than deleted because "which
                    engine did this card come from" is the first question
                    anyone asks of a recommendation. */}
                {!generating && (
                  <span className="rh-devbar-note rh-devbar-ok">
                    Runs the rebuilt engine - deterministic selection, no model
                    in the choosing path.
                  </span>
                )}
              </div>
            )}
          </header>

          {/* HEADLINE (§4.3) */}
          {quiet ? (
            <div className="rh-headline rh-headline-quiet">
              <h2>No urgent recommendations today.</h2>
              <p>Nothing needs a decision today. {byStatus.accepted.length > 0 ? `${byStatus.accepted.length} accepted item${byStatus.accepted.length === 1 ? '' : 's'} still in your plan.` : 'The next review runs overnight.'}</p>
            </div>
          ) : (
            <div className="rh-headline">
              <h2>
                {fmtNum(openVisible.length)} open recommendation{openVisible.length === 1 ? '' : 's'} ·{' '}
                <span className="rh-headline-value">{fmtMoney(openValue30)} to gain over the next 30 days</span> <em>(est.)</em>
              </h2>
              <MetricInfo
                label="Value of open recommendations"
                info="Every open recommendation carries its own estimate of what acting on it is worth. This adds them up over a common 30-day window, so a weekly opportunity and a monthly one are counted on the same footing. It is what is available to act on, not money already earned."
              />
            </div>
          )}

          {/* KEY FIGURES (§6.2) */}
          <div className="rh-figures">
            {keyFigures.map((f) => (
              /* The figure is a navigating <button>; the info control is a
                 button too, and nesting them is invalid HTML that browsers
                 unnest - so the controls are a sibling layered on top. */
              <div key={f.label} className="rh-fig-cell">
              <button type="button" className={`rh-fig rh-fig-${f.tone}`} onClick={() => onNavigate && onNavigate(f.link)}>
                <span className="rh-fig-label">{f.label}</span>
                <span className={`rh-fig-value ${f.empty ? 'is-empty' : ''}`}>{f.value}</span>
                {f.delta && (
                  <span className={`rh-fig-delta ${f.delta.good ? 'is-good' : 'is-bad'}`}>
                    {f.delta.up ? '▲' : '▼'} {f.delta.text}
                  </span>
                )}
                <span className="rh-fig-note">{f.note}</span>
                {f.linkLabel && <span className="rh-fig-link">{f.linkLabel} <ArrowRight size={11} /></span>}
              </button>
              <span className="rh-fig-meta"><MetricInfo label={f.label} info={f.info} sqlKey={f.sqlKey} /></span>
              </div>
            ))}
          </div>

          {/* TABS (§4.2) + meta row */}
          {fromReport && hiIds.size > 0 && (
            <div className="rh-fromreport">
              <span className="rh-fromreport-dot" />
              <span>
                <strong>{hiIds.size}</strong> recommendation{hiIds.size === 1 ? '' : 's'} from{' '}
                {fromReport.label || 'your report'}{hiIds.size === 1 ? ' is' : ' are'} marked below.
              </span>
            </div>
          )}

          <div className="rh-tabrow">
            <div className="rh-tabs" role="tablist">
              {[
                ['open', 'Open', c.open, undefined],
                ['accepted', 'Accepted', c.accepted, undefined],
                ['claimed', 'Marked done', c.claimed, 'You marked these done; your orders, stock and prices have not confirmed them yet.'],
                ['completed', 'Completed', c.completed, 'Confirmed by your data: an order, an invoice, a stock rise, a price change or a new catalogue item.'],
              ].map(([k, label, n, title]) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} className={`rh-tab ${tab === k ? 'is-on' : ''}`} title={title} onClick={() => setTab(k)}>
                  {label} <span className="rh-tab-count">{n}</span>
                </button>
              ))}
            </div>
            <span className="rh-rankedby">
              {needDecisionThisWeek > 0 ? `${fmtNum(needDecisionThisWeek)} need a decision this week` : ''}
              {needDecisionThisWeek > 0 && run?.generated_at ? ' · ' : ''}
              {run?.generated_at ? `generated ${new Date(run.generated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}
            </span>
            {/* Both dropdowns share one wrapper so a single outside-click test
                covers them, and one `openMenu` value so opening either closes
                the other. */}
            <div className="rh-filters" ref={menuBarRef}>
              <div className="rh-typefilter">
                <button type="button" className="rh-typefilter-btn"
                  onClick={() => setOpenMenu((m) => (m === 'type' ? null : 'type'))}
                  aria-expanded={openMenu === 'type'} aria-haspopup="menu">
                  {typeFilter === 'all' ? 'All types' : TYPE_TAG[typeFilter] || 'All types'} <ChevronDown size={13} />
                </button>
                {openMenu === 'type' && (
                  <div className="rh-typefilter-menu" role="menu">
                    {['all', ...typesPresent].map((t) => (
                      <button key={t} type="button" role="menuitem" className={`rh-typefilter-opt ${typeFilter === t ? 'is-on' : ''}`}
                        onClick={() => { setTypeFilter(t); setOpenMenu(null); }}>
                        {t === 'all' ? 'All types' : TYPE_TAG[t] || t}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* CARDS */}
          {recsError ? (
            <RetrievalNotice sample="recommendations"
              error={recsError}
              label="Recommendations"
              onRetry={() => fetchAll().catch(() => {})}
              errorClassName="rh-empty"
              fallback="Unable to load your recommendations."
            />
          ) : list.length === 0 ? (
            <div className="rh-empty">
              {tab === 'open' ? 'No open recommendations. Nicely run.'
                : tab === 'accepted' ? 'Nothing accepted yet. Accept a recommendation to add it to your plan.'
                  : tab === 'claimed' ? 'Nothing marked done is waiting on your data. A card you mark complete sits here until an order, invoice, stock rise or price change confirms it.'
                    : 'Nothing confirmed yet. A recommendation lands here when your own data shows you followed it - never because it was clicked.'}
            </div>
          ) : (
            <ul className="rh-list">
              {list.map((r, i) => {
                const v = groundedValue(r);
                const dl = deadlineFor(r);
                const ev = evidenceFor(r, keyDomain);
                const isOpen = expanded === r.id;
                const lead = (r.products && r.products[0]) || {};
                const leadName = lead.product_name || (r.primary_skus && r.primary_skus[0]) || 'this product';
                const extra = (r.products || []).length - 1;
                // CALIBRATED, NEVER RAW (sheet 18 rule 5).
                //
                // This read `r.confidence` - the model's STATED confidence,
                // which sheet 08 measured at a mean of 0.48 against an actual
                // hit rate of 0.23. A coin flip with a decimal point, shown
                // under the word that makes people trust it.
                //
                // And when it was absent it defaulted to `{ word: 'Good' }`
                // and to 60% - inventing a confidence claim for a card that
                // made none. Same bug class as `Number(null) === 0`: an
                // unknown rendered as a confident value.
                //
                // Now: the calibrated field only, words only, and a card with
                // no calibrated confidence claims none at all.
                const conf = confidenceDisplay(r);
                // Withheld rather than absent. `cardConfidence` returns null
                // when the figure does not separate this card from the next,
                // and a bare gap would read as "no data" when the truth is
                // "one store-level rate, the same on every card today".
                const confNote = confidenceNote(r);
                // The server's one sentence about whether the data shows this
                // card was followed (039); the overlay keeps the latest copy
                // the POST response carried.
                const fulfilText = r.fulfilment_summary || (r._statusMeta && r._statusMeta.summary) || null;
                // NOT FOLLOWED: a detector with full visibility saw nothing
                // and the time to act has run out. Shown on an open or
                // accepted card, with the sentence - which, when the owner
                // had marked it done, says both things.
                const notFollowed = r._fulfilment === 'not_followed' ? (
                  <>
                    <span className="rh-notfollowed" title="We checked your orders, stock and prices; nothing showed up before the window closed."><PackageX size={14} /> Not followed</span>
                    {fulfilText && <p className="rh-fulfil">{fulfilText}</p>}
                  </>
                ) : null;
                const actions = r._status === 'open' ? (
                  dismissing === r.id ? (
                    <div className="rh-dismiss-menu">
                      <span className="rh-dismiss-q">Why dismiss?</span>
                      {DISMISS_REASONS.map((reason) => (
                        <button key={reason} type="button" className="rh-dismiss-opt" onClick={() => doDismiss(r, reason)}>{reason}</button>
                      ))}
                      <button type="button" className="rh-dismiss-cancel" onClick={() => setDismissing(null)}>Cancel</button>
                    </div>
                  ) : (
                    <div className="rh-actions">
                      <button type="button" className="rh-btn rh-btn-primary" onClick={() => executionPlan(r)}><Sparkles size={14} /> Execution plan</button>
                      <button type="button" className="rh-btn rh-btn-outline" onClick={() => accept(r)}><Check size={14} /> Accept</button>
                      <button type="button" className="rh-btn rh-btn-text" onClick={() => setDismissing(r.id)}>Dismiss</button>
                      {notFollowed}
                    </div>
                  )
                ) : r._status === 'accepted' ? (
                  <div className="rh-actions">
                    <span className="rh-accepted"><Check size={14} /> Accepted</span>
                    <button type="button" className="rh-btn rh-btn-outline" onClick={() => complete(r)}>Mark complete</button>
                    <button type="button" className="rh-btn rh-btn-text" onClick={() => reopen(r)}>Move back to Open</button>
                    {notFollowed}
                  </div>
                ) : r._status === 'claimed' ? (
                  // THE OWNER'S WORD, shown as the owner's word (039). Distinct
                  // from the trophy: hollow chip, the server's sentence saying
                  // what has and has not appeared, and a way back.
                  <div className="rh-actions">
                    <span className="rh-claimed"><Hourglass size={14} /> Marked done - checking your data</span>
                    <button type="button" className="rh-btn rh-btn-text" onClick={() => reopen(r)}>Undo</button>
                    {fulfilText && <p className="rh-fulfil">{fulfilText}</p>}
                  </div>
                ) : (
                  // THE DATA'S WORD. Only fulfilment_state === 'confirmed'
                  // reaches here. No Reopen: a purchase order that happened
                  // cannot be un-happened from a button.
                  <div className="rh-actions">
                    <span className="rh-completed"><Trophy size={14} /> Completed</span>
                    <span className="rh-fulfil-note">confirmed by your data</span>
                    {fulfilText && <p className="rh-fulfil">{fulfilText}</p>}
                  </div>
                );
                return (
                  <li key={r.id}
                      id={`rec-${r.id}`}
                      ref={hiIds.has(String(r.id)) && !firstHiRef.current ? firstHiRef : null}
                      className={`rh-card ${isOpen ? 'is-open' : ''} rh-prox-${dl.proximity}${hiIds.has(String(r.id)) ? ' rh-card-hi' : ''}`}>
                    <div className="rh-card-grid">
                      {/* LEFT: what and why */}
                      <div className="rh-card-left">
                        <div className="rh-card-top">
                          {/* Rank follows displayed position (01, 02, 03 …).
                              V20: an accepted card is no longer in the ranked
                              queue, so it shows an em dash instead. */}
                          <span className="rh-rank">{r._status === 'accepted' ? '' : String(i + 1).padStart(2, '0')}</span>
                          <span className="rh-type">{TYPE_TAG[r.action_type] || 'Act'}</span>
                          <span className="rh-prod" title={leadName}>{leadName}{extra > 0 ? <em className="rh-more"> + {extra} more</em> : null}</span>
                        </div>
                        <p className="rh-why"><strong>Why:</strong> {whyFor(r)}</p>
                        {/* THE PROVENANCE LINE IS NOT OPTIONAL (sheet 18 rule 1).
                            On the card face, not behind the caret: a card whose
                            numbers are partly borrowed from other shops must say
                            so where it is read, not where it is investigated. */}
                        {cardProvenance(r) && (
                          <p className="rh-provenance">{cardProvenance(r)}</p>
                        )}
                        {/* A cohort-weighted card arriving without its line is a
                            PIPELINE bug (sheet 15 generates it, sheet 16 checks
                            it). Surfaced loudly in development and never shown
                            to a store - in production the line above falls back
                            to composing one from the same Provenance object, so
                            a missing sentence never becomes a missing
                            disclosure. */}
                        {IS_INTERNAL && provenanceIsMissing(r) && (
                          <p className="rh-provenance-bug">
                            DEV: own_weight {String(r.provenance.own_weight)} but
                            {' '}no provenance_sentence arrived - pipeline bug.
                          </p>
                        )}
                        <div className="rh-chips">
                          {ev.map((e, i) => { const Ico = SOURCE_ICON[e.source] || Package; return (
                            <span key={i} className={`rh-chip rh-src-${e.source}`}><Ico size={12} /> {e.label}</span>
                          ); })}
                        </div>
                      </div>

                      {/* RIGHT: worth, confidence, deadline, actions */}
                      <div className="rh-card-right">
                        <div className="rh-value">
                          <span className="rh-value-head">
                            {v.unmeasured ? (
                              <em>No sales history to project from</em>
                            ) : (<>
                              <strong>{fmtMoney(amountOf(r))}</strong> in {VALUE_KIND_LABEL[v.kind] || 'projected value'} over {v.horizon_days || 30} days <em>(est.)</em>
                            </>)}
                          </span>
                          {r.cost && r.cost.amount != null && <span className="rh-cost">order cost {fmtMoney(r.cost.amount)}</span>}
                        </div>
                        <div className="rh-rightmeta">
                          {conf && (
                            <span className="rh-conf" title={conf.word}>
                              <span className="rh-conf-segs">{[0, 1, 2, 3].map((i) => <span key={i} className={`rh-seg ${i < conf.seg ? 'on' : ''}`} />)}</span>
                              <span className="rh-conf-word">{conf.word}</span>
                            </span>
                          )}
                          {dl.iso && (
                            <span className={`rh-deadline rh-prox-${dl.proximity}`}>
                              {dl.proximity === 'overdue'
                                ? <>Overdue · was due {fmtDate(dl.iso)}</>
                                : <>{DEADLINE_VERB[r.action_type] || 'Reassess by'} {fmtDate(dl.iso)}{dl.reason ? ` · ${dl.reason}` : ''}</>}
                            </span>
                          )}
                          <button type="button" className="rh-caret" onClick={() => setExpanded(isOpen ? null : r.id)} aria-expanded={isOpen} aria-label={isOpen ? 'Collapse' : 'Expand'}>
                            <ChevronDown size={16} className={isOpen ? 'rh-chev-open' : ''} />
                          </button>
                        </div>
                        {actions}
                      </div>
                    </div>

                    {isOpen && (
                      <div className="rh-detail">
                        <div className="rh-skus">
                          {(r.products || []).map((p) => (
                            <div key={p.sku} className="rh-sku">
                              <span className="rh-sku-name" title={p.product_name || p.sku}>{truncate(p.product_name || p.sku, 42)}</span>
                              <span className="rh-sku-meta">{p.on_hand ?? NOT_AVAILABLE} on hand{p.price != null ? ` · ${fmtMoney(p.price)}` : ''}</span>
                            </div>
                          ))}
                        </div>
                        {/* "24 units (2 cases of 12)" rather than a bare 24
                            (sheet 18 rule 3). What makes the constraints layer
                            read as care rather than as unexplained arithmetic -
                            an owner who sees 24 wonders why not 25. */}
                        {quantityWithReason(r.suggested_order_qty, r.constraints) ? (
                          <div className="rh-suggested">
                            <strong>Suggested order:</strong>{' '}
                            {quantityWithReason(r.suggested_order_qty, r.constraints)}
                          </div>
                        ) : (
                          r.quantity_hint && <div className="rh-suggested"><strong>Suggested order:</strong> {r.quantity_hint}</div>
                        )}
                        {/* Only when the quantity was actually CHANGED. A note
                            about a constraint that did not bind is noise, and
                            noise is what teaches people to stop reading the
                            notes that matter. */}
                        {constraintNote(r) && (
                          <p className="rh-constraint">Adjusted: {constraintNote(r)}</p>
                        )}
                        <p className="rh-rationale">{r.rationale}</p>
                        {(r.signals_cited || []).length > 0 && (
                          <div className="rh-sigchips">
                            {(r.signals_cited || []).slice(0, 6).map((s, i) => (
                              <button key={i} type="button" className="rh-sigchip" onClick={() => setSignalsOpen(true)}>
                                {resolveSignalLabel(typeof s === 'string' ? s : (s.key || s.kind), snapshot)}
                              </button>
                            ))}
                          </div>
                        )}
                        {/* WHAT EACH LIVE SIGNAL WAS FOUND TO DO HERE (migration
                            043), in the engine's one sentence. A reorder card
                            cites nothing - it consults no external signal - but
                            the engine still checked every live signal against
                            this card's drink family, and this is where it says
                            what it found: "16 live signal(s) checked against
                            beer; none measurable yet - too_few_active_days:7<20".
                            Printed verbatim; a card from before 043 has none
                            and prints nothing, which is the truth. */}
                        {r.signal_impact_summary && (
                          <p className="rh-sigimpact">{r.signal_impact_summary}</p>
                        )}
                        <div className="rh-detail-foot">
                          {/* Words, not a percentage. "74%" invites a precision
                              nobody has earned; the calibrated estimate's honest
                              resolution is a band. */}
                          {/* Both lines ride on SHOW_CARD_CONFIDENCE (features.js).
                              The note explained a MISSING figure by quoting the
                              store rate it would have been ("44% is how often..."),
                              so with no figure anywhere it would print the very
                              number the flag withdraws; it goes with it. */}
                          {SHOW_CARD_CONFIDENCE && conf && <span className="rh-conf-line">Confidence · <strong>{conf.word}</strong></span>}
                          {SHOW_CARD_CONFIDENCE && !conf && confNote && <span className="rh-conf-line rh-conf-flat">{confNote}</span>}
                          {dl.iso && <span className="rh-foot-sep">·</span>}
                          {dl.iso && <span>{DEADLINE_VERB[r.action_type] || 'Act by'} {fmtDate(dl.iso)}</span>}
                          <button type="button" className="rh-support" onClick={() => {
                            // C1: carry the recommendation's rows + label into the reference
                            // screen so it highlights, scrolls, and shows a return path.
                            try {
                              const skus = [...new Set([...(r.primary_skus || []), ...((r.products || []).map((p) => p.sku).filter(Boolean))].map(String))];
                              sessionStorage.setItem('botella_ref_highlight', JSON.stringify({ skus, label: `${TYPE_TAG[r.action_type] || 'Recommendation'} · ${leadName}`, recId: r.id }));
                            } catch { /* no-op */ }
                            onNavigate && onNavigate('purchasing');
                          }}>View supporting data <ArrowRight size={13} /></button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {/* A3: low-value recommendations folded into one collapsed group.
              Withdrawn behind SHOW_FOLDED_RECOMMENDATIONS (utils/features.js):
              with it off the Open tab IS the main fold, the counts above read
              from the same set, and the per-type reservation in utils/mainFold
              is the only way a $0-valued markdown or bundle reaches the screen. */}
          {SHOW_FOLDED_RECOMMENDATIONS && tab === 'open' && openFolded.length > 0 && typeFilter === 'all' && (
            <div className="rh-folded">
              <button type="button" className="rh-folded-toggle" onClick={() => setShowFolded((v) => !v)} aria-expanded={showFolded}>
                <ChevronDown size={15} className={showFolded ? 'rh-chev-open' : ''} />
                {openFolded.length} more recommendation{openFolded.length === 1 ? '' : 's'} · lower estimated value
              </button>
              {showFolded && (
                <ul className="rh-folded-list">
                  {openFolded.map((r) => {
                    const lead = (r.products && r.products[0]) || {};
                    const name = lead.product_name || (r.primary_skus && r.primary_skus[0]) || 'this product';
                    return (
                      <li key={r.id} id={`rec-${r.id}`} className="rh-folded-item">
                        <span className="rh-folded-type">{TYPE_TAG[r.action_type] || 'Act'}</span>
                        <span className="rh-folded-name" title={name}>{truncate(name, 40)}</span>
                        <span className="rh-folded-val">{fmtMoney(amountOf(r))} <em>(est.)</em></span>
                        <button type="button" className="rh-folded-accept" onClick={() => accept(r)}>Accept</button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {/* DISCLAIMER (§6.10) */}
          <div className="rh-disclaimer">
            <strong>Important:</strong> Recommendations, projections and estimates are generated automatically from your store’s data and third-party signals (weather, events, comparable-store benchmarks). They may be incomplete or inaccurate, are provided for informational purposes only, and do not constitute financial, legal or business advice. Verify against your own records before making purchasing, pricing, staffing or other business decisions. Botella is not responsible for decisions made in reliance on this information.
          </div>
        </div>

        {/* RIGHT RAIL (§6.6-6.7) - sticky */}
        <aside className="rh-rail">
          {/* Signals - the compact, domain-grouped list from the run's own
              signal_snapshot. "View all signals" opens the clustered modal.
              (The per-signal "measured / not yet measurable" rail that read
              GET /api/signal-impact/today was tried here on 20 Oct 2026 and
              taken back out on 22 Oct by request: the owner wanted the
              original Active Signals panel. The component is still in
              SignalImpactRail.js and the endpoint still answers.) */}
          <section className="rh-panel">
            <header className="rh-panel-head">
              <span className="rh-panel-title"><Radar size={15} /> Signals informing today’s recommendations</span>
              <span className="rh-panel-count">{fmtNum(Object.values(domainCounts).reduce((a, b) => a + b, 0))} active</span>
            </header>
            <SignalsRail snapshot={snapshot} onViewAll={() => setSignalsOpen(true)} />
          </section>

          {/* Effectiveness to date - withdrawn with the Effectiveness screen it
              links into. Leaving the tile up would strand a "View effectiveness"
              button on a route that no longer resolves, and it is the loudest
              number on the page. See utils/features.js. */}
          {SHOW_EFFECTIVENESS && (
            <EffectivenessTile eff={eff} onView={() => onNavigate && onNavigate('effectiveness')} />
          )}

          {/* Your plan */}
          <section className="rh-panel">
            <header className="rh-panel-head">
              <span className="rh-panel-title"><ClipboardList size={15} /> Your plan</span>
            </header>
            {byStatus.accepted.length === 0 ? (
              <p className="rh-plan-empty">Accepted recommendations appear here until you mark them complete.</p>
            ) : (
              <ul className="rh-plan-list">
                {byStatus.accepted.map((r) => {
                  const lead = (r.products && r.products[0]) || {};
                  const name = lead.product_name || (r.primary_skus && r.primary_skus[0]) || 'this product';
                  return (
                    <li key={r.id} className="rh-plan-item">
                      <span className="rh-plan-name" title={name}>{TYPE_TAG[r.action_type] || 'Act'}: {truncate(name, 22)}</span>
                      <button type="button" className="rh-plan-done" onClick={() => complete(r)}>Mark complete</button>
                    </li>
                  );
                })}
              </ul>
            )}
            {byStatus.accepted.length > 0 && (
              <button type="button" className="rh-plan-viewall" onClick={() => setTab('accepted')}>View accepted <ArrowRight size={13} /></button>
            )}
          </section>
        </aside>
      </div>

      <SignalsModal snapshot={snapshot} open={signalsOpen} onClose={() => setSignalsOpen(false)} />
    </div>
  );
}

/* ── Signals rail (compact, domain-grouped) ─────────────────────────────── */
function SignalsRail({ snapshot, onViewAll }) {
  const { domains, total } = buildSignalDomains(snapshot);
  if (total === 0) return <p className="rh-plan-empty">No external signals active today. Recommendations are inventory-driven.</p>;
  return (
    <>
      <ul className="rh-sig-list">
        {domains.map((d) => (
          <li key={d.id} className="rh-sig-group">
            <div className="rh-sig-head" style={{ '--sig': d.color }}><d.icon size={12} /> {d.label} <em>{d.items.length}</em></div>
            {d.items.slice(0, 3).map((it, i) => (
              <div key={i} className="rh-sig-item"><span className="rh-sig-dot" style={{ '--sig': d.color }} /><span className="rh-sig-text" title={it.detail || it.title}>{truncate(it.title, 30)}</span>{it.when && <span className="rh-sig-when">{it.when}</span>}</div>
            ))}
            {d.items.length > 3 && (
              <button type="button" className="rh-sig-more" onClick={onViewAll}>+{d.items.length - 3} more</button>
            )}
          </li>
        ))}
      </ul>
      <button type="button" className="rh-plan-viewall" onClick={onViewAll}>View all signals <ArrowRight size={13} /></button>
    </>
  );
}

/* ── Effectiveness to date tile (§6.7) ──────────────────────────────────── */
function EffectivenessTile({ eff, onView }) {
  const s = eff?.available ? (eff.summary || {}) : null;
  const measured = s?.evaluated || 0;
  const threshold = 10;
  const live = s && measured >= threshold && (s.revenue_impact != null || s.winners != null);
  const dollars = s ? (s.gross_margin ?? s.revenue_impact ?? null) : null;
  const tot = (s?.winners || 0) + (s?.neutral || 0) + (s?.underperformers || 0);
  // CONFIRMED BY DATA (039), never the owner's click; the click is `claimed`
  // and gets its own clause.
  const confirmed = s ? (s.confirmed ?? s.acted_as_recommended ?? null) : null;
  const claimed = s ? (s.claimed ?? 0) : 0;
  return (
    <section className="rh-panel rh-eff">
      <header className="rh-panel-head">
        <span className="rh-panel-title"><Trophy size={15} /> Effectiveness to date</span>
      </header>
      {live ? (
        <>
          <div className="rh-eff-value">{dollars != null ? fmtMoney(dollars) : `${fmtNum(s.winners)} winners`}</div>
          <div className="rh-eff-sub">
            {confirmed != null ? `${fmtNum(confirmed)} confirmed done by your data` : `${fmtNum(measured)} measured`}
            {claimed > 0 ? ` · ${fmtNum(claimed)} marked done, unconfirmed` : ''}
            {' · measured impact'}
          </div>
          {tot > 0 && (
            <div className="rh-eff-bar">
              <span className="rh-eff-seg rh-eff-good" style={{ flex: s.winners || 0 }} />
              <span className="rh-eff-seg rh-eff-mid" style={{ flex: s.neutral || 0 }} />
              <span className="rh-eff-seg rh-eff-bad" style={{ flex: s.underperformers || 0 }} />
            </div>
          )}
          <div className="rh-eff-legend"><span><i className="rh-eff-good" /> {fmtNum(s.winners)} outperformed</span><span><i className="rh-eff-mid" /> {fmtNum(s.neutral)} as expected</span><span><i className="rh-eff-bad" /> {fmtNum(s.underperformers)} under</span></div>
        </>
      ) : (
        <>
          <div className="rh-eff-value rh-eff-measuring">{fmtNum(measured)} <span>measuring</span></div>
          <div className="rh-eff-sub">Results appear as each recommendation’s window closes.</div>
        </>
      )}
      <button type="button" className="rh-plan-viewall" onClick={onView}><Coins size={13} /> View effectiveness <ArrowRight size={13} /></button>
    </section>
  );
}
