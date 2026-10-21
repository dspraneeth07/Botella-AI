-- Sheet 19 — the outcome feedback loop. Shown and withheld alike.
--
-- NOTHING IN THE ARCHITECTURE IMPROVES WITHOUT THIS TABLE.
--   Calibration (08) needs outcomes to fit a curve. The shrinkage constant k
--   (06) needs outcomes to be fitted from. The gate (17) needs outcomes to
--   judge. Cohort priors (05) need outcomes to sharpen. Every PROVISIONAL
--   setting in the registry stays provisional until this loop has run.
--
-- THE WITHHELD ARM IS THE ENTIRE POINT.
--   A row is written for every recommendation the engine produced, whether the
--   store saw it or not. Without the withheld arm we measure FORECASTING - did
--   the number we predicted come true. With it we measure CAUSATION - did
--   telling them change what happened. Our only existing evidence is a
--   retrospective backtest for exactly this reason.
--
--   So `arm` is NOT NULL and has no default. A row that cannot say which arm
--   it belongs to is not an outcome, it is a sales figure.
--
-- EVERY ROW CARRIES ITS VERSIONS.
--   model_version, feature_version, config_version and snapshot_id are what
--   make an outcome replayable: "this decision was made by that model, on that
--   feature definition, under that config, over that snapshot". A row without
--   them can be counted but not explained, and an unexplainable outcome cannot
--   be used to change a threshold - which is the only thing outcomes are for.

CREATE TABLE IF NOT EXISTS recommendation_outcomes (
  id              bigserial PRIMARY KEY,

  -- What was recommended, and to whom.
  recommendation_id bigint  NOT NULL,
  client_id       integer   NOT NULL,
  location_id     integer   NOT NULL,
  sku             text      NOT NULL,
  family          text      NOT NULL,

  -- THE ARM. No default: a row that cannot say which side it is on is not an
  -- outcome. The CHECK stops a third value appearing and silently splitting
  -- the population three ways.
  arm             text      NOT NULL CHECK (arm IN ('shown', 'withheld')),

  -- What we asked for, what they bought, what sold.
  --
  -- All three NULLABLE, and they mean different things: a NULL
  -- actual_purchased_qty is "no purchase-order data for this store", not "they
  -- bought none". 429,690 purchase rows exist across 682 suppliers but not for
  -- every store, and a zero here would read as a store ignoring every
  -- recommendation.
  recommended_qty      numeric,
  actual_purchased_qty numeric,
  actual_units_sold    numeric,

  -- The window this was measured over. OPEN days, because Bethany closes
  -- Sundays plus three holidays - 200 closed days of 1,360 - and a
  -- calendar-day denominator understates its every rate by 21.7%.
  window_start      date    NOT NULL,
  window_end        date    NOT NULL,
  open_days_in_window integer NOT NULL,
  -- The trailing window the baseline came from, in open days too. Stored
  -- because a lift cannot be recomputed from the row without it.
  baseline_open_days  integer,
  baseline_units      numeric,

  -- THE one definition (backend/lib/lift.js). NULL means UNMEASURABLE and
  -- never "no effect"; `lift_reason` says which.
  lift            numeric,
  lift_reason     text,
  expected_units  numeric,
  upside_units    numeric,

  -- Both confidences, so calibration can fit one against the other. Keeping
  -- only the calibrated one would destroy the very pairing sheet 08 needs.
  stated_confidence     numeric,
  calibrated_confidence numeric,

  -- The evidence behind the decision, as sheet 06 weighted it.
  evidence_state  text,
  own_weight      numeric,
  cohort_level    text,
  cohort_size     integer,

  -- What produced it. See the note above.
  model_version   text,
  feature_version text,
  config_version  text,
  snapshot_id     text,

  scored_at       timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- One outcome per recommendation per measurement window. Re-scoring the same
  -- window updates in place rather than accumulating duplicates that would
  -- each be counted as independent evidence by the gate.
  UNIQUE (recommendation_id, window_start, window_end)
);

-- The gate's read: every scored outcome for one store-family, both arms.
CREATE INDEX IF NOT EXISTS idx_outcomes_gate
  ON recommendation_outcomes (client_id, location_id, family, window_end DESC);

-- Calibration's read: stated against actual, across the estate.
CREATE INDEX IF NOT EXISTS idx_outcomes_calibration
  ON recommendation_outcomes (family, window_end DESC)
  WHERE stated_confidence IS NOT NULL AND lift IS NOT NULL;

-- The honesty check: shown vs withheld for one store-family.
CREATE INDEX IF NOT EXISTS idx_outcomes_arm
  ON recommendation_outcomes (client_id, location_id, family, arm);

COMMENT ON TABLE recommendation_outcomes IS
  'Sheet 19. One row per recommendation per measurement window, SHOWN AND '
  'WITHHELD ALIKE. The withheld arm is what turns forecasting into causation. '
  'Feeds the feature store (03), cohort priors (05), the shrinkage constant k '
  '(06), calibration (08) and the gate (17).';

COMMENT ON COLUMN recommendation_outcomes.lift IS
  'THE one definition - backend/lib/lift.js and app/pipeline/outcomes/lift.py, '
  'pinned to each other by tests/lift-parity-verify.js. NULL is UNMEASURABLE, '
  'never "no effect".';
