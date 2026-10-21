# Sheet 06A — Integration: the pipeline runs on real data

**Status:** complete. 724 Python tests, 8 Node suites, two build guards, all green.
**Depends on:** 03, 04, 05, 06. **Wave:** 3. **Nature:** activation, not new theory.
**Closes:** the carried-forward item that had been open since sheet 03.

---

## 1. Why this sheet exists

Every sheet from 03 onward ended with the same paragraph:

> **Carried forward, now four sheets old:** no caller migrated to the feature
> store, and the builder has not been run, so `feature_daily` is empty. Every
> sheet since 03 is pure and testable without it, but nothing is *running* on
> real data yet. **This is the largest outstanding item in the programme.**

Six components existed, each proven in isolation. None of them had ever been
handed a real row, and none of them had ever called another. This sheet does
three things and only three:

1. **Run the builder** across the whole estate.
2. **Migrate the callers** still dividing by calendar days.
3. **Wire 04 → 05 → 06** into one call, and run it on real stores.

It adds ~90 lines of genuinely new logic. The rest is wiring — and the wiring
found **seven** defects that no amount of unit testing was going to find,
because every one of them lived *between* two correct components.

---

## 2. The estate is built

| | Before | After |
|---|---:|---:|
| Stores built | 70 of 94 | **94 of 94** |
| Failed | 24 | **0** |
| `feature_daily` rows | 4,249,122 | **12,091,569** |
| `feature_store_day` rows | 33,731 | **60,882** |
| Open / closed / unsynced days | 27,381 / 968 / 5,382 | 53,702 / 1,235 / 5,945 |
| Wall clock | 225.8s | 438.0s |
| DEFAULT partition | 0 rows | **0 rows** (correct) |

`DEFAULT partition: 0 rows` is the check that the 58 monthly partitions from
sheet 03 actually cover the estate's real date range. A non-zero count there
means history is landing in the catch-all and no partition pruning is
happening.

---

## 3. Seven defects, all of them in the seams

### 3.1 The builder timed out on the 24 largest stores

syncgo's `statement_timeout` is **15s**. The per-SKU aggregation over a large
store's full history is nowhere near that: store 122 (880k sale rows, from
2023-01-01) takes **79.5s** as a single statement. Every one of the 24
failures was a timeout, and they were — necessarily — the 24 stores that
matter most.

Two changes, and the asymmetry between them is the interesting part:

- **The fact query is chunked** by date (`BACKFILL_CHUNK_DAYS`, default 365).
  It aggregates by `(sku, obs_date)`, so a date slice is closed under it — no
  aggregate spans a boundary and chunking cannot change an answer. Chunking
  also bounds the result set; 395k rows in one array times the build
  concurrency is memory nobody budgeted for.
- **The calendar query is NOT chunked.** Its outage detection is a run-length
  over consecutive silent days, so a boundary mid-run would split one 9-day
  outage into two 4-day closures — a wrong answer, quietly. It runs whole,
  under a raised timeout.

Proven neutral before it shipped, on the store that broke:

```
whole   rows 395868 units 1330725.00
chunked rows 395868 units 1330725.00
per-(sku,day) mismatches: 0
```

`dateChunks` is an exact partition — verified exhaustively over 805 spans × 7
chunk sizes, zero gaps, zero overlaps, and DST-safe (it steps a UTC
millisecond counter; `setDate` on a local date crosses a spring-forward
boundary and emits a duplicate slice, which would have double-counted units).

**The timeout is raised with `SET LOCAL` inside a read-only transaction, not
`SET`.** A plain `SET` outlives `release()` and leaves a 10-minute timeout on a
pooled connection for whatever borrows it next — which is how a batch job's
settings become an API request's hung query. The transaction is also
`REPEATABLE READ`: the chunks are separate statements, so without a snapshot a
sync landing mid-build would let the 2023 slice and the 2026 slice disagree
about the same store, and the fact table would hold a state that never existed.

### 3.2 `push(...rows)` overflowed the call stack

The first run with chunking failed **5 stores** with
`Maximum call stack size exceeded`. `factRows.push(...part.rows)` spreads every
row as a separate *function argument*; a 300k-row chunk overflows the argument
stack.

It failed on exactly the five largest stores in the estate — the ones chunking
had just been added to rescue. That is the shape of bug that only ever appears
on the data you were trying to fix.

```js
// NOT push(...part.rows)
for (const row of part.rows) factRows.push(row);
```

### 3.3 Sheets 04 and 05/06 disagreed on two pattern names

```
evidence      day_of_week  weekly_trend  monthly              sku_velocity  category
priors/blend  day_of_week  weekly_trend  monthly_seasonality  sku_velocity  category_share
```

Each module was internally consistent and fully tested, so nothing caught it.
**It surfaced on the first attempt to run them as one pipeline** — which is
the point of assembling them: a contract between two modules is not tested by
testing each module.

Not fixed by renaming. `category` is already taken twice over in this codebase
— it is a *specificity* rung on the prior ladder (`sku → category →
all_products`) and a field on every product. Renaming across 48 sites would
have put three meanings of one word within a few lines of each other. Instead
`app/pipeline/patterns.py` holds the canonical five plus one translation, and
`test_the_three_sheets_agree_on_the_pattern_vocabulary` asserts the map is a
**bijection over both tuples** — adding a sixth pattern to one sheet and not
the others fails the build.

### 3.4 The cohort prior was supplied at the wrong grain

The first real end-to-end run produced this, and it looked entirely reasonable:

```
GIFT_C          272  21   93%    4.630  182.586   17.384  MATURE  all_products/state/15
088004026622    256  21   92%    3.935  182.586   17.479  MATURE  all_products/state/15
```

182.586 is the store's **total** units per open day — a store-level quantity
being offered as the prior for **one SKU's** rate. A SKU genuinely selling
3.9/day came back at 17.5, a 4.5× overstatement.

**Nothing in sheets 04–06 could have caught it.** The ladder resolved, k-anon
passed, the blend arithmetic was exactly right. A correct formula over wrong
units is still wrong.

The invariant, now written down and tested: *every rung must answer in the same
unit as the quantity being estimated.*

| Rung | Value |
|---|---|
| `sku` | that SKU's units / open days |
| `category` | category units / open days / distinct SKUs in it |
| `all_products` | store units / open days / distinct SKUs |

After the fix the same rung reads **0.115**, and the blend moves 4.630 → 4.306.
(§3.7 then moved it again, to a *stable* **0.074** — this rung was wrong twice,
in two different ways, and only the first was visible from the numbers alone.)

### 3.5 A swallowed error emptied the category rung

The category rung never fired — every SKU too rare for its own rung fell
through to `all_products`. The cause: the aggregation JOINed `products`
(syncgo) against `feature_daily` (bottleai_analytics). **Separate databases**,
so a single statement naming both cannot run — and it was wrapped in
`.catch(() => ({ rows: [] }))`, which turned a hard error into an empty result
and an output that looked fine.

Same class as the two silent over-refusal bugs fixed before sheet 03. Now two
queries and no catch. A swallowed error is worse than a crash.

### 3.6 The coldest stores got nothing at all

**15 stores in this estate carry products and have sold nothing.** One
(106:106, Maine) stocks **29,019 SKUs** and has never rung up a single unit.
They are the purest cold-start case — the one shrinkage exists to serve.

They got nothing. Two causes, stacked:

1. The exporter seeded its SKU list from `feature_daily` — from what the store
   had **sold**. A store that has sold nothing produced an empty list.
2. Even given SKUs, those stores have no `feature_store_day` rows, and
   `count_evidence` refuses an empty window with `no_calendar_for_window`.
   Every SKU was dropped.

So the store with the least of its own data received the least help, which is
exactly backwards, and it would have shipped looking fine — the 94 stores with
sales all worked.

Neither fix weakens a refusal:

- **SKUs are seeded from inventory**, ranked by how many peer stores sell them.
  A SKU 40 stores sell is a better thing to say something about than one 2
  stores sell, and the cohort answering for it is correspondingly stronger.
- **The caller supplies the days it knows about**, marked for what they are:
  `was_open=false, has_data=false, open_source='no_sync'` — sheet 03's existing
  vocabulary. This invents no trading days; `open_days` stays 0 so nothing can
  divide by it. It turns *"I cannot answer"* into the true answer, **n=0**.

A never-sold SKU is not a zero. `own_rate` is **null**, never 0 — 0 would be a
confident claim that the store sells none of it.

Result on 106:106 — a store with literally zero sales:

```
sku             n   k   own%      own   cohort    BLEND  state   rung/geo/size
3514            0  21     0%    0.000    0.012    0.012  NEW     sku/national/13
1650            0  21     0%    0.000    0.110    0.110  NEW     sku/national/11
12 of 12 SKUs estimated

Based 0% on your own sales (0 observations) and 100% on 13 similar stores (national).
```

### 3.7 The same SKU has different categories in different stores

**95,074 SKUs in this estate carry more than one category** — the same product,
filed differently by different stores.

The exporter resolved a SKU's category with
`DISTINCT ON (sku) ... WHERE category = ANY(categories)`. The filter runs
**before** the pick, so which row wins depended on *which categories the query
happened to ask about*. Exporting store 171:

| `--top` | GIFT_C cohort | rung | cohort size |
|---|---:|---|---:|
| 12 | 0.119 | `category/state` | 8 |
| 20 | 0.115 | `category/state` | 8 |

Same rung, same cohort size, different answer. **An estimate that moves
because you asked about a different number of *other* SKUs is not an
estimate.**

Fixed by resolving every SKU's category first and filtering after, so which
row wins is a property of the SKU and not of the question:

```sql
SELECT sku, category FROM (
  SELECT DISTINCT ON (sku) sku, category FROM products
   WHERE sku <> '' AND category <> ''
   ORDER BY sku, last_updated DESC NULLS LAST
) resolved
WHERE category = ANY($1::text[])
```

Now **0.074 at every `--top`**, and all 12 shared SKUs are byte-identical
across `--top 12` and `--top 25`.

---

## 4. The callers are migrated

Three calendar-day divisors remained. All three now divide by **open** days
when the calendar is known.

| File | Was | Now |
|---|---|---|
| `backend/services/recommendationEvalService.js` (×2) | `units / (28/7)`, `units / 28` | `featureStore.openDays(...)`, with probe-and-degrade + a warning |
| `app/store_data/velocity.py` — `_trend` | `units_prior_83d / (83/7)` | `/ (prior_open_days / 7)` |
| `app/store_data/inventory_health.py` | `units_30d / 4.3` | `units_30d / (open_days_30d / 7)` |

**Every migration is conditional on a calendar being supplied, and that is
deliberate.** Without one there is no way to know which days a store was shut,
and switching the divisor blind is a different wrong answer. A caller with a
calendar gets the corrected rate; a caller without gets exactly the previous
behaviour. The basis is logged, so the difference is never silent.

`app/store_data/__init__.py` gains the seam: `compute_derived(..., calendar=)`.
Python holds no analytics credentials — Node serves the calendar in the
payload. That constraint is preserved, not worked around.

> The sheet-03 claim that `backend/lib/metrics.js` contained a duplicate
> velocity definition was **wrong** — that file contains no velocity code at
> all. The real Node divisors were both in `recommendationEvalService.js`.

### What `_trend` was getting wrong

83 units of prior over a 130-unit window, three divisors:

| This week | 83 calendar days | 71 open days (shut 1/wk) | 36 open days (open 3/wk) |
|---:|---|---|---|
| 15 | **rising** | stable | **falling** |

One number, three verdicts, and only the last two are true.

---

## 5. 04 → 05 → 06 is one call

`app/pipeline/assemble.py` — ~90 lines that call three stages in order and do
nothing else. It may not fetch anything (every input arrives in
`EstateInput`/`SkuInput`, so all three stages stay replayable from recorded
inputs), and it may not branch on `evidence_state`, on `n`, or on whether the
store is new.

**Sheet 00's envelope rejected the first version.** `estimate_sku` was written
with loose arguments — `(estate, sku, pattern, ctx)` — and `@stage` refused it:
the envelope records the *first* argument as THE input, and a stage whose input
is spread across three parameters cannot be replayed from what was recorded.
Hence `EstimateRequest`. That is the guard working, on its author.

---

## 6. It runs. Both ends of "every store, empty to full".

**Bethany (171:171)** — 308 open days in the window, 4,019 facts:

```
sku                 n   k   own%      own   cohort    BLEND  state       rung/geo/size
080686001904      267  21    93%    6.860    1.019    6.434  MATURE      sku/state/6
GIFT_C            272  21    93%    4.630    0.074    4.303  MATURE      category/state/7
088004045456      193  21    90%    4.114    0.846    3.793  MATURE      sku/national/6
619947000037      294  21    93%    4.058    3.843    4.044  MATURE      sku/state/7
088004026622      256  21    92%    3.935    0.064    3.642  MATURE      category/state/7
20 of 20 SKUs estimated
```

**Store 172:172** — the middle. 99 calendar days, **23 open**, 227 facts:

```
sku                 n   k   own%      own   cohort    BLEND  state       rung/geo/size
080660113760       23  21    52%   29.478    0.117   15.465  ESTABLISHED category/state/10
088004012786       19  21    48%    8.043    0.367    4.013  EMERGING    sku/region/5
080686001904       21  21    50%    7.783    1.019    4.401  ESTABLISHED sku/state/6
080686006091       10  21    32%    2.739    0.140    0.979  EMERGING    sku/state/6
12 of 12 SKUs estimated
```

**Store 106:106** — the true cold start. 29,019 SKUs carried, **zero sales
ever**, no calendar rows at all:

```
sku             n   k   own%      own   cohort    BLEND  state   rung/geo/size
3514            0  21     0%    0.000    0.012    0.012  NEW     sku/national/13
1650            0  21     0%    0.000    0.110    0.110  NEW     sku/national/11
2075            0  21     0%    0.000    0.033    0.033  NEW     sku/national/11
12 of 12 SKUs estimated
```

This is the architectural claim, on real data, across the whole spectrum:

| | 106:106 | 172:172 | 171:171 |
|---|---:|---:|---:|
| Open days | **0** | 23 | 308 |
| Facts | 0 | 227 | 4,019 |
| Own weight | **0%** | 32–52% | 83–93% |
| State | `NEW` | `EMERGING`/`ESTABLISHED` | `MATURE` |
| SKUs estimated | 12 of 12 | 12 of 12 | 20 of 20 |
| Code path | identical | identical | identical |

- All three ran the **same three calls in the same order**. Only `n` differs.
- The geography ladder visibly climbs `state → region → national`, and the
  specificity ladder `sku → category → all_products`, per SKU.
- Store 172 gets an answer for all 12 of its SKUs. Under the old engine a
  23-open-day store had nothing to say.

And the sentence an owner can act on:

```
Based 93% on your own sales (267 observations) and 7% on 6 similar stores (state).
Based 52% on your own sales (23 observations) and 48% on 10 similar stores (state).
```

---

## 7. Files

| File | Lines | What |
|---|---:|---|
| `backend/services/featureStoreService.js` | +70 | Chunking, `SET LOCAL`, snapshot txn, `dateChunks` |
| `backend/scripts/build-feature-store.js` | — | The CLI (unchanged) |
| `backend/scripts/export-pipeline-input.js` | 300 | **new** — Node reads analytics, emits the payload; inventory-seeded SKUs, `no_sync` calendar, query-independent category resolution |
| `backend/services/recommendationEvalService.js` | ~30 | Both divisors migrated |
| `app/pipeline/patterns.py` | 80 | **new** — the one vocabulary |
| `app/pipeline/assemble.py` | 230 | **new** — 04 → 05 → 06 |
| `app/store_data/velocity.py` | ~60 | `open_days_between`, `_trend` migrated |
| `app/store_data/inventory_health.py` | ~20 | `open_days_30d` |
| `app/store_data/__init__.py` | ~20 | The `calendar` seam |
| `scripts/run_pipeline.py` | 160 | **new** — the runner |
| `tests/test_assemble.py` | 420 | **new** — 15 tests |
| `tests/test_velocity.py` | +90 | 5 new |
| `tests/test_inventory_health.py` | +50 | 3 new |

---

## 8. Verification

```bash
# Node
cd backend
node scripts/build-feature-store.js --as-of 2026-09-22    # 94/94, 0 failed
node tests/feature-store-reconcile.js                      # ALL CHECKS PASSED
node tests/numbers-verify.js                               # ALL CHECKS PASSED
node tests/daily-snapshot-verify.js                        # ALL CHECKS PASSED
node tests/ingestion-verify.js                             # ALL CHECKS PASSED
node tests/rec-admission-verify.js                         # ALL CHECKS PASSED

# End to end, on a real store
node scripts/export-pipeline-input.js 171 171 --top 20 --out bethany.json
cd ../Botella_External_APIs
./.venv/Scripts/python.exe scripts/run_pipeline.py bethany.json

# Python
./.venv/Scripts/python.exe -m pytest -q                    # 724 passed
./.venv/Scripts/python.exe scripts/check_no_state_branches.py   # exit 0
./.venv/Scripts/python.exe scripts/check_no_literals.py         # exit 0
./.venv/Scripts/python.exe -m ruff check app/pipeline app/store_data  # clean
./.venv/Scripts/python.exe -m mypy app/pipeline/assemble.py           # clean
```

| Requirement | Proven by |
|---|---|
| Chunking changes no answer | reconciliation: 395,868 rows, 0 mismatches |
| `dateChunks` is an exact partition | 805 spans × 7 sizes, 0 failures, DST-safe |
| The three sheets share one vocabulary | `test_the_three_sheets_agree_on_the_pattern_vocabulary` |
| Wrong grain is caught | `test_a_cohort_observation_at_the_wrong_grain_wrecks_the_blend` |
| Empty store and full store run the same code | `test_the_empty_store_and_the_full_store_run_the_same_code` |
| No cliff across the whole seam | `test_the_blend_moves_monotonically_with_history_and_never_jumps` |
| Open days change the trend verdict | `test_a_closed_day_raises_the_prior_rate_and_can_flip_a_trend` |
| Open days change weeks-on-hand | `test_open_days_raise_the_weekly_rate_and_lower_weeks_on_hand` |
| A store with zero sales still gets an answer | `test_a_store_with_no_calendar_rows_still_gets_an_answer` |
| `no_sync` days are never a denominator | `test_no_sync_days_are_never_counted_as_open` |
| An estimate does not move with `--top` | 12 shared SKUs identical at `--top 12` and `--top 25` |

---

## 9. Not done

- **Nothing serves these estimates to a store yet.** The assembly runs from an
  exported payload; wiring it into the live recommendation path is its own
  piece of work, and it should wait for sheet 07's intervals — a point estimate
  without a width is exactly the "ambiguous" output this rebuild exists to
  replace.
- **The feature store is built, not scheduled.** `build-feature-store.js
  --incremental` exists and works; it has no cron.
- **`check_no_literals` does not scan `app/store_data/`.** Its roots are
  `app/pipeline` and `storeagent`, so the migrated files are outside the
  guard's scope. Widening it would surface a large tail of pre-existing
  literals in legacy modules and belongs in its own commit.
- **43 of 43 registry settings remain PROVISIONAL.** Unchanged — wave 6 fits
  them.
- **The exporter is a demo harness, not the production path.** It proves the
  seam end to end on real data; serving these estimates is separate work.
- **Pre-existing, not regressions** (all confirmed unmodified in git):
  `tests/round5-unit.js` fails all 8 checks because it is pinned to
  `MAX(sale_date)=2026-05-27` and the warehouse is now at 2026-09-22;
  `tests/redteam-verify.js` reports app-layer tenant-column gaps in
  `routes/chat.js` (RLS still blocks at the DB, migration 002);
  `tests/rec-eval-verify.js` crashes at line 128 in its own mock; six suites
  need a server on :3100; migrations 001–004 are checksum-drifted; 9 ruff
  findings in modules this sheet did not touch.
- **`own_weight=1.0` on producing stages is a convention, not a bug.** It was
  flagged during review and checked: features, gates and evidence all report
  1.0 ("derived from this store's own data"), priors and peers report 0.0
  ("borrowed"). Only sheet 06's blend means `n/(n+k)`, and that is the value
  the card reads. No change made.

---

## 10. The one-line summary

Six proven components became one proven pipeline — and the seven defects that
turned up in the joins were all invisible to the tests of the parts. Two of
them only appeared on the stores with the least data, which is exactly where
this engine is supposed to be better than the last one.
