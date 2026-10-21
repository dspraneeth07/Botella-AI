"""Shapes for the feedback loop and co-purchase grounding.

Both data sources are OPTIONAL Node endpoints (see API_CONTRACT.md §1.4/§1.5).
Until Node implements them the fetchers return empty lists and every feature
in this module stays inert — the same graceful-degradation pattern as
``cost`` and ``created_at``.
"""

from __future__ import annotations

from datetime import date

from pydantic import AliasChoices, BaseModel, ConfigDict, Field


class PastRecommendation(BaseModel):
    """One previously persisted recommendation, returned by Node.

    The fields needed to score it: when it ran, what it recommended, what
    bucket it was in, and (once the UI ships thumbs) how users voted on it.
    """

    model_config = ConfigDict(extra="ignore")

    rec_date: date = Field(validation_alias=AliasChoices("rec_date", "date"))
    category: str = "unknown"
    primary_skus: list[str] = []
    confidence: float | None = None
    # Optional explicit user feedback (counts, so multiple users/visits can
    # vote). Absent/zero -> the score falls back to pure realized lift.
    thumbs_up: int = 0
    thumbs_down: int = 0
    # Node's measured effectiveness score (0-1) for this rec — its longest
    # evaluated window, blending realized lift, detected action compliance and
    # shrunk votes (recommendationEvalService). None until evaluated. When
    # present it supersedes this module's own shorter-window computation.
    evaluated_score: float | None = None
    # --- Measured fields from the rec's longest EVALUATED window (additive;
    # may come from a different window than evaluated_score's longest SCORED
    # one). All degrade to None on an older Node. ---
    # Tri-state action detection: True = the store was seen acting on the rec,
    # False = provably did not (we checked), None = can't tell (or the eval
    # tables don't exist). NEVER round None up to yes.
    action_taken: bool | None = None
    # The owner's self-report: 'did' | 'did_not' | 'dismissed' | None.
    # 'dismissed' means they declined to answer — evidence of neither action
    # nor inaction.
    action_claim: str | None = None
    # 'winner' | 'neutral' | 'underperformer' | 'insufficient_data' | None.
    # insufficient_data = not yet measurable; treat it as unmeasured, never as
    # failure.
    verdict: str | None = None
    # RAW UNCAPPED realized lift stored for that window. Honesty rule: cap at
    # 5 before averaging or displaying (Node stores raw, shows capped means).
    lift: float | None = None

    @property
    def user_score(self) -> float | None:
        """Share of positive votes, or None when nobody voted."""
        votes = self.thumbs_up + self.thumbs_down
        if votes <= 0:
            return None
        return self.thumbs_up / votes


class EffectivenessEntry(BaseModel):
    """One SKU-level lesson from Node's measured evaluations (§1.4 envelope).

    ``evidence`` arrives pre-worded by Node from register-measured results
    (e.g. ``"worked 2 of 2 times, avg lift 2.1x"``; averaged lift already
    capped at 5 server-side) — render it verbatim, never re-derive it.
    """

    model_config = ConfigDict(extra="ignore")

    sku: str
    # Product name from the warehouse; None when it was slow/unreachable.
    name: str | None = None
    category: str = "unknown"
    evidence: str = ""


class LearnedEffectiveness(BaseModel):
    """Node's proven/avoid SKU lists: each SKU had >=2 scored evaluations and
    repeatedly cleared (proven) or missed (avoid) the measured thresholds."""

    model_config = ConfigDict(extra="ignore")

    proven: list[EffectivenessEntry] = []
    avoid: list[EffectivenessEntry] = []

    def is_empty(self) -> bool:
        return not (self.proven or self.avoid)


class RecommendationHistoryFeed(BaseModel):
    """Everything GET recommendation-history returns.

    Older Nodes return a bare array (rows only); newer ones the
    ``{"data": [...], "effectiveness": {...}}`` envelope. Both parse into
    this shape, with ``learned`` empty when the envelope is absent.
    """

    rows: list[PastRecommendation] = []
    learned: LearnedEffectiveness = Field(default_factory=LearnedEffectiveness)


class FeedbackParams(BaseModel):
    """Tunables for recommendation scoring (defaults mirror Settings)."""

    # Blend weights: realized lift (computed) vs explicit thumbs (human).
    # Renormalized when a component is missing, so lift-only still scores.
    lift_weight: float = 0.6
    user_weight: float = 0.4
    # Score thresholds: >= winner -> the rec's SKUs become "proven winners"
    # (boosted into the candidate pool); <= loser -> its SKUs go on the
    # didn't-convert list the model is told to be skeptical of.
    winner_threshold: float = 0.6
    loser_threshold: float = 0.4


class CoPurchasePair(BaseModel):
    """Two SKUs that co-occur in baskets, with how often (basket count)."""

    model_config = ConfigDict(extra="ignore")

    sku_a: str
    sku_b: str
    support: int = 0


class CategoryFeedback(BaseModel):
    """Realized performance of one recommendation category over the window."""

    category: str
    recs: int
    avg_lift: float  # 1.0 = sold at baseline rate after being recommended
    avg_score: float  # blended 0-1 score (lift + thumbs); 0.5 = neutral


class FeedbackDigest(BaseModel):
    """Compact summary of how past recommendations actually converted.

    ``lift`` compares each recommended SKU's units in the days after the
    recommendation against its own trailing baseline; >1 means the rec
    coincided with above-baseline sales. ``score`` blends that lift with any
    explicit thumbs votes into one 0-1 number per rec (0.5 = neutral); the
    winner/loser SKU lists are the recs that cleared / missed the thresholds.
    """

    window_days: int
    measured_recs: int
    overall_lift: float | None = None
    overall_score: float | None = None
    categories: list[CategoryFeedback] = []
    # Average lift split by stated confidence, for calibration context.
    high_confidence_lift: float | None = None  # confidence >= 0.75
    low_confidence_lift: float | None = None  # confidence < 0.75
    # SKUs from recs scoring >= winner_threshold: deterministically boosted
    # into the candidate pool as the "proven" slice.
    winner_skus: list[str] = []
    # SKUs from recs scoring <= loser_threshold: surfaced as an avoid-list.
    loser_skus: list[str] = []
