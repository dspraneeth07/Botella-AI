"""N3.1 — one currency for every family, enforced structurally.

The four literals this replaces: cold_box 0.55, pre_stock 0.55, bundles 0.7,
stock_new 0.6, and a bundles pick with no units at all. A hand-written confidence
cannot be ranked against a measured one, so `pipeline.py` carved the slate up by
FAMILY rather than by VALUE - which is why the slate looks like restock even
though all twenty signal modules are switched on.
"""

from __future__ import annotations

import ast
import pathlib
from datetime import date

import pytest

from app.pipeline.rank.family import (
    FamilyPick,
    SignalEffect,
    units_from_effect,
)
from app.recommender import families as F

REPO = pathlib.Path(__file__).resolve().parents[1]


def pick(**over) -> FamilyPick:
    base = dict(
        family="cold_box", category="weather", action_type="cold_box",
        primary_skus=("0245",), units_at_stake=12.0, unit_margin=4.0,
        raw_confidence=0.6, horizon_open_days=26, provenance="test",
    )
    return FamilyPick(**{**base, **over})


def effect(**over) -> SignalEffect:
    base = dict(key="heat_advisory", beta=0.22, interval_lo=0.09,
                interval_hi=0.35, observations=40, basis="ols-hc1")
    return SignalEffect(**{**base, **over})


# ── units_at_stake is never None ─────────────────────────────────────────────


def test_every_family_returns_units_at_stake() -> None:
    """The contract makes it a required field, and every family that can build a
    pick must therefore quote one."""
    p = pick()
    assert p.units_at_stake == 12.0
    assert p.expected_value == pytest.approx(48.0)

    # It is required - omitting it is a TypeError from the dataclass itself.
    with pytest.raises(TypeError):
        FamilyPick(                                   # type: ignore[call-arg]
            family="cold_box", category="weather", action_type="cold_box",
            primary_skus=("0245",), unit_margin=4.0, raw_confidence=0.6,
            horizon_open_days=26, provenance="test",
        )


def test_family_without_units_at_stake_refuses() -> None:
    """A sentinel RANKS, which is worse than producing no card at all."""
    with pytest.raises(TypeError, match="REFUSES"):
        pick(units_at_stake=None)
    with pytest.raises(ValueError, match="negative"):
        pick(units_at_stake=-5.0)
    with pytest.raises(ValueError, match="finite"):
        pick(units_at_stake=float("inf"))

    # And the real refusal path: no estimate means no units, which means no card.
    assert units_from_effect(None, 100.0) is None
    assert units_from_effect(effect(beta=0.05, interval_lo=-0.18,
                                   interval_hi=0.28), 100.0) is None
    assert units_from_effect(effect(), 100.0) == pytest.approx(22.0)


def test_a_suppressing_effect_produces_no_card() -> None:
    """A negative beta is a VETO, not a card with negative value. A competitor
    promotion means do not pre-stock and do not read the dip as recoverable."""
    veto = effect(beta=-0.30, interval_lo=-0.50, interval_hi=-0.10)
    assert veto.usable is True, "the interval excludes zero, so it is measured"
    assert veto.suppresses is True
    assert units_from_effect(veto, 100.0) is None


def test_an_interval_spanning_zero_is_not_an_effect() -> None:
    """The same refusal elasticity/guard.py applies to price. Most signals at
    most stores will land here and that is the correct answer."""
    assert effect(beta=0.05, interval_lo=-0.18, interval_hi=0.28).usable is False
    assert effect(beta=0.22, interval_lo=0.09, interval_hi=0.35).usable is True
    assert effect(beta=-0.3, interval_lo=-0.5, interval_hi=-0.1).usable is True
    with pytest.raises(ValueError, match="inverted"):
        effect(interval_lo=0.5, interval_hi=0.1)


# ── no family may stamp a calibrated confidence ─────────────────────────────


def test_no_family_sets_calibrated_confidence_directly() -> None:
    """Enforced by ABSENCE: the dataclass has no such field, so a family cannot
    set one even by accident. That is what keeps N2 meaningful."""
    assert not hasattr(pick(), "calibrated_confidence")
    with pytest.raises(TypeError):
        pick(calibrated_confidence=0.9)             # type: ignore[call-arg]

    # The calibrated value enters only when the CALLER supplies it, from sheet 08.
    from app.pipeline.candidates.types import CandidateIdentity, ReorderCandidate
    from app.pipeline.provenance import Provenance
    cand = ReorderCandidate(
        CandidateIdentity(1, 1, "0245"), "reorder",
        Provenance(own_observations=10, own_weight=1.0, evidence_state="MATURE"),
        None, feasible_qty=10, order_by_date=date(2026, 4, 1), demand_p50=10.0,
        demand_p90=15.0, on_hand=0.0, on_order=0.0, lead_time_days=7,
        lead_time_assumption="declared",
    )
    si = pick().to_score_inputs(cand, 0.72)
    assert si.calibrated_confidence == 0.72
    assert si.units_at_stake == 12.0
    assert si.unit_margin == 4.0

    assert 0.0 <= pick(raw_confidence=0.0).raw_confidence <= 1.0
    with pytest.raises(ValueError, match="raw_confidence"):
        pick(raw_confidence=1.4)


def test_ratio_never_multiplied_by_margin() -> None:
    """Only unit counts become dollars. The defect removed twice already."""
    p = pick(units_at_stake=10.0, unit_margin=3.0, raw_confidence=0.9)
    # expected_value uses the UNITS, never the confidence.
    assert p.expected_value == pytest.approx(30.0)
    assert p.expected_value != pytest.approx(0.9 * 3.0)

    # Changing the confidence must not move the money at all.
    assert pick(raw_confidence=0.1).expected_value == pytest.approx(48.0)
    assert pick(raw_confidence=0.99).expected_value == pytest.approx(48.0)

    # No margin means NO expected value, not an assumed one.
    assert pick(unit_margin=None).expected_value is None

    # And structurally: the only multiplication in expected_value is by margin.
    src = pathlib.Path(
        REPO / "app" / "pipeline" / "rank" / "family.py"
    ).read_text(encoding="utf-8")
    tree = ast.parse(src)
    fn = next(n for n in ast.walk(tree)
              if isinstance(n, ast.FunctionDef) and n.name == "expected_value")
    names = {n.attr for n in ast.walk(fn) if isinstance(n, ast.Attribute)}
    assert "raw_confidence" not in names, (
        "expected_value must not read a probability"
    )


def test_provenance_and_skus_are_required() -> None:
    """A card whose numbers cannot be traced to a component does not ship."""
    with pytest.raises(ValueError, match="provenance"):
        pick(provenance="  ")
    with pytest.raises(ValueError, match="at least one SKU"):
        pick(primary_skus=())


def test_pick_serialises_with_its_effect() -> None:
    p = pick(effect=effect(), decision_by=date(2026, 4, 1))
    d = p.as_dict()
    assert d["units_at_stake"] == 12.0
    assert d["expected_value"] == pytest.approx(48.0)
    assert d["effect"]["usable"] is True
    assert d["decision_by"] == "2026-04-01"
    assert "calibrated_confidence" not in d


# ── the live families, rewired ───────────────────────────────────────────────


def test_signal_families_refuse_without_an_estimated_effect() -> None:
    """A DELIBERATE reduction in coverage against today. These families used to
    fire on nothing more than "a key is active" and state 0.55; measured over
    155 signal-driven recommendations that layer scored 6 to 10 points below
    random."""
    cat = {"A": {"name": "Seltzer 12pk", "size_ml": 355}}
    rates = {"A": 2.0}
    assert F.cold_box(["heat_advisory"], cat, rates) == []
    assert F.pre_stock(["nfl_home_game"], cat, rates) == []

    # With a usable effect they fire again.
    got = F.cold_box(["heat_advisory"], cat, rates,
                     effects={"heat_advisory": effect()})
    assert len(got) == 1

    # With an unusable one they do not.
    assert F.cold_box(["heat_advisory"], cat, rates,
                      effects={"heat_advisory": effect(
                          beta=0.05, interval_lo=-0.18, interval_hi=0.28)}) == []


def test_confidence_now_rises_with_the_evidence() -> None:
    """A pair seen in 12 baskets and one seen in 400 no longer state the same
    number, which is the whole complaint against the literals."""
    k = F.MIN_BUNDLE_SUPPORT
    assert F.confidence_from_evidence(k, k) == pytest.approx(0.5)
    vals = [F.confidence_from_evidence(n, k) for n in (k, 40, 120, 400)]
    assert vals == sorted(vals)
    assert vals[-1] > 0.95
    assert F.confidence_from_evidence(0, k) == 0.0
    # Never divides by zero even with a nonsense k.
    assert 0.0 <= F.confidence_from_evidence(10, 0) <= 1.0


def test_the_build_guard_catches_a_reintroduced_literal() -> None:
    """The guard is the thing that stops the contract being reverted one family
    at a time - so it has to actually fire."""
    import subprocess
    import sys

    script = REPO / "scripts" / "check_families_quote_ev.py"

    # The real tree is clean - run it the way CI does.
    done = subprocess.run([sys.executable, str(script)], cwd=REPO,
                          capture_output=True, text=True)
    assert done.returncode == 0, done.stdout + done.stderr

    # A reintroduced literal is caught.
    sys.path.insert(0, str(REPO / "scripts"))
    import check_families_quote_ev as mod   # noqa: E402
    bad = REPO / "tests" / "_tmp_bad_family.py"
    bad.write_text(
        "from app.pipeline.rank.family import FamilyPick\n"
        "p = FamilyPick(family='x', category='c', action_type='a',\n"
        "               primary_skus=('1',), units_at_stake=None,\n"
        "               unit_margin=1.0, raw_confidence=0.55,\n"
        "               horizon_open_days=1, provenance='p')\n",
        encoding="utf-8",
    )
    try:
        found = mod.check_file(bad, "tests/_tmp_bad_family.py")
        rules = {v.rule for v in found}
        assert "units_at_stake_is_none" in rules
        assert "hardcoded_confidence" in rules
    finally:
        bad.unlink(missing_ok=True)
