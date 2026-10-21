"""Profit/margin context: cost ingestion, candidate + summary margin, prompt."""

from __future__ import annotations

from app.config import Settings
from app.recommender.prompt_builder import _format_candidate, format_summary
from app.schemas.derived import Candidate, StoreSummary
from app.schemas.signals import SignalBundle
from app.schemas.store import InventoryItem
from app.store_data import compute_derived
from tests.conftest import NOW, item, sale

# ----- cost ingestion + margin_pct ----------------------------------------


def test_cost_coercion_and_margin() -> None:
    it = InventoryItem(sku="A", price=20.0, cost="12.5")  # numeric string coerced
    assert it.cost == 12.5
    assert it.margin_pct == 37.5  # (20 - 12.5) / 20 * 100


def test_cost_absent_is_none_not_zero() -> None:
    it = InventoryItem(sku="A", price=20.0)
    assert it.cost is None
    assert it.margin_pct is None  # unknown, not 100%


def test_blank_cost_is_none() -> None:
    assert InventoryItem(sku="A", price=10.0, cost="").cost is None


def test_margin_none_when_price_zero() -> None:
    assert InventoryItem(sku="A", price=0.0, cost=5.0).margin_pct is None


# ----- flows into candidates + summary ------------------------------------


def _ctx(inventory: list[InventoryItem], sales: list) -> object:
    return compute_derived(
        store=None,  # type: ignore[arg-type]  (compute_derived only passes it through)
        signals=SignalBundle(),
        inventory=inventory,
        sales=sales,
        now=NOW,
        candidate_pool_size=50,
    )


def test_candidate_carries_margin_and_degrades() -> None:
    ctx = _ctx(
        [item("A", price=20.0, cost=12.0), item("B", price=15.0)],  # B has no cost
        [sale("A", 2, 5), sale("B", 2, 5)],
    )
    by_sku = {c.sku: c for c in ctx.candidates}
    assert by_sku["A"].margin_pct == 40.0
    assert by_sku["B"].margin_pct is None


def test_summary_category_margin_units_weighted() -> None:
    # Same category, different margins; A sells 3x more, so it dominates.
    ctx = _ctx(
        [
            item("A", category="beer", price=10.0, cost=8.0),   # 20% margin, 30 units
            item("B", category="beer", price=10.0, cost=5.0),   # 50% margin, 10 units
        ],
        [sale("A", 2, 30), sale("B", 2, 10)],
    )
    m = ctx.summary.category_margin_pct["beer"]
    # weighted: (20*30 + 50*10) / 40 = 27.5
    assert m == 27.5


def test_summary_margin_empty_without_cost() -> None:
    ctx = _ctx([item("A", category="beer", price=10.0)], [sale("A", 2, 5)])
    assert ctx.summary.category_margin_pct == {}


# ----- prompt formatting --------------------------------------------------


def test_candidate_line_shows_margin_when_present() -> None:
    c = Candidate(sku="A", product_name="Beer", category="beer", price=20.0, margin_pct=40.0)
    assert "m:40.0%" in _format_candidate(c)


def test_candidate_line_omits_margin_when_absent() -> None:
    c = Candidate(sku="A", product_name="Beer", category="beer", price=20.0)
    assert "m:" not in _format_candidate(c)


def test_summary_prompt_shows_na_without_cost() -> None:
    text = format_summary(StoreSummary())
    assert "CATEGORY MARGIN" in text
    assert "no cost data" in text


def test_system_prompt_mentions_margin_rule() -> None:
    from app.recommender.prompt_builder import build_system_prompt

    sys = build_system_prompt(Settings(node_api_base_url="http://n", anthropic_api_key="x"))
    assert "margin" in sys.lower()
