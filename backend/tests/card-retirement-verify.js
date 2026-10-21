#!/usr/bin/env node
/**
 * Card retirement - a verdict is made once and remembered (checklist 17).
 *
 * The lifecycle retires a card whose claim has failed and suppresses the SKU
 * for fourteen open days. Python is stateless, so until migration 034 the
 * retirement was decided afresh every morning and the suppression was "today
 * + 14" every morning - rolling forever while the rule fired, gone the moment
 * it stopped. This file is the guard on the Node half of the fix:
 *
 *   1  persistRun writes the run's card_retirements in the run's transaction
 *   2  a same-day re-run is idempotent (ON CONFLICT DO NOTHING)
 *   3  getCardHistory hands the stored retirement back per SKU
 *   4  a SKU never retired carries nulls, and accepted/dismissed still flow
 *   5  a card issued AFTER the retirement is a fresh claim: the feed reports
 *      that card's own first_issued/baseline and drops the retirement
 *   6  a card from the SAME run as the retirement is not "fresh"
 *   7  a run with no retirements writes nothing and does not throw
 *   8  a malformed retirement is skipped with a warning, not fatal
 *
 * PREREQ: analytics migration 034 applied (`npm run migrate`).
 * Run:  node tests/card-retirement-verify.js
 */
require('dotenv').config();

const { getAnalyticsPool } = require('../database/analytics-connection');
const recSvc = require('../services/recommendationService');

const CID = 999934;
const LID = 990034;

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail && !ok ? ` - ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function makeRun(overrides = {}) {
  return {
    client_id: CID,
    location_id: LID,
    generated_at: new Date().toISOString(),
    data_as_of: '2026-10-07',
    candidate_count: 14,
    recommendations_generated: 2,
    dropped_invalid: 0,
    signal_snapshot: {},
    recommendations: [
      { rank: 1, category: 'inventory_understock', action_type: 'reorder',
        primary_skus: ['SKU-KEPT'], rationale: 'r', signals_cited: [],
        confidence: 0.5, valid_through: '2026-10-21', engine_daily_rate: 0.9 },
      { rank: 2, category: 'inventory_understock', action_type: 'reorder',
        primary_skus: ['SKU-OTHER'], rationale: 'r', signals_cited: [],
        confidence: 0.4, valid_through: '2026-10-21', engine_daily_rate: 0.3 },
    ],
    card_retirements: [],
    ...overrides,
  };
}

const RETIREMENT = {
  sku: 'SKU-RETIRED',
  retired_at: '2026-10-07',
  suppressed_until: '2026-10-22',
  rule: 'declining',
  reason: '0 units in 6 open days against 2.4 expected; 9% of the time',
  first_issued: '2026-10-01',
  open_days_since: 6,
  recovery_ratio: 0,
  tail_probability: 0.0907,
  distribution: 'poisson_unmeasured_dispersion',
};

async function cleanup(pool) {
  await pool.query('DELETE FROM recommendation_retirements WHERE client_id=$1 AND location_id=$2', [CID, LID]);
  await pool.query('DELETE FROM recommendation_runs WHERE client_id=$1 AND location_id=$2', [CID, LID]);
  await pool.query('DELETE FROM daily_store_recommendations WHERE client_id=$1 AND location_id=$2', [CID, LID])
    .catch(() => {});
}

async function insertCard(pool, runId, sku, { createdAt, rate = 0.5, vote = null, claim = null } = {}) {
  await pool.query(
    `INSERT INTO recommendations (run_id, client_id, location_id, rank, category, action_type,
       primary_skus, rationale, signals_cited, confidence, valid_through, engine_daily_rate,
       vote, action_claim, created_at)
     VALUES ($1, $2, $3, 9, 'inventory_understock', 'reorder', $4, 'r', '{}', 0.5,
             '2026-10-21', $5, $6, $7, $8)`,
    [runId, CID, LID, [sku], rate, vote, claim, createdAt]
  );
}

(async () => {
  const pool = getAnalyticsPool();

  const ready = await pool.query(
    `SELECT to_regclass('public.recommendation_retirements') IS NOT NULL AS ok`);
  if (!ready.rows[0].ok) {
    console.error('Analytics migration 034 is not applied - run `npm run migrate` first.');
    process.exit(2);
  }

  await cleanup(pool);

  console.log('\n-- 1. persistRun writes the retirement with the run ---------');

  const { runId } = await recSvc.persistRun(pool, makeRun({ card_retirements: [RETIREMENT] }));
  const stored = await pool.query(
    `SELECT sku, retired_at::text AS retired_at, suppressed_until::text AS suppressed_until,
            retirement_rule, reason, first_issued::text AS first_issued, open_days_since,
            recovery_ratio, tail_probability, distribution, run_id
       FROM recommendation_retirements WHERE client_id=$1 AND location_id=$2`,
    [CID, LID]);
  check('1a one row was written', stored.rowCount === 1, String(stored.rowCount));
  const row = stored.rows[0] || {};
  check('1b it carries the sku, the date and the stored end date',
    row.sku === 'SKU-RETIRED' && row.retired_at === '2026-10-07'
      && row.suppressed_until === '2026-10-22', JSON.stringify(row));
  check('1c the rule, the reason and the tail travel for the audit',
    row.retirement_rule === 'declining' && /9% of the time/.test(row.reason || '')
      && Math.abs(Number(row.tail_probability) - 0.0907) < 1e-6
      && row.distribution === 'poisson_unmeasured_dispersion'
      && row.open_days_since === 6 && row.first_issued === '2026-10-01');
  check('1d it is tied to the run that decided it', row.run_id === runId, `${row.run_id} vs ${runId}`);

  console.log('\n-- 2. a same-day re-run is idempotent -----------------------');

  await recSvc.persistRun(pool, makeRun({ card_retirements: [RETIREMENT] }));
  const again = await pool.query(
    `SELECT count(*)::int AS n FROM recommendation_retirements WHERE client_id=$1 AND location_id=$2`,
    [CID, LID]);
  check('2  the second run did not duplicate the retirement', again.rows[0].n === 1, String(again.rows[0].n));

  console.log('\n-- 3/4. getCardHistory hands the stored verdict back --------');

  // The card that WAS retired, issued before the retirement row was written.
  await insertCard(pool, runId, 'SKU-RETIRED', {
    createdAt: '2026-10-01T04:00:00Z', rate: 0.4 });
  await insertCard(pool, runId, 'SKU-RETIRED', {
    createdAt: '2026-10-05T04:00:00Z', rate: 0.7 });
  // Owner decisions on an unretired SKU, to prove that plumbing still flows.
  await insertCard(pool, runId, 'SKU-OTHER', {
    createdAt: '2026-10-03T04:00:00Z', rate: 0.3, vote: 1 });

  const history = await recSvc.getCardHistory(pool, CID, LID, 60);
  const bySku = Object.fromEntries(history.map((h) => [h.sku, h]));
  const retired = bySku['SKU-RETIRED'];
  check('3a the retired SKU is in the feed', !!retired, JSON.stringify(history));
  check('3b with retired_at and suppressed_until as stored',
    retired && retired.retired_at === '2026-10-07' && retired.suppressed_until === '2026-10-22'
      && retired.retirement_rule === 'declining', JSON.stringify(retired));
  check('3c and the retired card\'s own first_issued and FIRST baseline rate',
    retired && retired.first_issued === '2026-10-01' && retired.baseline_rate === 0.4
      && retired.times_shown === 2, JSON.stringify(retired));

  const other = bySku['SKU-OTHER'];
  check('4a a SKU never retired carries nulls, not a default',
    other && other.retired_at === null && other.suppressed_until === null
      && other.retirement_rule === null, JSON.stringify(other));
  check('4b accepted/dismissed still flow (an upvote is acceptance)',
    other && other.accepted === true && other.dismissed === false, JSON.stringify(other));
  const kept = bySku['SKU-KEPT'];
  check('4c a card with no vote and no claim is not accepted, and not unknown',
    kept && kept.accepted === false && kept.dismissed === false, JSON.stringify(kept));

  console.log('\n-- 5. a card issued AFTER the retirement is a fresh claim ---');

  // Strictly after the retirement row's created_at (which is now()).
  await new Promise((r) => setTimeout(r, 20));
  const later = new Date(Date.now() + 1000).toISOString();
  await insertCard(pool, runId, 'SKU-RETIRED', { createdAt: later, rate: 0.55 });
  const fresh = (await recSvc.getCardHistory(pool, CID, LID, 60)).find((h) => h.sku === 'SKU-RETIRED');
  check('5a the retirement is dropped: the old verdict is history',
    fresh && fresh.retired_at === null && fresh.suppressed_until === null
      && fresh.retirement_rule === null, JSON.stringify(fresh));
  check('5b first_issued, times_shown and baseline describe the FRESH card only',
    fresh && fresh.first_issued === later.slice(0, 10) && fresh.times_shown === 1
      && fresh.baseline_rate === 0.55, JSON.stringify(fresh));

  console.log('\n-- 6. a card from the SAME run as the retirement is not fresh');

  await cleanup(pool);
  // A run that both issues a card for a SKU (another family can) and retires
  // it in the same transaction: both rows get the transaction's now().
  const sameRun = makeRun({
    recommendations: [{ rank: 1, category: 'weather', action_type: 'cold_box',
      primary_skus: ['SKU-RETIRED'], rationale: 'r', signals_cited: ['heat_advisory'],
      confidence: 0.5, valid_through: '2026-10-21', engine_daily_rate: 0.4 }],
    card_retirements: [RETIREMENT],
  });
  await recSvc.persistRun(pool, sameRun);
  const same = (await recSvc.getCardHistory(pool, CID, LID, 60)).find((h) => h.sku === 'SKU-RETIRED');
  check('6  the same-run card does not supersede the retirement',
    same && same.retired_at === '2026-10-07' && same.times_shown === 1, JSON.stringify(same));

  console.log('\n-- 7/8. nothing to write, and a bad row ---------------------');

  await cleanup(pool);
  let threw = null;
  try { await recSvc.persistRun(pool, makeRun({ card_retirements: [] })); } catch (e) { threw = e; }
  try { await recSvc.persistRun(pool, makeRun()); delete makeRun().card_retirements; } catch (e) { threw = e; }
  const none = await pool.query(
    `SELECT count(*)::int AS n FROM recommendation_retirements WHERE client_id=$1 AND location_id=$2`,
    [CID, LID]);
  check('7  an empty or absent list writes nothing and does not throw',
    threw === null && none.rows[0].n === 0, threw ? threw.message : String(none.rows[0].n));

  const warned = [];
  const origWarn = console.warn;
  console.warn = (msg) => warned.push(String(msg));
  try {
    await recSvc.persistRun(pool, makeRun({
      card_retirements: [{ sku: 'SKU-BAD', retired_at: '2026-10-07' /* no until, no rule */ }, RETIREMENT],
    }));
  } finally {
    console.warn = origWarn;
  }
  const afterBad = await pool.query(
    `SELECT sku FROM recommendation_retirements WHERE client_id=$1 AND location_id=$2`, [CID, LID]);
  check('8a the malformed row is skipped and the good one lands',
    afterBad.rows.map((r) => r.sku).join(',') === 'SKU-RETIRED', JSON.stringify(afterBad.rows));
  check('8b and it was warned about, not swallowed',
    warned.some((m) => /card retirement skipped/.test(m)), warned.join(' | '));

  await cleanup(pool);
  await pool.end();

  console.log('');
  console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
