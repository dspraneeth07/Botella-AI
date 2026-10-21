-- ============================================================================
-- 039_fulfilment_state.sql - whether the store actually followed a card, as a
--                            state the DATA decides, not a button the owner
--                            clicked
-- ============================================================================
-- DATABASE: bottleai_analytics  (applied by database/migrate.js - see 001.)
--
-- THE DEFECT
--
--   "Completed" was a browser-side click. The Recommendations home kept its
--   Open / Accepted / Completed tabs in localStorage (botella_rec_status_v1),
--   so a card read COMPLETED the moment the owner pressed "Mark complete" -
--   in that browser, on that device, whatever the shelf did afterwards. The
--   click did reach the server as action_claim = 'did' (migration 004), and
--   the evaluator then used that claim to FILL action_taken wherever no
--   detector had spoken, which fed the final score and the verdict. So the
--   Effectiveness screen's "you acted on N" counted owner memory alongside
--   purchase orders, and nothing in the schema could tell the two apart:
--   `recommendations` had action_claim (what the owner said) and
--   `recommendation_evaluations` had action_taken (what the detectors saw or
--   the claim filled), and no column said which one a given row rested on.
--
--   The requirement is the opposite: a card is COMPLETED only when database
--   evidence shows the owner followed it - a purchases-feed row, a matched
--   invoice line, an attributable stock inflow, a price drop, a catalogue
--   arrival. The owner's click is a CLAIM, shown as a claim, until the data
--   confirms or refutes it.
--
-- WHAT THIS ADDS, on `recommendations` (one row per card - the state belongs
-- to the card, not to any one evaluation window)
--
--   fulfilment_state      the machine's answer, one of:
--     pending        nothing decisive yet, and nothing claimed
--     claimed        the owner said 'did'; no detector has confirmed it (yet,
--                    or ever, for a shelf-floor action no feed can see)
--     confirmed      a detector with real rows said TRUE. Never from an owner
--                    report. Terminal: later evaluations may add evidence but
--                    never take this away - a PO that happened still happened
--     not_followed   a detector with FULL visibility said FALSE and the window
--                    the decision is taken on has closed (or valid_through has
--                    passed). An owner's 'did' does NOT override this; the
--                    evidence then records both - "you said done; the data
--                    shows no order" - and the UI shows both
--     unobservable   endcap / cold box / promote / bundle: the detectors
--                    cannot see it and the owner has not claimed it
--     expired        valid_through passed with nothing seen and nothing said
--   fulfilment_evidence   jsonb: which detector decided, the rows that decided
--                         it (feed units and days, invoice ids and numbers,
--                         the snapshot delta and threshold, the two prices,
--                         the registry arrival), the window it was judged on,
--                         the frontier it was judged at, and the claim if any
--   fulfilment_confirmed_at  first time the state became confirmed; stays put
--   fulfilment_checked_at    last time the machine looked at this card
--   dismiss_reason           the owner's reason for a dismissal ("Wrong
--                            product", "Disagree with the rationale") - the
--                            most useful feedback an owner produces, and until
--                            now it never left the browser (recStatus.js said
--                            so in its own header)
--
--   and on `po_recommendation_outcomes` (005), `acted_reason` - because that
--   sibling ledger wrote acted = false for a store whose POS has never synced
--   a single purchase row, which reads "ignored every suggestion" when the
--   truth is "we cannot see orders here". NULL with a reason, from now on.
--
-- WHAT THIS DOES NOT CHANGE
--
--   action_claim / action_claim_at stay exactly as 004 defined them; the claim
--   is still recorded, it just no longer fills action_taken. The CHECK on
--   action_claim is untouched: a retraction is written as NULL, not as a
--   fourth value. recommendation_evaluations.action_taken keeps its tri-state
--   meaning and from this migration on means only what detectors saw.
--
-- GRANTS
--
--   New columns inherit the table-level grants. 000_base_tables.sql grants
--   SELECT, INSERT, UPDATE, DELETE ON recommendations TO bottleai_writer
--   (line ~203), and 005 grants SELECT, INSERT, UPDATE on
--   po_recommendation_outcomes - verified against the live role_table_grants
--   before this file was written. No new GRANT is needed, and none is written,
--   following 004's note for the same table.
--
-- BACKFILL
--
--   None, deliberately. Every existing row takes the default 'pending' and is
--   re-stated by the next evaluation pass (nightly cron, or POST /evaluate
--   with force). Deriving a state here from action_claim alone would mint
--   exactly the owner-reported "confirmed" this migration exists to end;
--   deriving it from recommendation_evaluations would duplicate the machine
--   in SQL and the two would drift. The read paths carry a documented
--   fallback for rows still at the default (recommendationEvalService
--   .effectiveFulfilment), so the report does not go dark in between.
-- ============================================================================

BEGIN;

ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS fulfilment_state text NOT NULL DEFAULT 'pending'
    CHECK (fulfilment_state IN ('pending', 'claimed', 'confirmed', 'not_followed',
                                'unobservable', 'expired')),
  ADD COLUMN IF NOT EXISTS fulfilment_evidence     jsonb,
  ADD COLUMN IF NOT EXISTS fulfilment_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS fulfilment_checked_at   timestamptz,
  ADD COLUMN IF NOT EXISTS dismiss_reason          text;

COMMENT ON COLUMN recommendations.fulfilment_state IS
  'Whether the store followed this card, decided by the DATA: pending | claimed '
  '(owner said did, nothing confirms it) | confirmed (a detector saw rows: '
  'purchases feed, matched invoice, attributable stock inflow, price drop, '
  'catalogue arrival - never an owner report) | not_followed (full-visibility '
  'detector said false and the window closed; an owner claim does not override) '
  '| unobservable (shelf-floor action, no claim) | expired (valid_through passed, '
  'nothing seen, nothing said). confirmed is never downgraded.';
COMMENT ON COLUMN recommendations.fulfilment_evidence IS
  'Which detector decided, the rows that decided it (units and days from the '
  'feed, invoice ids and numbers, the snapshot delta and threshold, the two '
  'prices, the registry arrival), the window it was judged on, the frontier it '
  'was judged at, and the owner claim if any.';
COMMENT ON COLUMN recommendations.fulfilment_confirmed_at IS
  'First instant fulfilment_state became confirmed. Kept when later passes add '
  'evidence; a confirmation is not re-dated.';
COMMENT ON COLUMN recommendations.fulfilment_checked_at IS
  'Last instant the fulfilment machine looked at this card.';
COMMENT ON COLUMN recommendations.dismiss_reason IS
  'The owner''s own reason for dismissing (or, for "Already done", claiming) '
  'this card. Free text from a fixed menu; feedback about the engine, kept.';

-- The Recommendations home splits one store's cards by state on every load,
-- and the effectiveness summary counts them the same way.
CREATE INDEX IF NOT EXISTS idx_recommendations_fulfilment
  ON recommendations (client_id, location_id, fulfilment_state);

-- The PO-suggestion ledger (005) may not exist in every environment; the
-- service probes for it, so the column rides the same condition.
DO $$
BEGIN
  IF to_regclass('public.po_recommendation_outcomes') IS NOT NULL THEN
    ALTER TABLE po_recommendation_outcomes
      ADD COLUMN IF NOT EXISTS acted_reason text;
    COMMENT ON COLUMN po_recommendation_outcomes.acted_reason IS
      'Why acted is NULL: the store had no purchases rows at all in the '
      'evaluation period, so absence of an order is not evidence of inaction. '
      'NULL when acted is true or false.';
  END IF;
END $$;

COMMIT;

-- ── Verify ───────────────────────────────────────────────────────────────────
-- SELECT fulfilment_state, count(*) FROM recommendations GROUP BY 1;
--   -- all 'pending' until the next evaluation pass re-states them
-- SELECT has_table_privilege('bottleai_writer','recommendations','UPDATE');  -- t
-- SELECT indexname FROM pg_indexes WHERE indexname = 'idx_recommendations_fulfilment';
--
-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS idx_recommendations_fulfilment;
-- ALTER TABLE recommendations
--   DROP COLUMN IF EXISTS fulfilment_state, DROP COLUMN IF EXISTS fulfilment_evidence,
--   DROP COLUMN IF EXISTS fulfilment_confirmed_at, DROP COLUMN IF EXISTS fulfilment_checked_at,
--   DROP COLUMN IF EXISTS dismiss_reason;
-- ALTER TABLE po_recommendation_outcomes DROP COLUMN IF EXISTS acted_reason;
