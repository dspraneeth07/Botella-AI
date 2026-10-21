"""Track-3 tests: the bounded-concurrency fan-out helper."""

from __future__ import annotations

import asyncio

from app.recommender.pipeline import gather_with_limit


async def test_results_align_with_items() -> None:
    async def runner(x: int) -> int:
        return x * 2

    out = await gather_with_limit([1, 2, 3], runner, limit=2)
    assert out == [2, 4, 6]


async def test_exceptions_returned_in_place_not_raised() -> None:
    async def runner(x: int) -> int:
        if x == 2:
            raise ValueError("boom")
        return x

    out = await gather_with_limit([1, 2, 3], runner, limit=3)
    assert out[0] == 1
    assert isinstance(out[1], ValueError)
    assert out[2] == 3


async def test_respects_concurrency_limit() -> None:
    state = {"active": 0, "peak": 0}

    async def runner(_x: int) -> int:
        state["active"] += 1
        state["peak"] = max(state["peak"], state["active"])
        await asyncio.sleep(0.01)
        state["active"] -= 1
        return _x

    await gather_with_limit(list(range(10)), runner, limit=3)
    assert state["peak"] <= 3
