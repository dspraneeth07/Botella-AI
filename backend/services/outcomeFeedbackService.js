'use strict';

/**
 * Sheet 19 — the outcome feedback loop. Shown and withheld alike.
 *
 * NOTHING ELSE IMPROVES WITHOUT THIS.
 *   Calibration fits on outcomes. The shrinkage constant k is fitted from
 *   them. The gate judges on them. Cohort priors sharpen against them. Every
 *   PROVISIONAL setting in the registry stays provisional until this loop has
 *   run for a quarter.
 *
 * THE WITHHELD ARM IS THE ENTIRE POINT.
 *   Both arms are scored by the SAME function, over the SAME window, against
 *   the SAME baseline. Not "also scored" - identically scored. The moment the
 *   two paths differ, the comparison stops measuring the recommendation and
 *   starts measuring the difference between the two code paths.
 *
 *   `scoreRecommendation` is therefore not given the recommendation AT ALL -
 *   only the SKU outcomes and the two windows. It cannot branch on the arm
 *   because nothing in it knows what the arm is. The arm is recorded, never
 *   consulted, and `tests/outcome-feedback-verify.js` asserts the signature
 *   rather than trusting the body.
 *
 * ONE DEFINITION OF LIFT
 *   `lib/lift.js`, shared with the dashboard, the chat and the eval service,
 *   and pinned to `app/pipeline/outcomes/lift.py` by a cross-language fixture.
 *   Two implementations of one metric is how a dead-stock count came out 454
 *   on one screen and 485 on another while the owner was told they matched.
 */

const { liftFor } = require('../lib/lift');
const logger = require('../utils/logger');

let tableExists = null;

async function outcomesTableExists(analyticsPool) {
  if (tableExists !== null) return tableExists;
  try {
    const { rows } = await analyticsPool.query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'recommendation_outcomes' LIMIT 1`
    );
    tableExists = rows.length > 0;
  } catch {
    tableExists = false;
  }
  return tableExists;
}

// Migration 035 - the quantity columns and the stockout grade. Probe-and-
// degrade like the table itself: an estate that has not applied 035 keeps
// recording the 020 shape rather than failing every outcome on an unknown
// column, and the figures it cannot store are simply not stored - never
// squeezed into a column that means something else.
let quantityColumnsExist = null;

async function outcomeQuantityColumnsExist(analyticsPool) {
  if (quantityColumnsExist !== null) return quantityColumnsExist;
  try {
    const { rows } = await analyticsPool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'recommendation_outcomes'
          AND column_name = 'sold_through_reason' LIMIT 1`
    );
    quantityColumnsExist = rows.length > 0;
  } catch {
    quantityColumnsExist = false;
  }
  return quantityColumnsExist;
}

/** Test seam: forget the probes so a migration inside one process is seen. */
function _resetProbe() {
  tableExists = null;
  quantityColumnsExist = null;
}

// The 035 columns, in INSERT order, with the outcome field each is read from.
// One list drives both the column list and the ON CONFLICT assignments, so a
// column cannot be inserted on first write and silently left stale on the
// re-score - which is the shape of bug the 28-column block below caught once
// already (snapshot_id).
const QUANTITY_COLUMNS = [
  'on_hand_at_issue', 'on_hand_at_window_end', 'on_hand_observed_on',
  'units_unsold', 'purchased_qty_source',
  'sold_through', 'days_to_sell_through', 'delivery_observed_on',
  'delivery_evidence', 'sold_through_reason',
];

/**
 * Score one recommendation. Arm-blind BY CONSTRUCTION, not by discipline.
 *
 * IT IS NOT GIVEN THE RECOMMENDATION AT ALL.
 *   The first version took `(rec, skuOutcomes, windows)` and simply did not
 *   read `rec`. That is a promise a future edit can break in one line, and the
 *   line would look harmless - "while we are here, treat the withheld arm's
 *   partial windows differently". The moment the two arms travel different
 *   code, the comparison stops measuring the recommendation and starts
 *   measuring the difference between the two paths.
 *
 *   So the parameter is gone. This function CANNOT branch on the arm, because
 *   nothing here knows what the arm is.
 *
 * @param {Array}  skuOutcomes [{ sku, baseline_units, actual_units }]
 * @param {object} windows    { baseline_open_days, window_open_days } OPEN days
 */
function scoreRecommendation(skuOutcomes, windows) {
  const result = liftFor(skuOutcomes, windows);
  return {
    lift: result.lift,
    lift_reason: result.reason,
    expected_units: result.expected,
    actual_units_sold: result.actual,
    upside_units: result.upside_units,
    measurable: result.measurable,
  };
}

/**
 * Record one outcome. Every column the sheet lists, including the versions.
 *
 * A row missing its versions can be counted but not explained, and an
 * unexplainable outcome cannot be used to move a threshold - which is the only
 * thing outcomes are for. So the versions are validated here rather than
 * discovered missing a quarter later.
 */
async function recordOutcome(analyticsPool, outcome) {
  if (!(await outcomesTableExists(analyticsPool))) {
    logger.warn('[Outcomes] recommendation_outcomes is missing; run the '
      + 'analytics migrations. Outcome not recorded.');
    return false;
  }
  if (outcome.arm !== 'shown' && outcome.arm !== 'withheld') {
    // Not a default, not a guess. A row that cannot say which arm it is on is
    // not an outcome, it is a sales figure.
    throw new Error(`[Outcomes] arm must be 'shown' or 'withheld', got `
      + `${JSON.stringify(outcome.arm)}`);
  }

  // The 035 quantities and the stockout grade ride on the probe. Every one
  // is written on insert AND refreshed on conflict: the window-end on-hand
  // and the grade genuinely change as the sparse on-hand capture fills in
  // behind a window, and a re-score that left them behind would pair this
  // night's sales with last week's shelf count.
  const withQuantities = await outcomeQuantityColumnsExist(analyticsPool);
  const extraCols = withQuantities ? QUANTITY_COLUMNS : [];
  const extraVals = extraCols.map((c) => outcome[c] ?? null);
  const extraColList = extraCols.map((c) => `, ${c}`).join('');
  const extraParams = extraCols.map((_, i) => `, $${29 + i}`).join('');
  const extraUpdates = extraCols.map((c) => `, ${c} = EXCLUDED.${c}`).join('');

  await analyticsPool.query(
    `INSERT INTO recommendation_outcomes (
       recommendation_id, client_id, location_id, sku, family, arm,
       recommended_qty, actual_purchased_qty, actual_units_sold,
       window_start, window_end, open_days_in_window,
       baseline_open_days, baseline_units,
       lift, lift_reason, expected_units, upside_units,
       stated_confidence, calibrated_confidence,
       evidence_state, own_weight, cohort_level, cohort_size,
       model_version, feature_version, config_version, snapshot_id
       ${extraColList},
       scored_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
       $19,$20,$21,$22,$23,$24,$25,$26,$27,$28
       ${extraParams}, now()
     )
     ON CONFLICT (recommendation_id, window_start, window_end) DO UPDATE SET
       -- Re-scoring the same window REPLACES rather than accumulating. Two
       -- rows for one window would each be counted as independent evidence by
       -- the gate, which is how 30 outcomes becomes 60 without 30 more facts.
       actual_purchased_qty = EXCLUDED.actual_purchased_qty,
       actual_units_sold = EXCLUDED.actual_units_sold,
       open_days_in_window = EXCLUDED.open_days_in_window,
       baseline_open_days = EXCLUDED.baseline_open_days,
       baseline_units = EXCLUDED.baseline_units,
       lift = EXCLUDED.lift,
       lift_reason = EXCLUDED.lift_reason,
       expected_units = EXCLUDED.expected_units,
       upside_units = EXCLUDED.upside_units,
       calibrated_confidence = EXCLUDED.calibrated_confidence,
       -- PROVENANCE HAS TO MOVE WITH THE FIGURES. snapshot_id names the data
       -- the numbers above were measured on; leaving it behind makes the row
       -- claim one snapshot's figures under another snapshot's id, which is
       -- worse than having no id at all. This was unreachable until the key
       -- stopped moving - every re-score used to be a fresh INSERT, so the id
       -- was always the right one by accident.
       snapshot_id = EXCLUDED.snapshot_id,
       -- Stable per card in practice, but refreshed for the same reason: an
       -- early row written before a field was populated should pick it up on
       -- the next scoring rather than stay null forever.
       recommended_qty = EXCLUDED.recommended_qty,
       stated_confidence = EXCLUDED.stated_confidence,
       model_version = EXCLUDED.model_version,
       feature_version = EXCLUDED.feature_version,
       config_version = EXCLUDED.config_version,
       -- The evidence behind the decision genuinely moves between scorings as
       -- outcomes accumulate, so a stale copy would misdate the weighting.
       evidence_state = EXCLUDED.evidence_state,
       own_weight = EXCLUDED.own_weight,
       cohort_level = EXCLUDED.cohort_level,
       cohort_size = EXCLUDED.cohort_size
       ${extraUpdates},
       scored_at = now()`,
    [
      outcome.recommendation_id, outcome.client_id, outcome.location_id,
      outcome.sku, outcome.family, outcome.arm,
      outcome.recommended_qty ?? null,
      outcome.actual_purchased_qty ?? null,
      outcome.actual_units_sold ?? null,
      outcome.window_start, outcome.window_end, outcome.open_days_in_window,
      outcome.baseline_open_days ?? null, outcome.baseline_units ?? null,
      outcome.lift ?? null, outcome.lift_reason ?? null,
      outcome.expected_units ?? null, outcome.upside_units ?? null,
      outcome.stated_confidence ?? null, outcome.calibrated_confidence ?? null,
      outcome.evidence_state ?? null, outcome.own_weight ?? null,
      outcome.cohort_level ?? null, outcome.cohort_size ?? null,
      outcome.model_version ?? null, outcome.feature_version ?? null,
      outcome.config_version ?? null, outcome.snapshot_id ?? null,
      ...extraVals,
    ]
  );
  return true;
}

/**
 * Everything the GATE needs for one store-family, in the shape it expects.
 *
 * This is the query sheet 17 was waiting on. It returns BOTH arms, because the
 * gate tests the shown arm and the withheld arm is what makes the comparison
 * credible.
 */
async function outcomesForGate(analyticsPool, { clientId, locationId, family, sinceDays = 120 }) {
  if (!(await outcomesTableExists(analyticsPool))) return [];
  const { rows } = await analyticsPool.query(
    `SELECT sku, family, arm, lift, own_weight, cohort_level, cohort_size
       FROM recommendation_outcomes
      WHERE client_id = $1 AND location_id = $2 AND family = $3
        AND lift IS NOT NULL
        AND window_end > now()::date - $4::int
      ORDER BY window_end DESC`,
    [clientId, locationId, family, sinceDays]
  );
  return rows.map((r) => ({
    sku: r.sku,
    family: r.family,
    lift: Number(r.lift),
    shown: r.arm === 'shown',
  }));
}

/**
 * The volume-matched null pool: SKUs at this store that got NO recommendation.
 *
 * The comparison sheet 17 makes is against products the engine did not speak
 * about - so this deliberately EXCLUDES anything with an outcome row, in
 * either arm. A withheld recommendation is not an un-recommended product: the
 * engine still chose it, and including it in the null would compare the engine
 * against its own choices.
 */
async function nullPoolForGate(analyticsPool, { clientId, locationId, sinceDays = 120 }) {
  if (!(await outcomesTableExists(analyticsPool))) return {};
  const { rows } = await analyticsPool.query(
    `WITH spoken_about AS (
       SELECT DISTINCT sku FROM recommendation_outcomes
        WHERE client_id = $1 AND location_id = $2
          AND window_end > now()::date - $3::int
     ),
     open_days AS (
       SELECT count(*)::numeric AS n FROM feature_store_day
        WHERE client_id = $1 AND location_id = $2
          AND obs_date > now()::date - $3::int
          AND was_open IS TRUE AND has_data IS TRUE
     )
     SELECT f.sku,
            SUM(f.units_sold)::numeric AS units,
            (SELECT n FROM open_days) AS open_days
       FROM feature_daily f
      WHERE f.client_id = $1 AND f.location_id = $2
        AND f.obs_date > now()::date - $3::int
        AND f.units_sold IS NOT NULL
        AND f.sku NOT IN (SELECT sku FROM spoken_about)
      GROUP BY f.sku
     HAVING SUM(f.units_sold) > 0`,
    [clientId, locationId, sinceDays]
  );
  return rows;
}

/**
 * Was this recommendation withheld?
 *
 * Reads the SAME key the persistence layer used, so the arm recorded in an
 * outcome is the arm the store actually experienced. Re-deriving it with a
 * different key here would be the two-implementations failure again, in the
 * one field the whole sheet turns on.
 */
const holdout = require('../lib/holdoutAssignment');

function armFor(rec, holdoutPct) {
  return holdout.isHoldout({
    clientId: rec.client_id,
    locationId: rec.location_id,
    sku: (Array.isArray(rec.primary_skus) ? rec.primary_skus : [])[0],
    family: rec.action_type || rec.family,
  }, holdoutPct) ? 'withheld' : 'shown';
}

module.exports = {
  _resetProbe,
  QUANTITY_COLUMNS,
  armFor,
  nullPoolForGate,
  outcomesForGate,
  outcomesTableExists,
  outcomeQuantityColumnsExist,
  recordOutcome,
  scoreRecommendation,
};
