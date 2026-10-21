from __future__ import annotations

from app.schemas.signals import NewsSignal, SignalBundle, TrendSignal
from app.signals.social import combine, trend_key


def _trend(term: str, source: str = "reddit", **overrides) -> TrendSignal:
    fields = {"term": term, "source": source, "key": trend_key(term)}
    fields.update(overrides)
    return TrendSignal(**fields)


def test_trend_key_slugs_deterministically() -> None:
    assert trend_key("Aperol Spritz") == "trend_aperol_spritz"
    assert trend_key("  BuzzBallz!  ") == "trend_buzzballz"
    assert trend_key("high noon") == trend_key("High  Noon")
    assert trend_key("***") == "trend_unknown"


def test_combine_merges_same_term_across_sources() -> None:
    reddit_signals = [
        _trend("mezcal", mentions=3, score=1200, note="Feature the anejo."),
        _trend("buzzballz", mentions=2, score=800),
    ]
    trends_signals = [
        _trend("mezcal", source="google_trends", momentum="rising", interest=62),
        _trend("ranch water", source="google_trends", momentum="rising", interest=40),
    ]
    merged = combine(reddit_signals, trends_signals)
    assert [s.term for s in merged] == ["mezcal", "buzzballz", "ranch water"]
    mezcal = merged[0]
    # Reddit evidence survives; Google Trends adds momentum on top.
    assert mezcal.source == "reddit+google_trends"
    assert mezcal.mentions == 3 and mezcal.note == "Feature the anejo."
    assert mezcal.momentum == "rising" and mezcal.interest == 62
    # One key per term even when both sources saw it.
    assert len([s for s in merged if s.key == "trend_mezcal"]) == 1


def test_combine_with_one_empty_side() -> None:
    only_reddit = [_trend("gin")]
    assert combine(only_reddit, []) == only_reddit
    only_trends = [_trend("soju", source="google_trends")]
    assert combine([], only_trends) == only_trends


def test_bundle_counts_social_and_cites_trend_keys() -> None:
    bundle = SignalBundle(social=[_trend("mezcal")], active_keys=["trend_mezcal"])
    assert not bundle.is_empty()
    assert bundle._entry_keys("social", 0) == {"trend_mezcal"}
    snap = bundle.snapshot(display_cap=5)
    assert [t["term"] for t in snap["social"]] == ["mezcal"]


def test_snapshot_ranks_buy_ahead_news_above_trends() -> None:
    bundle = SignalBundle(
        social=[_trend("buzzballz", note="Stock it.")],
        news=[
            NewsSignal(headline="Email item", category="industry_email",
                       impact="demand_up", key="email_k"),
            NewsSignal(headline="Analyzed", category="business",
                       impact="supply_risk", key="n0"),
            NewsSignal(headline="Soft", category="top"),
        ],
    )
    # Cap 2: the email item and the supply-risk story survive; the trend and
    # soft news trim. A closing buying window outranks a fading trend.
    snap = bundle.snapshot(display_cap=2)
    assert snap["social"] == []
    assert [n["headline"] for n in snap["news"]] == ["Email item", "Analyzed"]
    # A demand-direction analyzed story still ranks below trends.
    demand = SignalBundle(
        social=[_trend("buzzballz", note="Stock it.")],
        news=[NewsSignal(headline="Analyzed", category="business",
                         impact="demand_up", key="n0")],
    )
    snap = demand.snapshot(display_cap=1)
    assert [t["term"] for t in snap["social"]] == ["buzzballz"]
    assert snap["news"] == []
    # A cited trend entry survives even past the cap.
    tight = bundle.snapshot(display_cap=1, cited_keys={"trend_buzzballz"})
    assert [t["term"] for t in tight["social"]] == ["buzzballz"]
    # Trend eligibility metadata stays complete in the snapshot.
    full = SignalBundle(
        social=[_trend("mezcal")],
        trend_categories=["mezcal"],
        trend_product_keywords=["mezcal"],
    ).snapshot(display_cap=1)
    assert full["trend_categories"] == ["mezcal"]
    assert full["trend_product_keywords"] == ["mezcal"]


def test_cap_by_evidence_keeps_strongest_classes_first() -> None:
    from app.signals.social import cap_by_evidence

    def _t(term, source):
        return TrendSignal(term=term, source=source, key=trend_key(term))

    social = [
        _t("mojito", "reddit"),
        _t("negroni", "youtube"),
        _t("espresso martini", "reddit+google_trends"),
        _t("aperol spritz", "instagram"),
        _t("high noon", "registers"),
        _t("amaro", "reddit"),
    ]
    kept = cap_by_evidence(social, 4)
    assert len(kept) == 4
    # Register-measured first, Instagram second, chatter fills the rest in
    # its upstream order.
    assert [t.term for t in kept] == [
        "high noon", "aperol spritz", "mojito", "negroni",
    ]


def test_cap_by_evidence_untouched_when_within_budget() -> None:
    from app.signals.social import cap_by_evidence

    social = [TrendSignal(term="mojito", source="reddit", key=trend_key("mojito"))]
    assert cap_by_evidence(social, 4) == social


def test_cap_by_evidence_rations_pure_register_entries_to_one() -> None:
    """Four register readings are one metric measured four times: the ration
    keeps the strongest (first) and frees the other slots for genuinely
    different evidence, even when the channel is under the total cap."""
    from app.signals.social import cap_by_evidence

    def _t(term, source):
        return TrendSignal(term=term, source=source, key=trend_key(term))

    social = [
        _t("irish cream", "registers"),
        _t("gin", "registers"),
        _t("tequila", "registers"),
        _t("vodka", "registers"),
    ]
    kept = cap_by_evidence(social, 4, register_max=1)
    assert [t.term for t in kept] == ["irish cream"]


def test_cap_by_evidence_register_merged_entries_do_not_count() -> None:
    """A register row that corroborates a social trend is that trend's proof,
    not another standalone register reading: it survives the ration, and the
    freed slots go to other sources."""
    from app.signals.social import cap_by_evidence

    def _t(term, source):
        return TrendSignal(term=term, source=source, key=trend_key(term))

    social = [
        _t("irish cream", "registers"),
        _t("espresso martini", "twitter+registers"),
        _t("gin", "registers"),
        _t("aperol spritz", "instagram"),
        _t("mojito", "reddit"),
    ]
    kept = cap_by_evidence(social, 4, register_max=1)
    assert [t.term for t in kept] == [
        "irish cream", "espresso martini", "aperol spritz", "mojito",
    ]
