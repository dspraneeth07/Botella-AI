"""N7.1 — the slate as a portfolio under a budget, and the right to issue nothing.

An owner with $2,000 of free cash receiving $8,000 of advice does not simply get
less than they were offered: THE ENGINE'S RANKING IS OVERRIDDEN, by whoever reads
the page, on a criterion nobody recorded.
"""

from __future__ import annotations

from datetime import date

import pytest

from app.pipeline.context import RunContext
from app.pipeline.rank.portfolio import (
    CASH_BUDGET,
    MIN_EXPECTED_NET,
    SHELF_BUDGET_UNITS,
    PortfolioCandidate,
    choose_portfolio,
    top_k_by_expected_net,
)
from app.pipeline.registry import cfg

AS_OF = date(2026, 3, 31)


def ctx(**over) -> RunContext:
    base = {
        "run_id": "run-n71", "tenant_id": 1, "store_id": 171, "as_of": AS_OF,
        "snapshot_id": "snap-1", "config_version": "default", "seed": 0,
        "versions": {"portfolio": "1.0.0"},
    }
    return RunContext(**{**base, **over})


def cand(sku: str, *, units=10.0, margin=5.0, p=0.8, holding=2.0,
         cash=100.0, shelf=None) -> PortfolioCandidate:
    return PortfolioCandidate(
        sku=sku, family="reorder", units_at_stake=units, unit_margin=margin,
        calibrated_confidence=p, holding_cost_if_unsold=holding,
        cash_required=cash,
        units_required=units if shelf is None else shelf,
    )


# ── The budget binds ─────────────────────────────────────────────────────────


def test_slate_respects_cash_budget() -> None:
    """Five cards at $300 each against $1,000 of cash takes three, not five."""
    offered = [cand(f"sku{i}", cash=300.0) for i in range(5)]
    slate = choose_portfolio(offered, ctx(), cash_budget=1000.0,
                             shelf_budget_units=10_000)

    assert slate.coverage == 3
    assert slate.cash_committed == pytest.approx(900.0)
    assert slate.cash_committed <= slate.cash_budget
    assert len(slate.skipped) == 2
    assert all("over_cash_budget" in reason for _, reason in slate.skipped)
    # And the budget it assumed is on the slate for the owner to disagree with.
    assert any("1,000" in a for a in slate.assumptions())
    assert any("declared, not measured" in a for a in slate.assumptions())


def test_slate_respects_shelf_budget() -> None:
    """Cheap stock passes the cash budget and can still not fit on the shelf."""
    offered = [cand(f"sku{i}", cash=10.0, units=500.0, shelf=500.0)
               for i in range(4)]
    slate = choose_portfolio(offered, ctx(), cash_budget=100_000.0,
                             shelf_budget_units=1200.0)
    assert slate.coverage == 2
    assert slate.units_committed == pytest.approx(1000.0)
    assert any("over_shelf_budget" in reason for _, reason in slate.skipped)


def test_a_zero_cash_card_is_free_and_ranks_first() -> None:
    """A bundle or a merchandising move can earn margin without an order, so it
    has no finite ratio and is taken ahead of anything that costs money."""
    free = cand("free", cash=0.0, margin=1.0, units=5.0)
    paid = cand("paid", cash=500.0, margin=20.0, units=50.0)
    slate = choose_portfolio([paid, free], ctx(), cash_budget=500.0,
                             shelf_budget_units=10_000)
    assert slate.chosen[0].sku == "free"
    assert slate.coverage == 2


def test_nothing_is_dropped_silently() -> None:
    """Everything offered is either chosen or skipped WITH A REASON."""
    offered = [cand(f"sku{i}", cash=400.0) for i in range(5)]
    slate = choose_portfolio(offered, ctx(), cash_budget=800.0,
                             shelf_budget_units=10_000)
    assert slate.coverage + len(slate.skipped) == len(offered)
    assert slate.offered == len(offered)
    assert all(reason for _, reason in slate.skipped)


# ── Abstention ───────────────────────────────────────────────────────────────


def test_empty_slate_is_a_valid_response() -> None:
    """"Nothing worth doing today" is an ANSWER. Never an error, and the UI must
    not treat it as a failure."""
    # Low confidence and a real holding cost make the expectation negative.
    hopeless = [cand(f"sku{i}", p=0.05, margin=1.0, units=1.0, holding=50.0)
                for i in range(4)]
    slate = choose_portfolio(hopeless, ctx())

    assert slate.abstained is True
    assert slate.coverage == 0
    assert slate.chosen == ()
    assert slate.offered == 4
    assert len(slate.skipped) == 4
    assert all("expected_net_not_positive" in r for _, r in slate.skipped)
    assert "Nothing worth doing today" in slate.explain()
    # It is a valid object, not an exception and not a None.
    assert slate.as_dict()["abstained"] is True
    assert slate.cash_committed == 0.0


def test_abstention_needs_the_downside_term_to_be_possible_at_all() -> None:
    """Without the (1 - p) x holding term nothing is ever negative, and
    abstention could never fire - which would make the whole module decoration."""
    with_downside = cand("x", p=0.05, margin=1.0, units=1.0, holding=50.0)
    without = cand("x", p=0.05, margin=1.0, units=1.0, holding=0.0)
    assert with_downside.expected_net < 0.0
    assert without.expected_net > 0.0


def test_an_empty_candidate_list_abstains_rather_than_failing() -> None:
    slate = choose_portfolio([], ctx())
    assert slate.abstained is True
    assert slate.offered == 0
    assert slate.explain()


def test_a_card_with_no_margin_is_recorded_not_counted() -> None:
    """No cost means no expected value, never an assumed one - and the card is
    still recorded, because five of ten audited stores send no cost at all."""
    unpriced = PortfolioCandidate(
        sku="nocost", family="reorder", units_at_stake=10.0, unit_margin=None,
        calibrated_confidence=0.9, holding_cost_if_unsold=None,
        cash_required=0.0, units_required=10.0,
    )
    assert unpriced.expected_net is None
    assert unpriced.ratio is None
    slate = choose_portfolio([unpriced], ctx())
    assert slate.abstained is True
    assert slate.skipped[0][1].startswith("no_unit_margin")


# ── Greedy ratio against top-k ───────────────────────────────────────────────


def test_greedy_ratio_beats_top_k_on_net_margin() -> None:
    """Under a budget, score is the wrong sort key.

    One big card at $900 earning $120, against three small ones at $300 earning
    $60 each. Same cash; $180 against $120. Top-k by expected net takes the big
    one because it is individually worth most.
    """
    big = PortfolioCandidate(
        sku="big", family="reorder", units_at_stake=100.0, unit_margin=1.2,
        calibrated_confidence=1.0, holding_cost_if_unsold=0.0,
        cash_required=900.0, units_required=100.0,
    )
    smalls = [
        PortfolioCandidate(
            sku=f"small{i}", family="reorder", units_at_stake=60.0,
            unit_margin=1.0, calibrated_confidence=1.0,
            holding_cost_if_unsold=0.0, cash_required=300.0,
            units_required=60.0,
        )
        for i in range(3)
    ]
    offered = [big, *smalls]

    assert big.expected_net == pytest.approx(120.0)
    assert smalls[0].expected_net == pytest.approx(60.0)

    greedy = choose_portfolio(offered, ctx(), cash_budget=900.0,
                              shelf_budget_units=10_000)
    assert [c.sku for c in greedy.chosen] == ["small0", "small1", "small2"]
    assert greedy.expected_net == pytest.approx(180.0)

    # Top-k by expected net, with the same cash, takes only the big one.
    topk = top_k_by_expected_net(offered, 1)
    assert topk[0].sku == "big"
    topk_net = sum(c.expected_net or 0.0 for c in topk)
    assert topk_net == pytest.approx(120.0)

    assert greedy.expected_net > topk_net, (
        "greedy on ratio must beat top-k on net under a binding budget, or the "
        "sort key change bought nothing"
    )


def test_the_slate_is_byte_identical_on_a_rerun() -> None:
    """Determinism is already a property of the composer and must not be lost."""
    offered = [cand(f"sku{i}", cash=100.0 + i, margin=5.0 - i * 0.1)
               for i in range(8)]
    first = choose_portfolio(offered, ctx(), cash_budget=400.0,
                             shelf_budget_units=10_000)
    second = choose_portfolio(list(reversed(offered)), ctx(),
                              cash_budget=400.0, shelf_budget_units=10_000)
    assert [c.sku for c in first.chosen] == [c.sku for c in second.chosen], (
        "input order must not change the slate"
    )


def test_ties_break_on_sku_not_on_input_order() -> None:
    a = cand("aaa", cash=100.0)
    b = cand("bbb", cash=100.0)
    assert a.ratio == pytest.approx(b.ratio)
    slate = choose_portfolio([b, a], ctx(), cash_budget=100.0,
                             shelf_budget_units=10_000)
    assert [c.sku for c in slate.chosen] == ["aaa"]


# ── Coverage travels with accuracy ───────────────────────────────────────────


def test_coverage_is_published_with_every_accuracy_figure() -> None:
    """An accuracy figure without its coverage is the number a confidence floor
    would game, so the slate cannot report one without the other."""
    offered = [cand(f"sku{i}", cash=300.0) for i in range(5)]
    slate = choose_portfolio(offered, ctx(), cash_budget=1000.0,
                             shelf_budget_units=10_000)
    published = slate.as_dict()

    assert published["coverage"] == slate.coverage == 3
    assert published["offered"] == 5
    # Both numbers, in the same object, always.
    for key in ("coverage", "offered", "abstained", "expected_net",
                "cash_committed", "assumptions"):
        assert key in published
    # And the sentence an owner reads carries both.
    assert "3 of 5 candidates" in slate.explain()


def test_coverage_is_zero_and_still_published_when_abstaining() -> None:
    slate = choose_portfolio([cand("x", p=0.01, margin=1.0, units=1.0,
                                   holding=99.0)], ctx())
    d = slate.as_dict()
    assert d["coverage"] == 0
    assert d["offered"] == 1
    assert d["abstained"] is True


# ── Settings and validation ──────────────────────────────────────────────────


def test_every_setting_is_declared_and_surfaced() -> None:
    c = ctx()
    for setting in (CASH_BUDGET, SHELF_BUDGET_UNITS, MIN_EXPECTED_NET):
        assert setting.status == "PROVISIONAL"
        assert setting.why.strip() and setting.owner.strip()
        assert cfg.get(setting, c) is not None
    # The abstention threshold is ZERO on purpose - see its `why`.
    assert float(cfg.get(MIN_EXPECTED_NET, c)) == 0.0


def test_the_budget_defaults_come_from_the_registry() -> None:
    c = ctx()
    slate = choose_portfolio([cand("x", cash=1.0)], c)
    assert slate.cash_budget == pytest.approx(float(cfg.get(CASH_BUDGET, c)))
    assert slate.shelf_budget_units == pytest.approx(
        float(cfg.get(SHELF_BUDGET_UNITS, c)))


def test_negative_inputs_are_refused_at_construction() -> None:
    with pytest.raises(ValueError, match="cash_required"):
        cand("x", cash=-1.0)
    with pytest.raises(ValueError, match="units_at_stake"):
        cand("x", units=-5.0)
    with pytest.raises(ValueError, match="calibrated_confidence"):
        cand("x", p=1.5)


def test_expected_net_never_multiplies_a_ratio_by_a_margin() -> None:
    """Only unit counts become dollars. The confidence scales the RESULT, it is
    never the multiplicand of the margin."""
    c = cand("x", units=10.0, margin=5.0, p=1.0, holding=0.0)
    assert c.expected_net == pytest.approx(50.0)      # units x margin
    half = cand("x", units=10.0, margin=5.0, p=0.5, holding=0.0)
    assert half.expected_net == pytest.approx(25.0)   # p x (units x margin)
    # Not p x margin, which would be 2.5.
    assert half.expected_net != pytest.approx(2.5)
