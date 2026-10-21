-- ============================================================================
-- 029_signal_effects.sql - let the serving path see what the signals measured
--
-- THE GAP THIS CLOSES
--   The engine gathers five to thirteen live signals per store - home fixtures
--   for four leagues, heat advisories, severe weather, concerts, arts events,
--   social trends - and cited ZERO of them on ZERO cards.
--
--   `cold_box` and `pre_stock` refuse without a measured effect, which is correct
--   (N3.1: a festival is SCHEDULED for a weekend that was going to be busy
--   anyway, so the naive version credits the signal for the weekend). But the
--   measurement happens offline, in `elasticity/signal.py`, against day-of-week,
--   month and trend controls - and there was nowhere to put the answer. No table,
--   no endpoint, nothing in `app/recommender` that reads one. So the families
--   refused unconditionally, forever, at every store.
--
--   This is the same shape as migrations 023 (the store gate verdict) and 024
--   (the calibration bundle): a figure that can only be measured over accumulated
--   history, published once, and read back by primary key at decision time.
--
-- WHY EVERY ROW, INCLUDING THE REFUSALS
--   A refused cell is the more common answer and the more useful one. Measured
--   over 504 (store x signal x category) cells, 499 were refused and 5 earned a
--   beta. Storing only the five would leave nobody able to answer "did you look
--   at sports, and what did you find" - which is the question an owner asks first
--   when a card does NOT mention the game tonight.
--
--   So `beta` is NULL and `refused_reason` is set for a refusal, and the
--   `usable` column is GENERATED from the same rule `SignalEffectResult.usable`
--   applies in Python: an estimate with an interval that spans zero may not be
--   cited, because an effect that might be negative is not an effect.
--
-- A NEGATIVE BETA IS A RESULT, NOT A FAILURE
--   Marshfield's only usable weather effect is beer FALLING 11.8% in a cold snap.
--   That is worth storing and worth acting on - it says do not pre-stock, and do
--   not read the subsequent dip as something to recover from. The CHECK below
--   bounds the magnitude, never the sign.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS signal_effects (
  id                bigserial   PRIMARY KEY,
  client_id         integer     NOT NULL,
  location_id       integer     NOT NULL,

  -- The cell. `category_family` is the TAXONOMY family (beer / wine / spirits /
  -- seltzer...), not the POS category string: the estimate is fitted on the
  -- family because a per-POS-category fit splits the same product line across
  -- half a dozen spellings and then refuses all of them for too few days.
  signal_key        text        NOT NULL,
  category_family   text        NOT NULL,

  -- The SHRUNK estimate - what a card may cite - and the store's own number
  -- before shrinkage, so a reader can see what this store's data said alone.
  beta              numeric,
  own_beta          numeric,
  interval_lo       numeric,
  interval_hi       numeric,
  own_weight        numeric,

  observations      integer     NOT NULL DEFAULT 0,
  active_days       integer     NOT NULL DEFAULT 0,

  -- Non-null exactly when nothing may be cited. The reason is the point.
  refused_reason    text,
  -- How it was estimated and against which controls. Travels onto the card,
  -- because confounding here runs TOWARD finding an effect.
  basis             text        NOT NULL DEFAULT '',

  -- The window the fit covers, so a stale effect is visibly stale rather than
  -- quietly current.
  fit_from          date,
  fit_to            date,
  fitted_at         timestamptz NOT NULL DEFAULT now(),

  -- MAY A CARD CITE THIS? Generated, not supplied, so the serving path and the
  -- estimator cannot disagree about it. Same rule as
  -- `SignalEffectResult.usable`: refused_reason is null, beta exists, and the
  -- interval does not span zero.
  usable            boolean     GENERATED ALWAYS AS (
                      refused_reason IS NULL
                      AND beta IS NOT NULL
                      AND interval_lo IS NOT NULL
                      AND interval_hi IS NOT NULL
                      AND (interval_lo > 0 OR interval_hi < 0)
                    ) STORED,

  -- A proportional effect. 0.22 is "about 22% more units while this signal is
  -- active". Bounded in MAGNITUDE only: the sign carries real information.
  CONSTRAINT signal_effects_beta_plausible CHECK (
    beta IS NULL OR (beta > -1.0 AND beta < 5.0)
  ),
  CONSTRAINT signal_effects_interval_ordered CHECK (
    interval_lo IS NULL OR interval_hi IS NULL OR interval_lo <= interval_hi
  ),
  CONSTRAINT signal_effects_counts_nonneg CHECK (
    observations >= 0 AND active_days >= 0 AND active_days <= observations
  )
);

-- ONE ROW PER CELL. The publisher upserts, so re-running a fit corrects the
-- estimate rather than accumulating copies of it - which is what migration 026
-- had to go back and fix for `signal_history` after a missing unique index made
-- its ON CONFLICT a silent no-op and a re-run doubled every row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_effects_cell
  ON signal_effects (client_id, location_id, signal_key, category_family);

-- The serving read: every usable effect for one store, in one query.
CREATE INDEX IF NOT EXISTS idx_signal_effects_serving
  ON signal_effects (client_id, location_id) WHERE usable;

COMMENT ON TABLE signal_effects IS
  'Measured effect of each external signal on each drink family, per store, '
  'fitted offline against day-of-week / month / trend controls by '
  'app/pipeline/elasticity/signal.py and read back at decision time by the '
  'cold_box and pre_stock families. Refusals are stored too: 499 of 504 cells '
  'refused on the first estate-wide fit, and "we looked at sports and the data '
  'cannot tell" is the answer to the question an owner asks when a card does not '
  'mention tonight''s game.';

COMMENT ON COLUMN signal_effects.usable IS
  'Generated, never supplied. A card may cite this only when the estimate exists '
  'and its interval excludes zero - an effect that might be negative is not an '
  'effect. Keeping the rule in the column stops the serving path and the '
  'estimator from drifting apart on it.';

COMMENT ON COLUMN signal_effects.beta IS
  'Proportional and SHRUNK toward the cohort where a peer estimate existed. '
  'NEGATIVE IS VALID AND VALUABLE: Marshfield''s only usable weather effect is '
  'beer falling 11.8% in a cold snap, which says do not pre-stock and do not '
  'read the dip afterwards as something to recover.';

COMMENT ON COLUMN signal_effects.refused_reason IS
  'Why no card may cite this cell - too few days, too few ACTIVE days, an '
  'interval spanning zero, an implausible magnitude. Non-null exactly when '
  'usable is false.';

COMMIT;

-- ── Rollback ─────────────────────────────────────────────────────────────────
-- BEGIN;
-- DROP INDEX IF EXISTS idx_signal_effects_serving;
-- DROP INDEX IF EXISTS idx_signal_effects_cell;
-- DROP TABLE IF EXISTS signal_effects;
-- COMMIT;
