"""No card leaves without saying what its confidence figure IS.

THE FINDING
    352 cards in the analytics store carried no `confidence_basis`; 33 more
    carried the raw ranking score passed through unchanged; the isotonic cards
    all read 0.444. The same column held a shrinkage weight, an uncalibrated
    ordering score, a store base rate and a model's guess, and nothing on the
    card said which. A reader could not discount a figure without knowing
    which kind it was, and the 0.35 admission floor filtered on all four as
    though they were one thing.

WHAT THIS FILE PINS
    1. The vocabulary is closed, and the response model requires a member of
       it. A card with no basis, or an invented one, does not validate.
    2. Every emitter writes one: the deterministic card builder on both its
       branches (a curve, no curve, a curve with no fit for the cell), the
       signal families' builder, and the LLM client's extraction.
    3. The validator labels a bare card `not_recorded` with a warning that
       names it, rather than dropping it - and does the same to an unknown
       value, so a fifth meaning cannot travel under a name nobody declared.
    4. By AST: every dict literal in the recommender package that writes a
       "confidence" key also writes "confidence_basis". That is the property
       that catches the NEXT emitter, which no list of today's emitters can.
"""

from __future__ import annotations

import ast
from dataclasses import replace
from datetime import date
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.pipeline.calibrate.fit import ANY, CalibrationBundle, IsotonicFit
from app.recommender import llm_client
from app.recommender.deterministic import Pick, to_raw_recommendations
from app.recommender.families import ExtraPick, to_raw
from app.recommender.validator import validate_recommendations
from app.schemas.recommendation import (
    BASIS_NOT_RECORDED, CONFIDENCE_BASES, DISCRIMINATING_CALIBRATED_BASES,
    Recommendation,
)

AS_OF = date(2026, 10, 6)

PICK = Pick(
    sku="SKU1", rank=1, recent_units=12.0, recent_rate=0.43, long_run_rate=3.44,
    reverted_rate=0.92, uplift=2.14, p_hit=0.65, deficit_units=17.0,
    dispersion_cv=0.47, evidence_state="EMERGING", why="because",
    long_run_days_available=365, family="recovering", days_cover=4.0,
    unit_cost=11.50, horizon_open_days=25.7,
)


def _fit(ys: tuple[float, ...], family: str = "reorder") -> IsotonicFit:
    return IsotonicFit(
        family=family, demand_class=ANY, xs=(0.05, 0.25, 0.50), ys=ys,
        n_outcomes=56, domain_lo=0.05, domain_hi=0.50,
        fitted_at=date(2026, 10, 1), velocity_band=ANY,
    )


def _bundle(*fits: IsotonicFit) -> dict:
    return CalibrationBundle(
        version="v", fitted_at=date(2026, 10, 1),
        fits={(f.family, f.demand_class, f.velocity_band): f for f in fits},
        skipped={},
    ).as_dict()


def _card(**over) -> dict:
    card = {
        "rank": 1, "category": "weather", "action_type": "endcap",
        "primary_skus": ["SKU1"], "rationale": "because signal",
        "signals_cited": ["heat_advisory"], "confidence": 0.8,
        "valid_through": "2026-06-05", "confidence_basis": "raw_ranking_score",
    }
    card.update(over)
    return card


# ── 1. The vocabulary is closed and required ─────────────────────────────────


def test_the_model_refuses_a_card_with_no_basis() -> None:
    card = _card()
    del card["confidence_basis"]
    with pytest.raises(ValidationError):
        Recommendation.model_validate(card)


def test_the_model_refuses_a_basis_outside_the_vocabulary() -> None:
    with pytest.raises(ValidationError):
        Recommendation.model_validate(_card(confidence_basis="identity_constant"))
    with pytest.raises(ValidationError):
        Recommendation.model_validate(_card(confidence_basis=None))


def test_every_name_in_the_vocabulary_validates() -> None:
    for basis in CONFIDENCE_BASES:
        assert Recommendation.model_validate(_card(confidence_basis=basis)) \
            .confidence_basis == basis


def test_the_floor_applies_to_one_basis_only() -> None:
    """The only figure a confidence floor may filter on is a calibrated one
    that differs between cards. Everything else in the vocabulary is a raw
    score, a constant, a flat slate, an evidence count, a model's guess or an
    absence - and a floor on any of those decides on a number that was never a
    probability."""
    assert DISCRIMINATING_CALIBRATED_BASES == ("isotonic",)
    assert set(DISCRIMINATING_CALIBRATED_BASES) <= set(CONFIDENCE_BASES)
    assert BASIS_NOT_RECORDED in CONFIDENCE_BASES


# ── 2. Every emitter writes one ──────────────────────────────────────────────


def test_the_deterministic_builder_labels_every_branch() -> None:
    graded = _fit((0.30, 0.50, 0.70))
    constant = _fit((0.444, 0.444, 0.444))
    cases = (
        # No curve at all: the raw score, labelled as the raw score.
        (dict(), "raw_ranking_score"),
        # A curve with levels, one card: isotonic.
        (dict(client_id=1, location_id=171, calibration_bundle=_bundle(graded)),
         "isotonic"),
        # A one-level curve: the store's base rate, and the label says so.
        (dict(client_id=1, location_id=171, calibration_bundle=_bundle(constant)),
         "isotonic_constant"),
        # A bundle with no fit for THIS card's family: the identity transform
        # returns the raw score, so the label is the raw score's, never
        # "identity_constant" - a name the vocabulary does not have.
        (dict(client_id=1, location_id=171,
              calibration_bundle=_bundle(_fit((0.3, 0.5, 0.7), family="bundle"))),
         "raw_ranking_score"),
    )
    for kwargs, expected in cases:
        for pick in (PICK, replace(PICK, family="overstock")):
            card = to_raw_recommendations([pick], as_of=AS_OF, **kwargs)[0]
            assert card["confidence_basis"] in CONFIDENCE_BASES, kwargs
            if pick.family != "overstock":
                assert card["confidence_basis"] == expected, kwargs
            Recommendation.model_validate(card)


def test_a_flat_slate_is_a_vocabulary_member_and_only_for_priced_cards() -> None:
    """Three cards on a constant curve: all three `isotonic_constant_flat_slate`.
    A raw card in the same slate keeps `raw_ranking_score` - it was not priced
    by the curve, so the slate's flatness is not a claim about it."""
    constant = _fit((0.444, 0.444, 0.444))
    picks = [replace(PICK, sku=f"SKU{i}", p_hit=0.55 + i / 100) for i in range(3)]
    cards = to_raw_recommendations(
        picks, as_of=AS_OF, client_id=1, location_id=171,
        calibration_bundle=_bundle(constant))
    assert {c["confidence_basis"] for c in cards} == {"isotonic_constant_flat_slate"}
    for card in cards:
        Recommendation.model_validate(card)
    # A single priced card is not a flat slate - there is nothing to tell apart.
    one = to_raw_recommendations(
        picks[:1], as_of=AS_OF, client_id=1, location_id=171,
        calibration_bundle=_bundle(constant))[0]
    assert one["confidence_basis"] == "isotonic_constant"


def test_the_signal_families_label_their_evidence_count() -> None:
    extra = [ExtraPick(family="cold_box", category="inventory_understock",
                       action_type="pre_stock", skus=("S1",),
                       rationale="hot week ahead", signals_cited=("heat_advisory",),
                       confidence=0.5, daily_rate=1.2),
             ExtraPick(family="bundle", category="bundle",
                       action_type="bundle", skus=("S1", "S2"),
                       rationale="bought together 22 times",
                       signals_cited=(), confidence=0.64)]
    for card in to_raw(extra, as_of=AS_OF):
        assert card["confidence_basis"] == "family_evidence_count"
        Recommendation.model_validate(card)


def test_the_llm_extraction_stamps_llm_stated() -> None:
    class _Block:
        type = "tool_use"
        input = {"recommendations": [
            {"rank": 1, "confidence": 0.9},
            {"rank": 2, "confidence": 0.4, "confidence_basis": "llm_stated"},
            "not a dict - the validator drops this with its own reason",
        ]}

    out = llm_client._extract_recommendations([_Block()], stop_reason="end_turn")
    assert out[0]["confidence_basis"] == llm_client.LLM_STATED_BASIS == "llm_stated"
    assert out[1]["confidence_basis"] == "llm_stated"
    assert out[2] == "not a dict - the validator drops this with its own reason"


# ── 3. The validator labels, loudly, and never drops over a label ────────────


class _RecordingLog:
    """Stands in for the validator's structlog logger.

    Not `structlog.testing.capture_logs`: the app configures structlog with
    `cache_logger_on_first_use=True`, so once any earlier test has made the
    validator log a line its processor chain is frozen and capture_logs sees
    nothing. That made these tests pass alone and fail in the full run. A stub
    on the module attribute is order-independent.
    """

    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []

    def warning(self, event: str, **kw) -> None:
        self.events.append((event, kw))

    info = debug = error = warning

    def named(self, event: str) -> list[dict]:
        return [kw for e, kw in self.events if e == event]


@pytest.fixture
def validator_log(monkeypatch) -> _RecordingLog:
    from app.recommender import validator

    stub = _RecordingLog()
    monkeypatch.setattr(validator, "log", stub)
    return stub


def test_a_bare_card_is_labelled_not_recorded_with_a_warning_naming_it(
    validator_log: _RecordingLog,
) -> None:
    bare = _card()
    del bare["confidence_basis"]
    out, dropped = validate_recommendations(
        [bare], [], max_recommendations=10,
        active_signal_keys=["heat_advisory"], today=date(2026, 6, 3),
        area_winners=[],
    )
    # Dropped for the missing SKU, or kept - either way the label was applied
    # before any later rule, and the warning names the card.
    warnings = validator_log.named("confidence_basis_not_recorded")
    assert len(warnings) == 1
    assert warnings[0]["rank"] == 1 and warnings[0]["supplied"] is None
    assert dropped >= 0


def test_a_bare_card_that_survives_carries_not_recorded() -> None:
    from app.schemas.derived import Candidate

    cand = Candidate(sku="SKU1", product_name="Product", category="beer")
    bare = _card()
    del bare["confidence_basis"]
    out, dropped = validate_recommendations(
        [bare], [cand], max_recommendations=10,
        active_signal_keys=["heat_advisory"], today=date(2026, 6, 3),
    )
    assert dropped == 0 and len(out) == 1
    assert out[0]["confidence_basis"] == BASIS_NOT_RECORDED
    Recommendation.model_validate(out[0])


def test_an_unknown_basis_is_relabelled_not_invented(
    validator_log: _RecordingLog,
) -> None:
    from app.schemas.derived import Candidate

    cand = Candidate(sku="SKU1", product_name="Product", category="beer")
    out, _ = validate_recommendations(
        [_card(confidence_basis="gut_feeling")], [cand],
        max_recommendations=10, active_signal_keys=["heat_advisory"],
        today=date(2026, 6, 3),
    )
    assert out[0]["confidence_basis"] == BASIS_NOT_RECORDED
    warnings = validator_log.named("confidence_basis_not_recorded")
    assert [w["supplied"] for w in warnings] == ["gut_feeling"]


def test_a_labelled_card_is_left_alone(validator_log: _RecordingLog) -> None:
    from app.schemas.derived import Candidate

    cand = Candidate(sku="SKU1", product_name="Product", category="beer")
    out, _ = validate_recommendations(
        [_card(confidence_basis="family_evidence_count")], [cand],
        max_recommendations=10, active_signal_keys=["heat_advisory"],
        today=date(2026, 6, 3),
    )
    assert out[0]["confidence_basis"] == "family_evidence_count"
    assert not validator_log.named("confidence_basis_not_recorded")


# ── 4. The property, by AST: no dict literal writes confidence without basis ──

RECOMMENDER = Path(__file__).resolve().parents[1] / "app" / "recommender"

#: Files whose "confidence" dict keys are not card dicts. llm_client.py's is the
#: tool SCHEMA (a JSON-schema `properties` map); its cards are stamped after
#: extraction, which the test above covers directly.
NOT_CARD_DICTS = frozenset({"llm_client.py"})


def _dicts_writing_confidence(path: Path):
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if not isinstance(node, ast.Dict):
            continue
        keys = {k.value for k in node.keys
                if isinstance(k, ast.Constant) and isinstance(k.value, str)}
        if "confidence" in keys:
            yield node.lineno, keys


def test_no_card_dict_in_the_recommender_writes_confidence_without_a_basis() -> None:
    """The next emitter. A list of today's emitters would be maintained beside
    the thing it describes; this reads the code instead."""
    offenders = []
    checked = 0
    for path in sorted(RECOMMENDER.glob("*.py")):
        if path.name in NOT_CARD_DICTS:
            continue
        for lineno, keys in _dicts_writing_confidence(path):
            checked += 1
            if "confidence_basis" not in keys:
                offenders.append(f"{path.name}:{lineno}")
    # The two builders this file tests by hand must be among what was walked,
    # or the walk is reading the wrong tree.
    assert checked >= 2, "the AST walk found fewer card dicts than exist"
    assert not offenders, (
        "a dict literal writes `confidence` without `confidence_basis`; the "
        f"response model will refuse the card: {offenders}"
    )
