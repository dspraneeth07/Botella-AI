# Engineering response to the independent assessment

**Reviewing:** *Recommendation Engine: Independent Assessment and Technical
Requirements*
**Responding:** engineering
**Date:** 28 September 2026

---

## 0. Position in one paragraph

**We accept the review.** Every technical claim in it that we could check, we
checked against the code — and the ones that matter are right. Three of the
most serious findings (M1, M2, M3) are defects **we introduced**, and one of
them (M3) means a sentence in our own report contradicts our own numbers. Of
the 26 requirements, **21 are doable as written**, 3 need a scope decision,
1 needs a data source we do not have, and 1 conflicts with a standing
architectural constraint that we think should now be relaxed. Nothing in the
review calls for a rewrite, and we agree with that reading.

The single most important line in the review is not a defect at all:

> *The binding constraint is data, not modelling.*

That is correct, and it changes what we should work on first.

---

## 1. Methodology findings — verified, one by one

Each was checked against the source. "Confirmed" means we reproduced it.

| # | Finding | Status | Where |
|---|---|---|---|
| M1 | Margin summed across overlapping horizons | **CONFIRMED — our defect** | `real_engine_backtest.py:1089` |
| M2 | Engine re-run per horizon | **CONFIRMED — our defect** | `real_engine_backtest.py:1049` |
| M3 | Hardcoded narrative text | **CONFIRMED — our defect** | `:224`, `:1279`, `:842` |
| M4 | p-value doesn't reconcile with config | **Partly — reporting gap, not a wrong number** | see below |
| M5 | Hit graded against trailing rate, not the prediction | **CONFIRMED — by design, and the design is wrong** | |
| M6 | Downside not counted | **CONFIRMED** | |
| M7 | No stock in the replay | **CONFIRMED — already stated in every report** | |
| M8 | Non-merchandise SKUs are candidates | **CONFIRMED** | |
| M9 | Quantity contract too loose | **CONFIRMED** | `MAX_PLAUSIBLE_LINE_QUANTITY = 1000` |
| M10 | Ledger intervals assume independence | **CONFIRMED — already stated in the ledger** | |
| M11 | Two lift definitions | **CONFIRMED — worse than described** | `recommendationEvalService.js:939` |

### M1 — margin double-counted. Accepted.

`_agg()` sums `margin_impact` over every row in an arm, and an arm contains the
same picks measured at 30, 60, 90 and 120 days. The same recovered unit is
counted up to four times.

**The headline dollar figures in all four store reports are overstated.** The
hit rates, the nulls, the edges and the p-values are unaffected — they are
computed per horizon. Only the money is wrong, and only where it was summed.

Fix: report money **per horizon**, headline the 30-day figure, never total
across windows. (R4)

### M2 — the engine was re-run per horizon. Accepted, and it contradicts us.

`engine_picks(store, as_of, h, ordering=arm)` is called inside the horizon
loop. So the 90-day slate is not the 30-day slate followed for longer — it is a
**different set of picks**, chosen with a different deficit window.

The reviewer notes this contradicts our own ledger, which says *"re-running the
engine per horizon would be a different store on a different day."* That is
exactly right. The **ledger** does it correctly (one run per trading day,
followed at four horizons); the **backtest** does not. Two of our own artefacts
disagree, and the ledger is the one that is right.

Fix: one run per decision date, graded at four horizons — the ledger's shape.
(R4)

### M3 — hardcoded narrative. Accepted, and this is the one that hurts.

Three strings are literals in the HTML template rather than computed:

- `"Combining 24 such tests by Fisher's method returns p = 0.73"` — Cork Runner
  has **252** runs, and its Fisher value is computed but never used in the
  prose.
- `"$98.6M on a store turning over $7M"` — Mango Jo's figure, printed on
  reports for other stores.
- `"the fourth fifth outscores the fifth"` — true of Bethany when written,
  asserted everywhere after.

We wrote, at the top of every one of those reports, *"every number on this page
was produced by app/pipeline."* For those sentences that was **not true.** The
review is right to call it a credibility risk and we would rather have been
told by our own process than by a reviewer.

Fix: no narrative sentence may contain a figure that is not interpolated from
computed data, enforced by a test that greps the template for digit literals
outside `%(…)s`. (R4)

### M4 — the p-value is right; the disclosure was not.

The reviewer's arithmetic is correct given what we printed. The resolution of
an add-one p-value over 400 baskets is 1/401 ≈ 0.0025, so 0.0005 looks
impossible.

The actual answer is that **two different counts are in play**:

- `NULL_BASKETS = 400` — used to estimate the *null hit rate*.
- `pooled_permutation(draws=2000)` — used for the *p-value*. 1/2001 = 0.0005.

So the number is correct and the configuration table listed only one of the two
counts. That is our reporting error, not an arithmetic one, and a reader doing
exactly what this reviewer did should not land on a contradiction. Both counts
will be listed. (R4)

### M5 — the metric never checks the promise. Accepted; this is the deepest one.

A card says *"expect about 62 units above run-rate."* It is scored a hit if the
product beats its trailing rate **by one unit**. The Wheatley example in the
review is exact: promised ~62, delivered −2 at 30 days, still scored a hit at
90 and 120.

This is not a bug — it is what the metric was designed to measure, and the
design is too weak for a card that states a quantity. **A store owner acts on
the number, not on the direction.**

Fix: add `prediction_accuracy = realised extra ÷ predicted extra` and report it
beside the hit rate. Expect it to be unflattering. (R15)

### M6 — only upside is counted. Accepted.

`margin_impact` counts units sold above the trailing rate. Units **ordered and
not sold** cost money — cash, shelf, and eventually markdown — and appear
nowhere. Any honest net figure needs the carrying cost of the over-order.
(R15)

### M8 / M9 — junk SKUs and a cap that is far too loose. Accepted.

`0123456789`, `S50`, `SKU 12` (CRV deposit), ice bags are not merchandise and
should never have been candidates. And a 1,000-unit ceiling against a
99th-percentile line of **20** units means a 900-unit error sails through
looking plausible.

Fix: a merchandise filter, and a **per-SKU** outlier rule (e.g. reject a line
above ~50× that SKU's own 99th percentile) plus an explicit rejection of
`quantity == sku` or `quantity == barcode`. The Mango Jo's 8,245,805-unit line
was caught only because it was absurd; the same class of error at 400 units
would not be. (R4)

### M11 — two lift definitions, and the parity test does not cover the live one.

Worse than the review states. We have a shared definition (`backend/lib/lift.js`
↔ `app/pipeline/outcomes/lift.py`) pinned digit-for-digit by
`lift-parity-verify.js`. **`outcomeFeedbackService.js` uses it.
`recommendationEvalService.js` does not** — it computes `lift = baselinedActual
/ expected` inline at line 939 and only *mentions* `liftFor` in comments.

`recommendationEvalService` is the service that writes
`recommendation_evaluations`. So the table the whole feedback loop depends on
would be populated by the **unpinned** definition.

This must be fixed **before R1 turns the loop on**, or we will accumulate
months of outcomes under a definition nothing verifies. We are treating it as a
blocker on R1, not a parallel task.

---

## 2. Where we would qualify the review

Three small things. None changes its conclusions.

**The 50% figure deserves its context.** *"Counting each product once, the
March ledger's 30-day hit rate is 50%"* is accurate and is our own number — we
published it. It is **8 hits out of 16**, and a 16-sample proportion has a 95%
interval of roughly **28–72%**. It is evidence that the effect is smaller than
the 69% headline; it is not itself a precise estimate. The 52-date backtest
exists because one month cannot answer this.

**Marshfield being least reliable is right, and it is our labelling that is
wrong.** 6 decision dates, ~3 months of history. It should not have been
presented alongside three stores with 63 dates without a prominence warning.
That is a reporting fix, not a data problem.

**"p_hit doesn't rank above the floor" — agreed, and we found it first.** It is
in our own report with the non-monotone quintile table and the sentence *"the
floor does the work; p_hit does not finely rank above it."* We flag this only
because the review lists it under "weaker than it looks", and we would rather it
be recorded as a known, published limitation than a discovered one. It is
nonetheless a real defect and R14 is the right fix.

---

## 3. Requirements — our assessment of every one

**Effort key:** S ≤ 1 week · M 1–3 weeks · L 3–8 weeks · XL > 8 weeks.
**Verdict key:** ✅ doable as written · ⚠️ doable with a caveat · 🔶 needs a
decision · ❌ blocked.

### P0 — capture that cannot be backfilled

| # | Requirement | Verdict | Effort | Engineering note |
|---|---|---|---|---|
| **R1** | Eval job + 20% holdout | ⚠️ | S | **Blocked on M11 first.** The mechanism exists (`REC_HOLDOUT_PCT`, default 10, capped 50; FNV-1a on `client:location:sku:family`). Two cautions: (a) changing the percentage **reshuffles arm assignment**, so do it once, now, before enforcement; (b) fix the two lift definitions before writing a single outcome row. |
| **R2** | Daily on-hand snapshots | ✅ | S | `captureOnHand()` already exists and writes `feature_daily.on_hand` with `COALESCE` so it **never rewrites a fact**. Needs scheduling for the 5 GOOD stores. Highest value per hour of work on this list. |
| **R3** | Lead times per supplier | ✅ | S (+ ops) | Engineering is trivial; the cost is **operational**. `policy.lead_time_days.declared = 7` is PROVISIONAL and we have verified four times that nothing in the warehouse records arrival — `purchase_orders` has the right columns and **zero rows**. Only asking the stores fixes it. A 7→10 day error moves every order-up-to level by ~21%. |
| **R4** | Fix the reports | ✅ | M | Accepted in full; see §1. We will add a test that fails the build on a digit literal in narrative text, so M3 cannot recur. |

### P1 — forecast every product

| # | Requirement | Verdict | Effort | Engineering note |
|---|---|---|---|---|
| **R5** | `feature_daily` for every SKU/open day | ✅ | M | Table and the open-days discipline exist. This is a widening (promo, temp, holiday, event columns) and a backfill, not a new design. Note the **43.8% product-master gap** limits cost/category/pack for those rows. |
| **R6** | Calendar features | ✅ | S–M | Straightforward and high value. Moving holidays (Easter, Thanksgiving, Super Bowl) need a proper calendar table, not arithmetic. Tax-refund window should be **tested per store, not assumed** — agreed with the review's wording. |
| **R7** | True demand (stockout correction) | ⚠️ | M | **Cannot be applied to history.** No historical on-hand exists at 4 of the 5 GOOD stores. Usable from ~30 days after R2 lands; meaningful for training after ~6–12 months. This is the strongest argument for starting R2 this week. |
| **R8** | Demand classification → per-class methods | ✅ | M | Syntetos-Boylan classification already exists (`storeagent/forecasting/classify.py`) with the published 1.32 / 0.49 cuts. Routing to Croston/SBA/ETS is new work but well-trodden. |
| **R9** | Global LightGBM, quantile p10/p50/p90 | 🔶 | L | **Doable, and it breaks a standing constraint we should now relax.** `app/pipeline` is deliberately pure-stdlib — no numpy, scipy or sklearn — which is what makes it replayable and what lets the Node and Python lift definitions be pinned digit-for-digit. A gradient-boosted model cannot honour that. <br><br>Our recommendation: **keep the constraint for the decision path and break it for the forecast.** Train offline, export the model as a versioned artefact, and have the pipeline consume *predictions* rather than run an inference library. The stage envelope stays replayable because the model version is pinned in the payload. This is a decision for the team, not something we should do silently. |
| **R10** | Backtest harness vs 3 baselines | ✅ | M | The harness exists and already does walk-forward, date-clustered intervals and matched nulls. Adding WAPE, bias and p10–p90 coverage against trailing-28 / same-period-last-year / 12-month is an extension. **We would add a fourth baseline: the current engine**, so we can see whether the new forecaster actually beats what we have. |

### P2 — decisions that move money

| # | Requirement | Verdict | Effort | Engineering note |
|---|---|---|---|---|
| **R11** | Inventory policy with real quantities | ⚠️ | M | Sheet 10 already computes order-up-to, safety stock and service levels. It is **not wired to live stock**, and its lead time is the declared 7. Gated by R2 and R3 — the arithmetic is ready, the inputs are not. |
| **R12** | New card families | ✅ | M–L | Sheet 12's candidate types are already typed and pluggable; `clear` and `markdown` templates exist. "Holiday prep" depends on R6. Agreed that dip-only should stop being the sole family. |
| **R13** | Rank by expected dollars | ⚠️ | M | Doable and we support it — with one measured caution. We tested ranking nearer the signal versus nearer the money: **money-weighted ranking scored ~9 points lower on hit rate** (60.0% vs 69.6% out-of-sample) while capturing more margin. Both were real. If we move the sort key to dollars, the hit rate **will** fall, and everyone should agree in advance that this is the intended trade rather than a regression. Needs `P(wrong) × cost`, which needs R2 and R15. |
| **R14** | Calibrate confidence (isotonic) | ✅ | S–M | Sheet 08's isotonic (PAVA) implementation exists and currently ships as identity because nothing has been fitted. Needs R1's outcomes. **Strongly agree with hiding the raw score** until calibration error is inside ~5 points — we publish it now with a warning, which is weaker than not publishing it. |
| **R15** | Grade the promise; count the downside | ✅ | S | The most valuable cheap item on the list. Both metrics are computable from data we already store. Expect the first numbers to be uncomfortable. |
| **R16** | Repeat control / cooldown | ✅ | S | Directly evidenced: Stroyski shown 8 consecutive days, missed every one. `recommendation_sku_state` already exists for cooldown. A 7-day retirement with an early read at 7–14 days is the right shape. |
| **R17** | Category gate (shadow → live) | ✅ | M | Sheet 17's gate already does shadow/live/suspended per store × family with a permutation test and `MIN_OUTCOMES = 30`. Extending the key to include category is a schema and threshold change, not new machinery. Needs R1. |

### P3 — prove it

| # | Requirement | Verdict | Effort | Engineering note |
|---|---|---|---|---|
| **R18** | Live pilot, 5 GOOD stores, SKU-level holdout | ✅ | M | Agreed, including **"a hidden SKU stays hidden for the pilot"** — that is the right design and our FNV-1a assignment already gives it for free. Logging owner action (acted / changed quantity / dismissed) is new UI + schema work and should not be an afterthought; without it we learn whether the engine was right but not whether anyone listened. |
| **R19** | Power check before starting | ✅ | S | Should be done **before** R18, not alongside. Our own 16-sample month is the cautionary example. |
| **R20** | Report extra margin shown vs held out | ✅ | S | Falls out of R1 + R18. |

### P4 — data remediation

| # | Requirement | Verdict | Effort | Engineering note |
|---|---|---|---|---|
| **R21** | Diagnose missing cost at 78 stores | ✅ | M | We saw this from the other end: **all five second-cohort stores had 0.0% cost coverage** — one integration not sending cost, which is also what earned them their POOR grade. Diagnose **per integration**, not per store. |
| **R22** | Close the product-master gap (43.8%) | ✅ | L | Blocks dollar ranking, category rollups and pack sizes beyond the 5 GOOD stores. |
| **R23** | Triage 62 majority-failing syncs | ✅ | M | Related to the three stores that stopped on 3 June — a single-date, multi-store stop is a connector-side event, not three coincidences. **Add a staleness gate regardless:** a store whose feed is days behind still has a 28-day window the engine will happily compute from, and a stalled feed looks exactly like "every product went quiet", which is this engine's buy signal. |
| **R24** | Backfill monthly partitions | ✅ | M | Pure performance. Matters once R9 trains on multi-year history. |
| **R25** | Reconcile local vs Neon; duplicate `005` | ✅ | S | Two migrations with the same number is a foot-gun; fix before more schema lands. |
| **R26** | New analytics schema on its own instance | ✅ | M | Sizing for 40–60M `feature_daily` rows is sound. |

**Totals:** ✅ 21 · ⚠️ 4 · 🔶 1 · ❌ 0

---

## 4. Answers to the open questions

**Q. Feedback loop — built but not scheduled, or writing elsewhere?**
Built, not scheduled, **and it would write under the wrong lift definition.**
`recommendationEvalService.js` computes lift inline (line 939) instead of
calling the pinned `liftFor`. `outcomeFeedbackService.js` does use the pinned
one. So the zero rows are not just a scheduling gap; turning it on today would
start accumulating outcomes under an unverified definition. **Fix M11 first.**

**Q. What produces p10/p50/p90 today, and for which SKUs?**
Sheet 07: demand class first (Syntetos-Boylan), then the level from the
04→05→06→20 chain, then an interval. Hand-written, pure stdlib — Holt-Winters,
PAVA isotonic, OLS by Gauss-Jordan, inverse normal by bisection on `math.erf`.
It runs for any SKU passing the materiality floor. It **refuses** where the
interval is too wide to order against, which is deliberate.
Of Engine Two: C1 partially (feature_daily exists, narrower than R5), C4/C5/C9
exist but are unwired or shipping as identity, C10/C11 exist behind the gate.
C2/C3 (classification routing, global model) are not built.

**Q. How is the live card's quantity computed?**
`order_up_to − on_hand − on_order`, rounded to case pack, where `order_up_to` =
coverage demand over (lead time + review period) + safety stock. It **does** use
lead time and case pack — but lead time is the declared 7 for every vendor, and
this is the path the backtest could not exercise because there is no historical
on-hand.

**Q. Was the engine intentionally re-run per horizon?**
**No.** It is a defect (M2), and our own ledger documents why it is wrong.

**Q. Which permutation count produced p = 0.0005?**
2,000 draws in `pooled_permutation` → 1/2001. The 400 in the config table is the
null-basket count, a different quantity. Both will be listed (M4).

**Q. Do any GOOD stores' POS systems keep an inventory change log?**
**Unknown, and worth an hour of someone's time before we accept that history is
unrecoverable.** We have only inspected what lands in `syncgo`. If a LocalDB
holds an inventory movement log, it would make R7 possible on history rather
than only going forward — which would be the single biggest unlock on this
list. We will check.

**Q. Which lift definition should be canonical?**
`backend/lib/lift.js` ↔ `app/pipeline/outcomes/lift.py`. They are pinned to each
other digit-for-digit by a shared fixture. `recommendationEvalService.js` should
call it rather than reimplement it.

**Q. Which requirements are quick or hard?**
Quick and high value: **R2, R15, R16, R19, R25** — all ≤ 1 week, none blocked.
Hard: **R9** (architectural decision), **R22** (large data remediation),
**R18** (needs UI, schema and a real pilot).
Time-critical: **R1, R2, R3** — every day without them is a day of evidence we
cannot recover.

---

## 5. What we would add

**A staleness gate, before the pilot.** Not on the list, and it is a live
hazard. A store that stopped syncing still has a 28-day window; a stalled feed
looks identical to "every product went quiet", which is precisely this engine's
buy signal. The materiality floor catches a *fully* dead feed (zero sales fails
the 8-unit test). A **partially** stale feed is the dangerous case and nothing
currently catches it.

**A "no narrative literal" build check.** M3 is the kind of defect that recurs
because it is invisible in review. It should be mechanically impossible.

**A fourth baseline in R10: the current engine.** Otherwise we will know the
new forecaster beats a trailing average without knowing whether it beats what
we already ship.

---

## 6. Proposed sequence

**Week 1 — stop the clock on unrecoverable data**
M11 (one lift definition) → R1 (eval job + 20% holdout) → R2 (daily on-hand) →
R3 kick-off with ops. Plus R25 and R19 — both cheap, both unblock later work.

**Weeks 2–4 — make the reports defensible**
R4 in full, with the narrative-literal check. R15 and R16, which are small and
change what we can honestly claim. Check the LocalDB inventory-log question.

**Weeks 5–12 — forecasting core**
R5, R6, R8, R10. **R9 only after the team decides the stdlib question.**

**From ~week 8, in parallel as R2 data matures**
R7, R11, R14, R17.

**Pre-Thanksgiving — pilot**
R18 and R20. The review's point about being live before the holidays is well
made: liquor demand is concentrated there, and a pilot that misses it waits a
year for the same evidence.

---

## 7. Closing

The review is right that the engine is ready for a **measured pilot, not a
broad launch or revenue claims**, and we are not going to argue for a stronger
claim than the evidence supports.

The finding we would most like recorded is not one of ours: **the binding
constraint is data, not modelling.** We can improve the forecast with what is
already in `syncgo`. We cannot prove the engine makes anyone money without
outcomes, stock history and lead times — and two of those three can only be
captured going forward. That is why R1, R2 and R3 sit above everything else,
including the modelling work that is more interesting to do.
