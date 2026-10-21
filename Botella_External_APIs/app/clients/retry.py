"""Shared retry policy for outbound HTTP calls.

Retries only on transient failures: network/transport errors and 5xx responses.
4xx responses are surfaced immediately (no point retrying a 404 or a 400).
"""

from __future__ import annotations

import httpx
from tenacity import (
    retry_if_exception,
    stop_after_attempt,
    wait_exponential,
)


def is_transient(exc: BaseException) -> bool:
    if isinstance(exc, httpx.TransportError):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code >= 500
    return False


def transient_retry(max_attempts: int) -> dict:
    """Keyword args for ``tenacity.retry`` / ``AsyncRetrying``."""
    return {
        "reraise": True,
        "stop": stop_after_attempt(max_attempts),
        "wait": wait_exponential(multiplier=0.4, min=0.4, max=5.0),
        "retry": retry_if_exception(is_transient),
    }
