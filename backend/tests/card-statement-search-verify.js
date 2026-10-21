#!/usr/bin/env node
/**
 * Card Statement Analysis - does the list's search box find what the owner means?
 *
 * The owner searches by store, merchant number or file name, and by period:
 * "june", "jun 2026", "06/2026", "2026", a day such as "06/30/2026". Every word
 * has to match, as text or as a period (cardStatementSearch.js).
 *
 * Pinned here:
 *
 *   READ        every supported period spelling reads as the right period, and
 *               an impossible one ("13/2026", "02/30/2026", a bare "6") stays text
 *   PHRASES     "jun 2026" and "june 30 2026" read as ONE period, not a month
 *               AND a year that two different statements could satisfy
 *   SQL         one parameterised condition: placeholders continue the caller's
 *               numbering, nothing typed reaches the SQL text, LIKE wildcards
 *               are escaped, and every word keeps its text alternative
 *   MEANING     run against the 12 sample statements with the same semantics
 *               as the SQL: "june" finds the four June statements, "wine june"
 *               two, "06/30/2026" the four statements covering that day
 *
 * Run:  node tests/card-statement-search-verify.js
 */

const path = require('path');
const { parseSearch, periodOf, searchClause, likePattern } = require('../services/cardStatementSearch');

const FIXTURES = path.join(__dirname, 'fixtures', 'card-statements');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const describe = (p) => {
  if (!p) return 'text';
  if (p.kind === 'date') return `date:${p.date}`;
  if (p.kind === 'month_year') return `month_year:${p.first}..${p.last}`;
  if (p.kind === 'month') return `month:${p.month}`;
  return `year:${p.year}`;
};

/* ── READ ────────────────────────────────────────────────────────────────── */
console.log('\nREAD - period spellings');
const READS = [
  ['june', 'month:6'], ['Jun', 'month:6'], ['JULY', 'month:7'], ['may', 'month:5'], ['Sept', 'month:9'],
  ['2026', 'year:2026'],
  ['June/2026', 'month_year:2026-06-01..2026-06-30'], ['06/2026', 'month_year:2026-06-01..2026-06-30'],
  ['6-2026', 'month_year:2026-06-01..2026-06-30'], ['2026-06', 'month_year:2026-06-01..2026-06-30'],
  ['2026/6', 'month_year:2026-06-01..2026-06-30'], ['jun26', 'month_year:2026-06-01..2026-06-30'],
  ['feb-2028', 'month_year:2028-02-01..2028-02-29'],
  ['06/30/2026', 'date:2026-06-30'], ['6/30/26', 'date:2026-06-30'], ['2026-06-30', 'date:2026-06-30'],
  ['30/06/2026', 'date:2026-06-30'], ['20260630', 'date:2026-06-30'],
  ['13/2026', 'text'], ['02/30/2026', 'text'], ['6', 'text'], ['26', 'text'], ['1899', 'text'],
  ['wine', 'text'], ['498387143882', 'text'], ['50%', 'text'],
];
for (const [word, want] of READS) {
  const got = describe(periodOf(word));
  check(`"${word}" reads as ${want}`, got === want, `got ${got}`);
}

/* ── PHRASES ─────────────────────────────────────────────────────────────── */
console.log('\nPHRASES - several words, one period');
const PHRASES = [
  ['jun 2026', ['month_year:2026-06-01..2026-06-30']],
  ['June 2026', ['month_year:2026-06-01..2026-06-30']],
  ['2026 june', ['month_year:2026-06-01..2026-06-30']],
  ['June 30 2026', ['date:2026-06-30']],
  ['June 30, 2026', ['date:2026-06-30']],
  ['30 June 2026', ['date:2026-06-30']],
  ['wine june', ['text', 'month:6']],
  ['wine jun 2026', ['text', 'month_year:2026-06-01..2026-06-30']],
  ['WINE REPUBLIC', ['text', 'text']],
  ['  bethany   wines  ', ['text', 'text']],
];
for (const [term, want] of PHRASES) {
  const got = parseSearch(term).map((w) => describe(w.period));
  check(`"${term}" is ${want.join(' & ')}`, JSON.stringify(got) === JSON.stringify(want), `got ${got.join(' & ')}`);
}
check('an empty query has no words', parseSearch('   ').length === 0);
check('a long query is capped at 8 words', parseSearch('a b c d e f g h i j k').length === 8);

/* ── SQL ─────────────────────────────────────────────────────────────────── */
console.log('\nSQL - one parameterised condition');
{
  const params = [171, 'analysed'];
  const sql = searchClause("wine jun 2026 O'Brien", params);
  check('placeholders continue after the caller\'s parameters', /\$3\b/.test(sql) && !/\$1\b|\$2\b/.test(sql), sql);
  check('nothing typed reaches the SQL text', !/wine|jun|2026|brien/i.test(sql), sql);
  check('every word must match (AND)', sql.split(') AND (').length === 3, sql);
  check('the period word keeps its text alternative',
    /file_name ILIKE \$4 OR \(period_start <= \$5::date AND period_end >= \$6::date\)/.test(sql), sql);
  check('values: patterns and month bounds',
    JSON.stringify(params.slice(2)) === JSON.stringify(['%wine%', '%jun 2026%', '2026-06-30', '2026-06-01', "%O'Brien%"]),
    JSON.stringify(params));
  check('an empty query adds no condition and no parameter', searchClause('  ', params) === null && params.length === 7);
  check('LIKE wildcards are escaped', likePattern('50%_x\\') === '%50\\%\\_x\\\\%', likePattern('50%_x\\'));
  const p2 = [];
  const day = searchClause('06/30/2026', p2);
  check('a day tests the period that covers it',
    day.includes('period_start <= $2::date AND period_end >= $2::date') && p2[1] === '2026-06-30', day);
  const p3 = [];
  check('a month tests either end of the period',
    searchClause('june', p3).includes('EXTRACT(MONTH FROM period_start) = $2 OR EXTRACT(MONTH FROM period_end) = $2') && p3[1] === 6);
  const p4 = [];
  check('a year tests either end of the period',
    searchClause('2026', p4).includes('EXTRACT(YEAR FROM period_start) = $2 OR EXTRACT(YEAR FROM period_end) = $2') && p4[1] === 2026);
}

/* ── MEANING ─────────────────────────────────────────────────────────────── */
console.log('\nMEANING - the 12 sample statements');
const NAMES = ['498387143882', '498407670880', '498466534886', '498480373881']
  .flatMap((m) => ['202605', '202606', '202607'].map((p) => `${m}_${p}`));
const rows = NAMES.map((name) => {
  const x = require(path.join(FIXTURES, `${name}.extracted.json`));
  const [m, ym] = name.split('_');
  return {
    key: `${x.merchant.name} ${ym}`,
    merchant_name: x.merchant.name,
    merchant_number: m,
    file_name: `Statement_Location_${m}_${x.period.end.replace(/-/g, '')}.pdf`,
    period_start: x.period.start,
    period_end: x.period.end,
  };
});
// A row with no period yet, as an analysing upload has.
rows.push({ key: 'analysing upload', merchant_name: null, merchant_number: null, file_name: 'june-statement.pdf', period_start: null, period_end: null });

// The SQL's semantics, written out in JavaScript.
const contains = (hay, needle) => hay != null && hay.toLowerCase().includes(needle.toLowerCase());
const monthNo = (d) => Number(d.slice(5, 7));
const yearNo = (d) => Number(d.slice(0, 4));
function matches(row, term) {
  return parseSearch(term).every(({ text, period }) => {
    if (contains(row.merchant_name, text) || contains(row.merchant_number, text) || contains(row.file_name, text)) return true;
    if (!period || !row.period_start || !row.period_end) return false;
    if (period.kind === 'date') return row.period_start <= period.date && row.period_end >= period.date;
    if (period.kind === 'month_year') return row.period_start <= period.last && row.period_end >= period.first;
    if (period.kind === 'month') return monthNo(row.period_start) === period.month || monthNo(row.period_end) === period.month;
    return yearNo(row.period_start) === period.year || yearNo(row.period_end) === period.year;
  });
}
const found = (term) => rows.filter((r) => matches(r, term)).map((r) => r.key).sort();

const EXPECT = [
  ['june', 5, (k) => k.endsWith('202606') || k === 'analysing upload'],
  // One phrase, so the analysing "june-statement.pdf" (no period yet, and no
  // "jun 2026" in its name) is not found, unlike a bare "june" above.
  ['jun 2026', 4, (k) => k.endsWith('202606')],
  ['06/2026', 4, (k) => k.endsWith('202606')],
  ['2026-06', 4, (k) => k.endsWith('202606')],
  ['July', 4, (k) => k.endsWith('202607')],
  ['06/30/2026', 4, (k) => k.endsWith('202606')],
  ['2026-07-01', 4, (k) => k.endsWith('202607')],
  ['2026', 12, (k) => k !== 'analysing upload'],
  ['wine june', 2, (k) => /^(WINE REPUBLIC|BETHANY WINES & LIQUORS) 202606$/.test(k)],
  ['wine republic', 3, (k) => k.startsWith('WINE REPUBLIC ')],
  ['498387143882 may', 1, (k) => k === 'WINE REPUBLIC 202605'],
  ['august', 0, () => false],
  ['05/2025', 0, () => false],
];
for (const [term, n, pick] of EXPECT) {
  const got = found(term);
  const want = rows.map((r) => r.key).filter(pick).sort();
  check(`"${term}" finds ${n}`, got.length === n && JSON.stringify(got) === JSON.stringify(want), got.join(', '));
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
