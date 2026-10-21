"""The last gate before the model sees anything. Is this DECISION correct?

HALF OF A SPLIT, AND THE SPLIT IS THE POINT
    This validator asks one question - **is this decision correct** - and asks
    it before a single token is spent. Sheet 16 asks a different one: does the
    SENTENCE match the decision. Keeping them apart is the whole design.

    A candidate that fails here is DROPPED, because it is wrong and no wording
    can fix it.

WHY A FAILURE HERE PAGES AND A SHEET-16 FAILURE DOES NOT
    A failure here means an upstream stage produced something IMPOSSIBLE - a
    negative quantity, a date already past, a risk figure that does not
    reconcile with the forecast that produced it. That is a pipeline bug, and
    it should wake someone.

    A sheet-16 failure means the model wrote a sentence that did not match a
    correct decision. That is a prompt regression. It should be logged and
    counted, and it is not a 3am problem.

    Conflating the two is exactly what made the current single validator
    useless: both kinds of failure produced the same dropped card and the same
    log line, so neither was ever investigated. `Severity` exists so the two
    are different objects, not two readings of the same one.

SILENCE IS A FAILURE
    Check 4 is the one that catches the quiet class of bug. A constraint that
    was never evaluated is not a constraint that passed. An assumed bound is
    not a measured one. Both are rejected, because sheet 11's whole point is
    that "we do not know your shelf capacity" and "you have infinite shelf"
    are different sentences - and a validator that accepts silence undoes that
    in one line.

THE RECORD IS THE CONTRACT WITH SHEET 16
    `DecisionRecord` carries EVERY figure the card may display. Sheet 16 will
    check each numeral in the generated sentence against this record, so a
    number missing here is a number the explanation layer cannot say - and a
    number present here that nobody validated is a hole in the gate.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date
from enum import StrEnum
from typing import Any

from app.pipeline.candidates.types import Candidate
from app.pipeline.constraints.sources import Availability, Constraint
from app.pipeline.context import RunContext
from app.pipeline.envelope import StageResult, stage
from app.pipeline.provenance import record_inputs
from app.pipeline.registry import ConfigRegistry, Setting, cfg

PERCENT = 100

RISK_TOLERANCE_PCT = Setting(
    name="validate.risk_tolerance_pct",
    default=5,
    unit="percent difference between the stated risk and forecast x margin",
    owner="forecasting",
    why="provisional; above this the two stages genuinely disagree about the "
        "same quantity, which is a BUG rather than a rounding issue. Five "
        "percent absorbs float accumulation and the rounding a card applies "
        "for display, and nothing else. Tightening it further would start "
        "paging on display rounding; loosening it would let a real "
        "disagreement through as noise",
    status="PROVISIONAL",
)

INVENTORY_TOLERANCE_UNITS = Setting(
    name="validate.inventory_tolerance_units",
    default=1,
    unit="units",
    owner="operations",
    why="provisional; the inventory identity is checked in whole units, and a "
        "case pack rounds the order UP, so the closing position can legally "
        "exceed safety stock but must never fall short by more than the "
        "rounding that produced it. One unit absorbs the ceil; more would "
        "hide a genuine shortfall",
    status="PROVISIONAL",
)

MAX_ORDER_BY_HORIZON_DAYS = Setting(
    name="validate.max_order_by_horizon_days",
    default=180,
    unit="days between as_of and the order-by date",
    owner="operations",
    why="provisional; a deadline further out than half a year is not a "
        "relaxed deadline, it is date arithmetic that went wrong upstream - "
        "and it would read to an owner as 'no hurry' on a card about a "
        "stockout. Six months comfortably covers a seasonal pre-buy, which is "
        "the longest legitimate lead this trade has",
    status="PROVISIONAL",
)

MAX_PLAUSIBLE_ORDER_MULTIPLE = Setting(
    name="validate.max_plausible_order_multiple",
    default=12,
    unit="multiples of the horizon demand",
    owner="operations",
    why="provisional; an order beyond twelve times the forecast demand for the "
        "horizon is not a large order, it is an upstream arithmetic error - a "
        "units/cases confusion or a rate applied to the wrong window. Sheet 11 "
        "caps by shelf and budget where those exist, and neither does today, "
        "so this is the only thing standing between a decimal slip and a "
        "purchase order",
    status="PROVISIONAL",
)


class Severity(StrEnum):
    """How loudly a failure should be reported.

    Two values, deliberately. `PAGE` is this sheet; `LOG` is sheet 16. They
    are different objects so that nobody can accidentally handle them the same
    way - which is the failure this sheet exists to correct.
    """

    #: An upstream stage produced something impossible. Wake someone.
    PAGE = "page"
    #: A wording regression. Count it, look at it on Monday.
    LOG = "log"


class Check(StrEnum):
    """The five checks, named so a failure says which gate caught it."""

    QUANTITY = "quantity"
    DATE = "date"
    RISK = "risk"
    CONSTRAINTS = "constraints"
    INVENTORY = "inventory"


@dataclass(frozen=True, slots=True)
class Failure:
    """One failed check, with enough detail to debug the upstream stage."""

    check: Check
    severity: Severity
    reason: str

    def as_dict(self) -> dict[str, Any]:
        return {"check": self.check.value, "severity": self.severity.value,
                "reason": self.reason}


@dataclass(frozen=True, slots=True)
class DecisionRecord:
    """Every figure the card may display, validated.

    Sheet 16 checks each numeral in the generated sentence against
    `figures()`. A number missing here cannot be said; a number here that no
    check touched is a hole in this gate.
    """

    sku: str
    #: What the card CALLS the product. Carried because the card displays it,
    #: and this record's whole contract is that everything displayable is on
    #: it - sheet 16 checks each named product against the store's catalogue,
    #: and cannot do that against a name the record never carried.
    #:
    #: It is also why `allowed_literals` includes it: "Terra Lager 12pk"
    #: contains "12", and a name scanned as arithmetic fails every card whose
    #: product has a pack size in its name.
    product_name: str | None
    family: str
    quantity: int
    order_by_date: date | None
    demand_p50: float
    demand_p90: float
    on_hand: float
    on_order: float
    safety_stock: float
    lead_time_days: int
    unit_margin: float | None
    stated_risk: float | None
    #: Constraint name -> its state. EVERY constraint stage 11 knows about
    #: must appear, satisfied or explicitly unavailable.
    constraint_states: Mapping[str, str] = field(default_factory=dict)
    assumptions: tuple[str, ...] = ()
    #: The window the order was sized for, and the demand over THAT window -
    #: not over the forecast horizon. Recorded because the inventory check
    #: compared these, and a card that says "covers you for N days" must say
    #: which N. Zero means the caller stated no window and the check fell back
    #: to the forecast horizon as given; the ambiguity is then visible here
    #: rather than implied.
    coverage_days: int = 0
    coverage_demand: float = 0.0

    def figures(self) -> dict[str, float]:
        """The numbers sheet 16 may allow in a sentence."""
        values: dict[str, float] = {
            "quantity": float(self.quantity),
            "demand_p50": self.demand_p50,
            "demand_p90": self.demand_p90,
            "on_hand": self.on_hand,
            "on_order": self.on_order,
            "safety_stock": self.safety_stock,
            "lead_time_days": float(self.lead_time_days),
        }
        if self.coverage_days:
            values["coverage_days"] = float(self.coverage_days)
            values["coverage_demand"] = self.coverage_demand
        if self.unit_margin is not None:
            values["unit_margin"] = self.unit_margin
        if self.stated_risk is not None:
            values["stated_risk"] = self.stated_risk
        return values

    def as_dict(self) -> dict[str, Any]:
        return {
            "sku": self.sku, "family": self.family, "quantity": self.quantity,
            "order_by_date": (
                self.order_by_date.isoformat() if self.order_by_date else None
            ),
            "figures": self.figures(),
            "constraint_states": dict(self.constraint_states),
            "assumptions": list(self.assumptions),
        }


@dataclass(frozen=True, slots=True)
class DecisionRequest:
    """The decision to check, assembled from stages 10-13."""

    candidate: Candidate
    quantity: int
    order_by_date: date | None
    demand_p50: float
    demand_p90: float
    on_hand: float
    on_order: float
    safety_stock: float
    lead_time_days: int
    #: Every constraint stage 11 considered - including the ones it could not
    #: evaluate. An absent constraint is a FAILURE, not a pass.
    constraints: Sequence[Constraint] = ()
    #: The risk/value figure the card would state, and its components. Both
    #: None when the family makes no money claim.
    stated_risk: float | None = None
    unit_margin: float | None = None
    assumptions: tuple[str, ...] = ()
    #: Policy bound from sheet 10. The order must not exceed it.
    order_up_to: float | None = None
    #: The window `demand_p50` covers - sheet 07's forecast horizon, in OPEN
    #: days.
    horizon_days: int = 0
    #: The window the ORDER was sized for - sheet 10's lead time plus review
    #: period. The inventory identity is checked over THIS window, not the
    #: forecast horizon. See `_check_inventory`.
    coverage_days: int = 0


#: Constraints stage 11 knows about. Every one must be accounted for.
REQUIRED_CONSTRAINTS: tuple[str, ...] = (
    "case_pack", "on_hand", "moq", "shelf_capacity", "budget",
)


def _check_quantity(
    request: DecisionRequest, config: ConfigRegistry, ctx: RunContext
) -> list[Failure]:
    failures: list[Failure] = []
    quantity = request.quantity

    if not isinstance(quantity, int) or isinstance(quantity, bool):
        failures.append(Failure(
            Check.QUANTITY, Severity.PAGE,
            f"quantity_is_not_an_integer:{quantity!r}",
        ))
        return failures

    if quantity <= 0:
        failures.append(Failure(
            Check.QUANTITY, Severity.PAGE,
            f"quantity_is_not_positive:{quantity}",
        ))

    if request.order_up_to is not None and quantity > math.ceil(
        request.order_up_to
    ):
        failures.append(Failure(
            Check.QUANTITY, Severity.PAGE,
            f"quantity_exceeds_policy_order_up_to:{quantity}>"
            f"{request.order_up_to:.2f}",
        ))

    # A decimal slip is the failure mode here, not a large order.
    horizon_demand = request.demand_p50
    multiple = config.get(MAX_PLAUSIBLE_ORDER_MULTIPLE, ctx)
    if horizon_demand > 0 and quantity > horizon_demand * multiple:
        failures.append(Failure(
            Check.QUANTITY, Severity.PAGE,
            f"quantity_implausible:{quantity}>{multiple}x_horizon_demand"
            f"({horizon_demand:.1f})",
        ))
    return failures


def _check_date(
    request: DecisionRequest, config: ConfigRegistry, ctx: RunContext
) -> list[Failure]:
    """Not in the past, and reachable given the declared lead time."""
    failures: list[Failure] = []
    order_by = request.order_by_date
    if order_by is None:
        return [Failure(Check.DATE, Severity.PAGE, "order_by_date_is_missing")]

    if order_by < ctx.as_of:
        failures.append(Failure(
            Check.DATE, Severity.PAGE,
            f"order_by_date_is_in_the_past:{order_by.isoformat()}<"
            f"{ctx.as_of.isoformat()}",
        ))

    # REACHABLE. An order placed today arrives `lead_time_days` later, so a
    # deadline is only meaningful if the delivery it implies lands within the
    # window the decision was sized for. A deadline years out is not a relaxed
    # deadline - it is date arithmetic that went wrong upstream, and it would
    # read to an owner as "no hurry" on a card about a stockout.
    days_out = (order_by - ctx.as_of).days
    horizon = config.get(MAX_ORDER_BY_HORIZON_DAYS, ctx)
    if days_out > horizon:
        failures.append(Failure(
            Check.DATE, Severity.PAGE,
            f"order_by_date_is_unreachably_far:{order_by.isoformat()} is "
            f"{days_out}d out, beyond the {horizon}d horizon "
            f"(lead_time={request.lead_time_days}d)",
        ))

    if request.lead_time_days < 0:
        failures.append(Failure(
            Check.DATE, Severity.PAGE,
            f"lead_time_is_negative:{request.lead_time_days}",
        ))
    return failures


def _check_risk(
    request: DecisionRequest, config: ConfigRegistry, ctx: RunContext
) -> list[Failure]:
    """The stated figure must reconcile with forecast x margin.

    A mismatch means two stages disagree about the same quantity. That is a
    BUG, not a rounding issue, and the reason carries BOTH values so whoever
    is paged can see which stage is wrong without reproducing the run.
    """
    if request.stated_risk is None:
        return []
    if request.unit_margin is None:
        return [Failure(
            Check.RISK, Severity.PAGE,
            f"risk_stated_without_a_margin_to_derive_it_from:"
            f"{request.stated_risk:.2f}",
        )]

    expected = request.demand_p50 * request.unit_margin
    tolerance = config.get(RISK_TOLERANCE_PCT, ctx) / PERCENT
    if expected == 0:
        if abs(request.stated_risk) > 0:
            return [Failure(
                Check.RISK, Severity.PAGE,
                f"risk_does_not_reconcile:stated={request.stated_risk:.2f} "
                f"expected=0.00 (demand_p50={request.demand_p50:.2f} x "
                f"margin={request.unit_margin:.2f})",
            )]
        return []

    difference = abs(request.stated_risk - expected) / abs(expected)
    if difference > tolerance:
        return [Failure(
            Check.RISK, Severity.PAGE,
            f"risk_does_not_reconcile:stated={request.stated_risk:.2f} "
            f"expected={expected:.2f} "
            f"(demand_p50={request.demand_p50:.2f} x "
            f"margin={request.unit_margin:.2f}), "
            f"off_by={difference * PERCENT:.1f}%>"
            f"{tolerance * PERCENT:.0f}%",
        )]
    return []


def _check_constraints(request: DecisionRequest) -> tuple[
    list[Failure], dict[str, str]
]:
    """Every constraint satisfied OR explicitly recorded unavailable.

    SILENCE IS A FAILURE. A constraint nobody evaluated is not a constraint
    that passed, and this is the check that catches the quiet class of bug -
    the one where a stage is skipped and everything downstream looks fine.
    """
    seen: dict[str, str] = {}
    failures: list[Failure] = []

    for constraint in request.constraints:
        seen[constraint.name] = constraint.availability.value

    for name in REQUIRED_CONSTRAINTS:
        if name not in seen:
            failures.append(Failure(
                Check.CONSTRAINTS, Severity.PAGE,
                f"constraint_never_evaluated:{name} - silence is not a pass",
            ))

    for constraint in request.constraints:
        if constraint.availability is Availability.KNOWN:
            if constraint.value is None:
                failures.append(Failure(
                    Check.CONSTRAINTS, Severity.PAGE,
                    f"constraint_claims_known_with_no_value:{constraint.name}",
                ))
        elif not constraint.detail:
            # An unavailable constraint with no stated reason is an assumed
            # bound wearing an honest label.
            failures.append(Failure(
                Check.CONSTRAINTS, Severity.PAGE,
                f"constraint_unavailable_without_a_reason:{constraint.name}",
            ))
    return failures, seen


def coverage_demand(request: DecisionRequest) -> tuple[float, int]:
    """Demand over the window the ORDER was sized for, and that window.

    THE TWO WINDOWS MUST MATCH, AND THEY DO NOT BY DEFAULT.

    `demand_p50` is sheet 07's forecast over its HORIZON - 30 open days. The
    order is sheet 10's, sized to cover the lead time plus the review period -
    14 days. Checking a 14-day order against 30 days of demand compares two
    different quantities and fails every correct decision.

    That is not hypothetical. The first real run of this gate paged on all
    three of store 171's decisions:

        on_hand=48.0 + on_order=0.0 + order=116 - demand=277.8 = -113.8

    The order was right; the comparison was not. A false page is worse than no
    page, because it teaches people to ignore the real one - which is the
    exact failure this sheet exists to correct, reproduced in the gate meant
    to correct it.

    Pro-rating assumes demand is flat across the two windows. It is not -
    day-of-week and seasonality both move it - but the alternative is a second
    forecast at a second horizon, and the error from pro-rating is far smaller
    than the error from comparing 14 days against 30.
    """
    if request.coverage_days <= 0 or request.horizon_days <= 0:
        # No windows stated: use the forecast as given, which is correct only
        # when the caller sized the order over that same window.
        return request.demand_p50, request.horizon_days or 0
    scaled = request.demand_p50 * request.coverage_days / request.horizon_days
    return scaled, request.coverage_days


def _check_inventory(
    request: DecisionRequest, config: ConfigRegistry, ctx: RunContext
) -> list[Failure]:
    """on_hand + order - demand >= safety_stock, over the ORDER's window."""
    demand, window = coverage_demand(request)
    closing = request.on_hand + request.on_order + request.quantity - demand
    tolerance = float(config.get(INVENTORY_TOLERANCE_UNITS, ctx))
    if closing < request.safety_stock - tolerance:
        window_note = f"_over_{window}d" if window else ""
        return [Failure(
            Check.INVENTORY, Severity.PAGE,
            f"inventory_does_not_close:on_hand={request.on_hand:.1f}+"
            f"on_order={request.on_order:.1f}+order={request.quantity}-"
            f"demand={demand:.1f}{window_note}={closing:.1f} "
            f"<safety_stock={request.safety_stock:.1f}",
        )]
    return []


@stage("validate_decision", "1.0.0")
def validate_decision(
    request: DecisionRequest, ctx: RunContext, config: ConfigRegistry = cfg
) -> StageResult:
    """Five checks. Pass carries the record; fail drops the candidate and pages.

    All five run even after one fails, so a paged engineer sees everything
    that is wrong rather than the first thing - two stages disagreeing often
    breaks more than one invariant, and fixing them one page at a time is how
    an incident lasts all afternoon.
    """
    record_inputs("candidates_generate.candidates", "policy_inventory.safety_stock",
                  "constraints_apply.feasible_qty")

    failures: list[Failure] = []
    failures += _check_quantity(request, config, ctx)
    failures += _check_date(request, config, ctx)
    failures += _check_risk(request, config, ctx)
    constraint_failures, constraint_states = _check_constraints(request)
    failures += constraint_failures
    failures += _check_inventory(request, config, ctx)

    if failures:
        return StageResult.failure(
            *[f"{f.severity.value}:{f.check.value}:{f.reason}" for f in failures],
            provenance=request.candidate.provenance,
        )

    covered_demand, covered_window = coverage_demand(request)
    record = DecisionRecord(
        sku=request.candidate.identity.sku,
        product_name=getattr(request.candidate, "display_name", None),
        family=request.candidate.family,
        quantity=request.quantity,
        order_by_date=request.order_by_date,
        demand_p50=request.demand_p50,
        demand_p90=request.demand_p90,
        on_hand=request.on_hand,
        on_order=request.on_order,
        safety_stock=request.safety_stock,
        lead_time_days=request.lead_time_days,
        unit_margin=request.unit_margin,
        stated_risk=request.stated_risk,
        constraint_states=constraint_states,
        assumptions=request.assumptions,
        coverage_days=covered_window,
        coverage_demand=covered_demand,
    )
    return StageResult.success(record, request.candidate.provenance)


def pageable(reasons: Sequence[str]) -> list[str]:
    """The reasons that should wake someone, out of a failed result.

    A helper rather than a convention, so the alerting path cannot drift from
    the severity the check assigned.
    """
    return [r for r in reasons if r.startswith(f"{Severity.PAGE.value}:")]


__all__ = [
    "INVENTORY_TOLERANCE_UNITS",
    "MAX_ORDER_BY_HORIZON_DAYS",
    "MAX_PLAUSIBLE_ORDER_MULTIPLE",
    "REQUIRED_CONSTRAINTS",
    "RISK_TOLERANCE_PCT",
    "Check",
    "DecisionRecord",
    "DecisionRequest",
    "Failure",
    "Severity",
    "coverage_demand",
    "pageable",
    "validate_decision",
]
