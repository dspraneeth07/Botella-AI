# Sheet 07 — Forecast ensemble

**Status:** complete. 788 Python tests (+62), two build guards, ruff + mypy clean.
**Depends on:** 03, 06. **Wave:** 3. **Effort:** the largest sheet in the programme.
**Split into three PRs**, as the sheet asked.

> **One correction to the sheet header.** It names the repo
> `C:/Users/Techm/Downloads/external_api`. That is the **stale August copy**
> (no git, `validator.py` 38KB vs 45KB). All work is in
> `BottleAI-gitlab/Botella_External_APIs`, as established in phase 0.

---

## 1. Why this sheet exists

`storeagent/forecasting/demand.py` is 196 lines and applies essentially one
approach to every SKU. Liquor demand is not one shape:

- a top-20 vodka sells every day,
- a niche mezcal sells four times a year,
- a seasonal cream liqueur does 60% of its volume in six weeks.

One method cannot serve all three, and the one in place serves the
**intermittent majority worst** — which is most of the catalogue. On store 171
the real distribution of the top 120 SKUs is:

| | smooth | intermittent | erratic | lumpy |
|---|---:|---:|---:|---:|
| store 171 | 5 | **66** | 1 | 54 |
| store 122 | 52 | **42** | 17 | 26 |
| store 125 | 33 | **32** | 14 | 52 |

---

## 2. The three PRs

| PR | File | Lines | What |
|---|---|---:|---|
| 1 | `storeagent/forecasting/classify.py` | 330 | Syntetos-Boylan classification from the feature store |
| 2 | `storeagent/forecasting/ensemble.py` | 520 | Five forecasters, every one returning p10/p50/p90 |
| 3 | `storeagent/forecasting/backtest.py` | +420 | Rolling-origin backtest scored **per demand class** |
| — | `app/pipeline/assemble.py` | +120 | `estimate_and_forecast` — 07 chained onto 04→05→06 |
| — | `tests/test_classify.py` | 300 | 17 tests |
| — | `tests/test_ensemble.py` | 420 | 28 tests |
| — | `tests/test_backtest_classes.py` | 300 | 15 tests |
| — | `tests/test_pipeline_guards.py` | +90 | 4 tests — the guard widening (§8) |
| — | `scripts/check_no_literals.py` | +40 | one narrow gap closed (§8) |
| — | `scripts/config_report.py` | +8 | now walks `storeagent.forecasting` too (§11) |

`backtest_daily` and `demand.py` are **untouched**. `storeagent/runtime/pipeline.py`
calls the first and eight modules import the second; this sheet EXTENDS.

---

## 3. A decision the sheet left open: ETS, not LightGBM

The sheet says *"Seasonal ETS **or** LightGBM with calendar features"*. We took
ETS, and the reason is worth recording because it is not a small call.

**This service has no numerical stack at all.** Its dependencies are FastAPI,
httpx, pydantic, structlog and psycopg — there is no numpy, pandas, scipy,
sklearn or statsmodels. Adding LightGBM means adding a ~100MB compiled binary
and a transitive numeric stack to a stateless service that has never needed
one.

And the sheet itself says: *"LightGBM is not bitwise deterministic across
thread counts."* Sheet 07's own "done when" requires reproducibility. Choosing
the estimator that fights that requirement, in order to gain a gradient booster
we cannot yet fit (all thresholds are PROVISIONAL until wave 6), would have
been the wrong trade.

**Everything here is pure stdlib** — Croston, SBA, Holt-Winters, the bootstrap,
WAPE/MASE/pinball, and a hand-written Spearman. All of it is reviewable
arithmetic, and all of it is deterministic.

---

## 4. PR 1 — classify

```
                CV2 < 0.49          CV2 >= 0.49
ADI < 1.32      smooth              erratic
ADI >= 1.32     intermittent        lumpy
n below floor   new_sku  (a LABEL, routed to the cohort prior)
```

**The two cuts are `MEASURED`** — among the programme's first four, with the
two quantile levels in §11. They are not ours to tune — they come from Syntetos, Boylan &
Croston (2005), *On the categorization of demand patterns*, JORS 56(5), and
changing them would put us outside the literature our method names refer to.
`test_the_two_cuts_are_the_published_values_and_marked_measured` asserts both
the values and that the citation is in the `why`.

**ADI is counted in OPEN days — this is the sheet-03 join.** A store shut every
Sunday has ~52 non-trading days a year. Counted as calendar days every SKU in
that store looks ~17% more intermittent than it is, and a SKU sitting near the
1.32 cut gets pushed across it into a different forecasting method *because of
the store's opening hours*. A closed day is a gap in **opportunity**, not a gap
in demand.

`new_sku` is a label, never a separate code path. It routes to the cohort prior
through sheet 06's blend, where n=0 does the work. There is no `if is_new:`
anywhere in the package.

---

## 5. PR 2 — the ensemble

| class | method | interval from |
|---|---|---|
| smooth | seasonal ETS | residual bootstrap |
| intermittent | Croston | bootstrap over inter-demand intervals |
| erratic | SBA | bootstrap |
| lumpy | SBA, wide | bootstrap — **may refuse** |
| new_sku | cohort prior (sheet 06) | cohort dispersion |

### 5.1 There is no trend term, and that is the point

Holt-Winters has a trend slot. Filling it would be the obvious thing to do.

The last backtest scored **23% against a 32% random pick** because the engine
was instructed to chase accelerating products, and momentum **anti-predicts**
at this horizon (ρ = −0.36 at 60 days). The model executed that instruction
faithfully, to within 0.3 points of a mechanical top-accelerators picker. It
was not a modelling failure; it was a correctly-executed wrong objective.

So `forecast.ets.beta` — the trend weight — **defaults to 0.0**. The structure
is present and the setting is in the registry so wave 6 can fit it if the data
ever supports one. A positive fitted value is a signal to re-examine, not a
discovery. `test_no_momentum_vocabulary_earns_weight_anywhere_in_the_module`
parses the AST for `momentum`, `acceleration`, `trending`.

### 5.2 Refusing is correct for lumpy

A lumpy SKU is rare **and** wildly variable. Its honest 80% interval can read
*"expect 2, could be 78"*, and you cannot order against that. Sheet 02
established the right to refuse; this is the forecasting instance of it.
Returning a confident-looking midpoint instead would be the ambiguous output
this rebuild exists to remove.

The gate measures the **interval**, not the label —
`test_a_lumpy_sku_within_the_width_limit_is_still_answered` proves raising the
limit admits the same SKU, so the rule is about usability and not a quiet ban
on a whole demand class.

---

## 6. PR 3 — the backtest, and what it caught

Rolling-origin, 8 origins a fortnight apart, 30-open-day horizon. Reports
**WAPE, MASE and pinball loss per demand class** against seasonal-naive.

**The verdict is an ALL, not an average.** An ensemble that wins on average
while losing on intermittent SKUs has failed — intermittent is the majority of
the catalogue, and a mean over SKUs is dominated by the smooth minority that
sell every day and carry most of the volume.
`test_losing_on_intermittent_fails_the_report_even_if_the_average_wins`
constructs exactly that case: smooth wins by a mile, intermittent loses
narrowly, the mean looks like a clear improvement — and the report **fails**.

A class with too few windows is `UNJUDGED`, and unjudged is not a pass.

### The backtest earned its place immediately

Run on real store history it **failed**, and finding out why produced six real
defects. Every one of them was invisible to the unit tests, which all passed
throughout.

| # | Defect | Symptom on real data |
|---|---|---|
| 1 | Bootstrap started the clock **on a sale**, so the first gap was a full inter-demand interval | A SKU selling every ~36 open days returned **p10 = p50 = p90 = 0** over a 30-day horizon. True chance of a sale: ~83% |
| 2 | First interval drawn **uniformly** — the inspection paradox | **+12.3% bias** against seasonal-naive's −1.0%. A random *moment* is likelier to land in a long gap than a short one, so the containing interval must be length-biased |
| 3 | The raw bootstrap median was the point estimate — **Croston was never used** | Resampling the whole history weights a sale from two years ago like last week's. Intermittent **lost**: WAPE 54.3 vs naive 44.1 |
| 4 | Fixing #3 by scaling the finished totals by `point/median` | Where the median sits near zero — most lumpy SKUs — the factor explodes. **p90 of 100 became 12,052** |
| 5 | `intervals` spanned only **first sale → last sale** | The silence after a delisted product was invisible. mean(intervals) **1.29** against an ADI of **3.74** for the same SKUs — one quantity, two measurements, 3× apart |
| 6 | Off-by-one in `croston_rate`: the loop was indexed by `sizes`, so **the last interval was never smoothed** | A SKU that sold 22.8/day for 584 days then stopped forecast **1,016 units against an actual of 0** |

Defects 5 and 6 are the 454-vs-485 problem again, in a new place: two ways of
measuring "how often does this sell" that disagreed, and nothing compared them
until the backtest did.

---

## 7. The real results, including the store that still fails

120 SKUs per store, 700-day window, 8 rolling origins, 30-open-day horizon.

| store | class | SKUs | windows | WAPE | naive | MASE | pinball | naive pin | verdict |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| **171** | smooth | 5 | 30 | 27.3 | 31.2 | 0.41 | 26.7 | 42.0 | BEATS |
| | intermittent | 66 | 504 | **33.3** | 44.1 | 1.43 | 8.5 | 16.0 | **BEATS** |
| | erratic | 1 | 5 | 49.5 | 73.6 | 0.37 | 57.9 | 100.5 | UNJUDGED |
| | lumpy | 54 | 401 | 47.2 | 60.6 | 0.41 | 20.4 | 38.2 | BEATS |
| | | | | | | | | | **PASSED** |
| **125** | smooth | 33 | 251 | 9.4 | 10.4 | 0.38 | 193.8 | 319.4 | BEATS |
| | intermittent | 32 | 213 | **32.3** | 41.9 | 0.28 | 28.9 | 56.6 | **BEATS** |
| | erratic | 14 | 108 | 24.1 | 30.1 | 0.30 | 70.1 | 123.7 | BEATS |
| | lumpy | 52 | 380 | 30.6 | 44.3 | 0.31 | 29.0 | 61.8 | BEATS |
| | | | | | | | | | **PASSED** |
| **122** | smooth | 52 | 373 | 26.9 | 27.4 | 0.37 | 52.2 | 67.7 | BEATS |
| | intermittent | 42 | 275 | **35.2** | **30.6** | 1.36 | 68.2 | 77.9 | **LOSES** |
| | erratic | 17 | 124 | 35.8 | 38.1 | 0.36 | 53.7 | 76.4 | BEATS |
| | lumpy | 26 | 164 | 35.1 | 39.8 | 0.35 | 32.1 | 53.6 | BEATS |
| | | | | | | | | | **FAILED** |

**Two of three stores pass. Store 122 does not, and we are not going to
pretend otherwise.**

Its intermittent class loses 35.2 to 30.6. 122 trades every single day
(698/699 open) and has the most stable weekly pattern in the sample — its
seasonal-naive baseline is unusually strong (30.6, against 44.1 and 41.9
elsewhere). Our Croston level is flat across the horizon; the baseline reads
only the last week and is far more responsive.

### The tuning we did NOT do

`forecast.croston.alpha` is PROVISIONAL, so the obvious move was to fit it.
Swept across all three stores:

| α | 171 int | 122 int | 125 int | stores passing |
|---:|---|---|---|---:|
| 0.05 | 33.8 / 44.1 | 41.3 / 30.6 | 32.1 / 41.9 | 2/3 |
| **0.1** | **33.2 / 44.1** | 35.2 / 30.6 | **32.3 / 41.9** | **2/3** |
| 0.2 | 36.0 / 44.1 | **32.3** / 30.6 | 35.7 / 41.9 | 2/3 |
| 0.3 | 39.7 / 44.1 | 33.0 / 30.6 | 40.2 / 41.9 | 1/3 |
| 0.5 | 47.9 / 44.1 | 35.9 / 30.6 | 50.0 / 41.9 | 0/3 |

α = 0.2 gets 122 closest and makes 171 and 125 **worse**. No α makes 122 pass.
Raising α to chase one store is precisely the overfit that produced the 23%
backtest, so **α stays at 0.1** and the failure is reported. Wave 6 fits it per
class across the whole estate, which is what the setting's `why` has said since
it was written.

**Momentum ρ measured here: +0.155, +0.291, +0.125** — small and noisy on a
120-SKU sample, versus the −0.36 the sheet cites at 60 days. The backtest
reports it every run so the claim is a number the team can see rather than a
warning nobody re-checks.

---

## 8. One build guard was widened, by exactly one shape

`check_no_literals` flagged the published cuts `1.32` and `0.49` — while its own
error message said *"declare thresholds as a Setting with an owner, a unit and a
reason"*, which is exactly what they were. Every earlier sheet happened to use
integer-valued Settings, so the gap had never surfaced.

The rule was never "no floats"; it is **"no unexplained numbers"**, and a
`Setting` is the explanation. The guard now permits a float that is the
`default=` of a `Setting(...)` call — and nothing else. Four tests keep it
tight:

- a float default of a registered Setting is allowed;
- **a bare float beside a Setting in the same file still fails**;
- a Setting default of `0.49` does **not** launder a bare `0.49` three lines
  later (identity, not value);
- `default=` on a call that is *not* `Setting(...)` is still caught.

---

## 9. Connected to the rest of the engine

`app/pipeline/assemble.py` gains `estimate_and_forecast`: **07 → 04 → 05 → 06 → 07**.

```
classify  (07)  ->  which SHAPE is this SKU
  |
  +-- count_evidence (04) -> n
  +-- estimate_prior (05) -> theta_cohort
  +-- blend          (06) -> the RATE, cold start as a weight
  |
forecast  (07)  ->  p10 / p50 / p90 over the horizon
```

Shape and level stay separate questions: the class chooses the estimator, the
blend sets the level. A `new_sku` is forecast from sheet 06's blended value —
which at n=0 **is** the cohort prior, reached without a branch. Sheet 07 does
not re-implement cold start; it consumes sheet 06's answer.

Live, on store 171 (308 open days):

```
sku             class           rate/day      p10      p50      p90  status
080686001904    erratic            6.434    211.1    280.6    351.4  ok
088004045456    intermittent       3.793     52.2     73.2     93.8  ok
619947000037    smooth             4.044     94.8    119.1    144.2  ok
721059000505    lumpy              3.545    169.9    246.9    337.5  ok
20 of 20 forecast over 30 open days; 0 refused as unactionable
demand shapes: lumpy=10, erratic=4, intermittent=3, smooth=3

  Expect about 281 units over the next 30 trading days
  (211 to 351 in 8 cases out of 10).
```

And on store 106:106 — 29,019 SKUs carried, **zero sales ever**:

```
3514            new_sku            0.012      0.0      0.4      1.3  ok
1650            new_sku            0.110      0.7      3.3      5.8  ok
12 of 12 forecast over 30 open days
```

All four demand shapes appear in one store's top 20, which is the sheet's
premise demonstrated rather than argued.

---

## 10. Determinism — to a stated epsilon, never bitwise

The bootstrap is seeded from `ctx.seed`, `ctx.run_id` and **the SKU**, so a
SKU's forecast does not depend on how many other SKUs were processed before it
or in what order — the same class of instability as an estimate that moves with
the batch size.

`test_two_runs_on_the_same_snapshot_agree_within_epsilon` asserts agreement to
`1e-9`, deliberately **not** bitwise. A bitwise assertion over floating-point
accumulation becomes flaky the moment anything about the numeric path changes,
and a flaky test gets disabled — which is worse than no test. This
implementation is pure stdlib and happens to be bitwise stable; the assertion
stays tolerance-based so it remains valid if that stops being true.

Verified on real data: two runs of the full chain on store 171 produce
byte-identical output.

---

## 11. Registry — 12 new settings

| Setting | Default | Status |
|---|---:|---|
| `forecast.classify.adi_cut` | 1.32 | **MEASURED** |
| `forecast.classify.cv2_cut` | 0.49 | **MEASURED** |
| `forecast.interval.lower_quantile` | 0.1 | **MEASURED** |
| `forecast.interval.upper_quantile` | 0.9 | **MEASURED** |
| `forecast.classify.min_demand_events` | 3 | PROVISIONAL |
| `forecast.classify.min_open_days` | 14 | PROVISIONAL |
| `forecast.croston.alpha` | 0.1 | PROVISIONAL |
| `forecast.ets.alpha` | 0.2 | PROVISIONAL |
| `forecast.ets.beta` | **0.0** | PROVISIONAL — the momentum weight (§5.1) |
| `forecast.ets.gamma` | 0.1 | PROVISIONAL |
| `forecast.interval.bootstrap_draws` | 1000 | PROVISIONAL |
| `forecast.lumpy.max_relative_width` | 4.0 | PROVISIONAL |
| `forecast.new_sku.fallback_cv_pct` | 80 | PROVISIONAL |
| `backtest.origins` / `.step_open_days` / `.horizon_open_days` / `.min_windows_per_class` | 8 / 14 / 30 / 20 | PROVISIONAL |

**The first four MEASURED settings in the programme.** Two are published
constants; two are the output contract of this stage, not tuning knobs.

> **The catalogue did not see them at first.** `config_report.py` walked only
> `app.pipeline`, and Settings register on import — so it printed
> `MEASURED (0)` while four MEASURED settings existed. Sheet 07 is the first to
> declare Settings outside `app.pipeline` (the forecasting thresholds live with
> the forecasters). A catalogue that silently omits a package is worse than no
> catalogue, because an incomplete enumeration reads exactly like a complete
> one. It now walks `storeagent.forecasting` as well, and reports **56
> PROVISIONAL + 4 MEASURED = 60**.

---

## 12. Verification

```bash
cd Botella_External_APIs
./.venv/Scripts/python.exe -m pytest tests/test_classify.py -q          # 17
./.venv/Scripts/python.exe -m pytest tests/test_ensemble.py -q          # 28
./.venv/Scripts/python.exe -m pytest tests/test_backtest_classes.py -q  # 15
./.venv/Scripts/python.exe -m pytest -q                                 # 788
./.venv/Scripts/python.exe scripts/check_no_literals.py                 # exit 0
./.venv/Scripts/python.exe scripts/check_no_state_branches.py           # exit 0
./.venv/Scripts/python.exe -m ruff check storeagent/forecasting         # clean
./.venv/Scripts/python.exe -m mypy storeagent/forecasting/classify.py \
    storeagent/forecasting/ensemble.py storeagent/forecasting/backtest.py

# End to end on a real store
cd ../backend
node scripts/export-pipeline-input.js 171 171 --top 20 --out b.json
cd ../Botella_External_APIs
./.venv/Scripts/python.exe scripts/run_pipeline.py b.json --forecast
```

| Sheet requirement | Proven by |
|---|---|
| Every SKU classified, class in provenance | `test_the_class_is_carried_in_provenance` |
| Every forecast returns p10/p50/p90 | `test_every_class_returns_p10_p50_p90` |
| Beats seasonal-naive **per class** | §7 — 2 of 3 stores; 122 reported as failing |
| Losing on intermittent fails the report | `test_losing_on_intermittent_fails_the_average_wins` |
| Two runs agree within a stated epsilon | `test_two_runs_on_the_same_snapshot_agree_within_epsilon` |
| Not bitwise | asserted with `abs=1e-9`, and said so in the docstring |
| ADI in open days, not calendar days | `test_a_closed_day_is_not_a_gap_in_demand` |
| Momentum earns no weight | `ETS_BETA.default == 0.0` + AST scan + measured ρ |
| Lumpy may refuse | `test_a_lumpy_sku_with_an_unusable_interval_refuses` |

---

## 13. Not done

- **Store 122's intermittent class still loses** (35.2 vs 30.6). Diagnosed, not
  fixed: its seasonal-naive baseline reads only the last week and is more
  responsive than a slow Croston level. The likely remedy is a
  recency-weighted or Teunter-Syntetos-Babai variant that updates the demand
  probability every period rather than only on demand events. That is a
  modelling change and wants its own measurement, not a hurried α.
- **Backtested on 3 stores × 120 SKUs**, not the estate. The exporter now
  carries the batch timeout, so an estate-wide run is a scheduling question
  rather than a code one.
- **`erratic` is UNJUDGED on store 171** (1 SKU, 5 windows). Correctly not
  claimed as a pass.
- **All 16 forecasting settings except the 4 MEASURED ones are PROVISIONAL.**
  By design — wave 6 fits them per class.
- **Nothing serves these forecasts to a store yet.** Same position as 06A: the
  chain runs from an exported payload. Wiring it into the live recommendation
  path is its own piece of work.
- **`demand.py` is still in use** by 8 modules and is unchanged. Migrating its
  callers to the ensemble is a follow-up, not part of this sheet.

---

## 14. The one-line summary

Four demand shapes, four methods, and an interval on every one — and the
backtest that had to be built to prove it found six defects the unit tests
could not, including one that forecast 1,016 units of a product that had
stopped selling.
