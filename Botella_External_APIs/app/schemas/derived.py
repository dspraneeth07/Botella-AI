"""In-memory artifacts computed from raw store data.

None of these are persisted by this service; they live for the duration of a
single request and feed candidate selection + the LLM prompt.
"""

from __future__ import annotations

from pydantic import BaseModel

VelocityBucket = str  # one of: very_low | low | medium | high | very_high
Trend = str  # one of: falling | stable | rising
HealthStatus = str  # stockout | understock | healthy | overstock_mild | overstock_severe


class VelocityInfo(BaseModel):
    sku: str
    category: str
    units_7d: int
    units_30d: int
    units_90d: int
    velocity_score: float
    velocity_bucket: VelocityBucket
    trend: Trend


class HealthInfo(BaseModel):
    sku: str
    category: str
    #: None when the POS sends no count. Not 0 - an empty shelf is a buy signal
    #: and an unknown one must not be mistaken for it.
    on_hand: int | None
    weekly_rate: float
    weeks_on_hand: float | None
    tied_up_capital: float | None
    status: HealthStatus


class StoreSummary(BaseModel):
    category_revenue_pct: dict[str, float] = {}
    # Units-weighted gross margin % per category (only categories with cost data;
    # empty when Node sends no cost). Lets the model push profitable categories.
    category_margin_pct: dict[str, float] = {}
    top_movers_30d: list[str] = []
    recent_winners: list[str] = []
    recent_losers: list[str] = []
    slow_movers_with_stock: list[dict] = []


class Candidate(BaseModel):
    """One eligible product the LLM may recommend, plus the metadata it reasons
    over. The ``slice`` field records which selection slice surfaced it."""

    sku: str
    product_name: str
    category: str | None = None
    sub_category: str | None = None
    price: float = 0.0
    # Price position WITHIN the product's own category at this store
    # (value | mid | premium, by percentile). This — not the raw dollar
    # figure — is what the prompt's pricing language is allowed to lean on:
    # a $20 wine is mid-tier for wine, never "high value" on dollars alone.
    price_tier: str = "mid"
    # Gross margin %, or None when the product carries no cost data.
    margin_pct: float | None = None
    #: None when the POS sends no count - distinct from a measured 0.
    on_hand: int | None = 0
    velocity_bucket: VelocityBucket = "very_low"
    trend: Trend = "stable"
    weeks_on_hand: float | None = None
    health_status: HealthStatus = "healthy"
    # Units/week. Canonical (shelf-age-corrected 90d pace from the shared
    # demand engine) when the warehouse bridge is available; otherwise the
    # legacy 30d flat average from the Node sales feed.
    weekly_rate: float = 0.0
    # Bottle volume parsed from the product name (None = unknown, treated as
    # full-size). <= 100ml is "small format" (a nip): rendered with a NIP tag
    # and rationed to one rec per run so minis never crowd out real bottles.
    size_ml: float | None = None
    slice: str = "bestseller"
    # Canonical reorder figures from the shared demand engine (the same
    # ``order_quantity`` the Store Intelligence Buying tab prints). None when
    # the bridge is unavailable; 0 order-qty rows keep None here so the prompt
    # renders an order figure only when there is genuinely something to order.
    # order_by is clamped to wall-clock today (never a past date); run_out is
    # when current stock hits zero at the current pace.
    suggested_order_qty: int | None = None
    order_by: str | None = None
    run_out: str | None = None
    coverage_days: int | None = None
    # Store-intelligence grounding (see app/store_data/store_intel.py). All
    # None/False when the bridge is unavailable.
    # The Inventory tab's velocity class (fast|normal|slow|dead|never_sold)
    # and recency — what grounds markdown/liquidate in the tab's own numbers.
    si_class: str | None = None
    days_since_last_sale: int | None = None
    # On the Buying tab's don't-buy list (dead, or fading with months of
    # supply): rendered as a DONT_BUY tag; the validator suppresses
    # reorder/pre_stock on it.
    dont_buy: bool = False
    # Measured stockout bleed from the Buying tab's lost-sales view: days out
    # of stock and dollars already missed. Rendered as a LOST_SALE tag.
    lost_days_out: int | None = None
    lost_revenue: float | None = None
