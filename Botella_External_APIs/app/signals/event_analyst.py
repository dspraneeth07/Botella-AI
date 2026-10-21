"""LLM event analyst: keep only events that matter to a liquor store.

The raw Ticketmaster feed is indiscriminate: a children's puppet show, a
business expo, and a stadium country show all land in the prompt (and in the
store owner's "active signals" view) as an equally weighted name + date. This
module runs one small, cheap tool-use call (Haiku by default) over the fetched
events and returns structured analysis per event:

* ``relevant``: does this event plausibly move liquor-store demand nearby
  (drinking-age crowd, pre/post-event purchases, tailgating, watch parties)?
  Irrelevant events are dropped entirely: they stop widening candidate
  eligibility and stop appearing in the prompt and the signal snapshot.
* ``draw``: crowd-size judgment (major/moderate/minor) from the act, venue,
  and number of nights, so a stadium run outranks a bar gig.
* ``categories``: canonical category tokens (same vocabulary the categorizer
  emits) whose demand the event lifts; they widen candidate eligibility
  exactly like mapped signal keys do.
* ``key`` / ``note``: a citable snake_case signal key and a one-line
  so-what, both surfaced on the EVENT line in the prompt.

The analysis runs inside the per-geo signal cache, so it costs one Haiku call
per store area per TTL (~6h), and it is fail-soft: any error falls back to the
untouched segment-keyword pipeline, never sinking a run.
"""

from __future__ import annotations

import re
from typing import Any

from anthropic import AsyncAnthropic

from app.config import Settings
from app.logging_config import get_logger
from app.schemas.signals import EventSignal
from app.signals.events import keys_for_events
from app.store_data.categorize import family_members

log = get_logger(__name__)

_TOOL_NAME = "analyze_events"
_DRAWS = ("major", "moderate", "minor")
_DRAW_RANK = {d: i for i, d in enumerate(_DRAWS)}
_KEY_SHAPE = re.compile(r"[^a-z0-9_]+")
# Notes reach the owner (prompt line + frontend snapshot); em/en dashes are
# banned from all user-facing and AI-generated text in this product.
_DASHES = re.compile(r"\s*[–—]\s*")


def _clean_note(raw: str | None) -> str | None:
    return _DASHES.sub(", ", (raw or "").strip()) or None


def _vocabulary() -> list[str]:
    cats = family_members("beer") | family_members("wine") | family_members("spirits")
    return sorted(cats | {"beer", "wine", "spirits"})


def _build_tool() -> dict[str, Any]:
    return {
        "name": _TOOL_NAME,
        "description": "Report which nearby events affect liquor-store demand, and how.",
        "input_schema": {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "index": {
                                "type": "integer",
                                "description": "0-based index of the event being classified.",
                            },
                            "relevant": {"type": "boolean"},
                            "draw": {
                                "type": "string",
                                "enum": list(_DRAWS),
                                "description": "Crowd size: major = stadium/arena/"
                                "festival scale, moderate = mid-size venue or "
                                "multi-night club run, minor = small room.",
                            },
                            "categories": {
                                "type": "array",
                                "items": {"type": "string", "enum": _vocabulary()},
                                "description": "Product categories whose demand this "
                                "event lifts.",
                            },
                            "key": {
                                "type": "string",
                                "description": "Short snake_case signal key, "
                                "e.g. event_zach_bryan_moody_center.",
                            },
                            "note": {
                                "type": "string",
                                "description": "One short sentence: who the crowd is "
                                "and what the store should stock or feature for it.",
                            },
                        },
                        "required": ["index", "relevant"],
                    },
                }
            },
            "required": ["items"],
        },
    }


_SYSTEM = """You screen nearby events for a US liquor store's recommendation \
engine. The store sells beer, wine, and spirits for off-premise consumption; \
event demand comes from pre-gaming, tailgating, post-show stops, and watch or \
after parties at homes and hotels near the venue. Every listed event is \
already within a short drive of the store, so relevance is about the CROWD, \
not fame: mark relevant any event that gathers a drinking-age crowd — \
concerts and club shows (a working music venue's nightly crowd pre-games and \
stops nearby even when the act is unknown), festivals and fairs, pro or \
college sports, food and drink events, touring theater and comedy with an \
adult evening audience, big nightlife happenings. Drop only events whose \
crowd does not buy drinks: children's and family shows, school and church \
events, daytime expos and business conferences, lectures. Judge draw by venue \
scale and run length, not name recognition: major = stadium, arena, \
amphitheater, or festival scale; moderate = mid-size hall, touring \
production, or multi-night club run; minor = a single club or bar-room \
night, still worth keeping. Several shows near the store on the same night \
lift demand together; keep the strongest of them. For relevant events give \
the categories the crowd actually buys (a country stadium show skews \
beer/bourbon/seltzer; a wine festival skews wine/sparkling; theater skews \
wine), a snake_case key, and a one-line note telling the owner who is coming \
and what to have ready."""


def _payload(events: list[EventSignal]) -> str:
    lines = []
    for i, e in enumerate(events):
        nights = f" ({e.nights} nights)" if e.nights > 1 else ""
        dist = f", {e.distance_mi} mi away" if e.distance_mi is not None else ""
        seg = f" [{e.category}]" if e.category else ""
        lines.append(
            f"[{i}]{seg} {e.name} at {e.venue or 'venue n/a'} on "
            f"{e.date or 'date n/a'}{nights}{dist}"
        )
    return "Nearby events:\n" + "\n".join(lines) + "\n\nClassify each via the analyze_events tool."


def _slug(raw: str | None, fallback: str) -> str:
    slug = _KEY_SHAPE.sub("_", (raw or "").strip().lower()).strip("_")
    slug = slug or fallback
    return slug if slug.startswith("event_") else f"event_{slug}"


def apply_analysis(
    events: list[EventSignal], items: list[dict], *, max_kept: int = 5
) -> tuple[list[EventSignal], list[str], list[str]]:
    """Pure merge of analyst output into the signals (testable without a client).

    Returns (relevant events only, biggest draw first; keys; categories).
    Events the analyst does not mark relevant are DROPPED: they no longer emit
    eligibility keys, and they disappear from the prompt and the snapshot.
    """
    vocabulary = set(_vocabulary())
    kept: list[EventSignal] = []
    kept_categories: list[set[str]] = []

    for item in items:
        index = item.get("index")
        if not isinstance(index, int) or not 0 <= index < len(events):
            continue
        if not item.get("relevant"):
            continue
        draw = item.get("draw")
        if draw not in _DRAWS:
            draw = "moderate"
        key = _slug(item.get("key"), fallback=f"event_item_{index}")
        kept.append(
            events[index].model_copy(
                update={
                    "draw": draw,
                    "key": key,
                    "note": _clean_note(item.get("note")),
                }
            )
        )
        kept_categories.append(
            {c for c in item.get("categories") or [] if c in vocabulary}
        )

    order = sorted(
        range(len(kept)),
        key=lambda i: (_DRAW_RANK.get(kept[i].draw or "", 99), kept[i].date or "9999"),
    )[:max_kept]
    kept = [kept[i] for i in order]
    categories: set[str] = set().union(*(kept_categories[i] for i in order), set())
    # Keys and categories come from the KEPT events only — a dropped event
    # must not leave an orphan key in ACTIVE KEYS (no prompt line to back it)
    # or widen eligibility. Segment keys are likewise recomputed over the
    # kept list, so an irrelevant event no longer asserts event_nearby;
    # analyst keys merge on top so each kept event stays individually citable.
    keys = sorted(set(keys_for_events(kept)) | {e.key for e in kept if e.key})
    return kept, keys, sorted(categories)


async def analyze(
    events: list[EventSignal],
    client: AsyncAnthropic,
    settings: Settings,
) -> tuple[list[EventSignal], list[str], list[str]]:
    """Run the analyst over fetched events; fail-soft to the keyword pipeline.

    On any error the (broad) fetch is trimmed to the normal cap and keyed by
    segment exactly as if the analyst were disabled.
    """
    if not events:
        return events, [], []
    params: dict[str, Any] = {
        "model": settings.events_llm_model,
        "max_tokens": settings.events_llm_max_tokens,
        "system": _SYSTEM,
        "messages": [{"role": "user", "content": _payload(events)}],
        "tools": [_build_tool()],
        "tool_choice": {"type": "tool", "name": _TOOL_NAME},
    }
    try:
        response = await client.messages.create(**params)
        # A response truncated at max_tokens loses the tool input silently
        # (empty dict), which reads as "no relevant events" — surface it.
        if getattr(response, "stop_reason", None) == "max_tokens":
            log.warning(
                "event_analysis_truncated", max_tokens=settings.events_llm_max_tokens
            )
        tool_block = next(
            (b for b in response.content if getattr(b, "type", None) == "tool_use"), None
        )
        items = (tool_block.input or {}).get("items", []) if tool_block else []
        if not isinstance(items, list):
            items = []
    except Exception as exc:  # noqa: BLE001 - optional enrichment must never sink a run
        log.warning("event_analysis_failed", error=str(exc))
        trimmed = events[: settings.events_max_kept]
        return trimmed, keys_for_events(trimmed), []

    kept, keys, categories = apply_analysis(events, items, max_kept=settings.events_max_kept)
    log.info(
        "events_analyzed",
        fetched=len(events),
        kept=len(kept),
        keys=keys,
        categories=categories,
    )
    return kept, keys, categories
