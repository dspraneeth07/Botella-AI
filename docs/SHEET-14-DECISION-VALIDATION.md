# Sheet 14 — Decision validation

**Status:** complete. **1038 Python tests (+48), two build guards, ruff + mypy
clean, 10 Node suites green.**
**Depends on:** 10, 11, 12. **Wave:** 4. **Replaces:** a single validator that
could not tell a pipeline bug from a wording slip.

> **Note on the source path.** The sheet header names
> `C:/Users/Techm/Downloads/external_api`. That is the **stale August copy**.
> All work in this programme is in `BottleAI-gitlab/Botella_External_APIs`, on
> branch `New_Rec_Engine_v1.0`.

---

## 1. Why this exists

There is already a validator. It drops a card when something looks wrong, logs
a line, and moves on. That is the problem: **a negative order quantity and a
clumsily-worded sentence produce the same dropped card and the same log line**,
so neither is ever investigated. One is a 3am problem and one is a Monday
problem, and the system could not tell you which it had just seen.

This sheet asks exactly one question, before a single token is spent:

> **Is this DECISION correct?**

Sheet 16 asks a different one — *does the SENTENCE match the decision*. Keeping
them apart is the whole design. A candidate that fails here is **dropped**,
because it is wrong and no wording can fix it.

| | Sheet 14 | Sheet 16 |
|---|---|---|
| Question | is the decision correct | does the sentence match it |
| Failure means | an upstream stage produced something **impossible** | a **prompt regression** |
| Severity | `PAGE` — wake someone | `LOG` — count it, look Monday |
| Cost of running | free, pre-model | after the model call |

`Severity` is a `StrEnum` with two members so the two kinds of failure are
**different objects**, not two readings of the same one. `pageable(reasons)` is
a function rather than a convention, so the alerting path cannot drift from the
severity the check assigned.

---

## 2. The five checks

| # | Check | What it refuses |
|---|---|---|
| 1 | `QUANTITY` | non-integer, non-positive, above sheet 10's `order_up_to`, or beyond `MAX_PLAUSIBLE_ORDER_MULTIPLE` × horizon demand |
| 2 | `DATE` | missing, in the past, unreachably far out, or a negative lead time |
| 3 | `RISK` | a stated figure that does not reconcile with `demand_p50 × unit_margin` |
| 4 | `CONSTRAINTS` | **silence** — a constraint nobody evaluated |
| 5 | `INVENTORY` | `on_hand + on_order + order − demand < safety_stock` |

### Check 1 catches a decimal slip, not a large order

An order beyond **twelve times** the horizon demand is not ambition, it is a
units/cases confusion or a rate applied to the wrong window. Sheet 11 caps by
shelf capacity and budget where those exist — and **neither exists in this
warehouse** — so this is the only thing standing between a decimal slip and a
purchase order.

### Check 2: reachable, not merely future-dated

A deadline six months out is not a relaxed deadline; it is date arithmetic that
went wrong upstream, and it reads to an owner as *"no hurry"* on a card about a
stockout. `MAX_ORDER_BY_HORIZON_DAYS` is 180 — comfortably past a seasonal
pre-buy, the longest legitimate lead this trade has.

### Check 4 is the quiet one

**Silence is a failure.** A constraint that was never evaluated is not a
constraint that passed.

```python
REQUIRED_CONSTRAINTS = ("case_pack", "on_hand", "moq", "shelf_capacity", "budget")
```

Every one must appear, satisfied or **explicitly unavailable with a stated
reason**. An unavailable constraint carrying no reason is an assumed bound
wearing an honest label, and it fails too.

This is the check that catches the class of bug where a stage is skipped and
everything downstream still looks fine. Sheet 11's whole point is that *"we do
not know your shelf capacity"* and *"you have infinite shelf"* are different
sentences; a validator that accepts silence undoes that in one line.

---

## 3. The gate found its own bug on its first real run

This is the finding of the sheet, and it is worth stating plainly because it is
the failure this sheet exists to prevent, reproduced inside the gate meant to
prevent it.

Run the chain `03 → 07 → 10 → 11 → 12 → 14` on real store 171 data. All three
decisions **paged**:

```
on_hand=48.0 + on_order=0.0 + order=116 - demand=277.8 = -113.8  <  safety_stock=30.0
```

The order was right. **The comparison was not.**

- `demand_p50` is sheet 07's forecast over its **horizon** — 30 open days.
- The order is sheet 10's, sized to cover **lead time + review period** — 14 days.

You are not buying 30 days of stock. You are buying enough to reach the next
delivery. Checking a 14-day order against 30 days of demand compares two
different quantities, and it fails *every correct decision*.

> **A false page is worse than no page**, because it teaches people to ignore
> the real one.

`DecisionRequest` now carries both windows and `coverage_demand()` pro-rates:

```python
def coverage_demand(request) -> tuple[float, int]:
    if request.coverage_days <= 0 or request.horizon_days <= 0:
        return request.demand_p50, request.horizon_days or 0
    scaled = request.demand_p50 * request.coverage_days / request.horizon_days
    return scaled, request.coverage_days
```

After the fix: **3 passed, 0 paged**, same data, same run.

**Pro-rating assumes demand is flat across the two windows.** It is not —
day-of-week and seasonality both move it — but the alternative is a second
forecast at a second horizon, and the error from pro-rating is far smaller than
the error from comparing 14 days against 30. Stated here rather than hidden,
because it is an assumption and assumptions get surfaced in this programme.

### The two windows are deliberately different, and that is pinned

Risk is **not** pro-rated. The risk a card displays is the full exposure over
the forecast horizon — what the store stands to lose by doing nothing. The
order only has to cover to the next delivery. Pro-rating risk as well would
quietly shrink every risk figure on every card to less than half of what is
actually at stake, so
`test_risk_stays_on_the_forecast_horizon_and_is_not_prorated` holds the
distinction in place.

### The record says which window it used

`DecisionRecord` carries `coverage_days` and `coverage_demand`, and
`figures()` exposes them — so a card may say *"covers you for 14 days"* and
sheet 16 can check the numeral. When the caller states no window they are
**absent** rather than zero: nothing claims a coverage window nobody stated.

---

## 4. The second finding: the engine was sizing orders against an empty shelf

Threading sheet 14 end-to-end on real data required an honest `on_hand`, and
looking for one turned up something larger.

**`feature_daily.on_hand` is NULL in all 12,091,569 rows.** Every store, every
day, since the table was created. That is deliberate and the migration says so:
`syncgo.products` keeps **one mutating row per SKU** with no history, so there
is no on-hand history to reconstruct and the column is only ever filled forward
from the day capture starts. Capture has not started.

Meanwhile sheets 10, 11, 12 and 14 all take `on_hand`, and:

```
ideal_qty = order_up_to - on_hand - on_order
```

**A missing `on_hand` read as zero does not produce a cautious small order. It
produces the largest order the policy can express** — on every SKU at once,
with nothing in the output looking wrong. The first version of the chain
script did exactly that and recommended **170** units of `080686001904` where
the true count of 48 gives **116**: a 47% over-order, silently.

That is the `Number(null) === 0` bug class this programme exists to kill,
reproduced in a script written to prove the programme works.

### What was built

**The forward capture the column was created for now runs.**
`featureStoreService.captureOnHand()` writes `products.stock_qty` into
`feature_daily.on_hand`, and `build-feature-store.js` calls it on every build.
Across the five stores sampled that is **110,079 shelf counts** in a column
that held none.

The one decision that makes it honest rather than merely populated: **each row
is stamped at the day the SYNC took the count** (`obs_date =
date(products.last_updated)`), never at `as_of`.

- A store that synced this morning gets today's count at today's date.
- A store whose sync stopped on 2026-06-03 gets its count **at 2026-06-03**,
  which is *true*. Sheet 14 still refuses to size an order against it.

Stamping a stale count with today's date would be the most confident lie
available to this table, and invisible forever after.

Two further rules, both the same rule `known_at` already follows:

- **Nothing captured is ever rewritten** —
  `on_hand = COALESCE(feature_daily.on_hand, EXCLUDED.on_hand)`. A table whose
  past changes underneath a backtest cannot measure anything. Re-running
  capture is idempotent, and `on-hand-capture-verify.js` asserts it.
- **Capture rows never carry `units_sold = 0`.** Sheet 04 counts *n* from days
  with sales; a zero there would inflate every store's evidence and shrink it
  toward its own data prematurely.

**`export-pipeline-input.js` now reads the capture, not the catalogue** — which
is what makes the export point-in-time. `products` holds one mutating row per
SKU and can only answer *"what is on the shelf now"*; the capture holds one row
per (sku, day), so `obs_date <= AS_OF` is an honest historical read and a
backtest sees exactly the count the engine would have seen that day. Measured:
**5 of the top 25 SKUs have a count as of 2026-09-20, 23 as of 2026-09-23** —
monotonic, as a point-in-time read must be.

The counts are carried as their own block, **not folded into `facts`**: facts
are a time series of transactions, a shelf count is an observation about a day,
and each row states when it was observed so sheet 11 can measure its age.

**`on_hand_from_snapshot()` in sheet 11** turns a raw count into a `Constraint`
that carries *why* it has the value it has. Four outcomes, four different facts:

| Input | Result | Why |
|---|---|---|
| a recent count (0 included) | `KNOWN` | zero is a **measurement** — an empty shelf is the state most likely to deserve a reorder |
| no row in the snapshot | `UNAVAILABLE` | unknown is not empty |
| a **negative** count | `UNPARSEABLE` | **83,322 of 911,022 rows (9%)** are negative. Not clamped to zero: clamping turns *"this count is wrong"* into *"this shelf is empty"*, which orders the maximum |
| older than `MAX_STOCK_SNAPSHOT_AGE_DAYS` | **`STALE`** | a new fifth `Availability` state |

A wiring bug worth recording, because it was silent and backwards: capture
first ran **after** the builder's `no_sales` skip, so store 106 — 29,019 SKUs,
10,334 of them holding stock — captured **nothing**, purely because it had sold
nothing that week. A store holding stock it is not selling is the *dead stock*
case, the one most worth having a count for. Capture now runs before the skip
and recovers **26,634** counts for that store.

`STALE` is distinct from `UNAVAILABLE` on purpose. `UNAVAILABLE` says the
warehouse cannot supply a shelf count — false, and unactionable. `STALE` says
**a sync stopped**, which somebody can go and restart. A stale constraint
supplies **no value at all**, because a stale count is not a less certain count;
it is a count of a shelf that has since been sold from and restocked an unknown
number of times, and arithmetic on it produces a confident wrong number rather
than an uncertain one.

### The estate is wildly uneven, and it matters

| store | SKUs | positive | zero | negative | last synced |
|---|---:|---:|---:|---:|---|
| 171 | 9,759 | 2,438 | 7,290 | 31 | **2026-09-23** (today) |
| 22 | 23,746 | 13,916 | 8,510 | 1,320 | **2026-09-23** (today) |
| 97 | 31,198 | 8,690 | 21,689 | 819 | 2026-06-03 — **112 days ago** |
| 92 | 21,161 | 297 | 20,615 | 249 | 2026-06-03 — **112 days ago** |
| 106 | 29,019 | 10,334 | 16,300 | 2,385 | 2026-06-03 — **112 days ago** |

Before the freshness guard, **store 106 produced 13 confident reorder
recommendations sized against shelves last counted in June.** They are now all
withheld. That is the difference between a recommendation and a guess wearing
a number.

`MAX_STOCK_SNAPSHOT_AGE_DAYS` defaults to **7** — one review period, the window
inside which a count is still about the same shelf. PROVISIONAL, to be fitted
once sync freshness is monitored rather than inferred.

### The look-ahead is now structurally impossible

Before the capture there was only a current snapshot, so a historical `--as-of`
had to be given **no stock at all** — today's shelf says nothing about March's,
and pretending otherwise is a look-ahead that makes a backtest look better than
the engine is. That was a restriction, not a solution: **no reorder could be
backtested.**

Reading `feature_daily.on_hand` with `obs_date <= AS_OF` removes the question.
A historical read cannot see a later count because a later count is a different
row. The payload still carries `stock_basis`, so a reader can tell *"this store
has no counts captured"* from *"we did not ask"* — different facts that look
identical as an empty list.

Capture has one observation per SKU so far, so reads before it started return
nothing, honestly. Daily runs accumulate the history.

---

## 5. What it does on real data

`scripts/run_decisions.py` runs the whole chain from an exported payload —
**03 → 07 → 10 → 11 → 12 → 14** — and is committed rather than ad-hoc, because
an end-to-end result nobody can re-run is an anecdote.

```
store (171, 171)  as_of=2026-09-23  snapshot=b89fcac65a561a13
  horizon  30 open days (sheet 07)
  coverage 14 days = 7 lead + 7 review (sheet 10)
  stock    22 usable of 23 carried (1 stale), basis=current_snapshot

sku                qty          by      p50   covers  on_hand      ss  record
080686001904       116  2026-09-30    275.1    128.4     48.0    36.2  5 states, 9 figures
721059000505        29  2026-09-30    247.4    115.5    125.0    39.5  5 states, 9 figures
858800              30  2026-09-30     89.0     41.5     29.0    17.7  5 states, 9 figures

3 decisions passed the gate (14-day coverage window)
22 refused before the gate - not a bug, a stage declining to answer
```

Across five real stores:

| store | usable counts | **passed** | refused | paged |
|---|---:|---:|---:|---:|
| 171 | 22 of 23 | **3** | 22 | 0 |
| 22 | 21 of 23 | **7** | 18 | 0 |
| 97 | 0 of 1 | 0 | 25 | 0 |
| 92 | 0 of 0 | 0 | 25 | 0 |
| 106 | 0 of 22 | 0 | 25 | 0 |

**10 valid decisions, 0 pages.** Of store 171's 22 refusals, **20 are simply
"stocked above the reorder point"** — a correct answer, not a gap. The engine
looked at 25 SKUs and found 3 worth acting on, which is what a store owner
should get instead of 25 cards.

---

## 6. Every threshold is a registry Setting

| Setting | Default | Why |
|---|---:|---|
| `validate.risk_tolerance_pct` | 5 | absorbs float accumulation and display rounding, nothing else |
| `validate.inventory_tolerance_units` | 1 | a case pack rounds the order **up**, so one unit absorbs the ceil |
| `validate.max_order_by_horizon_days` | 180 | covers a seasonal pre-buy, the longest legitimate lead here |
| `validate.max_plausible_order_multiple` | 12 | beyond this it is arithmetic, not ambition |
| `constraints.on_hand.max_snapshot_age_days` | 7 | one review period |

All PROVISIONAL. `check_no_literals` enforces that none of them is a literal.

---

## 7. Files

| File | Lines | What |
|---|---:|---|
| `app/pipeline/validate/decision.py` | ~530 | five checks, `Severity`, `DecisionRecord`, `coverage_demand` |
| `app/pipeline/validate/__init__.py` | 40 | public surface |
| `app/pipeline/constraints/sources.py` | +110 | `STALE`, `stale()`, `on_hand_from_snapshot()` |
| `scripts/run_decisions.py` | 290 | the whole chain on one real store |
| `backend/services/featureStoreService.js` | +125 | `captureOnHand()` — the forward capture |
| `backend/scripts/build-feature-store.js` | +60 | runs it, and reports stores whose sync stopped |
| `backend/scripts/export-pipeline-input.js` | +50 | point-in-time `stock` block read from the capture |
| `backend/tests/on-hand-capture-verify.js` | 180 | 12 checks against the real warehouse |
| `tests/test_validate_decision.py` | 575 | 40 tests |
| `tests/test_constraints.py` | +100 | 8 tests for the shelf-count guard |

---

## 8. Verification

```bash
cd Botella_External_APIs
./.venv/Scripts/python.exe -m pytest tests/test_validate_decision.py -q  # 40
./.venv/Scripts/python.exe -m pytest tests/test_constraints.py -q        # 49
./.venv/Scripts/python.exe -m pytest -q                                  # 1038
./.venv/Scripts/python.exe scripts/check_no_literals.py                  # exit 0
./.venv/Scripts/python.exe scripts/check_no_state_branches.py            # exit 0
./.venv/Scripts/python.exe -m mypy app/pipeline/                         # clean

# End to end on a real store: capture the shelf, export, decide
cd ../backend
node scripts/build-feature-store.js 171 171 --incremental   # fills on_hand
node tests/on-hand-capture-verify.js                        # 12 checks
node scripts/export-pipeline-input.js 171 171 --top 25 --out s171.json
cd ../Botella_External_APIs && ./.venv/Scripts/python.exe scripts/run_decisions.py s171.json
```

| Sheet requirement | Proven by |
|---|---|
| A wrong decision is dropped, not reworded | `test_a_failed_decision_carries_no_record_to_reword` |
| Silence is a failure | `test_a_constraint_that_was_never_evaluated_is_rejected` |
| Pipeline bug pages, wording does not | `test_every_failure_here_is_page_severity` |
| The record carries every displayable figure | `test_a_valid_candidate_passes_and_carries_its_full_record` |
| The two windows must match | `test_demand_is_prorated_to_the_window_the_order_covers` |
| The real store-171 case passes | `test_the_real_store_171_decision_passes_once_the_windows_match` |
| Risk is **not** pro-rated | `test_risk_stays_on_the_forecast_horizon_and_is_not_prorated` |
| A stale count refuses | `test_a_stale_count_is_stale_not_unavailable_and_says_how_old` |
| A negative count is never clamped | `test_a_negative_count_is_unparseable_and_never_clamped_to_zero` |
| Zero on hand is a measurement | `test_zero_on_hand_is_a_measurement_and_passes_through` |
| The count is dated by its sync, not by today | `on-hand-capture-verify.js` check 5 |
| Capture never rewrites a recorded fact | `on-hand-capture-verify.js` checks 7–9 |
| Capture rows cannot inflate sheet 04's *n* | `on-hand-capture-verify.js` check 12 |

---

## 9. Not done

- **Nothing calls this in the live run yet.** Same migration dependency as
  sheets 10–13: stage 12's typed candidates must first replace the 14-slice
  generator in `validator.py`.
- **`PAGE` does not page yet.** `pageable()` returns the reasons; wiring them
  to an alerting channel is an ops task, and the severity is carried precisely
  so that wiring is a one-liner rather than a redesign.
- **Only the `reorder` family runs end-to-end.** CLEAR, MARKDOWN, RANGE and
  SUBSTITUTE are validated by the same five checks but are not yet produced by
  the chain script, because they need sheet 09's elasticity and days-since-last-sale
  threaded through.
- **The capture's observation date is UTC, not the store's day.**
  DAILY-CAPTURE.md §4 establishes that a day key should be the store's own
  calendar date, because a 04:00 UTC event is the previous evening across the
  US — so a count synced overnight can be attributed one day late. Fixing it
  needs a per-store IANA zone, and the table that supplies it
  (`daily_store_signals`) is **empty in this environment**: the signal cron has
  not run. Guessing a zone would be worse than a recorded basis, so capture
  returns `day_basis: 'utc'` and says so rather than implying store-local
  precision it does not have.

  The first version of this was worse and is worth recording: it derived the
  date in **JavaScript**, from the process timezone, so the same row landed on
  2026-09-23 on an IST laptop and 2026-09-22 on a UTC server. This file's own
  service header warns against exactly that — *"re-implementing the calendar
  derivation in JavaScript would have recreated the 454-vs-485 problem in a new
  place"*. It did. The derivation is now `to_char(last_updated AT TIME ZONE
  'UTC', 'YYYY-MM-DD')`, in SQL, explicit about its zone, returned as a string
  so nothing downstream can reinterpret it.

- **Three of the five stores sampled still receive no reorder at all**, because
  their POS product sync stopped on 2026-06-03. That is now *visible* — the
  builder prints every store whose newest count is older than the limit — but
  it is an ops fix, not a code one.

---

## 10. The one-line summary

The last gate before the model now asks whether the decision is *correct* —
separately, and loudly, from whether the sentence is *well-worded* — and on its
first real run it caught a units mismatch between two stages, a 47% over-order
hiding behind a null, and 13 recommendations sized against a shelf last counted
112 days earlier. Closing the last of those turned a column that had been NULL
in 12,091,569 rows into 110,079 dated observations, and made a reorder
backtestable for the first time.
