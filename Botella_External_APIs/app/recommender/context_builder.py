"""Assemble the full recommendation context for a location.

Sequence:
  1. Fetch the store profile, then geocode its address if it has no coordinates.
  2. Concurrently: gather external signals, fetch inventory, fetch sales.
  3. Compute velocity / health / summary / candidates in-memory.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import httpx
from anthropic import AsyncAnthropic

from app.clients.geocode import Geocoder
from app.clients.node_api import NodeApiClient
from app.clients.signal_cache import SignalCache
from app.config import Settings
from app.logging_config import get_logger
from app.schemas.context import RecommendationContext
from app.schemas.feedback import FeedbackParams
from app.schemas.store import StoreProfile, TrendProof
from app.signals import gather_signals, instagram, registers, social
from app.signals.capture import RawPayloadCollector, SignalRecorder
from app.store_data import compute_derived, prioritize_history
from app.store_data.canonical_demand import CanonicalDemandMap, fetch_canonical_demand
from app.store_data.categorize import is_drink_term
from app.store_data.store_intel import StoreIntel, fetch_store_intel

log = get_logger(__name__)


async def _ensure_geo(store: StoreProfile, geocoder: Geocoder) -> StoreProfile:
    """Populate latitude/longitude from the address when Node didn't supply them."""
    if store.has_geo or not store.is_us:
        return store
    address = store.oneline_address
    if not address:
        return store
    coords = await geocoder.geocode(address)
    if coords is None:
        return store
    lat, lng = coords
    log.info("geocoded", location_id=store.id, latitude=lat, longitude=lng)
    return store.model_copy(update={"latitude": lat, "longitude": lng})


async def build_context(
    client_id: int,
    location_id: int,
    *,
    node_client: NodeApiClient,
    signal_http: httpx.AsyncClient,
    geocoder: Geocoder,
    settings: Settings,
    signal_cache: SignalCache | None = None,
    anthropic_client: AsyncAnthropic | None = None,
    recorder: SignalRecorder | None = None,
    collector: RawPayloadCollector | None = None,
) -> RecommendationContext:
    store = await node_client.get_profile(client_id, location_id)
    had_geo = store.has_geo
    store = await _ensure_geo(store, geocoder)
    if recorder is not None:
        # Where the coordinates came from, recorded because it explains the
        # geo-scoped signals: "no weather" reads very differently when the
        # address failed to geocode than when the forecast was simply quiet.
        recorder.geo_source = (
            "profile" if had_geo else ("geocoded" if store.has_geo else "none")
        )

    async def _canonical() -> CanonicalDemandMap | None:
        # One-number rule: the storeagent demand engine's per-SKU rates and
        # reorder quantities, so quantity hints quote the Buying tab's exact
        # figures. Soft-fails to None (legacy Node-feed math) on any error.
        if not settings.canonical_demand_enabled:
            return None
        return await fetch_canonical_demand(client_id, location_id)

    async def _intel() -> StoreIntel | None:
        # Store-intelligence grounding: don't-buy list, lost sales, velocity
        # classes, market gaps — the same engines behind the Store
        # Intelligence tabs. Shares the demand pull with _canonical (same
        # cache key, single-flight) and soft-fails to None like it.
        if not settings.store_intel_enabled:
            return None
        return await fetch_store_intel(
            client_id, location_id, market_gap_max=settings.market_gap_max_lines
        )

    (signals, inventory, sales, history_feed, co_purchases,
     area_winners, ig_rows, register_rows, canonical, intel,
     card_history_rows, gate_verdict,
     calibration_bundle, signal_effects, lead_times) = await asyncio.gather(
        gather_signals(
            store, signal_http, settings,
            cache=signal_cache, anthropic_client=anthropic_client,
            recorder=recorder, collector=collector,
        ),
        node_client.get_inventory(client_id, location_id),
        node_client.get_sales(client_id, location_id, days=settings.node_sales_window_days),
        # Optional feeds — empty lists until Node implements the endpoints.
        node_client.get_recommendation_history(
            client_id, location_id,
            days=settings.feedback_window_days,
            limit=settings.recommendation_history_limit,
        ),
        node_client.get_co_purchases(
            client_id, location_id, days=settings.node_sales_window_days
        ),
        node_client.get_area_winners(client_id, location_id),
        node_client.get_social_trends(client_id, location_id),
        node_client.get_register_trends(client_id, location_id),
        _canonical(),
        _intel(),
        # N5.1 - the LIFECYCLE feed. One row per SKU already shown, so the
        # selector stops re-issuing a card that has been up for weeks without
        # recovering. Production showed one store the same product FIFTEEN times
        # before this existed. Fail-soft: a 404 leaves the selector with no
        # memory, which is exactly how it behaved before.
        node_client.get_card_history(
            client_id, location_id, days=settings.feedback_window_days
        ),
        # Sheet 17 - the STORE gate verdict, measured offline over a month of
        # ledger and read here by primary key. None when nobody has measured this
        # store, which the cards report as `gate_measured: false` rather than as a
        # failure.
        node_client.get_store_gate_verdict(client_id, location_id),
        # Sheet 08 - the fitted confidence curve. None until one exists, in which
        # case `apply` runs identity and the card keeps declining to state a
        # percentage, exactly as it did before.
        node_client.get_calibration_bundle(client_id, location_id),
        # N4.1 - the measured signal effects. Empty until a fit has been
        # published, which leaves `cold_box` and `pre_stock` silent - exactly as
        # they were before this feed existed, and for the same honest reason.
        node_client.get_signal_effects(client_id, location_id),
        # Checklist 16 - per-SKU delivery lead time with provenance. Empty until
        # a store has uploaded invoices with receipt dates (migration 037), in
        # which case every quantity rests on the declared default and the card
        # says so - exactly as before, minus the pretence that seven was a fact.
        node_client.get_lead_times(client_id, location_id),
    )

    # Instagram quantification (§1.8) and register-measured discovery (§1.9):
    # both merge onto the social channel BEFORE the trend-validation slice
    # below, so an Instagram-surfaced drink also gets register-proofed and a
    # register-discovered category rides the same TREND rendering. Keys join
    # active_keys for the same reason every source's do — the validator
    # rejects citations of keys that aren't active.
    ig_signals, ig_categories, ig_keywords = instagram.to_signals(ig_rows, settings)
    reg_signals, reg_categories, reg_keywords = registers.to_signals(register_rows, settings)
    if ig_signals or reg_signals:
        merged = social.combine(signals.social, ig_signals + reg_signals)
        new_keys = {s.key for s in ig_signals + reg_signals if s.key}
        signals = signals.model_copy(
            update={
                "social": merged,
                "active_keys": sorted(set(signals.active_keys) | new_keys),
                "trend_categories": sorted(
                    set(signals.trend_categories) | set(ig_categories) | set(reg_categories)
                ),
                "trend_product_keywords": sorted(
                    set(signals.trend_product_keywords) | set(ig_keywords) | set(reg_keywords)
                ),
            }
        )

    # Social budget: cap the merged trend channel so the strip and ACTIVE
    # SIGNALS keep room for weather, sports, events, holidays, news, and
    # email, and ration pure register entries to one (they are one metric
    # read many times; unrationed they filled every kept slot). Runs
    # unconditionally: the register ration applies even when the channel is
    # under the total cap. Keys of dropped terms leave active_keys too (every
    # social key is trend_-prefixed), so the model can never cite a trend the
    # owner cannot see — the orphan-key rule holds under the cap.
    kept_social = social.cap_by_evidence(
        signals.social, settings.social_signals_max,
        register_max=settings.register_signals_max,
    )
    if kept_social != signals.social:
        kept_keys = {t.key for t in kept_social if t.key}
        signals = signals.model_copy(
            update={
                "social": kept_social,
                "active_keys": sorted(
                    {k for k in signals.active_keys if not k.startswith("trend_")}
                    | kept_keys
                ),
            }
        )
        log.info(
            "social_signals_capped",
            kept=[t.term for t in kept_social],
            cap=settings.social_signals_max,
        )

    # Trend terms only exist after the signal gather, so this one optional call
    # runs sequentially: "is that trending drink actually selling at nearby
    # registers?" Fail-soft like every optional feed — empty until Node ships
    # the endpoint, and a failure never sinks the run.
    # Close the discovery -> measurement loop: report the run's observed trend
    # terms so Node's Instagram poller can start measuring them from its next
    # daily tick (contract §1.8 dynamic vocabulary). Instagram-sourced entries
    # are excluded (already tracked). Best-effort — never sinks the run.
    observed = [
        {"term": t.term, "display_term": t.term, "source": t.source}
        for t in signals.social
        if "instagram" not in t.source and is_drink_term(t.term)
    ][:15]
    if observed:
        await node_client.post_observed_terms(client_id, location_id, terms=observed)

    # ── RECORD WHAT WE JUST SAW ────────────────────────────────────────────
    #
    # Until this existed, `signal_history` had 35 calendar keys and 2 archived
    # weather keys and nothing else - no home fixture, no concert, no social
    # trend, ever, because the only writer was a backfill script. So `cold_box`
    # and `pre_stock` refused for want of a measurement that nothing was
    # collecting, and the honest answer to "why does no card mention the game"
    # was "because we have never written down that a game happened".
    #
    # Written for TODAY only, with origin 'captured'. A calendar row can be
    # regenerated from a date; this cannot, which is exactly why it has to be
    # recorded as it goes rather than reconstructed later.
    frontier = (max((r.sale_date for r in sales), default=None)
                or datetime.now(UTC).date())
    captured = [
        {
            # The DATA frontier, not wall-clock. The signals were gathered for
            # today, but every other date in this system is anchored to the latest
            # sale - and a history whose dates do not line up with the sales series
            # cannot be joined to it, which is the one thing it exists for.
            "as_of": frontier.isoformat(),
            "signal_key": key,
            # No strength. Every key here is a binary "this was active today", and
            # a fabricated 1.0 would later be averaged with a real captured
            # intensity and called measured.
            "strength": None,
            "source": "signals.gather",
            "origin": "captured",
        }
        for key in sorted(set(signals.active_keys or ()))
    ]
    if captured:
        await node_client.post_signal_history(
            client_id, location_id, rows=captured)
        log.info("signal_history_captured", client_id=client_id,
                 location_id=location_id, keys=len(captured))

    trend_proof: list[TrendProof] = []
    # Register-sourced terms are ALREADY register-measured — re-validating
    # them would burn the §1.7 fan-out budget re-proving the discovery.
    trend_terms = [t.term for t in signals.social if "registers" not in t.source][:8]
    if trend_terms:
        trend_proof = await node_client.get_trend_validation(
            client_id, location_id, terms=trend_terms
        )

    # Defensive bound: keep voted recs first, then the most recent, so the
    # feedback digest and prompt never balloon if Node returns more than asked.
    history_fetched = len(history_feed.rows)
    history = prioritize_history(history_feed.rows, settings.recommendation_history_limit)

    log.info(
        "context_fetched",
        client_id=client_id,
        location_id=location_id,
        inventory_count=len(inventory),
        sales_rows=len(sales),
        history_rows=history_fetched,
        history_used=len(history),
        learned_proven=len(history_feed.learned.proven),
        learned_avoid=len(history_feed.learned.avoid),
        co_purchase_pairs=len(co_purchases),
        area_winners=len(area_winners),
        trend_proofs=len(trend_proof),
        active_signals=signals.active_keys,
        canonical_demand="ok" if canonical is not None else "unavailable",
        store_intel="ok" if intel is not None else "unavailable",
    )

    context = compute_derived(
        store=store,
        signals=signals,
        inventory=inventory,
        sales=sales,
        now=datetime.now(UTC),
        candidate_pool_size=settings.candidate_pool_size,
        small_format_max_ml=settings.small_format_max_ml,
        classify_uncategorized=settings.category_name_fallback,
        past_recommendations=history,
        learned=history_feed.learned,
        co_purchases=co_purchases,
        area_winners=area_winners,
        trend_proof=trend_proof,
        feedback_window_days=settings.feedback_window_days,
        feedback_params=FeedbackParams(
            lift_weight=settings.feedback_lift_weight,
            user_weight=settings.feedback_user_weight,
            winner_threshold=settings.feedback_winner_threshold,
            loser_threshold=settings.feedback_loser_threshold,
        ),
        canonical=canonical,
        intel=intel,
    )

    # Kept for the deterministic selector; see RecommendationContext.sales.
    context.sales = sales
    # The lifecycle feed, carried raw. The selector turns it into CardHistory,
    # because the second half of each record - units sold since, over how many
    # OPEN days - is measured from `sales`, which it already holds.
    context.card_history_rows = list(card_history_rows or [])
    #: The store's measured gate inputs, or None. Carried raw so the card builder
    #: applies the SAME `serving_decision` rule the batch applied - two
    #: implementations of one rule is how an estate ends up with two answers.
    context.gate_verdict = gate_verdict
    #: The serialised calibration bundle, or None. Carried raw; the card builder
    #: deserialises and applies it, so one module owns the key shape.
    context.calibration_bundle = calibration_bundle
    #: The measured signal effects, raw. The pipeline turns them into
    #: `SignalEffect` objects keyed on (signal_key, drink family), which is the
    #: shape `cold_box` and `pre_stock` ask for.
    context.signal_effects = list(signal_effects or [])
    #: Per-SKU lead time with provenance, keyed by SKU. The policy reads it to
    #: size against a measured vendor and to say which basis the number has.
    context.lead_times = dict(lead_times or {})

    log.info(
        "context_built",
        client_id=client_id,
        location_id=location_id,
        candidate_count=len(context.candidates),
        data_as_of=context.data_as_of.isoformat(),
    )
    return context
