"""Track-3 tests: bulk pipeline orchestration + the bulk route."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.config import Settings
from app.exceptions import NoCandidatesError
from app.main import create_app
from app.recommender.llm_client import BatchOutcome
from app.recommender.pipeline import RecommendationPipeline
from app.schemas.bulk import BulkRunError, LocationRef
from app.schemas.context import RecommendationContext
from app.schemas.recommendation import RunResult
from app.schemas.signals import SignalBundle
from app.schemas.store import StoreProfile
from app.store_data import compute_derived
from tests.conftest import NOW, item, sale


def _settings(**kw: object) -> Settings:
    return Settings(node_api_base_url="http://node.test", anthropic_api_key="x", **kw)


def _pipeline(settings: Settings) -> RecommendationPipeline:
    # All upstream clients are stubbed; the bulk methods under test are
    # exercised by monkeypatching run / _build_context / the LLM.
    return RecommendationPipeline(
        settings, node_client=None, signal_http=None,  # type: ignore[arg-type]
        anthropic_client=None, geocoder=None, signal_cache=None,  # type: ignore[arg-type]
    )


def _context() -> RecommendationContext:
    return compute_derived(
        store=StoreProfile(id=1, name="Test Store"),
        signals=SignalBundle(),
        inventory=[item("A", category="beer", on_hand=10)],
        sales=[sale("A", days_ago=2, units=5)],
        now=NOW,
        candidate_pool_size=50,
    )


_RAW_REC = {
    "rank": 1,
    "category": "weather",
    "action_type": "reorder",
    "primary_skus": ["A"],
    "rationale": "test",
    "signals_cited": [],
    "confidence": 0.5,
    "valid_through": "2026-06-10",
}


# ----- concurrent mode ----------------------------------------------------


async def test_run_many_collects_successes_and_errors() -> None:
    pipe = _pipeline(_settings(bulk_max_concurrency=4))
    ctx = _context()

    async def fake_run(client_id: int, location_id: int) -> RunResult:
        if location_id == 2:
            raise NoCandidatesError("nope")
        return pipe._assemble(client_id, location_id, ctx, [dict(_RAW_REC)])

    pipe.run = fake_run  # type: ignore[method-assign]

    pairs = [LocationRef(client_id=9, location_id=i) for i in (1, 2, 3)]
    result = await pipe.run_bulk(pairs, mode="concurrent")

    assert result.mode == "concurrent"
    assert result.requested == 3
    assert result.succeeded == 2
    assert result.failed == 1
    assert result.errors[0].location_id == 2
    assert result.errors[0].code == "no_candidates"


# ----- batch mode ---------------------------------------------------------


async def test_run_batch_assembles_results_and_reports_context_failures() -> None:
    pipe = _pipeline(_settings())
    ctx = _context()

    async def fake_build_context(
        client_id: int, location_id: int, recorder: object | None = None
    ) -> RecommendationContext:
        if location_id == 2:
            raise NoCandidatesError("nope")
        return ctx

    async def fake_batch(prompts: dict[str, dict[str, str]]):
        # custom_ids are positional indices among the *submitted* prompts.
        outcomes = {cid: BatchOutcome(recommendations=[dict(_RAW_REC)]) for cid in prompts}
        return "batch_abc", outcomes

    pipe._build_context = fake_build_context  # type: ignore[method-assign]
    pipe._llm.recommend_batch = fake_batch  # type: ignore[method-assign]

    pairs = [LocationRef(client_id=9, location_id=i) for i in (1, 2, 3)]
    result = await pipe.run_bulk(pairs, mode="batch")

    assert result.mode == "batch"
    assert result.batch_id == "batch_abc"
    assert result.succeeded == 2  # locations 1 and 3
    assert result.failed == 1  # location 2 failed context build
    assert {e.location_id for e in result.errors} == {2}


async def test_run_batch_maps_llm_failure_to_error() -> None:
    pipe = _pipeline(_settings())
    ctx = _context()

    async def fake_build_context(
        client_id: int, location_id: int, recorder: object | None = None
    ) -> RecommendationContext:
        return ctx

    async def fake_batch(prompts: dict[str, dict[str, str]]):
        return "b1", {cid: BatchOutcome(error="batch result expired") for cid in prompts}

    pipe._build_context = fake_build_context  # type: ignore[method-assign]
    pipe._llm.recommend_batch = fake_batch  # type: ignore[method-assign]

    result = await pipe.run_bulk([LocationRef(client_id=9, location_id=1)], mode="batch")
    assert result.succeeded == 0
    assert result.failed == 1
    assert result.errors[0].code == "llm_error"


# ----- non-blocking batch (submit / status / collect) ----------------------


async def test_submit_batch_run_returns_id_and_errors() -> None:
    pipe = _pipeline(_settings())
    ctx = _context()
    seen_prompts: dict[str, dict[str, str]] = {}

    async def fake_build_context(
        client_id: int, location_id: int, recorder: object | None = None
    ) -> RecommendationContext:
        if location_id == 2:
            raise NoCandidatesError("nope")
        return ctx

    async def fake_submit(prompts: dict[str, dict[str, str]]) -> str:
        seen_prompts.update(prompts)
        return "batch_xyz"

    pipe._build_context = fake_build_context  # type: ignore[method-assign]
    pipe._llm.submit_batch = fake_submit  # type: ignore[method-assign]

    pairs = [LocationRef(client_id=9, location_id=i) for i in (1, 2)]
    submission = await pipe.submit_batch_run(pairs)

    assert submission.batch_id == "batch_xyz"
    assert submission.requested == 2 and submission.submitted == 1
    assert submission.errors[0].location_id == 2
    assert set(seen_prompts) == {"9:1"}  # custom_id is client:location, not an index


async def test_collect_batch_run_raises_409_while_processing() -> None:
    import pytest

    from app.exceptions import BatchNotFinishedError

    pipe = _pipeline(_settings())

    async def fake_status(batch_id: str):
        return "in_progress", {"processing": 3}

    pipe._llm.batch_status = fake_status  # type: ignore[method-assign]

    with pytest.raises(BatchNotFinishedError):
        await pipe.collect_batch_run("b1", [LocationRef(client_id=9, location_id=1)])


async def test_collect_batch_run_assembles_and_flags_unknown_pairs() -> None:
    pipe = _pipeline(_settings())
    ctx = _context()

    async def fake_status(batch_id: str):
        return "ended", {"succeeded": 1}

    async def fake_collect(batch_id: str):
        return {"9:1": BatchOutcome(recommendations=[dict(_RAW_REC)])}

    async def fake_build_context(
        client_id: int, location_id: int, recorder: object | None = None
    ) -> RecommendationContext:
        return ctx

    pipe._llm.batch_status = fake_status  # type: ignore[method-assign]
    pipe._llm.collect_batch = fake_collect  # type: ignore[method-assign]
    pipe._build_context = fake_build_context  # type: ignore[method-assign]

    pairs = [LocationRef(client_id=9, location_id=1), LocationRef(client_id=9, location_id=7)]
    result = await pipe.collect_batch_run("b1", pairs)

    assert result.mode == "batch" and result.batch_id == "b1"
    assert result.succeeded == 1
    assert result.results[0].location_id == 1
    assert result.failed == 1
    assert result.errors[0].location_id == 7 and result.errors[0].code == "not_in_batch"


# ----- route validation ---------------------------------------------------


def test_bulk_route_rejects_empty_pairs() -> None:
    app = create_app()
    with TestClient(app) as client:
        resp = client.post("/run-recommendations", json={"pairs": []})
        assert resp.status_code == 422  # pydantic min_length


def test_bulk_route_rejects_oversized_batch() -> None:
    app = create_app()
    with TestClient(app) as client:
        pairs = [{"client_id": 9, "location_id": i} for i in range(1, 600)]
        resp = client.post("/run-recommendations", json={"pairs": pairs})
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "bad_request"


def test_bulk_route_in_openapi() -> None:
    app = create_app()
    with TestClient(app) as client:
        paths = client.get("/openapi.json").json()["paths"]
        assert "/run-recommendations" in paths
        assert "post" in paths["/run-recommendations"]


def test_error_helper_classifies_service_vs_unexpected() -> None:
    pair = LocationRef(client_id=1, location_id=1)
    from app.recommender.pipeline import _error_for

    svc = _error_for(pair, NoCandidatesError("x"))
    assert isinstance(svc, BulkRunError) and svc.code == "no_candidates"
    unexpected = _error_for(pair, RuntimeError("boom"))
    assert unexpected.code == "internal_error"
