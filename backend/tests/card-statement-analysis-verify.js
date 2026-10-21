#!/usr/bin/env node
/**
 * Card Statement Analysis - the engine on the 12 hand-verified samples.
 *
 * analyse() is pure, so it is tested here the way it runs in production: the
 * extracted JSON of a real statement in, the public analysis and the DB header
 * out. Nothing here reads a PDF, calls a model or touches a database.
 *
 * Every expected figure comes from outside the code under test:
 *
 *   statement.html      the target report (July KPIs, scorecard, junk fees,
 *                       the Bethany batch anomaly), quoted at the precision
 *                       the report prints
 *   the plan, §10       the assertion table (legacy notices, null customers,
 *                       the WR May chargeback, the trend fallback)
 *   CARD-STATEMENTS.md  the output contract (§5): six findings in a fixed
 *                       order, missing sections null and listed, no dashes,
 *                       no vendor name, deterministic
 *
 * The fixtures are JSON transcriptions of the PDFs, checked by hand and by the
 * reconciliation suite; the PDFs themselves stay out of the repository.
 *
 * Run:  node tests/card-statement-analysis-verify.js
 */

const path = require('path');
const assert = require('assert');
const { analyse } = require('../services/cardStatementAnalysis');
const rules = require('../services/cardStatementRules');

const FIXTURES = path.join(__dirname, 'fixtures', 'card-statements');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// A fresh copy every time, so no test can see another's mutation.
const load = (name) => JSON.parse(JSON.stringify(require(path.join(FIXTURES, `${name}.extracted.json`))));

const STORES = {
  WR: { merchant: '498387143882', name: 'Wine Republic' },
  SP: { merchant: '498407670880', name: 'Spotswood' },
  BE: { merchant: '498466534886', name: 'Bethany' },
  MI: { merchant: '498480373881', name: 'Millstone' },
};
const MONTHS = ['202605', '202606', '202607'];
const fixtureName = (store, month) => `${STORES[store].merchant}_${month}`;

const fixed = (v, dp) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(dp) : String(v));
const fmtMoney2 = (v) => `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const squash = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();

const FINDING_KEYS = ['debit_at_credit_rates', 'sales_trend', 'customer_scorecard', 'daily_patterns', 'junk_fees', 'fine_print'];
const FINDING_FIELDS = ['key', 'number', 'title', 'severity', 'flagged', 'available', 'unavailableReason', 'impactLabel', 'why',
  'isEstimate', 'shows', 'hidden', 'metrics', 'chart', 'table', 'callout', 'footnote', 'sourceRefs'];
const NULLABLE_SECTIONS = ['feeLines', 'daily', 'cardMix', 'customers', 'salesTrend', 'reportableSales', 'funding'];

// Every string in a value, with the path it sits at.
function strings(value, at = '$', out = []) {
  if (typeof value === 'string') out.push([at, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${at}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) strings(v, `${at}.${k}`, out);
  return out;
}

const DASH = /[\u2013\u2014]/;
const VENDOR = /anthropic|claude|sonnet|opus|haiku|openai|chatgpt|\bgpt\b|gemini|\bllm\b/i;

/* ── Run the engine once per fixture, as the service does ─────────────────── */

const results = {};
for (const store of Object.keys(STORES)) {
  for (const month of MONTHS) {
    const name = fixtureName(store, month);
    results[name] = analyse(load(name));
  }
}
const july = (store) => results[fixtureName(store, '202607')].analysis;

/* ── 1. Shape: six findings in order, every field present ─────────────────── */

console.log('\nSHAPE - six findings, fixed order 01..06, on every statement');

for (const [name, { analysis, header }] of Object.entries(results)) {
  const f = analysis.findings || [];
  check(`${name}: exactly six findings, keys in order`,
    f.length === 6 && f.every((x, i) => x.key === FINDING_KEYS[i]), f.map((x) => x.key).join(','));
  check(`${name}: numbered Finding 01 .. Finding 06`,
    f.every((x, i) => x.number === `Finding 0${i + 1}`), f.map((x) => x.number).join(','));
  const missingFields = f.flatMap((x) => FINDING_FIELDS.filter((k) => !(k in x)).map((k) => `${x.key}.${k}`));
  check(`${name}: every finding carries every contract field`, missingFields.length === 0, missingFields.join(','));
  check(`${name}: findingsCount counts the flagged findings`,
    analysis.findingsCount === f.filter((x) => x.flagged === true).length
      && header.findingsCount === analysis.findingsCount, `${analysis.findingsCount}`);
  check(`${name}: severities are high|medium|low|info`,
    f.every((x) => ['high', 'medium', 'low', 'info'].includes(x.severity)));
}

/* ── 2. July against statement.html ───────────────────────────────────────── */

console.log('\nJULY - the KPIs statement.html prints');

// statement.html, the debit chart data and the scorecard rows.
const HTML = {
  WR: { vol: 194524, dVol: 144094, debit: '74.1', rate: '3.02', rep: '31.6', amex: 29, yoy: -1.63, tick: 28.11 },
  SP: { vol: 188823, dVol: 98195, debit: '52.0', rate: '3.00', rep: '26.0', amex: 27, yoy: 3.79, tick: 33.15 },
  BE: { vol: 227057, dVol: 124144, debit: '54.7', rate: '3.01', rep: '23.8', amex: 34, yoy: -4.97, tick: 38.03 },
  MI: { vol: 161008, dVol: 82315, debit: '51.1', rate: '3.10', rep: '26.9', amex: 40, yoy: -0.82, tick: 36.41 },
};

for (const [store, want] of Object.entries(HTML)) {
  const a = july(store);
  const { header } = results[fixtureName(store, '202607')];
  const k = a.kpis;
  const label = STORES[store].name;
  check(`${label}: card volume (amount submitted) $${want.vol.toLocaleString('en-US')}`,
    Math.round(k.cardVolume) === want.vol, String(k.cardVolume));
  check(`${label}: debit volume $${want.dVol.toLocaleString('en-US')}`, Math.round(k.debitVolume) === want.dVol, String(k.debitVolume));
  check(`${label}: debit share ${want.debit}%`, fixed(k.debitShare, 1) === want.debit, String(k.debitShare));
  check(`${label}: effective rate ${want.rate}%`, fixed(k.effectiveRate, 2) === want.rate, String(k.effectiveRate));
  check(`${label}: repeat share ${want.rep}%`, a.customers && fixed(a.customers.repeatSharePct, 1) === want.rep,
    JSON.stringify(a.customers));
  const amex = a.findings[2].metrics.amexPremiumPct;
  check(`${label}: Amex premium +${want.amex}%`, Math.round(amex) === want.amex, String(amex));
  check(`${label}: Amex tell callout (premium >= 20%)`, !!(a.findings[2].callout && a.findings[2].callout.title));
  check(`${label}: YoY ${want.yoy > 0 ? '+' : ''}${want.yoy}% (printed, from the statement)`,
    a.salesTrend && a.salesTrend.yoyPct === want.yoy && a.salesTrend.source === 'statement'
      && a.findings[1].metrics.yoyPct === want.yoy, JSON.stringify(a.salesTrend && a.salesTrend.yoyPct));
  check(`${label}: finding 02 flagged exactly when YoY is negative`, a.findings[1].flagged === (want.yoy < 0));
  check(`${label}: average ticket $${want.tick} (printed)`, k.avgTicket === want.tick && k.avgTicketSource === 'printed',
    `${k.avgTicket} ${k.avgTicketSource}`);
  check(`${label}: 13-month printed trend with peak and trough`,
    a.salesTrend.points.length === 13 && !!a.salesTrend.peak && !!a.salesTrend.trough, String(a.salesTrend.points.length));
  check(`${label}: header columns agree with the KPIs`,
    header.amountSubmitted === k.cardVolume && header.totalFees === k.processingFees
      && header.effectiveRate === Math.round(k.effectiveRate * 10000) / 10000
      && header.debitShare === Math.round(k.debitShare * 10000) / 10000
      && header.transactionCount === k.transactions && header.layoutVersion === 'v2_2026');
  check(`${label}: nothing missing on the new layout`, Array.isArray(a.missing) && a.missing.length === 0, JSON.stringify(a.missing));
  // D48: Rebelipay prices debit and credit the same, so finding 01 states the
  // debit share as a fact and never calls the rate an overcharge.
  {
    const f1 = a.findings[0];
    const words = JSON.stringify([f1.title, f1.impactLabel, f1.shows, f1.hidden, f1.why]);
    check(`${label}: finding 01 is a fact, never a flag: "${f1.title}"`,
      f1.flagged === false && f1.severity === 'info' && f1.why === null && f1.metrics.sameRate === true
        && f1.title === `Debit is ${Math.round(k.debitShare)}% of your card sales`
        && /^\$[\d,]+\.\d{2} in debit card sales$/.test(f1.impactLabel || ''), `${f1.flagged} ${f1.title} ${f1.impactLabel}`);
    check(`${label}: finding 01 never says overcharge or "credit rate"`,
      !/overcharg|credit[- ]card rate|credit rate|should be cheaper|costs less to process/i.test(words), words.slice(0, 200));
  }
}

{
  const a = july('WR');
  check('Wine Republic: repeat share is 1,225 / (2,650 + 1,225)',
    a.customers.new === 2650 && a.customers.repeat === 1225
      && Math.abs(a.customers.repeatSharePct - (1225 / 3875) * 100) < 1e-9);
  check('Wine Republic: 6,921 transactions, $5,865.65 fees, $188,657.93 net deposited',
    a.kpis.transactions === 6921 && a.kpis.processingFees === 5865.65 && a.kpis.netDeposited === 188657.93);
  check('Wine Republic: debit volume is the sum of the debit fee-line bases ($144,094.24)',
    a.kpis.debitVolume === 144094.24, String(a.kpis.debitVolume));
  check('Wine Republic: 49 funding rows, 17 split days (only rows with sales count)',
    a.funding && a.funding.rows === 49 && a.funding.splitDays === 17, JSON.stringify(a.funding));
}

/* ── 3. Junk fees ─────────────────────────────────────────────────────────── */

console.log('\nJUNK FEES - finding 05');

const junk = (store) => july(store).findings[4];
const item = (store, re) => junk(store).metrics.items.find((it) => re.test(it.line));
{
  for (const store of ['WR', 'BE']) {
    const it = item(store, /NON RECEIPT OF PCI VALIDATION/);
    check(`${STORES[store].name}: PCI non-validation $29.95, tagged penalty, $359.40 a year`,
      it && it.tag === 'penalty' && it.monthly === 29.95 && it.annualised === 359.4 && it.period === 'monthly',
      JSON.stringify(it));
    check(`${STORES[store].name}: finding 05 flagged`, junk(store).flagged === true && junk(store).isEstimate === true);
  }
  const ac = item('MI', /ANNUAL COMPLIANCE/);
  check('Millstone: annual compliance $159.00, negotiable, annualised as-is at $159.00',
    ac && ac.tag === 'negotiable' && ac.monthly === 159 && ac.annualised === 159 && ac.period === 'annual', JSON.stringify(ac));
  check('Millstone: finding 05 flagged', junk('MI').flagged === true);
  const mr = item('BE', /MAESTRO REG/);
  check('Bethany: Maestro registration $0.28 tagged watch', mr && mr.tag === 'watch' && mr.monthly === 0.28, JSON.stringify(mr));
  check('Spotswood: no penalty and nothing negotiable (statement.html lists none)',
    !junk('SP').metrics.items.some((it) => it.tag === 'penalty' || it.tag === 'negotiable') && junk('SP').flagged === false,
    JSON.stringify(junk('SP').metrics.items));
  const wrLine = july('WR').feeLines.find((l) => /PCI VALIDATION/.test(l.description));
  check('Wine Republic: the fee table tags the PCI line too', wrLine && wrLine.tag === 'penalty' && !!wrLine.fix);
  const be = junk('BE').metrics;
  check('Bethany: total annualised = 359.40 + 0.28 x 12', be.totalAnnualised === 362.76, String(be.totalAnnualised));
  // D46: every tagged fee flags the check, so a card titled "1 fee to check"
  // never sits under "Nothing to fix". Only a fee to ask about: low.
  const miJun = results[fixtureName('MI', '202606')].analysis.findings[4];
  check('Millstone Jun: one fee to ask about flags finding 05 at low, not medium',
    miJun.flagged === true && miJun.severity === 'low' && miJun.title === '1 fee to check'
      && miJun.metrics.items.length === 1 && miJun.metrics.items[0].tag === 'review', `${miJun.flagged} ${miJun.severity} ${miJun.title}`);
  for (const name of Object.keys(results)) {
    const j5 = results[name].analysis.findings[4];
    if (j5.available === false) continue;
    const items = j5.metrics.items;
    const act = items.some((it) => it.tag === 'penalty' || it.tag === 'negotiable');
    check(`${name}: finding 05 flagged exactly when a fee is tagged, medium only for a penalty or a fee to cut`,
      j5.flagged === (items.length > 0) && j5.severity === (act ? 'medium' : items.length ? 'low' : 'info'), `${j5.flagged} ${j5.severity}`);
  }
  check('every junk item points at its fee line',
    Object.keys(STORES).every((s) => junk(s).metrics.items.every((it) => /^fee_lines\[\d+\]$/.test(it.sourceRef)
      && july(s).feeLines[Number(it.sourceRef.match(/\d+/)[0])].description === it.line)));
}

/* ── 4. Bethany's July days ───────────────────────────────────────────────── */

console.log('\nDAILY - Bethany July (low batch, spike, zero day, prior period)');

{
  const a = july('BE');
  const f = a.findings[3];
  const anomalies = f.metrics.anomalies;
  const low = anomalies.find((x) => x.type === 'low_batch');
  check('Jul 3 flagged as a low batch of about $77', low && low.date === '2026-07-03' && Math.round(low.amount) === 77,
    JSON.stringify(low));
  check('followed by the Jul 4 spike of about $46.6K', low && low.nextDate === '2026-07-04'
    && fixed(low.nextAmount / 1000, 1) === '46.6', JSON.stringify(low));
  check('Jul 3 is the only low batch', anomalies.filter((x) => x.type === 'low_batch').length === 1);
  const zero = anomalies.find((x) => x.type === 'zero_with_fees');
  check('Jul 31: $0 submitted with fees', zero && zero.date === '2026-07-31' && zero.amount === 145.67, JSON.stringify(zero));
  const prior = anomalies.find((x) => x.type === 'prior_period');
  check('the 06/30 row is a prior-period row', prior && prior.date === '2026-06-30' && prior.amount === 5497.2, JSON.stringify(prior));
  // The short note follows the row's date and amount, so it repeats neither.
  check('every anomaly has a short note after its date and amount', anomalies.every((x) => typeof x.note === 'string' && x.note.length > 0
    && !x.note.includes(fmtMoney2(x.amount)) && !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),/.test(x.note)), JSON.stringify(anomalies.map((x) => x.note)));
  check('the low batch note names the usual day and the spike', low && low.note === 'in card sales, compared with $9,170.95 on a usual Friday. Then Sat, Jul 4 brought in $46,580.92, 4.2 times a usual Saturday.', low && low.note);
  check('the zero day note', zero && zero.note === 'in fees on a day with no card sales.', zero && zero.note);
  check('finding 04 flagged', f.flagged === true);
  // D46: every listed day flags the check; a split deposit alone is low.
  for (const name of Object.keys(results)) {
    const f4 = results[name].analysis.findings[3];
    if (f4.available === false) continue;
    const an = f4.metrics.anomalies || [];
    const medium = an.some((x) => x.type === 'low_batch' || x.type === 'zero_with_fees');
    check(`${name}: finding 04 flagged exactly when a day is listed, medium only for a low sales day or fees with no sales`,
      f4.flagged === (an.length > 0) && f4.severity === (medium ? 'medium' : an.length ? 'low' : 'info'), `${f4.flagged} ${f4.severity}`);
  }
  const wrJul = july('WR').findings[3];
  check('Wine Republic Jul: split deposits alone flag finding 04 at low',
    wrJul.flagged === true && wrJul.severity === 'low' && wrJul.metrics.anomalies.every((x) => x.type === 'split_funding'),
    `${wrJul.flagged} ${wrJul.severity} ${JSON.stringify(wrJul.metrics.anomalies.map((x) => x.type))}`);
  check('and its title says what to check, leaving the busiest days to their tile',
    wrJul.title === "Some days' card sales were paid in more than one deposit", wrJul.title);
  {
    // D46 for the fine print: a notice about a new way to get statements,
    // alone, flags finding 06 at low, with its own title and why.
    const x = load(fixtureName('SP', '202605'));
    x.notices = x.notices.filter((n) => n.kind === 'delivery_change' || n.kind === 'other');
    const f6 = analyse(x).analysis.findings[5];
    check('a statement-delivery notice alone flags finding 06 at low', f6.flagged === true && f6.severity === 'low'
      && f6.title === 'A notice says the way you get your statements is changing' && /make sure someone can still get them/.test(f6.why || ''),
    `${f6.flagged} ${f6.severity} ${f6.title} ${f6.why}`);
    // Disputes not read are unknown: the title never says "no disputes".
    const y = load(fixtureName('SP', '202605'));
    y.notices = [{ text: 'Thank you for your business. Our office will be closed on Labor Day.', kind: 'other', effective_date: null }];
    y.summary.disputes = null; y.chargebacks = [];
    const g6 = analyse(y).analysis.findings[5];
    check('with the disputes line not read, finding 06 never says "no disputes"', g6.flagged === false && g6.title === 'No urgent notices', g6.title);
  }
  // D47: the biggest day against a usual day of its weekday.
  const bd = july('BE').findings[3].metrics.biggestDay;
  const sameDow = load(fixtureName('BE', '202607')).daily
    .filter((r) => !r.is_prior_period && r.date !== bd.date && new Date(`${r.date}T00:00:00Z`).getUTCDay() === new Date(`${bd.date}T00:00:00Z`).getUTCDay()
      && r.submitted !== null && r.submitted !== undefined)
    .map((r) => Number(r.submitted)).sort((a, b) => a - b);
  const mid = sameDow.length % 2 ? sameDow[(sameDow.length - 1) / 2] : (sameDow[sameDow.length / 2 - 1] + sameDow[sameDow.length / 2]) / 2;
  check('Bethany Jul: the biggest day, Sat Jul 4, is 4.2 times a usual Saturday (the median of the other Saturdays)',
    bd.date === '2026-07-04' && bd.usualAmount === Math.round(mid * 100) / 100 && bd.timesUsual === 4.2, JSON.stringify(bd));
  // Every listed item counts, split deposits too.
  check('"items to check" counts every listed anomaly', f.impactLabel === `${anomalies.length} items to check` && anomalies.length === 4, f.impactLabel);
  // The busiest days' real share (60% or a little more), never a flat "60%".
  check('busiest days carry their real share', typeof f.metrics.daysFor60SharePct === 'number' && f.metrics.daysFor60SharePct >= 60,
    String(f.metrics.daysFor60SharePct));
  {
    // A day whose sales were not read is neither a $0 day nor a low day.
    const x = load(fixtureName('BE', '202607'));
    const d31 = x.daily.find((r) => r.date === '2026-07-31');
    d31.submitted = null;
    const an = analyse(x).analysis.findings[3].metrics.anomalies;
    check('an unread day is never "fees on a day with no card sales"', !an.some((a) => a.type === 'zero_with_fees' && a.date === '2026-07-31'), JSON.stringify(an.map((a) => a.type)));
    const y = load(fixtureName('BE', '202607'));
    y.daily.find((r) => r.date === '2026-07-03').submitted = null;
    const an2 = analyse(y).analysis.findings[3].metrics.anomalies;
    check('an unread day is never a low sales day', !an2.some((a) => a.type === 'low_batch' && a.date === '2026-07-03'), JSON.stringify(an2.map((a) => a.type)));
  }
  {
    // Disputes whose line was not read, with no chargeback rows: unknown, not "none".
    const x = load(fixtureName('BE', '202607'));
    x.summary.disputes = null;
    x.chargebacks = [];
    const a6 = analyse(x).analysis;
    check('unread disputes stay unknown, never "no disputes"', a6.disputes === null && a6.findings[5].metrics.zeroDisputes === null, JSON.stringify(a6.disputes));
  }
  {
    const priorOf = (mutate) => {
      const x = load(fixtureName('BE', '202607'));
      const row = x.daily.find((r) => r.date === '2026-06-30');
      mutate(row);
      return analyse(x).analysis.findings[3].metrics.anomalies.find((a) => a.type === 'prior_period');
    };
    const noDate = priorOf((r) => { r.date = null; r.is_prior_period = true; });
    check('earlier sales with no date read: no "null" in the sentence', noDate && !/null/.test(noDate.detail)
      && noDate.detail === '$5,497.20 in card sales from before this statement began are counted on this statement.', noDate && noDate.detail);
    const noAmount = priorOf((r) => { r.submitted = null; });
    check('earlier sales with no amount read: no "$0.00" in the sentence', noAmount && !/\$0\.00/.test(noAmount.detail)
      && noAmount.detail === 'Card sales dated Jun 30, 2026, from before this statement began are counted on this statement.', noAmount && noAmount.detail);
  }
  const row = (d) => a.daily.rows.find((r) => r.date === d);
  check('daily table marks 06/30 as prior period', row('2026-06-30') && row('2026-06-30').priorPeriod === true);
  check('daily table carries the anomalies on Jul 3 and Jul 31',
    row('2026-07-03').anomalies.includes('low_batch') && row('2026-07-31').anomalies.includes('zero_with_fees'));
  check('prior-period sales are excluded from the in-period share facts',
    f.metrics.daysInPeriod === 31, String(f.metrics.daysInPeriod));
  check('daily totals add up to the summary', a.daily.totals.submitted === a.kpis.cardVolume
    && a.daily.totals.fees === a.kpis.processingFees, JSON.stringify(a.daily.totals));
  check('daily rows weekend flag is Friday to Sunday',
    row('2026-07-03').weekend === true && row('2026-07-05').weekend === true && row('2026-07-06').weekend === false);
}
{
  const others = ['WR', 'SP', 'MI'].map((s) => july(s).findings[3].metrics.anomalies.filter((x) => x.type === 'low_batch'));
  check('no low batch at the sister stores in July', others.every((x) => x.length === 0), JSON.stringify(others));
}

/* ── D47: why each flagged check has its level, and last month ──────────── */
console.log('\nWHY AND LAST MONTH - D47');
{
  for (const name of Object.keys(results)) {
    for (const f of results[name].analysis.findings) {
      check(`${name} ${f.number}: a "why" exactly when flagged, plain words`,
        f.flagged ? typeof f.why === 'string' && f.why.length > 20 && !DASH.test(f.why) && !VENDOR.test(f.why) && !/n\/a|undefined|null|NaN/.test(f.why)
          : f.why === null, `${f.flagged} ${f.why}`);
    }
  }
  // The history the service hands over: each earlier statement's filed figures.
  const filedAs = (name) => {
    const { analysis, header } = results[name];
    return { periodStart: header.periodStart, periodEnd: header.periodEnd, amountSubmitted: header.amountSubmitted, totalFees: header.totalFees,
      amountProcessed: header.amountProcessed, effectiveRate: header.effectiveRate, debitShare: header.debitShare, avgTicket: analysis.kpis.avgTicket };
  };
  const change = (now, was) => Math.round(((now - was) / Math.abs(was)) * 10000) / 100;
  for (const store of Object.keys(STORES)) {
    const jun = filedAs(fixtureName(store, '202606'));
    const { analysis } = analyse(load(fixtureName(store, '202607')), { history: [filedAs(fixtureName(store, '202605')), jun] });
    const k = analysis.kpis; const lm = k.lastMonth;
    const t = analysis.salesTrend;
    check(`${STORES[store].name} Jul: last month is June, from June's filed figures`, !!lm && lm.month === '2026-06'
      && lm.processingFeesPct === change(k.processingFees, jun.totalFees) && lm.netDepositedPct === change(k.netDeposited, jun.amountProcessed)
      && lm.avgTicketPct === change(k.avgTicket, jun.avgTicket) && lm.effectiveRate === jun.effectiveRate && lm.debitShare === jun.debitShare,
    JSON.stringify(lm));
    check(`${STORES[store].name} Jul: card sales move as finding 02 says, never a second number`,
      lm.cardVolumePct === Math.round(t.momPct * 100) / 100, `${lm.cardVolumePct} vs ${t.momPct}`);
  }
  const mayAlone = results[fixtureName('BE', '202605')].analysis.kpis.lastMonth;
  check('Bethany May with no earlier statement and no printed trend: no last month', mayAlone === null, JSON.stringify(mayAlone));
  const asFile = analyse({ ...load(fixtureName('BE', '202607')), layout_version: 'csv' },
    { history: [filedAs(fixtureName('BE', '202606'))] }).analysis.kpis.lastMonth;
  check('a CSV file covers any span: no last month', asFile === null, JSON.stringify(asFile));
  const skip = analyse(load(fixtureName('BE', '202607')), { history: [filedAs(fixtureName('BE', '202605'))] }).analysis.kpis.lastMonth;
  check('only the month right before counts: with May on file, July has no fees change', skip && skip.processingFeesPct === null
    && skip.effectiveRate === null, JSON.stringify(skip));
  check('card sales says where its change came from: printed on this statement', skip && skip.cardVolumeSource === 'printed', JSON.stringify(skip));
  // A file or a part month is not "last month": a June CSV of ten days on file
  // gives no fees change, and the legacy trend leaves it out too.
  const junFile = { ...filedAs(fixtureName('BE', '202606')), layoutVersion: 'csv', periodStart: '2026-06-20', periodEnd: '2026-06-29',
    amountSubmitted: 52000, totalFees: 1430, amountProcessed: 50570 };
  const withFile = analyse(load(fixtureName('BE', '202607')), { history: [junFile] }).analysis.kpis.lastMonth;
  check('a short CSV for June is not last month', withFile && withFile.processingFeesPct === null && withFile.effectiveRate === null
    && withFile.debitShare === null, JSON.stringify(withFile));
  const partJun = { ...filedAs(fixtureName('BE', '202606')), periodStart: '2026-06-16', periodEnd: '2026-06-30' };
  const legacyJun = analyse(load(fixtureName('BE', '202606')), { history: [{ ...filedAs(fixtureName('BE', '202605')), periodStart: '2026-05-25' }] }).analysis;
  check('a part month is left out of the trend built from uploads', legacyJun.salesTrend === null || legacyJun.salesTrend.points.length === 1,
    JSON.stringify(legacyJun.salesTrend));
  const withPart = analyse(load(fixtureName('BE', '202607')), { history: [partJun] }).analysis.kpis.lastMonth;
  check('nor is a half-month statement last month', withPart && withPart.processingFeesPct === null, JSON.stringify(withPart));
  // The why sentences say what is true for each case.
  {
    const priorOnly = july('WR').findings[3].why === null ? null : results[fixtureName('WR', '202605')].analysis.findings[3];
    check('earlier sales alone: a bookkeeping step, not the split-deposit one', priorOnly && /match this statement to your books/.test(priorOnly.why)
      && !/deposit reached your bank/.test(priorOnly.why), priorOnly && priorOnly.why);
    const review = results[fixtureName('MI', '202606')].analysis.findings[4];
    check('a fee we do not recognise is never called harmless', /We don't recognise a fee here/.test(review.why) && !/None is a penalty/.test(review.why), review.why);
    const negotiable = july('MI').findings[4];
    check('a fee to cut points to the table\'s own step', /The table says how to stop or lower it\./.test(negotiable.why), negotiable.why);
    const d = load(fixtureName('SP', '202607'));
    d.notices = []; d.summary.disputes = 250; d.chargebacks = [];
    const f6 = analyse(d).analysis.findings[5];
    check('disputes with no rows read: the amount, never "a customer"', /^Disputes took \$250\.00 off your deposits: check each one against your receipts\.$/.test(f6.why || ''), f6.why);
    const near = load(fixtureName('WR', '202607'));
    const deb = near.fee_lines.find((l) => l.is_debit && l.rate !== null && l.base_amount);
    if (deb) {
      deb.rate = 0.0296; deb.amount = Math.round(deb.base_amount * 0.0296 * 100) / 100;
      const f1 = analyse(near).analysis.findings[0];
      check('debit near the credit rate is still a fact, with no why line', f1.flagged === false && f1.why === null, f1.why);
    }
  }
}

/* ── 5. Legacy statements (May / June) ────────────────────────────────────── */

console.log('\nLEGACY - May and June statements');

for (const store of Object.keys(STORES)) {
  for (const month of ['202605', '202606']) {
    const name = fixtureName(store, month);
    const a = results[name].analysis;
    const label = `${STORES[store].name} ${month}`;
    const fine = a.findings[5];
    const acq = fine.metrics.notices.find((n) => n.kind === 'acquirer_change');
    check(`${label}: acquirer change, Wells Fargo to Citizens, effective 2026-06-29`,
      acq && acq.effectiveDate === '2026-06-29' && squash(acq.text).includes('wellsfargo')
        && squash(acq.text).includes('citizensbank') && !!acq.action, JSON.stringify(acq && acq.effectiveDate));
    const ach = fine.metrics.notices.find((n) => n.kind === 'ach_descriptor_change');
    check(`${label}: ACH descriptor notice`, ach && squash(ach.text).includes('companyname') && !!ach.action);
    check(`${label}: finding 06 flagged, severity high`, fine.flagged === true && fine.severity === 'high');
    const fixtureTexts = load(name).notices.map((n) => squash(n.text));
    check(`${label}: notices verbatim (ignoring whitespace)`,
      a.notices.length === fixtureTexts.length && a.notices.every((n, i) => squash(n.text) === fixtureTexts[i]));
    check(`${label}: customers null, not zeros`, a.customers === null
      && a.findings[2].metrics.newCustomers === null && a.findings[2].metrics.repeatSharePct === null);
    check(`${label}: card mix and Amex premium kept`, !!a.cardMix && typeof a.findings[2].metrics.amexPremiumPct === 'number');
    check(`${label}: missing lists customers, salesTrend and funding, each null`,
      ['customers', 'salesTrend', 'funding'].every((k) => a.missing.includes(k) && a[k] === null), JSON.stringify(a.missing));
    check(`${label}: average ticket computed from submitted / items`, a.kpis.avgTicketSource === 'computed'
      && a.kpis.avgTicket === Math.round((a.kpis.cardVolume * 100) / a.kpis.transactions) / 100);
    check(`${label}: layout legacy_2026`, a.layoutVersion === 'legacy_2026');
    check(`${label}: no Amounts Funded section, so split-funding days unknown (null, not 0)`,
      a.funding === null && a.findings[3].metrics.splitFundingDays === null,
      String(a.findings[3].metrics.splitFundingDays));
  }

  // A lone May: nothing to build a trend from.
  const may = results[fixtureName(store, '202605')].analysis;
  check(`${STORES[store].name} May alone: trend unavailable`,
    may.salesTrend === null && may.findings[1].available === false
      && may.findings[1].unavailableReason === 'A trend needs at least two months of card sales' && may.findings[1].flagged === false);

  // June with May in history: a two-point trend built from history.
  const mayFx = load(fixtureName(store, '202605'));
  const junFx = load(fixtureName(store, '202606'));
  const history = [{ periodStart: mayFx.period.start, periodEnd: mayFx.period.end, amountSubmitted: mayFx.summary.amount_submitted }];
  const jun = analyse(junFx, { history }).analysis;
  const t = jun.salesTrend;
  const mom = ((junFx.summary.amount_submitted - mayFx.summary.amount_submitted) / mayFx.summary.amount_submitted) * 100;
  check(`${STORES[store].name} June with May in history: trend from history, May then June`,
    t && t.source === 'history' && t.points.length === 2 && t.points[0].month === '2026-05' && t.points[1].month === '2026-06'
      && t.points[0].amount === mayFx.summary.amount_submitted && t.points[1].amount === junFx.summary.amount_submitted,
    JSON.stringify(t));
  check(`${STORES[store].name} June: MoM computed from history, no YoY without a year of history`,
    t && Math.abs(t.momPct - mom) < 1e-9 && t.yoyPct === null && jun.findings[1].available === true
      && !jun.missing.includes('salesTrend'));

  // History that is not strictly earlier is ignored.
  const julFx = load(fixtureName(store, '202607'));
  const withLater = analyse(junFx, {
    history: history.concat([{ periodStart: julFx.period.start, periodEnd: julFx.period.end, amountSubmitted: 1 },
      { periodStart: junFx.period.start, periodEnd: junFx.period.end, amountSubmitted: 2 }]),
  }).analysis;
  check(`${STORES[store].name} June: later and same-period history ignored`,
    JSON.stringify(withLater) === JSON.stringify(jun));
}

{
  const may = results[fixtureName('WR', '202605')].analysis;
  check('Wine Republic May: chargeback of $26.36 captured in disputes',
    may.disputes.count === 1 && may.disputes.amount === 26.36 && may.disputes.items[0].amount === 26.36
      && may.disputes.items[0].date === '2026-05-18', JSON.stringify(may.disputes));
  check('Wine Republic May: finding 06 lists the dispute and is not zeroDisputes',
    may.findings[5].metrics.zeroDisputes === false && may.findings[5].metrics.disputes.amount === 26.36
      && !!may.findings[5].table);
  const jun = results[fixtureName('WR', '202606')].analysis;
  check('Wine Republic June: zero disputes confirmed', jun.disputes.count === 0 && jun.disputes.amount === 0
    && jun.findings[5].metrics.zeroDisputes === true);
  check('Wine Republic May: 1099-K reportable sales carried', may.reportableSales
    && may.reportableSales.ytdAmount === 627340.92 && may.reportableSales.tinLast4 === '0000');
}
{
  const julWithHistory = analyse(load(fixtureName('WR', '202607')), {
    history: [{ periodStart: '2026-05-01', periodEnd: '2026-05-31', amountSubmitted: 187377.59 }],
  }).analysis;
  check('a printed trend wins over history', julWithHistory.salesTrend.source === 'statement'
    && JSON.stringify(julWithHistory) === JSON.stringify(july('WR')));
}

/* ── 6. Missing sections are null, never zeros ────────────────────────────── */

console.log('\nMISSING - null sections, listed in analysis.missing');

for (const [name, { analysis }] of Object.entries(results)) {
  const nulls = NULLABLE_SECTIONS.filter((k) => analysis[k] === null);
  check(`${name}: missing lists exactly the null sections`,
    JSON.stringify([...analysis.missing].sort()) === JSON.stringify(nulls.sort()), `${analysis.missing} vs ${nulls}`);
}
{
  // A statement that prints nothing beyond its header.
  const bare = {
    processor: null, layout_version: 'unknown',
    merchant: { number: '400000000009', name: 'BARE' }, period: { start: '2026-07-01', end: '2026-07-31' },
    summary: { amount_submitted: 1000, paid_by_others: null, disputes: 0, adjustments: 0, fees: 30, amount_processed: 970 },
    customers: null, sales_trend: [], printed_yoy_pct: null, printed_mom_pct: null, daily: [], month_end_charges: null,
    card_types: [], fee_lines: [], chargebacks: [], funding: [], reportable_sales: null, notices: [],
  };
  const { analysis } = analyse(bare);
  check('a bare statement: every optional section null and listed',
    NULLABLE_SECTIONS.every((k) => analysis[k] === null && analysis.missing.includes(k)), JSON.stringify(analysis.missing));
  check('a bare statement: unknowns stay null, never 0',
    analysis.kpis.transactions === null && analysis.kpis.debitVolume === null && analysis.kpis.avgTicket === null
      && analysis.kpis.debitShare === null, JSON.stringify(analysis.kpis));
  check('a bare statement: still six findings', analysis.findings.length === 6
    && analysis.findings.every((f, i) => f.key === FINDING_KEYS[i]));
}

/* ── 7. Deterministic, dash-free, vendor-free ─────────────────────────────── */

console.log('\nOUTPUT HYGIENE - deterministic, no dashes, no vendor names');

for (const store of Object.keys(STORES)) {
  for (const month of MONTHS) {
    const name = fixtureName(store, month);
    const again = analyse(load(name));
    let same = true;
    try { assert.deepStrictEqual(again, results[name]); } catch { same = false; }
    check(`${name}: identical output on a second run`, same);
  }
}
{
  const input = load(fixtureName('BE', '202607'));
  const before = JSON.stringify(input);
  analyse(input);
  check('analyse() does not mutate its input', JSON.stringify(input) === before);
}
{
  const bad = [];
  for (const [name, r] of Object.entries(results)) {
    const fx = load(name);
    const verbatim = new Set([
      ...fx.notices.map((n) => n.text), ...fx.fee_lines.map((l) => l.description),
      ...fx.chargebacks.map((c) => c.reason),
    ]);
    for (const [at, s] of strings(r)) {
      if (DASH.test(s)) bad.push(`${name} ${at}: dash`);
      // The statement's own words are quoted as printed; everything we wrote is checked.
      if (VENDOR.test(s) && !verbatim.has(s)) bad.push(`${name} ${at}: vendor/model name`);
    }
  }
  check('no em or en dash, and no vendor or model name, in any string', bad.length === 0, bad.slice(0, 5).join('; '));
}
{
  const json = JSON.stringify(rules);
  check('rules are never serialised by accident', !/0\.0255|pctRate|perTxnFee|feeCatalogue/.test(json), json.slice(0, 80));
}

/* ── 8. A transaction CSV with no fee column ──────────────────────────────── */

console.log('\nCSV - a transaction export without fees');

// Deterministic parser only: with no key set the column-mapping fallback can
// never run, and the fixture's headers match the aliases anyway.
delete process.env.ANTHROPIC_API_KEY;
// Short, so the stalled-stream case at the end proves the deadline in a second.
process.env.CS_PARSE_TIMEOUT_MS = '1000';
const { parseCsv, extractPdf, normaliseExtracted } = require('../services/cardStatementExtract');
const { reconcile } = require('../services/cardStatementReconcile');
const csvOf = (text, fileName = 'stmt_400000000008.csv') => parseCsv({ buffer: Buffer.from(text), fileName });

(async () => {
  const fs = require('fs');
  const file = path.join(FIXTURES, 'csv-three-rows.csv');
  const { extracted } = await parseCsv({ buffer: fs.readFileSync(file), fileName: 'csv-three-rows.csv' });
  const { analysis, header } = analyse(extracted);
  const t = analysis.daily && analysis.daily.totals;
  check('csv: card volume $135.55 over 3 transactions', analysis.kpis.cardVolume === 135.55 && analysis.kpis.transactions === 3);
  check('csv: fees unknown -> processingFees, effectiveRate, netDeposited null',
    analysis.kpis.processingFees === null && analysis.kpis.effectiveRate === null && analysis.kpis.netDeposited === null
      && header.totalFees === null && header.effectiveRate === null);
  check('csv: daily rows keep fees and processed null', analysis.daily.rows.every((r) => r.fees === null && r.processed === null));
  check('csv: daily totals do not turn unknown fees into $0.00',
    t && t.submitted === 135.55 && t.fees === null && t.processed === null, JSON.stringify(t));
  check('csv: no funding section, split-funding days null', analysis.funding === null
    && analysis.findings[3].metrics.splitFundingDays === null, String(analysis.findings[3].metrics.splitFundingDays));
  check('csv: layout csv, still six findings', analysis.layoutVersion === 'csv' && analysis.findings.length === 6);
  check('csv: no dash in any string', strings(analysis).every(([, s]) => !DASH.test(s)));

  // What a transaction export does not carry is unknown, never zero or "none".
  check('csv: disputes null (not in a transaction file), listed as missing',
    analysis.disputes === null && analysis.missing.includes('disputes'), JSON.stringify(analysis.disputes));
  check('csv: no DEBIT rows -> debit volume and share null in the KPIs and the header',
    analysis.kpis.debitVolume === null && analysis.kpis.debitShare === null && header.debitShare === null,
    `${analysis.kpis.debitShare} ${header.debitShare}`);
  check('csv: finding 01 says the file does not show which cards were debit',
    analysis.findings[0].available === false
      && analysis.findings[0].unavailableReason === 'This file does not show which cards were debit', analysis.findings[0].unavailableReason);
  check('csv: finding 06 is "not in this file", not a claim of zero disputes',
    analysis.findings[5].available === false && analysis.findings[5].flagged === false
      && analysis.findings[5].metrics.zeroDisputes === null && analysis.findings[5].impactLabel === null,
    JSON.stringify(analysis.findings[5]).slice(0, 200));
  check('csv: daily rows do not claim $0 disputes or adjustments',
    analysis.daily.rows.every((r) => r.disputes === null && r.adjustments === null));
  const copy = strings(analysis.findings).map(([, s]) => s).join(' | ');
  const pdfCopy = /Summary by Day|card type table|of the month|the month's|No disputes|Zero disputes/i;
  check('csv: no PDF copy (Summary by Day, card type table, "of the month", "No disputes", "Zero disputes")',
    !pdfCopy.test(copy), String(copy.match(new RegExp(`.{0,40}(${pdfCopy.source}).{0,40}`, 'i'))));
  check('csv: finding 04 describes the file\'s transactions',
    analysis.findings[3].shows === 'The file lists 3 transactions over 3 days.', analysis.findings[3].shows);

  /* ── 9. CSV edge cases ──────────────────────────────────────────────────── */

  console.log('\nCSV EDGES - hostile cells, funding columns, blank fees');

  {
    // A 200 KB amount cell used to backtrack quadratically and freeze the
    // process for every tenant; now it is turned away by length.
    const poison = `date,amount,card type\n2026-07-01,${'9'.repeat(200 * 1024)}x,VISA\n2026-07-02,10.00,VISA\n`;
    // Best of three, so a cold JIT is not what is measured; the old pattern
    // took seconds here, not milliseconds.
    let ms = Infinity;
    let x = null;
    for (let k = 0; k < 3; k += 1) {
      const t0 = process.hrtime.bigint();
      ({ extracted: x } = await csvOf(poison));
      ms = Math.min(ms, Number(process.hrtime.bigint() - t0) / 1e6);
    }
    check(`a 200 KB amount cell is skipped in ${ms.toFixed(1)} ms (< 50 ms), the good row kept`,
      ms < 50 && x.transactions.length === 1 && x.summary.amount_submitted === 10 && x.csv_source.rows_skipped === 1, `${ms} ms`);
    const t1 = process.hrtime.bigint();
    const n = normaliseExtracted({ fee_lines: [{ description: `${'1'.repeat(3000)} X`, amount: 1, rate: 0.03, base_amount: 10 }] });
    const ms2 = Number(process.hrtime.bigint() - t1) / 1e6;
    check(`a 3,000-digit fee description is not regex-parsed (${ms2.toFixed(1)} ms < 50 ms); the model's rate and base stand`,
      ms2 < 50 && n.fee_lines[0].rate === 0.03 && n.fee_lines[0].base_amount === 10, `${ms2} ms`);
    const real = normaliseExtracted({ fee_lines: [
      { description: 'VISA SALES DISCOUNT 0.0150 DISC RATE TIMES $1,234.56', amount: 18.52 },
      { description: '.0150 DISCOUNT RATE TIMES .56', amount: 0.01 },
      { description: '0.002 DISC RATE TIMES $ 12,000.00', amount: 24 },
      { description: 'NON RECEIPT OF PCI VALIDATION 1 TRANSACTIONS AT 29.95', amount: 29.95 },
    ] }).fee_lines;
    check('the rewritten rate pattern reads real descriptions exactly as before',
      real[0].rate === 0.015 && real[0].base_amount === 1234.56 && real[1].rate === 0.015 && real[1].base_amount === 0.56
        && real[2].rate === 0.002 && real[2].base_amount === 12000 && real[3].count === 1 && real[3].unit_price === 29.95,
      JSON.stringify(real.map((l) => [l.rate, l.base_amount, l.count, l.unit_price])));
  }
  {
    // A "Type" column of Credit / Debit says how the card was funded. It used
    // to turn every credit-card sale into a refund: negative volume, and a
    // pitched saving on a negative Rebelipay cost.
    const { extracted: x } = await csvOf('Date,Amount,Card Type,Type,Fee\n2026-07-01,100.00,Visa,Credit,3.00\n'
      + '2026-07-02,50.00,Visa,Debit,1.50\n2026-07-03,20.00,Mastercard,Credit,0.60\n');
    const { analysis: a } = analyse(x);
    const negativeNumbers = [];
    // A per-card-type "You keep" cell may be negative on an eligible statement
    // (honest arithmetic); nothing else may.
    (function walk(v, at) {
      if (/^\$\.rebelipay\.byCardType\.\d+\.savings$/.test(at)) return;
      if (typeof v === 'number' && v < 0) negativeNumbers.push(at);
      else if (v && typeof v === 'object') for (const [k, w] of Object.entries(v)) walk(w, `${at}.${k}`);
    }({ kpis: a.kpis, rebelipay: a.rebelipay }, '$'));
    check('a Credit/Debit funding column marks no refunds: $170.00 submitted, three sales',
      x.summary.amount_submitted === 170 && x.transactions.every((t) => !t.is_refund) && a.kpis.cardVolume === 170,
      JSON.stringify(x.summary));
    check('and no KPI or pricing figure is negative', negativeNumbers.length === 0, negativeNumbers.join(', '));
    const { extracted: y } = await csvOf('Date,Amount,Card Type,Type\n2026-07-01,100.00,Visa,Sale\n2026-07-02,40.00,Visa,Credit\n'
      + '2026-07-03,5.00,Visa,Refund\n2026-07-04,7.00,Visa,Chargeback\n2026-07-05,9.00,Visa,Auth Reversal\n');
    check('beside Sale rows, Credit, Refund and Chargeback are refunds; an auth reversal is not money moving',
      y.summary.amount_submitted === 48 && y.transactions.length === 4 && y.csv_source.rows_skipped === 1,
      JSON.stringify([y.summary.amount_submitted, y.transactions.length]));
    const { extracted: z } = await csvOf('Date,Amount,Card Type\n2026-07-01,-100.00,Visa\n2026-07-02,20.00,Visa\n');
    const zr = analyse(z).analysis.rebelipay;
    check('a file that nets below zero is never eligible and shows no Rebelipay cost (the service also fails it)',
      zr.eligible === false && zr.reason === 'no_volume' && zr.rebelipayCost === null && zr.savings === null, JSON.stringify(zr));
  }
  {
    const { extracted: x } = await csvOf('Date,Amount,Card Type,Fee\n2026-07-01,100.00,Visa,\n2026-07-02,100.00,Visa,\n');
    const { analysis: a } = analyse(x);
    check('a Fee column blank on every row: fees unknown, not $0',
      x.summary.fees === null && x.summary.amount_processed === null && x.transactions.every((t) => t.fee === null)
        && a.kpis.processingFees === null, JSON.stringify(x.summary));
    check('and the pricing says the file does not show the fees (not "already competitive")',
      a.rebelipay.reason === 'no_current_fees' && a.rebelipay.eligible === false, a.rebelipay.reason);
    const { extracted: y } = await csvOf('Date,Amount,Card Type,Fee\n2026-07-01,100.00,Visa,2.50\n2026-07-02,100.00,Visa,\n');
    check('some fees blank: the numeric ones still add up', y.summary.fees === 2.5 && y.transactions[1].fee === null,
      JSON.stringify(y.summary));
    const { extracted: w } = await csvOf('Date,Amount,Card Type,Fee\n2026-07-01,100.00,Visa,-2.50\n2026-07-02,100.00,Visa,\n');
    check('negative-convention fees still flip, and a blank stays blank', w.summary.fees === 2.5 && w.transactions[1].fee === null,
      JSON.stringify(w.transactions));
  }

  /* ── 10. A card type read without its count or sales ──────────────────── */

  console.log('\nINCOMPLETE CARD TYPES - never priced as zero');

  for (const [label, field] of [['count', 'items'], ['sales', 'gross']]) {
    const x = load(fixtureName('WR', '202607'));
    x.card_types.find((c) => c.type === 'VISA')[field] = null;
    const r = reconcile(x);
    const { analysis: a, header: h } = analyse(x);
    check(`WR July, VISA ${label} not read: no saving pitched`, a.rebelipay.eligible === false && a.rebelipay.reason === 'incomplete'
      && a.rebelipay.savings === null && a.rebelipay.rebelipayCost === null && a.rebelipay.byCardType.length === 0
      && a.kpis.rebelipaySavings === null && h.rebelipayEligible === false && h.rebelipaySavings === null && h.rebelipayCost === null,
    JSON.stringify(a.rebelipay));
    check(`WR July, VISA ${label} not read: reconciliation fails card_type_rows`, r.ok === false
      && r.checks.find((c) => c.name === 'card_type_rows').ok === false && r.confidence < 1);
    if (field === 'items') {
      check('WR July, VISA count not read: transactions unknown, not a partial sum',
        a.kpis.transactions === null && h.transactionCount === null && a.rebelipay.transactions === null
          && a.kpis.avgTicketSource !== 'computed', `${a.kpis.transactions} ${a.kpis.avgTicketSource}`);
    }
  }

  /* ── 11. A read that stalls mid-stream is cut off at its deadline ──────── */

  console.log('\nDEADLINE - a stream that never finishes is stopped');

  await stalledStream();
})().then(finish, (e) => { console.error('threw:', e); process.exit(1); });

/**
 * A local server that starts a reply and then only ever pings: the headers
 * arrive at once, so the SDK's own timeout is satisfied, and only a deadline
 * on the body can end the read (D13).
 */
async function stalledStream() {
  const http = require('http');
  const timers = new Set();
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const start = { type: 'message_start', message: { id: 'msg_stall', type: 'message', role: 'assistant', content: [],
      model: 'stub', stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } };
    res.write(`event: message_start\ndata: ${JSON.stringify(start)}\n\n`);
    const t = setInterval(() => res.write('event: ping\ndata: {"type": "ping"}\n\n'), 200);
    timers.add(t);
    res.on('close', () => { clearInterval(t); timers.delete(t); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  const started = Date.now();
  let err = null;
  try {
    await extractPdf({ buffer: Buffer.from('%PDF-1.4\n'), fileName: 'stall.pdf' });
  } catch (e) {
    err = e;
  }
  const ms = Date.now() - started;
  for (const t of timers) clearInterval(t);
  if (server.closeAllConnections) server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  check(`a stalled stream is stopped at the 1 s deadline (${ms} ms), as EXTRACTION_UNAVAILABLE`,
    Boolean(err) && err.code === 'EXTRACTION_UNAVAILABLE' && ms < 4000, err ? `${err.code} ${err.message}` : 'resolved');
  check('with an owner-safe, retryable message', Boolean(err) && /took too long/.test(err.publicMessage || '')
    && !DASH.test(err.publicMessage) && !VENDOR.test(err.publicMessage), err && err.publicMessage);
}

function finish() {
  console.log('');
  if (failures) {
    console.log(`${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('ALL CHECKS PASSED');
}
