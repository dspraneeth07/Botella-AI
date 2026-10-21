#!/usr/bin/env node
/**
 * ONE definition of lift, pinned across both languages.
 *
 * There were two. `recommendationEvalService.js` used a 28-day baseline and
 * pooled the ratio across a recommendation's SKUs; `app/store_data/feedback.py`
 * used a 21-day baseline, a fixed 7-day post window, and the unweighted MEAN
 * of per-SKU ratios. On identical data those produce answers 1.37x apart.
 *
 * That is the 454-vs-485 failure - a figure that differed between two screens
 * while the owner was told in writing that they matched - reproduced in the
 * metric the entire feedback loop depends on. Calibration fits on lift, k is
 * fitted from it, the gate judges on it.
 *
 * This runs one shared fixture through BOTH implementations and compares the
 * results digit for digit. The same pattern sheet 08 uses to pin the stage
 * envelope across the two languages.
 *
 * Run:  node tests/lift-parity-verify.js
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { liftFor, scoreFromLift } = require('../lib/lift');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// ── The shared fixture. Every case exists because it once produced a
//    disagreement, or because it is a boundary the two could drift across.
const CASES = [
  {
    name: 'a plain recommendation, both SKUs with a baseline',
    skus: [
      { sku: 'A', baseline_units: 100, actual_units: 110 },
      { sku: 'B', baseline_units: 40, actual_units: 50 },
    ],
    windows: { baseline_open_days: 23, window_open_days: 6 },
  },
  {
    name: 'the pooled-vs-mean case: one busy SKU and one quiet one',
    // Pooled: (110+3)/(100+1 scaled) . Mean of ratios: (1.1 + 3.0)/2.
    // These differ by ~2x, which is how the two implementations diverged.
    skus: [
      { sku: 'BUSY', baseline_units: 100, actual_units: 110 },
      { sku: 'QUIET', baseline_units: 1, actual_units: 3 },
    ],
    windows: { baseline_open_days: 28, window_open_days: 7 },
  },
  {
    name: 'a zero-baseline SKU is upside, never a zero denominator',
    skus: [
      { sku: 'HAS', baseline_units: 20, actual_units: 25 },
      { sku: 'NEW', baseline_units: 0, actual_units: 9 },
    ],
    windows: { baseline_open_days: 23, window_open_days: 6 },
  },
  {
    name: 'every SKU is new - unmeasurable, not infinite',
    skus: [{ sku: 'NEW1', baseline_units: 0, actual_units: 12 }],
    windows: { baseline_open_days: 23, window_open_days: 6 },
  },
  {
    name: 'a store closed throughout the baseline window',
    skus: [{ sku: 'A', baseline_units: 50, actual_units: 10 }],
    windows: { baseline_open_days: 0, window_open_days: 6 },
  },
  {
    name: 'a store closed throughout the measurement window',
    skus: [{ sku: 'A', baseline_units: 50, actual_units: 0 }],
    windows: { baseline_open_days: 23, window_open_days: 0 },
  },
  {
    name: 'no SKUs at all',
    skus: [],
    windows: { baseline_open_days: 23, window_open_days: 6 },
  },
  {
    name: "Bethany's real shape: 23 open days in a 28-day window",
    skus: [{ sku: '080686001904', baseline_units: 277, actual_units: 96 }],
    windows: { baseline_open_days: 23, window_open_days: 6 },
  },
  {
    name: 'a fractional result that must round identically in both languages',
    skus: [{ sku: 'A', baseline_units: 7, actual_units: 3 }],
    windows: { baseline_open_days: 23, window_open_days: 6 },
  },
];

console.log('\n── Both implementations, one fixture ──────────────────────');

const fixturePath = path.join(require('os').tmpdir(), 'lift-parity-fixture.json');
fs.writeFileSync(fixturePath, JSON.stringify(CASES), 'utf8');

// Resolved rather than hardcoded: .venv/Scripts/python.exe is the WINDOWS
// layout, and a Linux virtualenv has no Scripts/ at all - so this test
// reported "the Python side runs: FAIL" on any POSIX box, a parity failure
// that was really a path.
const pythonRunner = require('../lib/pythonRunner');

let pythonResults = null;
try {
  const out = execFileSync(pythonRunner.resolvePython(),
    [pythonRunner.scriptPath('lift_parity.py'), fixturePath], { encoding: 'utf8' });
  pythonResults = JSON.parse(out);
} catch (err) {
  check('0  the Python side runs', false,
    `${String(err.message).slice(0, 200)}`);
}

if (!pythonResults) {
  console.log('\n  Cannot compare without the Python side. '
    + 'Is Botella_External_APIs/.venv present, or PYTHON_BIN set?');
  process.exit(1);
}

check('0  the Python side ran and returned every case',
  pythonResults.length === CASES.length,
  `${pythonResults.length} of ${CASES.length}`);

for (let i = 0; i < CASES.length; i++) {
  const c = CASES[i];
  const node = liftFor(c.skus, c.windows);
  const py = pythonResults[i];

  const sameLift = node.lift === py.lift
    || (node.lift === null && py.lift === null);
  check(`${i + 1}  ${c.name}`,
    sameLift
    && node.expected === py.expected
    && node.actual === py.actual
    && node.upside_units === py.upside_units
    && node.baselined_skus === py.baselined_skus
    && node.upside_skus === py.upside_skus
    && node.measurable === py.measurable,
    `node=${JSON.stringify({ lift: node.lift, expected: node.expected, measurable: node.measurable })} `
    + `py=${JSON.stringify({ lift: py.lift, expected: py.expected, measurable: py.measurable })}`);
}

console.log('\n── The properties the definition promises ────────────────');

const pooled = liftFor(CASES[1].skus, CASES[1].windows);
const meanOfRatios = CASES[1].skus
  .map((s) => s.actual_units / ((s.baseline_units / 28) * 7))
  .reduce((a, b, _, arr) => a + b / arr.length, 0);
check('A  a pooled ratio, not a mean of ratios',
  Math.abs(pooled.lift - meanOfRatios) > 0.5,
  `pooled=${pooled.lift} meanOfRatios=${meanOfRatios.toFixed(2)} — `
  + 'the quiet SKU must not carry half the answer');

const upside = liftFor(CASES[2].skus, CASES[2].windows);
check('B  a zero-baseline SKU is reported apart, not in the numerator',
  upside.upside_units === 9 && upside.actual === 25,
  JSON.stringify({ upside: upside.upside_units, actual: upside.actual }));

const noBaseline = liftFor(CASES[3].skus, CASES[3].windows);
check('C  unmeasurable is null WITH a reason, never 1.0',
  noBaseline.lift === null && !noBaseline.measurable && !!noBaseline.reason,
  JSON.stringify(noBaseline));

check('D  open days change the answer - they are not decoration',
  liftFor(CASES[7].skus, { baseline_open_days: 23, window_open_days: 6 }).lift
    !== liftFor(CASES[7].skus, { baseline_open_days: 28, window_open_days: 7 }).lift,
  'a calendar-day divisor understates Bethany by 21.7%');

check('E  the score agrees with the lift it came from',
  scoreFromLift(1) === 0.5 && scoreFromLift(null) === null,
  `1.0x must squash to the 0.5 midpoint; got ${scoreFromLift(1)}`);

fs.unlinkSync(fixturePath);

console.log('');
console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
