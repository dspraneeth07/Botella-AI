-- ============================================================================
-- 011_po_events_backfill.sql - a starting trail for documents that predate it
--
-- 010 added the event table, so every document uploaded before it has an empty
-- activity list. A log panel that is blank for every existing document reads as
-- broken rather than as new, and the first thing anyone would do is look for
-- the bug.
--
-- Two events per document can be recovered exactly, because the columns that
-- record them were always there:
--
--   uploaded  created_at, uploaded_by, file_name, file_size
--   parsed    updated_at, parse_model, parse_confidence, parse_ms, item count
--
-- Nothing is invented. A document that failed gets its failure, not a parse;
-- and the edits people made before this table existed are genuinely unknown, so
-- no edit events are fabricated to fill the gap.
--
-- IDEMPOTENT. The NOT EXISTS guards mean re-running adds nothing, so this is
-- safe if the file is ever applied twice against the same database.
-- ============================================================================

BEGIN;

-- The upload. actor is uploaded_by, which is exactly who did it.
INSERT INTO purchase_order_events
  (purchase_order_id, client_id, location_id, event, actor, payload, created_at)
SELECT o.id, o.client_id, o.location_id, 'uploaded', o.uploaded_by,
       jsonb_strip_nulls(jsonb_build_object(
         'fileName', o.file_name,
         'length',   o.file_size,
         'mime',     o.file_mime,
         'backfilled', true
       )),
       o.created_at
  FROM purchase_orders o
 WHERE NOT EXISTS (
         SELECT 1 FROM purchase_order_events e
          WHERE e.purchase_order_id = o.id AND e.event = 'uploaded'
       );

-- The parse. No actor: the system did it, which is how the UI tells a machine
-- step from a person's. Only for documents that actually parsed.
INSERT INTO purchase_order_events
  (purchase_order_id, client_id, location_id, event, actor, payload, created_at)
SELECT o.id, o.client_id, o.location_id, 'parsed', NULL,
       jsonb_strip_nulls(jsonb_build_object(
         'items',      (SELECT count(*)::int FROM purchase_order_items i
                         WHERE i.purchase_order_id = o.id),
         'method',     o.parse_model,
         'confidence', o.parse_confidence,
         'ms',         o.parse_ms,
         'backfilled', true
       )),
       o.updated_at
  FROM purchase_orders o
 WHERE o.status = 'parsed'
   AND NOT EXISTS (
         SELECT 1 FROM purchase_order_events e
          WHERE e.purchase_order_id = o.id AND e.event = 'parsed'
       );

-- The failure, for documents that never parsed. parse_error is the reason.
INSERT INTO purchase_order_events
  (purchase_order_id, client_id, location_id, event, actor, payload, created_at)
SELECT o.id, o.client_id, o.location_id, 'parse_failed', NULL,
       jsonb_strip_nulls(jsonb_build_object(
         'error',      o.parse_error,
         'backfilled', true
       )),
       o.updated_at
  FROM purchase_orders o
 WHERE o.status = 'failed'
   AND NOT EXISTS (
         SELECT 1 FROM purchase_order_events e
          WHERE e.purchase_order_id = o.id AND e.event = 'parse_failed'
       );

COMMIT;

-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DELETE FROM purchase_order_events WHERE payload ->> 'backfilled' = 'true';
