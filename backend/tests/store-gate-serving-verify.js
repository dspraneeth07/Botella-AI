#!/usr/bin/env node
/**
 * Sheet 17's STORE gate, on the serving path.
 *
 * The family gate has been applied when building a slate for a while. The
 * store gate - the one that asks whether this store's cards are trustworthy at
 * all - was computed, published and read by the audit page, and never consulted
 * when serving. A store the gate had judged unfit went on showing cards.
 *
 * The three things that are easy to get wrong here, each of which is worse than
 * having no gate:
 *
 *   UNMEASURED READ AS FAILED. "Nobody has measured this store" is not "this
 *   store failed". Treating them alike withholds every card at every store the
 *   first time the flag is honoured - an outage dressed as caution.
 *
 *   EXPIRY GRANTING PERMISSION. A verdict that ages out must be able to close a
 *   store and never to open one. "We proved it in June" does not survive to
 *   November; "we never proved it" stays true no matter how old it gets.
 *
 *   A MISSING EXPIRY READ AS FOREVER. Rows written before migration 033 carry
 *   no valid_until. Grandfathering them in would preserve precisely the
 *   behaviour the column exists to end.
 *
 * Run:  node tests/store-gate-serving-verify.js
 */

const svc = require('../services/recommendationService');

const decide = svc.storeGateDecision;
const NOW = new Date('2026-10-08T12:00:00Z');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail ? ` - ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const FRESH = '2026-12-31';
const STALE = '2026-07-29';

console.log('\n-- Unmeasured is not failed ------------------------------');

const unmeasured = decide(
  { measured: false, displayed: false, state: 'shadow', valid_until: FRESH },
  { enforced: true, now: NOW }
);
check('1  an unmeasured store is not marked measured', unmeasured.measured === false);
check('2  ...so the caller has no grounds to withhold',
  // The serving path withholds only on `measured && !displayed`. This is the
  // guard that keeps a never-measured estate serving.
  !(unmeasured.measured && !unmeasured.displayed));

console.log('\n-- A live, in-date verdict serves ------------------------');

const live = decide(
  { measured: true, displayed: true, state: 'live', reason: 'both_gates_hold',
    valid_until: FRESH, verdict_as_of: '2026-09-30' },
  { enforced: true, now: NOW }
);
check('3  it serves', live.measured && live.displayed && !live.expired);
check('4  and keeps the reason the gate gave it',
  live.reason === 'both_gates_hold', live.reason);

console.log('\n-- A measured failure withholds --------------------------');

const failed = decide(
  { measured: true, displayed: false, state: 'shadow',
    reason: 'promise_fill_outside_band', valid_until: FRESH },
  { enforced: true, now: NOW }
);
check('5  measured and not displayed is the withhold case',
  failed.measured && !failed.displayed);
check('6  and the reason survives for a support call',
  failed.reason === 'promise_fill_outside_band', failed.reason);

console.log('\n-- Expiry closes a store, and never opens one ------------');

const expiredLive = decide(
  { measured: true, displayed: true, state: 'live', reason: 'both_gates_hold',
    valid_until: STALE, verdict_as_of: '2026-03-31' },
  { enforced: true, now: NOW }
);
check('7  a live verdict past its date stops displaying',
  expiredLive.expired === true && expiredLive.displayed === false);
check('8  and says WHY, naming the date it expired on',
  expiredLive.reason === `verdict_expired:${STALE}`, expiredLive.reason);
check('9  the stored state is reported unchanged, not rewritten',
  // `state` is what the gate decided; `displayed` is whether we may act on it.
  // Overwriting the state would lose the fact that this store did pass.
  expiredLive.state === 'live');

const expiredFailed = decide(
  { measured: true, displayed: false, state: 'shadow',
    reason: 'ece_too_high', valid_until: STALE },
  { enforced: true, now: NOW }
);
check('10 an expired FAILURE is still a failure',
  expiredFailed.displayed === false,
  'expiry must not be able to open a withheld store');
check('11 and keeps its own reason rather than the expiry one',
  expiredFailed.reason === 'ece_too_high', expiredFailed.reason);

console.log('\n-- No expiry date at all is expired, not forever ---------');

const noDate = decide(
  { measured: true, displayed: true, state: 'live', valid_until: null },
  { enforced: true, now: NOW }
);
check('12 a verdict that never stated an expiry has one now',
  noDate.expired === true && noDate.displayed === false);
check('13 and the reason names the absence',
  noDate.reason === 'verdict_expired:no_valid_until', noDate.reason);

console.log('\n-- Good THROUGH the last valid day ----------------------');

const lastDay = decide(
  { measured: true, displayed: true, valid_until: '2026-10-08' },
  { enforced: true, now: NOW }
);
check('14 the final day is inside the window, not outside it',
  lastDay.expired === false && lastDay.displayed === true,
  'a date-only expiry must not fire at midnight on the morning of it');
const dayAfter = decide(
  { measured: true, displayed: true, valid_until: '2026-10-07' },
  { enforced: true, now: NOW }
);
check('15 the day after is outside it', dayAfter.expired === true);

console.log('\n-- Enforcement is reported, not assumed -----------------');

const shadowMode = decide(
  { measured: true, displayed: false, state: 'shadow', valid_until: FRESH },
  { enforced: false, now: NOW }
);
check('16 with enforcement off the verdict is still computed',
  shadowMode.measured === true && shadowMode.displayed === false);
check('17 ...and the flag says it will not be acted on',
  shadowMode.enforced === false,
  'the serving path withholds only when this is true');

console.log('\n-- Calibration staleness stays tri-state ----------------');

check('18 a stale curve is reported as stale',
  decide({ measured: true, displayed: true, valid_until: FRESH,
    calibration_is_stale: true }, { now: NOW }).calibration_is_stale === true);
check('19 a healthy curve is FALSE, which is a measurement',
  decide({ measured: true, displayed: true, valid_until: FRESH,
    calibration_is_stale: false }, { now: NOW }).calibration_is_stale === false);
check('20 and a publisher that did not say leaves NULL, not false',
  // `||` would collapse false and absent to the same value, which is the whole
  // reason this uses `??`. "We were not told" is not "the curve was fine".
  decide({ measured: true, displayed: true, valid_until: FRESH },
    { now: NOW }).calibration_is_stale === null);

console.log('\n-- Dates are normalised, whatever the driver returns -----');

check('21 a Date object for valid_until is handled',
  decide({ measured: true, displayed: true,
    valid_until: new Date('2026-12-31T00:00:00Z') },
  { now: NOW }).expired === false);
// 21 ALONE IS NOT ENOUGH, and that is not a hypothetical: the first version of
// this code String()'d the Date, got "Wed Dec 31", parsed it to Invalid Date,
// and every comparison against Invalid is false - so 21 passed while every
// verdict in production would have read as valid forever. The PAST case is the
// one that catches it, because there the honest answer is `true`.
check('21b and a Date in the PAST actually expires',
  decide({ measured: true, displayed: true,
    valid_until: new Date('2026-07-29T00:00:00Z') },
  { now: NOW }).expired === true,
  'String()ing a Date yields Invalid Date, whose comparisons are all false');
check('22 verdict_as_of comes back as a plain day',
  decide({ measured: true, displayed: true, valid_until: FRESH,
    verdict_as_of: new Date('2026-09-30T00:00:00Z') },
  { now: NOW }).verdict_as_of === '2026-09-30');

console.log('');
console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
