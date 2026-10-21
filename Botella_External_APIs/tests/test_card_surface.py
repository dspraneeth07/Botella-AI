"""The guard for the boundary that threw six months of work away.

WHAT HAPPENED
    `to_raw_recommendations` computed the store gate's verdict, the two-sided
    predictive range, the promise floor, the cost of being wrong, the calibration
    basis and the slate's budget. `Recommendation.model_validate` then discarded
    every one of them, because the model sets no `model_config` and pydantic's
    default is `extra="ignore"`. No warning, nothing counted in
    `dropped_invalid`, nothing in a log.

    The unit tests all passed. `test_live_card_fields.py` asserts on the dict
    `to_raw_recommendations` RETURNS - one layer above the boundary that dropped
    it - so it proved the figures were computed and said nothing about whether
    they were delivered. An owner's card carried none of it.

WHY A TEST AND NOT A CONFIG CHANGE
    Setting `extra="allow"` would have fixed this instance and hidden the next
    one: a misspelled key would then sail through to a response field nobody
    declared, and a consumer reading `expected_range_lo` would get silence
    instead of an error. The allow-list is right. What was missing is anything
    that checks the two lists against each other.

    So this asserts the property directly: every key the card builder can emit is
    a field the response model declares. It fails on the NEXT field added to one
    side and not the other, which is the only way this does not happen again.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import date

from app.pipeline.rank.portfolio import PortfolioCandidate, choose_portfolio
from app.recommender.deterministic import Pick, to_raw_recommendations
from app.recommender.families import ExtraPick, to_raw
from app.schemas.recommendation import Recommendation
from tests.test_gate_serving import passing_store
from tests.test_portfolio import ctx as portfolio_ctx

AS_OF = date(2026, 10, 6)

PICK = Pick(
    sku="SKU1", rank=1, recent_units=12.0, recent_rate=0.43, long_run_rate=3.44,
    reverted_rate=0.92, uplift=2.14, p_hit=0.65, deficit_units=17.0,
    dispersion_cv=0.47, evidence_state="EMERGING", why="because",
    long_run_days_available=365, family="recovering", days_cover=4.0,
    unit_cost=11.50, horizon_open_days=25.7,
)

#: Bethany's real measured inputs, borrowed from the gate's own suite rather
#: than invented - a hand-written shape that happens not to match
#: `verdict_for` would make this file pass while testing nothing.
GATE_INPUTS = passing_store()


def _slate():
    """A real `PortfolioSlate`, so the budget fields are the shapes the live
    route actually produces rather than hand-written stand-ins."""
    return choose_portfolio(
        [PortfolioCandidate(sku="SKU1", family="recovering", units_at_stake=17.0,
                            unit_margin=6.0, calibrated_confidence=0.65,
                            holding_cost_if_unsold=4.1, cash_required=195.5,
                            units_required=17.0)],
        portfolio_ctx(),
    )


def _every_emitted_key() -> set[str]:
    """Every key the card builder can emit, across the branches that add fields.

    Enumerated by RUNNING it rather than by listing the keys, because a list
    would have to be maintained alongside the thing it describes - which is the
    failure this file exists to prevent, one layer further out.
    """
    keys: set[str] = set()
    variants = (
        # The full live path: identifiers, a gate verdict and a budget.
        dict(client_id=1, location_id=171, gate_inputs=GATE_INPUTS,
             portfolio=_slate()),
        # A legacy caller, which must still work and gains nothing.
        dict(),
        # The markdown branch, which deliberately publishes no holding cost.
        dict(client_id=1, location_id=171),
    )
    families = (PICK, replace(PICK, family="overstock"),
                # No cost, so the holding cost is refused rather than zeroed.
                replace(PICK, unit_cost=None),
                # No horizon, so the interval and the floor are both refused.
                replace(PICK, horizon_open_days=None))
    for kwargs in variants:
        for pick in families:
            for card in to_raw_recommendations([pick], as_of=AS_OF, **kwargs):
                keys |= set(card)
    return keys


# ── The property ────────────────────────────────────────────────────────────


def test_every_field_the_card_builder_emits_survives_the_response_model() -> None:
    """THE test. Any key the builder emits that the model does not declare is
    silently deleted on its way to the owner."""
    declared = set(Recommendation.model_fields)
    emitted = _every_emitted_key()
    undeclared = sorted(emitted - declared)
    assert not undeclared, (
        "these keys are computed and then silently discarded by "
        f"Recommendation.model_validate: {undeclared}"
    )


def test_the_signal_families_emit_nothing_undeclared_either() -> None:
    """`families.to_raw` is the second builder, and it writes the same shape."""
    extra = [ExtraPick(family="cold_box", category="inventory_understock",
                       action_type="pre_stock", skus=("S1",),
                       rationale="hot week ahead", signals_cited=("heat_advisory",),
                       confidence=0.5, daily_rate=1.2),
             ExtraPick(family="bundle", category="merchandising",
                       action_type="bundle", skus=("S1", "S2"),
                       rationale="bought together 22 times",
                       signals_cited=(), confidence=0.64)]
    declared = set(Recommendation.model_fields)
    for card in to_raw(extra, as_of=AS_OF):
        assert not set(card) - declared, sorted(set(card) - declared)


def test_a_full_card_round_trips_with_its_figures_intact() -> None:
    """The regression itself, stated as a value rather than as a key set: the
    numbers that arrive are the numbers that were computed."""
    card = to_raw_recommendations(
        [PICK], as_of=AS_OF, client_id=1, location_id=171,
        gate_inputs=GATE_INPUTS, portfolio=_slate())[0]
    model = Recommendation.model_validate(card)
    assert model.gate_state == card["gate_state"] == "live"
    assert model.gate_measured is True
    assert model.expected_range_low == card["expected_range_low"]
    assert model.expected_range_high == card["expected_range_high"]
    assert model.holding_cost_if_unsold == card["holding_cost_if_unsold"]
    assert model.portfolio_cash_budget == card["portfolio_cash_budget"]
    assert model.portfolio_assumptions == card["portfolio_assumptions"]
    # And the dump carries them onward, which is what Node reads.
    dumped = model.model_dump()
    for key in ("gate_state", "expected_range_low", "holding_cost_if_unsold",
                "portfolio_cash_committed", "confidence_raw"):
        assert key in dumped, key


def test_absence_stays_absent_rather_than_becoming_a_zero() -> None:
    """A legacy caller computes none of this. The model must report None, not 0:
    a zero holding cost says being wrong is free, and a zero budget says the
    store has no cash."""
    model = Recommendation.model_validate(
        to_raw_recommendations([PICK], as_of=AS_OF)[0])
    assert model.holding_cost_if_unsold is None
    assert model.expected_range_low is None
    assert model.portfolio_cash_budget is None
    assert model.gate_state is not None       # the gate always answers
    assert model.gate_measured is False       # ...and an unmeasured store says so
    assert model.portfolio_assumptions == []


def test_a_misspelled_key_is_still_rejected() -> None:
    """The allow-list is kept deliberately. `extra="allow"` would have fixed the
    original bug and hidden the next one, by letting a typo reach a field nobody
    declared."""
    model = Recommendation.model_validate(
        {**to_raw_recommendations([PICK], as_of=AS_OF)[0],
         "expected_range_lo": 3})
    assert not hasattr(model, "expected_range_lo")


# ── The published downside prices the quantity the card asks for ─────────────


def test_the_holding_cost_prices_the_canonical_quantity_not_the_deficit() -> None:
    """A bug that predates the portfolio and was on every live card whose quantity
    the validator rewrites. Marshfield published $79.26 of downside for an order
    worth $66, because the deficit said 227 units and the card said 8."""
    big = replace(PICK, deficit_units=227.0, unit_cost=8.25)
    on_deficit = to_raw_recommendations(
        [big], as_of=AS_OF, client_id=1, location_id=178)[0]
    on_canonical = to_raw_recommendations(
        [big], as_of=AS_OF, client_id=1, location_id=178,
        canonical_qty={"SKU1": (8, 14)})[0]
    assert on_canonical["suggested_order_qty"] == 8
    assert on_deficit["suggested_order_qty"] == 227
    assert (on_canonical["holding_cost_if_unsold"]
            < on_deficit["holding_cost_if_unsold"] / 10)


def test_the_decision_figures_do_not_move_when_the_quantity_does() -> None:
    """THE safety property. The canonical figure is what the owner PAYS; the
    deficit is still what the decision was taken on, so nothing that selects or
    orders may read differently."""
    big = replace(PICK, deficit_units=227.0, unit_cost=8.25)
    plain = to_raw_recommendations([big], as_of=AS_OF, client_id=1,
                                   location_id=178)[0]
    with_qty = to_raw_recommendations([big], as_of=AS_OF, client_id=1,
                                      location_id=178,
                                      canonical_qty={"SKU1": (8, 14)})[0]
    for key in ("rank", "confidence", "confidence_raw", "engine_daily_rate",
                "engine_days_cover", "engine_on_hand", "expected_range_low",
                "expected_range_high", "promise_floor_units", "gate_state"):
        assert plain.get(key) == with_qty.get(key), key


# -- THE RANGE SENTENCE MUST SURVIVE THE VALIDATOR -----------------------------
#
# `validator._enforce_quantity` keeps the one-number rule by requiring the
# canonical figure to be quoted IN UNITS, and rebuilds any hint that does not
# quote it. The rebuild replaces the WHOLE string - including the predictive
# range appended to it, which is the one claim on the card that can be held to.
#
# The engine wrote "about 8 more than the last four weeks imply". No unit word,
# so the check never matched and every buy card was rebuilt. Measured on a live
# run of the five pilot stores: 26 of 31 reorder cards lost the range. The five
# that kept it were at the one store with no canonical quantity, where the
# validator returns before the regex - so better data meant a worse card.


def _quantity_hint_survives(hint: str, canonical_qty: int) -> bool:
    """The validator's own test, applied to a finished hint."""
    from app.recommender.validator import _enforce_quantity

    rec = {"action_type": "reorder", "quantity_hint": hint,
           "primary_skus": ["SKU1"], "suggested_order_qty": None}
    kept = _enforce_quantity(rec, {"SKU1": (canonical_qty, 14)},
                             AS_OF, {"SKU1": "Fords Gin 1L"})
    assert kept is True
    return rec["quantity_hint"] == hint


def test_the_engines_own_hint_quotes_its_unit() -> None:
    """Both buy shapes, as the engine writes them."""
    for pick, shape in ((replace(PICK, family="stockout"), "to cover"),
                        (replace(PICK, family="recovering"), "more than")):
        card = to_raw_recommendations(
            [pick], as_of=AS_OF, client_id=1, location_id=171,
            canonical_qty={"SKU1": (8, 14)})[0]
        hint = card["quantity_hint"]
        assert "8 units" in hint, hint
        assert shape in hint, hint


def test_the_range_sentence_survives_the_rewrite() -> None:
    """THE REGRESSION. The hint carries the range, and the validator must leave
    both alone when the engine has quoted the canonical figure properly."""
    card = to_raw_recommendations(
        [PICK], as_of=AS_OF, client_id=1, location_id=171,
        canonical_qty={"SKU1": (8, 14)})[0]
    hint = card["quantity_hint"]
    assert "land between" in hint, "the engine did not append the range at all"
    assert _quantity_hint_survives(hint, 8), (
        "the validator rebuilt the hint and deleted the range: " + hint)


def test_a_disagreeing_canonical_still_forces_the_rewrite() -> None:
    """The fix must not defeat the rule it was tripping over. Where the engine's
    number and the canonical number genuinely differ, the hint is still rebuilt -
    the check searches for the CANONICAL figure, so quoting a different one in
    units does not satisfy it."""
    hint = ("about 8 units more than the last four weeks imply. Over the next 30 "
            "selling days total sales should land between 6 and 21 units")
    assert not _quantity_hint_survives(hint, 12), (
        "a hint quoting 8 was accepted against a canonical quantity of 12")


def test_a_bare_number_is_still_refused() -> None:
    """Relaxing the regex would have been the wrong fix: "19" unqualified is
    exactly the ambiguity that makes an owner order nineteen CASES."""
    assert not _quantity_hint_survives("about 8 more than last month", 8)
