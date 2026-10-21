"""Turn the IDEAL quantity into an ORDERABLE one, and say what moved it.

    ideal    = 37.4 units        (sheet 10's policy)
    feasible = 24               (2 cases of 12, capped by shelf 40)
    reasons  = ["rounded up to 3 case packs of 12 (36)",
                "capped at shelf capacity 40 -> 24"]

THE REASONS TRAVEL WITH THE NUMBER
    The card has to explain why it says 24 and not 37. That is the difference
    between looking wrong and looking careful - and a recommendation that says
    "order 37" when the supplier ships twelves is wrong in a way no forecast
    improvement fixes. The owner reads it as "the software does not understand
    my business", which is very hard to reverse.

THE ORDER IS DEFINED AND TESTED
    1. MOQ            raise to the supplier's minimum
    2. case pack      round to a whole number of packs
    3. shelf capacity cap by what fits, then re-round DOWN to whole packs
    4. budget         cap by spend, then re-round DOWN to whole packs

    Caps come after rounding and force a re-round, because rounding up THEN
    capping can leave a part-pack the supplier will not ship. Re-rounding down
    can reach zero, and zero is a legitimate answer: "this does not fit and we
    are not going to pretend otherwise".

AN UNAVAILABLE CONSTRAINT NEVER BINDS
    `shelf_capacity = None` means we do not know, not infinity. It cannot cap
    anything, and the fact that it could not is recorded in `not_applied` so
    stage 14 and the card can both see it.
"""

from __future__ import annotations

import math
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from app.pipeline.constraints.sources import Availability, Constraint
from app.pipeline.context import RunContext
from app.pipeline.envelope import StageResult, stage
from app.pipeline.provenance import Provenance, record_inputs
from app.pipeline.registry import ConfigRegistry, Setting, cfg

#: Guard against ceil() turning an exact multiple into an extra pack.
#:
#: 36.0 / 12 can land on 3.0000000000000004 after the divisions above, and
#: ceil would then order a FOURTH case of twelve for one unit of floating-point
#: dust. Derived from machine epsilon rather than written as 1e-9: it is a
#: property of float arithmetic, not a judgement about ordering.
_PACK_EPSILON = sys.float_info.epsilon * 16

MIN_MOQ_OBSERVATIONS = Setting(
    name="constraints.moq.min_observations",
    default=3,
    unit="purchases of one supplier-SKU",
    owner="operations",
    why="provisional; below three purchases the modal order quantity is just "
        "the first thing that happened. Such supplier-SKUs report "
        "INSUFFICIENT_HISTORY rather than a guessed floor, and improve as "
        "history accumulates across the 429,690 purchase rows",
    status="PROVISIONAL",
)


@dataclass(frozen=True, slots=True)
class ConstraintSet:
    """Every constraint for one SKU, available or not."""

    case_pack: Constraint
    on_hand: Constraint
    moq: Constraint
    shelf_capacity: Constraint
    budget: Constraint
    unit_cost: Constraint | None = None

    def all(self) -> tuple[Constraint, ...]:
        found = (self.case_pack, self.on_hand, self.moq,
                 self.shelf_capacity, self.budget)
        return found + ((self.unit_cost,) if self.unit_cost else ())


@dataclass(frozen=True, slots=True)
class ApplyRequest:
    sku: str
    ideal_qty: float
    constraints: ConstraintSet


@dataclass(frozen=True, slots=True)
class FeasibleQuantity:
    """What can actually be ordered, and every step that changed it."""

    sku: str
    ideal_qty: float
    feasible_qty: int
    reasons: tuple[str, ...]
    #: Constraints that could NOT be applied, and why. Never empty in this
    #: warehouse: shelf capacity and budget do not exist yet.
    not_applied: tuple[str, ...]

    @property
    def was_constrained(self) -> bool:
        return bool(self.reasons)

    def as_dict(self) -> dict[str, Any]:
        return {
            "sku": self.sku, "ideal_qty": self.ideal_qty,
            "feasible_qty": self.feasible_qty,
            "reasons": list(self.reasons),
            "not_applied": list(self.not_applied),
        }

    def explain(self) -> str:
        """Why it says 24 and not 37."""
        if not self.reasons:
            return f"Order {self.feasible_qty}."
        return (
            f"Order {self.feasible_qty} rather than {self.ideal_qty:.1f}: "
            + "; ".join(self.reasons) + "."
        )


def _round_to_pack(quantity: float, pack: int, *, down: bool) -> int:
    packs = quantity / pack
    whole = math.floor(packs) if down else math.ceil(packs - _PACK_EPSILON)
    return max(0, int(whole) * pack)


@stage("constraints_apply", "1.0.0")
def apply_constraints(
    request: ApplyRequest, ctx: RunContext, config: ConfigRegistry = cfg
) -> StageResult:
    """Ideal -> orderable, with a reason for every constraint that bit."""
    record_inputs("products.pack_size", "products.stock_qty",
                  "purchases.quantity")

    constraints = request.constraints
    reasons: list[str] = []
    not_applied: list[str] = []

    for constraint in constraints.all():
        if constraint.availability is not Availability.KNOWN:
            # Recorded, not silently skipped. "We do not know" is information.
            not_applied.append(
                f"{constraint.name}: {constraint.availability.value}"
                + (f" ({constraint.detail})" if constraint.detail else "")
            )

    quantity = max(0.0, request.ideal_qty)

    # 1. MOQ - raise to the supplier's minimum.
    if constraints.moq.binds and quantity > 0:
        moq = float(constraints.moq.value or 0)
        if quantity < moq:
            reasons.append(
                f"raised to the supplier minimum of {moq:.0f}"
            )
            quantity = moq

    # 2. Case pack - round UP to a whole number of packs.
    pack = int(constraints.case_pack.value or 0) if constraints.case_pack.binds else 0
    if pack > 1 and quantity > 0:
        rounded = _round_to_pack(quantity, pack, down=False)
        if rounded != quantity:
            reasons.append(
                f"rounded up to {rounded // pack} case pack(s) of {pack} "
                f"({rounded})"
            )
        quantity = rounded

    # 3. Shelf capacity - cap by what fits, then re-round DOWN to whole packs.
    #    Capping after rounding can leave a part-pack the supplier will not
    #    ship, so the cap forces a re-round.
    if constraints.shelf_capacity.binds:
        room = max(0.0, float(constraints.shelf_capacity.value or 0)
                   - float(constraints.on_hand.value or 0
                           if constraints.on_hand.binds else 0))
        if quantity > room:
            capped = _round_to_pack(room, pack, down=True) if pack > 1 else math.floor(room)
            reasons.append(
                f"capped at shelf capacity "
                f"{constraints.shelf_capacity.value:.0f} -> {capped:.0f}"
            )
            quantity = capped

    # 4. Budget - same shape as the shelf cap.
    if constraints.budget.binds and constraints.unit_cost \
            and constraints.unit_cost.binds:
        cost = float(constraints.unit_cost.value or 0)
        if cost > 0:
            affordable = float(constraints.budget.value or 0) / cost
            if quantity > affordable:
                capped = (_round_to_pack(affordable, pack, down=True)
                          if pack > 1 else math.floor(affordable))
                reasons.append(
                    f"capped by budget "
                    f"{constraints.budget.value:.0f} -> {capped:.0f}"
                )
                quantity = capped

    feasible = FeasibleQuantity(
        sku=request.sku,
        ideal_qty=request.ideal_qty,
        # int() last: every intermediate step stays exact so a re-round
        # cannot accumulate a unit of drift.
        feasible_qty=max(0, int(quantity)),
        reasons=tuple(reasons),
        not_applied=tuple(not_applied),
    )
    return StageResult.success(
        feasible,
        Provenance(
            own_observations=0,
            own_weight=1.0,
            evidence_state="ESTABLISHED" if not not_applied else "EMERGING",
            inputs=("products.pack_size", "products.stock_qty",
                    "purchases.quantity"),
        ),
    )


def apply_many(
    requests: Sequence[ApplyRequest], ctx: RunContext,
    config: ConfigRegistry = cfg,
) -> list[FeasibleQuantity]:
    out: list[FeasibleQuantity] = []
    for request in requests:
        result = apply_constraints(request, ctx, config)
        if result.ok and result.value is not None:
            out.append(result.value)
    return out


__all__ = [
    "MIN_MOQ_OBSERVATIONS",
    "ApplyRequest",
    "ConstraintSet",
    "FeasibleQuantity",
    "apply_constraints",
    "apply_many",
]
