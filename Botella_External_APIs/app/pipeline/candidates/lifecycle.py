"""When to stop repeating a card the store is not acting on, or that was wrong.

THE DEFECT THIS EXISTS TO FIX, FROM THE MARCH 2026 LEDGER
    Stroyski 1.75L was recommended on **eight consecutive trading days** and
    missed every single time, costing $133. Deep Eddy Lemon 50ml hit 7 of 21.
    Wheatley Vodka 50ml hit 9 of 21.

    The engine had no memory. Every morning it recomputed a depressed trailing
    window, found the same product, and said the same thing - with no idea it
    had said it yesterday, or that yesterday's prediction had already started
    going wrong. 162 cards over sixteen products is not sixteen judgements
    repeated by design; it is one judgement repeated because nothing was
    watching.

    A recovery call is a testable claim with a short fuse. "This will come back"
    is checkable within a week or two of daily sales, and if it is not coming
    back the card should go - not because the owner ignored it, but because the
    engine was wrong and can tell.

WHAT THIS IS NOT
    Not a cooldown on the PRODUCT. A SKU that genuinely dips again three months
    later deserves a fresh card on fresh evidence. This retires a CLAIM, and a
    retired claim can be re-earned.

    Not a guess at owner behaviour either. Nothing here reads whether anyone
    clicked anything - that data does not exist yet. It reads what the product
    DID, which is the same evidence that justified the card in the first place.

THE THREE RULES, AND WHY THEY ARE IN THIS ORDER
    1. DECLINING. If sales since the card went up are IMPLAUSIBLY low for the
       rate that justified it, this was not a dip - it is a decline, and the
       card is actively wrong. Retire at once; do not wait out the review
       window.
    2. NO RECOVERY. After the review window, if the rate has not improved on
       the baseline at all, the recovery has not happened. Retire.
    3. STALE. Past the maximum age, retire regardless. A card that has sat for
       a month is furniture, and a claim nobody can remember being made cannot
       be judged.

    Declining is checked first because it is the only rule that fires EARLY,
    and the whole point is to stop a wrong card before it repeats eight times.

DECLINING IS A TAIL PROBABILITY, NOT A RATIO (checklist 17)
    The first version of rule 1 compared a point ratio against 0.8: realised
    rate over baseline rate, retire below. At three open days that is a test
    on two or three baskets, and it fired on noise. A product justified at one
    a day that sold two units in its first three open days has a ratio of
    0.67 and was retired - but under a Poisson count with mean 3, two or fewer
    units happens 42% of the time. The rule was retiring cards on evidence
    that would have appeared, with the card perfectly right, two mornings in
    five.

    The rule now asks the question it meant to ask: IF the product were still
    selling at the rate that justified the card, how often would it have sold
    this few? That is P(X <= units_since) with mean baseline_rate x open_days
    under the same count model the card's own published range is drawn from
    (`blend/predictive_interval.py`): negative binomial with the SKU's own
    measured dispersion where one exists, Poisson where it does not - and the
    retirement says which, because a Poisson tail on an erratic SKU overstates
    the surprise.

    The threshold is `lifecycle.decline_tail_probability`, and the arithmetic
    is in its `why`. The property the Stroyski case needs is kept: a card at
    one a day selling half that is pulled before the eighth repeat.

A RETIREMENT HAS A DATE, AND THE DATE IS STORED
    `suppressed_until()` returns an open-day INDEX, which is the right unit
    for the rule and the wrong thing to persist: an index into one morning's
    trading calendar means nothing the next morning. The live route used to
    compute "today + 14" every morning from a card it re-judged every morning,
    which is either a suppression that rolls forever or one that ends the
    moment the rule stops firing - not fourteen days.

    `CardRetirement` is what the route now returns to Node: the retirement
    date, the rule, and a PROJECTED calendar date on which the suppression
    ends (`suppression_end_date`). Node stores it, hands it back on the next
    morning's card-history feed, and the route honours the STORED date rather
    than re-deciding. A verdict is made once.

A FLOOR UNDER THE CANDIDATE POOL
    At a thin store - Bethany clears fourteen products through the gates -
    retiring and suppressing a handful of cards can leave the slate empty, and
    an empty slate is indistinguishable from a broken engine. Below
    `lifecycle.min_candidate_pool`, the route relaxes suppression on the cards
    nearest the END of their window, one at a time, until the floor is met or
    there is nothing left to relax - and COUNTS each relaxation, so a slate
    that was back-filled from retired claims says so in its screen counts.
    With a pool above the floor the behaviour is byte-identical to before.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from app.pipeline.blend.predictive_interval import lower_tail_probability
from app.pipeline.context import RunContext
from app.pipeline.registry import ConfigRegistry, Setting, cfg

CARD_REVIEW_OPEN_DAYS = Setting(
    name="lifecycle.review_open_days",
    default=7,
    unit="open days after the card was first issued",
    owner="commercial",
    why="MEASURED against the March 2026 ledger. A recovery claim is testable "
        "within about a week of trading: seven open days is enough daily sales "
        "to tell a dip that is reversing from one that is not, and short "
        "enough that a wrong card repeats twice rather than eight times. "
        "Stroyski 1.75L ran for eight consecutive days and missed every one; "
        "at seven this rule would have pulled it after the second",
    status="MEASURED",
)

CARD_MAX_OPEN_DAYS = Setting(
    name="lifecycle.max_open_days",
    default=21,
    unit="open days after the card was first issued",
    owner="commercial",
    why="provisional; the age past which a card is furniture rather than "
        "advice. Three trading weeks is roughly one reorder cycle plus a "
        "review period, so a card that has survived it has had its chance to "
        "be acted on. The claim can be re-earned on fresh evidence the "
        "following day - this retires a claim, never a product",
    status="PROVISIONAL",
)

DECLINE_TAIL_PROBABILITY = Setting(
    name="lifecycle.decline_tail_probability",
    default=0.10,
    unit="P(X <= units sold since issue | the product still sells at the "
         "rate that justified the card); retire below this",
    owner="forecasting",
    why="provisional. Replaces a point ratio of 0.8 on the realised rate, "
        "which at three open days retired a card on two baskets: a product "
        "justified at 1/day that sold 2 units in 3 open days had a ratio of "
        "0.67 and was retired, yet under Poisson(3) two or fewer units is a "
        "42% event - the card was right and the rule fired on noise. At 0.10 "
        "the same three days retire only on ZERO units (P = 0.050) and keep "
        "two (0.42) and one (0.20); a product justified at 2/day that sells 2 "
        "in 3 days IS retired (P(X<=2 | 6) = 0.062). The Stroyski shape - "
        "justified at 1/day, selling half that - crosses 0.10 on the seventh "
        "open day (P(X<=3 | 7) = 0.082), before the eighth repeat, and the "
        "no-recovery rule would take it the same morning. Not lower than 0.10 "
        "because the rule is re-run every morning, so the chance a RIGHT card "
        "is eventually retired is larger than any single morning's tail; not "
        "higher because above it the rule is back to firing on one quiet "
        "basket. To be fitted once retirement outcomes exist",
    status="PROVISIONAL",
)

MIN_CANDIDATE_POOL = Setting(
    name="lifecycle.min_candidate_pool",
    default=3,
    unit="recommendable candidates after suppression, below which suppression "
         "is relaxed",
    owner="commercial",
    why="provisional. Bethany clears 14 products through the gates on an "
        "ordinary morning and the slate holds 10; a lifecycle that retires a "
        "handful at once can leave the screen empty, which an owner reads as "
        "a broken engine rather than as caution. Three is deliberately FAR "
        "below the slate size: a short slate is the lifecycle doing its job, "
        "and only an empty one is the lifecycle eating the store. Not one, "
        "because a single card is not a selection, it is whatever was left; "
        "not five, because a store that clears four products would then "
        "never have a card retired at all. At Bethany this binds only when "
        "twelve of fourteen candidates are suppressed at once, and every "
        "relaxation is counted in the screen counts rather than hidden",
    status="PROVISIONAL",
)

RETIRE_SUPPRESS_OPEN_DAYS = Setting(
    name="lifecycle.suppress_open_days_after_retirement",
    default=14,
    unit="open days",
    owner="commercial",
    why="provisional, and the piece without which retirement does nothing. The "
        "engine recomputes a depressed trailing window every morning, so a "
        "retired card is re-earned the next day by exactly the evidence that "
        "was just shown to be wrong - the eight-day Stroyski loop, restarted. "
        "Fourteen open days is long enough for the trailing window to turn "
        "over materially, so the next claim rests on different data rather "
        "than the same data reconsidered. This suppresses a CLAIM about a "
        "product, never the product",
    status="PROVISIONAL",
)

MIN_OPEN_DAYS_TO_JUDGE = Setting(
    name="lifecycle.min_open_days_to_judge",
    default=3,
    unit="open days",
    owner="forecasting",
    why="provisional; below three open days a realised rate is one or two "
        "shopping baskets and says nothing. Retiring a card on that would be "
        "as arbitrary as never retiring one, and it is the failure mode that "
        "makes a lifecycle rule worse than no rule",
    status="PROVISIONAL",
)


@dataclass(frozen=True, slots=True)
class CardHistory:
    """What has happened since a card was first issued.

    Assembled by the caller from the same feature store the card came from, so
    nothing here needs a new source of truth.
    """

    sku: str
    first_issued: date
    #: The rate, per OPEN day, that justified the card - sheet 20's recent
    #: rate at the moment of issue. The claim is that sales will exceed it.
    baseline_rate: float
    #: What has actually sold since, and over how many OPEN days.
    units_since: float
    open_days_since: int
    #: THE OWNER ACTED ON IT. An explicit 'did', or an upvote - the two surfaces
    #: disagree about which the owner is offered, and a store that only ever votes
    #: would otherwise read as one that never acts.
    #:
    #: False when the feed does not carry it, which is every caller that predates
    #: this field - so the behaviour without it is exactly the old behaviour.
    accepted: bool = False
    #: The owner said no. Different from ignoring, and worth separating: an
    #: ignored card may simply not have been seen, a dismissed one was.
    dismissed: bool = False
    #: The SKU's measured scatter (coefficient of variation of weekly rates),
    #: ideally as of `first_issued` so the declining test uses the same
    #: dispersion the card's range was published under. None means NOT
    #: MEASURED - the declining rule then falls back to Poisson and says so.
    #: It must never be defaulted to zero here: zero is the narrowest count
    #: distribution there is, and it would make the rule most trigger-happy
    #: on exactly the SKUs it knows least about.
    dispersion_cv: float | None = None
    #: A retirement Node has already STORED for this claim, if any. Node sends
    #: it ONLY while no fresher card has been issued since - a card written
    #: after the retirement is a new claim, and Node then reports that card
    #: and no retirement. So when set, the verdict is not re-made:
    #: `suppressed_until` is honoured as written, and the SKU is simply free to
    #: be re-earned once it passes. All three are None for a feed that
    #: predates migration 034, which restores the previous behaviour.
    retired_at: date | None = None
    suppressed_until: date | None = None
    retirement_rule: str | None = None
    #: What KIND of card this was - "reorder", "markdown", ... - as Node
    #: stored it. None where the feed predates the column. An ABSENCE: a card
    #: of unknown kind keeps the rules it has always had, so legacy rows
    #: change nothing; it is never read as "reorder".
    action_type: str | None = None

    @property
    def already_retired(self) -> bool:
        """A stored retirement that nothing fresher has superseded.

        Node decides "fresher" by comparing the card's write time with the
        retirement row's, which is exact; a date comparison here against
        `first_issued` would be re-deriving that from a trading date that
        lags the run by a day or more, and would get it wrong on a slow sync.
        """
        return self.retired_at is not None

    @property
    def realised_rate(self) -> float:
        """Units per open day since the card went up. Zero open days is zero
        rate, never a divide - the same guard sheet 19 needed after an
        unguarded version turned a closed store's lift into Infinity."""
        return (self.units_since / self.open_days_since
                if self.open_days_since > 0 else 0.0)

    @property
    def recovery_ratio(self) -> float:
        """Realised over promised. 1.0 means exactly on the old rate; above
        means the recovery is happening. Returns 1.0 when there is no baseline
        to compare against, which withholds judgement rather than inventing a
        verdict."""
        return (self.realised_rate / self.baseline_rate
                if self.baseline_rate > 0 else 1.0)


@dataclass(frozen=True, slots=True)
class Retirement:
    """Whether to stop showing a card, and the reason in words."""

    retire: bool
    reason: str | None
    #: DISPLAY and AUDIT. Which rule fired, for counting them later.
    rule: str | None
    recovery_ratio: float
    open_days_since: int
    #: For `declining` only: the lower-tail probability the rule fired on and
    #: the count model it was computed under. "poisson_unmeasured_dispersion"
    #: names the fallback, so a reader can tell a tail computed from the SKU's
    #: own scatter from one computed because no scatter was available.
    tail_probability: float | None = None
    distribution: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {"retire": self.retire, "reason": self.reason, "rule": self.rule,
                "recovery_ratio": self.recovery_ratio,
                "open_days_since": self.open_days_since,
                "tail_probability": self.tail_probability,
                "distribution": self.distribution}


@dataclass(frozen=True, slots=True)
class CardRetirement:
    """A retirement DECIDED this morning, in the shape Node persists.

    One per retired SKU per run. `retired_at` is the run's `as_of`, never a
    clock read; `suppressed_until` is the projected calendar date from
    `suppression_end_date`, stored so the next morning honours it rather than
    computing a fresh "today + 14".
    """

    sku: str
    retired_at: date
    suppressed_until: date
    rule: str
    reason: str | None
    first_issued: date
    open_days_since: int
    recovery_ratio: float
    tail_probability: float | None = None
    distribution: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "sku": self.sku,
            "retired_at": self.retired_at.isoformat(),
            "suppressed_until": self.suppressed_until.isoformat(),
            "rule": self.rule,
            "reason": self.reason,
            "first_issued": self.first_issued.isoformat(),
            "open_days_since": self.open_days_since,
            "recovery_ratio": self.recovery_ratio,
            "tail_probability": self.tail_probability,
            "distribution": self.distribution,
        }


#: The distribution label when no dispersion was measured. A Poisson tail on
#: a SKU that is in fact erratic UNDERSTATES how ordinary a quiet spell is,
#: so a retirement made under it is a weaker claim and is labelled as one.
POISSON_UNMEASURED = "poisson_unmeasured_dispersion"


#: The rules that test whether a RECOVERY happened. Both ask "is the product
#: selling again at the rate that justified the card" - a question only a
#: card that predicted a recovery can be asked.
RECOVERY_RULES = frozenset({"declining", "no_recovery"})

#: Card kinds that predict NO recovery. A markdown says "you are holding four
#: months of this; clear it" - sales staying flat is its premise, not its
#: failure. Measured at Bethany, 20 October: two overstock SKUs holding $1,150
#: and $774 of capital, each issued as a card, each retired under
#: `no_recovery` with the text "the recovery this card predicted has not
#: started", each then suppressed for seventeen days. The card predicted
#: nothing of the kind.
#: `liquidate` is the same premise by name. Bethany's retirement table, read on
#: 20 October: `no_recovery` had retired 2 markdown SKUs, 1 liquidation - and
#: 2 pre_stock and 1 bundle, which are NOT exempted here because what those
#: two families claim has not been examined; widening an exemption on a hunch
#: is how a rule stops meaning anything.
DISCOUNT_ACTIONS = frozenset({"markdown", "liquidate"})


def review_card(
    history: CardHistory, ctx: RunContext, config: ConfigRegistry = cfg
) -> Retirement:
    """Should this card still be on the screen this morning?

    Pure arithmetic on what the product did. No clock read - the caller's
    `history` is built against `ctx.as_of`, which is what makes a decision
    replayable months later.
    """
    review_days = int(config.get(CARD_REVIEW_OPEN_DAYS, ctx))
    max_days = int(config.get(CARD_MAX_OPEN_DAYS, ctx))
    tail_floor = float(config.get(DECLINE_TAIL_PROBABILITY, ctx))
    min_days = int(config.get(MIN_OPEN_DAYS_TO_JUDGE, ctx))

    ratio = history.recovery_ratio
    seen = history.open_days_since
    keep = Retirement(False, None, None, ratio, seen)

    # ── WHAT THE OWNER DID COMES BEFORE WHAT THE PRODUCT DID ───────────────
    #
    # These two rules run first because they are not predictions. Every rule
    # below asks whether the CLAIM is holding up, which is a question about the
    # product; these ask whether the ADVICE has already been dealt with, which is
    # a question about the card. A card the owner ordered on Monday is not a
    # better or worse forecast on Tuesday - it is finished, and repeating it is
    # how a slate comes to feel like furniture.
    #
    # Neither is a judgement on the recommendation. `acted_on` retires a card
    # that WORKED, and the suppression that follows is the gap in which the order
    # lands and sells; the claim can be re-earned afterwards on fresh evidence.
    if history.accepted:
        return Retirement(
            True,
            ("You ordered this, so the card has done its job. It will come back "
             "only if the product needs ordering again."),
            "acted_on", ratio, seen,
        )
    if history.dismissed:
        return Retirement(
            True,
            ("You dismissed this. The same claim will not be made again from "
             "the same evidence."),
            "dismissed", ratio, seen,
        )

    # ── A MARKDOWN IS NEVER JUDGED ON RECOVERY ────────────────────────────
    #
    # Rules 1 and 2 below ask whether the product is selling again at the rate
    # that justified the card. A reorder card made that claim. A markdown made
    # the opposite one - it exists BECAUSE the product is not moving - so for
    # it, "sales still at or below the old rate" is the premise holding, not
    # the claim failing. Judged by rules 1 and 2, every markdown retires on
    # schedule and its SKU is then suppressed, which is how a store with
    # fifteen overstock lines came to show ten reorders and no markdown.
    #
    # What a markdown CAN be retired for: the owner acting or dismissing
    # (above - those are about the card, not the product) and going stale
    # (here - the case re-made on current evidence rather than assumed). The
    # honest product-side test for a markdown is whether the STOCK moved, and
    # nothing in this function measures stock, so nothing here pretends to.
    #
    # None is an absence, not "reorder": an unknown kind keeps every rule it
    # always had, so legacy rows change nothing.
    if history.action_type in DISCOUNT_ACTIONS:
        if seen >= max_days:
            return Retirement(
                True,
                f"This markdown has been up for {seen} open days. Retiring it "
                f"so the case for clearing this stock can be re-made on "
                f"current evidence rather than assumed.",
                "stale", ratio, seen)
        return keep

    # Too early to say anything. Withholding judgement is a decision, and it is
    # the right one here: one quiet basket is not evidence of a failed recovery.
    if seen < min_days:
        return keep

    # 1. DECLINING - fires EARLY, which is the entire point.
    #
    # A TAIL PROBABILITY, not a ratio. The question is "if this product were
    # still selling at the rate that justified the card, how often would it
    # have sold this few?" - P(X <= units_since) with mean baseline x open
    # days. A ratio of 0.67 at three days sounds decisive and is a 42% event
    # under Poisson(3); the ratio was retiring right cards on noise.
    #
    # No baseline means no expected count and no test: the rule withholds,
    # exactly as `recovery_ratio` does, rather than inventing a verdict.
    expected = history.baseline_rate * seen
    if expected > 0.0:
        if history.dispersion_cv is None:
            # EXPLICIT fallback, and labelled. Absence of a measured cv is not
            # a cv of zero; it is the Poisson tail stated as the weaker claim
            # it is. Never silently defaulted, because zero dispersion is the
            # narrowest count model there is and would make this rule most
            # eager on exactly the SKUs it knows least about.
            tail = lower_tail_probability(
                history.units_since, mean=expected, dispersion_cv=0.0)
            model = POISSON_UNMEASURED
            model_note = "assuming Poisson counts; no dispersion measured"
        else:
            tail = lower_tail_probability(
                history.units_since, mean=expected,
                dispersion_cv=history.dispersion_cv)
            model = tail.distribution
            model_note = (
                "under this product's own measured scatter"
                if tail.distribution == "negative_binomial"
                else "with a measured dispersion of zero, so Poisson")
        if tail.probability < tail_floor:
            return Retirement(
                True,
                f"Sales since this card went up are running at "
                f"{ratio * 100:.0f}% of the rate that justified it: "
                f"{history.units_since:.0f} units in {seen} open days against "
                f"about {expected:.1f} expected. If the product were still "
                f"selling at that rate, this few would happen "
                f"{tail.probability * 100:.0f}% of the time ({model_note}). "
                f"This is not a dip reversing - it is still falling.",
                "declining", ratio, seen,
                tail_probability=tail.probability, distribution=model)

    # 2. NO RECOVERY by the end of the review window.
    if seen >= review_days and ratio <= 1.0:
        return Retirement(
            True,
            f"{seen} open days on and sales are still at "
            f"{ratio * 100:.0f}% of the old rate. The recovery this card "
            f"predicted has not started.",
            "no_recovery", ratio, seen)

    # 3. STALE regardless of outcome.
    if seen >= max_days:
        return Retirement(
            True,
            f"This card has been up for {seen} open days. Retiring it so the "
            f"claim can be re-made on current evidence rather than assumed.",
            "stale", ratio, seen)

    return keep


def suppressed_until(
    retired_on_open_day: int, ctx: RunContext, config: ConfigRegistry = cfg
) -> int:
    """The open-day index at which a retired claim may be made again.

    Takes and returns an INDEX into the store's open days rather than a date,
    because "fourteen open days later" is not fourteen calendar days later for
    a store that shuts on Sundays and holidays - and sheet 03's whole rule is
    that open days are the denominator.
    """
    return retired_on_open_day + int(config.get(RETIRE_SUPPRESS_OPEN_DAYS, ctx))


def suppression_end_date(
    retired_on: date,
    open_days_per_calendar_day: float,
    ctx: RunContext,
    config: ConfigRegistry = cfg,
) -> date:
    """The calendar date on which a claim retired today may be made again.

    THE DATE THAT GETS STORED. `suppressed_until` answers in open-day indices,
    which is the right unit and cannot be persisted: tomorrow's trading
    calendar has one more entry and the index means something else. Node
    needs a date it can write once and hand back, and a reader with no
    trading calendar - the UI, an audit query - needs one it can compare
    against today.

    But fourteen open days from now is not a date anyone knows yet, because
    the days the store will be open are in the future. So this is a
    PROJECTION from the store's own trailing open-day density, the same
    estimator the forward horizon already uses (`horizon_open_days` on a
    card): a store open 24 of the last 28 days is projected to reach 14 open
    days in 17 calendar days, a seven-day store in 14. Rounded UP, because
    the error that matters is a card coming back early, not late.

    The route then honours the stored date by converting it back to an index
    against the calendar it has that morning, which by then is history and
    exact.
    """
    window = int(config.get(RETIRE_SUPPRESS_OPEN_DAYS, ctx))
    # A density outside (0, 1] is a caller error rather than a store: the
    # route refuses to select at all when no open days arrived. Clamp to one
    # (every calendar day open), which projects the SHORTEST window - the
    # honest reading of "I was told nothing usable about this store's week".
    density = (open_days_per_calendar_day
               if 0.0 < open_days_per_calendar_day <= 1.0 else 1.0)
    return retired_on + timedelta(days=int(math.ceil(window / density)))


__all__ = [
    "CARD_MAX_OPEN_DAYS",
    "CARD_REVIEW_OPEN_DAYS",
    "DECLINE_TAIL_PROBABILITY",
    "MIN_CANDIDATE_POOL",
    "MIN_OPEN_DAYS_TO_JUDGE",
    "POISSON_UNMEASURED",
    "RETIRE_SUPPRESS_OPEN_DAYS",
    "CardHistory",
    "CardRetirement",
    "Retirement",
    "review_card",
    "suppressed_until",
    "suppression_end_date",
]
