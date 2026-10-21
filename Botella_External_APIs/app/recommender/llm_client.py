"""Claude tool-use calls that return structured recommendations.

Two paths share one tool definition and one prompt shape:

* ``recommend`` — a single streamed tool-use call for one store (low latency,
  used by the per-store endpoint).
* ``recommend_batch`` — many stores in one Message Batches submission for ~50%
  token cost on cron-driven runs that tolerate minutes of latency.

Why tool-use instead of "respond in JSON": the tool call arrives as parsed
JSON, so there's no string parsing on our side, and ``tool_choice`` forces the
model to emit exactly this tool. The ``input_schema`` is advisory, NOT a
guarantee — Anthropic does not strictly validate tool input against it, so
out-of-enum values, missing keys, and wrong types can and do reach this code.
Every field is re-validated deterministically in the validator/pipeline.

Prompt caching: the system prompt + tool definition are static across every
store in a daily run, so they're cached behind one breakpoint. Only the
per-store user payload is uncached. The batch path benefits the most — every
request in the batch shares the cached prefix.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import anthropic
from anthropic import AsyncAnthropic

from app.config import Settings
from app.exceptions import LLMError
from app.logging_config import get_logger
from app.schemas.recommendation import ACTION_TYPES, CATEGORIES

#: The basis every card this client extracts carries. A name here rather than a
#: literal at the stamp so the vocabulary test can find it.
LLM_STATED_BASIS = "llm_stated"

log = get_logger(__name__)

_TOOL_NAME = "recommend_products"


@dataclass(slots=True)
class BatchOutcome:
    """Per-store result of a batch submission: recommendations or an error."""

    recommendations: list[dict] | None = None
    error: str | None = None


def _build_tool(max_recommendations: int, floor: int) -> dict[str, Any]:
    return {
        "name": _TOOL_NAME,
        "description": "Produce ranked, signal-grounded recommendations for tomorrow.",
        "input_schema": {
            "type": "object",
            "properties": {
                "recommendations": {
                    "type": "array",
                    "minItems": floor,
                    "maxItems": max_recommendations,
                    "items": {
                        "type": "object",
                        "properties": {
                            "rank": {"type": "integer"},
                            "category": {"type": "string", "enum": list(CATEGORIES)},
                            "action_type": {"type": "string", "enum": list(ACTION_TYPES)},
                            "primary_skus": {
                                "type": "array",
                                "items": {"type": "string"},
                                "minItems": 0,
                                "description": (
                                    "MUST be SKUs from the candidate list. Empty ONLY "
                                    "for the two sanctioned stock_new shapes: a NOT "
                                    "CARRIED area winner, or a NOT CARRIED trend-proof "
                                    "top seller."
                                ),
                            },
                            "quantity_hint": {
                                "type": "string",
                                "description": (
                                    "How much, in UNITS. When the candidate line "
                                    "shows order:<N>u, quote exactly N (e.g. "
                                    "'order 45 units'). Never use cases."
                                ),
                            },
                            "rationale": {"type": "string"},
                            "signals_cited": {
                                "type": "array",
                                "items": {"type": "string"},
                            },
                            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                            "valid_through": {"type": "string", "format": "date"},
                        },
                        "required": [
                            "rank", "category", "action_type", "primary_skus",
                            "rationale", "signals_cited", "confidence", "valid_through",
                        ],
                    },
                }
            },
            "required": ["recommendations"],
        },
    }


def _extract_recommendations(content: list[Any], *, stop_reason: str | None = None) -> list[dict]:
    """Pull the recommendations array out of a message's tool_use block.

    Shared by the streaming and batch paths — both receive a fully assembled
    ``Message`` whose ``content`` holds the forced ``recommend_products`` call.

    The most common failure is truncation: when the response hits ``max_tokens``
    the tool's JSON is cut off mid-array, so ``recommendations`` arrives empty or
    not-a-list. We detect that and say so, rather than emitting a cryptic error.
    """
    truncated = stop_reason == "max_tokens"
    hint = (
        " The response hit max_tokens — the tool JSON was cut off. Raise "
        "LLM_MAX_TOKENS and/or lower LLM_EFFORT (effort/thinking spends the "
        "same output budget)."
    )

    tool_block = next((b for b in content if getattr(b, "type", None) == "tool_use"), None)
    if tool_block is None:
        raise LLMError(
            "Model did not return a recommend_products tool call."
            + (hint if truncated else "")
        )

    recommendations = tool_block.input.get("recommendations")
    if not isinstance(recommendations, list):
        # Surface what actually came back so the cause is visible in the logs.
        raw = tool_block.input
        log.warning(
            "tool_input_missing_recommendations",
            stop_reason=stop_reason,
            input_keys=list(raw.keys()) if isinstance(raw, dict) else None,
        )
        raise LLMError(
            "Tool call returned no recommendations array."
            + (hint if truncated else " The model emitted the tool with no usable array.")
        )
    # THE MODEL WROTE THE NUMBER, and the card says so. Stamped here because
    # both the streaming and the batch path funnel through this one function,
    # so there is no LLM-emitted card that misses it. Only dicts: the validator
    # drops anything else with its own reason, and a stamp on a non-dict would
    # mask that. Never overwritten - a basis the model somehow supplied is a
    # claim to be refused at the schema (the Literal) rather than silently
    # replaced here.
    for rec in recommendations:
        if isinstance(rec, dict) and not rec.get("confidence_basis"):
            rec["confidence_basis"] = LLM_STATED_BASIS
    return recommendations


class LLMRecommender:
    """Wraps the Anthropic async client and the recommend_products tool call."""

    def __init__(self, client: AsyncAnthropic, settings: Settings) -> None:
        self._client = client
        self._settings = settings
        self._tool = _build_tool(settings.max_recommendations, settings.recommendation_floor)

    def model_id(self) -> str:
        """The model this client will actually ask for.

        A pinned, dated snapshot when one is configured; the floating alias
        otherwise. Exposed rather than read from settings at each call site so
        that what is SENT and what is RECORDED cannot drift apart.
        """
        return self._settings.llm_model_pinned or self._settings.llm_model

    def _build_params(self, prompt: dict[str, str]) -> dict[str, Any]:
        """Core Messages-API params shared by the single and batch paths.

        ``effort`` is placed in ``output_config`` here (valid for both batch
        requests and the streaming call). The system block carries the cache
        breakpoint so the static prefix is reused across every store.

        TEMPERATURE IS NOT A PARAMETER ON THIS SDK, AND THAT IS THE FINDING.
            Sheet 15 asked for ``temperature: 0`` here, because the chat path
            (backend/routes/chat.js:1548) sends it and the two disagreed. So it
            was added - and it crashed every run:

                TypeError: AsyncMessages.stream() got an unexpected keyword
                argument 'temperature'

            The two paths are two SDK GENERATIONS apart. Node is on
            @anthropic-ai/sdk 0.39.0, where ``temperature`` is a normal
            Messages parameter. Python is on anthropic 1.3.0, which removed it
            from BOTH ``stream()`` and ``create()``; ``OutputConfigParam``
            accepts only ``effort`` and ``format``.

            So the two paths CANNOT be made to agree on temperature. This one
            has no such knob to set.

        WHAT DETERMINISM RESTS ON INSTEAD, NOW THAT IT CANNOT REST ON THAT
            Every figure in the output was fixed before this call - sheet 14
            validated it and sheet 15's prompt forbids computing, deriving or
            rounding any of it. Sheet 16 then checks every numeral in the
            sentence against that record. So the NUMBERS are deterministic
            whatever the sampler does.

            The PROSE is not, and cannot be made so from here. That is a stated
            limitation rather than a silent one: a wording regression has to be
            told from run-to-run variation by sheet 16's failure RATE over many
            cards, not by diffing two sentences.

        The unit test asserts these params against the installed SDK's actual
        signature, not just their presence in a dict - which is what the first
        version did, and why a dict that was provably correct crashed on the
        first real call.
        """
        system_block: dict[str, Any] = {"type": "text", "text": prompt["system"]}
        if self._settings.prompt_cache_enabled:
            system_block["cache_control"] = {"type": "ephemeral"}

        params: dict[str, Any] = {
            "model": self.model_id(),
            "max_tokens": self._settings.llm_max_tokens,
            "system": [system_block],
            "messages": [{"role": "user", "content": prompt["user"]}],
            "tools": [self._tool],
            "tool_choice": {"type": "tool", "name": _TOOL_NAME},
        }
        if self._settings.llm_effort:
            params["output_config"] = {"effort": self._settings.llm_effort}
        return params

    async def narrate(self, system: str, user: str, *,
                      max_tokens: int = 400) -> str | None:
        """One plain-text sentence about a decision that is already fixed.

        SEPARATE FROM `recommend` ON PURPOSE. That path uses a tool schema because
        it was built to RETURN DECISIONS, and a tool call is how you constrain the
        shape of a decision. This returns prose about a decision somebody else
        made, so there is nothing to constrain structurally - the constraint is
        `narrate.ground`, which checks every numeral against the engine figures and
        throws the whole sentence away if one is unaccounted for.

        FAIL-SOFT TO None, ALWAYS. Every caller falls back to the engine own
        sentence, so an outage, a rate limit or a refusal costs fluency and never a
        recommendation. This is the difference that makes narration safe where
        model-led SELECTION was not: on 29 September 2026 a billing failure
        produced zero recommendations for every store, and nothing like that can
        happen here.
        """
        try:
            response = await self._client.messages.create(
                model=self.model_id(),
                max_tokens=max_tokens,
                system=system,
                messages=[{"role": "user", "content": user}],
            )
        except Exception as exc:  # noqa: BLE001 - prose must never sink a run
            log.warning("narration_failed", error=str(exc))
            return None
        parts = [
            getattr(block, "text", "") for block in (response.content or ())
            if getattr(block, "type", "") == "text"
        ]
        text = " ".join(p.strip() for p in parts if p).strip()
        return text or None

    async def recommend(self, prompt: dict[str, str]) -> list[dict]:
        params = self._build_params(prompt)
        # Stream the call: tokens arrive incrementally so the connection stays
        # alive, avoiding the read-timeout that a long non-streaming request
        # hits (see Anthropic docs on long requests). get_final_message()
        # reassembles the full Message — including the tool_use block.
        try:
            async with self._client.messages.stream(**params) as stream:
                response = await stream.get_final_message()
        except anthropic.APIError as exc:
            raise LLMError(f"Anthropic API error: {exc}") from exc

        usage = response.usage
        log.info(
            "llm_call_complete",
            # Both: what we ASKED for, and what the API resolved it to. An
            # alias moves, so the requested id alone cannot explain a card
            # written months ago - `resolved_model` is the dated snapshot to
            # put in `llm_model_pinned` when freezing a run.
            model=self.model_id(),
            resolved_model=getattr(response, "model", None),
            # What this SDK generation actually exposes in place of
            # temperature. Recorded so a card can still say how it was
            # generated, which is what sheet 15 needed the temperature for.
            effort=self._settings.llm_effort,
            input_tokens=getattr(usage, "input_tokens", None),
            output_tokens=getattr(usage, "output_tokens", None),
            cache_read=getattr(usage, "cache_read_input_tokens", None),
            cache_write=getattr(usage, "cache_creation_input_tokens", None),
            stop_reason=response.stop_reason,
        )
        return _extract_recommendations(response.content, stop_reason=response.stop_reason)

    async def submit_batch(self, prompts: dict[str, dict[str, str]]) -> str:
        """Submit one Message Batch and return its id immediately (no polling)."""
        requests = [
            {"custom_id": cid, "params": self._build_params(prompt)}
            for cid, prompt in prompts.items()
        ]
        try:
            batch = await self._client.messages.batches.create(requests=requests)  # type: ignore[arg-type]
        except anthropic.APIError as exc:
            raise LLMError(f"Anthropic batch create failed: {exc}") from exc
        log.info("batch_submitted", batch_id=batch.id, count=len(requests))
        return batch.id

    async def batch_status(self, batch_id: str) -> tuple[str, dict[str, int]]:
        """Return (processing_status, request_counts) for a submitted batch."""
        try:
            batch = await self._client.messages.batches.retrieve(batch_id)
        except anthropic.APIError as exc:
            raise LLMError(f"Anthropic batch poll failed: {exc}") from exc
        counts = batch.request_counts
        return batch.processing_status, {
            "processing": counts.processing,
            "succeeded": counts.succeeded,
            "errored": counts.errored,
            "canceled": counts.canceled,
            "expired": counts.expired,
        }

    async def collect_batch(self, batch_id: str) -> dict[str, BatchOutcome]:
        """Retrieve and parse every result of an ended batch, keyed by custom_id."""
        outcomes: dict[str, BatchOutcome] = {}
        try:
            async for result in await self._client.messages.batches.results(batch_id):
                outcomes[result.custom_id] = self._parse_batch_result(result)
        except anthropic.APIError as exc:
            raise LLMError(f"Anthropic batch results failed: {exc}") from exc
        log.info(
            "batch_collected",
            batch_id=batch_id,
            succeeded=sum(1 for o in outcomes.values() if o.recommendations is not None),
            errored=sum(1 for o in outcomes.values() if o.error is not None),
        )
        return outcomes

    async def recommend_batch(
        self, prompts: dict[str, dict[str, str]]
    ) -> tuple[str | None, dict[str, BatchOutcome]]:
        """Submit, poll to completion, and collect — the blocking batch path.

        ``prompts`` maps a caller-chosen ``custom_id`` to its prompt. Returns the
        Anthropic batch id (for tracing) and one :class:`BatchOutcome` per
        custom_id — a recommendations list on success or an ``error`` string (a
        per-store failure never sinks the whole run). Polls until the batch ends
        or ``batch_max_wait_seconds`` is hit. Prefer the non-blocking
        submit/status/collect endpoints for long batches — they don't hold an
        HTTP connection open through proxies for the whole processing window.
        """
        if not prompts:
            return None, {}

        batch_id = await self.submit_batch(prompts)

        waited = 0.0
        interval = self._settings.batch_poll_interval_seconds
        status, _counts = await self.batch_status(batch_id)
        while status != "ended":
            if waited >= self._settings.batch_max_wait_seconds:
                raise LLMError(
                    f"Batch {batch_id} did not finish within "
                    f"{self._settings.batch_max_wait_seconds:.0f}s (status={status}). "
                    f"The batch is still processing on Anthropic's side — collect it "
                    f"later via POST /run-recommendations/batch/{batch_id}/collect."
                )
            await asyncio.sleep(interval)
            waited += interval
            status, _counts = await self.batch_status(batch_id)

        return batch_id, await self.collect_batch(batch_id)

    @staticmethod
    def _parse_batch_result(result: Any) -> BatchOutcome:
        result_type = result.result.type
        if result_type != "succeeded":
            return BatchOutcome(error=f"batch result {result_type}")
        message = result.result.message
        try:
            recs = _extract_recommendations(
                message.content, stop_reason=getattr(message, "stop_reason", None)
            )
        except LLMError as exc:
            return BatchOutcome(error=str(exc))
        return BatchOutcome(recommendations=recs)
