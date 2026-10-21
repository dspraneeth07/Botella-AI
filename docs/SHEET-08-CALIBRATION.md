# Sheet 08 — Calibration, applied

**Status:** complete, and deliberately shipping as the identity transform.
**823 Python tests (+35), two build guards, ruff + mypy clean.**
**Depends on:** 07, 19. **Wave:** 6. **Gated by:** outcomes existing — see §3.

> **One correction to the sheet header.** It names the repo
> `C:/Users/Techm/Downloads/external_api`, the stale August copy. All work is
> in `BottleAI-gitlab/Botella_External_APIs`.

---

## 1. Why this sheet exists

The backtest scored **mean stated confidence 0.48 against an actual hit rate of
0.23** — Brier 0.255, where **0.25 is a coin flip**. The engine's confidence
carried no information.

A number that says 80% and is right 23% of the time is **worse than no number**,
because the interface and the owner both treat it as meaningful. Deleting it
would at least be honest; leaving it uncalibrated is a claim we have not earned.

### What the live data says today

79 stored recommendations, every one carrying a confidence:

| family | recs | distinct values | min | max |
|---|---:|---:|---:|---:|
| reorder | 15 | 7 | **0.87** | **0.95** |
| endcap | 15 | 10 | 0.38 | 0.85 |
| pre_stock | 13 | 10 | 0.71 | 0.92 |
| promote | 10 | 10 | 0.33 | 0.83 |
| liquidate | 9 | 7 | 0.73 | 0.90 |
| bundle | 8 | 8 | 0.74 | 0.87 |
| markdown | 5 | 5 | 0.72 | 0.82 |
| cold_box | 4 | 3 | 0.88 | 0.91 |

Mean stated confidence across all of them: **0.796**.

**`reorder` has never once said it was unsure.** Fifteen recommendations, all
between 0.87 and 0.95. A number that never varies cannot be carrying
information about a world that does — and it is the family with the most
recommendations.

And the column that would check it:

```
recommendation_evaluations:  0 rows
```

Seventy-nine confidences, zero outcomes.

---

## 2. The three files

| File | Lines | When it runs | What |
|---|---:|---|---|
| `app/pipeline/calibrate/fit.py` | 330 | offline, weekly | Isotonic fit per (family, demand class), versioned |
| `app/pipeline/calibrate/apply.py` | 230 | **ONLINE, in-run** | Before ranking and before display |
| `app/pipeline/calibrate/monitor.py` | 330 | after outcomes land | Brier, ECE, reliability, suspension |
| `app/pipeline/calibrate/__init__.py` | 60 | — | Public surface |
| `app/pipeline/provenance.py` | +14 | — | `calibration_version` |
| `app/recommender/validator.py` | +110 | — | The real call site (§4) |
| `backend/lib/stageEnvelope.js` | +12 | — | The Node mirror (§7) |
| `tests/test_calibrate.py` | 430 | — | 35 tests |

---

## 3. Isotonic, and written out rather than imported

The sheet's snippet is `sklearn.isotonic.IsotonicRegression`. **This service
has no sklearn** — no numpy, no scipy, nothing numeric. Same situation as
sheet 07's LightGBM, and the same answer: Pool-Adjacent-Violators is forty
lines, **exact** rather than iterative-approximate, and deterministic. Adding a
numeric stack to a stateless service for forty lines of arithmetic is the wrong
trade.

**Why isotonic and not Platt scaling.** A sigmoid assumes the miscalibration
has a particular S-shape. We have no reason to believe that, and every reason
to think families are wrong in different ways — `reorder` is uniformly
overconfident at 0.87–0.95, `promote` ranges 0.33–0.83 and may be closer to
honest. Isotonic assumes only **monotonicity**: more stated confidence should
not mean fewer hits. That is the one thing we are willing to assert.

**Fitted per (family, demand class), never pooled.** A `reorder` on a smooth
SKU and a `reorder` on a lumpy one are not the same claim with the same
reliability, and pooling them hides both.

---

## 4. Where it runs is the whole sheet

Calibration is applied **before ranking**, not afterwards as a grade.

The real call site is `app/recommender/validator.py`, which caps recommendations
in three places — and those caps decide what an owner actually sees:

```python
trending.sort(key=_rank_confidence, reverse=True)   # which trending survive
cold.sort(key=_rank_confidence, reverse=True)       # which cold_box → endcap
ends.sort(key=_rank_confidence, reverse=True)       # which endcap → promote
```

`_apply_calibration(...)` now runs immediately above them.

Applied **after** those sorts, an overconfident `reorder` still holds its slot
and still reaches the owner; calibration merely prints a smaller number beside
it. Applied **before**, the same `reorder` loses its place to a `cold_box`
whose stated confidence was lower but whose observed hit rate is higher.

That is the decision changing, and `test_the_validators_caps_rank_on_the_calibrated_value`
asserts exactly it:

```
before calibration:  reorder 0.90  >  cold_box 0.40
after  calibration:  cold_box 0.60 >  reorder  0.31
```

`_rank_confidence` is a named function rather than three lambdas so that
"ranking uses the calibrated value" is **one fact in one place that a test can
assert**, instead of a convention three sort calls have to remember separately.

---

## 5. Shipped as the identity transform, on purpose

No curve can be fitted today. Not one family clears the floor — the largest has
15 recommendations against a floor of 50 — and none has a single outcome.

So the sheet's own sequencing instruction is followed exactly: **the plumbing
ships complete and the transform is the identity.** Request, result, reasons,
the version in Provenance, the Node mirror, and the call site in the ranking
path all exist. When outcomes accumulate the work is fitting a curve, not
threading a new value through eleven stages.

`test_the_identity_path_costs_nothing_in_the_ranking_it_shipped_with` proves
today's output is byte-identical to pre-sheet-08 ranking — which is what makes
it safe to ship the path before the curve exists.

**Nothing is a silent default.** Every identity result carries a reason:

```
no_calibration_bundle
no_fit_for_cell:markdown/lumpy:too_few_outcomes:10<50
family_suspended:reorder
```

An unexplained passthrough and a fitted curve would look identical on the wire,
and the first would quietly become permanent.

---

## 6. It never extrapolates

A stated confidence outside the range a curve was fitted on is **clipped**, and
says so:

```
clipped_above_fitted_range:0.990>0.950
```

Extrapolating an isotonic fit means continuing the last segment into a region
where no outcome was ever observed — the exact unearned claim this sheet exists
to remove. And it would happen most often precisely where the engine is most
overconfident, which is the region that decides what gets shown.

**Too few outcomes returns the identity transform with a reason, never a guessed
curve.** Two floors, both in the registry:

- `calibrate.min_outcomes_to_fit` (50) — below this an isotonic fit is
  shape-fitting noise; it will happily interpolate five points into a
  confident-looking staircase.
- `calibrate.min_distinct_confidences` (4) — a cell where every recommendation
  stated 0.9 has no curve to fit. Not hypothetical: `reorder` spans 0.87 to
  0.95 across 15 rows, and a fit on that is a horizontal line dressed as a
  model.

---

## 7. The version is auditable — and that crossed a language boundary

`Provenance.calibration_version` records which curve shaped a given number, so a
card shown six months ago can still be explained. A calibration nobody can audit
is just a second unexplained number stacked on the first.

Adding one field to `Provenance` **immediately failed a golden-fixture test**:

```
The audit-row shape changed. Regenerate the golden fixture in BOTH
tests/fixtures/ and backend/tests/fixtures/, and check
backend/lib/stageEnvelope.js still parses it.
```

That is sheet 00's cross-language contract working exactly as designed. The
Node mirror in `backend/lib/stageEnvelope.js` now parses and validates
`calibration_version`, and both golden fixtures were regenerated deliberately.
Without the pin, the field would have reached production as an `undefined` in a
Node tile.

**Identity carries a real version — `identity.v1` — not `None`.** `None` means
"this provenance predates calibration entirely"; `identity.v1` means
"calibration ran and had nothing to apply". Collapsing them would lose the
difference between never asking and asking and being told no.

The version is `YYYY-MM-DD.<digest of the outcomes>`, so two fits on the same
day over different data are distinguishable. A version carrying only the date
would make a refit indistinguishable from the fit it replaced — which is the
one thing recording it is for.

---

## 8. Monitor — and why suspension is routine

| Metric | What it catches |
|---|---|
| **Brier** | Overall probabilistic error. 0.25 is a coin flip |
| **ECE** | Only the calibration part, weighted by bin population |
| **Reliability curve** | *Where* the miscalibration lives |

**Brier alone is not enough.** It mixes calibration with discrimination: a model
that says 0.23 to everything is perfectly calibrated against a 23% base rate and
completely useless, and its Brier looks respectable. The reliability curve shows
where the error lives — and the engine is not uniformly wrong. It is wrong at
the top, where it says 0.91 and means 0.34, which is exactly the region that
decides what an owner sees.

**Empty bins are kept**, with count 0 and `None` rates. Dropping them would make
a family that only ever states 0.9 look like it covers the whole range — which
is the shape `reorder` currently has.

**Suspension is a normal state, not an incident.** When a family's ECE drifts
past `calibrate.ece_suspend_threshold`, that family is suspended for that store,
`apply` falls back to identity with a reason, and a refit is requested. Nothing
pages anybody. This has to be routine, because the alternative is a curve
everyone is slightly afraid to touch — and one whose suspension is an incident
will be left running long past the point it stopped being true.

A family with too few outcomes comes back **UNSCORED**, which is not a pass. A
Brier over nine recommendations is a number, and it is not evidence.

---

## 9. Verification

```bash
cd Botella_External_APIs
./.venv/Scripts/python.exe -m pytest tests/test_calibrate.py -q   # 35
./.venv/Scripts/python.exe -m pytest -q                           # 823
./.venv/Scripts/python.exe scripts/check_no_literals.py           # exit 0
./.venv/Scripts/python.exe scripts/check_no_state_branches.py     # exit 0
./.venv/Scripts/python.exe -m mypy app/pipeline/calibrate/        # clean
cd ../backend && node tests/stage-envelope-verify.js              # ALL CHECKS PASSED
```

| Sheet requirement | Proven by |
|---|---|
| Overconfident input pulled toward truth | `test_a_deliberately_overconfident_input_is_pulled_toward_truth` |
| Too few outcomes → identity **with a reason** | `test_too_few_outcomes_returns_identity_with_a_reason` |
| Applied value is what ranking receives, end to end | `test_the_validators_caps_rank_on_the_calibrated_value` |
| Never extrapolates — clips, and says so | `test_a_confidence_above_the_fitted_range_is_clipped_and_says_so` |
| Version lands in Provenance | `test_the_calibration_version_lands_in_provenance` |
| Fitted per family AND per demand class | `test_families_are_fitted_separately`, `test_demand_classes_are_fitted_separately_within_a_family` |
| Suspension reaches the online path | `test_a_suspended_family_falls_back_to_identity_at_apply_time` |
| ECE drift suspends and triggers a refit | `test_a_drifted_family_is_suspended_and_a_refit_requested` |
| Identity ships without changing today's ranking | `test_the_identity_path_costs_nothing_in_the_ranking_it_shipped_with` |

On synthetic outcomes matching the measured shape (states 0.6–0.95, hits
0.25–0.36):

```
stated 0.60 -> calibrated 0.308
stated 0.80 -> calibrated 0.308
stated 0.90 -> calibrated 0.313
stated 0.95 -> calibrated 0.385
```

0.60 and 0.80 collapse to the same value, which is the curve saying **the engine
cannot tell those cases apart**. That is more useful than any single rescaled
figure.

---

## 10. Not done

- **No curve is fitted, and none can be.** `recommendation_evaluations` holds 0
  rows. This is calendar time, not engineering time, and the sheet says so.
- **`demand_class_by_sku` is not threaded from the validator's caller.** The
  parameter and the seam exist; without it every rec lands in the `"unknown"`
  cell.

  > **Correction.** This was first described as "a one-line change at the call
  > site". It is not. `RecommendationContext` carries `velocity`, whose
  > `velocity_bucket` is a DIFFERENT taxonomy (very_low..very_high) from sheet
  > 07's demand class (smooth / intermittent / erratic / lumpy / new_sku).
  > Threading the real class needs the feature-store calendar and facts in the
  > payload so `classify()` can run - the same seam sheet 06A opened for the
  > calendar, and the same reason: Python is stateless and Node owns the
  > analytics database.
- **Nothing schedules the weekly fit.** `fit_calibration` is a stage with no
  cron, the same position `build-feature-store --incremental` is in.
- **The monitor is not wired to persist suspensions.** `suspended_families` is
  an input to `apply`; storing the monitor's verdict per store is sheet 19's
  table to own.
- **All 5 new settings are PROVISIONAL** (61 PROVISIONAL, 4 MEASURED overall).
  By design — they are fitted when outcomes exist.

---

## 11. The one-line summary

The confidence figure was a coin flip wearing a decimal point; sheet 08 builds
the machinery to earn it back, ships it as an honest identity transform because
zero outcomes exist to fit on, and puts it *before* the ranking so that when the
curve arrives it changes what gets recommended rather than grading what already
was.
