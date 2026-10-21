-- ============================================================================
-- Migration 025 — signal_history: which signals were active, per store, per day
-- ============================================================================
-- MOVED FROM database/migrations/ (where it was wrong, and never applied).
--   That directory targets the SYNCGO warehouse, which the application accesses
--   SELECT-only by design and which needs a separate owner DSN to migrate at all.
--   This table is written by NODE into bottleai_analytics, so it belongs here. It
--   had not been applied anywhere, so nothing is being corrected retroactively -
--   but left in place it would either have failed or created a table in a
--   read-only warehouse that Node could never write to.
--
-- WHY
--   Nothing in the signal layer is estimable without this. `signal_effect`
--   (app/pipeline/elasticity/signal.py) fits
--       ln(units + 1) = alpha + beta*signal_active + dow + month + trend + e
--   and `signal_active` has to come from a RECORD of what was active on each
--   past date. Today nothing stores that: `signals.active_keys` is computed for
--   the current request and discarded, so the engine has twenty signal modules
--   and no history of any of them.
--
--   That matters because the signal layer, measured across 155 signal-driven
--   recommendations, scored 6 TO 10 POINTS BELOW RANDOM. The fix is to make each
--   signal earn an estimated coefficient, and the coefficient needs history.
--
-- WHAT IS AND IS NOT RECONSTRUCTIBLE
--   COMPUTABLE, so backfillable exactly: holidays, pre-holiday windows, moving
--   dates and paydays. `app/pipeline/features/calendar.py` already derives these
--   with the anonymous Gregorian computus for Easter, nth-weekday rules and the
--   Super Bowl's move to the second Sunday in February from 2022, with 22 tests
--   pinning known-good dates across four years.
--
--   NOT RECONSTRUCTIBLE: weather and news. A past advisory is not recoverable
--   cheaply and a reconstruction would be a guess wearing a measurement's
--   clothes. Capture starts now and beta for those keys stays REFUSED until
--   enough history exists. That is stated here rather than papered over.
--
--   ALREADY MEASURED on the computable half: across the five pilot stores, 488
--   of 489 (store x category x calendar key) cells REFUSE - the interval spans
--   zero. The single exception is Mango Jo's beer against a payday window at
--   beta +0.047, a 4.8% lift. So the calendar signals do not move these stores
--   in a way the data can detect, and the weather and news keys this table
--   exists to capture are the only remaining candidates.
--
-- APPEND-ONLY, AND THAT IS NOT A STYLE PREFERENCE
--   A corrected signal is a NEW ROW, never an UPDATE. If a row can be amended
--   then the table is a current-state cache, not a history, and an estimate
--   fitted on it cannot be reproduced - which defeats the only reason it exists.
--   Enforced below with a trigger rather than left to convention.
--
-- STRENGTH IS NULLABLE, DELIBERATELY
--   A binary advisory ("a heat advisory is in force") has no intensity. Giving
--   it a fabricated 1.0 would let a later reader average it with a real
--   temperature anomaly and call the result measured. NULL means "this signal
--   has no magnitude", which is different from zero.
--
-- WHO WRITES IT
--   NODE, nightly. Node remains the sole writer of bottleai_analytics; the
--   Python service is stateless and holds no analytics credentials, and there is
--   no version of this where that changes.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS signal_history (
    id            BIGSERIAL PRIMARY KEY,
    client_id     INTEGER     NOT NULL,
    location_id   INTEGER     NOT NULL,
    -- The trading date the signal was active ON, not when we noticed.
    as_of         DATE        NOT NULL,
    signal_key    TEXT        NOT NULL,
    -- NULL = this signal has no magnitude. See the header.
    strength      NUMERIC,
    -- Which module produced it, so a connector defect reads as one pattern
    -- rather than as N unrelated anomalies.
    source        TEXT        NOT NULL,
    -- 'captured' for a live observation, 'computed' for a calendar backfill.
    -- Keeping them distinguishable is what stops a backfill being quoted as
    -- evidence that capture was running.
    origin        TEXT        NOT NULL DEFAULT 'captured',
    captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT signal_history_strength_sane
        CHECK (strength IS NULL OR strength >= 0),
    CONSTRAINT signal_history_origin_known
        CHECK (origin IN ('captured', 'computed'))
);

-- The estimator reads one (store, key) series at a time over a date range.
CREATE INDEX IF NOT EXISTS signal_history_store_key_date_idx
    ON signal_history (client_id, location_id, signal_key, as_of);

-- The weekly coverage report counts distinct keys with >= 20 active days.
CREATE INDEX IF NOT EXISTS signal_history_store_date_idx
    ON signal_history (client_id, location_id, as_of);

-- Not a unique constraint on (client, location, as_of, key): the same signal
-- legitimately arrives twice when a correction is recorded, and the whole point
-- is that both rows survive. Readers take the latest captured_at per key-date.

-- ── Append-only, enforced ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION signal_history_is_append_only()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'signal_history is append-only: % is not permitted. A corrected signal '
        'is a NEW ROW. If a row can be amended, the table is a cache rather '
        'than a history and no estimate fitted on it can be reproduced.',
        TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS signal_history_no_update ON signal_history;
CREATE TRIGGER signal_history_no_update
    BEFORE UPDATE OR DELETE ON signal_history
    FOR EACH ROW EXECUTE FUNCTION signal_history_is_append_only();

COMMIT;
