"""Domain exceptions and FastAPI exception handlers.

The pipeline raises these; ``register_exception_handlers`` maps them to clean
HTTP responses so route code stays free of try/except noise.
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.logging_config import get_logger

log = get_logger(__name__)


class ServiceError(Exception):
    """Base class for all service errors. ``status_code`` drives the HTTP reply."""

    status_code: int = 500
    error_code: str = "internal_error"

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.message = message
        if status_code is not None:
            self.status_code = status_code


class NodeApiError(ServiceError):
    """The Node backend could not satisfy a data request."""

    error_code = "node_api_error"

    def __init__(self, message: str, *, status_code: int = 502) -> None:
        super().__init__(message, status_code=status_code)


class BadRequestError(ServiceError):
    """The caller sent an invalid request (e.g. an over-sized bulk batch)."""

    status_code = 400
    error_code = "bad_request"


class NoCandidatesError(ServiceError):
    """No candidate products could be assembled for the location."""

    status_code = 404
    error_code = "no_candidates"


class LLMError(ServiceError):
    """The recommendation model failed to produce a usable response."""

    status_code = 502
    error_code = "llm_error"


class UnauthorizedError(ServiceError):
    """Missing or wrong X-API-Key on a protected endpoint."""

    status_code = 401
    error_code = "unauthorized"


class BatchNotFinishedError(ServiceError):
    """A batch collect was attempted while the batch is still processing."""

    status_code = 409
    error_code = "batch_not_finished"


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(ServiceError)
    async def _handle_service_error(request: Request, exc: ServiceError) -> JSONResponse:
        log.warning(
            "service_error",
            path=request.url.path,
            error_code=exc.error_code,
            status_code=exc.status_code,
            message=exc.message,
        )
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": exc.error_code, "message": exc.message}},
        )

    @app.exception_handler(Exception)
    async def _handle_unexpected(request: Request, exc: Exception) -> JSONResponse:
        log.error("unhandled_exception", path=request.url.path, exc_info=exc)
        return JSONResponse(
            status_code=500,
            content={"error": {"code": "internal_error", "message": "Internal server error."}},
        )
