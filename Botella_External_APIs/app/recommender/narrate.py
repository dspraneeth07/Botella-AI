"""The model writes the sentence. The engine owns every number in it.

WHAT THIS FIXES, AND IT IS NOT WHAT IT LOOKED LIKE
    `pipeline.py` carries a comment saying "The model still writes the prose
    (sheets 15-16), after the decision is fixed". That is false on the
    deterministic path. The only `self._llm.recommend(...)` call lives in the
    `else` branch - the superseded arm that scored 24.2% - so on the path that
    actually ships, THE MODEL IS NEVER CALLED AT ALL. Not for choosing, which is
    correct and deliberate, and not for writing either, which was not.

    `app/pipeline/explain/` was built for exactly this job - render, prompt,
    template, precedent, plus a numeral verifier in `validate/explanation.py` -
    and nothing in `app/recommender/` imports any of it. So every card's prose is
    a hardcoded f-string:

        "Order more Hidden Stock 1.75ml - about 7 units above your recent run-rate"

    That is arithmetic read aloud. It is why the cards read mechanically to a
    store owner, and why an owner looking at a page that lists a home game, a
    heat advisory and four social trends sees none of them mentioned on any card.

LAW 1 IS NOT BEING RELAXED
    No model chooses anything. The products, the quantities, the ranking and the
    budget are all fixed before this module runs, and it cannot alter any of them.
    It receives a card that has already been decided and returns a better sentence
    about it, or nothing.

    That distinction is not cosmetic. The LLM-choosing arm scored 24.2% against
    the engine's 75.9%, and on 29 September 2026 an Anthropic billing failure
    produced zero recommendations for every store because the component that
    CHOSE could not be reached. Narration cannot do that: a failure here costs
    fluency and leaves the engine's own sentence in place.

THE GROUNDING RULE, WHICH IS THE WHOLE SAFETY ARGUMENT
    Every numeral the model writes must match a figure the engine computed, within
    a rounding tolerance that is itself a registry Setting. `unaccounted_numerals`
    is the check, and it is sheet 16's own implementation rather than a second
    one - the prompt, the template and the verifier share one definition of "a
    numeral" and one of "matches".

    A sentence carrying any unaccounted numeral is DISCARDED WHOLE. Not repaired,
    not partially accepted: a model that invented one figure has demonstrated it
    will invent, and the engine's sentence is right there. The reason is recorded
    on the card so a rejection is visible rather than silent.

WHAT IT MAY SAY ABOUT A SIGNAL, AND WHAT IT MAY NOT
    It may MENTION an active signal, because the owner can see it on the same
    page: "there is a Cowboys home game on Sunday" is a fact about the world that
    the engine fetched.

    It may NOT claim the signal moves sales. "Order more because of the game" is a
    causal claim, and 488 of 489 signal-category cells refused against
    day-of-week, month and trend controls - so for almost every signal the honest
    position is that we looked and the data cannot tell. The prompt forbids the
    causal form explicitly, and a quantified uplift would need a numeral, which
    the grounding rule would then reject for not being in the engine's figures.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Mapping, Sequence

from app.logging_config import get_logger
from app.pipeline.context import RunContext
from app.pipeline.explain.render import unaccounted_numerals
from app.pipeline.registry import ConfigRegistry, Setting, cfg

log = get_logger(__name__)

MAX_NARRATED_CARDS = Setting(
    name="narrate.max_cards_per_run",
    default=12,
    unit="cards narrated in one run",
    owner="engineering",
    why="a bound on cost and latency, not on quality. One call per card at ten "
        "cards a store over ninety stores is nine hundred calls a night, and the "
        "slate is capped near ten anyway - so this only ever bites if "
        "max_recommendations is raised a long way. Set it to zero to turn "
        "narration off entirely and keep the engine's own sentences, which is "
        "exactly the behaviour every card had before this module existed",
    status="PROVISIONAL",
)

MAX_NARRATED_CHARS = Setting(
    name="narrate.max_sentence_chars",
    default=320,
    unit="characters in a narrated card body",
    owner="commercial",
    why="a card is read on a phone between customers. The engine's own sentences "
        "run 120-260 characters, so this allows a little more room to mention a "
        "live signal without permitting a paragraph. Longer output is refused "
        "rather than truncated, because a sentence cut mid-clause can invert its "
        "own meaning",
    status="PROVISIONAL",
)

SYSTEM = """You rewrite one retail recommendation card for an independent liquor \
store owner who reads it on a phone between customers.

YOU ARE NOT DECIDING ANYTHING. The product, the quantity and the reason were \
computed before you were called. Your job is to say the same thing more clearly.

HARD RULES, and output that breaks one is discarded entirely:
1. Every number you write must be one of the FIGURES given below, copied as \
written. Do not compute, derive, round, convert or combine them. Do not invent a \
percentage, a date, a price or a count.
2. Do not claim a signal causes sales. You may mention that a signal is live \
("there is an NFL home game on Sunday") because the owner can see it. You may NOT \
say it will raise demand, by any amount, in any wording. That link has been \
measured for these stores and almost never holds.
3. Do not add advice the card does not contain. No pricing, no staffing, no \
promotion, no cross-sell that is not already in the figures.
4. One or two sentences. Plain words. No preamble, no sign-off, no markdown, no \
bullet points. Return only the sentence.
5. If you cannot write it within these rules, return exactly: SKIP"""


@dataclass(frozen=True, slots=True)
class Narration:
    """The sentence that will be shown, and why it is that one."""

    sentence: str
    #: "model" or "engine". The card carries this so a reader can tell which.
    source: str
    #: Why the model's attempt was not used, when it was not. Empty on success.
    refused: str = ""

    @property
    def narrated(self) -> bool:
        return self.source == "model"


def figures_for(card: Mapping[str, Any]) -> dict[str, float]:
    """Every number this card is allowed to contain.

    Taken off the card itself rather than recomputed, so the allow-list cannot
    disagree with what the engine published. A figure the card does not carry is
    not permitted in prose about the card, which is the point.
    """
    allowed: dict[str, float] = {}
    for key in (
        "suggested_order_qty", "engine_daily_rate", "engine_days_cover",
        "engine_on_hand", "expected_range_low", "expected_range_high",
        "promise_floor_units", "holding_cost_if_unsold", "confidence",
        "confidence_raw", "portfolio_cash_committed", "portfolio_cash_budget",
    ):
        value = card.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            allowed[key] = float(value)
    return allowed


def _day(value: Any) -> str:
    """An ISO signal date as a card would say it: 2026-10-09 -> "Oct 9".

    The signal clients return ISO. A model writing an owner-facing sentence
    writes "Oct 9", and then the numeral check sees a bare 9 that matches no
    ISO literal and discards the sentence. Rendering the date the way it will
    be written is what makes the literal and the prose the same string.

    Anything unparseable passes through untouched rather than being dropped: a
    date we cannot format is still a date the signal reported.
    """
    text = str(value or "").strip()
    if not text:
        return ""
    head = text[:10]
    try:
        parsed = datetime.strptime(head, "%Y-%m-%d").date()
    except ValueError:
        return text
    return f"{parsed.strftime('%b')} {parsed.day}"


def _status(key: str | None, effects: Any) -> str:
    """What is KNOWN about this signal's effect on sales at this store.

    The honest answer is almost always "nothing". 585 signal-family cells were
    fitted across the estate against day-of-week, month and trend controls and
    9 earn a citable effect; Bethany has none. Saying so on the line itself is
    what stops both readers - the model and the owner - from assuming a live
    signal is a reason to buy.
    """
    if not effects:
        return "no measured effect on sales here"
    hits = [eff for (k, _fam), eff in effects.items() if k == key]
    if not hits:
        return "no measured effect on sales here"
    best = max(hits, key=lambda e: abs(getattr(e, "beta", 0.0) or 0.0))
    beta = float(getattr(best, "beta", 0.0) or 0.0)
    return f"measured {beta:+.1%} on sales here"


def signal_lines(bundle: Any, effects: Any = None) -> tuple[str, ...]:
    """The signals live at this store, as labelled and dated phrases.

    WHY THE WRITEUP COULD NEVER MENTION A SIGNAL.

    The prompt has always passed `active_keys` - bare tokens like
    `nba_home_game`, `event_concert`, `trend_vodka`. The system prompt invites a
    mention ("there is an NFL home game on Sunday") and rule 1 forbids inventing
    a date, while `ground` discards the WHOLE sentence over any numeral the
    engine does not own. So a model that wrote "with the Mavericks at home on
    Oct 9" lost the sentence on the "9", and one that obeyed rule 1 had nothing
    concrete to say. An owner looking at ten live signals in the UI saw none of
    them on any card, which is what it looks like when a feature is wired at
    both ends and not in the middle.

    So this hands over what the signal clients actually fetched - team names,
    the event and its venue, the trending term and where it trended, the
    forecast - each with its own date. `signal_literals` then admits exactly
    those strings to the numeral check, so a date that came from ESPN survives
    and a number the model made up still does not.

    DESCRIPTIVE, NEVER CAUSAL. Every line names a thing that is happening. None
    of them says it moves demand, because at these stores that is measured and
    almost never holds - 585 signal-family cells fitted, 9 citable. The
    measured effects travel separately, in `signal_notes`.
    """
    if bundle is None:
        return ()
    out: list[str] = []

    weather = getattr(bundle, "weather", None)
    if weather is not None:
        summary = str(getattr(weather, "summary", "") or "").strip()
        when = _day(getattr(weather, "summary_date", None)
                   or getattr(weather, "date", None))
        if summary:
            out.append(f"weather: {summary}"
                       + (f" on {when}" if when else "")
                       + f" (forecast; {_status('weather', effects)})")

    for game in (getattr(bundle, "sports", None) or ()):
        home = str(getattr(game, "home", "") or "").strip()
        away = str(getattr(game, "away", "") or "").strip()
        when = _day(getattr(game, "date", None))
        league = str(getattr(game, "league", "") or "").strip()
        if home or away:
            label = f"{away} at {home}" if away and home else (home or away)
            key = getattr(game, "key", None) or (
                f"{league.lower()}_home_game" if league else "home_game")
            out.append(f"{league or 'game'}: {label}"
                       + (f" on {when}" if when else "")
                       + f" (schedule feed; {_status(key, effects)})")

    for event in (getattr(bundle, "events", None) or ()):
        name = str(getattr(event, "name", "") or "").strip()
        if not name:
            continue
        venue = str(getattr(event, "venue", "") or "").strip()
        when = _day(getattr(event, "date", None))
        near = getattr(event, "distance_mi", None)
        draw = getattr(event, "draw", None)
        detail = ", ".join(
            x for x in (
                f"{float(near):.0f} mi away" if isinstance(near, (int, float)) else "",
                f"{draw} draw" if draw else "",
                _status(getattr(event, "key", None) or "event_nearby", effects),
            ) if x)
        out.append(f"event: {name}"
                   + (f" at {venue}" if venue else "")
                   + (f" on {when}" if when else "")
                   + (f" ({detail})" if detail else ""))

    for holiday in (getattr(bundle, "holidays", None) or ()):
        name = str(getattr(holiday, "name", "") or "").strip()
        when = _day(getattr(holiday, "date", None))
        if name:
            out.append(f"holiday: {name}" + (f" on {when}" if when else "")
                       + f" (calendar; {_status(getattr(holiday, 'key', None) or 'holiday', effects)})")

    for trend in (getattr(bundle, "social", None) or ()):
        term = str(getattr(trend, "term", "") or "").strip()
        if not term:
            continue
        source = str(getattr(trend, "source", "") or "").strip()
        score = getattr(trend, "score", None)
        seen = getattr(trend, "mentions", None)
        detail = ", ".join(
            x for x in (
                f"rising {int(score)}" if isinstance(score, (int, float)) else "",
                f"{int(seen):,} mentions" if isinstance(seen, (int, float))
                and int(seen) > 1 else "",
                _status(f"trend_{term.lower()}", effects),
            ) if x)
        out.append(f"trending: {term}"
                   + (f" on {source}" if source else "")
                   + (f" ({detail})" if detail else ""))

    for item in (getattr(bundle, "news", None) or ()):
        headline = str(getattr(item, "headline", None)
                       or getattr(item, "title", "") or "").strip()
        if headline:
            src = str(getattr(item, "source", "") or "").strip()
            out.append(f"news: {headline}"
                       + (f" ({src}; " if src else " (")
                       + _status(getattr(item, "key", None) or "news", effects)
                       + ")")

    # Deduplicated, order preserved: two clients can report one game.
    seen: set[str] = set()
    unique = [ln for ln in out if not (ln in seen or seen.add(ln))]
    return tuple(unique)


def signal_literals(lines: Sequence[str]) -> tuple[str, ...]:
    """Digit-bearing fragments of the signal lines, for the numeral check.

    The whole line goes in, and so does every whitespace-delimited token in it
    that carries a digit - so "Oct 9", "89F" or a bare "9" survives when it came
    from a signal, while a figure that appears in no signal still does not. This
    is narrower than it looks: the token has to occur verbatim in what the
    signal clients returned.
    """
    out: list[str] = []
    for line in lines or ():
        text = str(line)
        out.append(text)
        tokens = text.replace(",", " ").split()
        for i, token in enumerate(tokens):
            if not any(ch.isdigit() for ch in token):
                continue
            clean = token.strip("()[]:;")
            out.append(clean)
            # The token WITH the word before it, so "Oct 9" is removed as one
            # phrase. Longest-first removal in the numeral check then takes the
            # 9 with the month rather than leaving it to be flagged.
            if i and tokens[i - 1].isalpha():
                out.append(f"{tokens[i - 1]} {clean}")
    seen: set[str] = set()
    return tuple(x for x in out if x and not (x in seen or seen.add(x)))


#: Words that appear in a signal line but identify nothing - matching on one of
#: these would credit a card for "mentioning" a signal because it used the word
#: "game". The label prefix is stripped before matching, so these are the words
#: left inside the payload itself.
_GENERIC_SIGNAL_WORDS = frozenset({
    "game", "event", "news", "trending", "weather", "holiday", "high", "low",
    "clear", "cloudy", "sunny", "mostly", "partly", "home", "away", "center",
    "centre", "arena", "stadium", "field", "park", "the", "and", "at", "on",
    "of", "in", "vs", "season",
})


def mentions(sentence: str, line: str) -> bool:
    """Does `sentence` actually refer to the signal described by `line`?

    Used to fill `signals_cited` from the sentence that was accepted rather than
    from everything that was live, so "cited" keeps meaning "this card refers to
    it". Matching is on the DISTINCTIVE words of the signal - a team, an event,
    a trending term - with the label prefix and the generic vocabulary removed,
    on word boundaries so "clear" cannot match "clearance".
    """
    if not sentence or not line:
        return False
    # The label prefix AND the parenthetical are dropped. The parenthetical
    # carries provenance and measured status - "schedule feed", "no measured
    # effect on sales here" - whose words are not identifying: without this, a
    # card that merely used the word "sales" would be recorded as citing every
    # signal at the store.
    payload = re.sub(r"\([^)]*\)", " ", str(line).split(":", 1)[-1])
    words = {w for w in re.findall(r"[A-Za-z][A-Za-z'&-]+", payload.lower())
             if len(w) >= 4 and w not in _GENERIC_SIGNAL_WORDS}
    if not words:
        return False
    low = sentence.lower()
    # Lookarounds rather than a word-boundary escape: a backslash in this
    # position has been silently eaten by a shell layer before now, and a
    # broken boundary makes every match fail open rather than loudly.
    return any(re.search("(?<![a-z])" + re.escape(w) + "(?![a-z])", low)
               for w in words)


def literals_for(card: Mapping[str, Any],
                 product_names: Mapping[str, str] | None = None,
                 signal_facts: Sequence[str] = ()) -> tuple[str, ...]:
    """Identifiers that contain digits but are not quantities.

    A UPC is thirteen digits and a product name carries its size - "Titos 1.75L",
    "Fireball 50 ml". Without these the verifier reads "1.75" as an unaccounted
    figure and throws away a perfectly good sentence for naming the bottle.

    `signal_facts` extends the same idea to the external signals: a date ESPN
    returned is a fact the engine holds, just not one of the card's FIGURES, and
    without it a sentence that names the game is discarded over its date.
    """
    out: list[str] = list(signal_facts or ())
    for sku in card.get("primary_skus") or ():
        out.append(str(sku))
        name = (product_names or {}).get(sku)
        if name:
            out.append(str(name))
    if card.get("valid_through"):
        out.append(str(card["valid_through"]))
    if card.get("reference_upc"):
        out.append(str(card["reference_upc"]))
    return tuple(out)


def build_user_prompt(
    card: Mapping[str, Any],
    *,
    store_name: str,
    product_names: Mapping[str, str] | None = None,
    active_signals: Sequence[str] = (),
    signal_notes: Sequence[str] = (),
    signal_facts: Sequence[str] = (),
) -> str:
    """What the model is told. Facts only, and the signals it may mention."""
    names = ", ".join(
        f"{sku} ({(product_names or {}).get(sku, 'name unknown')})"
        for sku in (card.get("primary_skus") or ())) or "none"
    figures = "\n".join(f"  {k} = {v:g}" for k, v in figures_for(card).items()) \
        or "  (none)"
    signals = ", ".join(active_signals) or "none active today"
    notes = "\n".join(f"  - {n}" for n in signal_notes) or "  (none)"
    facts = chr(10).join(f"  - {f}" for f in signal_facts) or "  (none)"
    return (
        f"STORE: {store_name}\n"
        f"ACTION: {card.get('action_type')}\n"
        f"PRODUCTS: {names}\n"
        f"WHAT THE ENGINE SAYS (rewrite this, do not contradict it):\n"
        f"  {card.get('rationale') or ''}\n"
        f"  {card.get('quantity_hint') or ''}\n"
        f"FIGURES you may use, copied exactly as written:\n{figures}\n"
        f"SIGNALS LIVE AT THIS STORE TODAY (you may mention, never claim they "
        f"raise demand): {signals}\n"
        f"THE SIGNALS IN FULL, with their own dates. You may quote any of "
        f"these VERBATIM, including the date, and a date copied from here is "
        f"NOT an invented one. Mention at most one, only where it is "
        f"genuinely relevant to this product, and never as a cause:"
        + chr(10) + facts + chr(10)
        +         f"WHAT HAS ACTUALLY BEEN MEASURED ABOUT THOSE SIGNALS HERE:\n{notes}\n"
        f"Write the card."
    )


def ground(
    sentence: str | None,
    card: Mapping[str, Any],
    ctx: RunContext,
    config: ConfigRegistry = cfg,
    *,
    product_names: Mapping[str, str] | None = None,
    signal_facts: Sequence[str] = (),
) -> Narration:
    """Accept the model's sentence only if the engine owns every number in it.

    Returns the engine's own sentence otherwise, with the reason. Never raises:
    a writing problem must not delete a correct recommendation.
    """
    fallback = str(card.get("rationale") or "")
    if sentence is None:
        return Narration(fallback, "engine", "model produced nothing")
    text = sentence.strip()
    if not text or text.upper().startswith("SKIP"):
        return Narration(fallback, "engine", "model declined")
    limit = int(config.get(MAX_NARRATED_CHARS, ctx))
    if len(text) > limit:
        # REFUSED, not truncated. A sentence cut mid-clause can invert its own
        # meaning, and "do not order" truncated at the comma is the worst
        # possible failure on a card about money.
        return Narration(fallback, "engine", f"too long:{len(text)}>{limit}")
    if "\n" in text:
        return Narration(fallback, "engine", "multi-line output")
    stray = unaccounted_numerals(
        text, figures_for(card), ctx, config,
        # The signals' own strings count as literals: a date ESPN returned is
        # a fact we hold, and without this a sentence naming the game is
        # thrown away over its date - which is why no card ever mentioned one.
        literals=literals_for(card, product_names, signal_facts),
    )
    if stray:
        # DISCARDED WHOLE. A model that invented one figure has shown it will
        # invent, and the engine's sentence is right there.
        return Narration(fallback, "engine",
                         f"unaccounted numerals:{','.join(stray[:4])}")
    return Narration(text, "model")


__all__ = [
    "MAX_NARRATED_CARDS",
    "mentions",
    "signal_lines",
    "signal_literals",
    "MAX_NARRATED_CHARS",
    "SYSTEM",
    "Narration",
    "build_user_prompt",
    "figures_for",
    "ground",
    "literals_for",
]
