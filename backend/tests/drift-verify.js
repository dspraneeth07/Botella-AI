#!/usr/bin/env node
/**
 * Checklist 18 - drift. A store below its null for a month is suspended
 * automatically; one that is not is left exactly as it was.
 *
 * The statistics live in Python (`app/pipeline/gate/drift.py`, pinned by
 * tests/test_gate_drift.py). This verifies the half Node owns: the outcome
 * query, the payload, and above all the WRITE RULE - a proven drift suspends
 * and carries the measured inputs across; anything else writes nothing, so a
 * store LIVE on a fresh published verdict is never touched on thin evidence,
 * and a suspension is never cleared by this job (promotion is Gate A/B's).
 *
 * The null pool is injected rather than read from feature_daily, which is a
 * partitioned table this test should not be seeding.
 *
 * PREREQ: analytics migrations 020, 023, 033.
 * Run:  node tests/drift-verify.js
 */
require('dotenv').config();

const { getAnalyticsPool } = require('../database/analytics-connection');
const recSvc = require('../services/recommendationService');
const drift = require('../scripts/run-drift');

const CID = 999918;
const LID = 990018;
const AS_OF = '2026-10-08';
const DAY = 86400000;

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail ? ` - ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const iso = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const asOfDate = new Date(2026, 9, 8);
const daysAgo = (n) => iso(new Date(asOfDate.getTime() - n * DAY));

/** A null whose mean lift is 1.0, so lifts under it are below and over it above. */
const NULL_POOL = { v2: Array.from({ length: 100 }, (_, i) => [0.8, 0.9, 1.0, 1.1, 1.2][i % 5]) };

let nextRecId = 1;
async function seedOutcome(pool, { lift, scoredDaysAgo, arm = 'shown', windowDays = 30 }) {
  const end = daysAgo(scoredDaysAgo);
  const start = daysAgo(scoredDaysAgo + windowDays);
  await pool.query(
    `INSERT INTO recommendation_outcomes
       (recommendation_id, client_id, location_id, sku, family, arm,
        window_start, window_end, open_days_in_window, lift)
     VALUES ($1, $2, $3, $4, 'reorder', $5, $6::date, $7::date, 26, $8)
     ON CONFLICT (recommendation_id, window_start, window_end) DO NOTHING`,
    [9990000000 + nextRecId, CID, LID, `SKU${nextRecId++}`, arm, start, end, lift]
  );
}

/** Seven outcomes a week for four weeks at one lift. */
async function seedMonth(pool, lift) {
  for (let week = 0; week < 4; week++) {
    for (let i = 0; i < 7; i++) {
      await seedOutcome(pool, { lift, scoredDaysAgo: week * 7 + 3 });
    }
  }
}

async function cleanup(pool) {
  await pool.query('DELETE FROM recommendation_outcomes WHERE client_id = $1', [CID]);
  await pool.query('DELETE FROM store_gate_verdict WHERE client_id = $1', [CID]);
}

(async () => {
  const pool = getAnalyticsPool();
  const ready = await pool.query(
    `SELECT to_regclass('public.recommendation_outcomes') IS NOT NULL
        AND to_regclass('public.store_gate_verdict')      IS NOT NULL AS ok`
  );
  if (!ready.rows[0].ok) {
    console.error('Analytics migrations 020/023/033 are not applied - run `npm run migrate`.');
    process.exit(2);
  }
  await cleanup(pool);
  const store = { clientId: CID, locationId: LID };

  console.log('\n-- A LIVE store with a fresh verdict, and thin evidence ------');

  await recSvc.upsertStoreGateVerdict(pool, {
    client_id: CID, location_id: LID, state: 'live', reason: 'both_gates_hold',
    measured: true, displayed: true, ece_points: 2.6, promise_fill_ratio: 104,
    cards: 183, measured_for_month: '2026-06',
    verdict_as_of: '2026-06-30', valid_until: '2026-10-28',
  });
  // Three outcomes in one week: sampled, not measured.
  for (let i = 0; i < 3; i++) await seedOutcome(pool, { lift: 0.3, scoredDaysAgo: 2 });

  let r = await drift.evaluateStore(pool, store, { asOf: AS_OF, nullPool: NULL_POOL });
  check('1  thin evidence abstains with a reason',
    r.verdict.abstained === true && /^drift:thin_evidence:/.test(r.verdict.reason),
    r.verdict.reason);
  check('2  ...and writes NOTHING', r.applied.written === false);
  let row = await drift.currentVerdictRow(pool, CID, LID);
  check('3  the live verdict is untouched - state, reason, dates',
    row.state === 'live' && row.reason === 'both_gates_hold' && row.displayed === true
    && iso(row.valid_until) === '2026-10-28', JSON.stringify({ s: row.state, v: row.valid_until }));

  console.log('\n-- The same store, healthy for a month ----------------------');

  await pool.query('DELETE FROM recommendation_outcomes WHERE client_id = $1', [CID]);
  await seedMonth(pool, 1.7);
  r = await drift.evaluateStore(pool, store, { asOf: AS_OF, nullPool: NULL_POOL });
  check('4  a store beating its null every week holds',
    r.verdict.drifted === false && r.verdict.abstained === false, r.verdict.reason);
  check('5  n_outcomes counts the shown arm inside the window', r.verdict.n_outcomes === 28,
    String(r.verdict.n_outcomes));
  check('6  nothing written', r.applied.written === false);

  console.log('\n-- One bad week is not drift --------------------------------');

  await pool.query('DELETE FROM recommendation_outcomes WHERE client_id = $1', [CID]);
  for (let week = 0; week < 4; week++) {
    for (let i = 0; i < 7; i++) {
      await seedOutcome(pool, { lift: week === 1 ? 0.4 : 1.7, scoredDaysAgo: week * 7 + 3 });
    }
  }
  r = await drift.evaluateStore(pool, store, { asOf: AS_OF, nullPool: NULL_POOL });
  check('7  one week below, three above: holds',
    r.verdict.drifted === false && /beat_null_in_3_of_4/.test(r.verdict.reason), r.verdict.reason);
  check('8  nothing written', r.applied.written === false);

  console.log('\n-- Four weeks below the null: SUSPENDED ---------------------');

  await pool.query('DELETE FROM recommendation_outcomes WHERE client_id = $1', [CID]);
  await seedMonth(pool, 0.5);
  // The withheld arm sits at a healthy lift and must not rescue the store:
  // it is the control, not a recommendation.
  for (let i = 0; i < 10; i++) {
    await seedOutcome(pool, { lift: 2.0, scoredDaysAgo: 5, arm: 'withheld' });
  }
  // A 7-day-window outcome inside the period must not count either: the rule
  // is defined on the 30-day window.
  for (let i = 0; i < 10; i++) {
    await seedOutcome(pool, { lift: 2.0, scoredDaysAgo: 5, windowDays: 7 });
  }
  r = await drift.evaluateStore(pool, store, { asOf: AS_OF, nullPool: NULL_POOL });
  check('9  drift is proven', r.verdict.drifted === true && r.verdict.state === 'suspended',
    r.verdict.reason);
  check('10 the reason names the days covered', r.verdict.reason === 'drift:below_null_for_28d',
    r.verdict.reason);
  check('11 only shown, 30-day outcomes were judged', r.verdict.n_outcomes === 28,
    String(r.verdict.n_outcomes));
  check('12 the suspension was written, as a transition from live',
    r.applied.written === true && r.applied.changed === true && r.applied.previousState === 'live');

  row = await drift.currentVerdictRow(pool, CID, LID);
  check('13 state suspended, measured, NOT displayed',
    row.state === 'suspended' && row.measured === true && row.displayed === false);
  check('14 the reason is the drift reason', row.reason === 'drift:below_null_for_28d', row.reason);
  check('15 previous_state and state_changed_at record the fall',
    row.previous_state === 'live' && row.state_changed_at !== null);
  check('16 verdict_as_of is today and valid_until is 120 days on (the publisher\'s Setting)',
    iso(row.verdict_as_of) === AS_OF && iso(row.valid_until) === '2027-02-05',
    JSON.stringify({ a: row.verdict_as_of, v: row.valid_until }));
  check('17 the measured inputs Gate A/B wrote are carried across, not nulled',
    Number(row.ece_points) === 2.6 && Number(row.promise_fill_ratio) === 104
    && row.cards === 183 && row.measured_for_month === '2026-06',
    JSON.stringify({ e: row.ece_points, p: row.promise_fill_ratio, c: row.cards }));

  console.log('\n-- The serving path honours it -----------------------------');

  const decision = recSvc.storeGateDecision(row, { enforced: true, now: new Date(2026, 9, 8, 12) });
  check('18 measured and not displayed: every card is withheld under enforcement',
    decision.measured === true && decision.displayed === false);
  check('19 ...with the drift reason', decision.reason === 'drift:below_null_for_28d');

  console.log('\n-- Drift clearing does NOT promote ------------------------');

  await pool.query('DELETE FROM recommendation_outcomes WHERE client_id = $1', [CID]);
  await seedMonth(pool, 1.8);
  r = await drift.evaluateStore(pool, store, { asOf: AS_OF, nullPool: NULL_POOL });
  check('20 the store now holds', r.verdict.drifted === false && r.verdict.abstained === false);
  check('21 ...and nothing is written - promotion is Gate A/B\'s job',
    r.applied.written === false);
  row = await drift.currentVerdictRow(pool, CID, LID);
  check('22 the store stays suspended until the next publish re-measures it',
    row.state === 'suspended' && row.displayed === false);

  console.log('\n-- A dry run writes nothing even when drift is proven -------');

  await pool.query('DELETE FROM recommendation_outcomes WHERE client_id = $1', [CID]);
  await pool.query('DELETE FROM store_gate_verdict WHERE client_id = $1', [CID]);
  await seedMonth(pool, 0.5);
  r = await drift.evaluateStore(pool, store, { asOf: AS_OF, nullPool: NULL_POOL, dryRun: true });
  check('23 drift proven, dry run', r.verdict.drifted === true && r.applied.dryRun === true);
  check('24 no row created', (await drift.currentVerdictRow(pool, CID, LID)) === null);

  console.log('\n-- No matched null abstains ---------------------------------');

  r = await drift.evaluateStore(pool, store, { asOf: AS_OF, nullPool: { v0: [1, 1, 1] } });
  check('25 a pool with no comparable class is an absence of evidence, not drift',
    r.verdict.abstained === true && /^drift:no_matched_null/.test(r.verdict.reason),
    r.verdict.reason);

  await cleanup(pool);

  console.log('');
  console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(async (err) => {
  console.error(err.stack || err.message);
  try { await cleanup(getAnalyticsPool()); } catch { /* best effort */ }
  process.exit(1);
});
