/**
 * Signal-impact verification - exercises signalImpactService.signalImpactLedger
 * and the /api/signal-impact route end-to-end against the real analytics DB
 * (sentinel tenant), covering the things a trust ledger gets wrong quietly:
 *
 *   1  a cited key counts the cards that cited it, holdouts excluded
 *   2  a card citing two keys counts once under each
 *   3  lift is averaged over the cards that HAVE one; the rest stay out of the mean
 *   4  no measurable lift is NULL with a reason, never 0
 *   5  owner actions: true counted, NULL kept apart as unknown, false neither
 *   6  margin sums only computable impacts; none computable is NULL with a reason
 *   7  the fitted effect rides along with its interval, usable only where it is
 *   8  a refused cell carries the fit's reason; a spanning interval is named
 *   9  a key the fit has but no card cited still appears (the unused measurement)
 *   10 a cited key the fit never saw says so
 *   11 stock cards (empty signals_cited) are counted in totals and nowhere else
 *   12 internal evidence keys are flagged, not presented as external signals
 *   13 window and history bound are clamped to the configured vocabulary
 *   14 another tenant sees none of it
 *   15 the route returns the same ledger for the JWT's tenant, 200, under {data}
 *
 * PREREQ: analytics migrations 002 (evaluations), 003 (dollar columns) and 029
 * (signal_effects) applied.
 * Run:  node tests/signal-impact-verify.js
 */
require('dotenv').config();

const http = require('http');
const express = require('express');
const { getAnalyticsPool } = require('../database/analytics-connection');
const impact = require('../services/signalImpactService');

const CID = 999941;
const LID = 990041;
const OTHER_CID = 999942;
const OTHER_LID = 990042;

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail && !ok ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const near = (a, b, eps = 1e-6) => a != null && b != null && Math.abs(a - b) < eps;

async function cleanup(pool) {
  // evaluations cascade from recommendations, recommendations from the run.
  for (const [c, l] of [[CID, LID], [OTHER_CID, OTHER_LID]]) {
    await pool.query('DELETE FROM recommendation_runs WHERE client_id=$1 AND location_id=$2', [c, l]);
    await pool.query('DELETE FROM signal_effects WHERE client_id=$1 AND location_id=$2', [c, l]);
  }
}

async function insertRun(pool, cid, lid) {
  const { rows } = await pool.query(
    `INSERT INTO recommendation_runs (client_id, location_id, generated_at, data_as_of,
                                      candidate_count, recommendation_count, dropped_invalid, signal_snapshot)
     VALUES ($1, $2, now(), current_date, 10, 0, 0, '{}'::jsonb) RETURNING id`,
    [cid, lid]
  );
  return rows[0].id;
}

async function insertRec(pool, runId, cid, lid, rank, { action, signals, status = null }) {
  const { rows } = await pool.query(
    `INSERT INTO recommendations (run_id, client_id, location_id, rank, category, action_type,
                                  primary_skus, rationale, signals_cited, confidence, valid_through, status)
     VALUES ($1, $2, $3, $4, 'weather', $5, ARRAY[$8::text], 'r', $6::text[], 0.7,
             current_date + 7, $7) RETURNING id`,
    [runId, cid, lid, rank, action, signals, status, `SKU-${rank}`]
  );
  return rows[0].id;
}

async function insertEval(pool, recId, cid, lid, { lift, actionTaken, margin }) {
  await pool.query(
    `INSERT INTO recommendation_evaluations (rec_id, client_id, location_id, window_days, evaluated_at,
        data_through, units_sold, expected_units, units_in_validity, lift, outcome_score, action_taken,
        action_evidence, vote_ups, vote_downs, vote_component, final_score, verdict, revenue_impact, margin_impact)
     VALUES ($1, $2, $3, 30, now(), current_date, 5, 4, 5, $4, 0.5, $5, '{}'::jsonb, 0, 0, NULL, 0.5,
             $6, NULL, $7)`,
    [recId, cid, lid, lift, actionTaken, lift == null ? 'insufficient_data' : 'winner', margin]
  );
}

async function insertEffect(pool, cid, lid, { key, family, beta, lo, hi, refused }) {
  await pool.query(
    `INSERT INTO signal_effects (client_id, location_id, signal_key, category_family, beta, own_beta,
        interval_lo, interval_hi, own_weight, observations, active_days, refused_reason, basis, fit_from, fit_to)
     VALUES ($1, $2, $3, $4, $5, $5, $6, $7, 1, 200, 40, $8, 'own_only', current_date - 400, current_date)`,
    [cid, lid, key, family, beta, lo, hi, refused]
  );
}

(async () => {
  const pool = getAnalyticsPool();

  const ready = await pool.query(
    `SELECT to_regclass('public.recommendation_evaluations') IS NOT NULL
        AND to_regclass('public.signal_effects')             IS NOT NULL
        AND EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='recommendation_evaluations' AND column_name='margin_impact') AS ok`
  );
  if (!ready.rows[0].ok) {
    console.error('Analytics migrations 002 + 003 + 029 are not applied — run `npm run migrate` first.');
    process.exit(2);
  }

  await cleanup(pool);

  // ── Fixture ──────────────────────────────────────────────────────────────
  const runId = await insertRun(pool, CID, LID);
  // heat_advisory: three visible cards (lift 0.5 / lift 0.1 / no lift) + one holdout.
  const h1 = await insertRec(pool, runId, CID, LID, 1, { action: 'cold_box', signals: ['heat_advisory'] });
  const h2 = await insertRec(pool, runId, CID, LID, 2, { action: 'cold_box', signals: ['heat_advisory', 'nhl_home_game'] });
  const h3 = await insertRec(pool, runId, CID, LID, 3, { action: 'pre_stock', signals: ['heat_advisory'] });
  await insertRec(pool, runId, CID, LID, 4, { action: 'cold_box', signals: ['heat_advisory'], status: 'holdout' });
  // nhl_home_game alone: one card, not yet evaluated.
  await insertRec(pool, runId, CID, LID, 5, { action: 'pre_stock', signals: ['nhl_home_game'] });
  // Stock cards cite nothing, by design.
  await insertRec(pool, runId, CID, LID, 6, { action: 'reorder', signals: [] });
  await insertRec(pool, runId, CID, LID, 7, { action: 'markdown', signals: [] });
  // An LLM-era internal evidence key.
  await insertRec(pool, runId, CID, LID, 8, { action: 'reorder', signals: ['understock'] });

  await insertEval(pool, h1, CID, LID, { lift: 0.5, actionTaken: true, margin: 12.5 });
  await insertEval(pool, h2, CID, LID, { lift: 0.1, actionTaken: null, margin: null });
  await insertEval(pool, h3, CID, LID, { lift: null, actionTaken: false, margin: null });

  await insertEffect(pool, CID, LID, { key: 'heat_advisory', family: 'beer', beta: 0.158, lo: 0.0015, hi: 0.315, refused: null });
  await insertEffect(pool, CID, LID, { key: 'heat_advisory', family: 'spirits', beta: -0.039, lo: -0.106, hi: 0.027, refused: null });
  await insertEffect(pool, CID, LID, { key: 'nfl_home_game', family: 'beer', beta: null, lo: null, hi: null, refused: 'too_few_active_days:8<20' });

  // Another tenant with its own citing card, to prove scoping.
  const otherRun = await insertRun(pool, OTHER_CID, OTHER_LID);
  await insertRec(pool, otherRun, OTHER_CID, OTHER_LID, 1, { action: 'cold_box', signals: ['heat_advisory'] });

  console.log('\n── Ledger ──────────────────────────────────────────────────');
  const ledger = await impact.signalImpactLedger(pool, CID, LID, { windowDays: 30, sinceDays: 30 });
  const byKey = Object.fromEntries(ledger.signals.map((s) => [s.signal_key, s]));
  const heat = byKey.heat_advisory;
  const nhl = byKey.nhl_home_game;
  const nfl = byKey.nfl_home_game;
  const under = byKey.understock;

  check('1  heat_advisory issued = 3 (holdout excluded)', heat && heat.cards_issued === 3, JSON.stringify(heat));
  check('2  card citing two keys counts under both', nhl && nhl.cards_issued === 2, JSON.stringify(nhl));
  check('3  mean lift averages the two cards that have one (0.3)',
    heat && heat.cards_with_lift === 2 && near(heat.mean_lift, 0.3), JSON.stringify(heat && heat.mean_lift));
  check('3b evaluated count includes the lift-less card', heat && heat.cards_evaluated === 3);
  check('4  nhl_home_game: one evaluated card with lift, one unevaluated - mean is that card, not an average with 0',
    nhl && nhl.cards_evaluated === 1 && nhl.cards_with_lift === 1 && near(nhl.mean_lift, 0.1), JSON.stringify(nhl));
  check('5  actions: 1 taken, 1 unknown, false counted as neither',
    heat && heat.cards_acted === 1 && heat.cards_action_unknown === 1, JSON.stringify(heat));
  check('6  margin sums only the computable impact (12.5)',
    heat && near(heat.margin_impact, 12.5) && heat.margin_cards === 1 && heat.margin_reason === null,
    JSON.stringify([heat && heat.margin_impact, heat && heat.margin_reason]));
  check('6b nhl margin is NULL with a reason, not 0',
    nhl && nhl.margin_impact === null && typeof nhl.margin_reason === 'string' && nhl.margin_reason.length > 0,
    JSON.stringify(nhl && nhl.margin_reason));
  check('7  heat effect: beer usable with its interval, spirits not',
    heat && heat.effect_usable_families.join() === 'beer'
      && heat.effects.length === 2
      && heat.effects.find((e) => e.category_family === 'beer').usable === true
      && near(heat.effects.find((e) => e.category_family === 'beer').interval_lo, 0.0015)
      && heat.effect_reason === null,
    JSON.stringify(heat && heat.effects));
  check('8  spanning interval is named as the reason on that cell',
    heat && heat.effects.find((e) => e.category_family === 'spirits').refused_reason === 'interval_spans_zero');
  check('8b refused cell carries the fit\'s own reason',
    nfl && nfl.effects.length === 1 && nfl.effects[0].refused_reason === 'too_few_active_days:8<20'
      && /too_few_active_days/.test(nfl.effect_reason), JSON.stringify(nfl));
  check('9  a fitted-but-never-cited key appears with issued=0 and a lift reason',
    nfl && nfl.cards_issued === 0 && nfl.mean_lift === null && /no card cited/.test(nfl.lift_reason), JSON.stringify(nfl));
  check('10 a cited key the fit never saw says so',
    nhl && nhl.effects.length === 0 && /never fitted/.test(nhl.effect_reason), JSON.stringify(nhl && nhl.effect_reason));
  check('11 stock cards count in totals and under no key',
    ledger.cards_total === 7 && ledger.cards_citing === 5 && !('' in byKey), JSON.stringify([ledger.cards_total, ledger.cards_citing]));
  check('12 understock is flagged internal; heat_advisory is not',
    under && under.internal === true && heat.internal === false);
  check('12b header counts one signal with a usable effect', ledger.signals_with_usable_effect === 1);

  const clamped = await impact.signalImpactLedger(pool, CID, LID, { windowDays: 13, sinceDays: 9999 });
  check('13 window falls back to the default; days clamp to 365',
    clamped.window_days === impact.DEFAULT_WINDOW_DAYS && clamped.since_days === 365,
    JSON.stringify([clamped.window_days, clamped.since_days]));

  const other = await impact.signalImpactLedger(pool, OTHER_CID, OTHER_LID, { windowDays: 30, sinceDays: 30 });
  check('14 another tenant sees only its own card and no effects',
    other.cards_total === 1 && other.signals.length === 1
      && other.signals[0].cards_issued === 1 && other.signals[0].effects.length === 0, JSON.stringify(other.signals));

  console.log('\n── Route ───────────────────────────────────────────────────');
  // The real router behind a stand-in for verifyToken that stamps the sentinel
  // tenant, the way the JWT would, on an ephemeral port.
  const app = express();
  app.use('/api/signal-impact', (req, _res, next) => {
    req.user = { client_id: CID, location_id: LID };
    next();
  }, require('../routes/signal-impact'));
  const server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  const body = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/api/signal-impact?window=30&days=30`, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(buf) }));
    }).on('error', reject);
  });
  server.close();
  check('15 route answers 200 with the ledger under {data}',
    body.status === 200 && body.json.data && body.json.data.cards_total === 7
      && body.json.data.signals.find((s) => s.signal_key === 'heat_advisory').cards_issued === 3,
    JSON.stringify(body).slice(0, 300));

  await cleanup(pool);
  await pool.end();

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\nverification aborted:', err);
  process.exit(1);
});
