-- ============================================================================
-- 012_po_grants.sql - the grants 008, 009 and 010 forgot
--
-- 002 ends with an explicit GRANT to bottleai_writer. 008 (purchase_orders,
-- purchase_order_items), 009 (po_manual_products) and 010 (purchase_order_events)
-- do not, and the omission is invisible in development, where the app role owns
-- the schema and therefore owns anything it creates.
--
-- It is not invisible anywhere the migrations are applied by a privileged role
-- against a least-privilege app role - which is every environment the design
-- actually intends (see ANALYTICS_MIGRATE_DSN in database/migrate.js). There
-- the tables end up owned by the migrating role and the app can read none of
-- them:
--
--     [PO] list failed  permission denied for table purchase_orders
--
-- which reads exactly like the missing-table error it is not, and sends whoever
-- meets it looking for a migration that has already run.
--
-- Privileges match what the routes do. Documents and lines are created, read,
-- corrected and deleted. The manual-product overlay is written and read but
-- never deleted - a product the owner added stays. Events are append-only by
-- design (see 010): INSERT and SELECT, deliberately no UPDATE or DELETE, so the
-- grant cannot quietly become the thing that makes an audit trail editable.
--
-- IDEMPOTENT. GRANT is not an error when the privilege is already held, so this
-- is safe to re-run and safe in environments that never had the problem.
-- ============================================================================

BEGIN;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE purchase_orders      TO bottleai_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE purchase_order_items TO bottleai_writer;
GRANT SELECT, INSERT, UPDATE         ON TABLE po_manual_products   TO bottleai_writer;
GRANT SELECT, INSERT                 ON TABLE purchase_order_events TO bottleai_writer;

-- Every one of those has a bigserial primary key, and INSERT on the table is
-- refused without USAGE on the sequence behind it.
GRANT USAGE, SELECT ON SEQUENCE purchase_orders_id_seq       TO bottleai_writer;
GRANT USAGE, SELECT ON SEQUENCE purchase_order_items_id_seq  TO bottleai_writer;
GRANT USAGE, SELECT ON SEQUENCE purchase_order_events_id_seq TO bottleai_writer;

-- The migration runner reads what has been applied and records what it applies.
-- Without these, MIGRATE_ON_BOOT fails on a table it can see but not write.
GRANT SELECT, INSERT ON TABLE schema_migrations TO bottleai_writer;

COMMIT;

-- ── Rollback ─────────────────────────────────────────────────────────────────
-- REVOKE ALL ON TABLE purchase_orders, purchase_order_items,
--   po_manual_products, purchase_order_events FROM bottleai_writer;
