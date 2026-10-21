# Sheet 19 — Outcome feedback

**Status:** complete. **1167 Python tests (+16), 15 Node suites, both build
guards, ruff + mypy clean.**
**Depends on:** 17, 18. **Wave:** 6. **Feeds:** 03, 05, 06, 08, 17.

---

## 1. Why this exists

**Nothing in the architecture improves without this.**

Calibration needs outcomes to fit. The shrinkage constant *k* needs outcomes to
be fitted from. The gate needs outcomes to judge. Cohort priors need outcomes to
sharpen. **Every PROVISIONAL setting in the registry stays provisional until
this loop has run.**

And it closes the gap sheet 17 shipped with: the gate's statistics existed, the
table existed, and nothing assembled the inputs.

---

## 2. The finding: there were already two definitions of lift

The sheet warns that two implementations of one metric is how a dead-stock count
came out **454 on one screen and 485 on another** — while the owner was told in
writing that they matched.

That had already happened again, in the metric the entire feedback loop depends
on:

| | `recommendationEvalService.js` | `app/store_data/feedback.py` |
|---|---|---|
| baseline window | 28 days | **21 days** |
| measurement window | the covered span | **fixed 7 days** |
| aggregation | `sum(actual) / sum(expected)` — **pooled** | `fmean(ratios)` — **mean of ratios** |

On identical data those produce answers **1.37× apart**:

```
Node  (pooled, 28d):  lift = 4.48
Python(mean,   21d):  lift = 6.15
ratio between them:   1.37x
```

Calibration fits on lift. *k* is fitted from it. The gate judges on it. Two
definitions means two answers to *"did it work"*.

### One definition, pinned across both languages

`backend/lib/lift.js` owns the arithmetic; `app/pipeline/outcomes/lift.py` is
its twin; `backend/tests/lift-parity-verify.js` runs **one shared fixture**
through both and compares digit for digit. The same pattern sheet 08 uses to pin
the stage envelope.

Three decisions, made once:

**1. Open days, never calendar days — in *both* windows.**
Dividing the baseline by open days and then multiplying by calendar days just
moves the error.

**2. A pooled ratio, not a mean of ratios.**
A recommendation covering a 100-unit SKU and a 1-unit SKU is mostly about the
100-unit one. The mean of ratios lets the quiet SKU — whose ratio swings wildly
on a single basket — carry half the answer. That is the same volume-blindness
sheet 17's matched null removes, and it belongs out of the metric too.

**3. A zero baseline is not a zero denominator.**
A SKU with no trailing sales has an **undefined** lift, not an infinite one. Its
sales are real and are reported separately as upside.

> **`lift = null` always means UNMEASURABLE, never "no effect".** A caller
> reading null as 1.0 turns *"we could not tell"* into *"it did nothing"* — the
> same class of error as reading a missing count as zero.

---

## 3. The second finding: the per-rec lift used calendar days

The store-level rate had been fixed to open days long ago, with a comment about
the calendar divisor it replaced. The **per-recommendation** one was missed —
and it is the figure the gate and calibration actually consume:

```js
expectedSku = (baseUnits / BASELINE_DAYS) * coveredDays;   // 28 CALENDAR days
```

Measured across the estate:

| store | closed days | open days in a 28-day window | rate understated by |
|---|---|---|---|
| 103:103 | 203 of 1,359 | 22 | **27.3%** |
| 171:171 (Bethany) | 200 of 1,360 | 23 | **21.7%** |
| 101:101 | 199 of 1,350 | 22 | **27.3%** |

The error is the **mismatch** between the two windows' open fractions, so it
does not cancel: a baseline period with four Sundays measured against a window
with five produces a lift wrong by the difference, in whichever direction the
calendar happened to fall.

Both windows now count open days from the store's own calendar, fetched once per
run as a set of dates — because each recommendation needs the open days in *its
own* two windows, which a single estate-wide count cannot answer.

A bug I introduced fixing it, and caught: a window with **zero** open days
divides by nothing, producing `Infinity` that propagates into `expected` and
makes lift 0 — reporting *"this did nothing"* for a store that was shut. Guarded
in both the shared library and the inline path.

---

## 4. The withheld arm is the entire point

Without it we measure **forecasting** — did the number we predicted come true.
With it we measure **causation** — did telling them change what happened. Our
only existing evidence is a retrospective backtest for exactly this reason.

So both arms are scored by the **same function, over the same window, against
the same baseline**. Not "also scored" — *identically* scored.

### Arm-blind by construction, not by discipline

The first version took `(rec, skuOutcomes, windows)` and simply did not read
`rec`. That is a promise a future edit can break in one line, and the line would
look harmless — *"while we are here, treat the withheld arm's partial windows
differently"*. The moment the two arms travel different code, the comparison
stops measuring the recommendation and starts measuring the difference between
the two code paths.

**The parameter is gone.** `scoreRecommendation(skuOutcomes, windows)` cannot
branch on the arm because nothing in it knows what the arm is, and the test
asserts the *signature* rather than trusting the body.

> **A false green I caught while doing it.** Removing the parameter left the
> test passing three arguments to a two-argument function, so both calls
> returned the same *unmeasurable* result and checks 4–6 compared two identical
> failures. They were green and meant nothing. `4a` now asserts the comparison
> is measurable before comparing it.

`arm` is `NOT NULL` with **no default** and a CHECK constraint. A row that
cannot say which side it is on is not an outcome — it is a sales figure.

---

## 5. Every row can replay the decision that produced it

```
recommendation_id · client_id · location_id · sku · family · arm
recommended_qty · actual_purchased_qty · actual_units_sold
window_start · window_end · open_days_in_window · baseline_open_days
lift · lift_reason · expected_units · upside_units
stated_confidence · calibrated_confidence
evidence_state · own_weight · cohort_level · cohort_size
model_version · feature_version · config_version · snapshot_id
```

**Both confidences are kept**, because calibration's whole job is fitting one
against the other — storing only the calibrated one would destroy the pairing.

**`actual_purchased_qty` is nullable and that matters**: a NULL means *"no
purchase-order data for this store"*, not *"they bought none"*. A zero would
read as a store ignoring every recommendation.

**Re-scoring replaces, it does not accumulate.** Two rows for one window would
each be counted as independent evidence by the gate — which is how 30 outcomes
becomes 60 without 30 more facts.

---

## 6. The loop closes

`backend/scripts/run-gate.js` is the job sheet 17 was waiting on: read outcomes
and the volume-matched null pool, hand them to Python, write the verdict back.

Proven end to end on real store data — 40 outcomes (32 shown, 8 withheld held at
1.0), a null pool built from store 171's genuinely un-recommended SKUs:

```
  171:171   reorder       live       n=  32  beat_the_null
            p=0.0025  observed=2.4  null=1.13

1 store-family pair(s) evaluated, 1 live, 0 transition(s)
```

**The first family ever proven at any store.** `p = 0.0025` is exactly 1/401 —
the resolution floor, as designed, not a claim of vanishing improbability.

The null pool **excludes anything with an outcome row in either arm**. A
withheld recommendation is not an un-recommended product: the engine still chose
it, and including it would compare the engine against its own choices.

---

## 7. Files

| File | Lines | What |
|---|---:|---|
| `backend/lib/lift.js` | 155 | **THE** definition |
| `app/pipeline/outcomes/lift.py` | 195 | Its twin, pinned by fixture |
| `backend/database/analytics-migrations/020_...sql` | 120 | The outcome record |
| `backend/services/outcomeFeedbackService.js` | 230 | Record both arms; feed the gate |
| `backend/scripts/run-gate.js` | 175 | The job sheet 17 waited on |
| `Botella_External_APIs/scripts/gate_eval.py` | 110 | The statistics side of it |
| `Botella_External_APIs/scripts/lift_parity.py` | 55 | The parity runner |
| `backend/services/recommendationEvalService.js` | +60 | Open days in both windows |
| `backend/tests/lift-parity-verify.js` | 175 | 15 checks, both languages |
| `backend/tests/outcome-feedback-verify.js` | 185 | 19 checks |
| `Botella_External_APIs/tests/test_outcomes.py` | 165 | 16 tests |
| `app/store_data/feedback.py` | +90 | switched to the shared definition |
| `Botella_External_APIs/tests/test_feedback.py` | +95 | 6 tests pinning the change |
| `backend/services/recommendationEvalService.js` | +55 | writes outcome rows |
| `backend/server.js` | +55 | the nightly gate cron |

---

## 8. Verification

```bash
cd backend
npm run migrate                              # 020
node tests/lift-parity-verify.js             # 15 — both languages, one fixture
node tests/outcome-feedback-verify.js        # 19 — both arms, identically
node scripts/run-gate.js 171 171             # the loop, end to end

cd ../Botella_External_APIs
./.venv/Scripts/python.exe -m pytest -q      # 1167
```

| Sheet requirement | Proven by |
|---|---|
| A withheld rec is scored identically to a shown one | `outcome-feedback-verify.js` 4–7 |
| …and the comparison is not vacuous | `outcome-feedback-verify.js` 4a |
| Open-day division everywhere | `test_open_days_are_used_in_both_windows`, parity D |
| One lift figure across services | `lift-parity-verify.js` 1–9 |
| A pooled ratio, not a mean of ratios | `test_the_ratio_is_pooled_so_a_quiet_sku_cannot_carry_the_answer` |
| Every row carries its versions | `outcome-feedback-verify.js` 11 |
| Both confidences stored | `outcome-feedback-verify.js` 12 |
| `null` is unmeasurable, never "no effect" | `test_unmeasurable_is_never_reported_as_one` |
| Re-scoring replaces | `outcome-feedback-verify.js` 15–16 |
| The uniform-closing case cancels (why it hid) | `test_a_uniform_closing_pattern_cancels_out` |
| The uneven case does not, and that is the bug | `test_an_UNEVEN_closing_pattern_does_not_cancel_and_that_is_the_bug` |
| The per-rec score is deliberately uncapped | `test_the_score_component_is_deliberately_uncapped_here` |

---

## 9. The loop is wired end to end

All three items this sheet originally deferred are done.

**The evaluation pass writes outcome rows.** `recommendationEvalService` now
records one per (recommendation, window) alongside its own evaluation — the two
answer different questions and both are kept. The arm comes from the persisted
`status`, **read and never re-derived**: re-deriving it from the current
`REC_HOLDOUT_PCT` would relabel history the day that setting changes.

`calibrated_confidence` is written as NULL rather than a copy of the stated
value. Sheet 08's curve needs this table to be fitted, and seeding it with the
stated value would make the calibration fit itself.

**`feedback.py` uses the shared definition.** It fed the proven-winner pool and
the avoid-list off its own 21-day mean-of-ratios lift, so this changes which
SKUs get boosted — deliberately, and now pinned by tests.

`_lift_component` is deliberately **not** the shared `score_from_lift`: that one
caps at 5× before squashing, which is right for the gate's mean (one 40× row
must not decide a store's verdict) and wrong here, where the score is per
recommendation and a genuine 40× is the strongest signal available. Same shape,
different job, stated rather than accidental.

**The gate is scheduled.** 05:00 nightly, an hour after the recommendation
batch — the gate judges on outcomes, so running before the day's outcomes are
scored would decide today's visibility on yesterday's evidence. It logs every
state transition, because a family that was live for three months and is now
suspended is a signal about that store. Failing is safe: a gate that does not
run leaves every family where it was.

### A finding from testing the open-day fix

The calendar-day error **cancels exactly** when both windows have the same open
fraction — `21/21 × 7` and `21/18 × 6` are both 7. A store that simply closes
every Sunday gets the right lift either way, which is why nobody noticed the
denominator for so long.

It bites when the fractions **differ**: a holiday shutdown inside the
measurement window but not the baseline projects a full window's expected sales
onto days the store could not have sold on, and marks the recommendation down
for them. Both cases are now pinned by tests.

---

## 10. Still not done

- **The null pool is approximated.** It uses each un-recommended SKU's rate
  relative to its volume class's median, which is a reasonable stand-in for
  "what it would have done anyway" but is not the same construction as a
  recommended SKU's lift against its own trailing baseline. Tightening it needs
  per-SKU baselines for the whole catalogue — a heavier query than the gate
  currently justifies.
- **`evidence_state`, `own_weight`, `cohort_level` and `cohort_size` are NULL
  on outcome rows.** The columns exist and the gate reads them; the evaluation
  pass does not yet carry sheet 06's provenance through, because the live path
  still uses the legacy generator. They fill when the migration lands.
- **No family is live in production yet**, and none can be for roughly a
  quarter. That is the cost of the holdout having been switched off until sheet
  17, and it is why the loop had to ship before anything that consumes it.

---

## 11. The one-line summary

The loop that every PROVISIONAL setting in the registry has been waiting on now
runs end to end — and closing it first meant finding that the metric it turns
on had two implementations disagreeing by 37%, and that the per-recommendation
lift had been dividing by calendar days at stores that close 200 days a year.
