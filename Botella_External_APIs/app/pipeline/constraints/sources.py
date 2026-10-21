"""Which constraints exist, which do not, and the difference between them.

THE RULE THIS FILE EXISTS FOR
    An unavailable constraint is recorded as UNAVAILABLE, never silently
    treated as unbounded. `shelf_capacity = None` means "we do not know", NOT
    infinity.

    That distinction is the difference between a system that is honest about
    its limits and one that recommends 400 units into a shop with room for 40.
    Stage 14 can see it, and the card can say it.

MEASURED AVAILABILITY, this warehouse, today
    case_pack      products.pack_size    100% populated (911,022 rows)
                                         91.6% of 380 distinct values parse
    on_hand        products.stock_qty    100% populated in syncgo, BUT a
                                         CURRENT snapshot with no history, and
                                         stale for most stores (see below).
                                         feature_daily.on_hand is NULL in all
                                         12,091,569 rows - it is only ever
                                         filled forward from the day capture
                                         starts, and capture has not started
    moq            purchases.quantity    429,690 rows, 682 suppliers -> DERIVED
    uom            products.uom          69.9% non-empty, and it is VOLUME,
                                         not a pack count (see normalise.py)
    lead_time      -                     ABSENT. Declared assumption (sheet 10)
    shelf_capacity -                     ABSENT. Owner input later
    budget         -                     ABSENT. Owner input per period
    promo_locks    -                     ABSENT. Needs a promotions feed
    perishability  -                     ABSENT. Per-category shelf life later
"""

from __future__ import annotations

import statistics
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from enum import StrEnum
from typing import Any

from app.pipeline.context import RunContext
from app.pipeline.registry import ConfigRegistry, Setting, cfg


class Availability(StrEnum):
    """Why a constraint has the value it has.

    Three states, not two. `UNAVAILABLE` and a value of None are not the same
    as `KNOWN` with a value of None, and neither is `UNPARSEABLE` - which
    means the source HAD data and we could not read it, a condition somebody
    should fix rather than accept.
    """

    KNOWN = "known"
    #: The source column does not exist in this warehouse at all.
    UNAVAILABLE = "unavailable"
    #: The source had a value and it could not be read. Actionable.
    UNPARSEABLE = "unparseable"
    #: Derived from history that is too thin to trust yet.
    INSUFFICIENT_HISTORY = "insufficient_history"
    #: The source HAD a value and it is too old to act on. Distinct from
    #: UNAVAILABLE, which means the column does not exist: this one is a
    #: sync that stopped, which somebody can go and restart.
    STALE = "stale"


@dataclass(frozen=True, slots=True)
class Constraint:
    """One constraint's value AND why it has it."""

    name: str
    value: float | None
    availability: Availability
    detail: str | None = None

    @property
    def binds(self) -> bool:
        """Can this constraint actually restrict a quantity?

        Only a KNOWN value can. An unavailable constraint must never be read
        as "no limit" - it is read as "no limit APPLIED, and we said so".
        """
        return self.availability is Availability.KNOWN and self.value is not None

    def as_dict(self) -> dict[str, Any]:
        return {"name": self.name, "value": self.value,
                "availability": self.availability.value, "detail": self.detail}


def known(name: str, value: float, detail: str | None = None) -> Constraint:
    return Constraint(name, float(value), Availability.KNOWN, detail)


def unavailable(name: str, detail: str) -> Constraint:
    """A constraint this warehouse cannot supply. NOT unbounded."""
    return Constraint(name, None, Availability.UNAVAILABLE, detail)


def unparseable(name: str, detail: str) -> Constraint:
    return Constraint(name, None, Availability.UNPARSEABLE, detail)


def stale(name: str, detail: str) -> Constraint:
    """A value that exists and is too old to act on.

    Returns no value at all, deliberately. A stale count is not a smaller
    count or a less certain count - it is a count of a shelf that has since
    been sold from and restocked an unknown number of times, and arithmetic on
    it produces a confident wrong number rather than an uncertain one.
    """
    return Constraint(name, None, Availability.STALE, detail)


# ── The constraints that do not exist here, named once ───────────────────────
#
# Written out rather than left implicit so that "we never looked" and "we
# looked and it is not there" are different states in the code as well as in
# the prose.

def shelf_capacity_unavailable() -> Constraint:
    return unavailable(
        "shelf_capacity",
        "no planogram or shelf data in either database - owner input needed. "
        "This is NOT unlimited shelf space",
    )


def budget_unavailable() -> Constraint:
    return unavailable(
        "budget",
        "no per-period purchasing budget recorded - owner input needed. "
        "Cheap to capture and changes the output immediately",
    )


def promo_locks_unavailable() -> Constraint:
    return unavailable(
        "promo_locks",
        "no promotions feed, so a SKU locked into a promotion cannot be "
        "detected and its price/quantity may be changed under one",
    )


def perishability_unavailable() -> Constraint:
    return unavailable(
        "perishability",
        "no per-category shelf life recorded - matters for beer and mixers, "
        "not for spirits",
    )


# ── MOQ, derived from purchase history ───────────────────────────────────────


@dataclass(frozen=True, slots=True)
class MoqEvidence:
    """What the purchase history says about one supplier-SKU's minimum."""

    supplier_id: str
    sku: str
    observations: int
    minimum: int
    modal: int


def derive_moq(
    quantities: Sequence[int],
    supplier_id: str,
    sku: str,
    min_observations: int,
) -> tuple[Constraint, MoqEvidence | None]:
    """Infer a minimum order quantity from what was actually ordered.

    The MODAL order quantity, not the minimum. A single small order - a
    sample, a partial delivery, a correction - would drag the minimum to 1 and
    switch the constraint off, which is the silent-default failure again. The
    mode is what this supplier-SKU is normally bought in.

    Both are reported, so a reader can see when they disagree.

    Thin history returns INSUFFICIENT_HISTORY rather than a guess: it improves
    as history accumulates, and until then saying so beats inventing a floor.
    """
    usable = [int(q) for q in quantities if q and int(q) > 0]
    if len(usable) < min_observations:
        return (
            Constraint(
                "moq", None, Availability.INSUFFICIENT_HISTORY,
                f"{len(usable)} purchase(s) of {sku} from {supplier_id}, "
                f"need {min_observations}",
            ),
            None,
        )
    modal = statistics.mode(usable)
    evidence = MoqEvidence(supplier_id, sku, len(usable), min(usable), modal)
    return (
        known("moq", modal,
              f"modal order quantity across {len(usable)} purchases "
              f"(smallest seen: {min(usable)})"),
        evidence,
    )


# ── On hand, from a snapshot that is only sometimes current ──────────────────

MAX_STOCK_SNAPSHOT_AGE_DAYS = Setting(
    name="constraints.on_hand.max_snapshot_age_days",
    default=7,
    unit="days between the POS sync and the decision",
    owner="operations",
    why="provisional. syncgo.products holds ONE mutating row per SKU with no "
        "history, so a shelf count is only as good as its last sync - and the "
        "estate is wildly uneven: stores 171 and 22 synced the morning this "
        "was written, while 97, 92 and 106 last synced 2026-06-03, 112 days "
        "earlier. Sizing an order against a 112-day-old count is not a less "
        "accurate order, it is an order for a shop whose shelves have since "
        "turned over entirely. Seven days is one review period, the window "
        "inside which a count is still about the same shelf; it is a judgement "
        "to be fitted once sync freshness is monitored rather than inferred",
    status="PROVISIONAL",
)


def on_hand_from_snapshot(
    quantity: float | None,
    observed_at: datetime | date | None,
    as_of: date,
    ctx: RunContext,
    config: ConfigRegistry = cfg,
) -> Constraint:
    """A shelf count, if there is one and it is recent enough to mean anything.

    THREE WAYS THIS RETURNS NOTHING, AND THEY ARE DIFFERENT FACTS.
        no value        -> UNAVAILABLE. This SKU is not in the snapshot.
        negative value  -> UNPARSEABLE. 83,322 of 911,022 rows estate-wide are
                           negative, which is a POS artefact, not a shelf. It
                           is NOT clamped to zero: clamping turns "this count
                           is wrong" into "this shelf is empty", which is a
                           measurement nobody made and which orders the
                           maximum.
        too old         -> STALE. See MAX_STOCK_SNAPSHOT_AGE_DAYS.

    Zero IS a value and passes through: an empty shelf is a measurement, and
    the one most likely to deserve a reorder.

    Why this matters more than it looks: every reorder is sized as
    `order_up_to - on_hand - on_order`, so a missing on_hand read as zero does
    not produce a cautious small order - it produces the largest order the
    policy can express, on every SKU at once, with nothing in the output
    looking wrong.
    """
    if quantity is None:
        return unavailable(
            "on_hand",
            "this SKU is not in the POS product snapshot, so the shelf count "
            "is unknown - which is not the same as empty",
        )

    if quantity < 0:
        return unparseable(
            "on_hand",
            f"the POS reports {quantity:g} on hand, which is not a shelf "
            f"state. Not read as empty: that would order the maximum",
        )

    if observed_at is None:
        return stale(
            "on_hand",
            "the shelf count carries no sync time, so its age cannot be "
            "checked and it cannot be trusted to be current",
        )

    observed = (observed_at.date() if isinstance(observed_at, datetime)
                else observed_at)
    age_days = (as_of - observed).days
    max_age = int(config.get(MAX_STOCK_SNAPSHOT_AGE_DAYS, ctx))
    if age_days > max_age:
        return stale(
            "on_hand",
            f"the POS last synced this store {age_days} days ago "
            f"({observed.isoformat()}), beyond the {max_age}-day limit. The "
            f"shelf has turned over since; restart the sync",
        )

    detail = (f"POS shelf count, synced {age_days} day(s) ago"
              if age_days else "POS shelf count, synced today")
    return known("on_hand", quantity, detail)


__all__ = [
    "Availability",
    "MAX_STOCK_SNAPSHOT_AGE_DAYS",
    "Constraint",
    "MoqEvidence",
    "budget_unavailable",
    "derive_moq",
    "known",
    "on_hand_from_snapshot",
    "perishability_unavailable",
    "promo_locks_unavailable",
    "shelf_capacity_unavailable",
    "stale",
    "unavailable",
    "unparseable",
]
