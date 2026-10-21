"""Store-intelligence bridge: ground recommendations in the storeagent engines.

Extends the canonical-demand bridge (one demand engine for every reorder
number — see ``canonical_demand.py``) to the rest of Store Intelligence:

* the Buying tab's **don't-buy list** (dead or fading SKUs the engine says to
  stop ordering) — the validator suppresses reorder/pre_stock picks on them;
* the Buying tab's **lost-sales** items (proven movers currently stocked out,
  with measured dollars bleeding) — the strongest reorder evidence there is,
  surfaced as their own candidate slice;
* the Inventory tab's **velocity classes** (fast/normal/slow/dead/never_sold)
  and premium flags — so markdown/liquidate picks are justified by the same
  classification the tab prints, and premium dead bottles are featured, not
  discounted;
* the Market tab's **assortment gaps** (peer-proven products this store does
  not carry) — evidence for stock_new picks with real register data behind
  them.

Both stacks run in one process, so each piece is a direct module call through
storeagent's shared TTL result cache: the demand pull rides the SAME cache key
the canonical bridge and the Buying tab use (one pull, one set of numbers),
and the market pull rides the Market tab's own key, so a tab compute within
the TTL is reused rather than re-queried.

Scope note: the market engine is CLIENT-wide by design (statewide peer
comparison against the whole client catalog — see
``storeagent/source/market_repo.py``); for a single-location client that
equals the store. Everything else here is (client, location)-scoped exactly
like the demand pull.

Everything degrades softly, at two levels: the whole fetch returns ``None``
when the warehouse is unreachable (the pipeline then behaves exactly as if
the bridge didn't exist), and each engine piece also fails independently, so
a market timeout still leaves the don't-buy and lost-sales grounding intact.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import date

from app.logging_config import get_logger
from app.store_data.canonical_demand import _CACHE_KEY as _DEMAND_CACHE_KEY

log = get_logger(__name__)

# Cache key for the enriched inventory dataset (velocity classes). Ours alone:
# the Inventory tab caches its full rendered payload under ("inventory", ...),
# which caps per-class item lists — the classifier map here must be complete.
_INVENTORY_CACHE_KEY = "rec_inventory_intel"

# SI velocity classes that justify a price cut (markdown/liquidate): the same
# membership the Inventory tab's slow/dead/never-sold views print.
STAGNANT_CLASSES = frozenset({"slow", "dead", "never_sold"})


@dataclass(frozen=True)
class DontBuySku:
    """One SKU from the Buying tab's don't-buy list: dead (no sale in months /
    never sold) or fading with months of supply on hand. ``reason`` is the
    engine's owner-facing prose, kept for logs and future surfacing."""

    sku: str
    reason: str
    days_since_sold: int | None
    days_of_supply: float | None


@dataclass(frozen=True)
class LostSaleSku:
    """One measured stockout bleed from the Buying tab's lost-sales view: a
    proven mover with nothing on the shelf, out ``days_out`` days at
    ``daily_rate`` units/day — ``lost_revenue`` dollars already missed and
    ``ongoing_daily_loss`` more bleeding every day it stays out."""

    sku: str
    days_out: int
    daily_rate: float
    lost_units: float
    lost_revenue: float
    ongoing_daily_loss: float


@dataclass(frozen=True)
class SkuIntel:
    """The Inventory tab's per-SKU classification: velocity class
    (fast | normal | slow | dead | never_sold), recency, and whether the
    bottle is premium (premium dead stock is a HOLD — feature it, never
    liquidate it — per the tab's own suggested action)."""

    velocity_class: str
    days_since_last_sale: int | None
    premium: bool


@dataclass(frozen=True)
class MarketGap:
    """One Market-tab assortment opportunity: a product this store does NOT
    carry that peer stores statewide sell steadily (anonymized aggregates).
    The UPC is what Node's effectiveness evaluator later uses to detect that
    the store started carrying it (same contract as area winners)."""

    upc: str
    product_name: str
    category: str | None
    peer_units: int
    peer_stores: int
    avg_price: float | None
    est_annual_revenue: float | None


@dataclass(frozen=True)
class StoreIntel:
    as_of: date
    # sku -> engine facts. lost_sales preserves the engine's ranking (worst
    # bleed first) — dict insertion order carries it.
    dont_buy: dict[str, DontBuySku] = field(default_factory=dict)
    lost_sales: dict[str, LostSaleSku] = field(default_factory=dict)
    sku_intel: dict[str, SkuIntel] = field(default_factory=dict)
    market_gaps: list[MarketGap] = field(default_factory=list)


async def fetch_store_intel(
    client_id: int, location_id: int, *, market_gap_max: int = 6
) -> StoreIntel | None:
    """Fetch the store-intelligence grounding, or ``None`` when unavailable.

    Runs the (synchronous, psycopg-based) storeagent pulls in a worker thread
    so the async pipeline never blocks on the warehouse.
    """
    try:
        return await asyncio.to_thread(
            _fetch_sync, client_id, location_id, market_gap_max
        )
    except Exception as exc:  # noqa: BLE001 — any failure degrades, never sinks a run
        log.warning(
            "store_intel_unavailable",
            client_id=client_id,
            location_id=location_id,
            error=str(exc),
        )
        return None


def _fetch_sync(
    client_id: int, location_id: int, market_gap_max: int
) -> StoreIntel | None:
    # Imported lazily, like canonical_demand: the storeagent stack (and its DB
    # driver) stays optional for deployments without a warehouse connection.
    from storeagent.runtime import result_cache
    from storeagent.source.connector import source_db
    from storeagent.source.forecast_repo import fetch_sku_demand

    def _pull() -> tuple[date | None, list]:
        with source_db("120s") as db:
            return fetch_sku_demand(db, client_id, location_id)

    # The SAME key the canonical bridge reads and run_buying publishes: within
    # the TTL, this run's demand pull is shared with the reorder-quantity
    # bridge and the Buying tab — one pull, one set of numbers.
    as_of, demands = result_cache.get_or_compute(
        (_DEMAND_CACHE_KEY, client_id, location_id), _pull
    )
    if as_of is None:
        return None

    return StoreIntel(
        as_of=as_of,
        dont_buy=_dont_buy_map(demands, as_of),
        lost_sales=_lost_sales_map(demands, as_of),
        sku_intel=_sku_intel_map(client_id, location_id),
        market_gaps=_market_gap_list(client_id, location_id, market_gap_max),
    )


def _dont_buy_map(demands: list, as_of: date) -> dict[str, DontBuySku]:
    """Don't-buy SKUs via the Buying engine itself (never a re-derivation),
    so a suppressed reorder is suppressed by the exact list the tab prints."""
    try:
        from storeagent.functions.buying import buy_recommendations

        buying = buy_recommendations(demands, as_of)
        return {
            row["sku"]: DontBuySku(
                sku=row["sku"],
                reason=row["reason"],
                days_since_sold=row.get("days_since_sold"),
                days_of_supply=row.get("days_of_supply"),
            )
            for row in buying["dont_buy_list"]
        }
    except Exception as exc:  # noqa: BLE001
        log.warning("store_intel_piece_failed", piece="dont_buy", error=str(exc))
        return {}


def _lost_sales_map(demands: list, as_of: date) -> dict[str, LostSaleSku]:
    try:
        from storeagent.functions.lost_sales import lost_sales

        ls = lost_sales(demands, as_of)
        return {
            row["sku"]: LostSaleSku(
                sku=row["sku"],
                days_out=row["days_out"],
                daily_rate=row["daily_rate"],
                lost_units=row["lost_units"],
                lost_revenue=row["lost_revenue"],
                ongoing_daily_loss=row["ongoing_daily_loss"],
            )
            for row in ls["items"]
        }
    except Exception as exc:  # noqa: BLE001
        log.warning("store_intel_piece_failed", piece="lost_sales", error=str(exc))
        return {}


def _sku_intel_map(client_id: int, location_id: int) -> dict[str, SkuIntel]:
    try:
        from storeagent.functions import inventory as inv
        from storeagent.runtime import result_cache
        from storeagent.source.connector import source_db
        from storeagent.source.inventory_repo import build_inventory_dataset

        def _pull():
            with source_db("120s") as db:
                return inv.enrich(build_inventory_dataset(db, client_id, location_id))

        dataset = result_cache.get_or_compute(
            (_INVENTORY_CACHE_KEY, client_id, location_id), _pull
        )
        return {
            s.sku: SkuIntel(
                velocity_class=s.velocity_class,
                days_since_last_sale=s.days_since_last_sale,
                premium=s.is_premium,
            )
            for s in dataset.skus
        }
    except Exception as exc:  # noqa: BLE001
        log.warning("store_intel_piece_failed", piece="sku_intel", error=str(exc))
        return {}


def _market_gap_list(
    client_id: int, location_id: int, cap: int
) -> list[MarketGap]:
    if cap <= 0:
        return []
    try:
        from storeagent.runtime import result_cache
        from storeagent.runtime.pipeline import run_market

        # The Market tab's own cache key (capability, store, location,
        # narrate): a tab compute within the TTL is reused, and ours seeds the
        # tab in turn. The peer fan-out is the priciest pull in this module,
        # which is exactly why it rides the shared slot.
        payload = result_cache.get_or_compute(
            ("market", client_id, location_id, False),
            lambda: run_market(client_id, location_id),
        )
        market = (payload or {}).get("market") or {}
        if not market.get("available"):
            return []
        gaps: list[MarketGap] = []
        for row in market.get("opportunities") or []:
            if not row.get("upc") or not row.get("product_name"):
                continue
            gaps.append(
                MarketGap(
                    upc=row["upc"],
                    product_name=row["product_name"],
                    category=row.get("category"),
                    peer_units=int(row.get("peer_units") or 0),
                    peer_stores=int(row.get("peer_stores") or 0),
                    avg_price=row.get("avg_price"),
                    est_annual_revenue=row.get("est_annual_revenue"),
                )
            )
            if len(gaps) >= cap:
                break
        return gaps
    except Exception as exc:  # noqa: BLE001
        log.warning("store_intel_piece_failed", piece="market_gaps", error=str(exc))
        return []
