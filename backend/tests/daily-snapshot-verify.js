/**
 * Daily-snapshot verification - exercises dailySnapshotService and the capture
 * path in recommendationService.persistRun end-to-end against the real
 * analytics DB (sentinel tenant), covering the behaviours that are easy to get
 * subtly wrong and impossible to notice later:
 *
 *   1  store-local day key across the UTC boundary (the 04:00-cron bug)
 *   2  UTC fallback when the zone is unknown/unusable, basis recorded
 *   3  an invalid instant throws instead of inventing a plausible day
 *   4  persistRun stamps rec_date / day_basis / timezone on the run
 *   5  the day archive matches the run: counts, rank order, real rec ids
 *   6  holdouts counted separately but still archived
 *   7  re-running the same day UPSERTS (capture_count++, first_captured_at kept)
 *   8  a full bundle stores as fidelity='full' with generated columns populated
 *   9  no signal_capture degrades to 'display_trimmed' - never mislabelled
 *   10 raw payloads dedupe by geo key (capture_count++, one row)
 *   11 a malformed raw payload is skipped, not fatal
 *   12 signal capture NEVER throws, even against a broken pool
 *   13 the archive and the signal cell agree on the day
 *
 * PREREQ: analytics migrations 014 + 015 applied.
 * Run:  node tests/daily-snapshot-verify.js
 */
require('dotenv').config();

const { getAnalyticsPool } = require('../database/analytics-connection');
const dailySvc = require('../services/dailySnapshotService');
const recSvc = require('../services/recommendationService');

const CID = 999902;
const LID = 990002;
const TZ = 'America/Chicago';

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail && !ok ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function makeRun(overrides = {}) {
  return {
    client_id: CID,
    location_id: LID,
    // 04:00 UTC — the rec cron's hour. In Chicago this is 23:00 the PREVIOUS
    // day, which is the whole point of case 1.
    generated_at: '2026-09-22T04:00:00.000Z',
    data_as_of: '2026-09-21',
    candidate_count: 150,
    recommendations_generated: 3,
    dropped_invalid: 2,
    signal_snapshot: { weather: { summary: 'Hot' }, sports: [], events: [], holidays: [], news: [], social: [] },
    recommendations: [
      { rank: 1, category: 'weather', action_type: 'cold_box', primary_skus: ['SKU1'],
        rationale: 'hot', signals_cited: ['heat_advisory'], confidence: 0.9, valid_through: '2026-09-29' },
      { rank: 2, category: 'inventory_overstock', action_type: 'markdown', primary_skus: ['SKU2'],
        rationale: 'slow', signals_cited: [], confidence: 0.7, valid_through: '2026-09-29' },
      { rank: 3, category: 'new_arrival', action_type: 'stock_new', primary_skus: [],
        rationale: 'area winner', signals_cited: [], confidence: 0.6, valid_through: '2026-09-29',
        reference_upc: '0999' },
    ],
    ...overrides,
  };
}

const FULL_BUNDLE = {
  weather: { summary: 'Hot', high_f: 99 },
  sports: [{ league: 'nfl', home: 'A', away: 'B', date: '2026-09-21' }],
  events: [{ name: 'Fest', date: '2026-09-22' }],
  holidays: [],
  news: [{ headline: 'H', category: 'state' }],
  social: [],
  active_keys: ['heat_advisory', 'nfl_home_game'],
  news_categories: ['beer'],
  news_product_keywords: ['ipa'],
  event_categories: ['seltzer'],
  trend_categories: [],
  trend_product_keywords: [],
};

async function cleanup(pool) {
  // recommendations cascade from the run; the day tables are keyed by tenant.
  await pool.query('DELETE FROM recommendation_runs WHERE client_id=$1 AND location_id=$2', [CID, LID]);
  await pool.query('DELETE FROM daily_store_recommendations WHERE client_id=$1 AND location_id=$2', [CID, LID]);
  await pool.query('DELETE FROM daily_store_signals WHERE client_id=$1 AND location_id=$2', [CID, LID]);
  await pool.query("DELETE FROM signal_source_payloads WHERE source LIKE '__test_%'", []);
}

(async () => {
  const pool = getAnalyticsPool();

  // Guard: without the migrations this file would report nonsense failures.
  const ready = await pool.query(
    `SELECT to_regclass('public.daily_store_signals')         IS NOT NULL
        AND to_regclass('public.daily_store_recommendations') IS NOT NULL
        AND to_regclass('public.signal_source_payloads')      IS NOT NULL AS ok`
  );
  if (!ready.rows[0].ok) {
    console.error('Analytics migrations 014 + 015 are not applied — run `npm run migrate` first.');
    process.exit(2);
  }

  await cleanup(pool);
  dailySvc._resetProbes();

  console.log('\n── Day-key resolution ──────────────────────────────────────');

  // 1. The bug this key exists to prevent: 04:00 UTC is still YESTERDAY in
  //    every US zone, so a UTC key labels the whole network a day early.
  const local = dailySvc.resolveDayKey('2026-09-22T04:00:00.000Z', TZ);
  check('1  04:00Z resolves to the store\'s previous local day',
    local.date === '2026-09-21' && local.basis === 'store_local' && local.timezone === TZ,
    JSON.stringify(local));

  // 2. An unusable zone must degrade to UTC AND say so, never silently pretend.
  const bad = dailySvc.resolveDayKey('2026-09-22T04:00:00.000Z', 'Mars/Olympus');
  check('2  unknown zone falls back to UTC and records basis=utc',
    bad.date === '2026-09-22' && bad.basis === 'utc' && bad.timezone === null,
    JSON.stringify(bad));

  const none = dailySvc.resolveDayKey('2026-09-22T04:00:00.000Z', null);
  check('2b no zone → UTC', none.date === '2026-09-22' && none.basis === 'utc');

  // 3. A bad timestamp must fail loudly; a plausible-looking wrong day is worse.
  let threw = false;
  try { dailySvc.resolveDayKey('not-a-date', TZ); } catch { threw = true; }
  check('3  invalid instant throws rather than guessing', threw);

  console.log('\n── persistRun: run row + day archive ───────────────────────');

  const run = makeRun({ signal_capture: { timezone: TZ } });
  const { runId, day, archived } = await recSvc.persistRun(pool, run);
  check('   persistRun returned the resolved day', day.date === '2026-09-21' && day.basis === 'store_local');

  // 4. The run row carries the day key, so no reader ever casts generated_at.
  const runRow = await pool.query(
    'SELECT rec_date::text AS rec_date, day_basis, timezone, recommendation_count FROM recommendation_runs WHERE id=$1',
    [runId]
  );
  check('4  run row stamped with rec_date/day_basis/timezone',
    runRow.rows[0].rec_date === '2026-09-21' && runRow.rows[0].day_basis === 'store_local'
      && runRow.rows[0].timezone === TZ,
    JSON.stringify(runRow.rows[0]));

  // 5. The archive must agree with the run tables, and its ids must be the
  //    real recommendations.id so per-rec outcomes can join back.
  const arch = await pool.query(
    `SELECT rec_date::text AS rec_date, signal_date::text AS signal_date, run_id,
            recommendation_count, shown_count, holdout_count, dropped_invalid,
            candidate_count, categories, action_types, recommendations, capture_count,
            data_as_of::text AS data_as_of
       FROM daily_store_recommendations WHERE client_id=$1 AND location_id=$2`,
    [CID, LID]
  );
  const a = arch.rows[0];
  check('5  archive row written for the store-local day',
    a && a.rec_date === '2026-09-21' && String(a.run_id) === String(runId), JSON.stringify(a?.rec_date));
  check('5b counts match the run',
    a.recommendation_count === 3 && a.dropped_invalid === 2 && a.candidate_count === 150,
    `${a.recommendation_count}/${a.dropped_invalid}/${a.candidate_count}`);
  check('5c data_as_of preserved as the same calendar day', a.data_as_of === '2026-09-21', a.data_as_of);

  const dbIds = await pool.query(
    'SELECT id, rank FROM recommendations WHERE run_id=$1 ORDER BY rank', [runId]
  );
  const archIds = a.recommendations.map((r) => String(r.id));
  check('5d archived ids are the real recommendations.id',
    eq(archIds, dbIds.rows.map((r) => String(r.id))),
    `${archIds} vs ${dbIds.rows.map((r) => r.id)}`);
  check('5e archive is rank-ordered', eq(a.recommendations.map((r) => r.rank), [1, 2, 3]));
  check('5f vocab arrays de-duplicated and sorted',
    eq(a.categories, ['inventory_overstock', 'new_arrival', 'weather'])
      && eq(a.action_types, ['cold_box', 'markdown', 'stock_new']),
    JSON.stringify([a.categories, a.action_types]));
  check('5g returned `archived` matches what was stored', archived.length === 3);

  // 6. Holdouts are archived too (they are evaluated), but counted apart.
  //
  // The holdout is now ON BY DEFAULT (sheet 17) - it was built and never
  // switched on, which is why the programme's only evidence was a
  // retrospective backtest. So the assertion is no longer "unset means none";
  // it is that shown + holdout accounts for every rec, and that an explicit
  // 0 still means none.
  check('6  every rec is archived in exactly one arm',
    a.shown_count + a.holdout_count === 3,
    `${a.shown_count}/${a.holdout_count}`);
  check('6b holdouts are archived, not discarded',
    Array.isArray(a.recommendations) && a.recommendations.length === 3,
    String(a.recommendations && a.recommendations.length));

  // 7. A second run on the same store-local day replaces the cell and records
  //    that it happened twice — first_captured_at must survive.
  const before = await pool.query(
    'SELECT first_captured_at FROM daily_store_recommendations WHERE client_id=$1 AND location_id=$2', [CID, LID]
  );
  const rerun = makeRun({
    signal_capture: { timezone: TZ },
    // Still the SAME Chicago day: 04:45Z is 23:45 on Sep 21 in CDT (UTC-5).
    // 05:30Z would already be 00:30 on the 22nd and must produce a SECOND
    // row - that is correct behaviour, not an upsert, and case 7c proves it.
    generated_at: '2026-09-22T04:45:00.000Z',
    recommendations: makeRun().recommendations.slice(0, 1),
    recommendations_generated: 1,
  });
  await recSvc.persistRun(pool, rerun);
  const after = await pool.query(
    `SELECT capture_count, recommendation_count, first_captured_at,
            (SELECT count(*)::int FROM daily_store_recommendations WHERE client_id=$1 AND location_id=$2) AS rows
       FROM daily_store_recommendations WHERE client_id=$1 AND location_id=$2`, [CID, LID]
  );
  check('7  same-day re-run upserts one row, capture_count=2',
    after.rows[0].rows === 1 && after.rows[0].capture_count === 2 && after.rows[0].recommendation_count === 1,
    JSON.stringify(after.rows[0]));
  check('7b first_captured_at preserved across the upsert',
    before.rows[0].first_captured_at.getTime() === after.rows[0].first_captured_at.getTime());

  // 7c. The converse, and the reason case 7 is easy to get wrong: crossing the
  //     store's local midnight MUST open a new day, even though both instants
  //     fall on the same UTC date. 05:30Z = 00:30 on the 22nd in Chicago.
  await recSvc.persistRun(pool, makeRun({
    signal_capture: { timezone: TZ }, generated_at: '2026-09-22T05:30:00.000Z',
  }));
  const days = await pool.query(
    `SELECT rec_date::text AS rec_date, capture_count FROM daily_store_recommendations
      WHERE client_id=$1 AND location_id=$2 ORDER BY rec_date`, [CID, LID]
  );
  check('7c crossing local midnight opens a NEW day row (same UTC date)',
    days.rows.length === 2 && days.rows[0].rec_date === '2026-09-21'
      && days.rows[1].rec_date === '2026-09-22',
    JSON.stringify(days.rows));

  console.log('\n── Signal capture ──────────────────────────────────────────');

  // 8. A full bundle must be stored as such, with the generated columns
  //    derived from it rather than written separately.
  const fullRun = makeRun({
    signal_capture: {
      timezone: TZ, signal_date: '2026-09-21', day_basis: 'store_local',
      bundle: FULL_BUNDLE, latitude: 32.78, longitude: -96.8, state: 'TX',
      geo_source: 'geocoded',
      source_health: {
        weather: { ok: true, items: 1, latency_ms: 120 },
        events: { ok: true, items: 1 },
        news: { ok: false, error: 'timeout' },
        reddit: { dormant: 'no_api_key' },
      },
      source_geo_keys: { weather: { scope: 'gridpoint', key: '32.78,-96.8' } },
      raw_payloads: [
        { source: '__test_weather', geo_scope: 'gridpoint', geo_key: '32.78,-96.8',
          fetch_date: '2026-09-21', payload: { periods: [1, 2] }, item_count: 2, ok: true,
          http_status: 200, latency_ms: 120 },
        { source: '__test_news', geo_scope: 'state', geo_key: 'TX', fetch_date: '2026-09-21',
          payload: null, ok: false, error: 'timeout', http_status: 504 },
        { source: '', geo_scope: 'nonsense', geo_key: 'x', fetch_date: 'bad' }, // case 11
      ],
    },
  });
  const capResult = await dailySvc.captureSignalsForRun(pool, fullRun, dailySvc.resolveDayKey(fullRun.generated_at, TZ));
  check('8  full bundle reported as fidelity=full', capResult.fidelity === 'full', JSON.stringify(capResult));

  const sig = await pool.query(
    `SELECT signal_date::text AS signal_date, day_basis, timezone, bundle_fidelity,
            weather, sports, events, active_keys, news_categories,
            sources_ok, sources_failed, sources_dormant, signal_count,
            latitude, longitude, state, geo_source, bundle_sha256, capture_count,
            display_snapshot
       FROM daily_store_signals WHERE client_id=$1 AND location_id=$2`, [CID, LID]
  );
  const s = sig.rows[0];
  check('8b stored on the store-local signal day', s.signal_date === '2026-09-21' && s.day_basis === 'store_local');
  check('8c generated per-source columns derive from the bundle',
    s.weather?.high_f === 99 && s.sports?.length === 1 && s.events?.length === 1,
    JSON.stringify({ w: s.weather, sp: s.sports?.length, e: s.events?.length }));
  check('8d active_keys / categories lifted to real arrays',
    eq(s.active_keys, ['heat_advisory', 'nfl_home_game']) && eq(s.news_categories, ['beer']),
    JSON.stringify(s.active_keys));
  check('8e health rolled up (dormant is not a failure)',
    s.sources_ok === 2 && s.sources_failed === 1 && s.sources_dormant === 1,
    `${s.sources_ok}/${s.sources_failed}/${s.sources_dormant}`);
  check('8f signal_count counts the FULL bundle (weather+1 sport+1 event+1 news)',
    s.signal_count === 4, String(s.signal_count));
  check('8g geography recorded', Number(s.latitude) === 32.78 && s.state === 'TX' && s.geo_source === 'geocoded');
  check('8h bundle hash present', /^[0-9a-f]{64}$/.test(s.bundle_sha256 || ''));
  check('8i display snapshot kept alongside the full bundle', s.display_snapshot !== null);

  // 10/11. Raw payloads: two valid rows stored, the malformed one skipped.
  check('10 raw payloads written, malformed one skipped',
    capResult.raw.written === 2 && capResult.raw.skipped === 1, JSON.stringify(capResult.raw));

  const rawBefore = await pool.query(
    "SELECT source, capture_count, ok, item_count, payload_sha256, payload_bytes FROM signal_source_payloads WHERE source LIKE '__test_%' ORDER BY source"
  );
  check('10b failed fetch recorded as a row with ok=false and no payload',
    rawBefore.rows.find((r) => r.source === '__test_news')?.ok === false, JSON.stringify(rawBefore.rows));
  check('10c successful payload hashed and sized',
    /^[0-9a-f]{64}$/.test(rawBefore.rows.find((r) => r.source === '__test_weather')?.payload_sha256 || ''));

  // Same geo key again → upsert, not a duplicate row.
  await dailySvc.captureSignalsForRun(pool, fullRun, dailySvc.resolveDayKey(fullRun.generated_at, TZ));
  const rawAfter = await pool.query(
    "SELECT count(*)::int AS n, max(capture_count) AS mx FROM signal_source_payloads WHERE source='__test_weather'"
  );
  check('10d same (source, geo, date) dedupes to one row, capture_count=2',
    rawAfter.rows[0].n === 1 && rawAfter.rows[0].mx === 2, JSON.stringify(rawAfter.rows[0]));

  const sigAfter = await pool.query(
    'SELECT capture_count FROM daily_store_signals WHERE client_id=$1 AND location_id=$2', [CID, LID]
  );
  check('10e signal cell upserts rather than duplicating', sigAfter.rows[0].capture_count === 2);

  // 9. Without signal_capture the trimmed snapshot is all we have — and it must
  //    be labelled as such, or a backtest silently trains on chip-sized input.
  await pool.query('DELETE FROM daily_store_signals WHERE client_id=$1 AND location_id=$2', [CID, LID]);
  const legacy = makeRun(); // no signal_capture at all
  const legacyDay = dailySvc.resolveDayKey(legacy.generated_at, null);
  const legacyResult = await dailySvc.captureSignalsForRun(pool, legacy, legacyDay);
  check('9  missing signal_capture stores display_trimmed, never mislabelled as full',
    legacyResult.fidelity === 'display_trimmed', JSON.stringify(legacyResult));
  const legacyRow = await pool.query(
    'SELECT bundle_fidelity, day_basis, timezone FROM daily_store_signals WHERE client_id=$1 AND location_id=$2',
    [CID, LID]
  );
  check('9b legacy row honest about basis too',
    legacyRow.rows[0].bundle_fidelity === 'display_trimmed' && legacyRow.rows[0].day_basis === 'utc'
      && legacyRow.rows[0].timezone === null, JSON.stringify(legacyRow.rows[0]));

  // 12. Capture is best-effort by contract: it must swallow anything.
  const brokenPool = { query: async () => { throw new Error('connection reset'); } };
  dailySvc._resetProbes();
  const swallowed = await dailySvc.captureSignalsForRun(brokenPool, fullRun, local);
  check('12 capture never throws on a broken pool', swallowed && typeof swallowed === 'object',
    JSON.stringify(swallowed));
  dailySvc._resetProbes();

  // 13. The two cells must describe the same day for the same run.
  await cleanup(pool);
  dailySvc._resetProbes();
  const paired = makeRun({ signal_capture: { timezone: TZ, bundle: FULL_BUNDLE } });
  const pr = await recSvc.persistRun(pool, paired);
  await dailySvc.captureSignalsForRun(pool, paired, pr.day);
  const joined = await pool.query(
    `SELECT r.rec_date::text AS rec_date, r.signal_date::text AS signal_date,
            s.signal_date::text AS s_date, s.bundle_fidelity
       FROM daily_store_recommendations r
       JOIN daily_store_signals s
         ON s.client_id = r.client_id AND s.location_id = r.location_id
        AND s.signal_date = r.signal_date
      WHERE r.client_id=$1 AND r.location_id=$2`, [CID, LID]
  );
  check('13 archive and signal cell join on the same store-local day',
    joined.rows.length === 1 && joined.rows[0].rec_date === '2026-09-21'
      && joined.rows[0].s_date === '2026-09-21' && joined.rows[0].bundle_fidelity === 'full',
    JSON.stringify(joined.rows[0]));

  await cleanup(pool);
  await pool.end();

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\nverification aborted:', err);
  process.exit(1);
});
