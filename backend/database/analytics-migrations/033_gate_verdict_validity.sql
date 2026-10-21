-- ============================================================================
-- 033_gate_verdict_validity.sql - when a gate verdict stops being true, and
--                                 whether the curve under it was stale
-- ============================================================================
-- DATABASE: bottleai_analytics  (applied by database/migrate.js - see 001.)
--
-- TWO THINGS THE VERDICT COULD NOT SAY.
--
-- 1. WHETHER IT EXPIRED.
--
--    `store_gate_verdict` carried `evaluated_at` (when the row was written) and
--    `measured_for_month` (a text month). Neither says when the verdict stops
--    being true, so a store measured once in June would have gone on reading
--    LIVE forever on the strength of June. A gate that cannot expire is not a
--    gate; it is a one-time blessing.
--
--    `verdict_as_of` is the day the verdict SPEAKS FOR, which is not the day the
--    row was written - a month can only be judged once it has 120 days of
--    outcomes behind it, so the publisher routinely writes a June verdict in
--    November. Conflating the two would make every verdict look fresh.
--
--    `valid_until` is computed BY THE PUBLISHER and stored, rather than derived
--    by each reader from a TTL. That is deliberate: the serving path and the
--    audit page must agree, and two readers each applying their own window is
--    exactly how they come to disagree. One date, written once, compared by
--    everybody.
--
-- 2. WHETHER THE CALIBRATION CURVE UNDER IT WAS STALE.
--
--    `app/pipeline/gate/store.py` reads `calibration_is_stale` and
--    `calibration_staleness_detail` and lets them CHANGE THE DECISION - a stale
--    curve withholds the calibration check (line ~400) and rewrites the reason
--    it prints. Neither value was in the PUT payload, so the audit page knew the
--    verdict was made against a stale curve and the serving path did not. The
--    two could describe the same store differently and both be reporting what
--    they had.
--
-- NULL IS NOT FALSE for the staleness flag. A verdict published before this
-- migration did not say whether the curve was stale, and "nobody told us" is
-- not "the curve was fine" - the serving path treats an absent flag as unknown
-- and says so, rather than silently reading it as healthy.
-- ============================================================================

BEGIN;

ALTER TABLE store_gate_verdict
  ADD COLUMN IF NOT EXISTS verdict_as_of date,
  ADD COLUMN IF NOT EXISTS valid_until   date,
  ADD COLUMN IF NOT EXISTS calibration_is_stale boolean,
  ADD COLUMN IF NOT EXISTS calibration_staleness_detail text;

COMMENT ON COLUMN store_gate_verdict.verdict_as_of IS
  'The day this verdict speaks for - the end of the month it measured, NOT the '
  'day the row was written. A month needs 120 days of outcomes behind it, so a '
  'June verdict is routinely written in November.';
COMMENT ON COLUMN store_gate_verdict.valid_until IS
  'The last day this verdict may be served on. Computed by the publisher and '
  'stored so the serving path and the audit page compare the same date instead '
  'of each applying its own window.';
COMMENT ON COLUMN store_gate_verdict.calibration_is_stale IS
  'Whether the confidence curve under this verdict was stale when it was made. '
  'NULL means the publisher did not say - unknown, not healthy.';

-- Existing rows get an as-of derived from the month they measured, which is a
-- fact already on the row, and NO valid_until. A verdict that never stated an
-- expiry is treated as expired by the serving path rather than as valid
-- forever: "this verdict does not say when it stops being true" has to fail
-- closed, or the migration itself would grandfather in the exact behaviour it
-- exists to end.
UPDATE store_gate_verdict
   SET verdict_as_of = (to_date(measured_for_month || '-01', 'YYYY-MM-DD')
                        + interval '1 month - 1 day')::date
 WHERE verdict_as_of IS NULL
   AND measured_for_month ~ '^[0-9]{4}-[0-9]{2}$';

COMMIT;

-- ── Verify ───────────────────────────────────────────────────────────────────
-- SELECT client_id, measured_for_month, verdict_as_of, valid_until,
--        calibration_is_stale FROM store_gate_verdict ORDER BY client_id;
--
-- ── Rollback ─────────────────────────────────────────────────────────────────
-- ALTER TABLE store_gate_verdict
--   DROP COLUMN verdict_as_of, DROP COLUMN valid_until,
--   DROP COLUMN calibration_is_stale, DROP COLUMN calibration_staleness_detail;
