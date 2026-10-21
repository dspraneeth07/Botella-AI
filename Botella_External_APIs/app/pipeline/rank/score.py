"""score = expected_value × calibrated_confidence × urgency.

WHY THIS REPLACES THE MODEL
    Today the LLM chooses which recommendations appear and in what order. That
    single fact explains most of the backtest result: the ordering was
    unstable, unexplainable and UNIMPROVABLE, because nobody could say what it
    optimised.

    Ranking becomes an ordinary function of numbers the pipeline already
    computed. After that, the ordering can be argued about, tuned and tested -
    which is the whole value. It is arguably the smallest module in the
    programme and the one that most changes the system's character.

THE THREE TERMS
    expected_value        margin × units at risk, or units gained. Money.
    calibrated_confidence sheet 08's CALIBRATED value, never the raw one.
    urgency               how soon the decision window closes.

    Multiplied rather than summed, because each is a fraction of the others'
    value: a certain, urgent recommendation worth nothing is worth nothing, and
    a valuable, certain one whose window closed last month is worth nothing
    too. A weighted sum would let two strong terms carry a zero third, which is
    exactly the "high confidence, no money" card this rebuild exists to remove.

CALIBRATED, NEVER RAW
    `raw_confidence` is not read in this module, and
    `test_raw_confidence_is_never_used_in_place_of_calibrated` walks the AST to
    prove it. Sheet 08 measured stated confidence at 0.48 against a 0.23 hit
    rate - ranking on that number would order cards by how confident the engine
    SOUNDS rather than by how often it is right.

NO MODEL. NO RANDOMNESS. NO CLOCK.
    No model call, no `random`, no `datetime.now`. Every date comes from
    `ctx.as_of`. `check_no_literals` already forbids ambient clock reads in
    this package; `order.py` asserts the byte-identical consequence.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any

from app.pipeline.blend.reversion import RevertedDemand
from app.pipeline.candidates.types import Candidate
from app.pipeline.context import RunContext
from app.pipeline.registry import ConfigRegistry, Setting, cfg

PERCENT = 100

# ── Weights. All PROVISIONAL, all to be tuned against holdout outcomes. ──────

WEIGHT_EXPECTED_VALUE = Setting(
    name="rank.weight.expected_value",
    default=1.0,
    unit="exponent on the expected-value term",
    owner="commercial",
    why="provisional; an EXPONENT rather than a multiplier, because a "
        "multiplier on a product term only rescales every score identically "
        "and cannot change an ordering. At 1.0 the term enters linearly; "
        "above 1 money dominates, below 1 it flattens. To be fitted against "
        "holdout outcomes in wave 6",
    status="PROVISIONAL",
)

WEIGHT_CONFIDENCE = Setting(
    name="rank.weight.confidence",
    default=1.0,
    unit="exponent on the calibrated-confidence term",
    owner="forecasting",
    why="provisional; same shape as the value weight. Raising it makes the "
        "engine conservative - it will prefer a small certain win to a large "
        "uncertain one. That is a commercial preference, not an engineering "
        "one, so it is a setting rather than a constant",
    status="PROVISIONAL",
)

WEIGHT_URGENCY = Setting(
    name="rank.weight.urgency",
    default=1.0,
    unit="exponent on the urgency term",
    owner="commercial",
    why="provisional; raising it pushes closing-window cards up the list even "
        "when they are worth less. To be fitted in wave 6",
    status="PROVISIONAL",
)

URGENCY_HORIZON_DAYS = Setting(
    name="rank.urgency_horizon_days",
    default=30,
    unit="days",
    owner="commercial",
    why="provisional; the horizon over which urgency decays to its floor. A "
        "decision due tomorrow scores near 1.0, one due beyond this horizon "
        "scores the floor. Thirty days is roughly a reorder cycle plus a "
        "review period",
    status="PROVISIONAL",
)

URGENCY_FLOOR = Setting(
    name="rank.urgency_floor",
    default=0.1,
    unit="multiplier",
    owner="commercial",
    why="provisional, and deliberately ABOVE zero. A distant deadline makes a "
        "recommendation less pressing, not worthless - a floor of zero would "
        "multiply the whole score to nothing and silently delete every card "
        "without a near deadline, including large ones",
    status="PROVISIONAL",
)

DEFAULT_MARGIN_RATE = Setting(
    name="rank.default_margin_rate",
    default=0,
    unit="fraction",
    owner="commercial",
    why="provisional, and ZERO on purpose. A candidate whose margin cannot be "
        "computed - 31 stores send 0.00% cost, so this is common - scores no "
        "expected value rather than borrowing an assumed rate. Sheet 02 "
        "already withholds margin CLAIMS without cost; this is the ranking "
        "half of the same rule, and a non-zero default here would rank a "
        "store's cards on a margin nobody measured",
    status="PROVISIONAL",
)


@dataclass(frozen=True, slots=True)
class ScoreInputs:
    """The money and timing behind one candidate. Supplied by stage 12/14."""

    candidate: Candidate
    #: Sheet 08's CALIBRATED confidence. Never the raw stated figure.
    calibrated_confidence: float
    #: Units at risk (a stockout) or gained (a range addition).
    units_at_stake: float
    #: Per-unit margin in currency. None when cost is unavailable - which
    #: yields zero expected value, never an assumed rate.
    unit_margin: float | None = None
    #: When the decision stops being actionable. None means no deadline, which
    #: scores the urgency floor rather than the maximum.
    decision_by: date | None = None

    def __post_init__(self) -> None:
        if not 0.0 <= self.calibrated_confidence <= 1.0:
            raise ValueError(
                "calibrated_confidence must be within 0..1, got "
                f"{self.calibrated_confidence}"
            )

    @classmethod
    def from_reversion(
        cls,
        candidate: Candidate,
        reverted: RevertedDemand,
        calibrated_confidence: float,
        *,
        unit_margin: float | None = None,
        decision_by: date | None = None,
    ) -> ScoreInputs:
        """Build the score inputs from sheet 20's output.

        THIS CONSTRUCTOR EXISTS TO MAKE ONE MISTAKE IMPOSSIBLE.
        `units_at_stake` must be the DEFICIT - the units the current plan
        misses - and not the corrected rate itself. Ranking on the rate is
        what the old engine did: it orders by how big a seller is, so it picks
        the biggest sellers, whose trailing windows are the most inflated, and
        they are precisely the ones that fall back. Measured on Bethany that
        ordering scored 39.3% and MINUS $13,783 of realised margin, against
        65.6% and PLUS $14,508 for this one. The difference is entirely which
        quantity went into this field.

        `reverted.p_hit` is deliberately NOT accepted as the confidence. It is
        ordered but not numerically calibrated (p_hit 0.55 corresponds to a
        42% outcome), so it must pass through sheet 08 first - the caller
        supplies the calibrated value, exactly as sheet 08's 0.48-stated-
        against-0.23-actual finding requires.

        A negative deficit clamps to zero expected value rather than raising:
        a SKU heading down is a real answer and belongs in the list at the
        bottom, not as an exception. `is_recommendable` is what keeps it off
        a card entirely.
        """
        return cls(
            candidate=candidate,
            calibrated_confidence=calibrated_confidence,
            units_at_stake=max(0.0, reverted.deficit_units),
            unit_margin=unit_margin,
            decision_by=decision_by,
        )


@dataclass(frozen=True, slots=True)
class Score:
    """The score, and each term that produced it."""

    sku: str
    family: str
    score: float
    expected_value: float
    calibrated_confidence: float
    urgency: float
    #: Recorded so a reader can tell "no margin data" from "no units at stake".
    margin_available: bool

    def as_dict(self) -> dict[str, Any]:
        return {
            "sku": self.sku, "family": self.family, "score": self.score,
            "expected_value": self.expected_value,
            "calibrated_confidence": self.calibrated_confidence,
            "urgency": self.urgency,
            "margin_available": self.margin_available,
        }

    def explain(self) -> str:
        if not self.margin_available:
            return (
                "Ranked on timing and confidence only - no cost data, so the "
                "money this would make cannot be computed."
            )
        return (
            f"Worth about ${self.expected_value:.0f}, "
            f"{self.calibrated_confidence:.0%} likely to work, "
            f"urgency {self.urgency:.2f}."
        )


def expected_value_of(inputs: ScoreInputs) -> tuple[float, bool]:
    """margin × units. Returns (value, whether margin was available).

    Zero when cost is missing, and the flag says which kind of zero it is - a
    candidate worth nothing and a candidate whose worth is unknown look
    identical as a number and are not the same thing.
    """
    if inputs.unit_margin is None:
        return 0.0, False
    return max(0.0, inputs.unit_margin * max(0.0, inputs.units_at_stake)), True


def urgency_of(
    decision_by: date | None, as_of: date, horizon_days: int, floor: float
) -> float:
    """1.0 for a decision due now, decaying linearly to `floor` at the horizon.

    `as_of` comes from the RunContext - never a clock read, which is what
    makes two runs over the same snapshot produce the same ordering months
    apart.

    A deadline already PAST scores 1.0, not zero: the window closing is the
    most urgent state there is, not a reason to stop mentioning it.
    """
    if decision_by is None:
        return floor
    days_remaining = (decision_by - as_of).days
    if days_remaining <= 0:
        return 1.0
    if days_remaining >= horizon_days:
        return floor
    fraction = days_remaining / horizon_days
    return floor + (1.0 - floor) * (1.0 - fraction)


def score_candidate(
    inputs: ScoreInputs, ctx: RunContext, config: ConfigRegistry = cfg
) -> Score:
    """score = expected_value^a × confidence^b × urgency^c.

    A pure function of numbers earlier stages computed. No I/O, no clock, no
    model - which is what lets `order.py` assert byte-identical output.
    """
    value, margin_available = expected_value_of(inputs)
    urgency = urgency_of(
        inputs.decision_by, ctx.as_of,
        int(config.get(URGENCY_HORIZON_DAYS, ctx)),
        float(config.get(URGENCY_FLOOR, ctx)),
    )
    confidence = inputs.calibrated_confidence

    weight_value = float(config.get(WEIGHT_EXPECTED_VALUE, ctx))
    weight_confidence = float(config.get(WEIGHT_CONFIDENCE, ctx))
    weight_urgency = float(config.get(WEIGHT_URGENCY, ctx))

    score = (
        value ** weight_value
        * confidence ** weight_confidence
        * urgency ** weight_urgency
    )
    return Score(
        sku=inputs.candidate.identity.sku,
        family=inputs.candidate.family,
        score=score,
        expected_value=value,
        calibrated_confidence=confidence,
        urgency=urgency,
        margin_available=margin_available,
    )


__all__ = [
    "DEFAULT_MARGIN_RATE",
    "URGENCY_FLOOR",
    "URGENCY_HORIZON_DAYS",
    "WEIGHT_CONFIDENCE",
    "WEIGHT_EXPECTED_VALUE",
    "WEIGHT_URGENCY",
    "Score",
    "ScoreInputs",
    "expected_value_of",
    "score_candidate",
    "urgency_of",
]
