-- signal_history.origin gains 'archived': a third kind of fact, not a third name
-- for the two that exist.
--
-- WHY A THIRD VALUE AND NOT ONE OF THE TWO
--   The column exists to stop one kind of evidence being quoted as another, so
--   adding a value is only justified if the new rows really are a different kind.
--   They are:
--
--     computed   derived from the CALENDAR alone. Thanksgiving 2025 was the 27th
--                of November and will be forever. Reproducible exactly, by anyone,
--                with no external dependency.
--
--     captured   observed LIVE by this engine and written down at the time. A
--                temperature we recorded on the day. Not reproducible - if we did
--                not record it, it is gone.
--
--     archived   read back from a third-party HISTORICAL record, after the fact.
--                A daily maximum temperature for a date in 2024, fetched from a
--                weather archive in 2026.
--
--   Calling archived weather 'computed' would be a lie: nothing about it follows
--   from the calendar, and a reader checking the claim would find no arithmetic
--   behind it. Calling it 'captured' would be a worse lie: it asserts the engine
--   was watching at the time, which is exactly the claim the column was added to
--   prevent being made falsely.
--
-- WHY IT MATTERS TO AN ESTIMATE, NOT JUST TO BOOKKEEPING
--   An archive is a REANALYSIS. It is revised, it is interpolated to a grid point
--   rather than measured at the shop door, and its definition of a hot day is the
--   one the archive uses rather than the one the live alert feed uses. An
--   elasticity fitted on archived weather is a weaker claim than one fitted on
--   captured weather, and the two must be distinguishable after the fact or that
--   difference is lost the moment both are in the same table.
--
--   The fit is still worth having. "Sales rose 18% on days the archive says were
--   above 95F" is a real finding. It is simply not the same sentence as "sales rose
--   18% on days we recorded a heat advisory", and the engine should not be able to
--   print the second while holding evidence for the first.

ALTER TABLE signal_history
  DROP CONSTRAINT IF EXISTS signal_history_origin_known;

ALTER TABLE signal_history
  ADD CONSTRAINT signal_history_origin_known
  CHECK (origin IN ('captured', 'computed', 'archived'));

COMMENT ON COLUMN signal_history.origin IS
  'captured = observed live by this engine at the time. computed = derived from '
  'the calendar and reproducible exactly. archived = read back from a third-party '
  'historical record after the fact - a reanalysis, revised and grid-interpolated, '
  'so an estimate fitted on it is a weaker claim than one fitted on captured data.';
