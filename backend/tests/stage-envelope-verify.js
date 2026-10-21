#!/usr/bin/env node
/**
 * Stage-envelope verification — the Node half of the sheet-00 contract.
 *
 * The golden fixture is EMITTED BY PYTHON (app/pipeline/envelope.py) and
 * committed here. That is the point: if the two sides ever disagree about the
 * shape of a stage output, this fails rather than some downstream tile
 * quietly rendering `undefined`. Regenerate it from the Python repo when the
 * audit-row shape legitimately changes; never hand-edit it to make this pass.
 *
 * Run:  node tests/stage-envelope-verify.js
 */

const fs = require('fs');
const path = require('path');

const env = require('../lib/stageEnvelope');

const GOLDEN = path.join(__dirname, 'fixtures', 'stage_result_golden.json');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function throws(label, fn, match) {
  try {
    fn();
    check(label, false, 'no error thrown');
  } catch (err) {
    const ok = err instanceof env.StageEnvelopeError && String(err.message).includes(match);
    check(label, ok, err.message);
  }
}

const clone = (o) => JSON.parse(JSON.stringify(o));

console.log('\n── Cross-language golden row (emitted by Python) ────────────');

if (!fs.existsSync(GOLDEN)) {
  console.error(`Missing ${GOLDEN} — regenerate it from the Python service.`);
  process.exit(2);
}
const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
const row = env.parseAuditRow(golden);

check('1  parses a Python-emitted audit row', row.ok === true && row.stage === 'dead_stock');
check('1b value survives intact', JSON.stringify(row.value) === JSON.stringify(['MD1', 'ZB1']),
  JSON.stringify(row.value));
check('1c stage version carried', row.stage_version === '1.0.0');

console.log('\n── Provenance travels with the value ───────────────────────');

const p = row.provenance;
check('2  evidence fields read across the wire',
  p.own_observations === 4 && p.evidence_state === 'ESTABLISHED' && p.own_weight === 0.8,
  JSON.stringify(p));
check('2b cohort disclosed', p.cohort_level === 'state' && p.cohort_size === 240);
check('2c config_keys survived (they filled themselves in Python)',
  p.config_keys.includes('dead_stock.days'), JSON.stringify(p.config_keys));
check('2d inputs survived', p.inputs.length === 2, JSON.stringify(p.inputs));
check('2e describeProvenance states the evidence, not just the number',
  env.describeProvenance(p) === '4 obs, ESTABLISHED, own 0.80, cohort state/240',
  env.describeProvenance(p));

console.log('\n── The pinned context ──────────────────────────────────────');

check('3  context round-trips', row.context.tenant_id === 46 && row.context.store_id === 46);
check('3b as_of stays a STRING — new Date() would shift it a day west of UTC',
  row.context.as_of === '2026-09-21' && typeof row.context.as_of === 'string');
check('3c versions pinned', row.context.versions.engine === '2.0.0');
check('3d row is replayable', env.isReplayable(row) === true);

console.log('\n── Contract violations are refused, never coerced ──────────');

throws('4  unknown schema', () => env.parseAuditRow({ ...clone(golden), schema: 'stage_result/9' }),
  'schema');
throws('4b own_weight above 1', () => {
  const bad = clone(golden); bad.provenance.own_weight = 1.5;
  env.parseAuditRow(bad);
}, 'within 0..1');
throws('4c unknown evidence_state', () => {
  const bad = clone(golden); bad.provenance.evidence_state = 'SOLID';
  env.parseAuditRow(bad);
}, 'evidence_state');
throws('4d cohort_size without a level', () => {
  const bad = clone(golden); bad.provenance.cohort_level = null;
  env.parseAuditRow(bad);
}, 'without a cohort_level');
throws('4e as_of that is not a plain date', () => {
  const bad = clone(golden); bad.context.as_of = '2026-09-21T04:00:00Z';
  env.parseAuditRow(bad);
}, 'YYYY-MM-DD');
throws('4f negative observation count', () => {
  const bad = clone(golden); bad.provenance.own_observations = -1;
  env.parseAuditRow(bad);
}, '>= 0');

console.log('\n── ok:false is an OUTCOME, not an error ────────────────────');

const failed = clone(golden);
failed.ok = false;
failed.value = null;
failed.reasons = ['no_dead_stock'];
const parsedFail = env.parseAuditRow(failed);
check('5  a no-answer row parses cleanly',
  parsedFail.ok === false && parsedFail.reasons[0] === 'no_dead_stock');
check('5b it still carries provenance and is still auditable',
  parsedFail.provenance.evidence_state === 'ESTABLISHED' && parsedFail.stage === 'dead_stock');

throws('5c ok:false with no reasons is refused', () => {
  const bad = clone(golden); bad.ok = false; bad.reasons = [];
  env.parseAuditRow(bad);
}, 'no reasons');

console.log('\n── Parsed rows are frozen ──────────────────────────────────');

const before = row.provenance.own_observations;
try { row.provenance.own_observations = 999; } catch { /* strict mode throws */ }
check('6  a consumer cannot mutate a parsed result',
  row.provenance.own_observations === before);

console.log('\n── tryParse for non-throwing call sites ────────────────────');

check('7  tryParse reports the problem instead of throwing',
  env.tryParseAuditRow({ schema: 'nope' }).ok === false);
check('7b tryParse passes a good row through', env.tryParseAuditRow(golden).ok === true);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
