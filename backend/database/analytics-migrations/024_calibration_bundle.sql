-- Sheet 08 — the fitted calibration curve, so the serving path can APPLY it.
--
-- WHY THIS TABLE EXISTS
--   `calibrate/fit.py` has been able to fit an isotonic curve since it was
--   written, and `calibrate/apply.py` has been able to apply one. Nothing could
--   STORE one, so every curve the harness fitted was thrown away at the end of
--   the run and production shipped the raw ranking score. That is the whole of
--   why stage 8 stayed inert after its data blocker was cleared.
--
--   Measured on the 58 scored production outcomes: the raw score states 0.85-0.97
--   and the curve maps all of those to 0.651. An owner reading 0.95 was reading a
--   number that is right about two thirds of the time.
--
-- WHY A TABLE AND NOT A COMPUTATION AT SERVE TIME
--   Fitting walks every accumulated outcome and runs pool-adjacent-violators per
--   cell. That is batch work, and the same split sheets 17 and 19 already use:
--   fitted offline on a schedule, READ by primary key when serving.
--
-- WHY THE WHOLE BUNDLE IN ONE JSONB COLUMN
--   `CalibrationBundle` is a versioned, immutable object addressed by
--   (family, demand_class, velocity_band). Splitting it across relational rows
--   would let half a bundle be read - a curve for one cell and not its parent -
--   and the fallback chain would then silently land on a different rung than the
--   one that was fitted. One row, one bundle, one version.
--
--   The reader is `fit.bundle_from_dict`, which rebuilds the THREE-PART lookup
--   keys. A two-part key misses every rung of the chain and falls back to
--   identity, which is indistinguishable from "no curve exists" - that bug was
--   written and caught by round-tripping a real bundle and comparing the APPLIED
--   value rather than the fit count.
--
-- WHY `skipped` IS STORED TOO
--   "we looked at this cell and there was not enough data" is information. Its
--   absence would read as "we never looked", and a store asking why its markdown
--   family has no curve deserves the count that was short.

CREATE TABLE IF NOT EXISTS calibration_bundle (
  client_id   integer NOT NULL,
  location_id integer NOT NULL,

  -- The bundle's own version string, which encodes the fit date and a digest of
  -- the outcomes behind it. A card can cite this and be replayed years later.
  version     text    NOT NULL,
  fitted_at   date    NOT NULL,

  -- The serialised CalibrationBundle: {version, fitted_at, fits[], skipped{}}.
  bundle      jsonb   NOT NULL,

  -- Provenance, so a stale or thin curve is visible as such rather than trusted.
  outcomes_fitted integer NOT NULL DEFAULT 0,
  cells_fitted    integer NOT NULL DEFAULT 0,
  cells_skipped   integer NOT NULL DEFAULT 0,
  -- The rungs actually present. A bundle holding only the global curve is a
  -- weaker claim than one holding per-family cells, and the difference must not
  -- have to be inferred from the JSON.
  rungs           text,

  published_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (client_id, location_id)
);

COMMENT ON TABLE calibration_bundle IS
  'Sheet 08. One fitted isotonic bundle per store, written by the batch and read '
  'on the request path. Read it with fit.bundle_from_dict - the lookup keys are '
  'three-part (family, demand_class, velocity_band) and a two-part key silently '
  'falls back to identity.';

COMMENT ON COLUMN calibration_bundle.rungs IS
  'Which rungs the bundle holds, e.g. "global" or "global,reorder/*". A '
  'global-only bundle is a weaker claim than per-family cells.';
