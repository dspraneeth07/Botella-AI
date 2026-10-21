/**
 * Recommendation admission — a recommendation is shown only if it is valid
 * AND its profit claim is supportable.
 *
 * This is where sheets 00, 01 and 02 actually meet, and it is the answer to
 * "no more ambiguous recommendations". Three independent things must hold
 * before an owner sees a card:
 *
 *   1. THE STORE'S DATA IS USABLE            (sheet 02, store_quality_state)
 *      A rejected or quarantined batch produces no recommendation at all.
 *
 *   2. THE FIELDS THE CLAIM NEEDS ARE PRESENT (sheet 02, completeness)
 *      A markdown is a MARGIN claim. Margin needs cost. Cost is 0.00%
 *      available for gokul, square and mpower — 31 stores, 355k SKUs. For
 *      those stores a markdown cannot state a profit, so it is not shown.
 *      Previously it was shown anyway, computed against a cost of zero, which
 *      is how "liquidate this at 40% off" gets recommended for a product whose
 *      real margin is unknown.
 *
 *   3. THE NUMBER IS POSITIVE AND STATED      (this module)
 *      A profit-claiming action with no computable figure is withheld. Not
 *      shown with a blank — withheld, with a reason. "We think this helps" is
 *      the ambiguity being removed.
 *
 * WHAT IS NOT WITHHELD. A weather or event recommendation makes no margin
 * claim: "it will be 99°F on Saturday, move seltzer to the cold box" is
 * actionable without knowing unit cost. Silencing those for a store with thin
 * cost data would punish the store for its POS vendor's defect. Degraded
 * stores keep the advice that does not depend on the missing field.
 *
 * Every suppression is RECORDED (recommendation_admission), because a refusal
 * nobody can explain is just a different kind of unexplainable output.
 */

const logger = require('../utils/logger');
const { toNumber, toPositiveNumber } = require('../utils/numbers');
const { coerceBasis, floorApplies } = require('../lib/confidenceBasis');

// ─── What each action actually claims ────────────────────────────────────────
// `requires` lists the product fields the claim cannot be made without.
// `basis` says what kind of number it is, which decides how profit is computed.

const ACTION_CLAIMS = Object.freeze({
  // Margin claims. Recovering frozen capital or protecting margin - all of
  // them are statements about money the store keeps, and all need cost.
  markdown:  { basis: 'margin', requires: ['price', 'cost'] },
  liquidate: { basis: 'margin', requires: ['price', 'cost'] },
  bundle:    { basis: 'margin', requires: ['price', 'cost'] },

  // Availability claims: the value is the sale that would otherwise be lost.
  // Velocity and price carry that; cost only sharpens it.
  reorder:   { basis: 'avoided_stockout', requires: ['price'] },
  pre_stock: { basis: 'avoided_stockout', requires: ['price'] },
  stock_new: { basis: 'avoided_stockout', requires: [] },

  // Placement/attention claims. No margin assertion, so no cost needed - a
  // heat advisory is actionable whatever the POS sends.
  promote:   { basis: 'revenue', requires: ['price'] },
  endcap:    { basis: 'revenue', requires: ['price'] },
  cold_box:  { basis: 'revenue', requires: [] },
});

/** Actions whose whole point is a money figure. Withheld without one. */
const PROFIT_CLAIMING = Object.freeze(['markdown', 'liquidate', 'bundle']);

/**
 * Store verdicts that permit any recommendation at all.
 * 'unknown' is permissive on purpose: a store the gates have never examined
 * must not be silenced by the mere arrival of this feature. It is reported as
 * ungated rather than treated as refused.
 */
const ADMITTING_VERDICTS = Object.freeze(['pass', 'degraded', 'unknown']);

/**
 * Below this the model is guessing; the sheet-00 vocabulary calls it NEW.
 *
 * APPLIED ONLY TO A CALIBRATED FIGURE THAT DIFFERS BETWEEN CARDS - see
 * `admit()`, step 4. For months this floor filtered on `rec.confidence`
 * whatever that number was: the engine's raw p_hit (confined to about
 * 0.50-0.70, so the floor never bit), a signal family's n/(n+k) evidence
 * weight (which it did bite - a bundle seen in exactly k baskets states 0.50,
 * one seen in k/3 states 0.25), a constant base rate (admitting or refusing
 * the whole slate at once), or nothing recorded at all. QA measured the
 * result: 33 Tuscany cards gated on a raw score, 352 cards estate-wide gated
 * on an unlabelled one, and on the forward test higher stated confidence went
 * with LOWER hit rates. A floor on that number was deciding which cards reach
 * the screen on a figure that was never a probability. Now it applies to
 * `confidence_basis = 'isotonic'` and the skip is recorded on every other
 * card, so the expected-profit floor - a number with a unit - carries the
 * decision until the calibration measurement (audit/calibration/) says the
 * confidence figure has earned one.
 */
const MIN_CONFIDENCE = Number(process.env.REC_MIN_CONFIDENCE || '0.35');

/**
 * Staleness beyond which no recommendation is shown, as a MULTIPLE of the
 * store's own median sync interval. Not a fixed day count - a weekly store is
 * healthy at six days (sheet 02). Beyond this the data is too old to act on
 * whatever the cadence.
 */
const MAX_STALENESS_MULTIPLE = Number(process.env.REC_MAX_STALENESS_MULTIPLE || '6');
// A FLOOR UNDER THE ALLOWED STALENESS, in days. The multiple is relative to the
// store's own sync cadence, and a Korona store syncs about every fifteen
// minutes - median 0.01 days - so six times its cadence is ninety minutes, and
// at 04:00 every one of them was eight hours past its last evening sync and
// refused as "data_too_stale:0d>0d". That is not a stale feed; that is a shop
// that closed for the night. A feed less than a day old is current for a job
// that runs once a day, whatever its cadence, so the allowance is never below
// this. Measured on the estate at 2026-10-13: nine live Korona stores refused
// on exactly this, every one with staleness 0.33-0.34 days.
const MIN_STALENESS_DAYS = Number(process.env.REC_MIN_STALENESS_DAYS || '1');

/** Expected profit must clear this to be worth an owner's attention. */
const MIN_EXPECTED_PROFIT_USD = Number(process.env.REC_MIN_PROFIT_USD || '1');

/**
 * Must a profit-claiming recommendation carry a COMPUTABLE figure to be shown?
 *
 * `true` (the default, and the original behaviour) withholds a reorder whose
 * money cannot be worked out - usually because the POS sends no cost, which is
 * every line at 78 of the 94 trading stores. The reasoning was sound: a profit
 * claim with no number behind it is the "$2,470 projected sales" defect, and a
 * card that quietly shows a blank where a figure should be is worse than one
 * that is honestly absent.
 *
 * `false` shows the card ANYWAY, with `expected_profit_usd: null` - the advice
 * without the money claim. That is a different thing from showing a fabricated
 * figure, and it is the right answer when the store's own judgement about which
 * products to reorder is worth more than the dollar estimate we cannot make.
 *
 * WHAT THIS FLAG DOES NOT DO, AND WILL NOT: invent a number. A card with no
 * computable profit renders with no profit line. The floors below it
 * (REC_MIN_PROFIT_USD, REC_MIN_CONFIDENCE) can be set to 0 to stop hiding
 * cards for being small or uncertain; none of them can make a figure appear
 * that the data does not support.
 */
const REQUIRE_PROFIT_FIGURE = String(
  process.env.REC_REQUIRE_PROFIT_FIGURE ?? 'true'
).toLowerCase() !== 'false';

// ─── Profit estimation ───────────────────────────────────────────────────────

/**
 * Estimate what acting on this recommendation is worth, in dollars.
 *
 * Returns { amount, basis, inputs } or { amount: null, basis: 'none', missing }
 * when it cannot be computed. **Null is a real answer** and the caller must
 * treat it as "no figure", never as zero — the entire point of this module is
 * that an unstatable number is not a small number.
 *
 * @param {object} rec        the persisted recommendation
 * @param {object[]} products enriched product rows for its primary_skus
 * @param {string[]} unavailable fields the completeness gate withheld
 */
function estimateProfit(rec, products, unavailable = []) {
  const claim = ACTION_CLAIMS[rec.action_type] || { basis: 'revenue', requires: ['price'] };
  const missing = claim.requires.filter((f) => unavailable.includes(f));
  if (missing.length) {
    return { amount: null, basis: 'none', missing, claim: claim.basis };
  }

  // toNumber, not Number(): a SKU missing from the warehouse is enriched with
  // price: null, and Number(null) is 0 - so the obvious filter KEEPS it as a
  // product priced at zero. That produced a profit of 0 and then the wrong
  // refusal reason (profit_below_floor instead of no_profit_estimate).
  const usable = (products || []).filter((p) => p && toNumber(p.price) !== null);
  if (!usable.length) {
    return { amount: null, basis: 'none', missing: ['price'], claim: claim.basis };
  }

  // Units the action is about. suggested_order_qty is the canonical figure
  // from the demand engine where one exists; otherwise fall back to what is
  // on the shelf, which is what a markdown or liquidation actually moves.
  // A null order quantity must stay NULL, not become an explicit zero: markdowns
  // carry no suggested_order_qty by nature, and reading it as 0 made units 0
  // and silently suppressed the figure on every one of them.
  const qty = toNumber(rec.suggested_order_qty);

  // ── WHAT WILL ACTUALLY SELL, NOT WHAT IS ON THE SHELF ───────────────────
  //
  // This is the fix for the worst class of card this system produced.
  //
  // `qty ?? onHand` assumes every unit moves inside the horizon. On a live
  // Bethany card that turned 13 bottles of Bruichladdich Octomore - a product
  // that sold ZERO in 90 open days - into "$2,470 in projected sales over 30
  // days", on the same card whose own rationale said it sells about one every
  // twelve weeks. The card contradicted itself, and the number was simply the
  // shelf value relabelled.
  //
  // So units are now bounded by MEASURED demand over the horizon. `rates` is
  // units per OPEN day from featureStoreService - the one definition, the same
  // one sheet 03 exists to protect - and a SKU with no measured rate yields no
  // figure at all rather than a confident one.
  const HORIZON_DAYS = 30;
  const rates = rec._rates instanceof Map ? rec._rates : null;

  /**
   * Units this action can honestly claim for one product.
   *
   * REFUSES rather than guesses. A null here withholds the money figure,
   * which is the correct outcome for a product nobody can forecast: sheet 02
   * already withholds a margin without cost, and this is the same rule for
   * the quantity the margin is multiplied by.
   */
  const sellableUnits = (product) => {
    const onHand = toNumber(product.on_hand ?? product.stock_qty);
    if (!rates) return qty ?? onHand;           // pre-migration callers
    const rate = rates.get(product.sku);
    const perOpenDay = rate ? toNumber(rate.per_open_day) : null;
    if (perOpenDay === null) return null;       // never measured - no claim

    // Open days, not calendar days. Bethany closes 200 days of 1,360, so a
    // calendar horizon overstates what any of its SKUs can sell.
    const openRatio = rate.open_days && rate.open_days > 0
      ? Math.min(1, rate.open_days / HORIZON_DAYS) : 1;
    const demand = perOpenDay * HORIZON_DAYS * openRatio;

    // Bounded by what there is to sell. A reorder can sell what arrives; a
    // markdown can only move what is already there.
    const available = qty !== null ? (qty + (onHand ?? 0)) : (onHand ?? 0);
    return Math.max(0, Math.min(demand, available));
  };

  let amount = 0;
  const inputs = [];

  for (const product of usable) {
    const price = toNumber(product.price);
    // Positive-only: a cost of 0.00 is a cost we do not have, and treating it
    // as free is how a 100% margin gets recommended.
    const cost = toPositiveNumber(product.cost);
    // `on_hand` is what the enrichment in recommendationService actually
    // emits; `stock_qty` is the warehouse column name and is accepted so a
    // caller passing raw product rows works too.
    const onHand = toNumber(product.on_hand ?? product.stock_qty);

    if (claim.basis === 'margin') {
      // Cost of zero is NOT a free product - it is an unknown cost, and the
      // completeness gate should already have withheld the field. Belt and
      // braces: refuse to invent a 100% margin here too.
      if (cost === null) {
        return { amount: null, basis: 'none', missing: ['cost'], claim: claim.basis };
      }
      const units = sellableUnits(product);
      if (units === null) {
        return { amount: null, basis: 'none', missing: ['demand_rate'],
          claim: claim.basis };
      }
      amount += Math.max(0, price - cost) * units;
      inputs.push({ sku: product.sku, price, cost, units, horizon_days: HORIZON_DAYS });
    } else {
      // Revenue-shaped claims. Deliberately conservative: the value is the
      // margin where cost is known, and only the gross price where it is not,
      // never an invented margin percentage.
      const units = sellableUnits(product);
      if (units === null) {
        return { amount: null, basis: 'none', missing: ['demand_rate'],
          claim: claim.basis };
      }
      const per = cost === null ? price : Math.max(0, price - cost);
      amount += per * units;
      inputs.push({ sku: product.sku, price, cost, units, per_unit: per,
        horizon_days: HORIZON_DAYS });
    }
  }

  if (!inputs.some((i) => i.units > 0)) {
    // Every SKU had zero or unknown units: there is nothing to multiply, so
    // there is no figure. Say that rather than reporting $0.
    return { amount: null, basis: 'none', missing: ['units'], claim: claim.basis };
  }

  return { amount: Math.round(amount * 100) / 100, basis: claim.basis, inputs };
}

// ─── Admission ───────────────────────────────────────────────────────────────

/**
 * The STORE-level refusals, independent of any one recommendation.
 *
 * Split out of `admit()` so the 04:00 generation batch (server.js) can ask the
 * same question BEFORE it builds a slate: a store whose feed has stalled must
 * not produce a buy signal in the first place, and the read-path refusal in
 * `admit()` was the only place this rule lived. Two spellings of "is this
 * store's data usable" is how a stalled store gets generated at 04:00 and
 * withheld at 09:00 - correct in the end, but it spent an hour of compute on
 * cards nobody may see, and a reader of `recommendation_runs` sees a run that
 * looks healthy.
 *
 * Returns the reasons in refusal order, empty when the store is admitted.
 * 'unknown' (no row, or a failed lookup) is ADMITTED on purpose - see
 * ADMITTING_VERDICTS. This is the one fail-open in the gate, and it exists so
 * that the arrival of the quality job cannot silence an estate it has not yet
 * examined; the job itself (run-quality.js) is what closes it, store by store.
 *
 * `data_too_stale` is the stalled-feed refusal. It needs BOTH numbers, which
 * is why `run-quality.js` writes `median_interval_days` as well as
 * `staleness_days` - for months nothing wrote either, and a feed three weeks
 * dark read as `degraded`, which admits.
 */
function storeRefusals(quality) {
  const reasons = [];
  const verdict = quality?.verdict || 'unknown';

  // 1. The store's data.
  if (!ADMITTING_VERDICTS.includes(verdict)) {
    reasons.push(`store_quality:${verdict}`);
  }
  if (quality?.never_synced) reasons.push('store_never_synced');

  // 2. Staleness, relative to the store's own cadence.
  // toNumber so a null staleness (never synced) does not read as "0 days old".
  const staleness = toNumber(quality?.staleness_days);
  const median = toNumber(quality?.median_interval_days);
  if (staleness !== null && median !== null && median > 0) {
    const allowed = Math.max(median * MAX_STALENESS_MULTIPLE, MIN_STALENESS_DAYS);
    if (staleness > allowed) {
      reasons.push(`data_too_stale:${Math.round(staleness)}d>${Math.round(allowed)}d`);
    }
  }
  return reasons;
}

/**
 * Decide whether one recommendation may be shown.
 *
 * @returns {{visible, reasons, explanation, expected_profit_usd, profit_basis}}
 */
function admit(rec, { quality = null, products = [], requireProfit = true } = {}) {
  const unavailable = quality?.unavailable_fields || [];

  // 1-2. The store's data and its staleness - the same rule the generation
  // batch applies, from the same function.
  const reasons = storeRefusals(quality);

  // 3. The fields this particular claim needs.
  const claim = ACTION_CLAIMS[rec.action_type] || { basis: 'revenue', requires: ['price'] };
  for (const needed of claim.requires) {
    if (unavailable.includes(needed)) reasons.push(`missing_field:${needed}`);
  }

  // 4. Evidence. A low-confidence rec with nothing cited is a guess - IF the
  // figure is a probability. The floor applies only when `confidence_basis`
  // says the number is a calibrated curve's output that differs between
  // cards ('isotonic'). On every other basis - the raw ranking score, a
  // constant, a flat slate, an evidence count, a model's guess, nothing
  // recorded - the floor is skipped, the skip is RECORDED as a note (shown,
  // not withheld; a reason would hide the card), and the card rests on the
  // expected-profit floor below. A missing or unknown basis reads as
  // 'not_recorded', the same word the persist path writes: the gate must not
  // be more generous to a card than the row that stores it.
  const notes = [];
  const confidence = toNumber(rec.confidence);
  const { basis } = coerceBasis(rec.confidence_basis);
  if (confidence !== null && floorApplies(basis)) {
    if (confidence < MIN_CONFIDENCE) {
      reasons.push(`low_confidence:${confidence.toFixed(2)}<${MIN_CONFIDENCE}`);
    }
  } else if (confidence !== null) {
    notes.push(`confidence_floor_not_applicable:${basis}`);
  }

  // 5. The number itself.
  const profit = estimateProfit(rec, products, unavailable);
  const isProfitClaim = PROFIT_CLAIMING.includes(rec.action_type);
  if (requireProfit && isProfitClaim) {
    if (profit.amount === null) {
      // Absent figure. Withholding is opt-out: see REQUIRE_PROFIT_FIGURE.
      // When shown anyway the card carries expected_profit_usd = null, so the
      // interface omits the money line rather than printing a zero that reads
      // as a measurement.
      if (REQUIRE_PROFIT_FIGURE) {
        reasons.push(`no_profit_estimate:${(profit.missing || []).join(',') || 'unknown'}`);
      }
    } else if (profit.amount < MIN_EXPECTED_PROFIT_USD) {
      reasons.push(`profit_below_floor:${profit.amount}<${MIN_EXPECTED_PROFIT_USD}`);
    }
  }

  const visible = reasons.length === 0;
  return {
    visible,
    reasons,
    // Decisions that did NOT refuse the card (migration 041). Separate from
    // `reasons` because a reason withholds and these do not.
    notes,
    explanation: visible ? null : explain(reasons, rec, quality),
    expected_profit_usd: profit.amount,
    profit_basis: profit.basis,
    profit_inputs: profit.inputs || null,
  };
}

/** The sentence an owner would accept as an explanation. */
function explain(reasons, rec, quality) {
  const first = reasons[0] || '';
  const connector = quality?.connector ? ` (${quality.connector})` : '';

  if (first.startsWith('store_quality:reject')) {
    return 'Your latest data did not pass its quality checks, so we are not '
      + 'making recommendations from it today rather than guessing.';
  }
  if (first.startsWith('store_quality:quarantine')) {
    return 'Your latest sync looked abnormal and is being reviewed before we '
      + 'use it. No recommendations from that batch.';
  }
  if (first === 'store_never_synced') {
    return 'We have not yet received a successful sync from this store.';
  }
  if (first.startsWith('data_too_stale')) {
    return 'Your data is well past this store\'s normal sync interval, so any '
      + 'advice from it would be out of date.';
  }
  if (first.startsWith('missing_field:cost')) {
    return `A margin figure cannot be calculated because your POS${connector} is not `
      + 'sending unit cost, so we are withholding this rather than guessing at the profit.';
  }
  if (first.startsWith('missing_field:')) {
    return `Your POS${connector} is not sending ${first.split(':')[1]}, which this `
      + 'recommendation depends on.';
  }
  if (first.startsWith('no_profit_estimate')) {
    return 'We could not put a dollar figure on this, and a profit claim without '
      + 'a number is not worth your time.';
  }
  if (first.startsWith('profit_below_floor')) {
    return 'The expected gain is too small to be worth acting on.';
  }
  if (first.startsWith('low_confidence')) {
    return 'The evidence behind this was too thin to be worth showing.';
  }
  return `Withheld: ${reasons.join(', ')}`;
}

// ─── Reading and writing state ───────────────────────────────────────────────

/**
 * The store's latest quality verdict. Never throws: a missing quality table or
 * an unexamined store degrades to `unknown`, which ADMITS. Introducing a gate
 * must not silence the whole estate on the day it ships.
 */
async function getStoreQuality(analyticsPool, clientId, locationId) {
  try {
    const { rows } = await analyticsPool.query(
      `SELECT connector, verdict, unavailable_fields, staleness_days,
              median_interval_days, never_synced, reasons, checked_at
         FROM store_quality_state
        WHERE client_id = $1 AND location_id = $2`,
      [clientId, locationId]
    );
    if (!rows.length) {
      return { verdict: 'unknown', unavailable_fields: [], never_synced: false, ungated: true };
    }
    const row = rows[0];
    return {
      ...row,
      unavailable_fields: row.unavailable_fields || [],
      staleness_days: row.staleness_days === null ? null : Number(row.staleness_days),
      median_interval_days:
        row.median_interval_days === null ? null : Number(row.median_interval_days),
      ungated: false,
    };
  } catch (err) {
    logger.warn(`[RecGate] quality lookup failed for ${clientId}:${locationId}: ${err.message}`);
    return { verdict: 'unknown', unavailable_fields: [], never_synced: false, ungated: true };
  }
}

/**
 * Does `recommendation_admission.notes` exist (migration 041)? Probed once per
 * process and remembered, like the other probe-and-degrade columns: an estate
 * that has not applied 041 keeps its admission audit, minus the notes.
 */
let notesColumnKnown = null;
async function notesColumnExists(analyticsPool) {
  if (notesColumnKnown !== null) return notesColumnKnown;
  notesColumnKnown = await analyticsPool
    .query(`SELECT 1 FROM information_schema.columns
             WHERE table_name = 'recommendation_admission'
               AND column_name = 'notes' LIMIT 1`)
    .then((r) => r.rowCount > 0)
    .catch(() => false);
  return notesColumnKnown;
}

/** Persist the decisions. Best-effort: an audit failure must not hide a rec. */
async function recordAdmissions(analyticsPool, clientId, locationId, recDate, decisions) {
  try {
    const withNotes = await notesColumnExists(analyticsPool);
    for (const { rec, decision } of decisions) {
      if (!rec.id) continue;
      const params = [rec.id, clientId, locationId, recDate || null, decision.visible,
        decision.reasons, decision.explanation, decision.expected_profit_usd,
        decision.profit_basis];
      if (withNotes) params.push(decision.notes || []);
      await analyticsPool.query(
        `INSERT INTO recommendation_admission
           (rec_id, client_id, location_id, rec_date, visible, reasons,
            explanation, expected_profit_usd, profit_basis${withNotes ? ', notes' : ''}, decided_at)
         VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9${withNotes ? ',$10' : ''}, now())
         ON CONFLICT (rec_id) DO UPDATE SET
           visible=EXCLUDED.visible, reasons=EXCLUDED.reasons,
           explanation=EXCLUDED.explanation,
           expected_profit_usd=EXCLUDED.expected_profit_usd,
           profit_basis=EXCLUDED.profit_basis,${withNotes ? ' notes=EXCLUDED.notes,' : ''} decided_at=now()`,
        params
      );
    }
  } catch (err) {
    logger.warn(`[RecGate] admission audit failed for ${clientId}:${locationId}: ${err.message}`);
  }
}

/**
 * Apply admission to a run's recommendations.
 *
 * Returns { visible, withheld, quality }. Withheld recs are NOT discarded —
 * they are returned separately with their reasons, so the UI can say "3
 * suggestions were withheld because your POS is not sending cost" instead of
 * quietly showing a shorter list.
 *
 * @param {Array} recs  enriched recommendations (each may carry `products`)
 */
/**
 * @param {object} opts.rates  sku -> { per_open_day, open_days } from
 *   featureStoreService.ratesBySku. THE one definition of a rate. Optional:
 *   without it the profit figure falls back to shelf-based units, which is
 *   what produced "$2,470 projected sales" for a product that sold nothing.
 *   Callers that can supply it should.
 */
function applyAdmission(recs, quality, { requireProfit = true, rates = null } = {}) {
  const visible = [];
  const withheld = [];
  const decisions = [];

  for (const rec of recs || []) {
    const products = rec.products || rec.product_details || [];
    // Carried on the rec rather than threaded through `admit`'s signature so
    // the many existing callers of `admit` keep working unchanged.
    const decision = admit({ ...rec, _rates: rates }, { quality, products, requireProfit });
    decisions.push({ rec, decision });

    if (decision.visible) {
      visible.push({
        ...rec,
        expected_profit_usd: decision.expected_profit_usd,
        profit_basis: decision.profit_basis,
        // What the gate chose NOT to apply, on the card, so a reader of the
        // API response can see that this card was not confidence-gated and
        // why. Empty when every floor applied.
        admission_notes: decision.notes || [],
        // Staleness rides along on every shown recommendation (sheet 02):
        // the owner sees what the advice is based on, not just the advice.
        data_as_of_days_ago: quality?.staleness_days ?? null,
      });
    } else {
      withheld.push({
        rank: rec.rank, id: rec.id, action_type: rec.action_type,
        reasons: decision.reasons, explanation: decision.explanation,
      });
    }
  }
  return { visible, withheld, decisions, quality };
}

module.exports = {
  ACTION_CLAIMS,
  ADMITTING_VERDICTS,
  MAX_STALENESS_MULTIPLE,
  MIN_STALENESS_DAYS,
  MIN_CONFIDENCE,
  MIN_EXPECTED_PROFIT_USD,
  PROFIT_CLAIMING,
  admit,
  applyAdmission,
  estimateProfit,
  getStoreQuality,
  recordAdmissions,
  storeRefusals,
  _internals: { explain },
};
