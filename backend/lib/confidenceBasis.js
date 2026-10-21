/**
 * What a card's `confidence` figure IS - the closed vocabulary, mirrored.
 *
 * The one list lives in Botella_External_APIs/app/schemas/recommendation.py
 * (`CONFIDENCE_BASES`), where the response model requires a member of it on
 * every card. This is the Node copy, for the two places that must read it
 * without an HTTP call: the persist path, which refuses to store a word the
 * vocabulary does not have, and the admission gate, which must know whether
 * the figure it is about to filter on is a probability at all.
 *
 * KEPT IN STEP BY HAND AND BY A TEST. tests/confidence-basis-verify.js reads
 * the Python tuple out of the schema file and asserts the two lists are equal,
 * so the next name added on one side fails the suite on the other.
 *
 * WHY THE DISTINCTION MATTERS HERE. The reviewer measured it: 352 cards with
 * no basis, 33 with the raw ranking score passed through, every isotonic card
 * on the same 0.444, and on the forward test higher stated confidence went
 * with LOWER hit rates. REC_MIN_CONFIDENCE filtered on all of them as one
 * number. A floor is defensible on exactly one of these bases - a fitted curve
 * with more than one level whose slate shows more than one value - and on the
 * rest it is deciding which cards reach the screen on a figure that was never
 * a probability.
 */

'use strict';

/** Every basis a card may carry. Order matches the Python tuple. */
const CONFIDENCE_BASES = Object.freeze([
  // The deterministic engine's p_hit, uncalibrated. An ordering signal
  // confined to about [0.50, 0.70]; also what a card gets when a curve exists
  // but has no fit for its cell.
  'raw_ranking_score',
  // A fitted curve with more than one level, on a slate that shows more than
  // one value. The ONLY basis a confidence floor applies to.
  'isotonic',
  // A fitted curve with one level: the store's base rate on every card.
  'isotonic_constant',
  // The curve had levels; every card in this slate landed on one of them.
  'isotonic_flat_slate',
  'isotonic_constant_flat_slate',
  // families.confidence_from_evidence: n / (n + k) over the family's evidence.
  'family_evidence_count',
  // The model wrote the number (the superseded generator path).
  'llm_stated',
  // Nothing upstream said. Backfilled onto every pre-vocabulary row by
  // migration 040 and written by the persist path for any card that arrives
  // without one.
  'not_recorded',
]);

/** The bases on which the figure is a calibrated probability that differs
 *  between cards. `admit()` applies REC_MIN_CONFIDENCE to these and to nothing
 *  else. */
const DISCRIMINATING_CALIBRATED_BASES = Object.freeze(['isotonic']);

const NOT_RECORDED = 'not_recorded';

const KNOWN = new Set(CONFIDENCE_BASES);

/** Is `basis` a word the vocabulary has? */
function isKnownBasis(basis) {
  return typeof basis === 'string' && KNOWN.has(basis);
}

/** Does a confidence floor mean anything on a card with this basis? */
function floorApplies(basis) {
  return typeof basis === 'string' && DISCRIMINATING_CALIBRATED_BASES.includes(basis);
}

/**
 * The basis to PERSIST for a card payload: the card's own when it is a known
 * word, `not_recorded` otherwise - with the reason, so the caller can log it.
 *
 * LABELLED, NOT DROPPED. The alternative was to refuse the card. A card is
 * advice the store can act on; the basis is a label on one of its numbers.
 * Dropping the advice because the label is missing hides a card for a
 * bookkeeping defect, and does it silently from the owner's point of view -
 * the slate is simply shorter. Writing `not_recorded` keeps the card and makes
 * the defect visible on the row, where the next query for it finds it. The
 * caller logs each one with the card's identity and counts them per run.
 *
 * @returns {{ basis: string, reason: string | null }}  reason is null when the
 *   card's own basis was kept; 'missing' or 'unknown:<value>' otherwise.
 */
function coerceBasis(basis) {
  if (basis === undefined || basis === null || basis === '') {
    return { basis: NOT_RECORDED, reason: 'missing' };
  }
  if (!isKnownBasis(basis)) {
    return { basis: NOT_RECORDED, reason: `unknown:${String(basis).slice(0, 60)}` };
  }
  return { basis, reason: null };
}

module.exports = {
  CONFIDENCE_BASES,
  DISCRIMINATING_CALIBRATED_BASES,
  NOT_RECORDED,
  coerceBasis,
  floorApplies,
  isKnownBasis,
};
