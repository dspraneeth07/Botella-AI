/**
 * Numeric coercion that keeps UNKNOWN distinct from ZERO.
 *
 * WHY THIS EXISTS
 *   `Number.isFinite(Number(x)) ? Number(x) : null` looks obviously correct
 *   and is wrong for the four values that matter most when reading a database
 *   row or a JSON payload:
 *
 *     Number(null)  === 0      Number('')    === 0
 *     Number([])    === 0      Number(false) === 0
 *
 *   So an ABSENT value becomes a confident zero. That bug shipped four times
 *   across this rebuild before anything caught it:
 *
 *     • a null `suggested_order_qty` read as an explicit 0, making units 0 and
 *       suppressing the profit figure on every markdown;
 *     • `engine.input_tokens` absent stored as "0 tokens used" rather than
 *       "unknown";
 *     • `engine.cost_usd` absent stored as "$0.00" rather than "unknown";
 *     • a product with a NULL price counted as a usable product priced at 0,
 *       which produced a profit of 0 and then the WRONG refusal reason
 *       (profit_below_floor instead of no_profit_estimate).
 *
 *   Every one of those is the same mistake the whole rebuild is about:
 *   **a zero that means "we do not know" is a lie with a decimal point on it.**
 *   A cost of 0.00 yields a 100% margin. A staleness of 0 reads as fresh. A
 *   token count of 0 reads as a free run.
 *
 *   Four occurrences is enough. The primitive lives here, once, and is tested.
 *
 * THE RULE
 *   Absent in → null out. Only a value that is genuinely, finitely numeric
 *   comes back as a number.
 */

'use strict';

/**
 * A finite number, or null when the value is absent or not numeric.
 *
 * Rejected before coercion, because `Number()` maps all of them to 0:
 *   null · undefined · '' (and whitespace) · [] · true/false
 *
 * Accepted: numbers, and numeric strings ('7', ' 7.5 ').
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function toNumber(value) {
  if (value === null || value === undefined) return null;
  // Booleans coerce to 1/0 and are never a measurement.
  if (typeof value === 'boolean') return null;
  // [] -> 0 and [5] -> 5; neither is a number anyone meant to write.
  if (Array.isArray(value)) return null;
  if (typeof value === 'string' && value.trim() === '') return null;

  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * A whole number, or null. Truncates toward zero.
 *
 * `int(float(x))` semantics on purpose: a POS sending "2.0" for a quantity is
 * sending a decimal string, not garbage, and a keg partial should land as 2
 * rather than as null.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function toInt(value) {
  const n = toNumber(value);
  return n === null ? null : Math.trunc(n);
}

/**
 * A number that must be positive to count as known.
 *
 * For money fields where zero is indistinguishable from absent: a product
 * costing 0.00 is a product whose cost we do not have, and treating it as free
 * is how a 100% margin gets recommended.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function toPositiveNumber(value) {
  const n = toNumber(value);
  return n !== null && n > 0 ? n : null;
}

/** True when the value is a real, finite number (not absent, not a blank). */
const isNumeric = (value) => toNumber(value) !== null;

module.exports = { isNumeric, toInt, toNumber, toPositiveNumber };
