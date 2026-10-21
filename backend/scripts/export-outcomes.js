#!/usr/bin/env node
/**
 * Export one store's scored outcomes - what each card CLAIMED and what
 * happened - for the calibration differentiation measurement.
 *
 * WHY A NODE SCRIPT AND NOT A PYTHON QUERY. Node is the sole writer of
 * `bottleai_analytics` and the only process holding its credentials; the
 * Python side is stateless and reads what it is handed. So the measurement
 * (Botella_External_APIs/scripts/calibration_differentiation.py) gets a JSON
 * file, the same arrangement export-holdout-facts.js uses for the engine report.
 *
 * READ-ONLY. Two SELECTs, no writes, no temp tables.
 *
 * WHAT IS EXPORTED, and from where. Two sources, kept apart because they
 * answer with different windows and were produced by different jobs:
 *
 *   outcomes     recommendation_outcomes (migration 020): the per-card,
 *                per-window lift the nightly evaluation job computes, with the
 *                confidence the card STATED at issue (stated_confidence) and
 *                the window's open-day span. One row per (card, window).
 *   evaluations  recommendation_evaluations (migration 002): the older
 *                fixed-horizon grades at 7/30/60/90 days, with lift.
 *
 * For each row: the card id, its issue date, the stated confidence and its
 * basis (from the card row - `not_recorded` on every pre-040 row that had
 * none), the lift, the window, and `hit` = lift >= 1.0 - THE one definition,
 * the same one the ledger and the gate use (backend/lib/lift.js). A row with
 * no lift is exported with hit: null and lift: null rather than dropped, so
 * the measurement can say how much of the history is unmeasurable instead of
 * silently reporting on the part that is.
 *
 * Usage:
 *   node scripts/export-outcomes.js --store 171 --out ../audit/calibration/outcomes-171.json
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { getAnalyticsPool } = require('../database/analytics-connection');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const STORE = Number(arg('store', '171'));
const OUT = path.resolve(process.cwd(), arg('out', `outcomes-${STORE}.json`));

if (!Number.isInteger(STORE) || STORE <= 0) {
  console.error('--store must be a positive integer location id');
  process.exit(2);
}

(async () => {
  const pool = getAnalyticsPool();
  try {
    // The pilot stores have client_id == location_id; every query still
    // filters on BOTH, per the house rule.
    const { rows: outcomes } = await pool.query(
      `SELECT o.recommendation_id            AS rec_id,
              r.created_at::date::text        AS rec_date,
              r.action_type                   AS family,
              r.engine_family,
              o.stated_confidence::float      AS stated_confidence,
              o.calibrated_confidence::float  AS calibrated_confidence,
              r.confidence_basis,
              o.lift::float                   AS lift,
              o.lift_reason,
              o.window_start::text            AS window_start,
              o.window_end::text              AS window_end,
              o.open_days_in_window           AS window_open_days,
              o.arm,
              CASE WHEN o.lift IS NULL THEN NULL ELSE (o.lift >= 1.0) END AS hit
         FROM recommendation_outcomes o
         JOIN recommendations r ON r.id = o.recommendation_id
        WHERE o.client_id = $1 AND o.location_id = $1
          AND r.client_id = $1 AND r.location_id = $1
        ORDER BY r.created_at, o.recommendation_id, o.window_start`,
      [STORE]);

    const { rows: evaluations } = await pool.query(
      `SELECT e.rec_id,
              r.created_at::date::text        AS rec_date,
              r.action_type                   AS family,
              r.engine_family,
              r.confidence::float             AS stated_confidence,
              r.confidence_basis,
              e.window_days                   AS window,
              e.lift::float                   AS lift,
              e.verdict,
              (r.status IS NOT DISTINCT FROM 'holdout') AS holdout,
              CASE WHEN e.lift IS NULL THEN NULL ELSE (e.lift >= 1.0) END AS hit
         FROM recommendation_evaluations e
         JOIN recommendations r ON r.id = e.rec_id
        WHERE e.client_id = $1 AND e.location_id = $1
          AND r.client_id = $1 AND r.location_id = $1
        ORDER BY r.created_at, e.rec_id, e.window_days`,
      [STORE]);

    const measured = (rows) => rows.filter((x) => x.lift !== null).length;
    const out = {
      generated: new Date().toISOString(),
      store: STORE,
      hit_definition: 'lift >= 1.0 (backend/lib/lift.js); null lift => hit null, never a miss',
      counts: {
        outcomes: outcomes.length, outcomes_measured: measured(outcomes),
        evaluations: evaluations.length, evaluations_measured: measured(evaluations),
      },
      outcomes,
      evaluations,
    };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
    console.log(
      `store ${STORE}: ${outcomes.length} outcome rows (${out.counts.outcomes_measured} with a lift), ` +
      `${evaluations.length} evaluation rows (${out.counts.evaluations_measured} with a lift) -> ${OUT}`
    );
  } finally {
    await pool.end();
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
