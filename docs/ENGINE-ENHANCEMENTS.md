# Engine enhancements — what changed, why, and what it measured

Everything done to the recommendation engine on this line of work, in the order
it happened, with the measurement that justified each change and the ones that
were **rejected** by their own measurement.

**Branch:** `Enh_Engine_v1`
**State:** 1,265 Python tests · both build guards clean · 120 declared settings
(106 still PROVISIONAL, printed on every CI run on purpose)

---

## The one-paragraph version

The engine ranked candidates on **total demand** estimated from a noisy 28-day
window. Ranking on that quantity selects the products whose windows are most
*inflated*, which are exactly the ones that fall back — so the selection
criterion and the estimation error were the same number. It scored ~31% and was
destroying measurable margin. Ranking instead on the **deficit** — the units the
current plan misses — took it to **75.7%**, **+16.6 points over a baseline that
already knows about mean reversion**, significant at p = 0.0005, and it now
holds at all five pilot stores (+6.1 to +19.9).

What is *not* fixed: the engine is right about **direction** almost everywhere
and wrong about **size** almost everywhere. Four of five stores are net negative
in April once unsold stock is costed. That is the open problem.

---

## 1. Temporal reversion — the change that moved the number

**The defect.** A demand rate estimated from a trailing 28-day window is noisy:
sometimes it catches a quiet spell, sometimes a spike. Ranking by that rate
orders products by *how big a seller they look right now*, so it selects the
inflated ones — and an inflated window is by definition the one most likely to
fall back.

**The fix.** Sheet 06 already shrinks a store's estimate toward its cohort,
across **stores**. This shrinks a SKU's recent rate toward its own long run,
across **time**:

```
rate_hat = (n_eff · r_recent + k · r_long) / (n_eff + k)
n_eff    = open_days / (1 + cv²)
```

`n_eff` is the textbook overdispersion deflation — an erratic four weeks carries
less information than a steady four weeks. **`k` is not a new constant**: it is
the registry's existing `shrink.k.sku_velocity`, so the two axes cannot drift
apart.

**Why it is trustworthy: nothing is fitted.** The hit rate is flat at
68.0 / 68.0 / 68.7 / 68.4 / 68.0 for k = 8 / 13 / 21 / 30 / 45. Insensitivity
across a 5× range is the signature of a real effect, not a tuned one.

**A tuned version scored higher and is not in the code.** A rank-average of the
same two signals hit **74.8%** — then collapsed to 64.9% and 50.4% as a
materiality floor was applied. Its edge was borrowed from products selling ~1
unit a month, where the ratio is noise amplified by division.

`app/pipeline/blend/reversion.py` · [SHEET-20](SHEET-20-TEMPORAL-REVERSION.md)

### Two outputs that must not be confused

| output | what it is | where it goes |
|---|---|---|
| `deficit_units` | units the current plan misses | **money** → `units_at_stake` |
| `p_hit` | likelihood it beats its baseline | **confidence** → sheet 08 |

`deficit_units` may be multiplied by a margin to make a dollar figure. `p_hit`
is a ratio and **may not be** — a card claiming "$400" computed from a ratio is
the fabricated-figure defect this rebuild has removed twice.

### p_hit: a product, not an average

Originally `p_hit` averaged a squashed uplift with steadiness. An average lets
either term carry a candidate alone — and a perfectly steady seller has
`steadiness = 1.0` whether it is climbing **or dying**, so `cv = 0` forced
`p_hit ≥ 0.5` however hard the product was falling.

```
p_hit = s / (1 + s),   s = uplift × steadiness
```

Chosen on the first 25 decision dates, scored on the last 25 it never saw:
**68.8% → 69.6%**. It scored *better* out of sample — structure, not a fit.

And the floor now reads as a sentence: `p_hit ≥ 0.5` is exactly
`uplift × steadiness ≥ 1`, i.e. the long-run rate must exceed the recent rate by
at least `(1 + cv)`.

---

## 2. Card lifecycle — the engine had no memory

**The defect, from the March ledger.** Stroyski 1.75L was recommended on **eight
consecutive trading days** and missed every one. The engine recomputed the same
depressed window each morning with no idea it had already said this, or that the
prediction was visibly failing.

**The fix.** Three rules, checked before any card is issued:

1. **Declining** — sales since the card went up are below the rate that
   justified it. Fires **early**, which is the entire point.
2. **No recovery** — past the review window and the rate has not improved.
3. **Stale** — past the maximum age, retire regardless.

Plus **suppression after retirement**, without which retirement does nothing:
the next morning re-earns the card from exactly the evidence just shown to be
wrong.

**Measured.** 162 March cards → **69**, at the same hit rate. Stroyski pulled
after **3 days instead of 8**. 17 retirements (13 declining, 1 no-recovery,
3 stale).

`app/pipeline/candidates/lifecycle.py`

---

## 3. Merchandise contract — and it nearly shipped broken

**The defect.** `0123456789` at 3,506 units a month, `SKU 12` at ten cents (a
bottle deposit), and bags of ice reached the **top** of the earnings table. They
have huge volume and a wobbling trailing window, which is exactly the shape the
reversion signal hunts. The engine was working correctly on data that should
never have reached it.

**The near-miss, and it is the most useful thing in this document.** The first
version of the filter was audited against all ten stores' catalogues before
shipping, and would have **deleted real stock**:

| rule | what it wrongly refused |
|---|---|
| "an ascending run of digits" `0*1?2?3?…` | **1690 Absolut Mandrin**, 1389 Paul Masson, 12390 Moët & Chandon |
| four-character SKU minimum | **417 E&J Brandy**, 443 Bud Light, 105 Keg Miller Lite, 3A Adictivo Añejo |
| the word "department" | **Department 66 Grenache** — a *winery* |
| the word "rounding" | **LYNX POLARIZED GROUNDING AD.** — g-*rounding* |
| a $0.50 price floor | **187 real bottles** with broken price fields |

Rewritten to exact forms and phrases, with **word-boundary** matching for single
words: **45 of 44,398 SKUs refused (0.10%)**, every one accountable. The price
floor now **flags** a suspect price instead of deleting the product.

**A filter that removes real stock is worse than the mess it cleans up**, and
that sentence is in the module so the broad version does not come back.

`app/pipeline/candidates/merchandise.py`

---

## 4. Grading the promise — the measure that exposed the real problem

**The defect.** Hit rate only asks whether a product beat its own trailing rate.
It never checks the **quantity** the card promised, and nothing costed units
ordered but unsold. A card saying "expect 40 more" when 12 arrive has not been
useful, however the hit is scored.

**Added:** `prediction_accuracy` (realised ÷ promised) and the cost of unsold
units, so a **net** figure exists.

**First measurement, Bethany March:**

| window | promised | delivered | kept | margin | cost of unsold | **net** |
|---|---:|---:|---:|---:|---:|---:|
| **30d** | 1,540 | 912 | **59%** | +$1,122 | −$1,617 | **−$495** |
| 90d | 1,540 | 3,254 | 211% | +$3,276 | −$1,284 | +$1,992 |

**At its own decision horizon the engine was net negative.** Right about
direction, wrong about size.

---

## 5. Calibrating the promise — validated at one store, and it does not generalise

**Two hypotheses tested and discarded first.**

*Winner's curse* — ranking by the largest estimated deficit should rank by
estimation error too. Measured: selected cards keep **47%**, every material SKU
with a positive deficit keeps **51%**. A four-point selection penalty is not the
explanation.

*A better `k`* — the deficit is `(1−w)(r_long − r_recent)·H`, directly
proportional to `k`:

| k | promise kept | WAPE total | bias | hit rate |
|---|---:|---:|---:|---:|
| 8 | 85% | 43.3% | +5.7% | 53.4% |
| **21** | 51% | **42.6%** | **+0.2%** | 53.4% |
| 45 | 39% | 43.8% | −3.2% | 53.4% |

`k=21` already **minimises** forecast error and bias; `k=8` fixes the promise
and breaks the forecast. **Hit rate is flat across the whole sweep** — which is
why an earlier sweep called `k` insensitive. True, and misleading: hit rate
depends only on *ordering*, and `k` moves *magnitude*.

**So the level keeps its `k` and the gap is calibrated separately**
(`reversion.deficit_calibration`), per store, from its own closed windows.

**At Bethany: 50% → 93%** on dates the factor never saw.

### Then five stores said otherwise

| store | promise kept | calibration factors |
|---|---:|---|
| Cork Runner | 150% | 0.51–0.92 |
| **Bethany** | **104%** | 0.41–0.70 |
| Mango Jo's | 53% | 0.25–0.54 |
| Northlake | 45% | 0.38–0.67 |
| Marshfield | **21%** | **1.00 — all 169 cards uncalibrated** |

**I validated at one store and generalised from it.** One scalar per store,
fitted on recent closed windows, is not enough: where the reversion relationship
shifts between the calibration period and the measured month, the factor is
stale.

**Marshfield is the fallback working as designed** — history only from Feb 2025,
so too few closed windows to fit on, and every card uses the identity. Refusing
to invent a correction is right, and it is why its promise is the worst.

**Open problem. Candidate next steps:** a longer calibration window (more
stable, less responsive), per-category calibration, or — most honestly — promise
a **range** rather than a point.

---

## 6. Forecast accuracy — the gate, built before the thing it gates

Every accuracy claim about this engine had been about hit rate, which is a
question about *selection* and is already ~59% by accident. **Nothing had ever
measured how wrong the quantity is.**

**Bethany, April window, 5,272 forecasts** (dates held out from the calibration
slice):

| model | WAPE units | WAPE margin | bias |
|---|---:|---:|---:|
| **the engine** | **42.3%** | **47.3%** | **+0.6%** |
| 12-month average | 47.8% | 50.6% | −6.7% |
| trailing 28 days *(what it used to use)* | 51.3% | 76.7% | +17.2% |
| same window last year | 69.8% | 69.7% | −14.1% |

| horizon | baselines | bias | coverage |
|---|---|---|---|
| 30d | PASS 3/3 | **PASS +0.6%** | **PASS 81%** |
| 60d | PASS 3/3 | **PASS +3.5%** | **PASS 80%** |
| 90d | PASS 3/3 | FAIL +6.7% | PASS 81% |
| 120d | PASS 3/3 | FAIL +8.8% | PASS 82% |

**R10 passes outright at 30 and 60 days.** Over-forecasts at the long ones.

### The interval took three attempts and only the third is honest

| attempt | coverage (target 75–85%) |
|---|---|
| weekly `cv` applied to the window total | **91–93%** — so wide it could not be wrong |
| `cv / √weeks` | **37–62%** — too narrow; weekly demand is autocorrelated |
| **empirical, from the estimator's own track record** | **80–82%** |

The third drops the distributional assumption entirely: fit the band on an early
slice, apply it to later dates.

`scripts/forecast_accuracy.py`

---

## 7. Calendar facts — built, and the candidate they powered was rejected

Moving dates are **computed, never tabulated**: Thanksgiving is the fourth
Thursday, Memorial Day the last Monday, the Super Bowl moved to the second Sunday
in February in 2022, and Easter needs the anonymous Gregorian computus. 22 tests
pin known-good dates across four years so the arithmetic cannot drift silently.

**Then the honest part.** A seasonal multiplier built from those facts — with the
day-of-week and pre-holiday indices **estimated from each store's own history**
rather than hand-written — **lost at 0 of 4 horizons**, pushing 30-day bias from
+0.6% to **+9.2%**.

The trailing window already reflects current conditions, so a store-level
busy-ness index double-counts. **Second time seasonality has been tried on this
engine and lost.** The harness prints `REJECT` with the reason.

**The calendar facts stay** — they are inputs a model can learn a coefficient
for. The multiplier does not.

`app/pipeline/features/calendar.py`

---

## 8. Evidence infrastructure

| script | what it answers |
|---|---|
| `real_engine_backtest.py` | walk-forward over the full export, reversion-matched null, pooled permutation test, date-clustered bootstrap |
| `forecast_accuracy.py` | WAPE / bias / coverage vs three baselines (R10) |
| `daily_recommendation_ledger.py` | every card on every trading day, followed 30/60/90/120 days |
| `run_all_ledgers.py` | all three layers per store, plus the index |
| `export-store-sales.js` | cursor-streamed SELECT out of `syncgo` |

### Statistical choices that matter

- **Reversion-matched null, not volume-matched.** The engine selects products
  whose recent window is depressed; the metric asks whether they beat that
  window. Those are close to the same question, so part of any edge is
  regression to the mean. Against a *volume-matched* null the edge reads +44
  points; against products **equally primed to revert** it is **+16.6**.
  **Quote the second.**
- **Date-clustered bootstrap.** Two picks on the same date share a market. A
  row-wise bootstrap reported "82.9%" off 41 observations and was thrown away.
- **Pooled permutation, not per-run.** Each run shows ~5 cards, so a per-run test
  is nearly powerless — Fisher over 24 of them returned p = 0.73 while the
  clustered interval comfortably excluded the null. Pooling across runs while
  drawing the null run-by-run gives **p = 0.0005**. Both are printed.
- **Incremental, not total, margin.** `(sold − expected) × margin`, not
  `sold × margin`. The old ordering showed the **largest** total captured
  ($215k) and a **negative** incremental — total rewards naming the biggest
  sellers while predicting nothing.

---

## 9. Reporting fixes

| finding | what was wrong |
|---|---|
| **M1** | Incremental margin summed across overlapping horizons — counting one decision four times |
| **M2** | Backtest re-runs per horizon *by design*; the ledger runs once a day. Both legitimate, now **labelled** so they cannot be confused |
| **M3** | Hardcoded prose. "Combining 24 such tests… p = 0.73" printed on a run with 212 tests; "the fourth fifth outscores the fifth" in every copy including the ones where it was false, beside a chart showing otherwise. Now `_calibration_verdict()` computes the curve's actual shape |
| **M4** | `p = 0.0005` is the add-one floor of **2,000 permutation draws**, not of the 400 null baskets listed beside it. Both now labelled |
| **M5/M6** | Promise and downside — see §4 |
| **M8** | Non-merchandise candidates — see §3 |
| **M10** | Ledger intervals treat overlapping cards as independent and are **optimistic**; stated in place, with the fortnightly backtest named as the better headline |

### Windows named by the month they close in

"30 days" is an engineering unit. A card written 2 March and judged 30 days later
is judged **in April**:

| window | closes |
|---|---|
| **April** (30d) | 1 – 30 Apr |
| **May** (60d) | 1 – 30 May |
| **May–Jun** (90d) | 31 May – 29 Jun |
| **Jun–Jul** (120d) | 30 Jun – 29 Jul |

The 90-day window genuinely straddles two months and says so. A reader who
checks and finds a rounding will then check everything else.

### A falsy-zero bug, caught before it shipped

`s.get("cost") or 1.0` maps a genuine `0.0` coverage to `1.0` — the same class as
`Number(null) === 0`. A store sending **no cost data** would have had its money
columns rendered as if measured. Caught by exercising the index generator on a
synthetic no-cost store before any real run used it.

Five of ten stores audited genuinely send zero cost, so this would have fired.

---

## 10. Where it stands

### All five pilot stores

| store | backtest | hard null | **edge** | p | April | promise | April net |
|---|---:|---:|---:|---:|---:|---:|---:|
| 178 Marshfield | 83.8% | 63.8% | **+19.9** | 0.0005 | 68.6% | 21% | −$5,099 |
| 181 Cork Runner | 78.0% | 59.4% | **+18.6** | 0.0005 | 77.4% | 150% | −$186 |
| 171 Bethany | 75.7% | 59.1% | **+16.6** | 0.0005 | 65.2% | **104%** | **+$120** |
| 176 Northlake | 71.0% | 63.1% | +7.9 | 0.0005 | 54.7% | 45% | −$776 |
| 177 Mango Jo's | 76.1% | 70.0% | +6.1 | 0.0005 | 78.6% | 53% | −$5,539 |

**Every store beats a reversion-matched null significantly.** That is the result
that holds.

**Four of five are net negative in April.** That is the result that does not.
"Ship" in the index means *has a real edge over mean reversion* — it does **not**
mean *makes money*.

### On the 90% target

Measured three ways: top decile of the strongest available signal caps at
**65–69%** at every horizon; sweeping floor × coverage over 50 dates the best
worst-horizon is **73.1%**; the best single card per date is 71.1%. **90% is not
reachable on this metric.** For a product selling ~10 units a month, Poisson
noise alone puts it below its own mean about a third of the time regardless of
what is known.

### What is blocked, and why

| | |
|---|---|
| **Historical on-hand** | Does not exist. A stockout is indistinguishable from a dip, so the engine recommends it and scores the restock as skill — noise in the selection **and** the grade. Cannot be backfilled; capture must start now |
| **Lead times** | `purchase_orders` has the right columns and **zero rows** at four of five stores. Only asking the stores fixes it |
| **LightGBM (R9)** | No numeric stack, and `app/pipeline` forbids one by design. Train offline, consume a fitted artefact |
| **Causal proof** | `recommendation_evaluations` has zero rows. The holdout mechanism exists and is not switched on |

Full requirement-by-requirement prompts: [ENGINE-TWO-PROMPTS.md](ENGINE-TWO-PROMPTS.md)

---

## 11. Rejected by measurement — the list worth keeping

A rebuild that reports only its successes is not evidence.

| idea | why it was dropped |
|---|---|
| Tuned rank-average of reversion + stability | 74.8% → 64.9% → 50.4% as a materiality floor applied. Edge borrowed from 1-unit-a-month products |
| Seasonality as a **ranking** ratio | 90-day hit rate 70.0% → 58.4% |
| Seasonality as a **forecast multiplier** | Lost at 0/4 horizons; bias +0.6% → +9.2% |
| Higher materiality floor | 66.2% → 39.5% as it rose 8 → 80 units. Big steady sellers have little room to beat their own rate |
| Stockout-shape features (`longest_zero_run`) | ~8 points of decile spread against reversion's 49–61 |
| Lower `k` to fix the promise | Fixes the promise, breaks the forecast — see §5 |
| Batch-relative `p_hit` percentile | Measured well, unshippable: the same product scores differently depending on which others are in the run |
| SKU price floor as a **refusal** | Deleted 187 real bottles with broken price fields. Demoted to a flag |

---

## 12. Reproducing all of it

```bash
# 1. export each pilot store from syncgo (SELECT-only, cursor-streamed)
cd backend && node scripts/export-store-sales.js all --out ../audit/data

# 2. all three evidence layers for every store, plus the index
cd ../Botella_External_APIs
python scripts/run_all_ledgers.py --data ../audit/data --out ../audit --month 2026-03

# 3. tests and both build guards
python -m pytest tests/ -q                      # 1265
python scripts/check_no_literals.py             # no magic numbers
python scripts/check_no_state_branches.py       # nothing branches on evidence state
python scripts/config_report.py                 # 106 of 120 still PROVISIONAL
```

Outputs: `audit/ENGINE_AUDIT.html` (index) and
`audit/ledger-{store}-2026-03/RECOMMENDATION_LEDGER.html` (per store, 12
sections). Rerun on the same exports and every page reproduces except its
generation date.
