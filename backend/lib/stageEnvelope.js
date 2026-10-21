/**
 * Stage envelope — the Node half of the pipeline contract (sheet 00).
 *
 * The Python service emits one audit row per stage: the value, whether the
 * stage reached one, why, and the provenance behind it. This module is the
 * ONE place Node turns that JSON into an object. The alternative — every
 * consumer picking fields out of the blob it happens to receive — is how the
 * dead-stock tile came to say 454 while chat said 485: two readers of the same
 * idea, each with its own quiet interpretation.
 *
 * FIELD NAMES ARE NOT TRANSLATED. The wire is snake_case, the analytics
 * columns are snake_case, so the parsed object is snake_case too. Renaming to
 * camelCase here would be exactly the "bespoke adapter" this file exists to
 * remove — a second vocabulary to keep in sync, which nobody would, and which
 * would drift silently because both spellings look correct in isolation.
 *
 * Mirrors: app/pipeline/envelope.py, provenance.py, context.py.
 * The enum vocabularies below are duplicated from Python on purpose (there is
 * no shared schema artefact yet) and are pinned by a cross-language golden
 * fixture — see backend/tests/stage-envelope-verify.js.
 */

'use strict';

/** Bumped whenever the audit row's shape changes incompatibly. */
const AUDIT_SCHEMA = 'stage_result/1';

/** app/pipeline/provenance.py :: EvidenceState */
const EVIDENCE_STATES = Object.freeze(['NEW', 'EMERGING', 'ESTABLISHED', 'MATURE']);
/** app/pipeline/provenance.py :: CohortLevel */
const COHORT_LEVELS = Object.freeze(['store', 'state', 'region', 'national']);
/** app/pipeline/registry.py :: Status */
const STATUSES = Object.freeze(['PROVISIONAL', 'FITTED', 'MEASURED']);

class StageEnvelopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StageEnvelopeError';
  }
}

// ─── small validators ────────────────────────────────────────────────────────
// These throw rather than coerce. A stage output that does not match the
// contract is a bug on the producing side, and silently repairing it here
// means the bug ships and is discovered much later, in a number nobody can
// explain.

function must(condition, message) {
  if (!condition) throw new StageEnvelopeError(message);
}

function asObject(value, where) {
  must(value !== null && typeof value === 'object' && !Array.isArray(value),
    `${where} must be an object, got ${Array.isArray(value) ? 'array' : typeof value}`);
  return value;
}

function asInt(value, where, { min = null } = {}) {
  must(Number.isInteger(value), `${where} must be an integer, got ${JSON.stringify(value)}`);
  if (min !== null) must(value >= min, `${where} must be >= ${min}, got ${value}`);
  return value;
}

function asString(value, where, { allowEmpty = false } = {}) {
  must(typeof value === 'string', `${where} must be a string, got ${typeof value}`);
  must(allowEmpty || value.length > 0, `${where} must not be empty`);
  return value;
}

function asStringArray(value, where) {
  must(Array.isArray(value), `${where} must be an array`);
  value.forEach((v, i) => asString(v, `${where}[${i}]`, { allowEmpty: true }));
  return Object.freeze([...value]);
}

function asEnum(value, allowed, where) {
  must(allowed.includes(value),
    `${where} must be one of ${allowed.join(' | ')}, got ${JSON.stringify(value)}`);
  return value;
}

// ─── parsers ─────────────────────────────────────────────────────────────────

/**
 * Provenance — how a stage decided, travelling with what it decided.
 *
 * `own_weight` is the field to read before trusting a number: 1.0 means the
 * answer is this store's own behaviour, 0.0 means it is entirely a cohort
 * prior wearing this store's name.
 */
function parseProvenance(raw, where = 'provenance') {
  const p = asObject(raw, where);
  const own_weight = p.own_weight;
  must(typeof own_weight === 'number' && Number.isFinite(own_weight),
    `${where}.own_weight must be a finite number, got ${JSON.stringify(own_weight)}`);
  must(own_weight >= 0 && own_weight <= 1,
    `${where}.own_weight must be within 0..1, got ${own_weight}`);

  const cohort_level = p.cohort_level ?? null;
  if (cohort_level !== null) asEnum(cohort_level, COHORT_LEVELS, `${where}.cohort_level`);

  const calibration_version = p.calibration_version ?? null;
  if (calibration_version !== null) {
    must(typeof calibration_version === 'string' && calibration_version.length > 0,
      `${where}.calibration_version must be a non-empty string or null, got ` +
      JSON.stringify(calibration_version));
  }

  const cohort_size = p.cohort_size ?? null;
  if (cohort_size !== null) {
    asInt(cohort_size, `${where}.cohort_size`, { min: 0 });
    // Same rule Python enforces: a size with no level says "borrowed from 240
    // of something".
    must(cohort_level !== null,
      `${where}.cohort_size was given without a cohort_level`);
  }

  return Object.freeze({
    own_observations: asInt(p.own_observations, `${where}.own_observations`, { min: 0 }),
    cohort_level,
    cohort_size,
    own_weight,
    evidence_state: asEnum(p.evidence_state, EVIDENCE_STATES, `${where}.evidence_state`),
    inputs: asStringArray(p.inputs ?? [], `${where}.inputs`),
    config_keys: asStringArray(p.config_keys ?? [], `${where}.config_keys`),
    // Sheet 08. Which calibration curve shaped the confidence this stage
    // produced. `null` means none was applied - either the stage produces no
    // confidence, or no fit existed and the identity transform ran. It is not
    // a failure state, so it is not validated as an enum.
    //
    // Recorded so a card shown six months ago can still be traced to the
    // curve that ranked it. A calibration nobody can audit is just a second
    // unexplained number stacked on the first.
    calibration_version: calibration_version,
  });
}

/**
 * RunContext — the pinned world a stage ran against.
 *
 * `as_of` stays a 'YYYY-MM-DD' STRING and is never turned into a Date.
 * `new Date('2026-09-21')` is UTC midnight, which renders as the 20th in any
 * timezone behind UTC — the same class of bug that made the daily capture
 * tables key on the store's own calendar date rather than the server's.
 */
function parseRunContext(raw, where = 'context') {
  const c = asObject(raw, where);
  const as_of = asString(c.as_of, `${where}.as_of`);
  must(/^\d{4}-\d{2}-\d{2}$/.test(as_of),
    `${where}.as_of must be YYYY-MM-DD, got ${JSON.stringify(as_of)}`);

  const versions = asObject(c.versions ?? {}, `${where}.versions`);
  Object.entries(versions).forEach(([k, v]) => asString(v, `${where}.versions.${k}`));

  return Object.freeze({
    run_id: asString(c.run_id, `${where}.run_id`),
    tenant_id: asInt(c.tenant_id, `${where}.tenant_id`),
    store_id: asInt(c.store_id, `${where}.store_id`),
    as_of,
    snapshot_id: asString(c.snapshot_id, `${where}.snapshot_id`),
    config_version: asString(c.config_version, `${where}.config_version`),
    seed: asInt(c.seed ?? 0, `${where}.seed`),
    versions: Object.freeze({ ...versions }),
  });
}

/**
 * Parse one persisted audit row.
 *
 * `ok: false` is a LEGITIMATE OUTCOME carrying reasons, not an error — "not
 * enough evidence to say anything about this SKU" is a real answer. Callers
 * must branch on `.ok`, never treat a falsy result as a failed read.
 */
function parseAuditRow(raw, where = 'audit row') {
  const row = asObject(raw, where);
  must(row.schema === AUDIT_SCHEMA,
    `${where}.schema is ${JSON.stringify(row.schema)}, expected ${JSON.stringify(AUDIT_SCHEMA)}`);
  must(typeof row.ok === 'boolean', `${where}.ok must be a boolean`);

  const reasons = asStringArray(row.reasons ?? [], `${where}.reasons`);
  // Mirrors StageResult.failure(): a bare ok=false is as unhelpful as a bare
  // number — it says something did not happen without saying what to do.
  must(row.ok || reasons.length > 0, `${where} is ok=false but carries no reasons`);

  return Object.freeze({
    schema: row.schema,
    stage: asString(row.stage, `${where}.stage`),
    stage_version: asString(row.stage_version, `${where}.stage_version`),
    ok: row.ok,
    value: row.ok ? (row.value ?? null) : null,
    reasons,
    duration_ms: asInt(row.duration_ms ?? 0, `${where}.duration_ms`, { min: 0 }),
    provenance: parseProvenance(row.provenance, `${where}.provenance`),
    context: parseRunContext(row.context, `${where}.context`),
    input_digest: row.input_digest ?? null,
  });
}

/** Non-throwing variant: `{ ok: true, result }` or `{ ok: false, error }`. */
function tryParseAuditRow(raw) {
  try {
    return { ok: true, result: parseAuditRow(raw) };
  } catch (err) {
    if (err instanceof StageEnvelopeError) return { ok: false, error: err.message };
    throw err;
  }
}

/**
 * One line fit for a log or a UI tooltip, stating the evidence rather than
 * just the number. "8 obs, ESTABLISHED, own 0.80, cohort state/240".
 */
function describeProvenance(provenance) {
  const p = provenance;
  const parts = [
    `${p.own_observations} obs`,
    p.evidence_state,
    `own ${p.own_weight.toFixed(2)}`,
  ];
  if (p.cohort_level) parts.push(`cohort ${p.cohort_level}/${p.cohort_size ?? '?'}`);
  return parts.join(', ');
}

/**
 * True when a row carries everything replay needs: the pinned context, the
 * stage version, and the input digest. Worth checking before promising a
 * reader that a number can be reproduced.
 */
function isReplayable(row) {
  return Boolean(
    row && row.context && row.stage && row.stage_version && row.input_digest
  );
}

module.exports = {
  AUDIT_SCHEMA,
  COHORT_LEVELS,
  EVIDENCE_STATES,
  STATUSES,
  StageEnvelopeError,
  describeProvenance,
  isReplayable,
  parseAuditRow,
  parseProvenance,
  parseRunContext,
  tryParseAuditRow,
};
