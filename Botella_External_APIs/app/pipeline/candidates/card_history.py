"""Assemble `CardHistory` for the lifecycle screen from what Node can supply.

WHAT THE LIFECYCLE SCREEN WAS WAITING FOR
    `candidates/lifecycle.py` has been complete and tested for weeks and has done
    nothing, because `choose()` accepts `card_history` and no caller ever sent
    any. In the meantime production showed one store the same product
    **fifteen times**, and four more products twelve to fifteen times each:

        088110151058   shown 15x   first issued 2026-09-23
        854493005710   shown 15x   first issued 2026-09-29
        088004063849   shown 15x   first issued 2026-09-29
        080432500149   shown 12x   first issued 2026-09-09

    Each morning recomputed the same depressed window with no idea it had already
    said this, or that the claim was visibly failing. That is the exact defect
    lifecycle.py was written for, and it is why Stroyski 1.75L was recommended on
    eight consecutive trading days and missed every one.

THE SPLIT OF WORK, AND WHY IT IS THIS WAY
    Node owns what it has written down - when a card was first issued, how many
    times it has been shown, and the engine rate that justified the FIRST one.
    Python owns what it can measure from the sales it already holds - what has
    sold since, over how many OPEN days.

    Nothing new is fetched for the second half. The sales window the selector
    already reads is the same series, so `units_since` cannot disagree with the
    rate the card was built from.

BASELINE RATE IS THE ISSUE-TIME RATE, AND ABSENCE SKIPS THE SKU
    The lifecycle divides realised rate BY `baseline_rate`, so handing it today's
    rate would compare a card against a claim it never made. Node returns the
    rate attached to the FIRST card for that SKU, and `None` for rows that predate
    the column - 34 of 49 SKUs at the first store checked.

    A SKU with no baseline rate is SKIPPED, not defaulted. A default of zero makes
    `realised_rate / baseline_rate` either a divide-by-zero or an infinite
    recovery ratio, and either one would retire or rescue a card on no evidence.

OPEN DAYS, NEVER CALENDAR DAYS
    `open_days_since` counts trading days between first issue and today. A store
    shut on Sundays reaches a 14-open-day suppression later than a calendar count
    implies, and the suppression window is the whole mechanism - getting its
    denominator wrong makes a card come back a fortnight early.

WHAT THE OWNER DID, AND WHAT WAS ALREADY DECIDED (checklist 17)
    Node's feed has carried `accepted`, `dismissed` and `last_action_on` since
    the owner-decision wiring (checklist 9), and a2ae0b8 dropped the plumbing
    for them on this side - so the selector was back to being unable to tell
    "ordered on day one" from "ignored for a month". Restored here, and the
    default when the feed does not carry them is False: not knowing whether the
    owner acted is never read as knowing that they did.

    The feed also now carries the latest STORED retirement for the SKU
    (`retired_at`, `suppressed_until`, `retirement_rule`, migration 034) -
    but ONLY while no fresher card has been issued since. A card written after
    the retirement is a new claim: Node then reports that card's own
    `first_issued` and `baseline_rate` and no retirement, so the route judges
    it on its own. With a retirement present, the figures describe the retired
    card and the route does not judge it again.

DISPERSION IS MEASURED BY THE CALLER, AS OF ISSUE
    The declining rule tests a tail probability under the SKU's own count
    model, which needs the SKU's dispersion. That is a property of the sales
    series the selector already holds, computed by the selector's own weekly
    bucketing; `assemble` takes it as a callback rather than re-deriving a
    second version of the bucketing here. None from the callback means NOT
    MEASURED, and the lifecycle falls back to Poisson explicitly and says so.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any, Callable, Mapping, Sequence

from app.pipeline.candidates.lifecycle import CardHistory

#: (sku, as_of) -> dispersion cv, or None when it cannot be measured.
DispersionOf = Callable[[str, date], float | None]


def _parse_date(raw: Any) -> date | None:
    """A date from a Node row, or None. Never raises - the feed is optional."""
    if raw is None or raw == "":
        return None
    if isinstance(raw, date):
        return raw
    try:
        return date.fromisoformat(str(raw)[:10])
    except ValueError:
        return None


@dataclass(frozen=True, slots=True)
class PriorCard:
    """One SKU's card history as NODE reports it. Python adds the rest."""

    sku: str
    first_issued: date
    times_shown: int
    #: `engine_daily_rate` on the FIRST card for this SKU. None for rows that
    #: predate the column; such a SKU is skipped rather than defaulted.
    baseline_rate: float | None
    #: The owner's decision, as Node recorded it. False when the feed does not
    #: carry the field, so a feed that predates it behaves exactly as before.
    accepted: bool = False
    dismissed: bool = False
    last_action_on: date | None = None
    #: The latest STORED retirement for this SKU (migration 034). All None for
    #: a feed that predates it.
    retired_at: date | None = None
    suppressed_until: date | None = None
    retirement_rule: str | None = None
    #: Node's `action_type` for the card. None where the feed predates the
    #: column - an absence, which the lifecycle treats as "unknown kind" and
    #: never as "reorder".
    action_type: str | None = None

    @classmethod
    def from_row(cls, row: Mapping[str, Any]) -> "PriorCard | None":
        """Parse one Node row, or None when it cannot be used.

        Returns None rather than raising: a malformed row in an optional feed
        must never sink a run, and the count of skipped rows is what the caller
        logs.
        """
        sku = str(row.get("sku") or "").strip()
        raw_date = row.get("first_issued")
        if not sku or not raw_date:
            return None
        issued = _parse_date(raw_date)
        if issued is None:
            return None
        rate = row.get("baseline_rate")
        try:
            baseline = None if rate is None else float(rate)
        except (TypeError, ValueError):
            baseline = None
        try:
            shown = int(row.get("times_shown") or 1)
        except (TypeError, ValueError):
            shown = 1
        rule = row.get("retirement_rule")
        kind = row.get("action_type")
        return cls(
            sku=sku, first_issued=issued, times_shown=max(1, shown),
            baseline_rate=baseline,
            # `is True`, not truthiness: a feed that sends "false" as a string
            # must not read as acceptance.
            accepted=row.get("accepted") is True,
            dismissed=row.get("dismissed") is True,
            last_action_on=_parse_date(row.get("last_action_on")),
            retired_at=_parse_date(row.get("retired_at")),
            suppressed_until=_parse_date(row.get("suppressed_until")),
            retirement_rule=(str(rule).strip() or None) if rule else None,
            action_type=(str(kind).strip() or None) if kind else None,
        )


def assemble(
    prior: Sequence[PriorCard],
    *,
    daily_by_sku: Mapping[str, Mapping[date, float]],
    trading_days: Sequence[date],
    as_of: date,
    dispersion_of: DispersionOf | None = None,
) -> tuple[tuple[CardHistory, ...], dict[str, int]]:
    """Build `CardHistory` for every SKU that can carry one.

    Returns the histories and a count of each reason a SKU was skipped, so the
    caller can log why a store with 49 prior SKUs produced 15 histories instead
    of silently appearing to have none.

    `dispersion_of(sku, first_issued)` supplies the SKU's measured scatter as
    of the day the card went up; None (or no callback at all) leaves
    `dispersion_cv` unmeasured, and the lifecycle says so when it judges.
    """
    skipped: dict[str, int] = {}

    def skip(reason: str) -> None:
        skipped[reason] = skipped.get(reason, 0) + 1

    out: list[CardHistory] = []
    for card in prior:
        if card.baseline_rate is None:
            # Absence, not zero. A zero baseline makes the recovery ratio either
            # a divide-by-zero or infinite, and either retires or rescues a card
            # on no evidence at all.
            skip("no_baseline_rate")
            continue
        if card.baseline_rate <= 0.0:
            skip("baseline_rate_not_positive")
            continue
        if card.first_issued > as_of:
            skip("issued_in_the_future")
            continue

        # OPEN days, never calendar days. The suppression window is counted in
        # them, and a store shut on Sundays reaches 14 open days later than a
        # calendar count implies.
        open_days = sum(1 for d in trading_days if card.first_issued < d <= as_of)
        units = sum(u for d, u in (daily_by_sku.get(card.sku) or {}).items()
                    if card.first_issued < d <= as_of)
        cv = dispersion_of(card.sku, card.first_issued) if dispersion_of else None
        out.append(CardHistory(
            sku=card.sku,
            first_issued=card.first_issued,
            baseline_rate=card.baseline_rate,
            units_since=float(units),
            open_days_since=int(open_days),
            accepted=card.accepted,
            dismissed=card.dismissed,
            dispersion_cv=(None if cv is None or cv < 0.0 else float(cv)),
            retired_at=card.retired_at,
            suppressed_until=card.suppressed_until,
            retirement_rule=card.retirement_rule,
            action_type=card.action_type,
        ))
    return tuple(out), skipped


def from_rows(
    rows: Sequence[Mapping[str, Any]],
    *,
    daily_by_sku: Mapping[str, Mapping[date, float]],
    trading_days: Sequence[date],
    as_of: date,
    dispersion_of: DispersionOf | None = None,
) -> tuple[tuple[CardHistory, ...], dict[str, int]]:
    """Node rows straight through to `CardHistory`. The caller's one entry point."""
    parsed: list[PriorCard] = []
    skipped: dict[str, int] = {}
    for row in rows:
        card = PriorCard.from_row(row)
        if card is None:
            skipped["unparseable_row"] = skipped.get("unparseable_row", 0) + 1
            continue
        parsed.append(card)
    histories, more = assemble(
        parsed, daily_by_sku=daily_by_sku, trading_days=trading_days, as_of=as_of,
        dispersion_of=dispersion_of)
    for reason, count in more.items():
        skipped[reason] = skipped.get(reason, 0) + count
    return histories, skipped


__all__ = ["DispersionOf", "PriorCard", "assemble", "from_rows"]
