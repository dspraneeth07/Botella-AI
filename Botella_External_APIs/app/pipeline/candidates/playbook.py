"""An event playbook: ONE decision with many lines, not thirty cards.

WHAT A PLAYBOOK IS
    "Thanksgiving is in six weeks. Here is the order list, here is what it costs,
    here is what each line should deliver." One card. The owner makes one decision
    and commits cash once.

    If this module ever produces thirty cards it is wrong, and
    `test_playbook_is_one_card_not_many` says so.

IT DOES NOT TOUCH THE DAILY FORECAST
    Seasonality has lost on this engine twice, both times as an adjustment to
    `rate_hat`. A playbook is a different object: discrete, dated, with its own
    window, estimated from that event's own history, producing an ORDER LIST. No
    line here scales a daily rate, and if one ever does it will lose for the third
    time.

THE PROMISE AND THE ORDER ARE DIFFERENT NUMBERS, AND THIS IS WHERE IT SHOWS
    Everywhere else in the engine that split is a correctness argument. Here it is
    visible to the owner, because they are committing real cash WEEKS EARLY:

        order_units    the high quantile - what to buy. A stockout on
                       Thanksgiving Eve cannot be fixed on Thanksgiving Eve.
        promise_units  the LOW quantile - what to expect. A promise kept is worth
                       more than a promise that sounded bigger.

    Both appear on every line. A single number would be wrong for both purposes,
    which is the whole of N1.

THE ALERT DATE RESTS ON AN ASSUMPTION AND SAYS SO
        alert_on = event_date - window_pre - lead_time - safety_buffer

    `purchase_orders` is empty at four of five stores, so the lead time is
    DECLARED, not measured. The four-to-six-week promise is a consequence of that
    assumption, and the card carries it.

A PLAYBOOK IS THE LARGEST SINGLE CASH ASK THE ENGINE MAKES
    So the budget binds hardest here. A playbook that does not fit is TRIMMED BY
    EXPECTED NET MARGIN PER DOLLAR, line by line - the same greedy ratio the slate
    uses - and the card says what was dropped and why. It is never silently
    truncated and it is never allowed to exceed the budget.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Sequence

from app.pipeline.context import RunContext
from app.pipeline.registry import ConfigRegistry, Setting, cfg

ALERT_SAFETY_BUFFER_DAYS = Setting(
    name="playbook.alert_safety_buffer_days",
    default=7,
    unit="calendar days added to the lead time before alerting",
    owner="operations",
    why="provisional. The lead time itself is DECLARED because purchase_orders "
        "is empty at four of five stores, so this buffer is a hedge on an "
        "assumption rather than on a measurement - which is exactly why it "
        "exists and exactly why it is stated on the card. A week turns a 7-day "
        "declared lead time into a 4-to-6-week alert for a 3-day run-up event, "
        "which is the window an owner can actually negotiate in. It becomes "
        "MEASURED when received dates are captured and the real variance of "
        "lead time is known",
    status="PROVISIONAL",
)

MIN_LINES = Setting(
    name="playbook.min_lines",
    default=3,
    unit="lines a playbook must have to be worth issuing",
    owner="commercial",
    why="provisional. A 'playbook' of one line is a reorder card wearing a "
        "costume - it carries all the ceremony of an event plan and none of the "
        "value, which is the breadth. Below three lines the card is withheld and "
        "the ordinary reorder path can have the SKU back. It becomes MEASURED "
        "when playbook outcomes can be compared by line count",
    status="PROVISIONAL",
)


@dataclass(frozen=True, slots=True)
class PlaybookLine:
    """One SKU in one playbook. Both quantities, and why it is here."""

    sku: str
    product: str
    #: The HIGH quantile - what to buy. From policy/inventory.py at q*.
    order_units: float
    #: The LOW quantile - what to expect. Never the same number as above.
    promise_units: float
    unit_cost: float | None
    unit_margin: float | None
    #: The event uplift that earned this line, as a multiple of the baseline.
    lift_multiple: float
    #: What this line's number rests on, in the owner's words.
    evidence: str
    why: str

    def __post_init__(self) -> None:
        for name in ("order_units", "promise_units"):
            if getattr(self, name) < 0:
                raise ValueError(f"{self.sku}: {name} must be >= 0")
        if self.promise_units > self.order_units:
            raise ValueError(
                f"{self.sku}: promise_units ({self.promise_units}) exceeds "
                f"order_units ({self.order_units}). The promise is a LOW quantile "
                f"and the order a HIGH one; this ordering cannot be reversed."
            )

    @property
    def cash_required(self) -> float:
        """What the owner commits for this line. Zero when cost is unknown."""
        return self.order_units * (self.unit_cost or 0.0)

    @property
    def expected_margin(self) -> float | None:
        """On the PROMISE, not the order - the units this line is claiming."""
        if self.unit_margin is None:
            return None
        return self.promise_units * self.unit_margin

    @property
    def ratio(self) -> float | None:
        """Expected margin per dollar committed. The trim order."""
        margin = self.expected_margin
        if margin is None or self.cash_required <= 0.0:
            return None
        return margin / self.cash_required

    def as_dict(self) -> dict[str, Any]:
        return {
            "sku": self.sku, "product": self.product,
            "order_units": self.order_units,
            "promise_units": self.promise_units,
            "unit_cost": self.unit_cost, "unit_margin": self.unit_margin,
            "cash_required": self.cash_required,
            "expected_margin": self.expected_margin,
            "lift_multiple": self.lift_multiple,
            "evidence": self.evidence, "why": self.why,
        }


@dataclass(frozen=True, slots=True)
class Playbook:
    """One card. One decision. Many lines."""

    event_key: str
    event_name: str
    event_date: date
    window_start: date
    window_end: date
    alert_on: date
    lines: tuple[PlaybookLine, ...]
    #: (line, reason) for everything trimmed. Carried, never silently dropped.
    trimmed: tuple[tuple[PlaybookLine, str], ...]
    cash_budget: float
    lead_time_days: int
    safety_buffer_days: int
    #: The cohort evidence for the event as a whole.
    evidence: str
    #: Past instances of this event the THINNEST surviving line rests on.
    #:
    #: Carried rather than left to the caller, because the caller cannot know it:
    #: the per-SKU counts are computed inside the builder and were discarded. The
    #: first attempt at passing it in read a non-existent attribute, `getattr`
    #: returned 0, `confidence_from_evidence(0, k)` returned 0.0, and a
    #: zero-confidence plan would have reached an owner with every test passing.
    #:
    #: Zero means no line survived, which an empty playbook already says.
    min_occurrences: int = 0

    @property
    def units_at_stake(self) -> float:
        """The SUM, so the playbook ranks on N3's currency as one card."""
        return sum(line.promise_units for line in self.lines)

    @property
    def cash_required(self) -> float:
        return sum(line.cash_required for line in self.lines)

    @property
    def expected_margin(self) -> float:
        return sum(line.expected_margin or 0.0 for line in self.lines)

    @property
    def is_empty(self) -> bool:
        """A playbook of refused lines is an empty playbook, and that is a VALID
        answer - not an error and not a failure."""
        return not self.lines

    def assumptions(self) -> tuple[str, ...]:
        return (
            f"a {self.lead_time_days}-day delivery lead time (DECLARED, not "
            f"measured - no receipt date exists in the data)",
            f"a {self.safety_buffer_days}-day buffer on top of it, so the alert "
            f"date rests on that assumption too",
            f"${self.cash_budget:,.0f} of cash available (declared, not measured)",
        )

    def explain(self) -> str:
        if self.is_empty:
            return (
                f"No playbook for {self.event_name}: no product had a usable "
                f"event uplift, so there is nothing to recommend buying."
            )
        trimmed = (f" {len(self.trimmed)} line(s) were trimmed to fit the budget."
                   if self.trimmed else "")
        return (
            f"{self.event_name} is on {self.event_date:%d %b %Y} and sells from "
            f"{self.window_start:%d %b} to {self.window_end:%d %b}. "
            f"Order {len(self.lines)} product(s) by {self.alert_on:%d %b}, "
            f"committing ${self.cash_required:,.0f} to capture about "
            f"{self.units_at_stake:,.0f} extra units.{trimmed}"
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "event_key": self.event_key, "event_name": self.event_name,
            "event_date": self.event_date.isoformat(),
            "window_start": self.window_start.isoformat(),
            "window_end": self.window_end.isoformat(),
            "alert_on": self.alert_on.isoformat(),
            "lines": [line.as_dict() for line in self.lines],
            "trimmed": [{"sku": line.sku, "reason": reason}
                        for line, reason in self.trimmed],
            "units_at_stake": self.units_at_stake,
            "cash_required": self.cash_required,
            "expected_margin": self.expected_margin,
            "cash_budget": self.cash_budget,
            "is_empty": self.is_empty,
            "evidence": self.evidence,
            "assumptions": list(self.assumptions()),
        }


def alert_date_for(
    event_date: date, window_pre_days: int, lead_time_days: int,
    ctx: RunContext, config: ConfigRegistry = cfg,
) -> date:
    """When the owner has to be told, counting back from the event.

        event_date - window_pre - lead_time - safety_buffer

    CALENDAR days, deliberately, unlike almost everything else in this engine: a
    supplier's lead time runs on the supplier's calendar, not on the store's
    opening pattern, and a delivery does not wait for a Sunday closure.
    """
    buffer_days = int(config.get(ALERT_SAFETY_BUFFER_DAYS, ctx))
    return event_date - timedelta(
        days=window_pre_days + lead_time_days + buffer_days)


def build_playbook(
    *,
    event_key: str,
    event_name: str,
    event_date: date,
    window_start: date,
    window_end: date,
    window_pre_days: int,
    candidate_lines: Sequence[PlaybookLine],
    lead_time_days: int,
    evidence: str,
    ctx: RunContext,
    config: ConfigRegistry = cfg,
    cash_budget: float,
    #: Past instances the thinnest candidate line rests on. The caller computed
    #: these to build the lines at all, so it is the only place that knows.
    min_occurrences: int = 0,
) -> Playbook:
    """Assemble one playbook, trimmed to the cash budget by ratio.

    `candidate_lines` must already EXCLUDE any SKU whose event uplift was refused
    - a playbook does not re-litigate the estimate, it spends the ones that
    survived it. Passing a refused line in would be a caller error, and the
    emptiness test below is what catches the case where none survived.
    """
    buffer_days = int(config.get(ALERT_SAFETY_BUFFER_DAYS, ctx))
    minimum_lines = int(config.get(MIN_LINES, ctx))

    alert_on = alert_date_for(event_date, window_pre_days, lead_time_days,
                              ctx, config)

    # Best expected margin per dollar first; a line committing no cash is free
    # and goes ahead of everything that costs money. SKU breaks ties so the
    # playbook is identical on a rerun.
    def sort_key(line: PlaybookLine) -> tuple[int, float, str]:
        ratio = line.ratio
        if ratio is None:
            return (0, -(line.expected_margin or 0.0), line.sku)
        return (1, -ratio, line.sku)

    kept: list[PlaybookLine] = []
    trimmed: list[tuple[PlaybookLine, str]] = []
    committed = 0.0

    for line in sorted(candidate_lines, key=sort_key):
        if line.expected_margin is None:
            trimmed.append((line, "no_unit_margin:cannot_price_this_line"))
            continue
        if committed + line.cash_required > cash_budget:
            trimmed.append((
                line,
                f"over_cash_budget:{committed + line.cash_required:,.0f}"
                f">{cash_budget:,.0f}",
            ))
            continue
        kept.append(line)
        committed += line.cash_required

    if len(kept) < minimum_lines:
        # A playbook of one or two lines is a reorder card wearing a costume.
        # Everything is recorded as trimmed so the reason survives.
        trimmed = [(line, f"too_few_lines:{len(kept)}<{minimum_lines}")
                   for line in kept] + trimmed
        kept = []

    return Playbook(
        event_key=event_key, event_name=event_name, event_date=event_date,
        window_start=window_start, window_end=window_end, alert_on=alert_on,
        lines=tuple(kept), trimmed=tuple(trimmed),
        cash_budget=cash_budget, lead_time_days=lead_time_days,
        safety_buffer_days=buffer_days, evidence=evidence,
        # Only the lines that SURVIVED the budget trim. A line trimmed for cost
        # lends its evidence to nothing, so counting it would let a dropped line
        # raise the confidence of the card that replaced it.
        min_occurrences=(min_occurrences if kept else 0),
    )


__all__ = [
    "ALERT_SAFETY_BUFFER_DAYS",
    "MIN_LINES",
    "Playbook",
    "PlaybookLine",
    "alert_date_for",
    "build_playbook",
]
