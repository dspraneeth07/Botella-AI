-- ============================================================================
-- Migration 002 — Row-Level Security for tenant isolation (Finding #1, BLOCKER)
-- ============================================================================
-- WHY
--   The run_sql fallback executes model-authored SQL. The app-layer validator
--   (routes/chat.js: isSafeQuery + validateTenantFilter) blocks the known leak
--   shapes, but a string/parser guard is a denylist on a huge grammar. RLS makes
--   tenant isolation a PROPERTY OF THE DATABASE: every row read is filtered to
--   the session's tenant no matter what SQL reaches Postgres. This is the durable
--   fix; the validator stays as defense-in-depth ABOVE it.
--
-- HOW IT BINDS
--   The app sets two transaction-local GUCs before every query
--   (database/connection.js -> tenantScopedQuery):
--       SELECT set_config('app.client_id',  <jwt client_id>,  true);
--       SELECT set_config('app.location_id', <jwt location_id>, true);
--   The policies below filter each table to those values. current_setting(...,
--   true) returns NULL when unset, so a connection that forgot to set them sees
--   ZERO rows (fail-closed), never another tenant's data.
--
-- ROLE REQUIREMENTS (verified for this deployment)
--   * The app role (`bottela`) must be NON-superuser and NON-BYPASSRLS so the
--     policies apply to it.  Verified: rolsuper=false, rolbypassrls=false.
--   * FORCE ROW LEVEL SECURITY makes the policy apply even to a table OWNER, so
--     isolation holds regardless of which role the app connects as.
--   * Apply this migration as the table OWNER (`syncgo`) or a superuser. The app
--     role is SELECT-only and CANNOT run this — hand it to a DBA.
--
-- ⚠️ DEPLOYMENT ORDER (do not skip)
--   RLS filters EVERY surface that reads these tables (chat, dashboard, summary,
--   insights, dead-stock, market-analysis). They ALL now route queries through
--   the tenant-scoped pool (server.js attachPool -> makeTenantScopedPool), so the
--   GUCs are set fleet-wide. Before enabling RLS in production, confirm with the
--   self-test at the bottom that a scoped connection still returns its own rows.
--
-- HOW TO APPLY
--   psql "$ADMIN_DSN" -f 002_tenant_rls.sql
-- ============================================================================

BEGIN;

-- One policy per tenant table. SELECT-only app, so USING (the read filter) is
-- the operative clause; WITH CHECK mirrors it so the policy is complete if a
-- write ever occurs through a non-BYPASSRLS role.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['products','sales','sale_items','purchases','suppliers','customers']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (
          client_id   = current_setting('app.client_id',  true)::int
          AND location_id = current_setting('app.location_id', true)::int
        )
        WITH CHECK (
          client_id   = current_setting('app.client_id',  true)::int
          AND location_id = current_setting('app.location_id', true)::int
        )
    $f$, t);
  END LOOP;
END $$;

COMMIT;

-- ── Self-test (run manually as the app role to confirm isolation) ────────────
-- BEGIN;
--   SELECT set_config('app.client_id','46', true), set_config('app.location_id','46', true);
--   SELECT count(*) FROM sales;                              -- expect 79129 (Zeke's only)
--   SELECT count(*) FROM sales WHERE client_id = 125;        -- expect 0 (RLS hides it)
--   SELECT (SELECT count(*) FROM sales WHERE client_id=125) AS leak;  -- expect 0
-- ROLLBACK;
--
-- ── Rollback this migration ──────────────────────────────────────────────────
-- DO $$ DECLARE t text; BEGIN
--   FOREACH t IN ARRAY ARRAY['products','sales','sale_items','purchases','suppliers','customers'] LOOP
--     EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
--     EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
--     EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
--   END LOOP; END $$;
