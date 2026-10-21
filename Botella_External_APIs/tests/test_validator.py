from __future__ import annotations

from datetime import date

from app.recommender.validator import validate_recommendations
from app.schemas.derived import Candidate

TODAY = date(2026, 6, 3)


def _candidate(sku: str, **overrides: object) -> Candidate:
    fields: dict = {
        "sku": sku,
        "product_name": f"Product {sku}",
        "category": "beer",
    }
    fields.update(overrides)
    return Candidate(**fields)


def _rec(rank: int, skus: list[str], **overrides: object) -> dict:
    rec: dict = {
        "rank": rank,
        "category": "weather",
        "action_type": "endcap",
        "primary_skus": skus,
        "rationale": "because signal",
        "signals_cited": ["heat_advisory"],
        "confidence": 0.8,
        "valid_through": "2026-06-05",
    }
    rec.update(overrides)
    return rec


def _validate(
    raw: list[dict], candidates: list[Candidate], **kwargs: object
) -> tuple[list[dict], int]:
    kwargs.setdefault("active_signal_keys", ["heat_advisory"])
    return validate_recommendations(
        raw,
        candidates,
        max_recommendations=10,
        today=TODAY,
        horizon_days=21,
        **kwargs,  # type: ignore[arg-type]
    )


def test_drops_hallucinated_skus_and_reranks() -> None:
    # Distinct SKUs per rec: cross-rec duplicates are now removed separately
    # (see test_same_sku_never_appears_in_two_recs).
    candidates = [_candidate("REAL1"), _candidate("REAL2"), _candidate("REAL3")]
    raw = [
        _rec(1, ["REAL1"]),
        _rec(2, ["GHOST"]),           # no real sku -> dropped
        _rec(3, ["REAL2", "GHOST"]),  # partial salvage: GHOST stripped, rec kept
        _rec(4, ["REAL3"]),
    ]
    valid, dropped = _validate(raw, candidates)
    assert [r["primary_skus"] for r in valid] == [["REAL1"], ["REAL2"], ["REAL3"]]
    assert [r["rank"] for r in valid] == [1, 2, 3]  # contiguous re-rank
    assert dropped == 1


def test_empty_skus_dropped() -> None:
    candidates = [_candidate("REAL1")]
    valid, dropped = _validate([_rec(1, [])], candidates)
    assert valid == []
    assert dropped == 1


def test_caps_at_max_without_counting_truncation_as_dropped() -> None:
    candidates = [_candidate(f"S{i}") for i in range(20)]
    raw = [_rec(i, [f"S{i}"]) for i in range(20)]
    valid, dropped = _validate(raw, candidates)
    assert len(valid) == 10
    assert valid[-1]["rank"] == 10
    # 10 perfectly valid extra recs are truncated, not "invalid".
    assert dropped == 0


def test_truncation_keeps_the_model_ranked_best() -> None:
    candidates = [_candidate(f"S{i}") for i in range(12)]
    # Emitted out of order: the model's own rank decides who survives the cap.
    raw = [_rec(12 - i, [f"S{i}"]) for i in range(12)]
    valid, _ = _validate(raw, candidates)
    assert len(valid) == 10
    # The two recs the model ranked worst (11, 12 = emitted first) are cut.
    assert [r["primary_skus"][0] for r in valid[:2]] == [["S11"][0], ["S10"][0]]


def test_hallucinated_signal_keys_stripped() -> None:
    candidates = [_candidate("REAL1")]
    raw = [
        _rec(
            1,
            ["REAL1"],
            signals_cited=["heat_advisory", "cinco_de_mayo", "understock", "Eagles game Sunday"],
        )
    ]
    valid, _ = _validate(raw, candidates)
    # cinco_de_mayo is not active -> removed; the active key, the inventory
    # flag, and the free-text citation all survive.
    assert valid[0]["signals_cited"] == ["heat_advisory", "understock", "Eagles game Sunday"]


def test_miscased_citation_is_normalized_not_stripped() -> None:
    candidates = [_candidate("REAL1")]
    valid, _ = _validate(
        [_rec(1, ["REAL1"], signals_cited=["Heat_Advisory"])], candidates
    )
    assert valid[0]["signals_cited"] == ["heat_advisory"]


def test_valid_through_clamped_to_window() -> None:
    candidates = [_candidate(f"REAL{i}") for i in (1, 2, 3, 4)]
    raw = [
        _rec(1, ["REAL1"], valid_through="2027-01-01"),  # far future -> horizon
        _rec(2, ["REAL2"], valid_through="2020-01-01"),  # past -> today
        _rec(3, ["REAL3"], valid_through="not-a-date"),  # junk -> SHORTEST life
        _rec(4, ["REAL4"], valid_through="2026-06-10"),  # in window -> untouched
    ]
    valid, _ = _validate(raw, candidates)
    horizon = "2026-06-24"  # TODAY + 21 days
    # Junk dates get the shortest plausible life (a week), not the horizon: an
    # expiry the model failed to state must not linger on screen for 3 weeks.
    short_life = "2026-06-10"  # TODAY + 7 days
    assert [r["valid_through"] for r in valid] == [
        horizon, TODAY.isoformat(), short_life, "2026-06-10"
    ]


# ─── enum + shape enforcement ────────────────────────────────────────────────


def test_out_of_enum_category_or_action_drops_the_rec() -> None:
    candidates = [_candidate("REAL1")]
    raw = [
        _rec(1, ["REAL1"], category="weathery_vibes"),
        _rec(2, ["REAL1"], action_type="shelf_dance"),
        _rec(3, ["REAL1"]),
    ]
    valid, dropped = _validate(raw, candidates)
    assert len(valid) == 1
    assert dropped == 2


def test_miscased_enum_values_are_normalized() -> None:
    raw = [_rec(1, ["REAL1"], category="Weather", action_type="Cold Box",
                signals_cited=["heat_advisory"])]
    valid, _ = _validate(
        raw, [_candidate("REAL1", velocity_bucket="high")],
        chill_driver_keys={"heat_advisory"},
    )
    assert valid[0]["category"] == "weather"
    assert valid[0]["action_type"] == "cold_box"


def test_empty_rationale_drops_and_bad_confidence_is_neutralized() -> None:
    candidates = [_candidate("REAL1")]
    valid, dropped = _validate([_rec(1, ["REAL1"], rationale="  ")], candidates)
    assert valid == [] and dropped == 1
    valid, _ = _validate([_rec(1, ["REAL1"], confidence="high")], candidates)
    assert valid[0]["confidence"] == 0.5
    valid, _ = _validate([_rec(1, ["REAL1"], confidence=1.7)], candidates)
    assert valid[0]["confidence"] == 1.0


# ─── action coherence ────────────────────────────────────────────────────────


def test_bundle_with_one_real_sku_is_dropped() -> None:
    candidates = [_candidate("REAL1")]
    raw = [_rec(1, ["REAL1", "GHOST"], category="bundle", action_type="bundle")]
    valid, dropped = _validate(raw, candidates)
    assert valid == [] and dropped == 1


def test_markdown_needs_an_overstock_justification() -> None:
    healthy = [_candidate("REAL1")]
    overstocked = [_candidate("REAL1", health_status="overstock_mild")]
    raw = [_rec(1, ["REAL1"], category="inventory_overstock", action_type="markdown",
                signals_cited=[])]
    valid, dropped = _validate([dict(raw[0])], healthy)
    assert valid == [] and dropped == 1
    # Overstocked SKU justifies it even without the flag cited...
    valid, _ = _validate([dict(raw[0])], overstocked)
    assert len(valid) == 1
    # ...and so does citing the flag.
    cited = _rec(1, ["REAL1"], category="inventory_overstock", action_type="liquidate",
                 signals_cited=["overstock_severe"])
    valid, _ = _validate([cited], healthy)
    assert len(valid) == 1


# ─── supply-risk buy-ahead rule (the "import pause tagged Promote" fix) ──────

_SPAIN = {
    "news_spain_wine_pause": {
        "categories": {"wine", "wine_red", "wine_white", "wine_rose"},
        "keywords": {"rioja"},
    }
}


def test_supply_risk_promote_of_affected_product_becomes_pre_stock() -> None:
    wine = [_candidate("W1", category="wine_red", product_name="Rioja Reserva")]
    raw = [_rec(1, ["W1"], category="news", action_type="promote",
                signals_cited=["news_spain_wine_pause"])]
    valid, _ = _validate(
        raw, wine,
        active_signal_keys=["news_spain_wine_pause"], supply_news=_SPAIN,
    )
    assert valid[0]["action_type"] == "pre_stock"


def test_supply_risk_promote_of_substitute_is_allowed() -> None:
    # A bourbon is not what the Spain wine story is about: promoting it as a
    # substitute stays legal.
    bourbon = [_candidate("B1", category="bourbon", product_name="Eagle Rare")]
    raw = [_rec(1, ["B1"], category="news", action_type="promote",
                signals_cited=["news_spain_wine_pause"])]
    valid, _ = _validate(
        raw, bourbon,
        active_signal_keys=["news_spain_wine_pause"], supply_news=_SPAIN,
    )
    assert valid[0]["action_type"] == "promote"


def test_supply_risk_keyword_match_counts_as_affected() -> None:
    # Category resolution missed it, but the story names rioja and so does
    # the product.
    wine = [_candidate("W2", category="uncategorized", product_name="Marques Rioja 750ml")]
    raw = [_rec(1, ["W2"], category="news", action_type="endcap",
                signals_cited=["news_spain_wine_pause"])]
    valid, _ = _validate(
        raw, wine,
        active_signal_keys=["news_spain_wine_pause"], supply_news=_SPAIN,
    )
    assert valid[0]["action_type"] == "pre_stock"


def test_supply_item_without_product_info_coerces_when_only_citation() -> None:
    blank = {"news_pause": {"categories": set(), "keywords": set()}}
    beer = [_candidate("B1")]
    only = _rec(1, ["B1"], category="news", action_type="promote",
                signals_cited=["news_pause"])
    valid, _ = _validate(
        [only], beer, active_signal_keys=["news_pause"], supply_news=blank
    )
    assert valid[0]["action_type"] == "pre_stock"
    # With an independent demand driver cited, the promote stands.
    mixed = _rec(1, ["B1"], category="news", action_type="promote",
                 signals_cited=["news_pause", "heat_advisory"])
    valid, _ = _validate(
        [mixed], beer, active_signal_keys=["news_pause", "heat_advisory"],
        supply_news=blank,
    )
    assert valid[0]["action_type"] == "promote"


# ─── cold_box policy ─────────────────────────────────────────────────────────


def _cold_rec(sku: str, rank: int = 1, confidence: float = 0.8, **overrides: object) -> dict:
    return _rec(rank, [sku], action_type="cold_box", confidence=confidence, **overrides)


def test_cold_box_survives_only_with_all_criteria() -> None:
    fast_beer = [_candidate("B1", velocity_bucket="high")]
    valid, _ = _validate(
        [_cold_rec("B1")], fast_beer, chill_driver_keys={"heat_advisory"}
    )
    assert valid[0]["action_type"] == "cold_box"


def test_cold_box_demoted_without_imminent_driver() -> None:
    fast_beer = [_candidate("B1", velocity_bucket="high")]
    valid, _ = _validate([_cold_rec("B1")], fast_beer, chill_driver_keys=set())
    assert valid[0]["action_type"] == "endcap"


def test_cold_box_demoted_for_non_chilled_products() -> None:
    bourbon = [_candidate("K1", category="bourbon", velocity_bucket="very_high")]
    valid, _ = _validate(
        [_cold_rec("K1")], bourbon, chill_driver_keys={"heat_advisory"}
    )
    assert valid[0]["action_type"] == "endcap"


def test_cold_box_demoted_for_slow_movers() -> None:
    slow_beer = [_candidate("B1", velocity_bucket="low", trend="stable")]
    valid, _ = _validate(
        [_cold_rec("B1")], slow_beer, chill_driver_keys={"heat_advisory"}
    )
    assert valid[0]["action_type"] == "endcap"


def test_cold_box_capped_per_run_keeping_highest_confidence() -> None:
    beers = [
        _candidate("B1", velocity_bucket="high"),
        _candidate("B2", velocity_bucket="high"),
    ]
    raw = [
        _cold_rec("B1", rank=1, confidence=0.6),
        _cold_rec("B2", rank=2, confidence=0.9),
    ]
    valid, _ = _validate(
        raw, beers, chill_driver_keys={"heat_advisory"}, cold_box_max=1
    )
    by_sku = {r["primary_skus"][0]: r["action_type"] for r in valid}
    assert by_sku == {"B1": "endcap", "B2": "cold_box"}


def test_endcap_capped_per_run_demoting_lowest_confidence_to_promote() -> None:
    # Store 171, 2026-08-27: 7 of 14 recs shipped as endcap — more end
    # displays than the store has. Excess endcaps demote to promote.
    candidates = [_candidate("E1"), _candidate("E2"), _candidate("E3")]
    raw = [
        _rec(1, ["E1"], confidence=0.9),
        _rec(2, ["E2"], confidence=0.5),
        _rec(3, ["E3"], confidence=0.7),
    ]
    valid, dropped = _validate(raw, candidates, endcap_max=2)
    assert dropped == 0
    by_sku = {r["primary_skus"][0]: r["action_type"] for r in valid}
    assert by_sku == {"E1": "endcap", "E2": "promote", "E3": "endcap"}


def test_cold_box_overflow_counts_toward_endcap_cap() -> None:
    # A cold_box rec demoted to endcap competes for the endcap slots like any
    # other — the caps compose instead of stacking placements.
    beers = [
        _candidate("B1", velocity_bucket="high"),
        _candidate("B2", velocity_bucket="high"),
        _candidate("E1"),
    ]
    raw = [
        _cold_rec("B1", rank=1, confidence=0.9),
        _cold_rec("B2", rank=2, confidence=0.8),  # over cold_box cap -> endcap
        _rec(3, ["E1"], confidence=0.3),
    ]
    valid, _ = _validate(
        raw, beers, chill_driver_keys={"heat_advisory"},
        cold_box_max=1, endcap_max=1,
    )
    by_sku = {r["primary_skus"][0]: r["action_type"] for r in valid}
    assert by_sku == {"B1": "cold_box", "B2": "endcap", "E1": "promote"}


# ─── empty-shelf placements and duplicate trends ─────────────────────────────


def test_placement_on_stocked_out_sku_coerced_to_reorder() -> None:
    # Store 171: "out of stock for 40 days ... give it a front display"
    # shipped as promote. A shelf with nothing on it cannot be featured.
    out = [_candidate("S1", health_status="stockout")]
    raw = [_rec(1, ["S1"], action_type="promote")]
    valid, dropped = _validate(raw, out)
    assert dropped == 0
    assert valid[0]["action_type"] == "reorder"


def test_placement_on_lost_sale_sku_coerced_to_reorder() -> None:
    bleeding = [_candidate("S1", lost_days_out=40, lost_revenue=373.0)]
    raw = [_rec(1, ["S1"], action_type="endcap")]
    valid, _ = _validate(raw, bleeding)
    assert valid[0]["action_type"] == "reorder"


def test_placement_kept_when_any_sku_has_stock() -> None:
    mixed = [_candidate("S1", health_status="stockout"), _candidate("S2")]
    raw = [_rec(1, ["S1", "S2"], action_type="promote")]
    valid, _ = _validate(raw, mixed)
    assert valid[0]["action_type"] == "promote"


def test_duplicate_trend_recs_dropped_first_kept() -> None:
    # Store 171: three trending picks all riding trend_margarita. One rec
    # per trend; a rec citing a NEW trend stays.
    cands = [_candidate("T1"), _candidate("T2"), _candidate("T3")]
    raw = [
        _rec(1, ["T1"], category="social_trending", action_type="promote",
             signals_cited=["trend_margarita"]),
        _rec(2, ["T2"], category="social_trending", action_type="promote",
             signals_cited=["trend_margarita"]),
        _rec(3, ["T3"], category="social_trending", action_type="promote",
             signals_cited=["trend_espresso_martini"]),
    ]
    valid, dropped = _validate(
        raw, cands,
        active_signal_keys=["trend_margarita", "trend_espresso_martini"],
    )
    assert dropped == 1
    assert [r["primary_skus"][0] for r in valid] == ["T1", "T3"]


# ─── SKU-less area-winner shape ──────────────────────────────────────────────


def _area_rec(**overrides) -> dict:
    rec = {
        "rank": 1,
        "category": "new_arrival",
        "action_type": "stock_new",
        "primary_skus": [],
        "rationale": ("Obscure Seltzer 8pk is selling at three stores near "
                      "you. Order a case to trial it."),
        "signals_cited": ["area_winner", "new_arrival"],
        "confidence": 0.7,
        "valid_through": "2099-01-01",
    }
    rec.update(overrides)
    return rec


def _winner(name: str, upc: str, carried: bool = False):
    from app.schemas.store import AreaWinner

    return AreaWinner(upc=upc, product_name=name, carried=carried, store_count=2)


def test_skuless_area_winner_rec_is_kept_when_it_names_a_winner() -> None:
    out, _ = validate_recommendations(
        [_area_rec()], [], max_recommendations=10,
        area_winners=[_winner("Obscure Seltzer 8pk", "0444")],
    )
    assert len(out) == 1
    assert out[0]["primary_skus"] == []
    assert out[0]["reference_upc"] == "0444"


def test_skuless_rec_without_area_winner_citation_is_dropped() -> None:
    out, _ = validate_recommendations(
        [_area_rec(signals_cited=["new_arrival"])], [], max_recommendations=10,
        area_winners=[_winner("Obscure Seltzer 8pk", "0444")],
    )
    assert out == []


def test_skuless_rec_wrong_category_is_dropped() -> None:
    out, _ = validate_recommendations(
        [_area_rec(category="bundle")], [], max_recommendations=10,
        area_winners=[_winner("Obscure Seltzer 8pk", "0444")],
    )
    assert out == []


def test_area_rec_with_invented_sku_keeps_rec_but_strips_sku() -> None:
    # The model often puts the UPC in primary_skus; it must not leak downstream.
    out, _ = validate_recommendations(
        [_area_rec(primary_skus=["0812066021123"])], [], max_recommendations=10,
        area_winners=[_winner("Obscure Seltzer 8pk", "0444")],
    )
    assert len(out) == 1
    assert out[0]["primary_skus"] == []


def test_area_rec_gets_reference_upc_by_name_match() -> None:
    winners = [_winner("Obscure Seltzer 8pk", "0444"), _winner("Local Amaro", "0555")]
    out, _ = validate_recommendations(
        [_area_rec(rationale="Obscure Seltzer 8pk is selling well nearby. Try a case.")],
        [], max_recommendations=10, area_winners=winners,
    )
    assert out[0]["reference_upc"] == "0444"


def test_area_rec_sole_winner_fallback_needs_a_name_token() -> None:
    winners = [_winner("Local Amaro", "0555"), _winner("Carried Thing", "0666", carried=True)]
    # Shares the distinctive token "amaro" -> the sole not-carried winner is
    # what the model meant.
    out, _ = validate_recommendations(
        [_area_rec(rationale="An amaro from a nearby store is worth trialing.")],
        [], max_recommendations=10, area_winners=winners,
    )
    assert out[0]["reference_upc"] == "0555"
    # No shared token: the pick is unverifiable (possibly a hallucinated
    # product) and stamping the UPC would poison the measured track record.
    out, dropped = validate_recommendations(
        [_area_rec(rationale="A promising nearby product is worth trialing.")],
        [], max_recommendations=10, area_winners=winners,
    )
    assert out == [] and dropped == 1


def test_area_rec_ambiguous_name_prefers_most_specific() -> None:
    winners = [_winner("99 Guava", "0111"), _winner("99 Guava Liquor 50ml", "0222")]
    out, _ = validate_recommendations(
        [_area_rec(rationale="99 Guava Liquor 50ml is moving fast at a nearby store.")],
        [], max_recommendations=10, area_winners=winners,
    )
    assert out[0]["reference_upc"] == "0222"


def test_area_rec_without_winners_is_dropped() -> None:
    # No area winners in the context = there were no AREA WINNERS lines in the
    # prompt, so a rec citing one is hallucinated.
    out, dropped = validate_recommendations([_area_rec()], [], max_recommendations=10)
    assert out == [] and dropped == 1


def test_carried_only_winners_never_sanction_a_skuless_pick() -> None:
    winners = [_winner("Carried Thing", "0666", carried=True)]
    out, dropped = validate_recommendations(
        [_area_rec(rationale="Carried Thing is doing well nearby.")],
        [], max_recommendations=10, area_winners=winners,
    )
    assert out == [] and dropped == 1


def test_skuless_area_rec_action_type_is_coerced_to_stock_new() -> None:
    out, _ = validate_recommendations(
        [_area_rec(action_type="promote")], [], max_recommendations=10,
        area_winners=[_winner("Obscure Seltzer 8pk", "0444")],
    )
    assert out[0]["action_type"] == "stock_new"
    assert out[0]["reference_upc"] == "0444"


# ---- One-number rule: quantity enforcement against the canonical engine ----


def _buy_rec(rank: int, sku: str, action: str, hint: str | None) -> dict:
    return _rec(rank, [sku], action_type=action, category="inventory_understock",
                signals_cited=["understock"], quantity_hint=hint)


def test_quantity_hint_quoting_canonical_qty_is_kept() -> None:
    candidates = [_candidate("REAL1")]
    raw = [_buy_rec(1, "REAL1", "reorder", "order 45 units before Friday")]
    valid, _ = _validate(raw, candidates, canonical_qty={"REAL1": (45, 15)})
    assert valid[0]["quantity_hint"] == "order 45 units before Friday"
    assert valid[0]["suggested_order_qty"] == 45


def test_quantity_hint_with_wrong_number_is_rewritten() -> None:
    candidates = [_candidate("REAL1")]
    raw = [_buy_rec(1, "REAL1", "reorder", "order 3 to 4 dozen")]
    valid, _ = _validate(raw, candidates, canonical_qty={"REAL1": (45, 15)})
    assert "45 units" in valid[0]["quantity_hint"]
    assert valid[0]["suggested_order_qty"] == 45


def test_case_language_is_rewritten_even_with_right_number() -> None:
    # No pack data exists anywhere, so "cases" can never be grounded.
    candidates = [_candidate("REAL1")]
    raw = [_buy_rec(1, "REAL1", "pre_stock", "order 45 units, about 7 cases")]
    valid, _ = _validate(raw, candidates, canonical_qty={"REAL1": (45, 15)})
    assert "case" not in valid[0]["quantity_hint"].lower()
    assert "45 units" in valid[0]["quantity_hint"]


def test_reorder_dropped_when_engine_says_nothing_to_order() -> None:
    candidates = [_candidate("REAL1"), _candidate("REAL2")]
    raw = [
        _buy_rec(1, "REAL1", "reorder", "order 20 units"),   # engine: 0 -> drop
        _buy_rec(2, "REAL2", "reorder", "order 12 units"),   # engine: 12 -> keep
    ]
    valid, _ = _validate(raw, candidates,
                      canonical_qty={"REAL1": (0, 21), "REAL2": (12, 21)})
    assert [r["primary_skus"] for r in valid] == [["REAL2"]]
    assert valid[0]["rank"] == 1  # re-ranked contiguously after the drop


def test_pre_stock_survives_zero_engine_qty() -> None:
    # Event uplift is real demand the steady-state engine doesn't model.
    candidates = [_candidate("REAL1")]
    raw = [_buy_rec(1, "REAL1", "pre_stock", "stock up ahead of Saturday")]
    valid, _ = _validate(raw, candidates, canonical_qty={"REAL1": (0, 21)})
    assert len(valid) == 1
    assert "suggested_order_qty" not in valid[0]


def test_sku_unknown_to_engine_is_not_enforced() -> None:
    # Absent from the map = the engine never saw it (or the bridge was down):
    # no basis to rewrite or drop.
    candidates = [_candidate("REAL1")]
    raw = [_buy_rec(1, "REAL1", "reorder", "order a few units")]
    valid, _ = _validate(raw, candidates, canonical_qty={"OTHER": (9, 21)})
    assert valid[0]["quantity_hint"] == "order a few units"


def test_non_buy_actions_are_untouched() -> None:
    candidates = [_candidate("REAL1")]
    raw = [_rec(1, ["REAL1"], action_type="markdown", category="inventory_overstock",
                signals_cited=["overstock_mild"],  # justified per the taxonomy rules
                quantity_hint="mark down 15 to 20 bottles")]
    valid, _ = _validate(raw, candidates, canonical_qty={"REAL1": (45, 15)})
    assert valid[0]["quantity_hint"] == "mark down 15 to 20 bottles"
    assert "suggested_order_qty" not in valid[0]


def test_endcap_hint_with_order_advice_is_enforced() -> None:
    # Store-171 Fireball shape: an endcap rec whose hint gives ordering advice.
    # The figure obeys the same one-number rule as a reorder.
    candidates = [_candidate("REAL1")]
    raw = [_buy_rec(1, "REAL1", "endcap", "Order 20 units right away")]
    valid, _ = _validate(raw, candidates, canonical_qty={"REAL1": (13, 7)})
    assert "13 units" in valid[0]["quantity_hint"]
    assert valid[0]["suggested_order_qty"] == 13


def test_endcap_hint_without_order_language_is_untouched() -> None:
    candidates = [_candidate("REAL1")]
    raw = [_buy_rec(1, "REAL1", "endcap", "move 14 units to the front display")]
    valid, _ = _validate(raw, candidates, canonical_qty={"REAL1": (13, 7)})
    assert valid[0]["quantity_hint"] == "move 14 units to the front display"
    assert "suggested_order_qty" not in valid[0]


def test_endcap_order_advice_stripped_when_nothing_to_order() -> None:
    # Display advice stands; needless buy advice goes.
    candidates = [_candidate("REAL1")]
    raw = [_buy_rec(1, "REAL1", "endcap", "order 20 more units for the display")]
    valid, _ = _validate(raw, candidates, canonical_qty={"REAL1": (0, 21)})
    assert len(valid) == 1
    assert valid[0]["quantity_hint"] is None


def test_pack_phrasing_counts_as_quoting_the_quantity() -> None:
    # A 6pk product's sellable unit IS the pack; "19 six-packs" quotes 19.
    candidates = [_candidate("REAL1")]
    raw = [_buy_rec(1, "REAL1", "reorder", "order 19 six-packs by Friday")]
    valid, _ = _validate(raw, candidates, canonical_qty={"REAL1": (19, 21)})
    assert valid[0]["quantity_hint"] == "order 19 six-packs by Friday"
    assert valid[0]["suggested_order_qty"] == 19


# ---- Batched (multi-SKU) quantity enforcement: the store-171 hole ----------


def _named_candidate(sku: str, name: str) -> Candidate:
    return Candidate(sku=sku, product_name=name, category="spirits")


def test_batched_rec_quoting_every_figure_is_kept() -> None:
    candidates = [_named_candidate("A1", "Lunazul Repo"), _named_candidate("B2", "Taylor BP")]
    raw = [_rec(1, ["A1", "B2"], action_type="reorder", category="inventory_understock",
                signals_cited=["understock"],
                quantity_hint="Order 21 units of Lunazul Repo and 24 units of Taylor BP today")]
    valid, _ = _validate(raw, candidates, canonical_qty={"A1": (21, 21), "B2": (24, 21)})
    assert valid[0]["quantity_hint"].startswith("Order 21 units")


def test_batched_rec_missing_a_figure_is_rebuilt_per_sku() -> None:
    candidates = [_named_candidate("A1", "Lunazul Repo"), _named_candidate("B2", "Taylor BP")]
    raw = [_rec(1, ["A1", "B2"], action_type="reorder", category="inventory_understock",
                signals_cited=["understock"],
                quantity_hint="Order 21 units of Lunazul Repo today")]  # Taylor's 24 missing
    valid, _ = _validate(raw, candidates, canonical_qty={"A1": (21, 21), "B2": (24, 15)})
    hint = valid[0]["quantity_hint"]
    assert "21 units of Lunazul Repo" in hint
    assert "24 units of Taylor BP" in hint


def test_batched_pre_stock_omits_fully_covered_skus_from_rebuild() -> None:
    # The Corazon case: cited alongside real reorders but the engine says it
    # needs nothing - the rebuilt hint must not imply an order for it.
    candidates = [_named_candidate("G4", "G4 Anejo"), _named_candidate("COR", "Corazon Blanco")]
    raw = [_rec(1, ["G4", "COR"], action_type="pre_stock", category="calendar_sports",
                quantity_hint="Order 9 units of G4 Anejo. Corazon is being reordered separately.")]
    valid, _ = _validate(raw, candidates, canonical_qty={"G4": (9, 21), "COR": (0, 21)})
    hint = valid[0]["quantity_hint"]
    # "reordered separately" contains no unit-bound 9?  It does contain "9 units" -
    # but the cross-reference sentence has no enforced number, so the hint is
    # compliant per-figure; the PROMPT rule forbids the phrasing. What must
    # hold here: no rebuild is triggered by the covered SKU, and no order
    # figure is invented for it.
    assert "units of Corazon" not in hint


def test_batched_reorder_all_covered_is_dropped() -> None:
    candidates = [_named_candidate("A1", "X"), _named_candidate("B2", "Y")]
    raw = [_rec(1, ["A1", "B2"], action_type="reorder", category="inventory_understock",
                signals_cited=["understock"], quantity_hint="order 30 units of each")]
    valid, _ = _validate(raw, candidates, canonical_qty={"A1": (0, 21), "B2": (0, 21)})
    assert valid == []


def test_batched_rec_no_suggested_order_qty_stamp() -> None:
    # The scalar field can't represent a batch; it stays reserved for
    # single-SKU picks.
    candidates = [_named_candidate("A1", "X"), _named_candidate("B2", "Y")]
    raw = [_rec(1, ["A1", "B2"], action_type="reorder", category="inventory_understock",
                signals_cited=["understock"], quantity_hint="order 5 units of X and 7 units of Y")]
    valid, _ = _validate(raw, candidates, canonical_qty={"A1": (5, 21), "B2": (7, 21)})
    assert "suggested_order_qty" not in valid[0]



# ---- One product, one recommendation + small-format rationing --------------


def test_same_sku_never_appears_in_two_recs() -> None:
    # Store-171 report: Kentucky Gentleman 375ml showed up in two recs. The
    # best-ranked pick claims the SKU; the later rec loses it (and drops when
    # nothing remains).
    candidates = [_candidate("KG375"), _candidate("OTHER")]
    raw = [
        _rec(1, ["KG375"]),
        _rec(2, ["KG375", "OTHER"]),  # loses KG375, keeps OTHER
        _rec(3, ["KG375"]),           # nothing left -> dropped
    ]
    valid, dropped = _validate(raw, candidates)
    assert [r["primary_skus"] for r in valid] == [["KG375"], ["OTHER"]]
    assert dropped == 1


def _sized_candidate(sku: str, name: str) -> Candidate:
    from storeagent.canonical.size import parse_size_ml

    return Candidate(sku=sku, product_name=name, category="bourbon",
                     size_ml=parse_size_ml(name, None, None))


def test_no_50ml_recommendation_survives() -> None:
    candidates = [
        _sized_candidate("N1", "Jim Beam 50ml"),
        _sized_candidate("N2", "Fireball 50ml"),
        _sized_candidate("B1", "Kentucky Gentleman 375ml"),
    ]
    raw = [
        _rec(1, ["N1"]),        # mini: dropped
        _rec(2, ["N2"]),        # mini: dropped
        _rec(3, ["B1"]),        # full bottle: unaffected
    ]
    valid, dropped = _validate(raw, candidates)
    assert [r["primary_skus"] for r in valid] == [["B1"]]
    assert dropped == 2


def test_mini_paired_with_a_real_bottle_is_still_dropped() -> None:
    # The old per-run cap only counted recs whose skus were ALL minis, so
    # pairing a nip with a real bottle shipped the nip anyway. Any cited mini
    # now drops the whole rec.
    candidates = [
        _sized_candidate("N1", "Jim Beam 50ml"),
        _sized_candidate("B1", "Kentucky Gentleman 375ml"),
    ]
    raw = [_rec(1, ["N1", "B1"])]
    valid, dropped = _validate(raw, candidates)
    assert valid == []
    assert dropped == 1


def test_100ml_is_not_excluded_at_the_50ml_ceiling() -> None:
    # The ceiling is 50ml by configuration; a 100ml stays eligible and is
    # governed by the softer per-run nip cap instead.
    candidates = [_sized_candidate("H1", "Jim Beam 100ml")]
    valid, dropped = _validate([_rec(1, ["H1"])], candidates)
    assert [r["primary_skus"] for r in valid] == [["H1"]]
    assert dropped == 0


def test_at_most_one_register_discovery_rec_per_run() -> None:
    # "Irish cream is hot at 2 of 4 nearby stores" is a measured fact, but a
    # run full of register-anchored picks reads like surveillance. Cap 1;
    # a rec mixing a register key with a genuine social trend doesn't count.
    candidates = [_candidate(f"R{i}") for i in (1, 2, 3)]
    reg_keys = {"trend_irish_cream", "trend_scotch"}
    raw = [
        _rec(1, ["R1"], category="social_trending", action_type="promote",
             signals_cited=["trend_irish_cream"]),
        _rec(2, ["R2"], category="social_trending", action_type="promote",
             signals_cited=["trend_scotch"]),            # 2nd register-anchored: dropped
        _rec(3, ["R3"], category="social_trending", action_type="promote",
             signals_cited=["trend_scotch", "trend_mojito"]),  # mixed: kept
    ]
    valid, dropped = _validate(
        raw, candidates,
        active_signal_keys=["trend_irish_cream", "trend_scotch", "trend_mojito"],
        register_trend_keys=reg_keys,
    )
    assert [r["primary_skus"] for r in valid] == [["R1"], ["R3"]]
    assert dropped == 1
