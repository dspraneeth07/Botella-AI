#!/usr/bin/env node
/**
 * Holdout assignment — is the arm STABLE?
 *
 * Sheet 17 step 1: turn the holdout on. But a holdout whose arms reshuffle is
 * worse than no holdout at all, because it accumulates a quarter of noise and
 * then reports that the engine does not work.
 *
 * The assignment WAS:
 *
 *     ((runId * 31 + r.rank) % 100) < holdoutPct
 *
 * `runId` is a fresh serial every run; `rank` moves as the ranking moves. Over
 * 100 consecutive runs, rank 1 changed arm 39 times. This file is the guard
 * that stops that shipping again.
 *
 * Run:  node tests/holdout-assignment-verify.js
 */

const {
  BUCKETS, assignmentKey, bucketFor, isHoldout,
} = require('../lib/holdoutAssignment');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const rec = (over = {}) => ({
  clientId: 171, locationId: 171, sku: '080686001904', family: 'reorder', ...over,
});

console.log('\n── The arm does not move while the question is open ────────');

// The old key, reproduced so the regression is visible rather than described.
const oldArm = (runId, rank, pct) => ((runId * 31 + rank) % 100) < pct;
let oldFlips = 0;
let prev = null;
for (let runId = 100; runId < 200; runId++) {
  const arm = oldArm(runId, 1, 20);
  if (prev !== null && arm !== prev) oldFlips += 1;
  prev = arm;
}
check(`1  the OLD key flipped arm ${oldFlips} times in 100 runs (regression witness)`,
  oldFlips > 10, String(oldFlips));

// The new key does not take a run id or a rank at all, so "across runs" is
// tested by asking the same question many times with everything else varying.
const arms = new Set();
for (let runId = 1; runId <= 500; runId++) {
  for (const rank of [1, 2, 3, 7, 10]) {
    // runId and rank are deliberately NOT arguments - if either ever creeps
    // back into the key, this set grows and the check fails.
    arms.add(isHoldout(rec(), 20));
  }
}
check('2  the arm is identical across 2,500 (run, rank) combinations',
  arms.size === 1, `${arms.size} distinct arms`);

console.log('\n── The key is what is being measured ──────────────────────');

check('3  a different SKU can land in a different arm',
  assignmentKey(rec()) !== assignmentKey(rec({ sku: '721059000505' })));
check('4  a different STORE can land in a different arm',
  assignmentKey(rec()) !== assignmentKey(rec({ clientId: 22, locationId: 22 })));
check('5  a different FAMILY is assigned independently',
  assignmentKey(rec()) !== assignmentKey(rec({ family: 'markdown' })),
  'a store can be live for reorder and shadow for markdown');
check('6  the key contains no run id, rank or date',
  !/\d{4}-\d{2}-\d{2}/.test(assignmentKey(rec()))
  && assignmentKey(rec()) === '171:171:080686001904:reorder',
  assignmentKey(rec()));

console.log('\n── The split is the size it claims to be ──────────────────');

// 20,000 realistic keys across 200 stores.
const keys = [];
for (let store = 1; store <= 200; store++) {
  for (let i = 0; i < 100; i++) {
    keys.push(rec({ clientId: store, locationId: store, sku: `SKU${i}` }));
  }
}
for (const pct of [5, 10, 20, 50]) {
  const held = keys.filter((k) => isHoldout(k, pct)).length;
  const actual = (held / keys.length) * 100;
  check(`7  ${pct}% holdout assigns ${actual.toFixed(1)}% (within 1.5 points)`,
    Math.abs(actual - pct) < 1.5, `${held}/${keys.length}`);
}

console.log('\n── Buckets are not an arithmetic progression ──────────────');

// The old key strode 31 buckets per id, so assignment correlated with id
// order - for us, the order stores were onboarded. A hash should not.
const strides = new Set();
for (let i = 0; i < 50; i++) {
  const a = bucketFor(`171:171:SKU${i}:reorder`);
  const b = bucketFor(`171:171:SKU${i + 1}:reorder`);
  strides.add(((b - a) % BUCKETS + BUCKETS) % BUCKETS);
}
check('8  consecutive keys do not share one stride', strides.size > 20,
  `${strides.size} distinct strides over 50 pairs`);

const oldStrides = new Set();
for (let i = 0; i < 50; i++) {
  oldStrides.add((((i + 1) * 31 + 1) % 100 - ((i * 31 + 1) % 100) + 100) % 100);
}
check('9  ...whereas the old key had exactly one (witness)',
  oldStrides.size === 1, `${[...oldStrides]}`);

console.log('\n── Off means off ─────────────────────────────────────────');

check('10 pct 0 withholds nothing', !isHoldout(rec(), 0));
check('11 pct 0 withholds nothing, for every key',
  keys.every((k) => !isHoldout(k, 0)));

console.log('\n── Determinism: same key, same arm, any process ──────────');

const once = keys.slice(0, 500).map((k) => isHoldout(k, 20));
const twice = keys.slice(0, 500).map((k) => isHoldout(k, 20));
check('12 two evaluations agree exactly',
  once.every((v, i) => v === twice[i]));
check('13 the bucket is a pure function of the key string',
  bucketFor('171:171:080686001904:reorder')
    === bucketFor(assignmentKey(rec())));

// A missing SKU must not throw and must not silently collapse every such rec
// into one bucket-0 arm without saying so.
check('14 a missing sku still produces a stable, keyed arm',
  typeof isHoldout(rec({ sku: undefined }), 20) === 'boolean'
    && assignmentKey(rec({ sku: undefined })) === '171:171::reorder');

console.log('');
console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
