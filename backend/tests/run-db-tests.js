#!/usr/bin/env node
/**
 * Runs every backend suite that needs the ANALYTICS DATABASE and nothing else -
 * no syncgo warehouse data, no running server, no model key, no network - each
 * in its own Node process, and exits non-zero if any of them fails.
 *
 * This is backend/package.json's "test:db" script and CI's `test-backend-db`
 * job runs it against the same postgres:16 service the migrations job uses,
 * after `node database/migrate.js analytics` has built the schema from empty.
 * Before this file existed these suites ran only when someone remembered to
 * run them by hand: the 19 October 2026 QA audit (defect 16) counted 21
 * database-backed suites, found 15 of them passing on the local database, and
 * none of them anywhere a merge could be blocked on them. They are the suites
 * that exercise the evaluator, the gates, the drift monitor, the lifecycle,
 * the scoreboards and the forward test end to end - the most valuable Node
 * tests in the tree, and the ones a schema change breaks first.
 *
 * WHAT A SUITE MUST BE TO BE LISTED HERE. Each one:
 *   - loads backend/.env through dotenv (a no-op in CI, where there is none)
 *     and opens the analytics pool from ANALYTICS_PG_* (database/
 *     analytics-connection.js), so CI points those at its service container;
 *   - uses a SENTINEL tenant (client ids 9999xx) that it creates and removes
 *     itself, so it is safe against a shared development database;
 *   - either never touches the syncgo warehouse, or MOCKS it (rec-eval,
 *     pilot-scoreboard, forward-test-daily pass a mock pool in). In CI PG_* is
 *     pointed at the same analytics service, which has no warehouse tables:
 *     a suite that opened a real syncgo pool would fail there with "relation
 *     does not exist", so one that does is not on this list.
 * Each name below was run with PG_* pointed at the analytics database (the CI
 * shape) and passed. Add a suite only after doing the same.
 *
 * EXCLUDED, AND WHY (so nobody re-adds them without reading this):
 *   on-hand-capture-verify.js   opens the REAL syncgo pool (getPool) and asserts
 *                               that the newest captured shelf count is as new
 *                               as the newest sync. That is a statement about
 *                               the nightly 03:45 job on a live estate, not
 *                               about the code; in CI there is no warehouse,
 *                               and on the laptop it correctly fails whenever
 *                               the capture has not run (QA: 6 days stale).
 *   rec-admission-verify.js     its checks 3, 7, 7b, 8, 8b assert the module
 *                               DEFAULTS for the profit and confidence floors
 *                               (REC_MIN_PROFIT_USD 1, REC_MIN_CONFIDENCE
 *                               0.35), and read them from the environment -
 *                               so it passes or fails with whatever .env the
 *                               process inherited (this checkout sets both to
 *                               0 and it fails 5 checks). Env-dependent floors
 *                               are not a CI assertion; it needs its own
 *                               pinned-env harness before it can be listed.
 *   holdout-assignment-verify.js already in run-unit-tests.js (needs no DB).
 *   audit-verify, fixfinal-verify, hallucination-eval, reaudit-fixes,
 *   round5-e2e, routing-eval, metric-spike-eval, redteam-verify
 *                               need a running server and a model key and
 *                               spend LLM calls.
 *   rls-and-index-proof.sh      needs local Postgres binaries (initdb).
 *   feature-store-reconcile.js, tenant-leak-probe.js, round5-unit.js,
 *   ground-truth.js, grade-eval.js
 *                               utilities and probes against real tenants,
 *                               not sentinel suites.
 *
 * Run:  npm run test:db                     (from backend/, against .env's DB)
 *       node tests/run-db-tests.js [name-verify.js ...]   (a subset)
 *
 * The CI shape, locally (every PG_* at the analytics database):
 *       PG_HOST=$ANALYTICS_PG_HOST PG_PORT=$ANALYTICS_PG_PORT \
 *       PG_DATABASE=$ANALYTICS_PG_DATABASE PG_USER=$ANALYTICS_PG_USER \
 *       PG_PASSWORD=$ANALYTICS_PG_PASSWORD npm run test:db
 */

const path = require('path');
const { spawnSync } = require('child_process');

// The runner's own dotenv load is for the pre-flight below; each suite loads
// it again in its own process, from the same file.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const SUITES = [
  'card-retirement-verify.js',
  'catalog-tracking-verify.js',
  'confidence-basis-verify.js',
  'daily-snapshot-verify.js',
  'drift-verify.js',
  'family-gate-verify.js',
  'forward-test-daily-verify.js',
  'holdout-report-verify.js',
  'ingestion-verify.js',
  'lead-time-verify.js',
  'money-audit-verify.js',
  'outcome-feedback-verify.js',
  'pilot-scoreboard-verify.js',
  'quality-gate-verify.js',
  'store-spectrum-verify.js',
];

// Suites that need the REAL syncgo warehouse as well, so they run by hand on a
// developer machine (`node tests/run-db-tests.js rec-eval-verify.js`) and are
// NOT in the default list CI runs. Named here rather than silently dropped so
// the runner can still run them when asked, and so the reason is next to the
// name.
//
//   rec-eval-verify.js   mocks the warehouse for scoring (it passes
//                        `syncgoPool: mockSyncgo` into evaluateTenant), but the
//                        evaluator's owner-action claim re-evaluation opens the
//                        pool itself - `opts.syncgoPool || getPool()` in
//                        services/recommendationEvalService.js - on a path the
//                        test's options do not reach, and reads sale_items
//                        there. With PG_* at the analytics database (the CI
//                        shape) that logs `relation "sale_items" does not
//                        exist` and two checks fail: 'owner "yes" fills an
//                        unknown action as owner_reported' and 'owner "no"
//                        fills an unknown action as not acted'. The other 86
//                        pass. Measured 19 October 2026 with exactly that env;
//                        against the real warehouse all 88 pass (QA audit).
//                        Threading the mock through that call is a change to
//                        the evaluator, which is being edited elsewhere.
const WAREHOUSE_SUITES = [
  'rec-eval-verify.js',
];

// Two pairs share a sentinel tenant (holdout-report and pilot-scoreboard on
// 999921; catalog-tracking and rec-eval on 999901) and each cleans it first,
// so the suites run ONE AT A TIME. Do not parallelise this loop.

const requested = process.argv.slice(2);
const known = [...SUITES, ...WAREHOUSE_SUITES];
const unknown = requested.filter((n) => !known.includes(n));
if (unknown.length) {
  console.error(`not in the DB suite list: ${unknown.join(', ')}`);
  console.error(`known: ${known.join(', ')}`);
  process.exit(2);
}
const toRun = requested.length ? requested : SUITES;

async function preflight() {
  // One query before thirteen suites each discover the same closed port,
  // with the target named: a wrong ANALYTICS_PG_HOST in CI should read as a
  // wrong variable, not as thirteen unrelated failures.
  const { getAnalyticsPool } = require('../database/analytics-connection');
  const target = `${process.env.ANALYTICS_PG_HOST || 'localhost'}:${process.env.ANALYTICS_PG_PORT || '5432'}`
    + `/${process.env.ANALYTICS_PG_DATABASE || 'bottleai_analytics'}`;
  const pool = getAnalyticsPool();
  try {
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM schema_migrations'
    );
    console.log(`analytics database ${target}: reachable, ${rows[0].n} migrations recorded`);
  } catch (err) {
    console.error(
      `analytics database ${target} is not usable: ${err.message}\n`
      + 'Set ANALYTICS_PG_HOST / ANALYTICS_PG_PORT / ANALYTICS_PG_DATABASE / '
      + 'ANALYTICS_PG_USER / ANALYTICS_PG_PASSWORD (backend/.env locally; job '
      + 'variables in CI) and run `node database/migrate.js analytics` first.'
    );
    process.exit(2);
  } finally {
    await pool.end();
  }
}

(async () => {
  await preflight();

  const dir = __dirname;
  const results = [];
  for (const file of toRun) {
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

  console.log('\n── Database suites ──────────────────────────────────────────');
  for (const r of results) {
    console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.file}  (${r.ms} ms${r.ok ? '' : `, ${r.why}`})`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} of ${results.length} suites passed`);
  process.exit(failed ? 1 : 0);
})();
