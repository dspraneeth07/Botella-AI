"""The assembled context passed from the context builder to the prompt builder."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import TYPE_CHECKING, Any

from app.schemas.derived import Candidate, HealthInfo, StoreSummary, VelocityInfo
from app.schemas.feedback import (
    CoPurchasePair,
    FeedbackDigest,
    LearnedEffectiveness,
    PastRecommendation,
)
from app.schemas.signals import SignalBundle
from app.schemas.store import SaleRecord, AreaWinner, StoreProfile, TrendProof

if TYPE_CHECKING:  # import-cycle guard: app.store_data imports this module
    from app.store_data.store_intel import StoreIntel


@dataclass(frozen=True, slots=True)
class ProductInfo:
    """What the POS knows about one stocked product, for writing a card about it.

    Name, size, and what it costs. Anything about how it SELLS belongs in the
    sales rows or the derived views, which are anchored to the data frontier - a
    rate copied in here would be a second answer to a question already answered.

    PRICE AND COST ARE HERE BECAUSE THE BUDGET NEEDS THEM, and because there was
    nowhere else honest to put them. `rank/portfolio.py` allocates a store's cash
    across the slate, which needs what the owner pays per unit and what they earn
    per unit, for EVERY stocked SKU - and the only other place carrying money per
    product is `candidates`, a shortlist that held 99 of store 171's 2,691 SKUs.
    Same shape of mistake the catalogue was created to fix, so it is fixed the
    same way: one map, built from the inventory rows the health view and the
    candidate view are also built from, so the three cannot disagree.
    """

    name: str
    size_ml: float | None = None
    #: Shelf price, or None when there is none. `InventoryItem.price` coerces a
    #: missing price to 0.0, and the builder turns that back into None here: a
    #: zero price is not a product given away, and a margin computed against one
    #: would be the entire cost reported as profit.
    unit_price: float | None = None
    #: What the store PAID. None, never zero, when the POS sends no cost: a cost
    #: of zero is a free product, and at 78 of 94 trading stores the POS sends
    #: nothing at all. Distinct from the health view's `tied_up_capital`, which is
    #: `on_hand x PRICE` - a retail valuation, not a cost.
    unit_cost: float | None = None
    #: The POS category AS THE TILL SENDS IT - "LOTTO", "TOBACCO", "VODKA 750" -
    #: not the canonical drink token. `compute_derived` rewrites
    #: `InventoryItem.category` to that token before anything downstream sees
    #: it, and only drink types survive the rewrite: a lottery line comes out as
    #: "uncategorized", which is why the live route's category screen never
    #: fired. This field is captured before the rewrite so the merchandise
    #: screen can read the one string that knows a scratchcard is not stock.
    pos_category: str | None = None


@dataclass(frozen=True, slots=True)
class LeadTime:
    """One SKU's delivery lead time, and WHERE THE NUMBER CAME FROM.

    Checklist 16. The reorder quantity rests on a lead time that was seven days
    declared in three places and measured in none, because nothing recorded
    when an order arrived. Node now carries `purchase_orders.received_date` and
    a per-vendor median in `supplier_lead_times` (migration 037); this is that
    row, resolved to the SKU the vendor supplies.

    `source` is the whole point. A measured four and a declared seven are both
    just integers once they reach the arithmetic, and a card must be able to
    say which it is standing on: "measured from 4 receipts between March and
    June" against "supplier default, declared, not measured". A `default` row
    still names the vendor, which is more than the engine knew before.
    """

    #: Calendar days from order to receipt. The median over the trailing year
    #: when measured; Node's declared default otherwise.
    days: float
    #: "measured" or "default". Nothing else is accepted from the feed.
    source: str
    #: How many receipts the figure rests on. 0 on a default row.
    observations: int
    #: The vendor's name as last seen on a document, for the sentence.
    vendor: str
    #: The normalised key the row is stored under, for joining and logging.
    vendor_key: str = ""
    #: The span of receipts a measured figure covers. None on a default row.
    measured_from: date | None = None
    measured_to: date | None = None

    @property
    def is_measured(self) -> bool:
        return self.source == "measured" and self.observations > 0


@dataclass(slots=True)
class RecommendationContext:
    store: StoreProfile
    signals: SignalBundle
    velocity: dict[str, VelocityInfo]
    inventory_health: list[HealthInfo]
    summary: StoreSummary
    candidates: list[Candidate]
    # The latest sale_date in the data; velocity windows are anchored here, not
    # to wall-clock, because the source DB can lag (Node anchors to MAX(sale_date)).
    data_as_of: date
    # Optional enrichments — None/empty until Node ships the endpoints.
    feedback: FeedbackDigest | None = None
    co_purchases: list[CoPurchasePair] = field(default_factory=list)
    area_winners: list[AreaWinner] = field(default_factory=list)
    # Register-measured validation of the social-trend terms (contract §1.7):
    # anonymized same-state aggregates separating hype from actual movement.
    trend_proof: list[TrendProof] = field(default_factory=list)
    # Node's register-measured proven/avoid SKU lists (§1.4 envelope); None
    # until Node ships them or while nothing qualifies.
    learned: LearnedEffectiveness | None = None
    # The bounded past-rec history the feedback digest was computed from, kept
    # here so the prompt's MEASURED TRACK RECORD section can read the per-rec
    # measured fields (action_taken / action_claim / verdict / lift).
    past_recommendations: list[PastRecommendation] = field(default_factory=list)
    # The raw per-(sku, day) sales the derived views were computed FROM.
    #
    # Retained because the deterministic engine needs daily granularity over a
    # year - it compares a 28-day window against the SKU's own long run - and
    # `velocity` carries only 7/30/90-day aggregates. Refetching inside the
    # selector would mean two reads of the same rows in one run.
    sales: list[SaleRecord] = field(default_factory=list)
    # Every SKU the store stocks, with the name and size the POS holds for it.
    #
    # The card families need a NAME to write a sentence with, and `candidates`
    # is the wrong place to get one: it is a shortlist sized by
    # candidate_pool_size, so on store 171 it held 99 of 2,691 SKUs and the
    # bundle family could never find a pair with both halves present. Same
    # mistake, same shape, as the one the stock path already fixed by taking
    # `orderable` from inventory rather than from candidates.
    #
    # Carried as a plain map rather than the InventoryItem rows because the
    # name and the size are the only fields anything downstream reads, and a
    # map cannot drift from the collection it was derived from.
    catalogue: dict[str, ProductInfo] = field(default_factory=dict)
    # One-number rule: {sku: (order_qty, coverage_days)} from the shared demand
    # engine — EVERY sku the engine knows, zeros included, so the validator can
    # tell "engine says nothing to order" (qty 0 → a reorder is false urgency)
    # from "engine never saw this sku" (absent → no enforcement). Empty when
    # the warehouse bridge is unavailable.
    canonical_qty: dict[str, tuple[int, int]] = field(default_factory=dict)
    # Store-intelligence grounding (don't-buy list, lost sales, velocity
    # classes, market gaps) from the storeagent engines; None when the bridge
    # is unavailable. The validator and the prompt's MARKET GAP section read it.
    intel: StoreIntel | None = None
    # ── DECLARED, BECAUSE THIS CLASS HAS __slots__ ──────────────────────────
    #
    # These three were being ASSIGNED by the context builder without ever being
    # declared here, which `@dataclass(slots=True)` forbids outright:
    #
    #     AttributeError: 'RecommendationContext' object has no attribute
    #     'card_history_rows' and no __dict__ for setting new attributes
    #
    # Every fresh process 500-ed on every store. It went unnoticed because a
    # long-running uvicorn had already imported the module as it was BEFORE the
    # assignments were added, so the running service kept serving stale code and
    # the break only surfaced on the next restart. The tests never caught it
    # because they build a context directly rather than through the builder.
    #
    # N5.1 - the lifecycle feed, carried RAW. The selector turns it into
    # CardHistory, because the second half of each record (units sold since, over
    # how many OPEN days) is measured from `sales`, which it already holds.
    card_history_rows: list[Any] = field(default_factory=list)
    # Sheet 17 - the store's measured gate inputs, or None. Carried raw so the
    # card builder applies the SAME `serving_decision` rule the batch applied;
    # two implementations of one rule is how an estate ends up with two answers.
    gate_verdict: dict[str, Any] | None = None
    # Sheet 08 - the serialised calibration bundle, or None. Carried raw; the card
    # builder deserialises it, so one module owns the key shape.
    calibration_bundle: dict[str, Any] | None = None
    # N4.1 - the MEASURED effect of each external signal on each drink family.
    #
    # Empty is the normal state and not a gap: 499 of 504 cells refused on the
    # first estate-wide fit, and `cold_box`/`pre_stock` correctly produce nothing
    # without an effect whose interval excludes zero. Carried raw and turned into
    # `SignalEffect` objects by the pipeline, so the shape is owned in one place.
    signal_effects: list[Any] = field(default_factory=list)
    # Checklist 16 - per-SKU delivery lead time WITH PROVENANCE, keyed by SKU.
    #
    # Empty is the normal state and not a gap: a store that has uploaded no
    # invoices, or an estate that has not run migration 037, has no vendor
    # known for anything, and every quantity then rests on the declared default
    # exactly as before - the difference is that the card now SAYS so. A SKU
    # absent from this map keeps the default; a SKU present with a `default`
    # row names its vendor; a SKU with a `measured` row sizes against it.
    lead_times: dict[str, LeadTime] = field(default_factory=dict)
