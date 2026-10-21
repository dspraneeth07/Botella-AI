"""N5.1 — the lifecycle and the catalogue contract, on the live request path.

Both were built, tested and reached only by the audit harness. Measured there,
the lifecycle cut 162 March cards to 69 AT THE SAME HIT RATE and pulled a failing
card after 3 days instead of 8: Stroyski 1.75L had been recommended on eight
consecutive trading days, missing every one, because each morning recomputed the
same depressed window with no memory.
"""

from __future__ import annotations

from datetime import date, timedelta
from types import SimpleNamespace

import pytest

from app.pipeline.candidates.lifecycle import (
    CARD_REVIEW_OPEN_DAYS,
    DECLINE_TAIL_PROBABILITY,
    MIN_CANDIDATE_POOL,
    MIN_OPEN_DAYS_TO_JUDGE,
    RETIRE_SUPPRESS_OPEN_DAYS,
    CardHistory,
)
from app.pipeline.registry import cfg
from app.recommender import deterministic as D

AS_OF = date(2026, 3, 31)

#: The candidate-pool floor switched OFF. The suppression tests below use a
#: single-SKU fixture, which is a pool of one - under any sensible floor - so
#: with the floor on, the suppression they test would be relaxed on the spot.
#: The floor has its own tests further down; these test suppression alone.
NO_FLOOR = cfg.with_overrides("default", {MIN_CANDIDATE_POOL.name: 0})


def sales(sku: str, *, days: int, per_day: float, dip_per_day: float | None = None,
          dip_days: int = 28, end: date = AS_OF, skip_sundays: bool = False):
    """Daily sale rows in the shape `choose` consumes.

    Rows are OBJECTS with .sku/.sale_date/.units - `choose` reads them with
    getattr, not as dicts. `dip_per_day` makes the trailing window run below the
    long run, which is what makes a SKU a sheet-20 candidate at all.
    """
    out = []
    d = end - timedelta(days=days)
    while d < end:
        if not (skip_sundays and d.weekday() == 6):
            units = (dip_per_day if dip_per_day is not None
                     and (end - d).days <= dip_days else per_day)
            out.append(SimpleNamespace(sku=sku, sale_date=d, units=units))
        d += timedelta(days=1)
    return out


def choose(rows, **over):
    base = dict(client_id=1, location_id=171, as_of=AS_OF, limit=10)
    return D.choose(rows, **{**base, **over})


# ── A card with no memory repeats; a card with memory does not ──────────────


def test_route_retires_a_declining_card() -> None:
    """The card is up, sales since issue are BELOW the rate that justified it, and
    the route must not issue it again.

    The declining rule fires EARLY - from day 3 - which is the whole point: eight
    days of Stroyski was eight days of watching a prediction fail.
    """
    # A genuine sheet-20 candidate: long run 1.5 a day, trailing 28 days dipped
    # to 0.4, so it is material AND carries a positive deficit.
    rows = sales("0245", days=400, per_day=1.5, dip_per_day=0.4)
    assert "0245" in {p.sku for p in choose(rows)}, (
        "the fixture must be a candidate, or there is nothing to suppress"
    )

    # Issued 6 open days ago claiming 0.4 a day, and nothing has arrived: 0
    # units against 2.4 expected is a 9% event if the claim held, under the
    # 10% tail floor.
    failing = (CardHistory(sku="0245", first_issued=AS_OF - timedelta(days=6),
                           baseline_rate=0.4, units_since=0.0,
                           open_days_since=6),)
    selection = D.select(rows, client_id=1, location_id=171, as_of=AS_OF,
                         limit=10, card_history=failing, config=NO_FLOOR)
    assert "0245" not in {p.sku for p in selection.picks}, (
        "a visibly failing card must not be re-issued - this is the eight days "
        "of Stroyski the lifecycle exists to stop"
    )
    # And the retirement LEAVES the process, dated, so Node can store it.
    assert len(selection.retirements) == 1
    r = selection.retirements[0]
    assert r.sku == "0245" and r.rule == "declining"
    assert r.retired_at == AS_OF
    assert r.tail_probability == pytest.approx(0.0907, abs=1e-3)
    assert r.distribution == "poisson_unmeasured_dispersion"
    # The stored end date is PROJECTED from the trailing open-day density.
    # This fixture's rows stop the day before AS_OF, so the trailing 28 days
    # hold 27 open days and fourteen open days project to fifteen calendar
    # days - rounded up, because a card coming back early is the error that
    # matters. A seven-day store with a row on AS_OF would project fourteen.
    from app.pipeline.candidates.lifecycle import suppression_end_date
    assert r.suppressed_until == suppression_end_date(AS_OF, 27 / 28, _ctx())
    assert r.suppressed_until == AS_OF + timedelta(days=15)
    assert selection.screened["suppressed_after_retirement"] == 1

    # And the rule must be DISCRIMINATING, not a blanket suppression: a card
    # that is delivering stays.
    delivering = (CardHistory(sku="0245", first_issued=AS_OF - timedelta(days=6),
                              baseline_rate=0.4, units_since=4.0,
                              open_days_since=6),)
    assert "0245" in {p.sku for p in choose(rows, card_history=delivering)}

    assert 0.0 < float(cfg.get(DECLINE_TAIL_PROBABILITY, _ctx())) < 1.0
    assert int(cfg.get(MIN_OPEN_DAYS_TO_JUDGE, _ctx())) == 3


def test_the_route_measures_dispersion_as_of_issue_from_raw_rows() -> None:
    """Through the Node-row path `units_since` is MEASURED from the series and
    the selector supplies the SKU's own scatter, anchored at `first_issued`.
    A 13-week history earns a measured cv, so the retirement names
    negative_binomial and its tail is wider than the Poisson fallback's."""
    from app.pipeline.blend.predictive_interval import lower_tail_probability

    issued = AS_OF - timedelta(days=10)
    # The SKU sells 1.5/day for a year, dips to 0.4/day, then sells NOTHING
    # after the card goes up. A filler SKU keeps the store trading on those
    # days, because a trading day is a day the store sold something.
    rows = [r for r in sales("0245", days=400, per_day=1.5, dip_per_day=0.4)
            if r.sale_date <= issued]
    rows += sales("7777", days=400, per_day=1.0)
    node_rows = [{"sku": "0245", "first_issued": issued.isoformat(),
                  "times_shown": 9, "baseline_rate": 0.4}]
    selection = D.select(rows, client_id=1, location_id=171, as_of=AS_OF,
                         limit=10, card_history_rows=node_rows)
    assert len(selection.retirements) == 1
    r = selection.retirements[0]
    assert r.rule == "declining", r
    assert r.open_days_since == 9, "AS_OF itself has no row in this fixture"
    assert r.distribution == "negative_binomial"
    poisson = lower_tail_probability(0, mean=0.4 * 9, dispersion_cv=0.0)
    assert poisson.probability == pytest.approx(0.0273, abs=5e-4)
    assert r.tail_probability > poisson.probability, (
        "the SKU's own scatter makes a quiet spell LESS surprising")
    assert "own measured scatter" in r.reason


def _ctx():
    from app.pipeline.context import RunContext
    return RunContext(run_id="r", tenant_id=1, store_id=171, as_of=AS_OF,
                      snapshot_id="s", config_version="default", seed=0,
                      versions={"temporal_reversion": "1.1.0"})


def test_retired_card_is_suppressed_for_fourteen_open_days() -> None:
    """Retirement WITHOUT suppression does nothing: the next morning re-earns the
    card from exactly the evidence just shown to be wrong. Suppression is the only
    transition that makes the state machine terminate."""
    ctx = _ctx()
    assert int(cfg.get(RETIRE_SUPPRESS_OPEN_DAYS, ctx)) == 14

    from app.pipeline.candidates.lifecycle import suppressed_until
    retired_on_open_day = 100
    until = suppressed_until(retired_on_open_day, ctx, cfg)
    assert until == retired_on_open_day + 14

    # Inside the window the SKU is held; outside it may be earned again.
    assert retired_on_open_day + 13 < until
    assert retired_on_open_day + 14 >= until


# ── A verdict is made once: the STORED date is honoured ─────────────────────


def _retired(sku: str, retired_at: date, until: date) -> CardHistory:
    """A history as Node reports it AFTER storing a retirement: first_issued is
    the old card, retired_at and suppressed_until are the stored verdict."""
    return CardHistory(sku=sku, first_issued=retired_at - timedelta(days=6),
                       baseline_rate=0.4, units_since=0.0,
                       open_days_since=6 + (AS_OF - retired_at).days,
                       retired_at=retired_at, suppressed_until=until,
                       retirement_rule="declining")


def test_a_stored_suppression_is_honoured_not_recomputed() -> None:
    """The defect: `retired_index` was today's index every morning, so the
    suppression was "today + 14" every morning - rolling forever while the
    rule fired, gone the moment it stopped. The stored date is now the
    authority, and the card is NOT re-judged while it stands."""
    rows = sales("0245", days=400, per_day=1.5, dip_per_day=0.4)
    retired_at = AS_OF - timedelta(days=10)

    # Day 10 of a 14-day window: still held, and no NEW retirement is decided
    # even though the old card would fail every rule if re-judged.
    held = D.select(rows, client_id=1, location_id=171, as_of=AS_OF, limit=10,
                    card_history=(_retired("0245", retired_at,
                                           retired_at + timedelta(days=14)),),
                    config=NO_FLOOR)
    assert "0245" not in {p.sku for p in held.picks}
    assert held.retirements == (), "a stored verdict is not re-made"
    assert held.screened["suppressed_after_retirement"] == 1

    # The window has passed: the claim may be re-earned, and STILL no new
    # retirement is written for the old card - that would restart the loop.
    free = D.select(rows, client_id=1, location_id=171, as_of=AS_OF, limit=10,
                    card_history=(_retired("0245", retired_at,
                                           retired_at + timedelta(days=9)),),
                    config=NO_FLOOR)
    assert "0245" in {p.sku for p in free.picks}
    assert free.retirements == ()
    assert "suppressed_after_retirement" not in free.screened


def test_the_stored_date_ends_on_its_own_day_and_not_before() -> None:
    """suppressed_until is the first day the claim MAY be made again."""
    rows = sales("0245", days=400, per_day=1.5, dip_per_day=0.4)
    retired_at = AS_OF - timedelta(days=14)
    on_the_day = D.select(rows, client_id=1, location_id=171, as_of=AS_OF,
                          limit=10, card_history=(_retired("0245", retired_at, AS_OF),),
                          config=NO_FLOOR)
    assert "0245" in {p.sku for p in on_the_day.picks}
    day_before = D.select(rows, client_id=1, location_id=171, as_of=AS_OF,
                          limit=10,
                          card_history=(_retired("0245", retired_at,
                                                 AS_OF + timedelta(days=1)),),
                          config=NO_FLOOR)
    assert "0245" not in {p.sku for p in day_before.picks}


def test_a_fresh_card_after_a_stored_retirement_is_judged_on_its_own() -> None:
    """A claim re-earned once the window passed is a new claim. Node reports
    it with ITS first_issued and baseline and WITHOUT the old retirement (the
    feed drops a retirement that a fresher card has superseded), so the route
    judges it like any other - including retiring it again if it fails."""
    rows = sales("0245", days=400, per_day=1.5, dip_per_day=0.4)
    fresh = CardHistory(sku="0245", first_issued=AS_OF - timedelta(days=6),
                        baseline_rate=0.4, units_since=0.0, open_days_since=6)
    assert fresh.already_retired is False
    out = D.select(rows, client_id=1, location_id=171, as_of=AS_OF, limit=10,
                   card_history=(fresh,), config=NO_FLOOR)
    assert len(out.retirements) == 1 and out.retirements[0].retired_at == AS_OF
    assert "0245" not in {p.sku for p in out.picks}


# ── The candidate-pool floor ─────────────────────────────────────────────────


def _many(skus) -> list:
    rows: list = []
    for sku in skus:
        rows += sales(sku, days=400, per_day=1.5, dip_per_day=0.4)
    return rows


def test_a_large_pool_is_byte_identical_with_suppression_applied() -> None:
    """With more candidates than the floor, suppression simply removes the
    retired SKU and nothing else moves: same picks in the same order, same
    counts, and no relaxation key appears at all."""
    skus = [f"10{i:02d}" for i in range(1, 9)]          # eight candidates
    rows = _many(skus)
    floor = int(cfg.get(MIN_CANDIDATE_POOL, _ctx()))
    assert len(skus) - 1 >= floor, "the fixture must clear the floor"

    retired_at = AS_OF - timedelta(days=3)
    stored = (_retired("1003", retired_at, retired_at + timedelta(days=14)),)
    without = D.select(rows, client_id=1, location_id=171, as_of=AS_OF,
                       limit=10)
    with_hist = D.select(rows, client_id=1, location_id=171, as_of=AS_OF,
                         limit=10, card_history=stored)
    assert [p.sku for p in without.picks] == skus
    assert [p.sku for p in with_hist.picks] == [s for s in skus if s != "1003"]
    assert with_hist.relaxed == ()
    assert with_hist.screened == {"suppressed_after_retirement": 1}
    assert without.screened == {}


def test_the_floor_relaxes_suppression_nearest_expiry_first_and_counts_it() -> None:
    """Three candidates, two of them suppressed, floor of two: the pool after
    suppression is one, so ONE suppression is relaxed - the card nearest the
    end of its window, because its trailing window has turned over most. The
    release is counted, never silent."""
    skus = ["1001", "1002", "1003"]
    rows = _many(skus)
    retired_at = AS_OF - timedelta(days=5)
    stored = (
        _retired("1001", retired_at, AS_OF + timedelta(days=9)),   # later
        _retired("1002", retired_at, AS_OF + timedelta(days=2)),   # sooner
    )
    config = cfg.with_overrides("default", {MIN_CANDIDATE_POOL.name: 2})
    out = D.select(rows, client_id=1, location_id=171, as_of=AS_OF, limit=10,
                   card_history=stored, config=config)
    assert out.relaxed == ("1002",), out.relaxed
    assert {p.sku for p in out.picks} == {"1003", "1002"}
    assert out.screened == {"suppressed_after_retirement": 1,
                            "suppression_relaxed_for_pool_floor": 1}

    # Under the DEFAULT floor one candidate is not a selection, it is whatever
    # was left, so both are released - still nearest expiry first.
    default = D.select(rows, client_id=1, location_id=171, as_of=AS_OF,
                       limit=10, card_history=stored)
    assert int(cfg.get(MIN_CANDIDATE_POOL, _ctx())) == 3
    assert default.relaxed == ("1002", "1001")
    assert default.screened["suppression_relaxed_for_pool_floor"] == 2
    assert default.screened["suppressed_after_retirement"] == 0

    # And switched off, suppression is absolute: one card is what is shown.
    off = D.select(rows, client_id=1, location_id=171, as_of=AS_OF, limit=10,
                   card_history=stored, config=NO_FLOOR)
    assert [p.sku for p in off.picks] == ["1003"]
    assert off.relaxed == () and off.screened == {"suppressed_after_retirement": 2}


def test_relaxation_never_exceeds_what_the_floor_needs() -> None:
    """Six candidates, four suppressed, floor three: one is released and the
    other three stay held. The floor is a floor, not a reset."""
    skus = [f"10{i:02d}" for i in range(1, 7)]
    rows = _many(skus)
    retired_at = AS_OF - timedelta(days=5)
    stored = tuple(
        _retired(s, retired_at, AS_OF + timedelta(days=n))
        for n, s in enumerate(("1001", "1002", "1003", "1004"), start=1)
    )
    out = D.select(rows, client_id=1, location_id=171, as_of=AS_OF, limit=10,
                   card_history=stored)
    assert len(out.picks) == 3
    assert out.relaxed == ("1001",)
    assert out.screened == {"suppressed_after_retirement": 3,
                            "suppression_relaxed_for_pool_floor": 1}
    assert {"1002", "1003", "1004"}.isdisjoint({p.sku for p in out.picks})


def test_open_day_counting_on_a_sunday_closed_store() -> None:
    """A store shut on Sundays reaches its day-7 review after EIGHT calendar days,
    and the rule must not fire early because of that.

    The route builds its open-day index from the TRADING CALENDAR, so a Sunday
    simply is not a day. This asserts the two differ, which is the only thing
    that makes the distinction load-bearing.
    """
    rows = sales("0245", days=400, per_day=1.0, skip_sundays=True)
    trading = sorted({r.sale_date.isoformat() for r in rows})
    assert len(trading) < 400, "the fixture must actually skip Sundays"

    # Seven OPEN days back is more than seven calendar days back.
    opens = [date.fromisoformat(d) for d in trading]
    seventh_open_day_back = opens[-7]
    assert (AS_OF - seventh_open_day_back).days > 7, (
        "seven open days must span more than seven calendar days at a "
        "Sunday-closed store - otherwise the review window is being counted "
        "in the wrong unit"
    )
    review = int(cfg.get(CARD_REVIEW_OPEN_DAYS, _ctx()))
    assert review == 7


# ── Two screens, and the second is not a replacement for the first ──────────


def test_route_uses_the_catalogue_merchandise_filter() -> None:
    """The audited contract: 45 of 44,398 SKUs refused, 0.10%. It screens on NAME
    and PRICE, which the route's own blocklist does not look at."""
    # A bag of ice has an ordinary SKU shape and would pass the blocklist.
    assert D.is_orderable_sku("Ice Bag Large", None) is True

    from app.pipeline.candidates.merchandise import is_merchandise as catalogue
    assert catalogue("Ice Bag Large", "Ice Bag Large", 1.35, _ctx()) is False, (
        "the catalogue filter is the one that knows ice is not stock"
    )

    # And it does NOT delete real stock - the near-miss this module exists for.
    for sku, name, price in (("1690", "1690 Absolut Mandrin", 24.99),
                             ("417", "417 E&J Brandy", 12.99),
                             ("3A", "3A Adictivo Anejo", 59.99)):
        assert catalogue(sku, name, price, _ctx()) is True, f"{name} was refused"


def test_route_blocklist_still_applies_on_top() -> None:
    """A bare "2" or "22" is a discount or deposit key with a perfectly ordinary
    name, so the catalogue filter has no reason to refuse it. The route's own
    SKU-shape blocklist is what catches those, and dropping it would let a whole
    class of non-product back in."""
    from app.pipeline.candidates.merchandise import is_merchandise as catalogue

    for till_key in ("2", "22", "105"):
        assert D.is_orderable_sku(till_key, None) is False, (
            f"{till_key} is a till key and the blocklist must refuse it"
        )

    # The catalogue filter alone would NOT have stopped at least one of them.
    passed_catalogue = [
        k for k in ("2", "22", "105")
        if catalogue(k, f"Item {k}", 9.99, _ctx())
    ]
    assert passed_catalogue, (
        "if the catalogue filter already caught every till key, the blocklist "
        "would be redundant - this asserts it is not"
    )

    # Orderability is also only the blocklist's business.
    assert D.is_orderable_sku("0245", frozenset({"9999"})) is False


def test_route_screens_on_the_pos_category_when_it_has_one() -> None:
    """Checklist 12. A lottery line has an ordinary SKU, an ordinary name and an
    ordinary price, so the name and price tests pass it and the blocklist does
    not know it. The POS category is the one string that says what it is, and
    the live route never passed it. The same SKU is kept without a category
    (an absent category is not a refusal) and refused with one."""
    rows = sales("4471", days=400, per_day=3.0, dip_per_day=1.0)

    without = choose(rows, product_names={"4471": "DAILY DOUBLE GAME"},
                     unit_prices={"4471": 2.0})
    assert [p.sku for p in without] == ["4471"], (
        "with no category the only evidence is the name, and '$2 SCRATCHOFF' "
        "carries none of the catalogue's non-stock terms"
    )

    with_cat = choose(rows, product_names={"4471": "DAILY DOUBLE GAME"},
                      unit_prices={"4471": 2.0},
                      pos_categories={"4471": "LOTTERY"})
    assert with_cat == [], "a LOTTERY category must refuse the line"


def test_a_drink_category_is_never_refused_by_the_category_screen() -> None:
    """The policy lives in non_stock.py and is deferred to here: a category
    naming a drink type is stock whatever else the string says."""
    rows = sales("1690", days=400, per_day=3.0, dip_per_day=1.0)
    picks = choose(rows, product_names={"1690": "1690 Absolut Mandrin"},
                   unit_prices={"1690": 24.99},
                   pos_categories={"1690": "VODKA TAX"})
    assert [p.sku for p in picks] == ["1690"]


def test_the_category_refusal_has_its_own_counter() -> None:
    """A refusal the route ran without for a month must be countable on its own,
    not folded into the name/price count."""
    import inspect
    src = inspect.getsource(D.select)
    assert "not_merchandise_category" in src


def test_both_screens_are_counted_separately() -> None:
    """Two reasons, two counters. A single "not_merchandise" count could not tell
    a catalogue refusal from a till key, and the two need different fixes."""
    import inspect
    src = inspect.getsource(D.select)
    assert "not_merchandise_catalogue" in src
    assert "not_merchandise_blocklist" in src
    assert "suppressed_after_retirement" in src
    assert "suppression_relaxed_for_pool_floor" in src


def test_choose_still_works_without_any_memory() -> None:
    """An empty history means "no memory available", which is today's behaviour.
    The wiring must be a reduction in repetition, not a new failure mode."""
    rows = (sales("0245", days=400, per_day=1.5, dip_per_day=0.4)
            + sales("1690", days=400, per_day=2.0, dip_per_day=0.6))
    picks = choose(rows, card_history=())
    assert isinstance(picks, list)
    # And the same call with product names supplied must not crash either.
    assert isinstance(
        choose(rows, card_history=(),
               product_names={"0245": "Vodka 750ml", "1690": "Absolut Mandrin"},
               unit_prices={"0245": 19.99, "1690": 24.99}),
        list,
    )



# ── A stored retirement under a rule that could not apply is void ───────────


def _void(kind, rule, *, until_days=14):
    """A history as Node reports it after storing a retirement, with the kind of
    card and the rule set explicitly. The window is still open."""
    from dataclasses import replace
    retired_at = AS_OF - timedelta(days=10)
    return replace(_retired("0245", retired_at,
                            retired_at + timedelta(days=until_days)),
                   retirement_rule=rule, action_type=kind)


def test_a_markdown_retired_for_no_recovery_is_not_suppressed() -> None:
    """Measured at Bethany, 20 October: two overstock SKUs each issued as a
    markdown, retired under no_recovery - a recovery a markdown never
    predicts - and suppressed for seventeen days. A verdict made under a rule
    that could not apply is void, so the SKU comes back by logic rather than
    by someone editing rows. No NEW retirement is written either: the card is
    not re-judged, it is simply no longer hidden."""
    rows = sales("0245", days=400, per_day=1.5, dip_per_day=0.4)
    for rule in ("no_recovery", "declining"):
        sel = D.select(rows, client_id=1, location_id=171, as_of=AS_OF,
                       limit=10, card_history=(_void("markdown", rule),),
                       config=NO_FLOOR)
        assert "0245" in {p.sku for p in sel.picks}, rule
        assert "suppressed_after_retirement" not in sel.screened, rule
        assert sel.retirements == (), rule


def test_the_void_is_narrow() -> None:
    """Only a recovery rule, only on a discount card, only when the kind is
    known. Everything else keeps the stored suppression exactly as before."""
    rows = sales("0245", days=400, per_day=1.5, dip_per_day=0.4)
    kept = (
        ("reorder", "no_recovery"),   # the rule applies to a reorder
        (None, "no_recovery"),        # an unknown kind is an absence
        ("markdown", "acted_on"),     # not a recovery rule
        ("markdown", "stale"),
    )
    for kind, rule in kept:
        sel = D.select(rows, client_id=1, location_id=171, as_of=AS_OF,
                       limit=10, card_history=(_void(kind, rule),),
                       config=NO_FLOOR)
        assert "0245" not in {p.sku for p in sel.picks}, (kind, rule)
        assert sel.screened["suppressed_after_retirement"] == 1, (kind, rule)
        assert sel.retirements == (), (kind, rule)
