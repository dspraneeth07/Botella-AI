-- 030  Collapse the mid-window outcome snapshots into one row per card-window.
--
-- WHY THIS EXISTS
--
-- `recommendation_outcomes` is the evidence base. The gate counts its rows, the
-- calibration curve is fitted on them, and k is estimated from them - so a row
-- that is the same card measured again is not neutral, it is a fact invented
-- out of a re-read.
--
-- Migration 020 keyed the table `UNIQUE (recommendation_id, window_start,
-- window_end)` to prevent exactly that, and said so: "Re-scoring the same window
-- updates in place rather than accumulating duplicates that would each be
-- counted as independent evidence by the gate." The evaluator then passed the
-- MOVING SALES FRONTIER as `window_end`, so the key changed every night, the
-- ON CONFLICT never fired, and each card accumulated a row per nightly re-score.
--
-- Measured here before the fix: 444 rows covering 284 card-windows. 284 of those
-- rows sat at a span that is not an evaluation horizon at all - 4, 10, 12, 24,
-- 26 and 39 days - and 150 (recommendation_id, window_start) groups held more
-- than one row. Two thirds of the evidence base was repetition.
--
-- The evaluator now writes the NOMINAL end (rec_date + window_days), which is
-- fixed for the life of the card. This migration brings the rows already written
-- into that shape.
--
-- WHY SNAP RATHER THAN DELETE
--
-- A partial row is not junk - it is a real measurement of a window that had not
-- closed yet, and deleting it would throw away the only evidence for every card
-- still inside its window. The horizon it belongs to is recoverable without a
-- `window_days` column, because the horizons are 7/30/60/90 and a window is
-- scored only until it completes: a 7-day window is finished at 7, so a 10-day
-- span cannot be a 7 - it can only be a partial 30. The smallest horizon at or
-- above the recorded span is therefore the one it was measuring.
--
-- Where snapping makes two rows collide, the one with the most OPEN days in the
-- window wins: that is the later, more complete look at the same card. A fully
-- scored row always has the most open days of its group, so a real outcome is
-- never displaced by a snapshot of itself.

BEGIN;

-- The horizon each row was measuring, and its rank within the group it will
-- land in. `nominal_end` is NULL for a span past the longest horizon, which
-- should not exist; such a row is left exactly as it is rather than guessed at.
CREATE TEMP TABLE _outcome_snap ON COMMIT DROP AS
SELECT
  o.id,
  o.window_start + h.days AS nominal_end,
  row_number() OVER (
    PARTITION BY o.recommendation_id, o.window_start, o.window_start + h.days
    ORDER BY o.open_days_in_window DESC, o.scored_at DESC, o.id DESC
  ) AS rank_in_group
FROM recommendation_outcomes o
CROSS JOIN LATERAL (
  SELECT min(d) AS days
    FROM unnest(ARRAY[7, 30, 60, 90]) AS d
   WHERE d >= (o.window_end - o.window_start)
) h
WHERE h.days IS NOT NULL;

-- The losers: a less complete look at a card-window we also hold a better look
-- at. Deleted before the update so the unique key cannot be violated mid-flight.
DELETE FROM recommendation_outcomes
 WHERE id IN (SELECT id FROM _outcome_snap WHERE rank_in_group > 1);

-- The survivors move to the end they were always measuring toward. The row keeps
-- its own `open_days_in_window` and `snapshot_id`, so how much of the window it
-- actually saw, and when, remain on the record.
UPDATE recommendation_outcomes o
   SET window_end = s.nominal_end
  FROM _outcome_snap s
 WHERE o.id = s.id
   AND s.rank_in_group = 1
   AND o.window_end <> s.nominal_end;

COMMIT;
