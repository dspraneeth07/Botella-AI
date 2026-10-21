-- ============================================================================
-- 009_po_manual_products.sql - products the owner adds from an invoice line
--
-- WHY THIS TABLE EXISTS AND WE DO NOT JUST INSERT INTO products.
--
-- `syncgo.products` is the POS MIRROR. The application role (`bottela`) holds
-- SELECT on it and nothing else - verified, not assumed:
--
--     current_user = bottela, SELECT = true, INSERT = false, UPDATE = false
--
-- That is the correct arrangement, not an oversight. The mirror is owned by the
-- sync process; a row we inserted would either be deleted or overwritten the
-- next time the POS pushed its catalogue, so the "add to inventory" button
-- would appear to work and then quietly undo itself hours later.
--
-- So a product the owner adds from an invoice is recorded HERE, as Botella's
-- own note that this product exists, and the invoice matcher reads both:
-- the POS catalogue first, this overlay second. When the product later appears
-- in a real POS sync, the POS row wins on sku and the overlay row simply stops
-- being consulted.
--
-- This is deliberately NOT a general "create a product in the POS" feature.
-- Doing that needs a write path into the POS itself (the reference
-- implementation has one, through its POS connector); Botella has no such
-- connector today. What this gives the owner is the thing the screen is for:
-- an invoice line that stops being flagged as unknown.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS po_manual_products (
  id           bigserial PRIMARY KEY,
  client_id    integer     NOT NULL,
  location_id  integer     NOT NULL,

  sku          text        NOT NULL,
  upc          text,
  product_name text        NOT NULL,
  category     text,
  price        numeric(14,4),
  cost         numeric(14,4),
  stock_qty    integer     NOT NULL DEFAULT 0,

  -- Which invoice line this came from, so the origin of a manually added
  -- product is answerable later ("where did this come from?").
  source_item_id bigint,

  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- One sku per store. The route also checks the POS catalogue before
  -- inserting, but that check is a race; this constraint is the guarantee.
  CONSTRAINT po_manual_products_sku_unique UNIQUE (client_id, location_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_po_manual_tenant
  ON po_manual_products (client_id, location_id);

COMMIT;

-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS po_manual_products;
