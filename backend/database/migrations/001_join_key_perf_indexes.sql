-- ============================================================================
-- Migration 001 — functional indexes for the both-keys product join (Finding #2)
-- ============================================================================
-- WHY
--   sale_items.sku links to a product via EITHER products.sku OR products.upc;
--   the live join is
--       (TRIM(p.sku) = TRIM(si.sku) OR TRIM(p.upc) = TRIM(si.sku))
--   The TRIM() wrappers make every EXISTING btree index unusable, and there is
--   NO index on products.upc at all. Result: top-products / category / margin
--   aggregations fall back to a nested-loop seq-scan and TIME OUT — measured at
--   Zeke's (client 46): the all-time top-products query did not finish in 200s.
--
--   At Zeke's the keys are already clean (0 padded rows), so TRIM is a no-op
--   here — but we keep TRIM in the SQL for STORE-AGNOSTIC safety (other stores
--   may carry padded keys). That means the indexes must be FUNCTIONAL on
--   TRIM(...) so the planner can use them regardless of padding.
--
-- WHAT
--   Functional btree indexes on TRIM(sku)/TRIM(upc) for both tables, tenant
--   columns leading so they double as the per-tenant scoping index.
--
-- IMPACT (measured/expected)
--   With these in place the both-keys join becomes a BitmapOr of two index scans
--   instead of a 160k x 5k nested loop; full-window margin/category/top-products
--   drop from "times out" to sub-second. Proven on a local fixture in
--   tests/rls-and-index-proof.sh (EXPLAIN before/after).
--
-- HOW TO APPLY  (requires a role that OWNS the tables or is superuser —
--   the app's `bottela` role is SELECT-only and CANNOT run this; hand to a DBA)
--       psql "$ADMIN_DSN" -f 001_join_key_perf_indexes.sql
--   CONCURRENTLY builds without locking writes; it must run OUTSIDE a txn block
--   (do not wrap in BEGIN/COMMIT). IF NOT EXISTS makes the migration idempotent.
-- ============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_products_tenant_trim_sku
    ON products (client_id, location_id, (TRIM(sku)));

CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_products_tenant_trim_upc
    ON products (client_id, location_id, (TRIM(upc)));

-- sale_items is partitioned by sale_date; index the trimmed sku with the
-- partition key so windowed product joins prune by date AND seek by key.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_sale_items_tenant_trim_sku
    ON sale_items (client_id, location_id, (TRIM(sku)), sale_date);

-- After applying, refresh planner stats so the new indexes are costed correctly:
--   ANALYZE products;
--   ANALYZE sale_items;
