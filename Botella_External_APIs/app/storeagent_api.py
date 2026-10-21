"""FastAPI adapter for the vendored StoreAgent module.

StoreAgent lives in its own top-level package (``storeagent/``). This module
is the HTTP bridge between the two codebases: it re-exposes StoreAgent's
existing ``run_capability()`` entry point as FastAPI routes mounted under
``/storeagent`` by :mod:`app.main`.

It is NOT the only place the two halves meet, and this docstring used to say
it was ("Botella imports nothing from StoreAgent"). The 19 October 2026 QA
audit listed that sentence as defect 10, because the boundary it described does
not exist in either direction. What is true, from a grep of the imports:

* Eight ``app/`` files import ``storeagent``: ``app/pipeline/assemble.py`` and
  ``app/pipeline/policy/inventory.py`` (both inside a function body, see
  below), ``app/recommender/quantity.py``, ``app/recommender/validator.py``,
  ``app/store_data/__init__.py``, ``app/store_data/candidates.py``,
  ``app/store_data/canonical_demand.py`` and ``app/store_data/store_intel.py``
  - plus this file. The live route takes its order quantities and its
  warehouse reads (canonical demand, the Buying tab's lists) from StoreAgent.
* Three StoreAgent modules import ``app.pipeline``:
  ``storeagent/forecasting/backtest.py``, ``classify.py`` and ``ensemble.py``
  take the run context, the stage envelope, provenance and the settings
  registry from it, so a forecast is a pipeline stage with the same
  replayability rules as the other nineteen.

So the two halves share a process AND share logic. Anyone refactoring should
treat ``storeagent.forecasting`` <-> ``app.pipeline`` as one dependency cycle
(which is why ``assemble.py`` and ``policy/inventory.py`` import it lazily,
inside the function that needs it, rather than at module scope).

The boundary that DOES hold, and the one the backend image depends on, is
narrower: ``app/pipeline`` imports only the standard library and itself at
module scope. Verified by grepping every ``from``/``import`` line under
``app/pipeline``: stdlib (``dataclasses``, ``datetime``, ``math``, ``re``,
``json``, ``statistics``, ``hashlib`` ...), ``app.pipeline.*``, and exactly two
edges out of the package - ``app/pipeline/priors/ladder.py`` imports
``app.signals.us_states`` (itself stdlib-only) and
``app/pipeline/features/weather_archive.py`` imports two threshold constants
from ``app.signals.weather`` (which pulls httpx and the settings model). No
pydantic, no httpx, no database handle anywhere else; the ``storeagent``
imports are function-scoped and never run on the Node side.
``backend/Dockerfile`` copies ``app/pipeline`` and ``scripts/`` alone, with
the system ``python3`` and no pip install, and the two scripts the Node crons
run there (``publish_calibration.py``, ``publish_signal_effects.py``) import
``calibrate.fit``, ``context``, ``elasticity.signal``,
``features.signal_backfill`` and ``features.taxonomy`` - none of which reach
the two edges above. That claim is what the image relies on; keep it true or
the nightly refit dies on an ImportError at 07:00.

StoreAgent reads the read-only ``syncgo`` warehouse over psycopg, which blocks,
so every capability call is offloaded to a worker thread to keep the event loop
free. The original StoreAgent server was a ``ThreadingHTTPServer``; running each
request in its own thread preserves that execution model exactly.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from app.dependencies import require_api_key
from app.logging_config import get_logger

# Imported from the vendored package — never edited here.
from storeagent.api.service import CAPABILITIES, capabilities_meta, run_capability
from storeagent.config import NARRATION

log = get_logger(__name__)

# A dedicated router so the entire StoreAgent surface is namespaced under one
# prefix and can be mounted/unmounted in one line without touching Botella's
# own routes. Guarded by the same shared-key check as the recommender's work
# endpoints: a no-op when SERVICE_API_KEY is unset (dev), required once it is
# set. The browser never calls this directly — the BottleAI Node backend does,
# and it sends the key (STOREAGENT_API_KEY) on the user's behalf.
router = APIRouter(tags=["storeagent"], dependencies=[Depends(require_api_key)])


@router.get("/health", summary="StoreAgent liveness + capability list")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "narration_enabled": NARRATION.enabled,
        "capabilities": list(CAPABILITIES),
    }


@router.get("/capabilities", summary="StoreAgent capability metadata")
async def capabilities() -> dict[str, Any]:
    return {"capabilities": capabilities_meta()}


def _no_dashes(text: str) -> str:
    """Strip em/en dashes from generated text (project-wide style rule)."""
    return text.replace("—", "-").replace("–", "-")


def _validate_window(capability: str, window: int | None) -> JSONResponse | None:
    """The selectable analysis window only exists for Inventory Intelligence."""
    if window is None:
        return None
    if capability != "inventory" or window not in (30, 60, 90):
        return JSONResponse(
            status_code=400,
            content={"error": "window is only supported for the inventory capability, values 30/60/90"},
        )
    return None


@router.get("/{capability}/narration", summary="AI narration over a capability's numbers")
async def capability_narration(
    capability: str,
    store: int | None = Query(default=None, ge=1),
    location: int | None = Query(default=None, ge=1),
    window: int | None = Query(default=None, description="Inventory analysis window (30/60/90 days)."),
) -> Any:
    """Narration only. Reuses the cached base result (no extra warehouse query),
    so toggling AI on the frontend never recomputes/reloads the whole view."""
    if capability not in CAPABILITIES:
        return JSONResponse(status_code=404, content={"error": f"unknown capability: {capability}"})
    bad = _validate_window(capability, window)
    if bad is not None:
        return bad

    def _run() -> dict[str, Any]:
        from storeagent.narration import narrate_capability

        base = run_capability(capability, store=store, location=location, narrate=False,
                              use_cache=True, window=window)
        narr = narrate_capability(capability, base)
        if narr.get("text"):
            narr["text"] = _no_dashes(narr["text"])
        return {"narration": narr}

    try:
        return await run_in_threadpool(_run)
    except Exception as exc:  # noqa: BLE001
        log.warning("storeagent_narration_failed", capability=capability, error=str(exc))
        return JSONResponse(status_code=502, content={"error": f"{type(exc).__name__}: {exc}"})


@router.get("/{capability}", summary="Run a StoreAgent capability for a store")
async def capability(
    capability: str,
    store: int | None = Query(
        default=None,
        ge=1,
        description="client_id to analyse (defaults to the capability's pilot store).",
    ),
    location: int | None = Query(
        default=None,
        ge=1,
        description="location_id scoping every figure; omitted = client-wide (legacy).",
    ),
    narrate: bool = Query(
        default=False,
        description="Add the Claude narration layer (only when ANTHROPIC creds are set).",
    ),
    nocache: bool = Query(
        default=False,
        description="Bypass the 10-minute capability cache and recompute.",
    ),
    window: int | None = Query(
        default=None,
        description="Inventory analysis window in days (30/60/90); omit for the default analysis.",
    ),
) -> Any:
    # Declared after /health and /capabilities so those literal paths win; this
    # dynamic route only catches the actual capability slugs.
    if capability not in CAPABILITIES:
        return JSONResponse(
            status_code=404,
            content={"error": f"unknown capability: {capability}"},
        )
    bad = _validate_window(capability, window)
    if bad is not None:
        return bad
    try:
        # StoreAgent's run_capability is synchronous and DB-bound; keep it off
        # the event loop. Each call carries its own SQL-capture scope inside the
        # worker thread, exactly as it did under ThreadingHTTPServer.
        result = await run_in_threadpool(
            run_capability,
            capability,
            store=store,
            location=location,
            narrate=narrate,
            use_cache=not nocache,
            window=window,
        )
        # Project style rule: no em dashes in generated text.
        if isinstance(result, dict) and isinstance(result.get("briefing"), str):
            result["briefing"] = _no_dashes(result["briefing"])
        return result
    except Exception as exc:  # noqa: BLE001 - surface as JSON, never 500 the SPA
        # Mirror StoreAgent's original 502 envelope so the frontend's error
        # handling (reads `.error`) behaves identically.
        log.warning("storeagent_capability_failed", capability=capability, error=str(exc))
        body: dict[str, Any] = {"error": f"{type(exc).__name__}: {exc}"}
        # Only ever populated under STOREAGENT_DEBUG_SQL: the durations of the
        # queries that DID complete are what identify which one timed out.
        debug_sql = getattr(exc, "debug_sql", None)
        if debug_sql:
            body["debug_sql"] = debug_sql
        return JSONResponse(status_code=502, content=body)
