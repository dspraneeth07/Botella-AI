"""Request/response shapes for the bulk run endpoint.

The bulk endpoint lets the caller hand the whole network (or any slice of it) to
the service in one call, so the service owns concurrency instead of relying on
``xargs -P``. ``mode`` selects live concurrent runs or the cheaper Message
Batches path.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.recommendation import RunResult


class LocationRef(BaseModel):
    client_id: int = Field(ge=1, description="Tenant / client id")
    location_id: int = Field(ge=1, description="Store location id")


class BulkRunRequest(BaseModel):
    pairs: list[LocationRef] = Field(..., min_length=1)
    # "concurrent": live, bounded-concurrency runs (immediate results).
    # "batch": Anthropic Message Batches (~50% LLM cost, minutes of latency).
    mode: Literal["concurrent", "batch"] = "concurrent"


class BulkRunError(BaseModel):
    client_id: int
    location_id: int
    code: str
    message: str


class BatchSubmission(BaseModel):
    """Response of the non-blocking batch submit endpoint."""

    batch_id: str | None = None  # None when no store produced a context
    requested: int
    submitted: int
    errors: list[BulkRunError] = []


class BatchStatus(BaseModel):
    """Processing status of a submitted Anthropic Message Batch."""

    batch_id: str
    processing_status: str  # "in_progress" | "canceling" | "ended"
    counts: dict[str, int] = {}


class BatchCollectRequest(BaseModel):
    """Body for the batch collect endpoint: the same pairs that were submitted.

    The service is stateless, so the caller echoes the pairs back; results are
    matched by the ``client_id:location_id`` custom_id and validated against a
    freshly fetched candidate set (validating against *current* stock).
    """

    pairs: list[LocationRef] = Field(..., min_length=1)


class BulkRunResult(BaseModel):
    mode: str
    requested: int
    succeeded: int
    failed: int
    # Anthropic batch id when mode="batch" (None for concurrent) — useful for
    # tracing the run in the Anthropic console.
    batch_id: str | None = None
    results: list[RunResult] = []
    errors: list[BulkRunError] = []
