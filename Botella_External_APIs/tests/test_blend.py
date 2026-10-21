"""Sheet 06 — shrinkage. The architectural keystone.

The point of this sheet is that **cold start is a weight, not a branch**. So
the tests are not really about arithmetic (the arithmetic is one line) — they
are about proving the branch is absent and cannot come back:

  * `blend()` contains no conditional of any kind, asserted against its AST
  * nothing anywhere in the pipeline branches on `evidence_state`, asserted
    against every module's AST
  * the blend is continuous across n = 0..100, so there is no cliff to cross
  * changing the label changes no computed number
"""

from __future__ import annotations

import ast
import importlib.util
import inspect
import sys
from datetime import date
from pathlib import Path

import pytest

from app.pipeline import RunContext
from app.pipeline.blend import (
    K_BY_PATTERN,
    PATTERNS,
    BlendRequest,
    blend,
    cohort_weight_for,
    evidence_state_for,
    k_for_pattern,
    own_weight_for,
)
from app.pipeline.blend import shrink as shrink_mod

REPO_ROOT = Path(__file__).resolve().parents[1]
AS_OF = date(2026, 9, 21)


def ctx(**over) -> RunContext:
    base = {
        "run_id": "run-06", "tenant_id": 46, "store_id": 46, "as_of": AS_OF,
        "snapshot_id": "snap-1", "config_version": "default", "seed": 0,
        "versions": {"blend": "1.0.0"},
    }
    return RunContext(**{**base, **over})


def req(n: int, own: float | None = 100.0, cohort: float = 20.0,
        pattern: str = "sku_velocity", **kw) -> BlendRequest:
    return BlendRequest(pattern=pattern, n=n, theta_own=own,
                        theta_cohort=cohort, **kw)


# ── n = 0 is the cohort, exactly ────────────────────────────────────────────


def test_n_zero_returns_exactly_theta_cohort_with_own_weight_zero() -> None:
    """The sheet's first named test. A brand-new store, no branch taken."""
    out = blend(req(n=0, own=None, cohort=42.5), ctx()).value
    assert out.value == 42.5
    assert out.own_weight == 0.0
    assert out.cohort_weight == 1.0
    assert out.evidence_state == "NEW"


def test_theta_own_is_annihilated_when_n_is_zero() -> None:
    """Proves the None->0.0 normalisation at the boundary CANNOT matter.

    If substituting a value for a missing own-estimate could change the
    answer, that substitution would be a hidden branch. It cannot: n=0
    multiplies it away, whatever it is."""
    answers = {
        blend(req(n=0, own=own, cohort=7.0), ctx()).value.value
        for own in (None, 0.0, -1e9, 1e9, 123.456)
    }
    assert answers == {7.0}, "any theta_own gives the same answer at n=0"


def test_n_equals_k_is_exactly_the_midpoint() -> None:
    k = k_for_pattern("sku_velocity", ctx())
    out = blend(req(n=k, own=100.0, cohort=20.0), ctx()).value
    assert out.value == pytest.approx(60.0)
    assert out.own_weight == pytest.approx(0.5)


def test_n_far_above_k_is_essentially_own_history() -> None:
    k = k_for_pattern("sku_velocity", ctx())
    out = blend(req(n=k * 200, own=100.0, cohort=20.0), ctx()).value
    assert out.value == pytest.approx(100.0, abs=0.5)
    assert out.own_weight > 0.99


# ── No branch. Asserted against the source, not asked for in review. ────────


def test_blend_contains_no_conditional_of_any_kind() -> None:
    """The architectural requirement, checked against the AST of the function
    itself. `if n == 0`, `if store.is_new`, a tier gate, or even a defensive
    ternary would all fail here."""
    source = inspect.getsource(blend.undecorated)  # type: ignore[attr-defined]
    tree = ast.parse(source)

    offenders = [
        type(node).__name__
        for node in ast.walk(tree)
        if isinstance(node, (ast.If, ast.IfExp, ast.Match, ast.While, ast.Assert))
    ]
    assert offenders == [], (
        f"blend() grew {offenders} - cold start must stay a WEIGHT, not a branch"
    )


def test_own_weight_helpers_are_branchless_too() -> None:
    for fn in (own_weight_for, cohort_weight_for):
        tree = ast.parse(inspect.getsource(fn))
        assert not [
            n for n in ast.walk(tree)
            if isinstance(n, (ast.If, ast.IfExp, ast.Match))
        ], f"{fn.__name__} grew a branch"


def test_the_source_contains_no_tier_gate() -> None:
    """Belt and braces for the specific shapes the sheet calls out.

    Checked against the AST, not the text. The module docstring deliberately
    QUOTES the anti-pattern (`if store.tier == "T0"`) as the thing not to
    write, and a naive grep flags the warning as the offence - which it did,
    the first time this test ran.
    """
    tree = ast.parse(Path(shrink_mod.__file__).read_text(encoding="utf-8"))
    forbidden = {"tier", "is_new", "is_cold_start", "store_tier"}
    offenders = [
        node.attr if isinstance(node, ast.Attribute) else node.id
        for node in ast.walk(tree)
        if (isinstance(node, ast.Attribute) and node.attr in forbidden)
        or (isinstance(node, ast.Name) and node.id in forbidden)
    ]
    assert offenders == [], f"tier gate in executable code: {offenders}"


# ── Continuity: no cliff anywhere ───────────────────────────────────────────


def test_the_blend_is_continuous_across_n_0_to_100() -> None:
    """The sheet's second named test. A tier gate shows up here as a jump -
    a store crossing the boundary would see its number move overnight for a
    reason it cannot observe."""
    values = [blend(req(n=n, own=100.0, cohort=20.0), ctx()).value.value
              for n in range(101)]

    steps = [abs(b - a) for a, b in zip(values, values[1:], strict=False)]
    # Monotone increasing toward theta_own, and every step smaller than the
    # first: a shrinkage curve has no cliff by construction.
    assert all(b >= a for a, b in zip(values, values[1:], strict=False))
    assert max(steps) == steps[0]
    assert values[0] == 20.0 and values[-1] < 100.0


def test_continuity_holds_for_every_pattern() -> None:
    for pattern in PATTERNS:
        values = [
            blend(req(n=n, own=50.0, cohort=10.0, pattern=pattern), ctx()).value.value
            for n in range(0, 120)
        ]
        steps = [abs(b - a) for a, b in zip(values, values[1:], strict=False)]
        assert max(steps) == steps[0], f"{pattern} has a cliff"


def test_there_is_no_jump_where_the_LABEL_changes() -> None:
    """The label boundary is exactly where a tier system would have its cliff.
    Crossing it must change the word and nothing else."""
    k = k_for_pattern("sku_velocity", ctx())
    below = blend(req(n=k - 1, own=100.0, cohort=20.0), ctx()).value
    at = blend(req(n=k, own=100.0, cohort=20.0), ctx()).value

    assert below.evidence_state == "EMERGING"
    assert at.evidence_state == "ESTABLISHED"
    # ...and the number barely moved.
    assert abs(at.value - below.value) < 2.0
    assert at.value > below.value


# ── The label is display only ───────────────────────────────────────────────


def test_evidence_state_changes_label_without_changing_any_number() -> None:
    """The sheet's third named test."""
    k = k_for_pattern("day_of_week", ctx())
    seen: dict[str, float] = {}
    for n in (0, 1, k - 1, k, k * 2, k * 4, k * 40):
        out = blend(req(n=n, own=100.0, cohort=20.0, pattern="day_of_week"), ctx()).value
        # The value is fully determined by n and k - recompute it independently.
        expected = (n * 100.0 + k * 20.0) / (n + k)
        assert out.value == pytest.approx(expected), f"n={n}"
        seen[out.evidence_state] = out.value
    assert set(seen) == {"NEW", "EMERGING", "ESTABLISHED", "MATURE"}


def test_the_four_bands_derive_from_n_and_k() -> None:
    k = 10
    assert evidence_state_for(0, k, ctx()) == "NEW"
    assert evidence_state_for(1, k, ctx()) == "EMERGING"
    assert evidence_state_for(k - 1, k, ctx()) == "EMERGING"
    assert evidence_state_for(k, k, ctx()) == "ESTABLISHED"
    assert evidence_state_for(k * 4 - 1, k, ctx()) == "ESTABLISHED"
    assert evidence_state_for(k * 4, k, ctx()) == "MATURE"


def test_NOTHING_IN_THE_PIPELINE_BRANCHES_ON_EVIDENCE_STATE() -> None:
    """The sheet's explicit requirement: a test that greps the pipeline
    packages for branches on evidence_state and fails if one appears.

    This is the guard that keeps the tier gate from coming back through the
    back door six months from now."""
    spec = importlib.util.spec_from_file_location(
        "check_no_state_branches", REPO_ROOT / "scripts" / "check_no_state_branches.py")
    assert spec and spec.loader
    checker = importlib.util.module_from_spec(spec)
    sys.modules["check_no_state_branches"] = checker
    spec.loader.exec_module(checker)

    violations = checker.collect(REPO_ROOT)
    assert violations == [], (
        "a stage branches on evidence_state:\n  "
        + "\n  ".join(str(v) for v in violations)
    )
    assert checker.main(["--root", str(REPO_ROOT)]) == 0


def test_the_guard_catches_a_planted_branch(tmp_path: Path) -> None:
    """Prove the guard actually works, rather than trusting a clean result."""
    spec = importlib.util.spec_from_file_location(
        "check_no_state_branches2", REPO_ROOT / "scripts" / "check_no_state_branches.py")
    checker = importlib.util.module_from_spec(spec)   # type: ignore[arg-type]
    sys.modules[spec.name] = checker                  # @dataclass needs this
    spec.loader.exec_module(checker)                  # type: ignore[union-attr]

    planted = tmp_path / "app" / "pipeline" / "leaky.py"
    planted.parent.mkdir(parents=True, exist_ok=True)

    for body, kind in [
        ("def f(p):\n    if p.evidence_state == 'MATURE':\n        return 1\n    return 0\n",
         "branch"),
        ("def f(p):\n    return 1 if p.evidence_state == 'NEW' else 0\n", "conditional"),
        ("def f(p):\n    match p.evidence_state:\n        case 'NEW':\n            return 0\n",
         "match"),
        ("HANDLERS = {}\ndef f(row):\n    return HANDLERS[row['evidence_state']]\n",
         "comparison"),
    ]:
        planted.write_text(body, encoding="utf-8")
        found = checker.collect(tmp_path)
        assert found, f"guard missed a planted {kind}"
        assert checker.main(["--root", str(tmp_path)]) == 1

    # ...and passes once the branch is gone.
    planted.write_text(
        "def f(n, k):\n    return (n * 1.0 + k * 2.0) / (n + k)\n", encoding="utf-8")
    assert checker.collect(tmp_path) == []
    assert checker.main(["--root", str(tmp_path)]) == 0


def test_assigning_the_label_is_not_branching_on_it(tmp_path: Path) -> None:
    """Producing the label is what the producing stages are for. The guard
    must not flag it, or every stage in the pipeline would fail."""
    spec = importlib.util.spec_from_file_location(
        "check_no_state_branches3", REPO_ROOT / "scripts" / "check_no_state_branches.py")
    checker = importlib.util.module_from_spec(spec)   # type: ignore[arg-type]
    sys.modules[spec.name] = checker                  # @dataclass needs this
    spec.loader.exec_module(checker)                  # type: ignore[union-attr]

    path = tmp_path / "app" / "pipeline" / "producer.py"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "from app.pipeline.provenance import Provenance\n"
        "def make(n):\n"
        "    return Provenance(own_observations=n, own_weight=1.0,\n"
        "                      evidence_state='MATURE' if n > 10 else 'NEW')\n",
        encoding="utf-8",
    )
    assert checker.collect(tmp_path) == [], "assignment must not trip the guard"


# ── k comes from the registry ───────────────────────────────────────────────


def test_k_is_a_registry_setting_per_pattern_not_a_literal() -> None:
    """The sheet's fourth named test. Writing a fixed 12 into the code is how
    the current engine acquired 63 unexamined constants."""
    assert set(K_BY_PATTERN) == set(PATTERNS)
    for pattern, setting in K_BY_PATTERN.items():
        assert setting.name == f"shrink.k.{pattern}"
        assert setting.status == "PROVISIONAL", "fitted in wave 6, not before"
        assert setting.owner and setting.why


def test_k_records_itself_into_provenance() -> None:
    result = blend(req(n=5, pattern="weekly_trend"), ctx())
    assert "shrink.k.weekly_trend" in result.provenance.config_keys


def test_the_no_literals_guard_still_passes() -> None:
    spec = importlib.util.spec_from_file_location(
        "check_no_literals_b", REPO_ROOT / "scripts" / "check_no_literals.py")
    checker = importlib.util.module_from_spec(spec)   # type: ignore[arg-type]
    sys.modules[spec.name] = checker                  # @dataclass needs this
    spec.loader.exec_module(checker)                  # type: ignore[union-attr]
    offenders = [v for v in checker.collect(REPO_ROOT)
                 if v.path.startswith("app/pipeline/blend")]
    assert offenders == [], offenders


def test_a_non_positive_k_is_a_config_error_not_a_data_branch() -> None:
    """The one guard in the module. It fires on a misconfigured registry,
    identically for every store, never on the shape of a store's data."""
    from app.pipeline.registry import ConfigRegistry

    broken = ConfigRegistry(version="broken", overrides={"shrink.k.day_of_week": 0})
    with pytest.raises(ValueError, match="must be positive"):
        k_for_pattern("day_of_week", ctx(config_version="broken"), broken)


def test_an_unknown_pattern_is_refused() -> None:
    with pytest.raises(ValueError, match="unknown pattern"):
        k_for_pattern("vibes", ctx())


# ── Provenance and the store-facing sentence ────────────────────────────────


def test_own_weight_reaches_provenance_for_the_card() -> None:
    result = blend(req(n=10, cohort_level="state", cohort_size=24), ctx())
    k = k_for_pattern("sku_velocity", ctx())
    assert result.provenance.own_weight == pytest.approx(10 / (10 + k))
    assert result.provenance.own_observations == 10
    assert result.provenance.cohort_level == "state"
    assert result.provenance.cohort_size == 24


def test_the_card_can_say_how_much_was_the_stores_own_data() -> None:
    out = blend(req(n=0, own=None, cohort=12.0,
                    cohort_level="state", cohort_size=24), ctx()).value
    assert out.explain() == (
        "Based 0% on your own sales (0 observations) and 100% on 24 similar "
        "stores (state)."
    )


def test_a_negative_n_is_refused_at_the_boundary() -> None:
    with pytest.raises(ValueError, match="n must be >= 0"):
        req(n=-1)


# ── Cold start end to end ───────────────────────────────────────────────────


def test_a_brand_new_store_and_a_mature_one_run_the_same_code() -> None:
    """The keystone claim, stated as a test: identical stage, identical
    version, identical code path - only n differs."""
    newborn = blend(req(n=0, own=None, cohort=30.0), ctx())
    veteran = blend(req(n=5000, own=95.0, cohort=30.0), ctx())

    assert newborn.stage == veteran.stage == "shrink_blend"
    assert newborn.stage_version == veteran.stage_version
    assert newborn.ok is veteran.ok is True
    assert newborn.value.value == 30.0
    assert veteran.value.value == pytest.approx(95.0, abs=0.5)
    assert newborn.value.evidence_state == "NEW"
    assert veteran.value.evidence_state == "MATURE"


@pytest.mark.parametrize("pattern", list(PATTERNS))
def test_every_pattern_blends(pattern: str) -> None:
    out = blend(req(n=0, own=None, cohort=9.0, pattern=pattern), ctx()).value
    assert out.value == 9.0 and out.own_weight == 0.0


def test_the_blend_stage_is_well_formed() -> None:
    result = blend(req(n=3), ctx())
    assert result.stamped and result.provenance is not None
    assert result.duration_ms >= 0
