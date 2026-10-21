# StoreAgent SQL checks

SQL that reproduces the StoreAgent frontend figures directly from the read-only
`syncgo` warehouse. Each section's query is a faithful port of the Python
(`storeagent/...`) and was run against the live warehouse and compared
figure-by-figure to the real StoreAgent output.

## Frontend SQL icon: one query PER component

`frontend/src/storeagent/checkSql.js` is generated from here and maps each
component to its own query:
- a scalar card -> the section CTE + a SELECT of just that one column
  (key "section.column", e.g. "overview.revenue_mom_pct")
- a table -> a query returning that table's rows (key "section.table")

Generators (run `./.venv/bin/python sql_checks/_build_checksql.py` to regenerate
checkSql.js): `_build_checksql.py` splits each section query into per-column
queries; `table_sql.py` holds the per-table row queries (reuse the verified CTEs).

EVERY scalar card and EVERY table across all eight tabs now has its own query,
all row-reproduced and verified (row set + key sum match the live StoreAgent
output exactly). Re-check any time with
`./.venv/bin/python sql_checks/verify_tables.py` (prints ALL EXACT TABLES MATCH):

- overview: what's slipping (declining), what's heating up (surging)
- inventory: dead-stock, velocity classes, wasted markdowns, brand concentration
- pricing: raise list, cut list
- buying: buy now, don't-buy, demand heating up, lost sales (what's slipping)
- basket: best bundle ideas (by lift), most frequent pairs (by volume), strong-bundle count
- loss: rung-up-as-free, sold-below-cost
- customers: win-back, top customers
- market: head-to-head, priced above, priced below, stocking opportunities, regional assortment

The brand-dependent figures (inventory brand concentration, market opportunities /
stocking upside / regional assortment) are now EXACT too: `table_sql.brand_expr`
and `token_sig_expr` are faithful SQL ports of `canonical/brand.extract_brand`
and `market._token_sig` (the 90-alias dictionary + size-noise / leading-words /
title-case heuristic, and the leading-token signature dedupe).

The one component with NO icon: the shrinkage / cashier block (Loss tab) - it
needs per-transaction cashier attribution + a purchases ledger (a separate data
path; absent on most stores, including the test store 46).

## Files

- **`storeagent_checks.sql`** — one query per frontend section, each labelled,
  with the store id inlined. Run a section in psql/pgAdmin; the single output
  row gives that section's headline figures. This is also what the BottleAI
  frontend shows in each component's SQL icon (via
  `frontend/src/storeagent/checkSql.js`, generated from these queries, with the
  logged-in store substituted for `%(cid)s`).
- **`verify_all.py`** — self-contained harness. Runs the real StoreAgent
  computation AND every section's SQL against the live warehouse and prints a
  match table. Re-run any time to re-verify:
  `./.venv/bin/python sql_checks/verify_all.py`

Read-only throughout (SELECT only).

## Status (store 46; Customers on store 88) — all verified exact

Inventory (value, frozen, slow, velocity classes, dead/actionable), Inventory
money-leaks, Pricing, Basket, Overview pulse, Customers, Loss Prevention (loss
block), Market (peer count, regional SKUs, price-positioning), Predictive Buying
(buy list, don't-buy, lost sales), and the forecast backtest (WAPE/accuracy).

Two things baked in to match Python exactly: Postgres regex uses `\y` for the
word boundary Python writes as `\b`; and Python `round()` is banker's rounding
on floats, matched with double-precision `round()` and double-precision (not
exact-NUMERIC) intermediate arithmetic. When a realized price (revenue/units)
lands exactly on a half cent (x.xx5), the SQL can still show a price one cent
off the UI, and that row's dollar figure drifts by <= $0.01 x its units — e.g.
store 171's Margin Left reproduces to $0.10 on ~$29k (7 tie rows of 481).
Counts and classifications are exact (a tie row would additionally have to sit
exactly on the +-10% flag boundary to flip lists, which needs a double tie).

The brand/name heuristics in `canonical/brand.extract_brand` and
`market._token_sig` ARE ported to SQL (`table_sql.brand_expr` / `token_sig_expr`)
and verified exact, so Inventory **brand concentration** and Market
**carried_count / opportunity_count / total_projected_profit** now reproduce
exactly (they previously could not).

## NOT reproduced

- Loss Prevention **shrinkage / cashier block** — only present on stores that
  record a cashier per transaction (store 46 does not) and needs a purchases
  ledger; a separate data path, so it has no SQL icon.
- Overview **total_opportunity** (the single hero number) sums six action-queue
  components; each component is reproduced on its own card, but the combined
  hero figure is not re-summed in one query.
