#!/usr/bin/env node
/**
 * Signals today (GET /api/signal-impact/today) - the shaping, without a database.
 *
 * THE DEFECT. The Signals rail on the Recommendations screen listed sixteen live
 * keys at Bethany on 20 October 2026 and not one card mentioned any of them; the
 * owner read that as "the engine ignores the feeds". It had examined every one
 * and refused most for want of data, and nothing on the screen could say so.
 *
 * lib/signalsToday.js turns a run's snapshot, the store's fitted signal_effects
 * and the run's cards into one row per live signal with a label, a verdict in
 * words and the cards it reached. Pinned here with fixtures shaped like the real
 * Bethany run (run 813):
 *
 *   1  active keys: the daily row wins, then the snapshot's list, then the
 *      entries' .key plus weather alerts
 *   2  domain: internal before weather before prefix before snapshot; a bare
 *      key no entry claims is a holiday
 *   3  labels come from the snapshot entry (name + venue, team @ team + venue,
 *      headline, term · trending, weather word + temperature), never the bare
 *      key where an entry exists; the date or range rides along
 *   4  state words: a usable cell is `measured` with beta, interval and active
 *      days; all-refused is `not_yet_measurable` with the fit's reason spelt
 *      out and NO number; no cell is `not_fitted`
 *   5  cards: matched by signals_cited (via 'cited') or by a MEASURED
 *      signal_impact entry (via 'signal_impact'); a not_fitted entry does not
 *      count, holdouts never count
 *   6  internal keys stay out of `active` unless a card cited them
 *   7  the totals: cards_total, cards_with_signal, effects_fitted_at
 *   8  the persist path and getLatest carry the two 043 columns the house way,
 *      and the migration is idempotent with no GRANT (regex on source, as
 *      card-order-by-verify.js does, because the service opens a pool on load)
 *
 * Run:  node tests/signals-today-verify.js
 */

const path = require('path');
const fs = require('fs');

const today = require('../lib/signalsToday');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/* ── fixtures: the shape of run 813 at Bethany, trimmed ──────────────────── */

const SNAPSHOT = {
  weather: {
    summary: 'Clear', current_f: 66.2, high_f: 97, low_f: 54, alerts: ['Heat Advisory'],
    window_start: '2026-10-19', window_end: '2026-10-26', timezone: 'America/Chicago',
  },
  sports: [
    { league: 'nhl', away: 'Boston Bruins', home: 'Dallas Stars', date: '2026-10-20', venue: 'American Airlines Center', is_local_home: true },
    { league: 'nhl', away: 'Winnipeg Jets', home: 'Dallas Stars', date: '2026-10-22', venue: 'American Airlines Center', is_local_home: true },
    { league: 'nba', away: 'Phoenix Suns', home: 'Dallas Mavericks', date: '2026-10-21', venue: 'American Airlines Center', is_local_home: true },
  ],
  events: [
    { key: 'event_worlds_2026_swiss_1', name: 'Worlds 2026 - Swiss 1', venue: 'Credit Union of Texas Event Center', date: '2026-10-23', category: 'Sports' },
    { key: 'event_worlds_2026_swiss_2', name: 'Worlds 2026 - Swiss 2', venue: 'Credit Union of Texas Event Center', date: '2026-10-24', category: 'Sports' },
  ],
  holidays: [
    { key: 'halloween', name: 'Halloween', date: '2026-10-31', days_away: 11 },
    { key: 'day_of_dead', name: 'Day of the Dead', date: '2026-11-02', days_away: 13 },
  ],
  news: [{ key: 'news_inflation_pricing_pressure', headline: 'Inflation keeps pressure on shelf prices', date: '2026-10-19' }],
  social: [{ key: 'trend_tequila', term: 'tequila', source: 'reddit' }],
  active_keys: [
    'day_of_dead', 'event_nearby', 'event_sports', 'event_worlds_2026_swiss_1', 'event_worlds_2026_swiss_2',
    'halloween', 'nba_home_game', 'news_inflation_pricing_pressure', 'nhl_home_game', 'trend_tequila',
    'heat_advisory', 'understock',
  ],
};

const HEAT_BEER = {
  category_family: 'beer', beta: 0.15840922944565552, interval_lo: 0.0014565524494566107,
  interval_hi: 0.31536190644185447, observations: 172, active_days: 96, usable: true,
  refused_reason: null, fitted_at: '2026-10-19T05:37:46.209Z',
};
const refused = (family, reason, active_days, observations, fitted_at = '2026-10-18T05:00:00.000Z') => ({
  category_family: family, beta: null, interval_lo: null, interval_hi: null,
  observations, active_days, usable: false, refused_reason: reason, fitted_at,
});

const EFFECTS = new Map([
  ['heat_advisory', [HEAT_BEER, refused('wine', 'too_few_active_days:12<20', 12, 170)]],
  ['nhl_home_game', [
    refused('beer', 'too_few_active_days:7<20', 7, 120),
    refused('spirits', 'too_few_active_days:4<20', 4, 120),
  ]],
  ['day_of_dead', [refused('beer', 'too_few_days:1<120', 1, 1), refused('wine', 'too_few_days:1<120', 1, 1)]],
  ['understock', [refused('beer', 'singular_design:controls_collinear', 40, 200)]],
  // An inconclusive cell the fit did not mark refused: usable is false and the
  // reason is the spanning interval.
  ['trend_tequila', [{ category_family: 'spirits', beta: 0.02, interval_lo: -0.05, interval_hi: 0.09,
    observations: 90, active_days: 30, usable: false, refused_reason: null, fitted_at: '2026-10-17T05:00:00.000Z' }]],
]);

const impactFor = (family, measuredKeys = []) => SNAPSHOT.active_keys
  .filter((k) => k !== 'understock')
  .map((k) => (measuredKeys.includes(k)
    ? { signal_key: k, family, state: 'measured', beta: 0.158, interval_lo: 0.001, interval_hi: 0.315, reason: null, active_days: 96 }
    : { signal_key: k, family, state: k === 'nhl_home_game' ? 'not_measurable' : 'not_fitted', beta: null,
      interval_lo: null, interval_hi: null, reason: 'too_few_active_days:7<20', active_days: 7 }));

const CARDS = [
  { id: '3857', rank: 1, action_type: 'reorder', primary_skus: ['088004063849'], signals_cited: [], status: null,
    signal_impact: impactFor('beer', ['heat_advisory']) },
  { id: '3858', rank: 2, action_type: 'reorder', primary_skus: ['265731'], signals_cited: [], status: 'holdout',
    signal_impact: impactFor('beer', ['heat_advisory']) },
  { id: '3860', rank: 4, action_type: 'reorder', primary_skus: ['8410441000644'], signals_cited: [], status: null,
    signal_impact: impactFor('wine') },
  { id: '3866', rank: 10, action_type: 'bundle', primary_skus: ['080686010760', '721059002974'], signals_cited: [], status: null,
    signal_impact: impactFor('spirits') },
  { id: '3870', rank: 11, action_type: 'cold_box', primary_skus: ['111'], signals_cited: ['nhl_home_game'], status: null,
    products: [{ sku: '111', product_name: 'Modelo Especial 12pk' }], signal_impact: impactFor('beer') },
  { id: '3871', rank: 12, action_type: 'markdown', primary_skus: ['222'], signals_cited: ['understock'], status: null,
    signal_impact: [] },
];

/* ── 1. active keys ──────────────────────────────────────────────────────── */
console.log('\n── 1. Which keys are live ──────────────────────────────────────');
check('1a the daily_store_signals row is authoritative when present',
  JSON.stringify(today.activeKeysFor(SNAPSHOT, ['Halloween', 'nhl_home_game', 'nhl_home_game'])) === '["halloween","nhl_home_game"]');
check('1b otherwise the snapshot active_keys list, lowercased and de-duplicated',
  today.activeKeysFor(SNAPSHOT, null).length === SNAPSHOT.active_keys.length
    && today.activeKeysFor(SNAPSHOT, []).includes('heat_advisory'));
const legacy = { ...SNAPSHOT, active_keys: undefined };
const rebuilt = today.activeKeysFor(legacy, null);
check('1c a pre-active_keys snapshot is rebuilt from the entries\' .key plus weather alerts',
  rebuilt.includes('halloween') && rebuilt.includes('event_worlds_2026_swiss_1')
    && rebuilt.includes('news_inflation_pricing_pressure') && rebuilt.includes('trend_tequila')
    && rebuilt.includes('heat_advisory'),
  JSON.stringify(rebuilt));
check('1d an alert headline becomes a key the fit would recognise',
  today.alertKey('Heat Advisory') === 'heat_advisory' && today.alertKey(' Severe  Weather! ') === 'severe_weather');

/* ── 2. domains ──────────────────────────────────────────────────────────── */
console.log('\n── 2. Which feed a key belongs to ──────────────────────────────');
const dom = (k) => today.domainOfKey(k, SNAPSHOT);
check('2a weather keys', dom('heat_advisory') === 'weather' && dom('cold_snap') === 'weather' && dom('severe_weather') === 'weather');
check('2b *_home_game is sports', dom('nhl_home_game') === 'sports' && dom('nba_home_game') === 'sports');
check('2c event_* is events, including the class keys', dom('event_worlds_2026_swiss_1') === 'events' && dom('event_nearby') === 'events');
check('2d news_* and trend_*', dom('news_inflation_pricing_pressure') === 'news' && dom('trend_tequila') === 'social');
check('2e a bare key the snapshot claims', dom('halloween') === 'holidays' && dom('day_of_dead') === 'holidays');
check('2f a bare key no entry claims is a trimmed holiday, not a mystery', dom('thanksgiving') === 'holidays');
check('2g stock facts are internal, whatever the snapshot says', dom('understock') === 'internal' && dom('dead_stock') === 'internal');
check('2h every domain word is one the rail knows',
  ['heat_advisory', 'nhl_home_game', 'event_nearby', 'halloween', 'news_x', 'trend_x', 'understock', 'zzz']
    .every((k) => today.DOMAINS.includes(dom(k))));

/* ── 3. labels ───────────────────────────────────────────────────────────── */
console.log('\n── 3. Labels from the run\'s own snapshot ───────────────────────');
const lab = (k) => today.labelFor(k, SNAPSHOT);
check('3a an event: name · venue, dated',
  lab('event_worlds_2026_swiss_1').label === 'Worlds 2026 - Swiss 1 · Credit Union of Texas Event Center'
    && lab('event_worlds_2026_swiss_1').when === '2026-10-23', JSON.stringify(lab('event_worlds_2026_swiss_1')));
check('3b a holiday: its name, dated',
  lab('halloween').label === 'Halloween' && lab('halloween').when === '2026-10-31');
check('3c a home game: away @ home · venue, with the extra games counted and the span',
  lab('nhl_home_game').label === 'Boston Bruins @ Dallas Stars · American Airlines Center · +1 more home game'
    && lab('nhl_home_game').when === '2026-10-20..2026-10-22', JSON.stringify(lab('nhl_home_game')));
check('3d a single home game has no "+more" and one date',
  lab('nba_home_game').label === 'Phoenix Suns @ Dallas Mavericks · American Airlines Center'
    && lab('nba_home_game').when === '2026-10-21');
check('3e news: the headline', lab('news_inflation_pricing_pressure').label === 'Inflation keeps pressure on shelf prices');
check('3f social: the term, marked trending', lab('trend_tequila').label === 'tequila · trending');
check('3g weather: the word and the temperature, over the outlook window',
  lab('heat_advisory').label === 'Heat advisory · high 97°' && lab('heat_advisory').when === '2026-10-19..2026-10-26',
  JSON.stringify(lab('heat_advisory')));
check('3h cold snap quotes the low', lab('cold_snap').label === 'Cold snap · low 54°');
check('3i an event class key is named for the class and spans the events',
  lab('event_nearby').label === 'Events nearby' && lab('event_nearby').when === '2026-10-23..2026-10-24'
    && lab('event_sports').label === 'Sports events');
check('3j a key whose entry the trim dropped is humanised, never shown raw',
  lab('event_buddy_guy_moody').label === 'Buddy guy moody' && lab('event_buddy_guy_moody').when === null);
check('3k labels never leak the bare key when an entry exists',
  !Object.values(SNAPSHOT.active_keys).some((k) => lab(k).label === k && today.domainOfKey(k, SNAPSHOT) !== 'internal'));

/* ── 4. the verdict in words ─────────────────────────────────────────────── */
console.log('\n── 4. State and its sentence ───────────────────────────────────');
const measured = today.stateOf(EFFECTS.get('heat_advisory'));
check('4a a usable cell is measured, with beta, interval and active days, and the refused family is not quoted',
  measured.state === 'measured'
    && measured.state_reason === 'beer +15.8% [+0.1%, +31.5%], measured over 96 active days',
  measured.state_reason);
const refusedAll = today.stateOf(EFFECTS.get('nhl_home_game'));
check('4b all refused is not_yet_measurable, worded from the best-covered cell, with the families named',
  refusedAll.state === 'not_yet_measurable'
    && refusedAll.state_reason === 'too few active days: 7 of 20 needed (checked against beer, spirits)',
  refusedAll.state_reason);
check('4c a refusal carries NO number', !/\d+(\.\d+)?%/.test(refusedAll.state_reason));
const fewDays = today.stateOf(EFFECTS.get('day_of_dead'));
check('4d too_few_days reads as days of data', /^too few days of data: 1 of 120 needed/.test(fewDays.state_reason));
const spanning = today.stateOf(EFFECTS.get('trend_tequila'));
check('4e an interval across zero is named as inconclusive, and the beta the fit computed is withheld',
  spanning.state === 'not_yet_measurable' && /interval spans zero/.test(spanning.state_reason) && !/2\.0%/.test(spanning.state_reason),
  spanning.state_reason);
check('4f a key with no cell is not_fitted with the honest sentence',
  today.stateOf([]).state === 'not_fitted' && today.stateOf(undefined).state_reason === 'no fit yet - the weekly fit has not seen this signal');
check('4g every refusal in the fit\'s vocabulary has words',
  ['too_few_active_days:4<20', 'too_few_days:7<120', 'too_few_residual_df:3<10', 'interval_spans_zero',
    'signal_always_active:no_comparison_days', 'singular_design:controls_collinear', 'non_finite_estimate',
    'implausible_beta:+4.20|>|2.00'].every((r) => !today.refusalInWords(r).startsWith('the weekly fit refused:'))
    && today.refusalInWords('something_new') === 'the weekly fit refused: something_new');

/* ── 5. cards ────────────────────────────────────────────────────────────── */
console.log('\n── 5. The cards a signal reached ───────────────────────────────');
const heatCards = today.cardsFor('heat_advisory', CARDS);
check('5a a MEASURED signal_impact entry matches the card, via signal_impact',
  heatCards.length === 1 && heatCards[0].id === '3857' && heatCards[0].via === 'signal_impact'
    && heatCards[0].product === '088004063849' && heatCards[0].action_type === 'reorder',
  JSON.stringify(heatCards));
check('5b the holdout card with the same entry is not counted', !heatCards.some((c) => c.id === '3858'));
const nhlCards = today.cardsFor('nhl_home_game', CARDS);
check('5c a cited key matches via cited, with the first product NAME when known',
  nhlCards.length === 1 && nhlCards[0].via === 'cited' && nhlCards[0].product === 'Modelo Especial 12pk',
  JSON.stringify(nhlCards));
check('5d a not_fitted entry does not make a card "touched" - every card lists every live key',
  today.cardsFor('halloween', CARDS).length === 0 && today.cardsFor('event_nearby', CARDS).length === 0);
check('5e matching is case-insensitive on the key', today.cardsFor('NHL_HOME_GAME', CARDS).length === 1);

/* ── 6 + 7. the whole answer ─────────────────────────────────────────────── */
console.log('\n── 6. Internal keys, and the assembled answer ──────────────────');
const out = today.shapeSignalsToday({
  run: { id: 813, rec_date: '2026-10-19' },
  snapshot: SNAPSHOT,
  dailyActiveKeys: null,
  signalDate: null,
  effectsByKey: EFFECTS,
  cards: CARDS,
});
const byKey = new Map(out.active.map((s) => [s.signal_key, s]));
check('6a an internal key is listed only because a card cited it, under domain internal',
  byKey.has('understock') && byKey.get('understock').domain === 'internal'
    && byKey.get('understock').cards[0].via === 'cited');
const noCite = today.shapeSignalsToday({
  run: { id: 813, rec_date: '2026-10-19' }, snapshot: SNAPSHOT, dailyActiveKeys: null, signalDate: null,
  effectsByKey: EFFECTS, cards: CARDS.filter((c) => c.id !== '3871'),
});
check('6b the same internal key is excluded when no card cites it',
  !noCite.active.some((s) => s.signal_key === 'understock'));
check('6c every external live key is present', ['heat_advisory', 'nhl_home_game', 'nba_home_game', 'halloween',
  'day_of_dead', 'event_nearby', 'event_sports', 'event_worlds_2026_swiss_1', 'event_worlds_2026_swiss_2',
  'news_inflation_pricing_pressure', 'trend_tequila'].every((k) => byKey.has(k)),
JSON.stringify([...byKey.keys()]));
check('6d measured rows lead, then by domain order',
  out.active[0].signal_key === 'heat_advisory' && out.active[0].state === 'measured'
    && out.active.findIndex((s) => s.state === 'not_fitted') > out.active.findIndex((s) => s.state === 'not_yet_measurable'));
check('6e a row with no fit says not_fitted and carries no effects',
  byKey.get('halloween').state === 'not_fitted' && byKey.get('halloween').effects.length === 0);
check('6f every row has a label, a domain word, a state word and a sentence',
  out.active.every((s) => s.label && today.DOMAINS.includes(s.domain)
    && ['measured', 'not_yet_measurable', 'not_fitted'].includes(s.state) && s.state_reason));
check('6g effects on a row carry the refusal reason, and usable is a boolean',
  byKey.get('nhl_home_game').effects.every((e) => typeof e.usable === 'boolean' && e.refused_reason)
    && byKey.get('trend_tequila').effects[0].refused_reason === 'interval_spans_zero');
check('6h a cited key the feed never listed is still shown',
  today.shapeSignalsToday({ run: { id: 1 }, snapshot: {}, effectsByKey: new Map(),
    cards: [{ id: 1, rank: 1, action_type: 'pre_stock', primary_skus: ['x'], signals_cited: ['halloween'] }] })
    .active.some((s) => s.signal_key === 'halloween' && s.cards.length === 1));

console.log('\n── 7. Totals ───────────────────────────────────────────────────');
check('7a cards_total excludes holdouts', out.cards_total === 5, String(out.cards_total));
check('7b cards_with_signal counts a card once however many signals reached it', out.cards_with_signal === 3, String(out.cards_with_signal));
check('7c effects_fitted_at is the newest fit', out.effects_fitted_at === '2026-10-19T05:37:46.209Z', String(out.effects_fitted_at));
check('7d run_id, rec_date and signal_date (falling back to rec_date)',
  out.run_id === 813 && out.rec_date === '2026-10-19' && out.signal_date === '2026-10-19');
check('7e with a daily row its date is the signal_date',
  today.shapeSignalsToday({ run: { id: 1, rec_date: '2026-10-19' }, snapshot: SNAPSHOT,
    dailyActiveKeys: ['halloween'], signalDate: '2026-10-19', effectsByKey: new Map(), cards: [] }).signal_date === '2026-10-19');
const empty = today.shapeSignalsToday({ run: null, snapshot: {}, effectsByKey: new Map(), cards: [] });
check('7f no run at all is an empty answer, not a throw',
  empty.run_id === null && empty.active.length === 0 && empty.cards_total === 0);

/* ── 8. the persist path, getLatest, and the migration ───────────────────── */
console.log('\n── 8. Migration 043 and the two columns ────────────────────────');
const ROOT = path.join(__dirname, '..');
const service = fs.readFileSync(path.join(ROOT, 'services', 'recommendationService.js'), 'utf8');
const migration = fs.readFileSync(path.join(ROOT, 'database', 'analytics-migrations', '043_card_signal_impact.sql'), 'utf8');
const impactSvc = fs.readFileSync(path.join(ROOT, 'services', 'signalImpactService.js'), 'utf8');
const route = fs.readFileSync(path.join(ROOT, 'routes', 'signal-impact.js'), 'utf8');

check('8a persistRun probes for the signal_impact column before writing it',
  (service.match(/column_name = 'signal_impact' LIMIT 1/g) || []).length >= 2);
check('8b the INSERT writes both columns together, the block as JSON text and the sentence only when non-empty',
  /cols\.push\('signal_impact', 'signal_impact_summary'\)/.test(service)
    && /Array\.isArray\(r\.signal_impact\) \? JSON\.stringify\(r\.signal_impact\) : null/.test(service)
    && /typeof r\.signal_impact_summary === 'string' && r\.signal_impact_summary\.trim\(\)\.length/.test(service));
check('8c getLatest selects both under the probe and exposes an array and a string-or-null',
  /\$\{hasSignalImpact \? ', signal_impact, signal_impact_summary' : ''\}/.test(service)
    && /signal_impact: hasSignalImpact && Array\.isArray\(i\.signal_impact\) \? i\.signal_impact : \[\]/.test(service));
check('8d the migration adds both columns idempotently', /ADD COLUMN IF NOT EXISTS signal_impact\s+jsonb/.test(migration)
  && /ADD COLUMN IF NOT EXISTS signal_impact_summary text/.test(migration));
check('8e the migration is transactional and writes no GRANT', /^BEGIN;/m.test(migration) && /^COMMIT;/m.test(migration) && !/^\s*GRANT/m.test(migration));
check('8f the migration comments both columns and documents the rollback',
  /COMMENT ON COLUMN recommendations\.signal_impact IS/.test(migration)
    && /COMMENT ON COLUMN recommendations\.signal_impact_summary IS/.test(migration)
    && /DROP COLUMN IF EXISTS signal_impact_summary/.test(migration));
check('8g the service exports signalsToday and the route serves /today under {data}',
  /signalsToday,/.test(impactSvc) && /router\.get\('\/today'/.test(route) && /impact\.signalsToday\(/.test(route));
check('8h the service probes every optional table and column it touches',
  /column_name = 'rec_date'/.test(impactSvc) && /column_name = 'signal_impact'/.test(impactSvc)
    && /to_regclass\('public\.daily_store_signals'\)/.test(impactSvc));

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures ? 1 : 0);
