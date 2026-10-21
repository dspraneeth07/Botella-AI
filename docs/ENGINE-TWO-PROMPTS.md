# Engine Two — implementation prompts

Hand-off prompts for the requirements in the independent assessment
(25 Sep 2026). Each is self-contained: paste one into a session or a ticket and
it carries the context, the constraint, the acceptance bar, and **what it can
and cannot move**.

Ordered by dependency, not by appeal. Later prompts assume earlier ones.

---

## Before anything: the accuracy target, stated honestly

The ask is 90% at 30 days, against 65% today. **90% is not reachable on the
current metric**, and three independent measurements say so:

| measurement | result |
|---|---|
| Top decile of the strongest signal available, every horizon | **65–69%** |
| Best worst-horizon, sweeping the floor × coverage over 50 decision dates | **73.1%** |
| Best single card per date | 71.1% (95% CI 57.8–84.4) |

The reversion-matched null at 30 days is ~59%, so today's 65% is **+16.5 points
of real skill over a baseline that already knows about mean reversion**. Tuning
the same engine on the same metric to reach 90% is fitting to the test, and it
will not survive a rerun by anyone else.

**What is genuinely unknown is the ceiling on clean inputs.** Today's number is
measured on contaminated data:

- **A stockout looks exactly like a dip.** The engine recommends the product, it
  "recovers" when restocked, and that is noise in both directions — in the
  selection *and* in the grade. Unmeasurable without on-hand history.
- **Calendar effects are read as reversion.** A product that dips in early March
  and recovers around St Patrick's Day is seasonality, not mean reversion.
- **Non-merchandise lines are still candidates** at some stores (deposits, ice,
  placeholder SKUs), and they have the exact statistical shape the engine hunts.

So: **do not promise 90%.** Promise to find out what is achievable once the
inputs are clean, and report it. P0 and P1 below are what make that possible;
nothing in P2 is worth doing before them.

**One more framing point for the pass bar.** Hit rate against a trailing rate
is a weak target — it is already 59% by accident. The measures worth optimising
are **prediction accuracy** (does the card's quantity come true) and **net
margin after the cost of unsold stock**. On the March ledger those read **59%**
and **−$495** at 30 days. That is the real gap, and it is much larger than the
gap between 65% and 90%.

---

## P-1. Restore the reverted review fixes

> Commit `8c450dd` ("Remove unused merchandise classification and related
> logic", 28 Sep) deleted work that answered four findings from the independent
> assessment. Restore it, wired rather than orphaned, and keep it wired.
>
> Recover from history:
>
> ```
> git show b1ee34d -- '*/app/pipeline/candidates/lifecycle.py' \
>                     '*/app/pipeline/candidates/merchandise.py' \
>                     '*/tests/test_lifecycle_and_merchandise.py'
> ```
>
> **What each answers:**
> - `merchandise.py` → **M8**. Deposits, lottery lines, ice bags and placeholder
>   SKUs reached the *top* of the earnings table because a mechanic rung on
>   every transaction has huge volume and a wobbling trailing window — exactly
>   the shape the reversion signal hunts.
> - `lifecycle.py` → **R16**. Without it the engine has no memory: Stroyski
>   1.75L ran eight consecutive days and missed every one. With it, 162 March
>   cards became 69 at the same hit rate, and Stroyski was pulled after three
>   days.
> - The `_calibration_verdict()` function and the permutation-draw row in the
>   config table → **M3** and **M4**.
>
> **Critical warning, from the first attempt.** A name/SKU heuristic filter is
> dangerous. The first version of `merchandise.py` was audited against all ten
> stores' catalogues and would have deleted real stock: an "ascending digits"
> pattern matched *1690 Absolut Mandrin*; a four-character SKU minimum refused
> *417 E&J Brandy* and *105 Keg Miller Lite*; the word "department" refused
> *Department 66 Grenache*, a winery; "rounding" refused *LYNX POLARIZED
> GROUNDING AD.*
>
> **Acceptance:** re-run the full-catalogue audit (all ten
> `audit/data/store_*.csv.gz`) and show the refused list. Every refusal must be
> explainable as a mechanic. Target under 0.25% of distinct SKUs. If a real
> bottle is in the list, the filter is wrong, not the bottle.

---

## P0. Capture what cannot be backfilled

These three are time-sensitive in the literal sense: every day they are not
running is a day of evidence that can never be recovered.

### R1. Turn on the evaluation job and a 20% holdout

> `recommendation_evaluations` has **zero rows**. The feedback loop is built and
> not scheduled, so no card has ever had its outcome recorded, and there is no
> causal claim available at all.
>
> **Build:**
> 1. Schedule the evaluation job. Write an outcome row per card at **7, 30 and
>    60 days** after creation.
> 2. Write `is_holdout` **at card creation**, not at read time — assignment must
>    be fixed before anyone can see the result.
> 3. Set `REC_HOLDOUT_PCT=20`. Assignment is FNV-1a over
>    `client:location:sku:family`, so **changing the percentage reshuffles the
>    arms**. Do it once, now, before enforcement, not after.
> 4. Resolve **M11**: there must be exactly one lift definition.
>    `app/pipeline/outcomes/lift.py` is twinned with `backend/lib/lift.js` and
>    pinned by a shared fixture. Any third definition in the codebase should be
>    **deleted**, not reconciled.
>
> **Why 20% and not 10%:** the gate needs `MIN_OUTCOMES=30` per store × family
> before it can judge anything. At 10% a mid-sized store waits months. Nothing
> enforces on holdout results yet, so the cost of raising it today is zero.
>
> **Acceptance:** every card created from the deploy date has an outcome row at
> 7, 30 and 60 days. `SELECT count(*) FROM recommendation_evaluations` is
> non-zero and growing daily.

### R2. Daily on-hand snapshots

> **This is the single highest-value item in the whole list, and it is pure
> capture.** Historical on-hand does not exist anywhere: no `feature_daily`
> history, and `purchase_orders` has the right columns and zero rows at four of
> the five GOOD stores. It cannot be reconstructed. It can only be collected
> from today.
>
> **Build:** a daily job writing
> `(client_id, location_id, sku, date, on_hand, on_order)` into
> `feature_daily.stock_qty`. Start with the five GOOD stores (171, 176, 177,
> 178, 181), then every syncing store.
>
> **Two traps already hit on this codebase:**
> - Derive the observation date in **SQL**, not JavaScript. A previous capture
>   used the process timezone and recorded IST dates against a UTC warehouse,
>   off by one day for half the estate. Use
>   `to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD')`.
> - Capture **before** any `no_sales` skip. A previous version ran the capture
>   after it, so a 29,019-SKU store recorded nothing.
> - Never overwrite a captured fact. Upsert with
>   `on_hand = COALESCE(feature_daily.on_hand, EXCLUDED.on_hand)` and
>   `WHERE feature_daily.on_hand IS NULL`.
>
> **Acceptance:** 30 consecutive days captured at the five GOOD stores with
> under 1% missing SKU-days.
>
> **What this unlocks:** R7 (true demand), R11 (real order quantity), the
> stockout and overstock card families, and the stockout half of the acceptance
> scorecard. **Nothing in P1 or P2 is possible without it.**

### R3. Lead times and delivery days per supplier

> `policy.lead_time_days.declared` is **7**, status PROVISIONAL, and its own
> registry note says it was verified four times: `purchases` has an order date
> and an invoice date and *zero* columns recording receipt; `purchase_orders`
> has the right columns and no rows. **Nothing anywhere records when an order
> arrived.** No analysis fixes this — only asking the stores does.
>
> **Build:** per-supplier lead time and delivery days, captured at onboarding,
> with defaults **explicitly flagged as defaults** so a card can say which.
>
> **Why it matters more than it sounds:** order quantity covers lead time *plus*
> the wait until the next ordering opportunity — 14 days on current
> assumptions. If the true lead time is 10 days rather than 7, every
> order-up-to level is about **21% too low**, and it would present as a
> forecasting error rather than an assumption error.
>
> **Acceptance:** every active supplier at each GOOD store has a lead time, and
> every defaulted value is marked as such and surfaced on the card.

### R4. Fix the reports

> Two of these inflate headline numbers and would be caught in minutes by a
> technical buyer.
>
> 1. **M1** — stop summing incremental margin across overlapping horizons.
>    Report money **per horizon**, headline at 30 days. Totals that add the
>    30/60/90/120-day windows of the same picks are counting one decision four
>    times.
> 2. **M2** — one engine run per decision date, graded at four horizons. (The
>    backtest re-runs per horizon *by design*, to answer "does it have skill";
>    the ledger runs once per day. Both are legitimate, but they must be
>    **labelled** so they cannot be confused.)
> 3. **M3** — no narrative sentence may be typed. Restore
>    `_calibration_verdict()`, which computes the shape of the curve the run
>    actually produced, and generate every other claim from data.
> 4. **M4** — print the permutation draw count beside the p-value. 0.0005 is
>    the add-one floor of **2,000 draws**, not of the 400 null baskets listed
>    next to it.
> 5. **M9** — tighten the quantity contract. A 1,000-unit cap against a
>    99th-percentile line of 20 units lets every plausible-looking error
>    through. Add a **per-SKU outlier rule** (reject a line above, say, 20× that
>    SKU's own 99th percentile) and **reject quantity equal to the SKU or the
>    barcode** — Mango Jo's had quantities of 8,245,805.
>
> **Acceptance:** a report regenerated from scratch contains no sentence that
> contradicts its own numbers. Diff two runs on the same data: only the
> timestamp changes.

---

## P1. Forecast every product

Nothing here is possible before R2 has 30+ days of on-hand.

### R5. `feature_daily` for the whole catalogue

> Today the engine forecasts only candidates that pass the gates. A forecaster
> needs every SKU on every open trading day.
>
> **Build:** one row per (store, SKU, open trading day) carrying `units`,
> `price`, `cost`, `stock_qty`, `is_open`, `promo_flag`, `temp_c`, `is_holiday`,
> `event_count`.
>
> **The rule that matters most:** a **closed day is absent, not zero.** A store
> shut on Sundays trades ~24 days a month; writing zeros for the other days
> understates every rate by 14% and that error has already shipped once on this
> codebase. `open_days` is the denominator, everywhere, forever.
>
> **Sizing:** 40–60M rows. Fix **R24** (42.8% of `sale_items` sits in the
> pre-April-2025 DEFAULT partition) before running multi-year queries over it,
> or every training job will be slow for a reason nobody can see.

### R6. Calendar features

> The M5 competition organisers called calendar, special-day and price variables
> **critical**, and liquor is more seasonal than most retail — one retailer puts
> the holiday period at 15–18% of annual sales.
>
> **Build:** day of week; holidays **with pre-holiday windows** (Thanksgiving
> Eve, Christmas, New Year's Eve, July 4th, Memorial Day, Labor Day, Super Bowl,
> St Patrick's Day, Cinco de Mayo — moving dates computed, not hardcoded);
> season; start-of-month and mid-month flags; a tax-refund window tested per
> store.
>
> **Why this may move accuracy more than any model change:** a product that dips
> in early March and recovers around St Patrick's Day is a **calendar effect
> the current engine reads as mean reversion**. It gets the direction right by
> accident and the timing wrong. Separating the two is the difference between a
> signal and a coincidence.
>
> **Caution on the measurement:** an earlier attempt to add seasonality as a
> raw ratio feature *hurt* every horizon (90-day hit rate 70.0% → 58.4%). Decile
> spread was ~11 points against reversion's 49–61. **Build it as a model
> feature, not as a ranking term**, and measure it against the three baselines
> in R10 before believing it.

### R7. True demand

> **The contamination that puts a ceiling on every number in every report.**
> A product that was out of stock looks exactly like a product that went quiet.
> The engine recommends it, it "recovers" on restock, and the hit is recorded as
> skill. The same error corrupts the grade *and* the selection.
>
> **Build:** for SKU-days where `on_hand` is at or near zero (from R2 onward
> only — this cannot be backfilled), impute unconstrained demand from that SKU's
> in-stock days and its cohort. Train **and grade** on the corrected series.
>
> **Acceptance:** report the share of SKU-days corrected, and re-run the
> Bethany March ledger on corrected demand. **State both numbers** — the hit
> rate on raw and on true demand. If the corrected number is lower, that is the
> honest one and it means earlier reports were flattered by stockouts.
>
> **This is the item most likely to change the answer to the 90% question**, in
> either direction, and the only one that makes the question answerable.

### R8. Demand classification and routing

> **Build:** classify each SKU by the Syntetos-Boylan quadrants (smooth,
> erratic, intermittent, lumpy) and route: Croston/SBA for intermittent, ETS for
> smooth, the global model for the rest.
>
> **Keep `deficit_units` and the reversion features as model inputs.** The
> reversion signal is real — it beats a reversion-matched null by +16.5 points
> at Bethany — it is just not sufficient on its own. It becomes a feature, not
> the whole engine.
>
> Classification already exists at `storeagent/forecasting/classify.py`. Check
> what it does before rebuilding it.

### R9. Global cross-store model

> **Build:** LightGBM with quantile outputs (p10/p50/p90) and per-store effects,
> trained across every store with clean, current sales — up to 48 syncing daily,
> 94 with history.
>
> **Demand forecasting needs units, dates and prices, not cost.** The 78 stores
> missing cost still contribute training signal; they only lack dollar ranking.
> That is 19.9M line items instead of five stores' worth.
>
> **The one hard constraint:** `app/pipeline/` is **pure stdlib** — no numpy,
> scipy, sklearn or LightGBM, enforced by `scripts/check_no_literals.py` and by
> design. So the model **trains offline** and the pipeline **consumes a fitted
> artefact** (coefficients/trees serialised to a payload). Do not add a numeric
> stack to the request path; it is a deployment dependency, a version-skew risk
> and a place for a silent NaN. The boundary is a file, as it is everywhere else
> in this architecture.

### R10. Backtest harness against three baselines

> **This is the acceptance gate for all of P1, and it should be built before
> R9, not after** — otherwise there is no way to tell whether the model helped.
>
> **Build:** WAPE against **trailing 28 days**, **same period last year**, and
> **12-month average**. Weighted by units *and* by margin. Report bias and
> p10–p90 coverage, broken out **overall, by category, and for holiday weeks**
> specifically.
>
> **Acceptance:** beats all three baselines at every GOOD store; bias within
> ±5%; coverage 75–85%.
>
> Reuse the existing harness rather than writing a third one:
> `scripts/real_engine_backtest.py` already does walk-forward with a date-
> clustered bootstrap, a reversion-matched null and a pooled permutation test.
> Add WAPE to it.

---

## P2. Decisions that move money

### R11. Inventory policy with real quantities

> **Build:** `order_up_to = demand over (lead_time + review_period)` at a
> service level set by margin, minus `on_hand` and `on_order`, rounded to case
> pack. Store reorder point, safety stock, suggested quantity and stockout
> probability.
>
> Sheet 10 (`app/pipeline/policy/inventory.py`) already implements this. What it
> lacks is real `on_hand` (R2) and a measured lead time (R3). **Do not rebuild
> it; feed it.**
>
> **The trap that already paged this engine once:** compare demand over the
> **coverage** window against an order sized for the coverage window. Sheet 14's
> first real run paged on all three store-171 decisions because it compared a
> coverage-sized order against horizon-sized demand. `coverage_demand()` exists
> for exactly this.

### R12. New card families

> **Build:** reorder *with a quantity*; holiday prep; "don't reorder" (over 90
> days of supply); dead stock with a cash value. Retire dip-only as the sole
> card type.
>
> Later commits (`88e8637`, `29d74b3`) have already added stockout and overstock
> cards — **check what exists before building**. What is missing from this list
> is holiday prep (needs R6) and quantities (needs R2 and R3).
>
> **Keep the family cap.** One family taking every slot is how a store gets told
> one thing ten times; `29d74b3` addressed this and the behaviour should stay.

### R13. Rank by expected dollars

> **Replace confidence as the sort key** with
> `P(correct) × margin gained − P(wrong) × cost of overstock or stockout`.
>
> **The evidence this is right is already measured, and it is the strongest
> finding in the assessment.** `p_hit` does not rank above its own floor:
> top-quintile hit rates are *below* bottom-quintile at three of four stores
> (Cork Runner 77% vs 80%, Marshfield 77% vs 94%, Northlake 66% vs 72%). On
> Bethany the bands run 72 → 70 → 74 → **86** → 76 — it peaks in the fourth
> fifth. The biggest earners sit at p_hit 0.50–0.60, near the floor.
>
> So `p_hit` works as a **gate** and not at all as a **ranking**, which means
> showing the top three cards instead of the top ten is **not reliably better**
> today. Expected dollars is the replacement, and it needs the downside term —
> which needs R2.

### R14. Calibrate confidence

> **Build:** isotonic calibration per store and per category. **Hide the raw
> score from owners** until calibration error is within ~5 points per band.
>
> Sheet 08 exists and ships as identity because it has never had outcomes to
> fit on. R1 provides them. The reason this matters: sheet 08's own measurement
> found stated confidence of **0.48 against a 0.23 actual hit rate** on the old
> engine. A confidence that lies is worse than none, because it both ranks the
> cards and gets printed on them.

### R15. Grade the promise

> **Build:** add `prediction_accuracy` (realised ÷ predicted extra units) and
> `service_level_met` to `recommendation_outcome`.
>
> **Already measured on the March ledger, and this is the number to fix:**
>
> | window | promised | delivered | accuracy | margin | cost of unsold | **NET** |
> |---|---:|---:|---:|---:|---:|---:|
> | **30d** | 1,540 | 912 | **59%** | +$1,122 | −$1,617 | **−$495** |
> | 60d | 1,540 | 2,037 | 132% | +$2,130 | −$1,598 | +$532 |
> | 90d | 1,540 | 3,254 | 211% | +$3,276 | −$1,284 | +$1,992 |
>
> **At its own 30-day horizon the engine is net negative once unsold stock is
> costed.** It is right about direction and wrong about size, which no hit rate
> can show.
>
> **Do not fix this by scaling the deficit on one month of one store.** Two
> readings fit the data — the deficit is calibrated for a longer window than the
> card claims, or a reorder acted on at 30 days ties up cash the sales have not
> yet justified. Measure across all five GOOD stores first, then decide whether
> to scale the promise or restate the window.

### R16. Repeat control

> Restore `lifecycle.py` (see **P-1**). Three rules: declining (fires early —
> that is the point), no recovery by the review window, stale. Plus
> **suppression after retirement**, without which retirement does nothing: the
> next morning re-earns the card from exactly the evidence just shown to be
> wrong.
>
> Measured effect at Bethany, March 2026: **162 cards → 69** at the same hit
> rate; Stroyski pulled after 3 days instead of 8; 17 retirements (13
> declining).
>
> **Add what the restored version lacks:** an early read at 7–14 days using
> daily sales, and multi-month decline detection — a product in structural
> decline should never get a recovery card at all.

### R17. Category gate

> **Build:** a category enters in **shadow** and goes live only when its
> outcome, calibration and holdout conditions pass.
>
> The machinery exists — sheet 17's gate already does shadow/live/suspended per
> store × family with a permutation test, `MIN_OUTCOMES=30`, `P_THRESHOLD=0.05`
> and a `SUSPEND_P_THRESHOLD=0.2` hysteresis. **Extend it to category rather
> than rebuilding it.**

---

## P3. Prove it

### R18–R20. Live pilot

> **Build:** a live pilot on the five GOOD stores, holdout **by SKU** (a hidden
> SKU stays hidden for the whole pilot — switching arms mid-pilot destroys the
> comparison), with owner action logged per card: acted, changed quantity,
> dismissed.
>
> **Run the power check first (R19).** Estimate the cards and the duration
> needed to detect a realistic effect *before* starting. A pilot that cannot
> detect the effect it is looking for is an expensive way to learn nothing, and
> the arithmetic takes an afternoon.
>
> **Target: live before Thanksgiving**, so the holiday weeks — 15–18% of annual
> sales — are inside the measurement window.
>
> **Report (R20):** extra margin per store per month, shown vs. held out, with
> a confidence interval. Plus stockout days on recommended SKUs and inventory
> value, both shown vs. held out — those two are what tell you whether the
> engine helped or just moved cash onto a shelf.

---

## P4. Data remediation, to scale past five stores

> Batch these; none blocks the pilot.
>
> - **R21** diagnose missing cost per POS integration at the 78 stores (not
>   exposed / not requested / dropped in transform — they need different fixes).
> - **R22** close the product-master gap: 43.8% of sold store-SKU pairs have no
>   `products` row, so no cost, category, pack size or on-hand.
> - **R23** triage the 62 majority-failing syncs; mark the 95 never-traded store
>   records dormant. **Related live risk:** a store that stopped syncing still
>   has `feature_daily` rows up to the day it stopped, so the engine will happily
>   compute a 28-day rate from stale data and recommend against it. Add a
>   **staleness gate** — no cards for a store whose feed is more than a few days
>   behind, stated on screen rather than silently.
> - **R24** backfill monthly partitions Dec 2022 → Mar 2025.
> - **R25** reconcile the local and Neon analytics databases; renumber the
>   duplicate `005` migration.
> - **R26** stand up the new analytics schema on its own instance, sized for
>   40–60M `feature_daily` rows.

---

## What to tell her about the target

Not "we will hit 90%". That would be a promise against a measurement that says
otherwise, and the first person to rerun the backtest would find out.

Instead:

> The engine is at **65% at 30 days against a 59% baseline that already knows
> about mean reversion** — so +16.5 points of real skill, significant at
> p = 0.0005. Three independent measurements put the ceiling on this metric at
> **~73%**, so we are closer to it than the gap to 90% suggests.
>
> We are also measuring on contaminated inputs: a stockout is indistinguishable
> from a dip, and calendar effects are being read as reversion. **We do not know
> what is achievable on clean inputs, and we cannot know until on-hand capture
> has run for a month.** That capture cannot be backfilled, which is why it is
> the first thing we are doing.
>
> The gap worth closing first is not 65% → 90%. It is **prediction accuracy of
> 59% and a net margin of −$495 at the horizon the card claims**. An engine that
> is right about direction and wrong about size is not yet sellable, and that is
> fixable with measurement rather than modelling.
