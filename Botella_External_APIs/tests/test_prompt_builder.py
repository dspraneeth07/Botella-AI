from __future__ import annotations

from datetime import date

from app.recommender.prompt_builder import build_prompt, format_candidates
from app.schemas.context import RecommendationContext
from app.schemas.derived import Candidate, StoreSummary
from app.schemas.feedback import CategoryFeedback, CoPurchasePair, FeedbackDigest
from app.schemas.signals import SignalBundle, WeatherSignal
from app.schemas.store import StoreProfile


def _context() -> RecommendationContext:
    return RecommendationContext(
        store=StoreProfile(id=42, name="Test Liquor", city="Austin", state="TX"),
        signals=SignalBundle(
            weather=WeatherSignal(summary="Hot", high_f=95, low_f=70, alerts=["Heat Advisory"]),
            active_keys=["heat_advisory"],
        ),
        velocity={},
        inventory_health=[],
        summary=StoreSummary(category_revenue_pct={"beer": 60.0}, top_movers_30d=["Modelo"]),
        candidates=[
            Candidate(
                sku="0123", product_name="Modelo Especial 12pk", category="beer",
                sub_category="mexican_lager", price=18.99, on_hand=48,
                velocity_bucket="high", trend="rising", weeks_on_hand=2.1,
                health_status="healthy", slice="bestseller",
            ),
        ],
        data_as_of=date(2026, 6, 3),
    )


def test_build_prompt_structure(settings) -> None:
    prompt = build_prompt(_context(), settings)
    assert "recommend_products" in prompt["system"]
    assert "Test Liquor" in prompt["user"]
    assert "WEATHER: Hot" in prompt["user"]
    assert "SKU:0123" in prompt["user"]


def test_candidate_line_format() -> None:
    line = format_candidates(
        [
            Candidate(
                sku="9", product_name="Whispering Angel", category="wine",
                sub_category="rose", price=22.99, on_hand=180, velocity_bucket="low",
                trend="falling", weeks_on_hand=14.2, health_status="overstock_severe",
                weekly_rate=12.68, slice="overstock",
            )
        ]
    )
    assert "SKU:9" in line
    assert "FLAG:overstock_severe" in line  # flagged statuses are surfaced
    assert "wks:14.2" in line
    assert "wk:12.68" in line  # weekly rate grounds quantity_hint arithmetic


def test_system_prompt_clears_cache_floor(settings) -> None:
    # Prompt caching is a prefix match over tools + system (render order is
    # tools -> system -> messages; the breakpoint on the system block caches
    # both). Sonnet 4.6's minimum cacheable prefix is 2,048 tokens, so the
    # combined tools+system prefix must clear it or every store silently pays
    # full price for the prompt. Estimate conservatively at ~4 chars/token: if
    # the floor clears at 4 chars/token it clears at the real (denser) rate too.
    import json

    from app.recommender.llm_client import _build_tool

    system = build_prompt(_context(), settings)["system"]
    tool = _build_tool(settings.max_recommendations, settings.recommendation_floor)
    combined_tokens_est = (len(system) + len(json.dumps(tool))) // 4
    assert combined_tokens_est >= 2048, combined_tokens_est


def test_optional_sections_absent_by_default(settings) -> None:
    user = build_prompt(_context(), settings)["user"]
    assert "FEEDBACK" not in user
    assert "CO-PURCHASE" not in user
    assert "MEASURED TRACK RECORD" not in user


def test_feedback_section_renders(settings) -> None:
    ctx = _context()
    ctx.feedback = FeedbackDigest(
        window_days=30,
        measured_recs=5,
        overall_lift=1.4,
        overall_score=0.62,
        categories=[
            CategoryFeedback(category="weather", recs=3, avg_lift=1.8, avg_score=0.71)
        ],
        high_confidence_lift=1.9,
        low_confidence_lift=0.9,
        loser_skus=["0123", "UNSTOCKED"],
    )
    user = build_prompt(ctx, settings)["user"]
    assert "=== FEEDBACK" in user
    assert "weather: score 0.71 | 1.8x baseline (n=3)" in user
    assert "Confidence calibration" in user
    # Avoid-list resolves names from the candidate pool when it can.
    assert "DID NOT CONVERT" in user
    assert "0123 (Modelo Especial 12pk)" in user
    assert "UNSTOCKED" in user


def test_news_analysis_renders_on_news_line(settings) -> None:
    from app.schemas.signals import NewsSignal

    ctx = _context()
    ctx.signals.news = [
        NewsSignal(
            headline="Tariffs on Spanish imports announced", category="business",
            impact="price_increase_risk", key="news_tariff_spain_wine",
            note="Buy Spanish wine before wholesale prices rise.",
        ),
        NewsSignal(headline="Unanalyzed item", category="general"),
    ]
    user = build_prompt(ctx, settings)["user"]
    assert "[price_increase_risk; key:news_tariff_spain_wine]" in user
    assert "Buy Spanish wine before wholesale prices rise." in user
    assert "NEWS: [general] Unanalyzed item" in user  # soft context, no suffix


def test_news_match_tag_renders() -> None:
    line = format_candidates(
        [
            Candidate(
                sku="R1", product_name="Rioja Reserva", category="wine_red",
                price=24.99, on_hand=12, slice="news_match",
            )
        ]
    )
    assert line.endswith("| NEWS_MATCH")


def test_proven_tag_renders_on_candidate_line() -> None:
    line = format_candidates(
        [
            Candidate(
                sku="7", product_name="Casamigos Blanco", category="tequila",
                price=52.99, on_hand=6, velocity_bucket="high", trend="rising",
                weekly_rate=5.4, slice="proven",
            )
        ]
    )
    assert line.endswith("| PROVEN")


def test_co_purchases_only_render_actionable_pairs(settings) -> None:
    ctx = _context()
    ctx.co_purchases = [
        CoPurchasePair(sku_a="0123", sku_b="0123", support=40),  # both known
        CoPurchasePair(sku_a="0123", sku_b="UNKNOWN", support=99),  # not a candidate
    ]
    user = build_prompt(ctx, settings)["user"]
    assert "=== CO-PURCHASE PAIRS" in user
    assert "40 baskets" in user
    assert "UNKNOWN" not in user  # pairs the model can't act on are dropped


def test_co_purchase_section_omitted_when_no_pair_is_actionable(settings) -> None:
    ctx = _context()
    ctx.co_purchases = [CoPurchasePair(sku_a="X", sku_b="Y", support=99)]
    user = build_prompt(ctx, settings)["user"]
    assert "CO-PURCHASE" not in user


def test_system_prompt_is_owner_friendly_and_em_dash_free(settings) -> None:
    """The system prompt must instruct plain owner-facing language and itself
    contain no em dash (which would model the very style we forbid)."""
    from app.recommender.prompt_builder import build_system_prompt

    sys = build_system_prompt(settings)
    assert "—" not in sys  # no em dash anywhere in what the model reads
    low = sys.lower()
    assert "writing style" in low
    assert "plain" in low and "owner" in low
    # the rule must name the shorthand/flag tokens it forbids in rationale text
    assert "overstock_severe" in sys and "wks" in sys


def test_format_signals_renders_full_bundle_at_caps() -> None:
    """Every signal that makes the bundle renders: at the upstream bounds
    (sports<=8, events<=events_max_kept, news<=3 email+news_max_kept) no line
    is dropped, so no key in ACTIVE KEYS lacks a visible line behind it."""
    from app.recommender.prompt_builder import format_signals
    from app.schemas.signals import EventSignal, GameSignal, NewsSignal

    bundle = SignalBundle(
        weather=WeatherSignal(summary="Sunny", high_f=98, low_f=75),
        sports=[
            GameSignal(league="mlb", home="Astros", away=f"T{i}",
                       date=f"2026-07-{16 + i}", is_local_home=True)
            for i in range(8)
        ],
        events=[
            EventSignal(name=f"Event {i}", date=f"2026-07-{16 + i}",
                        draw="minor", key=f"event_k{i}")
            for i in range(8)
        ],
        news=[
            NewsSignal(headline=f"Item {i}", category="business",
                       impact="demand_up", key=f"news_k{i}")
            for i in range(8)
        ],
        active_keys=["mlb_home_game"],
    )
    out = format_signals(bundle)
    for prefix, expected in (("SPORTS:", 8), ("EVENT:", 8), ("NEWS:", 8)):
        got = sum(1 for line in out.splitlines() if line.startswith(prefix))
        assert got == expected, f"{prefix} rendered {got}, wanted {expected}"


def test_format_signals_orders_news_impact_first() -> None:
    """Unanalyzed soft-context headlines never displace actionable items."""
    from app.recommender.prompt_builder import format_signals
    from app.schemas.signals import NewsSignal

    soft = [NewsSignal(headline=f"Soft {i}", category="top") for i in range(6)]
    email = NewsSignal(headline="Email item", category="industry_email",
                       impact="demand_up", key="email_k")
    analyzed = NewsSignal(headline="Analyzed", category="business",
                          impact="supply_risk", key="news_k")
    # Soft items first in the bundle: ordering, not bundle position, must win.
    bundle = SignalBundle(news=soft + [email, analyzed])
    lines = [line for line in format_signals(bundle).splitlines()
             if line.startswith("NEWS:")]
    # Impact-bearing items lead regardless of where they sat in the list.
    assert "Email item" in lines[0] and "Analyzed" in lines[1]
    assert len(lines) == 8

def test_new_arrival_tags_render_on_candidate_lines() -> None:
    lines = format_candidates(
        [
            Candidate(
                sku="N1", product_name="High Noon Peach 4pk", category="rtd",
                price=11.99, on_hand=18, velocity_bucket="high", trend="rising",
                weekly_rate=6.0, slice="new_hot",
            ),
            Candidate(
                sku="N2", product_name="Obscure Amaro", category="liqueur",
                price=34.99, on_hand=6, slice="new",
            ),
        ]
    ).splitlines()
    assert lines[0].endswith("| NEW_HOT")
    assert lines[1].endswith("| NEW")


def test_system_prompt_covers_new_arrival_category(settings) -> None:
    from app.recommender.prompt_builder import build_system_prompt

    prompt = build_system_prompt(settings)
    assert "new_arrival" in prompt
    assert "NEW_HOT" in prompt


def test_area_winners_section_renders_carried_first() -> None:
    from app.recommender.prompt_builder import format_area_winners
    from app.schemas.store import AreaWinner

    winners = [
        AreaWinner(
            upc="0444", product_name="Obscure Seltzer 8pk", category="rtd",
            store_count=3, same_city_stores=1, avg_weekly_units=6.2,
            days_since_first_seen=12, carried=False,
        ),
        AreaWinner(
            upc="0555", product_name="Local Amaro", category="liqueur",
            store_count=2, avg_weekly_units=4.0, days_since_first_seen=20,
            carried=True, this_store_sku="1234", this_store_on_hand=6,
        ),
    ]
    block = format_area_winners(winners)
    lines = block.splitlines()
    assert "CARRIED here as SKU:1234" in lines[0]  # carried sorts first
    assert "NOT CARRIED at this store" in lines[1]
    assert "3 nearby stores (1 in this city)" in lines[1]
    assert "~6.2/wk" in lines[1]


# ----- MEASURED TRACK RECORD (learning loop, contract §1.4 envelope) --------


def _track_rec(day: str, category: str = "weather", skus: list[str] | None = None, **kw):
    from app.schemas.feedback import PastRecommendation

    return PastRecommendation(
        rec_date=date.fromisoformat(day),
        category=category,
        primary_skus=skus if skus is not None else ["0123"],
        **kw,
    )


def test_track_record_renders_proven_and_avoid_with_measured_evidence(settings) -> None:
    from app.schemas.feedback import EffectivenessEntry, LearnedEffectiveness

    ctx = _context()
    ctx.learned = LearnedEffectiveness(
        proven=[
            EffectivenessEntry(
                sku="0245", name="Casamigos Blanco 750ml", category="calendar_sports",
                evidence="worked 2 of 2 times, avg lift 2.1x",
            )
        ],
        avoid=[
            EffectivenessEntry(
                sku="0788", name=None, category="bundle", evidence="worked 0 of 2 times"
            )
        ],
    )
    user = build_prompt(ctx, settings)["user"]
    assert "=== MEASURED TRACK RECORD" in user
    assert "PROVEN AT THIS STORE" in user
    # Node's measured evidence renders verbatim, never re-derived.
    assert (
        "- 0245 (Casamigos Blanco 750ml, calendar_sports): "
        "worked 2 of 2 times, avg lift 2.1x" in user
    )
    assert "REPEATEDLY MISSED" in user
    # name=None (warehouse slow/unreachable) degrades to sku + category.
    assert "- 0788 (bundle): worked 0 of 2 times" in user
    section = user[user.index("PROVEN AT THIS STORE"):user.index("=== CANDIDATE")]
    assert "None" not in section


def test_track_record_distinguishes_ignored_from_followed_and_failed(settings) -> None:
    ctx = _context()
    ctx.past_recommendations = [
        # Acted on and still underperformed: the idea is disproven -> drop it.
        _track_rec("2026-05-20", category="weather", skus=["0123"],
                   action_taken=True, verdict="underperformer", lift=0.4),
        # Provably never acted on: untested -> repeat only with a hook.
        _track_rec("2026-05-21", category="bundle", skus=["0456"],
                   action_taken=False, verdict="underperformer", lift=0.5),
        # A 'did_not' self-report where the detectors couldn't tell counts too.
        _track_rec("2026-05-22", category="news", skus=["0789"],
                   action_taken=None, action_claim="did_not", verdict="neutral"),
        # 'dismissed' = declined to answer: evidence of nothing, lands nowhere.
        _track_rec("2026-05-23", category="new_arrival", skus=["0111"],
                   action_taken=None, action_claim="dismissed",
                   verdict="underperformer"),
        # insufficient_data = not yet measured, never counted as a failure.
        _track_rec("2026-05-24", category="calendar_sports", skus=["0222"],
                   action_taken=True, verdict="insufficient_data"),
        # Ignored but the SKU won anyway: demand is proven, not a repeat-with-
        # hook case, so it stays out of the ignored list.
        _track_rec("2026-05-25", category="weather", skus=["0333"],
                   action_taken=False, verdict="winner", lift=2.0),
    ]
    user = build_prompt(ctx, settings)["user"]
    failed_at = user.index("FOLLOWED AND FAILED")
    ignored_at = user.index("IGNORED BY THE OWNER")
    failed_block = user[failed_at:ignored_at]
    ignored_block = user[ignored_at:user.index("=== CANDIDATE")]
    # Followed-and-failed: named from the candidate pool, measured lift shown.
    assert (
        "- 2026-05-20 weather: 0123 (Modelo Especial 12pk) "
        "| measured 0.4x baseline" in failed_block
    )
    assert "0456" not in failed_block
    # Ignored: both the detector-false and the did_not-claim recs.
    assert "- 2026-05-21 bundle: 0456 | measured 0.5x baseline" in ignored_block
    assert "- 2026-05-22 news: 0789" in ignored_block
    # dismissed / insufficient_data / ignored-winner recs land in neither list.
    for sku in ("0111", "0222", "0333"):
        assert sku not in user


def test_track_record_caps_lists_and_lift_display(settings) -> None:
    from app.schemas.feedback import EffectivenessEntry, LearnedEffectiveness

    ctx = _context()
    ctx.learned = LearnedEffectiveness(
        proven=[
            EffectivenessEntry(sku=f"P{i}", name=f"Product {i}", category="beer",
                               evidence="worked 2 of 2 times")
            for i in range(12)
        ],
    )
    ctx.past_recommendations = [
        _track_rec(f"2026-05-{10 + i:02d}", skus=[f"F{i}"],
                   action_taken=True, verdict="underperformer", lift=0.5)
        for i in range(7)
    ] + [
        # Stored lift is raw and uncapped; the shown value caps at 5.
        _track_rec("2026-05-25", category="news", skus=["0456"],
                   action_taken=False, verdict="underperformer", lift=47.3),
    ]
    user = build_prompt(ctx, settings)["user"]
    section = user[user.index("=== MEASURED TRACK RECORD"):user.index("=== CANDIDATE")]
    assert section.count("worked 2 of 2 times") == 8  # 12 proven -> capped at 8
    assert "P11" not in section
    # 7 followed-and-failed recs -> capped at 4, newest kept.
    assert sum(1 for line in section.splitlines() if "measured 0.5x" in line) == 4
    assert "F6" in section and "F0" not in section
    assert "measured 5.0x baseline" in section  # 47.3 capped for display
    assert "47.3" not in section


def test_track_record_absent_when_nothing_measured(settings) -> None:
    from app.schemas.feedback import LearnedEffectiveness

    ctx = _context()
    ctx.learned = LearnedEffectiveness()  # empty lists = nothing learned yet
    ctx.past_recommendations = [
        _track_rec("2026-05-20"),  # no measured fields at all (older Node)
        _track_rec("2026-05-21", action_taken=True, verdict="winner", lift=2.2),
    ]
    user = build_prompt(ctx, settings)["user"]
    assert "MEASURED TRACK RECORD" not in user


def test_system_prompt_covers_track_record(settings) -> None:
    from app.recommender.prompt_builder import build_system_prompt

    sys = build_system_prompt(settings)
    assert "MEASURED TRACK RECORD" in sys
    assert "FOLLOWED AND FAILED" in sys
    assert "IGNORED" in sys
    assert "untested rather than disproven" in sys


def test_area_winner_tag_and_stock_new_in_system_prompt(settings) -> None:
    from app.recommender.prompt_builder import build_system_prompt

    prompt = build_system_prompt(settings)
    assert "stock_new" in prompt
    assert "AREA WINNERS" in prompt

    line = format_candidates(
        [
            Candidate(
                sku="1234", product_name="Local Amaro", category="liqueur",
                price=30.0, on_hand=6, slice="area_winner",
            )
        ]
    )
    assert line.endswith("| AREA_WINNER")
