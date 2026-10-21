"""The feature store reader — ONE definition of velocity, read everywhere.

Velocity is currently computed in `app/store_data/velocity.py`, again in
`backend/lib/metrics.js`, and again in SQL inside individual chat tools. When
those disagree you get 454 versus 485: the same question answered twice,
differently, with neither marked as the authority. This module is the
authority. After the follow-up migration commit, the other three read it.

THE FOUR RULES, in the order they bite:

1. CLOSED DAYS ARE ABSENT, NOT ZERO.
   Every rate divides by OPEN days. Measured on Bethany Discount Liquor
   (171:171): 1,358 calendar days, 1,158 trading days, 200 closed — 191 of
   them Sundays. Over a recent 28-day window, 24 open days and 5,945 units:
       per calendar day 212.32     per OPEN day 247.71
   Dividing by calendar days understates that store by 14.3%. The open-day
   count travels in provenance so a reader can see the denominator.

2. POINT-IN-TIME CORRECTNESS.
   A read as of 3 March returns what was KNOWN on 3 March. Rows whose
   `known_at` is later are excluded, because a backtest that sees them reports
   a skill the live system will not have.

3. ANCHOR TO ctx.as_of, NEVER TO THE LATEST ROW IN THE DATA.
   `app/store_data/__init__.py` anchors windows to `max(sale_date)`. Its
   comment defends this ("the source DB can lag; anchoring to now would make
   every SKU look like it's trending down") and that concern is REAL — but the
   cure is worse than the disease, because on a store four days behind,
   "trailing 30 days" silently becomes a different 30 days than production
   will see.

   The correct resolution is not to choose between them. Anchor to
   `ctx.as_of`, and treat unsynced days the same way closed days are treated:
   ABSENT, excluded from the denominator. The false-downtrend problem
   disappears because the missing days are never divided by, and the window
   is the one production will actually use. `has_data` is what makes that
   possible, and it is why it is a separate column from `was_open`.

4. ONE DEFINITION. Everything here is a pure function of (rows, calendar,
   ctx), so the same code answers a training question and an inference
   question. That is the bug that silently poisons most forecasting systems:
   the model trains on rows assembled one way and scores on rows assembled
   another.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

from app.pipeline.context import RunContext
from app.pipeline.envelope import StageResult, stage
from app.pipeline.provenance import EvidenceState, Provenance, record_inputs
from app.pipeline.registry import ConfigRegistry, Setting, cfg

# ── Thresholds ───────────────────────────────────────────────────────────────

MIN_OPEN_DAYS_FOR_RATE = Setting(
    name="features.velocity.min_open_days",
    default=3,
    unit="open days",
    owner="feature-store",
    why="provisional; below three open days a per-day rate is one busy "
        "afternoon wearing a trend. The read returns ok=False rather than a "
        "confident number. To be fitted in wave 6",
    status="PROVISIONAL",
)

MATURE_OPEN_DAYS = Setting(
    name="features.velocity.mature_open_days",
    default=56,
    unit="open days",
    owner="feature-store",
    why="provisional; two months of trading is where a per-SKU rate stops "
        "moving much. Drives evidence_state, not the number itself",
    status="PROVISIONAL",
)

ESTABLISHED_OPEN_DAYS = Setting(
    name="features.velocity.established_open_days",
    default=21,
    unit="open days",
    owner="feature-store",
    why="provisional; three trading weeks covers a full weekly cycle, which "
        "is the shortest window that is not dominated by day-of-week mix",
    status="PROVISIONAL",
)


# ── Rows ─────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class DayFact:
    """One row of `feature_daily`. NULL means genuinely absent, never zero."""

    obs_date: date
    sku: str
    units_sold: float | None = None
    revenue: float | None = None
    unit_cost: float | None = None
    on_hand: float | None = None
    price: float | None = None
    baskets_containing: int | None = None
    #: When WE learned it. Point-in-time reads filter on this.
    known_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class CalendarDay:
    """One row of `feature_store_day` — the dense calendar.

    `was_open` and `has_data` are separate because they are different facts.
    A Sunday closure is known and permanent; an unsynced day is unknown and
    may fill in tomorrow. Neither belongs in a denominator, and conflating
    them would make a lagging store look shut.
    """

    obs_date: date
    was_open: bool
    has_data: bool = True
    open_source: str = "observed"


@dataclass(frozen=True, slots=True)
class FeatureWindow:
    """The answer. Every rate here divides by `open_days`."""

    sku: str
    window_days: int
    start_date: date
    end_date: date

    units: float
    revenue: float | None
    #: Trading days in the window that we actually have data for. THE
    #: denominator, and the number a reader should check before believing a rate.
    open_days: int
    #: Calendar days in the window, for contrast. Never a denominator.
    calendar_days: int
    closed_days: int
    unsynced_days: int

    units_per_open_day: float | None
    units_per_calendar_day: float | None
    #: How wrong the naive calculation would have been, as a percentage.
    #: Recorded because it is the whole argument for this table existing.
    calendar_understatement_pct: float | None

    days_with_sales: int
    latest_price: float | None
    latest_unit_cost: float | None
    latest_on_hand: float | None
    baskets_containing: int | None

    def as_dict(self) -> dict[str, Any]:
        return {
            "sku": self.sku,
            "window_days": self.window_days,
            "start_date": self.start_date.isoformat(),
            "end_date": self.end_date.isoformat(),
            "units": self.units,
            "revenue": self.revenue,
            "open_days": self.open_days,
            "calendar_days": self.calendar_days,
            "closed_days": self.closed_days,
            "unsynced_days": self.unsynced_days,
            "units_per_open_day": self.units_per_open_day,
            "units_per_calendar_day": self.units_per_calendar_day,
            "calendar_understatement_pct": self.calendar_understatement_pct,
            "days_with_sales": self.days_with_sales,
            "latest_price": self.latest_price,
            "latest_unit_cost": self.latest_unit_cost,
            "latest_on_hand": self.latest_on_hand,
            "baskets_containing": self.baskets_containing,
        }


@dataclass(frozen=True, slots=True)
class FeatureRequest:
    """What to read. The window is derived from ctx.as_of, never from the data."""

    sku: str
    window_days: int
    facts: Sequence[DayFact]
    calendar: Sequence[CalendarDay]
    #: Exclude rows learned after this instant. Defaults to end-of-as_of-day,
    #: which is the honest reading of "what was known on that date".
    known_as_of: datetime | None = None


PERCENT = 100


def window_bounds(ctx: RunContext, window_days: int) -> tuple[date, date]:
    """[as_of - (window-1), as_of] inclusive.

    ANCHORED TO ctx.as_of. Not to max(sale_date), not to wall-clock. This is
    the one line that keeps training and inference looking at the same window.
    """
    if window_days < 1:
        raise ValueError(f"window_days must be >= 1, got {window_days}")
    return ctx.as_of - timedelta(days=window_days - 1), ctx.as_of


def visible_at(facts: Iterable[DayFact], known_as_of: datetime | None) -> list[DayFact]:
    """Drop rows we had not learned yet.

    A fact with no `known_at` is treated as always-known: the builder stamps
    every row it writes, so an unstamped row is test data or a backfill, and
    silently hiding it would be more surprising than including it.
    """
    if known_as_of is None:
        return list(facts)
    return [
        f for f in facts
        if f.known_at is None or _naive(f.known_at) <= _naive(known_as_of)
    ]


def _naive(value: datetime) -> datetime:
    return value.replace(tzinfo=None) if value.tzinfo is not None else value


def _evidence_for(open_days: int, established: int, mature: int) -> EvidenceState:
    if open_days >= mature:
        return "MATURE"
    if open_days >= established:
        return "ESTABLISHED"
    if open_days > 0:
        return "EMERGING"
    return "NEW"


# ── The reader ───────────────────────────────────────────────────────────────


@stage("feature_window", "1.0.0")
def read_window(
    request: FeatureRequest, ctx: RunContext, config: ConfigRegistry = cfg
) -> StageResult:
    """Compute one SKU's windowed features. The one definition.

    A pure function of (facts, calendar, ctx): no clock, no database, no
    network. The caller fetches the rows — see `build.FEATURE_WINDOW_SQL` for
    the query that does it point-in-time correctly.

    Returns ok=False when there is not enough open trading to state a rate.
    That is a legitimate outcome carrying reasons, not an error: "this store
    has been open twice since we started watching" is a real answer, and a
    per-day rate computed from it would be one busy afternoon wearing a trend.
    """
    record_inputs(
        "feature_daily.units_sold", "feature_daily.revenue",
        "feature_store_day.was_open", "feature_store_day.has_data",
    )

    start, end = window_bounds(ctx, request.window_days)
    known_as_of = request.known_as_of or datetime.combine(
        ctx.as_of, datetime.max.time()
    )

    # 1. Point-in-time: drop anything we had not learned yet.
    facts = [
        f for f in visible_at(request.facts, known_as_of)
        if start <= f.obs_date <= end and f.sku == request.sku
    ]

    # 2. The denominator comes from the CALENDAR, not from the facts. This is
    #    the whole design: a sparse fact table cannot tell a closed day from a
    #    day this SKU simply did not sell.
    in_window = [c for c in request.calendar if start <= c.obs_date <= end]
    open_days = sum(1 for c in in_window if c.was_open and c.has_data)
    closed_days = sum(1 for c in in_window if not c.was_open)
    unsynced_days = sum(1 for c in in_window if c.was_open and not c.has_data)
    calendar_days = (end - start).days + 1

    min_open = config.get(MIN_OPEN_DAYS_FOR_RATE, ctx)
    established = config.get(ESTABLISHED_OPEN_DAYS, ctx)
    mature = config.get(MATURE_OPEN_DAYS, ctx)

    provenance = Provenance(
        own_observations=open_days,
        own_weight=1.0,
        evidence_state=_evidence_for(open_days, established, mature),
        inputs=("feature_daily", "feature_store_day"),
    )

    if not in_window:
        return StageResult.failure("no_calendar_for_window", provenance=provenance)

    if open_days < min_open:
        # Say WHY there is no rate, with the numbers, so a caller can tell a
        # closed store from an unsynced one from a brand-new one.
        return StageResult.failure(
            f"insufficient_open_days:{open_days}<{min_open}",
            *( [f"closed_days:{closed_days}"] if closed_days else [] ),
            *( [f"unsynced_days:{unsynced_days}"] if unsynced_days else [] ),
            provenance=provenance,
        )

    units = sum(f.units_sold for f in facts if f.units_sold is not None)
    revenue_values = [f.revenue for f in facts if f.revenue is not None]
    revenue = sum(revenue_values) if revenue_values else None

    per_open = units / open_days
    per_calendar = units / calendar_days if calendar_days else None
    understatement = (
        round(PERCENT * (1 - per_calendar / per_open), 2)
        if per_open and per_calendar is not None else None
    )

    # "Latest" means latest WITHIN THE WINDOW and within what was known —
    # never the current value, which would leak the present into the past.
    latest = max(facts, key=lambda f: f.obs_date, default=None)
    baskets = [f.baskets_containing for f in facts if f.baskets_containing is not None]

    window = FeatureWindow(
        sku=request.sku,
        window_days=request.window_days,
        start_date=start,
        end_date=end,
        units=units,
        revenue=revenue,
        open_days=open_days,
        calendar_days=calendar_days,
        closed_days=closed_days,
        unsynced_days=unsynced_days,
        units_per_open_day=round(per_open, 4),
        units_per_calendar_day=round(per_calendar, 4) if per_calendar is not None else None,
        calendar_understatement_pct=understatement,
        days_with_sales=sum(1 for f in facts if f.units_sold),
        latest_price=latest.price if latest else None,
        latest_unit_cost=latest.unit_cost if latest else None,
        latest_on_hand=latest.on_hand if latest else None,
        baskets_containing=sum(baskets) if baskets else None,
    )

    # Reasons a caller should read even on success.
    notes: list[str] = []
    if unsynced_days:
        notes.append(f"unsynced_days_excluded:{unsynced_days}")
    if closed_days:
        notes.append(f"closed_days_excluded:{closed_days}")
    return StageResult.success(window, provenance, reasons=tuple(notes))


@stage("feature_windows", "1.0.0")
def read_windows(
    request: FeatureRequest, ctx: RunContext, config: ConfigRegistry = cfg
) -> StageResult:
    """Every SKU in the supplied facts, one window each.

    Shares the calendar across SKUs, which is the point: one denominator, used
    identically everywhere, rather than each caller deriving its own.
    """
    skus = sorted({f.sku for f in request.facts})
    windows: dict[str, dict[str, Any]] = {}
    refused: dict[str, tuple[str, ...]] = {}

    for sku in skus:
        result = read_window(
            FeatureRequest(
                sku=sku, window_days=request.window_days, facts=request.facts,
                calendar=request.calendar, known_as_of=request.known_as_of,
            ),
            ctx, config,
        )
        if result.ok and result.value is not None:
            windows[sku] = result.value.as_dict()
        else:
            refused[sku] = result.reasons

    in_window = [
        c for c in request.calendar
        if window_bounds(ctx, request.window_days)[0] <= c.obs_date <= ctx.as_of
    ]
    open_days = sum(1 for c in in_window if c.was_open and c.has_data)

    provenance = Provenance(
        own_observations=open_days,
        own_weight=1.0,
        evidence_state=_evidence_for(
            open_days,
            config.get(ESTABLISHED_OPEN_DAYS, ctx),
            config.get(MATURE_OPEN_DAYS, ctx),
        ),
        inputs=("feature_daily", "feature_store_day"),
    )
    if not windows:
        return StageResult.failure(
            "no_sku_had_enough_open_days", provenance=provenance
        )
    return StageResult.success(
        {"windows": windows, "refused": {k: list(v) for k, v in refused.items()},
         "open_days": open_days},
        provenance,
    )


__all__ = [
    "ESTABLISHED_OPEN_DAYS",
    "MATURE_OPEN_DAYS",
    "MIN_OPEN_DAYS_FOR_RATE",
    "CalendarDay",
    "DayFact",
    "FeatureRequest",
    "FeatureWindow",
    "read_window",
    "read_windows",
    "visible_at",
    "window_bounds",
]
