"""Deterministic anti-hallucination and policy validation.

The model is instructed to use only candidate SKUs, cite only active signals,
and follow the action-taxonomy criteria — but instruction-following is not a
guarantee, so everything the prompt promises is re-enforced here:

* **Enums / shape** — category and action_type must be members of the
  contract enums (normalized first: case, spaces, hyphens); the rationale
  must exist; confidence is coerced and clamped to [0, 1]. Violations drop
  the recommendation.
* **SKUs** — unknown SKUs are stripped; a recommendation survives as long as
  at least one cited SKU is real (a bundle citing 3 SKUs with 1 hallucinated
  keeps the 2 good ones). A recommendation with no valid SKUs is dropped —
  EXCEPT the two sanctioned SKU-less shapes: a ``new_arrival`` pick citing
  ``area_winner`` that names a known NOT CARRIED area winner, and a
  ``social_trending`` pick grounded in a NOT CARRIED TREND PROOF line. Those
  keep an empty ``primary_skus`` and get the referenced UPC stamped.
* **Signal citations** — key-shaped citations (``cinco_de_mayo``) are
  lowercased; ones that are neither an active signal key nor a known
  inventory-flag term are removed. A recommendation is never dropped for its
  citations — only cleaned.
* **Action coherence** — a bundle needs >= 2 real SKUs; markdown/liquidate
  need an overstock justification (flag cited or an overstocked SKU); a
  supply_risk / price_increase_risk news citation on the affected products
  forces the buy-ahead action (pre_stock) instead of a demand-side one —
  the exact "import pause tagged Promote" failure the store owner reported.
* **cold_box policy** — cold-door space is scarce and expensive, so cold_box
  survives only for chilled-consumption products with an imminent drink-now
  driver cited and real velocity, and at most ``cold_box_max`` per run;
  everything else is demoted to endcap (kept, cheaper placement).
* **endcap cap** — end displays are scarce too, and every demotion path
  lands on endcap, so at most ``endcap_max`` survive per run (highest
  confidence wins); the rest demote to promote.
* **Empty-shelf and duplicate-trend coherence** — a placement action whose
  SKUs are ALL stocked out (stockout flag or measured lost-sale bleed)
  coerces to reorder (a shelf with nothing on it cannot be featured), and
  the Trending section keeps ONE rec per trend key (best-ranked wins,
  later duplicates drop).
* **valid_through** — out-of-window dates are clamped to
  ``[today, today + horizon_days]``; an unparseable date gets a SHORT
  conservative window (7 days), never the maximum.
* **Quantities (one-number rule)** — buy quantities are the shared demand
  engine's figures, never LLM math: every cited SKU with a canonical order
  quantity must have it quoted in units (batched recs enforced per SKU),
  non-compliant hints are rewritten deterministically, and a reorder the
  engine says isn't needed is dropped (see ``_enforce_quantity``).
* **Store-intelligence coherence** — a rec must never contradict what the
  Store Intelligence tabs tell the same owner: reorder/pre_stock loses SKUs
  on the Buying tab's don't-buy list (dropped when none remain); a
  liquidate whose SKUs the Inventory tab classes as still moving softens to
  markdown; a price cut on premium dead stock (the tab's explicit HOLD)
  becomes an endcap; and the SI slow/dead/never_sold classes count as
  price-cut justification alongside the overstock flags. A SKU-less
  stock_new pick may also anchor on a MARKET GAP line (peer-proven, not
  carried), UPC-stamped like the area-winner shape and rationed per run.

We never re-prompt to refill — per the design, surface fewer recommendations
rather than inject noise.
"""

from __future__ import annotations

import re
from datetime import date, timedelta

from app.logging_config import get_logger
from app.pipeline.calibrate.apply import (
    IDENTITY,
    IDENTITY_VERSION,
    ISOTONIC,
    ApplyRequest,
    Calibrated,
)
from app.pipeline.calibrate.fit import CalibrationBundle
from app.pipeline.elasticity.estimate import Elasticity
from app.pipeline.elasticity.guard import PRICE_EFFECT_FAMILIES
from app.schemas.derived import Candidate
from app.schemas.recommendation import (
    ACTION_TYPES, BASIS_NOT_RECORDED, CATEGORIES, CONFIDENCE_BASES,
)
from app.schemas.store import AreaWinner, TrendProof
from app.signals.social import trend_key
from app.store_data.categorize import family_of, norm_text
from app.store_data.store_intel import STAGNANT_CLASSES, MarketGap, StoreIntel
from storeagent.canonical.size import SMALL_FORMAT_MAX_ML

log = get_logger(__name__)

# Categories whose products belong in a cold door at all. The "beer" family
# already spans beer styles, seltzer, RTD, and cider (see categorize._FAMILY);
# chilled-drinking wines are added explicitly. Red wine and spirits never
# qualify.
_CHILLED_WINE = {"wine_white", "wine_rose", "champagne", "prosecco", "sparkling"}

# Demand-side placements that must never be the response to a supply-risk /
# price-rise story about the products themselves.
_DEMAND_PLACEMENTS = {"promote", "endcap", "cold_box"}

# Citation terms that justify a price-cut action.
_OVERSTOCK_TERMS = {"overstock", "overstock_mild", "overstock_severe"}

# Conservative shelf life for a recommendation whose valid_through the model
# garbled: a hallucinated date earns the SHORT window, not the horizon.
_FALLBACK_VALID_DAYS = 7

# Inventory/velocity vocabulary the model may legitimately cite alongside
# external signal keys (rule: "cite at least one signal or inventory flag").
_FLAG_TERMS = {
    "understock", "overstock", "overstock_mild", "overstock_severe", "stockout",
    "liquidate", "slow_mover", "bestseller", "top_mover", "trending", "rising",
    "falling", "very_high", "high_velocity", "new_arrival", "area_winner",
    "margin", "high_margin", "co_purchase", "feedback",
    # Store-intelligence tags (candidate-line facts from the storeagent
    # engines): measured stockout bleed, the don't-buy list, the Inventory
    # tab's dead classification, and the Market tab's assortment gaps.
    "lost_sale", "dont_buy", "dead_stock", "market_gap",
}

_KEY_SHAPED = re.compile(r"^[a-z0-9_]+$")


def _normalize_token(raw: object) -> str:
    """Lowercase and collapse spaces/hyphens to underscores, the shape every
    downstream consumer (Node detectors, frontend tabs) matches exactly."""
    return re.sub(r"[\s-]+", "_", str(raw or "").strip().lower())


def _clean_citations(
    citations: list, allowed_keys: set[str]
) -> tuple[list[str], list[str]]:
    """Split citations into (kept, removed-hallucinated-keys).

    Key-shaped citations are lowercased first ("Cinco_de_Mayo" is the real
    key, mangled) so casing slips don't orphan a legitimate citation — the
    snapshot's .key values downstream are all lowercase.
    """
    kept: list[str] = []
    removed: list[str] = []
    for citation in citations:
        if not isinstance(citation, str):
            continue
        token = citation.strip().lower()
        if not _KEY_SHAPED.match(token):
            kept.append(citation)
        elif token in allowed_keys or token in _FLAG_TERMS:
            kept.append(token)
        else:
            removed.append(token)
    return kept, removed


def _match_area_winner_upc(
    rec: dict, area_winners: list[AreaWinner]
) -> str | None:
    """Resolve which NOT CARRIED area winner a SKU-less pick refers to.

    The prompt mandates the rationale start with the exact product name from
    the AREA WINNERS line, so a case-insensitive name match against the
    not-carried winners is the primary signal; when exactly one not-carried
    winner exists, it is the only thing the model could have meant. The UPC is
    what Node's effectiveness evaluator later uses to detect that the store
    started carrying the product — without it the rec is honest but
    unevaluable.
    """
    not_carried = [w for w in area_winners if not w.carried and w.upc]
    if not not_carried:
        return None
    rationale = str(rec.get("rationale") or "").lower()
    matches = [
        w for w in not_carried
        if w.product_name and w.product_name.strip().lower() in rationale
    ]
    if len(matches) == 1:
        return matches[0].upc
    if len(matches) > 1:
        # Ambiguous name overlap ("99 Guava" vs "99 Guava 50ml"): prefer the
        # longest matched name — the most specific product the text names.
        return max(matches, key=lambda w: len(w.product_name or "")).upc
    if len(not_carried) == 1:
        # A single not-carried winner is the only thing the model COULD have
        # meant — but only stamp its UPC when the rationale actually shares a
        # distinctive word with its name. A blind stamp once credited the
        # winner for a completely different (hallucinated) product, poisoning
        # the effectiveness history built on the UPC.
        winner = not_carried[0]
        padded = norm_text(rationale)
        tokens = [t for t in norm_text(winner.product_name or "").split() if len(t) >= 4]
        if tokens and any(f" {t} " in padded for t in tokens):
            return winner.upc
    return None


def _match_trend_proof_upc(rec: dict, proofs: list[TrendProof]) -> str | None:
    """Resolve which NOT CARRIED trend proof a SKU-less pick refers to.

    Mirrors ``_match_area_winner_upc``: the prompt mandates the rationale
    start with the exact top-seller name from the TREND PROOF line, and the
    citation carries the trend key, so match by cited key first, then by named
    product / term in the rationale. The UPC is what Node's effectiveness
    evaluator later uses to detect "the store started carrying it".
    """
    not_carried = [p for p in proofs if not p.carried and p.upc]
    if not not_carried:
        return None
    cited = {
        c.strip() for c in rec.get("signals_cited") or [] if isinstance(c, str)
    }
    rationale = str(rec.get("rationale") or "").lower()
    matches = [
        p for p in not_carried
        if trend_key(p.term) in cited
        or (p.product_name and p.product_name.strip().lower() in rationale)
        or p.term.strip().lower() in rationale
    ]
    if len(matches) == 1:
        return matches[0].upc
    if len(matches) > 1:
        # Ambiguity: prefer the proof whose (longer) product name the text
        # actually names — the most specific thing the model referred to.
        named = [
            p for p in matches
            if p.product_name and p.product_name.strip().lower() in rationale
        ]
        pool = named or matches
        return max(pool, key=lambda p: len(p.product_name or p.term)).upc
    if len(not_carried) == 1:
        return not_carried[0].upc
    return None


def _match_market_gap_upc(rec: dict, gaps: list[MarketGap]) -> str | None:
    """Resolve which MARKET GAP line a SKU-less pick refers to.

    Mirrors ``_match_area_winner_upc``: the prompt mandates the rationale
    start with the exact product name from the MARKET GAP line (every gap is
    not-carried by construction), so a case-insensitive name match is the
    primary signal, with the same longest-name tie-break and the same
    distinctive-word guard for a single-gap fallback — a blind stamp would
    poison the UPC-keyed effectiveness history exactly like a blind
    area-winner stamp did.
    """
    with_upc = [g for g in gaps if g.upc]
    if not with_upc:
        return None
    rationale = str(rec.get("rationale") or "").lower()
    matches = [
        g for g in with_upc
        if g.product_name and g.product_name.strip().lower() in rationale
    ]
    if len(matches) == 1:
        return matches[0].upc
    if len(matches) > 1:
        return max(matches, key=lambda g: len(g.product_name or "")).upc
    if len(with_upc) == 1:
        gap = with_upc[0]
        padded = norm_text(rationale)
        tokens = [t for t in norm_text(gap.product_name or "").split() if len(t) >= 4]
        if tokens and any(f" {t} " in padded for t in tokens):
            return gap.upc
    return None


def _clamp_valid_through(raw: object, today: date, horizon: date) -> str:
    try:
        parsed = date.fromisoformat(str(raw))
    except (TypeError, ValueError):
        # A date the model garbled earns the SHORT conservative window, never
        # the maximum: garbage input must not buy maximum shelf life.
        fallback = min(horizon, today + timedelta(days=_FALLBACK_VALID_DAYS))
        return fallback.isoformat()
    if parsed < today:
        return today.isoformat()
    if parsed > horizon:
        return horizon.isoformat()
    return parsed.isoformat()


_CASE_WORDS = re.compile(r"\bcases?\b", re.IGNORECASE)
# Ordering advice can ride ANY action's hint (store 171: an ``endcap`` rec
# whose hint said "Order 9 units right away") — enforcement keys on what the
# hint SAYS, not just the action enum.
_ORDER_LANGUAGE = re.compile(r"\b(?:re)?order(?:ing)?\b|\brestock\b|\bbuy\b", re.IGNORECASE)


def _covers_through(today: date, coverage_days: int) -> str:
    """Date-anchored coverage ("covers through about Sep 12"), not a uniform
    duration: with no purchase history most SKUs share the default 21-day
    window, and stamping "about 3 weeks" on every pick read as boilerplate."""
    end = today + timedelta(days=coverage_days)
    return f"covers through about {end.strftime('%b')} {end.day}"


def _enforce_quantity(
    rec: dict, canonical_qty: dict[str, tuple[int, int]], today: date,
    names: dict[str, str],
) -> bool:
    """One-number rule for buy quantities. Returns False to drop the rec.

    Applies to ``reorder``/``pre_stock`` picks, AND to any other action whose
    hint gives ordering advice with a number (an endcap can legitimately say
    "and order more" — but then the figure obeys the same rule). Enforced PER
    SKU, batched recs included: every cited SKU with a canonical order
    quantity from the shared demand engine must have its figure quoted in
    UNITS. A compliant hint is kept (the model may add useful phrasing);
    anything else — a different number, or case language, which no data in
    this pipeline can ground (no pack sizes exist) — is rewritten to the
    deterministic template, one figure per SKU that needs ordering. A
    ``reorder`` whose SKUs the engine says need NOTHING (targets already
    covered by stock) is dropped as false urgency; ``pre_stock`` survives it
    because event uplift is real demand the steady-state engine doesn't
    model; any other action with needless ordering advice keeps the rec but
    loses the hint.
    """
    action = rec.get("action_type")
    hint = str(rec.get("quantity_hint") or "")
    is_buy_action = action in ("reorder", "pre_stock")
    if not is_buy_action and not (_ORDER_LANGUAGE.search(hint) and re.search(r"\d", hint)):
        return True  # non-buy action, no numbered ordering advice — nothing to enforce
    skus = rec.get("primary_skus") or []
    entries = [(s, *canonical_qty[s]) for s in skus if s in canonical_qty]
    if not entries:
        return True  # no SKU known to the engine (or engine unavailable) — no enforcement
    # The SKUs the engine says actually need ordering. Batched recs (the model
    # groups several reorders into one pick) are enforced per SKU — a
    # multi-SKU rec was the store-171 hole where every quantity went
    # unchecked.
    needed = [(s, q, cov) for s, q, cov in entries if q > 0]
    if not needed:
        # Every engine-known SKU on this rec is fully covered by stock.
        if action == "reorder":
            # The engine ran and found nothing to order: current stock already
            # covers the lead time + reorder cycle + buffer. A reorder here is
            # false urgency — the exact bug class this rule exists to stop.
            log.warning("recommendation_dropped", reason="reorder_not_needed", skus=skus)
            return False
        if not is_buy_action:
            # e.g. an endcap telling the owner to order product the engine
            # says is fully covered: the display advice stands, the needless
            # buy advice goes.
            log.warning("quantity_hint_stripped", reason="order_not_needed",
                        skus=skus, action=action, was=hint)
            rec["quantity_hint"] = None
            return True
        return True  # pre_stock may ride event uplift the engine doesn't model
    if len(skus) == 1:
        rec["suggested_order_qty"] = needed[0][1]
    # Every canonical number must be bound to a unit word ("45 units", "19
    # six-packs" — a multi-pack product's sellable unit IS the pack, and pack
    # phrasing is encouraged), not merely appear anywhere: a date ("by the
    # 15th") or price that happens to equal a qty must not certify a hint
    # that quotes a DIFFERENT amount.
    def _quotes(qty: int) -> bool:
        return re.search(
            rf"\b{qty}\s*(?:\w+[- ])?(?:units?|bottles?|btls?|cans?|packs?|pks?|u)\b",
            hint, re.IGNORECASE,
        ) is not None

    if all(_quotes(q) for _, q, _ in needed) and not _CASE_WORDS.search(hint):
        return True
    # Deterministic rebuild, one figure per SKU that needs ordering (SKUs the
    # engine says are covered are deliberately omitted — never imply an order
    # for them). No delivery-time claims: actual delivery duration is
    # unknowable from our data (the purchase ledger has no order->receive
    # timestamps). State only the arithmetic fact: the date the ordered stock
    # carries them through (the tightest window when the batch differs).
    items = ", ".join(f"{q} units of {names.get(s) or s}" for s, q, _ in needed)
    min_cov = min(cov for _, _, cov in needed)
    rewritten = f"order {items} ({_covers_through(today, min_cov)})"
    log.warning(
        "quantity_hint_rewritten",
        skus=[s for s, _, _ in needed],
        canonical_qtys=[q for _, q, _ in needed],
        was=hint or None,
    )
    rec["quantity_hint"] = rewritten
    return True


def _coerce_confidence(raw: object) -> float:
    try:
        value = float(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.5  # unknown confidence is neutral, not zero and not high
    return max(0.0, min(1.0, value))


def _matches_any_keyword(name: str | None, keywords: set[str]) -> bool:
    if not keywords or not name:
        return False
    padded = norm_text(name)
    return any(f" {kw} " in padded for kw in keywords if kw)


def _cited_keys(rec: dict) -> list[str]:
    return [
        c.strip().lower()
        for c in rec.get("signals_cited") or []
        if isinstance(c, str) and _KEY_SHAPED.match(c.strip().lower())
    ]


# ── Sheet 08: calibration ────────────────────────────────────────────────────

#: The cell a rec falls in when its demand class is not known. A real key,
#: not None, so that "we never looked up the class" is a fittable cell rather
#: than a silent hole - and so the identity reason names it out loud.
UNKNOWN_DEMAND_CLASS = "unknown"


def _rank_confidence(rec: dict) -> float:
    """What every cap ranks on: the CALIBRATED confidence.

    Falls back to the raw value only when calibration has not run at all
    (older callers, tests constructing recs by hand). A function rather than
    a lambda so "ranking uses the calibrated value" is one fact in one place,
    asserted by a test, instead of a convention three sort calls have to
    remember separately.
    """
    value = rec.get("calibrated_confidence")
    if value is None:
        value = rec.get("confidence")
    return float(value or 0.0)


def _apply_calibration(
    recs: list[dict],
    bundle: CalibrationBundle | None,
    demand_class_by_sku: dict[str, str] | None,
    suspended_families: tuple[str, ...],
) -> None:
    """Stamp `calibrated_confidence` onto every rec, in place, before ranking.

    In place because the caps below re-slice `valid` several times and a
    rebuilt list would have to be threaded through each one.

    Never raises and never drops a rec: a confidence that cannot be
    calibrated passes through unchanged WITH ITS REASON, because an
    unexplained passthrough and a fitted curve look identical on the wire and
    the first would quietly become permanent.
    """
    classes = demand_class_by_sku or {}
    for rec in recs:
        raw = rec.get("confidence")
        if raw is None:
            continue
        skus = rec.get("primary_skus") or []
        demand_class = classes.get(skus[0]) if skus else None
        request = ApplyRequest(
            raw_confidence=float(raw),
            family=str(rec.get("action_type") or "unknown"),
            demand_class=demand_class or UNKNOWN_DEMAND_CLASS,
            bundle=bundle,
            suspended_families=suspended_families,
        )
        calibrated = _calibrate_one(request)
        rec["calibrated_confidence"] = calibrated.value
        rec["calibration_version"] = calibrated.version
        if calibrated.reasons:
            rec["calibration_reasons"] = list(calibrated.reasons)


def _calibrate_one(request: ApplyRequest) -> Calibrated:
    """One calibration, outside the stage envelope.

    `apply_calibration` is a @stage and wants a RunContext; the validator
    runs deep inside a request path that has none to hand. The transform
    itself is pure, so this calls it directly and keeps the stage wrapper for
    the pipeline entry point - rather than manufacturing a fake RunContext,
    which would put an unreplayable row in the audit trail claiming to be a
    real one.
    """
    reasons: list[str] = []
    fit = None
    if request.bundle is None:
        reasons.append("no_calibration_bundle")
    elif request.family in tuple(request.suspended_families):
        reasons.append(f"family_suspended:{request.family}")
    else:
        fit = request.bundle.fit_for(request.family, request.demand_class)
        if fit is None:
            skipped = request.bundle.skipped.get(
                (request.family, request.demand_class)
            )
            reasons.append(
                f"no_fit_for_cell:{request.family}/{request.demand_class}"
                + (f":{skipped}" if skipped else "")
            )

    if fit is None:
        return Calibrated(
            raw=request.raw_confidence, value=request.raw_confidence,
            transform=IDENTITY, version=IDENTITY_VERSION,
            family=request.family, demand_class=request.demand_class,
            reasons=tuple(reasons),
        )
    value, clip_reasons = fit.predict(request.raw_confidence)
    return Calibrated(
        raw=request.raw_confidence, value=value,
        transform=ISOTONIC, version=request.bundle.version,
        family=request.family, demand_class=request.demand_class,
        reasons=tuple(reasons) + clip_reasons,
    )


# ── Sheet 09: the elasticity guard ───────────────────────────────────────────


def _withhold_unsupported_price_claims(
    recs: list[dict],
    elasticity_by_category: dict[str, Elasticity | None],
) -> tuple[list[dict], list[tuple[dict, str]]]:
    """Split out markdown/liquidate/bundle cards with no price effect behind them.

    Every markdown makes an implicit elasticity claim - "drop the price and
    volume will more than compensate". On real data that claim is
    unsupportable for roughly three quarters of (store, category) cells: the
    interval spans zero, or the estimate is positive, or prices never moved
    enough to estimate anything. Refusing beats inventing.

    Families that make no price claim - reorder, promote, cold_box and the
    rest - pass through untouched. Blocking them on an elasticity they never
    cited would cost a store recommendations it was entitled to.
    """
    kept: list[dict] = []
    withheld: list[tuple[dict, str]] = []
    for rec in recs:
        family = str(rec.get("action_type") or "")
        category = str(rec.get("category") or "")
        if family not in PRICE_EFFECT_FAMILIES:
            kept.append(rec)
            continue

        # ALLOW-LIST, not a block-list. A price claim passes only on an
        # explicit usable estimate; a category simply ABSENT from the map is
        # blocked, not permitted.
        #
        # The block-list reading was the first version and it was wrong in the
        # dangerous direction: `blocked_categories({})` is empty, so supplying
        # no elasticity evidence at all let every markdown through - the exact
        # state this sheet exists to end, reached by passing nothing.
        estimate = elasticity_by_category.get(category)
        if estimate is not None and estimate.usable:
            kept.append(rec)
            continue
        if estimate is None:
            reason = "no_elasticity_estimate"
        else:
            bounds = (f"[{estimate.interval.low:.3f},"
                      f"{estimate.interval.high:.3f}]")
            reason = (
                f"elasticity_interval_spans_zero:{bounds}"
                if estimate.interval.spans_zero
                else f"elasticity_is_positive:{bounds}"
            )
        rec["withheld_reason"] = reason
        withheld.append((rec, reason))
    return kept, withheld


def validate_recommendations(
    raw_recs: list[dict],
    candidates: list[Candidate],
    *,
    max_recommendations: int,
    max_trending: int | None = None,
    active_signal_keys: list[str] | None = None,
    today: date | None = None,
    horizon_days: int = 21,
    area_winners: list[AreaWinner] | None = None,
    trend_proof: list[TrendProof] | None = None,
    # key -> {"categories": set[str] (family-expanded), "keywords": set[str]
    # (norm_text'd)} for every cited supply_risk / price_increase_risk news
    # item — the affected-product test behind the buy-ahead rule.
    supply_news: dict[str, dict] | None = None,
    # Citable keys of drink-now demand drivers landing within the next few
    # days (heat advisory, local games, imminent events/holidays). cold_box
    # requires one; None = caller has no driver info, gate on the rest only.
    chill_driver_keys: set[str] | None = None,
    #: SKUs the caller can prove exist because it read them out of the store's
    #: own sales. Not a bypass: they are ADDED to the pool, and every other
    #: rule - quantity, staleness, enum, coverage - still applies.
    verified_skus: set[str] | None = None,
    cold_box_max: int = 1,
    # Endcaps are physically scarce too (a store has a couple of end displays)
    # and every demotion path above lands on endcap, so they pile up without
    # a cap; excess endcaps (lowest confidence first) demote to promote.
    endcap_max: int = 2,
    # {sku: (order_qty, coverage_days)} from the shared demand engine — the
    # one-number rule's ground truth for quantity hints (empty = no
    # enforcement; see _enforce_quantity).
    canonical_qty: dict[str, tuple[int, int]] | None = None,
    # ── Sheet 08: calibration, applied BEFORE the caps below rank on it ──
    # The fitted bundle. None is the normal state today - no outcomes have
    # accumulated, so every confidence passes through unchanged and says so.
    calibration: CalibrationBundle | None = None,
    # sku -> sheet-07 demand class. Calibration is fitted per (family, demand
    # class), so without this every rec lands in the "unknown" cell and gets
    # the identity transform. Threading the real class through is the
    # remaining wiring; the seam is here so it is a one-line change.
    demand_class_by_sku: dict[str, str] | None = None,
    # Families the monitor has suspended for this store. A suspended family
    # falls back to identity rather than using a curve known to be drifting.
    suspended_families: tuple[str, ...] = (),
    # ── Sheet 09: the elasticity guard ───────────────────────────────────
    # category -> the fitted beta, or None where none could be estimated.
    # Empty/None means no elasticity evidence was supplied at all, which
    # BLOCKS every price-effect family - a markdown with nothing behind its
    # price claim is exactly what this sheet exists to stop. Pass an explicit
    # dict to enable the gate; callers that have not yet wired it keep their
    # current behaviour via `enforce_elasticity=False`.
    elasticity_by_category: dict[str, Elasticity | None] | None = None,
    enforce_elasticity: bool = False,
    # Max recs per run centered ENTIRELY on small-format (<=100ml) minis. Nips
    # sell huge unit counts at tiny prices and were crowding the list.
    small_format_max: int = 1,
    # Hard floor beneath that cap: a rec citing ANY sku at or under this volume
    # is dropped outright. The cap alone was not enough - it only counted recs
    # whose skus were ALL minis, so pairing a nip with a real bottle shipped it.
    small_format_exclude_ml: float = SMALL_FORMAT_MAX_ML,
    # Keys of register-discovered trend signals (source "registers") and the
    # per-run cap on recs anchored purely on them.
    register_trend_keys: set[str] | None = None,
    register_trend_max: int = 1,
    # Store-intelligence grounding (don't-buy list, velocity classes, market
    # gaps) from the storeagent engines; None = bridge unavailable, gates
    # inert. market_gap_max caps SKU-less picks anchored on a MARKET GAP line.
    store_intel: StoreIntel | None = None,
    market_gap_max: int = 1,
) -> tuple[list[dict], int]:
    """Returns (valid recommendations, genuinely dropped count).

    The dropped count excludes the max_recommendations truncation — a model
    that returns three extra PERFECTLY VALID recs has not produced three
    invalid ones, and the metric feeds monitoring.
    """
    # The SKUs a recommendation may legitimately name.
    #
    # `candidates` is the pool the LLM was SHOWN, and the hallucination check
    # below exists to catch a model naming something that was never in front of
    # it. That is the right test for a model and the wrong one for the
    # deterministic engine, which selects from the store's whole sales history:
    # a SKU with a year of that store's own receipts behind it is not invented,
    # it is better evidenced than a pool member.
    #
    # `verified_skus` is how the engine declares "these came from the data, not
    # from a generator". Empty for the model path, so its behaviour is
    # unchanged - the check still fires exactly as before.
    candidate_skus = {c.sku for c in candidates} | set(verified_skus or ())
    by_sku = {c.sku: c for c in candidates}
    candidate_names = {c.sku: c.product_name for c in candidates}
    _size_by_sku = {c.sku: c.size_ml for c in candidates}
    allowed_keys = set(active_signal_keys or [])
    supply_news = supply_news or {}
    today = today or date.today()
    horizon = today + timedelta(days=horizon_days)
    canonical_qty = canonical_qty or {}
    dont_buy = store_intel.dont_buy if store_intel is not None else {}
    sku_si = store_intel.sku_intel if store_intel is not None else {}
    market_gaps = store_intel.market_gaps if store_intel is not None else []

    valid: list[dict] = []
    dropped = 0

    for rec in raw_recs:
        # --- enum + shape enforcement (the tool schema is advisory, not a
        # guarantee: out-of-enum tags previously flowed to Node verbatim and
        # malformed fields crashed whole runs downstream) ---
        if not isinstance(rec, dict):
            dropped += 1
            log.warning("recommendation_dropped", reason="not_an_object", type=type(rec).__name__)
            continue
        rec["category"] = _normalize_token(rec.get("category"))
        rec["action_type"] = _normalize_token(rec.get("action_type"))
        if rec["category"] not in CATEGORIES or rec["action_type"] not in ACTION_TYPES:
            dropped += 1
            log.warning(
                "recommendation_dropped", reason="enum_violation",
                category=rec["category"], action_type=rec["action_type"],
            )
            continue
        if not str(rec.get("rationale") or "").strip():
            dropped += 1
            log.warning("recommendation_dropped", reason="empty_rationale")
            continue
        rec["confidence"] = _coerce_confidence(rec.get("confidence"))
        # EVERY CARD LEAVES WITH A BASIS. The emitters each write their own
        # (deterministic: the calibration outcome; families: the evidence count;
        # the LLM client: llm_stated), so a card arriving bare here came down a
        # path nobody labelled. LABELLED, NOT DROPPED: the response model would
        # otherwise refuse the card for a missing word, and hiding advice the
        # store could act on is a worse failure than printing "not recorded"
        # next to its figure - the label is precisely what tells a reader to
        # discount that figure. Loud, with the rank and the offending value, so
        # the path gets found. An UNKNOWN value is treated the same way: the
        # schema's Literal would drop the card, and an invented fifth meaning
        # must not travel under any name but this one.
        basis = rec.get("confidence_basis")
        if basis not in CONFIDENCE_BASES:
            log.warning(
                "confidence_basis_not_recorded",
                rank=rec.get("rank"), action_type=rec["action_type"],
                primary_skus=rec.get("primary_skus"),
                supplied=None if basis is None else str(basis),
            )
            rec["confidence_basis"] = BASIS_NOT_RECORDED

        skus = rec.get("primary_skus") or []
        good_skus = [s for s in skus if s in candidate_skus]
        bad_skus = [s for s in skus if s not in candidate_skus]
        if not good_skus:
            # Sanctioned SKU-less shapes: a new_arrival pick for a NOT CARRIED
            # area winner, or a social_trending pick for a NOT CARRIED trend-
            # proof product — either way the product has no SKU at this store
            # and the rationale names it. Anything the model put in
            # primary_skus (often the upc) is stripped rather than passed
            # downstream as a fake SKU.
            citations = rec.get("signals_cited") or []
            is_area_pick = rec.get("category") == "new_arrival" and any(
                isinstance(c, str) and c.strip() == "area_winner" for c in citations
            )
            trend_upc = (
                _match_trend_proof_upc(rec, trend_proof or [])
                if rec.get("category") == "social_trending"
                else None
            )
            # Third sanctioned shape (contract rule 1c): a stock_new pick for
            # a MARKET GAP line — a peer-proven product this store does not
            # carry — citing market_gap and naming the product.
            is_gap_pick = any(
                isinstance(c, str) and c.strip().lower() == "market_gap"
                for c in citations
            )
            gap_upc = _match_market_gap_upc(rec, market_gaps) if is_gap_pick else None
            if not is_area_pick and trend_upc is None and not is_gap_pick:
                dropped += 1
                log.warning("recommendation_dropped", reason="hallucinated_sku", bad_skus=bad_skus)
                continue
            if bad_skus:
                log.warning("skuless_pick_skus_stripped", bad_skus=bad_skus)
            rec["primary_skus"] = []
            # The sanctioned SKU-less shapes are <category> + stock_new
            # (contract §2). The model occasionally picks another action for an
            # uncarried product; coerce rather than drop — "start carrying it"
            # is the only action a store can take on a product it doesn't have.
            if rec.get("action_type") != "stock_new":
                log.warning(
                    "skuless_action_coerced", from_action=rec.get("action_type")
                )
                rec["action_type"] = "stock_new"
            # Stamp the referenced UPC so the effectiveness evaluator can later
            # detect "the store started carrying it" (contract §1.6/§1.7/§2).
            # A SKU-less pick whose rationale matches NO known not-carried
            # product (area winner, trend proof, or market gap) is dropped:
            # an unmatched pick is unverifiable at best and a hallucinated
            # product at worst, and a mis-stamped UPC poisons the measured
            # track record.
            rec["reference_upc"] = (
                trend_upc
                if trend_upc is not None
                else gap_upc
                if gap_upc is not None
                else _match_area_winner_upc(rec, area_winners or [])
            )
            if rec["reference_upc"] is None:
                dropped += 1
                log.warning("recommendation_dropped", reason="skuless_pick_unmatched")
                continue
            # Contract shape (c) is new_arrival + stock_new + market_gap: a
            # pick resolved to a MARKET GAP line (not a trend proof) belongs
            # to the new_arrival category, so an off-shape category the model
            # chose is coerced — mirroring the action coercion above.
            if (trend_upc is None and gap_upc is not None
                    and rec.get("category") != "new_arrival"):
                log.warning(
                    "gap_pick_category_coerced", from_category=rec.get("category")
                )
                rec["category"] = "new_arrival"
        elif bad_skus:
            # Partial salvage: keep the real SKUs, log the invented ones.
            log.warning("recommendation_skus_stripped", bad_skus=bad_skus, kept=len(good_skus))
            rec["primary_skus"] = good_skus

        citations = rec.get("signals_cited") or []
        kept_citations, removed_keys = _clean_citations(citations, allowed_keys)
        rec["signals_cited"] = kept_citations
        if removed_keys:
            log.warning("recommendation_citations_stripped", removed=removed_keys)

        # --- action coherence -------------------------------------------------
        action = rec["action_type"]
        rec_skus: list[str] = rec.get("primary_skus") or []
        cited = _cited_keys(rec)

        if action == "bundle" and len(rec_skus) < 2:
            dropped += 1
            log.warning("recommendation_dropped", reason="bundle_needs_two_skus")
            continue

        if action in ("markdown", "liquidate"):
            # Justification: the classic overstock evidence, OR the Inventory
            # tab's own slow/dead/never_sold classification — a price cut the
            # tab itself would print is grounded even when the weeks-of-cover
            # flag alone wouldn't fire.
            justified = bool(set(cited) & _OVERSTOCK_TERMS) or any(
                (c := by_sku.get(s)) is not None
                and c.health_status in ("overstock_mild", "overstock_severe")
                for s in rec_skus
            ) or any(
                (e := sku_si.get(s)) is not None
                and e.velocity_class in STAGNANT_CLASSES
                for s in rec_skus
            )
            if not justified:
                dropped += 1
                log.warning(
                    "recommendation_dropped", reason="price_cut_without_overstock",
                    action_type=action,
                )
                continue
            # Store-intelligence coherence (only for SKUs the engine knows):
            # premium dead stock is the Inventory tab's explicit HOLD —
            # feature it, never discount it — so the pick keeps its product
            # but becomes an endcap; and a liquidate whose SKUs the tab all
            # classes as still moving contradicts the tab's own clearance
            # view, so the cut softens to markdown.
            known = [sku_si[s] for s in rec_skus if s in sku_si]
            if known and all(
                e.premium and e.velocity_class in STAGNANT_CLASSES for e in known
            ):
                log.warning("price_cut_demoted", reason="premium_hold", skus=rec_skus)
                rec["action_type"] = action = "endcap"
            elif action == "liquidate" and known and all(
                e.velocity_class not in STAGNANT_CLASSES for e in known
            ):
                log.warning("liquidate_demoted", reason="still_moving", skus=rec_skus)
                rec["action_type"] = action = "markdown"

        # Empty-shelf rule: a placement action needs stock on the shelf. When
        # every SKU is flagged stockout or carries a measured lost-sale bleed
        # (store 171: "out of stock for 40 days ... give it a front display"
        # shipped as promote), the only action the store can take is reorder.
        # Gates on the deterministic flags, never bare on_hand (0 also means
        # "unknown" in sparse feeds).
        if action in _DEMAND_PLACEMENTS and rec_skus:
            empty = [
                (c := by_sku.get(s)) is not None
                and (c.health_status == "stockout" or c.lost_days_out is not None)
                for s in rec_skus
            ]
            if empty and all(empty):
                log.warning(
                    "placement_on_empty_shelf_coerced", from_action=action,
                    skus=rec_skus,
                )
                rec["action_type"] = action = "reorder"

        # Buy-ahead rule: a cited supply_risk / price_increase_risk story
        # about these very products means "buy now", never a demand-side
        # placement — the mis-tag the store owner reported ("imports may
        # pause" came out as Promote). Promoting a genuine substitute (a
        # product the story is NOT about) stays allowed.
        supply_cited = [k for k in cited if k in supply_news]
        if supply_cited and action in _DEMAND_PLACEMENTS:
            # `cited` and `rec_skus` are bound as defaults rather than
            # closed over. Today this closure is built and consumed inside one
            # iteration so late binding cannot bite - but it is one edit away
            # from being stored or deferred, and at that point every call
            # would silently read the LAST rec's values. Binding costs
            # nothing and removes the trap.
            def _affected_by(
                key: str, cited: object = cited, rec_skus: object = rec_skus
            ) -> bool:
                item = supply_news.get(key) or {}
                cats = item.get("categories") or set()
                keywords = item.get("keywords") or set()
                if not cats and not keywords:
                    # No affected-product info on the item: treat as affected
                    # unless some OTHER cited SIGNAL independently justifies a
                    # demand placement. Inventory-flag terms (bestseller,
                    # understock, ...) are product facts, not demand drivers,
                    # so they don't count as independent justification.
                    return not any(
                        k not in supply_news and k not in _FLAG_TERMS for k in cited
                    )
                for s in rec_skus:
                    c = by_sku.get(s)
                    if c is None:
                        continue
                    if (c.category or "") in cats:
                        return True
                    if _matches_any_keyword(c.product_name, keywords):
                        return True
                return False

            if any(_affected_by(k) for k in supply_cited):
                log.warning(
                    "supply_action_coerced", from_action=action,
                    supply_keys=supply_cited,
                )
                rec["action_type"] = action = "pre_stock"

        # Don't-buy suppression: the Buying tab's stop-ordering list (dead, or
        # fading with months of supply on hand). Putting more money into these
        # is wrong under ANY driver — event uplift included — so reorder and
        # pre_stock lose the flagged SKUs (partial salvage, like the
        # hallucination rule) and a rec left with none is dropped. Runs AFTER
        # the supply coercion so a coerced pre_stock is checked too. Markdown,
        # liquidate, and bundle stay allowed: clearing a don't-buy product is
        # exactly what the engine recommends for it.
        if action in ("reorder", "pre_stock") and rec_skus and dont_buy:
            flagged = [s for s in rec_skus if s in dont_buy]
            if flagged:
                kept_skus = [s for s in rec_skus if s not in dont_buy]
                if not kept_skus:
                    dropped += 1
                    log.warning(
                        "recommendation_dropped", reason="dont_buy_sku",
                        skus=flagged,
                    )
                    continue
                log.warning("dont_buy_skus_stripped", removed=flagged, kept=len(kept_skus))
                rec["primary_skus"] = rec_skus = kept_skus

        # cold_box policy: scarce, expensive space — chilled-consumption
        # products only, with an imminent drink-now driver cited and real
        # velocity behind them. Anything else keeps the rec but on an endcap.
        if action == "cold_box":
            reason = None
            chillable = all(
                (c := by_sku.get(s)) is not None
                and (
                    family_of(c.category) == "beer"
                    or (c.category or "") in _CHILLED_WINE
                )
                for s in rec_skus
            )
            if not rec_skus or not chillable:
                reason = "not_chilled_consumption"
            elif chill_driver_keys is not None and not (set(cited) & chill_driver_keys):
                reason = "no_imminent_driver"
            elif not any(
                (c := by_sku.get(s)) is not None
                and (c.velocity_bucket in ("high", "very_high") or c.trend == "rising")
                for s in rec_skus
            ):
                reason = "not_a_fast_mover"
            if reason:
                log.warning("cold_box_demoted", reason=reason, skus=rec_skus)
                rec["action_type"] = "endcap"

        rec["valid_through"] = _clamp_valid_through(rec.get("valid_through"), today, horizon)

        # One-number rule: buy quantities must be the shared demand engine's
        # figures (the same numbers the Buying tab prints), never LLM math.
        if not _enforce_quantity(rec, canonical_qty, today, candidate_names):
            dropped += 1
            continue

        valid.append(rec)

    # Order by the model's own rank (stable: emission order breaks ties) so
    # truncation keeps the picks the model ranked best, not merely the ones
    # it happened to emit first.
    def _rank_of(rec: dict) -> int:
        try:
            return int(rec.get("rank"))  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return 10**6

    valid.sort(key=_rank_of)

    # One product, one recommendation: the same SKU in two recs reads as
    # either a contradiction or a copy (store 171: Kentucky Gentleman 375ml
    # appeared twice in one run). The best-ranked rec claims its SKUs; later
    # recs lose the repeats, and a rec left with no SKUs is dropped (the
    # sanctioned SKU-less shapes carry none to begin with and pass through).
    claimed: set[str] = set()
    deduped: list[dict] = []
    for rec in valid:
        skus = rec.get("primary_skus") or []
        if not skus:
            deduped.append(rec)
            continue
        kept_skus = [s_ for s_ in skus if s_ not in claimed]
        repeats = [s_ for s_ in skus if s_ in claimed]
        if not kept_skus:
            dropped += 1
            log.warning("recommendation_dropped", reason="duplicate_skus", skus=skus)
            continue
        if repeats:
            log.warning("recommendation_skus_deduped", removed=repeats,
                        kept=len(kept_skus))
            rec["primary_skus"] = kept_skus
        claimed.update(kept_skus)
        deduped.append(rec)
    valid = deduped

    # Small-format exclusion: minis at or under ``small_format_exclude_ml``
    # are never recommended, so ANY rec citing one goes - mixed picks included.
    # Candidate selection already keeps them out of the pool; this is the
    # backstop for a rec that reaches the validator by another route.
    if small_format_exclude_ml > 0:
        kept: list[dict] = []
        for rec in valid:
            minis = [s_ for s_ in (rec.get("primary_skus") or [])
                     if (ml := _size_by_sku.get(s_)) is not None
                     and ml <= small_format_exclude_ml]
            if minis:
                dropped += 1
                log.warning("recommendation_dropped", reason="small_format_excluded",
                            skus=minis)
                continue
            kept.append(rec)
        valid = kept

    # Small-format rationing: at most ``small_format_max`` recs whose SKUs are
    # ALL <=100ml minis (mixed picks pairing a nip with a real bottle don't
    # count). Beyond the cap the rec is dropped so a full-bottle pick below
    # it can ship instead.
    def _all_small(rec: dict) -> bool:
        skus = rec.get("primary_skus") or []
        return bool(skus) and all(_size_by_sku.get(s_) is not None
                                  and _size_by_sku[s_] <= 100 for s_ in skus)

    small_seen = 0
    rationed: list[dict] = []
    for rec in valid:
        if _all_small(rec):
            small_seen += 1
            if small_seen > max(0, small_format_max):
                dropped += 1
                log.warning("recommendation_dropped", reason="small_format_cap",
                            skus=rec.get("primary_skus"))
                continue
        rationed.append(rec)
    valid = rationed

    # One trending rec per trend: three picks riding the same key crowd the
    # Trending section with one story told thrice (store 171: margarita x3).
    # The first (best-ranked) social_trending rec keeps each trend key; a
    # later one whose cited trend keys ALL belong to kept recs drops. A rec
    # citing any NEW trend stays — it tells a story not yet told.
    seen_trends: set[str] = set()
    trend_rationed: list[dict] = []
    for rec in valid:
        if rec.get("category") == "social_trending":
            tkeys = [k for k in _cited_keys(rec) if k.startswith("trend_")]
            if tkeys and all(k in seen_trends for k in tkeys):
                dropped += 1
                log.warning("recommendation_dropped", reason="duplicate_trend",
                            cited=tkeys)
                continue
            seen_trends.update(tkeys)
        trend_rationed.append(rec)
    valid = trend_rationed

    # Register-discovery rationing: a rec whose cited trend keys are ALL
    # register-sourced is anchored on nearby-store data alone — cap those at
    # ``register_trend_max`` per run (best-ranked wins) so measured-peer
    # picks inform without dominating.
    reg_keys = register_trend_keys or set()

    def _register_anchored(rec: dict) -> bool:
        trend_cited = [k for k in _cited_keys(rec) if k.startswith("trend_")]
        return bool(trend_cited) and all(k in reg_keys for k in trend_cited)

    reg_seen = 0
    reg_rationed: list[dict] = []
    for rec in valid:
        if _register_anchored(rec):
            reg_seen += 1
            if reg_seen > max(0, register_trend_max):
                dropped += 1
                log.warning("recommendation_dropped", reason="register_trend_cap",
                            cited=rec.get("signals_cited"))
                continue
        reg_rationed.append(rec)
    valid = reg_rationed

    # Market-gap rationing: at most ``market_gap_max`` SKU-less picks anchored
    # on a MARKET GAP line per run (best-ranked wins) — peer-proven assortment
    # gaps inform, never dominate, same idea as the register cap.
    gap_upcs = {g.upc for g in market_gaps if g.upc}

    def _gap_anchored(rec: dict) -> bool:
        return (not rec.get("primary_skus")
                and rec.get("reference_upc") in gap_upcs
                and "market_gap" in _cited_keys(rec))

    gap_seen = 0
    gap_rationed: list[dict] = []
    for rec in valid:
        if _gap_anchored(rec):
            gap_seen += 1
            if gap_seen > max(0, market_gap_max):
                dropped += 1
                log.warning("recommendation_dropped", reason="market_gap_cap",
                            reference_upc=rec.get("reference_upc"))
                continue
        gap_rationed.append(rec)
    valid = gap_rationed

    # ── Sheet 09: a price claim needs a price effect behind it ───────────
    #
    # Runs BEFORE the caps: a markdown blocked here must not occupy a slot
    # that a supportable recommendation could have had. Withheld rather than
    # silently dropped, with the reason on the record (sheet 02).
    if enforce_elasticity:
        valid, withheld_price = _withhold_unsupported_price_claims(
            valid, elasticity_by_category or {}
        )
        for rec, reason in withheld_price:
            dropped += 1
            log.warning("recommendation_dropped", reason="elasticity_guard",
                        detail=reason, action_type=rec.get("action_type"),
                        category=rec.get("category"))

    # ── Sheet 08: calibrate BEFORE anything ranks on confidence ──────────
    #
    # Every cap below sorts by confidence, and those sorts decide what an
    # owner actually sees: which trending recs survive, which cold_box is
    # demoted to endcap, which endcap is demoted to promote.
    #
    # Applying calibration AFTER them would leave an overconfident `reorder`
    # holding its slot and merely print a smaller number beside it. Applied
    # here, a family whose stated confidence has not been earned loses its
    # place to one whose has. That is the decision changing, which is the
    # only outcome worth the engineering.
    #
    # Today this is the identity transform - `recommendation_evaluations`
    # holds zero rows, so there is no curve to apply - and every rec carries
    # the reason why. The plumbing ships complete so that when outcomes
    # arrive the work is fitting a curve, not threading a value through the
    # ranking path.
    _apply_calibration(valid, calibration, demand_class_by_sku,
                       suspended_families)

    if max_trending is None:
        # Legacy single-budget behavior: one cap over everything.
        valid = valid[:max_recommendations]
    else:
        # Trending rides its OWN budget (it renders as a separate persistent
        # tab, never bucketed into the daily list): dailies keep the classic
        # cap (in model-rank order), and the trending pool keeps its top
        # ``max_trending`` by confidence — the prompt tells the model exactly
        # this, so an honest confidence score is what competes for the slots.
        daily = [r for r in valid if r.get("category") != "social_trending"]
        trending = sorted(
            (r for r in valid if r.get("category") == "social_trending"),
            key=_rank_confidence,
            reverse=True,
        )
        valid = daily[:max_recommendations] + trending[:max_trending]

    # Hard cap on surviving cold_box recs: keep the highest-confidence one(s),
    # demote the rest to endcap. The prompt says "at most once"; this makes it
    # true regardless of what the model does. Runs AFTER truncation so a rec
    # that won't ship can never demote the one that will.
    cold = [r for r in valid if r["action_type"] == "cold_box"]
    if len(cold) > max(0, cold_box_max):
        cold.sort(key=_rank_confidence, reverse=True)
        for rec in cold[max(0, cold_box_max):]:
            log.warning("cold_box_demoted", reason="over_per_run_cap")
            rec["action_type"] = "endcap"
    # Endcaps get the same physical-scarcity cap (a store has a couple of end
    # displays, and every demotion above — premium holds, over-cap cold boxes —
    # lands on endcap, so they pile up): keep the highest-confidence ones,
    # demote the rest to promote — the same visibility story on space the
    # store actually has. Runs AFTER the cold_box pass so its demotions count
    # against the cap. The swap is safe from the "never promote supply_risk
    # products" rule: the buy-ahead coercion already turned those into
    # pre_stock before any rec reaches here.
    ends = [r for r in valid if r["action_type"] == "endcap"]
    if len(ends) > max(0, endcap_max):
        ends.sort(key=_rank_confidence, reverse=True)
        for rec in ends[max(0, endcap_max):]:
            log.warning("endcap_demoted", reason="over_per_run_cap")
            rec["action_type"] = "promote"
    # Re-rank survivors 1..n so the output is clean and contiguous (trending
    # ranks after the dailies).
    for index, rec in enumerate(valid, start=1):
        rec["rank"] = index

    log.info("validation_complete", valid=len(valid), dropped=dropped)
    return valid, dropped
