"""Output shapes: the recommendations and the run envelope returned to Node."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

# Allowed enums, kept in one place and reused by the LLM tool schema.
CATEGORIES = (
    "inventory_understock",
    "inventory_overstock",
    "weather",
    "calendar_sports",
    "news",
    "bundle",
    "new_arrival",
    "social_trending",
)

ACTION_TYPES = (
    "pre_stock",
    "endcap",
    "cold_box",
    "bundle",
    "markdown",
    "reorder",
    "liquidate",
    "promote",
    "stock_new",
)

# ── WHERE A CARD'S CONFIDENCE FIGURE CAME FROM: the closed vocabulary ────────
#
# `confidence` is one float, and the same float means four different things
# depending on who wrote it. Until this was closed, 352 cards in the analytics
# store carried no basis at all (the signal families and the LLM path never
# wrote one; the deterministic engine did), 33 carried the raw ranking score
# passed straight through, and nothing on the card said which. A reviewer
# reading "0.44" could not tell a measured hit rate from a shrinkage weight.
#
# The names, and what each one is a statement about:
#
#   raw_ranking_score       the deterministic engine's p_hit = s/(1+s), where
#                           s = uplift x steadiness. An ORDERING signal that is
#                           structurally confined to about [0.50, 0.70]; it has
#                           never been shown to be a probability of anything.
#                           Also what a card gets when a curve exists but has no
#                           fit for its cell (the identity transform): the value
#                           shown is the raw score, so the label says so.
#   isotonic                a fitted curve mapped the raw score onto an observed
#                           hit rate AND the curve has more than one level AND
#                           the finished slate shows more than one value. The
#                           only basis on which a confidence floor is defensible.
#   isotonic_constant       a fitted curve with one level: the store's base
#                           rate, identical on every card. Correct, and not
#                           card-specific.
#   *_flat_slate            the curve had levels but every card in THIS slate
#                           landed on the same one (run 294: eight of nine cards
#                           at 0.444). Appended by the run-level pass.
#   family_evidence_count   families.confidence_from_evidence: n / (n + k) over
#                           the evidence the signal family holds (baskets,
#                           occurrences, stores). Rises with evidence; not a
#                           probability.
#   llm_stated              the model wrote the number. The superseded path, kept
#                           labelled so a card from it can never be mistaken for
#                           a measured one.
#   not_recorded            nothing upstream said. The validator stamps this with
#                           a warning rather than dropping the card: refusing a
#                           card over a missing label would hide advice the
#                           store could act on, and the label is exactly what
#                           tells a reader to discount the figure.
#
# Closed on purpose. A Literal rather than `str` means a misspelled or invented
# basis fails validation at the boundary instead of travelling to a card as a
# fifth meaning nobody declared. Node mirrors this list in
# backend/lib/confidenceBasis.js; the two are kept in step by hand and by the
# verify suite there.
CONFIDENCE_BASES = (
    "raw_ranking_score",
    "isotonic",
    "isotonic_constant",
    "isotonic_flat_slate",
    "isotonic_constant_flat_slate",
    "family_evidence_count",
    "llm_stated",
    "not_recorded",
)

#: The bases on which the figure is a calibrated probability that differs
#: between cards. A confidence FLOOR is only meaningful on one of these: a floor
#: on a raw ranking score filters on a number that was never a probability, and
#: a floor on a constant admits or refuses the whole slate at once.
DISCRIMINATING_CALIBRATED_BASES = ("isotonic",)

#: What the validator writes when a card arrives without a basis.
BASIS_NOT_RECORDED = "not_recorded"

ConfidenceBasis = Literal[
    "raw_ranking_score",
    "isotonic",
    "isotonic_constant",
    "isotonic_flat_slate",
    "isotonic_constant_flat_slate",
    "family_evidence_count",
    "llm_stated",
    "not_recorded",
]


class Recommendation(BaseModel):
    rank: int
    category: str
    action_type: str
    primary_skus: list[str]
    quantity_hint: str | None = None
    rationale: str
    #: What this card's TEXT actually names. Stays empty on a reorder card, which
    #: consults no external signal - see `signal_impact` for what was examined.
    signals_cited: list[str] = []
    #: WHAT EACH LIVE SIGNAL WAS FOUND TO DO TO THIS PRODUCT TYPE, HERE.
    #:
    #: Declared, and not left to `extra`, because this model's `extra="ignore"`
    #: has already silently deleted twenty-four computed decision figures once
    #: (migration 028). An undeclared field does not arrive late, it arrives
    #: never, and the unit tests stay green because they assert on the dict the
    #: card builder returns - one layer above the boundary that drops it.
    #:
    #: One entry per signal live at the store today, each either `measured` with
    #: a beta and its interval, or `not_measurable`/`not_fitted` with the NAMED
    #: reason. A refused entry carries beta null and never 0.0: the commonest
    #: reason is that the event has not happened often enough to measure at all,
    #: which is a different fact from an effect measured and found to be nothing.
    signal_impact: list[dict] = []
    #: The same block in one sentence, so a surface that shows no detail still
    #: cannot show silence.
    signal_impact_summary: str | None = None
    confidence: float = Field(ge=0.0, le=1.0)
    valid_through: str
    # For SKU-less stock_new picks only: the area winner's UPC, stamped by the
    # validator so Node's effectiveness evaluator can later detect "the store
    # started carrying it". None for every other recommendation.
    reference_upc: str | None = None
    # Canonical reorder size from the shared demand engine, stamped by the
    # validator on reorder/pre_stock picks whose SKU has one. The same number
    # the Store Intelligence Buying tab prints for that SKU — persist it so
    # downstream surfaces can render the figure without parsing the hint text.
    suggested_order_qty: int | None = None
    # Measured at decision time by the deterministic engine. None on the LLM
    # path, where no such figure exists - unknown, never zero.
    engine_daily_rate: float | None = None
    engine_days_cover: float | None = None
    engine_on_hand: float | None = None
    # The engine's own family for the card - "stockout", "recovering" or
    # "overstock". Stockout and recovering both ship as reorder cards, and only
    # the stockout one claims "it runs out before the next delivery", which the
    # evaluator grades on sell-through rather than lift. None on the LLM path.
    engine_family: str | None = None
    # THE DAY TO ORDER BY, decided by the engine and persisted (migration 042),
    # so every surface that shows this card shows one date. Until this field
    # the card's deadline was browser arithmetic on engine_days_cover with a
    # hard-coded seven, Purchasing's was a different formula with a lead of
    # three, and the two disagreed in public on the same bottle. A local
    # YYYY-MM-DD string, never a datetime: see docs/DAILY-CAPTURE.md section 4.
    # None on a markdown card (nothing to order), on the LLM path, and where
    # stock was unknown at decision time - absent, never today's date.
    order_by: str | None = None
    # The lead time that deadline rests on, and whether it was MEASURED from
    # this vendor's receipts or DECLARED (the seven the policy declares). The
    # same figure the stockout sentence quotes. None where order_by is None
    # for want of a card to order from (markdown, LLM path).
    lead_time_days: int | None = None
    lead_time_basis: Literal["measured", "declared"] | None = None

    # ── THE DECISION FIGURES, AND WHY THEY ARE DECLARED HERE ────────────────
    #
    # EVERY FIELD BELOW WAS BEING SILENTLY DISCARDED. This model sets no
    # `model_config`, so pydantic's default `extra="ignore"` applied:
    # `to_raw_recommendations` computed the gate verdict, the predictive range,
    # the promise floor, the holding cost, the calibration basis and the slate
    # budget, and `model_validate` dropped all of them on the floor. No warning,
    # no dropped_invalid, nothing in a log.
    #
    # The unit tests passed throughout, because they assert on the dict
    # `to_raw_recommendations` returns - one layer ABOVE the boundary that threw
    # it away. "Computed, tested, and never delivered" is the failure mode an
    # allow-list without a guard produces, and the guard is now
    # `tests/test_card_surface.py`, which asserts that every key the card builder
    # emits is a field this model declares.
    #
    # All None-by-default, and ABSENCE IS NOT ZERO throughout: a card from the
    # LLM path, or from a store with no cost data, legitimately has no figure
    # here, and a zero would read as a measured zero.

    # Sheet 17 - the store gate. `measured` is False when no verdict was
    # computed, which is an absence and not an instruction to withhold.
    gate_state: str | None = None
    gate_reason: str | None = None
    gate_displayed: bool | None = None
    gate_measured: bool | None = None

    # The two-sided predictive range, which is the claim the gate's coverage
    # check tests. `refused` carries the NAMED reason when no range was stated -
    # "no range" and "a range we declined to state, because X" are different
    # facts to a reader.
    expected_range_low: int | None = None
    expected_range_high: int | None = None
    expected_range_coverage: float | None = None
    expected_range_basis: str | None = None
    expected_range_refused: str | None = None

    # N1.1 - a floor on the TOTAL, which is the only form of the promise the
    # arithmetic permits. `increment_promise_basis` says why no INCREASE is
    # promised, with a figure in it.
    promise_floor_units: float | None = None
    promise_floor_coverage: float | None = None
    promise_floor_basis: str | None = None
    promise_floor_refused: str | None = None
    increment_promise_basis: str | None = None

    # N0.1 - what being wrong costs, in money. Absent on a markdown: that card
    # is not buying anything, so there is no unsold surplus to carry.
    holding_cost_if_unsold: float | None = None
    holding_cost_basis: str | None = None

    # Sheet 08 - `confidence` above is the CALIBRATED figure where a curve
    # exists. These two say which, and what the raw score was, because "0.65"
    # means a different thing in each case.
    #
    # REQUIRED, and drawn from the closed vocabulary above. Every emitter
    # (deterministic.to_raw_recommendations, families.to_raw, the LLM client's
    # extraction) writes one, and the validator stamps `not_recorded` on
    # anything that still arrives bare - so a card can reach this model without
    # a basis only through a path nobody has written. tests/test_confidence_basis.py
    # walks the emitters to keep that true.
    confidence_basis: ConfidenceBasis
    confidence_raw: float | None = None
    #: Distinct values the applied curve can return. 1 means `confidence` is the
    #: store's base rate and is IDENTICAL on every card of the run, so a surface
    #: must not render it as this card's own chance.
    confidence_levels: int | None = None
    confidence_discriminates: bool | None = None
    #: The sentence to show instead of a bare percentage when it does not.
    confidence_explain: str | None = None

    # N7.1 - the budget this slate was chosen under. Identical on every card of a
    # run, and on every card deliberately: a card is the unit that travels. One
    # gets voted on, screenshotted, forwarded and read six weeks later with no
    # run envelope attached, and a card that says it commits $340 of a $2,000
    # ASSUMED budget can be argued with.
    portfolio_cash_committed: float | None = None
    portfolio_cash_budget: float | None = None
    portfolio_units_committed: float | None = None
    portfolio_shelf_budget_units: float | None = None
    portfolio_coverage: int | None = None
    portfolio_offered: int | None = None
    #: "measured_replacement_cost" or "declared_default[:reason]". The budget was
    #: a flat $2,000 for every store in the estate and that was 4% of what these
    #: stores actually spend a cycle, so which of the two it is matters more than
    #: the number.
    portfolio_cash_budget_basis: str | None = None
    #: Declared, not measured, in words the owner can disagree with.
    portfolio_assumptions: list[str] = []

    # Sheets 15-16 - WHO WROTE THE BODY TEXT. "model" or "engine", and the
    # engine's own sentence is kept either way: a card that reads well and a card
    # you can audit are both required, and the second one is the engine's.
    #
    # `rationale_refused` names why a model attempt was thrown out - an
    # unaccounted numeral, a declined request, an over-long answer. A rejection
    # that leaves no trace is indistinguishable from never having tried.
    rationale_source: str | None = None
    rationale_engine: str | None = None
    rationale_refused: str | None = None


class RawSourcePayload(BaseModel):
    """One logical upstream fetch, raw, as received.

    Keyed by the GEOGRAPHY the response varies by rather than by store: an NWS
    gridpoint forecast is identical for every store on it, so Node stores one
    row per (source, geo, date) and a thousand stores reporting the same
    payload collapse to one upsert. ``payload`` holds every HTTP response the
    logical fetch made (weather alone makes four) under a ``requests`` list —
    they only mean anything together.
    """

    source: str
    geo_scope: str          # global | state | gridpoint | latlon | store
    geo_key: str
    fetch_date: str         # YYYY-MM-DD
    payload: dict | None = None
    item_count: int | None = None
    ok: bool = True
    http_status: int | None = None
    latency_ms: int | None = None
    error: str | None = None


class SignalCapture(BaseModel):
    """The full record of what the outside world said for this store today.

    ``signal_snapshot`` on the run is the owner-facing CHIP LIST — capped,
    trimmed for display, and useless as an engine input. This is the other
    thing: the complete bundle the engine actually reasoned over, which
    sources answered, and the raw bytes behind them. Node persists it to
    daily_store_signals / signal_source_payloads (analytics migration 014).

    Every field degrades: a Node deploy reading a response without this object
    stores the trimmed snapshot and marks it ``display_trimmed`` rather than
    pretending it has the full input.
    """

    # The complete, untrimmed SignalBundle (SignalBundle.model_dump()).
    bundle: dict
    # The STORE'S calendar date and how it was derived. A 04:00 UTC cron run
    # is the previous evening across the US, so a UTC key would misdate the
    # whole network by a day.
    signal_date: str
    day_basis: str = "utc"          # store_local | utc
    timezone: str | None = None     # IANA zone when day_basis == store_local

    # Per-source outcome: {source: {ok, items, latency_ms, cache_hit,
    # dormant, error}}. This is what makes an ABSENT signal legible.
    source_health: dict = {}
    # {source: {scope, key}} — the join back to the raw payload rows.
    source_geo_keys: dict = {}

    # Geography the signals were actually fetched for.
    latitude: float | None = None
    longitude: float | None = None
    state: str | None = None
    geo_source: str | None = None   # profile | geocoded | none

    raw_payloads: list[RawSourcePayload] = []


class EngineInfo(BaseModel):
    """Which engine produced a run, and what it cost.

    Persisted onto the day archive so a change in output can be attributed to
    a change in the engine rather than to the world.
    """

    version: str | None = None
    model: str | None = None
    prompt_version: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    latency_ms: int | None = None


class CardRetirement(BaseModel):
    """A card the lifecycle retired THIS run, for Node to store (migration 034).

    The route decides a retirement once and Node remembers it; the next
    morning's card-history feed hands `retired_at` and `suppressed_until` back
    and the route honours them instead of re-judging the same card and
    recomputing "today + 14". Without this round trip a suppression either
    rolled forever or ended the moment the rule stopped firing.
    """

    sku: str
    retired_at: date
    #: A PROJECTED calendar date - fourteen open days at the store's trailing
    #: open-day density - stored because an open-day index cannot be.
    suppressed_until: date
    rule: str
    reason: str | None = None
    first_issued: date | None = None
    open_days_since: int | None = None
    recovery_ratio: float | None = None
    #: For `declining`: the lower-tail probability it fired on and the count
    #: model it was computed under, so the retirement can be audited.
    tail_probability: float | None = None
    distribution: str | None = None


class RunResult(BaseModel):
    """Everything the Node side needs to persist a ``recommendation_runs`` row
    plus its child ``recommendations`` rows, and to surface them in the UI."""

    client_id: int
    location_id: int
    generated_at: datetime
    data_as_of: date
    candidate_count: int
    recommendations_generated: int
    dropped_invalid: int
    signal_snapshot: dict
    recommendations: list[Recommendation]
    # Additive (analytics migrations 014/015). Older Node deploys ignore both;
    # newer ones persist the day-grain signal cell and engine provenance.
    signal_capture: SignalCapture | None = None
    engine: EngineInfo | None = None
    # Additive (analytics migration 034). The claims the lifecycle retired this
    # morning, so Node can store the date and hand it back tomorrow. Empty is
    # the ordinary case; an older Node deploy ignores it.
    card_retirements: list[CardRetirement] = Field(default_factory=list)
