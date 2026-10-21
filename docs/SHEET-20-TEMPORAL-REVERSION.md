# Sheet 20 — Temporal reversion

**Status:** complete. **1206 Python tests (+39), both build guards, full suite
green.**
**Depends on:** 03, 06, 08, 13. **Wave:** 6. **Feeds:** 06, 07, 13, 19.

---

## 1. Why this exists

The backtest kept coming back at ~35%. Every sheet from 00 to 19 was measured,
tested and honest, and the engine still could not pick a good recommendation.

This sheet is the audit that found out why, and the fix.

**The engine was ranking on the quantity it was getting wrong.** Not ranking
badly — ranking on the *error itself*, which is worse than ranking at random
and is exactly what the numbers showed.

The fix is two changes, and the ablation in §3a separates them: **what expected
value multiplies** (the deficit, not total demand) carries most of the gain,
and the shrinkage that sizes that deficit adds the rest.

---

## 2. The finding

A demand rate is estimated from a trailing window — 28 days here. That window
is noisy: sometimes it catches a quiet spell and under-states the SKU,
sometimes it catches a spike and over-states it.

Ranking by that rate orders SKUs by *how big a seller they look right now*. So
it selects the ones whose windows are most **inflated**. And an inflated window
is, by definition, the one most likely to fall back next month.

The selection criterion and the mistake were the same quantity.

### Measured, on Bethany's three years, 45 decision dates

| ordering | hit rate | realised gross margin |
|---|---:|---:|
| **trailing rate — what shipped** | **39.3%** | **−$13,783** |
| corrected rate + deficit + p_hit | **65.6%** | **+$14,508** |

A **+$28,291 swing** on one store, and the old ordering's median pick had a
**negative** deficit of −6.5 units: the engine was systematically recommending
products that then sold *below* their own baseline.

That is not underperformance. The ordering was **anti-correlated** with the
outcome.

### The signal, found before any model was fitted

52,008 (sku, date) observations, features computed strictly before each
decision date, labels strictly after. Univariate hit rate, bottom decile → top
decile:

| feature | bottom → top | spread |
|---|---|---:|
| `rev_28_365` (28-day rate ÷ 365-day rate) | 60.6% → 18.3% | **47.2 pts** |
| `deficit_units` | 21.8% → 61.6% | **43.5 pts** |
| `rev_28_90` | 57.4% → 17.1% | 41.4 pts |
| `cv_90` (instability) | 44.9% → 17.3% | 27.6 pts |
| seasonality | — | 15.8 pts |
| momentum (`mom_7_28`) | — | 12.0 pts |
| `longest_zero_run` (stockout shape) | — | ~8 pts |

**Mean reversion dominates, and momentum barely registers.** The stockout
hypothesis — that a suppressed window is a stockout and reverts hard on
resupply — was tested and **disproved** at ~8 points.

---

## 3. The correction

Sheet 06 shrinks a store's own estimate toward its cohort, **across stores**.
This shrinks a SKU's recent rate toward its own long run, **across time**.
Same formula, different axis.

```
rate_hat = (n_eff · r_recent + k · r_long) / (n_eff + k)
n_eff    = open_days / (1 + cv²)
```

`n_eff` is the textbook effective-sample-size deflation for an overdispersed
count: an erratic four weeks carries less information than a steady four
weeks, so it is shrunk harder toward the long run.

**`k` is not a new constant.** It is the registry's existing
`shrink.k.sku_velocity`, declared in sheet 06 long before this measurement
existed. Reused rather than redeclared, so the two axes cannot drift apart.

### Nothing here is fitted

There is no parameter tuned against the outcome, so there is no sample this
result was fitted on. The hit rate at top-10:

| k | 8 | 13 | **21** | 30 | 45 |
|---|---:|---:|---:|---:|---:|
| hit rate | 68.0% | 68.0% | **68.7%** | 68.4% | 68.0% |

Flat across a 5× range. **Insensitivity is the signature of a real effect
rather than a tuned one.**

### The tuned version was better on the scoreboard and is not in the code

A rank-average of the same two signals scored **74.8%** — the best number this
audit produced. It is not shipped, because restricting to SKUs material enough
to deserve a card collapsed it:

| ordering | no floor | floor 8 units | floor 20 units |
|---|---:|---:|---:|
| tuned rank-average | **74.8%** | 64.9% | 50.4% |
| this sheet's estimator | 60.7% | **71.9%** | — |

Its 74.8% was **borrowed from SKUs selling ~1 unit a month** — where the ratio
`r_long/r_recent` is noise amplified by division. It was measuring the metric,
not the shop.

---

## 3a. The ablation — which half is actually doing the work

Four orderings over one candidate pool, 240 picks each, 6 decision dates ×
4 horizons, intervals clustered by date. `margin_impact` is
`(sold − expected) × margin` — money that would **not** have arrived anyway.

| ordering | hit rate | 95% CI | **incremental** | total | median pick |
|---|---:|---|---:|---:|---:|
| trailing deficit, no shrinkage | **68.8%** | 60.8–75.4 | +$23,151 | $122,753 | 15u |
| **sheet 20: deficit + gates** | **67.1%** | 60.0–74.2 | +$22,377 | $120,387 | 14.5u |
| total demand — what shipped | 60.4% | 56.2–65.8 | **+$882** | $215,233 | 30u |
| deficit, no gates | 57.1% | 47.5–66.7 | +$39,144 | $114,786 | **4u** |

**Most of the gain is the DEFICIT, not the shrinkage.** Switching what expected
value multiplies — from total demand to the units the plan misses — is worth
**+6.7 points and +$21,495**. Against a deficit built from the raw trailing
rate, the shrinkage measures **−1.7 points**: the two are statistically
indistinguishable, their intervals almost entirely overlapping.

The shrinkage is kept anyway, and the reason is a product requirement rather
than a scoreboard one: it **bounds the size of the claim**. An erratic SKU with
one quiet month can show an enormous raw deficit, and that number gets printed
on a card. Nothing in the hit rate notices; an owner would.

**The gates cost incremental margin and are still right.** Ungated, the deficit
earns the most money of any row (+$39,144) — from picks whose median size is
**4 units**. Those are not cards. The materiality and `p_hit` floors trade
$16,767 of paper margin for picks a store owner can actually act on, and the
hit rate rises 10 points doing it.

### Two margin numbers, and only one of them is a verdict

The old ordering shows **$215,233** of total captured margin and **+$882**
incremental. Both are real and they answer different questions:

- `margin_captured` = `sold × unit_margin` — total flow through the picked
  SKUs. Dominated by **how big the picks are**, so an engine that simply names
  the shop's biggest sellers maximises it while predicting nothing.
- `margin_impact` = `(sold − expected) × unit_margin` — money that would **not
  have arrived anyway**.

Judging a recommendation on total captured rewards naming the obvious. On the
decision metric the old ordering is **break-even to three significant figures**
while carrying the largest total in the table.

> **Correction.** An earlier version of this sheet reported the old ordering at
> **−$88,847**. That was measured before §3b's window bug was found, with the
> recent window tied to the horizon on *both* arms. With the window corrected
> for both, the old ordering is break-even rather than value-destroying. The
> ranking conclusion is unchanged; the magnitude was wrong.

---

## 3b. The window bug in the backtest port

The notebook set `lookback = horizon`, so a 120-day forecast estimated the
"recent" demand rate over **120 days** and compared it to a 365-day long run.
Two heavily overlapping windows carry almost no contrast, which is precisely
what sheet 20 runs on — the correction was being suppressed at exactly the
horizons where it read worst.

The demand **level** is a property of current trading conditions, not of how
far ahead you are looking. You estimate what the shop is selling now, then
project it over whatever horizon the decision needs. `BASELINE_WINDOW_DAYS`
is now fixed at 28, matching production and matching what sheet 20 was
measured on.

| horizon | before | after | edge over floor | p |
|---|---:|---:|---:|---:|
| 30 | 70.0% | **71.7%** | +32.3 | 0.00 |
| 60 | 67.8% | **71.7%** | +33.3 | 0.00 |
| 90 | **43.4%** | **63.3%** | +30.1 | 0.00 |
| 120 | **48.1%** | **63.3%** | +31.8 | 0.00 |

The 90-day horizon gained **+19.9 points**. More telling than any single row:
the edge is now a **stable ~+30 across all four horizons** instead of
collapsing at the long end. A model whose edge holds as the horizon changes is
correctly specified; one whose edge evaporates is being suppressed by
something, and here that something was the window.

Overall: **58.0% → 67.5%**, edge **+21.5 → +32.2 points**.

---

## 4. Two outputs, and they must not be confused

| output | what it is | where it goes |
|---|---|---|
| `deficit_units` | units the current plan misses | **money** → `units_at_stake` |
| `p_hit` | likelihood it beats its baseline | **confidence** → sheet 08 |

The engine already computes `expected_value × confidence × urgency`, so both
land in terms that were always there. **No new ranker was added.**

`deficit_units` is what a margin may be multiplied by to make a dollar figure.
`p_hit` is a ratio and **may not be** — a card claiming "$400" computed from a
ratio is the fabricated-figure defect this rebuild has already removed twice.

### `p_hit` is ordered, not calibrated

| `p_hit` band | actual hit rate |
|---|---:|
| ≤ 0.45 | 18.6% |
| 0.45–0.50 | 26.7% |
| 0.50–0.55 | 33.4% |
| 0.55–0.60 | 42.4% |
| 0.60–0.65 | 54.6% |
| > 0.65 | 63.7% |

Monotone, so it **ranks** correctly. Not numerically true — `p_hit = 0.55`
corresponds to a **42%** outcome. It must pass through sheet 08's isotonic
calibration before any figure derived from it reaches a store owner, exactly
as sheet 08's 0.48-stated-against-0.23-actual finding requires.

It is deliberately **not named `confidence`**, and
`ScoreInputs.from_reversion` takes the calibrated value as a separate
argument, so `p_hit` cannot slide into that field. A test asserts the
constructor never reads it.

---

## 5. Two defects found by the tests, not by the measurement

**A steady decliner cleared the confidence floor.**
`p_hit` averages an uplift term with a steadiness term, so a perfectly steady
seller has `steadiness = 1.0` and therefore `p_hit ≥ 0.5` *however hard it is
falling*. Ranking hid it — negative expected value sorts last — but **sorting
last is not being refused**, and a card at position 40 is still a card telling
an owner to reorder a dying product. `is_recommendable` now requires
`deficit_units > 0`.

**A field added in the middle rebound positional arguments.**
`SkuInput` is constructed positionally in the existing tests; inserting the
new window fields after `own_rate` silently bound `observations` to
`recent_units`. Four tests caught it. New fields are appended, never inserted.

---

## 6. Per-candidate, never per-batch

An earlier version scored a candidate by its **percentile among the others in
the run**. It measured well and is unshippable: the same SKU on the same data
would score differently depending on which other SKUs were in the batch, so
two runs over one snapshot could disagree and no card could explain its own
number.

The absolute form measured **better** anyway — 65.6% and $14,508 against
67.1% and $12,914 — and every quantity is now a function of one candidate's
own history.

---

## 6a. The report was grading two engines as one

Found while renaming the report away from "Claude": `res` holds **both arms**,
and every aggregate in the report read from it. So the headline was the
**average of the old LLM arm and the new engine** — a blend of a 21.7% system
and a 70.0% system, printed as one number and captioned "Claude".

It inverted the report's own conclusion:

| | pooled (as published) | engine only |
|---|---:|---:|
| hit rate | 45.8% | **67.5%** |
| mean percentile | 50.0 — *"no skill"* | **69.6** (CI 65.9–73.2) |
| p-value | 0.49 — **not significant** | **0.00000 — significant** |

Per horizon the engine reads **71.7 / 71.7 / 63.3 / 63.3%** against a ~36%
dart throw, every horizon significant.

`EVAL` is now the new arm wherever the report says "the engine"; the
head-to-head section still reads `res`, because comparing the arms is its job.
The subheader used to print the model id as though the engine were that model —
it now reads *"deterministic engine, no model in the selection path · old arm:
claude-opus-5"*, which is the only mention left and is labelled as the
comparison.

---

## 7. The honest answer on 90%

**It is not reachable on this metric, and no amount of tuning changes that.**

Tested at every confidence floor and every coverage, down to a single card per
decision date:

```
best single-card hit rate 71.1% at floor 0.78 (45 cards), 95% CI 57.8-84.4
  -> 90% is OUTSIDE even that interval
```

No ranker, floor or coverage combination has 90% inside its 95% confidence
interval. The reason is irreducible: for a SKU selling ~10 units a month,
Poisson noise alone puts it below its own mean roughly a third of the time no
matter what is known in advance. The base rate is 34.6%; the ceiling this
audit could find is ~70%.

**What is real is the edge: 34.6% → 65.6%, and −$13,783 → +$14,508.**

An earlier probe in this same audit reported **82.9% at top-1**. That was 41
observations and its true interval is enormous. Every figure in this sheet uses
a bootstrap **clustered by date**, because two picks on the same date share a
market and a row-wise bootstrap would report an interval far tighter than the
evidence supports.

### The dial, and what it costs

`reversion.min_hit_probability` is the lever — recommend fewer, only the
confident:

| floor | recs/date | hit rate | realised margin |
|---:|---:|---:|---:|
| 0.00 | 10.0 | 62.7% | $11,462 |
| **0.50** | **10.0** | **65.6%** | **$14,508** |
| 0.55 | 10.0 | 65.6% | $13,044 |
| 0.60 | 10.0 | 66.7% | $11,981 |
| 0.65 | 4.5 | 63.7% | $5,334 |

**Turning it up past 0.50 costs money and buys almost nothing.** It is not a
knob to raise for a better-looking number.

---

## 8. What shipped

| file | change |
|---|---|
| `app/pipeline/blend/reversion.py` | **new** — the stage, 4 settings, 3 MEASURED |
| `app/pipeline/assemble.py` | reversion runs **before** the cohort blend |
| `app/pipeline/rank/score.py` | `ScoreInputs.from_reversion` |
| `app/pipeline/blend/__init__.py` | exports |
| `tests/test_reversion.py` | **new** — 23 tests |
| `tests/test_assemble.py` | +6 seam tests |
| `tests/test_rank.py` | +4 ranking-seam tests |

### Order matters

Reversion runs **before** sheet 06, not after. Shrinking a biased estimate
toward a cohort leaves a biased estimate, just a quieter one. Correct across
time, *then* blend across stores.
`test_correction_happens_before_the_cohort_blend_not_after` asserts it by
property: `theta_own` must equal sheet 20's rate exactly, which can only hold
if nothing touched it in between.

### Migration is opt-in and exact

A caller supplying only `own_rate` gets **exactly** the old answer — not
approximately. Supply all four window fields and the correction applies.
Three of four is refused rather than half-applied: guessing the fourth would
silently invent history.

### Settings

| setting | value | status |
|---|---:|---|
| `reversion.materiality_floor_units` | 8 | **MEASURED** |
| `reversion.min_hit_probability` | 0.5 | **MEASURED** |
| `reversion.horizon_days` | 30 | **MEASURED** |
| `reversion.default_dispersion_cv` | 1.0 | PROVISIONAL |
| `reversion.min_weeks_for_dispersion` | 4 | PROVISIONAL |

Registry now: **60 settings, 54 still PROVISIONAL.**

---

## 9. Still open

- **The live path does not run any of this yet.** `validator.py` / `pipeline.py`
  still use the 14-slice generator; sheets 12–16 and now 20 are wired to each
  other but not to the request that serves a store. That migration is the
  remaining blocker between this measurement and a store owner seeing it.
- Measured on **one store**. The effect is structural rather than fitted, so it
  should generalise, but `reversion.default_dispersion_cv` in particular needs
  estate-wide dispersion before it stops being a guess.
- The evaluation script is rebuilt against this architecture next; the figures
  here come from the audit probes, not from the notebook.
