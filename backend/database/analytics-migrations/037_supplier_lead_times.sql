-- ============================================================================
-- 037_supplier_lead_times.sql - a receipt date, and a lead time with provenance
-- ============================================================================
-- DATABASE: bottleai_analytics  (applied by database/migrate.js - see 001.)
--
-- WHY
--
--   Every reorder quantity in the estate rests on a seven-day delivery lead
--   time, and the seven is declared in three places that do not know about
--   each other: `app/pipeline/policy/inventory.py` (a registry Setting,
--   PROVISIONAL, honest about it), `app/recommender/deterministic.py` (a
--   module constant printed on the stockout card as fact: "A delivery takes 7
--   days.") and `storeagent/config.py`. None of them can ever become measured,
--   because nothing in either database records when an order ARRIVED:
--
--       purchases        date, invoice_date         (date == invoice_date)
--       purchase_orders  po_date, invoice_date, due_date, created_at (upload)
--
--   `inventory.py` says so in its own header - "LEAD TIME IS NOT IN THE
--   WAREHOUSE ... Replace per vendor the moment anyone measures one" - and this
--   migration is the place a measurement can land.
--
-- 1. `purchase_orders.received_date`
--
--   The day the goods arrived. Nullable, because an invoice usually does not
--   carry it; a delivery note does, and the parser is told to read it when it
--   is there. An owner can also set it from the document screen - "this came on
--   Tuesday" is a fact they have and we do not. It is the ONLY column from
--   which a lead time can be computed, so it stays a plain date with no default:
--   defaulting it to the upload time would manufacture a measurement out of
--   when somebody got round to scanning the paperwork.
--
-- 2. `supplier_lead_times`
--
--   One row per (store, vendor). `source` says whether the figure was measured
--   or is the declared default, and the measured rows carry how many receipts
--   it rests on and the window they span, so a card can say "measured from 4
--   receipts between March and June" rather than printing an unqualified
--   number. A default row is written deliberately, not left absent: the
--   consumer must be able to tell "this vendor's lead time is the default" from
--   "nobody has looked at this vendor", and an absent row says the second.
--
--   `vendor_key` is the vendor name normalised by services/purchaseOrderService
--   `normaliseVendor` - the same fold the duplicate-invoice check uses, so
--   "Glazer's Beer & Beverage" and "GLAZERS BEER AND BEVERAGE" are one supplier
--   here exactly as they are there. Computed in JavaScript, in one place; the
--   `vendor_name` column keeps the most recent spelling for display.
--
--   The refresh runs nightly after the ingestion digest (server.js) and
--   whenever an owner sets a receipt date. Measured rows need a declared minimum
--   number of receipts (LEAD_TIME_MIN_OBSERVATIONS, default 3) before they are
--   written as measured; below that the row stays a default, because one
--   receipt is an anecdote.
-- ============================================================================

BEGIN;

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS received_date date;

COMMENT ON COLUMN purchase_orders.received_date IS
  'The day the goods arrived - set by the parser when the document states it '
  '(delivery notes do, invoices usually do not) or by the owner. NULL means '
  'unknown, never "the upload time". The only column a lead time can be '
  'measured from.';

CREATE TABLE IF NOT EXISTS supplier_lead_times (
  client_id       integer      NOT NULL,
  location_id     integer      NOT NULL,
  -- normaliseVendor(vendor_name): lower, '&' -> 'and', punctuation and
  -- whitespace removed. One rule, in one place, in JavaScript.
  vendor_key      text         NOT NULL,
  -- The most recent spelling seen on a document, for display.
  vendor_name     text,
  lead_time_days  numeric(6,2) NOT NULL,
  -- 'default'  the declared default; nobody has measured this vendor yet, or
  --            fewer receipts exist than the minimum.
  -- 'measured' the median of (received_date - COALESCE(po_date, invoice_date))
  --            over the trailing year, on at least the minimum number of
  --            receipts.
  source          text         NOT NULL CHECK (source IN ('default', 'measured')),
  -- How many receipts the figure rests on. 0 on a default row.
  observations    integer      NOT NULL DEFAULT 0,
  -- The span the receipts cover. NULL on a default row.
  measured_from   date,
  measured_to     date,
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, location_id, vendor_key),
  CHECK (lead_time_days > 0),
  CHECK (source = 'default' OR observations > 0)
);

COMMENT ON TABLE supplier_lead_times IS
  'Per-vendor delivery lead time with provenance. A default row is written on '
  'purpose so "the default" and "never looked at" are distinguishable.';

-- Refreshed by DELETE-then-INSERT per store (one vendor set at a time), the
-- same shape as signal_effects, so this one needs DELETE. Keyed on
-- (client_id, location_id, vendor_key) - no sequence to grant.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE supplier_lead_times TO bottleai_writer;

COMMIT;

-- ── Verify ───────────────────────────────────────────────────────────────────
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'purchase_orders' AND column_name = 'received_date';
-- SELECT vendor_key, lead_time_days, source, observations
--   FROM supplier_lead_times ORDER BY client_id, location_id, vendor_key;
-- SELECT has_table_privilege('bottleai_writer','supplier_lead_times','DELETE'); -- t
--
-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS supplier_lead_times;
-- ALTER TABLE purchase_orders DROP COLUMN IF EXISTS received_date;
