#!/usr/bin/env node
/**
 * Drift: suspend any store that has sat below its matched null for a month.
 *
 *   node scripts/run-drift.js              # every store with recent outcomes
 *   node scripts/run-drift.js 171 171      # one store
 *   node scripts/run-drift.js --dry-run    # evaluate and print, write nothing
 *
 * WHAT GATE A/B CANNOT SEE
 *   `store_gate_verdict` is written by `publish_gate_verdicts.py` over a
 *   finished month, about four times a year, and a verdict then stands for
 *   120 days. Between publishes a store can go quietly wrong - a connector
 *   starts sending half its lines, an ordering policy changes - and every
 *   FAMILY can still be individually "not enough outcomes" while the store as
 *   a whole is consistently below what its own products did unprompted.
 *   Nothing watched for that. This does, nightly, after the family gate.
 *
 * WHAT IT WRITES, AND WHAT IT NEVER WRITES
 *   Drift PROVEN (every week of the window below the null, enough outcomes)
 *   writes state 'suspended', measured true, displayed false, with the reason
 *   and a validity window computed by the Python side from the same Setting
 *   the publisher uses. The measured inputs already on the row (ECE, fill
 *   ratio, margin...) are carried across rather than nulled, so "why is this
 *   store dark" still has its numbers.
 *
 *   Drift NOT proven - abstained for thin data, or the store beat its null in
 *   some week - writes NOTHING. Not a promotion, not a cleared suspension,
 *   not a refreshed timestamp. Promotion is Gate A/B's job, on measured
 *   accuracy and money over a finished month; a monitor that could both close
 *   and open a store would be a second gate with a weaker bar. A store this
 *   job suspended stays suspended until the next publish measures it afresh.
 *
 *   A store currently LIVE on a fresh published verdict is therefore only
 *   touched when drift is proven. The verdict row's `previous_state` and
 *   `state_changed_at` record that it was live and when it fell.
 *
 * WHY THE STATISTICS ARE NOT HERE
 *   `app/pipeline/gate/drift.py` owns the window, the bucket width, the
 *   floors and the comparison - which is the SAME `compare_to_matched_null`
 *   the family gate uses, so "below the null" means one thing across the
 *   estate. This script moves rows.
 */

require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');

const { getAnalyticsPool } = require('../database/analytics-connection');
const outcomes = require('../services/outcomeFeedbackService');
const recSvc = require('../services/recommendationService');
const python = require('../lib/pythonRunner');

const RUNNER = 'drift_eval.py';

/**
 * The window the outcomes and the null pool are read over, in days. Mirrors
 * `gate.drift_window_days` ONLY as a query bound: the Python side re-derives
 * the window from the Setting and ignores anything older. Reading a little
 * wider here would be harmless; reading narrower would starve the oldest
 * bucket and make every store abstain, which is loud rather than silent.
 */
const WINDOW_DAYS = 30;

/** The outcome window length the drift rule is defined on (evaluation's 30d). */
const OUTCOME_WINDOW_DAYS = 30;

/**
 * Volume class boundaries, mirrored from `gate.volume_class_bounds` exactly as
 * `run-gate.js` mirrors them, and for the same reason: the null pool has to be
 * bucketed before it is handed over, and the Python side still owns the
 * definition. Outcomes are labelled 'v2' as run-gate.js does; the two scripts
 * must agree with each other before either agrees with the registry.
 */
const CLASS_BOUNDS = [0.1, 0.5, 2.0, 10.0];
const OUTCOME_CLASS = 'v2';

function volumeClass(unitsPerOpenDay) {
  if (unitsPerOpenDay === null || unitsPerOpenDay === undefined) return 'unmeasured';
  for (let i = 0; i < CLASS_BOUNDS.length; i++) {
    if (unitsPerOpenDay < CLASS_BOUNDS[i]) return `v${i}`;
  }
  return `v${CLASS_BOUNDS.length}`;
}

function parseArgs(argv) {
  const nums = argv.filter((a) => /^\d+$/.test(a)).map(Number);
  return {
    dryRun: argv.includes('--dry-run'),
    pair: nums.length >= 2 ? { client_id: nums[0], location_id: nums[1] } : null,
  };
}

/** The local calendar day, never toISOString() - a +05:30 box would shift it. */
function todayLocal(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

/**
 * Shown-arm, 30-day-window outcomes scored inside the window, every family.
 * `scored_on` is the day the measurement window CLOSED - the day the evidence
 * landed - which is what the Python side buckets by.
 */
async function driftOutcomesFor(analyticsPool, { clientId, locationId, asOf, windowDays = WINDOW_DAYS }) {
  const { rows } = await analyticsPool.query(
    `SELECT sku, family, lift, arm, window_end::text AS scored_on
       FROM recommendation_outcomes
      WHERE client_id = $1 AND location_id = $2
        AND lift IS NOT NULL
        AND window_end - window_start = $4::int
        AND window_end > $3::date - $5::int
        AND window_end <= $3::date
      ORDER BY window_end`,
    [clientId, locationId, asOf, OUTCOME_WINDOW_DAYS, windowDays]
  );
  return rows.map((r) => ({
    sku: r.sku, family: r.family, lift: Number(r.lift),
    shown: r.arm === 'shown', volume_class: OUTCOME_CLASS,
    scored_on: r.scored_on,
  }));
}

/**
 * The null pool over the SAME window, bucketed and median-normalised exactly
 * as run-gate.js does it, so the drift comparison and the family gate's
 * comparison draw from pools built one way.
 */
async function nullPoolFor(analyticsPool, { clientId, locationId, windowDays = WINDOW_DAYS }) {
  const poolRows = await outcomes.nullPoolForGate(analyticsPool, {
    clientId, locationId, sinceDays: windowDays,
  });
  const nullPool = {};
  for (const row of poolRows) {
    const openDays = Number(row.open_days) || 0;
    const rate = openDays > 0 ? Number(row.units) / openDays : null;
    const cls = volumeClass(rate);
    (nullPool[cls] = nullPool[cls] || []).push(rate === null ? 0 : rate);
  }
  for (const cls of Object.keys(nullPool)) {
    const sorted = [...nullPool[cls]].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)] || 0;
    nullPool[cls] = med > 0 ? nullPool[cls].map((r) => r / med) : [];
    if (!nullPool[cls].length) delete nullPool[cls];
  }
  return nullPool;
}

/** The whole current row, so a suspension can carry the measured inputs across. */
async function currentVerdictRow(analyticsPool, clientId, locationId) {
  const { rows } = await analyticsPool.query(
    `SELECT * FROM store_gate_verdict WHERE client_id = $1 AND location_id = $2`,
    [clientId, locationId]
  );
  return rows[0] || null;
}

// ─── Evaluate and persist ────────────────────────────────────────────────────

async function runPython(payload) {
  const tmp = path.join(
    os.tmpdir(), `drift-${payload.client_id}-${payload.location_id}-${process.pid}.json`
  );
  fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
  try {
    const { stdout } = await python.runScript(RUNNER, [tmp]);
    return JSON.parse(stdout);
  } finally {
    fs.unlinkSync(tmp);
  }
}

/**
 * Write the suspension - and ONLY the suspension.
 *
 * Returns { written, changed, previousState }. `written` is false whenever
 * drift was not proven, which is the common case and the correct one: the
 * row is left exactly as the last publish or the last proven drift left it.
 */
async function applyDriftVerdict(analyticsPool, verdict, existing) {
  if (!verdict.drifted || verdict.state !== 'suspended') {
    return { written: false, changed: false, previousState: existing ? existing.state : null };
  }
  const prior = existing || {};
  const result = await recSvc.upsertStoreGateVerdict(analyticsPool, {
    client_id: verdict.client_id,
    location_id: verdict.location_id,
    state: 'suspended',
    reason: verdict.reason,
    // Measured: this IS a measurement, of a month of shown outcomes against
    // the store's own null. Not displayed: that is what suspended means.
    measured: true,
    displayed: false,
    // The inputs Gate A/B measured are carried across untouched. Nulling them
    // would turn "suspended for drift" into a row with no numbers on it.
    promise_fill_ratio: prior.promise_fill_ratio,
    ece_points: prior.ece_points,
    worst_bin_points: prior.worst_bin_points,
    interval_coverage: prior.interval_coverage,
    net_margin_month: prior.net_margin_month,
    backtest_edge: prior.backtest_edge,
    backtest_p_value: prior.backtest_p_value,
    cards: prior.cards,
    priced_cards: prior.priced_cards,
    calibration_scored: prior.calibration_scored,
    calibration_fitted: prior.calibration_fitted,
    interval_considered: prior.interval_considered,
    measured_for_month: prior.measured_for_month,
    calibration_is_stale: prior.calibration_is_stale,
    calibration_staleness_detail: prior.calibration_staleness_detail,
    // The validity window is the Python side's, from the same Setting the
    // publisher uses - never derived here (migration 033).
    verdict_as_of: verdict.verdict_as_of,
    valid_until: verdict.valid_until,
  });
  return { written: true, ...result };
}

/** One store, end to end. Inputs may be injected for the verify test. */
async function evaluateStore(analyticsPool, { clientId, locationId }, opts = {}) {
  const asOf = opts.asOf || todayLocal();
  const rows = opts.outcomes
    || await driftOutcomesFor(analyticsPool, { clientId, locationId, asOf });
  const nullPool = opts.nullPool
    || await nullPoolFor(analyticsPool, { clientId, locationId });
  const payload = {
    client_id: clientId, location_id: locationId, as_of: asOf,
    outcomes: rows, null_pool: nullPool,
  };
  const verdict = await runPython(payload);
  const existing = await currentVerdictRow(analyticsPool, clientId, locationId);
  const applied = opts.dryRun
    ? { written: false, changed: false, previousState: existing ? existing.state : null, dryRun: true }
    : await applyDriftVerdict(analyticsPool, verdict, existing);
  return { verdict, applied, existing, payload };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

async function main(argv = process.argv.slice(2)) {
  const { dryRun, pair } = parseArgs(argv);
  const pool = getAnalyticsPool();

  if (!(await outcomes.outcomesTableExists(pool))) {
    console.error('recommendation_outcomes is missing. Run: npm run migrate');
    process.exit(1);
  }
  const ready = await pool.query(
    `SELECT to_regclass('public.store_gate_verdict') IS NOT NULL AS ok`
  );
  if (!ready.rows[0].ok) {
    console.error('store_gate_verdict is missing (migrations 023/033). Run: npm run migrate');
    process.exit(1);
  }

  const asOf = todayLocal();
  const stores = pair ? [pair] : (await pool.query(
    `SELECT DISTINCT client_id, location_id FROM recommendation_outcomes
      WHERE window_end > $1::date - $2::int
      ORDER BY 1, 2`,
    [asOf, WINDOW_DAYS]
  )).rows;

  if (!stores.length) {
    console.log('No outcomes scored in the window, so no store can have drifted.');
    process.exit(0);
  }

  let evaluated = 0;
  let suspended = 0;
  let transitions = 0;
  let abstained = 0;
  let failed = 0;

  for (const { client_id: clientId, location_id: locationId } of stores) {
    try {
      const { verdict, applied } = await evaluateStore(pool, { clientId, locationId }, { dryRun });
      evaluated += 1;
      if (verdict.abstained) abstained += 1;
      if (applied.written) suspended += 1;
      if (applied.changed) transitions += 1;

      const label = String(`${clientId}:${locationId}`).padEnd(12);
      const outcome = verdict.drifted ? 'DRIFTED' : (verdict.abstained ? 'abstain' : 'holds');
      console.log(
        `  ${label}${outcome.padEnd(9)}n=${String(verdict.n_outcomes).padStart(4)}  `
        + `${verdict.reason}${applied.written ? '  -> suspended' : ''}`
      );
      if (applied.changed) {
        // One line per real transition, in a shape server.js can lift into
        // its log: a store that was live and is now suspended is the line a
        // human should read in the morning.
        console.log(`TRANSITION ${clientId}:${locationId} ${applied.previousState} -> suspended ${verdict.reason}`);
      }
    } catch (err) {
      failed += 1;
      console.error(`  ${clientId}:${locationId} FAILED - ${err.message}`);
    }
  }

  console.log('');
  console.log(
    `${evaluated} store(s) evaluated, ${suspended} suspended for drift, `
    + `${transitions} transition(s), ${abstained} abstained, ${failed} failed`
    + (dryRun ? ' (dry run - nothing written)' : '')
  );
  process.exit(failed && failed === stores.length ? 1 : 0);
}

module.exports = {
  OUTCOME_CLASS,
  WINDOW_DAYS,
  applyDriftVerdict,
  currentVerdictRow,
  driftOutcomesFor,
  evaluateStore,
  nullPoolFor,
  todayLocal,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
