"""Sheet 11 — business constraints. Ideal quantity -> orderable quantity.

    ideal 37.4  ->  feasible 24  + reasons the card can show

An unavailable constraint is recorded as UNAVAILABLE, never treated as
unbounded. shelf_capacity=None means "we do not know", not infinity.
"""

from app.pipeline.constraints.apply import (
    ApplyRequest,
    ConstraintSet,
    FeasibleQuantity,
    apply_constraints,
    apply_many,
)
from app.pipeline.constraints.normalise import (
    ParsedPack,
    parse_many,
    parse_pack_size,
)
from app.pipeline.constraints.sources import (
    MAX_STOCK_SNAPSHOT_AGE_DAYS,
    Availability,
    Constraint,
    budget_unavailable,
    derive_moq,
    known,
    on_hand_from_snapshot,
    perishability_unavailable,
    promo_locks_unavailable,
    shelf_capacity_unavailable,
    stale,
    unavailable,
    unparseable,
)

__all__ = [
    "MAX_STOCK_SNAPSHOT_AGE_DAYS",
    "ApplyRequest", "Availability", "Constraint", "ConstraintSet",
    "FeasibleQuantity", "ParsedPack", "apply_constraints", "apply_many",
    "budget_unavailable", "derive_moq", "known", "parse_many",
    "on_hand_from_snapshot", "parse_pack_size", "perishability_unavailable",
    "promo_locks_unavailable", "shelf_capacity_unavailable", "stale",
    "unavailable", "unparseable",
]
