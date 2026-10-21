#!/usr/bin/env node
/**
 * Card Statement Analysis - what the owner would have kept with Rebelipay.
 *
 * The number an owner acts on is a difference of two five-figure totals, so it
 * is pinned here to the cent against the plan's worked table (§7.4), which was
 * computed by hand from the 12 sample statements:
 *
 *   PRICE      one all-in charge per transaction; the PDF basis rounds once
 *              per statement, the CSV basis rounds every transaction
 *   REFUNDS    the fee comes back on refunded transactions (D5, the default);
 *              with that off the engine reproduces the gross-only table
 *   SPLIT      the per-card-type rows add up to the totals exactly
 *   NEVER      the price never leaves the engine in parts: no field, value or
 *              string anywhere in the output exposes the percentage part, the
 *              per-transaction part, the refund credit or the offer's terms
 *              (D7, the ticket's acceptance criterion)
 *
 * The expected credits are computed here independently, in integer cents, from
 * the fixtures' own refund rows; nothing is read back from the code under test.
 *
 * Run:  node tests/card-statement-rebelipay-verify.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

// Deterministic CSV parsing only: no key, so the column-mapping fallback can never run.
delete process.env.ANTHROPIC_API_KEY;

const { analyse } = require('../services/cardStatementAnalysis');
const { priceRebelipay, savingsToDate } = require('../services/cardStatementPricing');
const { parseCsv } = require('../services/cardStatementExtract');
const rules = require('../services/cardStatementRules');

const FIXTURES = path.join(__dirname, 'fixtures', 'card-statements');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const load = (name) => JSON.parse(JSON.stringify(require(path.join(FIXTURES, `${name}.extracted.json`))));
const MERCHANTS = { WR: '498387143882', SP: '498407670880', BE: '498466534886', MI: '498480373881' };
const NAMES = Object.values(MERCHANTS).flatMap((m) => ['202605', '202606', '202607'].map((p) => `${m}_${p}`));

// Rules with the refund credit switched, built as a copy: the shared module stays untouched.
const withRefunds = (on) => ({ ...rules, rebelipay: { ...rules.rebelipay, refundsReturnFee: on } });
const GROSS_ONLY = withRefunds(false);

const cents = (v) => Math.round(Number(v) * 100);
const sumCents = (rows, pick) => rows.reduce((s, r) => s + cents(pick(r)), 0);

/* ── The offer, priced independently in integer arithmetic ────────────────── */
// Units: 1e-6 cent. The percentage is 25,500 parts per million; 10 cents a
// transaction is 10 x 1e6. Every product stays far inside 2^53.
const PPM = 25500;
const FEE = 10 * 1e6;
const MICRO = 1e6;
const roundHalfUp = (micro) => Math.floor((micro + MICRO / 2) / MICRO);

function independent(x) {
  const ct = x.card_types || [];
  const sales = ct.reduce((s, c) => s + cents(c.gross) * PPM + Number(c.items) * FEE, 0);
  const refunds = ct.reduce((s, c) => s + cents(c.refunds || 0) * PPM + Number(c.refund_items || 0) * FEE, 0);
  const grossOnly = roundHalfUp(sales);
  const credited = roundHalfUp(sales - refunds);
  return {
    grossOnly,
    credited,
    credit: grossOnly - credited,                    // what crediting refunds is worth on this statement
    pctPart: ct.reduce((s, c) => s + cents(c.gross) * PPM, 0) / MICRO, // cents, exact
    txnPart: ct.reduce((s, c) => s + Number(c.items) * 10, 0),         // cents
    hasRefunds: ct.some((c) => Number(c.refunds) > 0 || Number(c.refund_items) > 0),
  };
}

/* ── 1. The plan's worked table, to the cent ──────────────────────────────── */

console.log('\nWORKED TABLE - plan §7.4, PDF basis, refunds not credited');

const WORKED = [
  ['Wine Republic May', 'WR', '202605', 7200, 187377.59, 5651.28, 5498.13, 153.15, '3.02', '2.93'],
  ['Wine Republic Jun', 'WR', '202606', 6965, 186843.89, 5635.25, 5461.02, 174.23, '3.02', '2.92'],
  ['Wine Republic Jul', 'WR', '202607', 6921, 194523.58, 5865.65, 5652.45, 213.20, '3.02', '2.91'],
  ['Spotswood Jul', 'SP', '202607', 5693, 189030.63, 5670.96, 5389.58, 281.38, '3.00', '2.85'],
  ['Bethany Jul', 'BE', '202607', 5970, 227057.21, 6841.94, 6386.96, 454.98, '3.01', '2.81'],
  ['Millstone Jul', 'MI', '202607', 4420, 161077.37, 4991.37, 4549.47, 441.90, '3.10', '2.82'],
];

// D49: the plan's "keep" is the whole gap between the two costs. The PCI
// penalty on the Wine Republic and Bethany statements stops once the store
// files a free form, whichever processor it uses, so switching keeps the gap
// less the penalty, and the penalty is its own line. Millstone Jul carries a
// $159 annual compliance fee, counted once in a year, not twelve times.
const PENALTY = { 'Wine Republic May': 29.95, 'Wine Republic Jun': 29.95, 'Wine Republic Jul': 29.95, 'Bethany Jul': 29.95 };
const YEARLY_ONCE = { 'Millstone Jul': 159 };

for (const [label, store, period, txns, volume, paid, rebelipay, gap, rateNow, rateRp] of WORKED) {
  const x = load(`${MERCHANTS[store]}_${period}`);
  const { analysis, header } = analyse(x, { rules: GROSS_ONLY });
  const r = analysis.rebelipay;
  const penalty = PENALTY[label] || 0;
  const yearly = YEARLY_ONCE[label] || 0;
  const keep = (cents(gap) - cents(penalty)) / 100;
  const keepAnnualC = (cents(keep) - cents(yearly)) * 12 + cents(yearly);
  check(`${label}: ${txns} txns, $${volume} volume`, r.transactions === txns && r.volume === volume, `${r.transactions} ${r.volume}`);
  check(`${label}: paid $${paid}, with Rebelipay $${rebelipay}, the gap $${gap.toFixed(2)} is the total found`,
    r.currentCost === paid && r.rebelipayCost === rebelipay && r.totalFound === gap,
    `${r.currentCost} / ${r.rebelipayCost} / ${r.totalFound}`);
  check(`${label}: switching keeps $${keep.toFixed(2)}, the gap less the $${penalty.toFixed(2)} penalty`,
    r.savings === keep && (penalty ? r.penaltyFix === penalty && r.penaltyFixAnnual === penalty * 12
      && r.penaltyFixLabel === 'Fix the PCI penalty (free, about 20 minutes)' : r.penaltyFix === null && r.penaltyFixLabel === null),
    `${r.savings} ${r.penaltyFix} ${r.penaltyFixLabel}`);
  check(`${label}: a year counts a once-a-year fee once, and the total adds the penalty's year`,
    cents(r.savingsAnnual) === keepAnnualC && cents(r.totalFoundAnnual) === keepAnnualC + cents(penalty) * 12,
    `${r.savingsAnnual} ${r.totalFoundAnnual}`);
  // Both all-in rates are over the amount submitted (contract §6), so the gap
  // between them is the saving over the same volume.
  const submitted = x.summary.amount_submitted;
  check(`${label}: all-in rates are cost / amount submitted`,
    Math.abs(r.currentRate - (paid / submitted) * 100) < 1e-9 && Math.abs(r.rebelipayRate - (rebelipay / submitted) * 100) < 1e-9,
    `${r.currentRate} ${r.rebelipayRate}`);
  // The plan's rate column is the rate the owner sees, which credits refunds
  // (the default). Gross-only, Millstone's $4,549.47 over the $161,008.39
  // submitted would read 2.83%: the plan divided by gross volume there.
  const shown = analyse(x).analysis.rebelipay;
  check(`${label}: all-in rate chip ${rateNow}% -> ${rateRp}% (refunds credited, as shown)`,
    shown.currentRate.toFixed(2) === rateNow && shown.rebelipayRate.toFixed(2) === rateRp, `${shown.currentRate} ${shown.rebelipayRate}`);
  check(`${label}: eligible, the saving's share of the fees is switching's`,
    r.eligible === true && r.reason === null && Math.abs(r.savingsPct - (keep / paid) * 100) < 1e-9);
  check(`${label}: the independent integer price agrees`, independent(x).grossOnly === cents(rebelipay),
    String(independent(x).grossOnly));
  check(`${label}: header columns carry the raw totals`, header.rebelipayCost === rebelipay
    && header.rebelipaySavings === keep && header.rebelipayEligible === true && cents(header.rebelipaySavingsAnnual) === keepAnnualC);
  check(`${label}: KPI band shows the saving`, analysis.kpis.rebelipayEligible === true
    && analysis.kpis.rebelipaySavings === keep && analysis.kpis.rebelipaySavingsAnnual === r.savingsAnnual);
  check(`${label}: pricing basis per card type from the PDF, refunds not credited`,
    r.pricingBasis === 'per_card_type_from_pdf' && r.refundsCredited === false);
}

{
  // The rounding the plan calls out: once per statement, never per card type.
  const x = load(`${MERCHANTS.WR}_202605`);
  const perType = x.card_types.reduce((s, c) => s + roundHalfUp(cents(c.gross) * PPM + c.items * FEE), 0);
  check('WR May: one rounding per statement ($5,498.13), not one per card type ($5,498.12)',
    perType === 549812 && analyse(x, { rules: GROSS_ONLY }).analysis.rebelipay.rebelipayCost === 5498.13, String(perType));
}

/* ── 2. All 12 samples ────────────────────────────────────────────────────── */

console.log('\nALL 12 SAMPLES');

const gross = {};
const credited = {};
for (const name of NAMES) {
  gross[name] = analyse(load(name), { rules: GROSS_ONLY });
  credited[name] = analyse(load(name));
}
{
  const t = (set, k) => NAMES.reduce((s, n) => s + cents(set[n].analysis.rebelipay[k]), 0);
  // D49: six statements (Wine Republic and Bethany, three months each) carry
  // a $29.95 PCI penalty; switching keeps the gap less those $179.70.
  check('refunds not credited: $65,883.27 paid against $62,287.65, $3,595.62 found, $3,415.92 of it by switching',
    t(gross, 'currentCost') === 6588327 && t(gross, 'rebelipayCost') === 6228765 && t(gross, 'totalFound') === 359562
      && t(gross, 'savings') === 341592 && t(gross, 'penaltyFix') === 17970,
    `${t(gross, 'currentCost')} ${t(gross, 'rebelipayCost')} ${t(gross, 'savings')}`);
  check('every sample is eligible', NAMES.every((n) => gross[n].analysis.rebelipay.eligible && credited[n].analysis.rebelipay.eligible));
}

console.log('\nREFUNDS CREDITED - the default (D5)');

check('the default rules credit refunds', rules.rebelipay.refundsReturnFee === true);
{
  let withRefundRows = 0;
  for (const name of NAMES) {
    const x = load(name);
    const ind = independent(x);
    const g = gross[name].analysis.rebelipay;
    const c = credited[name].analysis.rebelipay;
    if (ind.hasRefunds) {
      withRefundRows += 1;
      check(`${name}: refunds on the statement, the owner keeps exactly ${(ind.credit / 100).toFixed(2)} more`,
        ind.credit > 0 && cents(c.savings) - cents(g.savings) === ind.credit
          && cents(g.rebelipayCost) - cents(c.rebelipayCost) === ind.credit && cents(c.rebelipayCost) === ind.credited,
        `${c.savings} vs ${g.savings}`);
      check(`${name}: what the processor charged does not move`, c.currentCost === g.currentCost);
    } else {
      const { refundsCredited: a, ...restC } = c;
      const { refundsCredited: b, ...restG } = g;
      let same = true;
      try { assert.deepStrictEqual(restC, restG); } catch { same = false; }
      check(`${name}: no refunds, so crediting them changes nothing`, same && a === true && b === false);
    }
  }
  check('the samples with refunds are the ones expected (Spotswood x3, Millstone x3)', withRefundRows === 6, String(withRefundRows));
}

/* ── 3. The per-card-type rows add up ─────────────────────────────────────── */

console.log('\nBY CARD TYPE - rows sum to the totals, to the cent');

for (const [setName, set] of [['gross only', gross], ['credited', credited]]) {
  const bad = [];
  for (const name of NAMES) {
    const r = set[name].analysis.rebelipay;
    const rows = r.byCardType;
    const cardRows = rows.filter((x) => x.type !== 'ACCOUNT_OTHER');
    const other = rows.filter((x) => x.type === 'ACCOUNT_OTHER');
    if (sumCents(rows, (x) => x.currentCost) !== cents(r.currentCost)) bad.push(`${name} currentCost`);
    if (sumCents(rows, (x) => x.rebelipayCost) !== cents(r.rebelipayCost)) bad.push(`${name} rebelipayCost`);
    if (sumCents(rows, (x) => x.savings) !== cents(r.savings)) bad.push(`${name} savings`);
    if (cardRows.reduce((s, x) => s + x.transactions, 0) !== r.transactions) bad.push(`${name} transactions`);
    if (sumCents(cardRows, (x) => x.volume) !== cents(r.volume)) bad.push(`${name} volume`);
    // The account row leaves the store's penalty out of the saving (D49).
    if (rows.some((x) => cents(x.savings) !== cents(x.currentCost) - cents(x.rebelipayCost)
      - (x.type === 'ACCOUNT_OTHER' ? cents(r.penaltyFix || 0) : 0))) bad.push(`${name} row savings`);
    if (other.length !== 1 || rows[rows.length - 1].type !== 'ACCOUNT_OTHER' || other[0].transactions !== null
      || other[0].volume !== null || other[0].rebelipayCost !== 0) bad.push(`${name} account row`);
    if (cardRows.length !== load(name).card_types.length) bad.push(`${name} row count`);
  }
  check(`${setName}: currentCost, rebelipayCost, savings, transactions and volume all add up on 12 statements`,
    bad.length === 0, bad.join(', '));
}
{
  const r = gross[`${MERCHANTS.WR}_202607`].analysis.rebelipay;
  const visa = r.byCardType.find((x) => x.type === 'VISA');
  check('WR Jul VISA row: 5,248 txns, $146,012.07, paid $4,380.39, Rebelipay $4,248.11, keep $132.28 (plan §7.4)',
    visa && visa.transactions === 5248 && visa.volume === 146012.07 && visa.currentCost === 4380.39
      && visa.rebelipayCost === 4248.11 && visa.savings === 132.28, JSON.stringify(visa));
}

/* ── 4. Savings to date ───────────────────────────────────────────────────── */

console.log('\nSAVINGS TO DATE');

{
  const rows = ['202605', '202606', '202607'].map((p) => {
    const { header } = credited[`${MERCHANTS.WR}_${p}`];
    return { periodEnd: header.periodEnd, rebelipaySavings: header.rebelipaySavings, status: 'analysed' };
  });
  const s = savingsToDate(rows);
  check('Wine Republic May-Jul: $450.73 across 3 statements, 2026-05 to 2026-07',
    s.amount === 450.73 && s.statements === 3 && s.from === '2026-05' && s.to === '2026-07', JSON.stringify(s));
  const order = savingsToDate([rows[2], rows[0], rows[1]]);
  check('upload order does not matter', JSON.stringify(order) === JSON.stringify(s));
  const snake = savingsToDate(rows.map((r) => ({ period_end: r.periodEnd, rebelipay_savings: r.rebelipaySavings })));
  check('the DB column names work too', snake.amount === 450.73 && snake.statements === 3);
  const mixed = savingsToDate(rows.concat([{ periodEnd: '2026-08-31', rebelipaySavings: -600, status: 'analysed' },
    { periodEnd: '2026-09-30', rebelipaySavings: 999, status: 'failed' }]));
  check('a negative month pulls the total down; non-analysed rows are ignored',
    mixed.amount === -149.27 && mixed.statements === 4 && mixed.to === '2026-08', JSON.stringify(mixed));
}

/* ── 5. When Rebelipay would cost more ────────────────────────────────────── */

console.log('\nNOT ELIGIBLE - Rebelipay costs more');

// Tiny tickets: 1,000 sales of $1.00 cost $125.50 with Rebelipay against $20.00 today.
const tiny = {
  processor: 'Test Payments', layout_version: 'v2_2026',
  merchant: { number: '400000000006', name: 'TINY TICKETS' }, period: { start: '2026-07-01', end: '2026-07-31' },
  summary: { amount_submitted: 1000, paid_by_others: 0, disputes: 0, adjustments: 0, fees: 20, amount_processed: 980 },
  customers: null, sales_trend: [], printed_yoy_pct: null, printed_mom_pct: null,
  daily: [{ date: '2026-07-01', submitted: 1000, disputes: 0, adjustments: 0, fees: 20, processed: 980, is_prior_period: false }],
  month_end_charges: 0,
  card_types: [{ type: 'VISA', label: 'VISA', avg_ticket: 1, items: 1000, gross: 1000, refund_items: 0, refunds: 0, net_items: 1000, net: 1000 }],
  fee_lines: [{ category: 'transaction', product: 'Visa', network: 'VISA', description: 'VISA SALES DISCOUNT 0.02 DISC RATE TIMES $1000.00',
    is_debit: false, rate: 0.02, base_amount: 1000, count: null, unit_price: null, fee_type: 'Service Charges', amount: 20 }],
  chargebacks: [], funding: [], reportable_sales: null, notices: [],
};
const costly = analyse(tiny);
{
  const r = costly.analysis.rebelipay;
  check('eligible false, reason costs_more', r.eligible === false && r.reason === 'costs_more');
  const leaked = ['currentCost', 'rebelipayCost', 'savings', 'savingsPct', 'savingsAnnual', 'rebelipayRate', 'byCardType']
    .filter((k) => k in r);
  check('no cost, saving, Rebelipay rate or card-type field survives', leaked.length === 0, leaked.join(','));
  check('the processor\'s own all-in rate is kept', r.currentRate === 2);
  check('the KPI band shows no saving', costly.analysis.kpis.rebelipayEligible === false
    && costly.analysis.kpis.rebelipaySavings === null && costly.analysis.kpis.rebelipaySavingsAnnual === null);
  check('the DB header keeps the raw (negative) saving for savings to date, and is not eligible',
    costly.header.rebelipayEligible === false && costly.header.rebelipaySavings === -105.5 && costly.header.rebelipayCost === 125.5,
    JSON.stringify(costly.header));
  const even = analyse({ ...tiny, summary: { ...tiny.summary, fees: 125.5, amount_processed: 874.5 } }).analysis.rebelipay;
  check('a saving of exactly $0.00 is not eligible either', even.eligible === false && even.reason === 'costs_more');
}
{
  const none = priceRebelipay({ ...tiny, card_types: [] }).public;
  check('nothing to price: reason no_volume', none.eligible === false && none.reason === 'no_volume' && none.rebelipayCost === null);
}

/* ── 6. CSV: every transaction rounded on its own ─────────────────────────── */

const csvAnalyses = [];
async function csvChecks() {
  console.log('\nCSV - per-transaction rounding');

  const file = path.join(FIXTURES, 'csv-three-rows.csv');
  const three = (await parseCsv({ buffer: fs.readFileSync(file), fileName: 'csv-three-rows.csv' })).extracted;
  const a3 = analyse(three).analysis;
  csvAnalyses.push(['csv-three-rows', a3, three]);
  const r = a3.rebelipay;
  check('three rows $10.00 + $25.55 + $100.00 = $0.36 + $0.75 + $2.65 = $3.76',
    r.rebelipayCost === 3.76 && r.transactions === 3 && r.volume === 135.55 && r.pricingBasis === 'per_transaction_from_csv',
    JSON.stringify(r));
  check('no fee column: reason no_current_fees, nothing to compare against',
    r.eligible === false && r.reason === 'no_current_fees' && r.currentCost === null && r.savings === null
      && r.savingsPct === null && r.savingsAnnual === null && r.currentRate === null && Array.isArray(r.byCardType)
      && r.byCardType.length === 0 && typeof r.rebelipayRate === 'number', JSON.stringify(r));
  check('no fee column: the KPI band shows no saving', a3.kpis.rebelipayEligible === false && a3.kpis.rebelipaySavings === null);

  // Three $10.00 sales: each is $0.355, rounded half up to $0.36, so $1.08.
  // One rounding of the exact $1.065 would give $1.07: this tells them apart.
  const tens = (await parseCsv({
    buffer: Buffer.from('Date,Amount,Card Type,Merchant Number\n2026-07-01,10.00,Visa,400000000004\n'
      + '2026-07-01,10.00,Visa,400000000004\n2026-07-02,10.00,Debit,400000000004\n'),
    fileName: 'tens.csv',
  })).extracted;
  const at = analyse(tens).analysis;
  csvAnalyses.push(['tens', at, tens]);
  check('three $10.00 sales price at $1.08 (per row), not $1.07 (one rounding)', at.rebelipay.rebelipayCost === 1.08,
    String(at.rebelipay.rebelipayCost));

  // With a fee column: compared, and a refund row gets its fee back.
  const withFees = (await parseCsv({
    buffer: Buffer.from('Date,Amount,Card Type,Type,Fee,Merchant Number\n'
      + '2026-07-01,100.00,Visa,Sale,3.50,400000000005\n2026-07-02,40.00,Mastercard,Sale,1.40,400000000005\n'
      + '2026-07-03,40.00,Mastercard,Refund,0,400000000005\n2026-07-04,25.55,Debit,Sale,0.90,400000000005\n'),
    fileName: 'fees.csv',
  })).extracted;
  const af = analyse(withFees).analysis;
  csvAnalyses.push(['fees', af, withFees]);
  // Sales: 2.65 + 1.12 + 0.75 = 4.52; the refund's 1.12 comes back: 3.40. Paid 5.80.
  check('CSV with fees: $5.80 paid, $3.40 with Rebelipay after the refund credit, keep $2.40',
    af.rebelipay.eligible === true && af.rebelipay.currentCost === 5.8 && af.rebelipay.rebelipayCost === 3.4
      && af.rebelipay.savings === 2.4, JSON.stringify(af.rebelipay));
  const afGross = analyse(withFees, { rules: GROSS_ONLY }).analysis;
  csvAnalyses.push(['fees gross only', afGross, withFees]);
  check('CSV with fees, refunds not credited: $4.52 with Rebelipay', afGross.rebelipay.rebelipayCost === 4.52,
    String(afGross.rebelipay.rebelipayCost));
  const rows = af.rebelipay.byCardType;
  check('CSV by card type adds up', sumCents(rows, (x) => x.currentCost) === 580 && sumCents(rows, (x) => x.rebelipayCost) === 340
    && sumCents(rows, (x) => x.savings) === 240, JSON.stringify(rows));
}

/* ── 7. The price never leaves in parts ───────────────────────────────────── */

// Keys that would name a part of the offer, anywhere in an analysis.
const FORBIDDEN_KEY = /pctRate|perTxn|per_txn|txnFee|ppm|percentPart|pctPart|feePart|fixedFee|perTransaction|refundCredit|creditAmount|monthlyFees|refundsReturnFee|roundPerTransaction|appliesTo/i;
// Values the offer's terms take; never the value of a rate, fee, cost or price field.
const OFFER_VALUES = [0.0255, 2.55, 0.1, 10, 25500, 255];
const MONEYISH_KEY = /rate|fee|cost|price|pct|charge/i;
const NOT_MONEY_KEY = /pct|share|rate|items|count|transactions|days|version|^new$|^repeat$|rows/i;
const PUBLIC_REBELIPAY_KEYS = new Set(['eligible', 'reason', 'currentProcessor', 'transactions', 'volume', 'currentCost',
  'rebelipayCost', 'savings', 'savingsPct', 'savingsAnnual', 'currentRate', 'rebelipayRate', 'byCardType', 'pricingBasis',
  'refundsCredited', 'penaltyFix', 'penaltyFixAnnual', 'penaltyFixLabel', 'totalFound', 'totalFoundAnnual']);
const ROW_KEYS = new Set(['type', 'label', 'transactions', 'volume', 'currentCost', 'rebelipayCost', 'savings']);

function walk(value, visit, at = '$', key = null) {
  visit(value, at, key);
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, visit, `${at}[${i}]`, key));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, visit, `${at}.${k}`, k);
}

function scan(label, output, extracted) {
  const bad = [];
  const rp = output.analysis.rebelipay;
  // The components of THIS statement's price, in cents.
  const ct = extracted.card_types || [];
  const pctPart = ct.reduce((s, c) => s + cents(c.gross) * PPM, 0) / MICRO;
  const txnPart = ct.reduce((s, c) => s + Number(c.items) * 10, 0);
  const ind = independent(extracted);
  const componentCents = new Set([Math.round(pctPart), Math.floor(pctPart), Math.ceil(pctPart), txnPart]);
  // The refund credit is a component only where it was applied.
  if (rp.refundsCredited && ind.credit > 0) componentCents.add(ind.credit);
  // In dollars and as printed strings, the same components.
  const componentText = [...componentCents].map((c) => (c / 100).toFixed(2));

  walk(output, (v, at, key) => {
    if (key && FORBIDDEN_KEY.test(key)) bad.push(`${at}: forbidden key`);
    if (typeof v === 'number' && Number.isFinite(v)) {
      // Money only: a 100% share or a count of 100 is not a dollar amount.
      if (!(key && NOT_MONEY_KEY.test(key))
        && componentCents.has(Math.round(v * 100)) && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6) {
        bad.push(`${at}: equals a price component (${v})`);
      }
      if (key && MONEYISH_KEY.test(key) && at.includes('rebelipay') && OFFER_VALUES.includes(v)) bad.push(`${at}: an offer value (${v})`);
    }
    if (typeof v === 'string') {
      if (/2\.55\s*%|0\.0255|10\s*(¢|cents?\b)|\$0\.10\b|per[- ]transaction fee/i.test(v)) bad.push(`${at}: names the price`);
      for (const t of componentText) if (new RegExp(`(^|[^0-9.,])\\$?${t.replace('.', '\\.')}(?![0-9])`).test(v.replace(/,/g, ''))) {
        bad.push(`${at}: prints a price component (${t})`);
      }
    }
  });

  for (const k of Object.keys(rp)) if (!PUBLIC_REBELIPAY_KEYS.has(k)) bad.push(`rebelipay.${k}: undocumented field`);
  for (const row of rp.byCardType || []) for (const k of Object.keys(row)) if (!ROW_KEYS.has(k)) bad.push(`byCardType.${k}: undocumented field`);
  for (const [k, v] of Object.entries(rp)) {
    if (typeof v === 'number' && OFFER_VALUES.includes(v) && k !== 'transactions') bad.push(`rebelipay.${k} = ${v}`);
  }
  check(`${label}: no component key, value or wording`, bad.length === 0, bad.slice(0, 4).join('; '));
}

function deepScan() {
  console.log('\nDEEP SCAN - no component of the price in any output');

  for (const name of NAMES) {
    scan(`${name} (refunds credited)`, credited[name], load(name));
    scan(`${name} (gross only)`, gross[name], load(name));
  }
  for (const [label, analysis, x] of csvAnalyses) scan(`csv ${label}`, { analysis }, x);
  scan('costs-more statement', costly, tiny);

  // The scanner itself must catch a leak, or a clean result means nothing.
  const catches = (name, store, plant) => {
    const x = load(name);
    const planted = JSON.parse(JSON.stringify(store[name]));
    plant(planted, x);
    const before = failures;
    const quiet = console.log;
    console.log = () => {};
    scan('planted', planted, x);
    console.log = quiet;
    const caught = failures > before;
    failures = before;
    return caught;
  };
  const wrJul = `${MERCHANTS.WR}_202607`;
  check('the scanner catches a per-transaction subtotal printed in a string', catches(wrJul, credited, (p, x) => {
    p.analysis.rebelipay.byCardType[0].note = `$${(x.card_types.reduce((s, c) => s + c.items, 0) * 0.1).toFixed(2)} in per-item charges`;
  }));
  check('the scanner catches a percentage subtotal as a number', catches(wrJul, credited, (p, x) => {
    p.analysis.kpis.extra = Math.round(x.card_types.reduce((s, c) => s + cents(c.gross) * PPM, 0) / MICRO) / 100;
  }));
  check('the scanner catches the refund credit as a number', catches(`${MERCHANTS.SP}_202607`, credited, (p, x) => {
    p.analysis.rebelipay.byCardType[1].extra = independent(x).credit / 100;
  }));
  check('the scanner catches an offer term on a rate field', catches(wrJul, credited, (p) => {
    p.analysis.rebelipay.byCardType[0].rate = 2.55;
  }));

  const json = JSON.stringify(rules);
  check('JSON.stringify(rules) does not leak the offer', !/0\.0255|0\.1\b|pctRate|perTxnFee|Rebelipay/.test(json), json.slice(0, 80));
  check('JSON.stringify(rules.rebelipay) does not leak the offer', !/0\.0255|pctRate|perTxnFee/.test(JSON.stringify(rules.rebelipay)));
  check('JSON.stringify of a rules copy (as a test builds it) is the only way to see it, and the engine never does',
    !/pctRate|perTxnFee/.test(JSON.stringify(credited[`${MERCHANTS.WR}_202607`])));
}

csvChecks()
  .then(deepScan)
  .then(() => {
    console.log('');
    if (failures) {
      console.log(`${failures} check(s) FAILED`);
      process.exit(1);
    }
    console.log('ALL CHECKS PASSED');
  })
  .catch((e) => { console.error('threw:', e); process.exit(1); });
