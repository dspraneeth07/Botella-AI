'use strict';

/**
 * Which arm a recommendation belongs to, and why the key matters more than
 * the percentage.
 *
 * THE BUG THIS REPLACES
 *   Assignment was:
 *
 *       ((runId * 31 + r.rank) % 100) < holdoutPct
 *
 *   `runId` is a fresh serial on every run and `rank` moves as the ranking
 *   moves, so the SAME store-SKU landed in a different arm almost every day.
 *   Measured over 100 consecutive runs, rank 1 changed arm 39 times.
 *
 *   That is not a small inaccuracy. A holdout measures what happens when a
 *   store is NOT told something; if the same product is withheld on Monday,
 *   shown on Tuesday and withheld again on Wednesday, no outcome can be
 *   attributed to either arm. Switching the holdout on in that state would
 *   have accumulated a quarter of noise and then reported that the engine
 *   does not work - which is the exact mistake the 23% backtest already made
 *   once, for a different reason.
 *
 * THE KEY IS THE THING BEING MEASURED
 *   A holdout arm has to be stable for as long as the question is open, and
 *   the question is "does recommending THIS PRODUCT to THIS STORE change
 *   anything". So the key is exactly that:
 *
 *       client_id : location_id : sku : family
 *
 *   No run id (it changes every run). No rank (it changes with the ranking).
 *   No date (the arm would flip daily by construction). Nothing that moves
 *   while the question is still open.
 *
 *   Family is included because the gate in sheet 17 is per store AND per
 *   family: a store can be live for reorder and still in shadow for markdown,
 *   and the arms have to be independent for that to mean anything.
 *
 * WHY A REAL HASH AND NOT `* 31`
 *   `(runId * 31 + rank) % 100` is an arithmetic progression, not a hash.
 *   Consecutive ids land in a fixed stride of 31 buckets, so the assignment
 *   is structured rather than random and correlates with whatever else
 *   correlates with id order - for us, the order stores were onboarded.
 *   FNV-1a over the key string has no such structure.
 *
 * DETERMINISTIC, AND THAT IS THE POINT
 *   No randomness, no clock, no stored assignment table. The same key always
 *   yields the same bucket, on any machine, months later - so a re-run
 *   reproduces the arms exactly, and an outcome can be attributed years after
 *   the run that produced it.
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const BUCKETS = 100;

/**
 * FNV-1a, 32-bit. Small, fast, dependency-free and well-distributed over
 * short ASCII keys, which is all this needs. Not a cryptographic hash and
 * does not need to be - nothing here resists an adversary, it only has to
 * avoid the structure that `* 31` had.
 */
function fnv1a(text) {
  let hash = FNV_OFFSET;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // `Math.imul` keeps the multiply in 32-bit space. A plain `*` would
    // silently promote to a double past 2^53 and lose the low bits that
    // carry the entropy.
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/**
 * The stable assignment key for one recommendation.
 *
 * `sku` is the FIRST primary SKU. A recommendation about several products is
 * keyed on the one it leads with, because that is the product whose outcome
 * the evaluation measures. Keying on the whole list would make the arm change
 * whenever the secondary products did.
 */
function assignmentKey({ clientId, locationId, sku, family }) {
  return `${clientId}:${locationId}:${String(sku || '').trim()}:${String(family || '').trim()}`;
}

/** 0..99, stable for the life of the key. */
function bucketFor(key) {
  return fnv1a(key) % BUCKETS;
}

/**
 * Is this recommendation withheld?
 *
 * Withheld does NOT mean discarded: it is computed, stored and scored exactly
 * like a shown one, and only excluded from what the owner sees. That is what
 * makes it a measurement rather than a saving.
 */
function isHoldout({ clientId, locationId, sku, family }, holdoutPct) {
  if (!holdoutPct || holdoutPct <= 0) return false;
  const key = assignmentKey({ clientId, locationId, sku, family });
  return bucketFor(key) < holdoutPct;
}

module.exports = {
  BUCKETS,
  assignmentKey,
  bucketFor,
  fnv1a,
  isHoldout,
};
