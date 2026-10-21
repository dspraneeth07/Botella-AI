/**
 * SIGNALS TODAY - the pure half of GET /api/signal-impact/today.
 *
 * "I want to see which external signals exist and their impact on the
 * recommendations; do not show me only reorder." This module turns the three
 * facts the database holds about one run day - the run's signal_snapshot, the
 * store's fitted signal_effects, and the run's cards - into one row per live
 * signal that an owner can read: what it is, when it is, what the weekly fit
 * found it does to each drink family here, and which cards it reached.
 *
 * NO DATABASE, NO CLOCK. Everything here is a function of its arguments, so
 * tests/signals-today-verify.js can pin the wording and the matching rules with
 * fixtures and run in CI's unit job. signalImpactService.signalsToday does the
 * queries and hands the rows in.
 *
 * NULL IS NOT ZERO, and "not measurable" is not "no effect". A signal whose
 * every fitted cell was refused is reported as `not_yet_measurable` with the
 * fit's own reason spelt out ("too few active days: 7 of 20 needed"); a signal
 * the fit has never seen is `not_fitted`. Neither carries a beta. Only a cell
 * the fit found usable - interval clear of zero, no refusal - is `measured`,
 * and only then does a number appear. The one way this surface could become a
 * lie is to let a refused cell read as a measured nothing, so the state words
 * are chosen here, once, and the frontend prints them.
 */

const WEATHER_KEYS = new Set(['heat_advisory', 'cold_snap', 'severe_weather']);
const WEATHER_LABEL = {
  heat_advisory: 'Heat advisory',
  cold_snap: 'Cold snap',
  severe_weather: 'Severe weather',
};
// Ticketmaster-derived category keys (app/signals/events.py keys_for_events):
// they stand for a CLASS of events, not one entry, so no snapshot row names them.
const EVENT_CLASS_LABEL = {
  event_nearby: 'Events nearby',
  event_sports: 'Sports events',
  event_concert: 'Concerts',
  event_arts: 'Arts & theatre events',
  event_festival: 'Festivals',
};
const LEAGUE_LABEL = { nfl: 'NFL', nba: 'NBA', mlb: 'MLB', nhl: 'NHL', mls: 'MLS', ncaa: 'College' };

// Facts about the store's own stock that the LLM-era validator let through as
// "signals". The same set signalImpactService flags on the ledger; mirrored
// here so this module stays dependency-free. They are never external, so they
// never appear in the rail unless a card actually cited one.
const INTERNAL_KEYS = new Set([
  'understock', 'overstock', 'overstock_severe', 'stockout', 'dead_stock',
  'lost_sale', 'dont_buy', 'new_arrival', 'area_winner', 'register_trend',
]);

const DOMAINS = ['weather', 'sports', 'events', 'holidays', 'news', 'social', 'internal'];

const lower = (v) => String(v == null ? '' : v).trim().toLowerCase();
const dateOnly = (v) => {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v));
  return m ? m[1] : null;
};
const humanize = (k) => String(k || '')
  .replace(/^event_/, '').replace(/^news_/, '').replace(/^trend_/, '')
  .replace(/_home_game$/, ' home game')
  .replace(/_/g, ' ')
  .replace(/^\w/, (c) => c.toUpperCase());

/** `'Heat Advisory'` -> `'heat_advisory'`: an NWS alert headline as a key. */
function alertKey(text) {
  return lower(text).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function snapshotLists(snapshot) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const arr = (v) => (Array.isArray(v) ? v.filter((e) => e && typeof e === 'object') : []);
  return {
    weather: s.weather && typeof s.weather === 'object' ? s.weather : null,
    sports: arr(s.sports),
    events: arr(s.events),
    holidays: arr(s.holidays),
    news: arr(s.news),
    social: arr(s.social),
    activeKeys: Array.isArray(s.active_keys) ? s.active_keys.map(lower).filter(Boolean) : null,
  };
}

/**
 * The keys live at the store on the run day, in display order.
 *
 * Precedence: the daily_store_signals row (migration 014) is the engine's own
 * untrimmed record and wins outright; the snapshot's active_keys is the same
 * list as the engine saw it; and a snapshot from before active_keys existed is
 * reconstructed from the entries' `.key` plus the weather alerts. Lowercased,
 * de-duplicated, order preserved.
 */
function activeKeysFor(snapshot, dailyActiveKeys) {
  if (Array.isArray(dailyActiveKeys) && dailyActiveKeys.length) {
    return [...new Set(dailyActiveKeys.map(lower).filter(Boolean))];
  }
  const s = snapshotLists(snapshot);
  if (s.activeKeys && s.activeKeys.length) return [...new Set(s.activeKeys)];
  const out = [];
  for (const list of [s.sports, s.events, s.holidays, s.news, s.social]) {
    for (const e of list) {
      const k = lower(e.key);
      if (k) out.push(k);
    }
  }
  if (s.weather && Array.isArray(s.weather.alerts)) {
    for (const a of s.weather.alerts) {
      const k = alertKey(a);
      if (k) out.push(k);
    }
  }
  return [...new Set(out)];
}

/** The snapshot entry a key names, with the list it came from, or null. */
function findEntry(key, s) {
  const k = lower(key);
  const byKey = (list) => list.find((e) => lower(e.key) === k) || null;
  const ORDER = [['holidays', s.holidays], ['events', s.events], ['news', s.news], ['social', s.social], ['sports', s.sports]];
  for (const [domain, list] of ORDER) {
    const e = byKey(list);
    if (e) return { domain, entry: e };
  }
  return null;
}

/**
 * Which feed a key belongs to.
 *
 * Internal first (a stock fact is never a feed), then the three weather keys,
 * then the key's own prefix - the Python signal clients namespace everything
 * they emit except holidays, which arrive bare (`halloween`, `day_of_dead`).
 * A key with no prefix that no snapshot entry claims is therefore a holiday
 * whose entry the display trim dropped, not a mystery.
 */
function domainOfKey(key, snapshot) {
  const k = lower(key);
  if (!k) return 'internal';
  if (INTERNAL_KEYS.has(k)) return 'internal';
  if (WEATHER_KEYS.has(k) || k.startsWith('weather_')) return 'weather';
  if (k.endsWith('_home_game')) return 'sports';
  if (k.startsWith('event_')) return 'events';
  if (k.startsWith('news_')) return 'news';
  if (k.startsWith('trend_')) return 'social';
  const hit = findEntry(k, snapshotLists(snapshot));
  if (hit) return hit.domain;
  return 'holidays';
}

/**
 * The human label and the date (or range) for a key, read from the run's own
 * snapshot. Never the bare key where an entry exists; the humanised key where
 * the display trim dropped the entry.
 */
function labelFor(key, snapshot) {
  const k = lower(key);
  const s = snapshotLists(snapshot);
  const domain = domainOfKey(k, snapshot);

  if (domain === 'weather') {
    const w = s.weather;
    const base = WEATHER_LABEL[k] || humanize(k);
    const hi = w && Number.isFinite(Number(w.high_f)) ? Math.round(Number(w.high_f)) : null;
    const lo = w && Number.isFinite(Number(w.low_f)) ? Math.round(Number(w.low_f)) : null;
    const temp = k === 'cold_snap' && lo != null ? `low ${lo}°` : hi != null ? `high ${hi}°` : null;
    const when = w ? rangeOf(w.window_start, w.window_end) : null;
    return { label: temp ? `${base} · ${temp}` : base, when };
  }

  if (domain === 'sports') {
    const league = k.replace(/_home_game$/, '');
    const games = s.sports.filter((g) => lower(g.league) === league && g.is_local_home !== false);
    if (!games.length) return { label: `${LEAGUE_LABEL[league] || league.toUpperCase()} home game`, when: null };
    const g = games[0];
    const parts = [`${g.away || 'Away'} @ ${g.home || 'Home'}`];
    if (g.venue) parts.push(g.venue);
    if (games.length > 1) parts.push(`+${games.length - 1} more home game${games.length > 2 ? 's' : ''}`);
    const dates = games.map((x) => dateOnly(x.date)).filter(Boolean).sort();
    const ends = games.map((x) => dateOnly(x.end_date)).filter(Boolean).sort();
    const last = [...dates, ...ends].sort().pop() || null;
    return { label: parts.join(' · '), when: rangeOf(dates[0] || null, last) };
  }

  if (domain === 'internal') return { label: humanize(k), when: null };

  const hit = findEntry(k, s);
  if (!hit) {
    if (EVENT_CLASS_LABEL[k]) {
      // A class key covers every event in the snapshot; its "when" is their span.
      const dates = s.events.map((e) => dateOnly(e.date)).filter(Boolean).sort();
      return { label: EVENT_CLASS_LABEL[k], when: dates.length ? rangeOf(dates[0], dates[dates.length - 1]) : null };
    }
    return { label: humanize(k), when: null };
  }
  const e = hit.entry;
  const title = e.title || e.name || e.headline || e.term || humanize(k);
  const parts = [hit.domain === 'social' ? `${title} · trending` : title];
  const venue = e.venue && (typeof e.venue === 'string' ? e.venue : e.venue.name);
  if (venue) parts.push(venue);
  return { label: parts.join(' · '), when: rangeOf(e.date, e.end_date) };
}

function rangeOf(from, to) {
  const a = dateOnly(from);
  const b = dateOnly(to);
  if (a && b && b !== a) return `${a}..${b}`;
  return a || b || null;
}

/* ── the fit's verdict, in words ─────────────────────────────────────────── */

const pct = (v) => {
  const n = Number(v) * 100;
  const s = `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
  return s;
};

/**
 * The refusal the fit recorded, as a sentence an owner can read. The vocabulary
 * is app/pipeline/elasticity/signal.py's `_refused` reasons; anything outside
 * it is shown as the fit wrote it rather than guessed at.
 */
function refusalInWords(reason) {
  const r = String(reason || '').trim();
  let m;
  if ((m = /^too_few_active_days:(\d+)<(\d+)$/.exec(r))) return `too few active days: ${m[1]} of ${m[2]} needed`;
  if ((m = /^too_few_days:(\d+)<(\d+)$/.exec(r))) return `too few days of data: ${m[1]} of ${m[2]} needed`;
  if ((m = /^too_few_residual_df:(\d+)<(\d+)$/.exec(r))) return `too few free observations after controls: ${m[1]} of ${m[2]} needed`;
  if (r === 'interval_spans_zero') return 'the interval spans zero - the data cannot tell the direction';
  if (r === 'signal_always_active:no_comparison_days') return 'the signal was active every day - nothing to compare against';
  if (r === 'singular_design:controls_collinear') return 'the controls are collinear - the fit could not separate the signal';
  if (r === 'non_finite_estimate') return 'the estimate was not finite';
  if ((m = /^implausible_beta:(.+)$/.exec(r))) return `an implausibly large estimate (${m[1]}) was refused as evidence about the data`;
  return r ? `the weekly fit refused: ${r}` : 'the weekly fit refused without a reason';
}

/**
 * One state and one sentence for a signal, over every family the fit tried.
 *
 *   measured            at least one usable cell: each is named with its beta,
 *                       interval and active days, strongest first.
 *   not_yet_measurable  cells exist and all were refused: the reason from the
 *                       best-covered cell, so the owner sees how far off it is.
 *   not_fitted          no cell at all.
 */
function stateOf(effects) {
  const fx = Array.isArray(effects) ? effects : [];
  if (!fx.length) {
    return { state: 'not_fitted', state_reason: 'no fit yet - the weekly fit has not seen this signal' };
  }
  const usable = fx.filter((e) => e.usable === true && e.beta != null);
  if (usable.length) {
    const words = usable
      .slice()
      .sort((a, b) => Math.abs(Number(b.beta)) - Math.abs(Number(a.beta)))
      .map((e) => `${e.category_family} ${pct(e.beta)} [${pct(e.interval_lo)}, ${pct(e.interval_hi)}]`
        + (e.active_days != null ? `, measured over ${e.active_days} active days` : ''));
    return { state: 'measured', state_reason: words.join('; ') };
  }
  // The cell closest to being measurable speaks for the signal: more active
  // days first, then more observations.
  const best = fx.slice().sort((a, b) => (Number(b.active_days) || 0) - (Number(a.active_days) || 0)
    || (Number(b.observations) || 0) - (Number(a.observations) || 0))[0];
  const families = [...new Set(fx.map((e) => e.category_family).filter(Boolean))];
  const scope = families.length ? ` (checked against ${families.join(', ')})` : '';
  // A cell the fit did not refuse but could not use has an interval across
  // zero: the GENERATED `usable` column is false and the reason is that one,
  // stated here rather than left to be inferred from two numbers (the same
  // rule signal_status_from_rows applies on the Python side).
  const reason = best.refused_reason || (best.beta != null ? 'interval_spans_zero' : null);
  return {
    state: 'not_yet_measurable',
    state_reason: `${refusalInWords(reason)}${scope}`,
  };
}

/* ── cards ───────────────────────────────────────────────────────────────── */

/**
 * The cards a signal reached, and how.
 *
 *   cited          the card's own text names the key (signals_cited).
 *   signal_impact  the card's stored disclosure block has a MEASURED entry for
 *                  the key - the fit found an effect on this card's family.
 *
 * Only a measured entry counts as "touched". The block lists every live key on
 * every card by design (it is a disclosure of what was examined), so counting
 * any entry would put "10 cards" beside every signal and say nothing. A card
 * whose entry for the key is `not_fitted` was examined and not affected.
 */
function cardsFor(key, cards) {
  const k = lower(key);
  const out = [];
  for (const c of Array.isArray(cards) ? cards : []) {
    if (!c || c.status === 'holdout') continue;
    const cited = (Array.isArray(c.signals_cited) ? c.signals_cited : [])
      .some((s) => lower(typeof s === 'string' ? s : (s && (s.key || s.kind))) === k);
    const measured = (Array.isArray(c.signal_impact) ? c.signal_impact : [])
      .some((e) => e && lower(e.signal_key) === k && e.state === 'measured');
    if (!cited && !measured) continue;
    const skus = Array.isArray(c.primary_skus) ? c.primary_skus : [];
    const firstName = Array.isArray(c.products) && c.products[0] && c.products[0].product_name;
    out.push({
      id: c.id,
      rank: c.rank,
      action_type: c.action_type,
      product: firstName || (skus.length ? String(skus[0]) : null),
      via: cited ? 'cited' : 'signal_impact',
    });
  }
  return out.sort((a, b) => (a.rank || 99) - (b.rank || 99));
}

/**
 * The whole answer, from facts already loaded.
 *
 * @param {object} input
 * @param {object|null} input.run             { id, rec_date } of the latest run
 * @param {object|null} input.snapshot        recommendation_runs.signal_snapshot
 * @param {string[]|null} input.dailyActiveKeys  daily_store_signals.active_keys for the day, if a row exists
 * @param {string|null} input.signalDate      daily_store_signals.signal_date when that row was used
 * @param {Map<string, object[]>|object} input.effectsByKey  signal_effects rows grouped by key (all families)
 * @param {object[]} input.cards              the run's recommendations (holdouts are skipped here anyway)
 */
function shapeSignalsToday(input) {
  const run = input.run || null;
  const snapshot = input.snapshot || {};
  const cards = (Array.isArray(input.cards) ? input.cards : []).filter((c) => c && c.status !== 'holdout');
  const fxMap = input.effectsByKey instanceof Map
    ? input.effectsByKey
    : new Map(Object.entries(input.effectsByKey || {}));
  const effectsOf = (k) => fxMap.get(k) || fxMap.get(lower(k)) || [];

  const live = activeKeysFor(snapshot, input.dailyActiveKeys);
  // A key a card named is live for the reader whether or not the feed listed
  // it: the card is on the screen saying so.
  const citedByAny = new Set();
  for (const c of cards) {
    for (const s of Array.isArray(c.signals_cited) ? c.signals_cited : []) {
      const k = lower(typeof s === 'string' ? s : (s && (s.key || s.kind)));
      if (k) citedByAny.add(k);
    }
  }
  const keys = [...new Set([...live, ...citedByAny])];

  const active = [];
  for (const key of keys) {
    const domain = domainOfKey(key, snapshot);
    const touched = cardsFor(key, cards);
    // A stock fact is not an external signal. It stays out unless a card's
    // own text named it, in which case it is shown for what it is.
    if (domain === 'internal' && !touched.some((c) => c.via === 'cited')) continue;
    const { label, when } = labelFor(key, snapshot);
    const fx = effectsOf(key).map((e) => ({
      category_family: e.category_family,
      beta: e.beta == null ? null : Number(e.beta),
      interval_lo: e.interval_lo == null ? null : Number(e.interval_lo),
      interval_hi: e.interval_hi == null ? null : Number(e.interval_hi),
      usable: e.usable === true,
      refused_reason: e.refused_reason || (e.usable ? null : 'interval_spans_zero'),
      active_days: e.active_days == null ? null : Number(e.active_days),
    }));
    const verdict = stateOf(fx);
    active.push({
      signal_key: key,
      domain,
      label,
      when,
      effects: fx,
      state: verdict.state,
      state_reason: verdict.state_reason,
      cards: touched,
    });
  }

  // Measured first - the only rows an owner can act on - then by domain in
  // the rail's order, then by name, so the list does not reshuffle between
  // loads for no reason.
  const STATE_RANK = { measured: 0, not_yet_measurable: 1, not_fitted: 2 };
  active.sort((a, b) => (STATE_RANK[a.state] - STATE_RANK[b.state])
    || (DOMAINS.indexOf(a.domain) - DOMAINS.indexOf(b.domain))
    || a.label.localeCompare(b.label));

  const withSignal = new Set();
  for (const s of active) for (const c of s.cards) withSignal.add(String(c.id));

  let fittedAt = null;
  for (const rows of fxMap.values()) {
    for (const e of rows || []) {
      if (e.fitted_at && (!fittedAt || new Date(e.fitted_at) > new Date(fittedAt))) fittedAt = e.fitted_at;
    }
  }

  return {
    run_id: run ? run.id : null,
    rec_date: run ? (run.rec_date || null) : null,
    signal_date: input.signalDate || (run ? (run.rec_date || null) : null),
    active,
    cards_total: cards.length,
    cards_with_signal: withSignal.size,
    effects_fitted_at: fittedAt,
  };
}

module.exports = {
  shapeSignalsToday,
  activeKeysFor,
  domainOfKey,
  labelFor,
  stateOf,
  refusalInWords,
  cardsFor,
  alertKey,
  INTERNAL_KEYS,
  WEATHER_KEYS,
  DOMAINS,
};
