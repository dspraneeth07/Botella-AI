'use strict';

/**
 * Sheet 17 — reading and enforcing the per-(store, family) display gate.
 *
 * WHAT THIS FILE IS NOT
 *   It is not the gate's statistics. The randomisation test, the volume
 *   matching, the state transitions and the cohort inheritance all live in
 *   `app/pipeline/gate/` on the Python side, where the registry Settings and
 *   the build guards are. This file stores the verdict and enforces it.
 *
 *   That split is deliberate and is the same one sheet 03 uses. A second
 *   implementation of the transition rule in JavaScript would drift from the
 *   first, and the estate would have two answers to "is this family live" -
 *   which is exactly the 454-vs-485 failure this programme exists to remove.
 *
 * FAIL CLOSED, AND SAY SO
 *   A store-family with no row is in SHADOW. Not live. A gate that fails open
 *   when its table is empty is not a gate - and the empty-table case is
 *   precisely the state every store starts in, so failing open would mean the
 *   gate never did anything at all.
 *
 * DEGRADE, BUT ONLY WHERE IT IS SAFE
 *   If the table does not exist yet (a deploy ahead of its migration), the
 *   gate reports itself UNAVAILABLE rather than guessing. The caller decides:
 *   `REC_GATE_ENFORCED=false` serves everything and logs loudly, which is the
 *   right behaviour while the gate is still accumulating its first quarter of
 *   outcomes and nothing is live yet.
 */

const logger = require('../utils/logger');

const STATES = Object.freeze(['shadow', 'live', 'suspended']);

/**
 * Enforcement switch.
 *
 * OFF BY DEFAULT, ON PURPOSE. The gate needs roughly a quarter of accumulated
 * outcomes before any family can go live. Enforcing on day one would show
 * every store nothing at all, which is not a cautious rollout - it is an
 * outage. So the sequence is:
 *
 *   1. holdout ON (done - it is what generates the evidence)
 *   2. gate COMPUTED and visible in the table, enforcement off
 *   3. enforcement ON once families start going live
 *
 * Step 2 is where this ships. Flip REC_GATE_ENFORCED=true to reach step 3.
 */
const ENFORCED = String(process.env.REC_GATE_ENFORCED || 'false').toLowerCase() === 'true';

let tableExists = null; // null = not probed yet

async function gateTableExists(analyticsPool) {
  if (tableExists !== null) return tableExists;
  try {
    const { rows } = await analyticsPool.query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'recommendation_family_gate' LIMIT 1`
    );
    tableExists = rows.length > 0;
  } catch {
    tableExists = false;
  }
  return tableExists;
}

/** Test seam: forget the probe so a migration inside one process is seen. */
function _resetProbe() {
  tableExists = null;
}

/**
 * Every family's state for one store.
 *
 * @returns {Promise<{available: boolean, states: Map<string,object>}>}
 *   `available: false` means the table is not there - NOT that everything is
 *   in shadow. The two must not look alike to the caller.
 */
async function statesForStore(analyticsPool, clientId, locationId) {
  if (!(await gateTableExists(analyticsPool))) {
    return { available: false, states: new Map() };
  }
  const { rows } = await analyticsPool.query(
    `SELECT family, state, reason, inherited, n_outcomes,
            p_value, observed, null_mean, previous_state
       FROM recommendation_family_gate
      WHERE client_id = $1 AND location_id = $2`,
    [clientId, locationId]
  );
  const states = new Map();
  for (const row of rows) states.set(row.family, row);
  return { available: true, states };
}

/**
 * May this store see this family?
 *
 * A missing row is SHADOW - see "fail closed" above. An unknown state value is
 * also shadow: the CHECK constraint should make that impossible, and if it
 * ever is not, the safe reading of a state nobody recognises is "not proven".
 */
function isDisplayable(stateRow) {
  if (!stateRow) return false;
  if (!STATES.includes(stateRow.state)) return false;
  return stateRow.state === 'live';
}

/**
 * Split a store's recommendations into what it sees and what it does not.
 *
 * Withheld recs are RETURNED, with their reason, rather than silently dropped.
 * Nothing in this programme disappears without saying why - the same rule
 * sheet 02's admission gate follows, and the reason a store owner can ask
 * "why am I not seeing markdowns" and get an answer.
 */
function applyGate(recommendations, gateStates, { enforced = ENFORCED } = {}) {
  const shown = [];
  const withheld = [];

  for (const rec of recommendations) {
    const family = rec.action_type || rec.family || '';
    const row = gateStates.get(family);
    const displayable = isDisplayable(row);

    if (displayable || !enforced) {
      shown.push(
        enforced ? rec : { ...rec, gate_state: row ? row.state : 'shadow' }
      );
      continue;
    }
    withheld.push({
      ...rec,
      gate_state: row ? row.state : 'shadow',
      gate_reason: row ? row.reason : 'no_gate_row_yet',
      // An owner-readable line. The state names are ours; this is not.
      gate_explanation: row && row.state === 'suspended'
        ? 'This kind of recommendation stopped outperforming a like-for-like '
          + 'comparison at your store, so it is paused while we re-measure.'
        : 'This kind of recommendation is still being measured at your store '
          + 'and is not shown until it has been shown to help.',
    });
  }
  return { shown, withheld, enforced };
}

/**
 * Persist one verdict, exactly as Python computed it.
 *
 * `previous_state` and `state_changed_at` are only touched when the state
 * ACTUALLY changes - re-running the gate on an unchanged family must not make
 * it look like it transitioned today, or "which families changed state" stops
 * being a usable report.
 */
async function recordVerdict(analyticsPool, verdict) {
  if (!(await gateTableExists(analyticsPool))) {
    logger.warn('[FamilyGate] recommendation_family_gate is missing; '
      + 'run the analytics migrations. Verdict not recorded.');
    return false;
  }
  if (!STATES.includes(verdict.state)) {
    throw new Error(`[FamilyGate] unknown state ${JSON.stringify(verdict.state)}`);
  }
  const evidence = verdict.evidence || {};
  await analyticsPool.query(
    `INSERT INTO recommendation_family_gate
       (client_id, location_id, family, state, reason, inherited, n_outcomes,
        p_value, observed, null_mean, previous_state, state_changed_at,
        evaluated_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
             CASE WHEN $11::text IS DISTINCT FROM $4::text THEN $11::text END,
             CASE WHEN $11::text IS DISTINCT FROM $4::text THEN now() END,
             now(), now())
     ON CONFLICT (client_id, location_id, family) DO UPDATE SET
       state = EXCLUDED.state,
       reason = EXCLUDED.reason,
       inherited = EXCLUDED.inherited,
       n_outcomes = EXCLUDED.n_outcomes,
       p_value = EXCLUDED.p_value,
       observed = EXCLUDED.observed,
       null_mean = EXCLUDED.null_mean,
       -- Only on a REAL transition. An unchanged family keeps whatever it
       -- previously transitioned from, and the date it did so.
       previous_state = CASE
         WHEN recommendation_family_gate.state IS DISTINCT FROM EXCLUDED.state
         THEN recommendation_family_gate.state
         ELSE recommendation_family_gate.previous_state END,
       state_changed_at = CASE
         WHEN recommendation_family_gate.state IS DISTINCT FROM EXCLUDED.state
         THEN now()
         ELSE recommendation_family_gate.state_changed_at END,
       evaluated_at = now(),
       updated_at = now()`,
    [
      verdict.client_id, verdict.location_id, verdict.family,
      verdict.state, verdict.reason, Boolean(verdict.inherited),
      verdict.n_outcomes || 0,
      evidence.p_value ?? null,
      evidence.observed ?? null,
      evidence.null_mean ?? null,
      verdict.previous ?? null,
    ]
  );
  return true;
}

/** Families that changed state recently — the report `suspended` exists for. */
async function recentTransitions(analyticsPool, { days = 7, limit = 50 } = {}) {
  if (!(await gateTableExists(analyticsPool))) return [];
  const { rows } = await analyticsPool.query(
    `SELECT client_id, location_id, family, previous_state, state, reason,
            n_outcomes, p_value,
            to_char(state_changed_at, 'YYYY-MM-DD') AS changed_on
       FROM recommendation_family_gate
      WHERE state_changed_at IS NOT NULL
        AND state_changed_at > now() - ($1::int * interval '1 day')
      ORDER BY state_changed_at DESC
      LIMIT $2`,
    [days, limit]
  );
  return rows;
}

module.exports = {
  ENFORCED,
  STATES,
  _resetProbe,
  applyGate,
  gateTableExists,
  isDisplayable,
  recentTransitions,
  recordVerdict,
  statesForStore,
};
