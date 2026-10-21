"""N7.1 live - one slate under one budget, and the end of the subtraction.

WHAT THE MEASUREMENT SAID BEFORE ANY OF THIS WAS WIRED, because these tests pin
behaviour and the behaviour has to be worth pinning:

    the cash budget binds on       3 of 117 real decision dates
    the abstention floor binds on  0 of 811 cards

Sheet 20's deficit gating already collapsed the ask from $17,043 to $340, so the
module's own premise - $8,000 of advice against $2,000 of cash - is now true only
of the ungated ordering that shipped before it. That is why nothing here claims
an accuracy improvement: what this fixes is WHO CHOOSES when the ask does exceed
the budget, which used to be whoever read the page.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import date

import pytest

from app.recommender.deterministic import Pick
from app.recommender.families import ExtraPick
from app.recommender.slate import (
    UNPRICED_FAMILIES,
    Money,
    candidate_for,
    compose,
    money_from_catalogue,
)
from app.schemas.context import ProductInfo

AS_OF = date(2026, 10, 6)

PICK = Pick(
    sku="SKU1", rank=1, recent_units=12.0, recent_rate=0.43, long_run_rate=3.44,
    reverted_rate=0.92, uplift=2.14, p_hit=0.65, deficit_units=17.0,
    dispersion_cv=0.47, evidence_state="EMERGING", why="because",
    long_run_days_available=365, family="recovering", days_cover=4.0,
    unit_cost=11.50, horizon_open_days=25.7,
)

CHEAP = Money(unit_price=16.0, unit_cost=11.50)


def pick(sku: str, **over) -> Pick:
    return replace(PICK, sku=sku, **over)


def extra(family: str = "bundle") -> ExtraPick:
    return ExtraPick(family=family, category="merchandising",
                     action_type="bundle", skus=("S1", "S2"),
                     rationale="bought together 22 times",
                     signals_cited=(), confidence=0.64)


def slate(picks, extras=(), *, money=None, limit=10, **kw):
    return compose(
        picks, extras,
        money=money if money is not None else {p.sku: CHEAP for p in picks},
        client_id=1, location_id=171, as_of=AS_OF, limit=limit, **kw,
    )


# ── Money: a margin needs BOTH halves, and the sign has to be sane ──────────


def test_a_margin_needs_a_price_and_a_cost() -> None:
    assert Money(unit_price=16.0, unit_cost=11.5).unit_margin == pytest.approx(4.5)
    assert Money(unit_price=16.0).unit_margin is None
    assert Money(unit_cost=11.5).unit_margin is None
    assert Money().unit_margin is None


def test_a_cost_above_the_price_is_a_broken_field_not_a_loss_making_product() -> None:
    """The same rule every money figure in the audit uses (`0 < cost < price`).
    A negative margin here would travel onto a card as evidence that selling the
    product loses money, when the real finding is that one of the two fields is
    wrong."""
    assert Money(unit_price=10.0, unit_cost=12.0).unit_margin is None
    assert Money(unit_price=10.0, unit_cost=10.0).unit_margin is None


def test_a_zero_cost_is_not_a_free_product() -> None:
    """A cost of zero is what a POS sends when it sends nothing. Reading it as
    free would make every margin equal the full shelf price."""
    assert Money(unit_price=10.0, unit_cost=0.0).unit_margin is None


def test_money_comes_off_the_catalogue_for_every_stocked_sku() -> None:
    """Not off `candidates`, which is a shortlist that held 99 of store 171's
    2,691 SKUs - the same mistake the catalogue itself was created to fix."""
    catalogue = {"A": ProductInfo(name="Titos 1L", unit_price=22.0, unit_cost=15.0),
                 "B": ProductInfo(name="Mystery", unit_price=9.0)}
    money = money_from_catalogue(catalogue)
    assert money["A"].unit_margin == pytest.approx(7.0)
    assert money["B"].unit_margin is None
    assert money_from_catalogue({}) == {}


# ── Pricing one card ─────────────────────────────────────────────────────────


def test_the_cash_committed_is_the_ORDER_quantity_not_the_deficit() -> None:
    """Buying 19 to close a gap of 10 commits the cash for 19. The budget charges
    what the owner pays, not what the engine was aiming at."""
    decision = slate([pick("A", deficit_units=17.4)])
    chosen = decision.portfolio.chosen[0]
    assert chosen.units_required == pytest.approx(17.0)
    assert chosen.cash_required == pytest.approx(17.0 * 11.50)
    # ...while the UPSIDE is still measured on the deficit, which is the gap.
    assert chosen.units_at_stake == pytest.approx(17.4)


def test_a_card_that_rounds_below_one_unit_still_costs_a_unit() -> None:
    """Charging the budget $0 for a card the owner will actually pay for would
    let an unbounded number of them through a finite budget."""
    chosen = slate([pick("A", deficit_units=0.2)]).portfolio.chosen[0]
    assert chosen.units_required == pytest.approx(1.0)
    assert chosen.cash_required == pytest.approx(11.50)


def test_the_downside_comes_from_the_module_the_card_publishes_it_from() -> None:
    """One number, not two. If the budget priced being-wrong differently from the
    card, the slate would be allocating against a figure the owner never sees."""
    chosen = slate([pick("A")]).portfolio.chosen[0]
    assert chosen.holding_cost_if_unsold is not None
    assert chosen.holding_cost_if_unsold > 0.0


def test_expected_net_counts_both_terms() -> None:
    """Without the downside nothing is ever negative and abstention can never
    fire, which would make the whole module decoration."""
    chosen = slate([pick("A")]).portfolio.chosen[0]
    gross = 0.65 * 17.0 * 4.5
    assert chosen.expected_net < gross
    assert chosen.expected_net == pytest.approx(
        gross - (1 - 0.65) * chosen.holding_cost_if_unsold)


def test_the_budget_reads_p_hit_and_never_the_display_confidence() -> None:
    """A build guard forbids expected value reading a confidence that has been
    through sheet 08's display curve. The two are different numbers: on the first
    56 pooled outcomes the raw score stated 0.85-0.97 and the curve mapped all of
    them to about 0.65."""
    chosen = slate([pick("A", p_hit=0.33)]).portfolio.chosen[0]
    assert chosen.calibrated_confidence == pytest.approx(0.33)


# ── UNPRICED is an absence, not a refusal ───────────────────────────────────


def test_a_markdown_is_never_valued_by_a_purchase_formula() -> None:
    """A markdown is a DISPOSAL at a cut price. Its worth is freed capital minus
    the margin given up; valuing it at full unit margin would put every markdown
    at the top of the slate on a number that is simply wrong."""
    assert "overstock" in UNPRICED_FAMILIES
    assert candidate_for(pick("A", family="overstock"), CHEAP,
                         _ctx(), ) is None


def test_a_card_with_no_cost_is_kept_rather_than_dropped() -> None:
    """MEASURED, not hypothetical: run as a filter, the portfolio dropped 5 of
    Mango Jo's 229 cards purely because the POS sent no unit cost for those SKUs.
    A data-availability filter wearing a profitability argument is exactly what
    this must not become - and an unpriced card has not FAILED the abstention
    test, because nobody computed an expectation for it."""
    decision = slate([pick("A"), pick("B")],
                     money={"A": CHEAP})       # B has no money at all
    assert decision.unpriced == 1
    assert [p.sku for p in decision.picks] == ["A", "B"]
    assert "B" not in {sku for sku, _ in decision.withheld}


def test_a_store_with_no_cost_data_at_all_gets_no_portfolio_and_every_card() -> None:
    """There is no budget to allocate, so claiming one was honoured would be the
    worst of the three available answers."""
    decision = slate([pick("A"), pick("B")], money={})
    assert decision.portfolio is None
    assert decision.unpriced == 2
    assert len(decision.picks) == 2


# ── The budget, where it binds ───────────────────────────────────────────────


def test_the_budget_stops_the_slate_and_says_so() -> None:
    cheap = {s: CHEAP for s in ("A", "B", "C")}
    decision = slate([pick("A"), pick("B"), pick("C")], money=cheap,
                     cash_budget=400.0)
    assert decision.portfolio.cash_committed <= 400.0
    assert len(decision.picks) < 3
    assert any(r.startswith("over_cash_budget")
               for _, r in decision.withheld)


def test_the_shelf_budget_binds_independently_of_the_cash_one() -> None:
    """Cheap stock passes the cash budget and can still fill a store. Without
    this the cash budget alone permits 3,000 units of anything."""
    decision = slate([pick("A"), pick("B")], cash_budget=100_000.0,
                     shelf_budget_units=20.0)
    assert decision.portfolio.units_committed <= 20.0
    assert any(r.startswith("over_shelf_budget") for _, r in decision.withheld)


def test_an_empty_slate_is_an_answer_and_never_an_error() -> None:
    decision = slate([], [])
    assert decision.abstained is True
    assert decision.total_cards == 0
    assert decision.portfolio is None


def test_a_negative_expectation_is_withheld_with_its_arithmetic() -> None:
    """The abstention floor. Measured at 0 of 811 real cards, which is worth
    knowing and is not a reason to leave it unwired: it is the only check that
    stops a card whose expected profit is negative."""
    hopeless = {"A": Money(unit_price=11.51, unit_cost=11.50)}   # 1c of margin
    decision = slate([pick("A", p_hit=0.02)], money=hopeless)
    assert decision.picks == ()
    assert any(r.startswith("expected_net_not_positive")
               for _, r in decision.withheld)


# ── The subtraction is gone ──────────────────────────────────────────────────


def test_a_signal_card_no_longer_costs_a_reorder_its_slot_by_subtraction() -> None:
    """THE DEFECT. `limit = max_recommendations - len(extra)` meant a heat
    advisory did not make the slate better, it made it one reorder shorter.

    The ceiling still applies to the whole slate - a person can only read so many
    cards - but it is applied ONCE, after the budget has decided how many cards
    the cash supports, instead of being divided up in advance.
    """
    picks = [pick(f"P{i}") for i in range(4)]
    money = {p.sku: CHEAP for p in picks}
    alone = slate(picks, [], money=money, limit=10)
    with_signal = slate(picks, [extra()], money=money, limit=10)
    # Four reorders fit under the ceiling either way: the signal card is NOT
    # paid for out of the stock families' allocation.
    assert len(alone.picks) == len(with_signal.picks) == 4
    assert with_signal.total_cards == 5


def test_the_ceiling_is_a_ceiling_and_the_overflow_is_named() -> None:
    picks = [pick(f"P{i}") for i in range(6)]
    decision = slate(picks, [extra(), extra()],
                     money={p.sku: CHEAP for p in picks}, limit=5)
    assert decision.total_cards == 5
    assert len(decision.extra) == 2
    assert sum(1 for _, r in decision.withheld
               if r.startswith("over_attention_ceiling")) == 3


def test_the_order_is_best_return_per_dollar_first() -> None:
    """Under a budget, score is the wrong sort key. Score answers "which card is
    worth most"; the budget asks "which cards together are worth most for the
    cash available"."""
    money = {"BIG": Money(unit_price=130.0, unit_cost=100.0),   # 0.30 per dollar
             "SMALL": Money(unit_price=14.0, unit_cost=10.0)}   # 0.40 per dollar
    decision = slate([pick("BIG"), pick("SMALL")], money=money)
    assert [p.sku for p in decision.picks] == ["SMALL", "BIG"]


def test_the_same_candidates_produce_the_same_slate_in_any_input_order() -> None:
    """The composer already guarantees a byte-identical rerun and this must not
    lose it."""
    picks = [pick("A"), pick("B"), pick("C")]
    money = {p.sku: CHEAP for p in picks}
    first = slate(picks, money=money, cash_budget=400.0)
    second = slate(list(reversed(picks)), money=money, cash_budget=400.0)
    assert [p.sku for p in first.picks] == [p.sku for p in second.picks]


def test_the_decision_serialises_for_the_run_log() -> None:
    decision = slate([pick("A")])
    payload = decision.as_dict()
    assert payload["cards"] == 1
    assert payload["portfolio"]["cash_budget"] > 0
    assert payload["portfolio"]["assumptions"]
    assert all("declared, not measured" in a
               for a in payload["portfolio"]["assumptions"])


def _ctx():
    from app.pipeline.context import RunContext
    return RunContext(run_id="r", tenant_id=1, store_id=171, as_of=AS_OF,
                      snapshot_id="s", config_version="default", seed=0,
                      versions={"portfolio": "1.0.0"})


# ── The quantity the card ASKS FOR is the quantity the budget is charged ─────
#
# FOUND BY TURNING THE BUDGET ON, on a real store. Marshfield's slate collapsed
# from ten cards to one: a single reorder committed $1,872.75 of a $2,000 cycle
# budget and crowded out nine others, while the card itself said "order 8 units"
# - $66 of stock. `validator._enforce_quantity` overwrites the hint and
# `suggested_order_qty` with the shared demand engine's canonical figure AFTER
# the card is built, so the budget was allocating against a purchase nobody is
# asked to make.


def test_the_canonical_quantity_is_what_the_budget_charges() -> None:
    from app.recommender.slate import order_units

    big = pick("A", deficit_units=227.0)
    assert order_units(big, _ctx()) == pytest.approx(227.0)
    assert order_units(big, _ctx(),
                       canonical_qty={"A": (8, 14)}) == pytest.approx(8.0)


def test_marshfields_collapse_does_not_happen_once_the_quantity_agrees() -> None:
    """The regression, as the numbers that produced it. 227 units of an $8.25
    bottle is $1,872 and eats a $2,000 cycle; 8 units is $66 and leaves room for
    the rest of the slate."""
    money = {s: Money(unit_price=11.36, unit_cost=8.25)
             for s in ("A", "B", "C", "D")}
    # A ranks FIRST, which is what made it fatal: greedy takes the best return
    # per dollar, and with $127 left of $2,000 nothing else fits. A big line that
    # ranks LAST is harmless - the module skips it and carries on, which is why
    # the measured rate of 1-card slates is only 1 in 117 dates.
    picks = [pick("A", deficit_units=227.0, p_hit=0.95)] + [
        pick(s, deficit_units=20.0, p_hit=0.30) for s in ("B", "C", "D")]
    starved = slate(picks, money=money, cash_budget=2000.0)
    assert starved.portfolio.cash_committed > 1800.0
    assert [p.sku for p in starved.picks] == ["A"]        # the bug
    assert sum(1 for _, r in starved.withheld
               if r.startswith("over_cash_budget")) == 3

    fixed = slate(picks, money=money, cash_budget=2000.0,
                  canonical_qty={"A": (8, 14)})
    assert len(fixed.picks) == 4                         # and the fix
    assert fixed.portfolio.cash_committed == pytest.approx((8 + 60) * 8.25)


def test_a_canonical_zero_is_not_priced_as_free() -> None:
    """The validator drops that card as false urgency - the engine ran and found
    the SKU already covered. Pricing it at nothing would rank it above every card
    that costs something, on its way out of the slate."""
    from app.recommender.slate import order_units

    assert order_units(pick("A", deficit_units=12.0), _ctx(),
                       canonical_qty={"A": (0, 14)}) == pytest.approx(12.0)


def test_the_deficit_itself_is_never_touched() -> None:
    """The quantity the DECISION was taken on, and the quantity the expected value
    is measured on. This change is only about what the owner PAYS."""
    chosen = slate([pick("A", deficit_units=227.0)],
                   canonical_qty={"A": (8, 14)}).portfolio.chosen[0]
    assert chosen.units_at_stake == pytest.approx(227.0)
    assert chosen.units_required == pytest.approx(8.0)


# ── The attention ceiling must not delete a whole family ────────────────────


def test_priced_cards_no_longer_crowd_out_every_unpriced_family() -> None:
    """The eight-reorder slate.

    `ordered` is priced-first and was then truncated to the ceiling, so whenever
    the budget afforded more reorder cards than the ceiling admits, every
    markdown and bundle was cut. Measured estate-wide over fourteen days: reorder
    is 78.4% of cards issued while markdown and bundle exist and are never
    reached at a ceiling of 8. The old comment claimed neither group could crowd
    the other out, which holds only when the budget binds before the ceiling.
    """
    priced = [pick(f"P{i}") for i in range(10)]
    marked = [pick(f"M{i}", family="markdown") for i in range(3)]
    out = slate(priced + marked, limit=8)

    families = [p.family for p in out.picks]
    assert len(out.picks) == 8, "the ceiling still binds"
    assert families.count("markdown") == 2, (
        f"two places are held for unpriced families, got {families}")
    assert families.count("recovering") == 6

    # A displaced priced card says it was displaced, rather than disappearing
    # into the generic ceiling count - the two have different fixes.
    reasons = dict(out.withheld)
    displaced = [r for r in reasons.values()
                 if r.startswith("displaced_by_unpriced_floor")]
    assert displaced, f"no displacement recorded: {reasons}"


def test_the_floor_never_reserves_more_than_the_unpriced_offered() -> None:
    """One markdown offered means one place held, not two - a reservation for a
    card that does not exist would shrink the slate for nothing."""
    out = slate([pick(f"P{i}") for i in range(10)]
                + [pick("M0", family="markdown")], limit=8)
    families = [p.family for p in out.picks]
    assert len(out.picks) == 8
    assert families.count("markdown") == 1
    assert families.count("recovering") == 7


def test_the_floor_is_off_when_nothing_unpriced_is_offered() -> None:
    """A store with only reorder candidates gets a full slate of them. The
    reservation is for families that exist, never a hole in the slate."""
    out = slate([pick(f"P{i}") for i in range(10)], limit=8)
    assert len(out.picks) == 8
    assert all(p.family == "recovering" for p in out.picks)


def test_the_floor_cannot_starve_the_priced_ranking() -> None:
    """At a ceiling of 1 the budget's best card still wins the place.

    `max(0, room - 1)` is what guarantees it: a reservation that could take the
    whole slate would let an unpriced card with no measured margin displace the
    single best-returning card the store has.
    """
    out = slate([pick("P0")] + [pick(f"M{i}", family="markdown")
                                for i in range(3)], limit=1)
    assert len(out.picks) == 1
    assert out.picks[0].family == "recovering"
