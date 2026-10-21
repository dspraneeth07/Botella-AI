"""FastAPI dependency providers.

Long-lived singletons (the pipeline, its clients) are created once in the app
lifespan and stored on ``app.state``; these accessors expose them to routes.
"""

from __future__ import annotations

import secrets
from typing import Any

from fastapi import Request

from app.config import Settings
from app.exceptions import UnauthorizedError
from app.recommender.pipeline import RecommendationPipeline


def get_pipeline(request: Request) -> RecommendationPipeline:
    return request.app.state.pipeline


def get_settings_dep(request: Request) -> Settings:
    return request.app.state.settings


SERVICE_AUTH_OPEN_WARNING = (
    "SERVICE_API_KEY is not set - the work endpoints and /storeagent accept "
    "anonymous callers. That is the development default and it is refused in "
    "production (ENVIRONMENT=production fails startup; see app/config.py). Set "
    "SERVICE_API_KEY here and the same value as REC_SERVICE_API_KEY and "
    "STOREAGENT_API_KEY in backend/.env."
)


def warn_if_service_auth_open(settings: Settings, log: Any) -> bool:
    """Log ONE warning at startup when the shared key is unset. True if it did.

    Called from the lifespan in :mod:`app.main`, after logging is configured
    and before any client is built. Only reached outside production: with
    ``ENVIRONMENT=production`` an unset key never gets this far, because
    ``Settings`` refuses to construct (defect 4 of the 19 October QA audit;
    the Node twin is backend/middleware/auth.js on NODE_API_TOKEN). The
    warning is the development half of that rule - the open door stays open
    for the three-terminal dev flow, but it is announced once, in the log,
    rather than discovered from a 200 that should have been a 401.
    """
    if settings.service_api_key:
        return False
    log.warning("service_auth_open", environment=settings.environment,
                message=SERVICE_AUTH_OPEN_WARNING)
    return True


async def require_api_key(request: Request) -> None:
    """Guard the work endpoints with a shared key when one is configured.

    Runs cost real LLM money, so anything that can reach the service must not
    be able to trigger them anonymously. When ``SERVICE_API_KEY`` is unset the
    check is a no-op - a development convenience, announced once at startup by
    :func:`warn_if_service_auth_open`. In production an unset key is not a
    no-op: ``Settings`` refuses to construct and the service does not start
    (``SERVICE_API_KEY_REQUIRED_MESSAGE`` in app/config.py), so this early
    return is never reached there.
    """
    expected = request.app.state.settings.service_api_key
    if not expected:
        return
    provided = request.headers.get("x-api-key") or ""
    if not secrets.compare_digest(provided, expected):
        raise UnauthorizedError("Missing or invalid X-API-Key header.")
