#!/usr/bin/env node
/* eslint-disable no-console */
// -----------------------------------------------------------------------------
// cs-extract-sample.js - read one card statement the way the upload does, and
// compare it with a hand-verified fixture (CARD-STATEMENTS.md §9).
//
//   node scripts/cs-extract-sample.js <statement.pdf|export.csv>
//   node scripts/cs-extract-sample.js <statement.pdf> tests/fixtures/card-statements/<merchant>_<yyyymm>.extracted.json
//
// Prints the extracted JSON, the reconciliation checks and, with a fixture, a
// field-by-field diff (path, fixture value, extracted value) and a count.
//
// A PDF read calls the model with ANTHROPIC_API_KEY from backend/.env and
// costs a little; a CSV is parsed locally. The statements are real merchant
// documents: keep them outside the repo and pass a path. The output is for
// your terminal only; do not paste it into tickets or commit it.
//
// Exit codes: 0 read (whatever the diff says), 1 extraction failed, 2 usage.
// -----------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { detectKind, extract } = require('../services/cardStatementExtract');
const { reconcile, coreHeaderMissing } = require('../services/cardStatementReconcile');

const [file, fixturePath] = process.argv.slice(2);
if (!file) {
  console.error('Usage: node scripts/cs-extract-sample.js <statement.pdf|export.csv> [fixture.extracted.json]');
  process.exit(2);
}

// What fixtures and this script's output carry in place of a real tax ID.
const SYNTHETIC_TIN = '0000';

const money = (n) => (typeof n === 'number' && !Number.isInteger(n) ? n.toFixed(2) : String(n));

/** Every leaf that differs, by path. Numbers within half a cent are equal. */
function diff(expected, actual, at = '', out = []) {
  if (typeof expected === 'number' && typeof actual === 'number') {
    if (Math.abs(expected - actual) > 0.005) out.push([at, expected, actual]);
    return out;
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) { out.push([at, expected, actual]); return out; }
    const n = Math.max(expected.length, actual.length);
    if (expected.length !== actual.length) out.push([`${at}.length`, expected.length, actual.length]);
    for (let i = 0; i < n; i++) diff(expected[i], actual[i], `${at}[${i}]`, out);
    return out;
  }
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object') {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const k of keys) diff(expected[k], actual[k], at ? `${at}.${k}` : k, out);
    return out;
  }
  if (expected !== actual) out.push([at, expected, actual]);
  return out;
}

(async () => {
  const buffer = fs.readFileSync(file);
  const kind = detectKind({ buffer, originalName: path.basename(file), mimetype: '' });
  if (!kind) {
    console.error(`Not a PDF or a CSV: ${file}`);
    process.exit(1);
  }

  let result;
  try {
    result = await extract({ buffer, kind, fileName: path.basename(file) });
  } catch (err) {
    console.error(`Extraction failed [${err.code || 'UNKNOWN'}]`);
    console.error(`  owner sees: ${err.publicMessage || '(no public message)'}`);
    console.error(`  cause:      ${err.cause ? err.cause.message : err.message}`);
    process.exit(1);
  }

  const { extracted } = result;
  // Printed with the synthetic tax ID, so output pasted into a fixture is
  // already clean (D14). The real value is still checked as 4 digits below.
  const tinRead = Boolean(extracted.reportable_sales && /^\d{4}$/.test(extracted.reportable_sales.tin_last4 || ''));
  const printable = JSON.parse(JSON.stringify(extracted));
  if (tinRead) printable.reportable_sales.tin_last4 = SYNTHETIC_TIN;
  console.log(JSON.stringify(printable, null, 2));
  if (extracted.reportable_sales) console.log(`  (tin_last4 ${tinRead ? 'read as 4 digits; printed as "0000"' : 'not read'})`);

  console.log('\n-- read --');
  console.log(`  kind ${kind}  model ${result.model || '(none)'}  ${result.ms} ms`
    + `${result.stopReason ? `  stop ${result.stopReason}` : ''}`
    + `${result.usage ? `  tokens in ${result.usage.inputTokens} out ${result.usage.outputTokens}` : ''}`);
  const missing = coreHeaderMissing(extracted);
  if (missing.length) console.log(`  CORE HEADER MISSING: ${missing.join(', ')}`);

  const rec = reconcile(extracted);
  console.log(`\n-- reconciliation: ${rec.passed}/${rec.total} passed, confidence ${rec.confidence} --`);
  for (const c of rec.checks) {
    if (c.skipped) { console.log(`  [skip] ${c.name}`); continue; }
    console.log(`  [${c.ok ? ' ok ' : 'FAIL'}] ${c.name}: expected ${money(c.expected)} actual ${money(c.actual)}`
      + `${c.detail ? `  ${JSON.stringify(c.detail)}` : ''}`);
  }

  if (fixturePath) {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    // Fixtures carry the synthetic tax ID too (D14: nothing identifying beyond
    // merchant name and number is committed), so the comparison is with the
    // printed copy; a fixture holding a real last 4 shows up as a difference.
    const rows = diff(fixture, printable);
    console.log(`\n-- diff against ${path.basename(fixturePath)} --`);
    for (const [at, want, got] of rows) {
      console.log(`  ${at}\n      fixture:   ${JSON.stringify(want)}\n      extracted: ${JSON.stringify(got)}`);
    }
    console.log(`  ${rows.length} difference${rows.length === 1 ? '' : 's'}`);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
