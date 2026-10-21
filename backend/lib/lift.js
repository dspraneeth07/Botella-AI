'use strict';

/**
 * THE definition of lift. One of them, shared by everything that reports it.
 *
 * WHY THIS FILE EXISTS
 *   There were two. The evaluation service measured a SKU against a 28-day
 *   baseline and pooled the ratio across a recommendation's SKUs; the Python
 *   feedback loop used a 21-day baseline, a fixed 7-day post window, and the
 *   unweighted MEAN of per-SKU ratios. On identical data those two produce
 *   1.37x different answers.
 *
 *   That is the 454-vs-485 failure - the one where a dead-stock count differed
 *   between two screens and the owner was told in writing that they matched -
 *   reproduced in the metric the ENTIRE feedback loop depends on. Calibration
 *   fits on lift. The shrinkage constant k is fitted from lift. The gate
 *   judges on lift. Two definitions means two answers to "did it work".
 *
 * THE THREE DECISIONS, MADE ONCE
 *
 *   1. OPEN DAYS, NEVER CALENDAR DAYS.
 *      Bethany closes every Sunday plus three holidays - 200 closed days of
 *      1,360. A 28-CALENDAR-day window there holds 23 open days, so a rate
 *      divided by 28 is understated by 21.7%. Stores 101, 102 and 103 are
 *      worse at 27.3%.
 *
 *      Both windows must use it. Dividing the baseline by open days and then
 *      multiplying by calendar days just moves the error.
 *
 *   2. A POOLED RATIO, NOT A MEAN OF RATIOS.
 *      sum(actual) / sum(expected), not mean(actual_i / expected_i).
 *
 *      A recommendation covering a 100-unit SKU and a 1-unit SKU is mostly
 *      about the 100-unit one. The mean of ratios lets the quiet SKU - whose
 *      ratio swings wildly on a single basket - carry half the answer. That is
 *      the same volume-blindness sheet 17's matched null exists to remove, and
 *      it belongs out of the metric as well as out of the comparison.
 *
 *   3. A ZERO BASELINE IS NOT A ZERO DENOMINATOR.
 *      A SKU with no trailing sales cannot have a lift - the ratio is
 *      undefined, not infinite. Its sales are real and are reported separately
 *      as upside, never folded into a numerator over an empty denominator.
 *
 * PURE, SO THE PYTHON SIDE CAN BE PINNED TO IT
 *   No database, no clock, no config. `app/pipeline/outcomes/lift.py` is the
 *   same arithmetic, and `tests/lift-parity-verify.js` checks the two against
 *   one shared fixture so they cannot drift apart again.
 */

/**
 * Lift for one recommendation.
 *
 * @param {Array<{sku: string, baseline_units: number, actual_units: number}>} skus
 * @param {{baseline_open_days: number, window_open_days: number}} windows
 *   OPEN days in each window. Not calendar days - see decision 1.
 * @returns {{
 *   lift: number|null, expected: number, actual: number,
 *   upside_units: number, baselined_skus: number, upside_skus: number,
 *   measurable: boolean, reason: string|null
 * }}
 *   `lift: null` always means UNMEASURABLE, never "no effect". A caller that
 *   reads null as 1.0 turns "we could not tell" into "it did nothing", which
 *   is the difference the whole programme is built on.
 */
function liftFor(skus, windows) {
  const baselineOpen = Number(windows && windows.baseline_open_days);
  const windowOpen = Number(windows && windows.window_open_days);

  if (!Number.isFinite(baselineOpen) || baselineOpen <= 0) {
    return unmeasurable('no open days in the baseline window - the store was '
      + 'closed or unsynced throughout it');
  }
  if (!Number.isFinite(windowOpen) || windowOpen <= 0) {
    return unmeasurable('no open days in the measurement window - nothing '
      + 'could have sold');
  }

  let expected = 0;
  let actual = 0;
  let upsideUnits = 0;
  let baselinedSkus = 0;
  let upsideSkus = 0;

  for (const row of skus || []) {
    const base = Number(row.baseline_units) || 0;
    const sold = Number(row.actual_units) || 0;
    if (base > 0) {
      // Rate per OPEN day, projected across the measurement window's OPEN days.
      expected += (base / baselineOpen) * windowOpen;
      actual += sold;
      baselinedSkus += 1;
    } else {
      // Real sales, reported apart. See decision 3.
      upsideUnits += sold;
      upsideSkus += 1;
    }
  }

  const base = {
    expected: round2(expected),
    actual: round2(actual),
    upside_units: round2(upsideUnits),
    baselined_skus: baselinedSkus,
    upside_skus: upsideSkus,
  };

  if (!baselinedSkus) {
    return { ...base, lift: null, measurable: false,
      reason: 'no SKU on this recommendation had a trailing baseline to '
        + 'measure against' };
  }
  if (expected <= 0) {
    return { ...base, lift: null, measurable: false,
      reason: 'the baseline projects zero units over this window' };
  }
  return { ...base, lift: round2(actual / expected), measurable: true, reason: null };
}

function unmeasurable(reason) {
  return {
    lift: null, expected: 0, actual: 0, upside_units: 0,
    baselined_skus: 0, upside_skus: 0, measurable: false, reason,
  };
}

/** Two decimals, the resolution a lift is ever reported at. */
function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

/**
 * Lift squashed to a 0-1 score. 1.0x -> 0.5, so neutral is the midpoint.
 *
 * Kept here rather than beside the callers for the same reason as `liftFor`:
 * a score and the lift it came from must agree, and they only do if one file
 * owns both.
 */
function scoreFromLift(lift, cap) {
  if (lift === null || lift === undefined || !Number.isFinite(Number(lift))) return null;
  const capped = Math.min(Math.max(Number(lift), 0), Number(cap) || 5);
  return round3(capped / (capped + 1));
}

function round3(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

module.exports = { liftFor, round2, scoreFromLift };
