"""N1.3 — the service level is derived, not declared.

    q* = Cu / (Cu + Co)
    Cu = unit margin                    what a stockout costs
    Co = holding cost for one cycle     what one surplus unit costs

The four SERVICE_LEVEL_* Settings are PROVISIONAL and marked "NEEDS COMMERCIAL
SIGN-OFF". They do not need sign-off: the trade-off is computable from figures
already in the warehouse, and these tests pin that it is computed the right way
round - high for spirits, which do not spoil, and lower for the dated families.
"""

from __future__ import annotations

from datetime import date

import pytest

from app.pipeline.context import RunContext
from app.pipeline.policy.inventory import (
    LEAD_TIME_DAYS,
    Q_STAR_CEILING,
    Q_STAR_FLOOR,
    REVIEW_PERIOD_DAYS,
    SERVICE_LEVEL_BY_FAMILY,
    ServiceLevel,
    service_level_for,
    service_level_for_sku,
    z_for,
)
from app.pipeline.registry import cfg

AS_OF = date(2026, 3, 2)


def ctx(**over) -> RunContext:
    base = {
        "run_id": "run-n13", "tenant_id": 1, "store_id": 171, "as_of": AS_OF,
        "snapshot_id": "snap-1", "config_version": "default", "seed": 0,
        "versions": {"policy": "1.0.0"},
    }
    return RunContext(**{**base, **over})


def sl(**over) -> ServiceLevel:
    base = dict(category_family="spirits", unit_price=30.0, unit_cost=20.0,
                ctx=ctx())
    return service_level_for_sku(**{**base, **over})


# ── The arithmetic ───────────────────────────────────────────────────────────


def test_q_star_from_margin_and_holding() -> None:
    """q* = Cu / (Cu + Co), with Co the holding cost of ONE unit for ONE cycle."""
    s = sl()
    assert s.basis == "critical_fractile"
    assert s.unit_margin == pytest.approx(10.0)
    assert s.holding_per_unit is not None and s.holding_per_unit > 0
    assert s.value == pytest.approx(
        s.unit_margin / (s.unit_margin + s.holding_per_unit)
    )
    # The cycle is lead time plus review period, derived rather than declared
    # again - two settings already own those numbers.
    c = ctx()
    assert s.cycle_days == (int(cfg.get(LEAD_TIME_DAYS, c))
                            + int(cfg.get(REVIEW_PERIOD_DAYS, c)))


def test_liquor_q_star_is_high_because_it_does_not_spoil() -> None:
    """The thesis of the prompt. A $20 spirit with $10 of margin costs about 35
    cents to hold for a cycle, so the economics say stock it generously."""
    s = sl()
    assert s.value > 0.95, (
        "spirits should want a high service level - a lost sale costs $10 and an "
        "extra bottle costs cents"
    )
    assert s.holding_per_unit < 1.0


def test_a_fatter_margin_wants_a_higher_service_level() -> None:
    thin = sl(unit_price=21.0)      # $1 margin
    fat = sl(unit_price=60.0)       # $40 margin
    assert fat.value > thin.value


def test_a_higher_holding_cost_wants_a_lower_service_level() -> None:
    """Same margin, more hazard. The only thing that changes is the family."""
    spirit = sl(category_family="spirits")
    beer = sl(category_family="beer")
    assert spirit.holding_per_unit < beer.holding_per_unit
    assert spirit.value > beer.value


def test_spirits_q_star_is_higher_than_the_dated_family() -> None:
    """The prompt names this "seasonal", but there is no seasonal family: N0.1
    deliberately declined to declare one, because nothing in the catalogue can
    identify a dated or limited SKU and a setting nothing can populate is worse
    than an honest default.

    `beer` is the dated family that DOES exist - freshness coding of 90 to 120
    days - and it carries the highest declared hazard, so it is the real test of
    the ordering.
    """
    assert sl(category_family="spirits").value > sl(category_family="beer").value
    assert sl(category_family="wine").value > sl(category_family="beer").value


# ── The clamp ───────────────────────────────────────────────────────────────


def test_q_star_is_clamped() -> None:
    """A thin margin on an expensive unit asks for a quantile the interval
    cannot support, and the clamp is recorded rather than silently applied."""
    c = ctx()
    floor = float(cfg.get(Q_STAR_FLOOR, c))
    ceiling = float(cfg.get(Q_STAR_CEILING, c))

    thin = sl(unit_price=20.5, unit_cost=20.0)      # 50c margin, $20 of capital
    assert thin.value == pytest.approx(floor)
    assert thin.clamped is True

    # And the ceiling binds for an enormous margin on a cheap, safe unit.
    huge = sl(unit_price=500.0, unit_cost=1.0)
    assert huge.value == pytest.approx(ceiling)
    assert huge.clamped is True


def test_an_unclamped_fractile_says_it_was_not_clamped() -> None:
    s = sl()
    assert s.clamped is False


def test_the_clamp_keeps_z_inside_a_range_the_interval_supports() -> None:
    """The clamp is an admission about the INTERVAL, not about the economics:
    sigma is recovered from a p10/p90 spread, so asking for the far tail is
    asking the interval for a number it was never calibrated to give."""
    c = ctx()
    for family in ("spirits", "beer", "wine", None):
        for price, cost in ((30.0, 20.0), (20.5, 20.0), (500.0, 1.0)):
            v = service_level_for_sku(category_family=family, unit_price=price,
                                      unit_cost=cost, ctx=c).value
            assert float(cfg.get(Q_STAR_FLOOR, c)) <= v <= float(
                cfg.get(Q_STAR_CEILING, c))
            assert z_for(v) < z_for(0.99)


# ── The fallback, and it must announce itself ───────────────────────────────


def test_q_star_falls_back_without_cost_and_says_so() -> None:
    """Five of ten audited stores send no unit cost at all. No cost means no
    margin means no fractile - and the card must be able to tell the owner that
    the number is a commercial default rather than their own economics."""
    s = sl(unit_cost=None)
    assert s.basis == "declared_family:spirits"
    assert s.is_derived is False
    assert s.value == pytest.approx(
        service_level_for("spirits", ctx(), cfg)
    )
    assert s.holding_per_unit is None
    assert "no unit cost" in s.explain()


def test_fallback_when_price_is_missing() -> None:
    assert sl(unit_price=None).is_derived is False


def test_fallback_when_cost_exceeds_price() -> None:
    """A broken price field, not a loss-leader: 187 real bottles in the export
    carry prices below their cost. Refuse to compute economics from them."""
    assert sl(unit_price=10.0, unit_cost=20.0).is_derived is False


def test_fallback_when_cost_is_zero() -> None:
    """A zero cost makes margin equal price and the fractile meaningless; the
    same `0 < cost < price` rule the outcome grader uses."""
    assert sl(unit_cost=0.0).is_derived is False


def test_unknown_family_falls_back_to_the_default_level() -> None:
    s = sl(category_family=None, unit_cost=None)
    assert s.basis == "declared_family:default"
    assert s.value == pytest.approx(
        float(cfg.get(SERVICE_LEVEL_BY_FAMILY["default"], ctx()))
    )


def test_derived_and_declared_are_distinguishable_on_the_wire() -> None:
    """A computed fractile and a commercial guess look identical once they are
    both a float, so the basis travels with the value."""
    a, b = sl(), sl(unit_cost=None)
    assert a.value != b.value
    assert a.as_dict()["basis"] != b.as_dict()["basis"]
    assert a.is_derived and not b.is_derived


# ── What the derivation says about the declared guesses ─────────────────────


def test_the_declared_levels_have_the_ordering_backwards() -> None:
    """A finding, pinned so it cannot be quietly forgotten.

    The declared levels were chosen on TURNOVER - beer turns fastest so it got
    0.95, wine turns slowest so it got 0.85. The economics order them the other
    way, on MARGIN against SPOILAGE: spirits do not go off, beer does.

    Wine is the big one: declared 0.85 against a derived 0.95 on the
    slowest-turning category in the estate, which means the declared level has
    been systematically understocking it.
    """
    c = ctx()
    declared = {f: service_level_for(f, c, cfg) for f in ("beer", "spirits", "wine")}
    derived = {f: sl(category_family=f).value for f in ("beer", "spirits", "wine")}

    assert declared["beer"] > declared["spirits"] > declared["wine"], (
        "the declared ordering, by turnover"
    )
    assert derived["spirits"] > derived["wine"] > derived["beer"], (
        "the derived ordering, by margin against spoilage - the reverse"
    )
    assert derived["wine"] - declared["wine"] > 0.05, (
        "wine is the category the declared level most understocks"
    )
    # And that gap is not cosmetic: it is more safety stock, not a rounding.
    assert z_for(derived["wine"]) > z_for(declared["wine"]) * 1.4


def test_both_clamp_settings_are_declared_provisional() -> None:
    for setting in (Q_STAR_FLOOR, Q_STAR_CEILING):
        assert setting.status == "PROVISIONAL"
        assert setting.why.strip() and setting.owner.strip()
        assert cfg.get(setting, ctx()) is not None


# ── N1.2: the policy module uses the derived level, and still refuses ───────


def test_estimate_policy_uses_the_derived_service_level() -> None:
    """Supply the economics and the policy orders against q*, not the declared
    family guess. Wine is the clearest case: declared 0.85, derived ~0.95."""
    from app.pipeline.policy.inventory import PolicyRequest, estimate_policy

    def run(**over):
        base = dict(sku="0245", family="wine", p10=18.0, p50=30.0, p90=45.0,
                    horizon_open_days=26, on_hand=4.0)
        r = estimate_policy(PolicyRequest(**{**base, **over}), ctx())
        assert r.ok, r.reasons
        return r.value

    declared = run()
    derived = run(unit_price=30.0, unit_cost=20.0)

    assert declared.service_level == pytest.approx(
        service_level_for("wine", ctx(), cfg))
    assert derived.service_level > declared.service_level
    assert derived.ideal_qty > declared.ideal_qty, (
        "a higher service level must buy more safety stock, or q* is inert"
    )
    # And the basis is on the card, not just in the number.
    assert any("computed from" in a for a in derived.assumptions)
    assert any("DECLARED" in a for a in declared.assumptions)


def test_route_refuses_quantity_without_interval() -> None:
    """The guardrail that must not be softened: no interval, no sigma, no
    quantity. Substituting a default sigma is the exact failure this rebuild
    exists to remove."""
    from app.pipeline.policy.inventory import PolicyRequest, estimate_policy

    r = estimate_policy(
        PolicyRequest(sku="0245", family="spirits", p10=None, p50=30.0,
                      p90=None, horizon_open_days=26, on_hand=0.0,
                      unit_price=30.0, unit_cost=20.0),
        ctx(),
    )
    assert not r.ok
    assert any("no_interval" in x or "sigma" in x for x in r.reasons)


def test_card_carries_the_lead_time_assumption() -> None:
    """purchase_orders has the right columns and ZERO ROWS at four of five
    stores, so every reorder date rests on a declared lead time and must say so."""
    from app.pipeline.policy.inventory import PolicyRequest, estimate_policy

    r = estimate_policy(
        PolicyRequest(sku="0245", family="spirits", p10=18.0, p50=30.0,
                      p90=45.0, horizon_open_days=26, on_hand=0.0,
                      unit_price=30.0, unit_cost=20.0),
        ctx(),
    )
    assert r.ok
    joined = " ".join(r.value.assumptions).lower()
    assert "lead" in joined
    assert "declared" in joined or "assum" in joined
