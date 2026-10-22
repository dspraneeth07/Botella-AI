// SignalsModal.js
// -----------------------------------------------------------------------------
// The "Active Signals" button + its clustered pop-up.
//
// The old "Why today?" strip crammed every external signal into one scrolling
// row. This turns it into a single button ("Live signals · N active") that
// opens a modal with a domain sidebar - Weather, Sports, Events, Holidays,
// News, Social - plus an "All" tab. Clicking a domain on the left shows the
// signals Botella pulled from it on the right, so the same feed reads
// professionally on the Dashboard, Summary and AI Recommendations pages.
//
// Everything is derived from the recommendation run's `signal_snapshot` - the
// exact object the Python service returns (weather / sports / events /
// holidays / news / social). No new data source.
// -----------------------------------------------------------------------------

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Radar, CloudSun, Trophy, MapPin, CalendarDays, Newspaper, TrendingUp,
  X, Sparkles, ChevronRight,
} from 'lucide-react';
import { formatLocalDate } from '../utils/date';
import './SignalsModal.css';

/* ── Date helpers ────────────────────────────────────────────────────────── */
const dShort = (d) => (d ? formatLocalDate(d, { month: 'short', day: 'numeric' }) : '');
const dRange = (a, b) => {
  if (!a) return '';
  if (!b || b === a) return dShort(a);
  return `${dShort(a)} to ${dShort(b)}`;
};

/* ── Domain definitions ──────────────────────────────────────────────────── */
// Colour groups signals by KIND, using the brand cuts - the same four the
// recommendation chips use (RecommendationsHome.css), so a "weather" signal is
// the same colour wherever it appears. Six arbitrary hues (sky, emerald,
// purple, amber, blue, pink) belonged to no palette and matched nothing.
//
// Each entry also carries an icon and a text label, so colour is never the only
// thing telling two domains apart.
//
//   cyan     the calendar and the sky   weather, holidays
//   fuchsia  things happening nearby    events, sports
//   plum     people                     social
//   neutral  reporting                  news
const SIG_CYAN = '#56CCF2';
const SIG_FUCHSIA = '#F58BC6';
const SIG_PLUM = '#C4A6FF';
const SIG_NEUTRAL = '#90909C';

// Exported for the Recommendations rail (SignalImpactRail), so a signal wears
// the same icon and colour there as it does in this modal.
export const DOMAIN_META = {
  weather:  { label: 'Weather',  icon: CloudSun,     color: SIG_CYAN },
  sports:   { label: 'Sports',   icon: Trophy,       color: SIG_FUCHSIA },
  events:   { label: 'Events',   icon: MapPin,       color: SIG_FUCHSIA },
  holidays: { label: 'Holidays', icon: CalendarDays, color: SIG_CYAN },
  news:     { label: 'News',     icon: Newspaper,    color: SIG_NEUTRAL },
  social:   { label: 'Social',   icon: TrendingUp,   color: SIG_PLUM },
};
const DOMAIN_ORDER = ['weather', 'sports', 'events', 'holidays', 'news', 'social'];

/* Keep the analyst summary, drop the source post.
   -----------------------------------------------------------------------------
   The trend feed hands us a summary with the post it was drawn from appended:

     "Multiple posts discuss tequila experiences and pricing; feature value
      tequila options ... · X: @Nicosaesthetic: "$29 for 2 shots of house
      tequila and you're wondering why nightlife is dying?""

   Everything from " · X: @handle:" onwards is somebody else's words, reproduced
   inside our product with no editorial control and no licence. One of them was
   crude enough to reach a customer demo. Dropping `t.evidence` handles the
   usual shape; this handles the case where the quote is already inside the
   summary field, which is how the Irish whiskey item arrived.

   Deliberately conservative: it cuts at a platform attribution or a URL, and
   otherwise returns the text untouched. A summary that happens to contain a
   colon keeps its colon. */
const SOURCE_CUT = /\s*[·|-]?\s*(?:\b(?:X|Twitter|Reddit|TikTok|Instagram|YouTube|Threads)\b\s*:|@[A-Za-z0-9_]{2,}\s*:|https?:\/\/)/i;

export function summarise(text) {
  if (!text) return '';
  let out = String(text).split(SOURCE_CUT)[0].trim();
  // A trailing separator or quote-opener means the cut landed mid-attribution.
  out = out.replace(/\s*[·|-]\s*$/, '').replace(/["“”]\s*$/, '').trim();
  // What survives has to be a sentence, not the run-up to one. "See" is what is
  // left of "See https://t.co/..." and reads as a truncation bug on the card;
  // an empty detail just renders nothing, which is the honest outcome.
  if (out.length < 15 && out.length < String(text).trim().length / 2) return '';
  return out;
}

/* Turn a raw signal_snapshot into per-domain lists of display items:
   { id, label, icon, color, items: [{ title, detail, when, badge }] }.
   Exported so callers can read a live count without opening the modal. */
export function buildSignalDomains(snapshot) {
  const s = snapshot || {};
  const out = {};
  const push = (dom, item) => { (out[dom] = out[dom] || []).push(item); };

  // Weather - usually one summarised outlook object.
  if (s.weather && (s.weather.summary || s.weather.high_f != null)) {
    const w = s.weather;
    const hi = w.high_f != null ? `${Math.round(w.high_f)}°` : '';
    const lo = w.low_f != null ? `${Math.round(w.low_f)}°` : '';
    const bits = [];
    if (w.window_start && w.window_end) bits.push(`Outlook ${dShort(w.window_start)} - ${dShort(w.window_end)}`);
    if (hi) bits.push(`High ${hi}${w.high_date ? ` (${dShort(w.high_date)})` : ''}`);
    if (lo) bits.push(`Low ${lo}${w.low_date ? ` (${dShort(w.low_date)})` : ''}`);
    push('weather', {
      title: w.summary || 'Weather outlook',
      detail: bits.join(' · '),
      when: hi ? `${hi}` : '',
    });
  }

  // Sports - local home games only (national games in old snapshots are dropped).
  (s.sports || []).filter((g) => g.is_local_home).forEach((g) => {
    push('sports', {
      title: `${g.away || 'Away'} @ ${g.home || 'Home'}`,
      detail: [g.games > 1 ? `${g.games}-game home series` : null, g.note].filter(Boolean).join(' · '),
      when: dRange(g.date, g.end_date),
    });
  });

  // Events - pre-screened for liquor relevance, biggest draw first.
  (s.events || []).forEach((e) => {
    push('events', {
      title: e.name || 'Local event',
      detail: [e.venue, e.nights > 1 ? `${e.nights} nights` : null, e.note].filter(Boolean).join(' · '),
      when: dShort(e.date),
      badge: e.draw === 'major' ? 'Major' : null,
    });
  });

  // Holidays.
  (s.holidays || []).forEach((h) => {
    push('holidays', {
      title: h.name || 'Holiday',
      detail: h.days_away != null ? (h.days_away === 0 ? 'Today' : `${h.days_away} day${h.days_away === 1 ? '' : 's'} away`) : '',
      when: dShort(h.date),
    });
  });

  // News - prefer analyst-relevant headlines (impact set) when present.
  const news = s.news || [];
  const analyzed = news.filter((n) => n.impact);
  (analyzed.length ? analyzed : news).forEach((n) => {
    push('news', {
      title: summarise(n.headline || 'Headline'),
      // Same rule as social: the analyst line, never the post it quotes.
      detail: summarise(n.note || n.impact || ''),
      when: dShort(n.date),
    });
  });

  // Social trends (Reddit / YouTube / Google Trends).
  //
  // `t.evidence` is NOT rendered. It carries the source post verbatim, and the
  // panel was reprinting strangers' posts word for word inside the product -
  // including a crude one under "tequila · trending". We have no editorial
  // control over that text, no licence to republish it, and a store owner does
  // not need the tweet to act on the trend. The summary and the counts say
  // everything the recommendation rests on.
  (s.social || []).forEach((t) => {
    const src = t.source || '';
    const bits = [];
    if (src.includes('reddit')) bits.push(`${t.mentions || 1} Reddit${t.score ? ` · ${t.score} upvotes` : ''}`);
    if (src.includes('youtube')) bits.push(`${t.mentions || 1} YouTube${t.score ? ` · ${Number(t.score).toLocaleString()} views` : ''}`);
    if (t.momentum === 'rising') bits.push(`search rising${t.interest != null ? ` (${t.interest}/100)` : ''}`);
    push('social', {
      title: `${t.term || 'Trend'} · trending`,
      detail: [summarise(t.note), bits.join(' · ')].filter(Boolean).join(' · '),
      when: '',
      badge: bits.length > 1 ? `${bits.length} sources` : null,
    });
  });

  const domains = DOMAIN_ORDER
    .filter((id) => (out[id] || []).length > 0)
    .map((id) => ({ id, ...DOMAIN_META[id], items: out[id] }));
  const total = domains.reduce((n, d) => n + d.items.length, 0);
  return { domains, total };
}

/* Count of active signals - cheap, for the button label. */
export function signalCount(snapshot) {
  return buildSignalDomains(snapshot).total;
}

/* ── One signal row ──────────────────────────────────────────────────────── */
function SignalRow({ item, color, icon: Icon }) {
  return (
    <li className="sig-row" style={{ '--sig': color }}>
      <span className="sig-row-icon"><Icon size={15} /></span>
      <div className="sig-row-body">
        <div className="sig-row-top">
          <span className="sig-row-title">{item.title}</span>
          {item.badge && <span className="sig-row-badge">{item.badge}</span>}
          {item.when && <span className="sig-row-when">{item.when}</span>}
        </div>
        {item.detail && <p className="sig-row-detail">{item.detail}</p>}
      </div>
    </li>
  );
}

/* ── The modal ───────────────────────────────────────────────────────────── */
export function SignalsModal({ snapshot, open, onClose, initialTab = 'all' }) {
  const { domains, total } = useMemo(() => buildSignalDomains(snapshot), [snapshot]);
  const [active, setActive] = useState('all');

  // Open on the tab the caller asked for - a source chip on a card opens the
  // popup on THAT source (22 Oct 2026) - or on All when the domain has no
  // signals today. Escape closes.
  useEffect(() => {
    if (!open) return undefined;
    const wanted = String(initialTab || 'all');
    setActive(wanted !== 'all' && domains.some((d) => d.id === wanted) ? wanted : 'all');
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose, initialTab, domains]);

  if (!open) return null;

  const tabs = [{ id: 'all', label: 'All', icon: Radar, color: '#B79CFF', count: total }]
    .concat(domains.map((d) => ({ id: d.id, label: d.label, icon: d.icon, color: d.color, count: d.items.length })));
  const shownDomains = active === 'all' ? domains : domains.filter((d) => d.id === active);

  return (
    <div className="sig-overlay" role="dialog" aria-modal="true" aria-label="Active signals" onMouseDown={onClose}>
      <div className="sig-modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="sig-modal-head">
          <div className="sig-modal-titles">
            <span className="sig-modal-kicker"><Radar size={13} /> Live signals</span>
            <h2 className="sig-modal-title">{total} active signal{total === 1 ? '' : 's'} shaping today’s picks</h2>
          </div>
          <button type="button" className="sig-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>

        {total === 0 ? (
          <div className="sig-empty">
            <Sparkles size={26} />
            <p>No external signals are active right now. Today’s recommendations are driven by your own inventory and sales.</p>
          </div>
        ) : (
          <div className="sig-body">
            {/* Left: domain sidebar */}
            <nav className="sig-nav" aria-label="Signal domains">
              {tabs.map((t) => {
                const Icon = t.icon;
                return (
                  <button
                    key={t.id}
                    type="button"
                    className={`sig-nav-btn ${active === t.id ? 'is-on' : ''}`}
                    onClick={() => setActive(t.id)}
                    style={{ '--sig': t.color }}
                  >
                    <span className="sig-nav-icon"><Icon size={16} /></span>
                    <span className="sig-nav-label">{t.label}</span>
                    <span className="sig-nav-count">{t.count}</span>
                    <ChevronRight size={14} className="sig-nav-caret" />
                  </button>
                );
              })}
            </nav>

            {/* Right: the signals for the active domain */}
            <div className="sig-content">
              {shownDomains.map((d) => (
                <section key={d.id} className="sig-group">
                  {active === 'all' && (
                    <h3 className="sig-group-head" style={{ '--sig': d.color }}>
                      <d.icon size={14} /> {d.label} <em>{d.items.length}</em>
                    </h3>
                  )}
                  <ul className="sig-list">
                    {d.items.map((it, i) => <SignalRow key={i} item={it} color={d.color} icon={d.icon} />)}
                  </ul>
                </section>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── The button (opens the modal it owns) ────────────────────────────────── */
export default function ActiveSignalsButton({ snapshot, variant = 'bar', className = '' }) {
  const [open, setOpen] = useState(false);
  const { domains, total } = useMemo(() => buildSignalDomains(snapshot), [snapshot]);
  const onClose = useCallback(() => setOpen(false), []);

  // A few domain icons as a live preview inside the bar variant.
  const preview = domains.slice(0, 5);

  return (
    <>
      <button
        type="button"
        className={`sig-btn sig-btn-${variant} ${className}`}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        title={total ? `View ${total} active signal${total === 1 ? '' : 's'}` : 'No active signals right now'}
      >
        <span className="sig-btn-pulse" aria-hidden="true"><Radar size={15} /></span>
        <span className="sig-btn-label">Live signals</span>
        {variant === 'bar' && preview.length > 0 && (
          <span className="sig-btn-preview" aria-hidden="true">
            {preview.map((d) => (
              <span key={d.id} className="sig-btn-dot" style={{ '--sig': d.color }}><d.icon size={11} /></span>
            ))}
          </span>
        )}
        <span className={`sig-btn-count ${total ? 'is-live' : ''}`}>{total} active</span>
      </button>
      <SignalsModal snapshot={snapshot} open={open} onClose={onClose} />
    </>
  );
}
