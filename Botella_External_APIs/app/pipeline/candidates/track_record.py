"""Suppress a SKU whose own past cards lost, and let the slate BACKFILL.

WHY SUPPRESSION ALONE IS NOT ENOUGH, AND THE ARITHMETIC THAT SHOWS IT
    Blocking SKUs with a losing record raises the pooled hit rate by about five
    points. It also cuts total net margin by 17-24%, because a suppressed card is
    both a miss removed and a card that would have earned something. Measured on
    March 2026 across five stores:

        hit rate  76.3% -> 81.2%     total net  $12,162 -> $10,151
        net per card rises at four of five stores; Northlake $6.48 -> $13.88

    Accuracy up and profit down is not a win, and no choice of blocking rule
    escapes it: removing cards removes earnings. The two can only rise together if
    the suppressed slot is FILLED by the next-best candidate, which is why this
    module is a screen inside selection rather than a filter after it.

    The slate has the room. Stores show 2.3 to 6.0 cards against a ten-slot slate,
    so a suppressed SKU does not cost the owner a recommendation - it costs the
    worst recommendation and buys the next one in the ranking.

ONLY OUTCOMES KNOWN BEFORE THE DECISION DATE
    This is the whole discipline of the module, and getting it wrong produced a
    result that looked spectacular and was worthless. Keying on "the first card
    for this SKU missed" scored 75.9% -> 88.0%, +12.1 points - using a 30-day
    outcome that is not known the next morning when the repeat is issued. The
    entire gain was look-ahead.

    Re-measured honestly, with only what today knows, the same idea is worth +0.1
    points and is negative at three of five stores.

    So every record here carries `known_on`, and `usable_on` refuses any outcome
    not yet scored at the decision date. A caller that passes unfiltered history
    gets the same refusal rather than a flattering number.

MONEY OR HIT RATE: BOTH ARE OFFERED, NEITHER IS ASSUMED
    Blocking on a losing MONEY record and blocking on a losing HIT record give
    different answers - Bethany gains 6.8 points on money and loses 0.8 on hits,
    Mango Jo's the reverse. Which one serves a store is an empirical question per
    estate, so the basis is a Setting and the refusal names which one fired.

A STORE'S OWN HISTORY, NEVER A COHORT'S
    A SKU that lost money at one store is not thereby a bad SKU. This screen is
    about THIS store's record with THIS product, which is also why it needs so
    little data to be useful: two cards is enough to notice a pattern worth acting
    on, and `MIN_PRIOR_CARDS` says why that floor is where it is.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any, Literal, Sequence

from app.pipeline.context import RunContext
from app.pipeline.registry import ConfigRegistry, Setting, cfg

MIN_PRIOR_CARDS = Setting(
    name="track_record.min_prior_cards",
    default=2,
    unit="scored cards for the same SKU before its record may block it",
    owner="commercial",
    why="provisional. ONE losing card is a coin landing: a SKU selling ten units "
        "a month falls below its own mean about a third of the time on Poisson "
        "noise alone, so blocking on a single miss would suppress a third of a "
        "healthy catalogue. Two is the smallest number that can show a PATTERN, "
        "and it is deliberately low because the screen backfills - a wrongly "
        "blocked SKU costs the slate nothing, while a wrongly kept one costs the "
        "owner a card. It becomes MEASURED when the blocked set has been followed "
        "for a season and the false-block rate is known",
    status="PROVISIONAL",
)

TRACK_RECORD_BASIS = Setting(
    name="track_record.basis",
    default="money",
    unit="'money' or 'hits' - which record blocks a SKU",
    owner="commercial",
    why="provisional, and 'money' because that is what the owner banks. The two "
        "bases genuinely disagree: on money Bethany gains 6.8 points of hit rate "
        "and Mango Jo's loses $2.7k of total margin; on hits the ordering "
        "reverses. Neither dominates, so this is a declared choice rather than a "
        "discovered fact, and the card names which basis blocked it. It becomes "
        "MEASURED when both have been run as a live holdout",
    status="PROVISIONAL",
)

MAX_BLOCKED_SHARE = Setting(
    name="track_record.max_blocked_share",
    default=0.35,
    unit="fraction of a store's candidates this screen may block, 0..1",
    owner="commercial",
    why="provisional guard, not a tuning knob. A screen that blocks most of a "
        "catalogue has stopped being a screen and become a different engine, and "
        "the failure would be silent - the slate would simply fill with weaker "
        "candidates while every report still showed a healthy hit rate. At the "
        "measured rates this screen blocks 8-10 SKUs a store, far below the cap, "
        "so hitting it means the prior window is unrepresentative rather than the "
        "catalogue being bad. The run is not failed; the screen stands down and "
        "says so",
    status="PROVISIONAL",
)


@dataclass(frozen=True, slots=True)
class CardOutcome:
    """One past card for one SKU, and the date its outcome became KNOWN.

    `known_on` is not the decision date - it is the decision date plus the
    scoring horizon. A card issued on 2 March with a 30-day window is not
    evidence until 1 April, and treating it as evidence on 3 March is the
    look-ahead that made an earlier version of this screen look twice as good as
    it is.
    """

    sku: str
    issued_on: date
    known_on: date
    hit: bool
    #: Net margin: margin impact less the holding cost of what did not sell.
    #: None when the SKU carries no unit cost, which is a real absence - five of
    #: ten audited stores send none - and such a card cannot inform a money
    #: record, though it still informs a hit record.
    net_margin: float | None

    def usable_on(self, as_of: date) -> bool:
        """Was this outcome known by `as_of`? The only question that matters."""
        return self.known_on <= as_of


@dataclass(frozen=True, slots=True)
class Record:
    """One SKU's track record at one store, as of one date."""

    sku: str
    cards: int
    hits: int
    net_margin: float | None
    #: Cards that carried measurable money, which is NOT `cards`.
    priced_cards: int

    @property
    def hit_rate(self) -> float | None:
        return (self.hits / self.cards) if self.cards else None

    def as_dict(self) -> dict[str, Any]:
        return {"sku": self.sku, "cards": self.cards, "hits": self.hits,
                "net_margin": self.net_margin, "priced_cards": self.priced_cards,
                "hit_rate": self.hit_rate}


def records_as_of(
    outcomes: Sequence[CardOutcome], as_of: date
) -> dict[str, Record]:
    """Each SKU's record from outcomes KNOWN by `as_of`, and nothing later."""
    cards: dict[str, int] = {}
    hits: dict[str, int] = {}
    nets: dict[str, float] = {}
    priced: dict[str, int] = {}
    for outcome in outcomes:
        if not outcome.usable_on(as_of):
            continue        # not yet scored. not evidence.
        sku = outcome.sku
        cards[sku] = cards.get(sku, 0) + 1
        hits[sku] = hits.get(sku, 0) + (1 if outcome.hit else 0)
        if outcome.net_margin is not None:
            nets[sku] = nets.get(sku, 0.0) + outcome.net_margin
            priced[sku] = priced.get(sku, 0) + 1
    return {
        sku: Record(sku=sku, cards=count, hits=hits.get(sku, 0),
                    net_margin=nets.get(sku), priced_cards=priced.get(sku, 0))
        for sku, count in cards.items()
    }


def _blocks(record: Record, basis: str, minimum: int) -> str | None:
    """The reason this record blocks its SKU, or None."""
    if basis == "money":
        if record.priced_cards < minimum:
            return None
        if record.net_margin is not None and record.net_margin < 0.0:
            return (f"lost ${abs(record.net_margin):,.0f} across "
                    f"{record.priced_cards} previous cards")
        return None
    # "hits"
    if record.cards < minimum:
        return None
    rate = record.hit_rate
    if rate is not None and rate * 2 < 1.0:
        return (f"hit {record.hits} of {record.cards} previous cards, "
                f"below half")
    return None


@dataclass(frozen=True, slots=True)
class ScreenResult:
    """Which SKUs are blocked, why, and whether the screen stood down."""

    blocked: dict[str, str]
    basis: str
    considered: int
    #: True when the block share exceeded the cap and the screen declined to act.
    stood_down: bool = False
    stand_down_reason: str | None = None

    def allows(self, sku: str) -> bool:
        return sku not in self.blocked

    def reason_for(self, sku: str) -> str | None:
        return self.blocked.get(sku)

    def as_dict(self) -> dict[str, Any]:
        return {"blocked": dict(self.blocked), "basis": self.basis,
                "considered": self.considered, "stood_down": self.stood_down,
                "stand_down_reason": self.stand_down_reason,
                "blocked_count": len(self.blocked)}


def screen(
    outcomes: Sequence[CardOutcome],
    *,
    as_of: date,
    candidate_skus: Sequence[str],
    ctx: RunContext,
    config: ConfigRegistry = cfg,
    basis: Literal["money", "hits"] | None = None,
) -> ScreenResult:
    """Which candidate SKUs their own past forbids, as of `as_of`.

    `candidate_skus` is what the engine was about to consider, and it matters
    only for the stand-down cap: blocking eight SKUs out of forty is a screen,
    and blocking thirty is a different engine.
    """
    minimum = int(config.get(MIN_PRIOR_CARDS, ctx))
    chosen = basis or str(config.get(TRACK_RECORD_BASIS, ctx))
    cap = float(config.get(MAX_BLOCKED_SHARE, ctx))

    records = records_as_of(outcomes, as_of)
    candidates = list(dict.fromkeys(candidate_skus))
    blocked: dict[str, str] = {}
    for sku in candidates:
        record = records.get(sku)
        if record is None:
            continue        # no history is not a bad history
        reason = _blocks(record, chosen, minimum)
        if reason:
            blocked[sku] = f"{chosen}:{reason}"

    if candidates and len(blocked) / len(candidates) > cap:
        # The screen stands down rather than reshaping the catalogue. Reported,
        # because a screen that silently stops screening is worse than one that
        # never ran.
        return ScreenResult(
            blocked={}, basis=chosen, considered=len(candidates),
            stood_down=True,
            stand_down_reason=(
                f"would block {len(blocked)} of {len(candidates)} candidates, "
                f"over the {cap:.0%} cap - the prior window is not "
                f"representative"),
        )
    return ScreenResult(blocked=blocked, basis=chosen,
                        considered=len(candidates))


__all__ = [
    "MAX_BLOCKED_SHARE",
    "MIN_PRIOR_CARDS",
    "TRACK_RECORD_BASIS",
    "CardOutcome",
    "Record",
    "ScreenResult",
    "records_as_of",
    "screen",
]
