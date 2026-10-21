# Sheet 09 — Elasticity engine

**Status:** complete. **864 Python tests (+41), two build guards, ruff + mypy clean.**
**Depends on:** 03, 05. **Wave:** 3. **Marked optional — and it earned its place.**

> **One correction to the sheet header.** It names `C:/Users/Techm/Downloads/external_api`,
> the stale August copy. All work is in `BottleAI-gitlab/Botella_External_APIs`.

---

## 1. Why this sheet exists

Every markdown recommendation makes an implicit elasticity claim — *"drop the
price and volume will more than compensate"*. The current engine makes that
claim with **no estimate behind it at all**.

This sheet either supplies a real one or refuses to let the claim be made. **The
refusal is the more valuable half**, and on real data it is most of the output.

---

## 2. The headline result, on real stores

335 (store, category) cells across stores 122, 125 and 171 — every category
with at least 60 priced selling days since 2025-01-01:

| outcome | cells | share |
|---|---:|---:|
| **may cite a profitable price cut** | **5** | **1.5%** |
| interval spans zero | 173 | 51.6% |
| **inelastic — a cut LOSES revenue** | **79** | **23.6%** |
| positive β — blocked | 30 | 9.0% |
| price never moved enough to fit | 48 | 14.3% |
| **BLOCKED overall** | **330** | **98.5%** |

**Five of 335 cells support a profitable markdown.** That is not a failure of
the estimator — it is the sheet working, and §6.4 explains why the binding
constraint turned out not to be the one the sheet anticipated.

The five survivors are exactly the price-shopped commodity categories where a
discount genuinely moves volume:

```
store 122  ENERGY DRINK      beta -5.87 [-9.57,-2.17]   10% cut -> 59% volume
store 171  Prosecco          beta -4.86 [-6.64,-3.08]   10% cut -> 49% volume
store 125  Tobacco           beta -4.48 [-6.86,-2.09]   10% cut -> 45% volume
store 122  Tobacco Products  beta -2.43 [-2.71,-2.15]   10% cut -> 24% volume
store 122  CIGARETTE         beta -1.62 [-2.02,-1.22]   10% cut -> 16% volume
```

---

## 3. The files

| File | Lines | What |
|---|---:|---|
| `app/pipeline/elasticity/estimate.py` | 520 | Log-log OLS, HC1 robust SE, interval, shrinkage |
| `app/pipeline/elasticity/guard.py` | 290 | The refusal |
| `app/pipeline/elasticity/__init__.py` | 45 | Public surface |
| `app/recommender/validator.py` | +60 | Stage-14 enforcement |
| `app/pipeline/blend/shrink.py` | +14 | `shrink.k.elasticity` |
| `app/pipeline/patterns.py` | +5 | `elasticity` in the canonical vocabulary |
| `app/pipeline/priors/ladder.py` | +5 | Ladder starts at `category` |
| `app/pipeline/evidence/count.py` | +55 | `_count_elasticity` |
| `tests/test_elasticity.py` | 560 | 41 tests |

---

## 4. `elasticity` is a first-class pattern, not a bolt-on

The sheet says: *"Shrink toward a cohort beta using `app/pipeline/blend/shrink.py`
— do not write a second blending implementation."*

Doing that properly meant adding `elasticity` to the **shared vocabulary** in
all four places — canonical, priors, blend, evidence — because sheet 07's
bijection test asserts those four agree. That test is what forced the honest
version instead of a special case wired round the side.

**`n` for elasticity is DISTINCT PRICE LEVELS, not days.** Every other pattern
counts observations, because for every other pattern an observation is a unit
of evidence. Two hundred days at a single price tell you *nothing* about what
happens when the price moves. Counting days would report a confident `n` for a
store that has never once changed a price.

`shrink.k.elasticity` is **30 — the highest k in the programme**, on purpose. A
single store's own β is the least trustworthy quantity we estimate, so it needs
a great deal of its own evidence before it should outweigh a cohort.

---

## 5. The identification problem, stated in code and in reasons

Retail price variation is **not experimental**. Prices move for reasons that
also move volume:

- **promotions**, timed to demand the retailer already expects;
- **seasonality**, which moves price and volume together;
- **competitor moves**, which we cannot observe at all;
- **cost pass-through**, which moves price without moving demand.

The day-of-week and month controls absorb the crudest of that. They absorb
**none** of the competitor effect and only some of the promotional one — because
a promotion is precisely a price cut chosen for a week when volume was going to
be high anyway. **That bias runs toward finding elasticity where there is none.**

Which is why the standard errors are **HC1 heteroskedasticity-robust**, not the
textbook homoskedastic ones. Daily retail sales are emphatically not
constant-variance, and classical standard errors would come out too *narrow* —
making intervals span zero **less** often. That is the one direction this sheet
must not be wrong in.

---

## 6. Four defects found by running it on real data

### 6.1 A positive β passed a spans-zero test

The guard originally tested only `spans_zero`. Real data returned these:

```
store 122  Tobacco  beta +0.38 [+0.15,+0.61]
store 125  CIGAR    beta +0.76 [+0.51,+1.02]
store 171  BOURBON  beta +0.12 [+0.02,+0.22]
```

Those intervals **do not span zero**, so the naive test passed them — and they
are evidence **against** the markdown they would have been cited for. Almost
certainly confounding (retail prices rise in exactly the periods demand is
already high), but either way, not a reason to discount.

A price-cut claim now requires the interval to lie **entirely below zero**, and
a positive β gets its own distinct refusal reason rather than being lumped in
with "spans zero". 30 of 335 cells are blocked by this rule alone.

### 6.2 The dummy-variable trap with an absent reference

61 of 335 cells were refused as `design_is_singular:controls_collinear_with_price`.
They were not collinear with price.

The month dummies held out January as the reference. A category trading only May
to September contains **no January**, so every observed month got its own dummy —
and they sum to 1 on every row, which is exactly the intercept. Singular.

The design is now built from the **levels actually observed**, holding out the
first one present. All 61 spurious refusals disappeared, and **store 171 went
from 0 usable elasticities to 19**.

### 6.3 The stage-14 gate was a block-list, and absence let everything through

`blocked_categories({})` is empty, so a caller supplying **no elasticity
evidence at all** had every markdown pass — the exact state this sheet exists to
end, reached by passing nothing.

The gate is now an **allow-list**: a price claim passes only on an explicit
usable estimate. Absence of evidence blocks.

### 6.4 The binding constraint was profitability, not statistics

The guard tested whether the interval spanned zero. It did not test whether the
estimate was **large enough for a discount to pay**.

A markdown claims volume will "more than compensate", which is precisely
**|β| > 1** — at unit elasticity a price cut raises volume by exactly enough to
hold revenue flat, and below it a discount loses money.

**79 of the 84 cells that passed the zero-spanning test were still inelastic.**

```
store 171  Vodka    beta -0.107 [-0.21,-0.00]   10% cut -> 1.1% volume
store 122  Wine     beta -0.098 [-0.18,-0.02]   10% cut -> 1.0% volume
store 125  MISC     beta -0.097 [-0.18,-0.02]   10% cut -> 1.0% volume
```

Store 171's Vodka is a solid, honest estimate — the interval is nowhere near
zero. Acting on it surrenders ten points of price to buy one of volume.
**Statistically detectable and economically wrong are different things**, and
only the second decides whether a card should be shown.

`elasticity.min_abs_beta_to_discount` is `1` and **MEASURED**: it is the
revenue break-even, arithmetic rather than judgement. Margin break-even is
*stricter* and depends on the cost sheet 02 already requires for a markdown, so
this is the floor every discount must clear, not the whole test.

> A fifth, in the test fixture rather than the code: drawing price and noise
> from one RNG coupled them through the draw order, and a true β of 0.0 came
> back **+0.20 with an interval excluding zero**. A neat miniature of this
> sheet's whole identification problem — and a useless fixture. Separate
> streams now.

---

## 7. What the guard blocks, and what it must not

| family | claim | gated? |
|---|---|---|
| `markdown` | "cut the price, volume more than compensates" | **yes** |
| `liquidate` | the same claim, steeper discount | **yes** |
| `bundle` | a discount wearing a different hat | **yes** |
| `reorder`, `pre_stock`, `stock_new` | availability | no |
| `promote`, `endcap`, `cold_box` | attention / placement | no |

Blocking the second group on an elasticity they never cited would be a different
kind of dishonesty — and a store whose prices happen not to vary would lose
recommendations it was entitled to.

The guard runs **before** the ranking caps, so a blocked markdown does not
occupy a slot a supportable recommendation could have had. Cards are **withheld
with the reason attached**, never silently dropped — sheet 02's rule.

**The gate ships off by default** (`enforce_elasticity=False`). Turning a
store-wide markdown block on before any caller supplies elasticity evidence
would silently delete most of what the engine produces today. The seam is built
and tested; switching it on is a caller decision.

---

## 8. A judgement call, recorded rather than buried

A thin own estimate whose interval spans zero, shrunk toward a confident cohort,
can come back with an interval that **excludes** zero — and the guard will then
let a markdown cite it.

Is that legitimate? Under this architecture, yes: borrowing from a cohort is
what sheets 05 and 06 exist for, it is the same mechanism that serves a
brand-new store, and `own_weight` says out loud how much of the answer is the
store's own. `elasticity.min_own_weight_to_cite` exists so the choice is
**visible and tunable** rather than implicit — it is `0` today, and raising it
would mean refusing to borrow, which would contradict the cold-start design.

What must not happen is the borrowing being invisible.
`test_a_cohort_can_rescue_an_unidentified_own_estimate_and_says_so` pins exactly
that: the own interval still spans zero, `own_weight < 0.3`, and the record
still says so.

---

## 9. Pure stdlib, again

No numpy, scipy, sklearn or statsmodels in this service. OLS via normal
equations plus a Gauss-Jordan inverse is ~80 lines, exact, deterministic — the
same call sheet 07 made over LightGBM and sheet 08 over sklearn's isotonic.

Two numerical constants avoided rather than hardcoded:

- **the t critical value.** One conservative multiplier (2.042 = t at 30 df)
  replaces a 19-entry lookup table, made honest by refusing any fit with fewer
  than 30 residual degrees of freedom. t *decreases* as df rises, so it is at
  least as wide as exact for every fit the stage accepts. Erring wide is the
  only safe direction: a narrower interval spans zero less often.
- **the singularity pivot tolerance**, derived from `sys.float_info.epsilon`
  rather than written as `1e-12`. It is a property of floating-point arithmetic
  on this platform, not a judgement about retail data, so it does not belong in
  the registry — and a hardcoded constant would be silently wrong on a platform
  with different precision.

---

## 10. Verification

```bash
cd Botella_External_APIs
./.venv/Scripts/python.exe -m pytest tests/test_elasticity.py -q   # 33
./.venv/Scripts/python.exe -m pytest -q                            # 856
./.venv/Scripts/python.exe scripts/check_no_literals.py            # exit 0
./.venv/Scripts/python.exe scripts/check_no_state_branches.py      # exit 0
./.venv/Scripts/python.exe -m mypy app/pipeline/elasticity/        # clean
```

| Sheet requirement | Proven by |
|---|---|
| Synthetic series recovers its known elasticity within the interval | `test_a_synthetic_series_recovers_its_known_elasticity` (−2.0, −1.5, −1.0, −0.5) |
| Flat-price series returns ok=False, not a spurious β | `test_a_flat_price_series_refuses_rather_than_returning_a_spurious_beta` |
| Zero-spanning interval blocks the downstream claim | `test_a_zero_spanning_interval_blocks_the_downstream_claim` |
| β always returned WITH an interval | `test_the_interval_is_always_returned_never_a_bare_point` |
| Stage 14 enforces it | `test_decision_validation_withholds_an_unsupported_markdown` |
| No second blending implementation | `test_nothing_in_the_package_reimplements_a_weighted_average` |
| Non-price families are never blocked | `test_families_that_make_no_price_claim_are_never_blocked` |
| Positive β is blocked too | `test_a_positive_elasticity_is_blocked_even_though_it_excludes_zero` |
| Absence of evidence blocks | `test_no_elasticity_evidence_at_all_blocks_every_price_claim` |

---

## 11. Not done

- **Nothing computes elasticity in the live run yet.** The estimator and guard
  are pure and tested; wiring a per-store elasticity pass into the daily job,
  and turning `enforce_elasticity` on, is a caller change with a real blast
  radius — it would withhold roughly three quarters of today's markdowns.
- **The cohort β is not computed.** `ElasticityRequest.cohort_beta` is supplied
  by the caller and sheet 05's ladder is wired for it (`PATTERN_START["elasticity"]
  = "category"`), but no job assembles cross-store elasticity observations yet.
  Until then every estimate is own-data-only at `own_weight = 1.0`.
- **Category price is a revenue-weighted daily average**, which is a mix effect
  as well as a price effect: a day that skews to premium SKUs shows a higher
  "category price" without any individual price changing. Per-SKU estimation
  would avoid that and has far less variation to work with. Worth measuring
  both ways in wave 6.
- **Measured on 3 stores × 335 cells**, not the estate.
- **10 new settings, 7 PROVISIONAL and 3 MEASURED** (68 PROVISIONAL, 7
  MEASURED overall). The three MEASURED ones are the 95% critical value, the
  30-df floor that makes a single critical value honest, and the unit-elastic
  revenue break-even. None is a tuning knob: widening any of them would make
  more markdowns "supportable" by lowering the bar rather than by learning
  anything.

---

## 12. The one-line summary

Every markdown was asserting a demand curve nobody had estimated; sheet 09
estimates it, and then refuses the claim on three quarters of real (store,
category) cells — including 30 where the data says a price *rise* moved more
volume, which a naive "interval excludes zero" test would have waved through.
