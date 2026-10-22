"""Capability service: runs the pipeline behind the shared TTL result cache.

Capability runs hit the read-only warehouse and can take seconds, so identical
requests within the TTL reuse the last result (runtime/result_cache - shared
with the overview action queue, single-flighted). Pure data-plumbing - no HTTP
here, so it's unit-testable.
"""
from __future__ import annotations

from ..config import (DEBUG_SQL, NARRATION, PILOT_CLIENT_ID, PILOT_CUSTOMER_CLIENT_ID)
from ..runtime import result_cache
# run_basket / run_loss_prevention / run_pricing: retired with their capability
# entries below.
from ..runtime.pipeline import (run_buying, run_customer_radar,
                                run_market, run_overview, run_store)
from ..source.connector import begin_sql_capture, end_sql_capture

CAPABILITIES = {
    "overview": {
        "label": "Executive Overview",
        "default_store": PILOT_CLIENT_ID,
        "description": "The morning read: revenue trend, margin, basket size, and top movers.",
        "runner": run_overview,
    },
    "inventory": {
        "label": "Inventory Intelligence",
        "default_store": PILOT_CLIENT_ID,
        "description": "Cash on the shelves, dead stock to liquidate, money-leaks, brand concentration.",
        "runner": run_store,
    },
    # Price & Profit Analysis retired (tab removed in BottleAI). Unregistered
    # so no request path can trigger its warehouse compute; run_pricing in the
    # pipeline is untouched. Re-add this entry (and the import) to revive it.
    # "pricing": {
    #     "label": "Pricing & Margin",
    #     "default_store": PILOT_CLIENT_ID,
    #     "description": "Raise under-priced fast movers, cut over-priced slow movers - vs your category norms.",
    #     "runner": run_pricing,
    # },
    "buying": {
        "label": "Predictive Buying",
        "default_store": PILOT_CLIENT_ID,
        "description": "Backtested demand forecast, dated buy list (per-supplier cadence), don't-buy, lost sales.",
        "runner": run_buying,
    },
    # Basket & Cross-Sell retired (tab removed in BottleAI). Unregistering it
    # here means /storeagent/basket 404s instead of computing, and it drops out
    # of /capabilities metadata. Re-add the entry (and the run_basket import)
    # to revive it.
    # "basket": {
    #     "label": "Basket & Cross-sell",
    #     "default_store": PILOT_CLIENT_ID,
    #     "description": "What sells together - bundle, co-locate, and cross-sell ideas by affinity (lift).",
    #     "runner": run_basket,
    # },
    "customers": {
        "label": "Customer Win-Back",
        "default_store": PILOT_CUSTOMER_CLIENT_ID,
        "description": "Regulars who broke their visit pattern, revenue at risk, named outreach list.",
        "runner": run_customer_radar,
    },
    # Loss Prevention retired (tab removed in BottleAI). Same deal as basket:
    # unregistered so no request path can trigger its warehouse compute.
    # "lossprev": {
    #     "label": "Loss Prevention",
    #     "default_store": PILOT_CLIENT_ID,
    #     "description": "Where money quietly walks out: free rings, below-cost sales, voids, cashier outliers, missing stock.",
    #     "runner": run_loss_prevention,
    # },
    "market": {
        "label": "Market Intelligence",
        "default_store": PILOT_CLIENT_ID,
        "description": "Products nearby stores sell well that you don't carry - with projected profit to stock them.",
        "runner": run_market,
    },
}

def capabilities_meta() -> list[dict]:
    return [{"capability": k, "label": v["label"], "default_store": v["default_store"],
             "description": v["description"]} for k, v in CAPABILITIES.items()]


def _compute(cfg: dict, store: int, location: int, narrate: bool,
             window: int | None = None) -> dict:
    kwargs = {"narrate": narrate}
    if window is not None:  # only the inventory runner accepts it (HTTP validates)
        kwargs["window_days"] = window
    # SQL debug (STOREAGENT_DEBUG_SQL=true): echo the exact warehouse queries
    # behind this result so every figure can be audited. Off by default - the
    # payload flows through the Node proxy to the browser and exposes the
    # warehouse schema. Cached results keep the log of the run that made them.
    if DEBUG_SQL:
        sql_log = begin_sql_capture()
        try:
            result = cfg["runner"](store, location, **kwargs)
        except Exception as exc:
            # Carry the partial log out on the exception: the queries that DID
            # finish, with their durations, are exactly what identifies a
            # statement timeout, and this is the one run where the normal
            # `result["debug_sql"]` assignment below is never reached.
            # psycopg's QueryCanceled takes the attribute, but a type that
            # refuses it must not replace the error we're trying to diagnose.
            try:
                exc.debug_sql = sql_log
            except AttributeError:
                pass
            raise
        finally:
            end_sql_capture()
        result["debug_sql"] = sql_log
        return result
    return cfg["runner"](store, location, **kwargs)


def run_capability(capability: str, store: int | None = None,
                   location: int | None = None, narrate: bool = False,
                   use_cache: bool = True, window: int | None = None) -> dict:
    cfg = CAPABILITIES.get(capability)
    if cfg is None:
        raise KeyError(capability)
    store = store or cfg["default_store"]
    # location=None means CLIENT-WIDE (legacy behavior): the repos skip their
    # location_id filter entirely. It must NOT default to the store id - with
    # location scoping live in the repos, filtering on a client id that isn't
    # a real location id would silently zero every figure. Production (the
    # Node proxy) always sends the JWT's real location; only direct callers
    # (sql_checks harness, curl) hit this.
    # Narration only happens if creds exist; bake that into the key.
    narrate = bool(narrate and NARRATION.enabled)
    # Shared with the overview action queue's engine runs (result_cache), so a
    # Daily Report compute makes the inventory/buying/market tabs instant and
    # vice versa; concurrent identical requests collapse into one computation.
    # Default requests keep the queue's exact 4-tuple key; only windowed views
    # (inventory 30/60/90) extend it, so they cache separately without breaking
    # that sharing.
    key = (capability, store, location, narrate) if window is None \
        else (capability, store, location, narrate, window)

    if use_cache:
        return result_cache.get_or_compute(key, lambda: _compute(cfg, store, location, narrate, window))
    result = _compute(cfg, store, location, narrate, window)
    result_cache.put(key, result)  # a refresh updates everyone, not just the caller
    return result


def clear_cache() -> None:
    result_cache.clear()
