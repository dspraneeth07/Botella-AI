"""Sheet 21 — the two defects an independent review found in the March ledger.

Both are failures of MEMORY and of INPUT, not of arithmetic, which is why
neither showed up in any earlier test: every stage was individually correct.

  lifecycle   Stroyski 1.75L was recommended on eight consecutive trading days
              and missed every one. The engine recomputed the same depressed
              window each morning with no idea it had already said this, or
              that the prediction was visibly failing.

  merchandise SKU 0123456789 at 3,506 units a month, `SKU 12` at ten cents
              (a bottle deposit), and bags of ice reached the TOP of the
              earnings table. Mechanics have huge volume and a wobbling
              trailing window, which is exactly the shape sheet 20 hunts.
              The engine was working correctly on data that should never have
              reached it.
"""

from __future__ import annotations

from datetime import date

import pytest

from app.pipeline import RunContext
from app.pipeline.blend.predictive_interval import lower_tail_probability
from app.pipeline.candidates.lifecycle import (
    CARD_MAX_OPEN_DAYS,
    CARD_REVIEW_OPEN_DAYS,
    DECLINE_TAIL_PROBABILITY,
    MIN_OPEN_DAYS_TO_JUDGE,
    POISSON_UNMEASURED,
    CardHistory,
    review_card,
)
from app.pipeline.candidates.merchandise import (
    MIN_MERCHANDISE_PRICE,
    MIN_SKU_LENGTH,
    classify,
    is_merchandise,
)
from app.pipeline.registry import cfg

AS_OF = date(2026, 3, 20)
ISSUED = date(2026, 3, 2)


def ctx(**over) -> RunContext:
    base = {
        "run_id": "run-21", "tenant_id": 171, "store_id": 171, "as_of": AS_OF,
        "snapshot_id": "snap-1", "config_version": "default", "seed": 0,
        "versions": {},
    }
    return RunContext(**{**base, **over})


def hist(baseline: float, units: float, days: int, sku: str = "SKU-1",
         cv: float | None = None) -> CardHistory:
    return CardHistory(sku=sku, first_issued=ISSUED, baseline_rate=baseline,
                       units_since=units, open_days_since=days,
                       dispersion_cv=cv)


def tail(units: float, mean: float, cv: float = 0.0) -> float:
    return lower_tail_probability(units, mean=mean, dispersion_cv=cv).probability


# ── The Stroyski case, reproduced ────────────────────────────────────────────


def test_the_stroyski_case_is_retired_before_it_can_repeat_eight_times() -> None:
    """Eight consecutive cards, every one a miss. The claim was that a
    depressed window would recover; sales kept falling instead.

    Checklist 17: the rule is a TAIL PROBABILITY now, and this states the one
    it fires on. Justified at 1/day, selling half that: on the seventh open day
    the card has 3 units against 7 expected, and if the product were still at
    1/day that few would happen 8.2% of the time - under the 10% floor. It is
    pulled before the eighth repeat. It is NOT pulled on day 3, where the same
    shape (1 unit against 3) is a 20% event: the old 0.8 ratio retired it
    there, on one quiet basket, and that was the defect.
    """
    floor = float(cfg.get(DECLINE_TAIL_PROBABILITY, ctx()))
    min_days = int(cfg.get(MIN_OPEN_DAYS_TO_JUDGE, ctx()))

    # Baseline 1.0/open day; realised 0.5 - falling further, not recovering.
    retired_on = None
    for day in range(1, 9):
        out = review_card(hist(1.0, 0.5 * day, day), ctx())
        if day < min_days:
            assert not out.retire, f"day {day}: too early to judge"
            continue
        p = tail(0.5 * day, 1.0 * day)
        if out.retire:
            retired_on = day
            assert out.rule == "declining"
            assert out.tail_probability == pytest.approx(p)
            assert p < floor
            assert out.distribution == POISSON_UNMEASURED
            break
        assert p >= floor, f"day {day}: tail {p:.3f} is under the floor and kept"
    else:
        pytest.fail("eight days of falling sales and the card never retired")

    assert retired_on is not None and retired_on < 8, retired_on
    assert retired_on == 7, "P(X<=3 | 7) = 0.082 is the first morning under 0.10"
    assert tail(3, 7) == pytest.approx(0.0818, abs=1e-3)
    # The day-3 verdict the old ratio rule got wrong.
    assert tail(1, 3) == pytest.approx(0.199, abs=1e-3)
    assert not review_card(hist(1.0, 1.5, 3), ctx()).retire


def test_declining_fires_early_which_is_the_entire_point() -> None:
    """A card that is actively wrong must go BEFORE the review window, or the
    rule only prevents the ninth repeat instead of the third.

    Justified at 2/day, 2 units in three open days against 6 expected: a 6.2%
    event if the product were still at 2/day, so retired on day three.
    """
    out = review_card(hist(2.0, 2.0, 3), ctx())
    assert out.retire
    assert out.rule == "declining"
    assert out.open_days_since < int(cfg.get(CARD_REVIEW_OPEN_DAYS, ctx()))
    assert out.tail_probability == pytest.approx(0.062, abs=1e-3)
    assert "6% of the time" in out.reason
    assert "no dispersion measured" in out.reason


def test_two_of_three_is_not_a_decline_it_is_tuesday() -> None:
    """THE defect. A product justified at 1/day that sold 2 in its first three
    open days had a ratio of 0.67 and was retired by the 0.8 rule. Under
    Poisson(3), two or fewer units is a 42% event - the card was right and
    the rule fired on noise."""
    assert tail(2, 3) == pytest.approx(0.423, abs=1e-3)
    out = review_card(hist(1.0, 2.0, 3), ctx())
    assert not out.retire, "a 42% event is not evidence of anything"
    # Zero units in three days IS: a 5% event.
    assert tail(0, 3) == pytest.approx(0.0498, abs=1e-3)
    assert review_card(hist(1.0, 0.0, 3), ctx()).rule == "declining"


def test_measured_dispersion_makes_the_rule_slower_not_faster() -> None:
    """An erratic SKU has quiet weeks as a matter of course. The same half-rate
    week that retires a Poisson card is a 22% event under the SKU's own cv of
    0.5, so the declining rule withholds and the no-recovery rule takes it at
    the review window instead - the right rule, for the right reason."""
    poisson = review_card(hist(1.0, 3.0, 7, cv=None), ctx())
    assert poisson.rule == "declining"
    assert poisson.distribution == POISSON_UNMEASURED

    erratic = review_card(hist(1.0, 3.0, 7, cv=0.5), ctx())
    assert tail(3, 7, cv=0.5) == pytest.approx(0.223, abs=1e-3)
    assert erratic.rule == "no_recovery", erratic
    assert erratic.tail_probability is None

    # Before the review window the erratic card is simply kept.
    assert not review_card(hist(1.0, 2.0, 5, cv=0.5), ctx()).retire


def test_a_measured_zero_dispersion_is_poisson_and_says_so() -> None:
    """cv == 0 is a legitimate measurement (identical weekly rates) and gets
    the Poisson tail as its honest answer - labelled as measured, not as the
    unmeasured fallback, because the two are different claims."""
    out = review_card(hist(2.0, 2.0, 3, cv=0.0), ctx())
    assert out.rule == "declining"
    assert out.distribution == "poisson"
    assert "measured dispersion of zero" in out.reason


def test_a_recovery_in_progress_is_left_alone() -> None:
    """The rule must not retire the cards that are working - that would be a
    worse defect than the one it fixes."""
    out = review_card(hist(1.0, 14.0, 7), ctx())     # 2.0/day against 1.0
    assert not out.retire
    assert out.reason is None
    assert out.recovery_ratio == pytest.approx(2.0)


def test_no_recovery_by_the_review_window_retires() -> None:
    """Flat is not recovery. The card predicted a rise, and it did not happen."""
    review = int(cfg.get(CARD_REVIEW_OPEN_DAYS, ctx()))
    flat = review_card(hist(1.0, float(review), review), ctx())
    assert flat.retire
    assert flat.rule == "no_recovery"
    assert flat.recovery_ratio == pytest.approx(1.0)


def test_a_stale_card_is_retired_even_while_it_is_working() -> None:
    """A card that has been up for a month is furniture. The claim can be
    re-earned tomorrow on current evidence, which is the point - this retires
    a CLAIM, never a product."""
    mx = int(cfg.get(CARD_MAX_OPEN_DAYS, ctx()))
    out = review_card(hist(1.0, 1.2 * mx, mx), ctx())   # still recovering
    assert out.retire
    assert out.rule == "stale"
    assert out.recovery_ratio > 1.0


# ── Withholding judgement is itself a decision ──────────────────────────────


def test_too_early_to_judge_withholds_rather_than_guessing() -> None:
    """One or two open days is a couple of baskets. Retiring on that is as
    arbitrary as never retiring, and it is the failure mode that makes a
    lifecycle rule worse than no rule."""
    for day in range(int(cfg.get(MIN_OPEN_DAYS_TO_JUDGE, ctx()))):
        out = review_card(hist(1.0, 0.0, day), ctx())
        assert not out.retire, f"{day} open days is not evidence"
        assert out.rule is None


def test_zero_open_days_is_not_a_divide() -> None:
    """Sheet 19 shipped an unguarded divide that turned a closed store's lift
    into Infinity. Both properties are computed, not just read."""
    h = hist(1.0, 0.0, 0)
    assert h.realised_rate == 0.0
    assert review_card(h, ctx()).retire is False


def test_no_baseline_withholds_judgement_rather_than_inventing_one() -> None:
    """A card with no baseline rate cannot be judged against one. Returning a
    ratio of zero would retire it instantly on a comparison that never
    happened."""
    h = hist(0.0, 5.0, 10)
    assert h.recovery_ratio == pytest.approx(1.0)
    out = review_card(h, ctx())
    # ratio 1.0 at or past the review window is "no recovery", which is honest:
    # nothing can be shown to have improved.
    assert out.rule == "no_recovery"


def test_the_decline_threshold_is_a_tail_probability_not_a_ratio() -> None:
    """Demanding no dip at all below baseline would retire half of a genuine
    recovery on its first quiet day. The floor is a probability, declared
    once, and a wobble sits nowhere near it."""
    floor = float(cfg.get(DECLINE_TAIL_PROBABILITY, ctx()))
    assert 0.0 < floor < 0.5, "above a half the rule retires the median card"
    assert floor == pytest.approx(0.10)
    wobble = review_card(hist(1.0, 4.5, 5), ctx())   # 0.9/day, a wobble
    assert not wobble.retire, "a 10% dip is noise, not a decline"
    assert tail(4.5, 5) == pytest.approx(0.440, abs=1e-3)
    assert DECLINE_TAIL_PROBABILITY.status == "PROVISIONAL"
    assert "0.42" in DECLINE_TAIL_PROBABILITY.why, "the why states the arithmetic"


def test_every_retirement_carries_a_reason_a_person_could_read() -> None:
    """A refusal nobody can explain is a refusal nobody can appeal."""
    for h in (hist(1.0, 1.5, 3), hist(1.0, 7.0, 7), hist(1.0, 30.0, 25)):
        out = review_card(h, ctx())
        if out.retire:
            assert out.reason and len(out.reason) > 20
            assert out.rule
            assert "%" in out.reason or "days" in out.reason


# ── Merchandise: the offenders from the real reports ────────────────────────


@pytest.mark.parametrize("sku,name,price,rule", [
    ("0123456789", "Placeholder", 5.0, "placeholder_sku"),
    ("0000", "Whatever", 5.0, "placeholder_sku"),
    ("UNKNOWN", "Unknown Author Cabernet 750ml", 19.99, "placeholder_sku"),
    ("2", "Manual entry tax", 0.0, "sku_too_short"),
    ("SKU 12", "CRV 10 cents", 0.10, "placeholder_sku"),
    ("01033100000", "BOTTLE DEPOSIT", 0.05, "non_merchandise_name"),
    ("2405700000", "INSTANT LOTTERY", 5.0, "non_merchandise_name"),
    ("074334000500", "EASTERN ICE BAG 5LBS", 2.99, "non_merchandise_name"),
    ("1000", "CRV", 0.05, "non_merchandise_name"),
    ("619947000013", "Ice Bag 10lb", 2.99, "non_merchandise_name"),
    ("4011", "Gift Card", 25.0, "non_merchandise_name"),
    ("998877665544", "Bottle Deposit", 0.05, "non_merchandise_name"),
    ("", "No code", 5.0, "no_sku"),
])
def test_the_real_offenders_are_refused_with_a_named_rule(
    sku: str, name: str, price: float, rule: str
) -> None:
    v = classify(sku, name, price, ctx())
    assert v.is_merchandise is False, f"{sku} {name} should be refused"
    assert v.rule == rule
    assert v.detail and len(v.detail) > 10


@pytest.mark.parametrize("sku,name,price", [
    ("085592104510", "McCormick Vodka 1.75L", 12.99),
    ("088004027834", "Wheatley Vodka 50ml", 1.49),
    ("080480016210", "BACARDI Silver 50ML", 1.29),
    ("856065002400", "Deep Eddy Lemon 50 ml", 1.99),
    ("718179673214", "Hidden Stock 1.75ml", 24.99),
    ("A1234B", "House Red 750ml", 8.99),
])
def test_real_products_are_kept(sku: str, name: str, price: float) -> None:
    v = classify(sku, name, price, ctx())
    assert v.is_merchandise is True, f"{sku} {name}: {v.rule} - {v.detail}"
    assert v.rule is None


def test_narrowing_the_rules_kept_the_real_stock_they_used_to_delete() -> None:
    """Every one of these was refused by the FIRST version of this filter, and
    every one is real, orderable stock. Audited against all ten stores'
    catalogues, which is the only way any of it surfaced.

      1690 / 1389 / 12390  matched an "ascending digits" pattern that in
                           practice matches almost any number
      417 / 443 / 105      refused by a four-character minimum; plenty of
                           stores number their own stock in three digits and
                           kegs almost always do
      3A                   same, at two characters
      Department 66        a WINERY, refused by the term "department"
      GROUNDING            refused because it contains "rounding"
    """
    for sku, name in (
        ("1690", "Absolut MANDRIN vodka"),
        ("1389", "Paul Masson VS Grand Amber brandy"),
        ("12390", "Moet & Chandon IMPERIAL Rose"),
        ("417", "E&J VS BRANDY-200 ML"),
        ("443", "BUD LIGHT (12 OZ 12PK BOTTLE)"),
        ("105", "Keg Miller Lite BIG"),
        ("3A", "ADICTIVO ANEJO 50ML"),
        ("13518", "Department 66 Others Grenache"),
        ("024291110149", "LYNX POLARIZED GROUNDING AD."),
    ):
        v = classify(sku, name, 9.99, ctx())
        assert v.is_merchandise is True, f"{sku} {name}: refused by {v.rule}"


def test_a_word_term_matches_a_word_and_not_a_substring_of_one() -> None:
    """"rounding" as a plain substring refused "LYNX POLARIZED GROUNDING AD.".
    A bare substring test on short words silently eats anything containing
    them, and the failure is invisible because the line simply never appears.
    """
    assert not is_merchandise("999999999999", "Bottle Deposit", 5.0, ctx())
    assert is_merchandise("999999999999", "Depositary Reserve Wine", 29.99, ctx())
    assert is_merchandise("999999999999", "Surrounding Hills Pinot", 19.99, ctx())


def test_a_sub_floor_price_is_flagged_and_KEPT() -> None:
    """Measured the hard way. A price floor looked like a clean deposit filter
    and refused 187 real bottles at Bethany - St. George Baller Single Malt,
    Ilegal Joven Mezcal, Monte Cristo Espada - which are stock with a broken
    price field, not deposits. The name rules catch mechanics on their own."""
    v = classify("027724387507", "St. George Baller Sgl Malt 750", 0.10, ctx())
    assert v.is_merchandise is True, "a mispriced real bottle must not be deleted"
    assert v.rule is None
    assert v.detail and "broken price" in v.detail


def test_a_missing_price_does_not_refuse_a_real_sku() -> None:
    """31 stores send no cost and some lines carry no price. Absence of a price
    is not evidence of a deposit, and refusing on it would delete real stock."""
    assert is_merchandise("085592104510", "McCormick Vodka 1.75L", None, ctx())


def test_a_long_real_barcode_beginning_with_a_digit_run_is_untouched() -> None:
    r"""A 12-digit UPC may legitimately begin 0123456789. The first version
    matched `0123456789\d*` and refused real barcodes; the pattern is now the
    exact placeholder only."""
    for sku in ("012345678905", "091234567890", "012345678901"):
        assert is_merchandise(sku, "Real Bottle 750ml", 9.99, ctx()), sku
    assert not is_merchandise("0123456789", "Jose Golden Margarita", 9.99, ctx())


def test_the_price_floor_flags_but_the_length_rule_barely_fires() -> None:
    """Both settings were cut back after being measured against the estate.
    The price floor no longer refuses anything, and the length rule refuses
    only a single character - a till department key."""
    floor = float(cfg.get(MIN_MERCHANDISE_PRICE, ctx()))
    assert 0.10 < floor < 1.0
    assert int(cfg.get(MIN_SKU_LENGTH, ctx())) == 2, (
        "at 4 this refused E&J Brandy, Bud Light and three kegs")


def test_retirement_without_suppression_would_do_nothing() -> None:
    """The piece that makes the rest of it work.

    The engine recomputes a depressed trailing window every morning, so a
    retired card is re-earned tomorrow by exactly the evidence just shown to be
    wrong - the eight-day Stroyski loop, restarted on day two. Suppression is
    what turns "retire" into "stop saying this".
    """
    from app.pipeline.candidates.lifecycle import (
        RETIRE_SUPPRESS_OPEN_DAYS,
        suppressed_until,
    )

    window = int(cfg.get(RETIRE_SUPPRESS_OPEN_DAYS, ctx()))
    assert window > int(cfg.get(CARD_REVIEW_OPEN_DAYS, ctx())), (
        "suppression must outlast the review window, or a card is retired and "
        "re-issued inside the same review cycle"
    )
    assert suppressed_until(10, ctx()) == 10 + window


def test_the_stored_suppression_date_is_a_projection_of_open_days() -> None:
    """Fourteen OPEN days from today is not a date anyone knows yet, so the
    date Node stores is projected from the store's trailing open-day density
    and rounded UP - the error that matters is a card coming back early."""
    from datetime import timedelta

    from app.pipeline.candidates.lifecycle import suppression_end_date

    seven_day = suppression_end_date(AS_OF, 1.0, ctx())
    assert seven_day == AS_OF + timedelta(days=14)
    sunday_closed = suppression_end_date(AS_OF, 24 / 28, ctx())
    assert sunday_closed == AS_OF + timedelta(days=17), "14 / (24/28) = 16.3, up"
    assert sunday_closed > seven_day
    # A nonsense density is a caller error and projects the SHORTEST window
    # rather than raising mid-run or inventing a long one.
    assert suppression_end_date(AS_OF, 0.0, ctx()) == seven_day
    assert suppression_end_date(AS_OF, 3.0, ctx()) == seven_day


def test_an_already_retired_history_is_recognised() -> None:
    """A stored retirement is not re-judged. Node sends one only while nothing
    fresher has been issued - a card written after the retirement is a new
    claim and arrives WITHOUT the retirement - so its presence is the whole
    signal, and the route does not re-derive it from dates that lag the run."""
    from datetime import timedelta

    old = CardHistory(sku="X", first_issued=ISSUED, baseline_rate=1.0,
                      units_since=0.0, open_days_since=10,
                      retired_at=ISSUED + timedelta(days=5),
                      suppressed_until=ISSUED + timedelta(days=19))
    assert old.already_retired is True
    # How a superseded retirement arrives: it does not.
    fresh = CardHistory(sku="X", first_issued=ISSUED + timedelta(days=20),
                        baseline_rate=1.0, units_since=0.0, open_days_since=3)
    assert fresh.already_retired is False
    assert hist(1.0, 0.0, 3).already_retired is False
