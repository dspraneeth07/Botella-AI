"""Evidence counting — how much this store actually knows.

Everything downstream needs one number: **n**, the count of usable
observations behind an estimate. It decides the shrinkage weight in sheet 06,
the interval width in sheet 07, the confidence in sheet 15 and the
evidence-state label the owner sees.

The current engine has no such number, which is precisely why it was equally
confident about a store with four years of history and one with three weeks.

**n IS NOT ROW COUNT.** It is usable observations *for the specific pattern
being estimated*, and it differs per pattern:

    day_of_week   open days per weekday inside the window
    weekly_trend  complete weeks having >= 4 open days
    monthly       complete years covering the target month
    sku_velocity  open days with a non-null price for that SKU
    category      open days with any sale in the category

Everything here reads from the feature store (`app/pipeline/features/store.py`)
and **never counts a closed day**. That is not a stylistic preference: on
Bethany (171:171), counting calendar days instead of open days overstates the
denominator by 14.7%, which flows straight into every interval and every
confidence downstream.

THE THIRD STATE, which the sheet does not name but the data demands.
A pattern can be:

    sufficient      n is at or above the floor — estimate away
    insufficient    n is below the floor — we could know this, we just don't yet
    NOT APPLICABLE  n is structurally zero — this store never trades then

Bethany closes every Sunday. Its Sunday day-of-week evidence is not "thin",
it is **absent by construction**, and reporting it as low-confidence would
invite someone to go and collect more of it. Measured: over a trailing year,
4 of the estate's stores show a minimum of ONE observation on their worst
weekday — almost always because they are closed that day, not because they are
new. Conflating those two is the difference between "wait a month" and "this
will never happen".
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from app.pipeline.context import RunContext
from app.pipeline.envelope import StageResult, stage
from app.pipeline.features.store import CalendarDay, DayFact, visible_at, window_bounds
from app.pipeline.provenance import EvidenceState, Provenance, record_inputs
from app.pipeline.registry import ConfigRegistry, Setting, cfg

# ── Patterns ─────────────────────────────────────────────────────────────────

PATTERNS = ("day_of_week", "weekly_trend", "monthly", "sku_velocity", "category",
            "elasticity")

#: Sufficiency verdicts. NOT_APPLICABLE is structural, not a shortage.
SUFFICIENCY = ("sufficient", "insufficient", "not_applicable")

DAYS_PER_WEEK = 7
PERCENT = 100


# ── Floors, declared once with an owner and a reason ─────────────────────────

DOW_MIN_OBSERVATIONS = Setting(
    name="evidence.day_of_week.min_observations",
    default=8,
    unit="open days for that weekday",
    owner="evidence",
    why="provisional; eight same-weekday observations is two months of a "
        "weekly cycle, enough to separate a Friday effect from noise. The "
        "sheet's sanity reference (store 122, 52 per weekday over a year) is "
        "a healthy 7-day store, not a floor. To be fitted in wave 6",
    status="PROVISIONAL",
)

WEEKLY_MIN_OPEN_DAYS = Setting(
    name="evidence.weekly_trend.min_open_days_per_week",
    default=4,
    unit="open days",
    owner="evidence",
    why="the sheet's definition: a week counts as complete at >= 4 open days. "
        "Below that the week's total is a partial sample masquerading as a "
        "weekly figure",
    status="PROVISIONAL",
)

WEEKLY_MIN_WEEKS = Setting(
    name="evidence.weekly_trend.min_weeks",
    default=13,
    unit="complete weeks",
    owner="evidence",
    why="provisional; the sheet says a weekly trend 'needs roughly a quarter "
        "before it says anything'. 13 weeks is that quarter",
    status="PROVISIONAL",
)

MONTHLY_MIN_YEARS = Setting(
    name="evidence.monthly.min_years",
    default=2,
    unit="complete years covering the target month",
    owner="evidence",
    why="the sheet's floor: two years minimum, because one prior December "
        "cannot tell a seasonal pattern from a one-off. Most of the estate "
        "fails this, which is why sheet 05 exists",
    status="PROVISIONAL",
)

MONTHLY_MIN_OPEN_DAYS = Setting(
    name="evidence.monthly.min_open_days_in_month",
    default=20,
    unit="open days",
    owner="evidence",
    why="provisional; a year 'covers' the target month only if the store was "
        "actually trading through it. 20 open days is a month with at most a "
        "week missing",
    status="PROVISIONAL",
)

SKU_MIN_OPEN_DAYS = Setting(
    name="evidence.sku_velocity.min_open_days",
    default=14,
    unit="open days with a known price",
    owner="evidence",
    why="provisional; two trading weeks. The sheet notes intermittent SKUs are "
        "the majority, so this floor is what routes most SKUs to the peer "
        "cohort rather than to their own thin history",
    status="PROVISIONAL",
)

CATEGORY_MIN_OPEN_DAYS = Setting(
    name="evidence.category.min_open_days",
    default=14,
    unit="open days with a sale in the category",
    owner="evidence",
    why="provisional; the SKU floor applied one level up, where the pooling "
        "makes it easier to clear",
    status="PROVISIONAL",
)

RARE_WEEKDAY_PCT = Setting(
    name="evidence.day_of_week.rare_weekday_pct",
    default=20,
    unit="percent of that weekday's occurrences in the window",
    owner="evidence",
    why="provisional; a weekday the store trades on fewer than 20% of its "
        "occurrences is not a thin sample, it is a day the store does not "
        "normally open. MEASURED: Bethany (171:171) traded ONE Sunday out of "
        "52 - without this the weakest-weekday rule reported n=1 for a store "
        "with 49-52 observations on every day it actually trades. To be "
        "fitted in wave 6",
    status="PROVISIONAL",
)

MATURE_MULTIPLE = Setting(
    name="evidence.mature_multiple",
    default=4,
    unit="multiples of the pattern floor",
    owner="evidence",
    why="provisional; evidence_state becomes MATURE at 4x the floor, which is "
        "where adding observations stops moving the estimate much",
    status="PROVISIONAL",
)


# ── Request / result ─────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class EvidenceRequest:
    """Everything a count needs, supplied by the caller. Never fetched."""

    pattern: str
    calendar: Sequence[CalendarDay]
    facts: Sequence[DayFact] = ()
    window_days: int = 364
    sku: str | None = None
    category: str | None = None
    #: sku -> category, for the `category` pattern.
    category_by_sku: dict[str, str] | None = None
    #: For `monthly`: which month is being estimated. Defaults to ctx.as_of's.
    target_month: int | None = None
    known_as_of: Any = None

    def __post_init__(self) -> None:
        if self.pattern not in PATTERNS:
            raise ValueError(f"unknown pattern {self.pattern!r}; expected one of {PATTERNS}")


@dataclass(frozen=True, slots=True)
class EvidenceCount:
    """n, plus enough context to know what it means."""

    pattern: str
    #: THE number. Consumed by shrinkage, intervals and confidence downstream.
    n: int
    floor: int
    sufficiency: str
    #: Per-bucket detail — weekday -> n, year -> n, and so on.
    breakdown: dict[str, int]
    #: Buckets that are structurally absent (a weekday the store never trades).
    not_applicable: tuple[str, ...]
    open_days_in_window: int
    window_days: int
    start_date: date
    end_date: date
    note: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "pattern": self.pattern, "n": self.n, "floor": self.floor,
            "sufficiency": self.sufficiency, "breakdown": dict(self.breakdown),
            "not_applicable": list(self.not_applicable),
            "open_days_in_window": self.open_days_in_window,
            "window_days": self.window_days,
            "start_date": self.start_date.isoformat(),
            "end_date": self.end_date.isoformat(),
            "note": self.note,
        }


WEEKDAY_NAMES = ("monday", "tuesday", "wednesday", "thursday", "friday",
                 "saturday", "sunday")


def _evidence_state(n: int, floor: int, mature_multiple: int) -> EvidenceState:
    if floor <= 0:
        return "NEW" if n == 0 else "ESTABLISHED"
    if n >= floor * mature_multiple:
        return "MATURE"
    if n >= floor:
        return "ESTABLISHED"
    if n > 0:
        return "EMERGING"
    return "NEW"


def _open_days(calendar: Sequence[CalendarDay], start: date, end: date) -> list[CalendarDay]:
    """Open AND synced. A day we have not received is no more countable than a
    Sunday - see features/store.py for why those are separate flags."""
    return [c for c in calendar if start <= c.obs_date <= end and c.was_open and c.has_data]


# ── The counter ──────────────────────────────────────────────────────────────


@stage("evidence_count", "1.0.0")
def count_evidence(
    request: EvidenceRequest, ctx: RunContext, config: ConfigRegistry = cfg
) -> StageResult:
    """How many usable observations stand behind this pattern for this store?

    Returns ok=True with n even when n is zero — "this store knows nothing
    about that" is a legitimate, useful answer and every caller needs it. The
    only failure is a request that cannot be evaluated at all (no calendar).

    `Provenance.own_observations` is set to n, because that is the number every
    later stage consumes.
    """
    record_inputs("feature_store_day.was_open", "feature_store_day.has_data")

    start, end = window_bounds(ctx, request.window_days)
    open_days = _open_days(request.calendar, start, end)
    mature_multiple = config.get(MATURE_MULTIPLE, ctx)

    # The guard is PATTERN-AWARE. `monthly` deliberately looks across the whole
    # calendar rather than a trailing window (a seasonal question is about the
    # same month in prior years), so requiring rows inside the window would
    # refuse every store whose last twelve months happen to be quiet while it
    # holds three Decembers of history. Caught by test.
    relevant = (
        request.calendar if request.pattern == "monthly"
        else [c for c in request.calendar if start <= c.obs_date <= end]
    )
    if not relevant:
        return StageResult.failure(
            "no_calendar_for_window" if request.pattern != "monthly"
            else "no_calendar_at_all",
            provenance=Provenance(own_observations=0, own_weight=1.0,
                                  evidence_state="NEW"),
        )

    facts = [
        f for f in visible_at(request.facts, request.known_as_of)
        if start <= f.obs_date <= end
    ]

    handler = {
        "day_of_week": _count_day_of_week,
        "weekly_trend": _count_weekly_trend,
        "monthly": _count_monthly,
        "sku_velocity": _count_sku_velocity,
        "category": _count_category,
        "elasticity": _count_elasticity,
    }[request.pattern]

    count = handler(request, ctx, config, open_days, facts, start, end)

    provenance = Provenance(
        own_observations=count.n,
        own_weight=1.0,
        evidence_state=_evidence_state(count.n, count.floor, mature_multiple),
        inputs=("feature_store_day", "feature_daily"),
    )

    reasons: list[str] = []
    if count.sufficiency == "insufficient":
        reasons.append(f"insufficient_evidence:{count.pattern}:{count.n}<{count.floor}")
    if count.sufficiency == "not_applicable":
        reasons.append(f"not_applicable:{count.pattern}")
    if count.not_applicable:
        reasons.append(f"structurally_absent:{','.join(count.not_applicable)}")

    return StageResult.success(count, provenance, reasons=tuple(reasons))


# ── Per-pattern counters ─────────────────────────────────────────────────────


def _count_day_of_week(request: EvidenceRequest, ctx: RunContext, config: ConfigRegistry,
                     open_days: list[CalendarDay], facts: list[DayFact],
                     start: date, end: date) -> EvidenceCount:
    """Open days per weekday. n is the WEAKEST weekday, not the total.

    The minimum rather than the mean, because a day-of-week model is only as
    good as its thinnest bucket: 300 Saturdays do not help you predict a
    Tuesday.

    A weekday with ZERO open days is structurally absent, not thin. Bethany
    trades six days a week; its Sunday bucket is empty because the store is
    shut, and calling that "insufficient" would suggest waiting for data that
    will never arrive.
    """
    floor = config.get(DOW_MIN_OBSERVATIONS, ctx)
    rare_pct = config.get(RARE_WEEKDAY_PCT, ctx)

    per_weekday = dict.fromkeys(WEEKDAY_NAMES, 0)
    for day in open_days:
        per_weekday[WEEKDAY_NAMES[day.obs_date.weekday()]] += 1

    # How many times each weekday even OCCURRED in the window, so "traded 1 of
    # 52 Sundays" can be told from "traded 1 of 1 Sunday in a one-week window".
    occurrences = dict.fromkeys(WEEKDAY_NAMES, 0)
    cursor = start
    while cursor <= end:
        occurrences[WEEKDAY_NAMES[cursor.weekday()]] += 1
        cursor += timedelta(days=1)

    # A weekday traded on almost none of its occurrences is a day the store
    # does not normally open, NOT a thin sample. MEASURED: Bethany traded one
    # Sunday out of 52, and the weakest-weekday rule then reported n=1 for a
    # store with 49-52 observations on every day it genuinely trades. Folding
    # those rare days into `not_applicable` keeps the headline honest.
    def _is_rare(name: str) -> bool:
        seen, possible = per_weekday[name], occurrences[name]
        return possible > 0 and 0 < PERCENT * seen < rare_pct * possible

    absent = tuple(
        name for name, n in per_weekday.items() if n == 0 or _is_rare(name)
    )
    traded = {
        name: n for name, n in per_weekday.items() if n > 0 and not _is_rare(name)
    }

    if not traded:
        return EvidenceCount(
            pattern="day_of_week", n=0, floor=floor, sufficiency="not_applicable",
            breakdown=per_weekday, not_applicable=absent,
            open_days_in_window=len(open_days), window_days=request.window_days,
            start_date=start, end_date=end,
            note="the store has no open days in this window",
        )

    n = min(traded.values())
    return EvidenceCount(
        pattern="day_of_week", n=n, floor=floor,
        sufficiency="sufficient" if n >= floor else "insufficient",
        breakdown=per_weekday, not_applicable=absent,
        open_days_in_window=len(open_days), window_days=request.window_days,
        start_date=start, end_date=end,
        note=(
            f"n is the weakest of {len(traded)} regularly-traded weekdays; "
            f"{len(absent)} weekday(s) not regularly traded"
            if absent else f"n is the weakest of {len(traded)} traded weekdays"
        ),
    )


def _count_weekly_trend(request: EvidenceRequest, ctx: RunContext, config: ConfigRegistry,
                     open_days: list[CalendarDay], facts: list[DayFact],
                     start: date, end: date) -> EvidenceCount:
    """Complete weeks — those with >= 4 open days. The sheet's definition."""
    min_open = config.get(WEEKLY_MIN_OPEN_DAYS, ctx)
    floor = config.get(WEEKLY_MIN_WEEKS, ctx)

    by_week: dict[str, int] = {}
    for day in open_days:
        iso = day.obs_date.isocalendar()
        by_week[f"{iso.year}-W{iso.week:02d}"] = by_week.get(f"{iso.year}-W{iso.week:02d}", 0) + 1

    # Only count weeks FULLY inside the window; a partial week at either edge
    # looks incomplete for a reason that has nothing to do with the store.
    complete = {
        week: n for week, n in by_week.items()
        if n >= min_open and _week_fully_inside(week, start, end)
    }
    n = len(complete)
    return EvidenceCount(
        pattern="weekly_trend", n=n, floor=floor,
        sufficiency="sufficient" if n >= floor else "insufficient",
        breakdown=dict(sorted(by_week.items())), not_applicable=(),
        open_days_in_window=len(open_days), window_days=request.window_days,
        start_date=start, end_date=end,
        note=f"{n} of {len(by_week)} weeks had >= {min_open} open days and sit "
             "fully inside the window",
    )


def _week_fully_inside(iso_week: str, start: date, end: date) -> bool:
    year, week = iso_week.split("-W")
    monday = date.fromisocalendar(int(year), int(week), 1)
    return monday >= start and monday + timedelta(days=DAYS_PER_WEEK - 1) <= end


def _count_monthly(request: EvidenceRequest, ctx: RunContext, config: ConfigRegistry,
                     open_days: list[CalendarDay], facts: list[DayFact],
                     start: date, end: date) -> EvidenceCount:
    """Complete YEARS covering the target month. Two minimum.

    Deliberately ignores `window_days`: a seasonal question is about the same
    month in prior years, so it looks across the whole calendar it was given
    rather than a trailing window.
    """
    floor = config.get(MONTHLY_MIN_YEARS, ctx)
    min_days = config.get(MONTHLY_MIN_OPEN_DAYS, ctx)
    month = request.target_month or ctx.as_of.month

    per_year: dict[str, int] = {}
    for day in request.calendar:
        if day.was_open and day.has_data and day.obs_date.month == month:
            per_year[str(day.obs_date.year)] = per_year.get(str(day.obs_date.year), 0) + 1

    # The current year does not count: the month is not over, so it cannot
    # show what the month looks like.
    covered = {
        year: n for year, n in per_year.items()
        if n >= min_days and int(year) < ctx.as_of.year
    }
    n = len(covered)
    return EvidenceCount(
        pattern="monthly", n=n, floor=floor,
        sufficiency="sufficient" if n >= floor else "insufficient",
        breakdown=dict(sorted(per_year.items())), not_applicable=(),
        open_days_in_window=len(open_days), window_days=request.window_days,
        start_date=start, end_date=end,
        note=f"month {month:02d}: {n} complete prior year(s) with >= {min_days} open days",
    )


ELASTICITY_MIN_PRICE_LEVELS = Setting(
    name="evidence.elasticity.min_price_levels",
    default=5,
    unit="distinct observed price levels",
    owner="forecasting",
    why="provisional; a regression of units on price needs price to actually "
        "move. Below five distinct levels the slope is fitted through a "
        "cluster of near-identical points and its interval will swamp it - "
        "which is the honest answer, but there is no point spending the fit "
        "to get there. To be measured in wave 6",
    status="PROVISIONAL",
)


def _count_elasticity(request: EvidenceRequest, ctx: RunContext, config: ConfigRegistry,
                      open_days: list[CalendarDay], facts: list[DayFact],
                      start: date, end: date) -> EvidenceCount:
    """DISTINCT PRICE LEVELS, not days. The identifying variation.

    Every other pattern counts observations, because for every other pattern
    an observation is a unit of evidence. Elasticity is different: two hundred
    days at a single price tell you NOTHING about what happens when the price
    moves. The evidence for a price effect is price variation, and counting
    days instead would report a confident n for a store that has never once
    changed a price.

    Prices are rounded to the cent before counting, so a half-cent of
    floating-point drift cannot manufacture a second "level" out of one.
    """
    floor = config.get(ELASTICITY_MIN_PRICE_LEVELS, ctx)
    open_dates = {c.obs_date for c in open_days}
    category = request.category
    by_sku = request.category_by_sku or {}

    levels: set[float] = set()
    usable = 0
    for fact in facts:
        if fact.obs_date not in open_dates:
            continue
        price = fact.price
        units = fact.units_sold
        if price is None or price <= 0 or units is None or units <= 0:
            continue
        if category is not None and by_sku.get(fact.sku) != category:
            continue
        usable += 1
        levels.add(round(float(price), 2))

    n = len(levels)
    return EvidenceCount(
        pattern="elasticity", n=n, floor=floor,
        sufficiency="sufficient" if n >= floor else "insufficient",
        breakdown={
            "distinct_price_levels": n,
            "usable_observations": usable,
        },
        not_applicable=(),
        open_days_in_window=len(open_days),
        window_days=request.window_days,
        start_date=start,
        end_date=end,
    )


def _count_sku_velocity(request: EvidenceRequest, ctx: RunContext, config: ConfigRegistry,
                     open_days: list[CalendarDay], facts: list[DayFact],
                     start: date, end: date) -> EvidenceCount:
    """Open days carrying a non-null PRICE for this SKU.

    Price rather than units on purpose. A day the SKU was stocked and priced
    but sold nothing is a real observation of zero demand; a day we have no
    price for is a day we know nothing about. Counting only days with sales
    would make every intermittent SKU look like it has no history, when in
    fact it has a long history of not selling — which is exactly the thing a
    reorder decision needs to know.
    """
    floor = config.get(SKU_MIN_OPEN_DAYS, ctx)
    sku = request.sku
    if not sku:
        raise ValueError("sku_velocity requires request.sku")

    open_dates = {c.obs_date for c in open_days}
    priced = {
        f.obs_date for f in facts
        if f.sku == sku and f.price is not None and f.obs_date in open_dates
    }
    with_sales = {
        f.obs_date for f in facts
        if f.sku == sku and f.units_sold not in (None, 0) and f.obs_date in open_dates
    }
    n = len(priced)
    return EvidenceCount(
        pattern="sku_velocity", n=n, floor=floor,
        sufficiency="sufficient" if n >= floor else "insufficient",
        breakdown={"open_days_priced": n, "open_days_with_sales": len(with_sales),
                   "open_days_in_window": len(open_days)},
        not_applicable=(),
        open_days_in_window=len(open_days), window_days=request.window_days,
        start_date=start, end_date=end,
        note=f"{sku}: priced on {n} of {len(open_days)} open days; "
             f"sold on {len(with_sales)}",
    )


def _count_category(request: EvidenceRequest, ctx: RunContext, config: ConfigRegistry,
                     open_days: list[CalendarDay], facts: list[DayFact],
                     start: date, end: date) -> EvidenceCount:
    """Open days with any sale in the category."""
    floor = config.get(CATEGORY_MIN_OPEN_DAYS, ctx)
    category = request.category
    if not category:
        raise ValueError("category pattern requires request.category")

    by_sku = request.category_by_sku or {}
    open_dates = {c.obs_date for c in open_days}
    days = {
        f.obs_date for f in facts
        if by_sku.get(f.sku) == category and f.units_sold not in (None, 0)
        and f.obs_date in open_dates
    }
    n = len(days)
    skus = {f.sku for f in facts if by_sku.get(f.sku) == category}
    return EvidenceCount(
        pattern="category", n=n, floor=floor,
        sufficiency="sufficient" if n >= floor else "insufficient",
        breakdown={"open_days_with_sale": n, "distinct_skus": len(skus),
                   "open_days_in_window": len(open_days)},
        not_applicable=(),
        open_days_in_window=len(open_days), window_days=request.window_days,
        start_date=start, end_date=end,
        note=f"{category}: sold on {n} of {len(open_days)} open days across "
             f"{len(skus)} SKU(s)",
    )


# ── All patterns at once ─────────────────────────────────────────────────────


@stage("evidence_profile", "1.0.0")
def evidence_profile(
    request: EvidenceRequest, ctx: RunContext, config: ConfigRegistry = cfg
) -> StageResult:
    """Every applicable pattern for one store, in one read.

    What sheet 15 renders as "how much we know about your store", and what
    sheet 06 reads to decide how hard to shrink toward the peer cohort.
    """
    results: dict[str, dict[str, Any]] = {}
    refused: dict[str, tuple[str, ...]] = {}

    wanted = ["day_of_week", "weekly_trend", "monthly"]
    if request.sku:
        wanted.append("sku_velocity")
    if request.category:
        wanted.append("category")

    for pattern in wanted:
        outcome = count_evidence(
            EvidenceRequest(
                pattern=pattern, calendar=request.calendar, facts=request.facts,
                window_days=request.window_days, sku=request.sku,
                category=request.category, category_by_sku=request.category_by_sku,
                target_month=request.target_month, known_as_of=request.known_as_of,
            ),
            ctx, config,
        )
        if outcome.ok and outcome.value is not None:
            results[pattern] = outcome.value.as_dict()
        else:
            refused[pattern] = outcome.reasons

    start, end = window_bounds(ctx, request.window_days)
    open_days = len(_open_days(request.calendar, start, end))
    provenance = Provenance(
        own_observations=open_days,
        own_weight=1.0,
        evidence_state=_evidence_state(
            open_days, config.get(WEEKLY_MIN_WEEKS, ctx),
            config.get(MATURE_MULTIPLE, ctx),
        ),
        inputs=("feature_store_day", "feature_daily"),
    )
    if not results:
        return StageResult.failure("no_pattern_could_be_counted", provenance=provenance)
    return StageResult.success(
        {"patterns": results, "refused": {k: list(v) for k, v in refused.items()},
         "open_days_in_window": open_days},
        provenance,
    )


__all__ = [
    "CATEGORY_MIN_OPEN_DAYS",
    "DOW_MIN_OBSERVATIONS",
    "MONTHLY_MIN_YEARS",
    "RARE_WEEKDAY_PCT",
    "PATTERNS",
    "SKU_MIN_OPEN_DAYS",
    "SUFFICIENCY",
    "WEEKDAY_NAMES",
    "WEEKLY_MIN_WEEKS",
    "EvidenceCount",
    "EvidenceRequest",
    "count_evidence",
    "evidence_profile",
]
