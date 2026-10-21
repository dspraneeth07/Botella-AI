"""Sheet 04 — evidence counting and the peer engine.

The four tests the sheet names, plus the ones whose failure would be
invisible: an evidence count that quietly counts calendar days looks exactly
like one that works, right up until every downstream interval is 15% too
tight.

Numbers are the measured ones. Store 122 (Big Hollow Convenient, Peoria IL)
gives exactly 52 observations per weekday over a trailing 364-day window —
which is what the sheet's reference means. Bethany (171:171) closes every
Sunday: 191 of its 200 closed days.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from app.pipeline import RunContext
from app.pipeline.evidence import (
    EvidenceRequest,
    PeerRequest,
    StoreFeatures,
    compare,
    cosine_similarity,
    count_evidence,
    evidence_profile,
    find_peers,
    volume_band_similarity,
)
from app.pipeline.features import CalendarDay, DayFact

AS_OF = date(2026, 9, 21)
YEAR = 364


def ctx(**over) -> RunContext:
    base = {
        "run_id": "run-04", "tenant_id": 122, "store_id": 122, "as_of": AS_OF,
        "snapshot_id": "snap-1", "config_version": "default", "seed": 0,
        "versions": {"evidence": "1.0.0"},
    }
    return RunContext(**{**base, **over})


def open_every_day(days: int = YEAR, end: date = AS_OF) -> list[CalendarDay]:
    """Store 122's shape: trades seven days a week."""
    start = end - timedelta(days=days - 1)
    return [CalendarDay(start + timedelta(days=i), was_open=True, has_data=True)
            for i in range(days)]


def closed_sundays(days: int = YEAR, end: date = AS_OF) -> list[CalendarDay]:
    """Bethany's shape: six days a week."""
    start = end - timedelta(days=days - 1)
    out = []
    for i in range(days):
        d = start + timedelta(days=i)
        sunday = d.weekday() == 6
        out.append(CalendarDay(d, was_open=not sunday, has_data=True,
                               open_source="assumed_closed" if sunday else "observed"))
    return out


# ── The sheet's sanity reference ────────────────────────────────────────────


def test_store_122_gives_52_observations_per_weekday() -> None:
    """The sheet's reference point, measured: over a trailing 364-day window
    store 122 has exactly 52 open days for every weekday."""
    result = count_evidence(
        EvidenceRequest("day_of_week", open_every_day(), window_days=YEAR), ctx())
    assert result.ok
    assert result.value.n == 52
    assert set(result.value.breakdown.values()) == {52}
    assert result.value.sufficiency == "sufficient"


def test_the_sheets_tripwire_a_count_below_40_means_calendar_days() -> None:
    """"If your day_of_week count for a typical store comes out below ~40,
    something is counting calendar days instead of open days." Here the store
    is closed every Sunday, so Sunday must be 0 and the traded weekdays must
    still be 52 - a calendar-day counter would give 52 everywhere."""
    result = count_evidence(
        EvidenceRequest("day_of_week", closed_sundays(), window_days=YEAR), ctx())
    bd = result.value.breakdown
    assert bd["sunday"] == 0, "a closed weekday must count ZERO, not 52"
    assert all(bd[d] == 52 for d in
               ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday"))


def test_closed_days_are_never_counted() -> None:
    """The rule everything downstream rests on."""
    cal = closed_sundays(28)
    result = count_evidence(EvidenceRequest("day_of_week", cal, window_days=28), ctx())
    assert result.value.open_days_in_window == 24, "28 days minus 4 Sundays"


def test_an_unsynced_day_is_not_counted_either() -> None:
    """A day we have not received is no more countable than a Sunday."""
    cal = [CalendarDay(AS_OF - timedelta(days=i), was_open=True, has_data=(i >= 4))
           for i in range(28)]
    result = count_evidence(EvidenceRequest("day_of_week", cal, window_days=28), ctx())
    assert result.value.open_days_in_window == 24


# ── The third state: NOT APPLICABLE ─────────────────────────────────────────


def test_a_closed_weekday_is_structurally_absent_not_thin_evidence() -> None:
    """Bethany's Sunday evidence is not 'insufficient' - it will never exist.
    Reporting it as thin would invite someone to wait for data that is never
    coming."""
    result = count_evidence(
        EvidenceRequest("day_of_week", closed_sundays(), window_days=YEAR), ctx())
    assert "sunday" in result.value.not_applicable
    assert result.value.sufficiency == "sufficient", "the six traded days are fine"
    assert any("structurally_absent:sunday" in r for r in result.reasons)


def test_n_is_the_WEAKEST_weekday_not_the_average() -> None:
    """300 Saturdays do not help you predict a Tuesday."""
    cal = open_every_day(YEAR)
    # Knock out most Tuesdays.
    cal = [c if c.obs_date.weekday() != 1 or c.obs_date.day < 8
           else CalendarDay(c.obs_date, was_open=False, has_data=True)
           for c in cal]
    result = count_evidence(EvidenceRequest("day_of_week", cal, window_days=YEAR), ctx())
    assert result.value.n == result.value.breakdown["tuesday"]
    assert result.value.n < 52


def test_a_store_open_no_days_is_not_applicable_rather_than_zero_evidence() -> None:
    cal = [CalendarDay(AS_OF - timedelta(days=i), was_open=False, has_data=True)
           for i in range(28)]
    result = count_evidence(EvidenceRequest("day_of_week", cal, window_days=28), ctx())
    assert result.value.sufficiency == "not_applicable"
    assert result.value.n == 0


# ── weekly_trend ────────────────────────────────────────────────────────────


def test_a_week_counts_only_with_at_least_four_open_days() -> None:
    """The sheet's definition."""
    start = date(2026, 6, 29)      # a Monday
    cal = []
    for week in range(8):
        for day in range(7):
            d = start + timedelta(days=week * 7 + day)
            # Weeks 0-3 trade 5 days; weeks 4-7 trade only 3.
            traded = day < (5 if week < 4 else 3)
            cal.append(CalendarDay(d, was_open=traded, has_data=True))
    result = count_evidence(
        EvidenceRequest("weekly_trend", cal, window_days=56), ctx(as_of=start + timedelta(days=55)))
    assert result.value.n == 4, "only the 5-day weeks qualify"


def test_weekly_trend_needs_roughly_a_quarter() -> None:
    result = count_evidence(
        EvidenceRequest("weekly_trend", open_every_day(YEAR), window_days=YEAR), ctx())
    assert result.value.floor == 13
    assert result.value.n >= 13 and result.value.sufficiency == "sufficient"

    short = count_evidence(
        EvidenceRequest("weekly_trend", open_every_day(28), window_days=28), ctx())
    assert short.value.sufficiency == "insufficient"
    assert any("insufficient_evidence:weekly_trend" in r for r in short.reasons)


# ── monthly ─────────────────────────────────────────────────────────────────


def test_monthly_needs_two_complete_prior_years() -> None:
    """Most of the estate fails this, which is why sheet 05 exists."""
    cal = []
    for year in (2024, 2025, 2026):
        for day in range(1, 29):
            cal.append(CalendarDay(date(year, 9, day), was_open=True, has_data=True))
    result = count_evidence(
        EvidenceRequest("monthly", cal, window_days=YEAR, target_month=9), ctx())
    assert result.value.n == 2, "2024 and 2025 - the current year does not count"
    assert result.value.sufficiency == "sufficient"


def test_one_prior_year_is_insufficient_for_a_seasonal_claim() -> None:
    cal = [CalendarDay(date(2025, 12, d), was_open=True, has_data=True)
           for d in range(1, 29)]
    result = count_evidence(
        EvidenceRequest("monthly", cal, window_days=YEAR, target_month=12), ctx())
    assert result.value.n == 1 and result.value.sufficiency == "insufficient"


def test_a_year_only_counts_if_the_store_actually_traded_that_month() -> None:
    cal = ([CalendarDay(date(2024, 9, d), was_open=True, has_data=True) for d in range(1, 29)]
           + [CalendarDay(date(2025, 9, d), was_open=True, has_data=True) for d in range(1, 6)])
    result = count_evidence(
        EvidenceRequest("monthly", cal, window_days=YEAR, target_month=9), ctx())
    assert result.value.n == 1, "2025 has only 5 open days in September"


# ── sku_velocity ────────────────────────────────────────────────────────────


def test_sku_velocity_counts_priced_days_not_selling_days() -> None:
    """An intermittent SKU has a long history of NOT selling, and a reorder
    decision needs exactly that. Counting only days with sales would call it
    'no history'."""
    cal = open_every_day(28)
    facts = [DayFact(c.obs_date, "SKU1", units_sold=0.0, price=19.99) for c in cal]
    facts[0] = DayFact(facts[0].obs_date, "SKU1", units_sold=3.0, price=19.99)

    result = count_evidence(
        EvidenceRequest("sku_velocity", cal, facts, window_days=28, sku="SKU1"), ctx())
    assert result.value.n == 28, "priced on every open day"
    assert result.value.breakdown["open_days_with_sales"] == 1


def test_a_sku_with_no_price_history_has_no_evidence() -> None:
    cal = open_every_day(28)
    facts = [DayFact(c.obs_date, "SKU1", units_sold=1.0, price=None) for c in cal]
    result = count_evidence(
        EvidenceRequest("sku_velocity", cal, facts, window_days=28, sku="SKU1"), ctx())
    assert result.value.n == 0 and result.value.sufficiency == "insufficient"


def test_sku_evidence_ignores_facts_on_closed_days() -> None:
    cal = closed_sundays(28)
    facts = [DayFact(c.obs_date, "SKU1", units_sold=1.0, price=10.0)
             for c in closed_sundays(28)]      # includes the Sundays
    result = count_evidence(
        EvidenceRequest("sku_velocity", cal, facts, window_days=28, sku="SKU1"), ctx())
    assert result.value.n == 24, "the 4 Sundays are not observations"


# ── category ────────────────────────────────────────────────────────────────


def test_category_counts_open_days_with_any_sale_in_it() -> None:
    cal = open_every_day(28)
    by_sku = {"A": "whiskey", "B": "beer"}
    facts = [DayFact(c.obs_date, "A", units_sold=1.0) for c in cal[:20]]
    facts += [DayFact(c.obs_date, "B", units_sold=1.0) for c in cal]
    result = count_evidence(
        EvidenceRequest("category", cal, facts, window_days=28,
                        category="whiskey", category_by_sku=by_sku), ctx())
    assert result.value.n == 20


# ── A zero-history store ────────────────────────────────────────────────────


def test_a_zero_history_store_returns_n_0_for_every_pattern_without_raising() -> None:
    """The sheet's explicit requirement."""
    cal = [CalendarDay(AS_OF - timedelta(days=i), was_open=False, has_data=False)
           for i in range(YEAR)]
    for pattern, extra in [
        ("day_of_week", {}), ("weekly_trend", {}), ("monthly", {}),
        ("sku_velocity", {"sku": "X"}),
        ("category", {"category": "beer", "category_by_sku": {}}),
    ]:
        result = count_evidence(
            EvidenceRequest(pattern, cal, window_days=YEAR, **extra), ctx())
        assert result.ok is True, f"{pattern} must not raise"
        assert result.value.n == 0, pattern
        assert result.provenance.own_observations == 0


def test_a_store_with_no_calendar_at_all_refuses_cleanly() -> None:
    result = count_evidence(EvidenceRequest("day_of_week", [], window_days=28), ctx())
    assert result.ok is False and "no_calendar_for_window" in result.reasons


def test_n_is_published_as_provenance_own_observations() -> None:
    """Every later stage consumes this field, not the payload."""
    result = count_evidence(
        EvidenceRequest("day_of_week", open_every_day(), window_days=YEAR), ctx())
    assert result.provenance.own_observations == result.value.n == 52
    assert result.provenance.evidence_state == "MATURE"


def test_evidence_profile_answers_every_pattern_at_once() -> None:
    cal = closed_sundays(YEAR)
    facts = [DayFact(c.obs_date, "SKU1", units_sold=1.0, price=9.99)
             for c in cal if c.was_open]
    result = evidence_profile(
        EvidenceRequest("day_of_week", cal, facts, window_days=YEAR, sku="SKU1"), ctx())
    assert result.ok
    assert set(result.value["patterns"]) == {
        "day_of_week", "weekly_trend", "monthly", "sku_velocity"}


# ══ PART 2 — peers ══════════════════════════════════════════════════════════


def store(cid: int, state: str = "TX", mix=None, vol: float | None = 500.0
          ) -> StoreFeatures:
    return StoreFeatures(
        client_id=cid, location_id=cid, state=state,
        category_share=mix if mix is not None else {"whiskey": 0.5, "beer": 0.5},
        monthly_volume=vol,
    )


def test_peer_similarity_is_symmetric() -> None:
    """The sheet's explicit requirement. A difference-based volume measure
    would break this and the cohort would depend on who asked."""
    a = store(1, mix={"whiskey": 0.7, "beer": 0.3}, vol=400.0)
    b = store(2, mix={"whiskey": 0.4, "wine": 0.6}, vol=900.0)
    assert compare(a, b, ctx()).score == compare(b, a, ctx()).score
    assert cosine_similarity(a.category_share, b.category_share) == \
        cosine_similarity(b.category_share, a.category_share)
    assert volume_band_similarity(400.0, 900.0, 150, 400) == \
        volume_band_similarity(900.0, 400.0, 150, 400)


def test_a_store_with_no_same_state_peers_returns_empty_with_a_reason() -> None:
    """Measured: 4 states in the estate hold exactly one store, so this is a
    real outcome, not an edge case."""
    lone = store(1, state="WY")
    others = [store(2, state="TX"), store(3, state="FL")]
    result = find_peers(PeerRequest(lone, others), ctx())

    assert result.ok is True, "no peers is a true answer, not a failure"
    assert result.value.peers == ()
    assert any("no_same_state_candidates:WY" in r for r in result.value.reasons)
    assert result.value.sufficient is False


def test_state_is_a_gate_not_a_weight() -> None:
    """A Texas store and a Maine store are not 60% similar."""
    tx = store(1, state="TX")
    me = store(2, state="ME")          # identical in every other respect
    result = find_peers(PeerRequest(tx, [me]), ctx())
    assert result.value.peers == ()


def test_peers_are_ordered_by_similarity_with_reasons_attached() -> None:
    subject = store(1, mix={"whiskey": 0.8, "beer": 0.2}, vol=500.0)
    near = store(2, mix={"whiskey": 0.75, "beer": 0.25}, vol=520.0)
    far = store(3, mix={"wine": 0.9, "beer": 0.1}, vol=3000.0)
    result = find_peers(PeerRequest(subject, [far, near], min_peers=1), ctx())

    assert [p.client_id for p in result.value.peers][0] == 2, "nearest first"
    top = result.value.peers[0]
    assert top.match_reasons, "every match carries its reasons"
    assert "same state (TX)" in top.match_reasons
    assert any("category-mix overlap" in r for r in top.match_reasons)


def test_every_match_is_explainable_in_one_sentence() -> None:
    """Sheet 15 renders this, so it has to read like something a person wrote."""
    subject = store(1, mix={"whiskey": 0.8, "beer": 0.2}, vol=500.0)
    peer = store(2, mix={"whiskey": 0.75, "beer": 0.25}, vol=520.0)
    result = find_peers(PeerRequest(subject, [peer], min_peers=1), ctx())
    sentence = result.value.peers[0].explanation
    assert sentence.startswith("Matched because:") and sentence.endswith(".")
    assert "same state" in sentence and "category-mix overlap" in sentence


def test_missing_dimensions_are_declared_not_defaulted() -> None:
    """The estate has no store format and no population density. Defaulting
    them to a neutral value would dilute every score by a constant and make
    two stores look more alike than the evidence supports."""
    result = find_peers(PeerRequest(store(1), [store(2)], min_peers=1), ctx())
    peer = result.value.peers[0]
    assert "store_format" in peer.missing_dimensions
    assert "density_class" in peer.missing_dimensions
    assert any("dimensions_unavailable" in r for r in result.value.reasons)
    # ...and the score is renormalised over what WAS comparable.
    assert set(peer.components) == {"category_mix", "volume_band"}


def test_a_store_is_never_its_own_peer() -> None:
    subject = store(1)
    result = find_peers(PeerRequest(subject, [subject, store(2)], min_peers=1), ctx())
    assert all(p.client_id != 1 for p in result.value.peers)


def test_too_few_peers_says_so_and_defers_widening_to_sheet_05() -> None:
    result = find_peers(PeerRequest(store(1), [store(2)], min_peers=5), ctx())
    assert result.value.sufficient is False
    assert any("insufficient_peers:1<5" in r and "sheet_05" in r
               for r in result.value.reasons)


def test_a_dissimilar_same_state_store_is_not_a_peer() -> None:
    """'Stores like yours' has to be true."""
    subject = store(1, mix={"whiskey": 1.0}, vol=100.0)
    unlike = store(2, mix={"cigarettes": 1.0}, vol=5000.0)
    result = find_peers(PeerRequest(subject, [unlike], min_peers=1), ctx())
    assert result.value.peers == ()
    assert any("no_candidate_cleared_similarity_floor" in r
               for r in result.value.reasons)


def test_peer_provenance_says_the_cohort_is_not_this_stores_own_evidence() -> None:
    result = find_peers(PeerRequest(store(1), [store(2), store(3)], min_peers=1), ctx())
    assert result.provenance.own_weight == 0.0, "a cohort is borrowed, not own"
    assert result.provenance.cohort_level == "state"
    assert result.provenance.cohort_size == 2


def test_peer_order_is_deterministic_for_replay() -> None:
    subject = store(1)
    tied = [store(5), store(3), store(4)]      # identical features -> tied scores
    first = find_peers(PeerRequest(subject, tied, min_peers=1), ctx())
    second = find_peers(PeerRequest(subject, list(reversed(tied)), min_peers=1), ctx())
    assert [p.client_id for p in first.value.peers] == \
        [p.client_id for p in second.value.peers] == [3, 4, 5]


def test_a_store_with_no_category_history_is_not_scored_as_zero_overlap() -> None:
    """An unknown overlap is not a zero overlap; a brand-new store must not
    look maximally different from everybody."""
    new = StoreFeatures(1, 1, state="TX", category_share={}, monthly_volume=500.0)
    established = store(2, vol=520.0)
    result = find_peers(PeerRequest(new, [established], min_peers=1), ctx())
    peer = result.value.peers[0]
    assert "category_mix" in peer.missing_dimensions
    assert peer.score == 1.0, "scored on volume alone, which matched"


# ── sheet-00 conformance ────────────────────────────────────────────────────


@pytest.mark.parametrize("call", [
    lambda: count_evidence(EvidenceRequest("day_of_week", open_every_day(),
                                           window_days=YEAR), ctx()),
    lambda: find_peers(PeerRequest(store(1), [store(2)]), ctx()),
])
def test_every_evidence_stage_is_well_formed(call) -> None:
    result = call()
    assert result.stamped and result.provenance is not None
    assert result.duration_ms >= 0


def test_evidence_floors_record_themselves_into_provenance() -> None:
    result = count_evidence(
        EvidenceRequest("day_of_week", open_every_day(), window_days=YEAR), ctx())
    assert "evidence.day_of_week.min_observations" in result.provenance.config_keys


def test_a_weekday_traded_once_in_a_year_is_not_regarded_as_thin_evidence() -> None:
    """MEASURED on Bethany (171:171): it traded exactly ONE Sunday out of 52.
    Without this rule the weakest-weekday headline collapsed to n=1 for a
    store holding 49-52 observations on every day it genuinely trades -
    making a well-evidenced store look brand new."""
    cal = closed_sundays(YEAR)
    # Open on exactly one of the 52 Sundays, as Bethany did.
    one_sunday = next(c.obs_date for c in cal if c.obs_date.weekday() == 6)
    cal = [CalendarDay(c.obs_date, was_open=True, has_data=True)
           if c.obs_date == one_sunday else c for c in cal]

    result = count_evidence(
        EvidenceRequest("day_of_week", cal, window_days=YEAR), ctx())

    assert result.value.breakdown["sunday"] == 1
    assert "sunday" in result.value.not_applicable, "1 of 52 is not a sample"
    assert result.value.n == 52, "the six regularly-traded days carry the headline"
    assert result.value.sufficiency == "sufficient"


def test_a_genuinely_thin_weekday_is_still_reported_as_insufficient() -> None:
    """The rule must not swallow real thinness. A store open on 60% of its
    Sundays but only 5 times is thin evidence, not a closure."""
    start = AS_OF - timedelta(days=34)
    cal = []
    for i in range(35):
        d = start + timedelta(days=i)
        # Trades every day except 2 of the 5 Sundays -> 3 of 5 = 60%, not rare.
        sundays_skipped = d.weekday() == 6 and d.day % 2 == 0
        cal.append(CalendarDay(d, was_open=not sundays_skipped, has_data=True))
    result = count_evidence(EvidenceRequest("day_of_week", cal, window_days=35), ctx())
    assert "sunday" not in result.value.not_applicable
    assert result.value.n == result.value.breakdown["sunday"]
    assert result.value.sufficiency == "insufficient"
