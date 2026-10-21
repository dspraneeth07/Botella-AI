#!/usr/bin/env node
/**
 * Recommendation admission verification (sheet 02, serving side).
 *
 * The promise being tested: **a recommendation is shown only if it is valid
 * and its profit claim is supportable.** Everything else is withheld with a
 * stated reason.
 *
 * The failure this guards against is the old behaviour: a markdown for a store
 * whose POS sends no cost, computed against cost = 0, recommending a
 * liquidation on an imaginary 100% margin. 31 stores and 355k SKUs are in that
 * position right now (gokul, square, mpower at 0.00% cost coverage).
 *
 * PREREQ: analytics migration 017.
 * Run:  node tests/rec-admission-verify.js
 */
require('dotenv').config();

// PIN THE FLOORS BEFORE THE MODULE READS THEM. The gate reads
// REC_MIN_CONFIDENCE and REC_MIN_PROFIT_USD once, at require time, and a
// checkout whose .env sets either to 0 (this one does, for the pilot) would
// make checks 7 and 7b fail for a reason that has nothing to do with the code.
// The suite tests the gate's rules, not the operator's current settings.
process.env.REC_MIN_CONFIDENCE = '0.35';
process.env.REC_MIN_PROFIT_USD = '1';
process.env.REC_REQUIRE_PROFIT_FIGURE = 'true';

const { getAnalyticsPool } = require('../database/analytics-connection');
const gate = require('../services/recommendationGateService');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const rec = (over = {}) => ({
  id: 1, rank: 1, action_type: 'markdown', category: 'inventory_overstock',
  confidence: 0.8, suggested_order_qty: null, primary_skus: ['SKU1'], ...over,
});

const product = (over = {}) => ({
  sku: 'SKU1', product_name: 'Bourbon', price: 30, cost: 18, stock_qty: 10, ...over,
});

const PASS = { verdict: 'pass', unavailable_fields: [], never_synced: false };
const NO_COST = {
  verdict: 'degraded', unavailable_fields: ['cost'], never_synced: false,
  connector: 'gokul',
};

(async () => {
  const pool = getAnalyticsPool();
  const ready = await pool.query(
    `SELECT to_regclass('public.store_quality_state')      IS NOT NULL
        AND to_regclass('public.recommendation_admission') IS NOT NULL AS ok`
  );
  if (!ready.rows[0].ok) {
    console.error('Analytics migration 017 is not applied — run `npm run migrate`.');
    process.exit(2);
  }

  console.log('\n── A margin claim needs a margin ───────────────────────────');

  let d = gate.admit(rec(), { quality: PASS, products: [product()] });
  check('1  a markdown with real cost is shown, with a dollar figure',
    d.visible === true && d.expected_profit_usd === 120 && d.profit_basis === 'margin',
    JSON.stringify(d));

  d = gate.admit(rec(), { quality: NO_COST, products: [product({ cost: null })] });
  check('2  the SAME markdown is WITHHELD when the POS sends no cost',
    d.visible === false && d.reasons.includes('missing_field:cost'),
    JSON.stringify(d.reasons));
  check('2b and the owner gets a sentence naming the cause',
    /not sending unit cost/.test(d.explanation || ''), d.explanation);
  check('2c no invented profit figure accompanies it',
    d.expected_profit_usd === null, String(d.expected_profit_usd));

  // The specific old bug: cost 0 read as free, producing a 100% margin.
  d = gate.admit(rec(), { quality: PASS, products: [product({ cost: 0 })] });
  check('3  a cost of ZERO never becomes a 100% margin',
    d.visible === false && d.reasons.some((r) => r.startsWith('no_profit_estimate')),
    JSON.stringify(d));

  console.log('\n── Advice that makes no margin claim survives ──────────────');

  d = gate.admit(rec({ action_type: 'cold_box', category: 'weather' }),
    { quality: NO_COST, products: [product({ cost: null })] });
  check('4  a cold_box on a heat advisory is still shown to a no-cost store',
    d.visible === true, JSON.stringify(d.reasons));
  check('4b punishing a store for its POS vendor\'s defect would be wrong',
    d.visible === true);

  d = gate.admit(rec({ action_type: 'promote' }),
    { quality: NO_COST, products: [product({ cost: null })] });
  check('4c promote survives too — price alone carries a revenue claim',
    d.visible === true, JSON.stringify(d.reasons));

  console.log('\n── The store\'s data must be usable at all ──────────────────');

  for (const [verdict, label] of [['reject', 'rejected'], ['quarantine', 'quarantined']]) {
    d = gate.admit(rec({ action_type: 'cold_box' }),
      { quality: { verdict, unavailable_fields: [] }, products: [product()] });
    check(`5  a ${label} batch produces NO recommendation at all`,
      d.visible === false && d.reasons.includes(`store_quality:${verdict}`));
  }

  d = gate.admit(rec({ action_type: 'cold_box' }), {
    quality: { verdict: 'unknown', unavailable_fields: [], never_synced: false },
    products: [product()],
  });
  check('5b an UNGATED store still gets advice (shipping a gate must not '
    + 'silence the estate)', d.visible === true);

  d = gate.admit(rec({ action_type: 'cold_box' }), {
    quality: { verdict: 'degraded', unavailable_fields: [], never_synced: true },
    products: [product()],
  });
  check('5c a never-synced store is refused', d.visible === false
    && d.reasons.includes('store_never_synced'));

  console.log('\n── Staleness is relative to the store\'s own cadence ────────');

  const weekly = {
    verdict: 'degraded', unavailable_fields: [], never_synced: false,
    median_interval_days: 7, staleness_days: 20,
  };
  d = gate.admit(rec({ action_type: 'cold_box' }), { quality: weekly, products: [product()] });
  check('6  a weekly store at 20 days is still inside tolerance (6 × 7)',
    d.visible === true, JSON.stringify(d.reasons));

  d = gate.admit(rec({ action_type: 'cold_box' }), {
    quality: { ...weekly, staleness_days: 60 }, products: [product()],
  });
  check('6b the same store at 60 days is refused', d.visible === false
    && d.reasons.some((r) => r.startsWith('data_too_stale')));

  d = gate.admit(rec({ action_type: 'cold_box' }), {
    quality: { verdict: 'degraded', unavailable_fields: [], median_interval_days: 1,
      staleness_days: 20 },
    products: [product()],
  });
  check('6c a DAILY store at the same 20 days IS refused — the point of '
    + 'relative staleness', d.visible === false);

  console.log('\n── Thin evidence and trivial gains ─────────────────────────');

  // THE FLOOR APPLIES TO A CALIBRATED, DISCRIMINATING FIGURE AND TO NOTHING
  // ELSE. QA measured what filtering on the bare number did: 33 Tuscany cards
  // gated on a raw ranking score, 352 estate-wide on an unlabelled one, and a
  // forward test where higher stated confidence went with LOWER hit rates.
  d = gate.admit(rec({ action_type: 'cold_box', confidence: 0.1, confidence_basis: 'isotonic' }),
    { quality: PASS, products: [product()] });
  check('7  a low CALIBRATED confidence is withheld',
    d.visible === false && d.reasons.some((r) => r.startsWith('low_confidence')),
    JSON.stringify(d.reasons));

  d = gate.admit(rec({ action_type: 'cold_box', confidence: 0.1, confidence_basis: 'raw_ranking_score' }),
    { quality: PASS, products: [product()] });
  check('7c the same 0.10 on a RAW ranking score is NOT floored - it was never a probability',
    d.visible === true && d.reasons.length === 0, JSON.stringify(d));
  check('7d and the skip is recorded on the decision, not silent',
    Array.isArray(d.notes) && d.notes.includes('confidence_floor_not_applicable:raw_ranking_score'),
    JSON.stringify(d.notes));

  d = gate.admit(rec({ action_type: 'cold_box', confidence: 0.1 }),
    { quality: PASS, products: [product()] });
  check('7e a card with NO basis reads as not_recorded and is not floored either',
    d.visible === true && d.notes.includes('confidence_floor_not_applicable:not_recorded'),
    JSON.stringify(d));

  for (const basis of ['isotonic_constant', 'isotonic_flat_slate', 'isotonic_constant_flat_slate',
    'family_evidence_count', 'llm_stated']) {
    d = gate.admit(rec({ action_type: 'cold_box', confidence: 0.1, confidence_basis: basis }),
      { quality: PASS, products: [product()] });
    check(`7f ${basis} is not floored and carries the note`,
      d.visible === true && d.notes.includes(`confidence_floor_not_applicable:${basis}`),
      JSON.stringify(d));
  }

  d = gate.admit(rec({ action_type: 'cold_box', confidence: 0.1, confidence_basis: 'made_up' }),
    { quality: PASS, products: [product()] });
  check('7g an UNKNOWN basis is treated as not_recorded, never as calibrated',
    d.visible === true && d.notes.includes('confidence_floor_not_applicable:not_recorded'),
    JSON.stringify(d));

  d = gate.admit(rec({ action_type: 'cold_box', confidence: 0.9, confidence_basis: 'isotonic' }),
    { quality: PASS, products: [product()] });
  check('7h a calibrated card above the floor carries no note - every floor applied',
    d.visible === true && d.notes.length === 0, JSON.stringify(d));

  d = gate.admit(rec(), { quality: PASS, products: [product({ price: 10.05, cost: 10, stock_qty: 1 })] });
  check('7b a gain of $0.05 is below the floor and not worth an owner\'s time',
    d.visible === false && d.reasons.some((r) => r.startsWith('profit_below_floor')),
    JSON.stringify(d));

  console.log('\n── Empty store → full store ────────────────────────────────');

  // EMPTY: no products enriched at all (the warehouse has nothing for it).
  d = gate.admit(rec(), { quality: PASS, products: [] });
  check('8  a store with NO product data yields no profit figure, so the '
    + 'margin claim is withheld', d.visible === false && d.expected_profit_usd === null);

  // A SKU with zero on-hand and no order quantity: nothing to multiply.
  d = gate.admit(rec(), { quality: PASS, products: [product({ stock_qty: 0 })] });
  check('8b zero units yields NO figure rather than $0 (a real distinction)',
    d.expected_profit_usd === null && d.visible === false);

  // FULL: everything present.
  d = gate.admit(rec({ action_type: 'reorder', suggested_order_qty: 24 }),
    { quality: PASS, products: [product()] });
  check('8c a full store with a canonical order quantity gets a real figure',
    d.visible === true && d.expected_profit_usd === 288, JSON.stringify(d));

  console.log('\n── applyAdmission over a whole run ─────────────────────────');

  const run = [
    rec({ id: 11, rank: 1, action_type: 'markdown' }),
    rec({ id: 12, rank: 2, action_type: 'cold_box', category: 'weather' }),
    rec({ id: 13, rank: 3, action_type: 'liquidate' }),
  ].map((r) => ({ ...r, products: [product({ cost: null })] }));

  const applied = gate.applyAdmission(run, NO_COST);
  check('9  a no-cost store keeps its weather advice and loses its margin advice',
    applied.visible.length === 1 && applied.visible[0].action_type === 'cold_box',
    JSON.stringify(applied.visible.map((r) => r.action_type)));
  check('9b withheld items are RETURNED with reasons, never silently dropped',
    applied.withheld.length === 2
      && applied.withheld.every((w) => w.reasons.length && w.explanation));
  check('9c every shown recommendation carries how old its data is',
    'data_as_of_days_ago' in applied.visible[0]);

  const allGood = gate.applyAdmission(
    run.map((r) => ({ ...r, products: [product()] })), PASS
  );
  check('9d a healthy store sees everything', allGood.visible.length === 3
    && allGood.withheld.length === 0);

  console.log('\n── Degrading safely ────────────────────────────────────────');

  const q = await gate.getStoreQuality(pool, -99991, -99991);
  check('10 an unexamined store reads as ungated and ADMITS',
    q.verdict === 'unknown' && q.ungated === true);

  const broken = { query: async () => { throw new Error('connection reset'); } };
  const q2 = await gate.getStoreQuality(broken, 1, 1);
  check('10b a quality-table failure never blocks serving',
    q2.verdict === 'unknown' && q2.ungated === true);

  await pool.end();
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\nverification aborted:', err);
  process.exit(1);
});
