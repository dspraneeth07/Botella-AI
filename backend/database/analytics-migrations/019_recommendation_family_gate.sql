-- Sheet 17 — the gate. Per store, per family: has this actually worked HERE?
--
-- A recommendation family is shown at a store only once it has beaten a
-- volume-matched null AT THAT STORE. Until then it runs in shadow: computed,
-- stored, scored, NOT displayed.
--
-- WHY A TABLE AND NOT A COMPUTATION AT SERVE TIME
--   The verdict is a randomisation test over 400 matched baskets. That is
--   cheap daily and far too slow on a page load, so the state is computed on a
--   schedule and READ when serving. Node owns this table; the statistics live
--   in `app/pipeline/gate/` on the Python side, and are not reimplemented here
--   - two implementations of one rule is how an estate ends up with two
--   answers (the 454-vs-485 lesson from sheet 03).
--
-- WHY THE EVIDENCE IS STORED ALONGSIDE THE STATE
--   "not shown" with no reason is the kind of refusal nobody can act on. A row
--   carries the p-value, the observed and null means, and the outcome count
--   that produced it, so "why is my markdown family not showing" has an answer
--   that does not require re-running anything.

CREATE TABLE IF NOT EXISTS recommendation_family_gate (
  client_id   integer NOT NULL,
  location_id integer NOT NULL,
  -- The action_type family: reorder, markdown, clear, ...
  family      text    NOT NULL,

  -- shadow | live | suspended. Written verbatim from Python's GateState, and
  -- constrained here so a typo in a writer cannot silently create a fourth
  -- state that the serving path then fails open on.
  state       text    NOT NULL DEFAULT 'shadow'
              CHECK (state IN ('shadow', 'live', 'suspended')),
  reason      text    NOT NULL DEFAULT 'not_enough_outcomes',

  -- TRUE when this state came from the cohort rather than this store's own
  -- outcomes. A new store is not left in shadow for a quarter, and is not
  -- trusted on zero evidence either - so which it is must be visible.
  inherited   boolean NOT NULL DEFAULT false,

  n_outcomes  integer NOT NULL DEFAULT 0,
  p_value     numeric,
  observed    numeric,
  null_mean   numeric,

  -- The state this replaced, and when. A family that was live for three
  -- months and is now suspended is a different conversation from one that was
  -- never proven, and that difference is only visible if the previous state
  -- survives the update.
  previous_state text,
  state_changed_at timestamptz,

  evaluated_at timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (client_id, location_id, family)
);

-- The serving path asks one question: which families may this store see? It
-- asks it on every page load, so it gets its own index.
CREATE INDEX IF NOT EXISTS idx_family_gate_live
  ON recommendation_family_gate (client_id, location_id)
  WHERE state = 'live';

-- "Which families changed state today" - the report that tells somebody a
-- store stopped working, which is the whole point of `suspended` being a
-- distinct state.
CREATE INDEX IF NOT EXISTS idx_family_gate_transitions
  ON recommendation_family_gate (state_changed_at DESC)
  WHERE state_changed_at IS NOT NULL;

COMMENT ON TABLE recommendation_family_gate IS
  'Sheet 17. Per (store, family) display gate. shadow until the family beats a '
  'volume-matched null AT THIS STORE; suspended if it later falls below it. '
  'Computed by app/pipeline/gate on the Python side; this table only stores '
  'the verdict and the evidence behind it.';
