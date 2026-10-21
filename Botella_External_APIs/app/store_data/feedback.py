"""Recommendation scoring: did past recommendations actually convert?

Joins the recommendation history Node returns (optional endpoint) with the
sales rows the run already fetched — no extra data round-trip. The chain is:

1. **Lift** (computed): each recommended SKU's units in the 7 days after the
   rec vs. its own trailing 21-day baseline. lift 1.0 = the rec changed
   nothing; 2.0 = the SKU sold at twice its normal rate.
2. **Score** (blended, 0-1): lift squashed to 0-1 (1.0x -> 0.5 neutral),
   blended with the rec's thumbs votes when the UI has any, via the weights in
   :class:`FeedbackParams`. Human votes are sparse but high-signal, so when
   present they pull the score hard; absent, the score is pure lift.
3. **Thresholds**: recs scoring >= ``winner_threshold`` donate their SKUs to
   the proven-winner pool (deterministically boosted into candidate
   selection); recs <= ``loser_threshold`` donate theirs to the avoid-list.

Everything in 1-3 is plain Python — the LLM only sees the resulting digest,
the PROVEN candidate tags, and the avoid-list. As thumbs data accumulates this
same scored history is the labeled dataset a future learned model (per-store
signal elasticities, confidence calibration) trains on.
"""

from __future__ import annotations

import statistics
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta

from app.logging_config import get_logger
from app.pipeline.outcomes import SkuOutcome, lift_for
from app.schemas.feedback import (
    CategoryFeedback,
    FeedbackDigest,
    FeedbackParams,
    PastRecommendation,
)
from app.schemas.store import SaleRecord

log = get_logger(__name__)

@dataclass(frozen=True, slots=True)
class OpenDayCalendar:
    """The days this store actually traded, so a rate is per OPEN day.

    OPTIONAL, and its absence is the honest default rather than a safe one:
    without it the windows below are counted in CALENDAR days, which at a store
    closing one day a week understates every baseline rate by about a fifth.
    Bethany closes 200 days of 1,360.

    Supplied by the caller because this module is stateless and holds no
    database credentials - the standing architectural constraint.
    """

    open_dates: frozenset[date]

    def between(self, start: date, end: date) -> float:
        """Open days in [start, end). Zero is a real answer - a store that was
        shut throughout a window has an unmeasurable lift, not an infinite
        one, and `lift_for` says so."""
        days = (end - start).days
        return float(sum(
            1 for i in range(max(0, days))
            if (start + timedelta(days=i)) in self.open_dates
        ))


_POST_DAYS = 7  # conversion window after a recommendation
_BASELINE_DAYS = 21  # trailing window that defines the SKU's normal rate
_CONFIDENCE_SPLIT = 0.75
_MAX_LISTED_SKUS = 15  # cap on winner/loser SKU lists in the digest


def prioritize_history(
    history: list[PastRecommendation], limit: int | None
) -> list[PastRecommendation]:
    """Bound the history to ``limit`` recs, keeping the highest-signal ones.

    Voted recs (a thumbs up/down — the scarce human signal) are kept first,
    then the most-recent unvoted recs fill the remaining slots. With no votes
    this is simply "the most recent ``limit`` recs". Node already returns a
    bounded, voted-first list (``?limit=``); this is the defensive Python-side
    guarantee so an older Node, an ignored param, or an unbounded response can
    never balloon the feedback computation or the prompt's winner/loser lists.

    Order within the kept set is irrelevant downstream — :func:`compute_feedback`
    aggregates regardless — so this only decides *which* recs survive truncation.
    """
    if limit is None or limit < 0 or len(history) <= limit:
        return history
    voted = sorted(
        (r for r in history if r.user_score is not None),
        key=lambda r: r.rec_date,
        reverse=True,
    )
    unvoted = sorted(
        (r for r in history if r.user_score is None),
        key=lambda r: r.rec_date,
        reverse=True,
    )
    return (voted + unvoted)[:limit]


def _units_between(
    daily: dict[str, dict[date, int]], sku: str, start: date, end: date
) -> int:
    """Total units for ``sku`` on days in (start, end] — exclusive/inclusive."""
    by_day = daily.get(sku)
    if not by_day:
        return 0
    return sum(units for day, units in by_day.items() if start < day <= end)


def _rec_lift(
    rec: PastRecommendation,
    daily: dict[str, dict[date, int]],
    open_days: OpenDayCalendar | None = None,
) -> float | None:
    """Lift across the recommendation's SKUs, or None if unmeasurable.

    NOW THE SHARED DEFINITION (sheet 19). This used to compute its own, and it
    disagreed with the Node evaluation service by 1.37x on identical data:

        here    21-day baseline, fixed 7-day window, MEAN of per-SKU ratios
        Node    28-day baseline, covered span, POOLED sum(actual)/sum(expected)

    Two implementations of one metric is how a dead-stock count came out 454 on
    one screen and 485 on another. Calibration fits on lift, the shrinkage
    constant k is fitted from it, and the gate judges on it - so it is now
    `app/pipeline/outcomes/lift.py`, twinned with `backend/lib/lift.js` and
    pinned to it by a cross-language fixture.

    WHAT CHANGED FOR THIS CALLER, STATED PLAINLY
        This score feeds the proven-winner pool and the avoid-list, so the
        metric change moves which SKUs get boosted. A recommendation covering a
        busy SKU and a quiet one now scores on the busy one, where the mean of
        ratios let the quiet SKU - whose ratio swings on a single basket -
        carry half the answer.

    `open_days` is optional and, when absent, falls back to calendar days with
    the window lengths this function has always used. That keeps a caller with
    no calendar working, and it is worse: at Bethany a 21-calendar-day window
    holds about 17 open days, so the baseline rate is understated by a fifth.
    """
    skus = [
        SkuOutcome(
            sku=sku,
            baseline_units=_units_between(
                daily, sku,
                rec.rec_date - timedelta(days=_BASELINE_DAYS), rec.rec_date,
            ),
            actual_units=_units_between(
                daily, sku, rec.rec_date,
                rec.rec_date + timedelta(days=_POST_DAYS),
            ),
        )
        for sku in rec.primary_skus
    ]

    baseline_days = float(_BASELINE_DAYS)
    post_days = float(_POST_DAYS)
    if open_days is not None:
        baseline_days = open_days.between(
            rec.rec_date - timedelta(days=_BASELINE_DAYS), rec.rec_date
        )
        post_days = open_days.between(
            rec.rec_date, rec.rec_date + timedelta(days=_POST_DAYS)
        )

    return lift_for(skus, baseline_days, post_days).lift


def _lift_component(lift: float) -> float:
    """Squash lift in [0, inf) to a 0-1 score: 1.0x -> 0.5 (neutral).

    Deliberately NOT `score_from_lift` from the shared module: that one CAPS at
    5x before squashing, which is right for the gate's mean (one 40x row must
    not decide a store's verdict) and wrong here, where the score is per
    recommendation and a genuine 40x should read as the strongest signal
    available. Same shape, different job, and the difference is stated rather
    than accidental.
    """
    return lift / (lift + 1.0)


def score_recommendation(
    lift: float | None, user_score: float | None, params: FeedbackParams
) -> float | None:
    """Blend computed lift and explicit thumbs into one 0-1 score.

    Missing components drop out and the weights renormalize, so a rec with
    only lift (no votes yet) or only votes (no measurable baseline) still
    scores. Returns None when neither component exists.
    """
    total_weight = 0.0
    accum = 0.0
    if lift is not None:
        accum += params.lift_weight * _lift_component(lift)
        total_weight += params.lift_weight
    if user_score is not None:
        accum += params.user_weight * user_score
        total_weight += params.user_weight
    if total_weight == 0.0:
        return None
    return round(accum / total_weight, 3)


def compute_feedback(
    history: list[PastRecommendation],
    sales: list[SaleRecord],
    *,
    data_as_of: date,
    window_days: int = 30,
    params: FeedbackParams | None = None,
) -> FeedbackDigest | None:
    """Score the past recommendations and build a :class:`FeedbackDigest`.

    Returns None when nothing is scoreable (no history, or every rec is both
    unvoted and too recent for its post window to have closed).
    """
    if not history:
        return None
    params = params or FeedbackParams()

    daily: dict[str, dict[date, int]] = defaultdict(dict)
    for record in sales:
        day_units = daily[record.sku]
        day_units[record.sale_date] = day_units.get(record.sale_date, 0) + record.units

    lifts_by_category: dict[str, list[float]] = defaultdict(list)
    scores_by_category: dict[str, list[float]] = defaultdict(list)
    high_conf: list[float] = []
    low_conf: list[float] = []
    winner_skus: list[str] = []
    loser_skus: list[str] = []
    measured = 0

    for rec in history:
        # Lift is only measurable once the post window has closed in the data;
        # thumbs votes count regardless.
        lift: float | None = None
        if rec.rec_date + timedelta(days=_POST_DAYS) <= data_as_of:
            lift = _rec_lift(rec, daily)
        # Closed loop: when Node has already measured this rec's effectiveness
        # (longer window, action-compliance-aware, votes shrunk in), that score
        # is authoritative — using it INSTEAD of re-blending here avoids
        # double-counting the same thumbs votes. Local lift still feeds the
        # per-category lift averages either way.
        if rec.evaluated_score is not None:
            score: float | None = round(rec.evaluated_score, 3)
        else:
            score = score_recommendation(lift, rec.user_score, params)
        if score is None:
            continue

        measured += 1
        scores_by_category[rec.category].append(score)
        if lift is not None:
            lifts_by_category[rec.category].append(lift)
            if rec.confidence is not None:
                (high_conf if rec.confidence >= _CONFIDENCE_SPLIT else low_conf).append(lift)

        if score >= params.winner_threshold:
            winner_skus.extend(rec.primary_skus)
        elif score <= params.loser_threshold:
            loser_skus.extend(rec.primary_skus)

    if not measured:
        return None

    categories = sorted(
        (
            CategoryFeedback(
                category=category,
                recs=len(scores),
                avg_lift=round(statistics.fmean(lifts_by_category[category]), 2)
                if lifts_by_category[category]
                else 1.0,
                avg_score=round(statistics.fmean(scores), 2),
            )
            for category, scores in scores_by_category.items()
        ),
        key=lambda c: c.avg_score,
        reverse=True,
    )
    all_lifts = [lift for lifts in lifts_by_category.values() for lift in lifts]
    all_scores = [s for scores in scores_by_category.values() for s in scores]

    # A SKU that both won and lost (different recs/contexts) is treated as a
    # winner — recent evidence it can convert outweighs one miss.
    winners_unique = list(dict.fromkeys(winner_skus))[:_MAX_LISTED_SKUS]
    losers_unique = [
        sku for sku in dict.fromkeys(loser_skus) if sku not in set(winners_unique)
    ][:_MAX_LISTED_SKUS]

    digest = FeedbackDigest(
        window_days=window_days,
        measured_recs=measured,
        overall_lift=round(statistics.fmean(all_lifts), 2) if all_lifts else None,
        overall_score=round(statistics.fmean(all_scores), 2),
        categories=categories,
        high_confidence_lift=round(statistics.fmean(high_conf), 2) if high_conf else None,
        low_confidence_lift=round(statistics.fmean(low_conf), 2) if low_conf else None,
        winner_skus=winners_unique,
        loser_skus=losers_unique,
    )
    log.info(
        "feedback_computed",
        measured=measured,
        overall_score=digest.overall_score,
        winners=len(winners_unique),
        losers=len(losers_unique),
    )
    return digest
