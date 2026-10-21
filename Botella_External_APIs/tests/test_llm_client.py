"""Track-3 tests: shared request builder + result parsing (no network)."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.config import Settings
from app.exceptions import LLMError
from app.recommender.llm_client import (
    LLMRecommender,
    _extract_recommendations,
)


def _recommender(**overrides: object) -> LLMRecommender:
    settings = Settings(
        node_api_base_url="http://node.test", anthropic_api_key="x", **overrides
    )
    # The client is unused by the builders/parsers under test.
    return LLMRecommender(client=None, settings=settings)  # type: ignore[arg-type]


def test_build_params_has_tool_forcing_and_effort() -> None:
    # Cache flag passed explicitly (not inherited from the developer's .env,
    # where it is switched off while the network is a single store).
    rec = _recommender(
        llm_model="claude-sonnet-4-6", llm_effort="medium", prompt_cache_enabled=True
    )
    params = rec._build_params({"system": "SYS", "user": "USR"})
    assert params["model"] == "claude-sonnet-4-6"
    assert params["system"][0]["text"] == "SYS"
    assert params["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert params["messages"] == [{"role": "user", "content": "USR"}]
    assert params["tool_choice"] == {"type": "tool", "name": "recommend_products"}
    assert params["tools"][0]["name"] == "recommend_products"
    assert params["output_config"] == {"effort": "medium"}


def test_build_params_omits_cache_when_disabled_and_effort_when_blank() -> None:
    rec = _recommender(prompt_cache_enabled=False, llm_effort=None)
    params = rec._build_params({"system": "S", "user": "U"})
    assert "cache_control" not in params["system"][0]
    assert "output_config" not in params


def test_extract_recommendations_from_tool_block() -> None:
    block = SimpleNamespace(type="tool_use", input={"recommendations": [{"rank": 1}]})
    content = [SimpleNamespace(type="text"), block]
    # Every extracted card is stamped with the basis the model's number has:
    # it wrote the number, and the card says so (tests/test_confidence_basis.py).
    assert _extract_recommendations(content) == [
        {"rank": 1, "confidence_basis": "llm_stated"}]


def test_extract_recommendations_missing_tool_block_raises() -> None:
    with pytest.raises(LLMError):
        _extract_recommendations([SimpleNamespace(type="text")])


def test_extract_recommendations_non_list_raises() -> None:
    block = SimpleNamespace(type="tool_use", input={"recommendations": "nope"})
    with pytest.raises(LLMError):
        _extract_recommendations([block])


def test_extract_recommendations_truncation_names_the_cause() -> None:
    # max_tokens truncation -> the error should point at the real fix.
    block = SimpleNamespace(type="tool_use", input={})  # cut off before the array
    with pytest.raises(LLMError) as exc:
        _extract_recommendations([block], stop_reason="max_tokens")
    msg = str(exc.value).lower()
    assert "max_tokens" in msg
    assert "llm_max_tokens" in msg or "llm_effort" in msg


def test_parse_batch_result_succeeded() -> None:
    block = SimpleNamespace(type="tool_use", input={"recommendations": [{"rank": 1}]})
    result = SimpleNamespace(
        custom_id="0",
        result=SimpleNamespace(type="succeeded", message=SimpleNamespace(content=[block])),
    )
    outcome = LLMRecommender._parse_batch_result(result)
    # The batch path funnels through the same extraction, so it carries the
    # same stamp.
    assert outcome.recommendations == [{"rank": 1, "confidence_basis": "llm_stated"}]
    assert outcome.error is None


def test_parse_batch_result_errored() -> None:
    result = SimpleNamespace(custom_id="0", result=SimpleNamespace(type="errored"))
    outcome = LLMRecommender._parse_batch_result(result)
    assert outcome.recommendations is None
    assert "errored" in (outcome.error or "")


# ── Sheet 15: temperature 0, and a model id that can be pinned ───────────────


def test_every_param_is_one_the_installed_sdk_accepts() -> None:
    """THE test that would have caught it, and the one that did not exist.

    Sheet 15 asked for `temperature: 0`. It was added, the unit test asserted
    the dict contained it - which was true - and every real call then crashed:

        TypeError: AsyncMessages.stream() got an unexpected keyword argument
        'temperature'

    A params dict that is provably correct and provably unusable. So this
    checks the params against the SDK's ACTUAL signature rather than against
    the shape we hoped it had.
    """
    import inspect

    from anthropic.resources.messages import AsyncMessages

    accepted = set(inspect.signature(AsyncMessages.stream).parameters)
    params = _recommender()._build_params({"system": "S", "user": "U"})
    unknown = set(params) - accepted
    assert not unknown, (
        f"the installed SDK's stream() does not accept {sorted(unknown)} - "
        f"a dict that is correct on paper and crashes on the first real call"
    )


def test_the_two_paths_are_two_sdk_generations_apart() -> None:
    """They cannot be made to agree on temperature, and that is the finding.

    Node is on @anthropic-ai/sdk 0.39.0, where `temperature` is a normal
    Messages parameter - `chat.js` sends 0 and it works. Python is on
    anthropic 1.3.x, which removed it from BOTH `stream()` and `create()`;
    `OutputConfigParam` accepts only `effort` and `format`.

    Pinned so that if a future SDK bump restores temperature, this test fails
    and somebody re-reads sheet 15 rather than rediscovering it in production.
    """
    import inspect

    from anthropic.resources.messages import AsyncMessages

    stream_params = set(inspect.signature(AsyncMessages.stream).parameters)
    create_params = set(inspect.signature(AsyncMessages.create).parameters)
    assert "temperature" not in stream_params
    assert "temperature" not in create_params, (
        "temperature is back on this SDK - re-read SHEET-15 section 2"
    )


def test_what_determinism_rests_on_instead() -> None:
    """The numbers are fixed before the call, whatever the sampler does.

    `effort` is what this SDK generation exposes, and it is recorded so a card
    can still say how it was generated.
    """
    params = _recommender(llm_effort="medium")._build_params(
        {"system": "S", "user": "U"}
    )
    assert params["output_config"] == {"effort": "medium"}


def test_a_pinned_model_is_sent_instead_of_the_floating_alias() -> None:
    """An alias moves; a card written months ago is then unexplainable."""
    floating = _recommender(llm_model="claude-sonnet-4-6")
    assert floating.model_id() == "claude-sonnet-4-6"

    pinned = _recommender(llm_model="claude-sonnet-4-6",
                          llm_model_pinned="claude-sonnet-4-6-20260101")
    assert pinned.model_id() == "claude-sonnet-4-6-20260101"
    assert pinned._build_params({"system": "S", "user": "U"})["model"] == (
        "claude-sonnet-4-6-20260101"
    )


def test_what_is_sent_and_what_is_recorded_cannot_drift() -> None:
    """`model_id()` is the single source for both."""
    rec = _recommender(llm_model_pinned="claude-sonnet-4-6-20260101")
    assert rec._build_params({"system": "S", "user": "U"})["model"] == rec.model_id()
