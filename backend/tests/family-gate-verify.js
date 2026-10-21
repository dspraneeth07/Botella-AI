#!/usr/bin/env node
/**
 * Sheet 17 — the gate, on the Node side.
 *
 * The statistics live in Python (`app/pipeline/gate/`). This verifies the half
 * Node owns: the table, the persistence, and the serving rule.
 *
 * The rule that matters most is FAIL CLOSED. Every store-family starts with no
 * row, so a gate that fails open on a missing row is a gate that never does
 * anything at all.
 *
 * Run:  node tests/family-gate-verify.js
 */

require('dotenv').config();

const { getAnalyticsPool } = require('../database/analytics-connection');
const gate = require('../services/familyGateService');

const CID = 999917;
const LID = 990017;

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const rec = (family, rank = 1) => ({
  id: rank, rank, action_type: family, category: 'inventory_overstock',
  primary_skus: ['SKU1'], rationale: 'x',
});

(async () => {
  const pool = getAnalyticsPool();
  gate._resetProbe();

  console.log('\n── The table exists and constrains its states ─────────────');

  check('1  recommendation_family_gate exists (migration 019)',
    await gate.gateTableExists(pool),
    'run: npm run migrate');

  let rejected = false;
  try {
    await pool.query(
      `INSERT INTO recommendation_family_gate (client_id, location_id, family, state)
       VALUES ($1, $2, 'bogus_family', 'not_a_state')`,
      [CID, LID]
    );
  } catch { rejected = true; }
  check('2  a fourth state cannot be written (CHECK constraint)', rejected,
    'a typo in a writer must not create a state the serving path fails open on');

  await pool.query(
    'DELETE FROM recommendation_family_gate WHERE client_id = $1 AND location_id = $2',
    [CID, LID]
  );

  console.log('\n── Fail closed: no row means SHADOW, never live ───────────');

  const empty = await gate.statesForStore(pool, CID, LID);
  check('3  a store with no rows returns an empty map, available=true',
    empty.available && empty.states.size === 0);
  check('4  a missing row is not displayable', !gate.isDisplayable(undefined));
  check('5  an unrecognised state is not displayable',
    !gate.isDisplayable({ state: 'probably_fine' }));
  check('6  shadow and suspended are not displayable',
    !gate.isDisplayable({ state: 'shadow' })
    && !gate.isDisplayable({ state: 'suspended' }));
  check('7  only live is displayable', gate.isDisplayable({ state: 'live' }));

  console.log('\n── Persisting a verdict, exactly as Python computed it ────');

  await gate.recordVerdict(pool, {
    client_id: CID, location_id: LID, family: 'reorder',
    state: 'live', reason: 'beat_the_null', inherited: false, n_outcomes: 42,
    previous: 'shadow',
    evidence: { p_value: 0.0025, observed: 1.8, null_mean: 1.0 },
  });
  await gate.recordVerdict(pool, {
    client_id: CID, location_id: LID, family: 'markdown',
    state: 'shadow', reason: 'not_enough_outcomes', n_outcomes: 4,
  });

  const stored = await gate.statesForStore(pool, CID, LID);
  check('8  both families are stored', stored.states.size === 2);
  check('9  the live family carries its evidence',
    Number(stored.states.get('reorder').p_value) === 0.0025
    && Number(stored.states.get('reorder').n_outcomes) === 42);
  check('10 a transition records what it came from',
    stored.states.get('reorder').previous_state === 'shadow');

  console.log('\n── An unchanged family did not "transition today" ─────────');

  const beforeRow = await pool.query(
    `SELECT state_changed_at FROM recommendation_family_gate
      WHERE client_id=$1 AND location_id=$2 AND family='reorder'`, [CID, LID]
  );
  await new Promise((r) => setTimeout(r, 15));
  await gate.recordVerdict(pool, {
    client_id: CID, location_id: LID, family: 'reorder',
    state: 'live', reason: 'still_beating_the_null', n_outcomes: 43,
    previous: 'live',
    evidence: { p_value: 0.003, observed: 1.7, null_mean: 1.0 },
  });
  const afterRow = await pool.query(
    `SELECT state_changed_at, n_outcomes FROM recommendation_family_gate
      WHERE client_id=$1 AND location_id=$2 AND family='reorder'`, [CID, LID]
  );
  check('11 re-running on an unchanged family does not move state_changed_at',
    String(beforeRow.rows[0].state_changed_at)
      === String(afterRow.rows[0].state_changed_at),
    'otherwise "which families changed today" stops being usable');
  check('12 ...but the evidence is refreshed',
    Number(afterRow.rows[0].n_outcomes) === 43);

  console.log('\n── A real transition IS recorded ─────────────────────────');

  await gate.recordVerdict(pool, {
    client_id: CID, location_id: LID, family: 'reorder',
    state: 'suspended', reason: 'fell_below_the_null', n_outcomes: 50,
    previous: 'live',
    evidence: { p_value: 0.7, observed: 0.6, null_mean: 1.0 },
  });
  const suspended = await pool.query(
    `SELECT state, previous_state, state_changed_at
       FROM recommendation_family_gate
      WHERE client_id=$1 AND location_id=$2 AND family='reorder'`, [CID, LID]
  );
  check('13 the suspension is stored with what it came from',
    suspended.rows[0].state === 'suspended'
    && suspended.rows[0].previous_state === 'live'
    && suspended.rows[0].state_changed_at !== null);

  const transitions = await gate.recentTransitions(pool, { days: 1 });
  check('14 it appears in the transitions report',
    transitions.some((t) => Number(t.client_id) === CID
      && t.family === 'reorder' && t.state === 'suspended'),
    `${transitions.length} transition(s) in the last day`);

  console.log('\n── Serving: withheld, never silently dropped ─────────────');

  const states = (await gate.statesForStore(pool, CID, LID)).states;
  const recs = [rec('reorder', 1), rec('markdown', 2), rec('clear', 3)];

  const enforced = gate.applyGate(recs, states, { enforced: true });
  check('15 a suspended family is withheld', enforced.shown.length === 0,
    `${enforced.shown.length} shown`);
  check('16 every withheld rec carries its state and reason',
    enforced.withheld.length === 3
    && enforced.withheld.every((w) => w.gate_state && w.gate_reason));
  check('17 a family with no row at all is withheld as shadow',
    enforced.withheld.find((w) => w.action_type === 'clear').gate_state === 'shadow');
  check('18 the withheld explanation is owner-readable, not a state name',
    enforced.withheld.every((w) => /recommendation/i.test(w.gate_explanation)));
  check('19 a suspended family says it is PAUSED, not "still measuring"',
    /paused|re-measure/i.test(
      enforced.withheld.find((w) => w.action_type === 'reorder').gate_explanation
    ));

  await gate.recordVerdict(pool, {
    client_id: CID, location_id: LID, family: 'reorder',
    state: 'live', reason: 'beat_the_null', n_outcomes: 60, previous: 'suspended',
    evidence: { p_value: 0.004, observed: 2.0, null_mean: 1.0 },
  });
  const recovered = (await gate.statesForStore(pool, CID, LID)).states;
  const afterRecovery = gate.applyGate(recs, recovered, { enforced: true });
  check('20 suspension is REVERSIBLE - a recovered family is shown again',
    afterRecovery.shown.length === 1
    && afterRecovery.shown[0].action_type === 'reorder');

  console.log('\n── Unenforced: everything shows, and says its state ───────');

  const observing = gate.applyGate(recs, recovered, { enforced: false });
  check('21 with enforcement off nothing is withheld',
    observing.shown.length === 3 && observing.withheld.length === 0);
  check('22 ...but each rec still carries the state it WOULD have had',
    observing.shown.every((r) => typeof r.gate_state === 'string'),
    'so the gate can be watched before it is trusted');

  await pool.query(
    'DELETE FROM recommendation_family_gate WHERE client_id = $1 AND location_id = $2',
    [CID, LID]
  );

  console.log('');
  console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
