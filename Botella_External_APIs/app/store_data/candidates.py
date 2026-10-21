"""Signal-aware candidate selection (no vector store).

Produces ~150 candidates across fourteen named slices (lost_sale, understock,
reorder_due, overstock, proven, area_winner, new_hot, news_match,
social_trend, new, bestseller, trending, liquidate, signal_aligned) so the
LLM reasons over a constrained, relevant set instead of the full catalog.
Slice order encodes priority: earlier slices win when the pool fills up.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from app.logging_config import get_logger
from app.schemas.derived import Candidate, HealthInfo, VelocityInfo
from app.schemas.signals import SignalBundle
from app.schemas.store import InventoryItem
from app.signals.mapping import active_categories, expand_families
from app.store_data.categorize import family_of, norm_text
from storeagent.canonical.size import (
    SMALL_FORMAT_MAX_ML,
    is_small_format,
    parse_size_ml,
)

if TYPE_CHECKING:  # import-cycle guard: store_intel has no imports from here
    from app.store_data.store_intel import StoreIntel

log = get_logger(__name__)

# Per-slice caps (sum > 150 before dedup; dedup + cap trims to top_n).
# signal_aligned is deliberately LAST in priority and capped so one broad
# family signal ("beer") can never crowd the inventory-driven perspectives
# (trending, liquidate) out of the pool — the slices before bestseller sum
# well under top_n=150, guaranteeing them room.
_SLICE_CAPS = {
    "lost_sale": 8,
    "understock": 10,
    "reorder_due": 10,
    "overstock": 15,
    "proven": 10,
    "area_winner": 5,
    "new_hot": 8,
    "news_match": 10,
    "social_trend": 8,
    "bestseller": 25,
    "signal_aligned": 60,
    "trending": 10,
    "new": 5,
    "liquidate": 5,
}
# Small-format (nip) discipline: minis sell huge UNIT counts at tiny prices,
# so unit-ranked slices drowned full bottles in nips. A product at or under
# ``small_format_max_ml`` is now excluded from the pool OUTRIGHT - every
# slice, operational ones included. Capping them at 15 (and exempting
# understock/reorder_due) still let minis reach the model, and a mini paired
# with a real bottle sailed past the validator's per-run cap on top of that.

# One week: long enough to prove first traction, short enough that the same
# product never dominates the daily new_arrival slot for a month (product ask).
_NEW_ARRIVAL_DAYS = 7
# A new arrival is "hot" when it has real volume for its short shelf life AND
# either weekly momentum (rising trend) or above-average velocity within its
# category. Below the volume floor a good week is indistinguishable from noise.
_NEW_HOT_MIN_UNITS_30D = 5

# Within-category price percentile cutoffs for the value/mid/premium tier the
# prompt shows next to every price. Thin cohorts fall back to the product's
# beer/wine/spirits family; below the floor there too, the tier stays "mid"
# (neutral: no basis to call anything premium or cheap).
_TIER_PREMIUM_PCT = 0.75
_TIER_VALUE_PCT = 0.25
_TIER_MIN_COHORT = 5


class _EnrichedProduct:
    """In-stock product joined with its velocity + health metadata."""

    __slots__ = (
        "item", "velocity_bucket", "units_30d", "trend",
        "weeks_on_hand", "health_status", "weekly_rate", "size_ml",
        "small_format",
    )

    def __init__(
        self,
        item: InventoryItem,
        v: VelocityInfo | None,
        h: HealthInfo | None,
        small_format_max_ml: float = SMALL_FORMAT_MAX_ML,
    ) -> None:
        self.item = item
        self.velocity_bucket = v.velocity_bucket if v else "very_low"
        self.units_30d = v.units_30d if v else 0
        self.trend = v.trend if v else "stable"
        self.weeks_on_hand = h.weeks_on_hand if h else None
        self.health_status = h.status if h else "healthy"
        self.weekly_rate = h.weekly_rate if h else 0.0
        self.size_ml = parse_size_ml(item.product_name, None, None)
        # Resolved once here rather than per-slice: the name is the only size
        # evidence at this layer (categories are canonicalized upstream, so
        # the raw "Miniature .99" label is already gone by now).
        self.small_format = is_small_format(
            item.product_name,
            size_ml=self.size_ml,
            category=item.category,
            max_ml=small_format_max_ml,
        )

    @property
    def capital(self) -> float | None:
        """Money tied up, or None when the shelf count is unknown.

        A zero would read as "nothing at risk on this line", which is a claim.
        """
        if self.item.on_hand is None:
            return None
        return self.item.on_hand * self.item.price

    @property
    def revenue_30d(self) -> float:
        """Trailing-30d revenue: the slice-ranking currency. Unit counts made
        a $0.99 nip at 30/week outrank a $25 bottle at 5/week; dollars put
        them on one scale ($30/wk vs $125/wk)."""
        return self.units_30d * self.item.price

def _to_candidate(p: _EnrichedProduct, slice_label: str, price_tier: str) -> Candidate:
    return Candidate(
        sku=p.item.sku,
        product_name=p.item.product_name,
        category=p.item.category,
        sub_category=p.item.sub_category,
        price=p.item.price,
        price_tier=price_tier,
        margin_pct=p.item.margin_pct,
        on_hand=p.item.on_hand,
        velocity_bucket=p.velocity_bucket,
        trend=p.trend,
        weeks_on_hand=p.weeks_on_hand,
        health_status=p.health_status,
        weekly_rate=p.weekly_rate,
        size_ml=p.size_ml,
        slice=slice_label,
    )


def _price_tiers(products: list[_EnrichedProduct]) -> dict[str, str]:
    """sku -> value | mid | premium, by price percentile WITHIN the product's
    own category at this store.

    This is what grounds the prompt's pricing language: without it the model
    judged expensiveness on absolute dollars and called a $20 wine "high
    value". A $20 bottle sitting at the 40th percentile of this store's wines
    is mid-tier, whatever the raw number looks like next to a $9 seltzer.
    """
    by_category: dict[str, list[float]] = defaultdict(list)
    by_family: dict[str, list[float]] = defaultdict(list)
    for p in products:
        price = p.item.price
        if price <= 0:
            continue
        by_category[p.item.category or "uncategorized"].append(price)
        family = family_of(p.item.category)
        # "default" is not a family: pooling every uncategorized product into
        # one cohort would rank a $30 wine "premium" against $5 mixers — a
        # confident label with no basis. Uncategorized products get a tier
        # only when their own category cohort is thick enough.
        if family != "default":
            by_family[family].append(price)

    def _percentile(cohort: list[float], price: float) -> float:
        below = sum(1 for x in cohort if x < price)
        ties = sum(1 for x in cohort if x == price)
        return (below + 0.5 * ties) / len(cohort)

    tiers: dict[str, str] = {}
    for p in products:
        price = p.item.price
        cohort = by_category.get(p.item.category or "uncategorized", [])
        if len(cohort) < _TIER_MIN_COHORT:
            cohort = by_family.get(family_of(p.item.category), [])
        if price <= 0 or len(cohort) < _TIER_MIN_COHORT:
            tiers[p.item.sku] = "mid"
            continue
        rank = _percentile(cohort, price)
        if rank >= _TIER_PREMIUM_PCT:
            tiers[p.item.sku] = "premium"
        elif rank <= _TIER_VALUE_PCT:
            tiers[p.item.sku] = "value"
        else:
            tiers[p.item.sku] = "mid"
    return tiers


def select_candidates(
    inventory: list[InventoryItem],
    velocity: dict[str, VelocityInfo],
    health: list[HealthInfo],
    signals: SignalBundle,
    *,
    now: datetime | None = None,
    top_n: int = 150,
    proven_skus: set[str] | None = None,
    area_winner_skus: set[str] | None = None,
    order_due_ranked: list[str] | None = None,
    intel: StoreIntel | None = None,
    small_format_max_ml: float = SMALL_FORMAT_MAX_ML,
) -> list[Candidate]:
    now = now or datetime.now(UTC)
    health_by_sku = {h.sku: h for h in health}

    products = [
        _EnrichedProduct(item, velocity.get(item.sku), health_by_sku.get(item.sku),
                         small_format_max_ml)
        for item in inventory
        # `is not None` first: an unknown level is not a stocked one. Without it
        # the comparison raises, and with a `or 0` it would silently fall into
        # the stocked-out pool below - the most urgent card the engine issues.
        if item.on_hand is not None and item.on_hand > 0
    ]
    # Stocked-out recent sellers are the strongest reorder case there is, but
    # an on_hand > 0 pool made them invisible to the model. They join ONLY the
    # understock slice: reorder/pre_stock are the only actions that make sense
    # for a product with nothing on the shelf.
    stockouts = [
        _EnrichedProduct(item, velocity.get(item.sku), health_by_sku.get(item.sku),
                         small_format_max_ml)
        for item in inventory
        # UNKNOWN IS NOT EMPTY. This pool is "nothing on the shelf and it was
        # selling", which is the strongest reorder case there is - so a SKU the
        # feed simply never mentioned must not land here.
        if item.on_hand is not None and item.on_hand <= 0
        and (v := velocity.get(item.sku)) is not None
        and v.units_30d > 0
    ]
    if not products and not stockouts:
        return []

    # Price tiers are read off the WHOLE shelf, minis included: a tier is
    # "where this price sits in its category", and dropping the cheap end
    # would silently re-rank every surviving product.
    price_tiers = _price_tiers(products + stockouts)

    # Minis leave here, before any slice is built. Filtering later would let
    # a nip-filled slice burn its cap and yield two real candidates instead
    # of ten.
    excluded_small = sum(p.small_format for p in products) + sum(
        p.small_format for p in stockouts
    )
    if excluded_small:
        products = [p for p in products if not p.small_format]
        stockouts = [p for p in stockouts if not p.small_format]
        log.info(
            "small_format_excluded",
            products=excluded_small,
            max_ml=small_format_max_ml,
        )
    if not products and not stockouts:
        return []

    # Mapped signal keys + whatever categories the LLM news/event/trend
    # analysts flagged (family-expanded like everything else).
    eligible_cats = active_categories(signals.active_keys) | expand_families(
        set(signals.news_categories)
        | set(signals.event_categories)
        | set(signals.trend_categories)
    )

    # Product-name keywords from the news analyst ("rioja", "cava" for a
    # Spanish-tariff story): match word-bounded against names so the slice
    # surfaces the specific affected imports, not whole categories. Hints go
    # through the SAME normalization as the names they're matched against —
    # a hint carrying an accent or punctuation ("rosé", "jack daniel's")
    # could otherwise never match a norm_text'd name, which silently missed
    # exactly the accented imports a supply story tends to name.
    news_hints = {
        hint
        for kw in signals.news_product_keywords
        if (hint := norm_text(kw).strip())
    }

    # Same mechanism for the social-trend channel ("aperol", "high noon"):
    # the slice surfaces the store's own products matching a trending drink.
    trend_hints = {
        hint
        for kw in signals.trend_product_keywords
        if (hint := norm_text(kw).strip())
    }

    def _matches_hints(p: _EnrichedProduct, hints: set[str]) -> bool:
        if not hints:
            return False
        padded = norm_text(p.item.product_name or "")
        return any(f" {hint} " in padded for hint in hints)

    def _matches_news(p: _EnrichedProduct) -> bool:
        return _matches_hints(p, news_hints)

    def top(
        items: list[_EnrichedProduct],
        key: Callable[[_EnrichedProduct], Any],
        n: int,
        reverse: bool = True,
    ) -> list[_EnrichedProduct]:
        return sorted(items, key=key, reverse=reverse)[:n]

    # Measured stockout bleed (Buying tab's lost-sales view): proven movers
    # with an empty shelf and real dollars already missed. The strongest
    # reorder case there is, so the slice outranks everything. Built from the
    # raw inventory (not the `stockouts` list): a SKU out for >30 days has
    # units_30d == 0 in the Node feed, yet the engine still measures its bleed
    # from the 90-day rate. Engine ranking (worst bleed first) is preserved.
    lost_by_sku = {item.sku: item for item in inventory
                   if item.on_hand is not None and item.on_hand <= 0}
    lost_sale = [
        _EnrichedProduct(lost_by_sku[sku], velocity.get(sku), health_by_sku.get(sku))
        for sku in (intel.lost_sales if intel is not None else {})
        if sku in lost_by_sku
    ][:_SLICE_CAPS["lost_sale"]]
    understock = top(
        [p for p in products if p.health_status == "understock"] + stockouts,
        key=lambda p: p.units_30d, n=_SLICE_CAPS["understock"],
    )
    # Week-ahead notice (canonical engine): SKUs whose order-by date lands
    # within the next 7 days, already ranked most-urgent-first upstream. This
    # is what surfaces a reorder BEFORE the understock threshold trips — the
    # owner gets the signal while there is still time for delivery.
    by_sku = {p.item.sku: p for p in products}
    reorder_due = [
        by_sku[sku] for sku in (order_due_ranked or []) if sku in by_sku
    ][:_SLICE_CAPS["reorder_due"]]
    overstock = top(
        [p for p in products if p.health_status in ("overstock_mild", "overstock_severe")],
        key=lambda p: p.capital, n=_SLICE_CAPS["overstock"],
    )
    # SKUs from past recommendations that scored above the winner threshold
    # (realized lift + thumbs votes). Feedback changes *eligibility*
    # deterministically here, the same way signals do — not just prompt prose.
    proven = top(
        [p for p in products if p.item.sku in (proven_skus or set())],
        key=lambda p: p.revenue_30d, n=_SLICE_CAPS["proven"],
    )
    # Products this store carries that are new-and-winning at nearby stores
    # (Node's cross-store area intelligence, matched back to a local sku).
    area_winners = top(
        [p for p in products if p.item.sku in (area_winner_skus or set())],
        key=lambda p: p.revenue_30d, n=_SLICE_CAPS["area_winner"],
    )
    news_match = top(
        [p for p in products if _matches_news(p)],
        key=lambda p: p.revenue_30d, n=_SLICE_CAPS["news_match"],
    )
    social_trend = top(
        [p for p in products if _matches_hints(p, trend_hints)],
        key=lambda p: p.revenue_30d, n=_SLICE_CAPS["social_trend"],
    )
    bestsellers = top(products, key=lambda p: p.revenue_30d, n=_SLICE_CAPS["bestseller"])
    signal_aligned = top(
        [p for p in products if (p.item.category or "") in eligible_cats],
        key=lambda p: p.revenue_30d, n=_SLICE_CAPS["signal_aligned"],
    )
    trending = top(
        [p for p in products if p.trend == "rising"],
        key=lambda p: p.revenue_30d, n=_SLICE_CAPS["trending"],
    )
    # New arrivals: created_at is the first-seen date Node's catalog tracking
    # assigns (products has no real creation timestamp). Split into "already
    # performing" (prioritized above bestsellers so an established big name
    # never claims the label first) and the plain "recently added" tail.
    all_new = [
        p for p in products
        if p.item.created_at is not None
        and (now - p.item.created_at).days <= _NEW_ARRIVAL_DAYS
    ]
    new_hot = top(
        [
            p for p in all_new
            if p.units_30d >= _NEW_HOT_MIN_UNITS_30D
            and (p.trend == "rising" or p.velocity_bucket in ("high", "very_high"))
        ],
        key=lambda p: p.units_30d, n=_SLICE_CAPS["new_hot"],
    )
    new_hot_skus = {p.item.sku for p in new_hot}
    new_arrivals = top(
        [p for p in all_new if p.item.sku not in new_hot_skus],
        key=lambda p: p.units_30d, n=_SLICE_CAPS["new"],
    )
    # Dead stock tying up capital is worth surfacing regardless of which
    # signals happen to be active — it's an inventory problem, not a signal
    # problem, so this slice is deliberately NOT gated on eligible_cats. It
    # IS gated on the family-aware overstock_severe status: a flat
    # weeks-on-hand cutoff used to tag wine at 17 weeks (healthy by the wine
    # thresholds) as liquidation stock, inviting clear-out actions on stock
    # that was fine.
    liquidate = top(
        [p for p in products if p.health_status == "overstock_severe"],
        key=lambda p: p.capital, n=_SLICE_CAPS["liquidate"],
    )

    # Dedup, preserving first-seen order (which respects slice priority).
    # trending and liquidate sit ABOVE signal_aligned: a broad family signal
    # once claimed 80 slots and pushed both out of the pool entirely.
    ordered_slices: list[tuple[list[_EnrichedProduct], str]] = [
        (lost_sale, "lost_sale"),
        (understock, "understock"),
        (reorder_due, "reorder_due"),
        (overstock, "overstock"),
        (proven, "proven"),
        (area_winners, "area_winner"),
        (new_hot, "new_hot"),
        (news_match, "news_match"),
        (social_trend, "social_trend"),
        # Plain "new" outranks bestseller so a recent addition keeps its NEW
        # tag (bestseller renders untagged, which would hide the recency).
        (new_arrivals, "new"),
        (bestsellers, "bestseller"),
        (trending, "trending"),
        (liquidate, "liquidate"),
        (signal_aligned, "signal_aligned"),
    ]

    seen: set[str] = set()
    candidates: list[Candidate] = []
    for items, label in ordered_slices:
        for p in items:
            if p.item.sku in seen:
                continue
            seen.add(p.item.sku)
            candidates.append(
                _to_candidate(p, label, price_tiers.get(p.item.sku, "mid"))
            )
            if len(candidates) >= top_n:
                return candidates
    return candidates
