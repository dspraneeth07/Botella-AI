-- Sheet 17 — the STORE-level gate verdict, so the serving path can read it.
--
-- WHY THIS TABLE EXISTS
--   `recommendation_family_gate` (019) answers "has this FAMILY worked at this
--   store". This one answers a different question: "has the engine as a whole
--   been shown to work here, on accuracy AND on money". Both gates must hold
--   before a store's cards are displayed, and they fail for different reasons.
--
--   Until this table existed the store verdict was computed inside `scripts/`,
--   which the deployed application cannot import. The verdict existed, an audit
--   page published it, and the engine it was a verdict ABOUT had no way of
--   reading it. That is the gap this closes.
--
-- WHY A TABLE AND NOT A COMPUTATION AT SERVE TIME
--   Gate A needs a store's expected calibration error, its interval coverage and
--   its worst reliability bin; Gate B needs a month of net margin. Every one of
--   those is an aggregate over accumulated OUTCOMES, which is batch work over the
--   ledger and far too slow for a page load. So the inputs are measured offline
--   and only the verdict is read when serving — the same split 019 uses, and the
--   reason `scripts/_gate_inputs.py` correctly stays in scripts/.
--
-- THE THREE-WAY STATE IS DELIBERATE, AND `measured` IS THE IMPORTANT COLUMN
--   A store that has been measured and failed is an instruction to withhold
--   cards. A store nobody has measured yet is an ABSENCE, and a serving path that
--   treats the second as the first withholds every card at every store the moment
--   it starts honouring the flag — which is how a rollout goes dark. Both are
--   `shadow`, so the state alone cannot be trusted; `measured` is what separates
--   them, and a reader honours `displayed` only where `measured` is true.
--
-- WHY THE INPUTS ARE STORED AND NOT ONLY THE VERDICT
--   "DO NOT SHIP" with no numbers is the kind of refusal nobody can act on. Every
--   measured input that produced the verdict is kept beside it, so "why is this
--   store not showing cards" has an answer that does not require re-running a
--   month of ledger.

CREATE TABLE IF NOT EXISTS store_gate_verdict (
  client_id   integer NOT NULL,
  location_id integer NOT NULL,

  -- shadow | live | suspended. Written verbatim from Python's GateState, and
  -- constrained here so a typo in a writer cannot create a fourth state that the
  -- serving path then fails open on. Same vocabulary as 019, on purpose: Node
  -- persists one set of strings for both gates.
  state       text    NOT NULL DEFAULT 'shadow'
              CHECK (state IN ('shadow', 'live', 'suspended')),

  -- Which checks failed, or 'both_gates_hold'. Human-readable because it is read
  -- by humans asking why.
  reason      text    NOT NULL DEFAULT 'no_gate_inputs:none_supplied',

  -- FALSE when no check produced a verdict at all. The column that stops an
  -- unmeasured store being mistaken for a failing one.
  measured    boolean NOT NULL DEFAULT false,

  -- TRUE only when both gates hold. Stored rather than derived so the serving
  -- path never re-implements the rule.
  displayed   boolean NOT NULL DEFAULT false,

  -- ── The measured inputs, kept so a verdict can be argued with ────────────
  -- All nullable: an unmeasured input is NULL, never 0.0. A zero reads as a
  -- measurement somebody made, and this engine has twice been bitten by a falsy
  -- zero standing in for an absence.
  promise_fill_ratio      numeric,   -- percent delivered of promised
  ece_points              numeric,   -- expected calibration error, out of sample
  worst_bin_points        numeric,
  interval_coverage       numeric,   -- percent, worst of four horizons
  net_margin_month        numeric,
  backtest_edge           numeric,
  backtest_p_value        numeric,
  -- Denominators. A rate without its sample size cannot be told from noise, and
  -- a store once failed a coverage check by 0.05 standard errors for want of one.
  cards                   integer,
  priced_cards            integer,
  calibration_scored      integer,
  calibration_fitted      integer,
  interval_considered     integer,

  -- The month the inputs were measured over, so a stale verdict is visible as
  -- stale rather than silently trusted.
  measured_for_month      text,
  evaluated_at            timestamptz NOT NULL DEFAULT now(),

  -- The state this replaced, and when. A store that was live for a quarter and is
  -- now shadow is a different conversation from one that never left shadow.
  previous_state          text,
  state_changed_at        timestamptz,

  PRIMARY KEY (client_id, location_id)
);

COMMENT ON TABLE store_gate_verdict IS
  'Sheet 17 store-level gate. Inputs measured offline from the ledger; the '
  'verdict is read on the request path. Honour `displayed` only where '
  '`measured` is true - an unmeasured store is an absence, not a failure.';

COMMENT ON COLUMN store_gate_verdict.measured IS
  'FALSE means no check produced a verdict. Both an unmeasured and a failing '
  'store read state=shadow, and conflating them takes every store dark.';

CREATE INDEX IF NOT EXISTS store_gate_verdict_displayed_idx
  ON store_gate_verdict (client_id, location_id)
  WHERE displayed;
