"""Inventory health: weeks-on-hand classification with category-aware thresholds.

Wine ages differently than beer, so the over/under-stock bands differ by
category. Status feeds both the candidate slices and the LLM's flags.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.schemas.derived import HealthInfo, VelocityInfo
from app.schemas.store import InventoryItem
from app.store_data.categorize import family_of

if TYPE_CHECKING:  # import cycle guard: canonical_demand has no app imports beyond logging
    from app.store_data.canonical_demand import CanonicalDemandMap

# 30 calendar days / 7. The FALLBACK divisor, used only when the open-day
# count is unknown - see `open_weeks_30d` on compute_inventory_health. A store
# shut one day a week is open ~25.7 days in 30, i.e. 3.67 weeks not 4.3, so
# this divisor understates its weekly rate by ~17% and therefore OVERSTATES
# weeks-on-hand - it makes a store look better covered than it is, which is the
# one direction that hides a stockout.
_WEEKS_PER_MONTH = 4.3
_DAYS_PER_WEEK = 7.0
_NO_VELOCITY_WEEKS = 9999.0  # sentinel for "never sells"

# Thresholds in weeks-on-hand.
HEALTH_THRESHOLDS: dict[str, dict[str, float]] = {
    "default": {"understock": 1.0, "overstock_mild": 8.0, "overstock_severe": 16.0},
    "wine": {"understock": 2.0, "overstock_mild": 20.0, "overstock_severe": 40.0},
    "beer": {"understock": 0.5, "overstock_mild": 4.0, "overstock_severe": 8.0},
    "spirits": {"understock": 1.5, "overstock_mild": 12.0, "overstock_severe": 24.0},
}

# "medium" counts as fast for the understock gate (low cover on an average
# seller is a real stockout risk) but NOT as slow for the overstock gate — an
# average seller with high cover is buffer, not a problem. It previously sat
# in both sets, a contradictory definition.
_FAST_BUCKETS = {"medium", "high", "very_high"}
_SLOW_BUCKETS = {"very_low", "low"}


def _thresholds_for(category: str) -> dict[str, float]:
    # Map the canonical token to its beer/wine/spirits family (e.g. "bourbon" ->
    # spirits, "wine_rose" -> wine, "seltzer" -> beer).
    return HEALTH_THRESHOLDS.get(family_of(category), HEALTH_THRESHOLDS["default"])


def _classify(
    weeks_on_hand: float, bucket: str, thresholds: dict[str, float],
    on_hand: int | None
) -> str:
    # UNKNOWN IS NOT EMPTY. Every branch below is a claim about the shelf, and
    # the status that an absent count used to fall into was `out_of_stock` - the
    # one that reads as "order now".
    if on_hand is None:
        return "unknown"
    if on_hand <= 0:
        return "stockout"
    if weeks_on_hand < thresholds["understock"] and bucket in _FAST_BUCKETS:
        return "understock"
    if weeks_on_hand > thresholds["overstock_severe"]:
        return "overstock_severe"
    if weeks_on_hand > thresholds["overstock_mild"] and bucket in _SLOW_BUCKETS:
        return "overstock_mild"
    return "healthy"


def compute_inventory_health(
    inventory: list[InventoryItem],
    velocity: dict[str, VelocityInfo],
    canonical: CanonicalDemandMap | None = None,
    open_days_30d: int | None = None,
) -> list[HealthInfo]:
    """Weeks-on-hand per SKU.

    `open_days_30d` is the number of days the store actually TRADED in the
    30-day window - sheet 03's one denominator. Supplied, the fallback weekly
    rate divides by OPEN weeks; omitted, it divides by calendar weeks exactly
    as before. Passing a wrong guess would be worse than passing nothing, so
    there is no default beyond None.
    """
    canonical_by_sku = canonical.by_sku if canonical is not None else {}
    # max(): a store with zero open days in the window has no rate to compute,
    # and 0 here would divide by zero rather than say so.
    weeks_in_window = (
        max(open_days_30d, 1) / _DAYS_PER_WEEK if open_days_30d else _WEEKS_PER_MONTH
    )
    health: list[HealthInfo] = []
    for item in inventory:
        category = (item.category or "default").lower()
        v = velocity.get(item.sku)
        units_30d = v.units_30d if v else 0
        bucket = v.velocity_bucket if v else "very_low"

        # Prefer the canonical engine's rate (shelf-age-corrected 90d pace —
        # the same number Store Intelligence classifies on) so both surfaces
        # agree on "how fast" and "how long it lasts". The legacy 30d flat
        # average only fills in when the warehouse bridge is unavailable or
        # the SKU is absent from it (e.g. never sold — rate 0 either way).
        c = canonical_by_sku.get(item.sku)
        if c is not None and c.weekly_rate > 0:
            weekly_rate = c.weekly_rate
            weeks_on_hand = (
                c.weeks_on_hand if c.weeks_on_hand is not None else _NO_VELOCITY_WEEKS
            )
        else:
            weekly_rate = units_30d / weeks_in_window if units_30d > 0 else 0.0
            # No level means no cover. `_NO_VELOCITY_WEEKS` is the existing
            # sentinel for "cannot be computed" and `weeks_value` below already
            # turns it into a null on the way out.
            weeks_on_hand = (
                (item.on_hand / weekly_rate)
                if weekly_rate > 0 and item.on_hand is not None
                else _NO_VELOCITY_WEEKS
            )

        status = _classify(weeks_on_hand, bucket, _thresholds_for(category), item.on_hand)
        weeks_value = round(weeks_on_hand, 1) if weeks_on_hand < _NO_VELOCITY_WEEKS else None

        health.append(
            HealthInfo(
                sku=item.sku,
                category=category,
                on_hand=item.on_hand,
                weekly_rate=round(weekly_rate, 2),
                weeks_on_hand=weeks_value,
                # None, not 0. A zero here reads as "no capital at risk on
                # this line", which is a claim; not knowing the level is not.
                tied_up_capital=(None if item.on_hand is None
                                 else round(item.on_hand * item.price, 2)),
                status=status,
            )
        )
    return health
