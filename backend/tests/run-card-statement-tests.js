#!/usr/bin/env node
/**
 * Runs every Card Statement Analysis suite (tests/card-statement-*-verify.js),
 * each in its own Node process, and exits non-zero if any of them fails.
 *
 * This is backend/package.json's "test" script, so CI's `npm test --if-present`
 * runs it on every merge request. The suites need no database, no network, no
 * model and no .env: they run anywhere `npm ci` has run.
 *
 * Run:  npm test            (from backend/)
 *       node tests/run-card-statement-tests.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = __dirname;
const suites = fs.readdirSync(dir)
  .filter((f) => /^card-statement-.+-verify\.js$/.test(f))
  .sort();

if (!suites.length) {
  console.log('No card statement suites found.');
  process.exit(1);
}

const results = [];
for (const file of suites) {
  console.log(`\n━━ ${file} ━━`);
  const started = Date.now();
  const run = spawnSync(process.execPath, [path.join(dir, file)], {
    cwd: path.join(dir, '..'),
    stdio: 'inherit',
    env: process.env,
  });
  const ok = run.status === 0 && !run.error && !run.signal;
  results.push({ file, ok, ms: Date.now() - started, why: run.error ? run.error.message : (run.signal || `exit ${run.status}`) });
}

console.log('\n── Card statement tests ──────────────────────────────────────');
for (const r of results) {
  console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.file}  (${r.ms} ms${r.ok ? '' : `, ${r.why}`})`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} of ${results.length} suites passed`);
process.exit(failed ? 1 : 0);
