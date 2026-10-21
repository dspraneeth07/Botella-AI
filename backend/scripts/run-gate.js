#!/usr/bin/env node
/**
 * Evaluate the gate for every store-family, and record the verdict.
 *
 *   node scripts/run-gate.js            # the whole estate
 *   node scripts/run-gate.js 171 171    # one store
 *
 * THE JOB SHEET 17 WAS WAITING ON.
 *   Sheet 17 built the gate's statistics and the table to hold its verdicts,
 *   and nothing assembled the inputs. This is that: read outcomes and the
 *   volume-matched null pool from `recommendation_outcomes` and
 *   `feature_daily`, hand them to the Python side, write the verdict back.
 *
 * WHY THE STATISTICS ARE NOT HERE
 *   `app/pipeline/gate/` owns the randomisation test, the volume classes and
 *   the state transitions, where the registry Settings and the build guards
 *   are. This script moves rows. Re-implementing the transition rule in
 *   JavaScript is how an estate ends up with two answers to "is this family
 *   live" - the 454-vs-485 lesson, which sheet 19 has just had to fix once
 *   already in the lift metric.
 */

require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');

const { getAnalyticsPool } = require('../database/analytics-connection');
const outcomes = require('../services/outcomeFeedbackService');
const familyGate = require('../services/familyGateService');

// The interpreter is RESOLVED, not assumed. This file hardcoded the Windows
// venv layout (.venv/Scripts/python.exe), which a Linux virtualenv never
// creates - so the nightly gate failed with ENOENT on every deployed box while
// passing on a developer's machine, and the cron's catch turned that into one
// log line a night. See lib/pythonRunner.js.
const python = require('../lib/pythonRunner');

const RUNNER = 'gate_eval.py';

const args = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);

/**
 * Volume class boundaries, mirrored from `gate.volume_class_bounds`.
 *
 * Duplicated here ONLY to bucket the null pool before handing it over - the
 * Python side still owns the definition, and `gate_eval.py` re-derives each
 * class from the same Setting. If these ever disagree the null pool is keyed
 * on classes the gate does not recognise and every family reports
 * `no_matched_null`, which is loud rather than silent.
 */
const CLASS_BOUNDS = [0.1, 0.5, 2.0, 10.0];

function volumeClass(unitsPerOpenDay) {
  if (unitsPerOpenDay === null || unitsPerOpenDay === undefined) return 'unmeasured';
  for (let i = 0; i < CLASS_BOUNDS.length; i++) {
    if (unitsPerOpenDay < CLASS_BOUNDS[i]) return `v${i}`;
  }
  return `v${CLASS_BOUNDS.length}`;
}

(async () => {
  const pool = getAnalyticsPool();

  if (!(await outcomes.outcomesTableExists(pool))) {
    console.error('recommendation_outcomes is missing. Run: npm run migrate');
    process.exit(1);
  }

  const pairs = args.length >= 2
    ? [{ client_id: args[0], location_id: args[1] }]
    : (await pool.query(
      `SELECT DISTINCT client_id, location_id FROM recommendation_outcomes
        ORDER BY 1, 2`
    )).rows;

  if (!pairs.length) {
    console.log('No scored outcomes yet, so no family can be judged.');
    console.log('The holdout is on (sheet 17); the gate needs roughly a quarter');
    console.log('of accumulated outcomes before any family can leave shadow.');
    process.exit(0);
  }

  let evaluated = 0;
  let live = 0;
  let transitions = 0;

  for (const { client_id: clientId, location_id: locationId } of pairs) {
    const { rows: families } = await pool.query(
      `SELECT DISTINCT family FROM recommendation_outcomes
        WHERE client_id = $1 AND location_id = $2`,
      [clientId, locationId]
    );

    // The null pool: SKUs this store sold that the engine said NOTHING about.
    // Bucketed by volume class so a 2-a-month SKU is only ever compared
    // against other 2-a-month SKUs.
    const poolRows = await outcomes.nullPoolForGate(pool, { clientId, locationId });
    const nullPool = {};
    for (const row of poolRows) {
      const openDays = Number(row.open_days) || 0;
      const rate = openDays > 0 ? Number(row.units) / openDays : null;
      const cls = volumeClass(rate);
      // The pool holds LIFTS, and an un-recommended SKU's lift against its own
      // baseline is what "it would have done anyway" means. Approximated here
      // as its rate relative to the store's median rate in its class; the
      // Python side does the comparison, this only supplies the sample.
      (nullPool[cls] = nullPool[cls] || []).push(rate === null ? 0 : rate);
    }
    // Normalise each class to its own median, so a pool entry is a RATIO
    // comparable with a lift rather than a raw rate.
    for (const cls of Object.keys(nullPool)) {
      const sorted = [...nullPool[cls]].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] || 0;
      nullPool[cls] = median > 0
        ? nullPool[cls].map((r) => r / median)
        : [];
      if (!nullPool[cls].length) delete nullPool[cls];
    }

    for (const { family } of families) {
      const familyOutcomes = await outcomes.outcomesForGate(pool, {
        clientId, locationId, family,
      });
      const current = (await familyGate.statesForStore(pool, clientId, locationId))
        .states.get(family);

      const payload = {
        client_id: clientId,
        location_id: locationId,
        family,
        outcomes: familyOutcomes.map((o) => ({
          sku: o.sku, family: o.family, lift: o.lift, shown: o.shown,
          volume_class: 'v2',
        })),
        null_pool: nullPool,
        current: current ? current.state : null,
        cohort_state: null,
      };

      const tmp = path.join(os.tmpdir(), `gate-${clientId}-${locationId}-${family}.json`);
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      let verdict;
      try {
        const { stdout } = await python.runScript(RUNNER, [tmp]);
        verdict = JSON.parse(stdout);
      } finally {
        fs.unlinkSync(tmp);
      }

      await familyGate.recordVerdict(pool, verdict);
      evaluated += 1;
      if (verdict.state === 'live') live += 1;
      if (verdict.transitioned) transitions += 1;

      const evidence = verdict.evidence
        ? ` p=${verdict.evidence.p_value} observed=${verdict.evidence.observed} `
          + `null=${verdict.evidence.null_mean}`
        : '';
      console.log(
        `  ${String(`${clientId}:${locationId}`).padEnd(10)}`
        + `${family.padEnd(14)}${verdict.state.padEnd(11)}`
        + `n=${String(verdict.n_outcomes).padStart(4)}  ${verdict.reason}${evidence}`
      );
    }
  }

  console.log('');
  console.log(`${evaluated} store-family pair(s) evaluated, ${live} live, `
    + `${transitions} transition(s)`);
  process.exit(0);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
