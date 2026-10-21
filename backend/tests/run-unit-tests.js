#!/usr/bin/env node
/**
 * Runs every backend suite that needs NO database, NO network and NO .env, each
 * in its own Node process, and exits non-zero if any of them fails.
 *
 * This is backend/package.json's "test:unit" script and CI's `test-backend` job
 * runs it on every merge request and every branch push, next to `npm test`
 * (the card-statement suites). Before this file existed the test stage ran the
 * card-statement suites and nothing else: the holdout key, the stage envelope,
 * the service-token guard, the store-gate decision, the lift parity between
 * Node and Python - all had a verify script, and none of them ran anywhere a
 * merge could be blocked on them.
 *
 * THE LIST IS EXPLICIT, NOT A GLOB. Most files in tests/ open the analytics
 * database with sentinel tenants, or drive a running server, and a glob would
 * pull those into a job that has neither. Each name here was run with every
 * PG_* host pointed at a closed port and passed, which is the only proof that
 * matters. Add a suite here only after doing the same.
 *
 * lift-parity-verify.js needs a Python interpreter on PATH (it runs the Python
 * twin of lift.js through lib/pythonRunner.js) and the sibling
 * Botella_External_APIs checkout. CI installs python3 for the native-module
 * build anyway, and the checkout is this repository, so it runs there too.
 *
 * Run:  npm run test:unit        (from backend/)
 *       node tests/run-unit-tests.js
 */

const path = require('path');
const { spawnSync } = require('child_process');

const SUITES = [
  'answer-verifier-selftest.js',
  'card-order-by-verify.js',
  'holdout-assignment-verify.js',
  'lift-parity-verify.js',
  'numbers-verify.js',
  'po-duplicate-verify.js',
  'purchase-date-verify.js',
  'rec-surface-verify.js',
  'service-token-verify.js',
  'signals-today-verify.js',
  'stage-envelope-verify.js',
  'store-gate-serving-verify.js',
];

const dir = __dirname;
const results = [];
for (const file of SUITES) {
  console.log(`\n━━ ${file} ━━`);
  const started = Date.now();
  const run = spawnSync(process.execPath, [path.join(dir, file)], {
    cwd: path.join(dir, '..'),
    stdio: 'inherit',
    env: process.env,
  });
  const ok = run.status === 0 && !run.error && !run.signal;
  results.push({
    file, ok, ms: Date.now() - started,
    why: run.error ? run.error.message : (run.signal || `exit ${run.status}`),
  });
}

console.log('\n── Unit suites ──────────────────────────────────────────────');
for (const r of results) {
  console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.file}  (${r.ms} ms${r.ok ? '' : `, ${r.why}`})`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} of ${results.length} suites passed`);
process.exit(failed ? 1 : 0);
