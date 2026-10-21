"""Canonical demand bridge: one demand engine for every reorder number.

The storeagent stack's shelf-age-corrected, weekday-seasonal forecast
(``storeagent/forecasting/demand.py``) and its reorder formula
(``storeagent/functions/buying.py::order_quantity``) are the single source of
truth for "how fast does this sell" and, FOR THE BUYING TAB, "how much should
I buy". This module lets the recommendation pipeline pull those exact figures -
same code, same warehouse data, same (client, location) scope.

NO LONGER THE CARD'S QUANTITY. It said "so an AI recommendation can never quote
a different quantity than the Store Intelligence Buying tab", and that has
stopped being true on purpose: cards are sized by
`app/pipeline/policy/inventory.py` from the ensemble's p10/p50/p90, because the
tab's formula scales a POINT forecast by a flat buffer and a buffer is a
statement about dispersion. What this map still supplies to the pipeline is the
FALLBACK - used where the policy refuses, for an unknown shelf count or a SKU
with no forecastable history - and the coverage window the card's sentence
quotes. See `app/recommender/quantity.py`.

Both stacks run in one process, so this is a direct module call through the
shared TTL result cache: a Buying-tab compute publishes its demand pull into
the same key this bridge reads (see ``run_buying``), so a rec run within the
TTL reuses that exact snapshot instead of re-querying the warehouse — one
pull, one set of numbers. (The tab itself always pulls fresh: its nocache
refresh contract requires it.) Everything degrades softly: no warehouse
configured, a query error, or a store with no sales all yield ``None``, and
the pipeline falls back to its legacy Node-feed math rather than failing the
run.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import date, timedelta

from app.logging_config import get_logger

log = get_logger(__name__)

# Cache namespace inside storeagent's shared result cache. run_buying
# publishes its (fresh) demand pull under this same key, so a rec run within
# the TTL reuses the Buying tab's snapshot instead of re-querying.
_CACHE_KEY = "canonical_demand"


@dataclass(frozen=True)
class CanonicalSkuDemand:
    """The engine's per-SKU numbers, in the units the UI speaks.

    Display figures are the TRENDED forward pace — the same pace the order
    quantity is sized on — so one card never says "sells 28 a week" (a stale
    90-day average) beside an order sized for the current ~8. For a
    steady seller (trend ~1) they equal the plain averages.
    """

    sku: str
    weekly_rate: float            # projected pace x 7 (trend included) — what
                                  # it is expected to sell per week RIGHT NOW
    weeks_on_hand: float | None   # cover at that projected pace, None when dead
    order_qty: int                # canonical reorder size; 0 = nothing to order
    coverage_days: int            # lead time + supplier cadence the qty covers
    order_by: str | None          # ISO date to place the order by (projected
                                  # stock-out minus lead, clamped to today —
                                  # never a past date)
    run_out: str | None           # ISO date stock hits zero at the projected pace
    stockout_risk: bool           # cover shorter than the coverage window
    trend_factor: float
    supplier: str | None


@dataclass(frozen=True)
class CanonicalDemandMap:
    as_of: date
    by_sku: dict[str, CanonicalSkuDemand]


async def fetch_canonical_demand(
    client_id: int, location_id: int
) -> CanonicalDemandMap | None:
    """Fetch the canonical per-SKU demand map, or ``None`` when unavailable.

    Runs the (synchronous, psycopg-based) storeagent pull in a worker thread so
    the async pipeline never blocks on the warehouse.
    """
    try:
        return await asyncio.to_thread(_fetch_sync, client_id, location_id)
    except Exception as exc:  # noqa: BLE001 — any failure degrades, never sinks a run
        log.warning(
            "canonical_demand_unavailable",
            client_id=client_id,
            location_id=location_id,
            error=str(exc),
        )
        return None


def _fetch_sync(client_id: int, location_id: int) -> CanonicalDemandMap | None:
    # Imported lazily: the storeagent stack (and its DB driver) stays optional
    # for deployments that run the recommender without a warehouse connection.
    from storeagent.runtime import result_cache
    from storeagent.source.connector import source_db
    from storeagent.source.forecast_repo import fetch_sku_demand

    def _pull() -> tuple[date | None, list]:
        with source_db("120s") as db:
            return fetch_sku_demand(db, client_id, location_id)

    as_of, demands = result_cache.get_or_compute(
        (_CACHE_KEY, client_id, location_id), _pull
    )
    if as_of is None:
        return None
    return _build_map(as_of, demands)


def _build_map(as_of: date, demands: list,
               today: date | None = None) -> CanonicalDemandMap:
    """Pure mapping from SkuDemand rows to the bridge shape (unit-testable).

    ``today`` clamps order-by dates to wall-clock (tests pin it) — the same
    rule as the Buying tab's ``_buy_row``: an order-by is an instruction to a
    human, so a lagging data frontier must read "order today", never a date
    in the past.
    """
    from storeagent.config import FORECAST
    from storeagent.functions.buying import order_quantity

    today = today or date.today()
    by_sku: dict[str, CanonicalSkuDemand] = {}
    for d in demands:
        qty, coverage = order_quantity(d, FORECAST)
        # Everything displayed runs at the PROJECTED pace (trend included) —
        # the pace the order quantity itself is sized on. Store 171's Ironroot
        # showed "sells 28/week" (stale 90d average) beside an order sized for
        # its collapsed ~8/week; one pace per card, and it's the forward one.
        dos_t = d.days_of_supply_at_trend(FORECAST)
        run_out = (as_of + timedelta(days=int(dos_t))).isoformat() if dos_t is not None else None
        order_by = None
        if qty > 0:
            # Same date the Buying tab prints: projected stock-out day minus
            # delivery lead, clamped to today.
            order_by_in = max(0, int(dos_t - FORECAST.lead_time_days)) if dos_t is not None else 0
            order_by = max(as_of + timedelta(days=order_by_in), today).isoformat()
        by_sku[d.sku] = CanonicalSkuDemand(
            sku=d.sku,
            weekly_rate=round(d.projected_daily(FORECAST) * 7, 2),
            weeks_on_hand=round(dos_t / 7, 1) if dos_t is not None else None,
            order_qty=qty,
            coverage_days=coverage,
            order_by=order_by,
            run_out=run_out,
            stockout_risk=dos_t is not None and dos_t < coverage,
            trend_factor=round(d.trend_factor(FORECAST), 2),
            supplier=d.supplier_name,
        )
    return CanonicalDemandMap(as_of=as_of, by_sku=by_sku)
