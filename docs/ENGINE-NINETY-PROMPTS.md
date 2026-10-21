# Engine Three — the ninety-percent prompts

Implementation prompts for the findings in
[the diagnostic](audit/ninety-percent-diagnostic.html). Each is self-contained:
paste one into a session or a ticket and it carries the context, the exact
contract, the acceptance bar, and **what it must not move**.

Ordered by dependency. Later prompts assume earlier ones, and the gates are
cumulative — do not start `N1` until `N0`'s gate is green, because `N1` is
measured with the ruler `N0` repairs.

**Branch:** `Enh_Engine_v1` · **Constraint:** `app/pipeline` is pure standard
library. No numpy, scipy, sklearn, statsmodels or LightGBM. OLS via normal
equations, isotonic by pool-adjacent-violators, bootstraps by resampling — all
of which are already in the codebase and are the precedent to follow.

---

## Read this before writing any code

### The two targets, stated so they cannot be gamed

| Target | Definition | Today | After |
|---|---|---|---|
| **90% accurate** | the card's **promise is kept** — realised units ≥ promised units — and its **stated confidence is calibrated** to within 10 points | promise kept at 1 of 5 stores · confidence uncalibrated | ≥90% at every store |
| **$1,000 a store** | **net** incremental margin per store per month, after the real cost of unsold stock | ~$370/store/month, measured on one family of eleven | ≥$1,000 |

**90% hit rate is not one of the targets and will not become one.** Three
independent measurements cap it near 73% (top decile 65–69%, best
worst-horizon 73.1%, best single card 71.1%), because at the order sizes a
liquor store trades in, one standard deviation of pure chance is ~27% of the
mean. Keep measuring it as a research metric for *selection*; never quote it as
the accuracy guarantee.

### Where the $1,000 comes from — the decomposition to hold yourself to

Current measured baseline: **+$51,052** incremental margin, 1,056 cards, five
stores, 52 decision dates across 2.3 years → **~$370 per store per month**, from
the **understock family alone**. That family is one of eleven in the UI.

| Source | Mechanism | Expected contribution |
|---|---|---|
| Sizing to `q*` instead of the mean | the engine currently under-orders — p50 is 14 where p91 is 19 on a 14-unit mean, and it hits 76% of the time | +$150–250 |
| Carrying-cost correction | reveals margin already earned and mis-charged as a full-COGS write-off | +$100–200 *(recovered, not new)* |
| Overstock / clearance family | freed capital and avoided markdown — a **different currency**, currently uncounted | +$150–300 |
| Bundle family, earned | measured basket uplift rather than a 0.7 literal | +$80–150 |
| Weather · calendar · news · trending, earned | spike pre-stocking where the effect is **estimated and non-zero** | +$150–350 |
| **Total** | | **$1,000–1,650** |

**This table is a projection, not a measurement.** Every row has a prompt below
whose gate measures it. If a row comes in at zero, it gets dropped and said out
loud — that is what `N3.4` and `N7.2` exist to enforce.

### The signal problem, diagnosed precisely

Eleven families appear in the UI. One produces measurable value. The other ten
are not broken plumbing — the plumbing is fine. They are broken **economics**:

```
app/recommender/families.py

  cold_box    confidence=0.55     ← a hardcoded literal
  pre_stock   confidence=0.55     ← a hardcoded literal
  bundles     confidence=0.7      ← a hardcoded literal
  stock_new   confidence=0.6      ← a hardcoded literal

  ExtraPick.units_at_stake = None for bundles
```

Four consequences, and all four have to be fixed together:

1. **No expected value, so no ranking.** An `ExtraPick` cannot be compared with
   a deficit-ranked reorder, so `pipeline.py` gives these families **reserved
   slots** — `limit = max_recommendations - len(extra)`. A weak weather card
   therefore displaces a strong restock card, and a genuinely large weather
   opportunity can never take more than one slot.
2. **The effect size is asserted.** `cold_box` picks the fastest-selling
   chillable SKU when a heat key is present. Nothing asks whether heat moves
   **this store's** seltzer, or by how much. `app/pipeline/elasticity/` is
   exactly the machinery for that question — OLS with HC1-robust standard errors
   and a refusal when the interval spans zero — and it is wired only to price.
3. **The triggers are very narrow.** Twenty modules under `app/signals/` funnel
   into two trigger sets: `HEAT_KEYS = ("heat_advisory", "heat_", "hot_")` and
   `EVENT_KEY_PREFIXES = ("nhl_", "nfl_", "nba_", "mlb_", "ncaa_",
   "news_festival", …)`. A cold snap, a storm, a long weekend, a payday, a
   liquor-tax change: nothing.
4. **Measured, this layer lost.** Across **155 signal-driven recommendations the
   signal layer scored 6–10 points below random.** So switching all eleven
   families on without earning them first makes the engine **worse**, and the
   accuracy target moves further away. This is the single most important
   sentence in this document.

**So the design is not "turn the signals on". It is: put every family on one
currency — expected incremental margin × calibrated probability — and make each
signal's coefficient something the store's own history had to supply.** A signal
that cannot clear that bar does not appear in the arithmetic, and therefore does
not appear in the sentence.

---

# N0 · Repair the ruler

Nothing below N0 can be trusted until these three land, because every later gate
is measured with them.

### N0.1 — Carrying cost, not a COGS write-off

`scripts/daily_recommendation_ledger.py:203` charges over-ordering as
`over_units × unit_cost` — the entire cost of goods, as though unsold stock were
destroyed. Liquor does not spoil. A case of bourbon unsold in April is on the
shelf in May.

Replace it with the real cost of holding:

```python
def holding_cost(over_units: float, unit_cost: float, days_held: int,
                 ctx: RunContext, config: Config) -> float:
    """What it actually costs to hold stock that did not sell this window.

    NOT unit_cost. Unsold spirits are inventory, not loss. The cost is the
    capital tied up plus the shelf it occupies plus the chance it never
    sells - and for spirits that last term is near zero, which is exactly
    why the previous model overstated the downside by one to two orders of
    magnitude on the products this engine recommends most.
    """
    wacc = config.get(COST_OF_CAPITAL_ANNUAL, ctx)        # new Setting
    shelf = config.get(SHELF_OPPORTUNITY_PER_UNIT_DAY, ctx)
    hazard = config.get(OBSOLESCENCE_HAZARD, ctx)          # by category family
    capital = unit_cost * wacc * (days_held / 365.0)
    return over_units * (capital + shelf * days_held + hazard * unit_cost)
```

- Three new `Setting`s, all `PROVISIONAL`, each with a `why` that says what would
  make it `MEASURED`. `OBSOLESCENCE_HAZARD` is per category family: near zero for
  spirits, real for dated, seasonal or limited stock.
- **Do not** silently default a missing `unit_cost` to anything. Five of ten
  audited stores send no cost at all; those stores must return an **absence**, and
  the report must print "no cost data", never "$0".

**Acceptance:** `test_holding_cost_is_not_cogs` — a $20 bottle held 30 extra days
costs under $1, not $20. `test_holding_cost_absent_without_cost` — no unit cost
gives `None`, and `None` does not become zero anywhere downstream.

**Gate:** re-run `run_all_ledgers.py` across all five pilot stores and publish
the before/after table. **Expect the sign to change at two or three stores.**
That is a measurement correction, not a win — say so in the report.

---

### N0.2 — Net margin per card becomes the primary scored outcome

Hit rate answers a research question. The business runs on money. Make the money
figure first-class, per card, at every horizon:

```python
net_margin_per_card = (realised_units - expected_units) * unit_margin
                    - holding_cost(over_units, unit_cost, days_held, ...)
```

- Report it **per card** and as a **clustered** interval over decision dates,
  never as a raw total — the arms place different numbers of bets and a total
  compares a rate to a volume.
- Keep `margin_captured` (total flow touched) as a **separate, labelled** column.
  It is not a result; the old ordering showed the largest captured flow ($215k)
  and a *negative* incremental.

**Acceptance:** `test_net_margin_is_incremental_not_total` pins
`(sold − expected) × margin`, and a case where total is positive while
incremental is negative.

**Gate:** every store's report leads with net margin per card and its interval.

---

### N0.3 — Turn the holdout on

`REC_HOLDOUT_PCT = 0`. One flag, and it unblocks four components that are built
and idle: `calibrate/fit.py`, `calibrate/monitor.py`, `gate/matched.py`, and any
causal claim at all.

- Set it to **20**.
- Assignment must be **deterministic** from `(client_id, location_id, sku,
  decision_date)` so a rerun scores the same arms — a random assignment makes
  the backtest unreproducible.
- The withheld arm is scored **identically** and shown to nobody.

**Acceptance:** `test_holdout_assignment_is_stable` — same inputs, same arm,
across processes. `test_withheld_never_reaches_a_card`.

**Gate:** `recommendation_evaluations` row count is non-zero and rising daily.
Until this is true, **N2 is impossible** — the calibration curve has nothing to
fit and `calibrate/apply.py` will keep returning `no_fit_for_cell`.

---

# N1 · Split the promise from the order

This is the highest-leverage change in the engine and it is arithmetic.

### N1.1 — Promise a quantity reality clears 90% of the time

`deficit_units` is an **expectation**. For a product whose true rate is 14 units
per 30 days, the probability that reality reaches its own mean is **53.5%** — so
a promise built on the mean fails about half the time *with a perfect forecast*.

```
promise 14  (the mean - what the card says today)   kept 53.5%
promise 12                                          kept 74.0%
promise 11  (p25)                                   kept 82.4%
promise 10                                          kept 89.1%   <- the target
promise  9  (p10)                                   kept 93.8%
```

Add a second field; **do not** repurpose the first:

```python
@dataclass(frozen=True, slots=True)
class RevertedDemand:
    ...
    deficit_units: float      # UNCHANGED - the RANKING quantity
    promise_units: float      # NEW - the quantile the card may state
```

```python
PROMISE_QUANTILE = Setting(
    name="reversion.promise_quantile",
    default=0.10,
    unit="quantile, 0..1",
    owner="commercial",
    why="PROVISIONAL pending the first measured promise-kept run. At 0.10 a "
        "Poisson mean of 14 is kept 93.8% of the time and at 0.20 about 89%. "
        "The target is a kept rate of 90%, so this is the dial that sets it - "
        "and it is a PROMISE dial, never an ORDER dial. Raising it makes the "
        "card claim more and keep its word less",
    status="PROVISIONAL",
)
```

**Guardrails, and they matter:**

- `deficit_units` **must not change.** The +16.6 point edge over a
  reversion-matched null was measured on that ordering. Changing it invalidates
  the result and the whole audit has to be re-run.
- The promise quantile comes from the **forecast's own interval**, not from a
  normal approximation. The interval is already empirically calibrated to 80–82%
  coverage; use it.
- Where no usable interval exists, the card states **a range or nothing** — it
  does not fall back to the mean.

**Acceptance:** `test_promise_is_below_the_mean_for_a_lumpy_sku`,
`test_promise_absent_without_an_interval`,
`test_deficit_units_is_byte_identical_to_v1_1_0` — a regression pin over the
stored backtest so this prompt cannot silently move the ranking.

**Gate:** **promise kept lands in 85–95% at every pilot store.** Not 100% — a
promise kept 100% of the time is a promise that was not worth making.

---

### N1.2 — Order to the economic quantile, through the module that already exists

`app/pipeline/policy/inventory.py` computes `z(service_level) · σ · √lead`, takes
σ from the p10–p90 interval, computes the divisor from the quantile settings
rather than hard-coding 2.563, and **refuses** a forecast with no usable
interval. It is the strongest module in the engine and the live route does not
call it. The live route does:

```python
qty = max(1, int(round(p.deficit_units)))     # app/recommender/deterministic.py
```

A mean. No σ, no lead time, no review period, no on-hand.

**Route the live path through `policy.inventory`.** Keep the deficit as the
ranking quantity; let the policy module own the quantity the owner is told to
buy.

**Acceptance:** `test_live_route_uses_policy_quantity` asserts the card's order
quantity equals `ideal_qty` from the policy module for a fixture store, and
`test_route_refuses_quantity_without_interval`.

**Gate:** no card states an order quantity that did not come from
`policy/inventory.py`, and `constraints/apply.py` (case packs, MOQ, shelf caps)
runs after it so the card can explain why 37.4 became 24.

---

### N1.3 — Derive the service level instead of declaring it

`SERVICE_LEVEL_BY_FAMILY` is a `Setting` per category family, `PROVISIONAL`,
"awaiting commercial sign-off". It does not need sign-off. The service level
**is** the newsvendor critical fractile and it is computable per SKU:

```
q* = Cu / (Cu + Co)

Cu = unit margin                     (price - cost)
Co = holding cost for one cycle      (N0.1's holding_cost for one unit)

$10 margin, $0.50 carrying  ->  q* = 95.2%
$10 margin, $1.00 carrying  ->  q* = 90.9%     order to the p91
$10 margin, $4.00 carrying  ->  q* = 71.4%
```

Because liquor does not spoil, `Co` is small and `q*` is **high** — the engine
should stock these generously. That is the opposite of what promising the mean
does, which is the whole point of splitting the two numbers.

- Keep `SERVICE_LEVEL_BY_FAMILY` as the **fallback** where cost is absent — five
  of ten stores — and mark the computed path `MEASURED`, the fallback
  `PROVISIONAL`.
- The card says which one it used.
- Clamp `q*` into `[0.70, 0.98]`. An unclamped fractile on a thin-margin,
  high-carrying SKU can ask for a quantile the interval cannot support.

**Acceptance:** `test_q_star_from_margin_and_holding`,
`test_q_star_falls_back_without_cost`, `test_q_star_is_clamped`.

**Gate:** **net margin per card is positive at ≥4 of 5 stores** at the 30-day
horizon, measured with N0.1's ruler.

---

# N2 · Earn the confidence number

### N2.1 — Fit the calibration curve from holdout outcomes

Today `deterministic.py` sets `confidence = p_hit`, where
`p_hit = s/(1+s)` and `s = uplift × steadiness` — a closed-form ratio.
`validator.py` then calls `_apply_calibration`, which looks for an isotonic fit
per `(family × demand_class)` cell, finds none, returns
`no_fit_for_cell:{family}/{demand_class}`, and passes the raw value through.
It is working exactly as designed and it has nothing to work with.

**So a card saying "74% likely" has never been checked against reality, and that
number also multiplies into the ranking score.**

With N0.3 on, outcomes accumulate. Fit the curve:

- Cells: `(family × demand_class × velocity_band)`. Add the velocity band — a
  1-unit-a-month SKU and a 40-unit-a-month SKU do not share a reliability curve,
  and the existing two-way cell pools them.
- Minimum ~50 outcomes per cell before a cell is used; below that, fall back to
  the parent cell, then to the global curve, then to a **stated band**.
- Pool-adjacent-violators isotonic, as `calibrate/fit.py` already implements.

**Acceptance:** `test_isotonic_is_monotone`,
`test_cell_falls_back_to_parent_below_minimum`,
`test_reason_is_recorded_on_every_passthrough`.

**Gate:** **ECE < 5 points** on held-out outcomes, from
`calibrate/monitor.py`, which already computes it.

---

### N2.2 — Make calibration a build gate, not a dashboard

```python
# a card may not state a confidence it has not earned
if abs(bin_observed_rate - stated_confidence) > MAX_RELIABILITY_DEVIATION:
    # state a band, or state nothing. never state a number that is wrong.
```

- Publish the reliability diagram in the per-store report, next to the hit rate.
- A family whose curve deviates by more than 10 points in any populated bin is
  **suspended** for that store — `calibrate/apply.py` already has
  `suspended_families` plumbed through `ApplyRequest`.

**Acceptance:** `test_card_with_unreliable_confidence_states_a_band`,
`test_suspended_family_does_not_reach_a_card`.

**Gate:** no card in any store's report states a confidence whose bin deviates
by more than 10 points.

---

# N3 · One currency for all eleven families

This is the ensemble. **It is not a model-blending exercise** — it is making
every family quote its value in the same units so they can be compared at all.

### N3.1 — Every family returns expected value, or it does not rank

Replace `ExtraPick`'s hardcoded `confidence` with the same contract the
deficit families satisfy:

```python
@dataclass(frozen=True, slots=True)
class FamilyPick:
    """What EVERY family must return. One currency, no exceptions.

    The four literals this replaces - 0.55, 0.55, 0.7, 0.6 - are why the
    signal families get reserved slots instead of competing: a hand-written
    confidence cannot be ranked against a measured one, so the slate was
    carved up by family rather than by value.
    """
    family: str
    category: str
    action_type: str
    primary_skus: tuple[str, ...]

    units_at_stake: float          # the units this card is ABOUT. never None.
    unit_margin: float | None      # None when the store sends no cost
    raw_confidence: float          # goes THROUGH calibration, never around it
    horizon_open_days: int

    effect: SignalEffect | None    # N4 - the estimate that earned this card
    provenance: str                # which component produced each figure
```

Then every family computes `expected_value = units_at_stake × unit_margin` and
`score = expected_value × calibrated_confidence × urgency` through the **existing**
`rank/score.py`. No family keeps its own scoring.

**Per family, what `units_at_stake` means — and all of these are already
derivable from data the context carries:**

| Family | `units_at_stake` | Already available from |
|---|---|---|
| understock | `max(0, deficit_units)` | unchanged — sheet 20 |
| overstock / clear | units above the policy's `order_up_to` | `policy/inventory.py` |
| weather `cold_box` | `effect.beta × baseline_units` over the signal window | N4.1 |
| calendar & sports `pre_stock` | same, with the event's own window | N4.1 |
| news `pre_stock` | same | N4.1 |
| bundle | incremental units on the **attached** SKU, from basket lift | `co_purchases` support |
| new & trending `stock_new` | the area cohort's first-30-day velocity | `area_winners` |

**Guardrails:**

- `units_at_stake` may **never** be `None`. A family that cannot compute it is a
  family that cannot rank, and it must refuse rather than pass a sentinel.
- `raw_confidence` goes **through** `calibrate/apply.py`. The whole point of N2
  is defeated by a family that stamps `calibrated_confidence` itself.
- Nothing multiplies a **ratio** by margin. `p_hit` is a probability; only unit
  counts may be turned into dollars. This defect has been removed twice already.

**Acceptance:** `test_every_family_returns_units_at_stake`,
`test_no_family_sets_calibrated_confidence_directly`,
`test_ratio_never_multiplied_by_margin`. Add a **build guard** —
`scripts/check_families_quote_ev.py`, in the style of the two existing guards —
that fails CI if any family constructs a pick without `units_at_stake`.

---

### N3.2 — Delete the reserved slots

```python
# app/recommender/pipeline.py - what to remove
limit = max(1, self._settings.max_recommendations - len(extra))
```

Reserved slots were a reasonable workaround for families that could not be
ranked. After N3.1 they can be, so:

- Build **one candidate pool** from all eleven families.
- Rank it with `rank/score.py`.
- Keep the existing **family cap** (`FAMILY_CAP_SHARE`) so one family cannot take
  the whole slate — that is diversity, which is a product decision, not a
  ranking failure.
- Keep the separate budget for `social_trending` only if it survives its own
  measurement in N3.4. Otherwise it competes like everything else.

**Acceptance:** `test_one_pool_one_ranking`,
`test_strong_weather_card_can_outrank_a_weak_reorder`,
`test_family_cap_still_holds`.

**Gate:** slate composition changes, and the per-family net margin table from
N3.4 shows **why** each change happened.

---

### N3.3 — Count the overstock money, which is a different currency

Two of the eleven families are overstock. Their value is **not** incremental
margin — it is **capital released** and **markdown avoided**. Counting them in
the same column as a restock card would be wrong, and leaving them uncounted is
why they look worthless.

```python
@dataclass(frozen=True, slots=True)
class ClearValue:
    capital_released: float      # units_over x unit_cost - cash back on the shelf
    markdown_avoided: float      # hazard x unit_cost x units, if it ages out
    margin_sacrificed: float     # the discount given to move it
    net: float                   # released x carrying_rate + avoided - sacrificed
```

- Report it in its own column, labelled, and **also** in a single "total benefit"
  figure so a store owner sees one number.
- The clearance recommendation is only made when `net > 0` — which is a real
  gate, because discounting stock that would have sold anyway is a pure loss.

**Acceptance:** `test_clear_refused_when_net_is_negative`,
`test_capital_release_not_counted_as_margin`.

**Gate:** the overstock families report a non-zero, signed net benefit per store,
and it reconciles to the store's own shelf.

---

### N3.4 — Measure every family separately, and drop the ones that lose

**The signal layer previously scored 6–10 points below random across 155
recommendations.** So this prompt is not optional bookkeeping — it is the thing
that stops N3 making the engine worse.

Extend `scripts/real_engine_backtest.py` to report **per family**:

| Family | cards | hit rate | reversion-matched null | edge | p | net margin / card | promise kept |
|---|---:|---:|---:|---:|---:|---:|---:|

- Each family gets its **own** reversion-matched null. A weather card and a
  reorder card do not share a baseline.
- Pooled permutation with add-one p-values; date-clustered bootstrap. A family
  with fewer than ~30 cards gets an interval and **no verdict**.
- A family whose net margin per card is not significantly positive is
  **suspended**, not quietly down-weighted, and the report says which and why.

**Acceptance:** `test_per_family_null_is_family_matched`,
`test_family_below_thirty_cards_gets_no_verdict`.

**Gate:** a per-family table exists for all eleven families at all five stores.
**Families that do not earn their place are switched off in the same commit as
the measurement that condemned them** — and `ENGINE-ENHANCEMENTS.md` §11 gets a
new row for each.

---

# N4 · Make every signal earn its coefficient

### N4.1 — Signal elasticity, by the pattern price elasticity already set

`app/pipeline/elasticity/estimate.py` estimates `ln(units) = α + β·ln(price) +
dow + month + ε` with HC1-robust standard errors, and `guard.py` **refuses any
card citing a price effect whose interval spans zero**. That is exactly the
discipline the signals need, and it is applied to price only.

Generalise it. For each signal key, estimate that signal's effect on **this
store's** units, per category:

```
ln(units + 1) = α + β·signal_active + dow + month + trend + ε

  β = 0.22  [0.09, 0.35]   usable: heat lifts this store's seltzer ~25%
  β = 0.05  [-0.18, 0.28]  UNUSABLE: the interval spans zero. no card.
```

- One `β` per **(store × category × signal_key_family)**. Shrink it toward the
  cohort's `β` with the registry's existing `k` machinery — a store with four
  past heat advisories has almost no information of its own.
- `signal_active` is built from the **historical** signal record. If signals were
  not persisted historically, **this prompt starts by persisting them** — and
  that is `N4.3`.
- Reuse `guard.py`'s refusal verbatim. Do not write a second one.

**Guardrails:**

- Expect **most intervals to span zero**, especially at low-volume stores. The
  price module says so explicitly and it is the correct answer, not a failure.
  A signal layer that finds an effect everywhere is the 6-to-10-points-below-random
  layer rebuilt.
- Confounding runs **toward** finding an effect: a festival is scheduled for a
  weekend that was going to be busy anyway. The `dow`, `month` and `trend`
  controls absorb the crudest of it and none of the competitor effect. Say this
  on the card's provenance line.

**Acceptance:** `test_signal_beta_refused_when_interval_spans_zero`,
`test_signal_beta_shrinks_toward_cohort_when_thin`,
`test_dow_and_month_controls_present`.

**Gate:** for each store, a table of every signal key tried, its `β`, its
interval, and `USABLE` / `REFUSED`. **Refusals are the expected majority** and
the report leads with the count.

---

### N4.2 — Widen the triggers, now that they are safe to widen

Only once N4.1 gates them. Twenty modules under `app/signals/` currently funnel
into two narrow trigger sets:

```python
HEAT_KEYS = ("heat_advisory", "heat_", "hot_")
EVENT_KEY_PREFIXES = ("nhl_", "nfl_", "nba_", "mlb_", "ncaa_", "news_festival", …)
```

Add trigger families, each one a key whose `β` must be estimated before it can
produce a card:

| New trigger | Why it plausibly moves liquor | Source module |
|---|---|---|
| cold snap / first freeze | whiskey, brandy, hot-drink mixers | `weather.py` |
| sustained rain or storm | footfall down, basket size up | `weather.py` |
| long weekend / public holiday eve | the largest predictable spike there is | `holidays.py` |
| payday proximity | fortnightly basket-value rhythm | `features/calendar.py` |
| local festival or concert | already partly covered by `news_festival` | `events.py` |
| graduation / wedding season | sparkling, gifting sizes | `holidays.py` |
| competitor promotion visible in news | a dip that is **not** to be recovered | `news_analyst.py` |
| tax or regulation change | price-level shift, not a demand dip | `news_analyst.py` |

**The last two are the most valuable on this list and they are the opposite of
recommendations:** they tell the engine *not* to recommend a recovery, because
the dip has a cause. A signal that suppresses a bad card is worth as much as one
that creates a good card and costs nothing in coverage.

**Acceptance:** one test per trigger family proving a key is emitted, and
`test_unestimated_trigger_produces_no_card`.

**Gate:** each new trigger appears in N4.1's table with a `β` and a verdict
before it is allowed to produce a card for any store.

---

### N4.3 — Persist the signal record, because β cannot be fitted without it

`β` needs history: which signals were active on which dates, per store. If that
is not already stored, nothing in N4 is estimable.

- One append-only table: `signal_history(client_id, location_id, as_of,
  signal_key, strength, source, captured_at)`.
- Written **nightly**, by Node — Node remains the sole writer of
  `bottleai_analytics`, and Python stays stateless with no analytics
  credentials. This constraint is not negotiable.
- Backfill what is reconstructible (holidays, sports fixtures, moving dates are
  all **computable** — `features/calendar.py` already does this and a 2031 run
  needs no edit). Weather and news are **not** reconstructible cheaply, so
  capture starts now and `β` for those keys stays `REFUSED` until enough history
  exists.

**Acceptance:** `test_signal_history_is_append_only`,
`test_computable_keys_backfill_exactly`.

**Gate:** `signal_history` has rows for every pilot store, and the count of
distinct `signal_key`s with ≥20 active days is reported weekly — that count is
the leading indicator for how many signals will ever be usable.

---

# N5 · Connect what is already built

### N5.1 — Lifecycle and the merchandise contract onto the live route

Both are built, tested, and only exercised by the audit harness.
`app/pipeline/candidates/lifecycle.py` cut 162 March cards to **69 at the same
hit rate** and pulled a failing card after 3 days instead of 8.
`app/pipeline/candidates/merchandise.py` refuses 45 of 44,398 SKUs (0.10%) after
a near-miss that would have deleted real stock.

- Wire `lifecycle` into `deterministic.choose`, before any card is issued. It
  needs card memory, so it needs the issued-card history — which N0.3's
  evaluation rows now provide.
- Replace `deterministic.is_merchandise` with
  `candidates.merchandise`. Keep the route's blocklist as an **additional**
  screen, not a replacement; it catches register mechanics the catalogue filter
  does not.
- Bring `constraints/apply.py` with them so case packs, MOQ and shelf caps apply
  to N1.2's quantity.

**Guardrail:** all day counts in `lifecycle` are **open** days. A store shut on
Sundays reaches its day-7 review after eight calendar days and the rule must not
fire early for that.

**Acceptance:** `test_route_retires_a_declining_card`,
`test_retired_card_is_suppressed_for_fourteen_open_days`,
`test_route_uses_the_catalogue_merchandise_filter`.

**Gate:** no SKU appears on consecutive days while failing, and the 162→69
reduction reproduces in production.

---

# N6 · Fix the inputs

### N6.1 — Treat stockouts as censored, not as zero demand

No module distinguishes "nobody wanted it" from "there was none to sell". The
damage runs both ways: the rate is biased **low**, so the deficit is
**overstated** and the engine over-promises; and the grade is corrupted, because
a restock scores as predicted skill.

**Two halves. Do the first now:**

```python
def probable_stockout(sku: str, day: date, ...) -> bool:
    """A SKU with an established rhythm that sold zero while its CATEGORY
    traded normally. Estimable today, from data already in the warehouse.
    """
```

Censored days leave the **denominator** — they are not counted as zero demand.
Validate the inference against the stores that do carry on-hand before trusting
it anywhere else.

**The second half is `N6.3` and it is not engineering.**

**Acceptance:** `test_censored_day_leaves_the_denominator`,
`test_zero_on_a_quiet_category_day_is_not_censored`,
`test_inference_agrees_with_on_hand_where_available`.

**Gate:** `r_long` rises for SKUs with inferred stockouts, the deficit falls, and
**promise kept improves** — which is the test of whether this was real.

---

### N6.2 — The right method for intermittent demand

`app/pipeline/blend/shrink.py` says it outright: *"intermittent SKUs are the
majority"*. The method applied to them is a shrunk **mean**. For a SKU selling in
bursts of six every three weeks, 0.28 units a day is arithmetically true and
operationally meaningless. There is a `demand_class` threaded through the
calibration cells and the forecast is documented as using "the method the demand
CLASS selects" — but there is no `app/pipeline/forecast/` module and no Croston,
SBA or bootstrap anywhere.

- Classify properly: **Syntetos–Boylan** on average inter-demand interval and the
  squared coefficient of variation → `smooth` / `erratic` / `intermittent` /
  `lumpy`.
- Route by class: shrunk mean for `smooth`, **Croston/SBA** for `intermittent`,
  **empirical bootstrap over historical windows** for `lumpy`.
- The bootstrap also produces an **honest interval** instead of a fitted band,
  which partly retires the three-attempt interval workaround (91–93% too wide,
  37–62% too narrow, 80–82% empirical).
- Pure standard library. A bootstrap is; a gradient-boosted model is not.

**Acceptance:** `test_syntetos_boylan_boundaries`,
`test_croston_beats_shrunk_mean_on_intermittent_wape`,
`test_bootstrap_interval_coverage_in_band`.

**Gate:** **bias inside ±5% at all four horizons**, not only 30 and 60 (today:
+0.6%, +3.5%, +6.7%, +8.8%), and interval coverage ≥90% at p5–p95.

---

### N6.3 — Capture what cannot be backfilled

Not engineering, and the hardest-stopping item on this list. Every night without
it is evidence permanently lost.

| Capture | Unblocks |
|---|---|
| **Nightly on-hand per SKU** | the stockout/slow-seller confusion that caps selection accuracy near 73%; a real reorder point instead of an assumed one |
| **Received / delivered dates** | lead time becomes measured per vendor instead of declared on every card. `purchase_orders` has the right columns and **zero rows at four of five stores** — one conversation per store |
| **Price-change events** | a dip caused by a competitor promotion is not a dip to recover from. Realised prices are stored; the **event** is not |

**Gate:** on-hand snapshots exist for every pilot store, dated from the night
this starts.

---

# N7 · Decide as a portfolio

### N7.1 — Budget, and abstention as a valid answer

Selection is top-k by score with a family cap. There is no cash or shelf budget
across the slate, so an owner with $2,000 of free cash receives $8,000 of advice
and silently picks — which means the engine's ranking is being overridden by
whoever reads it.

- Take a `cash_budget` and a `shelf_budget` per store (declared `Setting` until
  somebody measures them, surfaced on the slate).
- Choose the slate by **greedy ratio under budget** — expected net margin per
  dollar committed — not top-k. Greedy is sufficient, auditable and
  deterministic; a true knapsack is not worth the explanation cost.
- **Abstention is a first-class outcome.** If no candidate clears an expected
  **net** margin of zero, the slate is empty and says so: *"nothing worth doing
  today"*. An empty slate is an answer, and the engine never returns an error.

**Do not** reach 90% by raising the `p_hit` floor. The engine's own settings
already price that path: 0.50 gives 75.9% at 5.1 cards a run; 0.55 buys about one
point, cuts coverage to 2.4 cards and **halves the margin**. A dashboard reading
90% beside an empty slate is a worse product than one reading 76% with five
useful cards. Abstention is different: it withholds cards whose **expected
profit** is negative, and it publishes the coverage it chose.

**Acceptance:** `test_slate_respects_cash_budget`,
`test_empty_slate_is_a_valid_response`,
`test_greedy_ratio_beats_top_k_on_net_margin`.

---

### N7.2 — The two targets as measured gates

Add both to `run_all_ledgers.py` and to the index, per store, never pooled:

```
GATE A - ACCURACY
  promise kept                     in 85-95%           at every store
  calibration ECE                  < 5 points          at every store
  interval coverage (p5-p95)       >= 90%              at all four horizons
  no card states a confidence whose reliability bin deviates > 10 points

GATE B - PROFIT
  net margin per store per month   >= $1,000           at every store with cost
  per-family net margin            signed and published, all 11 families
  coverage (cards per run)         published beside every accuracy figure
```

- A store failing either gate is published **in red with DO NOT SHIP**, as the
  index already does. The most useful row on that page is the store where it
  does not work.
- Stores sending **no cost data** — five of ten audited — report Gate A only, and
  their money columns read "no cost data", never "$0". The falsy-zero class
  (`s.get("cost") or 1.0`) has already been caught once; the guard stays.

**Gate:** both gates green at ≥4 of 5 pilot stores before this reaches a
customer, and the failing store published rather than dropped.

---

# N8 · Seasonal and event playbooks

A ready-made plan per event — Super Bowl, Thanksgiving, Diwali, New Year's Eve
and twenty-odd more — built from the store's own history, delivered as an order
list **4 to 6 weeks ahead**.

### Why this is not the seasonality that was already rejected twice

This matters before any code is written, because the obvious objection is that
seasonality has lost on this engine **twice**:

| What was tried | What happened |
|---|---|
| Seasonality as a **ranking ratio** | 90-day hit rate 70.0% → **58.4%** |
| Seasonality as a **forecast multiplier** | lost at **0 of 4** horizons; 30-day bias +0.6% → **+9.2%** |

Both failures have the same cause: they applied a **continuous, store-level
busy-ness index** to the daily forecast, and the trailing 28-day window already
reflects current conditions — so the adjustment double-counted.

**A playbook is a different object.** It is discrete, dated and named; it has its
own window; it is estimated from *that event's own history at that store*; it
produces an **order list**, not a forecast adjustment; and **it does not touch the
daily forecast at all.** It is a new card family competing on N3's currency like
every other, not a modifier on an existing one.

If it is built as a multiplier on `rate_hat`, it will lose for the third time.

---

### N8.1 — The event calendar, computed and never tabulated

`app/pipeline/features/calendar.py` already computes moving dates: the anonymous
Gregorian computus for Easter, nth-weekday for Thanksgiving and Memorial Day, and
the Super Bowl's move to the second Sunday in February from 2022. Twenty-two
tests pin known-good dates across four years. Extend that module; do not start a
second one.

```python
@dataclass(frozen=True, slots=True)
class Event:
    key: str                  # "thanksgiving", "diwali", "nye", "super_bowl"
    name: str
    date_for: Callable[[int], date]   # year -> date. COMPUTED.
    window_pre_days: int      # the selling run-up this event actually has
    window_post_days: int
    may_suppress: bool        # True where the effect can legitimately be NEGATIVE
```

- **Luni-solar dates are the trap.** Diwali, Eid al-Fitr, Chinese New Year and the
  start of Ramadan are not nth-weekday rules. Compute them properly where a
  standard-library algorithm exists.
- Where an algorithm is genuinely too heavy for pure stdlib, **a table is
  acceptable only with an explicit end-of-validity year and a test that fails when
  the table runs out.** A silent wrong date in 2031 is worse than a build error in
  2030. This is the same discipline the calendar module already applies.
- `may_suppress` is not a courtesy. **Ramadan reduces alcohol demand in some trade
  areas**, and a negative `β` there is a correct, valuable result — it tells the
  engine not to pre-stock, and not to read the subsequent dip as something to
  recover.

**Acceptance:** `test_every_event_date_matches_known_good_for_four_years`,
`test_tabulated_event_fails_loudly_past_validity`,
`test_suppressing_event_may_return_negative_uplift`.

---

### N8.2 — Event uplift per store, shrunk hard, because n is 3

**This is the statistical heart of the prompt and the easiest thing to get
wrong.** The pilot stores have 3.7 years of history. That is **three or four
observations per event per store**. One store's Thanksgiving is `n = 3`.

An uplift estimated from three observations is noise. So this is the one place in
the engine where the peer cohort is genuinely load-bearing:

```
uplift_hat = (n_eff · u_own + k · u_cohort) / (n_eff + k)
```

- Same formula as sheets 06 and 20 — a **third axis**, across events. Use the
  registry's existing `k` machinery; do not introduce a new constant.
- `u_own` = this store's realised units in the event window versus its own
  baseline over the matched weekdays outside it.
- `u_cohort` = the same quantity across the peer cohort, which resolves at five
  levels and always resolves.
- **Refuse where the interval spans zero.** Reuse `elasticity/guard.py`. With
  `n = 3` most events at most stores will refuse, and that is the correct answer,
  not a failure of the estimator.
- The card **states its evidence level**: "based on your 3 previous
  Thanksgivings" is a different claim from "based on 14 similar Texas stores",
  and the owner should be able to tell which one they got.

**Acceptance:** `test_uplift_shrinks_to_cohort_at_n_equals_three`,
`test_uplift_refused_when_interval_spans_zero`,
`test_card_states_which_evidence_it_used`.

**Gate:** per store, a table of all 25+ events with `uplift_hat`, its interval,
`n_own`, the cohort level used, and `USABLE` / `REFUSED`. **Refusals are expected
to be the majority in year one** and the count is published.

---

### N8.3 — The playbook itself: one card, an order list, an alert date

A playbook is **one decision with many lines**, not thirty cards.

```python
@dataclass(frozen=True, slots=True)
class Playbook:
    event: Event
    alert_on: date            # event - window_pre - lead_time - safety_buffer
    lines: tuple[PlaybookLine, ...]   # sku, order_units, promise_units, why
    units_at_stake: float     # the SUM, so it ranks on N3's currency
    cash_required: float      # what the owner has to commit
    evidence: str             # "your 3 previous · 14 TX peers · cohort level 1"
```

- `order_units` per line comes from **`policy/inventory.py` at `q*`** over the
  event window (N1.2, N1.3). `promise_units` is the **p10** (N1.1). The two
  numbers are different and both appear.
- Then `constraints/apply.py` for case packs, MOQ and shelf caps, so the card can
  explain why 37.4 became 24.
- `alert_on` rests on a **declared** lead time, because `purchase_orders` is empty
  at four of five stores. **Say so on the card.** The 4-to-6-week promise is a
  consequence of that assumption, not a measurement.
- A playbook is the **largest single cash ask the engine makes**, so it is where
  N7.1's budget constraint matters most. A playbook that does not fit the cash
  budget is **trimmed by expected net margin per dollar**, line by line, and the
  card says what was trimmed and why.

**Acceptance:** `test_playbook_is_one_card_not_many`,
`test_alert_date_accounts_for_lead_time_and_window`,
`test_playbook_trimmed_to_cash_budget_keeps_best_ratio_lines`,
`test_order_and_promise_are_different_numbers`.

---

### N8.4 — Grade a playbook as one bet, and pool to get any power at all

A playbook fires **once a year**. One store-year is `n = 1`, so a playbook can
never be significant on its own — and reporting a per-store verdict on `n = 1`
would be the row-wise-bootstrap mistake again, which was already caught and
thrown away once.

- Grade the playbook **as a unit**: did realised units over the event window clear
  the promised total, and what was the net margin after N0.1's holding cost.
- **Pool across stores and across events** for any verdict. State the pooling
  explicitly in the report — this is the one family whose evidence is necessarily
  cross-sectional.
- Backtest is straightforward and cheap: 3.7 years of history contains three or
  four occurrences of every event, so a walk-forward over past events is available
  **today**, before any live playbook ships.

**Acceptance:** `test_playbook_graded_as_one_unit`,
`test_no_per_store_verdict_on_one_occurrence`.

**Gate:** pooled across stores — playbook **promise kept ≥ 85%** and **net margin
per playbook significantly positive**. A playbook family that fails this is
switched off in the same commit as the measurement, and gets a row in
`ENGINE-ENHANCEMENTS.md` §11 like every other rejected idea.

**Where the value plausibly is:** this is mostly a seasonal view of reorder data
that already exists, so the engineering is modest. The value is in **lead time**
— an owner told six weeks ahead can negotiate, consolidate a delivery and use
supplier terms, none of which is available to an owner told three days ahead. That
benefit is real and it is **not** incremental margin on units; if it is claimed,
it has to be measured separately, and N8.4 does not pretend to measure it.

---

## The order, and why

```
N0  ruler          1-2 wk   nothing is trustworthy until the measurement is
N1  promise/order  3-4 wk   the 90% promise and most of the profit. ARITHMETIC
N2  confidence     3 wk     needs N0.3's outcomes. blocks every accuracy claim
N3  one currency   4 wk     the ensemble. needs N1's EV contract
N4  signal betas   4-5 wk   needs N4.3's history first. REFUSALS EXPECTED
N5  connect        2 wk     can run in parallel with N3
N6  inputs         5-6 wk   N6.3 starts on day one regardless - it is capture
N7  portfolio      3 wk     last, because it needs every family's real EV
N8  playbooks      3-4 wk   needs N1, N3 and the cohort prior. BACKTESTABLE NOW
```

**Start today:** `N0.3` (one flag), `N6.3` (on-hand capture), `N4.3` (signal
history). All three are collection, all three are lost forever if deferred, and
none of them blocks on code review.

**The one-line summary for a standup:** the engine is not inaccurate because the
model is weak — it reports an average as though it were a floor, states a
confidence nobody has checked, and ranks ten of its eleven families on
hand-written literals. Fix those three and 90% is arithmetic.
