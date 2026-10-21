from __future__ import annotations

import calendar

from app.signals.holidays import _holidays_for_year, _last_weekday, _nth_weekday
from app.signals.mapping import FALLBACK_CATEGORIES, active_categories


def test_active_categories_union() -> None:
    cats = active_categories(["heat_advisory"])
    assert "tequila" in cats and "seltzer" in cats


def test_active_categories_combines_keys() -> None:
    cats = active_categories(["cinco_de_mayo", "cold_snap"])
    assert "tequila" in cats  # from cinco
    assert "bourbon" in cats  # from cold_snap


def test_active_categories_fallback_when_empty() -> None:
    # The fallback expands by family: a quiet day must keep granular tokens
    # (beer_ipa, bourbon, wine_red, ...) eligible, not just the literal
    # "beer"/"wine"/"spirits" strings nothing is categorized as.
    cats = active_categories([])
    assert FALLBACK_CATEGORIES <= cats
    assert {"beer_ipa", "stout", "bourbon", "tequila", "wine_red", "champagne"} <= cats
    assert active_categories(["unknown_key"]) == cats


def test_generic_family_tokens_expand() -> None:
    # nfl_home_game maps to "beer" (among others): every beer-family token —
    # including the IPA wall — must be eligible, not just literal "beer".
    cats = active_categories(["nfl_home_game"])
    assert "beer_ipa" in cats and "beer_ale" in cats and "stout" in cats
    # But families that weren't mapped stay out (no wine on a football key).
    assert "wine_red" not in cats


def test_nth_weekday() -> None:
    # 4th Thursday of November 2026 is Nov 26 (Thanksgiving).
    assert _nth_weekday(2026, 11, calendar.THURSDAY, 4).isoformat() == "2026-11-26"
    # 1st Monday of September 2026 is Sep 7 (Labor Day).
    assert _nth_weekday(2026, 9, calendar.MONDAY, 1).isoformat() == "2026-09-07"


def test_last_weekday() -> None:
    # Last Monday of May 2026 is May 25 (Memorial Day).
    assert _last_weekday(2026, 5, calendar.MONDAY).isoformat() == "2026-05-25"


def test_holiday_keys_are_mapped() -> None:
    from app.signals.mapping import SIGNAL_CATEGORY_MAP

    for key, _name, _day in _holidays_for_year(2026):
        assert key in SIGNAL_CATEGORY_MAP, f"holiday key {key} missing from category map"


def test_snapshot_display_cap_ranks_and_trims() -> None:
    from app.schemas.signals import (
        EventSignal,
        GameSignal,
        HolidaySignal,
        NewsSignal,
        SignalBundle,
        WeatherSignal,
    )

    bundle = SignalBundle(
        weather=WeatherSignal(summary="Hot", high_f=98, low_f=75),
        holidays=[HolidaySignal(name="Labor Day", date="2026-09-07", days_away=20,
                                key="labor_day")],
        sports=[GameSignal(league="mlb", home="Astros", away=f"T{i}",
                           date=f"2026-07-{17 + i}", is_local_home=True)
                for i in range(4)],
        events=[EventSignal(name=f"Event {i}", date=f"2026-07-{17 + i}",
                            draw="major" if i == 3 else "minor", key=f"e{i}")
                for i in range(6)],
        news=(
            [NewsSignal(headline="Email item", category="industry_email",
                        impact="demand_up", key="email_k")]
            + [NewsSignal(headline=f"Analyzed {i}", category="business",
                          impact="supply_risk", key=f"n{i}") for i in range(3)]
            + [NewsSignal(headline="Soft", category="top")]
        ),
        active_keys=["heat_advisory", "email_k"],
    )
    # 1 weather + 1 holiday + 4 sports + 6 events + 5 news = 17 entries total.
    snap = bundle.snapshot(display_cap=10)
    total = (1 if snap["weather"] else 0) + sum(
        len(snap[f]) for f in ("sports", "events", "holidays", "news")
    )
    assert total == 10
    assert snap["weather"] is not None  # weather always survives
    assert len(snap["holidays"]) == 1
    # The single major event survives; minors are the first casualties.
    assert [e["name"] for e in snap["events"]] == ["Event 3"]
    assert len(snap["sports"]) == 4
    # Impact news survives (email first); the soft item is trimmed.
    assert [n["headline"] for n in snap["news"]] == [
        "Email item", "Analyzed 0", "Analyzed 1",
    ]
    # Eligibility record stays complete even when its signal chip is trimmed.
    assert snap["active_keys"] == ["heat_advisory", "email_k"]
    # Uncapped snapshot is untouched.
    full = bundle.snapshot()
    assert len(full["events"]) == 6 and len(full["news"]) == 5


def _trim_bundle():
    """Same 17-entry bundle as the ranking test above (weather + 1 holiday +
    4 mlb games + 6 events + 5 news), for the cited-keys retention tests."""
    from app.schemas.signals import (
        EventSignal,
        GameSignal,
        HolidaySignal,
        NewsSignal,
        SignalBundle,
        WeatherSignal,
    )

    return SignalBundle(
        weather=WeatherSignal(summary="Hot", high_f=98, low_f=75),
        holidays=[HolidaySignal(name="Labor Day", date="2026-09-07", days_away=20,
                                key="labor_day")],
        sports=[GameSignal(league="mlb", home="Astros", away=f"T{i}",
                           date=f"2026-07-{17 + i}", is_local_home=True)
                for i in range(4)],
        events=[EventSignal(name=f"Event {i}", date=f"2026-07-{17 + i}",
                            draw="major" if i == 3 else "minor", key=f"e{i}")
                for i in range(6)],
        news=(
            [NewsSignal(headline="Email item", category="industry_email",
                        impact="demand_up", key="email_k")]
            + [NewsSignal(headline=f"Analyzed {i}", category="business",
                          impact="supply_risk", key=f"n{i}") for i in range(3)]
            + [NewsSignal(headline="Soft", category="top")]
        ),
        active_keys=["heat_advisory", "email_k"],
    )


def _snapshot_total(snap: dict) -> int:
    return (1 if snap["weather"] else 0) + sum(
        len(snap[f]) for f in ("sports", "events", "holidays", "news")
    )


def test_snapshot_trim_always_retains_cited_entries() -> None:
    """Entries cited by a returned recommendation must survive the trim —
    otherwise the citation is orphaned and the UI can only show a bare key.
    Only UNCITED entries are trimmed to make room."""
    bundle = _trim_bundle()
    # Without citations (see the test above) cap 10 drops the minor event
    # "Event 0" and the analyzed news item "Analyzed 2". Citing them flips
    # who gets trimmed.
    snap = bundle.snapshot(display_cap=10, cited_keys={"e0", "n2"})
    assert _snapshot_total(snap) == 10  # the cap still bounds the total
    assert [e["name"] for e in snap["events"]] == ["Event 0", "Event 3"]
    # The cited news item survives; the uncited analyzed items are trimmed.
    assert [n["headline"] for n in snap["news"]] == ["Email item", "Analyzed 2"]
    # Inventory-flag citations (no snapshot entry behind them) are harmless.
    same = bundle.snapshot(display_cap=10, cited_keys={"understock"})
    assert _snapshot_total(same) == 10
    # And no cited keys at all keeps the exact legacy trim.
    legacy = bundle.snapshot(display_cap=10)
    assert "Event 0" not in [e["name"] for e in legacy["events"]]


def test_snapshot_cited_entries_survive_even_past_the_cap() -> None:
    """Cited entries are never sacrificed to the cap: weather is retained via
    any of its three keys, and every game of a cited league's series stays."""
    bundle = _trim_bundle()
    snap = bundle.snapshot(
        display_cap=2, cited_keys={"heat_advisory", "mlb_home_game", "labor_day"}
    )
    assert snap["weather"] is not None
    assert len(snap["sports"]) == 4
    assert len(snap["holidays"]) == 1
    # 6 cited entries beat the cap of 2; nothing uncited squeezed in.
    assert _snapshot_total(snap) == 6
    assert snap["events"] == [] and snap["news"] == []


def test_snapshot_trim_retains_segment_cited_event_entries() -> None:
    """Events are citable via segment-derived keys (event_festival /
    event_concert / event_nearby, see app.signals.events.keys_for_event), not
    just their per-entry analyst key — a citation through any of them must
    protect the backing entry from the trim."""
    bundle = _trim_bundle()
    # A minor festival with no analyst key: previously invisible to the
    # cited-keys match, so the trim would orphan an 'event_festival' citation.
    bundle.events[0] = bundle.events[0].model_copy(
        update={"name": "Riverside Brewfest", "key": None}
    )
    legacy = bundle.snapshot(display_cap=10)
    assert "Riverside Brewfest" not in [e["name"] for e in legacy["events"]]
    snap = bundle.snapshot(display_cap=10, cited_keys={"event_festival"})
    assert "Riverside Brewfest" in [e["name"] for e in snap["events"]]
    assert _snapshot_total(snap) == 10  # only uncited entries were trimmed
    # event_concert resolves through the Ticketmaster segment on ``category``.
    bundle.events[1] = bundle.events[1].model_copy(
        update={"category": "Music", "key": None}
    )
    concert = bundle.snapshot(display_cap=10, cited_keys={"event_concert"})
    assert "Event 1" in [e["name"] for e in concert["events"]]
    # event_nearby resolves to EVERY fetched event — all six survive even past
    # the cap (mirrors the cited-league behavior for a sports series).
    near = bundle.snapshot(display_cap=2, cited_keys={"event_nearby"})
    assert len(near["events"]) == 6
