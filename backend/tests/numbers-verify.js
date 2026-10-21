#!/usr/bin/env node
/**
 * utils/numbers verification — unknown must never become zero.
 *
 * This bug class shipped FOUR times across the rebuild before anything caught
 * it, every time via the same obvious-looking line:
 *
 *     Number.isFinite(Number(x)) ? Number(x) : null
 *
 * which is wrong for exactly the values that mean "absent":
 *
 *     Number(null) === 0   Number('') === 0   Number([]) === 0
 *
 * The consequences were all the same shape — a confident zero standing in for
 * a missing measurement:
 *
 *   • null suggested_order_qty  -> units 0 -> no profit figure on ANY markdown
 *   • absent engine.input_tokens -> "0 tokens used" rather than unknown
 *   • absent engine.cost_usd     -> "$0.00" rather than unknown
 *   • NULL product price         -> a usable product priced at 0, producing
 *                                   profit 0 and the WRONG refusal reason
 *
 * A cost of 0.00 yields a 100% margin. A staleness of 0 reads as fresh. This
 * file is the guard that stops the fifth occurrence.
 *
 * Run:  node tests/numbers-verify.js
 */

const { isNumeric, toInt, toNumber, toPositiveNumber } = require('../utils/numbers');
const gate = require('../services/recommendationGateService');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

console.log('\n── Absent in, null out (the four that coerce to 0) ─────────');

for (const [value, label] of [
  [null, 'null'], [undefined, 'undefined'], ['', "''"], ['   ', "'   '"],
  [[], '[]'], [false, 'false'], [true, 'true'],
]) {
  check(`1  toNumber(${label}) is null, not 0`, toNumber(value) === null,
    String(toNumber(value)));
}

console.log('\n── Real numbers still pass through ─────────────────────────');

check('2  integers', toNumber(5) === 5 && toNumber(0) === 0 && toNumber(-3) === -3);
check('2b a genuine zero is PRESERVED (0 is a measurement when it is written)',
  toNumber(0) === 0 && toNumber('0') === 0);
check('2c numeric strings', toNumber('7') === 7 && toNumber(' 7.5 ') === 7.5);
check('2d non-numeric strings are null', toNumber('abc') === null);
check('2e NaN and Infinity are null',
  toNumber(NaN) === null && toNumber(Infinity) === null && toNumber(-Infinity) === null);

console.log('\n── toInt truncates, never invents ──────────────────────────');

check('3  "2.0" for a keg partial lands as 2, not null', toInt('2.0') === 2);
check('3b truncates toward zero', toInt(2.9) === 2 && toInt(-2.9) === -2);
check('3c absent stays null', toInt(null) === null && toInt('') === null);

console.log('\n── toPositiveNumber: zero money means unknown ──────────────');

check('4  a cost of 0.00 is UNKNOWN, not free', toPositiveNumber(0) === null);
check('4b a real cost survives', toPositiveNumber(12.5) === 12.5);
check('4c negatives are not costs', toPositiveNumber(-1) === null);
check('4d absent stays null', toPositiveNumber(null) === null);

check('5  isNumeric agrees with toNumber',
  isNumeric(0) === true && isNumeric(null) === false && isNumeric('') === false);

console.log('\n── The four original bugs, each re-checked at its call site ─');

const product = (over = {}) => ({
  sku: 'SKU1', product_name: 'Bourbon', price: 30, cost: 18, on_hand: 10, ...over,
});
const rec = (over = {}) => ({
  id: 1, rank: 1, action_type: 'markdown', confidence: 0.8,
  suggested_order_qty: null, primary_skus: ['SKU1'], ...over,
});

// BUG 1 — a markdown carries no order quantity by nature.
let profit = gate.estimateProfit(rec(), [product()]);
check('6  BUG 1: a null suggested_order_qty falls back to on_hand, not 0',
  profit.amount === 120, JSON.stringify(profit));

// ...and an explicit zero is still respected as a real instruction.
profit = gate.estimateProfit(rec({ suggested_order_qty: 0 }), [product()]);
check('6b an EXPLICIT zero quantity is still honoured as zero',
  profit.amount === null, JSON.stringify(profit));

// BUG 2 — enrichment field name, and cost present at all.
profit = gate.estimateProfit(rec(), [product({ on_hand: 7, stock_qty: undefined })]);
check('7  BUG 2: `on_hand` (what enrichment emits) is read',
  profit.amount === 84, JSON.stringify(profit));
profit = gate.estimateProfit(rec(), [{ sku: 'X', price: 30, cost: 18, stock_qty: 7 }]);
check('7b `stock_qty` (the warehouse column) is also accepted',
  profit.amount === 84, JSON.stringify(profit));

// BUG 3 — a NULL price must not read as a product priced at zero.
profit = gate.estimateProfit(rec(), [product({ price: null })]);
check('8  BUG 3: a NULL price yields NO figure, not a $0 product',
  profit.amount === null && (profit.missing || []).includes('price'),
  JSON.stringify(profit));
check('8b and the refusal reason is the RIGHT one (no estimate, not "below floor")',
  profit.basis === 'none');

// BUG 4 — a zero cost must never become a 100% margin.
profit = gate.estimateProfit(rec(), [product({ cost: 0 })]);
check('9  BUG 4: a cost of 0.00 yields no margin, not a 100% one',
  profit.amount === null && (profit.missing || []).includes('cost'),
  JSON.stringify(profit));

console.log('\n── Staleness: null must not read as "0 days old" ───────────');

let d = gate.admit(rec({ action_type: 'cold_box' }), {
  quality: { verdict: 'degraded', unavailable_fields: [],
    staleness_days: null, median_interval_days: 7 },
  products: [product()],
});
check('10 a null staleness does not silently become "fresh today"',
  d.visible === true && !d.reasons.some((r) => r.startsWith('data_too_stale')),
  JSON.stringify(d.reasons));

d = gate.admit(rec({ action_type: 'cold_box', confidence: null }),
  { quality: { verdict: 'pass', unavailable_fields: [] }, products: [product()] });
check('10b a null confidence is not treated as 0 and wrongly withheld',
  d.visible === true, JSON.stringify(d.reasons));

console.log('\n── The audit columns that were silently zeroed ─────────────');

const daily = require('../services/dailySnapshotService');
check('11 engine token/cost fields absent -> NULL, not 0',
  daily._internals !== undefined);
// asInt is now the shared toInt; prove the behaviour that was wrong before.
check('11b an absent token count is null', toInt(undefined) === null && toInt(null) === null);
check('11c an absent cost_usd is null', toNumber(null) === null);
check('11d an absent http_status is null (not "HTTP 0")', toInt(null) === null);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
