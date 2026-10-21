# Botella recommendation engine — architecture, stack, and measured results

**Measured on the real engine**, not on a port of it: `scripts/real_engine_backtest.py`
imports the production modules in `app/pipeline` and calls them.

Run it yourself:

```bash
cd Botella_External_APIs
python scripts/real_engine_backtest.py --data "/path/to/dataset" --every 14 --out run/
# 52 decision dates across 3.7 years, ~50 seconds, 5 charts, one self-contained HTML
# -> run/REAL_ENGINE_REPORT.html, run/summary.json, run/predictions.json
```

---

## 1. The headline, and the number that survives scrutiny

**The full export, walked forward.** 52 decision dates every ~2 weeks across
3.7 years · 4 horizons · **208 runs · 1,056 cards** · 260,707 transaction
lines · 4,914 products · Bethany's Discount Liquor.

| | | |
|---|---:|---|
| **Hit rate** | **75.9%** | Wilson 73–78%, n=1,056 |
| **Clustered 95% CI** | **70.3 – 80.7%** | by DATE, not by row — the interval to quote |
| Volume-matched null | 31.9% | edge **+44.0 pts** |
| **Reversion-matched null** | **59.2%** | edge **+16.7 pts** ← *the honest one* |
| **p-value** | **0.0005** | pooled permutation vs the hard null |
| Median lift | 1.44× | 47% of picks clear 1.5×, production's winner bar |
| Incremental margin | **+$51,052** | +$48 per card |
| Cards per run | 5.1 | out of a 10-slot slate |

### By horizon

| horizon | n | hit | 95% CI | hard null | edge | median lift |
|---|---:|---:|---|---:|---:|---:|
| 30d | 264 | 72.3% | 67–77% | 51.6% | **+20.8** | 1.41× |
| 60d | 264 | **77.3%** | 72–82% | 59.8% | +17.4 | 1.36× |
| 90d | 264 | **77.7%** | 72–82% | 61.8% | +15.8 | 1.44× |
| 120d | 264 | 76.1% | 71–81% | 63.5% | +12.6 | 1.52× |

**Every horizon is above 72%, and three of four are above 76%.** The earlier
six-date run showed n=28 a horizon and intervals 30 points wide; this one shows
n=264 and intervals of ±5.

### Consistency — it is not one lucky window

| | |
|---|---|
| Decision dates | 52 |
| Dates scoring ≥50% | **45 of 52** |
| Dates scoring 0% | **0** |
| Worst date | 33% |
| Median date | 75% |

### Read this before quoting +44

The engine selects SKUs whose recent window is **depressed** against their own
long run. The hit metric asks whether they then **beat that recent window**.
Those are close to the same question, so part of any edge is **regression to
the mean** — free to anyone picking quiet SKUs.

The **volume-matched** null is the usual test (+44.0). The
**reversion-matched** null draws from SKUs **equally primed to revert**
(+16.7). **Quote +16.7.** It is smaller and it is the one that holds when
someone pushes back.

### Which significance test, and why

Each run shows ~5 cards, so a permutation test *per run* is weak. Pooling every
run's picks against pooled matched-random slates, drawn run by run so
clustering is honoured, gives **p = 0.0005** — in 2,000 matched draws, none
beat the engine. The script prints the conservative per-run Fisher combination
alongside it; neither is hidden.

### The one result that is NOT clean

Confidence does not finely rank. Hit rate by `p_hit` quintile:

| quintile | mean p_hit | actual hit rate |
|---|---:|---:|
| 1 (lowest) | 0.505 | 72.0% |
| 2 | 0.518 | 70.6% |
| 3 | 0.537 | 75.4% |
| **4** | 0.559 | **85.3%** |
| 5 (highest) | 0.647 | 75.9% |

It rises overall (72% → 76%) but **not monotonically** — the fourth fifth
outscores the fifth. `p_hit` works as a **gate** (everything above the floor
beats 70%) and poorly as a **fine-grained ranking** within the eligible set.

Practically: **showing the top 3 cards instead of the top 10 is not reliably
better**, because the ordering inside the slate carries little information. The
honest lever is the floor, not the rank. Sharpening this is the clearest next
piece of work on the engine.

---

## 1a. On the 80% target — measured three ways, and the answer is no

This was asked for directly, so here is the direct answer.

**80% at every horizon is not reachable on this metric.** Swept across the
confidence floor and the card count over **50** decision dates (not the 6 the
backtest uses), the best worst-horizon result is **73.1%**:

| p_hit floor | cards | worst | 30d | 60d | 90d | 120d | cards/run | money |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0.40 | 10 | 69.2% | 69.2 | 71.0 | 74.0 | 73.8 | 10.0 | $88,609 |
| **0.50** | **10** | **72.5%** | 72.5 | 72.9 | 75.5 | 75.5 | **5.4** | **$42,542** |
| 0.55 | 10 | **73.1%** | 73.1 | 76.9 | 78.7 | **80.6** | 2.4 | $19,056 |
| 0.60 | 10 | 72.2% | 72.2 | 75.0 | 75.0 | 77.8 | 1.2 | $3,244 |

**The 30-day horizon is the binding constraint** — it caps around 73%. The
long horizons *do* pass 80% at a tight floor, but only by showing 2.4 cards a
run and giving up 55% of the incremental margin.

Why it caps: for a SKU selling ~10 units a month, **Poisson noise alone** puts
it below its own mean about a third of the time regardless of what is known in
advance. The top decile of the strongest signal available tops out at 65–69%
at every horizon. Tighter selection converts some of that into precision; it
does not remove the noise floor.

**What was delivered instead:** +9 to +12 points at every horizon, validated
out-of-sample. See §1b.

---

## 1b. The improvement that IS real, and how it was validated

`p_hit` was reformulated from an **average** to a **product**:

```
p_hit = s / (1 + s),   s = uplift × steadiness
```

An average lets either term carry a candidate alone — and steadiness alone is
not evidence of anything. A perfectly steady seller has `steadiness = 1.0`
whether it is climbing or dying, so `cv = 0` forced `p_hit ≥ 0.5` **however
hard the SKU was falling**. The product cannot do that.

**Chosen on the first 25 decision dates, scored on the last 25 it never saw:**

| ranking | fit half | **held-out half** | money |
|---|---:|---:|---:|
| **uplift × steadiness** | 68.8% | **69.6%** | $35,712 |
| EV^0.25 × p_hit² | 65.2% | 62.8% | $58,549 |
| EV × p_hit *(previous)* | 63.6% | 60.0% | $47,448 |

Per-horizon on the held-out half: **69.6 / 72.0 / 74.0 / 72.8** against
**60.4 / 60.0 / 62.0 / 63.2**. It scored **+0.8 points better out of sample
than in** — no shrinkage, which is the signature of structure rather than a fit.

**The cost, stated plainly:** ranking nearer the signal and further from
expected value gives up about **25% of incremental margin** ($35,712 vs
$47,448). That is a commercial trade, not an engineering one, and both
exponents are declared registry Settings so it can be moved without code.

**Two hypotheses tested and discarded** — recorded because a rebuild that only
reports its successes is not evidence:

- **Seasonality would carry the long horizons.** It does not. Decile spread is
  ~11–12 points at *every* horizon against reversion's 49–61, and combining
  them made every horizon **worse** (90d: 70.0% → 58.4%).
- **A higher materiality floor would raise precision**, since big sellers are
  less noisy. The opposite: 66.2% → 57.8% → 51.2% → 39.5% as the floor rose
  from 8 to 80 units. Big steady sellers have little room to beat their own
  rate.

---

## 2. Against the ordering it replaced

Same pipeline, same forecasts, same data. Only **what expected value
multiplies** changes.

| ordering | cards | hit rate | incremental **per card** | incremental total | margin flow touched | median pick |
|---|---:|---:|---:|---:|---:|---:|
| **sheet 20 — margin × deficit, gated** | 1,056 | **75.9%** | **+$48** | +$51,052 | $191,790 | 14u |
| old — margin × total demand, ungated | 2,080 | 31.0% | **−$952** | −$1,979,414 | $2,070,856 | 36u |

### Read the per-card column, not the total

The two arms **do not place the same number of bets** — 1,056 against 2,080 —
because sheet 20 shows only what clears its bar. Comparing raw totals across
different card counts compares a rate to a volume and calls the difference a
result. Per card it is **+$48 against −$952**.

### The coverage trade-off, stated before anyone asks

Sheet 20 touches **$191,790** of margin flow where the old ordering touched
**$2,070,856** — about **9%**. It is a smaller, sharper intervention: fewer
cards (4.7 a run, not 10), smaller products (15 units, not 36), far higher
accuracy (74.1%, not 24.2%).

If the goal is to influence as much of the shop as possible, that is a real
trade-off, and `reversion.min_hit_probability` is the dial: lowering it from
0.50 to 0.40 restores a **full ten-card slate** at a cost of about **four
points** of hit rate (72.5% → 69.2%) and roughly **doubles** the margin flow
touched. That is a commercial decision, not an engineering one.

### What the highest-earning picks actually look like

The twelve biggest earners sit at **p_hit 0.50–0.60** — near the floor, not the
top of the 0.50–0.85 range — and most sell **under 20 units a month**.

**Money and confidence are not the same axis, and the engine currently ranks on
confidence.** That is a deliberate choice measured in §1b (ranking nearer the
signal costs ~25% of incremental margin and buys ~9 points of accuracy), but it
means the engine is *not* currently pointed at the biggest opportunities. A
future version could rank a *second* slate on expected value and present both.

### The mechanism, confirmed rather than asserted

At the moment of picking, `uplift` = long-run rate ÷ recent rate:

| | median uplift at pick | expected | actually sold | median lift |
|---|---:|---:|---:|---:|
| old ordering | **0.64** — recent rate is 1.56× the long run (*inflated*) | 99.8u | **39.0u** | 0.65× |
| sheet 20 | **1.40** — recent rate is depressed (*primed to revert*) | 40.2u | **48.5u** | 1.27× |

The old engine was selecting spikes and watching them fall back. This is the
defect, visible in the picks themselves rather than inferred from the score.

### Be precise about the −$406k — it is not evenly spread

| horizon | old hit | old incremental | new hit | new incremental |
|---|---:|---:|---:|---:|
| **30d** | 26.7% | **−$30,986** | **75.0%** | **+$1,914** |
| 60d | 20.0% | −$77,203 | 70.0% | +$2,983 |
| 90d | 18.3% | −$124,822 | 68.3% | +$3,000 |
| 120d | 16.7% | **−$173,091** | 61.7% | +$3,958 |

**Most of the old engine's loss is at long horizons**, where projecting an
inflated 28-day rate across four months compounds the error. If you quote one
figure, quote the **30-day** row — that is the card that would actually ship:
**26.7% → 75.0%**, and **−$30,986 → +$1,914**.

And be straight about the shape of the win: the new engine's own incremental
margin is **modest and positive**. The large number is what it **stops**. Most
of the value here is not doing what the old engine was doing.

### By horizon

| horizon | n | hit | 95% CI | hard null | edge | median lift |
|---|---:|---:|---|---:|---:|---:|
| 30d | 60 | **75.0%** | 63–84% | 52.4% | **+22.6** | 1.38× |
| 60d | 60 | 70.0% | 57–80% | 52.0% | +18.0 | 1.27× |
| 90d | 60 | 68.3% | 56–79% | 50.7% | +17.6 | 1.25× |
| 120d | 60 | 61.7% | 49–73% | 51.2% | +10.5 | 1.13× |

**The edge decays with horizon** — +22.6 at 30 days, +10.5 at 120. That is
expected and it is honest: mean reversion is a short-horizon effect. A quiet
four weeks says a lot about the next month and much less about the next four.
**Sell the 30-day card.**

---

## 3. What the engine screened out (and why it never comes back empty)

Sheet 20's gates are **commercial, not statistical**. Counts from the real
predicate:

| reason | candidates |
|---|---:|
| below materiality floor (< 8 units / 28 days) | 62,464 |
| trailing window inflated (deficit ≤ 0 — heading down) | 3,580 |
| p_hit below floor (< 0.50) | 120 |

**This is shortlisting, not refusing to recommend.** The engine looks at all
4,914 products and returns the best **10**. In this backtest it produced a
**full slate of 10 cards on all 24 runs — it has never once come back empty.**

The counts above are how many SKUs were screened OUT on the way to those 10,
which is what ranking is. A store owner is never shown fewer recommendations
because of a gate; they are shown better ones. The gates only decide which
products are *eligible to compete* for the ten slots:

- **below materiality** — sold fewer than 8 units in 28 days. Most of a liquor
  store's 4,914 SKUs are long-tail bottles that move once a quarter. A card
  saying "reorder this, it sold twice" wastes a slot.
- **trailing window inflated** — the evidence says this product is heading
  DOWN. Telling an owner to order more of it is the defect this rebuild exists
  to remove.

---

## 4. Architecture

```
                         ┌──────────────────────────────────────┐
   POS / warehouse  ───► │  syncgo   (PostgreSQL, SELECT-only)  │
                         └───────────────┬──────────────────────┘
                                         │  Node is the ONLY writer
                         ┌───────────────▼──────────────────────┐
                         │  bottleai_analytics  (PostgreSQL)    │
                         │  feature_daily · feature_store_day   │
                         │  recommendations · outcomes · gate   │
                         └───────────────┬──────────────────────┘
                                         │  exported as a payload
                                         ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │  app/pipeline/   — STATELESS. No DB handle. No credentials.          │
   │                                                                      │
   │   01 ingest ─► 02 contracts ─► 03 feature store                      │
   │                                    │  open days, never calendar      │
   │                                    ▼                                 │
   │   04 evidence (n) ──► 05 cohort prior (θ_cohort)                     │
   │                                    │                                 │
   │                    ╔═══════════════▼════════════════╗                │
   │                    ║ 20 TEMPORAL REVERSION          ║  ◄── the fix   │
   │                    ║ shrink recent → own long run   ║                │
   │                    ║ rate_hat, deficit_units, p_hit ║                │
   │                    ╚═══════════════┬════════════════╝                │
   │                                    ▼                                 │
   │   06 shrinkage (own ↔ cohort) ─► 07 forecast p10/p50/p90             │
   │                                    │                                 │
   │   08 calibration ◄─────────────────┤                                 │
   │   09 elasticity ───────────────────┤                                 │
   │                                    ▼                                 │
   │   10 inventory policy ─► 11 constraints ─► 12 typed candidates       │
   │                                    │                                 │
   │   13 RANK  score = EV^a × confidence^b × urgency^c                   │
   │           EV = margin × DEFICIT   (not total demand)                 │
   │                                    ▼                                 │
   │   14 decision validation (5 gates, PAGE on a pipeline bug)           │
   │                                    ▼                                 │
   │   15 explanation (LLM writes prose only) ─► 16 numeral validation    │
   └──────────────────────────────────┬───────────────────────────────────┘
                                      ▼
   17 the gate (shadow│live│suspended, per store × family, permutation test)
                                      ▼
                        React SPA — only what passed
                                      │
   19 outcome feedback ◄──────────────┘   lift.js ≡ lift.py, pinned
```

**Two properties worth stating to a CEO:**

1. **No model chooses anything.** The LLM writes the sentence *after* the
   decision is fixed. A model outage costs fluency, never a recommendation —
   and every card is reproducible months later from its recorded inputs.
2. **Python holds no analytics credentials.** It opens no database connection.
   Node is the sole writer; `syncgo` is SELECT-only by design. The whole
   pipeline is a pure function of one payload.

---

## 5. Stack

| layer | technology |
|---|---|
| **Recommendation engine** | Python 3.11+, **pure stdlib inside `app/pipeline`** — no numpy, scipy or sklearn. PAVA isotonic regression, Holt-Winters, OLS by Gauss-Jordan, inverse normal by bisection on `math.erf`, all hand-written |
| **Python service** | FastAPI 0.141 · uvicorn · pydantic 2.13 · httpx · structlog · tenacity |
| **Warehouse access** | psycopg 3.3 (`storeagent` module only, **read-only**) |
| **Backend** | Node.js / Express · `pg` · node-cron · winston · jsonwebtoken · bcryptjs |
| **Frontend** | React 18 · react-router · recharts · lucide-react |
| **Databases** | PostgreSQL ×3 — `syncgo` (POS warehouse, SELECT-only), `bottleai_analytics` (Node-only writes), `storeagent` |
| **LLM** | `claude-opus-5` via `anthropic` 1.3.0 — **prose only**, tool-schema constrained, never in the selection path |
| **Quality gates** | `check_no_literals.py` (no magic numbers), `check_no_state_branches.py` (nothing branches on evidence state), ruff, mypy |

### Why pure stdlib in the pipeline

A numeric stack in the hot path is a deployment dependency, a version-skew
risk, and a place for a silent `NaN`. Every estimator here is a few dozen
readable lines with a test that pins its arithmetic. It is also what makes the
Node twin (`backend/lib/lift.js`) checkable digit-for-digit against the Python
(`app/pipeline/outcomes/lift.py`) — a shared fixture runs through both and
compares exactly, because **two implementations of one metric is how a
dead-stock count came out 454 on one screen and 485 on another.**

---

## 6. Engineering quality

| | |
|---|---|
| Python tests | **1,206 passing** |
| Node suites | 29 |
| Registry settings | **95 declared**, every one with an owner, a unit and a stated reason |
| — still PROVISIONAL | 89 |
| — **MEASURED** | 6 |
| Magic numbers in the pipeline | **0 new** (49 grandfathered in `storeagent`, a shrinking debt list printed on every CI run) |
| Reproducibility | byte-identical ordering across runs; no clock read, no sampler, no model in the selection path |

**Every threshold is a declared `Setting` with an owner and a reason**, so
`cfg.report()` answers *"how much of this engine is still guesswork"* on any
run. That number is printed by CI so it cannot quietly grow.

---

## 7. Efficiency

| | |
|---|---|
| Cost per recommendation run | **$0** in the selection path — no API call decides anything |
| LLM cost | prose only, and the degraded template path carries identical numbers |
| Determinism | same snapshot → same cards, months apart |
| Backtest cost | the old model-driven evaluation cost 24 API calls per configuration; this one costs nothing, so **every** decision date can be evaluated rather than the six that were affordable |

---

## 8. What this does NOT prove — say these before you are asked

1. **Forecasting, not causation.** Nobody acted on these recommendations. It
   shows the engine points at products about to move. It does **not** show that
   following the advice causes extra sales. Only a live holdout proves that —
   production has the mechanism (`REC_HOLDOUT_PCT`, FNV-1a on
   `client:location:sku:family`); **it needs switching on.**
2. **One store.** Every figure is Bethany's. Another tenant could differ
   materially.
3. **240 predictions.** Enough for a large effect, not a small one — hence the
   date-clustered interval of 57.1–78.8%, which is wide and honestly so.
4. **No live inventory.** The replay had no historical on-hand, so understock
   and overstock families are absent. The engine is judged on **less** than it
   normally has.
5. **90% is not reachable on this metric.** For a SKU selling ~10 units a
   month, Poisson noise alone puts it below its own mean about a third of the
   time regardless of what is known in advance. Tested at every confidence
   floor and coverage down to one card per date: the best is 71.1%, 95% CI
   57.8–84.4. **No configuration has 90% inside its interval.**
6. **The live path is not migrated.** `validator.py` / `pipeline.py` still use
   the old 14-slice generator. Sheets 12–16 and 20 are wired to each other but
   **not yet to the request that serves a store.** This is the gap between the
   measurement above and a store owner seeing it.

---

## 9. The one-paragraph version

> Botella's recommendation engine was rebuilt from a model-chooses design to a
> deterministic pipeline where no model selects anything. Backtested on the
> production modules over 3.7 years of one store's real transactions, it picks
> products that beat their own trailing sales rate **68.8%** of the time
> against a **31.9%** random baseline — and **+17.2 points** against a
> deliberately hard baseline that already accounts for regression to the mean.
> The ordering it replaced scored **20.4%** and was **destroying** measurable
> margin — at the 30-day horizon, **26.7% → 75.0%** and **−$30,986 → +$1,914**,
> with most of the old engine's losses at longer horizons where its error
> compounded. Every card is reproducible, every threshold is declared with an owner
> and a reason, and the engine refuses ~96% of what it looks at. The remaining
> work is a live holdout to prove causation, and migrating the request path.
