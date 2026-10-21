#!/usr/bin/env node
/**
 * Confidence basis verification (migrations 040 and 041, lib/confidenceBasis.js).
 *
 * The promise being tested: **every stored card says what its confidence
 * figure IS, from a closed vocabulary the Python schema owns, and the gate's
 * decision not to apply a floor is recorded rather than silent.**
 *
 * The failure this guards against is the one QA measured on 2026-10-19: 352
 * cards with no basis at all, 33 with the raw ranking score passed through,
 * every isotonic card on the same 0.444 - and an admission floor that treated
 * all of them as one probability.
 *
 * PREREQ: analytics migrations 040 and 041.
 * Run:  node tests/confidence-basis-verify.js
 *
 * Writes only to a sentinel tenant (999940 / 990040) and deletes it on exit.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');

const { getAnalyticsPool } = require('../database/analytics-connection');
const basisLib = require('../lib/confidenceBasis');
const gate = require('../services/recommendationGateService');

const CID = 999940;
const LID = 990040;

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/** The Python tuple, read out of the schema file so the two copies cannot drift. */
function pythonVocabulary() {
  const file = path.join(__dirname, '..', '..', 'Botella_External_APIs', 'app', 'schemas', 'recommendation.py');
  const src = fs.readFileSync(file, 'utf8');
  const m = src.match(/CONFIDENCE_BASES\s*=\s*\(([\s\S]*?)\)/);
  if (!m) return null;
  return m[1].split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean)
    .map((l) => l.replace(/^"|",?$/g, '').replace(/"/g, '').replace(/,$/, ''));
}

async function cleanup(pool) {
  await pool.query('DELETE FROM recommendation_admission WHERE client_id=$1 AND location_id=$2', [CID, LID])
    .catch(() => {});
  await pool.query('DELETE FROM recommendations WHERE client_id=$1 AND location_id=$2', [CID, LID]);
  await pool.query('DELETE FROM recommendation_runs WHERE client_id=$1 AND location_id=$2', [CID, LID]);
}

(async () => {
  const pool = getAnalyticsPool();
  const ready = await pool.query(
    `SELECT (SELECT is_nullable FROM information_schema.columns
              WHERE table_name='recommendations' AND column_name='confidence_basis') AS nullable,
            (SELECT column_default FROM information_schema.columns
              WHERE table_name='recommendations' AND column_name='confidence_basis') AS dflt,
            EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='recommendation_admission' AND column_name='notes') AS has_notes`
  );
  const col = ready.rows[0];
  if (!col.nullable || !col.has_notes) {
    console.error('Analytics migrations 040 and 041 are not applied — run `npm run migrate`.');
    process.exit(2);
  }

  try {
    await cleanup(pool);

    console.log('\n── One vocabulary, two copies ──────────────────────────────');
    const py = pythonVocabulary();
    check('1  the Python tuple was found and parsed', Array.isArray(py) && py.length > 0, JSON.stringify(py));
    check('1b the Node mirror equals it, in order',
      JSON.stringify(py) === JSON.stringify(basisLib.CONFIDENCE_BASES),
      `python=${JSON.stringify(py)} node=${JSON.stringify(basisLib.CONFIDENCE_BASES)}`);
    check('1c the floor applies to isotonic and to nothing else',
      JSON.stringify(basisLib.DISCRIMINATING_CALIBRATED_BASES) === '["isotonic"]'
        && basisLib.floorApplies('isotonic') && !basisLib.floorApplies('isotonic_constant')
        && !basisLib.floorApplies('raw_ranking_score') && !basisLib.floorApplies(undefined));

    console.log('\n── The persist-path coercion: labelled, never dropped ──────');
    check('2  a known basis is kept', basisLib.coerceBasis('family_evidence_count').basis === 'family_evidence_count'
      && basisLib.coerceBasis('family_evidence_count').reason === null);
    check('2b a missing basis becomes not_recorded, with the reason',
      ['missing', 'missing', 'missing'].join() === [undefined, null, ''].map((v) => basisLib.coerceBasis(v).reason).join()
        && basisLib.coerceBasis(null).basis === 'not_recorded');
    const unk = basisLib.coerceBasis('gut_feeling');
    check('2c an unknown basis becomes not_recorded and names what was sent',
      unk.basis === 'not_recorded' && unk.reason === 'unknown:gut_feeling', JSON.stringify(unk));

    console.log('\n── The column agrees with the model (migration 040) ────────');
    check('3  confidence_basis is NOT NULL', col.nullable === 'NO', col.nullable);
    check('3b and defaults to not_recorded', /not_recorded/.test(col.dflt || ''), col.dflt);
    const nulls = await pool.query('SELECT count(*)::int AS n FROM recommendations WHERE confidence_basis IS NULL');
    check('3c no stored card is without a basis', nulls.rows[0].n === 0, String(nulls.rows[0].n));
    const words = await pool.query('SELECT DISTINCT confidence_basis AS b FROM recommendations');
    const foreign = words.rows.map((r) => r.b).filter((b) => !basisLib.isKnownBasis(b));
    check('3d every stored basis is a word the vocabulary has', foreign.length === 0, JSON.stringify(foreign));

    // A sentinel run, so the constraint can be exercised against a real row.
    const run = await pool.query(
      `INSERT INTO recommendation_runs
         (client_id, location_id, generated_at, data_as_of, candidate_count, recommendation_count, dropped_invalid, signal_snapshot)
       VALUES ($1, $2, now(), current_date, 1, 1, 0, '{}'::jsonb) RETURNING id`, [CID, LID]);
    const runId = run.rows[0].id;
    const insertCard = (basisSql, params) => pool.query(
      `INSERT INTO recommendations
         (run_id, client_id, location_id, rank, category, action_type, primary_skus, rationale,
          signals_cited, confidence, valid_through${basisSql.col})
       VALUES ($1, $2, $3, $4, 'inventory_understock', 'reorder', ARRAY['SENTINEL-SKU'], 'sentinel',
               ARRAY[]::text[], 0.6, current_date + 14${basisSql.val}) RETURNING id, confidence_basis`,
      params);

    const defaulted = await insertCard({ col: '', val: '' }, [runId, CID, LID, 1]);
    check('4  a row written without the column lands on the default',
      defaulted.rows[0].confidence_basis === 'not_recorded', JSON.stringify(defaulted.rows[0]));
    let refused = false;
    try {
      await insertCard({ col: ', confidence_basis', val: ', $5' }, [runId, CID, LID, 2, null]);
    } catch (err) {
      refused = /null value|not-null/i.test(err.message);
    }
    check('4b an EXPLICIT NULL is refused by the column - which is why persistRun coerces first', refused);

    console.log('\n── The gate records what it did not apply (migration 041) ─');
    const card = { id: defaulted.rows[0].id, rank: 1, action_type: 'reorder', category: 'inventory_understock',
      confidence: 0.6, confidence_basis: 'raw_ranking_score', primary_skus: ['SENTINEL-SKU'], suggested_order_qty: 5,
      products: [{ sku: 'SENTINEL-SKU', product_name: 'Sentinel', price: 30, cost: 18, stock_qty: 10 }] };
    const quality = { verdict: 'pass', unavailable_fields: [], never_synced: false };
    const admission = gate.applyAdmission([card], quality, {});
    check('5  the shown card carries admission_notes naming the skipped floor',
      admission.visible.length === 1
        && admission.visible[0].admission_notes.includes('confidence_floor_not_applicable:raw_ranking_score'),
      JSON.stringify(admission.visible[0] && admission.visible[0].admission_notes));
    await gate.recordAdmissions(pool, CID, LID, null, admission.decisions);
    const stored = await pool.query(
      'SELECT visible, reasons, notes FROM recommendation_admission WHERE rec_id=$1', [card.id]);
    check('5b the audit row stores the note under notes, with reasons still empty',
      stored.rowCount === 1 && stored.rows[0].visible === true
        && stored.rows[0].reasons.length === 0
        && stored.rows[0].notes.includes('confidence_floor_not_applicable:raw_ranking_score'),
      JSON.stringify(stored.rows));
  } finally {
    await cleanup(pool);
    await pool.end();
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
