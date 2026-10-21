-- ============================================================================
-- 021_po_duplicate_identity.sql - catch the same invoice, not just the same file
--
-- Migration 013 added a sha256 of the uploaded bytes so re-dropping a file
-- would not create a second document. That works, and it is not enough.
--
-- A sha256 only recognises a BYTE-IDENTICAL file. The same invoice reaches us
-- re-scanned, re-exported from an email client, re-saved by a PDF viewer, or
-- photographed a second time - every one of those produces different bytes and
-- sails straight past the hash as a brand new document. The store then sees
-- invoice 1578334 listed twice, parsed twice, and counted twice against what
-- it believes it bought.
--
-- THE KEY IS THE INVOICE'S OWN IDENTITY. A vendor does not issue two different
-- invoices under one number, so (vendor, invoice_no) is the thing that says
-- "this is the same document" no matter how it arrived. It can only be known
-- AFTER the parse, which is why this is a post-parse check and not a second
-- gate on upload.
--
-- `duplicate_of` rather than a delete. The row is kept:
--   * the reader may have opened it and wants to know what happened to it
--   * the parse may be BETTER than the original's (a clean re-scan of a bad
--     photo), and the fix there is to keep the new one and retire the old,
--     which needs both rows present
--   * deleting a document a user just uploaded, with no trace, is how people
--     stop trusting an uploader
--
-- NOT A UNIQUE CONSTRAINT, for the same reason 013 gave: the check belongs
-- where it can explain itself and let the caller decide, not in a constraint
-- whose only move is to raise. A tenant may also legitimately hold two copies
-- (a half-failed reparse, an import), and a hard constraint turns that into a
-- 500 on an unrelated write.
-- ============================================================================

BEGIN;

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS duplicate_of bigint;

COMMENT ON COLUMN purchase_orders.duplicate_of IS
  'When set, this document is the same invoice as purchase_orders.id = this '
  'value, recognised after parsing by (vendor, invoice_no). The row is kept so '
  'the reader can see what happened to their upload; the list hides it unless '
  'asked. Null for every document that is not a recognised duplicate.';

-- Finding a tenant's duplicates, and excluding them from the default list.
CREATE INDEX IF NOT EXISTS idx_po_duplicate_of
  ON purchase_orders (client_id, location_id, duplicate_of)
  WHERE duplicate_of IS NOT NULL;

-- The identity lookup the post-parse check runs.
--
-- Indexed on the NORMALISED vendor, matching the query's predicate exactly -
-- an index on lower(vendor_name) cannot serve a filter on
-- regexp_replace(lower(replace(...))) and would sit there unused while the
-- planner seq-scans.
--
-- Vendor only. The invoice-number rule strips leading document-type markers
-- ("INV-1578334" and "#1578334" are one invoice) and that rule lives in
-- JavaScript, in one place, deliberately: writing it a second time as a
-- Postgres regexp is how this codebase ended up with two definitions of lift
-- that disagreed by 1.37x while everyone believed they matched. The query
-- narrows to the vendor and the application decides.
--
-- Partial: a document that failed to parse has neither field and must not
-- collide with every other one that also has neither.
CREATE INDEX IF NOT EXISTS idx_po_identity
  ON purchase_orders (client_id, location_id,
                      (regexp_replace(lower(replace(vendor_name, '&', ' and ')),
                                      '[^a-z0-9]', '', 'g')))
  WHERE invoice_no IS NOT NULL AND vendor_name IS NOT NULL;

COMMIT;

-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS idx_po_identity;
-- DROP INDEX IF EXISTS idx_po_duplicate_of;
-- ALTER TABLE purchase_orders DROP COLUMN IF EXISTS duplicate_of;
