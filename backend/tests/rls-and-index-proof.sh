#!/usr/bin/env bash
# =============================================================================
# rls-and-index-proof.sh — prove migrations 001 + 002 on a throwaway Postgres
# =============================================================================
# The production DB cannot be used to prove RLS: the app role is SELECT-only and
# we must never run DDL there. So we stand up a LOCAL ephemeral cluster, load a
# tiny TWO-tenant fixture (clients 46 and 125), apply the REAL migration files,
# and run the four audit leak probes as a NON-superuser, NON-bypassrls role
# (mirroring `bottela`). Pass = zero cross-tenant rows + legit queries unchanged.
#
# Requires local postgres binaries (initdb/pg_ctl/psql). No Docker, no network,
# no superuser on the host. Everything lives under a mktemp dir and is removed
# on exit. Exit code 0 = all assertions passed.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"          # backend/
MIG="$ROOT/database/migrations"
PGBIN="$(dirname "$(command -v initdb)")"
TMP="$(mktemp -d -t botella-rls-XXXXXX)"
PGDATA="$TMP/data"; SOCK="$TMP/sock"; LOG="$TMP/pg.log"; PORT=59432; DB=syncgo_test
mkdir -p "$SOCK"

cleanup(){ "$PGBIN/pg_ctl" -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

echo "→ initdb (throwaway cluster at $TMP)"
"$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust -E UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$PGDATA" -l "$LOG" -o "-p $PORT -k $SOCK -c listen_addresses=''" -w start >/dev/null
"$PGBIN/psql" -h "$SOCK" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -qc "CREATE DATABASE $DB" >/dev/null

# superuser psql (acts as the DBA applying migrations)
su(){ "$PGBIN/psql" -h "$SOCK" -p "$PORT" -U postgres -d "$DB" -v ON_ERROR_STOP=1 -At "$@"; }
# app role psql (acts as the SELECT-only, non-bypassrls app role `bottela`)
app(){ "$PGBIN/psql" -h "$SOCK" -p "$PORT" -U app_ro -d "$DB" -v ON_ERROR_STOP=1 -At "$@"; }

echo "→ schema + roles + two-tenant fixture"
su -q >/dev/null <<'SQL'
CREATE ROLE syncgo NOSUPERUSER;                       -- table owner (like prod)
CREATE ROLE app_ro LOGIN NOSUPERUSER NOBYPASSRLS;     -- app role (like bottela)
SET ROLE syncgo;
CREATE TABLE products   (id serial PRIMARY KEY, client_id int, location_id int, sku text, upc text, product_name text, category text, cost numeric, stock_qty int);
CREATE TABLE sales      (id serial PRIMARY KEY, client_id int, location_id int, sale_id text, sale_date timestamp, total_amount numeric);
CREATE TABLE sale_items (id serial, client_id int, location_id int, sale_id text, sku text, upc text, quantity int, total_amount numeric, sale_date timestamp);
CREATE TABLE purchases  (id serial PRIMARY KEY, client_id int, location_id int);
CREATE TABLE suppliers  (id serial PRIMARY KEY, client_id int, location_id int);
CREATE TABLE customers  (id serial PRIMARY KEY, client_id int, location_id int, customer_id text, customer_name text);
-- Zeke's (46): two small receipts.  Route 106 (125): one huge, distinctive receipt.
INSERT INTO sales(client_id,location_id,sale_id,sale_date,total_amount) VALUES
  (46,46,'A',now(),100.00),(46,46,'B',now(),50.00),(125,125,'Z',now(),999999.00);
INSERT INTO products(client_id,location_id,sku,upc,product_name,category,cost,stock_qty) VALUES
  (46,46,'SK1','UP1','Terra 500ml','LIQUOR',5,10),(125,125,'SK9','UP9','Secret 125 Product','WINE',7,3);
INSERT INTO sale_items(client_id,location_id,sale_id,sku,upc,quantity,total_amount,sale_date) VALUES
  (46,46,'A','SK1','UP1',2,100.00,now()),(125,125,'Z','SK9','UP9',1,999999.00,now());
RESET ROLE;
GRANT USAGE ON SCHEMA public TO app_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_ro;
SQL

echo "→ apply migration 001 (perf indexes) + 002 (RLS) as DBA"
su -q -f "$MIG/001_join_key_perf_indexes.sql" >/dev/null
su -q -f "$MIG/002_tenant_rls.sql" >/dev/null

fails=0
check(){ # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then printf '   PASS  %-46s = %s\n' "$1" "$3"
  else printf '   FAIL  %-46s expected[%s] got[%s]\n' "$1" "$2" "$3"; fails=$((fails+1)); fi
}
# Run a probe as app_ro scoped to tenant 46. The GUCs are set at connection via
# PGOPTIONS; RLS reads them identically to the app's transaction-local set_config
# (proven separately below). One statement per call so libpq returns its result
# (a multi-statement -c only returns the LAST result — that bit us once).
probe(){ PGOPTIONS="-c app.client_id=46 -c app.location_id=46" "$PGBIN/psql" -h "$SOCK" -p "$PORT" -U app_ro -d "$DB" -v ON_ERROR_STOP=1 -At -c "$1" 2>/dev/null | tr '\n' ',' | sed 's/,$//'; }

echo
echo "── Leak probes (session bound to tenant 46; 999999 = Route 106's secret) ──"
check "UNION ALL 46/125"         "100.00,50.00"  "$(probe "SELECT total_amount FROM sales WHERE client_id=46 AND location_id=46 UNION ALL SELECT total_amount FROM sales WHERE client_id=125 AND location_id=125")"
check "top-level OR client_id=125" "100.00,50.00" "$(probe "SELECT total_amount FROM sales WHERE location_id=46 AND client_id=46 OR client_id=125")"
check "body targets 125 (decoy)"  ""        "$(probe "SELECT total_amount FROM sales WHERE client_id=125 AND location_id=125")"
check "scalar subquery into 125"  ""        "$(probe "SELECT (SELECT SUM(total_amount) FROM sales WHERE client_id=125 AND location_id=125) AS leak")"
check "direct cross-tenant count" "0"       "$(probe "SELECT COUNT(*) FROM sales WHERE client_id=125")"

echo
echo "── Structural leaks the regex validator CANNOT catch — RLS does (the point) ──"
# An unfiltered tenant table inside a subquery (validator sees only the outer =46).
check "unfiltered subquery table (sale_items)" "100.00,100.00" "$(probe "SELECT (SELECT SUM(total_amount) FROM sale_items) FROM sales")"
# A second, unfiltered self-join alias (validator sees =46 on the other alias).
check "unfiltered self-join alias"             "46"            "$(probe "SELECT a.client_id FROM sales a, sales b WHERE b.client_id=46 AND b.location_id=46 GROUP BY a.client_id")"

echo
echo "── Legit single-tenant queries still work ──"
check "own revenue (sum)"         "150.00"  "$(probe "SELECT TO_CHAR(SUM(total_amount),'FM999990.00') FROM sales")"
check "own receipts (count)"      "2"       "$(probe "SELECT COUNT(*) FROM sales")"
check "both-keys product join"    "Terra 500ml" "$(probe "SELECT p.product_name FROM sale_items si JOIN products p ON (TRIM(p.sku)=TRIM(si.sku) OR TRIM(p.upc)=TRIM(si.sku)) AND p.client_id=si.client_id AND p.location_id=si.location_id WHERE si.client_id=46 AND si.location_id=46")"

echo
echo "── Fail-closed: no GUC set → zero rows (never another tenant) ──"
check "unscoped sees nothing"     "0"       "$(app -qc "SELECT COUNT(*) FROM sales" 2>/dev/null)"

echo
echo "── App mechanism: transaction-local set_config (exactly as connection.js) ──"
# --single-transaction wraps both -c in ONE txn; set_config(...,true) from the
# first -c is visible to the second. tail -1 grabs the second -c's result.
mech(){ app --single-transaction -q \
  -c "SELECT set_config('app.client_id','46',true), set_config('app.location_id','46',true)" \
  -c "$1" 2>/dev/null | tail -1; }
check "set_config(local) shows own tenant"  "true" "$(mech "SELECT (COALESCE(SUM(total_amount),0)=150)::text FROM sales")"
check "set_config(local) hides tenant 125"  "true" "$(mech "SELECT (COUNT(*)=0)::text FROM sales WHERE client_id=125")"

echo
echo "── Perf: functional index is usable for the TRIM() predicate ──"
idx="$(su -qc "SET enable_seqscan=off; EXPLAIN SELECT * FROM products WHERE client_id=46 AND location_id=46 AND TRIM(sku)='SK1'" | grep -c 'ix_products_tenant_trim_sku' || true)"
check "TRIM(sku) lookup uses functional idx" "1" "$idx"

echo
if [ "$fails" -eq 0 ]; then echo "✅ RLS + index proof: ALL ASSERTIONS PASSED"; else echo "❌ $fails assertion(s) FAILED"; fi
exit "$fails"
