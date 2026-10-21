"""N8.1 / N8.2 — the event calendar and the uplift that n = 3 can support.

The pilot stores have 3.7 years of history, so each event has three or four
occurrences per store. Everything in the uplift tests follows from that.
"""

from __future__ import annotations

import math
from datetime import date, timedelta

import pytest

from app.pipeline.blend.event_uplift import (
    MAX_PLAUSIBLE_UPLIFT,
    MIN_OCCURRENCES,
    SEASONALITY_PATTERN,
    T_CRITICAL_BY_DF,
    EventUpliftRequest,
    Occurrence,
    cohort_uplift_from,
    estimate_event_uplift,
    t_critical,
)
from app.pipeline.blend.shrink import K_BY_PATTERN, k_for_pattern
from app.pipeline.context import RunContext
from app.pipeline.features.calendar import holidays_for
from app.pipeline.features.events import (
    EVENTS,
    EVENTS_BY_KEY,
    LUNISOLAR_VALID_THROUGH,
    EventDateUnavailable,
    events_covering,
    events_for,
    unavailable_events,
)
from app.pipeline.registry import cfg

AS_OF = date(2026, 4, 1)


def ctx(**over) -> RunContext:
    base = {
        "run_id": "run-n8", "tenant_id": 1, "store_id": 171, "as_of": AS_OF,
        "snapshot_id": "snap-1", "config_version": "default", "seed": 0,
        "versions": {"event_uplift": "1.0.0"},
    }
    return RunContext(**{**base, **over})


# ── N8.1 the calendar ────────────────────────────────────────────────────────


def test_there_are_at_least_twenty_five_events() -> None:
    assert len(EVENTS) >= 25
    assert len(EVENTS_BY_KEY) == len(EVENTS), "keys must be unique"


def test_every_event_date_matches_known_good_for_four_years() -> None:
    """Hand-checked dates. A silent drift here would move every playbook."""
    known = {
        2026: {
            "thanksgiving": date(2026, 11, 26),      # 4th Thursday
            "thanksgiving_eve": date(2026, 11, 25),  # the Wednesday
            "black_friday": date(2026, 11, 27),
            "super_bowl": date(2026, 2, 8),          # 2nd Sunday from 2022
            "easter": date(2026, 4, 5),
            "memorial_day": date(2026, 5, 25),       # last Monday
            "labor_day": date(2026, 9, 7),           # 1st Monday
            "christmas": date(2026, 12, 25),
            "diwali": date(2026, 11, 8),
            "chinese_new_year": date(2026, 2, 17),
            "ramadan_start": date(2026, 2, 18),
            "eid_al_fitr": date(2026, 3, 20),
        },
        2027: {
            "thanksgiving": date(2027, 11, 25),
            "thanksgiving_eve": date(2027, 11, 24),
            "black_friday": date(2027, 11, 26),
            "super_bowl": date(2027, 2, 14),
            "easter": date(2027, 3, 28),
            "memorial_day": date(2027, 5, 31),
            "labor_day": date(2027, 9, 6),
            "diwali": date(2027, 10, 29),
            "chinese_new_year": date(2027, 2, 6),
        },
        2024: {
            "thanksgiving": date(2024, 11, 28),
            "super_bowl": date(2024, 2, 11),
            "easter": date(2024, 3, 31),
            "diwali": date(2024, 11, 1),
            "chinese_new_year": date(2024, 2, 10),
        },
        2025: {
            "thanksgiving": date(2025, 11, 27),
            "super_bowl": date(2025, 2, 9),
            "easter": date(2025, 4, 20),
            "diwali": date(2025, 10, 20),
            "ramadan_start": date(2025, 3, 1),
        },
    }
    for year, expected in known.items():
        for key, want in expected.items():
            got = EVENTS_BY_KEY[key].date_for(year)
            assert got == want, f"{key} {year}: got {got}, expected {want}"


def test_thanksgiving_is_always_a_thursday_and_its_eve_a_wednesday() -> None:
    """The weekday matters: the baseline is matched on it, and most of the estate
    is SHUT on the Thursday - which is why the eve is a separate event."""
    for year in range(2022, 2031):
        assert EVENTS_BY_KEY["thanksgiving"].date_for(year).weekday() == 3
        assert EVENTS_BY_KEY["thanksgiving_eve"].date_for(year).weekday() == 2
        assert EVENTS_BY_KEY["black_friday"].date_for(year).weekday() == 4


def test_computed_events_need_no_edit_in_a_distant_year() -> None:
    """A run in 2031 needs no edit for anything COMPUTED - the property
    features/calendar.py already has and this module must not lose."""
    for event in EVENTS:
        if not event.computed:
            continue
        far = event.date_for(2031)
        assert far.year == 2031
        assert event.date_for(2045).year == 2045


def test_tabulated_event_fails_loudly_past_validity() -> None:
    """A silent wrong date in 2031 is worse than a build error in 2030.

    THIS TEST IS THE ALARM. When it starts failing, the luni-solar table needs
    extending - and it fails while there is still a year of runway.
    """
    tabulated = [e for e in EVENTS if not e.computed]
    assert tabulated, "the luni-solar events must be marked as tabulated"
    assert {e.key for e in tabulated} == {
        "diwali", "chinese_new_year", "ramadan_start", "eid_al_fitr"}

    for event in tabulated:
        # Inside the table it answers.
        assert event.date_for(LUNISOLAR_VALID_THROUGH).year == \
            LUNISOLAR_VALID_THROUGH
        # One year past it, it RAISES rather than guessing.
        with pytest.raises(EventDateUnavailable, match="tabulated only through"):
            event.date_for(LUNISOLAR_VALID_THROUGH + 1)

    assert LUNISOLAR_VALID_THROUGH >= date.today().year + 1, (
        "the luni-solar table has less than a year of runway left - extend "
        "_DIWALI, _CHINESE_NEW_YEAR, _RAMADAN_START and _EID_AL_FITR in "
        "app/pipeline/features/events.py"
    )


def test_an_expired_table_does_not_take_the_calendar_down() -> None:
    """One unavailable event must not break the other twenty-four."""
    far = events_for(LUNISOLAR_VALID_THROUGH + 1)
    assert len(far) >= 21, "the computed events must still be there"
    missing = unavailable_events(LUNISOLAR_VALID_THROUGH + 1)
    assert set(missing) == {"diwali", "chinese_new_year", "ramadan_start",
                            "eid_al_fitr"}


def test_window_days_are_per_event_not_global() -> None:
    """A 7-day Christmas run-up and a 2-day Valentine's run-up are different
    trades. One global window would average them into neither."""
    pre = {e.key: e.window_pre_days for e in EVENTS}
    assert len(set(pre.values())) > 3, "the windows must actually differ"
    assert pre["christmas"] > pre["valentines"]
    assert pre["graduation_season"] > pre["thanksgiving"]
    # And they come from calendar.py's table where one exists, so one place owns
    # the number.
    from app.pipeline.features.calendar import PRE_HOLIDAY_WINDOW
    assert pre["christmas"] == PRE_HOLIDAY_WINDOW["christmas"]
    assert pre["thanksgiving"] == PRE_HOLIDAY_WINDOW["thanksgiving"]


def test_a_window_can_cross_the_year_boundary() -> None:
    """New Year's Eve sells into January; New Year's Day's run-up is in December."""
    nye = EVENTS_BY_KEY["new_years_eve"]
    start, end = nye.window(2026)
    assert start.year == 2026 and end.year == 2027
    assert EVENTS_BY_KEY["new_years_day"].covers(date(2025, 12, 31))


def test_suppressing_events_are_marked_and_can_be_negative() -> None:
    """may_suppress is not a courtesy. Ramadan reduces alcohol demand in some
    trade areas, and the day after Christmas is quiet because the party happened."""
    suppressing = {e.key for e in EVENTS if e.may_suppress}
    assert "ramadan_start" in suppressing
    assert "new_years_day" in suppressing
    assert "christmas" in suppressing
    # And a non-suppressing event is not marked, so the flag means something.
    assert EVENTS_BY_KEY["thanksgiving_eve"].may_suppress is False


def test_events_covering_a_day_finds_the_overlaps() -> None:
    """Two events can share a window. In 2027 the Super Bowl falls ON
    Valentine's Day, which the calendar must show rather than hide."""
    covering = {e.key for e in events_covering(date(2027, 2, 14))}
    assert {"super_bowl", "valentines"} <= covering
    # An ordinary day in a quiet month is covered by nothing.
    assert events_covering(date(2026, 8, 12)) == []


def test_every_holiday_event_resolves_through_calendar_py() -> None:
    """The dates live in ONE place. A second copy would drift."""
    for year in (2026, 2027):
        holidays = holidays_for(year)
        for event in EVENTS:
            if event.key in holidays:
                assert event.date_for(year) == holidays[event.key]


# ── N8.2 the uplift ─────────────────────────────────────────────────────────


def occ(event_units: float, baseline_units: float, year: int = 2024,
        event_open: int = 5, baseline_open: int = 20) -> Occurrence:
    return Occurrence(year=year, event_units=event_units,
                      event_open_days=event_open,
                      baseline_units=baseline_units,
                      baseline_open_days=baseline_open)


def uplift(occurrences, *, cohort=None, stores=0, level=None, c=None):
    result = estimate_event_uplift(
        EventUpliftRequest("thanksgiving", "0245", occurrences,
                           cohort_uplift=cohort, cohort_stores=stores,
                           cohort_level=level),
        c or ctx(),
    )
    assert result.ok, result.reason
    return result.value


def test_uplift_shrinks_to_cohort_at_n_equals_three() -> None:
    """n = 3 against the registry's seasonality k of 3 puts HALF the weight on
    the cohort. That is the point of this family: a four-year store will never
    have much of its own, because the event comes once a year."""
    c = ctx()
    k = k_for_pattern(SEASONALITY_PATTERN, c, cfg)
    assert SEASONALITY_PATTERN in K_BY_PATTERN, "must reuse an existing pattern"

    three = [occ(90 + i * 20, 100, 2023 + i) for i in range(3)]
    alone = uplift(three)
    shrunk = uplift(three, cohort=0.0, stores=14, level=1)

    assert alone.own_weight == 1.0
    assert shrunk.n_own == 3
    assert shrunk.own_weight == pytest.approx(3 / (3 + k))
    assert shrunk.own_uplift == pytest.approx(alone.own_uplift)
    # Shrinking toward a cohort of zero must pull the estimate DOWN.
    assert 0.0 < shrunk.uplift < shrunk.own_uplift

    # And more occurrences means more weight on the store's own number.
    six = [occ(90 + i * 20, 100, 2020 + i) for i in range(6)]
    assert uplift(six, cohort=0.0).own_weight > shrunk.own_weight


def test_shrinkage_does_not_narrow_the_interval() -> None:
    """Shrinkage moves the CENTRE. Narrowing the interval too would manufacture
    confidence out of a borrowed number."""
    three = [occ(90 + i * 20, 100, 2023 + i) for i in range(3)]
    alone, shrunk = uplift(three), uplift(three, cohort=0.0)
    width = lambda u: u.interval.high - u.interval.low      # noqa: E731
    assert width(shrunk) == pytest.approx(width(alone))
    assert shrunk.uplift != alone.uplift


def test_uplift_refused_when_interval_spans_zero() -> None:
    """With n = 3 most events at most stores will refuse. THAT IS CORRECT."""
    noisy = [occ(300, 100, 2023), occ(40, 100, 2024), occ(120, 100, 2025)]
    result = uplift(noisy)
    assert result.interval is not None
    assert result.interval.spans_zero
    assert result.usable is False
    assert result.suppresses is False


def test_a_consistent_lift_is_usable() -> None:
    """The refusal has to be discriminating, not a blanket no."""
    consistent = [occ(95, 100, 2023), occ(100, 100, 2024), occ(105, 100, 2025)]
    result = uplift(consistent)
    assert result.usable is True
    assert result.lift_multiple > 1.0


def test_negative_uplift_survives_for_a_suppressing_event() -> None:
    """Do not clamp at zero. A measured suppression says DO NOT pre-stock."""
    quiet = [occ(4, 100, 2023), occ(5, 100, 2024), occ(6, 100, 2025)]
    result = uplift(quiet)
    assert result.uplift < 0.0
    assert result.usable is True
    assert result.suppresses is True
    assert result.lift_multiple < 1.0


def test_zero_dispersion_is_refused_not_treated_as_certainty() -> None:
    """Three IDENTICAL observations give a zero-width interval, which spans_zero
    passes and a card would then state as a fact. It happens for real on sparse
    SKUs, and the only honest answer is that the data said nothing about spread."""
    identical = [occ(100, 100, y) for y in (2023, 2024, 2025)]
    result = uplift(identical)
    assert result.usable is False
    assert result.refused_reason is not None
    assert "zero_dispersion" in result.refused_reason


def test_too_few_occurrences_refuses() -> None:
    c = ctx()
    assert int(cfg.get(MIN_OCCURRENCES, c)) == 2
    assert "too_few_occurrences" in uplift([]).refused_reason
    assert "too_few_occurrences" in uplift([occ(100, 100)]).refused_reason


def test_an_implausible_uplift_is_a_data_defect() -> None:
    huge = [occ(100_000, 1, 2023), occ(90_000, 1, 2024), occ(110_000, 1, 2025)]
    result = uplift(huge)
    assert result.refused_reason is not None
    assert "implausible_uplift" in result.refused_reason
    assert float(cfg.get(MAX_PLAUSIBLE_UPLIFT, ctx())) == 2.0


def test_baseline_matches_weekdays() -> None:
    """The caller supplies a weekday-matched baseline, and the contract says so.

    An unmatched baseline would compare a Thursday against a week containing two
    weekend days and credit the event with the weekday pattern - the same confound
    that made the seasonal multiplier lose at 0 of 4 horizons. The rate arithmetic
    is per OPEN day on both sides, so a window containing a closure is shorter.
    """
    # Same units, different open days: the rate must change, not the total.
    wide = occ(50, 100, event_open=10, baseline_open=20)
    narrow = occ(50, 100, event_open=5, baseline_open=20)
    assert narrow.log_uplift > wide.log_uplift, (
        "fewer open days for the same units is a HIGHER rate"
    )
    # A baseline with no open days or no units cannot be a baseline.
    assert occ(50, 0, baseline_open=20).log_uplift is None
    assert occ(50, 100, baseline_open=0).log_uplift is None
    assert occ(50, 100).usable is True

    # And the docstring of Occurrence states the matching requirement, because
    # this module cannot enforce what the caller selects.
    assert "MATCHED WEEKDAYS" in Occurrence.__doc__


def test_card_states_which_evidence_it_used() -> None:
    """"Based on your 3 previous Thanksgivings" is a different claim from "based
    on 14 similar Texas stores", and the owner should be able to tell which."""
    three = [occ(90 + i * 20, 100, 2023 + i) for i in range(3)]

    alone = uplift(three)
    assert "3 previous" in alone.evidence
    assert "your data alone" in alone.evidence

    with_peers = uplift(three, cohort=0.1, stores=14, level=1)
    assert "3 previous" in with_peers.evidence
    assert "14 peer stores" in with_peers.evidence
    assert "cohort level 1" in with_peers.evidence
    assert "%" in with_peers.evidence, "the split must be stated"

    assert with_peers.as_dict()["evidence"] == with_peers.evidence


def test_t_critical_is_wide_for_small_df_and_falls_back_past_the_table() -> None:
    """At 2 df the multiplier is 4.303 against 2.042 at 30. Using the
    large-sample value would halve every interval and REFUSE FAR LESS THAN IT
    SHOULD, which is the dangerous direction."""
    c = ctx()
    assert t_critical(1, c) == pytest.approx(12.706)
    assert t_critical(2, c) == pytest.approx(4.303)
    assert t_critical(8, c) == pytest.approx(2.306)
    # Past the table, the price module's large-sample value.
    from app.pipeline.elasticity.estimate import CRITICAL_VALUE_95
    assert t_critical(30, c) == pytest.approx(float(cfg.get(CRITICAL_VALUE_95, c)))
    assert t_critical(2, c) > t_critical(8, c) > t_critical(30, c)
    with pytest.raises(ValueError):
        t_critical(0, c)
    assert T_CRITICAL_BY_DF.status == "MEASURED", "published values, not judgements"


def test_the_cohort_pools_own_values_not_shrunk_ones() -> None:
    """Shrinking toward a quantity that was itself shrunk toward the cohort would
    pull every store toward the cohort twice and collapse the spread."""
    three = [occ(90 + i * 20, 100, 2023 + i) for i in range(3)]
    per_store = [uplift(three, cohort=0.0) for _ in range(4)]
    pooled = cohort_uplift_from(per_store, min_stores=3)
    assert pooled is not None
    assert pooled == pytest.approx(per_store[0].own_uplift)
    assert pooled != pytest.approx(per_store[0].uplift)
    # Too few peers is no cohort at all.
    assert cohort_uplift_from(per_store[:2], min_stores=3) is None


def test_events_are_not_pooled_with_each_other() -> None:
    """A store's Diwali is not evidence about its Super Bowl. The request is per
    event key, so there is no path by which they could mix."""
    three = [occ(90 + i * 20, 100, 2023 + i) for i in range(3)]
    a = estimate_event_uplift(
        EventUpliftRequest("diwali", "0245", three), ctx()).value
    b = estimate_event_uplift(
        EventUpliftRequest("super_bowl", "0245", three), ctx()).value
    assert a.event_key == "diwali" and b.event_key == "super_bowl"
    assert a.event_key != b.event_key
