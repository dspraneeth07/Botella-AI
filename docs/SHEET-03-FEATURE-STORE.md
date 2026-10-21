# Sheet 03 — Feature store

**Status:** complete. 28 Python + 8 Node checks, all green. **Reconciles exactly.**
**Depends on:** 00, 02. **Blocks:** 04, 05, 07, 09. **Wave:** 1.
**Nature:** additive. New Python package, one migration. No caller migrated yet (§10).

> *"The highest-value sheet in the programme, because it removes an entire
> class of defect rather than one instance."*

---

## 1. The problem

Velocity is computed in `app/store_data/velocity.py`, again in
`backend/lib/metrics.js`, and again in SQL inside individual chat tools. When
those definitions disagree you get **454 versus 485** — the same question
answered twice, differently, with neither marked as the authority.

A feature store means the number is computed once and read everywhere. It is
also what makes training and inference consistent: the model trains on the same
rows the pipeline will read at decision time.

---

## 2. What I verified before building

Every number in this document was measured on the live warehouse.

### 2.1 The Bethany claim is right

Sheet: *"Bethany closes every Sunday, plus Thanksgiving, Christmas, New Year.
199 closed days across the backtest period… understates velocity by ~16%."*

Measured on **171:171 Bethany Discount Liquor, Allen TX**:

| | Measured | Sheet |
|---|---:|---:|
| Calendar days | 1,358 | — |
| Trading days | 1,158 | — |
| **Closed days** | **200** | 199 |
| …of which Sundays | **191** | "every Sunday" ✓ |
| …scattered holidays | 9 (2 Mon, 2 Wed, **5 Thu**) | "Thanksgiving, Christmas, New Year" ✓ |
| **Understatement** | **14.7%** | ~16% |

The five Thursdays are Thanksgiving. The sheet is correct in substance and
within a day of correct in detail.

On a recent 28-day window: **24 open days, 5,945 units** →
**212.32** per calendar day vs **247.71** per open day — a **14.3%** error.

### 2.2 The data-frontier anchor is real — and its defence is also real

`app/store_data/__init__.py:~87` does anchor to `max(sale_date)`. But its
comment defends the choice:

> *"The source DB can lag; if we anchored to 'now' the recent buckets would
> silently lose days and every SKU would look like it's trending down."*

**That concern is legitimate**, and simply switching the anchor to `as_of`
would reintroduce it. The sheet says anchor to `ctx.as_of`; the existing code
says that causes false downtrends. **Both are right.**

The resolution is not to pick a side. Anchor to `ctx.as_of` **and** treat
unsynced days exactly as closed days are treated — absent, excluded from the
denominator. The false downtrend disappears because the missing days are never
divided by, and the window is the one production will actually use.

That is why `has_data` is a **separate column** from `was_open`. It is the
whole reason the two concerns can both be satisfied.

### 2.3 The grain must be sparse — dense is 21× over budget

The sheet targets ~317M rows at 1,500 stores. Measured:

| Grain | Today (~105 active stores) | At 1,500 stores |
|---|---:|---:|
| **Dense** (every store × SKU × day) | 458,964,545 | **6,556,636,357** |
| **Sparse** (only where observed) | 12,111,902 | **173,027,171** |

Dense is **21× over** the target and was never viable. Sparse fits with room.

But sparse creates the problem this design turns on: **"no row" is ambiguous** —
closed, or open but this SKU didn't sell? Conflating those is the exact defect
the sheet exists to remove. So the calendar is a **second, dense table** at
(store, day) grain — 1,500 × ~1,100 days ≈ **1.65M rows**, trivial.

**Numerator from the sparse facts; denominator from the dense calendar.**

### 2.4 There is no historical on-hand, and I did not invent one

`products.stock_qty` is **current-only** (`last_updated` mutates on every
sync). So `on_hand` is NULL for every historical row, populated forward only.

Back-filling from today's stock would be the most confident lie in the table:
it would tell a backtest that a SKU which stocked out in March had 40 units all
along.

---

## 3. Files

| File | Lines | What |
|---|---:|---|
| `backend/database/analytics-migrations/018_feature_store.sql` | 215 | `feature_daily` (sparse, 58 monthly partitions) + `feature_store_day` (dense calendar) + `ensure_feature_partitions()`. |
| `Botella_External_APIs/app/pipeline/features/store.py` | 400 | **The reader — the one definition.** |
| `Botella_External_APIs/app/pipeline/features/build.py` | 400 | Incremental builder + the canonical extraction SQL. |
| `Botella_External_APIs/app/pipeline/features/__init__.py` | 55 | Public surface. |
| `Botella_External_APIs/tests/test_feature_store.py` | 400 | 28 tests. |
| `backend/tests/feature-store-reconcile.js` | 200 | The reconciliation, against the real `getSales`. |

> Migration numbering: the sheet says `015_feature_store.sql`. 015 is
> `daily_store_recommendations` and 016/017 are taken, so it is **018**.

---

## 4. The grain

```sql
feature_daily(client_id, location_id, sku, obs_date)      -- SPARSE
  units_sold, revenue, unit_cost, on_hand, price,
  baskets_containing, known_at
  PARTITION BY RANGE (obs_date)                            -- 58 monthly parts

feature_store_day(client_id, location_id, obs_date)        -- DENSE
  was_open, has_data, open_source,
  baskets, revenue, units_total, distinct_skus
```

**NULL means genuinely absent, everywhere.** Never zero-filled.

The calendar has **three** states, and keeping them apart is the point:

| `was_open` | `has_data` | Meaning | In the denominator? |
|---|---|---|---|
| true | true | The store traded | **Yes** |
| false | true | Closed — Bethany's 191 Sundays | No |
| true | false | Unknown — sync hasn't delivered | No |

`open_source` records *how* it was decided: `observed` / `assumed_closed` /
`no_sync`, so a measured closure is distinguishable from an assumed one.

---

## 5. The four rules, as implemented

### Rule 1 — closed days are absent, not zero

```python
open_days = sum(1 for c in calendar if c.was_open and c.has_data)
units_per_open_day = units / open_days        # never / calendar_days
```

`open_days` travels in `Provenance.own_observations`, so the denominator is
disclosed with the answer. The result also carries
`calendar_understatement_pct` — the size of the error this table removes,
attached to every read so the argument never has to be taken on faith.

**A long silence is an outage, not a closure.** A store does not shut for five
days without warning nearly as often as a connector dies, and labelling an
outage "closed" hides it behind a plausible-looking calendar while quietly
shrinking the denominator. Runs of ≥5 non-trading days are marked `no_sync`.

### Rule 2 — point-in-time correctness

`known_at` records when **we** learned a fact, not when it happened. A read as
of 3 March filters `known_at <= as_of`, so late-arriving rows are invisible.

`known_at` is **never advanced on update** — it records when the fact *first*
became known. Moving it forward would let a backtest see a row earlier than it
really arrived.

"Latest price" means latest *within the window and within what was known* —
never the current value, which would leak the present into the past.

### Rule 3 — anchor to `ctx.as_of`

```python
def window_bounds(ctx, window_days):
    return ctx.as_of - timedelta(days=window_days - 1), ctx.as_of
```

One function, no alternative path. A store four days behind gets the **same**
window production will use, with those four days counted as `unsynced` rather
than silently shifting the window (§2.2).

### Rule 4 — one definition

Every read goes through `read_window`, a pure function of
`(facts, calendar, ctx)`. A training read at a past `as_of` and an inference
read today go through the **identical** function — which is the bug that
silently poisons most forecasting systems.

The extraction SQL copies the canonical sales rule exactly:

1. **UPC→SKU canonicalisation** (`DISTINCT ON (jk)`, sku claim first, then stock)
2. **VOID receipts excluded** by `sale_id`
3. **`quantity > 0`** only
4. **Non-empty sku** only
5. **`units = SUM(quantity)`**, `price = SUM(total_amount)/SUM(quantity)` —
   revenue-weighted, never a plain AVG (ARCHITECTURE Rule 6a)

Deviating by one of those would recreate 454-vs-485 in a new place.

---

## 6. Reconciliation — the sheet's hardest requirement

> *"If it does not, STOP and report the discrepancy rather than adjusting the
> feature store to match."*

The test calls the **real** `integrationService.getSales` — not a copy of its
SQL — and compares. Result on Bethany:

```
Reconciling store 171:171, 28 days to Sep 21
  canonical (getSales)  units      5,945  skus  1040  days 24
  feature store         units      5,945  skus  1040  days 24
  ok   1  TOTAL UNITS match exactly
  ok   2  the same SKUs appear
  ok   3  the same trading days appear
  ok   4  every SKU reconciles individually
```

**Exact, including per-SKU.** Verified on five stores across four connectors
(171:171, 46:46, 20:20, 2:2, 88:88) — all exact.

What is *not* reconciled, deliberately: the window **anchor**. `getSales`
anchors to `max(sale_date)`; the feature store anchors to `ctx.as_of`, by
design. The test pins both to the same days so it compares the *aggregation*
rule honestly; the anchoring difference is tested separately in Python.

---

## 7. Partitions, and the lesson from sheet 02

Sheet 02 found syncgo's `sale_items` partitions stop at **2026-11-30** — in
~10 weeks every new sale lands in DEFAULT silently. This table will not repeat
that quietly:

- **58 partitions**, 2023-01 → 2027-09 (a year of runway)
- `ensure_feature_partitions(from, to)` — idempotent, callable by cron
- A DEFAULT partition that **must stay empty**; a row in it is an incident
- Monitoring queries in the migration footer

```sql
SELECT count(*) FROM feature_daily_default;   -- must be 0
SELECT ensure_feature_partitions(current_date, current_date + interval '12 months');
```

---

## 8. Every store, empty to full

| | EMPTY | PARTIAL | FULL |
|---|---|---|---|
| No calendar at all | `no_calendar_for_window` | — | — |
| < 3 open days | refuses, names closed vs unsynced | — | — |
| A SKU that never sold | — | **units 0.0 over real open days** | — |
| 4 days behind on sync | — | rate unchanged, 4 days excluded | — |
| Healthy | — | — | rate over 24 open days |

The distinction that matters: **a SKU that never sold is a genuine zero** — the
store *was* open and it didn't sell — so the rate is `0.0`, not NULL. A closed
day is NULL. Those are different facts and the tests hold them apart.

---

## 9. Verification

```bash
cd Botella_External_APIs
./.venv/Scripts/python.exe -m pytest tests/test_feature_store.py -q   # 28 passed
./.venv/Scripts/python.exe -m pytest -q                               # 603 passed
./.venv/Scripts/python.exe scripts/check_no_literals.py               # exit 0

cd backend
npm run migrate                                        # applies 018
node tests/feature-store-reconcile.js                  # Bethany, 8 checks
node tests/feature-store-reconcile.js 46 46 28         # any store
```

| Sheet "done when" | Status |
|---|---|
| Velocity answered by one read | ✅ `read_window` |
| …and velocity.py / metrics.js / chat tools call it | ⏳ **not yet — §10** |
| Point-in-time read returns what was known then | ✅ `known_at`, 3 tests |
| Closed days absent, open-day count queryable | ✅ `feature_store_day`, 6 tests |
| Reconciles to the Purchasing screen exactly | ✅ **exact on 5 stores, per-SKU** |

---

## 10. Not done — read this before starting sheet 04

- **No caller has been migrated.** The sheet says *"Write the reader first,
  then migrate callers in a follow-up commit."* The reader is written and
  reconciles; `velocity.py`, `metrics.js` and the chat tools **still compute
  their own**. Until that follow-up lands, 454-vs-485 is still possible — the
  cure exists but is not yet applied.
- **RESOLVED in [sheet 06A](SHEET-06A-INTEGRATION.md).** The builder exists
  (`backend/services/featureStoreService.js` +
  `scripts/build-feature-store.js`) and has run across the estate: 94/94
  stores, 12,091,569 fact rows, 60,882 calendar days, 0 in the DEFAULT
  partition. All three remaining calendar-day divisors are migrated.
  One correction to this sheet: it named `backend/lib/metrics.js` as holding a
  duplicate velocity definition. **That file contains no velocity code at
  all** - both Node divisors were in `recommendationEvalService.js`.
- **`on_hand` will be NULL for all history** and cannot be otherwise (§2.4).
- **Sheet 02's gates are still not wired into the daily run**, so
  `store_quality_state` remains empty and every store reads `unknown`.
- **All 15 registry settings are PROVISIONAL** (5 new here). By design — wave 6
  fits them.
