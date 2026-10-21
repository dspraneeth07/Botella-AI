"""Store-data computations: velocity, inventory health, summary, candidates.

All computed in-memory from raw rows fetched via the Node API — nothing here
touches a database. ``compute_derived`` is the single entry point.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

from app.logging_config import get_logger
from app.pipeline.features.store import CalendarDay
from app.schemas.context import ProductInfo, RecommendationContext
from app.schemas.derived import Candidate, HealthInfo, StoreSummary, VelocityInfo
from app.schemas.feedback import (
    CoPurchasePair,
    FeedbackParams,
    LearnedEffectiveness,
    PastRecommendation,
)
from app.schemas.signals import SignalBundle
from app.schemas.store import AreaWinner, InventoryItem, SaleRecord, StoreProfile, TrendProof
from app.store_data.candidates import select_candidates
from app.store_data.canonical_demand import CanonicalDemandMap
from app.store_data.categorize import classify_from_name, normalize_category
from app.store_data.feedback import compute_feedback, prioritize_history
from app.store_data.inventory_health import compute_inventory_health
from app.store_data.store_intel import StoreIntel
from app.store_data.store_summary import compute_summary
from app.store_data.velocity import compute_velocity, open_days_between
from storeagent.canonical.size import SMALL_FORMAT_MAX_ML, parse_size_ml

log = get_logger(__name__)


def _resolve_categories(inventory: list[InventoryItem], classify: bool) -> None:
    """Rewrite each product's ``category`` to a canonical token, in place.

    Normalizes the supplied category first; falls back to classifying from the
    product name when it's empty/junk. Logs how each source contributed so a
    store with sparse categories is visible in the logs.
    """
    from_raw = from_name = uncategorized = 0
    for item in inventory:
        token = normalize_category(item.category)
        if token:
            from_raw += 1
        elif classify and (token := classify_from_name(item.product_name)):
            from_name += 1
        else:
            token = "uncategorized"
            uncategorized += 1
        item.category = token

    log.info(
        "categories_resolved",
        total=len(inventory),
        from_raw=from_raw,
        from_name=from_name,
        uncategorized=uncategorized,
    )


def compute_derived(
    *,
    store: StoreProfile,
    signals: SignalBundle,
    inventory: list[InventoryItem],
    sales: list[SaleRecord],
    now: datetime,
    candidate_pool_size: int,
    small_format_max_ml: float = SMALL_FORMAT_MAX_ML,
    classify_uncategorized: bool = True,
    past_recommendations: list[PastRecommendation] | None = None,
    learned: LearnedEffectiveness | None = None,
    co_purchases: list[CoPurchasePair] | None = None,
    area_winners: list[AreaWinner] | None = None,
    trend_proof: list[TrendProof] | None = None,
    feedback_window_days: int = 30,
    feedback_params: FeedbackParams | None = None,
    canonical: CanonicalDemandMap | None = None,
    intel: StoreIntel | None = None,
    calendar: Sequence[CalendarDay] | None = None,
) -> RecommendationContext:
    # The raw POS category, taken BEFORE `_resolve_categories` rewrites it in
    # place. The canonical token that replaces it keeps drink types only, so
    # "LOTTO" and "SCRATCH OFF" leave the rewrite as "uncategorized" and the
    # merchandise screen can no longer tell them from a bottle.
    pos_category_by_sku = {
        item.sku: item.category.strip()
        for item in inventory
        if item.sku and item.category and item.category.strip()
    }
    _resolve_categories(inventory, classify_uncategorized)
    category_by_sku = {item.sku: (item.category or "uncategorized") for item in inventory}

    # Anchor the velocity windows to the data's frontier (latest sale_date),
    # not wall-clock. The source DB can lag; if we anchored to "now" the recent
    # buckets would silently lose days and every SKU would look like it's
    # trending down. Fall back to wall-clock when there are no sales at all.
    data_as_of = max((s.sale_date for s in sales), default=now.date())
    as_of = datetime(data_as_of.year, data_as_of.month, data_as_of.day, tzinfo=UTC)

    # THE seam for sheet 03's one denominator.
    #
    # Python is stateless and holds no analytics credentials, so it cannot read
    # `feature_store_day` itself - Node owns that database and serves the
    # calendar in the payload. Absent, every rate below falls back to calendar
    # days, which is what this module did before and is still a defensible
    # answer; present, the rates divide by days the store actually traded.
    velocity: dict[str, VelocityInfo] = compute_velocity(
        sales, category_by_sku, as_of, calendar
    )
    open_days_30d = open_days_between(calendar, data_as_of - timedelta(days=30),
                                      data_as_of)
    health: list[HealthInfo] = compute_inventory_health(
        inventory, velocity, canonical, open_days_30d
    )
    summary: StoreSummary = compute_summary(inventory, sales, velocity, health)

    # Feedback first: scored past recs (realized lift + thumbs) feed candidate
    # selection. Inert (None) until Node serves the recommendation-history feed.
    feedback = compute_feedback(
        past_recommendations or [],
        sales,
        data_as_of=data_as_of,
        window_days=feedback_window_days,
        params=feedback_params,
    )

    # Carried area winners join the candidate pool by THIS store's sku so the
    # model can act on them (promote/reorder); not-carried ones have no local
    # sku and are surfaced through the prompt's AREA WINNERS section instead.
    area_winner_skus = {
        w.this_store_sku for w in (area_winners or []) if w.carried and w.this_store_sku
    }

    # Register-measured proven SKUs (Node's learned lists) join the feedback
    # winners in the "proven" candidate boost — both mean "recommended here
    # before and it converted", the learned list just carries longer-window,
    # action-aware evidence.
    proven_skus = set(feedback.winner_skus) if feedback else set()
    if learned is not None:
        proven_skus |= {entry.sku for entry in learned.proven}

    # Week-ahead notice: SKUs whose order-by date falls within the next 7 days
    # get their own candidate slice, most urgent first — the owner hears about
    # a needed order BEFORE the stockout window, not after. Ranked by order_by
    # (ties: bigger order first) so the slice cap keeps the most pressing.
    order_due_ranked: list[str] = []
    if canonical is not None:
        due_horizon = (now.date() + timedelta(days=7)).isoformat()
        order_due_ranked = [
            cd.sku
            for cd in sorted(
                (
                    cd for cd in canonical.by_sku.values()
                    if cd.order_qty > 0 and cd.order_by is not None
                    and cd.order_by <= due_horizon
                ),
                key=lambda cd: (cd.order_by, -cd.order_qty),
            )
        ]

    # New-arrivals recency is genuinely about real time, so candidates use `now`.
    candidates: list[Candidate] = select_candidates(
        inventory, velocity, health, signals, now=now, top_n=candidate_pool_size,
        proven_skus=proven_skus or None,
        area_winner_skus=area_winner_skus,
        order_due_ranked=order_due_ranked or None,
        intel=intel,
        small_format_max_ml=small_format_max_ml,
    )

    # Stamp each candidate with the canonical reorder figures (the exact
    # numbers the Store Intelligence Buying tab prints). The prompt renders
    # them as ground truth and the validator enforces the quantity hint
    # against them — the one-number rule for reorders.
    if canonical is not None:
        stamped = 0
        for c in candidates:
            cd = canonical.by_sku.get(c.sku)
            if cd is not None and cd.order_qty > 0:
                c.suggested_order_qty = cd.order_qty
                c.order_by = cd.order_by
                c.run_out = cd.run_out
                c.coverage_days = cd.coverage_days
                stamped += 1
        log.info(
            "canonical_demand_applied",
            skus=len(canonical.by_sku),
            candidates_with_order_qty=stamped,
            order_due_within_week=len(order_due_ranked),
            engine_as_of=canonical.as_of.isoformat(),
        )

    # Stamp each candidate with the store-intelligence facts (the exact
    # classifications and measured figures the Store Intelligence tabs print):
    # velocity class + recency, don't-buy membership, lost-sale bleed. The
    # prompt renders them as tags and the validator enforces them — same
    # one-number rule as the reorder figures above.
    if intel is not None:
        tagged_dont_buy = tagged_lost = 0
        for c in candidates:
            si = intel.sku_intel.get(c.sku)
            if si is not None:
                c.si_class = si.velocity_class
                c.days_since_last_sale = si.days_since_last_sale
            if c.sku in intel.dont_buy:
                c.dont_buy = True
                tagged_dont_buy += 1
            ls = intel.lost_sales.get(c.sku)
            if ls is not None:
                c.lost_days_out = ls.days_out
                c.lost_revenue = ls.lost_revenue
                tagged_lost += 1
        log.info(
            "store_intel_applied",
            dont_buy_skus=len(intel.dont_buy),
            lost_sale_skus=len(intel.lost_sales),
            classed_skus=len(intel.sku_intel),
            market_gaps=len(intel.market_gaps),
            candidates_dont_buy=tagged_dont_buy,
            candidates_lost_sale=tagged_lost,
            engine_as_of=intel.as_of.isoformat(),
        )

    return RecommendationContext(
        store=store,
        signals=signals,
        velocity=velocity,
        inventory_health=health,
        summary=summary,
        candidates=candidates,
        data_as_of=data_as_of,
        canonical_qty=(
            {sku: (cd.order_qty, cd.coverage_days) for sku, cd in canonical.by_sku.items()}
            if canonical is not None
            else {}
        ),
        feedback=feedback,
        co_purchases=list(co_purchases or []),
        area_winners=list(area_winners or []),
        trend_proof=list(trend_proof or []),
        learned=learned if learned is not None and not learned.is_empty() else None,
        past_recommendations=list(past_recommendations or []),
        intel=intel,
        # Names for every stocked SKU, not just the shortlisted ones - see
        # RecommendationContext.catalogue on why the shortlist was the wrong
        # source. Built from the same `inventory` rows the health view and the
        # candidate selection are built from, so the three cannot disagree
        # about what the store carries.
        catalogue={
            item.sku: ProductInfo(
                name=item.product_name or item.sku,
                # Parsed from the name, which is the only size evidence the
                # POS gives us - the same call and the same single source the
                # candidate view uses, so a 1.75L handle is recognised as
                # unchillable identically in both places.
                size_ml=parse_size_ml(item.product_name, None, None),
                # The money, for the slate's cash budget. Straight off the same
                # row, uncoerced: `price` is already 0.0-for-absent and `cost` is
                # already None-for-absent, and re-deriving either here would be a
                # second answer to a question the schema already settled.
                unit_price=(item.price if item.price > 0 else None),
                unit_cost=item.cost,
                pos_category=pos_category_by_sku.get(item.sku),
            )
            for item in inventory
            if item.sku
        },
    )


__all__ = ["compute_derived", "compute_feedback", "prioritize_history", "select_candidates"]
