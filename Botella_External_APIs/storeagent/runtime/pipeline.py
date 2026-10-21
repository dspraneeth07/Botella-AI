"""Orchestrate the Inventory Intelligence run for one store."""
from __future__ import annotations

import contextvars  # TESTING-ONLY: SQL debug (context propagation into worker threads)
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from ..forecasting.backtest import backtest_daily
from ..functions import inventory as inv
from ..functions.basket import basket_affinity
from ..functions.buying import buy_recommendations
from ..functions.customers import customer_radar, engagement_profile
from ..functions.loss import loss_signals
from ..functions.lost_sales import lost_sales
from ..functions.margin import money_leaks
from ..functions.market import market_intelligence
from ..functions import no_sales
from ..functions.overview import overview as overview_fn
from ..functions.pricing import price_optimizer
from ..functions.shrinkage import shrinkage_report
from ..source.connector import source_db
from ..source.basket_repo import fetch_basket_data
from ..source.loss_repo import fetch_loss_data
from ..source.market_repo import fetch_market_data
from ..source.customer_repo import (fetch_customer_book_counts, fetch_customer_rows,
                                    fetch_engagement_context,
                                    fetch_favorite_categories, store_as_of)
from ..source.forecast_repo import fetch_sku_demand, fetch_store_daily
from ..source.inventory_repo import build_inventory_dataset
from ..source.margin_repo import fetch_margin_rows
from ..source.overview_repo import fetch_overview
from ..source.shrinkage_repo import fetch_shrinkage_data
from . import result_cache
from .digest import (build_briefing, build_basket_briefing, build_buying_briefing,
                     build_customer_briefing, build_loss_briefing, build_market_briefing,
                     build_overview_briefing, build_pricing_briefing,
                     build_shrinkage_briefing)


def _parallel(*jobs):
    """Run independent warehouse pulls concurrently, each opening its OWN
    connection (SourceDB is not thread-safe). Returns results in submission
    order; re-raises the first failure."""
    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        # copy_context(): TESTING-ONLY: SQL debug — carries the per-request SQL
        # capture into worker threads. Harmless otherwise; one copy per job
        # because a single Context can't be entered by two threads at once.
        futures = [pool.submit(contextvars.copy_context().run, j) for j in jobs]
        return [f.result() for f in futures]


def _usable(payload: dict | None, section: str) -> dict | None:
    """A capability section that actually holds figures, or None.

    Three different absences read identically to a consumer and used to crash
    in three different ways:

        the engine RAISED        `_safe` returns None for the whole payload
        the engine REFUSED       the payload is a dict, and the section is
                                 {"available": False, "reason": ...} - truthy,
                                 so `if payload:` passes and the first real
                                 key read is a KeyError
        the section is ABSENT    the key is missing or None, so `.get` on it
                                 is an AttributeError

    All three mean the same thing - there is nothing here to report - and none
    of them is an error. One reader, so a new absence cannot reintroduce the
    third variant of the same crash.
    """
    if not payload:
        return None
    value = payload.get(section)
    if not isinstance(value, dict) or value.get("available") is False:
        return None
    return value


def _attach_narration(result: dict, capability: str, narrate: bool) -> None:
    """Optionally add a Claude-narrated summary over the deterministic numbers."""
    if not narrate:
        return
    from ..narration import narrate_capability  # lazy: only when asked
    result["narration"] = narrate_capability(capability, result)


#: The sections run_store normally returns. A refusal has to carry every one
#: of them, because the frontend hides the view only when NOTHING it needs is
#: present - leave one out and it draws that part's headings over nothing.
_INVENTORY_SECTIONS = ("velocity_classes", "dead_stock", "frozen_capital",
                       "slow_but_premium", "brand_concentration", "money_leaks")


def _no_sales_inventory(client_id: int, location_id: int, label: str,
                        window_days: int | None, narrate: bool) -> dict:
    """Inventory Intelligence for a store whose feed has sent no sales.

    Shaped exactly like a real result, with every section refusing and saying
    why, so the screen reads as an answer rather than an error. Narration is
    deliberately skipped: there is nothing to narrate, and asking the model to
    describe an absence spends a call to be told so.
    """
    return {
        "capability": "inventory",
        "client_id": client_id,
        "location_id": location_id,
        "store_label": label,
        "window_days": window_days,
        "as_of": None,
        "generated_at": datetime.now().isoformat(),
        **{name: no_sales.unavailable() for name in _INVENTORY_SECTIONS},
        "briefing": (f" INVENTORY INTELLIGENCE - Store {label}\n\n"
                     f" {no_sales.NO_SALES_REASON}. Nothing can be measured "
                     f"until the point-of-sale feed sends sales for this "
                     f"store."),
    }


def run_store(client_id: int, location_id: int, persist: bool = False,
              store_label: str | None = None, narrate: bool = False,
              window_days: int | None = None) -> dict:
    """window_days (30/60/90) re-runs the whole analysis over that lookback:
    velocity measured within the window, recency buckets scaled to it (dead =
    no sale within the window), and money-leaks limited to the same period.
    None = the default long-horizon analysis."""
    label = store_label or f"{client_id}/{location_id}"

    def _dataset():
        with source_db() as db:
            # NO SALES AT ALL: build_inventory_dataset raises ValueError, and
            # it is right to - velocity, dead stock and frozen capital are all
            # measured against a sale date this store does not have, so there
            # is no dataset to build. The repo keeps raising; refusing is the
            # RUNNER's job, because it is the runner that owes the caller a
            # payload. The raise used to escape as far as the browser, where
            # an owner read "ValueError: No sales found for client_id=32" on
            # 111 of 212 stores.
            try:
                return build_inventory_dataset(db, client_id, location_id)
            except ValueError:
                return None

    def _margin():
        with source_db() as db:
            return fetch_margin_rows(db, client_id, location_id,
                                     window_days=window_days or 365)

    dataset, margin_rows = _parallel(_dataset, _margin)
    if dataset is None:
        return _no_sales_inventory(client_id, location_id, label, window_days,
                                   narrate)
    inv.enrich(dataset, window_days=window_days)

    vc = inv.velocity_classes(dataset)
    ds = inv.dead_stock(dataset)
    fc = inv.frozen_capital(dataset)
    sbp = inv.slow_but_premium(dataset)
    bc = inv.brand_concentration(dataset)

    class_map = {s.sku: s.velocity_class for s in dataset.skus}
    ml = money_leaks(margin_rows, class_map, window_days=window_days or 365)

    generated_at = datetime.now()
    briefing = build_briefing(label, vc, ds, fc, sbp, ml, generated_at)

    result = {
        "capability": "inventory",
        "client_id": client_id,
        "location_id": location_id,
        "store_label": label,
        "window_days": window_days,
        "as_of": dataset.as_of.isoformat(),
        "generated_at": generated_at.isoformat(),
        "velocity_classes": vc,
        "dead_stock": ds,
        "frozen_capital": fc,
        "slow_but_premium": sbp,
        "brand_concentration": bc,
        "money_leaks": ml,
        "briefing": briefing,
    }

    if persist:
        from ..app_db.store import persist_run  # lazy import (only needs app DB when persisting)
        persist_run(result, dataset)

    _attach_narration(result, "inventory", narrate)
    return result


def run_customer_radar(client_id: int, location_id: int,
                       store_label: str | None = None, narrate: bool = False) -> dict:
    label = store_label or f"{client_id}/{location_id}"
    with source_db("120s") as db:
        as_of = store_as_of(db, client_id)
        rows = fetch_customer_rows(db, client_id)
        radar = customer_radar(rows, as_of,
                               book_counts=fetch_customer_book_counts(db, client_id))
        if radar.get("available"):
            ids = [c["customer_id"] for c in radar["win_back"]]
            fav = fetch_favorite_categories(db, client_id, ids)
            for c in radar["win_back"]:
                c["favorite_category"] = fav.get(c["customer_id"])
        elif as_of is not None:
            # Gated store: the page still earns its place — anonymous shopper
            # patterns plus a measurable path to unlocking win-back.
            #
            # ONLY WHEN THE STORE HAS SALES. An engagement profile is a read of
            # ANONYMOUS SHOPPERS - tickets per day, peak hours, average basket,
            # how far off the 100 linked customers the store is. All of it is
            # measured from sales, so for a store with none it came back
            # `tracked_customers: 0, sales_90d: 0, by_day: [], top_hours: []`
            # and the screen drew the whole engagement view over it: "0 of 100
            # customers", an empty day chart, no peak hours. An owner reads
            # that as "we have zero customers", which is a far worse claim than
            # the true one - that we have received nothing to count. With no
            # sales the refusal stands on its own and the screen shows it.
            ctx = fetch_engagement_context(db, client_id)
            radar["engagement"] = engagement_profile(
                ctx, radar.get("distinct_customers", 0))

    generated_at = datetime.now()
    briefing = build_customer_briefing(label, radar, generated_at)
    result = {
        "capability": "customers",
        "client_id": client_id, "location_id": location_id,
        "store_label": label,
        "as_of": as_of.isoformat() if as_of else None,
        "generated_at": generated_at.isoformat(),
        "customer_radar": radar,
        "briefing": briefing,
    }
    _attach_narration(result, "customers", narrate)
    return result


def run_buying(client_id: int, location_id: int, store_label: str | None = None,
               narrate: bool = False) -> dict:
    label = store_label or f"{client_id}/{location_id}"

    def _demand():
        with source_db("120s") as db:
            pulled = fetch_sku_demand(db, client_id, location_id)
        # Publish into the canonical-demand cache slot (the key the rec
        # service's bridge reads via get_or_compute): a Buying-tab compute —
        # including a nocache refresh, which must stay FRESH and so never
        # reads this cache — hands its snapshot to the next rec run within
        # the TTL, so both surfaces price reorders off one warehouse pull.
        result_cache.put(("canonical_demand", client_id, location_id), pulled)
        return pulled

    def _daily():
        with source_db("120s") as db:
            return fetch_store_daily(db, client_id, location_id)

    (as_of, demands), daily = _parallel(_demand, _daily)
    if as_of is None:
        # No sales at this store yet (a just-onboarded location, or an empty
        # feed): degrade to an empty payload instead of letting the engines
        # call as_of.isoformat() and 502 the capability.
        return {
            "capability": "buying",
            "client_id": client_id, "location_id": location_id,
            "store_label": label,
            "as_of": None,
            "generated_at": datetime.now().isoformat(),
            "buying": None,
            "lost_sales": None,
            "forecast_backtest": None,
            "briefing": f"{label}: no sales data yet — the buying engine needs "
                        f"at least one recorded sale to size orders.",
        }
    backtest = backtest_daily(daily, as_of)
    buy = buy_recommendations(demands, as_of)
    lost = lost_sales(demands, as_of)

    generated_at = datetime.now()
    briefing = build_buying_briefing(label, buy, backtest, lost, generated_at)
    result = {
        "capability": "buying",
        "client_id": client_id, "location_id": location_id,
        "store_label": label,
        "as_of": as_of.isoformat() if as_of else None,
        "generated_at": generated_at.isoformat(),
        "buying": buy,
        "lost_sales": lost,
        "forecast_backtest": backtest,
        "briefing": briefing,
    }
    _attach_narration(result, "buying", narrate)
    return result


def run_loss(client_id: int, location_id: int, store_label: str | None = None,
             narrate: bool = False) -> dict:
    label = store_label or f"{client_id}/{location_id}"
    with source_db("120s") as db:
        data = fetch_loss_data(db, client_id)
    loss = loss_signals(data)

    generated_at = datetime.now()
    briefing = build_loss_briefing(label, loss, generated_at)
    result = {
        "capability": "loss",
        "client_id": client_id, "location_id": location_id,
        "store_label": label,
        "as_of": loss.get("as_of"),
        "generated_at": generated_at.isoformat(),
        "loss": loss,
        "briefing": briefing,
    }
    _attach_narration(result, "loss", narrate)
    return result


def run_loss_prevention(client_id: int, location_id: int, store_label: str | None = None,
                        narrate: bool = False) -> dict:
    """Loss Prevention = Loss & Theft Radar + Shrinkage & Staff on ONE page.

    They tell a single story — every way money quietly walks out — and an owner
    investigating a cashier needs the register signals and the stock math side
    by side. The two pulls run in parallel on separate connections.
    """
    label = store_label or f"{client_id}/{location_id}"

    def _loss():
        with source_db("120s") as db:
            return fetch_loss_data(db, client_id)

    def _shrink():
        with source_db("120s") as db:
            return fetch_shrinkage_data(db, client_id)

    loss_data, shrink_data = _parallel(_loss, _shrink)
    loss = loss_signals(loss_data)
    shrink = shrinkage_report(shrink_data)

    generated_at = datetime.now()
    briefing = (build_loss_briefing(label, loss, generated_at)
                + "\n\n"
                + build_shrinkage_briefing(label, shrink, generated_at))
    result = {
        "capability": "lossprev",
        "client_id": client_id, "location_id": location_id, "store_label": label,
        "as_of": loss.get("as_of") or shrink.get("as_of"),
        "generated_at": generated_at.isoformat(),
        "loss": loss,
        "shrinkage_report": shrink,
        "briefing": briefing,
    }
    _attach_narration(result, "lossprev", narrate)
    return result


def run_pricing(client_id: int, location_id: int, store_label: str | None = None,
                narrate: bool = False) -> dict:
    label = store_label or f"{client_id}/{location_id}"
    with source_db() as db:
        dataset = build_inventory_dataset(db, client_id, location_id)
    inv.enrich(dataset)
    pricing = price_optimizer(dataset)

    generated_at = datetime.now()
    briefing = build_pricing_briefing(label, pricing, generated_at)
    result = {
        "capability": "pricing",
        "client_id": client_id, "location_id": location_id, "store_label": label,
        "as_of": dataset.as_of.isoformat(),
        "generated_at": generated_at.isoformat(),
        "pricing": pricing,
        "briefing": briefing,
    }
    _attach_narration(result, "pricing", narrate)
    return result


def run_basket(client_id: int, location_id: int, store_label: str | None = None,
               narrate: bool = False) -> dict:
    label = store_label or f"{client_id}/{location_id}"
    with source_db("120s") as db:
        data = fetch_basket_data(db, client_id)
    basket = basket_affinity(data)

    generated_at = datetime.now()
    briefing = build_basket_briefing(label, basket, generated_at)
    result = {
        "capability": "basket",
        "client_id": client_id, "location_id": location_id, "store_label": label,
        "as_of": basket.get("as_of") or data.get("as_of"),
        "generated_at": generated_at.isoformat(),
        "basket": basket,
        "briefing": briefing,
    }
    _attach_narration(result, "basket", narrate)
    return result


def _safe(name: str, fn, errors: list[dict]):
    """Run an engine for the overview; never let one failure sink the page —
    but RECORD the failure, so a broken engine is never mistaken for a clean run."""
    try:
        return fn()
    except Exception as e:
        errors.append({"engine": name, "error": f"{type(e).__name__}: {str(e)[:160]}"})
        return None


def _action_queue(client_id: int, location_id: int) -> tuple[list[dict], list[dict]]:
    """The executive's differentiated value: ONE prioritized list of what to do,
    in dollars, synthesized across every engine — something no POS assembles.
    Engines run in parallel and go through the shared result cache under the
    SAME keys the capability endpoints use, so a Daily Report compute makes the
    inventory/buying/market tabs instant (and vice versa) instead of
    doing the warehouse work twice. Returns (actions, engine_errors) — failed
    engines are reported, not hidden."""
    actions: list[dict] = []
    errors: list[dict] = []

    def _cached(cap: str, runner):
        return result_cache.get_or_compute(
            (cap, client_id, location_id, False),
            lambda: runner(client_id, location_id))

    with ThreadPoolExecutor(max_workers=3) as pool:
        # copy_context() wrappers: SQL-debug context propagation into workers.
        f_inv = pool.submit(contextvars.copy_context().run, _safe, "inventory",
                            lambda: _cached("inventory", run_store), errors)
        f_buy = pool.submit(contextvars.copy_context().run, _safe, "buying",
                            lambda: _cached("buying", run_buying), errors)
        f_market = pool.submit(contextvars.copy_context().run, _safe, "market",
                               lambda: _cached("market", run_market), errors)
        # Retired fan-out engines, kept for reuse. Pricing left with its tab;
        # customers left when the win-back finding was dropped (its dollar
        # figure was a forecast, not a measurement — see the reorder action
        # below for what replaced it). The buying engine already serves the
        # reorder action, so the queue needs only these three.
        # f_pricing = pool.submit(contextvars.copy_context().run, _safe, "pricing",
        #                         lambda: _cached("pricing", run_pricing), errors)
        # f_cust = pool.submit(contextvars.copy_context().run, _safe, "customers",
        #                      lambda: _cached("customers", run_customer_radar), errors)
        invp, bu, mk = (f_inv.result(), f_buy.result(), f_market.result())

    # `if invp:` is not the question. A REFUSAL IS A TRUTHY PAYLOAD: for a
    # store with no sales, run_store now returns every section as
    # {"available": False, "reason": ...} rather than raising, so `invp` is a
    # dict and `invp["frozen_capital"]["value_basis"]` is a KeyError. What the
    # queue needs to know is whether the section has FIGURES in it, which
    # `_usable` answers for an absent, refused or missing section alike.
    fc, ds, ml = (_usable(invp, "frozen_capital"), _usable(invp, "dead_stock"),
                  _usable(invp, "money_leaks"))
    if fc and ds:
        freeable = (ds["actionable_frozen_capital"] if fc["value_basis"] == "cost"
                    else ds["actionable_frozen_retail"])
        if freeable > 0:
            actions.append({"key": "dead_stock", "title": "Free up frozen cash",
                            "capability": "inventory", "severity": "risk",
                            "value": freeable, "value_label": "tied in dead stock",
                            "recommendation": f"Liquidate or bundle {ds['actionable_sku_count']:,} dead SKUs"})
        # "Plug profit leaks" retired: its detail (Recoverable Margin Leaks)
        # rendered on the Inventory Intelligence tab, which no longer exists,
        # so the finding pointed nowhere. Kept for reuse. The frontend also
        # drops key="leaks" from stale cached payloads (Overview.js).
        # if ml.get("recoverable_estimate", 0) > 0:
        #     actions.append({"key": "leaks", "title": "Plug profit leaks",
        #                     "capability": "inventory", "severity": "risk",
        #                     "value": ml["recoverable_estimate"], "value_label": "recoverable / yr",
        #                     "recommendation": f"{ml['below_cost_lines']:,} below-cost sales + "
        #                                       f"${ml['wasted_discount_estimate']:,.0f} wasted markdowns"})
    # Same reading. `_safe` covers an engine that RAISED; what it never covered
    # is one that SUCCEEDED with nothing to report - for a store with no sales
    # run_buying returns a payload whose `lost_sales` is None, and
    # `None.get(...)` took the whole Overview down with an AttributeError the
    # owner read on the page.
    lost = _usable(bu, "lost_sales") or {}
    if lost.get("stockout_sku_count"):
        actions.append({"key": "stockouts", "title": "Stop stockout bleed",
                        "capability": "buying", "severity": "risk",
                        "value": lost["lost_revenue_estimate"], "value_label": "missed so far",
                        "recommendation": f"{lost['stockout_sku_count']:,} movers out of stock "
                                          f"(~${lost['ongoing_daily_loss']:,.0f}/day)"})

    # Market's section can be absent as well as refused; `_usable` covers both,
    # and `available` is what it already refuses on.
    M = _usable(mk, "market") or {}
    if M.get("opportunity_count"):
        actions.append({"key": "market", "title": "Capture nearby demand",
                        "capability": "market", "severity": "opportunity",
                        "value": M["total_projected_profit"], "value_label": "projected profit / yr",
                        "recommendation": f"Stock {M['opportunity_count']:,} products selling at nearby stores"})

    # Retired with the Price & Profit Analysis tab - kept for reuse:
    # P = _usable(pr, "pricing") or {}   # _usable, not pr["pricing"]: see above
    # if P.get("raise_sku_count"):
    #     actions.append({"key": "pricing_raises", "title": "Raise under-priced movers",
    #                     "capability": "pricing", "severity": "opportunity",
    #                     "value": P["est_annual_margin_upside"], "value_label": "margin upside / yr",
    #                     "recommendation": f"Raise {P['raise_sku_count']:,} under-priced fast movers "
    #                                       f"toward their category norm"})

    # win_back retired: its dollar ("annual revenue at risk" = spend rate × 365
    # projected onto people who MIGHT not return) is a forecast, and the daily
    # list should only carry figures the store can verify. Also filtered out of
    # stale cached payloads in Overview.js. Kept for reuse:
    # C = _usable(cu, "customer_radar") or {}   # _usable handles the refusal
    # if C.get("at_risk_count"):
    #     actions.append({"key": "win_back", "title": "Win back lapsed regulars",
    #                     "capability": "customers", "severity": "risk",
    #                     "value": C["annual_revenue_at_risk"], "value_label": "annual revenue at risk",
    #                     "recommendation": f"Reach out to {C['at_risk_count']:,} regulars who broke "
    #                                       f"their visit pattern"})

    # Today's reorder: the most decisive item on the list. Every figure is a
    # measurement, not a forecast — order quantities come from on-hand stock vs
    # each product's own selling pace, and the dollar is quantity × supplier
    # cost. The Buying tab's Suggested Reorder table backs it line by line.
    B = _usable(bu, "buying") or {}
    if B.get("buy_sku_count"):
        urgent = B.get("buy_urgent_count") or 0
        actions.append({"key": "reorder", "title": "Place today's reorder",
                        "capability": "buying", "severity": "risk",
                        "value": B["buy_total_value"], "value_label": "to restock (at cost)",
                        "recommendation": (
                            f"{urgent:,} fast sellers will likely run out before the next delivery — "
                            f"{B['buy_sku_count']:,} SKUs on the reorder list" if urgent
                            else f"{B['buy_sku_count']:,} SKUs need reordering to stay ahead of demand")})

    actions.sort(key=lambda a: a["value"], reverse=True)
    for i, a in enumerate(actions, 1):
        a["rank"] = i
        a["value"] = round(a["value"], 2)
    return actions, errors


def run_overview(client_id: int, location_id: int, store_label: str | None = None,
                 narrate: bool = False) -> dict:
    label = store_label or f"{client_id}/{location_id}"

    # Pulse/momentum and the action queue are independent — overlap them.
    def _pulse():
        with source_db("120s") as db:
            return fetch_overview(db, client_id, location_id)

    data, (queue, engine_errors) = _parallel(
        _pulse, lambda: _action_queue(client_id, location_id))
    ov = overview_fn(data)
    if ov.get("available"):
        ov["action_queue"] = queue
        ov["engine_errors"] = engine_errors
        ov["total_opportunity"] = round(sum(a["value"] for a in queue), 2)

    generated_at = datetime.now()
    briefing = build_overview_briefing(label, ov, generated_at)
    result = {
        "capability": "overview",
        "client_id": client_id, "location_id": location_id, "store_label": label,
        "as_of": ov.get("as_of"),
        "generated_at": generated_at.isoformat(),
        "overview": ov,
        "briefing": briefing,
    }
    _attach_narration(result, "overview", narrate)
    return result


def run_shrinkage(client_id: int, location_id: int, store_label: str | None = None,
                  narrate: bool = False) -> dict:
    label = store_label or f"{client_id}/{location_id}"
    with source_db("120s") as db:
        data = fetch_shrinkage_data(db, client_id)
    shrink = shrinkage_report(data)

    generated_at = datetime.now()
    briefing = build_shrinkage_briefing(label, shrink, generated_at)
    result = {
        "capability": "shrinkage",
        "client_id": client_id, "location_id": location_id, "store_label": label,
        "as_of": shrink.get("as_of"),
        "generated_at": generated_at.isoformat(),
        "shrinkage_report": shrink,
        "briefing": briefing,
    }
    _attach_narration(result, "shrinkage", narrate)
    return result


def run_market(client_id: int, location_id: int, store_label: str | None = None,
               narrate: bool = False) -> dict:
    label = store_label or f"{client_id}/{location_id}"
    with source_db("120s") as db:
        data = fetch_market_data(db, client_id)
    market = market_intelligence(data)

    generated_at = datetime.now()
    briefing = build_market_briefing(label, market, generated_at)
    result = {
        "capability": "market",
        "client_id": client_id, "location_id": location_id, "store_label": label,
        "as_of": market.get("as_of"),
        "generated_at": generated_at.isoformat(),
        "market": market,
        "briefing": briefing,
    }
    _attach_narration(result, "market", narrate)
    return result
