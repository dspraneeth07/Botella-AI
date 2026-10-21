-- ============================================================================
-- 028_recommendation_decision_figures.sql - the figures that were computed and
-- then thrown away twice
--
-- WHAT WAS WRONG
--   Six months of work added decision figures to the card: the store gate's
--   verdict (sheet 17), the two-sided predictive range, the promise floor
--   (N1.1), the cost of being wrong (N0.1), the calibration basis (sheet 08),
--   and the slate's cash budget (N7.1). Every one of them was computed
--   correctly, unit-tested, and then DISCARDED - twice over, at two allow-lists
--   neither of which logs a drop:
--
--     1. Python's `Recommendation` model sets no `model_config`, so pydantic's
--        default `extra="ignore"` applied and `model_validate` silently removed
--        every key the model did not declare.
--     2. This table's INSERT in recommendationService.js names its columns
--        explicitly, so even once the response carried them there was nowhere
--        to put them.
--
--   The unit tests passed throughout, because they assert on the dict the card
--   builder RETURNS - one layer above the boundary that threw it away. A card an
--   owner could actually see carried none of it.
--
-- WHY THE FIGURES BELONG IN THE ROW AND NOT IN A LOOKUP
--   Every one of them is a DECISION-TIME fact. A stock level read a week later
--   is not the one the decision was taken on; a gate verdict recomputed next
--   month is not the one that let the card through; a budget re-derived from
--   today's settings is not the one the slate was fitted to. Migration 022 made
--   this argument for the engine's rate and it is the same argument here.
--
--   The outcome evaluator needs them too. Coverage of the predictive range and
--   whether the promise floor held are both checks AGAINST the stated claim, and
--   a claim nobody recorded cannot be checked - which is precisely how
--   `promise_kept` came to be measured against a figure that was never stored.
--
-- EVERYTHING NULLABLE, NO BACKFILL, AND ABSENCE IS NOT ZERO
--   Rows from the LLM path have no engine figures. A store whose POS sends no
--   unit cost has no holding cost and no budget - there is nothing to allocate.
--   A card whose interval was refused carries the REASON in
--   expected_range_refused and a NULL range, which is a different fact from
--   "no interval was attempted". A zero in any of these columns would be read as
--   a measured zero: a zero holding cost says being wrong is free, and a zero
--   budget says the store has no cash.
--
-- THE PER-CARD DUPLICATION OF THE BUDGET IS DELIBERATE
--   portfolio_* is identical for every row of a run. It is stored per row anyway
--   because a card is the unit that TRAVELS: one gets voted on, screenshotted,
--   forwarded, and read six weeks later with no run attached. A card stating
--   that it commits $340 of a $2,000 ASSUMED budget can be argued with; the same
--   card with the budget held somewhere else cannot.
-- ============================================================================

BEGIN;

ALTER TABLE recommendations
  -- Sheet 17. gate_measured FALSE means no verdict was computed for the store,
  -- which is an absence and NOT an instruction to withhold - a consumer that
  -- treats an unmeasured store as a failing one goes dark across the estate.
  ADD COLUMN IF NOT EXISTS gate_state                   text,
  ADD COLUMN IF NOT EXISTS gate_reason                  text,
  ADD COLUMN IF NOT EXISTS gate_displayed               boolean,
  ADD COLUMN IF NOT EXISTS gate_measured                boolean,

  -- The two-sided predictive range: the claim the gate's coverage check tests.
  ADD COLUMN IF NOT EXISTS expected_range_low           numeric,
  ADD COLUMN IF NOT EXISTS expected_range_high          numeric,
  ADD COLUMN IF NOT EXISTS expected_range_coverage      numeric,
  ADD COLUMN IF NOT EXISTS expected_range_basis         text,
  ADD COLUMN IF NOT EXISTS expected_range_refused       text,

  -- N1.1. A floor on the TOTAL, which is the only form the arithmetic permits.
  ADD COLUMN IF NOT EXISTS promise_floor_units          numeric,
  ADD COLUMN IF NOT EXISTS promise_floor_coverage       numeric,
  ADD COLUMN IF NOT EXISTS promise_floor_basis          text,
  ADD COLUMN IF NOT EXISTS promise_floor_refused        text,
  ADD COLUMN IF NOT EXISTS increment_promise_basis      text,

  -- N0.1. What being wrong costs, in money.
  ADD COLUMN IF NOT EXISTS holding_cost_if_unsold       numeric,
  ADD COLUMN IF NOT EXISTS holding_cost_basis           text,

  -- Sheet 08. `confidence` is the CALIBRATED figure where a curve exists; these
  -- say which it is and what the raw score was.
  ADD COLUMN IF NOT EXISTS confidence_basis             text,
  ADD COLUMN IF NOT EXISTS confidence_raw               real,

  -- N7.1. The budget the slate was chosen under.
  ADD COLUMN IF NOT EXISTS portfolio_cash_committed     numeric,
  ADD COLUMN IF NOT EXISTS portfolio_cash_budget        numeric,
  ADD COLUMN IF NOT EXISTS portfolio_units_committed    numeric,
  ADD COLUMN IF NOT EXISTS portfolio_shelf_budget_units numeric,
  ADD COLUMN IF NOT EXISTS portfolio_coverage           integer,
  ADD COLUMN IF NOT EXISTS portfolio_offered            integer,
  ADD COLUMN IF NOT EXISTS portfolio_assumptions        text[];

-- Non-negativity where the quantity is an amount rather than a position. Not
-- NOT NULL: every one of these is legitimately absent. A negative holding cost
-- or a negative budget is a bug upstream, and a constraint is how it surfaces as
-- a failed write instead of a plausible-looking number on a card.
ALTER TABLE recommendations
  ADD CONSTRAINT recommendations_decision_figures_nonneg CHECK (
    (expected_range_low IS NULL OR expected_range_low >= 0)
    AND (expected_range_high IS NULL OR expected_range_high >= 0)
    AND (promise_floor_units IS NULL OR promise_floor_units >= 0)
    AND (holding_cost_if_unsold IS NULL OR holding_cost_if_unsold >= 0)
    AND (portfolio_cash_committed IS NULL OR portfolio_cash_committed >= 0)
    AND (portfolio_cash_budget IS NULL OR portfolio_cash_budget >= 0)
    AND (portfolio_units_committed IS NULL OR portfolio_units_committed >= 0)
    AND (portfolio_coverage IS NULL OR portfolio_coverage >= 0)
    AND (portfolio_offered IS NULL OR portfolio_offered >= 0)
  ) NOT VALID;

-- NOT VALID, then validated separately: every existing row has NULL in all of
-- these columns so the validation cannot fail, and splitting it keeps the ALTER
-- off an ACCESS EXCLUSIVE lock for the length of a table scan.
ALTER TABLE recommendations
  VALIDATE CONSTRAINT recommendations_decision_figures_nonneg;

-- A range is an interval, so its ends must not cross. Separate from the above
-- because this one is a RELATIONSHIP and would be unreadable folded in.
ALTER TABLE recommendations
  ADD CONSTRAINT recommendations_expected_range_ordered CHECK (
    expected_range_low IS NULL
    OR expected_range_high IS NULL
    OR expected_range_low <= expected_range_high
  ) NOT VALID;

ALTER TABLE recommendations
  VALIDATE CONSTRAINT recommendations_expected_range_ordered;

COMMENT ON COLUMN recommendations.gate_state IS
  'Sheet 17 serving state at decision time (LIVE / SHADOW / ...). NULL on rows '
  'written before the gate reached the serving path.';

COMMENT ON COLUMN recommendations.gate_measured IS
  'TRUE only where a verdict was actually computed for this store. FALSE is an '
  'ABSENCE of measurement, never an instruction to withhold the card.';

COMMENT ON COLUMN recommendations.expected_range_refused IS
  'The NAMED reason no range was stated. "No range" and "a range we declined to '
  'state, because X" are different facts to a reader, and only one of them is a '
  'missing feature.';

COMMENT ON COLUMN recommendations.holding_cost_if_unsold IS
  'What holding the ordered stock costs if the card does NOT work (N0.1): '
  'capital at WACC, shelf opportunity, and a one-off obsolescence hazard. NULL '
  'when the store sends no unit cost - absence, not a free product. Absent by '
  'design on a markdown, which is not buying anything.';

COMMENT ON COLUMN recommendations.confidence_raw IS
  'The engine''s raw ranking score before sheet 08''s curve. `confidence` is the '
  'calibrated figure where a curve exists, and confidence_basis says which of '
  'the two it is - on the first 56 pooled outcomes the raw score stated 0.85-0.97 '
  'and the curve mapped all of those to about 0.65.';

COMMENT ON COLUMN recommendations.portfolio_cash_budget IS
  'The cash the slate ASSUMED the store had this cycle. DECLARED, not measured: '
  'nothing in either database records a store''s free cash, so it is surfaced on '
  'the card for the owner to disagree with. Stored per card because a card '
  'travels alone.';

COMMENT ON COLUMN recommendations.portfolio_assumptions IS
  'The assumptions in the words the owner reads them in. Recorded so that a card '
  'read six weeks later still says what was assumed WHEN IT WAS MADE, rather '
  'than what the settings happen to say now.';

COMMIT;

-- ── Rollback ─────────────────────────────────────────────────────────────────
-- BEGIN;
-- ALTER TABLE recommendations
--   DROP CONSTRAINT IF EXISTS recommendations_expected_range_ordered,
--   DROP CONSTRAINT IF EXISTS recommendations_decision_figures_nonneg;
-- ALTER TABLE recommendations
--   DROP COLUMN IF EXISTS portfolio_assumptions,
--   DROP COLUMN IF EXISTS portfolio_offered,
--   DROP COLUMN IF EXISTS portfolio_coverage,
--   DROP COLUMN IF EXISTS portfolio_shelf_budget_units,
--   DROP COLUMN IF EXISTS portfolio_units_committed,
--   DROP COLUMN IF EXISTS portfolio_cash_budget,
--   DROP COLUMN IF EXISTS portfolio_cash_committed,
--   DROP COLUMN IF EXISTS confidence_raw,
--   DROP COLUMN IF EXISTS confidence_basis,
--   DROP COLUMN IF EXISTS holding_cost_basis,
--   DROP COLUMN IF EXISTS holding_cost_if_unsold,
--   DROP COLUMN IF EXISTS increment_promise_basis,
--   DROP COLUMN IF EXISTS promise_floor_refused,
--   DROP COLUMN IF EXISTS promise_floor_basis,
--   DROP COLUMN IF EXISTS promise_floor_coverage,
--   DROP COLUMN IF EXISTS promise_floor_units,
--   DROP COLUMN IF EXISTS expected_range_refused,
--   DROP COLUMN IF EXISTS expected_range_basis,
--   DROP COLUMN IF EXISTS expected_range_coverage,
--   DROP COLUMN IF EXISTS expected_range_high,
--   DROP COLUMN IF EXISTS expected_range_low,
--   DROP COLUMN IF EXISTS gate_measured,
--   DROP COLUMN IF EXISTS gate_displayed,
--   DROP COLUMN IF EXISTS gate_reason,
--   DROP COLUMN IF EXISTS gate_state;
-- COMMIT;
