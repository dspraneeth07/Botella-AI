import React, { useState, useEffect, useCallback } from 'react';
import {
  Lightbulb, Loader, RefreshCw, AlertTriangle, ArrowRight, Sparkles,
  PackagePlus, PackageX, CloudSun, Trophy, Newspaper, Layers,
  CalendarDays, MapPin, Thermometer, Package, Clock, Tag, ChevronDown,
  ThumbsUp, ThumbsDown, TrendingUp, ListChecks, Check,
} from 'lucide-react';
import { priorityOf } from './DashPanels';
import ActiveSignalsButton from './SignalsModal';
import { addTask, isSaved } from '../utils/tasklist';
import { SHOW_CARD_CONFIDENCE } from '../utils/features';
import './SuggestionsPage.css';

// ── Category metadata: label, icon, accent color ────────────────────────────
// Mirrors the Python contract enum (API_CONTRACT.md §2). Exported so the
// Effectiveness components (EffectivenessCase / EffectivenessPending) render
// the SAME category chips and action labels - one palette, one vocabulary.
export const CATEGORY_META = {
  inventory_understock: { label: 'Understock', icon: PackagePlus, color: '#2FBF97' },
  inventory_overstock:  { label: 'Overstock',  icon: PackageX,    color: '#F0ABFC' },
  weather:              { label: 'Weather',     icon: CloudSun,    color: '#56CCF2' },
  calendar_sports:      { label: 'Calendar & Sports', icon: Trophy, color: '#C4A6FF' },
  news:                 { label: 'News',        icon: Newspaper,   color: '#56CCF2' },
  bundle:               { label: 'Bundle',      icon: Layers,      color: '#8B5CF6' },
  new_arrival:          { label: 'New Product', icon: Sparkles,    color: '#F472B6' },
  social_trending:      { label: 'Trending',    icon: TrendingUp,  color: '#E879F9' },
};
export const fallbackCat = { label: 'Recommendation', icon: Lightbulb, color: '#B79CFF' };

// Signal-kind chip metadata - the SAME icons/colors the SignalStrip below
// inlines, exported so the Effectiveness case files ("Why this call" trigger
// chips) speak the identical visual vocabulary. Additive; keep in sync with
// SignalStrip if a color ever changes.
export const SIGNAL_KIND_META = {
  weather: { icon: Thermometer,  color: '#56CCF2' },
  sports:  { icon: Trophy,       color: '#2FBF97' },
  event:   { icon: MapPin,       color: '#F0ABFC' },
  holiday: { icon: CalendarDays, color: '#C4A6FF' },
  news:    { icon: Newspaper,    color: '#56CCF2' },
  trend:   { icon: TrendingUp,   color: '#E879F9' },
};

// ── STAGING ONLY - code toggle ──────────────────────────────────────────────
// Shows a "Generate now" button in the loaded view so testers can trigger a
// fresh run without waiting for the 04:00 cron (normally the button only
// exists in the no-runs empty state). Flip to false before/after the staging
// test window - deliberately a code switch, not an env flag, per request.
const STAGING_GENERATE_BUTTON = true;

// Action-type → human label (contract enum).
export const ACTION_LABELS = {
  pre_stock: 'Pre-stock', endcap: 'Endcap', cold_box: 'Cold box', bundle: 'Bundle',
  markdown: 'Markdown', reorder: 'Reorder', liquidate: 'Liquidate', promote: 'Promote',
  stock_new: 'Stock new product',
};

// ── Small formatters ────────────────────────────────────────────────────────
// A bare 'YYYY-MM-DD' is a calendar date - parse it as LOCAL midnight, not via
// `new Date(str)` (which treats it as UTC and shows the wrong day in -ve offsets).
const parseDateish = (d) => {
  if (!d) return null;
  if (typeof d === 'string') {
    const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  const dt = new Date(d);
  return isNaN(dt) ? null : dt;
};
// Max event chips in the signal strip; the snapshot is draw-sorted, so these
// are the biggest draws. Keeps a busy concert week from eating the whole strip.
const MAX_EVENT_CHIPS = 5;
// Short date for signal chips: "Jul 4" (no year - signals are near-term, so the year is noise).
const fmtDateShort = (d) => {
  const dt = parseDateish(d);
  return dt ? dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
};
// Date range for a collapsed multi-day signal, dropping the repeated month:
// "· Jul 20-23" within one month, "· Jul 30-Aug 2" across two. Returns a
// leading-separator string (or '') so callers can append it directly.
const fmtDateRange = (start, end) => {
  const from = fmtDateShort(start);
  if (!from) return '';
  if (!end || end === start) return ` · ${from}`;
  const to = fmtDateShort(end);
  if (!to) return ` · ${from}`;
  const sameMonth = from.split(' ')[0] === to.split(' ')[0];
  return ` · ${from}-${sameMonth ? to.split(' ')[1] : to}`;
};
const daysUntil = (d) => {
  const dt = parseDateish(d);
  if (!dt) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((dt - today) / 86400000);
};
// "Thu, Aug 7" - weekday included so a forecast date reads as a nearby day.
const fmtDayShort = (d) => {
  const dt = parseDateish(d);
  return dt ? dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '';
};
// Natural label for a near-term date: "today", "tomorrow", else "Thu, Aug 7".
const naturalDay = (d) => {
  const n = daysUntil(d);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  return fmtDayShort(d);
};
const money = (n) => (n == null ? null : `$${Number(n).toFixed(2)}`);
// First sentence of a rationale - the collapsed card's one-line gist. Falls
// back to the whole text when there's no sentence break (CSS clamps overflow).
const firstSentence = (text) => {
  if (!text) return '';
  const m = String(text).match(/^[\s\S]*?[.!?](?=\s|$)/);
  return m ? m[0].trim() : String(text);
};

export function confidenceTone(c) {
  if (c >= 0.75) return { label: 'High', color: '#2FBF97' };
  if (c >= 0.5) return { label: 'Medium', color: '#F0ABFC' };
  return { label: 'Low', color: '#FF6B8A' };
}

// In-flight generate run, keyed by auth token. Module scope so it survives this
// component unmounting (tab switch within the SPA): coming back to the page
// resumes the "Generating…" state instead of offering a second run. The promise
// never rejects - it settles to { ok } | { error } | { unauthorized }.
const inflightGenerate = new Map();

function SuggestionsPage({ authToken, apiUrl, onAnalyse }) {
  const [data, setData] = useState(null);      // { run, recommendations } | null
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [generating, setGenerating] = useState(() => inflightGenerate.has(authToken));
  const [genError, setGenError] = useState(null);
  // Which cards show full detail (lifted here so it survives category-tab
  // switches within the page).
  const [expandedIds, setExpandedIds] = useState(() => new Set());

  const fetchLatest = useCallback(async () => {
    if (!authToken) return;
    setLoading(true);
    setError(null);
    try {
      const base = apiUrl.replace(/\/api\/?$/, '');
      const res = await fetch(`${base}/api/recommendations/latest`, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
          'ngrok-skip-browser-warning': 'true',
        },
      });
      if (res.status === 401) {
        localStorage.removeItem('botella_token');
        window.location.href = '/login';
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message || 'Unable to load recommendations.');
      }
      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [authToken, apiUrl]);

  useEffect(() => { fetchLatest(); }, [fetchLatest]);

  // Thumbs on one rec: clicking the current vote retracts it ('none'), anything
  // else casts/flips. POST /api/recommendations/:id/vote returns the fresh vote
  // shape, which we fold back into the rec in place - the vote also feeds the
  // Python service's feedback loop, so future runs weigh it.
  const handleVote = useCallback(async (rec, dir) => {
    if (!authToken || rec.id == null) return;
    const next = rec.user_vote === dir ? 'none' : dir;
    const base = apiUrl.replace(/\/api\/?$/, '');
    try {
      const res = await fetch(`${base}/api/recommendations/${rec.id}/vote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
          'ngrok-skip-browser-warning': 'true',
        },
        body: JSON.stringify({ vote: next }),
      });
      if (!res.ok) return; // keep current state; voting is best-effort UI
      const fresh = await res.json();
      setData((prev) => prev && ({
        ...prev,
        recommendations: (prev.recommendations || []).map((r) => (r.id === rec.id
          ? { ...r, thumbs_up: fresh.thumbs_up, thumbs_down: fresh.thumbs_down, user_vote: fresh.user_vote }
          : r)),
      }));
    } catch { /* network hiccup - leave the previous vote showing */ }
  }, [authToken, apiUrl]);

  // Manual first-run seed: POST /generate (runs the Python service for this
  // tenant now, ~1 min). Only starts the request and flips the flag - the
  // attach effect below owns settling, so the outcome lands correctly even if
  // the user leaves this page and comes back mid-run.
  const generateNow = useCallback(() => {
    if (!authToken || inflightGenerate.has(authToken)) return;
    setGenError(null);
    const base = apiUrl.replace(/\/api\/?$/, '');
    inflightGenerate.set(authToken, (async () => {
      try {
        const res = await fetch(`${base}/api/recommendations/generate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`,
            'ngrok-skip-browser-warning': 'true',
          },
        });
        if (res.status === 401) return { unauthorized: true };
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          return { error: body?.error?.message || 'Unable to generate recommendations.' };
        }
        return { ok: true };
      } catch (err) {
        return { error: err.message };
      }
    })());
    setGenerating(true);
  }, [authToken, apiUrl]);

  // Attach this mount's UI to the in-flight run - whether it was started on
  // this mount or before a tab switch - and surface the outcome once it settles.
  useEffect(() => {
    if (!generating) return undefined;
    const run = inflightGenerate.get(authToken);
    if (!run) {
      setGenerating(false); // stale flag: run settled while unmounted
      return undefined;
    }
    let alive = true;
    run.then((r) => {
      inflightGenerate.delete(authToken);
      if (r.unauthorized) {
        localStorage.removeItem('botella_token');
        window.location.href = '/login';
        return;
      }
      if (!alive) return;
      setGenerating(false);
      if (r.error) setGenError(r.error);
      else fetchLatest();
    });
    return () => { alive = false; };
  }, [authToken, fetchLatest, generating]);

  const recs = data?.recommendations || [];
  const run = data?.run || null;

  const visible = recs;

  // Stable per-rec key (falls back to rank for legacy rows without an id).
  const recKey = (r, i) => r.id ?? `rank-${r.rank ?? i}`;
  const toggleOne = (key) => setExpandedIds((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  // ── Loading ────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="sp-container">
        <div className="sp-loading">
          <Loader size={32} className="sp-spin" />
          <p>Loading your latest recommendations…</p>
        </div>
      </div>
    );
  }

  // ── Error ────────────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="sp-container">
        <div className="sp-empty">
          <AlertTriangle size={36} />
          <h3>Couldn't load recommendations</h3>
          <p>{error}</p>
          <button className="sp-retry-btn" onClick={fetchLatest}>
            <RefreshCw size={14} /> Try Again
          </button>
        </div>
      </div>
    );
  }

  // ── Empty (cron hasn't produced a run yet) ──────────────────────────────────
  if (!run || recs.length === 0) {
    return (
      <div className="sp-container">
        <div className="sp-empty">
          <Sparkles size={44} />
          <h3>No recommendations yet</h3>
          <p>
            Your signal-aware stocking recommendations are generated automatically
            once a day - or start a run now and they'll appear here in about a minute.
          </p>
          {genError && <p className="sp-empty-error">{genError}</p>}
          <div className="sp-empty-actions">
            <button className="sp-generate-btn" onClick={generateNow} disabled={generating}>
              {generating ? <Loader size={14} className="sp-spin" /> : <Sparkles size={14} />}
              {generating ? 'Generating…' : 'Generate recommendations'}
            </button>
            <button className="sp-retry-btn" onClick={fetchLatest} disabled={generating}>
              <RefreshCw size={14} /> Refresh
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Loaded ─────────────────────────────────────────────────────────────────
  return (
    <div className="sp-container">
      {/* Toolbar: the "why today?" signals as a compact button, sitting beside
          the Generate trigger rather than as a full-width strip. */}
      <div className="sp-toolbar">
        <ActiveSignalsButton snapshot={run.signal_snapshot} variant="pill" />
        {/* STAGING ONLY: on-demand run trigger (see STAGING_GENERATE_BUTTON) */}
        {STAGING_GENERATE_BUTTON && (
          <div className="sp-staging-generate">
            <button className="sp-generate-btn" onClick={generateNow} disabled={generating}>
              {generating ? <Loader size={14} className="sp-spin" /> : <Sparkles size={14} />}
              {generating ? 'Generating…' : 'Generate now (staging)'}
            </button>
            {genError && <span className="sp-staging-generate-err">{genError}</span>}
          </div>
        )}
      </div>

      <div className="sp-smart-heading">
        <div>
          <span className="sp-smart-kicker">Your next best moves</span>
          <h2>Smart Actions</h2>
        </div>
        <span>{recs.length} {recs.length === 1 ? 'action' : 'actions'}</span>
      </div>

      {/* Recommendation list - one short action per row, expands inline */}
      <div className="sp-rec-list">
        {visible.map((r, i) => (
          <RecRow
            key={recKey(r, i)}
            rec={r}
            index={i}
            expanded={expandedIds.has(recKey(r, i))}
            onToggle={() => toggleOne(recKey(r, i))}
            onAnalyse={onAnalyse}
            onVote={handleVote}
          />
        ))}
      </div>

      <p className="sp-disclaimer">
        These recommendations are AI-generated from your historical data and external signals, and may be
        incomplete or inaccurate. They are provided for informational purposes only, not as financial or
        business advice. Please verify against your own records before making decisions.
      </p>
    </div>
  );
}

// ── Signal context strip ─────────────────────────────────────────────────────
// Legacy inline strip - superseded by <ActiveSignalsButton> (the clustered
// pop-up). Kept and exported for reference / possible reuse; not rendered.
export function SignalStrip({ snapshot }) {
  const s = snapshot || {};
  const chips = [];

  (s.holidays || []).forEach((h) =>
    chips.push({ icon: CalendarDays, text: h.date ? `${h.name} · ${fmtDateShort(h.date)}` : h.name, color: '#C4A6FF' }));
  if (s.weather && s.weather.summary) {
    const w = s.weather;
    const hi = w.high_f != null ? `${Math.round(w.high_f)}°` : '';
    // The high is the WEEK's peak, so date it ("98° Thu, Aug 7") - otherwise
    // a Friday heatwave reads as today's weather. Old snapshots have no
    // high_date and fall back to the undated form.
    const hiWhen = hi && w.high_date ? naturalDay(w.high_date) : '';
    const text = `${w.summary}${hi ? ` · ${hi}${hiWhen && hiWhen !== 'today' ? ` ${hiWhen}` : ''}` : ''}`;
    const titleParts = [];
    if (w.window_start && w.window_end) {
      titleParts.push(`7-day outlook ${fmtDateShort(w.window_start)} - ${fmtDateShort(w.window_end)}`);
    }
    if (hi && w.high_date) titleParts.push(`high ${hi} ${naturalDay(w.high_date)}`);
    if (w.low_f != null && w.low_date) {
      titleParts.push(`low ${Math.round(w.low_f)}° ${naturalDay(w.low_date)}`);
    }
    chips.push({
      icon: Thermometer, text, color: '#56CCF2',
      title: titleParts.length ? titleParts.join(' · ') : text,
    });
  }
  // Only games near THIS store. Older stored snapshots may still carry national
  // games (is_local_home === false); keep just the locally relevant ones so an
  // Austin store never shows New York / Detroit matchups.
  // A multi-game home series arrives collapsed into ONE signal (games > 1),
  // shown as a single "Jul 20-23" chip rather than one bubble per game.
  (s.sports || []).filter((g) => g.is_local_home).forEach((g) => {
    const series = g.games > 1 ? ` · ${g.games} games` : '';
    chips.push({
      icon: Trophy,
      text: `${g.away} @ ${g.home}${fmtDateRange(g.date, g.end_date)}${series}`,
      color: '#2FBF97',
    });
  });
  // Events arrive pre-screened for liquor relevance and sorted biggest draw
  // first (Python event analyst). Cap them so a busy concert week can't crowd
  // holidays/news out of the strip; the tooltip carries the analyst's stocking
  // note ("Metal crowd; heavy on beer") and major draws get a badge.
  (s.events || []).slice(0, MAX_EVENT_CHIPS).forEach((e) => {
    const nights = e.nights > 1 ? ` · ${e.nights} nights` : '';
    const text = e.date ? `${e.name} · ${fmtDateShort(e.date)}${nights}` : `${e.name}${nights}`;
    chips.push({
      icon: MapPin, text, color: '#F0ABFC',
      title: e.note || text,
      badge: e.draw === 'major' ? 'major' : null,
    });
  });
  // Social trends (Reddit / YouTube / Google Trends), term-level. The tooltip
  // carries the analyst's stocking note plus the evidence behind the trend.
  // Social trends (Reddit / YouTube / X / Google Trends / Instagram / registers),
  // term-level. The tooltip carries the analyst's stocking note plus evidence.
  (s.social || []).forEach((t) => {
    const src = t.source || '';
    const viaReddit = src.includes('reddit');
    const viaYouTube = src.includes('youtube');
    const viaTwitter = src.includes('twitter');
    const viaInstagram = src.includes('instagram');
    const viaRegisters = src.includes('registers');
    // "Search" = Google Trends specifically. (Momentum alone no longer implies
    // search: Instagram and register entries are rising too. Keep the momentum
    // fallback only for legacy snapshots that predate those sources.)
    const viaSearch = src.includes('google_trends')
      || (t.momentum === 'rising' && !viaInstagram && !viaReddit && !viaYouTube && !viaTwitter && !viaRegisters);
    const n = t.mentions || 1;
    const srcBits = [];
    if (viaReddit && viaYouTube) {
      srcBits.push(`${n} top posts and videos this week (Reddit + YouTube)`);
    } else if (viaReddit) {
      srcBits.push(`${n} Reddit post${n === 1 ? '' : 's'}${t.score ? ` · ${t.score} upvotes` : ''}`);
    } else if (viaYouTube) {
      srcBits.push(`${n} YouTube video${n === 1 ? '' : 's'}${t.score ? ` · ${t.score.toLocaleString()} views` : ''}`);
    }
    if (viaTwitter) srcBits.push(`viral on X${t.score ? ` · ${t.score.toLocaleString()} likes` : ''}`);
    if (viaInstagram) srcBits.push(`Instagram posts surging${t.score ? ` · ${t.score.toLocaleString()} engagement` : ''}`);
    if (viaSearch) srcBits.push(`search interest rising${t.interest != null ? ` (${t.interest}/100)` : ''}`);
    if (viaRegisters) srcBits.push('selling faster at nearby stores (register-measured)');
    const detail = [t.note, srcBits.join(' · '), t.evidence].filter(Boolean).join(' · ');
    const sourceCount = [viaReddit || viaYouTube, viaTwitter, viaInstagram, viaSearch, viaRegisters].filter(Boolean).length
      + (viaReddit && viaYouTube ? 1 : 0);
    // Provenance in the chip TEXT, not just the tooltip: a register-measured
    // entry is nearby-store sales data, not social buzz - show it at a glance.
    const chipLabel = viaRegisters
      ? `${t.term} · hot at nearby stores`
      : viaInstagram && !viaReddit && !viaYouTube && !viaTwitter
        ? `${t.term} · surging on Instagram`
        : viaTwitter && !viaReddit && !viaYouTube && !viaInstagram
          ? `${t.term} · buzzing on X`
          : `${t.term} · trending`;
    chips.push({
      icon: TrendingUp, text: chipLabel, color: '#E879F9',
      title: detail || `${t.term} is trending`,
      badge: sourceCount > 1 ? `${sourceCount} sources` : null,
    });
  });
  // Newer snapshots carry only analyst-relevant headlines (impact is set).
  // Older ones carry every fetched headline; prefer the analyzed subset there
  // and fall back to the first two so the strip never shows a wall of noise.
  const news = s.news || [];
  const analyzedNews = news.filter((n) => n.impact);
  (analyzedNews.length > 0 ? analyzedNews : news.slice(0, 2)).forEach((n) =>
    chips.push({ icon: Newspaper, text: n.headline, color: '#56CCF2', title: n.note || n.headline }));

  if (chips.length === 0) {
    return (
      <div className="sp-signal-strip sp-signal-empty">
        <Sparkles size={14} />
        <span>No external signals were active - these are inventory-driven picks.</span>
      </div>
    );
  }

  return (
    <div className="sp-signal-strip">
      <span className="sp-signal-label">Why today?</span>
      <div className="sp-signal-chips" role="list">
        {chips.slice(0, 10).map((c, i) => {
          const Icon = c.icon;
          return (
            <span key={i} className="sp-signal-chip" style={{ '--chip': c.color }} title={c.title || c.text}>
              <Icon size={13} />
              <span>{c.text}</span>
              {c.badge && <em className="sp-chip-badge">{c.badge}</em>}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ── Single recommendation row (inbox-style) ─────────────────────────────────
// Each card carries a rail of actions on its right: the AI hand-off, the
// priority the recommender itself assigned, and the tasklist. The rail is
// rendered once and stays put whether the card is open or closed.
//
// Collapsed: one scannable line - rank, category icon, "{Action}: {product}"
// headline, first-sentence gist, confidence, chevron. Clicking the row expands
// the full detail inline: all products with stock/price, quantity hint, full
// rationale, cited signals, validity and the Execute hand-off. Expansion state
// lives in the parent so it survives category-tab switches.
function RecRow({ rec, index, expanded, onToggle, onAnalyse, onVote }) {
  const meta = CATEGORY_META[rec.category] || fallbackCat;
  const Icon = meta.icon;
  const actionLabel = ACTION_LABELS[rec.action_type] || rec.action_type;
  const tone = confidenceTone(rec.confidence || 0);
  const pct = Math.round((rec.confidence || 0) * 100);
  const left = daysUntil(rec.valid_through);
  const priority = priorityOf(rec);
  const [saved, setSaved] = useState(() => isSaved(rec));

  // Display name + the lead product (for the Analyse hand-off).
  const products = rec.products && rec.products.length
    ? rec.products
    : (rec.primary_skus || []).map((sku) => ({ sku, product_name: null }));
  const lead = products[0] || {};
  const leadName = lead.product_name || lead.sku || 'this product';
  const extraCount = products.length - 1;

  return (
    <div
      className={`sp-rec-row ${expanded ? 'sp-rec-row-open' : ''}`}
      style={{ '--cat': meta.color, animationDelay: `${index * 0.04}s` }}
    >
      {/* Summary line - the row toggles the detail; Execute stays clickable
          without expanding (it's a sibling of the toggle, not nested in it). */}
      <div className="sp-rec-row-line">
        <button
          type="button"
          className="sp-rec-row-summary"
          onClick={onToggle}
          aria-expanded={expanded}
        >
            <span className="sp-rec-row-rank">{String(rec.rank).padStart(2, '0')}</span>
          <span className="sp-rec-row-icon" title={meta.label}><Icon size={15} /></span>
          <span className="sp-rec-row-main">
            <span className="sp-rec-headline">
              <span className="sp-rec-headline-action">{actionLabel}:</span>
              <span className="sp-rec-headline-name">{leadName}</span>
              {extraCount > 0 && <span className="sp-rec-summary-more">+{extraCount} more</span>}
            </span>
            {!expanded && <span className="sp-rec-teaser">{firstSentence(rec.rationale).replace(/[.!?].*$/, '')}</span>}
          </span>
          <span className="sp-rec-row-side">
            <span className="sp-rec-conf-pill" style={{ color: tone.color }}>{pct}%</span>
            <ChevronDown size={16} className="sp-rec-chevron" />
          </span>
        </button>
        {onVote && rec.id != null && (
          <span className="sp-rec-vote">
            <button
              type="button"
              className={`sp-vote-btn ${rec.user_vote === 'up' ? 'sp-vote-on-up' : ''}`}
              title={rec.user_vote === 'up' ? 'Remove rating' : 'Good recommendation'}
              aria-label="Thumbs up"
              onClick={() => onVote(rec, 'up')}
            >
              <ThumbsUp size={14} />
            </button>
            <button
              type="button"
              className={`sp-vote-btn ${rec.user_vote === 'down' ? 'sp-vote-on-down' : ''}`}
              title={rec.user_vote === 'down' ? 'Remove rating' : 'Not useful'}
              aria-label="Thumbs down"
              onClick={() => onVote(rec, 'down')}
            >
              <ThumbsDown size={14} />
            </button>
          </span>
        )}
        <div className="sp-rec-rail">
          {onAnalyse && (
            <button
              type="button"
              className="sp-analyse-btn sp-rec-row-execute"
              onClick={() => onAnalyse(rec.rationale, leadName, meta.label)}
              title="Opens a new chat that walks through how to carry this out"
            >
              <Sparkles size={14} />
              <span>Ask AI how to execute</span>
              <ArrowRight size={14} />
            </button>
          )}
              <span className={`sp-rec-priority dp-tone-${priority.tone}`}>
            <AlertTriangle size={12} />
            {priority.label}
          </span>
          <button
            type="button"
            className={`sp-rec-task ${saved ? 'is-saved' : ''}`}
            onClick={() => { addTask(rec, { title: leadName, priority: priority.key }); setSaved(true); }}
            disabled={saved}
          >
            {saved ? <><Check size={13} /> In tasklist</> : <><ListChecks size={13} /> Add to tasklist</>}
          </button>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="sp-rec-detail">
          {/* Products */}
          <div className="sp-rec-products">
            {products.map((p, i) => (
              <div key={i} className="sp-rec-product">
                <Package size={13} />
                <span className="sp-rec-product-name">{p.product_name || p.sku}</span>
                {(p.on_hand != null || p.price != null) && (
                  <span className="sp-rec-product-meta">
                    {p.on_hand != null ? `${p.on_hand} on hand` : ''}
                    {p.on_hand != null && p.price != null ? ' · ' : ''}
                    {money(p.price) || ''}
                  </span>
                )}
              </div>
            ))}
          </div>

          {/* Quantity hint */}
          {rec.quantity_hint && (
            <div className="sp-rec-qty"><Tag size={13} /> {rec.quantity_hint}</div>
          )}

          {/* Rationale */}
          <p className="sp-rec-rationale">{rec.rationale}</p>

          {/* Signals cited */}
          {rec.signals_cited && rec.signals_cited.length > 0 && (
            <div className="sp-rec-signals">
              {rec.signals_cited.map((sig, i) => (
                <span key={i} className="sp-rec-sig">{sig.replace(/_/g, ' ')}</span>
              ))}
            </div>
          )}

          {/* Footer: confidence bar (behind SHOW_CARD_CONFIDENCE - this is
              the RAW `confidence` field, the number the reviewer measured
              as not a probability; see features.js) + validity + analyse */}
          <div className="sp-rec-footer">
            {SHOW_CARD_CONFIDENCE && (
              <div className="sp-rec-conf">
                <div className="sp-rec-conf-track">
                  <div className="sp-rec-conf-fill" style={{ width: `${pct}%`, background: tone.color }} />
                </div>
                <span className="sp-rec-conf-label" style={{ color: tone.color }}>{tone.label} · {pct}%</span>
              </div>
            )}
            {left != null && (
              <span className={`sp-rec-valid ${left < 0 ? 'sp-rec-valid-expired' : ''}`}>
                <Clock size={12} />
                {left < 0 ? 'Expired' : left === 0 ? 'Ends today' : `${left}d left`}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default SuggestionsPage;
