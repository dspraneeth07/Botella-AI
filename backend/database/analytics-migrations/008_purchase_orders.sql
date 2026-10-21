-- ============================================================================
-- 008_purchase_orders.sql - Invoice / purchase-order capture ("Quick PO")
--
-- A store owner uploads a supplier invoice or purchase order (PDF or a photo
-- of one), Botella reads it, and the lines come back matched against the
-- store's own catalogue so the owner can see, in one place, what was ordered
-- and which of it Botella does not recognise.
--
-- WHY THE ANALYTICS DB. These rows are Botella's own record of a document the
-- owner gave us; they are not POS truth. `syncgo` is the POS mirror and is
-- written by the sync, not by us - putting our documents in there would blur
-- the line between "what the register says" and "what we read off a PDF".
-- Same reasoning that put recommendations here.
--
-- MATCHING IS NOT STORED. Whether a line matches a catalogue product is
-- resolved at READ time against `syncgo.products`, not frozen at parse time,
-- because the catalogue moves: a product added an hour after the upload should
-- make the line match without re-parsing. The only thing persisted is an
-- EXPLICIT link (`matched_sku`), set when a human picks a product or creates
-- one - a human decision outranks a fuzzy match and must survive.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS purchase_orders (
  id                bigserial PRIMARY KEY,
  client_id         integer     NOT NULL,
  location_id       integer     NOT NULL,

  -- What the document is. 'invoice' and 'purchase_order' read differently to
  -- an owner even though they parse identically.
  doc_type          text        NOT NULL DEFAULT 'invoice'
                                CHECK (doc_type IN ('invoice', 'purchase_order')),

  -- Parse lifecycle. A row is created as 'parsing' the moment the file lands,
  -- so an upload that dies mid-parse leaves a visible failed row rather than
  -- nothing at all.
  status            text        NOT NULL DEFAULT 'parsing'
                                CHECK (status IN ('parsing', 'parsed', 'failed')),
  parse_error       text,

  -- Header fields, all nullable: a real invoice is often missing half of them.
  vendor_name       text,
  account_no        text,
  invoice_no        text,
  invoice_date      date,
  due_date          date,
  po_number         text,
  po_date           date,
  currency          text,
  subtotal          numeric(14,2),
  tax_total         numeric(14,2),
  discount_total    numeric(14,2),
  delivery_total    numeric(14,2),
  invoice_total     numeric(14,2),
  notes             text,

  -- The original upload, kept so the owner can always open the source.
  file_name         text        NOT NULL,
  file_mime         text        NOT NULL,
  file_size         integer,
  file_path         text        NOT NULL,

  -- How the parse went, for support: which model, how sure, how long.
  parse_model       text,
  parse_confidence  real,
  parse_ms          integer,

  uploaded_by       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Every list view is "this store's documents, newest first".
CREATE INDEX IF NOT EXISTS idx_po_tenant_created
  ON purchase_orders (client_id, location_id, created_at DESC);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id                bigserial PRIMARY KEY,
  purchase_order_id bigint      NOT NULL
                                REFERENCES purchase_orders (id) ON DELETE CASCADE,
  client_id         integer     NOT NULL,
  location_id       integer     NOT NULL,

  line_no           integer,
  product_no        text,       -- the vendor's code, not ours
  product_name      text,
  upc               text,
  product_volume    text,
  pack              text,
  uom               text,
  quantity          numeric(12,3),
  cost              numeric(14,4),
  discount_amt      numeric(14,4),
  tax_amt           numeric(14,4),
  deposit_amt       numeric(14,4),
  ext_price         numeric(14,2),
  note              text,

  -- An EXPLICIT link to a catalogue product: set when someone picks a product
  -- or creates one from this line. NULL means "no human has decided yet",
  -- which is not the same as "no match" - the read path still tries to match
  -- automatically on product_no / upc / name.
  matched_sku       text,
  match_source      text        CHECK (match_source IS NULL OR match_source IN ('manual', 'created')),
  matched_at        timestamptz,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_po_items_order
  ON purchase_order_items (purchase_order_id, line_no);

CREATE INDEX IF NOT EXISTS idx_po_items_tenant
  ON purchase_order_items (client_id, location_id);

COMMIT;

-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS purchase_order_items;
-- DROP TABLE IF EXISTS purchase_orders;
