"""Domain models for inventory intelligence.

`SkuStat` is the single, fully-resolved record per SKU that every deterministic
function operates on. The repository builds these from the warehouse (raw pull +
cost resolution + category canonicalization + size parsing); the functions are
PURE over a list of SkuStat, which makes them unit-testable without a database.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date


@dataclass
class SkuStat:
    sku: str
    product_name: str | None
    raw_category: str | None
    canonical_category: str
    size_ml: float | None        # parsed bottle/can volume in millilitres (None if unknown)
    pack_count: int              # units per pack (1 if single)

    on_hand: int                 # clamped to >= 0 for capital math
    on_hand_raw: int             # original stock_qty (may be negative)
    stock_flag: str | None       # e.g. "negative_clamped"

    cost: float | None           # best-available unit cost
    cost_source: str             # product | purchases | imputed | unknown
    price: float | None          # regular retail price
    sale_price: float | None

    units_30: int
    units_90: int
    units_365: int
    last_sale_date: date | None
    lines_90: int                # number of sale lines in last 90 days
    units_60: int = 0            # for the 60d analysis-window view

    # ---- derived (filled by enrich()) ----
    days_since_last_sale: int | None = None
    daily_velocity: float = 0.0          # units/day, robust estimate
    days_of_supply: float | None = None  # on_hand / daily_velocity (None = infinite)
    velocity_class: str = "unknown"      # fast | normal | slow | dead | never_sold
    brand: str | None = None             # canonical brand parsed from product_name
    is_premium: bool = False
    frozen_capital: float = 0.0          # on_hand * cost for non-moving stock
    margin_pct: float | None = None      # (price - cost) / price

    def value_at_cost(self) -> float:
        return self.on_hand * (self.cost or 0.0)

    def value_at_retail(self) -> float:
        return self.on_hand * (self.price or 0.0)


@dataclass
class InventoryDataset:
    """A store's full, resolved inventory snapshot plus the reference date."""
    client_id: int
    location_id: int
    as_of: date                  # reference 'today' = latest sale_date in the store
    skus: list[SkuStat] = field(default_factory=list)

    def in_stock(self) -> list[SkuStat]:
        return [s for s in self.skus if s.on_hand > 0]
