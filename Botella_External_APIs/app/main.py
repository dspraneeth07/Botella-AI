"""FastAPI application factory and lifecycle wiring.

On startup we create the long-lived clients (Node API, external-signal HTTP,
Anthropic) and the pipeline that uses them; on shutdown we close them cleanly.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from anthropic import AsyncAnthropic
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api.routes import router
from app.clients.geocode import Geocoder
from app.clients.node_api import NodeApiClient
from app.clients.signal_cache import SignalCache
from app.config import Settings, get_settings
from app.dependencies import warn_if_service_auth_open
from app.exceptions import register_exception_handlers
from app.logging_config import configure_logging, get_logger
from app.recommender.pipeline import RecommendationPipeline
from app.storeagent_api import router as storeagent_router

log = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings: Settings = get_settings()
    configure_logging(settings)
    log.info(
        "startup",
        app=settings.app_name,
        environment=settings.environment,
        version=__version__,
    )
    # Once, here, and only outside production: in production an unset key has
    # already refused to construct `Settings` (app/config.py), so a process
    # that reaches this line with no key is a development process by definition.
    warn_if_service_auth_open(settings, log)

    node_client = NodeApiClient(settings)
    signal_http = httpx.AsyncClient(
        timeout=settings.http_timeout_seconds,
        headers={"User-Agent": settings.nws_user_agent},
        follow_redirects=True,
    )
    anthropic_client = AsyncAnthropic(
        api_key=settings.anthropic_api_key,
        timeout=settings.llm_timeout_seconds,
        max_retries=settings.llm_max_retries,
    )

    geocoder = Geocoder(signal_http, settings)
    signal_cache = SignalCache(
        enabled=settings.signal_cache_enabled,
        ttl_seconds=settings.signal_cache_ttl_seconds,
    )

    app.state.settings = settings
    app.state.node_client = node_client
    app.state.anthropic_client = anthropic_client
    app.state.pipeline = RecommendationPipeline(
        settings, node_client, signal_http, anthropic_client, geocoder, signal_cache
    )

    try:
        yield
    finally:
        log.info("shutdown")
        await node_client.aclose()
        await signal_http.aclose()
        await anthropic_client.close()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Contextual Intelligence Service",
        version=__version__,
        summary="Daily, signal-aware product recommendations per liquor store.",
        lifespan=lifespan,
    )
    # Browsers never call this machine-to-machine service; CORS is only wired
    # when origins are explicitly configured.
    if settings.cors_allow_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_allow_origins,
            allow_methods=["*"],
            allow_headers=["*"],
        )
    register_exception_handlers(app)
    app.include_router(router)
    # StoreAgent is a separate, self-contained module mounted under its own
    # prefix. Botella's routes above are untouched; this is purely additive.
    app.include_router(storeagent_router, prefix="/storeagent")
    return app


app = create_app()
