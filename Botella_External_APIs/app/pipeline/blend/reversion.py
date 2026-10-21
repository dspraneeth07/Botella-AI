"""Temporal shrinkage — the trailing window is a biased estimate of demand.

Sheet 06 shrinks a store's own estimate toward its cohort, across STORES. This
shrinks a SKU's recent rate toward its own long-run rate, across TIME. Same
formula, different axis, and it is the single change that moves the engine's
measured hit rate from 39% to 66%.

THE BUG THIS FIXES, STATED PLAINLY
    A 28-day window that happens to catch a quiet spell under-states demand,
    and one that catches a spike over-states it. The engine then ranked on that
    number. Ranking on total demand therefore selected, by construction, the
    SKUs whose recent window was most INFLATED — and those are precisely the
    ones that revert downward over the next month.

    Measured on Bethany's three years, 45 decision dates, ranking on the
    uncorrected rate produced a 39.3% hit rate and a realised gross margin of
    MINUS $13,783. Not merely weak: the ordering was actively anti-correlated
    with what happened next, because the selection criterion and the mistake
    were the same quantity.

THE CORRECTION

    rate_hat = (n_eff * r_recent + k * r_long) / (n_eff + k)
    n_eff    = open_days / (1 + cv^2)

``n_eff`` is the textbook effective-sample-size deflation for an overdispersed
count. An erratic 28 days carries less information than a steady 28 days, so
it is shrunk harder toward the long run. ``k`` is NOT a new constant: it is the
registry's existing ``shrink.k.sku_velocity``, declared in sheet 06 long before
this measurement existed.

NOTHING HERE IS FITTED, AND THAT IS THE POINT
    There is no parameter tuned against the outcome, so there is no sample
    this result was fitted on. The hit rate is flat at 68.0 / 68.0 / 68.7 /
    68.4 / 68.0 for k = 8 / 13 / 21 / 30 / 45 — insensitivity across a 5x range
    is the signature of a real effect rather than a tuned one. A version of
    this that WAS tuned (a rank-average of the same two signals) scored higher
    on the headline metric and then collapsed from 74% to 50% once immaterial
    SKUs were excluded. It is not in this module for that reason.

TWO OUTPUTS, AND THEY MUST NOT BE CONFUSED
    deficit_units  the units the current plan would miss.        MONEY.
    p_hit          how likely this SKU is to beat its baseline.  CONFIDENCE.

    The engine already multiplies expected value by confidence, so these land
    in the terms that were always there. ``deficit_units`` is what a margin may
    be multiplied by to make a dollar figure; ``p_hit`` is a ratio and MAY NOT
    be — a card claiming "$400" computed from a ratio is the fabricated-figure
    defect this rebuild has already removed twice.

p_hit IS ORDERED, NOT CALIBRATED
    Measured against outcomes it rises monotonically — 18.6, 26.7, 33.4, 42.4,
    54.6, 63.7 percent across its range — so it ranks correctly. It is NOT
    numerically true: p_hit = 0.55 corresponds to a 42% outcome, not 55%. It
    must therefore pass through sheet 08's isotonic calibration before any
    number derived from it is shown to a store owner, exactly as sheet 08's
    0.48-stated-against-0.23-actual finding requires. ``p_hit`` is deliberately
    NOT named ``confidence`` so that a caller cannot reach for it by mistake.

PER-CANDIDATE, NEVER PER-BATCH
    An earlier version scored a candidate by its percentile among the others in
    the run. It measured well and is unshippable: the same SKU on the same data
    would score differently depending on which other SKUs were in the batch, so
    two runs over one snapshot could disagree and no card could explain its own
    number. Every quantity here is a function of ONE candidate's own history.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from app.pipeline.blend.evidence_state import evidence_state_for
from app.pipeline.blend.shrink import k_for_pattern
from app.pipeline.blend.predictive_interval import (
    PredictiveInterval,
    predictive_interval,
)
from app.pipeline.context import RunContext
from app.pipeline.envelope import StageResult, stage
from app.pipeline.provenance import Provenance, record_inputs
from app.pipeline.registry import ConfigRegistry, Setting, cfg

#: The pattern whose k governs temporal shrinkage. Reused from sheet 06 rather
#: than redeclared, so there is exactly one k for "how fast a SKU's own
#: velocity becomes trustworthy" and it cannot drift between the two axes.
VELOCITY_PATTERN = "sku_velocity"

MATERIALITY_FLOOR_UNITS = Setting(
    name="reversion.materiality_floor_units",
    default=8,
    unit="units sold in the trailing baseline window",
    owner="commercial",
    why="MEASURED. Below this the ratio r_long/r_recent is noise amplified by "
        "division - a SKU that sold once all year produces an uplift near 20 "
        "and outranks every real candidate. Measured on Bethany: with no "
        "floor the selection's median pick sold ONE unit in 28 days, which is "
        "not a card any owner would act on. At 8 the median pick sells 14 and "
        "the hit rate rises from 60.7% to 71.9%. It is a COMMERCIAL rule "
        "first - the engine should not spend a card on an immaterial SKU - "
        "and it repairs the statistics as a side effect",
    status="MEASURED",
)

MIN_HIT_PROBABILITY = Setting(
    name="reversion.min_hit_probability",
    default=0.5,
    unit="p_hit, 0..1",
    owner="commercial",
    why="MEASURED, and re-measured after p_hit changed from an average to a "
        "product. The precision/coverage dial, and the honest answer to 'make "
        "the hit rate higher': recommend fewer and only the confident ones. "
        "Walked forward over the FULL export - 52 decision dates across 3.7 "
        "years, 208 runs, 1,056 cards - 0.50 gives 75.9% (clustered 95% CI "
        "70.3-80.7) at 5.1 cards a run. Dropping to 0.40 fills a ten-card "
        "slate and costs ~3 points; raising to 0.55 buys ~1 point and cuts "
        "coverage to 2.4 cards and margin by more than half. So this is not a "
        "knob to turn up for a better-looking number - it is a coverage "
        "decision with a measured price",
    status="MEASURED",
)

PROMISE_QUANTILE = Setting(
    name="reversion.promise_quantile",
    default=0.10,
    unit="quantile of the forecast distribution, 0..1",
    owner="commercial",
    why="PROVISIONAL pending the first measured promise-kept run. THIS IS A "
        "PROMISE DIAL AND NEVER AN ORDER DIAL, and the two move in opposite "
        "directions on purpose: raising this makes the card CLAIM MORE and KEEP "
        "ITS WORD LESS, while the order quantity wants a HIGH quantile because "
        "a stockout costs margin and an extra bottle of spirits costs pennies. "
        "A 14-unit mean should promise about 10 and order about 19. The "
        "arithmetic, for a Poisson mean of 14 over 30 days: promising the mean "
        "is kept 53.5% of the time, the p25 (11 units) 82.4%, 10 units 89.1%, "
        "and the p10 (9 units) 93.8%. The target is a kept rate of 90%, so 0.10 "
        "is the starting point and the first five-store run decides it. It "
        "becomes MEASURED when promise-kept lands in 85-95% at every store - "
        "not at 100%, because a promise kept every single time was not worth "
        "making",
    status="PROVISIONAL",
)

MIN_PROMISE_UNITS = Setting(
    name="reversion.min_promise_units",
    default=1.0,
    unit="units over the horizon",
    owner="commercial",
    why="provisional. Below one unit there is no promise worth printing: "
        "'expect 0.4 more bottles' is not a sentence an owner can act on, and "
        "rounding it to zero or to one both misstate it. A sub-unit promise "
        "becomes an absence with its reason recorded, which is the same rule "
        "the materiality floor applies to the card as a whole",
    status="PROVISIONAL",
)

REVERSION_HORIZON_DAYS = Setting(
    name="reversion.horizon_days",
    default=30,
    unit="days",
    owner="forecasting",
    why="MEASURED. The period the deficit is expressed over, and the period "
        "the whole sheet-20 measurement was taken at: 45 decision dates, a "
        "30-day forward window, on Bethany's three years. Changing it without "
        "re-measuring invalidates the 65.6% figure in the documentation, "
        "because the reversion effect is a property of the window LENGTH - a "
        "quiet four weeks says much less about the next four days than about "
        "the next four weeks",
    status="MEASURED",
)

DEFAULT_DISPERSION_CV = Setting(
    name="reversion.default_dispersion_cv",
    default=1.0,
    unit="coefficient of variation of weekly rates",
    owner="forecasting",
    why="provisional; the dispersion assumed when a SKU has too little history "
        "to measure its own. Deliberately HIGH - an unmeasured SKU is treated "
        "as erratic, which shrinks it hard toward its long-run rate and lowers "
        "its p_hit. The conservative direction: an unknown SKU is ranked down, "
        "never up. To be fitted from estate-wide dispersion in wave 6",
    status="PROVISIONAL",
)

DEFICIT_CALIBRATION = Setting(
    name="reversion.deficit_calibration",
    default=1.0,
    unit="multiplier on the deficit before it becomes a promise",
    owner="forecasting",
    why="MEASURED, and it exists because one shrinkage constant cannot "
        "calibrate two different quantities. Swept against the whole material "
        "population at Bethany, k=21 MINIMISES total-forecast error (WAPE "
        "42.6%, bias +0.2%) while the deficit built from it delivers only 51% "
        "of what it promises; k=8 gets the promise to 85% and pushes WAPE to "
        "43.3% and bias to +5.7%. The level and the gap want different "
        "constants, so the level keeps the one that is right for it and the "
        "gap is calibrated separately here. 1.0 is the identity default: a "
        "caller that has not measured its own store changes nothing. The "
        "calibration is estimated per store on an EARLY slice of history and "
        "applied to later dates, never fitted on the window it is scored on",
    status="MEASURED",
)

MIN_WEEKS_FOR_DISPERSION = Setting(
    name="reversion.min_weeks_for_dispersion",
    default=4,
    unit="complete weekly buckets",
    owner="forecasting",
    why="provisional; below four buckets a standard deviation is dominated by "
        "its own sampling error and would report a confident-looking cv that "
        "means nothing. Fewer than this falls back to the default dispersion",
    status="PROVISIONAL",
)


def dispersion_cv(weekly_rates: tuple[float, ...]) -> float | None:
    """Coefficient of variation of weekly rates. None when not measurable.

    None means "we could not measure this", which the caller resolves to the
    registry default. It does NOT mean zero — a cv of zero is a perfectly
    steady seller and is the most favourable value there is, so returning it
    for an unmeasured SKU would rank the unknown as the best.
    """
    usable = tuple(r for r in weekly_rates if r >= 0.0)
    if len(usable) < 2:
        return None
    mean = sum(usable) / len(usable)
    if mean <= 0.0:
        return None
    variance = sum((r - mean) ** 2 for r in usable) / len(usable)
    return math.sqrt(variance) / mean


def effective_observations(open_days: float, cv: float) -> float:
    """open_days / (1 + cv^2) — the overdispersion deflation.

    At cv = 0 a steady seller's window counts for its full length. At cv = 1
    it counts for half. At cv = 2, a fifth. This is what makes an erratic
    recent window shrink harder toward the long run without a branch.
    """
    return max(0.0, open_days) / (1.0 + max(0.0, cv) ** 2)


def steadiness_of(cv: float) -> float:
    """1 / (1 + cv), in 0..1. How much the recent window is to be trusted."""
    return 1.0 / (1.0 + max(0.0, cv))


@dataclass(frozen=True, slots=True)
class ReversionRequest:
    """One SKU's own history. Every field comes from the feature store."""

    sku: str
    #: Units sold and open days in the trailing baseline window (sheet 03's
    #: OPEN days, never calendar days — the denominator this engine already
    #: got wrong once, at a cost of 21.7% understatement on this same store).
    recent_units: float
    recent_open_days: int
    #: The same two quantities over the long-run window.
    long_run_units: float
    long_run_open_days: int
    #: Weekly rates over the stability window, for dispersion. May be short.
    weekly_rates: tuple[float, ...] = ()
    #: The horizon the deficit is expressed over.
    horizon_days: int = 0
    #: Multiplier applied to the deficit before it is promised, measured per
    #: store from history. 1.0 means "not calibrated at this store yet", which
    #: is honest rather than neutral - it says the promise is the raw estimate.
    deficit_calibration: float | None = None
    #: N1.1 - the empirical actual/forecast ratio at PROMISE_QUANTILE, measured
    #: on an EARLIER slice of this store's own history. `None` when it could not
    #: be measured, and then no promise is made at all.
    #:
    #: It is a RATIO and not an interval width on purpose: the band that works
    #: on this engine is the empirical one, fitted as actual/forecast over a
    #: calibration slice and applied to later dates. Two distributional versions
    #: were tried first and both failed - a weekly cv on the window total gave
    #: 91-93% coverage (so wide it could not be wrong) and cv/sqrt(weeks) gave
    #: 37-62% (too narrow, because weekly demand is autocorrelated). This module
    #: therefore does not compute its own interval. It is handed the one that
    #: was measured, and a second method competing with it is exactly what N6.2
    #: exists to prevent.
    promise_ratio: float | None = None
    #: Which quantile `promise_ratio` is. Checked against PROMISE_QUANTILE, so a
    #: caller that supplies a p25 ratio while the registry asks for a p10 gets a
    #: REFUSAL rather than a silently wrong promise. Two places owning one
    #: quantile is how a setting gets changed and a caller gets forgotten.
    promise_ratio_quantile: float | None = None
    #: OPEN days in the horizon. `horizon_days` above is CALENDAR days, and the
    #: deficit multiplies a per-open-day rate by it - which overstates by the
    #: closed-day fraction, measured at 16.8% on Bethany (25.7 open days in a
    #: 30-calendar-day window). That mismatch is NOT corrected here, because
    #: `deficit_units` is pinned to the ordering the five-store audit measured.
    #: But a NEW field must not inherit a known error, so the promise is
    #: computed over open days when they are supplied, and refuses when they are
    #: not - the grader measures the realised gap over open days, so a promise
    #: expressed in calendar days is being scored against a different unit.
    horizon_open_days: int | None = None

    #: Fields are APPENDED here, never inserted. Inserting one between
    #: `own_rate` and `observations` on the neighbouring SkuInput once rebound
    #: every positional call site silently - `SkuInput("0245","whiskey",None,obs)`
    #: bound `obs` to the new field - and the tests still passed.

    def __post_init__(self) -> None:
        for field_name in ("recent_open_days", "long_run_open_days", "horizon_days"):
            if getattr(self, field_name) < 0:
                raise ValueError(f"{field_name} must be >= 0")


@dataclass(frozen=True, slots=True)
class RevertedDemand:
    """The corrected rate, and every term that produced it."""

    sku: str
    #: THE output. Units per OPEN day, corrected for window bias.
    rate_per_open_day: float
    recent_rate: float
    long_run_rate: float
    #: rate_hat / recent_rate. 1.0 when no correction applies.
    uplift: float
    #: The deficit BEFORE calibration, kept so a reader can see what the raw
    #: estimator said and what was promised, and tell a calibrated store from
    #: an uncalibrated one.
    raw_deficit_units: float
    #: The factor applied. 1.0 means this store has not been calibrated.
    deficit_calibration: float
    #: MONEY. Units the current plan misses over the horizon. May be negative,
    #: which is a real and useful answer: the recent window was inflated and
    #: this SKU is heading DOWN. Those are the cards the old engine promoted.
    deficit_units: float
    dispersion_cv: float
    dispersion_measured: bool
    effective_observations: float
    recent_weight: float
    steadiness: float
    #: CONFIDENCE, ordered but not numerically calibrated. Must pass through
    #: sheet 08 before any figure derived from it reaches a store owner.
    p_hit: float
    #: Whether this SKU is large enough to deserve a card at all.
    material: bool
    #: N1.1 - THE NUMBER THE CARD IS ALLOWED TO STATE, and it is not the one
    #: above. `deficit_units` is an EXPECTATION, and a count distribution reaches
    #: its own mean about half the time: for a true rate of 14 units over 30
    #: days the spread is sqrt(14) = 3.74, and P(realised >= 14) = 53.5%. So a
    #: promise built on the mean fails about half the time EVEN WITH A PERFECT
    #: FORECAST. Promise 10 instead and the same forecast keeps its word 89.1%
    #: of the time.
    #:
    #: `None` means no promise can be made - see `promise_basis` for which of
    #: the four reasons applies. It NEVER falls back to the mean.
    promise_units: float | None = None
    #: Why there is, or is not, a promise. A card quoting a figure whose basis
    #: cannot be named is the defect this whole rebuild exists to remove.
    promise_basis: str = "not_computed"

    def as_dict(self) -> dict[str, Any]:
        return {
            "sku": self.sku,
            "rate_per_open_day": self.rate_per_open_day,
            "recent_rate": self.recent_rate,
            "long_run_rate": self.long_run_rate,
            "uplift": self.uplift,
            "raw_deficit_units": self.raw_deficit_units,
            "deficit_calibration": self.deficit_calibration,
            "deficit_units": self.deficit_units,
            "dispersion_cv": self.dispersion_cv,
            "dispersion_measured": self.dispersion_measured,
            "effective_observations": self.effective_observations,
            "recent_weight": self.recent_weight,
            "steadiness": self.steadiness,
            "p_hit": self.p_hit,
            "material": self.material,
            "promise_units": self.promise_units,
            "promise_basis": self.promise_basis,
        }

    def explain(self) -> str:
        """The sentence behind the card. No invented figures."""
        if not self.material:
            return (
                "Too small to act on - not enough recent sales to be worth a "
                "decision."
            )
        if self.deficit_units > 0.0:
            return (
                "Recent sales ran below this product's own longer-run rate, so "
                f"the last few weeks understate it by about "
                f"{self.deficit_units:.0f} units over the period."
            )
        return (
            "Recent sales ran above this product's own longer-run rate, so the "
            "last few weeks overstate what to expect next."
        )


def _rate(units: float, open_days: int) -> float:
    """Units per OPEN day. Zero open days is zero rate, never a divide.

    A store that was shut for the whole window has no rate, not an infinite
    one — the same guard sheet 19 needed after an unguarded version turned a
    closed store's lift into Infinity and then into "this did nothing".
    """
    return (units / open_days) if open_days > 0 else 0.0


@stage("temporal_reversion", "1.1.0")
def revert(
    request: ReversionRequest, ctx: RunContext, config: ConfigRegistry = cfg
) -> StageResult:
    """Shrink the recent rate toward the long-run rate. The keystone of the fix."""
    record_inputs("features.recent_window", "features.long_run_window")

    k = k_for_pattern(VELOCITY_PATTERN, ctx, config)
    floor_units = float(config.get(MATERIALITY_FLOOR_UNITS, ctx))
    min_weeks = int(config.get(MIN_WEEKS_FOR_DISPERSION, ctx))
    default_cv = float(config.get(DEFAULT_DISPERSION_CV, ctx))

    recent_rate = _rate(request.recent_units, request.recent_open_days)
    long_run_rate = _rate(request.long_run_units, request.long_run_open_days)

    measured_cv = (
        dispersion_cv(request.weekly_rates)
        if len(request.weekly_rates) >= min_weeks
        else None
    )
    cv = default_cv if measured_cv is None else measured_cv

    n_eff = effective_observations(float(request.recent_open_days), cv)
    recent_weight = n_eff / (n_eff + k)
    rate_hat = recent_weight * recent_rate + (1.0 - recent_weight) * long_run_rate

    uplift = (rate_hat / recent_rate) if recent_rate > 0.0 else 1.0

    # THE GAP IS CALIBRATED SEPARATELY FROM THE LEVEL, and the reason is a
    # measurement rather than a preference.
    #
    # deficit = (1 - w)(r_long - r_recent) * H, so it is directly proportional
    # to (1 - w) and therefore to k. Swept across the whole material population:
    # k=21 minimises total-forecast WAPE and bias, and its deficit delivers 51%
    # of what it promises; k=8 gets the promise to 85% and makes the forecast
    # worse. Both cannot be fixed by one constant, because the level and the gap
    # are different quantities - the level's errors cancel across increases and
    # decreases, the gap's do not.
    #
    # So the level keeps the k that is right for the level, and the promise is
    # scaled by a factor measured on the store's own history. A card then says a
    # number that has historically arrived, which is the only sense in which a
    # promise can be kept.
    calibration = request.deficit_calibration
    raw_deficit = (rate_hat - recent_rate) * request.horizon_days
    deficit = raw_deficit * (calibration if calibration is not None else 1.0)
    steadiness = steadiness_of(cv)

    # ── N1.1: THE PROMISE IS A QUANTILE, NOT THE MEAN ───────────────────────
    #
    # `deficit` above is an expectation and it stays exactly as it was - the
    # +16.6 point edge over a reversion-matched null (p = 0.0005, at all five
    # stores) was measured on that ordering and moving it would invalidate the
    # whole audit. What changes is only what the card is allowed to SAY.
    #
    # The derivation, from the band that was actually measured rather than a
    # normal approximation:
    #
    #     forecast total     = rate_hat    * H
    #     baseline total     = recent_rate * H          what happens anyway
    #     promise            = ratio_q * forecast_total - baseline_total
    #
    # where ratio_q is the empirical actual/forecast ratio at PROMISE_QUANTILE,
    # fitted on an earlier slice of this store's history. So the promise is the
    # gap that remains after assuming this estimator lands as poorly as it
    # historically does one time in ten.
    #
    # THE CALIBRATION FACTOR IS DELIBERATELY NOT APPLIED HERE. `deficit` carries
    # `deficit_calibration`, a single per-store scalar fitted to make the promise
    # land - and it does not generalise: it was validated at Bethany (50% -> 93%
    # out of sample) and holds at only ONE of five stores (150 / 104 / 53 / 45 /
    # 21%). The quantile does the same job from a principled direction, so
    # applying both would correct twice. If this prompt's gate passes,
    # DEFICIT_CALIBRATION becomes a candidate for deletion and a row in
    # ENGINE-ENHANCEMENTS.md section 11 - which is the honest outcome, not a
    # loose end.
    # ── N1.1, THE PROMISE. LIVE, on the quantity a low quantile can carry ────
    #
    # WHAT CHANGED, AND WHY IT HAD TO. This block used to compute a low quantile
    # of the INCREMENT - "at least N units MORE than your current rate" - and
    # refused on 97-100% of cards. Six formulations were measured and the reason
    # is arithmetic, not a missing fit:
    #
    #     a low quantile of a count sits far below its mean, so clearing the
    #     baseline needs an uplift of 1 / (p05/mean), which rises with dispersion
    #     faster than this engine's candidates supply it
    #
    #         cv 0.25  needs 1.88x   the smooth band's median uplift is 1.21x
    #         cv 0.45  needs 3.00x   near-smooth median 1.45x
    #         cv 0.60  needs 4.29x   erratic median 1.67x
    #         cv 0.80  needs 10.0x   lumpy median 2.26x
    #
    #     Dispersion and uplift are ANTI-CORRELATED: the products steady enough
    #     to carry a floor have no uplift, and the ones with uplift are too
    #     erratic. Measured over 513 cards: 0 could carry one, the closest
    #     reaching 89% of its requirement. `blend/promise_floor.py` holds the
    #     full derivation.
    #
    # So the promise is now made on the TOTAL, where a low quantile IS available:
    # "at least N units will sell over the period". Measured over the same 513
    # cards it holds 95.5% of the time (99.4 / 98.5 / 96.5 / 94.0 / 84.7% by
    # store). Positive, checkable against a till, and a claim an owner can hold
    # the engine to - which is what N1.1 was for.
    #
    # `deficit_units` is untouched and remains the expectation. The promise sits
    # BESIDE it, never in place of it: that is what N1 meant by promise and order
    # being different numbers, and the +16.6-point edge was measured on the
    # expectation.
    min_promise = float(config.get(MIN_PROMISE_UNITS, ctx))
    promise_units: float | None = None
    if request.recent_units < floor_units:
        promise_basis = "immaterial"
    elif request.horizon_open_days is None:
        # A promise scored over open days cannot be stated in calendar days.
        promise_basis = "no_open_day_horizon"
    else:
        band = predictive_interval(
            rate=rate_hat, horizon_open_days=float(request.horizon_open_days),
            dispersion_cv=cv, ctx=ctx, config=config,
        )
        if not isinstance(band, PredictiveInterval):
            # The interval's own named refusal, carried through rather than
            # restated - one vocabulary for one failure.
            promise_basis = band.basis
        elif band.low < min_promise:
            promise_basis = f"floor_below_minimum:{band.low}<{min_promise:.0f}"
        else:
            promise_units = float(band.low)
            promise_basis = (
                f"total_floor_p{int(round((1.0 - band.nominal_coverage) / 2 * 100)):02d}"
            )

    # p_hit = s / (1 + s),  s = uplift * steadiness
    #
    # WHY A PRODUCT AND NOT AN AVERAGE. The first version averaged a squashed
    # uplift with steadiness. An average lets either term carry a candidate on
    # its own, and steadiness alone is not evidence of anything: a perfectly
    # steady seller has steadiness = 1.0 whether it is climbing or dying, so
    # cv = 0 forced p_hit >= 0.5 however hard the SKU was falling. The product
    # cannot do that - a low uplift drags the whole thing down, which is what
    # "unlikely to beat its own rate" should mean.
    #
    # MEASURED, and validated OUT OF SAMPLE. The exponent pair was chosen on
    # the first 25 decision dates and scored on the last 25, which the choice
    # never saw: worst horizon 68.8% in-sample, 69.6% held out. It got BETTER
    # out of sample, so this is structure rather than a fit. Per horizon on the
    # held-out half: 69.6 / 72.0 / 74.0 / 72.8 against 60.4 / 60.0 / 62.0 /
    # 63.2 for the ordering it replaces.
    #
    # The division bounds it to 0..1 WITHOUT changing any ordering - x/(1+x) is
    # monotone - so it stays probability-shaped and cannot act as an unbounded
    # multiplier on a score, which is how the tuned rank-average blew up on
    # SKUs selling once a year.
    #
    # THE FLOOR NOW MEANS SOMETHING READABLE. p_hit >= 0.5 is exactly
    # uplift * steadiness >= 1, i.e. the long-run rate must exceed the recent
    # rate by at least (1 + cv). An erratic SKU has to be further depressed
    # than a steady one to qualify, which is the correct direction.
    selection_score = uplift * steadiness
    p_hit = selection_score / (1.0 + selection_score)

    reverted = RevertedDemand(
        sku=request.sku,
        rate_per_open_day=rate_hat,
        recent_rate=recent_rate,
        long_run_rate=long_run_rate,
        uplift=uplift,
        raw_deficit_units=raw_deficit,
        deficit_calibration=(calibration if calibration is not None else 1.0),
        deficit_units=deficit,
        dispersion_cv=cv,
        dispersion_measured=measured_cv is not None,
        effective_observations=n_eff,
        recent_weight=recent_weight,
        steadiness=steadiness,
        p_hit=p_hit,
        material=request.recent_units >= floor_units,
        promise_units=promise_units,
        promise_basis=promise_basis,
    )
    provenance = Provenance(
        own_observations=request.recent_open_days,
        own_weight=recent_weight,
        # n is the EFFECTIVE count, not the raw open days: an erratic four
        # weeks genuinely is less evidence than a steady four weeks, and the
        # label a store reads should say so. DISPLAY ONLY - sheet 06's rule
        # that nothing branches on this holds here too.
        evidence_state=evidence_state_for(int(n_eff), k, ctx, config),
        inputs=("features.recent_window", "features.long_run_window"),
    )
    return StageResult.success(reverted, provenance)


def is_recommendable(
    reverted: RevertedDemand, ctx: RunContext, config: ConfigRegistry = cfg
) -> bool:
    """Whether this candidate may become an ORDER-MORE card at all.

    Three requirements, and all three are commercial rather than statistical:

      material          big enough to be worth an owner's attention
      p_hit >= floor    the engine is more likely right than not about it
      deficit > 0       the evidence points UPWARD

    THE THIRD ONE IS NOT REDUNDANT, AND THAT IS NOT OBVIOUS.
    `p_hit` averages an uplift term with a steadiness term, so a PERFECTLY
    STEADY seller has steadiness = 1.0 and therefore p_hit >= 0.5 no matter
    how hard it is falling. A steady decliner would clear a 0.5 floor on
    steadiness alone. Ranking hides this - its expected value is negative so
    it sorts last - but sorting last is not the same as being refused, and a
    card at position 40 is still a card telling an owner to reorder something
    on its way down.

    A negative deficit is a genuine and useful signal; it just belongs to a
    different family (reduce cover, clear stock), whose gate is that family's
    to write. It is not an order-more recommendation.
    """
    return (
        reverted.material
        and reverted.deficit_units > 0.0
        and reverted.p_hit >= float(config.get(MIN_HIT_PROBABILITY, ctx))
    )


__all__ = [
    "DEFAULT_DISPERSION_CV",
    "MATERIALITY_FLOOR_UNITS",
    "MIN_HIT_PROBABILITY",
    "DEFICIT_CALIBRATION",
    "MIN_PROMISE_UNITS",
    "MIN_WEEKS_FOR_DISPERSION",
    "PROMISE_QUANTILE",
    "REVERSION_HORIZON_DAYS",
    "VELOCITY_PATTERN",
    "ReversionRequest",
    "RevertedDemand",
    "dispersion_cv",
    "effective_observations",
    "is_recommendable",
    "revert",
    "steadiness_of",
]
