"""Sales velocity, z-scored within category.

Because the Node backend returns raw sales rows, we aggregate the time windows
in Python, then z-score each SKU *within its own category* so a slow-moving
wine isn't unfairly compared to a fast-moving beer.

MIGRATED TO THE FEATURE STORE (sheet 03 rule 4: one definition).
    Every RATE here now divides by OPEN days, using the single definition in
    `app.pipeline.features.store`. It used to divide by calendar days, which
    understates any store that closes - measured on Bethany (171:171),
    212.32/day against a true 247.71/open-day, a 14.3% error that flowed into
    every trend ratio and every downstream comparison.

    The migration is CONDITIONAL on a `calendar` being supplied, and that is
    deliberate. Without one there is no way to know which days the store was
    shut, and switching the divisor blind would be a different wrong answer.
    A caller with a calendar gets the corrected rate; a caller without gets
    exactly the previous behaviour, unchanged. Which one happened is logged
    once per store - not carried on every VelocityInfo row, because the basis
    is a fact about the STORE and repeating it across a thousand SKUs would
    put a thousand copies of a constant into the model's prompt.
"""

from __future__ import annotations

import logging
import statistics
from collections import defaultdict
from collections.abc import Sequence
from datetime import date, datetime, timedelta

from app.pipeline.features.store import CalendarDay
from app.schemas.derived import VelocityInfo
from app.schemas.store import SaleRecord

logger = logging.getLogger(__name__)

DAYS_PER_WEEK = 7

# Weighted blend: emphasize 30d (most stable), 7d for recency, 90d for floor.
_W_30D, _W_90D, _W_7D = 0.5, 0.3, 0.2
_PRIOR_WINDOW_DAYS = 83  # the 90-day window minus the trailing 7 days


def _bucket(score: float) -> str:
    """Continuous z-score -> discrete label the LLM reasons over well."""
    if score >= 1.5:
        return "very_high"
    if score >= 0.5:
        return "high"
    if score >= -0.5:
        return "medium"
    if score >= -1.5:
        return "low"
    return "very_low"


def _bucket_absolute(u30: int) -> str:
    """Fallback for degenerate cohorts: a z-score against a flat or near-empty
    category distribution is identically 0, which labeled a
    one-unit-in-90-days SKU "medium" (and, via the understock gate, could
    prompt reorders of stock that barely sells). Bucket on the absolute
    30-day rate instead."""
    if u30 >= 30:
        return "very_high"
    if u30 >= 12:
        return "high"
    if u30 >= 4:
        return "medium"
    if u30 >= 1:
        return "low"
    return "very_low"


# Below this weekly volume a ratio is mostly noise (2 units this week vs ~1
# per week prior is not a "rising" trend), so the label stays "stable".
_MIN_TREND_UNITS = 3.0


def _trend(
    units_7d: int, units_prior_83d: int, prior_open_days: int | None = None
) -> str:
    """Rising / stable / falling.

    `prior_open_days` is the number of days the store actually TRADED in the
    prior window. Given it, the comparison is per open week; without it the
    divisor falls back to calendar weeks and the ratio is biased upward for
    any store that closes - a six-day store looks ~17% busier than it is.
    """
    denominator_days = (
        prior_open_days if prior_open_days else _PRIOR_WINDOW_DAYS
    )
    prior_per_week = units_prior_83d / max(
        denominator_days / DAYS_PER_WEEK, 1 / DAYS_PER_WEEK
    )
    if units_7d < _MIN_TREND_UNITS and prior_per_week < _MIN_TREND_UNITS:
        return "stable"
    if prior_per_week == 0:
        return "rising" if units_7d > 0 else "stable"
    ratio = units_7d / prior_per_week
    if ratio >= 1.3:
        return "rising"
    if ratio <= 0.7:
        return "falling"
    return "stable"


def _mean_std(values: list[float]) -> tuple[float, float]:
    if not values:
        return 0.0, 0.0
    mean = statistics.fmean(values)
    std = statistics.pstdev(values) if len(values) > 1 else 0.0
    return mean, std


def _z(value: float, mean: float, std: float) -> float:
    return (value - mean) / std if std else 0.0


def open_days_between(
    calendar: Sequence[CalendarDay] | None, start: date, end: date
) -> int | None:
    """Days the store traded in (start, end]. None when unknowable.

    The ONE definition of a denominator (sheet 03): open AND synced. A day we
    have not received is no more countable than a Sunday.
    """
    if calendar is None:
        return None
    return sum(
        1 for c in calendar
        if start < c.obs_date <= end and c.was_open and c.has_data
    )


def compute_velocity(
    sales: list[SaleRecord],
    category_by_sku: dict[str, str],
    as_of: datetime,
    calendar: Sequence[CalendarDay] | None = None,
) -> dict[str, VelocityInfo]:
    # `as_of` is the data frontier (latest sale_date), not necessarily today —
    # see compute_derived for why.
    today = as_of.date()
    cutoff_7d = today - timedelta(days=7)
    cutoff_30d = today - timedelta(days=30)
    cutoff_90d = today - timedelta(days=90)

    # 1. Aggregate windows per SKU. Every SKU known to the inventory is seeded
    # with zeros so non-sellers anchor the category distribution — otherwise
    # the z-score mean is computed only over SKUs that sold, inflating it and
    # making the weakest *seller* look like dead stock.
    windows: dict[str, dict[str, int]] = defaultdict(
        lambda: {"u7": 0, "u30": 0, "u90": 0, "prior": 0}
    )
    for sku in category_by_sku:
        windows[sku]  # noqa: B018 — seed the entry
    # Lower bounds are EXCLUSIVE: (today-7, today] spans exactly 7 calendar
    # days including the frontier day. The old inclusive bound made "u7" an
    # 8-day window compared against a 7-day prior rate, biasing every trend
    # ratio ~14% upward and nudging borderline SKUs into "rising".
    for record in sales:
        if record.sale_date <= cutoff_90d:
            continue
        w = windows[record.sku]
        w["u90"] += record.units
        if record.sale_date > cutoff_7d:
            w["u7"] += record.units
        else:
            w["prior"] += record.units  # within 90d but before the last 7d
        if record.sale_date > cutoff_30d:
            w["u30"] += record.units

    # 2. Group by category for z-scoring.
    # SKUs in sales but absent from inventory use the same "uncategorized"
    # label the summary uses (a "default" cohort here made the two disagree
    # about the same population).
    by_category: dict[str, list[tuple[str, dict[str, int]]]] = defaultdict(list)
    for sku, w in windows.items():
        by_category[category_by_sku.get(sku, "uncategorized")].append((sku, w))

    # The ONE denominator (sheet 03). The prior window is (today-90, today-7]
    # - the same span the "prior" bucket above accumulates into, so the
    # numerator and the divisor describe the identical set of days. Getting
    # those two out of step is how a rate silently becomes a different rate.
    prior_open_days = open_days_between(calendar, cutoff_90d, cutoff_7d)
    logger.info(
        "[velocity] trend basis=%s prior_days=%d skus=%d",
        "open_days" if prior_open_days else "calendar_days",
        prior_open_days or _PRIOR_WINDOW_DAYS,
        len(windows),
    )

    # 3. Score each SKU against its category distribution.
    result: dict[str, VelocityInfo] = {}
    for category, items in by_category.items():
        m7, s7 = _mean_std([w["u7"] for _, w in items])
        m30, s30 = _mean_std([w["u30"] for _, w in items])
        m90, s90 = _mean_std([w["u90"] for _, w in items])
        degenerate = len(items) < 3 or (s7 == 0 and s30 == 0 and s90 == 0)
        for sku, w in items:
            score = (
                _W_30D * _z(w["u30"], m30, s30)
                + _W_90D * _z(w["u90"], m90, s90)
                + _W_7D * _z(w["u7"], m7, s7)
            )
            # Zero sales in 90 days is "very_low" by definition, and a
            # degenerate distribution (tiny or flat cohort, std=0 -> z=0)
            # falls back to absolute-rate bucketing — neither may label dead
            # stock "medium".
            if w["u90"] == 0:
                bucket = "very_low"
            elif degenerate:
                bucket = _bucket_absolute(w["u30"])
            else:
                bucket = _bucket(score)
            result[sku] = VelocityInfo(
                sku=sku,
                category=category,
                units_7d=w["u7"],
                units_30d=w["u30"],
                units_90d=w["u90"],
                velocity_score=round(score, 3),
                velocity_bucket=bucket,
                trend=_trend(w["u7"], w["prior"], prior_open_days),
            )
    return result
