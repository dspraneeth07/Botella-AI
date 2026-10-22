"""The hybrid slate: the engine's stock arithmetic, the model's signal picks.

WHY THIS EXISTS. The deterministic engine (``app/pipeline``, selected in
``pipeline.run``) chooses reorders and markdowns from the store's own sales and
measures 75.9% against a 31.9% random pick. It is the right tool for "what is
about to run out". It is a poor tool for everything else on the owner's
screen: its signal families (cold_box, pre_stock, bundle, stock_new, the event
playbook) each refuse unless a published fit has MEASURED the signal's effect
at this store, and on the first estate-wide fit 499 of 504 cells refused. So a
store with a home game, a heat advisory, a festival three miles away and a
trend on Reddit got ten reorder cards and nothing else - and the owner's
reading was "the POS already tells me that".

The superseded LLM-chooses arm (``prompt_builder`` + ``LLMRecommender``) did
the opposite job well: weather, calendar and sports, news, bundles from the
basket data, new arrivals and trending drinks, each with a plain-language
reason an owner can act on. It scored 24.2% on REORDERS, which is why it was
retired - not because its signal cards were wrong.

This module puts the two together and keeps each to the thing it is good at:

  * the engine's cards lead the slate, and the engine OWNS reorder: a model
    reorder is dropped whenever the engine has produced one of its own;
  * the model's cards fill the signal categories (weather, calendar_sports,
    news, bundle, new_arrival, social_trending) and may cover the stock
    categories only where the engine was silent - a store with no cost data
    gets no engine markdown, so the model's overstock card is the only one;
  * any model card that names a SKU the engine already chose is dropped here
    rather than left to the validator's dedupe, so the ranks stay contiguous;
  * the engine's remaining cards come after the model's, so a model outage or
    an empty answer leaves the engine's full slate exactly as it was.

RELEVANCE IS ENFORCED, NOT REQUESTED. The first live hybrid runs (22 Oct 2026)
showed three leaks the prompt alone did not close: a bourbon offered for a
scotch-cocktail trend ("the closest high-end whiskey"), an overstock card
tagged endcap while its own text said markdown, and a game-day key cited on a
cigarette-and-scotch bundle it had nothing to do with. So `plan` now holds a
card to its category's evidence:

  * a weather card must cite a weather key; a calendar_sports card a holiday,
    home-game or event key; a news card a news key; a trending card a trend
    key - and any cited key from the WRONG domain is removed from the card;
  * a trending card must name a product that matches the trend by name or by
    the SOCIAL_TREND tag; "the closest thing on the shelf" is dropped;
  * an overstock card's action is markdown or liquidate (or a bundle that
    clears it); a visibility action on an overstock card becomes markdown;
  * tobacco, lottery, ice, bags and other non-beverage lines never reach the
    screen on a model card, whatever the pool contained.

FAIL-SOFT, ALWAYS. The caller wraps the model call in a broad except: the
29 September 2026 billing failure took every store to zero cards because the
component that CHOSE could not be reached, and nothing here may recreate that.
A model failure costs the signal cards and never a reorder.

Everything in here is pure so the composition rule can be tested without a
model, a network or a store.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence

#: The categories the model is asked to cover in the hybrid slate. The two
#: stock categories are NOT here on purpose - see ``plan``.
SIGNAL_CATEGORIES: tuple[str, ...] = (
    "weather",
    "calendar_sports",
    "news",
    "bundle",
    "new_arrival",
    "social_trending",
)

STOCK_CATEGORIES: tuple[str, ...] = ("inventory_understock", "inventory_overstock")

#: Written onto every model card so a reader of the row (and `_narrate_cards`)
#: can tell it from an engine card without inspecting the basis.
RATIONALE_SOURCE = "model_hybrid"

#: Signal domains, as `SignalBundle.citable_keys_by_domain` names them, and
#: the card category each one is allowed to drive.
DOMAIN_OF_CATEGORY: dict[str, frozenset[str]] = {
    "weather": frozenset({"weather"}),
    "calendar_sports": frozenset({"sports", "events", "holidays"}),
    "news": frozenset({"news"}),
    "social_trending": frozenset({"social"}),
}

#: Inventory facts and store-intelligence tags a card may cite in any category.
#: These are product facts, not demand drivers, and never conflict with a domain.
_FACT_KEYS = frozenset({
    "understock", "overstock", "overstock_mild", "overstock_severe", "stockout",
    "lost_sale", "dont_buy", "dead_stock", "market_gap", "new_arrival",
    "area_winner", "co_purchase",
})

_UNDERSTOCK_ACTIONS = frozenset({"reorder"})
_OVERSTOCK_ACTIONS = frozenset({"markdown", "liquidate"})
_OVERSTOCK_ALLOWED = frozenset({"markdown", "liquidate", "bundle"})

#: Names that are never a drink. The engine's own merchandise screen
#: (app/pipeline/candidates/merchandise.py) runs on the engine's path; the
#: model's pool is the candidate shortlist, which reached the screen with a
#: carton of cigarettes at rank 9 on the first hybrid run.
_NON_BEVERAGE_RE = re.compile(
    # Brand words that are also ordinary words or drink names (Camel, Kool,
    # Winston, Parliament, Copenhagen) are left out on purpose: a rye named
    # after a camel is a drink, and the POS category below catches the carton.
    r"\b(marlboro|newport|pall mall|american spirit|l&m|lucky strike|"
    r"cigarettes?|cigars?|cigarillos?|swisher|black ?& ?mild|backwoods|"
    r"dutch masters?|white owl|game leaf|vape|vuse|juul|zyn|skoal|snuff|tobacco|"
    r"lottery|lotto|scratch ?offs?|ice bag|bag of ice|lighters?|rolling papers?|"
    r"phone card|gift card|deposit|bottle return|tax)\b",
    re.IGNORECASE,
)
_NON_BEVERAGE_CATEGORY_RE = re.compile(
    r"tobacco|cigar|cigarette|vape|lottery|lotto|non[- ]?alcoholic merchandise|"
    r"grocery|snack|misc|supplies|ice",
    re.IGNORECASE,
)


def _skus(card: dict) -> list[str]:
    return [str(s) for s in (card.get("primary_skus") or []) if s]


def _cited(card: dict) -> list[str]:
    out: list[str] = []
    for c in card.get("signals_cited") or []:
        if isinstance(c, str) and c.strip():
            out.append(c.strip())
        elif isinstance(c, dict):
            k = c.get("key") or c.get("kind")
            if isinstance(k, str) and k.strip():
                out.append(k.strip())
    return out


def _rank_of(card: dict) -> int:
    try:
        return int(card.get("rank"))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 10**6


def is_non_beverage(name: str | None, pos_category: str | None = None) -> bool:
    """True for a line no drink recommendation should ever name."""
    if name and _NON_BEVERAGE_RE.search(name):
        return True
    if pos_category and _NON_BEVERAGE_CATEGORY_RE.search(pos_category):
        return True
    return False


def plan(
    engine_cards: Sequence[dict],
    model_cards: Iterable[dict],
    *,
    lead_slots: int,
    signal_categories: Iterable[str] = SIGNAL_CATEGORIES,
    stock_fallback: bool = True,
    key_domains: Mapping[str, str] | None = None,
    trend_skus: Iterable[str] | None = None,
    product_names: Mapping[str, str] | None = None,
    pos_categories: Mapping[str, str] | None = None,
) -> list[dict]:
    """Compose one ranked slate from the engine's cards and the model's.

    Order: the engine's first ``lead_slots`` cards, then the model's cards in
    the model's own rank order, then the engine's remaining cards. Ranks are
    rewritten 1..n in that order; the validator sorts on them and truncates in
    that order, so this IS the slate the owner sees when there are more cards
    than slots.

    Model cards are kept only when:
      * their category is one of ``signal_categories``; or
      * ``stock_fallback`` is on, their category is a stock category, and the
        engine produced NO card of that kind (no reorder for understock, no
        markdown/liquidate for overstock);
      * they name at least one SKU the engine did not already choose, or name
        no SKU at all (the sanctioned stock_new shapes the validator checks
        against the area-winner / trend-proof / market-gap lines);
      * with ``key_domains`` given, a weather / calendar_sports / news /
        social_trending card cites at least one key from its own domain, and
        keys from other domains are removed from it;
      * with ``trend_skus`` given, a social_trending card that names SKUs
        names at least one that matches a trend (the rest are removed);
      * with ``product_names`` given, no SKU is a non-beverage line.

    An inventory_overstock card with a visibility action is re-tagged markdown
    (the only honest action for an overstock claim that is not a bundle).

    Nothing about an engine card is changed except its rank.
    """
    engine = list(engine_cards)
    lead = max(0, int(lead_slots))
    allowed = set(signal_categories)
    domains = dict(key_domains or {})
    trend_ok = {str(s) for s in (trend_skus or ())}
    names = dict(product_names or {})
    pos = dict(pos_categories or {})

    engine_skus = {s for c in engine for s in _skus(c)}
    engine_actions = {str(c.get("action_type") or "") for c in engine}
    engine_has_understock = bool(engine_actions & _UNDERSTOCK_ACTIONS)
    engine_has_overstock = bool(engine_actions & _OVERSTOCK_ACTIONS)

    kept: list[dict] = []
    # SKUs already claimed by a better-ranked model card. The validator dedupes
    # by SKU too, but it does so AFTER its "bundle needs two SKUs" check, so a
    # bundle that lost one half to the card above it shipped with one product
    # on the first live run (store 171: "Fords Gin and Tito's" naming Fords
    # alone). Settled here, where the bundle can be dropped whole instead.
    claimed: set[str] = set()
    for raw in sorted((c for c in model_cards if isinstance(c, dict)), key=_rank_of):
        card = dict(raw)
        category = str(card.get("category") or "")
        action = str(card.get("action_type") or "")

        if category in allowed:
            pass
        elif stock_fallback and category == "inventory_understock" and not engine_has_understock:
            pass
        elif stock_fallback and category == "inventory_overstock" and not engine_has_overstock:
            pass
        else:
            continue

        # ── SKUs: not the engine's, not an earlier model card's, and never a
        #    non-beverage line ────────────────────────────────────────────────
        skus = _skus(card)
        if skus:
            skus = [s for s in skus if s not in engine_skus and s not in claimed]
            if not skus:
                continue
            if names or pos:
                skus = [s for s in skus if not is_non_beverage(names.get(s), pos.get(s))]
                if not skus:
                    continue
            if (category == "bundle" or action == "bundle") and len(skus) < 2:
                continue

        # ── Evidence: the cited keys must belong to the card's category ───
        wanted_domains = DOMAIN_OF_CATEGORY.get(category)
        if wanted_domains is not None and domains:
            cited = _cited(card)
            in_domain = [k for k in cited if domains.get(k) in wanted_domains]
            if not in_domain:
                continue
            card["signals_cited"] = [
                k for k in cited
                if domains.get(k) in wanted_domains or k in _FACT_KEYS or k not in domains
            ]
        elif domains and category in ("bundle", "new_arrival", *STOCK_CATEGORIES):
            # These rest on basket data, a NEW tag or a stock flag; a signal
            # key may ride along only when it is real, never when it is a
            # different domain's decoration.
            card["signals_cited"] = [
                k for k in _cited(card) if k in _FACT_KEYS or k in domains
            ]

        # ── Trending: the product has to match the trend ──────────────────
        if category == "social_trending" and skus and trend_skus is not None:
            matched = [s for s in skus if s in trend_ok]
            if not matched:
                continue
            skus = matched

        # ── Overstock: the action is a clearance action ───────────────────
        if category == "inventory_overstock" and action not in _OVERSTOCK_ALLOWED:
            card["action_type"] = "markdown"

        if _skus(card):
            card["primary_skus"] = skus
            claimed.update(skus)
        kept.append({**card, "rationale_source": RATIONALE_SOURCE})

    slate = engine[:lead] + kept + engine[lead:]
    out: list[dict] = []
    for index, card in enumerate(slate, start=1):
        out.append({**card, "rank": index})
    return out


def is_model_card(card: dict) -> bool:
    """True for a card the model wrote in full (prose included)."""
    return (card or {}).get("rationale_source") == RATIONALE_SOURCE


def trend_matching_skus(
    candidates: Iterable[object],
    trend_keywords: Iterable[str],
) -> set[str]:
    """SKUs a trending card may name: the SOCIAL_TREND slice, or a product
    whose name contains a trending drink's keyword (what the prompt calls "a
    clear name match"). Keywords shorter than three letters match nothing."""
    words = [w.strip().lower() for w in trend_keywords if w and len(w.strip()) >= 3]
    out: set[str] = set()
    for c in candidates:
        sku = str(getattr(c, "sku", "") or "")
        if not sku:
            continue
        if getattr(c, "slice", None) == "social_trend":
            out.add(sku)
            continue
        name = str(getattr(c, "product_name", "") or "").lower()
        if name and any(w in name for w in words):
            out.add(sku)
    return out


def prompt_addendum(
    engine_cards: Sequence[dict],
    product_names: Mapping[str, str] | None = None,
    *,
    stock_fallback: bool = True,
    has_trend_lines: bool = False,
    has_new_lines: bool = False,
) -> str:
    """The paragraph appended to the user payload in hybrid mode.

    Tells the model what the engine has already decided, so it does not spend
    its budget re-recommending those products, which categories its cards are
    wanted in, and the relevance and no-loss rules the slate is held to. Goes
    in the USER payload, never the system prompt: the system prompt is the
    cached prefix and must stay byte-identical across stores.
    """
    names = product_names or {}
    engine_actions = {str(c.get("action_type") or "") for c in engine_cards}
    covered: list[str] = []
    for card in engine_cards:
        for sku in _skus(card):
            label = names.get(sku)
            covered.append(f"{sku} ({label})" if label else sku)
    covered_line = ", ".join(covered[:40]) if covered else "none this run"

    wanted = ["weather", "calendar_sports", "news", "bundle", "new_arrival", "social_trending"]
    if stock_fallback and not (engine_actions & _OVERSTOCK_ACTIONS):
        wanted.insert(0, "inventory_overstock")
    if stock_fallback and not (engine_actions & _UNDERSTOCK_ACTIONS):
        wanted.insert(0, "inventory_understock")

    skipped = [c for c in STOCK_CATEGORIES if c not in wanted]
    skipped_line = (
        f" Do NOT produce {' or '.join(skipped)} picks: the store's own stock "
        "arithmetic engine has already issued those cards this run and they "
        "will be shown above yours."
        if skipped else ""
    )
    must_lines = []
    if has_trend_lines:
        must_lines.append(
            "TREND lines are present: include social_trending picks, one per "
            "trend, ONLY for products whose name matches the trending drink or "
            "that carry the SOCIAL_TREND tag. A bourbon is not a scotch trend "
            "pick; if nothing on the shelf matches, skip that trend."
        )
    if has_new_lines:
        must_lines.append(
            "NEW / NEW_HOT / AREA WINNER / MARKET GAP lines are present: "
            "include at least one new_arrival pick (give a NEW_HOT product "
            "visibility or a reorder before its first stockout; a NOT CARRIED "
            "area winner or market gap earns a stock_new pick)."
        )
    must = ("\n" + "\n".join(f"- {m}" for m in must_lines)) if must_lines else ""
    return (
        "\n=== HYBRID SLATE (read before choosing) ===\n"
        "A deterministic engine has already decided this store's stock cards "
        f"from its own sales arithmetic. Products it has already covered: "
        f"{covered_line}. Never recommend those SKUs again in any category.\n"
        f"Spend your budget on these categories: {', '.join(wanted)}.{skipped_line}"
        f"{must}\n"
        "RELEVANCE RULES, enforced after you answer (a card that breaks one is "
        "discarded, so do not write it):\n"
        "- Cite only the signal that actually drives the product's category: "
        "heat favors cold, light drinks and never a scotch or a bourbon; a home "
        "game favors beer, RTDs, party spirits; a holiday favors what people "
        "buy for that holiday. A weather card must cite a weather key, a "
        "calendar_sports card a holiday, home-game or event key, a news card a "
        "news key, a trending card a trend key. Do not decorate a bundle or a "
        "stock card with a game or weather key it does not rest on.\n"
        "- Never recommend tobacco, vapes, lottery, ice, bags, deposits, tax "
        "lines or any other non-beverage SKU, whatever its sales.\n"
        "- An inventory_overstock pick is a markdown, a liquidate or a bundle "
        "that clears it, never an endcap or a promote.\n"
        "NO-LOSS RULES: every card must make the store money or protect it.\n"
        "- No price cut without an overstock_mild / overstock_severe / "
        "DEAD_STOCK / DONT_BUY flag on that line; premium-tier dead stock gets a "
        "display or a bundle, not a deep cut; a markdown names the margin given "
        "up and stays modest.\n"
        "- Reorder and pre_stock quantities never exceed the shown order figure, "
        "or about three weeks of the wk rate when none is shown; never pre-stock "
        "a product with more than eight weeks of cover already.\n"
        "- Among comparable picks prefer the higher margin and the faster seller; "
        "feature and bundle what is already on the shelf before asking the owner "
        "to buy more.\n"
        "If the data supports fewer picks, return fewer.\n"
    )
