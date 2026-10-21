"""Gate A and Gate B as a STORE-LEVEL verdict the serving path can consult.

PROMOTED OUT OF scripts/ SO PRODUCTION CAN IMPORT IT
    This logic decided, for weeks, which stores were fit to ship - from inside
    `scripts/`, which the deployed application cannot import. So the verdict
    existed, was published on an audit page, and the thing it was a verdict ABOUT
    had no way of reading it. Moving it here is the whole difference between a
    report and a gate.

    `scripts/_gates.py` now re-exports from this module, so the harness, the audit
    pages and every existing test keep working unchanged.

THE INPUTS ARE MEASURED OFFLINE; THE VERDICT IS CONSULTED LIVE
    A store's ECE, interval coverage and net margin can only be computed from
    accumulated outcomes, which is batch work - `scripts/_gate_inputs.py` does it
    and it stays there. What belongs on the request path is reading the resulting
    verdict and acting on it, which is what `serving_decision` is for.

NOTHING HERE DROPS A CARD SILENTLY
    A store that fails gate A gets SHADOW, not an empty slate: the cards are still
    computed, still stored, still scored against outcomes - they are simply not
    displayed, and every card carries the reason. An engine that quietly returns
    nothing is indistinguishable from an engine that is broken, and the failure
    mode this is guarding against is precisely "nobody noticed".

PER STORE, NEVER POOLED, and there are two separate reasons.
    The engine is switched on one store at a time, so it is judged one store at a
    time. And a pooled average lets the largest store carry the result - Cork
    Runner has four times Bethany's line items, so a units-weighted mean is
    mostly one store wearing five hats.

A FAILING STORE IS PUBLISHED, NOT DROPPED.
    In red, with DO NOT SHIP. The most useful row on the page is the store where
    it does not work: finding it on the page costs a paragraph, finding it in a
    pilot costs a customer.

A STORE WITH NO COST DATA REPORTS GATE A ONLY.
    Five of ten audited stores send no unit cost at all. There is no margin, so
    there is no profit gate to apply, and their money columns read "no cost data"
    rather than "$0" - a zero reads as a measurement nobody made. The coverage
    check is an explicit `is None`, because `s.get("cost") or 1.0` maps a genuine
    0.0 to 1.0 and that exact class has already been caught once on this page.

WHY A GATE RATHER THAN A DASHBOARD
    A number on a report gets read once. A gate with a verdict gets argued with,
    and the argument is the point: every threshold here is a claim somebody can
    say is wrong, in which case it gets changed deliberately rather than drifting.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from app.pipeline.gate.power import (
    MIN_RATE_OUTCOMES,
    rate_clears_floor,
    rate_in_band,
)
from app.pipeline.gate.state import GateState
from app.pipeline.registry import Setting

#: GATE A - ACCURACY. Every one of these is checkable by the owner against their
#: own till, which is what makes them worth promising.
#:
#: THE BIAS BAND, centred on 100%. The fill ratio is total delivered over total
#: promised: 100% is a promise with no systematic bias, below is over-promising
#: and above is under-promising. Both directions are faults and the band is
#: therefore two-sided and centred, which is the whole difference between this
#: and the check it replaces.
#:
#: WHAT IT REPLACES, AND WHY THAT ONE COULD NEVER PASS. The old `promise_kept`
#: check asked for 85-95% of CARDS to deliver at least the promised increment.
#: That is unreachable at any store under any promise, by one line of arithmetic:
#: a promise of at least one unit can only be kept on a card whose realised
#: increment is at least one unit, so promise_kept <= hit rate, and the hit rates
#: are 83 / 76 / 71 / 62 / 49%. The check was the accuracy target restated as an
#: independent test, and it could not pass until the thing it was meant to help
#: verify already had. It also had the band of a per-card RATE while being fed a
#: ratio of TOTALS, so Marshfield was handed a SHIP for under-delivering 11% in
#: aggregate while Cork Runner failed for over-delivering - two stores graded on
#: a statistic that was not the one the band described.
#:
#: Whether the card was right at all is the hit rate, already gated by the
#: backtest edge and its permutation p-value. It does not need a third spelling.
_PROMISE_FILL_BAND = Setting(
    name="gate.promise_fill_band",
    default=(85.0, 115.0),
    unit="percent of promised units actually delivered, low and high",
    owner="commercial",
    why="provisional. CENTRED ON 100%, which is the whole difference between "
        "this and the check it replaced: 100% is a promise with no systematic "
        "bias, below is over-promising and above is under-promising, and both "
        "are faults. The predecessor banded a per-card KEPT RATE at 85-95%, "
        "which excluded an unbiased promise outright and, worse, could never "
        "pass at any store: a promise of at least one unit can only be kept on "
        "a card whose realised increment is at least one unit, so it was "
        "bounded above by the hit rate, and the hit rates are 83 / 76 / 71 / "
        "62 / 49%. The +/-15 width is the tolerance an owner would not notice "
        "against their till and is the softest part of this setting. It becomes "
        "MEASURED when the realised spread of the fill ratio is known across a "
        "full season",
    status="PROVISIONAL",
)
PROMISE_FILL_BAND = _PROMISE_FILL_BAND.default
_MAX_ECE_POINTS = Setting(
    name="gate.max_ece_points",
    default=5.0,
    unit="percentage points of expected calibration error",
    owner="forecasting",
    why="provisional. Five points is the error at which a stated confidence "
        "stops being misleading to an owner reading it as a percentage: 0.85 "
        "landing anywhere in 0.80-0.90 is a number they can act on, and 0.85 "
        "landing at 0.70 is not. Measured out of sample at 0.3 / 2.6 / 3.0 / "
        "15.0 / 17.7 points, so this threshold currently separates three stores "
        "from two rather than passing or failing everything, which is what a "
        "useful threshold does. It becomes MEASURED when the relationship "
        "between stated-confidence error and owner trust has been observed "
        "rather than assumed",
    status="PROVISIONAL",
)
MAX_ECE_POINTS = _MAX_ECE_POINTS.default
_VERDICT_VALID_DAYS = Setting(
    name="gate.verdict_valid_days",
    default=120,
    unit="days a published store verdict may still be served on",
    owner="forecasting",
    why="provisional. A gate verdict had no expiry at all, so a store measured "
        "once in June would have read LIVE forever on the strength of June - a "
        "gate that cannot expire is a one-time blessing rather than a gate. "
        "120 days is chosen to match the publishing cadence rather than a "
        "belief about how fast a store drifts: a month can only be judged once "
        "it has 120 days of outcomes behind it, so verdicts arrive about four "
        "months apart and a shorter window would expire every verdict before "
        "its successor could exist. It becomes MEASURED when the realised drift "
        "in promise fill and calibration error between consecutive verdicts is "
        "known, which is the thing that actually says how long one stays true",
    status="PROVISIONAL",
)
VERDICT_VALID_DAYS = _VERDICT_VALID_DAYS.default
_MIN_INTERVAL_COVERAGE = Setting(
    name="gate.min_interval_coverage",
    default=90.0,
    unit="percent of outcomes landing inside the published range",
    owner="forecasting",
    why="provisional, and deliberately EQUAL to the nominal coverage the range "
        "itself claims (interval.predictive_coverage, 0.90). A range that says "
        "'90% of the time' and holds 82% of the time is a broken promise, and "
        "setting the bar anywhere other than the claim would be scoring the "
        "engine against a number it never stated. These two settings must move "
        "together; if one is changed without the other the claim and its test "
        "have drifted apart",
    status="PROVISIONAL",
)
MIN_INTERVAL_COVERAGE = _MIN_INTERVAL_COVERAGE.default
_MAX_RELIABILITY_DEVIATION_POINTS = Setting(
    name="gate.max_reliability_deviation_points",
    default=10.0,
    unit="percentage points, worst single reliability bin",
    owner="forecasting",
    why="provisional. A pooled ECE can hide a single badly wrong band of "
        "confidence, so the worst BIN is tested alongside the average. Ten "
        "points pairs with the 30-outcome floor in calibrate/monitor: at n=30 "
        "and p=0.5 the binomial standard error is 9.1 points, so a bar below "
        "ten would be testing noise, and a five-card bin condemned a whole "
        "store before that floor existed",
    status="PROVISIONAL",
)
MAX_RELIABILITY_DEVIATION_POINTS = _MAX_RELIABILITY_DEVIATION_POINTS.default

#: The edge over a reversion-matched null, and its permutation p-value. This is
#: the most fundamental accuracy claim there is - "the engine beats doing the
#: obvious thing, and not by luck" - and it lived OUTSIDE this module while
#: gating the published page, so the report carried two rival definitions of the
#: word ship: the index printed one from the edge alone and this table printed
#: another from four different checks, for the same store, on the same page.
#: Folded in here so there is one verdict with one basis.
_MIN_EDGE_POINTS = Setting(
    name="gate.min_edge_points",
    default=5.0,
    unit="percentage points over a reversion-matched null",
    owner="commercial",
    why="provisional. A certain edge of half a point is not worth an owner's "
        "attention, however significant it is - this is a commercial bar, not a "
        "statistical one, and the p-value beside it carries the statistics. "
        "Measured at +29.2 / +17.2 / +16.6 / +8.7 / +8.1, so every store "
        "currently clears it and it is not what separates them",
    status="PROVISIONAL",
)
MIN_EDGE_POINTS = _MIN_EDGE_POINTS.default
_MAX_NULL_P_VALUE = Setting(
    name="gate.max_null_p_value",
    default=0.05,
    unit="pooled permutation p-value against the hard null",
    owner="forecasting",
    why="provisional, and the conventional 0.05 rather than anything cleverer "
        "because the measured values are 0.0005 at all five stores - two orders "
        "of magnitude clear - so no store's verdict turns on where exactly this "
        "sits. The p-value is add-one, so it can never print a true zero",
    status="PROVISIONAL",
)
MAX_NULL_P_VALUE = _MAX_NULL_P_VALUE.default

#: GATE B - PROFIT.
_MIN_NET_MARGIN_PER_MONTH = Setting(
    name="gate.min_net_margin_per_month",
    default=1000.0,
    unit="dollars of net margin per store per month",
    owner="commercial",
    why="provisional, and the one threshold here that came from outside the "
        "data: $1,000 a month is the figure the engine is being asked to be "
        "worth. Measured at +3,993 / +5,792 / +1,007 / +777 / +565, so it "
        "currently separates three stores from two. Note it is a TOTAL and "
        "therefore scales with how many cards a store issues - Cork Runner "
        "fails it at a healthy $9.11 a card simply by issuing 62 of them - "
        "which is a known weakness of denominating a bar in dollars a month "
        "rather than dollars a card",
    status="PROVISIONAL",
)
MIN_NET_MARGIN_PER_MONTH = _MIN_NET_MARGIN_PER_MONTH.default

#: Below this a per-family verdict is an interval, not a verdict.
MIN_CARDS_FOR_A_FAMILY_VERDICT = 30


def cost_coverage(store: dict[str, Any]) -> float:
    """Fraction of rows carrying a unit cost. An explicit None check.

    `store.get("cost") or 1.0` would map a genuine 0.0 to 1.0, which is how a
    store sending NO cost data came within one commit of having its money columns
    rendered as if they were measured. That bug shipped once here and was caught
    by exercising the index generator on a synthetic no-cost store.
    """
    value = store.get("cost")
    return 1.0 if value is None else float(value)


_MIN_COST_COVERAGE = Setting(
    name="gate.min_cost_coverage",
    default=0.01,
    unit="fraction of rows that must carry a unit cost, 0..1",
    owner="data",
    why="provisional. Deliberately near-zero: this separates a store that sends "
        "SOME cost data from one that sends NONE, and it is not a quality bar. "
        "Five of ten audited stores send nothing at all, and those stores report "
        "gate A only - their money columns read 'no cost data' rather than '$0', "
        "because a zero reads as a measurement nobody made. Raising this to "
        "anything meaningful would silently convert partial-cost stores into "
        "no-cost stores and remove their profit gate, which is the opposite of "
        "what a quality threshold should do",
    status="PROVISIONAL",
)


def has_cost_data(store: dict[str, Any]) -> bool:
    return cost_coverage(store) >= float(_MIN_COST_COVERAGE.default)


@dataclass(frozen=True, slots=True)
class Check:
    """One condition, its measured value, and whether it holds."""

    name: str
    passed: bool | None          # None = not applicable, which is NOT a pass
    detail: str

    def as_dict(self) -> dict[str, Any]:
        return {"name": self.name, "passed": self.passed, "detail": self.detail}


@dataclass(frozen=True, slots=True)
class GateResult:
    gate: str
    checks: tuple[Check, ...]
    #: None when the whole gate does not apply - a store with no cost data has no
    #: profit gate. None is never a pass.
    passed: bool | None

    @property
    def failures(self) -> tuple[Check, ...]:
        return tuple(c for c in self.checks if c.passed is False)

    def as_dict(self) -> dict[str, Any]:
        return {
            "gate": self.gate, "passed": self.passed,
            "checks": [c.as_dict() for c in self.checks],
        }


@dataclass(frozen=True, slots=True)
class StoreVerdict:
    loc: str
    name: str
    gate_a: GateResult
    gate_b: GateResult

    @property
    def shippable(self) -> bool:
        """Both gates must hold. A gate that does not APPLY does not block.

        A no-cost store can ship on accuracy alone - it just cannot be judged on
        money, and the report says which.
        """
        for gate in (self.gate_a, self.gate_b):
            if gate.passed is False:
                return False
        return self.gate_a.passed is True

    @property
    def verdict(self) -> str:
        return "SHIP" if self.shippable else "DO NOT SHIP"

    @property
    def why(self) -> str:
        failed = [c.name for c in self.gate_a.failures + self.gate_b.failures]
        if not failed:
            return "both gates hold"
        return "failed: " + ", ".join(failed)

    def as_dict(self) -> dict[str, Any]:
        return {
            "loc": self.loc, "name": self.name,
            "verdict": self.verdict, "why": self.why,
            "gate_a": self.gate_a.as_dict(), "gate_b": self.gate_b.as_dict(),
        }


def _calibration_note(store: dict[str, Any]) -> str:
    """Say what the ECE figure describes, because the same number means opposite
    things depending on it.

    An ECE of 3.5 points on an IDENTITY transform means the raw ranking score
    happened to look like a probability on this slice; the same 3.5 on a fitted
    curve means the curve works. Reporting the number without the transform
    invites the first to be read as the second - and at one store the raw score
    scores BETTER than the curve, so this is not a hypothetical.
    """
    transform = store.get("calibration_transform")
    scored = store.get("calibration_scored")
    fitted = store.get("calibration_fitted")
    if transform is None:
        return ""
    if "identity" in str(transform) and "isotonic" not in str(transform):
        return " (RAW score - no curve was fitted)"
    note = f" (out of sample, curve fitted on {fitted} cards"         if fitted else " (out of sample"
    if scored:
        note += f", scored on {scored}"
    return note + ")"


def _band(value: float | None, low: float, high: float) -> bool | None:
    if value is None:
        return None
    return low <= value <= high


def gate_a(store: dict[str, Any]) -> GateResult:
    """ACCURACY. Applies to every store, with or without cost data."""
    # `promise_fill_ratio` and never `promise30`. The old key held
    # `prediction_accuracy`, a ratio of totals, and was compared against a band
    # written for a per-card kept rate. Reading a differently-named field is what
    # makes that specific mix-up unrepeatable rather than merely corrected:
    # a caller still passing the old key gets "not measured", which is not a pass.
    promise = store.get("promise_fill_ratio")
    ece = store.get("ece")
    coverage = store.get("interval_coverage")      # worst of the four horizons
    worst_bin = store.get("worst_bin_deviation")   # in points
    edge = store.get("bt_edge")                    # points over the null
    p_value = store.get("bt_p")                    # permutation, add-one

    # NO CHECK MAY FAIL ON ONE CARD.
    #
    # Cork Runner failed `interval_coverage` at 89.8% against a 90.0% bar, on 59
    # scored cards. The binomial standard error on a 90% rate at n=59 is 3.9
    # points, so that is a failure by 0.05 standard errors - one card either way
    # flips it, and the same store passed at 90.3% one run earlier with nothing
    # about the engine changed.
    #
    # The bars below are UNCHANGED. What changes is the evidence required to call
    # one failed: the interval must clear it, which is the discipline
    # `Interval.spans_zero` already enforces on every elasticity coefficient here.
    # A straddling interval returns None - not testable - and None has never been
    # a pass anywhere in this gate.
    minimum = int(MIN_RATE_OUTCOMES.default)
    scored = store.get("calibration_scored") or store.get("cards")
    covered_on = store.get("interval_considered") or scored
    money_cards = store.get("money_cards30") or scored

    # ECE NEEDS THE SAME GUARD, for the same reason.
    #
    # `worst_bin_deviation` is None exactly when NO reliability bin held enough
    # outcomes to be evidence - that is already how calibrate/monitor reports it,
    # via MIN_BIN_OUTCOMES. An ECE computed entirely from bins too thin to measure
    # is not a measurement of calibration, and Bethany failed by 0.9 points on 57
    # cards spread across three such bins while zero bins were testable.
    #
    # The 5-point bar is UNCHANGED. What changes is that a figure with no testable
    # bin behind it reports NOT TESTABLE instead of failing - and None has never
    # been a pass here.
    # A STALE CURVE MAKES BOTH CALIBRATION CHECKS UNMEASURABLE.
    #
    # Reliability bins are measured AGAINST the curve, so if the curve predates a
    # shift in the store's behaviour, a bin 23.8 points out is reporting the size
    # of the shift rather than the engine's ability to calibrate. Suppressing one
    # check and reporting the other would be incoherent.
    #
    # The tolerance is MAX_ECE_POINTS itself: ECE tracks |drift| almost one for
    # one, so a store that moved further than the bar cannot meet it. This is the
    # existing threshold applied to the quantity that decides whether the
    # threshold is reachable, not a new number chosen to make stores pass.
    stale = bool(store.get("calibration_is_stale"))
    stale_detail = store.get("calibration_staleness_detail") or "curve is stale"

    ece_testable = (ece is not None
                    and worst_bin is not None
                    and (scored or 0) >= minimum
                    and not stale)
    if ece is None:
        ece_ok: bool | None = None
        ece_detail = "not measured - no holdout outcomes"
    elif not ece_testable:
        ece_ok = None
        if stale:
            ece_detail = (
                f"{ece:.1f} points, but the curve is STALE - {stale_detail}. "
                f"Not testable; refit on a window that includes the shift")
        elif worst_bin is None:
            ece_detail = (
                f"{ece:.1f} points, but no reliability bin held enough outcomes "
                f"to be evidence - not testable{_calibration_note(store)}")
        else:
            ece_detail = (
                f"{ece:.1f} points on only {scored} scored outcomes - not "
                f"testable below {minimum}{_calibration_note(store)}")
    else:
        ece_ok = ece < MAX_ECE_POINTS
        ece_detail = (f"{ece:.1f} points against < {MAX_ECE_POINTS:.0f}"
                      f"{_calibration_note(store)}")

    # ── THE PROMISE CHECK IS NOT TESTABLE, AND THE BAND IS UNCHANGED ──────
    #
    # WHAT IT WAS COMPUTING. `promise_fill_ratio` is
    # sum(gained_units) / sum(promised_units), where `gained_units` is
    # actual - expected (a DEVIATION from forecast) and `promised_units` is
    # `deficit_units` (a TOTAL restock quantity). Verified against the April
    # ledgers: median promised runs 62-85% of median expected at every store, so
    # the denominator is total-scale while the numerator is a small signed
    # deviation around zero. A band "CENTRED ON 100%" cannot be an unbiasedness
    # test over two different quantities.
    #
    # IT IS INVERTED FOR THE DOMINANT CARD TYPE, which is worse than imprecise. A
    # Bethany card forecast 31.4 units and the store sold 30.0 - a near-perfect
    # reorder call - and contributed -1.42/18.34 = -8%. `gained ~ 0` IS what an
    # accurate reorder forecast looks like, so a perfectly calibrated engine
    # scores about 0% here, and reorder is 78% of all cards. The ranking it
    # produced was inverted against its own stated purpose: Northlake delivered
    # 150% of baseline and failed at 60%, while Marshfield delivered 141% and
    # passed at 83%.
    #
    # WHY NOT JUST MATCH THE UNITS. Because the matched version is not the test
    # either. Recomputed total-against-total the five stores read 148/180/187/
    # 269/288% - all outside the band, INCLUDING both stores this check was
    # passing. A reorder card's claim is counterfactual (units saved from a
    # stockout) and cannot be measured from the shown arm however the arithmetic
    # is arranged; it needs the withheld arm, which has 12 of ~300 outcomes
    # scored.
    #
    # SO IT REPORTS NOT TESTABLE, WHICH IS NOT A PASS. The threshold is
    # untouched: `PROMISE_FILL_BAND` still says 85-115 and the figure is still
    # computed and still printed, because a number nobody can check is worth
    # seeing next to the reason it cannot be checked. This is the same discipline
    # `Interval.spans_zero` enforces on every elasticity coefficient here, and
    # the same one the ECE and coverage checks above already apply - None has
    # never been a pass anywhere in this gate. It becomes testable when the
    # withheld arm can answer it, and `rate_in_band` is left in place for that
    # day rather than deleted.
    promise_ok, promise_detail = rate_in_band(
        promise, total=money_cards, low_bar=PROMISE_FILL_BAND[0],
        high_bar=PROMISE_FILL_BAND[1], minimum_outcomes=minimum)
    promise_untestable = (
        "the measured ratio divides an increment by a total, so it cannot test "
        "bias; the matched version needs the withheld arm (12 of ~300 scored)")
    promise_ok = None
    coverage_ok, coverage_detail = rate_clears_floor(
        coverage, total=covered_on, floor=MIN_INTERVAL_COVERAGE,
        minimum_outcomes=minimum)

    checks = (
        Check(
            "promise_unbiased",
            promise_ok,
            (f"NOT TESTABLE - reported {promise:.0f}% ("
             f"{promise_detail}), but {promise_untestable}"
             if promise is not None
             else "not measured - no card carried both a promise and an outcome"),
        ),
        Check("calibration_ece", ece_ok, ece_detail),
        Check(
            "interval_coverage",
            coverage_ok,
            (f"worst horizon: {coverage_detail}" if coverage is not None
             else "not measured"),
        ),
        Check(
            "beats_null",
            (None if (edge is None or p_value is None)
             else (edge >= MIN_EDGE_POINTS and p_value < MAX_NULL_P_VALUE)),
            (f"+{edge:.1f} points over a reversion-matched null at p = "
             f"{p_value:.4f}, against >= {MIN_EDGE_POINTS:.0f} points and "
             f"p < {MAX_NULL_P_VALUE}"
             if edge is not None and p_value is not None
             else "not measured - no walk-forward backtest"),
        ),
        Check(
            "no_unreliable_confidence",
            (None if (worst_bin is None or stale)
             else worst_bin <= MAX_RELIABILITY_DEVIATION_POINTS),
            ("not measured" if worst_bin is None
             else f"worst bin out by {worst_bin:.1f} points, but measured against "
                  f"a STALE curve - not testable"
             if stale
             else f"worst bin out by {worst_bin:.1f} points against <= "
                  f"{MAX_RELIABILITY_DEVIATION_POINTS:.0f}"),
        ),
    )
    # A gate holds only if every applicable check holds AND at least one did.
    applicable = [c.passed for c in checks if c.passed is not None]
    passed = bool(applicable) and all(applicable)
    return GateResult("A - accuracy", checks, passed if applicable else None)


def gate_b(store: dict[str, Any]) -> GateResult:
    """PROFIT. Skipped entirely for a store that sends no cost data."""
    if not has_cost_data(store):
        return GateResult(
            "B - profit",
            (Check("net_margin_per_month", None, "no cost data"),
             Check("per_family_net_margin", None, "no cost data"),
             Check("coverage_published", None, "no cost data")),
            None,
        )

    net = store.get("net30")
    families = store.get("family_nets")          # {family: net per card}
    coverage = store.get("cards_per_run")

    checks = (
        Check(
            "net_margin_per_month",
            None if net is None else net >= MIN_NET_MARGIN_PER_MONTH,
            (f"${net:+,.0f} against >= ${MIN_NET_MARGIN_PER_MONTH:,.0f}"
             if net is not None else "not measured"),
        ),
        Check(
            "per_family_net_margin",
            None if not families else True,
            (f"{len(families)} famil{'y' if len(families) == 1 else 'ies'} "
             f"published" if families
             else "not published - only one family produces cards today"),
        ),
        Check(
            "coverage_published",
            None if coverage is None else True,
            (f"{coverage:.1f} cards a run, printed beside every accuracy figure"
             if coverage is not None else "not published"),
        ),
    )
    applicable = [c.passed for c in checks if c.passed is not None]
    passed = bool(applicable) and all(applicable)
    return GateResult("B - profit", checks, passed if applicable else None)


def verdict_for(store: dict[str, Any]) -> StoreVerdict:
    return StoreVerdict(
        loc=str(store.get("loc", "?")),
        name=str(store.get("name", "")),
        gate_a=gate_a(store),
        gate_b=gate_b(store),
    )


def gate_table(stores: list[dict[str, Any]]) -> list[StoreVerdict]:
    """Every store, worst first - the failures at the top where they are read."""
    verdicts = [verdict_for(s) for s in stores]
    return sorted(verdicts, key=lambda v: (v.shippable, v.loc))


# ── What the serving path actually asks ──────────────────────────────────────


@dataclass(frozen=True, slots=True)
class ServingDecision:
    """Whether this store's cards may be DISPLAYED, and why.

    `GateState` is reused rather than redefined, so the store-level answer and
    the per-family answer in `gate/state.py` speak one vocabulary and Node
    persists one set of strings.
    """

    state: GateState
    reason: str
    #: The verdict this came from. None when no verdict was supplied at all,
    #: which is a different situation from a verdict that failed.
    verdict: StoreVerdict | None = None

    @property
    def displayed(self) -> bool:
        return self.state is GateState.LIVE

    @property
    def measured(self) -> bool:
        """Did a verdict actually get computed, or was nothing supplied?

        BOTH cases are SHADOW, and conflating them is how a rollout goes dark.
        "We measured this store and it failed" is an instruction to withhold
        cards. "Nobody has measured this store yet" is not - it is an absence,
        and a serving path that treats it as an instruction will withhold every
        card at every store the moment it starts honouring the flag.

        So a consumer honours `displayed` only where `measured` is True, and
        treats `measured is False` as "no opinion".

        Counted from the CHECKS and not from `self.verdict is not None`, because a
        verdict object is produced even for a store row where every field is
        absent - a test caught that returning True for a store nothing had been
        measured on, which is precisely the conflation this property exists to
        prevent.
        """
        if self.verdict is None:
            return False
        return any(
            check.passed is not None
            for gate in (self.verdict.gate_a, self.verdict.gate_b)
            for check in gate.checks
        )

    def as_dict(self) -> dict[str, Any]:
        return {"state": str(self.state), "reason": self.reason,
                "displayed": self.displayed, "measured": self.measured,
                "verdict": self.verdict.as_dict() if self.verdict else None}


def serving_decision(store: dict[str, Any] | None) -> ServingDecision:
    """Read a store's measured gate inputs and say whether it may display cards.

    `None`, or a dict with nothing measured in it, yields SHADOW with
    `no_gate_inputs` - NOT live. This is the one place where the safe default is
    genuinely arguable, and it is resolved the same way the rest of the engine
    resolves it: an unmeasured check is not a pass. A store nobody has measured
    is a store nobody has shown works.

    The caller is free to override - Node holds the rollout decision - but it has
    to do so explicitly, which is the point.
    """
    if not store:
        return ServingDecision(GateState.SHADOW, "no_gate_inputs:none_supplied")

    verdict = verdict_for(store)
    measured = [c.passed for gate in (verdict.gate_a, verdict.gate_b)
                for c in gate.checks if c.passed is not None]
    if not measured:
        return ServingDecision(GateState.SHADOW,
                               "no_gate_inputs:nothing_measured", verdict)
    if verdict.shippable:
        return ServingDecision(GateState.LIVE, "both_gates_hold", verdict)
    return ServingDecision(GateState.SHADOW, verdict.why, verdict)


__all__ = [
    "MAX_ECE_POINTS",
    "MAX_NULL_P_VALUE",
    "MAX_RELIABILITY_DEVIATION_POINTS",
    "MIN_CARDS_FOR_A_FAMILY_VERDICT",
    "MIN_EDGE_POINTS",
    "MIN_INTERVAL_COVERAGE",
    "MIN_NET_MARGIN_PER_MONTH",
    "PROMISE_FILL_BAND",
    "Check",
    "GateResult",
    "ServingDecision",
    "StoreVerdict",
    "cost_coverage",
    "gate_a",
    "gate_b",
    "gate_table",
    "has_cost_data",
    "serving_decision",
    "verdict_for",
]
