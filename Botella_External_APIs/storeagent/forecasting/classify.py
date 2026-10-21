"""Syntetos-Boylan demand classification. Which SHAPE is this SKU?

    ADI  = average inter-demand interval, in OPEN days
    CV2  = squared coefficient of variation of the non-zero demand SIZES

                    CV2 < 0.49          CV2 >= 0.49
    ADI < 1.32      smooth              erratic
    ADI >= 1.32     intermittent        lumpy

WHY THIS SHEET EXISTS AT ALL
    `demand.py` is 196 lines and applies essentially one approach to every SKU.
    Liquor demand is not one shape: a top-20 vodka sells every day, a niche
    mezcal sells four times a year, and a seasonal cream liqueur does 60% of
    its volume in six weeks. One method cannot serve all three, and the one
    currently in place serves the INTERMITTENT majority worst - which is most
    of the catalogue.

ADI IS COUNTED IN OPEN DAYS, AND THAT IS THE WHOLE POINT OF SHEET 03
    A store shut every Sunday has ~52 non-trading days a year. Counted as
    calendar days, every SKU in that store looks ~17% more intermittent than
    it is, and SKUs sitting near the 1.32 cut get pushed across it into a
    different forecasting method entirely. A closed day is not a gap in
    demand; it is a gap in OPPORTUNITY, and the two mean opposite things.

    So the denominator here is the same one every rate in this programme uses:
    days the store was open AND we have data for.

NEW SKUs ARE NOT A SEPARATE PATH
    A SKU with too few demand events to classify is labelled `new_sku`, and
    that label routes it to the cohort prior through
    `app/pipeline/blend/shrink.py` - the same formula every other SKU goes
    through, with n=0 doing the work. There is no `if is_new:` anywhere in
    this package, and `scripts/check_no_state_branches.py` enforces the
    related rule for `evidence_state`.
"""

from __future__ import annotations

import statistics
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any

from app.pipeline.context import RunContext
from app.pipeline.envelope import StageResult, stage
from app.pipeline.features.store import CalendarDay, DayFact, visible_at, window_bounds
from app.pipeline.provenance import Provenance, record_inputs
from app.pipeline.registry import ConfigRegistry, Setting, cfg

# ── The published cuts ───────────────────────────────────────────────────────
# These two are MEASURED, not PROVISIONAL - among the first four in the
# programme to be. They are not our judgement to make: they come from a
# published empirical study, and changing them would put us outside the
# literature our method names refer to.

_SB_CITATION = (
    "Syntetos, A.A., Boylan, J.E. & Croston, J.D. (2005), 'On the "
    "categorization of demand patterns', Journal of the Operational Research "
    "Society 56(5), 495-503"
)

ADI_CUT = Setting(
    name="forecast.classify.adi_cut",
    default=1.32,
    unit="open days between demands",
    owner="forecasting",
    why="the published Syntetos-Boylan cut separating smooth/erratic from "
        "intermittent/lumpy. Derived as the point where Croston's estimator "
        "stops outperforming a simple moving average. NOT ours to tune: it is "
        "the boundary the method names refer to. " + _SB_CITATION,
    status="MEASURED",
)

CV2_CUT = Setting(
    name="forecast.classify.cv2_cut",
    default=0.49,
    unit="squared coefficient of variation",
    owner="forecasting",
    why="the published Syntetos-Boylan cut separating smooth/intermittent from "
        "erratic/lumpy, i.e. CV = 0.7. Same provenance and the same reason not "
        "to tune it. " + _SB_CITATION,
    status="MEASURED",
)

MIN_DEMAND_EVENTS = Setting(
    name="forecast.classify.min_demand_events",
    default=3,
    unit="days with a non-zero sale",
    owner="forecasting",
    why="provisional; below this there is no interval to average and no "
        "dispersion to measure - two events give one gap and a variance of "
        "whatever noise is in two numbers. Such SKUs are labelled new_sku and "
        "borrow from the cohort instead. To be fitted in wave 6",
    status="PROVISIONAL",
)

MIN_OPEN_DAYS = Setting(
    name="forecast.classify.min_open_days",
    default=14,
    unit="open days in the window",
    owner="forecasting",
    why="provisional; a window with fewer trading days than this cannot "
        "distinguish an intermittent SKU from a store that was simply shut. "
        "Classifying on it would put a label on the store's calendar rather "
        "than on the SKU's demand. To be fitted in wave 6",
    status="PROVISIONAL",
)

#: The four real shapes, plus the label that means "not enough to say".
SMOOTH = "smooth"
INTERMITTENT = "intermittent"
ERRATIC = "erratic"
LUMPY = "lumpy"
NEW_SKU = "new_sku"

DEMAND_CLASSES: tuple[str, ...] = (SMOOTH, INTERMITTENT, ERRATIC, LUMPY, NEW_SKU)

#: Which forecaster each shape routes to. Declared here, next to the
#: classification, so the routing is readable in one place rather than
#: scattered through the ensemble as conditionals.
METHOD_FOR_CLASS: dict[str, str] = {
    SMOOTH: "seasonal_ets",
    INTERMITTENT: "croston",
    ERRATIC: "sba",
    LUMPY: "sba_wide",
    NEW_SKU: "cohort_prior",
}


@dataclass(frozen=True, slots=True)
class ClassifyRequest:
    """One store-SKU's history. Supplied, never fetched."""

    sku: str
    calendar: Sequence[CalendarDay]
    facts: Sequence[DayFact]
    window_days: int = 364
    known_as_of: Any = None


@dataclass(frozen=True, slots=True)
class DemandProfile:
    """The shape, and the two numbers that decided it."""

    sku: str
    demand_class: str
    method: str
    #: None when the SKU could not be classified - never a fabricated number.
    adi: float | None
    cv2: float | None
    #: Days with a non-zero sale. THE count that decides new_sku.
    demand_events: int
    #: The denominator: open AND synced days in the window.
    open_days: int
    mean_size: float | None
    #: Non-zero demand sizes, in open-day order. The bootstrap resamples these.
    sizes: tuple[float, ...]
    #: Gaps between successive demands, in open days. The bootstrap resamples
    #: these too - an intermittent forecast's uncertainty is mostly about WHEN,
    #: not how much.
    intervals: tuple[int, ...]

    def as_dict(self) -> dict[str, Any]:
        return {
            "sku": self.sku,
            "demand_class": self.demand_class,
            "method": self.method,
            "adi": self.adi,
            "cv2": self.cv2,
            "demand_events": self.demand_events,
            "open_days": self.open_days,
            "mean_size": self.mean_size,
        }

    def explain(self) -> str:
        if self.adi is None or self.cv2 is None:
            return (
                f"Not enough history to classify ({self.demand_events} selling "
                f"days over {self.open_days} open days) - estimated from "
                "similar stores instead."
            )
        return (
            f"Sells about every {self.adi:.1f} open days "
            f"({self.demand_events} times in {self.open_days}), "
            f"size variability CV2 {self.cv2:.2f} -> {self.demand_class}."
        )


def open_day_sequence(
    calendar: Sequence[CalendarDay], start: date, end: date
) -> list[date]:
    """The window's OPEN, SYNCED days in order. The one denominator.

    Sorted explicitly rather than trusting the caller's ordering: ADI is a
    statistic about gaps between positions in this list, so an unsorted list
    would produce negative intervals and a silently wrong class.
    """
    return sorted(
        c.obs_date for c in calendar
        if start <= c.obs_date <= end and c.was_open and c.has_data
    )


def _profile_numbers(
    open_days: list[date], units_by_day: dict[date, float]
) -> tuple[list[float], list[int]]:
    """Demand sizes and inter-demand intervals, both in OPEN-day terms.

    Positions are indices into `open_days`, so a Sunday closure does not
    lengthen an interval. Two sales on consecutive trading days either side of
    a closed Sunday are one open day apart, not two.
    """
    sizes: list[float] = []
    positions: list[int] = []
    for index, day in enumerate(open_days):
        units = units_by_day.get(day, 0.0)
        if units > 0:
            sizes.append(float(units))
            positions.append(index)
    intervals = [b - a for a, b in zip(positions, positions[1:], strict=False)]

    # THE TRAILING GAP COUNTS.
    #
    # Gaps between consecutive sales describe only the span from the first
    # sale to the last. Everything after the last sale - a delisted product, a
    # seasonal line out of season, a supplier who stopped delivering - is
    # invisible to them, and Croston divides by exactly this number.
    #
    # Measured on store 122: mean(intervals) came out 1.29 against an ADI of
    # 3.74 for the same SKUs, because so many had sold steadily and then
    # stopped. Croston's rate was 3.3x the empirical rate and the intermittent
    # class lost the backtest by 71.9 WAPE against a seasonal-naive 30.6.
    #
    # Including the silence since the last sale makes mean(intervals) agree
    # with ADI, which is the same quantity measured two ways - and two ways of
    # measuring one thing disagreeing by 3x is the 454-vs-485 problem again.
    #
    # Note what is NOT added: the gap BEFORE the first sale. A product listed
    # six weeks ago must not be charged for the months it was not on the
    # shelf; that is the `days_live` correction demand.py already makes.
    if positions:
        trailing = len(open_days) - 1 - positions[-1]
        if trailing > 0:
            intervals.append(trailing)

    return sizes, intervals


@stage("forecast_classify", "1.0.0")
def classify(
    request: ClassifyRequest, ctx: RunContext, config: ConfigRegistry = cfg
) -> StageResult:
    """Label one store-SKU's demand shape. Always returns a label.

    Returns ok=True in every case. A SKU we cannot classify is `new_sku`, which
    is a true statement about our evidence rather than a failure - and it
    routes to the cohort prior, which always resolves (sheet 05).
    """
    record_inputs("feature_daily.units_sold", "feature_store_day.was_open")

    start, end = window_bounds(ctx, request.window_days)
    open_days = open_day_sequence(request.calendar, start, end)

    # Point-in-time: a row we had not learned yet cannot inform a label we are
    # claiming to have produced on `as_of`.
    facts = [
        f for f in visible_at(request.facts, request.known_as_of)
        if start <= f.obs_date <= end and f.sku == request.sku
    ]
    units_by_day: dict[date, float] = {}
    for fact in facts:
        units = float(fact.units_sold or 0.0)
        if units > 0:
            units_by_day[fact.obs_date] = units_by_day.get(fact.obs_date, 0.0) + units

    sizes, intervals = _profile_numbers(open_days, units_by_day)

    min_events = config.get(MIN_DEMAND_EVENTS, ctx)
    min_open = config.get(MIN_OPEN_DAYS, ctx)

    # Not enough to say. NOT a failure, and not a separate forecasting path -
    # the label routes to the cohort prior, which handles n=0 as a weight.
    if len(open_days) < min_open or len(sizes) < min_events:
        profile = DemandProfile(
            sku=request.sku, demand_class=NEW_SKU,
            method=METHOD_FOR_CLASS[NEW_SKU],
            adi=None, cv2=None, demand_events=len(sizes),
            open_days=len(open_days), mean_size=None,
            sizes=tuple(sizes), intervals=tuple(intervals),
        )
        return StageResult.success(profile, _provenance(profile))

    # ADI: open periods per demand event. The standard Syntetos-Boylan form,
    # p/n, not the mean of the observed gaps - the two differ because the mean
    # of n-1 gaps ignores the time before the first sale and after the last,
    # which is exactly the emptiness that makes a SKU intermittent.
    adi = len(open_days) / len(sizes)

    # CV2 of the demand SIZES - how variable an order is WHEN it happens,
    # which is a different question from how often it happens.
    mean_size = statistics.fmean(sizes)
    # Population stdev, matching velocity.py: these are the sizes we observed,
    # not a sample drawn from a larger set of sizes we did not.
    stdev = statistics.pstdev(sizes) if len(sizes) > 1 else 0.0
    cv2 = (stdev / mean_size) ** 2 if mean_size > 0 else 0.0

    adi_cut = config.get(ADI_CUT, ctx)
    cv2_cut = config.get(CV2_CUT, ctx)

    # The 2x2. Written as a lookup on two booleans rather than a chain of
    # elifs so that all four cells are visibly present and none can be
    # accidentally unreachable.
    quadrant = {
        (False, False): SMOOTH,
        (True, False): INTERMITTENT,
        (False, True): ERRATIC,
        (True, True): LUMPY,
    }
    demand_class = quadrant[(adi >= adi_cut, cv2 >= cv2_cut)]

    profile = DemandProfile(
        sku=request.sku,
        demand_class=demand_class,
        method=METHOD_FOR_CLASS[demand_class],
        adi=adi,
        cv2=cv2,
        demand_events=len(sizes),
        open_days=len(open_days),
        mean_size=mean_size,
        sizes=tuple(sizes),
        intervals=tuple(intervals),
    )
    return StageResult.success(profile, _provenance(profile))


def _provenance(profile: DemandProfile) -> Provenance:
    return Provenance(
        own_observations=profile.demand_events,
        # 1.0: the classification is derived entirely from this store's own
        # history. The blend weight that the card shows is sheet 06's, and
        # this is not it.
        own_weight=1.0,
        evidence_state="NEW" if profile.demand_class == NEW_SKU else "ESTABLISHED",
        inputs=("feature_daily.units_sold", "feature_store_day.was_open"),
    )


__all__ = [
    "ADI_CUT",
    "CV2_CUT",
    "DEMAND_CLASSES",
    "ERRATIC",
    "INTERMITTENT",
    "LUMPY",
    "METHOD_FOR_CLASS",
    "MIN_DEMAND_EVENTS",
    "MIN_OPEN_DAYS",
    "NEW_SKU",
    "SMOOTH",
    "ClassifyRequest",
    "DemandProfile",
    "classify",
    "open_day_sequence",
]
