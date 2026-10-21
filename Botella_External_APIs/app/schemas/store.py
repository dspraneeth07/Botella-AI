"""Raw data shapes returned by the Node backend.

These mirror the JSON contract documented in ``API_CONTRACT.md``. Extra fields
on the wire are ignored; missing optional fields fall back to defaults so a
sparsely-populated row never breaks the pipeline.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator

# Country values we'll geocode via the US Census geocoder (US-only).
_US_COUNTRIES = {"", "US", "USA", "UNITED STATES", "UNITED STATES OF AMERICA"}


class StoreProfile(BaseModel):
    """Store metadata used for geo-targeting signals and prompt context.

    The Node `clients` table provides a street address (not coordinates); the
    service geocodes ``oneline_address`` to populate ``latitude``/``longitude``
    when they aren't supplied directly.
    """

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    id: int
    name: str = "Unknown store"
    address: str | None = None
    city: str | None = None
    state: str | None = None
    country: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    dma_code: str | None = None
    zip_code: str | None = Field(
        default=None, validation_alias=AliasChoices("zip_code", "postal_code", "zip")
    )
    size_class: str = "medium"

    @property
    def has_geo(self) -> bool:
        return self.latitude is not None and self.longitude is not None

    @property
    def is_us(self) -> bool:
        return (self.country or "").strip().upper() in _US_COUNTRIES

    @property
    def oneline_address(self) -> str:
        """A single-line address suitable for geocoding, e.g.
        '251 Broadway, Saranac Lake, NY, 12983'."""
        parts = [self.address, self.city, self.state, self.zip_code]
        return ", ".join(p.strip() for p in parts if p and p.strip())


class InventoryItem(BaseModel):
    """One product with its on-hand quantity at a location."""

    model_config = ConfigDict(extra="ignore")

    sku: str
    product_name: str = ""
    category: str | None = None
    sub_category: str | None = None
    price: float = 0.0
    # Unit cost (what the store paid). Optional and None when Node doesn't send
    # it — kept distinct from 0.0 so "unknown cost" never looks like "free", and
    # so margin degrades gracefully (stays absent) until a real cost exists.
    cost: float | None = None
    #: Units on the shelf, or None when the POS sends no count. NOT 0 - see the
    #: validator. A zero is a measured empty shelf and an absence is not.
    on_hand: int | None = None
    created_at: datetime | None = None

    @field_validator("price", mode="before")
    @classmethod
    def _coerce_price(cls, v: Any) -> float:
        return float(v) if v is not None else 0.0

    @field_validator("cost", mode="before")
    @classmethod
    def _coerce_cost(cls, v: Any) -> float | None:
        # Preserve None / blank as "unknown"; coerce numeric strings otherwise.
        if v is None or (isinstance(v, str) and not v.strip()):
            return None
        return float(v)

    @field_validator("on_hand", mode="before")
    @classmethod
    def _coerce_on_hand(cls, v: Any) -> int | None:
        # int(float(...)): a decimal string from the POS ("2.0", keg partials)
        # must degrade to a whole-unit count, not fail the row.
        #
        # NONE SURVIVES. This returned 0 for a missing count, so an honest null
        # from Node became an empty shelf the moment it was parsed - and an empty
        # shelf is a buy signal. Unknown is not zero, and the engine already knows
        # what to do with unknown: it declines to claim cover.
        if v is None:
            return None
        try:
            return int(float(v))
        except (TypeError, ValueError):
            return None

    @field_validator("created_at", mode="before")
    @classmethod
    def _parse_created_at(cls, v: Any) -> Any:
        """Parse leniently, and never let one bad timestamp sink a run.

        The contract promises ISO, but a Postgres ``timestamptz`` rendered
        straight to text ("2026-08-06 09:52:55.394577+00") carries a bare
        two-digit offset that strict ISO parsing rejects. ``fromisoformat``
        accepts both that and the contract form. Anything still unreadable
        degrades to None rather than raising: this field is optional
        enrichment that only flags new arrivals, so losing it costs one
        candidate slice, exactly as Node already degrades when its first-seen
        lookup fails — it must not turn into a 500 for the whole store.
        """
        if not isinstance(v, str):
            return v
        text = v.strip()
        if not text:
            return None
        try:
            return datetime.fromisoformat(text)
        except ValueError:
            return None

    @field_validator("created_at", mode="after")
    @classmethod
    def _ensure_tz(cls, v: datetime | None) -> datetime | None:
        # Node sends ISO-with-Z, but a naive timestamp from any other caller
        # must not blow up the aware-datetime math in candidate selection.
        if v is not None and v.tzinfo is None:
            return v.replace(tzinfo=UTC)
        return v

    @property
    def margin_pct(self) -> float | None:
        """Gross margin %: (price - cost) / price * 100, or None when unknown."""
        if self.cost is None or self.price <= 0:
            return None
        return round((self.price - self.cost) / self.price * 100, 1)


class AreaWinner(BaseModel):
    """A new product performing well at OTHER stores in this store's area.

    Anonymized aggregate from Node's cross-store catalog tracking (contract
    §1.6): products are matched across stores by ``upc``; no contributing
    store is ever identified. ``carried``/``this_store_sku`` say whether THIS
    store already stocks it (then the SKU joins back to the candidate pool).
    """

    model_config = ConfigDict(extra="ignore")

    upc: str
    product_name: str = ""
    category: str | None = None
    store_count: int = 0
    same_city_stores: int = 0
    avg_weekly_units: float = 0.0
    days_since_first_seen: int | None = None
    carried: bool = False
    this_store_sku: str | None = None
    this_store_on_hand: int | None = None


class TrendProof(BaseModel):
    """Register-measured validation of one trending drink term (contract §1.7).

    Anonymized aggregates over same-state peer stores: how many sell products
    matching the term, at what weekly rate, and how many are accelerating this
    week. Velocity fields are None below Node's k-anonymity floor. ``upc``
    names the strongest peer seller's barcode so a NOT CARRIED trend can
    ground a measurable stock_new pick (the first-seen detector keys on it).
    """

    model_config = ConfigDict(extra="ignore")

    term: str
    stores_selling: int = 0
    avg_weekly_units: float | None = None
    accelerating_stores: int | None = None
    product_name: str | None = None
    upc: str | None = None
    carried: bool = False
    this_store_sku: str | None = None
    this_store_on_hand: int | None = None
    this_store_weekly_units: float | None = None


class InstagramTrend(BaseModel):
    """One tracked drink hashtag's velocity snapshot (contract §1.8).

    GLOBAL data (hashtag popularity is not per-store) served by the Node
    backend, whose cron polls Meta's Graph API daily. ``acceleration`` is the
    latest posts/hour over the term's own multi-day baseline — None until
    enough snapshots accrue to form one, so fresh deployments are observable
    but not rankable.
    """

    model_config = ConfigDict(extra="ignore")

    term: str
    # Word-bounded form of the concatenated hashtag ("espresso martini" for
    # #espressomartini) — what register validation and classification match.
    display_term: str | None = None
    hashtag_id: str | None = None
    posts_per_hour: float | None = None
    engagement: float | None = None
    baseline_posts_per_hour: float | None = None
    baseline_points: int = 0
    acceleration: float | None = None


class RegisterTrend(BaseModel):
    """One drink category accelerating at same-state peer registers
    (contract §1.9) — trend DISCOVERY from measured purchases, the inverse of
    §1.7's validation of externally discovered terms. Anonymized aggregates
    only; rows already sit above Node's k-anonymity floor.
    """

    model_config = ConfigDict(extra="ignore")

    term: str
    stores_selling: int = 0
    accelerating_stores: int = 0
    avg_weekly_units: float | None = None
    avg_growth: float | None = None
    product_name: str | None = None
    upc: str | None = None


class SaleRecord(BaseModel):
    """A single POS sales fact (one row per sku per day, aggregated upstream
    or raw — either works since we re-aggregate in Python)."""

    model_config = ConfigDict(extra="ignore")

    sku: str
    sale_date: date
    units: int = 0
    unit_price: float = 0.0

    @field_validator("units", mode="before")
    @classmethod
    def _coerce_units(cls, v: Any) -> int:
        # int(float(...)): decimal quantities from the POS degrade to whole
        # units instead of failing the sale row.
        try:
            return int(float(v)) if v is not None else 0
        except (TypeError, ValueError):
            return 0

    @field_validator("unit_price", mode="before")
    @classmethod
    def _coerce_unit_price(cls, v: Any) -> float:
        return float(v) if v is not None else 0.0
