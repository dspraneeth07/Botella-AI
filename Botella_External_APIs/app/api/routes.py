"""HTTP routes.

Work endpoints (called by external cron, protected by ``X-API-Key`` when
configured) plus health checks. Reads of stored recommendations are served by
the Node side, not here — this service is a stateless generator.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Path, Query

from app.config import Settings
from app.dependencies import get_pipeline, get_settings_dep, require_api_key
from app.exceptions import BadRequestError
from app.recommender.pipeline import RecommendationPipeline
from app.schemas.bulk import (
    BatchCollectRequest,
    BatchStatus,
    BatchSubmission,
    BulkRunRequest,
    BulkRunResult,
)
from app.schemas.recommendation import RunResult

router = APIRouter()
work_router = APIRouter(dependencies=[Depends(require_api_key)])


@router.get("/health", tags=["health"], summary="Liveness probe")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/healthz", tags=["health"], summary="Readiness probe with config echo")
async def healthz(
    request_settings: Settings = Depends(get_settings_dep),
    deep: bool = Query(
        default=False,
        description="Also check that the Node API and Anthropic are reachable.",
    ),
    pipeline: RecommendationPipeline = Depends(get_pipeline),
) -> dict[str, object]:
    payload: dict[str, object] = {
        "status": "ok",
        "environment": request_settings.environment,
        "max_recommendations": request_settings.max_recommendations,
        "candidate_pool_size": request_settings.candidate_pool_size,
        "auth_enabled": bool(request_settings.service_api_key),
    }
    if deep:
        checks = await pipeline.deep_health()
        payload["checks"] = checks
        if any(v != "ok" for v in checks.values()):
            payload["status"] = "degraded"
    return payload


@work_router.get(
    "/auth-check",
    tags=["health"],
    summary="Verify the caller's X-API-Key without doing any work",
)
async def auth_check() -> dict[str, bool]:
    """The cheapest possible authenticated endpoint.

    Exists so a deploy pipeline can prove its ``SERVICE_API_KEY`` still matches
    this service's, before a cron discovers otherwise hours later. Every other
    work endpoint either burns an LLM call or reaches the Anthropic API, which
    is far too expensive to run on every deploy.

    401 on a missing/wrong key (via the router-level guard), 200 otherwise —
    the status code IS the answer, the body carries nothing sensitive.
    """
    return {"ok": True}


@work_router.post(
    "/run-recommendations/{client_id}/{location_id}",
    response_model=RunResult,
    tags=["recommendations"],
    summary="Generate today's recommendations for one store",
)
async def run_recommendations(
    client_id: int = Path(..., ge=1, description="Tenant / client id"),
    location_id: int = Path(..., ge=1, description="Store location id"),
    pipeline: RecommendationPipeline = Depends(get_pipeline),
) -> RunResult:
    return await pipeline.run(client_id, location_id)


@work_router.post(
    "/run-recommendations",
    response_model=BulkRunResult,
    tags=["recommendations"],
    summary="Generate recommendations for many stores in one call",
)
async def run_recommendations_bulk(
    body: BulkRunRequest,
    pipeline: RecommendationPipeline = Depends(get_pipeline),
    settings: Settings = Depends(get_settings_dep),
) -> BulkRunResult:
    """Fan many stores out in one request so the service owns concurrency.

    ``mode="concurrent"`` runs them live with bounded concurrency and returns
    immediately; ``mode="batch"`` submits one Anthropic Message Batch (~50% LLM
    cost) and holds the connection open while it processes. For long batches
    prefer the non-blocking submit/status/collect endpoints below. Per-store
    failures are reported in ``errors`` without failing the whole call.
    """
    if len(body.pairs) > settings.bulk_max_pairs:
        raise BadRequestError(
            f"Too many stores in one bulk call ({len(body.pairs)} > "
            f"{settings.bulk_max_pairs}). Split into smaller batches."
        )
    return await pipeline.run_bulk(body.pairs, mode=body.mode)


@work_router.post(
    "/run-recommendations/batch",
    response_model=BatchSubmission,
    tags=["recommendations"],
    summary="Submit a Message Batch and return immediately (non-blocking)",
)
async def submit_batch(
    body: BatchCollectRequest,
    pipeline: RecommendationPipeline = Depends(get_pipeline),
    settings: Settings = Depends(get_settings_dep),
) -> BatchSubmission:
    """Non-blocking alternative to ``mode="batch"``: no held connection.

    Poll ``GET /run-recommendations/batch/{batch_id}`` until ``ended``, then
    ``POST /run-recommendations/batch/{batch_id}/collect`` with the same pairs.
    """
    if len(body.pairs) > settings.bulk_max_pairs:
        raise BadRequestError(
            f"Too many stores in one batch ({len(body.pairs)} > "
            f"{settings.bulk_max_pairs}). Split into smaller batches."
        )
    return await pipeline.submit_batch_run(body.pairs)


@work_router.get(
    "/run-recommendations/batch/{batch_id}",
    response_model=BatchStatus,
    tags=["recommendations"],
    summary="Processing status of a submitted batch",
)
async def batch_status(
    batch_id: str,
    pipeline: RecommendationPipeline = Depends(get_pipeline),
) -> BatchStatus:
    return await pipeline.batch_run_status(batch_id)


@work_router.post(
    "/run-recommendations/batch/{batch_id}/collect",
    response_model=BulkRunResult,
    tags=["recommendations"],
    summary="Collect an ended batch's results (validates against current stock)",
)
async def collect_batch(
    batch_id: str,
    body: BatchCollectRequest,
    pipeline: RecommendationPipeline = Depends(get_pipeline),
) -> BulkRunResult:
    """409 while the batch is still processing; results otherwise."""
    return await pipeline.collect_batch_run(batch_id, body.pairs)


router.include_router(work_router)
