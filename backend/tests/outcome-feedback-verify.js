#!/usr/bin/env node
/**
 * Sheet 19 — the outcome feedback loop, against the real database.
 *
 * THE WITHHELD ARM IS THE ENTIRE POINT. Without it we measure forecasting;
 * with it we measure causation. So the checks that matter most here are the
 * ones proving a withheld recommendation is scored IDENTICALLY to a shown one
 * - not "also scored", identically.
 *
 * Run:  node tests/outcome-feedback-verify.js
 */

require('dotenv').config();

const { getAnalyticsPool } = require('../database/analytics-connection');
const outcomes = require('../services/outcomeFeedbackService');

const CID = 999919;
const LID = 990019;

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const WINDOWS = { baseline_open_days: 23, window_open_days: 6 };
const SKUS = [
  { sku: 'A', baseline_units: 100, actual_units: 130 },
  { sku: 'B', baseline_units: 40, actual_units: 44 },
];

function outcomeRow(over = {}) {
  return {
    recommendation_id: 900001, client_id: CID, location_id: LID,
    sku: 'A', family: 'reorder', arm: 'shown',
    recommended_qty: 24, actual_purchased_qty: 24, actual_units_sold: 174,
    window_start: '2026-09-01', window_end: '2026-09-08',
    open_days_in_window: 6, baseline_open_days: 23, baseline_units: 140,
    lift: 1.31, lift_reason: null, expected_units: 36.5, upside_units: 0,
    stated_confidence: 0.9, calibrated_confidence: 0.62,
    evidence_state: 'MATURE', own_weight: 1.0,
    cohort_level: 'state', cohort_size: 14,
    model_version: 'claude-sonnet-4-6', feature_version: '1.0.0',
    config_version: 'default', snapshot_id: 'snap-abc123',
    // Migration 035 - the quantities and the stockout grade.
    on_hand_at_issue: 6, on_hand_at_window_end: 12, on_hand_observed_on: '2026-09-06',
    units_unsold: 0, purchased_qty_source: 'purchases_feed',
    sold_through: true, days_to_sell_through: 3, delivery_observed_on: '2026-09-05',
    delivery_evidence: 'purchases_feed',
    sold_through_reason: '6 on hand at issue (engine_on_hand); sold through on '
      + '2026-09-04, delivery observed 2026-09-05 (purchases_feed)',
    ...over,
  };
}

(async () => {
  const pool = getAnalyticsPool();
  outcomes._resetProbe();

  console.log('\n── The table exists and constrains the arm ───────────────');

  check('1  recommendation_outcomes exists (migration 020)',
    await outcomes.outcomesTableExists(pool), 'run: npm run migrate');

  let rejected = false;
  try {
    await pool.query(
      `INSERT INTO recommendation_outcomes
         (recommendation_id, client_id, location_id, sku, family, arm,
          window_start, window_end, open_days_in_window)
       VALUES (999, $1, $2, 'X', 'reorder', 'maybe', '2026-09-01', '2026-09-08', 6)`,
      [CID, LID]
    );
  } catch { rejected = true; }
  check('2  a third arm cannot be written (CHECK constraint)', rejected,
    'a third value would silently split the population three ways');

  let armless = false;
  try {
    await outcomes.recordOutcome(pool, outcomeRow({ arm: undefined }));
  } catch { armless = true; }
  check('3  a row with no arm is refused, not defaulted', armless,
    'a row that cannot say which side it is on is a sales figure, not an outcome');

  await pool.query('DELETE FROM recommendation_outcomes WHERE client_id = $1', [CID]);

  console.log('\n── A withheld rec is scored IDENTICALLY to a shown one ───');

  // There is no arm to pass: the scorer is not given the recommendation.
  const shown = outcomes.scoreRecommendation(SKUS, WINDOWS);
  const withheld = outcomes.scoreRecommendation(SKUS, WINDOWS);

  // FIRST, that the comparison is not vacuous. An earlier version of this file
  // passed three arguments to a two-argument function, so both calls returned
  // the same UNMEASURABLE result and checks 4-6 compared two identical
  // failures. They were green and meant nothing.
  check('4a the score is actually measurable, so 4-6 compare something',
    shown.measurable && shown.lift !== null,
    JSON.stringify(shown));

  check('4  same inputs, same lift', shown.lift === withheld.lift,
    `${shown.lift} vs ${withheld.lift}`);
  check('5  same expected, same actual, same upside',
    shown.expected_units === withheld.expected_units
    && shown.actual_units_sold === withheld.actual_units_sold
    && shown.upside_units === withheld.upside_units);
  check('6  every scored field agrees',
    JSON.stringify(shown) === JSON.stringify(withheld),
    'not "also scored" - identically scored');

  // The strongest available guarantee: the scorer cannot read the arm because
  // it is never passed one that matters.
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'services', 'outcomeFeedbackService.js'),
    'utf8'
  );
  const signature = src.slice(src.indexOf('function scoreRecommendation'),
    src.indexOf(')', src.indexOf('function scoreRecommendation')) + 1);
  check('7  the scorer is not even GIVEN the recommendation',
    !/\brec\b/.test(signature),
    `${signature.trim()} — it cannot branch on the arm, because nothing here `
    + 'knows what the arm is');

  console.log('\n── Both arms are stored, and both are readable ───────────');

  await outcomes.recordOutcome(pool, outcomeRow({
    recommendation_id: 900001, arm: 'shown', lift: 1.31,
  }));
  await outcomes.recordOutcome(pool, outcomeRow({
    recommendation_id: 900002, arm: 'withheld', sku: 'B', lift: 0.98,
  }));

  const forGate = await outcomes.outcomesForGate(pool, {
    clientId: CID, locationId: LID, family: 'reorder',
  });
  check('8  the gate query returns BOTH arms', forGate.length === 2,
    `${forGate.length} row(s)`);
  check('9  and marks which is which',
    forGate.filter((o) => o.shown).length === 1
    && forGate.filter((o) => !o.shown).length === 1);
  check('10 in the shape the gate expects',
    forGate.every((o) => typeof o.lift === 'number'
      && typeof o.shown === 'boolean' && o.sku && o.family));

  console.log('\n── Every row can replay the decision that produced it ────');

  const { rows: [stored] } = await pool.query(
    `SELECT model_version, feature_version, config_version, snapshot_id,
            stated_confidence, calibrated_confidence,
            evidence_state, own_weight, cohort_level, cohort_size,
            open_days_in_window, baseline_open_days
       FROM recommendation_outcomes
      WHERE client_id = $1 AND recommendation_id = 900001`, [CID]
  );
  for (const field of ['model_version', 'feature_version', 'config_version',
    'snapshot_id']) {
    check(`11 ${field} is on the row`, stored[field] != null, String(stored[field]));
  }
  check('12 BOTH confidences are kept, so calibration can fit one on the other',
    stored.stated_confidence != null && stored.calibrated_confidence != null
    && Number(stored.stated_confidence) !== Number(stored.calibrated_confidence));
  check('13 the evidence behind the decision is on the row',
    stored.evidence_state != null && stored.own_weight != null
    && stored.cohort_level != null && stored.cohort_size != null);
  check('14 both windows are recorded in OPEN days',
    Number(stored.open_days_in_window) === 6
    && Number(stored.baseline_open_days) === 23,
    'a lift cannot be recomputed from the row without them');

  console.log('\n── The quantities and the stockout grade (migration 035) ─');

  check('14a the 035 columns exist, and the writer agrees',
    await outcomes.outcomeQuantityColumnsExist(pool), 'run: npm run migrate');
  const { rows: colRows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'recommendation_outcomes' AND column_name = ANY($1)`,
    [outcomes.QUANTITY_COLUMNS]
  );
  check('14b every column the writer lists is on the table',
    colRows.length === outcomes.QUANTITY_COLUMNS.length,
    `${colRows.length} of ${outcomes.QUANTITY_COLUMNS.length}`);

  const { rows: [qty] } = await pool.query(
    `SELECT recommended_qty, actual_purchased_qty, purchased_qty_source, units_unsold,
            on_hand_at_issue, on_hand_at_window_end,
            to_char(on_hand_observed_on, 'YYYY-MM-DD') AS on_hand_observed_on,
            sold_through, days_to_sell_through, delivery_evidence, sold_through_reason,
            to_char(delivery_observed_on, 'YYYY-MM-DD') AS delivery_observed_on
       FROM recommendation_outcomes
      WHERE client_id = $1 AND recommendation_id = 900001`, [CID]
  );
  check('14c the three quantities are on the row - asked for, bought, sold',
    Number(qty.recommended_qty) === 24 && Number(qty.actual_purchased_qty) === 24
    && qty.purchased_qty_source === 'purchases_feed' && Number(qty.units_unsold) === 0,
    JSON.stringify(qty));
  check('14d the shelf count at issue and at window end, the latter DATED',
    Number(qty.on_hand_at_issue) === 6 && Number(qty.on_hand_at_window_end) === 12
    && qty.on_hand_observed_on === '2026-09-06',
    'the nightly series is sparse; a count without its date cannot be aged');
  check('14e the stockout grade is on the row with its evidence and reason',
    qty.sold_through === true && Number(qty.days_to_sell_through) === 3
    && qty.delivery_observed_on === '2026-09-05' && qty.delivery_evidence === 'purchases_feed'
    && /sold through on 2026-09-04/.test(qty.sold_through_reason),
    JSON.stringify(qty));

  // A source the column does not know is refused, not stored as a new kind
  // of evidence the gate would then have to interpret.
  let badSource = false;
  try {
    await outcomes.recordOutcome(pool, outcomeRow({
      recommendation_id: 900003, purchased_qty_source: 'guessed',
    }));
  } catch { badSource = true; }
  check('14f an unknown purchased_qty_source is refused by the CHECK', badSource);
  let badEvidence = false;
  try {
    await outcomes.recordOutcome(pool, outcomeRow({
      recommendation_id: 900004, delivery_evidence: 'declared_lead_time',
    }));
  } catch { badEvidence = true; }
  check('14g the declared lead time is not an admissible delivery evidence', badEvidence,
    'a card graded against its own assumption passes by construction');

  console.log('\n── Re-scoring replaces, it does not accumulate ───────────');

  await outcomes.recordOutcome(pool, outcomeRow({
    recommendation_id: 900001, arm: 'shown', lift: 1.55, actual_units_sold: 190,
  }));
  const { rows: [{ n }] } = await pool.query(
    `SELECT count(*)::int AS n FROM recommendation_outcomes
      WHERE client_id = $1 AND recommendation_id = 900001`, [CID]
  );
  check('15 one row per (recommendation, window), not two', n === 1,
    `${n} rows — two would each be counted as independent evidence by the gate`);
  const { rows: [{ lift }] } = await pool.query(
    `SELECT lift FROM recommendation_outcomes
      WHERE client_id = $1 AND recommendation_id = 900001`, [CID]
  );
  check('16 and it carries the NEWER score', Number(lift) === 1.55, String(lift));

  // The 035 columns move on a re-score too. The window-end count and the
  // grade genuinely change as the sparse on-hand capture fills in behind a
  // window; a re-score that left them behind would pair tonight's sales with
  // last week's shelf count.
  await outcomes.recordOutcome(pool, outcomeRow({
    recommendation_id: 900001, arm: 'shown',
    on_hand_at_window_end: 9, on_hand_observed_on: '2026-09-08',
    sold_through: null, days_to_sell_through: null, delivery_observed_on: null,
    delivery_evidence: null, sold_through_reason: 'window still open',
  }));
  const { rows: [rescored] } = await pool.query(
    `SELECT on_hand_at_window_end, to_char(on_hand_observed_on, 'YYYY-MM-DD') AS seen,
            sold_through, delivery_evidence, sold_through_reason
       FROM recommendation_outcomes
      WHERE client_id = $1 AND recommendation_id = 900001`, [CID]
  );
  check('16a a re-score refreshes the quantities and the grade, not just the lift',
    Number(rescored.on_hand_at_window_end) === 9 && rescored.seen === '2026-09-08'
    && rescored.sold_through === null && rescored.delivery_evidence === null
    && rescored.sold_through_reason === 'window still open',
    JSON.stringify(rescored));

  // Checks 15 and 16 held `window_end` fixed in the fixture, so they proved the
  // SINK deduplicates - and the bug was in the CALLER. `recommendationEvalService`
  // passed the moving sales frontier as `window_end`, so the key changed every
  // night, the ON CONFLICT never fired, and one card accumulated a row per
  // nightly re-score: 444 rows for 284 card-windows on the live table, 284 of
  // them at spans that are not evaluation horizons at all (4, 10, 12, 24, 26 and
  // 39 days). The gate counted every one of them as independent evidence.
  //
  // So re-score the way the evaluator does: one 30-day window looked at on three
  // successive nights, each night seeing more of it. The nominal end is a pure
  // function of (rec_date, window_days) and must not move with the coverage.
  const NOMINAL_30 = '2026-10-01';
  for (const openDays of [9, 21, 26]) {
    await outcomes.recordOutcome(pool, outcomeRow({
      recommendation_id: 900042,
      window_start: '2026-09-01', window_end: NOMINAL_30,
      open_days_in_window: openDays,
      actual_units_sold: 10 * openDays,
      snapshot_id: `frontier-${openDays}`,
    }));
  }
  const { rows: [nightly] } = await pool.query(
    `SELECT count(*)::int AS n, max(open_days_in_window) AS days,
            max(snapshot_id) AS snap
       FROM recommendation_outcomes
      WHERE client_id = $1 AND recommendation_id = 900042`, [CID]
  );
  check('15b three nightly re-scores of ONE window leave one row',
    nightly.n === 1,
    `${nightly.n} rows - the gate would read ${nightly.n} facts where there is 1`);
  check('15c and the surviving row carries the fullest coverage',
    nightly.days === 26 && nightly.snap === 'frontier-26',
    `${nightly.days} open days, ${nightly.snap}`);

  // Keying on the nominal end does not hide how much of the window was seen:
  // that is on the row, which is what lets a reader tell an open window from a
  // closed one without inspecting the key.
  check('15d a window still open is legible as partial',
    nightly.days < 30, `${nightly.days} open days of a 30-day window`);

  // A data-level invariant over the whole table, not just this fixture: every
  // span is an evaluation horizon. Any other span is a mid-window snapshot that
  // got past the key.
  const { rows: offHorizon } = await pool.query(
    `SELECT DISTINCT (window_end - window_start) AS span
       FROM recommendation_outcomes
      WHERE (window_end - window_start) NOT IN (7, 30, 60, 90)
      ORDER BY 1`
  );
  check('15e no row sits at a span that is not an evaluation horizon',
    offHorizon.length === 0,
    offHorizon.map((r) => r.span).join(', '));

  console.log('\n── The arm is derived from the same key that assigned it ──');

  const rec = {
    client_id: 171, location_id: 171,
    primary_skus: ['080686001904'], action_type: 'reorder',
  };
  const armA = outcomes.armFor(rec, 10);
  const armB = outcomes.armFor(rec, 10);
  check('17 the derived arm is stable', armA === armB && /^(shown|withheld)$/.test(armA),
    armA);
  check('18 pct 0 puts everything in the shown arm',
    outcomes.armFor(rec, 0) === 'shown');

  await pool.query('DELETE FROM recommendation_outcomes WHERE client_id = $1', [CID]);

  console.log('');
  console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
