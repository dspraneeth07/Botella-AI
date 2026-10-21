-- ============================================================================
-- Analytics migration 001 — product_first_seen (new-product detection registry)
-- ============================================================================
-- DATABASE: bottleai_analytics  (NOT syncgo — the numbered files in
--   ../migrations/ target syncgo; this folder targets the analytics DB.)
--
-- WHY
--   `products` in syncgo has no creation timestamp (`last_updated` mutates on
--   every sync), so services/catalogTrackingService.js diffs each inventory
--   pull's SKU set against this registry to learn when a SKU first appeared.
--   That first-seen date ships to the Python recommendation service as
--   `created_at` (new-arrival recommendations) and feeds the cross-store
--   "area winners" aggregation (upc = the cross-store product identity).
--
-- PROVISIONING RULE
--   Applied by the migration runner (database/migrate.js), tracked in
--   schema_migrations — run `npm run migrate`, or set MIGRATE_ON_BOOT=true.
--   Where the app role lacks schema-CREATE (prod/staging), point
--   ANALYTICS_MIGRATE_DSN at an owner/admin connection. The app role itself
--   gets SELECT + INSERT only — the service never updates, deletes, or
--   creates; there is deliberately NO lazy CREATE in app code. Until this is
--   applied the app just logs a warning and serves created_at = null.
--
--   Manual fallback: psql "$ANALYTICS_ADMIN_DSN" -f 001_product_first_seen.sql
--   (idempotent, safe to re-run — required property for all files here).
--   If the app role is named differently in an environment, change the GRANT
--   target below (dev/staging/prod all currently use bottleai_writer).
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS product_first_seen (
  client_id     integer     NOT NULL,
  location_id   integer     NOT NULL,
  sku           text        NOT NULL,
  upc           text,                                -- cross-store identity; nullable (not every product has one)
  first_seen_at timestamptz NOT NULL DEFAULT now(),  -- detection time (accurate to one pull interval)
  is_baseline   boolean     NOT NULL DEFAULT false,  -- pre-tracking catalog; never treated as "new"
  PRIMARY KEY (client_id, location_id, sku)
);

-- The area-winners seed scan is by recency across all tenants, so the PK
-- doesn't help it; a partial index on the non-baseline slice keeps it cheap
-- (baseline rows are the vast majority and are never scanned by recency).
CREATE INDEX IF NOT EXISTS idx_product_first_seen_recent
  ON product_first_seen (first_seen_at)
  WHERE is_baseline IS FALSE;

-- Least privilege: the service only ever SELECTs and INSERTs.
GRANT SELECT, INSERT ON TABLE product_first_seen TO bottleai_writer;

COMMIT;

-- ── Verify (run as the app role) ─────────────────────────────────────────────
-- SELECT has_table_privilege('bottleai_writer', 'product_first_seen', 'SELECT, INSERT');  -- expect t
-- INSERT INTO product_first_seen (client_id, location_id, sku, is_baseline)
--   VALUES (0, 0, '__probe__', true);
-- DELETE fails as expected for the app role; clean the probe row as admin:
--   DELETE FROM product_first_seen WHERE client_id = 0 AND location_id = 0;
--
-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS product_first_seen;
