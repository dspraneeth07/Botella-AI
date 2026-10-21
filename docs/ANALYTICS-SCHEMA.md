# `bottleai_analytics` — every table, and why it exists

**Status:** current as of migration `025`. Migrations up to `021` were verified
against the live database (PostgreSQL 16) on 29 September 2026; `023`-`025`
(card statements) were added on 7 October 2026 and applied to the local
analytics database that day (`npm run migrate:status`). `022` adds columns to
`recommendations` and is not described below yet.
**Database:** `bottleai_analytics` only. `syncgo` and `storeagent` are separate
and are not described here.
**Source of truth:** `backend/database/analytics-migrations/*.sql`. This
document is a reader's map of those files, not a replacement for them — if the
two disagree, the migrations are right and this is stale.

---

## 1. How to read this

**35 base tables**, plus **58 monthly partitions** of `feature_daily`
(93 relations in total). Every one was created by a numbered migration, and
every migration carries a header explaining the decision behind it.

Three rules hold across the whole database and explain most of the design:

1. **Node is the only writer.** The Python service holds no analytics
   credentials and opens no connection to this database. It reports what it saw
   in an HTTP response and Node persists it. One writer, no dual-write races.
2. **`syncgo` is SELECT-only.** Anything that needs to be *written* about a
   store lives here, even when it is about POS data — which is why
   `po_manual_products` and `feature_daily` exist at all.
3. **An absence is recorded, not implied.** A failed fetch, a dormant source, a
   refused batch and an unmeasurable outcome each get a row saying so. "No row"
   never has to be interpreted.

---

## 2. The tables at a glance

| # | Table | Migration | Purpose |
|---|---|---|---|
| | **Recommendations — the original loop** | | |
| 1 | `recommendations` | 000 | Every recommendation ever shown or withheld |
| 2 | `recommendation_runs` | 000 | One row per generation run |
| 3 | `recommendation_evaluations` | 002 | Did a recommendation work |
| 4 | `recommendation_sku_state` | 002 | Per-SKU state at capture: baseline, cost, cooldown |
| 5 | `recommendation_digests` | 003 | Archived owner-facing digests |
| 6 | `recommendation_admission` | 017 | Whether a store's data was fit to recommend from |
| 7 | `recommendation_family_gate` | 019 | Per store × family: shadow / live / suspended |
| 8 | `recommendation_outcomes` | 020 | The rebuild's outcome ledger — shown *and* withheld |
| | **Daily capture** | | |
| 9 | `daily_store_signals` | 014 | What the engine knew, per store per day |
| 10 | `signal_source_payloads` | 014 | Raw upstream responses, geo-deduplicated |
| 11 | `daily_store_recommendations` | 015 | What the engine said, per store per day |
| | **The feature store** | | |
| 12 | `feature_daily` | 018 | One definition of velocity. **Partitioned**, 58 partitions |
| 13 | `feature_store_day` | 018 | The dense calendar: open, closed, or unsynced |
| | **Ingestion and quality** | | |
| 14 | `sync_raw_log` | 016 | Every batch received, before interpretation |
| 15 | `sync_store_state` | 016 | Per-store ingestion state and staleness |
| 16 | `sync_connector_digest` | 016 | What a connector claims it sent |
| 17 | `data_quality_results` | 017 | Gate results per store per run |
| 18 | `store_quality_state` | 017 | Current verdict per store |
| | **Quick PO — invoice capture** | | |
| 19 | `purchase_orders` | 008 | An uploaded invoice or PO |
| 20 | `purchase_order_items` | 008 | Its lines, matched to the catalogue |
| 21 | `purchase_order_events` | 010 | Audit trail per document |
| 22 | `po_manual_products` | 009 | Products the owner created from a line |
| 23 | `po_recommendations` | 005 | Buying-report recommendations |
| 24 | `po_recommendation_outcomes` | 005 | Did those work |
| | **Card Statement Analysis** | | |
| 25 | `card_statements` | 023 | An uploaded card-processing statement and its analysis |
| 26 | `card_statement_events` | 024 | Audit trail per statement |
| | **Instagram trends** | | |
| 27 | `ig_hashtags` | 005 | Tracked hashtags |
| 28 | `ig_hashtag_snapshots` | 005 | Their counts over time |
| 29 | `ig_dynamic_terms` | 006 | Terms discovered rather than configured |
| 30 | `meta_token_history` | 005 | Meta API token rotation |
| | **Everything else** | | |
| 31 | `chat_interactions` | 000 | Chat telemetry |
| 32 | `feedback` | 000 | Owner feedback |
| 33 | `storeagent_capability_results` | 000 | StoreAgent capability probes |
| 34 | `product_first_seen` | 001 | When a SKU first appeared |
| 35 | `schema_migrations` | — | The migration runner's own ledger |

> **Two migrations are numbered 005** — `005_instagram_trends.sql` and
> `005_po_recommendations.sql`. Both are applied and neither is wrong, but
> which runs first depends on filesystem ordering, which is not a property that
> should decide a schema. Flagged in the September data audit; it needs
> renumbering before more migrations land.

---

## 3. The recommendation loop

### 3.1 `recommendations` — 20 columns, migration 000

Every recommendation ever produced, **including ones deliberately never shown**
(`is_holdout`). A withheld recommendation is the control arm; deleting it would
destroy the only evidence that the shown ones did anything.

Later migrations widened it rather than replacing it: `reference_upc` (002),
action-claim columns (004), `suggested_order_qty` (007).

### 3.2 `recommendation_runs` — 12 columns, migration 000

One row per generation run, with the model, prompt version, token counts and
latency. Migration 015 added `rec_date`, `day_basis` and `timezone`.

The seven runs predating 015 are **deliberately not backfilled**: we do not
know which timezone they were meant to be read in, and inventing one is worse
than recording that it is unknown. Readers treat NULL as "legacy, fall back to
`generated_at`".

### 3.3 `recommendation_evaluations` — 20 columns, migration 002

Whether a recommendation worked, measured against the SKU's own trailing rate.

> **This table is empty in production as of 17 September 2026.** The job exists
> but is not scheduled. There is also a live defect:
> `recommendationEvalService.js` computes lift **inline** rather than calling
> the pinned `lib/lift.js`, so turning the loop on today would accumulate
> outcomes under a definition nothing verifies. See
> [ENGINE-REVIEW-RESPONSE.md](ENGINE-REVIEW-RESPONSE.md) §1 (M11).

### 3.4 `recommendation_sku_state` — 10 columns, migrations 002, 003

Per-SKU state captured **at recommendation time**: trailing baseline, unit cost
(added by 003), and the cooldown that stops one product being recommended every
morning. Captured then, not looked up later, because a cost read six weeks
afterwards is not the cost the decision was made on.

### 3.5 `recommendation_admission` — 10 columns, migration 017

Sheet 02's answer to *"is this store's data fit to recommend from?"* — a batch
that failed the quality gate produces a row explaining the refusal rather than
silently producing nothing.

### 3.6 `recommendation_family_gate` — 14 columns, migration 019

**Per store × family**, one of `shadow` / `live` / `suspended`.

| Column | Meaning |
|---|---|
| `client_id`, `location_id`, `family` | **Primary key** |
| `state` | `shadow` (computed, stored, scored, **not shown**) → `live` → `suspended` |
| `reason` | Why, in words — defaults to `not_enough_outcomes` |
| `inherited` | Whether the verdict came from a parent scope rather than this store's own evidence |
| `n_outcomes`, `p_value`, `observed`, `null_mean` | The randomisation test behind the verdict |
| `previous_state`, `state_changed_at` | So a flip is visible rather than inferred |

A family is shown at a store **only** once it has beaten a volume-matched null
*at that store*. It is a table rather than a serve-time computation because the
verdict is a randomisation test over 400 matched baskets — far too expensive to
run while a request is waiting, and it should not change between two page loads
on the same evidence.

### 3.7 `recommendation_outcomes` — 31 columns, migration 020

The rebuild's outcome ledger, **shown and withheld alike**. Its migration header
puts it plainly:

> *Nothing in the architecture improves without this table.* Calibration (08)
> needs outcomes to fit a curve. The shrinkage constant *k* (06) needs outcomes
> to be fitted from. The gate (17) needs outcomes to judge. Cohort priors (05)
> need outcomes to sharpen. **Every PROVISIONAL setting in the registry stays
> provisional until this loop has run.**

95 of the 112 registry settings are still PROVISIONAL, and this table is why.

---

## 4. Daily capture

Fully documented in **[DAILY-CAPTURE.md](DAILY-CAPTURE.md)** — summarised here
for completeness.

| Table | Grain | The point |
|---|---|---|
| `daily_store_signals` | (store, store-local day) | The **complete untrimmed** signal bundle the engine received, plus `source_health` distinguishing "worked", "dormant by design" and "should have worked and didn't" |
| `signal_source_payloads` | (source, geo_scope, geo_key, date) | Raw upstream responses keyed by **geography, not store** — one NWS gridpoint is byte-identical for every store on it |
| `daily_store_recommendations` | (store, store-local day) | The rank-ordered array the store was given |

Two columns to know about:

- **`bundle_fidelity`** — `full` or `display_trimmed`. A trimmed row is honest
  history but **not training data**, and the column defaults to the pessimistic
  value on purpose.
- **`signal_date` / `rec_date`** — the **store's** calendar date, not UTC and
  not the server's. The 04:00 cron is the previous evening in every US zone; a
  UTC key labels the whole network's Tuesday as Wednesday.

---

## 5. The feature store

### 5.1 `feature_daily` — 12 columns, migration 018, **partitioned**

One definition of velocity, replacing three that disagreed.

| Column | Type | Notes |
|---|---|---|
| `client_id`, `location_id`, `sku`, `obs_date` | | **Primary key** |
| `units_sold`, `revenue`, `unit_cost`, `price` | `numeric` | **Nullable, and NULL means absent — never zero** |
| `on_hand` | `numeric` | Filled forward by the daily capture job; `COALESCE`d on write so it **never rewrites a fact** |
| `baskets_containing` | `integer` | |
| `known_at` | `timestamptz` | When *we* learned it. Point-in-time reads filter on this |
| `updated_at` | `timestamptz` | |

**Range-partitioned by month — 58 partitions**, plus `feature_daily_default`
for anything outside the declared ranges.

> `NULL` versus `0` is the distinction this table exists to preserve. A SKU that
> sold nothing on an open day is a real observation of zero; a SKU on a day we
> never synced is an absence. `Number(null) === 0` in JavaScript, which is how
> the two became the same thing in the code this table replaced — and how
> 12,091,569 rows of NULL `on_hand` were once read as "no stock anywhere".

### 5.2 `feature_store_day` — 12 columns, migration 018

The dense calendar, one row per store per day, carrying `was_open` and
`has_data` as **separate facts**.

A Sunday closure is known and permanent. An unsynced day is unknown and may
fill in tomorrow. Neither belongs in a denominator, and conflating them makes a
lagging store look shut. Every rate in the engine divides by
`was_open AND has_data`, which is what "open days, never calendar days" means
in practice — and that distinction is worth ~14% on every rate at a store that
closes Sundays.

---

## 6. Ingestion and quality

| Table | Migration | What it holds |
|---|---|---|
| `sync_raw_log` | 016 | Every batch as received, **before** interpretation — so a parser bug is repairable rather than a permanent loss |
| `sync_store_state` | 016 | Per-store ingestion state, last success, staleness |
| `sync_connector_digest` | 016 | What the connector *claims* it sent, to compare against what arrived |
| `data_quality_results` | 017 | Gate results per store per run |
| `store_quality_state` | 017 | Current verdict per store |

These live in `analytics-migrations/` rather than `migrations/` for a reason
worth stating: the sheet that specified them said to put them in the syncgo
folder, and **the app role on syncgo is SELECT-only by design.** Tables that must
be written cannot go there. The migration header records the disagreement and
the decision.

`sync_connector_digest` exists because "the connector says it sent 40,000 rows"
and "40,000 rows arrived" are different claims, and only comparing them catches
a connector that silently drops a page.

---

## 7. Quick PO

| Table | Migration | Notes |
|---|---|---|
| `purchase_orders` | 008 | 32 columns. `content_sha256` (013) recognises a re-uploaded **file**; `duplicate_of` (021) recognises a re-scanned **invoice** |
| `purchase_order_items` | 008 | 23 columns — parsed lines with `matched_sku` |
| `purchase_order_events` | 010 | Audit trail; backfilled by 011 |
| `po_manual_products` | 009 | **Exists because `syncgo.products` is a mirror the app cannot write to** — verified, not assumed: `SELECT = true, INSERT = false` |
| `po_recommendations` | 005 | Buying-report recommendations |
| `po_recommendation_outcomes` | 005 | Whether those worked |

The two duplicate-detection columns answer different questions and both are
needed: a sha256 catches a byte-identical re-upload, and only the
`(vendor, invoice_no)` identity catches the same invoice **re-scanned**, which
produces different bytes. See migration 021's header.

---

## 8. Card Statement Analysis

| Table | Migration | Notes |
|---|---|---|
| `card_statements` | 023 | 38 columns. **Scoped to `client_id`**, not the store: `location_id` is audit only. Header columns for the list; `extracted`, `analysis` and `reconciliation` as jsonb, read whole. `content_sha256` catches a re-uploaded **file**; the unique partial index `card_statements_identity_uniq` (merchant number + period end, `analysed` rows only) catches the same **statement** read twice, which becomes a `duplicate` tombstone |
| `card_statement_events` | 024 | Append-only audit trail; cascades with the statement |

Grants are in 025: `card_statements` gets SELECT, INSERT, UPDATE, DELETE;
`card_statement_events` gets SELECT and INSERT only, and both sequences get
USAGE, SELECT. `rebelipay_savings` is stored raw (negative when Rebelipay would
cost more) so savings to date stays honest; the API never returns it negative.
Rows stuck in `analysing` after a restart are swept to `failed` at boot and on
reads; the boot sweep is the one statement in the feature without a
`client_id` predicate. The re-upload check also matches `duplicate` tombstones
(and points at their original), which the partial hash index does not cover;
it falls back to the per-client index. On any other environment, run
`npm run migrate --prefix backend` with `ANALYTICS_MIGRATE_DSN` before the
backend ships, since `MIGRATE_ON_BOOT` is off in production by default. See
[CARD-STATEMENTS.md](CARD-STATEMENTS.md) sections 2 and 10.3.

---

## 9. Everything else

| Table | Migration | Notes |
|---|---|---|
| `chat_interactions` | 000 | Chat telemetry — separate from recommendations on purpose |
| `feedback` | 000 | Owner feedback |
| `storeagent_capability_results` | 000 | StoreAgent capability probes. `routes/storeagent.js` contains an **unguarded `DELETE FROM`** on this table inside a lazy-migration path — flagged, not fixed |
| `product_first_seen` | 001 | When a SKU first appeared. Exists because `syncgo.products.last_updated` **mutates on every touch**, so it cannot answer "is this new?" |
| `ig_hashtags`, `ig_hashtag_snapshots`, `ig_dynamic_terms`, `meta_token_history` | 005, 006 | Instagram trend tracking |
| `schema_migrations` | — | The runner's ledger: filename, checksum, applied-at |

---

## 10. Things to know before trusting this

**`000_base_tables.sql` is a recovered baseline.** The file was missing from
version control while `schema_migrations` recorded it as applied, so five core
tables had no DDL in the repo and a fresh database could not be provisioned
from it. The DDL was transcribed from the live schema and marked `-- @baseline`,
which tells the runner to reconcile the checksum and **not re-execute**.
Consequence, stated plainly: **editing a `@baseline` file changes no existing
database.**

**Migrations 001–004 are drifted** — edited after being applied. `npm run
migrate` warns about each on every run. They need either a documented
reconciliation or a fix-forward file.

**Local and Neon have diverged by six tables** (September audit). The migrations
say what *should* exist; they do not currently tell you what *does* on any
particular deployment. Run `npm run migrate:status` against the environment you
actually care about.

**42.8% of `sale_items` sits in the DEFAULT partition** (pre-April 2025) — that
is `syncgo`, not here, but it slows every multi-year query the forecaster needs
and is on the remediation list as R24.

**Two tables that matter are empty.** `recommendation_evaluations` and
`recommendation_outcomes` have no rows in production. Until they do, every
"is it working" question is answered by backtest rather than by measurement,
and 95 of 112 registry settings stay PROVISIONAL.

---

## 11. Working with it

```bash
cd backend
npm run migrate                 # apply (idempotent)
npm run migrate:status          # applied / pending / baseline / DRIFTED
npm run migrate:dry-run

node tests/daily-snapshot-verify.js   # 30 checks, capture layer
node tests/po-duplicate-verify.js     # 21 checks, invoice de-duplication
node tests/lift-parity-verify.js      # lift.js == lift.py, digit for digit
```

```sql
-- Every table and its size, largest first.
SELECT relname, pg_size_pretty(pg_total_relation_size(c.oid)) AS size
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
 ORDER BY pg_total_relation_size(c.oid) DESC;

-- Which migrations this database has actually run.
SELECT filename, applied_at FROM schema_migrations ORDER BY filename;

-- feature_daily partition coverage.
SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) AS range
  FROM pg_inherits i
  JOIN pg_class c ON c.oid = i.inhrelid
  JOIN pg_class p ON p.oid = i.inhparent
 WHERE p.relname = 'feature_daily'
 ORDER BY 1;
```

---

## 12. Related documents

| Document | Covers |
|---|---|
| [DAILY-CAPTURE.md](DAILY-CAPTURE.md) | Migrations 014/015 in full — the daily capture layer |
| [QUICK-PO.md](QUICK-PO.md) | Migrations 008–013, 021 — invoice capture |
| [CARD-STATEMENTS.md](CARD-STATEMENTS.md) | Migrations 023-025: card statement analysis, its API and its Rebelipay rules |
| [SHEET-03-FEATURE-STORE.md](SHEET-03-FEATURE-STORE.md) | Migration 018 — open days, and why velocity had three definitions |
| [SHEET-17-THE-GATE.md](SHEET-17-THE-GATE.md) | Migration 019 — the shadow/live gate |
| [SHEET-19-OUTCOME-FEEDBACK.md](SHEET-19-OUTCOME-FEEDBACK.md) | Migration 020 — the outcome loop |
| [ENGINE-REVIEW-RESPONSE.md](ENGINE-REVIEW-RESPONSE.md) | The two-lift-definitions defect, and what blocks turning the loop on |
| [project-overview.md](project-overview.md) §4 | The three databases and their roles |
