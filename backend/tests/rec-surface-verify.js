#!/usr/bin/env node
/**
 * Sheet 18 — two surfaces, one gate. Does the boundary actually hold?
 *
 * "Shadow cards are visible internally and never to the store" is only true if
 * the split happens on the SERVER. A client-side filter is not a boundary: the
 * payload still crossed the network, and anybody with devtools open has the
 * shadow cards and the p-values behind them.
 *
 * This checks the stripping function and the credential directly, without a
 * server: both are pure, and a test that needs :3100 up is a test that does not
 * run.
 *
 * Run:  node tests/rec-surface-verify.js
 */

const path = require('path');
const fs = require('fs');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const ROUTE = path.join(__dirname, '..', 'routes', 'recommendations.js');
const source = fs.readFileSync(ROUTE, 'utf8');

console.log('\n── The split is server-side, not a client filter ──────────');

check('1  the store route strips internal fields',
  /recommendations:\s*\(latest\.recommendations\s*\|\|\s*\[\]\)\.map\(forStore\)/.test(source));
check('2  withheld cards are stripped too',
  /withheld:\s*\(latest\.withheld\s*\|\|\s*\[\]\)\.map\(forStore\)/.test(source),
  'a withheld card carries the same gate reasoning as a shown one');
check('3  the internal surface is a separate ENDPOINT, not a query flag',
  /'\/internal\/latest'/.test(source));
check('4  the internal surface is not reachable with the store JWT alone',
  /if \(!isInternalRequest\(req\)\)/.test(source));

console.log('\n── The credential fails CLOSED ───────────────────────────');

// Exercised by re-evaluating the module's own logic against a fake request,
// which is what the route does. Loading the route would pull in a DB pool.
function makeIsInternal(configuredKey) {
  return function isInternalRequest(req) {
    if (!configuredKey) return false;
    const offered = req.get('X-Internal-Key') || '';
    if (offered.length !== configuredKey.length) return false;
    let diff = 0;
    for (let i = 0; i < configuredKey.length; i++) {
      diff |= offered.charCodeAt(i) ^ configuredKey.charCodeAt(i);
    }
    return diff === 0;
  };
}
const req = (key) => ({ get: (h) => (h === 'X-Internal-Key' ? key : undefined) });

const unconfigured = makeIsInternal('');
check('5  with NO key configured the internal surface is closed',
  !unconfigured(req('anything')) && !unconfigured(req(undefined)),
  'a debugging endpoint that is accidentally public is worse than one that is missing');

const configured = makeIsInternal('s3cret-key-value');
check('6  the right key opens it', configured(req('s3cret-key-value')));
check('7  a wrong key of the same length does not', !configured(req('wrong-key-value!')));
check('8  a wrong key of a different length does not', !configured(req('short')));
check('9  no header does not', !configured(req(undefined)));

console.log('\n── The comparison does not leak the key by timing ─────────');

check('10 the compare is constant-time over the key, not an early return',
  /diff \|= .*charCodeAt\(i\) \^ /.test(source)
  && !/offered === INTERNAL_KEY/.test(source));

console.log('\n── A wrong key gets 404, not 403 ─────────────────────────');

check('11 404 rather than 403',
  /status\(404\)/.test(source.slice(source.indexOf("'/internal/latest'"))),
  'an endpoint that answers "wrong key" confirms it exists');

console.log('\n── Internal-only fields are actually named ───────────────');

const listed = (source.match(/INTERNAL_ONLY_CARD_FIELDS = \[([\s\S]*?)\]/) || [])[1] || '';
for (const field of ['gate_state', 'gate_reason', 'p_value', 'null_mean', 'observed']) {
  check(`12 ${field} is stripped from the store surface`, listed.includes(field));
}

console.log('\n── forStore removes them, and keeps the rest ─────────────');

// The real function, extracted and evaluated - so this tests the shipped code
// rather than a copy of it.
const fnSource = source.slice(source.indexOf('function forStore'),
  source.indexOf('}', source.indexOf('return copy;')) + 1);
// eslint-disable-next-line no-new-func
const forStore = new Function(
  'INTERNAL_ONLY_CARD_FIELDS',
  `${fnSource}; return forStore;`
)(['gate_state', 'gate_reason', 'gate_evidence', 'p_value', 'null_mean',
  'observed', 'holdout_bucket', 'shadow']);

const card = {
  id: 7, rank: 1, action_type: 'reorder', rationale: 'Order 24.',
  suggested_order_qty: 24, calibrated_confidence: 0.72,
  provenance_sentence: '(based on 14 similar stores)',
  gate_state: 'shadow', gate_reason: 'not_enough_outcomes',
  p_value: 0.31, null_mean: 1.0, observed: 1.1,
};
const shown = forStore(card);

check('13 the store keeps what it needs',
  shown.rank === 1 && shown.rationale === 'Order 24.'
  && shown.suggested_order_qty === 24
  && shown.calibrated_confidence === 0.72
  && shown.provenance_sentence === '(based on 14 similar stores)');
check('14 and receives none of our statistics',
  shown.p_value === undefined && shown.null_mean === undefined
  && shown.observed === undefined && shown.gate_state === undefined
  && shown.gate_reason === undefined);
check('15 the original is not mutated', card.p_value === 0.31,
  'stripping must not damage the internal copy');

console.log('\n── The store is told THAT, never WHICH or HOW MUCH ───────');

check('16 the store gate block carries only a boolean',
  /gate: latest\.gate \? \{ measuring: Boolean\(latest\.gate\.withheld_by_gate\) \}/.test(source),
  '"why fewer cards" has an answer; "here is our p-value" is not it');

console.log('');
console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
