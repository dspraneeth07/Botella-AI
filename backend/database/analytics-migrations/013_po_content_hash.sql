-- ============================================================================
-- 013_po_content_hash.sql - stop the same invoice arriving twice
--
-- The upload endpoint stored whatever it was given. Re-dropping a file, or two
-- people uploading the same invoice, produced a second full document - parsed
-- again, billed again, and listed as though the store had bought the goods
-- twice. The demo list carried invoice 1578334 three times over, identical
-- vendor, date and total.
--
-- The key is the FILE CONTENT, not the file name. The same invoice reaches us
-- as "Invoice_Glazers.pdf", "Savanah_2.pdf" and "scan (1).pdf", and two genuinely
-- different invoices from one vendor often share a name pattern. A sha256 of
-- the bytes answers "have I already read exactly this" and nothing else.
--
-- NULLABLE, and no backfill. Rows uploaded before this migration have no hash
-- and are left alone: computing one would mean re-reading every stored file,
-- and a duplicate that is already in the list is a cleanup job
-- (scripts/clean-purchase-orders.js), not a migration.
--
-- The index is PARTIAL and NOT unique. Partial because the pre-existing NULLs
-- must not all collide. Not unique because the check belongs in the route,
-- where it can return the existing document and let the caller decide, rather
-- than in a constraint that can only raise. A tenant may also legitimately end
-- up with two copies - a reparse that failed halfway, an import - and a hard
-- constraint would turn that into a 500 on an unrelated write.
-- ============================================================================

BEGIN;

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS content_sha256 char(64);

COMMENT ON COLUMN purchase_orders.content_sha256 IS
  'sha256 of the uploaded file bytes. Used to recognise a re-upload of the same document; null for rows created before migration 013.';

CREATE INDEX IF NOT EXISTS idx_po_content_sha
  ON purchase_orders (client_id, location_id, content_sha256)
  WHERE content_sha256 IS NOT NULL;

COMMIT;

-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS idx_po_content_sha;
-- ALTER TABLE purchase_orders DROP COLUMN IF EXISTS content_sha256;
