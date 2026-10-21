-- ============================================================================
-- Analytics migration 014 — daily external-signal capture
-- ============================================================================
-- DATABASE: bottleai_analytics  (applied by database/migrate.js — see 001.)
--
-- WHY
--   Until now the ONLY trace of what the outside world looked like on a given
--   day was `recommendation_runs.signal_snapshot`, and that record is not good
--   enough to rebuild a recommendation engine on:
--
--     * It is TRIMMED. `SignalBundle.snapshot(display_cap=…)` keeps ~10 entries
--       because the value is rendered as owner-facing chips. Everything past
--       the cap — which the LLM prompt DID see and reason over — is discarded
--       at the moment of writing. The stored artifact is the UI's view, not the
--       engine's input.
--     * It records only SUCCESS. A source that timed out, returned nothing, or
--       sat dormant for want of an API key is indistinguishable in the snapshot
--       from a source that legitimately had nothing to report. "Why were there
--       no event signals on the 14th?" has never been answerable.
--     * It is thrown away when a run FAILS. Signals are gathered before the LLM
--       call; if the model errors, an entire day of external observations for
--       that store is lost, permanently and silently.
--     * It keeps no raw payload, so a parser bug can never be repaired
--       retroactively. Every signal ever mis-parsed is mis-parsed forever.
--
--   The new engine needs to be trainable and back-testable against real
--   history, which means the inputs have to survive with the same fidelity as
--   the outputs. This migration adds that, in two layers.
--
-- LAYER 1 — signal_source_payloads: the RAW upstream responses.
--   Keyed by GEOGRAPHY, not by store, because that is what actually determines
--   the response. One NWS gridpoint forecast is byte-identical for every store
--   on that gridpoint; the national sports schedule is identical for everyone;
--   the industry email and the social feeds are global. Storing these per store
--   would duplicate the same JSON ~1,200× per day and turn a tens-of-MB/year
--   table into a multi-GB one for zero extra information. The geo key here is
--   exactly the key app.clients.signal_cache already uses to collapse those
--   fetches, so the two agree by construction.
--
-- LAYER 2 — daily_store_signals: the per-store daily CELL.
--   One row per (store, day) holding the FULL untrimmed SignalBundle as it was
--   handed to the engine, the trimmed view that was actually shown, and the
--   per-source health that explains any gap. This is the row the new engine
--   reads for "what did this store know on this date", and the row a backtest
--   replays. `source_geo_keys` joins it back to layer 1 for the raw bytes.
--
-- UPSERT, NOT APPEND: a day is a CELL, so re-running a store on the same day
--   overwrites it rather than accumulating near-duplicates. `capture_count`
--   and `first_captured_at` preserve the fact that it happened more than once,
--   which is the part that would otherwise be lost.
--
-- DAY KEY: `signal_date` is the STORE'S OWN calendar date, not the server's
--   and not UTC. A 04:00 UTC cron run lands on the previous evening in every
--   US timezone, so a UTC-keyed row would label Tuesday's signals "Wednesday"
--   for every store in the network. `day_basis` records which rule produced
--   the date ('store_local' via the IANA zone NWS returns for the store's
--   gridpoint, or 'utc' when the store has no usable coordinates), and
--   `timezone` records the zone used — so a row is never silently ambiguous
--   about what "that day" meant.
-- ============================================================================

BEGIN;

-- ── Layer 1: raw upstream payloads, deduplicated by geography ────────────────
CREATE TABLE IF NOT EXISTS signal_source_payloads (
  -- Logical source name. Matches the cache namespace in app/signals/__init__.py
  -- so the two are never out of step: 'weather', 'sports', 'events',
  -- 'holidays', 'news', 'email', 'discovery', 'google_trends', 'social_trends',
  -- 'register_trends', 'area_winners', 'trend_validation'.
  source         text        NOT NULL,
  -- What the payload actually varies by. 'global' (identical everywhere),
  -- 'state', 'gridpoint' (NWS 4-decimal lat/lng), 'latlon' (event radius
  -- search) or 'store' (the few genuinely per-tenant pulls from our own API).
  geo_scope      text        NOT NULL CHECK (geo_scope IN
                   ('global', 'state', 'gridpoint', 'latlon', 'store')),
  -- The key within that scope: '' for global, 'TX', '32.7801,-96.8005',
  -- or '<client_id>:<location_id>' for store scope. Never NULL — '' is the
  -- global key, so the primary key stays usable (NULLs would not dedupe).
  geo_key        text        NOT NULL DEFAULT '',
  fetch_date     date        NOT NULL,

  captured_at       timestamptz NOT NULL DEFAULT now(),
  first_captured_at timestamptz NOT NULL DEFAULT now(),
  capture_count     integer     NOT NULL DEFAULT 1,

  -- The response as received, before any normalization. NULL on a failed
  -- fetch — `ok`/`error` carry the story, and a failure is worth a row
  -- precisely because "we asked and got nothing" is the fact being recorded.
  payload        jsonb,
  -- sha256 of the canonical payload text. Cheap "did this actually change
  -- since yesterday" without comparing multi-hundred-KB JSON documents.
  payload_sha256 char(64),
  payload_bytes  integer,
  item_count     integer,

  ok             boolean     NOT NULL DEFAULT true,
  http_status    integer,
  latency_ms     integer,
  error          text,

  PRIMARY KEY (source, geo_scope, geo_key, fetch_date)
);

-- Retention sweeps and "show me everything fetched on day X" both scan by
-- date across sources; the PK's source-first order cannot serve that.
CREATE INDEX IF NOT EXISTS idx_signal_payloads_date
  ON signal_source_payloads (fetch_date DESC);

-- Failure triage: "which sources were broken last week" must not read the
-- whole table. Partial, because the healthy rows are the overwhelming
-- majority and are never the ones being hunted.
CREATE INDEX IF NOT EXISTS idx_signal_payloads_failures
  ON signal_source_payloads (fetch_date DESC, source)
  WHERE ok IS FALSE;

COMMENT ON TABLE signal_source_payloads IS
  'Raw external-API responses, deduplicated by the geography that determines them. Layer 1 of daily signal capture; daily_store_signals.source_geo_keys joins here.';

-- ── Layer 2: the per-store daily signal cell ─────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_store_signals (
  client_id    integer NOT NULL,
  location_id  integer NOT NULL,
  signal_date  date    NOT NULL,      -- the STORE'S calendar date (see header)

  -- How signal_date was derived, and in which zone. 'utc' means the store had
  -- no usable coordinates and the date is a UTC fallback — read any
  -- day-boundary analysis on those rows with that in mind.
  day_basis    text    NOT NULL DEFAULT 'utc'
                 CHECK (day_basis IN ('store_local', 'utc')),
  timezone     text,                  -- IANA zone, e.g. 'America/Chicago'; NULL when day_basis='utc'

  captured_at       timestamptz NOT NULL DEFAULT now(),
  first_captured_at timestamptz NOT NULL DEFAULT now(),
  capture_count     integer     NOT NULL DEFAULT 1,

  -- THE CELL: the complete, untrimmed SignalBundle exactly as the engine
  -- received it (app/schemas/signals.py SignalBundle.model_dump). Everything
  -- else on this row is either derived from it or describes how it was got.
  bundle jsonb NOT NULL,

  -- Whether `bundle` really is the full bundle. A Node deploy talking to a
  -- Python service that predates full-bundle capture can only supply the
  -- display-trimmed snapshot, and it must say so: a backtest that silently
  -- trains on ~10 chip-sized entries while believing it has the engine's
  -- whole input would produce confidently wrong conclusions. Rows marked
  -- 'display_trimmed' are honest, usable-with-care history; they are not
  -- training data. Defaults to the pessimistic value on purpose.
  bundle_fidelity text NOT NULL DEFAULT 'display_trimmed'
                    CHECK (bundle_fidelity IN ('full', 'display_trimmed')),

  -- What the UI/prompt actually showed: the display-capped, citation-preserving
  -- trim (SignalBundle.snapshot). Kept alongside the full bundle because "what
  -- did the owner see" and "what did the engine see" are different questions
  -- and both get asked. Mirrors recommendation_runs.signal_snapshot.
  display_snapshot jsonb,

  -- Per-source slices, GENERATED from `bundle` rather than written separately.
  -- They exist so the common queries read like what they mean
  -- (`WHERE jsonb_array_length(events) > 0`) instead of digging a path — and
  -- being generated, they CANNOT drift from the bundle the way a hand-written
  -- duplicate column silently would.
  weather  jsonb GENERATED ALWAYS AS (bundle -> 'weather')  STORED,
  sports   jsonb GENERATED ALWAYS AS (bundle -> 'sports')   STORED,
  events   jsonb GENERATED ALWAYS AS (bundle -> 'events')   STORED,
  holidays jsonb GENERATED ALWAYS AS (bundle -> 'holidays') STORED,
  news     jsonb GENERATED ALWAYS AS (bundle -> 'news')     STORED,
  social   jsonb GENERATED ALWAYS AS (bundle -> 'social')   STORED,

  -- The eligibility bridge (app.signals.mapping): the keys a recommendation is
  -- allowed to cite, and the category/keyword widenings the analysts produced.
  -- Written as real arrays, not generated, because they are the join target for
  -- "which stores could have cited heat_advisory" and text[] indexes beat
  -- jsonb path scans for that.
  active_keys            text[] NOT NULL DEFAULT '{}'::text[],
  news_categories        text[] NOT NULL DEFAULT '{}'::text[],
  news_product_keywords  text[] NOT NULL DEFAULT '{}'::text[],
  event_categories       text[] NOT NULL DEFAULT '{}'::text[],
  trend_categories       text[] NOT NULL DEFAULT '{}'::text[],
  trend_product_keywords text[] NOT NULL DEFAULT '{}'::text[],

  -- Per-source outcome for THIS store's gather:
  --   { "<source>": { "ok": bool, "items": int, "latency_ms": int,
  --                   "cache_hit": bool, "dormant": "no_api_key" | null,
  --                   "error": "..." | null } }
  -- This is what makes an absent signal legible: a source that failed, a
  -- source with no credentials, and a source that genuinely had nothing to
  -- report are three different facts and the bundle alone cannot tell them
  -- apart.
  source_health jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- { "<source>": { "scope": "...", "key": "..." } } — the join back to
  -- signal_source_payloads for the raw bytes behind each source.
  source_geo_keys jsonb NOT NULL DEFAULT '{}'::jsonb,

  sources_ok      integer NOT NULL DEFAULT 0,
  sources_failed  integer NOT NULL DEFAULT 0,
  sources_dormant integer NOT NULL DEFAULT 0,
  -- Total signal entries in the FULL bundle (weather+sports+events+holidays
  -- +news+social) — the trimmed snapshot's count is not this number.
  signal_count    integer NOT NULL DEFAULT 0,

  -- Geography the signals were actually fetched for, and where it came from
  -- ('profile' = coordinates supplied, 'geocoded' = resolved from the address,
  -- 'none' = no geo, which is why weather/events are empty).
  latitude   double precision,
  longitude  double precision,
  state      text,
  geo_source text CHECK (geo_source IN ('profile', 'geocoded', 'none')),

  -- "Did anything actually change since yesterday" in one comparison, and the
  -- dedupe key for a backfill that must not double-count a re-capture.
  bundle_sha256  char(64),
  engine_version text,

  PRIMARY KEY (client_id, location_id, signal_date)
);

-- Network-wide reads ("every store's signals for yesterday", the backtest
-- loader) scan by date across tenants, which the tenant-first PK cannot serve.
CREATE INDEX IF NOT EXISTS idx_daily_signals_date
  ON daily_store_signals (signal_date DESC);

-- "Which stores had <key> active on <date>" — the question every signal-driven
-- backtest opens with. GIN over the array answers it without a full scan.
CREATE INDEX IF NOT EXISTS idx_daily_signals_active_keys
  ON daily_store_signals USING gin (active_keys);

-- Ad-hoc exploration of the bundle itself (jsonb_path_ops: smaller and faster
-- than the default opclass for the containment queries this gets used for).
CREATE INDEX IF NOT EXISTS idx_daily_signals_bundle
  ON daily_store_signals USING gin (bundle jsonb_path_ops);

-- Health triage across the network, kept off the healthy majority.
CREATE INDEX IF NOT EXISTS idx_daily_signals_degraded
  ON daily_store_signals (signal_date DESC, client_id, location_id)
  WHERE sources_failed > 0;

COMMENT ON TABLE daily_store_signals IS
  'One row per store per store-local day: the full external-signal bundle the engine saw, the trimmed view the owner saw, and per-source health. Layer 2 of daily signal capture.';
COMMENT ON COLUMN daily_store_signals.bundle IS
  'The complete untrimmed SignalBundle (app/schemas/signals.py). Authoritative; the per-source columns are generated from it. Check bundle_fidelity before treating it as the engine''s full input.';
COMMENT ON COLUMN daily_store_signals.bundle_fidelity IS
  '''full'' = the engine''s whole input. ''display_trimmed'' = only the capped chip view was available (legacy Python service); usable as history, NOT as training data.';
COMMENT ON COLUMN daily_store_signals.signal_date IS
  'The STORE''S calendar date, not the server''s. See day_basis/timezone for how it was derived.';

-- ── Grants ───────────────────────────────────────────────────────────────────
-- Capture INSERTs and upserts (UPDATE). No DELETE for the app role: pruning
-- these is a retention job run with admin credentials, never something a
-- request path can do. Generated columns are never written directly, so they
-- need no separate grant.
GRANT SELECT, INSERT, UPDATE ON TABLE signal_source_payloads TO bottleai_writer;
GRANT SELECT, INSERT, UPDATE ON TABLE daily_store_signals    TO bottleai_writer;

COMMIT;

-- ── Verify (run as the app role) ─────────────────────────────────────────────
-- SELECT has_table_privilege('bottleai_writer','daily_store_signals','INSERT');  -- expect t
-- SELECT count(*) FROM daily_store_signals WHERE signal_date = current_date;
-- -- A store's last week, with the gaps explained:
-- SELECT signal_date, signal_count, sources_ok, sources_failed, sources_dormant,
--        jsonb_pretty(source_health)
--   FROM daily_store_signals
--  WHERE client_id = 46 AND location_id = 46
--  ORDER BY signal_date DESC LIMIT 7;
--
-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS daily_store_signals;
-- DROP TABLE IF EXISTS signal_source_payloads;
