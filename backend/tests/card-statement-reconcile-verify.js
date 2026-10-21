#!/usr/bin/env node
/**
 * Card Statement Analysis - do the printed numbers agree with each other?
 *
 * A statement prints the same money several ways: by day, by card type, as fee
 * lines and as one summary. When a read is right those views agree to the
 * cent, which is how a misread row, a dropped page or a flipped sign is caught
 * without anyone opening the PDF (CARD-STATEMENTS.md §4).
 *
 * Pinned here:
 *
 *   CLEAN       all 12 hand-verified samples pass 8 of 8
 *   PRECISE     each check fails on a copy corrupted for THAT check, and only
 *               that check fails, so a failed label names the real problem
 *   TOLERANCE   $0.05, and the fee-line rate floor (D11): 5 cents passes,
 *               6 cents fails; large lines get 0.01% of rate x base
 *   SKIPPED     a check with nothing to check is skipped and not counted
 *   CORE        the header an analysis cannot run without
 *
 * Run:  node tests/card-statement-reconcile-verify.js
 */

const path = require('path');
const { reconcile, coreHeaderMissing, LABELS, TOLERANCE, RATE_FLOOR } = require('../services/cardStatementReconcile');

const FIXTURES = path.join(__dirname, 'fixtures', 'card-statements');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const load = (name) => JSON.parse(JSON.stringify(require(path.join(FIXTURES, `${name}.extracted.json`))));
const NAMES = ['498387143882', '498407670880', '498466534886', '498480373881']
  .flatMap((m) => ['202605', '202606', '202607'].map((p) => `${m}_${p}`));

const CHECKS = ['daily_submitted_total', 'daily_fees_total', 'card_types_total', 'fee_lines_total',
  'summary_equation', 'fee_line_rate_math', 'fee_bases_match_card_types', 'card_type_rows'];
const N = CHECKS.length;
const failedNames = (r) => r.checks.filter((c) => !c.skipped && !c.ok).map((c) => c.name);
const round2 = (n) => Math.round(n * 100) / 100;

/* ── 1. Every sample passes every check ───────────────────────────────────── */

console.log(`\nCLEAN - the 12 samples pass ${N} of ${N}`);

check('tolerance is $0.05 and the rate floor is $0.05', TOLERANCE === 0.05 && RATE_FLOOR === 0.05);
check('every check has an owner-facing label', CHECKS.every((n) => typeof LABELS[n] === 'string' && LABELS[n].length > 0
  && !/[\u2013\u2014]/.test(LABELS[n])));

for (const name of NAMES) {
  const r = reconcile(load(name));
  check(`${name}: ${N}/${N}, confidence 1, ok`, r.passed === N && r.total === N && r.confidence === 1 && r.ok === true,
    `${r.passed}/${r.total} failed: ${failedNames(r).join(',')}`);
  check(`${name}: the ${N} checks in contract order, none skipped`,
    r.checks.map((c) => c.name).join() === CHECKS.join() && r.checks.every((c) => c.ok === true && c.skipped === false
      && c.label === LABELS[c.name]));
}

/* ── 2. A corrupted copy fails exactly the right check ────────────────────── */

console.log('\nPRECISE - each corruption fails its own check and nothing else');

// Each corruption moves exactly one printed view of the money.
const CORRUPT = {
  // One day's sales misread by a dollar.
  daily_submitted_total: (x) => { x.daily[1].submitted = round2(x.daily[1].submitted + 1); },
  // One day's fees misread by a dollar.
  daily_fees_total: (x) => { x.daily[1].fees = round2(x.daily[1].fees + 1); },
  // A card type read twice: an extra row that agrees with itself and has no
  // rated fee lines, so only the total moves.
  card_types_total: (x) => {
    x.card_types.push({ type: 'OTHER', label: 'MISREAD ROW', avg_ticket: 1, items: 1, gross: 1, refund_items: 0, refunds: 0,
      net_items: 1, net: 1 });
  },
  // A fee line read twice: an extra, unrated line.
  fee_lines_total: (x) => {
    x.fee_lines.push({ category: 'account', product: null, network: null, description: 'MISREAD LINE', is_debit: false,
      rate: null, base_amount: null, count: null, unit_price: null, fee_type: 'Fees', amount: 1 });
  },
  // The net deposit misread.
  summary_equation: (x) => { x.summary.amount_processed = round2(x.summary.amount_processed + 1); },
  // A rate misread: 0.03 read as 0.031 (amount and base untouched).
  fee_line_rate_math: (x) => {
    const line = x.fee_lines.find((l) => typeof l.rate === 'number' && typeof l.base_amount === 'number' && l.base_amount > 1000);
    line.rate = Math.round((line.rate + 0.001) * 1e6) / 1e6;
  },
  // A rated line filed under the wrong network.
  fee_bases_match_card_types: (x) => {
    const line = x.fee_lines.find((l) => l.category === 'transaction' && l.network === 'VISA' && typeof l.rate === 'number');
    line.network = 'AMEX';
  },
  // A card type's count not read (net untouched, so every total still adds up).
  card_type_rows: (x) => { x.card_types[0].items = null; },
};

for (const name of NAMES) {
  for (const target of CHECKS) {
    const x = load(name);
    CORRUPT[target](x);
    const r = reconcile(x);
    const bad = failedNames(r);
    check(`${name}: corrupting ${target} fails exactly that check`,
      bad.length === 1 && bad[0] === target && r.passed === N - 1 && r.total === N && r.ok === false
        && r.confidence === Math.round(((N - 1) / N) * 10000) / 10000,
      `failed: ${bad.join(',')} (${r.passed}/${r.total})`);
  }
}
{
  const x = load(NAMES[2]);
  CORRUPT.fee_line_rate_math(x);
  const c = reconcile(x).checks.find((k) => k.name === 'fee_line_rate_math');
  check('a failed rate check names the line it failed on', Array.isArray(c.detail) && c.detail.length === 1
    && typeof c.detail[0].description === 'string' && typeof c.detail[0].index === 'number', JSON.stringify(c.detail));
  const y = load(NAMES[2]);
  CORRUPT.daily_submitted_total(y);
  const d = reconcile(y).checks.find((k) => k.name === 'daily_submitted_total');
  check('a failed total reports expected and actual', d.expected === y.summary.amount_submitted
    && Math.abs(d.actual - (y.summary.amount_submitted + 1)) < 0.005, JSON.stringify(d));
}

/* ── 3. Tolerances ────────────────────────────────────────────────────────── */

console.log('\nTOLERANCE - $0.05, and the fee-line rate floor (D11)');

function oneLine(amount, { rate = 0.03, base = 100 } = {}) {
  return {
    merchant: { number: '400000000001' }, period: { start: '2026-07-01', end: '2026-07-31' },
    summary: { amount_submitted: base, paid_by_others: 0, disputes: 0, adjustments: 0, fees: amount, amount_processed: round2(base - amount) },
    daily: [], card_types: [], month_end_charges: null,
    fee_lines: [{ category: 'other', network: null, description: 'RATED LINE', rate, base_amount: base, amount }],
  };
}
const rateOk = (x) => reconcile(x).checks.find((c) => c.name === 'fee_line_rate_math').ok;

check('0.03 x $100.00 printed $3.05 (5 cents over) passes', rateOk(oneLine(3.05)) === true);
check('0.03 x $100.00 printed $3.06 (6 cents over) fails', rateOk(oneLine(3.06)) === false);
check('0.03 x $100.00 printed $2.95 (5 cents under) passes', rateOk(oneLine(2.95)) === true);
check('0.03 x $100.00 printed $2.94 (6 cents under) fails', rateOk(oneLine(2.94)) === false);
// WR Jul VISA DEBIT: 0.03 x $119,190.57 = 3,575.7171, printed $3,575.74. 0.01% of it is $0.36.
check('0.03 x $119,190.57 printed $3,575.74 passes (the processor rounds per transaction)',
  rateOk(oneLine(3575.74, { base: 119190.57 })) === true);
check('0.03 x $1,000,000.00: $30,003.00 passes (0.01% = $3.00)', rateOk(oneLine(30003, { base: 1000000 })) === true);
check('0.03 x $1,000,000.00: $30,003.10 fails', rateOk(oneLine(30003.1, { base: 1000000 })) === false);

{
  const base = load(NAMES[0]);
  const at = (delta) => {
    const x = JSON.parse(JSON.stringify(base));
    x.summary.amount_processed = round2(x.summary.amount_processed + delta);
    return reconcile(x).checks.find((c) => c.name === 'summary_equation').ok;
  };
  check('a total 5 cents off passes', at(0.05) === true && at(-0.05) === true);
  check('a total 6 cents off fails', at(0.06) === false && at(-0.06) === false);
}

/* ── 4. Skipped checks are not counted ────────────────────────────────────── */

console.log('\nSKIPPED - nothing to check is not a pass and not a failure');

{
  // A CSV-shaped extraction: no fee lines, no fee column.
  const csv = {
    layout_version: 'csv', merchant: { number: '400000000003' }, period: { start: '2026-07-01', end: '2026-07-03' },
    summary: { amount_submitted: 135.55, paid_by_others: null, disputes: 0, adjustments: 0, fees: null, amount_processed: null },
    daily: [{ date: '2026-07-01', submitted: 10, fees: null }, { date: '2026-07-02', submitted: 25.55, fees: null },
      { date: '2026-07-03', submitted: 100, fees: null }],
    month_end_charges: null,
    card_types: [{ type: 'VISA', items: 2, gross: 110, refund_items: 0, refunds: 0, net_items: 2, net: 110 },
      { type: 'MASTERCARD', items: 1, gross: 25.55, refund_items: 0, refunds: 0, net_items: 1, net: 25.55 }],
    fee_lines: [],
  };
  const r = reconcile(csv);
  const skipped = r.checks.filter((c) => c.skipped).map((c) => c.name);
  check('without fees, five checks are skipped', skipped.join() === ['daily_fees_total', 'fee_lines_total', 'summary_equation',
    'fee_line_rate_math', 'fee_bases_match_card_types'].join(), skipped.join());
  check('skipped checks have ok null and are not counted', r.checks.filter((c) => c.skipped).every((c) => c.ok === null)
    && r.total === 3 && r.passed === 3 && r.confidence === 1 && r.ok === true, `${r.passed}/${r.total}`);
  csv.card_types[0].gross = 111;
  csv.card_types[0].net = 111;
  const r2 = reconcile(csv);
  check('a failure among the counted checks still counts', r2.total === 3 && r2.passed === 2 && r2.ok === false
    && r2.confidence === 0.6667, `${r2.passed}/${r2.total}`);
  const empty = reconcile({});
  check('nothing at all: every check skipped, total 0, confidence 1', empty.total === 0 && empty.passed === 0
    && empty.confidence === 1 && empty.ok === true && empty.checks.length === N && empty.checks.every((c) => c.skipped));
  check('reconcile(null) does not throw', reconcile(null).total === 0);
}

/* ── 4b. Card type rows: a gap the totals cannot see ──────────────────────── */

console.log('\nCARD TYPE ROWS - a row read without its sales or count fails, even though the totals add up');

{
  const rowsCheck = (x) => reconcile(x).checks.find((c) => c.name === 'card_type_rows');
  const cases = [
    ['VISA count not read', (x) => { x.card_types.find((c) => c.type === 'VISA').items = null; }, 'count missing'],
    ['VISA gross not read', (x) => { x.card_types.find((c) => c.type === 'VISA').gross = null; }, 'gross missing'],
    ['VISA gross misread', (x) => { const c = x.card_types.find((k) => k.type === 'VISA'); c.gross = round2(c.gross + 1); },
      'gross less refunds is not net'],
    ['VISA refund count not read', (x) => { x.card_types.find((c) => c.type === 'VISA').refund_items = null; }, 'refund count missing'],
    ['VISA net count misread', (x) => { x.card_types.find((c) => c.type === 'VISA').net_items += 1; }, 'counts do not add up'],
  ];
  // Spotswood July: VISA has 3 refunds, so every case above has something to break.
  for (const [label, corrupt, problem] of cases) {
    const x = load('498407670880_202607');
    corrupt(x);
    const r = reconcile(x);
    const c = rowsCheck(x);
    check(`${label}: card_type_rows fails and names the row`, c.ok === false && r.ok === false && r.confidence < 1
      && c.detail.length === 1 && c.detail[0].type === 'VISA' && c.detail[0].problems.includes(problem), JSON.stringify(c.detail));
    check(`${label}: card_types_total still passes (it sums net), so only this check could catch it`,
      label === 'VISA gross misread' || label === 'VISA gross not read' || r.checks.find((k) => k.name === 'card_types_total').ok === true);
  }
  const blank = load('498407670880_202607');
  blank.card_types.push({ type: 'OTHER', label: 'Other', avg_ticket: null, items: null, gross: null, refund_items: null,
    refunds: null, net_items: null, net: 0 });
  check('a printed row with no money on it needs no count', rowsCheck(blank).ok === true);
  check('net count is sales plus refunds, as the processor prints it (Spotswood July VISA 4187 + 3 = 4190)',
    rowsCheck(load('498407670880_202607')).ok === true);
}

/* ── 4c. Fixtures carry no real tax ID (D14) ──────────────────────────────── */

console.log('\nFIXTURES - nothing identifying beyond merchant name and number');

for (const name of NAMES) {
  const rs = load(name).reportable_sales;
  check(`${name}: tin_last4 is the synthetic "0000"`, !rs || rs.tin_last4 === '0000', rs && rs.tin_last4);
}

/* ── 5. The core header ───────────────────────────────────────────────────── */

console.log('\nCORE HEADER - what an analysis cannot run without');

for (const name of NAMES) {
  const missing = coreHeaderMissing(load(name));
  check(`${name}: nothing missing`, Array.isArray(missing) && missing.length === 0, JSON.stringify(missing));
}
{
  const cases = [
    ['merchant number null', (x) => { x.merchant.number = null; }, ['merchant number']],
    ['merchant number blank', (x) => { x.merchant.number = '   '; }, ['merchant number']],
    ['no merchant block', (x) => { delete x.merchant; }, ['merchant number']],
    ['period start null', (x) => { x.period.start = null; }, ['statement period']],
    ['period end null', (x) => { x.period.end = null; }, ['statement period']],
    ['no period block', (x) => { x.period = null; }, ['statement period']],
    ['amount submitted null', (x) => { x.summary.amount_submitted = null; }, ['amount submitted']],
    ['amount submitted as text', (x) => { x.summary.amount_submitted = '194523.58'; }, ['amount submitted']],
    ['no summary block', (x) => { delete x.summary; }, ['amount submitted']],
    ['all three', (x) => { x.merchant.number = ''; x.period.end = null; x.summary.amount_submitted = null; },
      ['merchant number', 'statement period', 'amount submitted']],
  ];
  for (const [label, corrupt, want] of cases) {
    const x = load(NAMES[2]);
    corrupt(x);
    const got = coreHeaderMissing(x);
    check(`${label} -> ${want.join(', ')}`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
  }
  check('null extraction -> all three, in order', JSON.stringify(coreHeaderMissing(null))
    === JSON.stringify(['merchant number', 'statement period', 'amount submitted']));
  const zero = load(NAMES[2]);
  zero.summary.amount_submitted = 0;
  check('an amount submitted of 0 is printed, not missing', coreHeaderMissing(zero).length === 0);
}

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('ALL CHECKS PASSED');
