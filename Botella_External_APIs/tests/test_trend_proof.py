from __future__ import annotations

from app.recommender.prompt_builder import format_trend_proof
from app.recommender.validator import validate_recommendations
from app.schemas.store import TrendProof


def _proof(**overrides) -> TrendProof:
    fields = {
        "term": "buzzballz",
        "stores_selling": 5,
        "avg_weekly_units": 6.3,
        "accelerating_stores": 3,
        "product_name": "BuzzBallz Chocolate Tease 200ml",
        "upc": "854372008021",
        "carried": False,
    }
    fields.update(overrides)
    return TrendProof(**fields)


def _trend_rec(**overrides) -> dict:
    rec = {
        "rank": 1,
        "category": "social_trending",
        "action_type": "stock_new",
        "primary_skus": [],
        "rationale": "BuzzBallz Chocolate Tease 200ml is trending and selling at "
        "5 stores in your state. Order a case to trial it.",
        "signals_cited": ["trend_buzzballz"],
        "confidence": 0.7,
        "valid_through": "2099-01-01",
    }
    rec.update(overrides)
    return rec


# ─── validator: the second sanctioned SKU-less shape ─────────────────────────


def test_skuless_trend_rec_kept_with_reference_upc() -> None:
    out, _ = validate_recommendations(
        [_trend_rec()], [], max_recommendations=10,
        active_signal_keys=["trend_buzzballz"], trend_proof=[_proof()],
    )
    assert len(out) == 1
    assert out[0]["primary_skus"] == []
    # The proof's UPC is stamped so Node's first-seen detector can later
    # observe "the store started carrying it".
    assert out[0]["reference_upc"] == "854372008021"


def test_skuless_trend_rec_coerces_action_to_stock_new() -> None:
    out, _ = validate_recommendations(
        [_trend_rec(action_type="endcap")], [], max_recommendations=10,
        active_signal_keys=["trend_buzzballz"], trend_proof=[_proof()],
    )
    assert out[0]["action_type"] == "stock_new"


def test_skuless_trend_rec_without_matching_proof_is_dropped() -> None:
    # No proof at all, a carried proof, and a proof without a UPC all fail to
    # sanction the SKU-less shape.
    for proofs in ([], [_proof(carried=True)], [_proof(upc=None)]):
        out, _ = validate_recommendations(
            [_trend_rec()], [], max_recommendations=10,
            active_signal_keys=["trend_buzzballz"], trend_proof=proofs,
        )
        assert out == []


def test_skuless_trend_rec_matches_by_cited_key() -> None:
    proofs = [
        _proof(),
        _proof(term="ranch water", product_name="Ranch Water 12pk", upc="123456789012"),
    ]
    rec = _trend_rec(
        rationale="A trending canned cocktail worth stocking.",
        signals_cited=["trend_ranch_water"],
    )
    out, _ = validate_recommendations(
        [rec], [], max_recommendations=10,
        active_signal_keys=["trend_ranch_water"], trend_proof=proofs,
    )
    assert out[0]["reference_upc"] == "123456789012"


def test_skuless_trend_rec_ambiguity_prefers_named_product() -> None:
    proofs = [
        _proof(term="seltzer", product_name="Obscure Seltzer 8pk", upc="111111111111"),
        _proof(term="hard seltzer", product_name="Other Seltzer", upc="222222222222"),
    ]
    rec = _trend_rec(
        rationale="Obscure Seltzer 8pk rides the hard seltzer trend near you.",
        signals_cited=["trend_seltzer", "trend_hard_seltzer"],
    )
    out, _ = validate_recommendations(
        [rec], [], max_recommendations=10,
        active_signal_keys=["trend_seltzer", "trend_hard_seltzer"], trend_proof=proofs,
    )
    assert out[0]["reference_upc"] == "111111111111"


# ─── prompt: TREND PROOF section ─────────────────────────────────────────────


def test_format_trend_proof_orders_strongest_first() -> None:
    proofs = [
        _proof(term="quiet", stores_selling=0, avg_weekly_units=None,
               accelerating_stores=None, product_name=None, upc=None),
        _proof(term="thin", stores_selling=2, avg_weekly_units=None,
               accelerating_stores=None, product_name=None, upc=None),
        _proof(term="buzzballz"),
    ]
    text = format_trend_proof(proofs)
    lines = text.splitlines()
    assert lines[0].startswith("- buzzballz: selling at 5 stores in this state")
    assert "~6.3 units/wk each, 3 accelerating this week" in lines[0]
    assert "NOT CARRIED at this store (top seller: BuzzBallz Chocolate Tease 200ml)" in lines[0]
    assert lines[1] == "- thin: selling at 2 nearby stores (too few for averages)"
    assert lines[2] == "- quiet: no matching sales at nearby stores yet (online buzz only)"


def test_format_trend_proof_carried_shows_local_rate() -> None:
    text = format_trend_proof([
        _proof(carried=True, this_store_sku="SKU9", this_store_weekly_units=2.5),
    ])
    assert "CARRIED here as SKU:SKU9, ~2.5/wk here" in text
