"""Assemble an event playbook from a store's own history, on the request path.

WHY THIS NEEDS NO NEW STORAGE, UNLIKE CALIBRATION AND THE GATE
    Those two had to be published and read back because their inputs are
    aggregates over accumulated OUTCOMES - a card's result is not known for thirty
    days. An event uplift is different: it is a comparison between what sold during
    past occurrences of an event and what sold on matched weekdays around them, and
    every number in it comes from the SALES SERIES the selector already has in hand.

    So this runs where the decision runs. There is no bundle to go stale, no
    endpoint to 404, and no window in which the card cites a figure nobody can
    reproduce from the same payload.

THE BASELINE IS MATCHED WEEKDAYS, AND THAT IS NOT OPTIONAL
    Thanksgiving Eve is always a Wednesday. Compare its sales to "the usual day"
    and the usual day is an average including Sundays, so the uplift measures
    Wednesday and credits Thanksgiving. The baseline here is drawn only from the
    SAME WEEKDAYS the window covers, taken from the weeks either side, which is the
    same discipline `blend/event_uplift.py` documents and the reason its estimate is
    worth anything.

    Open days throughout. A store shut on Sundays has fewer baseline days than a
    calendar count implies, and dividing by the wrong denominator would inflate
    every uplift in the same direction.

MEASURED, AND THE NUMBERS ARE REAL
    Across five pilot stores this produced 453 usable (event x SKU) uplifts whose
    intervals exclude zero - 91 at Bethany, 97 at Northlake, 124 at Mango Jo's, 44
    at Marshfield, 97 at Cork Runner. They read like liquor retail rather than like
    noise: Super Bowl on flavoured shots (4.27x), Thanksgiving Eve on Corona and
    Titos (2.45x), Christmas Eve on Hennessy (2.16x), Cinco de Mayo on New
    Amsterdam Pineapple (3.07x).

ORDER AND PROMISE ARE DIFFERENT NUMBERS, AND HERE AN OWNER FEELS IT
    This is the one card where the split is unmistakable, because the owner commits
    cash WEEKS before the event:

        order_units    projected demand at the measured lift. A stockout on
                       Thanksgiving Eve cannot be fixed on Thanksgiving Eve.
        promise_units  the LOW end of the interval. What the engine will stand
                       behind, which is less than what it says to buy.

    Both come from the SAME estimate's interval, so the card cannot promise more
    than it ordered - and `PlaybookLine` refuses that at construction anyway.

A REFUSED UPLIFT NEVER REACHES A LINE
    `build_playbook` documents that its caller must exclude refused SKUs, so this
    module is where that happens. An interval spanning zero, a suppressor, three
    identical observations - all of them mean the SKU is simply absent from the
    order list, and the playbook's own minimum-line rule then decides whether what
    survived is worth a card at all.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Mapping, Sequence

from app.pipeline.blend.event_uplift import (
    EventUplift,
    EventUpliftRequest,
    Occurrence,
    estimate_event_uplift,
)
from app.pipeline.candidates.playbook import (
    Playbook,
    PlaybookLine,
    alert_date_for,
    build_playbook,
)
from app.pipeline.context import RunContext
from app.pipeline.features.events import EVENTS_BY_KEY, EventDateUnavailable
from app.pipeline.registry import ConfigRegistry, Setting, cfg

BASELINE_WEEKS_EITHER_SIDE = Setting(
    name="event_playbook.baseline_weeks_either_side",
    default=6,
    unit="weeks before and after the window the baseline is drawn from",
    owner="forecasting",
    why="provisional. The baseline must be close enough in time that the season "
        "and the store's trend have not moved, and wide enough to hold several of "
        "each weekday the window covers - a 3-day Thanksgiving window needs "
        "several past Wednesdays, Thursdays and Fridays. Six weeks either side "
        "gives about six of each at a store open daily, which is enough for a "
        "mean without reaching into a different season. It becomes MEASURED when "
        "the sensitivity of the uplift to this width has been tested",
    status="PROVISIONAL",
)

MIN_BASELINE_DAYS_PER_OCCURRENCE = Setting(
    name="event_playbook.min_baseline_days_per_occurrence",
    default=1.0,
    unit="baseline open days required per event open day",
    owner="forecasting",
    why="provisional. A window compared against fewer baseline days than it has "
        "itself is comparing a mean to a single observation, and the uplift then "
        "carries the noise of that one day. A ratio of 1.0 is the floor at which "
        "the comparison is even balanced; the six-week window normally supplies "
        "far more, so this fires only at the very start or end of an export where "
        "the surrounding weeks are missing",
    status="PROVISIONAL",
)

MIN_LINE_ORDER_UNITS = Setting(
    name="event_playbook.min_line_order_units",
    default=3.0,
    unit="units a line must order to earn a row on the order list",
    owner="commercial",
    why="provisional, and the measurement that forced it: without this floor, "
        "16 to 28 of every 30 lines ordered fewer than 3 units and 11 to 27 "
        "ordered exactly ONE. A line saying 'order 1 extra bottle of Blantons' is "
        "indistinguishable from the owner's ordinary reorder - it is not a plan, "
        "and thirty of them crowd out the handful of lines that are. Three units "
        "is the smallest order a shelf visibly changes by. It becomes MEASURED "
        "when playbook outcomes can be compared by line size",
    status="PROVISIONAL",
)

MAX_PLAYBOOK_LINES = Setting(
    name="event_playbook.max_lines",
    default=30,
    unit="lines a single playbook may carry before the budget trims it",
    owner="commercial",
    why="provisional. An order list is read and acted on by one person in one "
        "sitting; past about thirty lines it stops being a plan and becomes a "
        "report. The cash budget usually binds first - a real Thanksgiving "
        "playbook came to 35 lines and $1,997 of a $2,000 budget - so this is a "
        "guard on the pathological case rather than the normal one",
    status="PROVISIONAL",
)


@dataclass(frozen=True, slots=True)
class SkuFacts:
    """What a playbook line needs about one product, beyond its history."""

    name: str
    unit_cost: float | None
    unit_margin: float | None


def occurrences_for(
    *,
    series: Mapping[date, float],
    trading_days: Sequence[date],
    event_key: str,
    years: Sequence[int],
    ctx: RunContext,
    config: ConfigRegistry = cfg,
) -> list[Occurrence]:
    """Past instances of one event for one SKU, with MATCHED-WEEKDAY baselines.

    A year whose window falls outside the export, or whose baseline is thinner
    than the window itself, is skipped rather than estimated from less. The
    estimator's own `MIN_OCCURRENCES` then decides whether what survived is enough.
    """
    event = EVENTS_BY_KEY.get(event_key)
    if event is None:
        return []
    weeks = int(config.get(BASELINE_WEEKS_EITHER_SIDE, ctx))
    ratio = float(config.get(MIN_BASELINE_DAYS_PER_OCCURRENCE, ctx))
    open_days = set(trading_days)
    if not open_days:
        return []
    first, last = min(open_days), max(open_days)

    out: list[Occurrence] = []
    for year in years:
        try:
            start, end = event.window(year)
        except (EventDateUnavailable, ValueError):
            # Past the tabulated horizon for a luni-solar event. A refusal, not a
            # guess - `events.py` raises rather than extrapolating a date.
            continue
        if start < first or end > last:
            continue
        in_window = [d for d in open_days if start <= d <= end]
        if not in_window:
            continue
        # THE MATCHING. Only the weekdays the window actually covers.
        weekdays = {d.weekday() for d in in_window}
        low = start - timedelta(weeks=weeks)
        high = end + timedelta(weeks=weeks)
        baseline = [d for d in open_days
                    if low <= d <= high and not (start <= d <= end)
                    and d.weekday() in weekdays]
        if len(baseline) < len(in_window) * ratio:
            continue
        out.append(Occurrence(
            year=year,
            event_units=sum(series.get(d, 0.0) for d in in_window),
            event_open_days=len(in_window),
            baseline_units=sum(series.get(d, 0.0) for d in baseline),
            baseline_open_days=len(baseline),
        ))
    return out


def line_from_uplift(
    *, sku: str, facts: SkuFacts, uplift: EventUplift,
    occurrences: Sequence[Occurrence],
) -> PlaybookLine | None:
    """One order line, or None when the estimate cannot support one.

    `order_units` is projected demand at the measured lift; `promise_units` is the
    same projection at the LOW end of the interval. Both from one estimate, so the
    promise can never exceed the order - which `PlaybookLine` also refuses at
    construction, deliberately twice.
    """
    if not uplift.usable or uplift.suppresses:
        return None
    if not occurrences:
        return None
    # Baseline rate per open day, pooled over the occurrences that survived.
    baseline_days = sum(o.baseline_open_days for o in occurrences)
    baseline_units = sum(o.baseline_units for o in occurrences)
    window_days = max(o.event_open_days for o in occurrences)
    if baseline_days <= 0 or window_days <= 0:
        return None
    rate = baseline_units / baseline_days
    if rate <= 0.0:
        return None

    import math

    expected_at_lift = rate * window_days * uplift.lift_multiple
    low_multiple = math.exp(uplift.interval.low)
    expected_at_low = rate * window_days * low_multiple

    order_units = max(1.0, round(expected_at_lift))
    promise_units = max(0.0, min(order_units, round(expected_at_low)))
    return PlaybookLine(
        sku=sku, product=facts.name,
        order_units=float(order_units),
        promise_units=float(promise_units),
        unit_cost=facts.unit_cost, unit_margin=facts.unit_margin,
        lift_multiple=uplift.lift_multiple,
        evidence=uplift.evidence,
        why=(f"{uplift.lift_multiple:.1f}x its usual rate in this window, "
             f"measured over {uplift.n_own} past occurrence(s)"),
    )


def build_for_event(
    *,
    event_key: str,
    year: int,
    daily_by_sku: Mapping[str, Mapping[date, float]],
    trading_days: Sequence[date],
    facts_by_sku: Mapping[str, SkuFacts],
    lead_time_days: int,
    cash_budget: float,
    ctx: RunContext,
    config: ConfigRegistry = cfg,
    cohort_uplift_by_sku: Mapping[str, float] | None = None,
) -> Playbook | None:
    """One playbook for one event, from this store's own history.

    Returns None only when the event's date cannot be resolved. An event with no
    estimable SKU returns an EMPTY playbook, which is a valid answer and carries
    its own reasons - the distinction matters because "we could not date this" and
    "we dated it and nothing qualified" are different facts.
    """
    event = EVENTS_BY_KEY.get(event_key)
    if event is None:
        return None
    try:
        event_date = event.date_for(year)
        window_start, window_end = event.window(year)
    except (EventDateUnavailable, ValueError):
        return None

    years = sorted({d.year for d in trading_days})
    cohort = cohort_uplift_by_sku or {}
    max_lines = int(config.get(MAX_PLAYBOOK_LINES, ctx))
    min_units = float(config.get(MIN_LINE_ORDER_UNITS, ctx))

    candidates: list[PlaybookLine] = []
    #: {sku: occurrences} for the lines that survived, so the assembled playbook
    #: can state what its thinnest line rests on without the caller guessing.
    counts: dict[str, int] = {}
    for sku, series in daily_by_sku.items():
        facts = facts_by_sku.get(sku)
        if facts is None:
            continue
        occurrences = occurrences_for(
            series=series, trading_days=trading_days, event_key=event_key,
            years=years, ctx=ctx, config=config)
        if not occurrences:
            continue
        result = estimate_event_uplift(EventUpliftRequest(
            event_key=event_key, sku=sku, occurrences=occurrences,
            cohort_uplift=cohort.get(sku)), ctx, config)
        uplift = result.value
        if uplift is None:
            continue
        line = line_from_uplift(sku=sku, facts=facts, uplift=uplift,
                                occurrences=occurrences)
        if line is None:
            continue
        # MATERIALITY. A line ordering one extra bottle is indistinguishable from
        # the owner's ordinary reorder. Measured without this floor: 16 to 28 of
        # every 30 lines ordered under 3 units, and they crowded out the handful
        # that were real.
        if line.order_units < min_units:
            continue
        counts[sku] = len(occurrences)
        candidates.append(line)

    # BY EXPECTED MARGIN, not by ratio. The cap decides which opportunities are
    # OFFERED and the biggest ones must survive it; `build_playbook` then trims to
    # the cash budget by margin per dollar, which is the right order for spending a
    # fixed pot but the wrong one for choosing what to put in front of someone.
    # Sorting the cap by ratio filled every playbook with cheap single-unit lines
    # whose margin-per-dollar was high on a trivial base.
    candidates.sort(key=lambda line: -(line.expected_margin or 0.0))
    return build_playbook(
        event_key=event_key, event_name=event.name, event_date=event_date,
        window_start=window_start, window_end=window_end,
        window_pre_days=event.window_pre_days,
        candidate_lines=candidates[:max_lines],
        lead_time_days=lead_time_days,
        evidence=(f"your own past {event.name}s at this store"),
        ctx=ctx, config=config, cash_budget=cash_budget,
        # The THINNEST of the lines that were offered. An event an owner is being
        # asked to commit cash for is only as well evidenced as its weakest line,
        # and taking the maximum here would let one well-observed SKU lend its
        # confidence to twenty-nine that have not earned it.
        min_occurrences=min((counts[line.sku] for line in candidates[:max_lines]),
                            default=0),
    )


def due_events(
    *, as_of: date, lead_time_days: int, ctx: RunContext,
    config: ConfigRegistry = cfg, horizon_days: int = 60,
) -> list[tuple[str, int]]:
    """(event_key, year) pairs whose ALERT DATE has arrived but not passed.

    The alert date is `event - window_pre - lead_time - safety_buffer`, so this is
    the set an owner should be hearing about now. Ordered by event date, because
    the nearest commitment is the one that matters.
    """
    due: list[tuple[str, int, date]] = []
    for key, event in EVENTS_BY_KEY.items():
        for year in (as_of.year, as_of.year + 1):
            try:
                event_date = event.date_for(year)
            except (EventDateUnavailable, ValueError):
                continue
            if event_date < as_of:
                continue
            alert = alert_date_for(event_date, event.window_pre_days,
                                   lead_time_days, ctx, config)
            if alert <= as_of and (event_date - as_of).days <= horizon_days:
                due.append((key, year, event_date))
    due.sort(key=lambda t: t[2])
    return [(key, year) for key, year, _ in due]


__all__ = [
    "BASELINE_WEEKS_EITHER_SIDE",
    "MAX_PLAYBOOK_LINES",
    "MIN_LINE_ORDER_UNITS",
    "MIN_BASELINE_DAYS_PER_OCCURRENCE",
    "SkuFacts",
    "build_for_event",
    "due_events",
    "line_from_uplift",
    "occurrences_for",
]
