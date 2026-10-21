#!/usr/bin/env node
/*
  Self-test for answer-verifier.js.

  PROVES the grader is not a rubber stamp: for each defect type (wrong weekday,
  wrong pairing, unsupported currency, closed-when-open, invented value on an
  honest-decline, wrong ranking, low recall) a deliberately WRONG answer MUST be
  graded confident_wrong/fail, and the matching CORRECT answer MUST pass.

  Run: node tests/answer-verifier-selftest.js   (exit 0 = all assertions held)
*/
const V = require('./answer-verifier');

let passed = 0, failed = 0;
const ok = (name, cond) => { if (cond) { passed++; } else { failed++; console.error('  ✗ FAIL:', name); } };

// Evidence fixtures (shape mirrors captured eval evidence: each item has .result)
const catEvidence = [{
  tool: 'get_category_sales_for_date', success: true,
  result: {
    date: '2026-06-02', salesExist: true, salesCount: 113, totalRevenue: 2791.18,
    categories: [
      { category: 'LIQUOR', revenue: 1021.60, pctOfRevenue: 36.6 },
      { category: 'BEER', revenue: 872.72, pctOfRevenue: 31.3 },
      { category: 'WINE', revenue: 453.64, pctOfRevenue: 16.3 },
    ],
  },
}];
const dayEvidence = [{
  tool: 'get_sales_by_day', success: true,
  result: { days: [
    { date: '2026-05-28', weekday: 'Thursday', revenue: 8203.71, isBestDay: false },
    { date: '2026-05-29', weekday: 'Friday', revenue: 13144.66, isBestDay: true },
    { date: '2026-05-30', weekday: 'Saturday', revenue: 12334.24, isBestDay: false },
  ] },
}];
const gtDay = { bestDay: { date: '2026-05-29', weekday: 'Friday', revenue: 13144.66 },
  dateToWeekday: { '2026-05-28': 'Thursday', '2026-05-29': 'Friday', '2026-05-30': 'Saturday' } };

// ── 1. Weekday correctness ──
ok('correct weekday passes',
  V.gradeTurn({ answer: 'Your best day was 2026-05-29, a Friday, with $13,144.66.', evidence: dayEvidence },
    { groundTruth: gtDay }).verdict !== 'confident_wrong');
ok('wrong weekday fails',
  V.gradeTurn({ answer: 'Your best day was 2026-05-29, a Thursday, with $13,144.66.', evidence: dayEvidence },
    { groundTruth: gtDay }).verdict === 'confident_wrong');

// ── 2. Correct pairing ──
const pairingSpec = { checks: [{ type: 'pairing', expectedMap: { LIQUOR: 1021.60, BEER: 872.72, WINE: 453.64 } }] };
ok('correct pairing passes',
  V.gradeTurn({ answer: 'LIQUOR: $1,021.60, BEER: $872.72, WINE: $453.64.', evidence: catEvidence },
    { expect: pairingSpec }).verdict === 'correct');
ok('swapped pairing fails',
  V.gradeTurn({ answer: 'LIQUOR: $872.72, BEER: $1,021.60, WINE: $453.64.', evidence: catEvidence },
    { expect: pairingSpec }).verdict === 'confident_wrong');

// ── 3. Percentage with correct pairing (the 65.1 vs 69.8 style bug) ──
ok('correct share passes',
  V.gradeTurn({ answer: 'BEER made up 31.3% of revenue.', evidence: catEvidence },
    { expect: { checks: [{ type: 'pairing', expectedMap: { BEER: 31.3 } }] } }).verdict === 'correct');
ok('wrong share fails',
  V.gradeTurn({ answer: 'BEER made up 65.1% of revenue.', evidence: catEvidence },
    { expect: { checks: [{ type: 'pairing', expectedMap: { BEER: 31.3 } }] } }).verdict === 'confident_wrong');

// ── 4. Unsupported currency ──
ok('supported currency passes',
  V.gradeTurn({ answer: 'Total was $2,791.18 across the categories.', evidence: catEvidence }, {}).verdict === 'correct');
ok('fabricated currency fails',
  V.gradeTurn({ answer: 'Total was $9,999.99 across the categories.', evidence: catEvidence }, {}).verdict === 'confident_wrong');

// ── 5. Closed-when-open ──
const gtClosure = { salesExistByDate: { '2026-06-02': 113, __latest__: 113 } };
ok('closed claim when sales exist fails',
  V.gradeTurn({ answer: 'No sales were recorded on 2026-06-02 - your store may have been closed.', evidence: [] },
    { groundTruth: gtClosure }).verdict === 'confident_wrong');
ok('legit out-of-range no-sales passes',
  V.gradeTurn({ answer: 'There were no sales on 2030-01-01; that date is outside your data range.', evidence: [] },
    { groundTruth: { salesExistByDate: { '2026-06-02': 113 } } }).verdict !== 'confident_wrong');

// ── 6. Honest decline vs invented value ──
const declineSpec = { checks: [{ type: 'honest_decline', forbid: [/top cashier is \w+/i, /\bcashier [A-Z]/] }] };
ok('honest decline credited',
  V.gradeTurn({ answer: "Cashier isn't recorded in your data, so I can't attribute sales to a cashier.", evidence: [{ tool: 'run_sql', success: true, result: { rows: [] } }] },
    { expect: declineSpec }).verdict === 'honest');
ok('invented cashier fails',
  V.gradeTurn({ answer: 'Your top cashier is Maria with $5,000 in sales.', evidence: [{ tool: 'run_sql', success: true, result: { rows: [] } }] },
    { expect: declineSpec }).verdict === 'confident_wrong');

// ── 7. Ranking ──
ok('correct top product passes',
  V.gradeTurn({ answer: "Your top product by revenue is TITO'S.", evidence: [] },
    { expect: { checks: [{ type: 'ranking', topLabel: "TITO'S" }] } }).verdict !== 'confident_wrong');
ok('wrong top product fails',
  V.gradeTurn({ answer: 'Your top product by revenue is FIREBALL.', evidence: [] },
    { expect: { checks: [{ type: 'ranking', topLabel: "TITO'S" }] } }).verdict === 'confident_wrong');

// ── 8. Search recall floor ──
ok('good recall passes',
  V.gradeTurn({ answer: 'I found 415 whiskeys under $200.', evidence: [] },
    { expect: { checks: [{ type: 'min_count', min: 400 }] } }).verdict !== 'confident_wrong');
ok('low recall fails',
  V.gradeTurn({ answer: 'I found just 1 whiskey under $200.', evidence: [] },
    { expect: { checks: [{ type: 'min_count', min: 400 }] } }).verdict === 'confident_wrong');

// ── 9. Large count grounded vs fabricated ──
const countEvidence = [{ tool: 'run_sql', success: true, result: { rows: [{ total: 17745 }] } }];
ok('grounded large count passes',
  V.gradeTurn({ answer: 'You have 17,745 products in your catalog.', evidence: countEvidence }, {}).verdict === 'correct');
ok('fabricated large count fails',
  V.gradeTurn({ answer: 'You have 25,000 products in your catalog.', evidence: countEvidence }, {}).verdict === 'confident_wrong');
ok('reasonable rounding of count tolerated',
  V.gradeTurn({ answer: 'You have about 17,700 products.', evidence: countEvidence }, {}).verdict === 'correct');

// ── 10. Down-scaling hole: a fabricated currency must NOT be excused by evidence 0s ──
const zeroEvidence = [{ tool: 'get_category_sales_for_date', success: true, result: { salesExist: false, salesCount: 0, totalRevenue: 0, coverage: { mappedPct: 100 }, categories: [] } }];
ok('fabricated currency not excused by evidence zeros',
  V.gradeTurn({ answer: 'There were 113 sales totalling $2787.22 that day.', evidence: zeroEvidence }, {}).verdict === 'confident_wrong');
ok('750ML in product name is not a 750-million figure',
  V.gradeTurn({ answer: 'WILLETT BOURBON 8YRS 750ML is in stock.', evidence: [{ tool:'search_products', success:true, result:{ rows:[{ productName:'WILLETT BOURBON 8YRS 750ML', price:399.99 }] } }] }, {}).verdict !== 'confident_wrong');

// ── 11. Bounded derivations: top-N cumulative + adjacent delta pass; fabricated fails ──
ok('top-3 cumulative share passes',
  V.gradeTurn({ answer: 'The top 3 categories make up about 84% of revenue.', evidence: catEvidence }, {}).verdict !== 'confident_wrong');
ok('adjacent-rank revenue gap passes',
  V.gradeTurn({ answer: 'Friday brought in nearly $800 more than Saturday.', evidence: dayEvidence }, {}).verdict !== 'confident_wrong');
ok('fabricated cumulative share still fails',
  V.gradeTurn({ answer: 'The top 3 categories make up 95% of revenue.', evidence: catEvidence }, {}).verdict === 'confident_wrong');

console.log(`\nanswer-verifier self-test: ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('SELF-TEST FAILED - the grader is not reliable.'); process.exit(1); }
console.log('All assertions held - the grader returns real FAILs on wrong answers and passes correct ones.');
