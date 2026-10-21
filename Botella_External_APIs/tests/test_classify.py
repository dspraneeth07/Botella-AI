"""Sheet 07 PR 1 — Syntetos-Boylan demand classification."""

from __future__ import annotations

import ast
import inspect
from datetime import date, timedelta

import pytest

from app.pipeline.context import RunContext
from app.pipeline.features.store import CalendarDay, DayFact
from app.pipeline.registry import cfg
from storeagent.forecasting import classify as classify_module
from storeagent.forecasting.classify import (
    ADI_CUT,
    CV2_CUT,
    DEMAND_CLASSES,
    ERRATIC,
    INTERMITTENT,
    LUMPY,
    METHOD_FOR_CLASS,
    MIN_DEMAND_EVENTS,
    NEW_SKU,
    SMOOTH,
    ClassifyRequest,
    classify,
    open_day_sequence,
)

AS_OF = date(2026, 9, 22)
YEAR = 364


def ctx(**over) -> RunContext:
    base = {
        "run_id": "run-07", "tenant_id": 1, "store_id": 1, "as_of": AS_OF,
        "snapshot_id": "snap-1", "config_version": "default", "seed": 0,
        "versions": {"forecast": "1.0.0"},
    }
    return RunContext(**{**base, **over})


def calendar(days: int = YEAR, *, closed_weekday: int | None = None) -> list[CalendarDay]:
    out = []
    for i in range(days):
        d = AS_OF - timedelta(days=i)
        out.append(CalendarDay(
            obs_date=d,
            was_open=(closed_weekday is None or d.weekday() != closed_weekday),
            has_data=True,
        ))
    return out


def facts(days_ago: list[int], units: float | list[float] = 5.0) -> list[DayFact]:
    sizes = units if isinstance(units, list) else [units] * len(days_ago)
    return [
        DayFact(obs_date=AS_OF - timedelta(days=d), sku="X", units_sold=u, price=10.0)
        for d, u in zip(days_ago, sizes, strict=True)
    ]


def profile_of(fact_list, cal=None, **over):
    result = classify(
        ClassifyRequest("X", cal if cal is not None else calendar(), fact_list, YEAR),
        ctx(**over),
    )
    assert result.ok
    return result.value


# ── The 2x2, all four cells ──────────────────────────────────────────────────


def test_a_daily_seller_with_steady_sizes_is_smooth() -> None:
    p = profile_of(facts(list(range(YEAR))))
    assert p.demand_class == SMOOTH
    assert p.adi == pytest.approx(1.0)
    assert p.cv2 == pytest.approx(0.0)
    assert p.method == "seasonal_ets"


def test_a_steady_but_infrequent_seller_is_intermittent() -> None:
    """A mezcal that sells four times a month, always two bottles."""
    p = profile_of(facts(list(range(0, YEAR, 5))))
    assert p.demand_class == INTERMITTENT
    assert p.adi == pytest.approx(5.0, abs=0.05)
    assert p.cv2 == pytest.approx(0.0)
    assert p.method == "croston"


def test_a_daily_seller_with_wild_sizes_is_erratic() -> None:
    days = list(range(YEAR))
    p = profile_of(facts(days, [1.0 if i % 2 else 40.0 for i in days]))
    assert p.demand_class == ERRATIC
    assert p.adi < cfg.get(ADI_CUT, ctx())
    assert p.cv2 >= cfg.get(CV2_CUT, ctx())
    assert p.method == "sba"


def test_a_rare_seller_with_wild_sizes_is_lumpy() -> None:
    days = list(range(0, YEAR, 7))
    p = profile_of(facts(days, [1.0 if i % 10 else 60.0 for i in days]))
    assert p.demand_class == LUMPY
    assert p.adi >= cfg.get(ADI_CUT, ctx())
    assert p.cv2 >= cfg.get(CV2_CUT, ctx())
    assert p.method == "sba_wide"


def test_every_class_has_a_method_and_every_method_a_class() -> None:
    assert set(METHOD_FOR_CLASS) == set(DEMAND_CLASSES)
    assert len(set(METHOD_FOR_CLASS.values())) == len(DEMAND_CLASSES)


# ── new_sku: a label, never a separate path ──────────────────────────────────


def test_too_few_demand_events_is_new_sku_not_a_failure() -> None:
    result = classify(ClassifyRequest("X", calendar(), facts([5, 90]), YEAR), ctx())
    assert result.ok, "an unclassifiable SKU is a LABEL, not a refusal"
    p = result.value
    assert p.demand_class == NEW_SKU
    assert p.method == "cohort_prior"
    assert p.adi is None and p.cv2 is None, "never a fabricated statistic"
    assert p.demand_events == 2


def test_a_brand_new_store_classifies_every_sku_as_new_without_erroring() -> None:
    """Zero facts, zero open days. Still a label, still ok."""
    result = classify(ClassifyRequest("X", [], [], YEAR), ctx())
    assert result.ok
    assert result.value.demand_class == NEW_SKU
    assert result.value.open_days == 0
    assert "similar stores" in result.value.explain()


def test_the_floor_comes_from_the_registry_not_a_literal() -> None:
    few = facts([1, 8, 15])
    assert profile_of(few).demand_class != NEW_SKU
    # Raise the floor above the evidence and the same SKU becomes new_sku.
    # The ctx must be pinned to the SAME config set - the registry refuses a
    # mismatch, because replaying a run against today's thresholds instead of
    # the ones it was produced under is exactly the silent drift sheet 00 exists
    # to prevent.
    strict = cfg.with_overrides("strict", {MIN_DEMAND_EVENTS.name: 10})
    result = classify(ClassifyRequest("X", calendar(), few, YEAR),
                      ctx(config_version="strict"), strict)
    assert result.ok, result.reasons
    assert result.value.demand_class == NEW_SKU


# ── ADI counts OPEN days. This is the sheet-03 join. ─────────────────────────


def test_a_closed_day_is_not_a_gap_in_demand() -> None:
    """The defect this would otherwise reintroduce.

    A store shut every Sunday has ~52 non-trading days a year. Counted as
    CALENDAR days, a SKU selling every single trading day would show an ADI of
    ~1.17 rather than 1.0 - and a SKU sitting near the 1.32 cut would be pushed
    across it into a different forecasting method entirely, because of the
    store's opening hours rather than anything about the product.

    A closed day is a gap in OPPORTUNITY, not a gap in demand.
    """
    cal = calendar(closed_weekday=6)                     # shut Sundays
    open_dates = open_day_sequence(cal, AS_OF - timedelta(days=YEAR - 1), AS_OF)
    sells_every_open_day = [
        DayFact(obs_date=d, sku="X", units_sold=5.0, price=10.0) for d in open_dates
    ]

    p = profile_of(sells_every_open_day, cal=cal)

    assert p.adi == pytest.approx(1.0), "sells every trading day -> ADI is 1.0"
    assert p.demand_class == SMOOTH
    assert p.open_days == len(open_dates) < YEAR


def test_unsynced_days_are_not_counted_as_open_either() -> None:
    """An unsynced day is unknown, not observed. It cannot lengthen an
    interval any more than a Sunday can."""
    cal = [
        CalendarDay(AS_OF - timedelta(days=i), was_open=True,
                    has_data=(i >= 30))
        for i in range(YEAR)
    ]
    counted = open_day_sequence(cal, AS_OF - timedelta(days=YEAR - 1), AS_OF)
    assert len(counted) == YEAR - 30


def test_intervals_are_measured_in_open_days_not_calendar_days() -> None:
    """Two sales either side of a closed Sunday are ONE open day apart."""
    cal = calendar(closed_weekday=6)
    open_dates = open_day_sequence(cal, AS_OF - timedelta(days=YEAR - 1), AS_OF)
    # Pick two consecutive OPEN days that straddle a Sunday.
    straddling = next(
        (a, b) for a, b in zip(open_dates, open_dates[1:], strict=False)
        if (b - a).days == 2
    )
    p = profile_of([
        DayFact(obs_date=d, sku="X", units_sold=4.0, price=10.0) for d in straddling
    ], cal=cal)
    # The first interval is the gap between the two sales: ONE open day,
    # though two calendar days. (A trailing gap follows it - see
    # test_the_silence_since_the_last_sale_is_counted.)
    assert p.intervals[0] == 1, "one OPEN day apart, though two calendar days"


def test_the_silence_since_the_last_sale_is_counted() -> None:
    """A SKU that stopped selling must look like a SKU that stopped selling.

    Gaps between consecutive sales describe only the span from the first sale
    to the last. Everything after it - a delisted product, a seasonal line out
    of season - is invisible to them, and Croston divides by exactly that
    number.

    Measured on store 122: mean(intervals) came out 1.29 against an ADI of
    3.74 for the same SKUs, because so many had sold steadily and then
    stopped. One SKU had sold 22.8 units a day for 584 open days and then
    nothing; the forecast for the next 30 days was 1,016 units against an
    actual of ZERO.
    """
    # Sells every open day for 100 days, then stops 200 open days ago.
    selling = list(range(200, 300))
    p = profile_of(facts(selling))
    assert p.demand_events == 100
    assert p.intervals[-1] == 200, "the silence since the last sale"
    # The two measures of "how often" now agree, which is the point.
    mean_interval = sum(p.intervals) / len(p.intervals)
    assert mean_interval == pytest.approx(p.adi, rel=0.35), (
        f"mean(intervals)={mean_interval:.2f} vs ADI={p.adi:.2f} - two ways of "
        "measuring one quantity must not disagree"
    )


def test_a_sale_on_the_last_open_day_adds_no_trailing_gap() -> None:
    """Zero silence is not an interval of zero."""
    p = profile_of(facts([0, 5, 10]))
    assert all(gap > 0 for gap in p.intervals)
    assert len(p.intervals) == 2, "two gaps between three sales, nothing trailing"


# ── The cuts are published, not ours ─────────────────────────────────────────


def test_the_two_cuts_are_the_published_values_and_marked_measured() -> None:
    assert ADI_CUT.default == 1.32
    assert CV2_CUT.default == 0.49
    assert ADI_CUT.status == "MEASURED"
    assert CV2_CUT.status == "MEASURED"
    for setting in (ADI_CUT, CV2_CUT):
        assert "Syntetos" in setting.why and "2005" in setting.why, (
            "a MEASURED setting must cite where it was measured"
        )


def test_the_cuts_are_read_from_the_registry_so_they_can_be_examined() -> None:
    """Moving the cut moves the label - proof nothing is hardcoded."""
    days = list(range(0, YEAR, 2))                       # ADI 2.0, steady size
    assert profile_of(facts(days)).demand_class == INTERMITTENT
    loose = cfg.with_overrides("loose", {ADI_CUT.name: 3.0})
    result = classify(ClassifyRequest("X", calendar(), facts(days), YEAR),
                      ctx(config_version="loose"), loose)
    assert result.ok, result.reasons
    assert result.value.demand_class == SMOOTH


# ── Structure ────────────────────────────────────────────────────────────────


def test_classification_never_branches_on_a_tier_or_on_newness() -> None:
    """`new_sku` is produced as a label; nothing may branch on being new."""
    tree = ast.parse(inspect.getsource(classify_module))
    banned = {"tier", "store_tier", "is_new", "is_cold_start", "cold_start"}
    names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
    names |= {n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
    assert not (names & banned)


def test_the_class_is_carried_in_provenance() -> None:
    """Sheet 07: 'Every SKU is classified, and the class is in provenance.'"""
    result = classify(ClassifyRequest("X", calendar(), facts(list(range(YEAR))), YEAR),
                      ctx())
    assert result.provenance.own_observations == YEAR
    assert result.value.as_dict()["demand_class"] == SMOOTH
    assert result.stage == "forecast_classify"
