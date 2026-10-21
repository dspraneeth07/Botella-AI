"""Tests for the LLM event analyst: the pure merge logic and its fail-soft
wrapper. The canonical shape: a stadium country show and a wine festival are
kept (with draw/key/note and category eligibility), while the puppet show that
would previously have asserted event_nearby is dropped entirely."""

from __future__ import annotations

from types import SimpleNamespace

from app.config import Settings
from app.schemas.signals import EventSignal
from app.signals.event_analyst import analyze, apply_analysis
from app.signals.events import _dedupe_runs, keys_for_events


def _events() -> list[EventSignal]:
    return [
        EventSignal(name="Zach Bryan", venue="Moody Center", date="2026-07-10",
                    category="Music", nights=2),
        EventSignal(name="Puppet Palooza Kids Show", venue="Community Hall",
                    date="2026-07-08", category="Arts & Theatre"),
        EventSignal(name="Hill Country Wine Festival", venue="Fairgrounds",
                    date="2026-07-12", category=None),
    ]


def test_apply_analysis_keeps_only_relevant() -> None:
    items = [
        {"index": 0, "relevant": True, "draw": "major",
         "categories": ["beer", "bourbon", "seltzer"],
         "key": "Zach Bryan @ Moody!", "note": "Country crowd, stock beer cold."},
        {"index": 1, "relevant": False},
        {"index": 2, "relevant": True, "draw": "moderate",
         "categories": ["wine", "sparkling"], "key": "wine_festival"},
    ]
    kept, keys, categories = apply_analysis(_events(), items)

    assert [e.name for e in kept] == ["Zach Bryan", "Hill Country Wine Festival"]
    assert kept[0].draw == "major"
    assert kept[0].key == "event_zach_bryan_moody"  # slugged + event_ prefixed
    assert kept[0].note == "Country crowd, stock beer cold."
    assert kept[0].nights == 2  # fetch-time fields survive the merge
    assert "event_wine_festival" in keys
    # Segment keys recomputed over kept events only: the concert still asserts
    # event_concert/event_nearby, and the wine fest name still trips the
    # festival keyword, but nothing from the dropped puppet show leaks in.
    assert "event_concert" in keys and "event_nearby" in keys
    assert "event_arts" not in keys
    assert categories == ["beer", "bourbon", "seltzer", "sparkling", "wine"]


def test_note_dashes_normalized() -> None:
    items = [{"index": 0, "relevant": True, "draw": "major",
              "note": "Big crowd — stock beer – and ice."}]
    kept, _, _ = apply_analysis(_events(), items)
    assert kept[0].note == "Big crowd, stock beer, and ice."


def test_apply_analysis_filters_junk() -> None:
    items = [
        {"index": 99, "relevant": True},  # out of range
        {"index": 0, "relevant": True, "draw": "colossal",  # bad draw -> default
         "categories": ["beer", "not_a_category"], "key": ""},
    ]
    kept, keys, categories = apply_analysis(_events(), items)
    assert len(kept) == 1
    assert kept[0].draw == "moderate"  # defaulted
    assert kept[0].key == "event_item_0"  # fallback slug
    assert "event_item_0" in keys
    assert categories == ["beer"]  # unknown vocab dropped


def test_kept_sorted_by_draw_then_date_and_capped() -> None:
    events = [
        EventSignal(name=f"Show {i}", date=f"2026-07-{10 + i:02d}", category="Music")
        for i in range(9)
    ]
    items = [
        {"index": i, "relevant": True,
         "draw": "minor" if i < 6 else "major", "key": f"show_{i}"}
        for i in range(len(events))
    ]
    kept, _, _ = apply_analysis(events, items, max_kept=5)
    assert len(kept) == 5
    assert kept[0].draw == "major"
    major_dates = [e.date for e in kept if e.draw == "major"]
    assert major_dates == sorted(major_dates)  # date ascending within a draw tier


def test_dedupe_runs_collapses_multi_night() -> None:
    fetched = [
        EventSignal(name="Zach Bryan", venue="Moody Center", date="2026-07-10"),
        EventSignal(name="Zach Bryan", venue="Moody Center", date="2026-07-11"),
        EventSignal(name="Zach Bryan", venue="Moody Center", date="2026-07-12"),
        EventSignal(name="Zach Bryan", venue="Other Arena", date="2026-07-14"),
    ]
    deduped = _dedupe_runs(fetched)
    assert len(deduped) == 2
    run = next(e for e in deduped if e.venue == "Moody Center")
    assert run.nights == 3
    assert run.date == "2026-07-10"  # earliest date kept (feed is date-sorted)


async def test_analyze_fail_soft_on_error() -> None:
    class _BoomMessages:
        async def create(self, **_: object) -> object:
            raise RuntimeError("api down")

    client = SimpleNamespace(messages=_BoomMessages())
    settings = Settings(node_api_base_url="http://x", anthropic_api_key="x")
    events = _events()
    kept, keys, categories = await analyze(events, client, settings)  # type: ignore[arg-type]
    assert kept == events[: settings.events_max_kept]  # untouched, trimmed to the cap
    assert keys == keys_for_events(kept)  # keyword floor
    assert categories == []


async def test_analyze_parses_tool_block() -> None:
    tool_block = SimpleNamespace(
        type="tool_use",
        input={
            "items": [
                {"index": 2, "relevant": True, "draw": "moderate",
                 "categories": ["wine"], "key": "wine_fest",
                 "note": "Wine crowd all weekend."}
            ]
        },
    )

    class _Messages:
        async def create(self, **kwargs: object) -> object:
            assert kwargs["tool_choice"] == {"type": "tool", "name": "analyze_events"}
            return SimpleNamespace(content=[tool_block])

    client = SimpleNamespace(messages=_Messages())
    settings = Settings(node_api_base_url="http://x", anthropic_api_key="x")
    kept, keys, categories = await analyze(_events(), client, settings)  # type: ignore[arg-type]
    assert [e.name for e in kept] == ["Hill Country Wine Festival"]
    assert kept[0].key == "event_wine_fest"
    assert "event_wine_fest" in keys
    assert categories == ["wine"]


def test_apply_analysis_keys_come_from_kept_events_only() -> None:
    """A dropped event must not leak its key into ACTIVE KEYS or its
    categories into eligibility (12 relevant events, cap 5 -> 5 keys)."""
    events = [
        EventSignal(name=f"Show {i}", venue="Club", date=f"2026-07-{17 + i}")
        for i in range(12)
    ]
    items = [
        {"index": i, "relevant": True, "draw": "major" if i < 5 else "minor",
         "key": f"show_{i}", "categories": ["beer"] if i < 5 else ["wine"]}
        for i in range(12)
    ]
    kept, keys, categories = apply_analysis(events, items, max_kept=5)
    assert len(kept) == 5
    assert [e.key for e in kept] == [f"event_show_{i}" for i in range(5)]
    event_specific = [k for k in keys if k.startswith("event_show_")]
    assert event_specific == [f"event_show_{i}" for i in range(5)]  # no orphans
    assert categories == ["beer"]  # dropped minors' wine never widens eligibility


def test_dedupe_runs_splits_non_adjacent_bookings() -> None:
    # Same generic name + venue three weeks apart is two events, not one
    # "2 nights" run hiding the later date.
    fetched = [
        EventSignal(name="Wine Tasting", venue="The Hall", date="2026-07-03"),
        EventSignal(name="Wine Tasting", venue="The Hall", date="2026-07-24"),
    ]
    deduped = _dedupe_runs(fetched)
    assert [(e.date, e.nights) for e in deduped] == [
        ("2026-07-03", 1), ("2026-07-24", 1),
    ]


def test_dedupe_runs_gap_boundary_and_split_chaining() -> None:
    fetched = [
        EventSignal(name="Show", venue="V", date="2026-07-01"),
        EventSignal(name="Show", venue="V", date="2026-07-03"),  # gap 2 -> merges
        EventSignal(name="Show", venue="V", date="2026-07-07"),  # gap 4 -> splits
        EventSignal(name="Show", venue="V", date="2026-07-08"),  # joins the NEW run
    ]
    deduped = _dedupe_runs(fetched)
    assert [(e.date, e.nights) for e in deduped] == [
        ("2026-07-01", 2), ("2026-07-07", 2),
    ]


def test_dedupe_runs_dateless_entries_still_collapse() -> None:
    # No dates = no adjacency to prove either way; slot conservation wins.
    fetched = [
        EventSignal(name="Show", venue="V", date=None),
        EventSignal(name="Show", venue="V", date=None),
    ]
    deduped = _dedupe_runs(fetched)
    assert len(deduped) == 1
    assert deduped[0].nights == 2
