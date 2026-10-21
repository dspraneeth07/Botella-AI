# Recommendation engine rebuild — index

The running record of the rebuild: what has landed, what it changed, and where
to read the detail. One row per sheet. Update it when a sheet lands.

**Two codebases, one contract.**

| | Path | Role |
|---|---|---|
| Python | `Botella_External_APIs/` | Signals, the pipeline, the stages. Stateless. |
| Node | `backend/` | Persistence, tenancy, serving. The only writer of `bottleai_analytics`. |

---

## Status

| Phase | Sheet | Title | Status | Detail | 
|---|---|---|---|---|
| 0 | — | Data layer: daily capture of recommendations + signals | ✅ done | [DAILY-CAPTURE.md](DAILY-CAPTURE.md) |
| 0 | 00 | The stage envelope | ✅ done | [SHEET-00-STAGE-ENVELOPE.md](SHEET-00-STAGE-ENVELOPE.md) |
| 1 | 01 | Data ingestion — durability, isolation, connector digest | ✅ done | [SHEET-01-DATA-INGESTION.md](SHEET-01-DATA-INGESTION.md) |
| 1 | 02 | Data contracts + quality gates — the right to refuse | ✅ done | [SHEET-02-DATA-CONTRACTS.md](SHEET-02-DATA-CONTRACTS.md) |
| 1 | 03 | Feature store — one definition of velocity | ✅ done | [SHEET-03-FEATURE-STORE.md](SHEET-03-FEATURE-STORE.md) |
| 2 | 04 | Evidence + peer engine — n, and "stores like yours" | ✅ done | [SHEET-04-EVIDENCE-PEERS.md](SHEET-04-EVIDENCE-PEERS.md) |
| 2 | 05 | Cohort prior engine — cold start, always resolves | ✅ done | [SHEET-05-COHORT-PRIORS.md](SHEET-05-COHORT-PRIORS.md) |
| 3 | 06 | Shrinkage — cold start becomes a weight, not a branch | ✅ done | [SHEET-06-SHRINKAGE.md](SHEET-06-SHRINKAGE.md) |
| 3 | 06A | **Integration — the pipeline runs on real data** | ✅ done | [SHEET-06A-INTEGRATION.md](SHEET-06A-INTEGRATION.md) |
| 3 | 07 | **Forecast ensemble — one method per demand shape, p10/p50/p90** | ✅ done | [SHEET-07-FORECAST-ENSEMBLE.md](SHEET-07-FORECAST-ENSEMBLE.md) |
| 6 | 08 | **Calibration — fitted from outcomes, applied before the decision** | ✅ built, shipping as identity | [SHEET-08-CALIBRATION.md](SHEET-08-CALIBRATION.md) |
| 3 | 09 | **Elasticity — β with an interval, and silence when it spans zero** | ✅ done, gate off by default | [SHEET-09-ELASTICITY.md](SHEET-09-ELASTICITY.md) |
| 3 | 10 | **Inventory policy — reorder point and safety stock** | ✅ done, not yet wired to callers | [SHEET-10-INVENTORY-POLICY.md](SHEET-10-INVENTORY-POLICY.md) |
| 2 | 11 | **Business constraints — ideal quantity → orderable** | ✅ done, not yet wired to callers | [SHEET-11-BUSINESS-CONSTRAINTS.md](SHEET-11-BUSINESS-CONSTRAINTS.md) |
| 4 | 12 | **Candidate generation — typed actions carrying every figure** | ✅ done, not yet wired to callers | [SHEET-12-CANDIDATES.md](SHEET-12-CANDIDATES.md) |
| 4 | 13 | **Deterministic ranking — code, not a model** | ✅ done, not yet wired to callers | [SHEET-13-RANKING.md](SHEET-13-RANKING.md) |
| 4 | 14 | **Decision validation — is the decision correct, before any token is spent** | ✅ done, runs end-to-end on real stores | [SHEET-14-DECISION-VALIDATION.md](SHEET-14-DECISION-VALIDATION.md) |
| 5 | 15 | **Explanation — the model writes, it does not decide** | ✅ done, degraded path runs end-to-end | [SHEET-15-EXPLANATION.md](SHEET-15-EXPLANATION.md) |
| 5 | 16 | **Explanation validation — every numeral traced, or the prose is dropped** | ✅ done, runs on every card | [SHEET-16-EXPLANATION-VALIDATION.md](SHEET-16-EXPLANATION-VALIDATION.md) |
| 6 | 17 | **The gate — has this family actually worked at THIS store?** | ✅ done. **Holdout ON**; enforcement off until families go live | [SHEET-17-THE-GATE.md](SHEET-17-THE-GATE.md) |
| 5 | 18 | **Store interface — only what passed, with its reasoning** | ✅ done, renders as the pipeline supplies fields | [SHEET-18-STORE-INTERFACE.md](SHEET-18-STORE-INTERFACE.md) |
| 6 | 19 | **Outcome feedback — the loop everything else depends on** | ✅ done. **Wired end-to-end and scheduled nightly** | [SHEET-19-OUTCOME-FEEDBACK.md](SHEET-19-OUTCOME-FEEDBACK.md) |
| 6 | 20 | **Temporal reversion — the engine was ranking on the quantity it was getting wrong** | ✅ done. **39.3% → 65.6%, −$13,783 → +$14,508** | [SHEET-20-TEMPORAL-REVERSION.md](SHEET-20-TEMPORAL-REVERSION.md) |
| … | … | 1 further sheet | ⏳ not started | |

---

## Phase 0a — Data layer (prerequisite)

**Why.** The engine's daily output was not being kept in a form a rebuild could
be trained or back-tested against.

**What changed.**

- Three new tables in `bottleai_analytics`: `daily_store_signals` (the full
  untrimmed signal bundle per store per day), `daily_store_recommendations`
  (the day's rec set as served), `signal_source_payloads` (raw upstream
  responses, deduplicated by geography).
- `recommendation_runs` gained `rec_date` / `day_basis` / `timezone`.
- Python now reports per-source health and raw payloads; Node persists them.

**Three findings worth knowing.**

1. `000_base_tables.sql` was recorded as applied in every environment but
   **the file was never committed** — the core tables had no DDL under version
   control and a fresh database could not be provisioned from the repo. Fixed,
   with a `-- @baseline` pragma in the migration runner.
2. **The day key was wrong.** The 04:00 cron is the *previous evening* in every
   US timezone, so a UTC-keyed day misdates the whole network. Days are now
   keyed on the store's own calendar date, from the IANA zone NWS already
   returns and we were discarding.
3. **`source_health` caught a live outage during testing.** ESPN was returning
   500 on every request while sports health read *healthy with zero items* —
   the fail-soft fetcher swallowed its own error. Health now defers to the
   transport verdict.

**Verify:** `npm run migrate` · `node tests/daily-snapshot-verify.js` (30 checks)

---

## Phase 0b — Sheet 00, the stage envelope

**Why.** A calculation read the database wherever it needed to, took the date
from the process clock, and returned a bare number. That is why the 23%
backtest could not be traced to a specific input, and why the dead-stock tile
said 454 while chat said 485.

**What changed.** A new `app/pipeline/` package defining the contract every
future stage is written against: `RunContext` in, `StageResult` + `Provenance`
out, thresholds declared in a registry, and a build guard that makes the old
habits fail CI.

**The shape of it, in one line each:**

- `RunContext` — everything a stage may know. `as_of` is THE clock.
- `Provenance` — how it decided, travelling *with* the value, never in a log.
- `StageResult` — `ok=False` is a legitimate outcome carrying reasons.
- `Setting` — every threshold declared once, with an owner, a unit, a reason
  and a status (`PROVISIONAL | FITTED | MEASURED`).
- `replay(audit_row)` — re-executes a recorded stage and proves it matches.
- `check_no_literals.py` — no magic numbers, no clock/env/DB/network in a stage.

**Purely additive.** No existing module was modified.

**Verify:** `pytest -q` (537 passed) · `scripts/check_no_literals.py` ·
`node tests/stage-envelope-verify.js` (24 checks)

**Open items:** 49 grandfathered literals in `storeagent/`; the CI test stage is
`when: manual` until the runner's Python toolchain is confirmed. Both are
explained in [SHEET-00-STAGE-ENVELOPE.md §7](SHEET-00-STAGE-ENVELOPE.md).

---

## Wave 1 — Sheet 01, data ingestion

**Why.** Ingestion works; it lacks isolation and replay. **132,611 of 519,702
sync runs have failed — 25.5%.** At 94 stores a person reads those. At 1,500
they are background noise and stores go dark unnoticed.

**What changed.** A new control plane around the (external) POS fetcher:
`sync_raw_log` lands every fetch before parsing, `sync_store_state` holds the
staleness marker downstream stages refuse on, `sync_connector_digest` reports
**one row per connector per day**. Plus a failure classifier built from the real
error corpus, and a batch runner where one store's failure cannot abort the run.

**What the first run found, none of it previously visible:**

- A store **dark for 169 days** — and it has no `client_pos_config` row at all.
- **Square: 0 runs, 27 stale stores, 116-day worst case.** A connector that is
  entirely silent and previously read as healthy.
- **MPower: 231 never-synced job-entities**; Clover: 195, and 100% failure
  (98/98 runs), every one a `401`.
- **38 Gokul jobs that can never succeed** —
  `Service 'GokulService' does not implement method 'ProcessSupplier'`.
- **MPower, Square and Gokul send no cost data at all** — 0.00% across 31
  stores and 355k SKUs. *The sheet blamed Korona; Korona is at 88.4%, and
  PCAmerica does not exist in the estate.*

**A bug in my own first implementation, worth recording.** `refreshSyncState`
derived its universe from *runs in the last 30 days*, so **662 of 935
configured jobs (71%) got no state row at all** — a store that stopped syncing
two months ago was invisible. That is "stores go dark unnoticed", reproduced by
the mechanism built to prevent it. Anchoring the universe on the `jobs` table
took state rows from **273 → 940**, never-synced detection from ~51 → **587**,
and surfaced the 169-day store and the silent Square connector.

**Three deviations, each with a reason** (detail in the sheet doc §2):
the work is **not** in `integrationService.js` (that file does no fetching);
the migration is **analytics 016**, not `migrations/003_` (the app role is
SELECT-only on syncgo by design); coverage is **measured live**, not asserted
from the sheet's stale figures.

**Verify:** `node tests/ingestion-verify.js` (49 checks) ·
`node tests/store-spectrum-verify.js` (30 checks) ·
`GET /api/ingestion/digest?format=text`

**Open item:** the external fetcher does not call `POST /api/ingestion/raw`
yet. Everything else works today via `POST /api/ingestion/refresh-state`, which
derives the same state from `job_runs_history`. **This is the one hand-off
sheet 01 needs from the connector team.**

---

## Wave 1 — Sheet 02, data contracts and quality gates

**Why.** Nothing stood between a malformed POS payload and a recommendation.
This sheet gives the system the **right to refuse**: a store whose data fails
its contract produces no recommendation and a stated reason.

**What changed.** `app/pipeline/contracts/` — 18 versioned contracts across 9
connectors, and four gates (schema, completeness, freshness, anomaly), each a
sheet-00 stage: pure, replayable, provenance-carrying. Plus migration 017 and
the **admission gate** that decides what an owner actually sees.

**Three corrections to the sheet, all measured:**

1. **The 43% DEFAULT partition is not malformed data.** All 8,616,193 rows have
   valid dates (2023-01-01 → 2025-03-31); they simply predate the oldest
   partition. **The real risk is the forward edge — partitions stop at
   2026-11-30, about ten weeks out, after which every new sale lands in DEFAULT
   silently.** That is an ops ticket someone needs to open now.
2. **Korona is one of the best connectors (88.4% cost), not the worst**, and
   PCAmerica is not in the estate — same error as sheet 01. The zero-cost
   connectors are mpower, square and gokul.
3. The migration is **017**, not 014 (014–016 are taken).

**Freshness is relative, and that is the subtle part.** A weekly store is
healthy at 6 days and broken at 20; a daily store is broken at 6. Same days,
opposite verdicts, judged against each store's **own** median sync interval.

**One bug class, four occurrences, now a shared primitive.**
`Number.isFinite(Number(x))` is wrong for `null`, `''`, `[]` and `false` — all
coerce to `0`. It made a null order quantity suppress the figure on every
markdown, stored absent token counts as "0 tokens" and absent costs as
"$0.00", and kept a NULL-priced product as one priced at zero. All four now go
through `backend/utils/numbers.js` (absent in, null out), guarded by
`tests/numbers-verify.js`.

**Sheet 00 paid off twice here** — its literal guard failed the build on my own
`86400.0`, and `config_report` now reports **10 of 10 settings PROVISIONAL**
instead of `0 of 0`.

**Verify:** `pytest tests/test_contracts.py -q` (38) ·
`node tests/rec-admission-verify.js` (26)

**Open item:** the gates are **not yet wired into the daily run**, so
`store_quality_state` is empty and every store reads `unknown`, which admits.
That is the safe default and the first task of sheet 03.

---

## Wave 1 — Sheet 03, the feature store

**Why.** Velocity was computed in `velocity.py`, again in `metrics.js`, and
again in SQL inside chat tools. When those disagree you get **454 versus 485**.
One definition, computed once, read everywhere.

**What changed.** `feature_daily` (sparse, 58 monthly partitions) +
`feature_store_day` (the dense calendar), and
`app/pipeline/features/` — a reader and an incremental builder, both sheet-00
stages.

**The grain decision, measured not assumed.** The sheet targets ~317M rows.
Dense (every store × SKU × day) would be **6.5 billion — 21× over**. Sparse
(only where observed) is **173M**. Sparse is the only viable grain, which makes
"no row" ambiguous — closed, or open and didn't sell? So the calendar is a
**second, dense table** at store-day grain (1.65M rows). **Numerator from the
sparse facts, denominator from the dense calendar.**

**Bethany verified exactly.** 171:171 has **200 closed days, 191 of them
Sundays** (sheet said 199), and dividing by calendar days understates its
velocity by **14.7%**. On a 28-day window: 24 open days, 5,945 units →
212.32/calendar-day vs **247.71/open-day**.

**The data-frontier anchor, and why both sides were right.** The old code
anchors to `max(sale_date)` and its comment defends that — *"anchoring to now
would make every SKU look like it's trending down."* **That concern is real**,
and switching the anchor alone would reintroduce it. The resolution is to
anchor to `ctx.as_of` **and** treat unsynced days exactly like closed days:
absent, never in the denominator. That is why `has_data` is a separate column
from `was_open`.

**It reconciles exactly.** Against the real `integrationService.getSales`, on
five stores across four connectors: identical total units, identical SKU count,
identical trading days, **and every SKU individually**.

**Verify:** `pytest tests/test_feature_store.py -q` (28) ·
`node tests/feature-store-reconcile.js` (8)

**Both open items are now closed** — see
[Wave 3 — Sheet 06A](#wave-3--sheet-06a-integration). The builder has run
(94/94 stores, 12,091,569 rows) and every calendar-day divisor is migrated.

---

## Wave 2 — Sheet 04, evidence and peers

**Why.** Everything downstream needs one number: **n**, the usable observations
behind an estimate. The old engine had no such number, *which is why it was
equally confident about a store with four years of history and one with three
weeks.*

**What changed.** `app/pipeline/evidence/` — n per pattern (day-of-week,
weekly trend, monthly, SKU velocity, category), and a peer engine matching on
observable structure only. No migration; everything reads the feature store.

**Corrections to the sheet, all measured:**

1. **Store 122's "52 per weekday" is exactly right — over a one-year window**
   (it is 194 over full history). But **122 is not the worst-data store, it is
   close to the best**: a 7-day store with a full year is the *maximum*
   possible 52 of 52. The genuinely thin stores sit at 1–3.
2. **Two of the five peer signals do not exist.** There is no store
   format/size column and no population-density data anywhere in the estate.
   They are renormalised away and **declared on every match**, never defaulted
   to a neutral value.
3. **Four states hold exactly one store**, so "no same-state peers" is a real
   outcome, not an edge case.

**A flaw real data exposed in my own design.** The first version validated
cleanly on fixtures, then reported **n=1 for Bethany** — because it traded
exactly one Sunday out of 52 and the weakest-weekday rule took it literally. A
store with 49–52 observations on every day it genuinely trades looked like it
had no evidence. One-of-52 is not a thin sample, it is a day the store does not
open; those now fold into `not_applicable`. After the fix Bethany reports
**n=49 with Sunday excluded**.

**The third state the sheet does not name.** A pattern is not just sufficient
or insufficient — it can be **not applicable**. The difference is *"wait a
month"* versus *"this will never happen"*.

**Peers stay boring on purpose.** State is a *gate*, not a weight (a Texas and
a Maine store are not 60% similar). Similarity is symmetric by construction,
ties break deterministically for replay, and every match carries a sentence
sheet 15 can render: *"same state (TX); 94% category-mix overlap (mainly
whiskey and beer); comparable volume."*

**Verify:** `pytest tests/test_evidence.py -q` (37)

**Open item:** nothing consumes n yet — that is sheets 06, 07 and 15.

---

## Wave 2 — Sheet 05, the cohort prior engine

**Why.** This is what we tell a store that opened yesterday. Without it a
zero-data store gets nothing — or, as the current engine does, **something
invented with no stated basis**.

**What changed.** `app/pipeline/priors/` — a ladder that **always resolves**,
k-anonymity enforced at every rung, and dispersion attached to every prior.

**The finding that changed the design.** The sheet describes one ladder
(state → region → national). The data says it cannot keep its own promise:
**282,068 of 313,990 UPCs (89.8%) are carried by fewer than 5 stores**, so for
`sku_velocity` k fails at the *national* rung — the top of the geography
ladder, with nowhere left to climb.

The rescue is to widen the **unit**, not the map. Beer spans 71 stores, wine
67, vodka 57; **115 categories clear k=5 nationally.** So a rung is a pair —
`(geography, specificity)` — with `sku → category → all_products` as the
second axis. Geography is walked first at each specificity, because a
same-state *category* prior beats a national *SKU* prior.

**The ladder is load-bearing, not decorative:** 13 of 27 states hold fewer
than 5 stores, so climbing is the normal path.

**Store 170:170 records its state as `"Texas"`**, spelled out — a naive
two-letter lookup would drop it to national for no reason. Codes are
normalised first.

**k counts STORES, not rows**, and a cohort of five where one store is 96% of
the weight is refused too — that is a cohort of one wearing a disguise.

**The guarantee is fuzzed, not asserted.** 600 randomised shapes — empty
estates, bogus states, missing units, zero weights — and not one returns
`ok=False` or leaks a cohort below k.

**Verify:** `pytest tests/test_priors.py -q` (31)

**Open item:** nothing consumes the prior yet — sheet 06 blends it, sheet 07
turns its dispersion into interval width.

---

## Wave 3 — Sheet 06, shrinkage (the keystone)

**Why.** This is where cold start stops being a special case and becomes a
weight. Forty lines of arithmetic replace a tier system with branches — and
branches for rare cases are exactly the code that never gets tested and rots.

```
θ̂ = (n · θ_own + k · θ_cohort) / (n + k)

n = 0   → θ_cohort exactly.  a brand-new store. NO BRANCH TAKEN.
n = k   → the midpoint.
n >> k  → essentially own history. SAME THREE LINES.
```

**The absence of the branch is enforced, not requested.** Three mechanisms:

1. `blend()` contains **no conditional of any kind** — asserted against its own
   AST. Not "no tier gate": no `if`, no ternary, no `match`.
2. **Nothing anywhere branches on `evidence_state`** —
   `scripts/check_no_state_branches.py` walks every pipeline module and fails
   on a branch, `match`, comparison **or dispatch table**. It runs as a test.
3. No tier vocabulary (`tier`, `is_new`, `is_cold_start`) in executable code.

**The guard is itself tested.** Four shapes are planted — branch, conditional,
match, jump table — and each must be caught, because a silently broken guard
reads exactly like a clean codebase. The dispatch-table case was a real hole:
the first version missed `HANDLERS[p.evidence_state]`, which is a branch
spelled with brackets.

**Two edges needed care.** A store with n=0 has no `θ_own`, but the formula
needs a number — where it is multiplied by zero and annihilated. Rather than
assert that is harmless, a test **proves** it: `None`, `0.0`, `±1e9` and
`123.456` all give the identical answer. And mypy caught the first version
declaring that field `float | None` while guaranteeing a float — the annotation
was lying, so the normalised value now lives in its own field.

**No cliff.** Crossing the `EMERGING → ESTABLISHED` boundary moves the number
by **less than 2 units on a 100-vs-20 blend**. That boundary is exactly where
a tier system would jump.

**Verify:** `pytest tests/test_blend.py -q` (30) ·
`scripts/check_no_state_branches.py`

---

## Wave 3 — Sheet 06A, integration

**Why.** Six components existed, each proven in isolation, and none of them had
ever been handed a real row or called another. Every sheet since 03 carried the
same open item forward.

**What changed.**

- The feature store is **built across the estate**: 94/94 stores, 12,091,569
  `feature_daily` rows, 60,882 calendar days, 0 rows in the DEFAULT partition.
- All three remaining calendar-day divisors migrated to open days
  (`recommendationEvalService.js` ×2, `velocity.py`, `inventory_health.py`),
  each conditional on a calendar being supplied so no store's behaviour changes
  on a guess.
- `app/pipeline/assemble.py` runs 04 -> 05 -> 06 as one call, demonstrated on a
  308-open-day store and a 23-open-day store — same code path, only `n` differs.

**Seven defects, every one of them between two correct components.**

1. **24 stores timed out.** syncgo's `statement_timeout` is 15s; store 122's
   full-history aggregation takes 79.5s. The fact query is now date-chunked
   (proven neutral: 395,868 rows, 0 mismatches); the calendar query is
   deliberately *not* chunked, because its outage run-length detection would
   split one 9-day outage into two 4-day closures at a boundary.
2. **`push(...rows)` overflowed the call stack** on exactly the five largest
   stores — the ones chunking had just been added to rescue.
3. **Sheets 04 and 05/06 disagreed on two pattern names** (`monthly` vs
   `monthly_seasonality`, `category` vs `category_share`). Each module was
   internally consistent, so only assembly could surface it.
4. **The cohort prior was supplied at the wrong grain** — a store's total
   units/day (182.6) offered as the prior for one SKU's rate, inflating a
   3.9/day SKU to 17.5. The ladder, k-anon and the blend were all correct; the
   units were not.
5. **A `.catch(() => ({ rows: [] }))` hid a cross-database join** and silently
   emptied the category rung.
6. **The 15 stores that carry stock but have never sold anything got nothing
   at all** — the SKU list was seeded from sales, and `count_evidence` refuses
   an empty calendar. The store with the least of its own data was receiving
   the least help. Now seeded from inventory (ranked by peer prevalence) with
   a `no_sync` calendar, so n=0 is an *answer* rather than a refusal.
7. **95,074 SKUs carry more than one category**, and the exporter resolved
   category with a filter that ran before the pick — so an estimate moved
   depending on how many *other* SKUs you asked about (0.119 at `--top 12`,
   0.115 at `--top 20`). Now resolved once, globally, then filtered.

**Verify:** `node scripts/build-feature-store.js` (94/94, 0 failed) ·
`pytest -q` (724) · `node tests/feature-store-reconcile.js` ·
`store-spectrum-verify` · `stage-envelope-verify` · `tenant-leak-probe`

Detail: [SHEET-06A-INTEGRATION.md](SHEET-06A-INTEGRATION.md)

---

## Wave 3 — Sheet 07, the forecast ensemble

**Why.** `demand.py` applied essentially one approach to every SKU. Liquor
demand is not one shape, and the single method served the INTERMITTENT
majority worst — which is most of the catalogue (66 of store 171's top 120
SKUs).

**What changed.** Three PRs, all pure stdlib.

- `classify.py` — Syntetos-Boylan 2×2 from the feature store. ADI counted in
  **open days**, which is the sheet-03 join: counted as calendar days, every
  SKU in a six-day store looks ~17% more intermittent than it is and SKUs near
  the 1.32 cut get pushed into a different method by the store's opening hours.
  The two cuts are the programme's first **MEASURED** settings — published
  constants, not ours to tune.
- `ensemble.py` — five forecasters, **every one returning p10/p50/p90**. A bare
  point estimate is not an acceptable output. Lumpy SKUs may **refuse** when the
  interval is too wide to order against.
- `backtest.py` — rolling-origin, scored **per demand class**, verdict is an
  ALL and not an average. Extends the file; `backtest_daily` is untouched.

**ETS, not LightGBM.** The sheet offered either. This service has no numerical
stack at all — no numpy, no pandas, no sklearn — and the sheet itself notes
LightGBM is not bitwise deterministic across thread counts, which fights sheet
07's own reproducibility requirement.

**No trend term.** `forecast.ets.beta` defaults to **0.0**. The previous engine
scored 23% against a 32% random pick because it was told to chase accelerating
products, and momentum anti-predicts at this horizon (ρ = −0.36 at 60 days).
The backtest now re-measures ρ every run so the claim is a number, not a
comment.

**Six defects, all found by the backtest on real data, none by the unit tests:**

1. The bootstrap started the clock **on a sale**, so a SKU selling every ~36
   open days returned p10 = p50 = p90 = **0** over 30 days.
2. The first interval was drawn uniformly — the **inspection paradox** — giving
   a **+12.3%** bias against seasonal-naive's −1.0%.
3. The raw bootstrap median was the point estimate, so **Croston was never
   used** and the intermittent class lost: WAPE 54.3 vs naive 44.1.
4. Fixing (3) by scaling the finished totals exploded the tails — **p90 of 100
   became 12,052**.
5. `intervals` spanned only first-sale→last-sale, so the silence after a
   delisted product was invisible: mean(intervals) **1.29** against an ADI of
   **3.74**. 454-vs-485 in a new place.
6. An off-by-one meant the **last interval was never smoothed** — a SKU that
   sold 22.8/day for 584 days then stopped forecast **1,016 units against an
   actual of 0**.

**Result: 2 of 3 stores pass; store 122 fails on intermittent (35.2 vs 30.6)
and is reported as failing.** An α sweep showed α = 0.2 would close 122's gap
and make 171 and 125 worse, so α stays at 0.1 and wave 6 fits it. Tuning to
rescue one store is the overfit that produced the 23% backtest.

Two supporting scripts needed fixing to keep their promises: `check_no_literals`
flagged the published cuts while telling the author to declare them exactly as
they were declared (widened by one narrow shape, with four tests keeping it
tight), and `config_report` printed `MEASURED (0)` because it walked only
`app.pipeline` — it now reports all **60** settings.

**Verify:** `pytest -q` (788) · both guards · `run_pipeline.py b.json --forecast`

Detail: [SHEET-07-FORECAST-ENSEMBLE.md](SHEET-07-FORECAST-ENSEMBLE.md)

---

## Wave 6 — Sheet 08, calibration

**Why.** The backtest scored mean stated confidence **0.48 against an actual hit
rate of 0.23** — Brier 0.255, where 0.25 is a coin flip. A number that says 80%
and is right 23% of the time is worse than no number, because the interface and
the owner both treat it as meaningful.

The live table says the same thing another way. Across 79 stored
recommendations, mean stated confidence is **0.796**, and `reorder` — the
largest family — spans **0.87 to 0.95 across all 15 of its rows**. It has never
once said it was unsure. A number that never varies is not carrying information
about a world that does. And `recommendation_evaluations` holds **0 rows**:
seventy-nine confidences, zero outcomes.

**What changed.**

- `calibrate/fit.py` — isotonic regression (Pool-Adjacent-Violators, forty
  lines of pure stdlib, since this service has no sklearn) fitted **per
  (family, demand class)**, never pooled. A fit is a versioned artifact,
  `YYYY-MM-DD.<digest>`, not a mutable global.
- `calibrate/apply.py` — **online, before ranking**. That ordering is the whole
  sheet: it shapes what gets recommended rather than grading what already was.
- `calibrate/monitor.py` — Brier, ECE and a reliability curve per family, and
  **suspension as a routine state** rather than an incident.

**Wired into the real decision point.** `validator.py` caps recommendations in
three places — which trending survive, which cold_box demotes to endcap, which
endcap demotes to promote — and every one of them sorted on raw confidence.
They now sort on `_rank_confidence`, which reads the calibrated value, and
calibration runs immediately above them.

**Shipping as the identity transform, deliberately.** No family clears the fit
floor (the largest has 15 rows against a floor of 50) and none has an outcome.
So the plumbing ships complete and the transform is the identity — with a
*reason* on every single passthrough, because an unexplained passthrough and a
fitted curve look identical on the wire and the first would quietly become
permanent. A test asserts today's ranking is unchanged, which is what makes it
safe to ship the path before the curve.

**One field crossed a language boundary.** Adding `calibration_version` to
`Provenance` immediately failed the golden-fixture test that pins the audit-row
shape against `backend/lib/stageEnvelope.js`. Sheet 00's cross-language contract
working exactly as designed: the Node mirror now parses and validates the field,
and both golden fixtures were regenerated deliberately. Without the pin it would
have reached production as an `undefined` in a Node tile.

**Verify:** `pytest -q` (823) · both guards · `node tests/stage-envelope-verify.js`

Detail: [SHEET-08-CALIBRATION.md](SHEET-08-CALIBRATION.md)

---

## Wave 3 — Sheet 09, the elasticity engine

**Why.** Every markdown recommendation makes an implicit elasticity claim —
"drop the price and volume will more than compensate". The engine made that
claim with **no estimate behind it at all**.

**The result, on 335 real (store, category) cells:**

| outcome | cells | share |
|---|---:|---:|
| **may cite a profitable price cut** | **5** | **1.5%** |
| interval spans zero | 173 | 51.6% |
| **inelastic — a cut LOSES revenue** | **79** | **23.6%** |
| positive β — blocked | 30 | 9.0% |
| price never moved enough to fit | 48 | 14.3% |
| **BLOCKED** | **330** | **98.5%** |

Five of 335 cells support a profitable markdown. That is the sheet working,
not the estimator failing.

**What changed.** `elasticity/estimate.py` fits log-log OLS with day-of-week and
month controls and **HC1 robust standard errors** — classical ones would be too
narrow and would make intervals span zero *less* often, the one direction this
sheet must not be wrong in. `elasticity/guard.py` is the important half.

**`elasticity` became a first-class pattern**, added to the canonical
vocabulary, priors, blend and evidence — because sheet 07's bijection test
asserts those four agree, which forced the honest version rather than a special
case wired round the side. Its `n` is **distinct price levels, not days**: two
hundred days at one price say nothing about what happens when the price moves.

**Four defects found by running it on real data:**

1. **A positive β passed a spans-zero test.** Store 122's Tobacco came back
   +0.38 [+0.15,+0.61] — the interval excludes zero, so the naive test passed
   it, and it is evidence *against* the markdown it would have been cited for.
   30 cells are blocked by this rule alone.
2. **The dummy-variable trap with an absent reference.** 61 cells were refused
   as "collinear with price"; they were not. A category trading May–September
   contains no January, so every observed month got its own dummy and they
   summed to the intercept. Building the design from observed levels fixed it —
   **store 171 went from 0 usable elasticities to 19**.
3. **The stage-14 gate was a block-list**, so supplying *no* elasticity evidence
   let every markdown through — the exact state the sheet exists to end,
   reached by passing nothing. It is now an allow-list.
4. **The binding constraint was profitability, not statistics.** The guard
   tested whether the interval spanned zero; it did not test whether the effect
   was big enough for a discount to *pay*. **79 of the 84 cells that passed
   were still inelastic** — store 171's Vodka is −0.107 [−0.21, −0.00], a solid
   estimate nowhere near zero where a 10% cut buys 1.1% more volume and gives
   up about 9% of revenue. A markdown claims volume will "more than
   compensate", which is precisely |β| > 1. Statistically detectable and
   economically wrong are different things.

**The gate ships off by default.** Turning it on before any caller supplies
elasticity evidence would silently withhold most of today's markdowns; that is
a caller decision, not a default.

**Verify:** `pytest -q` (864) · both guards · `mypy app/pipeline/`

Detail: [SHEET-09-ELASTICITY.md](SHEET-09-ELASTICITY.md)

---

## Wave 3 — Sheet 10, inventory policy

**Why.** A forecast is not a decision. `buying.py` turns one into a quantity
with `safety = demand_cover * 0.25` — a flat percentage with no service level
in it, no sigma, and no lead-time scaling, so a vendor who takes three weeks
and one who takes three days get the same buffer on the same SKU.

**What changed.** `app/pipeline/policy/inventory.py`:

```
safety_stock  = z(service_level) · σ · √lead_time
reorder_point = μ · lead_time + safety_stock
order_up_to   = reorder_point + review_period · μ
ideal_qty     = order_up_to − on_hand − on_order
```

**Measured on 20 real SKUs from store 171**, same 21-day window, safety stock
only — method against method:

| forecast rel. width | flat 25% | z·σ·√L | ratio |
|---:|---:|---:|---:|
| 0.18 (tightest, smooth) | 22.5 | **6.1** | 0.27 |
| 0.62 (intermittent) | 12.6 | 11.8 | 0.94 |
| 1.24 (widest, lumpy) | 4.2 | **7.9** | 1.88 |

The ratio rises **monotonically with forecast width**. The flat buffer is
proportional to volume only, so it over-buffers the predictable by 3.7× and
under-buffers the unpredictable by half — exactly backwards. Flat varies 11.8×
across these SKUs (volume); the policy varies 17.4× (volume *and* uncertainty).

**σ comes from sheet 07's interval, and a forecast without one is REFUSED** —
substituting a default σ would produce a confident-looking quantity resting on
a number nobody measured. This is why sheet 07 had to return p10/p50/p90.

**Lead time confirmed absent a fourth time.** `purchases` has `date` and
`invoice_date` and zero columns matching receive/deliver/arrive/lead;
`purchase_orders` has 0 rows. It is a declared assumption, carried in
provenance and stated on the card *in the same sentence as the number*.

**Service level is a business decision**, seeded from 103,267 SKUs: beer 0.95
(turns at 51.3 units/SKU), wine 0.85 (18.0 — 95% there ties capital for a year
on a bottle that sells four times). All PROVISIONAL, all marked NEEDS
COMMERCIAL SIGN-OFF.

**`on_order` is subtracted.** `buying.py` subtracts only `on_hand`, so a store
that ordered yesterday orders again today. And `on_order=None` (unknown) is
distinct from `0.0` (measured) — the `Number(null) === 0` lesson again.

**Verify:** `pytest -q` (895) · both guards · `mypy app/pipeline/`

Detail: [SHEET-10-INVENTORY-POLICY.md](SHEET-10-INVENTORY-POLICY.md)

---

## Wave 2 — Sheet 11, business constraints

**Why.** "Order 37" when the supplier ships cases of twelve is wrong in a way
**no forecast improvement fixes** — and the owner reads it as *the software
does not understand my business*, which is very hard to reverse. Cheap,
independent of forecast quality, and it removes a whole class of visibly wrong
output, so it belongs in wave 2.

**The parser, row-weighted over all 911,022 product rows:**

| | rows | share |
|---|---:|---:|
| parsed to an integer | **905,966** | **99.45%** |
| refused **with a reason** | 5,056 | 0.55% |

The refusals are itemised — `"NULL"` as a literal four-character string (2,142
rows), `"CASE"` and `"KEGS"` as container words with no count (1,160), `"-6"`
and `"0MG"` (336). **None of them silently became a 1**, because a pack size of
1 *disables* the constraint and ships the 37.

**141,634 rows (15.5%) have a pack > 1** — that is where the constraint
actually bites. For the other 83.9% it is correctly inert, and inert because it
parsed as 1, not because parsing failed.

**Two corrections to the sheet, both measured.**

- **`uom` cannot validate the pack parse.** Coverage is exactly 69.9% as
  stated, but `uom` here is container *volume* (750ML, 1.75L, 12OZ), not units
  per case. It is used only to confirm a row describes a single container,
  which fired on 504,808 rows. A real conflict found: sku 1002 has
  `pack_size="4 PK"` with `uom="6PK"` — trusting `uom` would have ordered it in
  sixes.
- **MOQ uses the MODE, and the data says why.** Across 20,000 supplier-SKUs,
  **26.8% have `min ≠ modal`** (e.g. min 4, modal 12). One sample order would
  drag the minimum down and switch the constraint off.

**The rule that matters most.** An unavailable constraint is recorded as
UNAVAILABLE, never treated as unbounded. Four states, not two — `UNAVAILABLE`
(the column does not exist) and `UNPARSEABLE` (it does and we could not read
it) call for different actions, so collapsing them loses the only information
that says which. Running the real chain on store 171, **all 18 SKUs carried
three unavailable constraints** — moq, shelf_capacity, budget — rather than
silently skipping them.

**Verify:** `pytest -q` (937) · both guards · `mypy app/pipeline/`

Detail: [SHEET-11-BUSINESS-CONSTRAINTS.md](SHEET-11-BUSINESS-CONSTRAINTS.md)

---

## Wave 4 — Sheet 12, typed candidates

**Why.** The rule that makes the whole explanation layer checkable lives here:
**a candidate carries every number that will ever appear on its card.** If a
figure is not on the candidate, stage 16 rejects any sentence containing it.

That turns *"do not hallucinate"* from an **instruction** into a **mechanism** —
an instruction is followed most of the time; a mechanism is a set membership
test. Missing figures fail at construction, not at render.

**Five families**, each refusing to exist without its justification: a CLEAR
must name the clearing rule, a RANGE must name which cohort, a SUBSTITUTE must
state basket or category evidence. Every candidate carries the Provenance of
the stages that produced it.

**MARKDOWN is never constructed** — not constructed and then flagged. The
elasticity check happens *before the object exists*, with a second line of
defence in the type itself, so there is no weak-evidence markdown sitting in
the pipeline waiting for somebody to forget to filter it. Withheld candidates carry the specific reason
(`spans_zero` / `is_positive` / `is_inelastic`), because those are three
different findings.

**A correction to the sheet.** It warns against reintroducing a substring bug
at `backend/lib/metrics.js:561-566`. Checked against the live database: that
defect is **already fixed** — the function returns `\y<term>\y`, and `\y` is
Postgres's word-boundary escape. Measured: bounded `gin` matches "gin bottle"
and correctly rejects "ginger ale" and "virgin mary"; unbounded `gin` matches
all three. The rule is enforced in the new module anyway, by AST test rather
than by review — a word-bounded name match is still not an identifier.

**On real data**, store 171 through 03 → 07 → 10 → 11 → 12: 18 SKUs produce 3
reorder candidates. The other 15 produce **nothing at all** — the store is well
stocked, so the policy asks for nothing and no card is proposed. The pipeline
declining to manufacture activity is the behaviour, not a gap.

**Verify:** `pytest -q` (963) · both guards · `mypy app/pipeline/`

Detail: [SHEET-12-CANDIDATES.md](SHEET-12-CANDIDATES.md)

---

## Wave 4 — Sheet 13, deterministic ranking

**Why.** Today the **model** chooses which recommendations appear and in what
order. That single fact explains most of the backtest result: the ordering was
unstable, unexplainable and **unimprovable**, because nobody could say what it
optimised.

```
score = expected_value × calibrated_confidence × urgency
```

**Multiplied, not summed** — a certain, urgent recommendation worth nothing is
worth nothing. A weighted sum would let two strong terms carry a zero third,
which is exactly the "high confidence, no money" card this rebuild exists to
remove. Live: the most *confident* card ranks last, because it is worth $20 and
its window is three weeks out.

**Calibrated, never raw.** Sheet 08 measured stated confidence at 0.48 against a
0.23 hit rate; ranking on it would order cards by how confident the engine
*sounds*. The input field is `calibrated_confidence`, not `confidence`, because
an ambiguous name is how the raw value gets used by accident — and an AST test
proves neither module reads a `raw` anything.

**Byte-identical, asserted in CI.** No model, no randomness, no clock — every
date comes from `ctx.as_of`. Ties break on `(-score, sku)`, so reproducibility
is a property of the **data** rather than of whatever order the caller happened
to build its list in. Reversing the input produces identical bytes.

**One design question settled by testing it.** The diversity cap first held
surplus candidates back unconditionally — so a store with *only* reorders saw
three cards instead of eight, the cap firing where there was nothing to protect.
It now binds **only where there is competition**: hold back first, then backfill
any room the cap left over. The guarantee is precise — *every family present
gets up to `cap` slots before any family gets more than `cap`* — and a store
with eight reorders and one clear sees the clear.

**Missing margin is not an assumed margin.** 31 stores send 0.00% cost;
`rank.default_margin_rate` is 0 on purpose, and `margin_available=False` keeps
"worth nothing" distinct from "worth unknown".

**Verify:** `pytest -q` (990) · both guards · `mypy app/pipeline/`

Detail: [SHEET-13-RANKING.md](SHEET-13-RANKING.md)

---

## Wave 4 — Sheet 14, decision validation

**Why.** There is already a validator, and it cannot tell a **negative order
quantity** from a **clumsily-worded sentence**: both produce the same dropped
card and the same log line, so neither is ever investigated. One is a 3am
problem and one is a Monday problem.

This sheet asks one question, **before a single token is spent** — *is this
DECISION correct?* Sheet 16 asks the other one — *does the SENTENCE match it?*
`Severity.PAGE` and `Severity.LOG` are different objects so nobody can
accidentally handle them the same way, and `pageable()` is a function rather
than a convention so the alerting path cannot drift from the severity a check
assigned.

**Five checks:** quantity (integer, positive, within sheet 10's `order_up_to`,
not a decimal slip), date (present, not past, reachable), risk (reconciles with
`demand_p50 × unit_margin`), constraints, inventory identity.

**Silence is a failure.** Every one of `case_pack, on_hand, moq,
shelf_capacity, budget` must appear — satisfied, or **explicitly unavailable
with a stated reason**. A constraint nobody evaluated is not a constraint that
passed, and an unavailable one carrying no reason is an assumed bound wearing
an honest label. This is the check that catches the class of bug where a stage
is skipped and everything downstream still looks fine.

**The gate found its own bug on its first real run.** All three of store 171's
decisions paged:

```
on_hand=48.0 + on_order=0.0 + order=116 - demand=277.8 = -113.8  <  safety_stock=30.0
```

The order was right; **the comparison was not**. `demand_p50` is sheet 07's
forecast over a **30-open-day horizon**; the order is sheet 10's, sized for
**lead time + review = 14 days**. You are not buying 30 days of stock, you are
buying enough to reach the next delivery. *A false page is worse than no page,
because it teaches people to ignore the real one* — which is the exact failure
this sheet exists to correct, reproduced in the gate meant to correct it.
`DecisionRequest` now carries both windows, `coverage_demand()` pro-rates, and
the record says which window it compared over so a card can name it. Risk is
deliberately **not** pro-rated and a test pins that.

**And a larger finding underneath it.** `feature_daily.on_hand` is **NULL in
all 12,091,569 rows** — every store, every day. Meanwhile
`ideal_qty = order_up_to - on_hand - on_order`, so a missing on-hand read as
zero does not produce a cautious small order, it produces **the largest order
the policy can express**, on every SKU at once, with nothing looking wrong. The
first chain script recommended **170** units where the true count of 48 gives
**116**.

So the forward capture that column was created for now runs — **110,079 shelf
counts**, each dated by the sync that took it, never rewritten, and read
point-in-time so a reorder is **backtestable for the first time**. Sheet 11
gained `on_hand_from_snapshot()` and a fifth `Availability` state, `STALE`.
See the seventh admission condition below.

**Verify:** `pytest -q` (1038) · both guards · `mypy app/pipeline/` ·
`scripts/run_decisions.py` end-to-end on a real store

Detail: [SHEET-14-DECISION-VALIDATION.md](SHEET-14-DECISION-VALIDATION.md)

---

## Wave 5 — Sheet 15, explanation (RAG + LLM)

**Why.** The model's job shrinks to **writing**. It does not choose, rank,
compute or decide — every number in its output was fixed by stages 10-14 before
it was called, and the prompt says so in as many words. That single fact is
what makes the rest of this sheet small.

**A live bug, fixed first.** `llm_client.py` built its request with **no
`temperature` key at all**, so it inherited the API default while the chat path
(`routes/chat.js:1548`) sent 0. The two disagreed and the one that sizes
purchase orders was the sampled one. It matters more now than before: with
every figure fixed beforehand, sampling can only vary the prose around fixed
numbers — turning a genuine prompt regression into something indistinguishable
from noise, which is the exact distinction sheet 16 exists to make.
`llm_model` is also an **alias**, and an alias moves, so `llm_model_pinned`
takes a dated snapshot and every call logs what the API resolved to. Model id,
temperature and `PROMPT_TEMPLATE_VERSION` now travel in Provenance on every
card.

**The one rule, made structural.** *Retrieval supplies words and precedent,
never a figure.* `RetrievedText` refuses to be constructed from a string
containing a digit — or a number word, because a digit check alone has an
obvious bypass. Not a review comment: a rule enforced by attention holds until
the day somebody is busy.

That is what makes sheet 16 possible. Faithfulness is checked by matching every
numeral against stage 14's record, and **that check is only meaningful if the
record is the only source of numerals**. One retrieved passage carrying a stale
figure makes the whole verification decorative. So arithmetic and retrieval are
separate pipes; nothing merges them but the sentence, and the sentence is
checked.

Only one of the three retrieval uses needs a vector store: past outcomes and
cohort precedent are keyed reads available from day one. Product context is
pgvector, and **not queried at all** for the 31 stores with no category data —
an empty result is a fact, a nearest neighbour over an uncategorised catalogue
is a confident-looking irrelevance.

**A missing explanation is never a missing card.** `model_sentence=None` is an
ordinary input, not an exception, so the degraded path lives *inside* the stage
and the template ships the identical figures. There is no path that returns
`ok=False` for a model problem — the decision was already validated, and
withholding it would punish the store for an outage in the part of the system
that contributes no arithmetic.

**The hedge is generated, never written.** *"(based on 14 similar stores in
Texas; you have 3 weeks of your own history)"* comes from `Provenance`, so the
model never rounds 14 to "about a dozen". Two bugs found writing it: the RUNG
(`store|state|region|national`) is not a PLACE — the first version would have
printed *"in state"* — and provenance figures were permitted even on cards
carrying no hedge, which let an invented "about 120 units" pass.

**Verify:** `pytest -q` (1084) · both guards · `mypy app/pipeline/` ·
`run_decisions.py` prints the cards and raises on any unaccounted numeral

Detail: [SHEET-15-EXPLANATION.md](SHEET-15-EXPLANATION.md)

---

## Wave 5 — Sheet 16, explanation validation

**Why.** The backtest found **two invented SKUs out of roughly 480 referenced**.
0.4%, and fatal: a single fabricated product destroys an owner's trust in every
other card on the screen. There is no rate of invention low enough to be
acceptable, which is why this is a set membership test rather than a confidence
score.

**The other half of the split.** Sheet 14 asks whether the DECISION is correct
and PAGES; this asks whether the SENTENCE matches a decision already known to
be correct, and only LOGS. It never re-checks the decision — sheet 14 owns that
question, and re-deriving the arithmetic would put one check in two places and
let them drift.

The stage returns `ok=True` **even when the sentence fails**: the verdict is in
the value, not the envelope, because a failed envelope would read to an operator
exactly like a sheet-14 page. That conflation is what made the old single
validator useless.

**Four checks, all decidable** — it does not judge whether a sentence is *good*,
because opinions cannot be regression tested:

1. **Numerals.** Every number appears in the stage-14 record. `$1,924.80`,
   `1,924.80` and `1924.8` compare equal; rounded, summed and invented all fail
   identically. The ISO date, the SKU and the product name are removed first —
   each would otherwise fail every card (`Terra Lager 12pk` contains `12`).
2. **Identity.** Exact key match on `(client_id, location_id, sku)`, never a
   name lookup — "close enough" is the judgement that produced the two invented
   SKUs. The SKU pattern is deliberately narrow: treating `116` as a possible
   SKU would fail every card, which is the false-positive rate that gets a
   checker switched off.
3. **Provenance.** `own_weight < 1` requires the hedge. A borrowed estimate that
   does not say so reads as a measurement of *this* shop.
4. **Claims.** An explicit list, kept as data: a substitution claim needs
   substitution evidence, a margin claim needs cost, a stockout claim needs the
   **upper** bound because running out is a tail event. Zero evidence is no
   evidence — a cohort of 0 stores is not a cohort.

**On failure: drop the prose, keep the decision.** The stage does the
substitution itself, so a caller cannot forget to fall back — a failed verdict
already carries sheet 15's template text. And the **rate** is counted, because
one bad sentence is a bad sentence while a moving failure rate is a regression;
`failure_rate` is `None` rather than `0.0` before anything is checked, so an
unrun check cannot look like a clean one.

**A gap in sheet 14 this surfaced.** `DecisionRecord` carried no product name,
while sheet 14's own contract is that it holds everything the card displays.
`ReorderCandidate` already had `display_name`; stage 14 simply was not
propagating it.

**Verify:** `pytest -q` (1119) · both guards · `mypy app/pipeline/` ·
`run_decisions.py` — 10 cards across two real stores, 0 failed

Detail: [SHEET-16-EXPLANATION-VALIDATION.md](SHEET-16-EXPLANATION-VALIDATION.md)

---

## Wave 6 — Sheet 17, the gate

**Why.** This is the sheet that would have prevented the 23% result from ever
reaching a customer. A recommendation family is shown at a store only once it
has beaten a **volume-matched null at that store**; until then it runs in
shadow — computed, stored, scored, not displayed.

**The sheet said this was configuration rather than construction. It was not,
and the difference would have cost a quarter.**

The holdout mechanism existed and was switched off, as described. But the
assignment was:

```js
((runId * 31 + r.rank) % 100) < holdoutPct
```

`runId` is a fresh serial every run and `rank` moves with the ranking, so the
same store-SKU landed in a different arm almost every day — **rank 1 changed
arm 39 times in 100 runs**. A holdout measures what happens when a store is NOT
told something; if the same product is withheld Monday, shown Tuesday and
withheld Wednesday, no outcome can be attributed to either arm. Switching it on
unfixed would have accumulated a quarter of noise and then reported that the
engine does not work — the same mistake the 23% backtest made once already, for
a different reason.

The key is now exactly the thing being measured — `client:location:sku:family`
— with no run id, no rank and no date, hashed with FNV-1a rather than an
arithmetic progression that correlated with onboarding order. **`REC_HOLDOUT_PCT`
now defaults to 10**: one card in ten is withheld so the other nine can be
proven to do something.

**The gate.** `shadow | live | suspended`, per store and per family. Suspended
is deliberately *not* shadow — "we learned something and it stopped being true"
is a different conversation from "we have not learned anything yet".

**The null is volume-matched** because a SKU selling 2 a month and one selling
200 are not comparable in percentage terms, and an unmatched comparison is
decided by whichever side drew the quieter products. 400 matched baskets, a
randomisation test rather than a t-test, seeded from `ctx.seed` and
`ctx.snapshot_id` so a p-value is reproducible months later — and it can never
be reported as zero, because with B draws the strongest claim available is
1/(B+1).

**A design bug a test caught.** The maintenance threshold defaulted to 0.5 —
unreachable, because a symmetric null puts p below 0.5 whenever the observed
value is above the null mean at all, so it could only ever fire where the
below-the-null check had already fired. It is now a proper hysteresis band:
p < 0.05 to open, p < 0.20 to stay, suspended when even that fails.

**A new store inherits its cohort, then earns its own.** Otherwise the stores
with the least of their own data — the ones sheet 06 exists to serve — would
get the least help for a quarter. Inheritance is not a free pass: the cohort is
only live if the cohort proved it.

The statistics live in Python (`app/pipeline/gate/`); Node owns the table and
enforcement and **does not reimplement the transition rule** — two
implementations of one rule is the 454-vs-485 failure again.

**Verify:** `pytest -q` (1151) · `node tests/holdout-assignment-verify.js` (14)
· `node tests/family-gate-verify.js` (22)

Detail: [SHEET-17-THE-GATE.md](SHEET-17-THE-GATE.md)

---

## Wave 5 — Sheet 18, the store interface

**Why.** Sheets 04–17 made the numbers defensible. Almost none of them are
legible. `own_weight: 0.31` is a fact about our shrinkage estimator, not
information about a shop; a bare `24` is arithmetic with the care removed. This
is where the pipeline learns to speak.

**Three bugs found on the way in, all in two lines of the card renderer.** It
displayed `r.confidence` — the model's STATED confidence, which sheet 08
measured at a mean of 0.48 against an actual hit rate of 0.23, shown under the
word that makes people trust it. It rendered a bare percentage, inviting a
precision nobody has earned. And when confidence was absent it defaulted to
`{ word: 'Good' }` and 60% — inventing a claim for a card that made none, the
same bug class as `Number(null) === 0`. Now: the calibrated field only, words
only, and a card with no calibrated confidence claims none. The sort tiebreak
was reading the raw value too.

**The provenance line is not optional**, and it sits on the card FACE rather
than behind the caret — a card whose numbers are partly borrowed must say so
where it is read, not where it is investigated. Sheet 15 generates it and sheet
16 verifies its numerals, so the UI prefers that string and only composes its
own as a fallback: a missing sentence must never become a missing disclosure.
A cohort-weighted card arriving without one is a PIPELINE bug and is surfaced
as one on internal builds. The RUNG is not the PLACE — printing `cohort_level`
would give "14 similar stores in state", the same trap sheet 15 hit from the
other side.

**The evidence state is spoken**: *"You're an emerging store - I'm using your
data where I can and similar shops where I can't"*, said once at the top
because it is a statement about the shop rather than any one card.

**Constraint reasons make the care visible**: "24 units (2 cases of 12)" rather
than a bare 24, and the note appears only when the quantity was actually
CHANGED — a note about a constraint that did not bind is noise, and noise
teaches people to stop reading the notes that matter.

**Two surfaces, one gate, and the check is server-side.** A client-side filter
is not a boundary: the payload still crossed the network. The internal surface
is a separate ENDPOINT behind a separate credential, not a query parameter the
browser can flip. It fails closed — with no key configured it 404s rather than
falling open — and a wrong key gets 404 rather than 403, because an endpoint
that answers "wrong key" confirms it exists.

Note the two questions are independent: enforcement is off during the gate's
first quarter, so a store still SEES every card — but it has never seen a
p-value, and will not. The field stripping does not depend on the rollout flag.

**Verify:** `CI=true npx react-scripts test` (27) · `npm run build` (all three
prebuild guards) · `node tests/rec-surface-verify.js` (16)

Detail: [SHEET-18-STORE-INTERFACE.md](SHEET-18-STORE-INTERFACE.md)

---

## Wave 6 — Sheet 19, outcome feedback

**Why.** Nothing in the architecture improves without this. Calibration needs
outcomes to fit; the shrinkage constant k needs outcomes to be fitted from; the
gate needs outcomes to judge; cohort priors need outcomes to sharpen. **Every
PROVISIONAL setting in the registry stays provisional until this loop has run.**

**The finding: there were already TWO definitions of lift.** The sheet warns
that two implementations of one metric is how a dead-stock count came out 454 on
one screen and 485 on another. It had already happened again, in the metric the
whole loop turns on — `recommendationEvalService.js` used a 28-day baseline and
a POOLED ratio; `app/store_data/feedback.py` used a 21-day baseline, a fixed
7-day window and the MEAN of per-SKU ratios. On identical data: **4.48 against
6.15, 1.37x apart**.

One definition now — `backend/lib/lift.js`, twinned by
`app/pipeline/outcomes/lift.py` and pinned by a shared fixture run through both
languages and compared digit for digit. Three decisions made once: open days in
BOTH windows; a pooled ratio, because a recommendation covering a 100-unit SKU
and a 1-unit SKU is mostly about the 100-unit one; and a zero baseline is an
UNDEFINED lift, not an infinite one.

**A second finding: the per-recommendation lift divided by CALENDAR days.** The
store-level rate was fixed long ago; this one was missed, and it is the figure
the gate and calibration actually consume. Bethany closes 200 days of 1,360 — a
28-calendar-day window there holds 23 open days, understating the rate by 21.7%;
stores 101-103 are worse at 27.3%. The error is the MISMATCH between the two
windows' open fractions, so it does not cancel.

**The withheld arm is the entire point**, and it is scored by the same function
over the same window against the same baseline — not "also scored", identically
scored. `scoreRecommendation` is not given the recommendation AT ALL, so it
cannot branch on the arm: the first version took it and simply did not read it,
which is a promise one harmless-looking edit can break.

**The loop closes.** `scripts/run-gate.js` is the job sheet 17 was waiting on.
Proven end to end on store 171 with 40 real outcomes: observed 2.4 against a
volume-matched null of 1.13, p = 0.0025, **family LIVE** — the first family ever
proven at any store.

**Wired end to end.** The evaluation pass writes outcome rows (arm read from
the persisted `status`, never re-derived — re-deriving it from the current
`REC_HOLDOUT_PCT` would relabel history the day that setting changes).
`feedback.py` uses the shared definition, which changes which SKUs the
proven-winner pool boosts and is now pinned by tests. The gate runs nightly at
05:00, an hour after the recommendation batch, and logs every state transition.

**One more finding from testing the open-day fix:** the calendar-day error
CANCELS EXACTLY when both windows have the same open fraction — 21/21 x 7 and
21/18 x 6 are both 7. A store that simply closes every Sunday got the right lift
either way, which is why nobody noticed the denominator for years. It bites only
when the fractions differ: a holiday shutdown inside the measurement window but
not the baseline projects a full window's sales onto days the store was shut.

**Verify:** `node tests/lift-parity-verify.js` (15) ·
`node tests/outcome-feedback-verify.js` (19) · `pytest -q` (1173) ·
`node scripts/run-gate.js 171 171`

Detail: [SHEET-19-OUTCOME-FEEDBACK.md](SHEET-19-OUTCOME-FEEDBACK.md)

---

## Wave 6 — Sheet 20, temporal reversion

**Why.** The backtest kept coming back at ~35%. Every sheet from 00 to 19 was
measured, tested and honest, and the engine still could not pick a good
recommendation. This sheet is the audit that found out why.

**The finding: the engine was ranking on the quantity it was getting wrong.**
A demand rate is estimated from a trailing 28-day window, and that window is
noisy — sometimes it catches a quiet spell, sometimes a spike. Ranking by that
rate orders SKUs by how big a seller they *look right now*, so it selects the
ones whose windows are most INFLATED — and an inflated window is by definition
the one most likely to fall back. **The selection criterion and the mistake
were the same quantity.**

Measured on Bethany's three years, 45 decision dates, bootstrap clustered by
date:

| ordering | hit rate | realised gross margin |
|---|---:|---:|
| trailing rate — what shipped | **39.3%** | **−$13,783** |
| corrected rate + deficit + p_hit | **65.6%** | **+$14,508** |

The old ordering's median pick had a **negative** deficit of −6.5 units: the
engine was systematically recommending products that then sold *below* their
own baseline. Not underperformance — **anti-correlated** with the outcome.

**The fix is sheet 06's formula on a second axis.** Sheet 06 shrinks a store's
estimate toward its cohort, across STORES. Sheet 20 shrinks a SKU's recent rate
toward its own long run, across TIME:

```
rate_hat = (n_eff · r_recent + k · r_long) / (n_eff + k)
n_eff    = open_days / (1 + cv²)
```

`k` is not a new constant — it is the registry's existing
`shrink.k.sku_velocity` from sheet 06. **Nothing is fitted**, and the hit rate
is flat at 68.0 / 68.0 / 68.7 / 68.4 / 68.0 across k = 8…45. Insensitivity
across a 5× range is the signature of a real effect rather than a tuned one.

**No new ranker was added.** The stage emits two quantities that land in terms
the engine already had: `deficit_units` is MONEY (→ `units_at_stake`) and
`p_hit` is CONFIDENCE (→ sheet 08). `p_hit` is ordered but **not numerically
calibrated** — 0.55 corresponds to a 42% outcome — so it must pass through
sheet 08 before any figure derived from it reaches an owner, and a test asserts
`from_reversion` never reads it.

**A tuned version scored higher and was rejected.** A rank-average of the same
two signals hit **74.8%** — then collapsed to 64.9% and 50.4% as a materiality
floor was applied. Its edge was borrowed from SKUs selling ~1 unit a month,
where the ratio is noise amplified by division. It was measuring the metric,
not the shop.

**90% is not reachable on this metric.** Tested at every confidence floor and
every coverage down to a single card per date: the best is 71.1% with a 95% CI
of 57.8–84.4. No combination has 90% inside its interval. For a SKU selling ~10
units a month, Poisson noise alone puts it below its own mean about a third of
the time regardless of what is known. The base rate is 34.6%; **the real result
is the edge, and the sign change on money.**

**Two defects the tests caught that the measurement did not.** A perfectly
steady *decliner* cleared the confidence floor on steadiness alone (`p_hit`
averages uplift with steadiness, so cv=0 forces p_hit ≥ 0.5) — ranking hid it,
but sorting last is not being refused. And adding the new fields to `SkuInput`
after `own_rate` silently rebound `observations` to `recent_units`, because the
existing tests construct it positionally.

**The ablation.** Four orderings over one candidate pool, 240 picks each.
`margin_impact` is `(sold − expected) × margin` — money that would not have
arrived anyway — and is the decision metric; `margin_captured` is total flow
and mostly measures how big the picks are.

| ordering | hit rate | 95% CI | **incremental** | total | median pick |
|---|---:|---|---:|---:|---:|
| trailing deficit, no shrinkage | **68.8%** | 60.8–75.4 | +$23,151 | $122,753 | 15u |
| **sheet 20: deficit + gates** | **67.1%** | 60.0–74.2 | +$22,377 | $120,387 | 14.5u |
| total demand — what shipped | 60.4% | 56.2–65.8 | **+$882** | $215,233 | 30u |
| deficit, no gates | 57.1% | 47.5–66.7 | +$39,144 | $114,786 | **4u** |

**Most of the gain is the DEFICIT, not the shrinkage** — worth +6.7 points and
+$21,495. Against a deficit built from the raw trailing rate the shrinkage
measures **−1.7 points**, statistically indistinguishable. It is kept because
it **bounds the size of the claim** printed on a card — an erratic SKU with one
quiet month can show an enormous raw deficit, which nothing in the hit rate
notices and an owner would. Ungated, the deficit earns the most money in the
table from picks whose median size is **4 units**; the gates trade that paper
margin for cards a store owner can act on.

*Correction: an earlier version of this section reported the old ordering at
−$88,847. That was measured before the window bug below was found, with the
recent window tied to the horizon on both arms. The ranking conclusion is
unchanged; the magnitude was wrong.*

**A window bug in the backtest port, worth more than the ranking change.** The
notebook set `lookback = horizon`, so a 120-day forecast estimated the "recent"
rate over 120 days and compared it to a 365-day long run — two heavily
overlapping windows, almost no contrast, and contrast is what sheet 20 runs on.
The demand level is a property of current trading conditions, not of how far
ahead you look. `BASELINE_WINDOW_DAYS` is now fixed at 28, matching production.

| horizon | before | after | edge | p |
|---|---:|---:|---:|---:|
| 30 | 70.0% | **71.7%** | +32.3 | 0.00 |
| 60 | 67.8% | **71.7%** | +33.3 | 0.00 |
| 90 | **43.4%** | **63.3%** | +30.1 | 0.00 |
| 120 | **48.1%** | **63.3%** | +31.8 | 0.00 |

The 90-day horizon gained +19.9 points, and the edge is now a **stable ~+30
across all four horizons** instead of collapsing at the long end — the
signature of a correctly specified model. Overall **58.0% → 67.5%**.

**End-to-end against the old LLM arm** (6 dates × 4 horizons): hit rate
**15.4% → 67.5%**, percentile **35.9 → 69.6** (p = 0.0005), gross margin
**$62,678 → $120,284** (1.9×), invented SKUs **6 → 0**.

**The notebook runs with no API key — Run all, one file, no setup.** Two things
stopped that. The per-run folder `signals/{h}d/{date}/` was a side effect of the
paid cell's loop, so skipping Cell 6 crashed the scorer on its first write. And
Cell 6 ended in `getpass()`, which on Run all with no key pops an input box and
waits forever — the notebook appeared to hang on its most expensive cell, for a
comparison arm nobody asked for.

Cell 6 now auto-detects: with no key it prints a note and does nothing
(`RUN_OLD_ARM = None|True|False` to override), the free path creates its own
folders, and a no-API run produces the same engine numbers as a full one.
Verified by `_src/noapi_test.py`, which executes every cell with the key
removed from the environment.

**Verify:** `pytest -q` (1206) · `python scripts/check_no_literals.py` ·
`python scripts/check_no_state_branches.py` ·
`python "dataset - Copy/colab/_src/smoketest.py"`

Detail: [SHEET-20-TEMPORAL-REVERSION.md](SHEET-20-TEMPORAL-REVERSION.md)

---

## Recommendations are now shown only if they are valid and profitable

The thing the rebuild is for. Three independent conditions, all enforced in
`backend/services/recommendationGateService.js` on every `/latest` read:

1. **The store's data is usable** — a rejected or quarantined batch produces
   nothing at all.
2. **The fields the claim needs are present.** A markdown is a *margin* claim
   and margin needs cost. Cost is 0.00% available for gokul, square and mpower
   — 31 stores, 355k SKUs. Those stores no longer receive markdowns computed
   against a cost of zero (an imaginary 100% margin).
3. **The number is stated and positive.** A profit-claiming action with no
   computable figure is withheld — not shown with a blank.

Advice that makes **no** margin claim survives: *"99°F Saturday, move seltzer
to the cold box"* is actionable whatever the POS sends, and silencing it would
punish the store for its vendor's defect.

Nothing is dropped silently. Withheld recommendations are returned with
reasons and an owner-readable explanation, every shown recommendation carries
`data_as_of_days_ago`, and every decision is recorded in
`recommendation_admission`. A refusal nobody can explain is just a different
kind of unexplainable output.

**Sheet 07 adds a fourth condition: the forecast must be actionable.**

4. **The interval has to be narrow enough to order against.** Every forecast
   now carries p10/p50/p90 — a bare point estimate is no longer an acceptable
   output of the forecasting stage, because "order 12" and "order 12, and the
   realistic range is 4 to 31" lead to different decisions and only the second
   is honest. A lumpy SKU whose 80% interval reads *"expect 2, could be 78"*
   is **refused**: you cannot place an order against that, and a
   confident-looking midpoint is exactly the ambiguous output this rebuild
   exists to remove.

And the number behind the claim is now defensible in a way it was not:

- Each SKU is forecast by the method its **demand shape** selects, so the
  intermittent majority is no longer served by a model built for daily
  sellers.
- The forecast is **measured against seasonal-naive per demand class**, and a
  class that loses fails the whole report — no averaging a loss on most of the
  catalogue behind a win on the few big sellers.
- **Momentum earns zero weight**, and the backtest re-measures its correlation
  every run. The 23%-vs-32% failure was a correctly-executed wrong objective;
  the objective is now demand over the horizon, and it is enforced by a
  default of `0.0` and an AST scan.
- Where the method still loses — store 122's intermittent class, 35.2 against
  a seasonal-naive 30.6 — **it is reported as losing** rather than tuned until
  the number turns green.

**Sheet 08 adds a fifth condition: the confidence attached to the claim has to
mean something.**

5. **Stated confidence is calibrated against outcomes before anything ranks on
   it.** The measured starting point was mean stated 0.48 against an actual hit
   rate of 0.23 — a coin flip with a decimal point. Today `reorder` states
   0.87–0.95 on every one of its 15 rows and has never said it was unsure.

   Calibration is applied **before** the caps that decide what an owner sees,
   so a family whose confidence has not been earned loses its slot to one whose
   has — rather than keeping the slot and printing a smaller number beside it.

   Until outcomes exist there is no curve, and the engine says so rather than
   inventing one: every confidence passes through unchanged **with a recorded
   reason**, and the curve version that shaped any past card is on its
   Provenance, so it can still be explained months later.

**Sheet 09 adds a sixth: a price claim needs a measured price effect.**

6. **No markdown, liquidate or bundle may cite a price effect unless β's
   interval lies entirely beyond −1.** Every such card asserts a demand curve;
   until sheet 09 nobody had estimated one. On real data **98.5% of (store,
   category) cells cannot support the claim** — the interval spans zero, or the
   estimate is *positive*, or prices never moved enough to fit, or the effect
   is real but too weak for a discount to pay for itself.

   The last is the one that binds: at |β| < 1 a price cut raises volume by less
   than it gives up in price, so it **loses money**. 79 cells were
   statistically solid and economically wrong, which is exactly the kind of
   confident-looking recommendation this rebuild exists to stop.

   Families that make no price claim — reorder, promote, cold_box — are never
   blocked on an elasticity they never cited, so a store whose prices happen not
   to vary keeps the recommendations it is entitled to.

   Blocked cards are **withheld with the reason attached**, and the gate runs
   *before* the ranking caps so an unsupportable markdown never occupies a slot
   a supportable card could have had.

**Sheet 14 adds a seventh: an order may not be sized against a shelf nobody
counted.**

7. **A reorder requires a shelf count that is present, non-negative and
   recent.** This is the condition with the largest measured effect of any in
   the list, because of one line of arithmetic:

   ```
   ideal_qty = order_up_to - on_hand - on_order
   ```

   A missing `on_hand` read as zero does **not** produce a cautious small
   order. It produces the largest order the policy can express, on every SKU
   at once, and nothing in the output looks wrong. The first end-to-end chain
   script recommended **170** units of one SKU where the true count of 48
   gives **116** — a 47% over-order, silently, on everything.

   `feature_daily.on_hand` **was NULL in all 12,091,569 rows** — the column
   migration 018 created and said would stay empty "until the day capture
   starts". Capture now starts: `featureStoreService.captureOnHand()` writes
   each shelf count **stamped at the day its sync took it**, never at `as_of`,
   so a store whose sync stopped in June gets its counts dated June — which is
   true — rather than today. **110,079 counts** across the five stores sampled,
   and because the table now holds one row per (sku, day), a reorder can be
   read point-in-time and **backtested for the first time**.

   Reading a count is then a question with four answers, and
   `on_hand_from_snapshot()` returns a `Constraint` carrying which:

   - a recent count — **`KNOWN`**. Zero included: an empty shelf is a
     measurement, and the state most likely to deserve a reorder.
   - no row — **`UNAVAILABLE`**. Unknown is not empty.
   - a **negative** count (83,322 of 911,022 rows estate-wide, 9%) —
     **`UNPARSEABLE`**, never clamped to zero. Clamping turns *"this count is
     wrong"* into *"this shelf is empty"*, which orders the maximum.
   - older than seven days — **`STALE`**, a new fifth `Availability` state.
     Distinct from `UNAVAILABLE` because *"the warehouse has no shelf counts"*
     is false and unactionable, while *"a sync stopped"* is something somebody
     can go and restart.

   The estate is uneven in a way that decides real cards: stores 171 and 22
   synced the morning this was written; **97, 92 and 106 last synced
   2026-06-03, 112 days earlier.** Before this guard, store 106 produced **13
   confident reorder recommendations sized against shelves last counted in
   June**. They are now withheld. Across five real stores the engine now
   returns **10 valid decisions and zero pages** — and of store 171's 22
   refusals, **20 are simply "stocked above the reorder point"**, which is a
   correct answer rather than a gap.

   A **historical `--as-of` gets no stock at all**, because today's shelf says
   nothing about March's and pretending otherwise is a look-ahead that would
   make a backtest look better than the engine is.

**Sheet 15 adds an eighth: every numeral on a card must come from the validated
decision.**

8. **The model writes the sentence; it supplies none of the numbers.** Every
   figure was fixed by stages 10-14 before the call, the prompt forbids
   computing, deriving or rounding any of them, and `Explanation`
   carries `allowed_figures` — the complete set a card may contain.

   The condition is enforceable because **retrieval cannot contribute a
   digit**: `RetrievedText` refuses construction from any string containing a
   numeral or a number word. Without that rule the verification would be
   decorative — a model quoting a real figure from a real retrieved document
   would produce a numeral the checker cannot account for, or worse, one that
   coincidentally matches.

   Two figures on a card come from outside stage 14 and both are **generated,
   never written**: the cohort size and the store's own history, in the hedge
   clause, straight from `Provenance`. They are permitted as numerals *only
   when that clause is actually printed* — the first version allowed them
   unconditionally, and a card with no hedge would have accepted an invented
   "about 120 units".

   And a card is never lost to a model outage: `model_sentence=None` is an
   ordinary input, and the template ships the same decision with the same
   figures. Withholding it would punish the store for a failure in the one
   part of the system that contributes no arithmetic.

**Sheet 16 adds a ninth: the sentence is checked against the decision, and a
failure costs the prose rather than the card.**

9. **Every numeral traces to a validated figure, and every SKU to something
   this store carries.** The backtest found two invented SKUs out of roughly
   480 referenced — 0.4%, and fatal, because one fabricated product destroys
   trust in every other card on the screen.

   Four mechanical checks: numerals against the stage-14 record (where
   `$1,924.80` and `1924.8` are one figure, and rounding is computing);
   identity by exact `(client_id, location_id, sku)` match and never a name
   lookup; the provenance hedge when the estimate is borrowed; and no claim
   without the field that backs it.

   **A failure drops the PROSE and keeps the DECISION** — the card ships with
   the template sentence carrying identical numbers. It **logs and counts**,
   and never pages: a wording regression is a working-hours problem, while a
   decision that does not close is a 3am one. Under the old single validator
   both produced the same dropped card and the same log line, so neither was
   ever investigated.

   Measured on real data: **10 cards across two stores, 0 failed.**

**Sheet 17 adds a tenth, and it is the one the others were building toward: has
this kind of recommendation ever actually worked AT THIS STORE?**

10. **A family is displayed only once it has beaten a volume-matched null at
    that store.** Conditions 1–9 all ask whether a recommendation is *correct*
    — valid data, supportable claim, actionable interval, calibrated
    confidence, measured price effect, a counted shelf, a decision that closes,
    a sentence that matches it. None of them asks whether saying it **changes
    anything**.

    That question needs a control, and the mechanism for one existed and was
    switched off — which is why the programme's only evidence was a
    retrospective backtest that could measure forecasting but not causation.
    It is now on, after fixing an assignment key that reshuffled arms 39 times
    in 100 runs.

    Until a family has ≥ 30 outcomes at a store and clears p < 0.05 against
    400 volume-matched baskets, it runs in **shadow**: computed, stored,
    scored, **not displayed**. If it later falls below the null it is
    **suspended** — automatically, reversibly, and as a distinct state from
    shadow, because "it stopped working" and "we never knew" deserve different
    conversations.

    A new store inherits its cohort's state until it has its own evidence, so
    the stores with the least of their own data are neither stranded in shadow
    for a quarter nor trusted on nothing.

    **Not yet enforced.** No family can be live for roughly a quarter, so
    enforcing today would show every store nothing at all. The gate computes
    and records its verdict now; `REC_GATE_ENFORCED=true` turns display
    enforcement on once families begin to qualify.

**Sheet 18 adds an eleventh, and it is the only one about the reader rather
than the recommendation: can the owner tell where this came from?**

11. **Every borrowed number says whose it is, and every constrained quantity
    says why.** A recommendation can satisfy all ten conditions above and still
    be unusable, because *correct* and *legible* are different properties and
    only one of them had ever been checked.

    A card whose `own_weight < 1` carries its provenance line on the card
    FACE — *"Based on 14 similar stores in Texas — you have 3 weeks of your own
    history"* — and a cohort-weighted card arriving without one is a pipeline
    bug, surfaced as one internally. The evidence state is a sentence rather
    than a score. A quantity reads "24 units (2 cases of 12)", with the binding
    constraint named whenever it actually changed the number.

    The confidence on the card is the **calibrated** one. It was the raw one:
    the model's stated confidence, measured at 0.48 against a 0.23 hit rate,
    and defaulting to "Good" when absent.

    And the statistics behind all of it — p-values, null means, gate reasoning —
    are stripped **server-side**, on a route the store's browser cannot reach.
    Unconditionally, not subject to the gate's rollout flag: a store has never
    seen a p-value and will not, whatever the gate is doing.

**Sheet 19 does not add a twelfth condition. It is what makes the other eleven
improvable.**

Conditions 1–11 are all checks a recommendation must pass. Every threshold in
them is PROVISIONAL — 0.05 for the gate, 30 outcomes, a 5% risk tolerance, a
7-day staleness limit, seven ranking weights — and **provisional means nobody
has measured it yet**.

Sheet 19 is the loop that turns those into fitted numbers. Calibration fits on
outcomes; the shrinkage constant k is fitted from them; the gate judges on them;
cohort priors sharpen against them. Until it had run, every threshold in this
document was a considered guess with a stated reason, which is better than an
unconsidered one and is not the same as a measurement.

It also closes the loop's own honesty requirement: **shown and withheld are
scored identically**, by a function that is not given the arm at all. Without
the withheld arm the programme measures forecasting; with it, causation — and
the reason the original 23% result could not distinguish the two is that nothing
had ever been withheld.

---

## Every store, empty to full

The estate is not uniform: of 188 configured stores, **79 have zero products
and zero sales** and 88 have thousands of both. Every sheet is verified across
that whole range by `backend/tests/store-spectrum-verify.js`.

The rule is not "must not crash on empty" — it is **a store with no data must
never produce a confident-looking answer**:

- No data reads **stale**, never fresh. No state row at all still reads stale.
- `never_synced` is distinct from stale-by-N (`days_stale` is `null`, not `0`).
- A run that produced nothing is **archived as an explicit zero**, because a
  missing row is indistinguishable from "the cron never fired".
- Empty collections are **empty arrays, never null**.
- **Unknown is not zero.** `n/a` coverage is silence; `0%` is a connector
  defect. Enforced in code by `utils/numbers.js`: absent in, null out, because
  `Number(null)` is `0` and that single fact caused four separate bugs.
- A stage with no data returns `ok=false` with a reason and
  `own_weight 0.0 / NEW` — never a fabricated number.
- **A closed day is not a zero-sales day.** Rates divide by OPEN days only; a
  SKU that genuinely didn't sell while the store was open IS a zero. Getting
  these confused understates Bethany's velocity by 14.7%.
- **Not-applicable is a third state, distinct from insufficient.** "This store
  never trades on Sundays" is not thin evidence to go and collect more of.
- **A cohort statistic is another tenant's data.** Never fewer than k=5
  distinct stores, never dominated by one store, and widen rather than
  return a thin cohort. A legal boundary, not a tuning knob.
- **The prior ladder always terminates.** Nothing downstream may need an
  `if prior is None:` branch — that branch is the one nobody tests.

**As of sheet 06A this is measured, not asserted.** The whole pipeline was run
on both ends of the estate:

| | Store 106:106 | Store 172:172 | Bethany (171:171) |
|---|---:|---:|---:|
| Open days in window | **0** | 23 | 308 |
| Facts | **0** | 227 | 4,019 |
| Own weight | **0%** | 32–52% | 83–93% |
| Evidence state | `NEW` | `EMERGING` / `ESTABLISHED` | `MATURE` |
| SKUs estimated | **12 of 12** | 12 of 12 | 20 of 20 |
| Code path | identical | identical | identical |

Store 106:106 carries 29,019 SKUs and has **never sold a single unit**. It
still gets an answer for every SKU asked about, and its card says *"Based 0% on
your own sales (0 observations) and 100% on 13 similar stores (national)"* —
which is both true and something an owner can act on. That case did not work
until this sheet; see [§3.6](SHEET-06A-INTEGRATION.md).

Sheet 07 carries the same store through to a forecast: every SKU classified
`new_sku`, every one returning an interval from cohort dispersion rather than a
point estimate it has no basis for — *"Expect about 0 units over the next 30
trading days (0 to 1 in 8 cases out of 10)"*. A store with no history gets a
forecast whose WIDTH says, correctly, that we do not know much yet.

---

## The four rules every sheet inherits

These come from sheet 00 and are enforced, not merely agreed.

1. **A stage is a pure function of `(value, ctx)`.** No clock, no environment,
   no connection, no network, no random source. If a stage needs it, it belongs
   in `RunContext`. *One clock read inside one stage destroys replay for every
   run that touches it, and it will not be noticed for months.*
2. **Every value carries its provenance.** Not a log line beside it — a field on
   it, persisted in the same row.
3. **Every threshold is declared once**, with an owner and a reason, and starts
   `PROVISIONAL`. `scripts/config_report.py` answers "how much of this engine is
   still guesswork" — a number the old engine could not produce, which is why
   its 63 constants went unexamined.
4. **`ok=False` is an outcome, not an error.** "Not enough evidence" is a real
   answer and belongs in the same shape as a real one.
5. **Cold start is a WEIGHT, not a branch.** `θ̂ = (n·θ_own + k·θ_cohort)/(n+k)`
   handles every store with the same three lines. No tier gate, no
   `if n == 0`, and nothing anywhere may branch on `evidence_state` — that
   label is for display, and `scripts/check_no_state_branches.py` fails the
   build if a stage forgets.

---

## Quick reference

```bash
# Python service
cd Botella_External_APIs
./.venv/Scripts/python.exe -m pytest -q                          # 1038 passed
./.venv/Scripts/python.exe -m pytest tests/test_contracts.py -q  # sheet 02
./.venv/Scripts/python.exe -m pytest tests/test_feature_store.py -q  # sheet 03
./.venv/Scripts/python.exe -m pytest tests/test_evidence.py -q       # sheet 04
./.venv/Scripts/python.exe -m pytest tests/test_priors.py -q         # sheet 05
./.venv/Scripts/python.exe -m pytest tests/test_blend.py -q          # sheet 06
./.venv/Scripts/python.exe scripts/check_no_state_branches.py        # rule 5
./.venv/Scripts/python.exe scripts/check_no_literals.py          # rule 1 + 3
./.venv/Scripts/python.exe scripts/check_no_literals.py --report # the debt list
./.venv/Scripts/python.exe scripts/config_report.py              # rule 3 status
./.venv/Scripts/python.exe -m ruff check app storeagent
./.venv/Scripts/python.exe -m mypy app/pipeline

# The whole engine on one real store: 03 -> 07 -> 10 -> 11 -> 12 -> 14
cd backend && node scripts/export-pipeline-input.js 171 171 --top 25 --out s171.json
# 03 -> 07 -> 10 -> 11 -> 12 -> 14 -> 15 -> 16: prints the cards an owner would
# read, and reports the sheet-16 failure rate over them.
cd ../Botella_External_APIs && ./.venv/Scripts/python.exe scripts/run_decisions.py s171.json

# Node backend
cd backend
npm run migrate                      # analytics migrations
npm run migrate:status
node tests/daily-snapshot-verify.js  # phase 0a
node tests/stage-envelope-verify.js  # phase 0b
node tests/ingestion-verify.js       # sheet 01
node tests/store-spectrum-verify.js  # empty store -> full store, all layers
node tests/rec-admission-verify.js   # sheet 02 - what an owner actually sees
node tests/feature-store-reconcile.js # sheet 03 - must reconcile EXACTLY
node tests/numbers-verify.js         # unknown never becomes zero
node tests/holdout-assignment-verify.js # sheet 17 - the arm must not reshuffle
node tests/family-gate-verify.js     # sheet 17 - shadow/live/suspended
node tests/lift-parity-verify.js     # sheet 19 - ONE lift, both languages
node tests/outcome-feedback-verify.js # sheet 19 - both arms, identically
node tests/rec-surface-verify.js     # sheet 18 - the store/internal boundary
node scripts/run-gate.js             # sheet 17+19 - judge every store-family
node tests/on-hand-capture-verify.js # sheet 14 - the forward shelf-count capture
node tests/rec-eval-verify.js        # outcome measurement, mocks + fixtures
BOTELLA_HEAVY_TIMEOUT_MS=60000 node tests/round5-unit.js   # chat metric layer
node scripts/check-routes.js         # route wiring

# Fill feature_daily.on_hand for a store, then decide from it
node scripts/build-feature-store.js 171 171 --incremental
```

## Pre-existing issues found, not fixed

Flagged rather than changed — each is a separate decision, none blocks the
rebuild. Detail in [DAILY-CAPTURE.md §7.2](DAILY-CAPTURE.md).

- **`MASK_CUSTOMER_IDENTITY = true` has a deadline set by a p-value, and needs
  a product/privacy owner BEFORE the gate reaches it.** The gate (sheet 17)
  moves a family from shadow to live automatically. `win_back` is one of those
  families. On the day it qualifies, every win-back card will name a customer
  the owner cannot identify — a recommendation that is correct, measured, and
  validated by sheets 14 and 16, and still unusable. **No gate in the programme
  catches it**, because none of them asks whether the owner can ACT on a
  correct card. Either the store sees its own customers' names (under what
  consent?) or `win_back` comes out of the family list. Raised, deliberately
  not decided, in [SHEET-18 §7](SHEET-18-STORE-INTERFACE.md).
- **There is no role on the JWT**, so sheet 18's internal surface is guarded by
  a shared secret rather than an identity. It fails closed and is tested, but a
  proper role model is the right answer and belongs to whoever owns auth.
- Analytics migrations 001–004 are checksum-drifted.
- **The POS product sync has stopped for part of the estate, and it decides
  real cards.** `syncgo.products.last_updated` is *today* for stores 171 and
  22, and **2026-06-03 — 112 days stale — for 97, 92 and 106**. Sheet 14 now
  refuses to size an order against a count that old (`Availability.STALE`), so
  the effect is silence rather than a wrong number; but silence is the cost.
  Three of the five stores sampled can currently receive **no reorder
  recommendations at all**. This is an ops fix, not a code one: restart the
  sync. See [SHEET-14 §4](SHEET-14-DECISION-VALIDATION.md).
- **83,322 of 911,022 `products.stock_qty` rows (9%) are negative.** A shelf
  cannot hold −7 bottles, so these are POS artefacts. They are refused as
  `UNPARSEABLE` rather than clamped to zero — clamping would turn *"this count
  is wrong"* into *"this shelf is empty"* and order the maximum — but the
  underlying data defect wants an owner.
- ~~`feature_daily.on_hand` is NULL in all 12,091,569 rows~~ — **fixed.** The
  forward capture the column was created for now runs
  (`featureStoreService.captureOnHand`, called by `build-feature-store.js`):
  **110,079 counts** across the five stores sampled, each stamped at the day
  its sync took it rather than at `as_of`. Because the table now holds one row
  per (sku, day), `obs_date <= as_of` is an honest point-in-time read and a
  reorder is **backtestable for the first time**. Verified by
  `node tests/on-hand-capture-verify.js` (12 checks).

  *Known limitation, recorded rather than hidden:* the observation date is
  **UTC**, not the store's calendar day, so an overnight sync can be dated a
  day late. Resolving it needs the per-store IANA zone, and
  `daily_store_signals` — which would supply it — is empty here because the
  signal cron has not run. Capture returns `day_basis: 'utc'` and says so.
- ~~`backend/tests/round5-unit.js` is pinned to a frozen data snapshot~~ —
  **fixed.** It was pinned to `MAX(sale_date)=2026-05-27` and all 8 date/value
  checks failed once the warehouse advanced. Re-freezing would only postpone
  it, so the anchor is now **read** from the warehouse and every date
  expectation derived from it, and the value checks assert the **property**
  each fix was about (de-duped revenue is below the naive all-rows sum;
  per-unit keeps numerator and denominator on one basis; a bare month never
  resolves past the anchor) instead of a dollar figure that moves daily.
- **`backend/tests/redteam-verify.js`: 13 of 88 adversarial queries still pass
  the app-layer guard** in `routes/chat.js` (was 14). The
  `client_id = total_amount` class is **fixed** — a column-to-column tenant
  predicate is now only accepted when the other side is the *same tenant
  column*, which is a join; anything else constrains nothing while satisfying
  the anchor check. Legitimate cross-table tenant joins still pass.

  The remaining 13 are one structural class: a **second, unfiltered reference
  to a tenant table** (a subquery, a CTE, a self-join, or a join to
  `sale_items` filtered only on `sales`). Closing it means requiring an anchor
  per table reference, which would also reject query shapes that may be in
  live use by the chat feature — a product decision for that route's owner,
  not a safe unilateral tightening. RLS still blocks all of them at the
  database (migration 002), so this is defence-in-depth, not an open hole.
- Six suites need a running server on `:3100` (`audit-verify`,
  `fixfinal-verify`, `reaudit-fixes`, `round5-e2e`, `routing-eval`,
  `metric-spike-eval`) and `hallucination-eval` needs network. Not run here.
- ~~`backend/tests/rec-eval-verify.js` crashes at line 128 in its own mock~~ —
  **fixed, and it was hiding more than a crash.** The mock routed on
  `/FROM products/`, which also matches the `SKU_KEYMAP_CTE` embedded in
  *sale_items* queries, so a single-SKU fetch reached a branch that called
  `.filter()` on a string. Behind the crash, every sales matcher was also dead:
  they keyed on `GROUP BY sku`, which stopped matching when the service adopted
  UPC→SKU canonicalisation (`GROUP BY COALESCE(k.sku, si.sku)`). The mock had
  been returning `[]` for every sales query, so **14 checks were asserting
  against an empty warehouse** and reporting `insufficient_data`, `lift null`,
  `revenue null`. Matchers now route on the SELECT list, which changes far less
  often than join-key canonicalisation, and a mis-route throws with the
  offending query instead of crashing 60 lines later. All checks pass.
- `routes/storeagent.js` and `feedbackService.js` create tables lazily in
  request paths, against migration 001's stated rule; the former contains an
  unguarded `DELETE FROM storeagent_capability_results`.
- `Botella_External_APIs/` is untracked in this repo — a separate codebase
  inside the working tree, sharing a contract that nothing enforces.
- A stale August copy of the Python service exists at
  `C:/Users/Techm/Downloads/external_api` (no git, `validator.py` 38KB vs
  45KB). Do not build there.
