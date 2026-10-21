"""End-to-end orchestration for one location, plus bulk fan-out.

Single store:  build_context -> build_prompt -> LLM -> validate -> RunResult.
Bulk:          many stores either concurrently (live) or via one Message Batch.

The service is stateless: results are returned to the caller (the cron / Node
side) which persists them. Nothing is written to a database here.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable, Sequence
from datetime import UTC, date, datetime, timedelta
from typing import Any, TypeVar

import httpx
from anthropic import AsyncAnthropic

from app import __version__
from app.clients.geocode import Geocoder
from app.clients.node_api import NodeApiClient
from app.clients.signal_cache import SignalCache
from app.config import Settings
from app.exceptions import BatchNotFinishedError, NoCandidatesError, ServiceError
from app.logging_config import get_logger
from app.recommender.context_builder import build_context
from app.recommender.llm_client import LLMRecommender
from app.recommender.prompt_builder import build_prompt
from app.pipeline.candidates import event_playbook_builder
from app.pipeline.candidates.merchandise import is_merchandise as catalogue_allows
from app.pipeline.context import RunContext
from app.pipeline.rank.portfolio import CASH_BUDGET
from app.pipeline.registry import cfg
from app.recommender import deterministic, families, narrate, quantity, slate
from app.pipeline.features.taxonomy import category_family_of
from app.recommender.families import (
    signal_effects_from_rows,
    signal_status_from_rows,
)
from app.recommender.validator import validate_recommendations
from app.schemas.bulk import (
    BatchStatus,
    BatchSubmission,
    BulkRunError,
    BulkRunResult,
    LocationRef,
)
from app.schemas.context import RecommendationContext
from app.schemas.recommendation import (
    CardRetirement as CardRetirementOut,
    EngineInfo,
    Recommendation,
    RunResult,
    SignalCapture,
)
from app.schemas.signals import BUY_AHEAD_IMPACTS, SignalBundle
from app.signals.capture import (
    RawPayloadCollector,
    SignalRecorder,
    make_response_hook,
    resolve_day_key,
)
from app.signals.events import keys_for_event
from app.signals.mapping import expand_families
from app.store_data.categorize import norm_text

log = get_logger(__name__)


def _supply_news_index(signals: SignalBundle) -> dict[str, dict]:
    """key -> affected categories/keywords for buy-ahead news items, the
    validator's basis for "supply_risk means pre_stock, not promote"."""
    index: dict[str, dict] = {}
    for n in signals.news:
        if n.key and n.impact in BUY_AHEAD_IMPACTS:
            index[n.key] = {
                "categories": expand_families(set(n.categories)),
                "keywords": {
                    hint for kw in n.product_keywords if (hint := norm_text(kw).strip())
                },
            }
    return index


def _chill_driver_keys(signals: SignalBundle, today: date, window_days: int) -> set[str]:
    """Citable keys of drink-now demand drivers landing within ``window_days``
    — what a cold_box recommendation must cite to survive validation."""
    keys: set[str] = set()
    if "heat_advisory" in signals.active_keys:
        keys.add("heat_advisory")

    def _parse(raw: str | None) -> date | None:
        try:
            return date.fromisoformat(raw or "")
        except ValueError:
            return None

    def _within(start_raw: str | None, end_raw: str | None = None,
                nights: int = 1) -> bool:
        """True when the driver's date RANGE overlaps [today, today+window].

        Multi-night runs are judged by the whole range, not the opener (a
        series that opened yesterday and runs through tomorrow IS a drink-now
        driver). The 1-day grace on the lower bound absorbs venue-local vs
        UTC date skew: an evening run sees "today" as the store's tomorrow.
        """
        start = _parse(start_raw)
        if start is None:
            return False
        end = _parse(end_raw) or start + timedelta(days=max(0, nights - 1))
        return (start - today).days <= window_days and (end - today).days >= -1

    for g in signals.sports:
        if g.is_local_home and _within(g.date, g.end_date, g.games):
            keys.add(f"{g.league}_home_game")
    for e in signals.events:
        if _within(e.date, nights=e.nights):
            keys |= keys_for_event(e)
            if e.key:
                keys.add(e.key)
    for h in signals.holidays:
        if 0 <= h.days_away <= window_days:
            keys.add(h.key)
    return keys

T = TypeVar("T")
R = TypeVar("R")


async def gather_with_limit(
    items: Sequence[T], runner: Callable[[T], Awaitable[R]], limit: int
) -> list[R | BaseException]:
    """Run ``runner`` over ``items`` with at most ``limit`` concurrent tasks.

    Results align positionally with ``items``; a raised exception is returned in
    place rather than cancelling siblings (so one bad store never sinks a bulk
    run). The caller decides how to map exceptions to errors.
    """
    sem = asyncio.Semaphore(max(1, limit))

    async def _one(item: T) -> R:
        async with sem:
            return await runner(item)

    return await asyncio.gather(
        *(_one(item) for item in items), return_exceptions=True
    )


def _error_for(pair: LocationRef, exc: BaseException) -> BulkRunError:
    code = exc.error_code if isinstance(exc, ServiceError) else "internal_error"
    return BulkRunError(
        client_id=pair.client_id,
        location_id=pair.location_id,
        code=code,
        message=str(exc) or exc.__class__.__name__,
    )


class RecommendationPipeline:
    def __init__(
        self,
        settings: Settings,
        node_client: NodeApiClient,
        signal_http: httpx.AsyncClient,
        anthropic_client: AsyncAnthropic,
        geocoder: Geocoder,
        signal_cache: SignalCache | None = None,
    ) -> None:
        self._settings = settings
        self._node = node_client
        self._signal_http = signal_http
        self._geocoder = geocoder
        # Raw upstream bodies are keyed by GEOGRAPHY, not by store, so one
        # process-wide buffer is correct: whichever run drains it, the rows
        # upsert to the same (source, geo, date) keys. See app.signals.capture.
        self._raw_collector = RawPayloadCollector()
        # Bodies reach the buffer through a response hook on the SIGNAL client
        # only. Attaching it here rather than in main.py keeps the collector
        # and its feed in one place, and means a pipeline built directly in a
        # test captures exactly like the real one. Requests made outside a
        # registered fetch (the geocoder, the health probes) have no active
        # fetch context and are ignored.
        #
        # Guarded: several call sites legitimately pass no HTTP client at all
        # (bulk tests that never reach a signal fetch, and any caller stubbing
        # the transport). Raw capture is an optional observability layer, so a
        # client that cannot carry the hook simply does not get one - it must
        # not be the thing that stops a pipeline being constructed.
        hooks = getattr(signal_http, "event_hooks", None)
        if isinstance(hooks, dict):
            hooks.setdefault("response", []).append(
                make_response_hook(self._raw_collector)
            )
        self._signal_cache = signal_cache
        self._anthropic = anthropic_client
        self._llm = LLMRecommender(anthropic_client, settings)

    # ----- health -----------------------------------------------------------

    # Fail-soft signal sources degrade SILENTLY in runs (that is the design:
    # a dead source never sinks recommendations), so upstream blocks would
    # otherwise only show as missing signals. Probing them here makes the
    # deploy preflight / any uptime monitor surface an outage loudly instead.
    # Google Trends is deliberately absent: probing it would burn the same
    # throttle budget the real daily fetch needs. Key-gated sources
    # (Ticketmaster, NewsData) are also skipped — reachability of their edges
    # says nothing without spending keyed calls.
    _SIGNAL_PROBES: tuple[tuple[str, str], ...] = (
        (
            "espn_primary",
            "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?limit=1",
        ),
        (
            "espn_mirror",
            "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?limit=1",
        ),
        ("nws_weather", "https://api.weather.gov/"),
    )

    async def deep_health(self) -> dict[str, str]:
        """Readiness checks: the two upstreams a run cannot live without, plus
        reachability of the keyless fail-soft signal sources (sports serves
        from whichever ESPN host answers — degraded means the fallback chain
        has lost a link, not that runs are failing)."""
        checks: dict[str, str] = {}
        checks["node_api"] = "ok" if await self._node.ping() else "unreachable"
        try:
            await self._anthropic.models.list(limit=1)
            checks["anthropic"] = "ok"
        except Exception as exc:  # any failure shape -> not ready
            checks["anthropic"] = f"error: {exc.__class__.__name__}"
        for name, url in self._SIGNAL_PROBES:
            try:
                resp = await self._signal_http.get(url, timeout=5)
                checks[name] = "ok" if resp.status_code < 400 else f"http {resp.status_code}"
            except httpx.HTTPError as exc:
                checks[name] = f"error: {exc.__class__.__name__}"
        return checks

    # ----- shared building blocks -----------------------------------------

    async def _build_recorded(
        self, pair: LocationRef
    ) -> tuple[RecommendationContext, SignalRecorder]:
        """Build one store's context with its own recorder attached.

        The batch paths go through this rather than calling _build_context
        bare, so a batched store captures exactly what a live store does.
        Without it, batch runs would silently persist display-trimmed signal
        rows while live runs persisted full ones - the kind of split that only
        shows up much later as an unexplained gap in the training data.
        """
        recorder = SignalRecorder()
        ctx = await self._build_context(pair.client_id, pair.location_id, recorder)
        return ctx, recorder

    async def _build_context(
        self, client_id: int, location_id: int,
        recorder: SignalRecorder | None = None,
    ) -> RecommendationContext:
        context = await build_context(
            client_id,
            location_id,
            node_client=self._node,
            signal_http=self._signal_http,
            geocoder=self._geocoder,
            settings=self._settings,
            signal_cache=self._signal_cache,
            anthropic_client=self._anthropic,
            recorder=recorder,
            collector=self._raw_collector if recorder is not None else None,
        )
        if not context.candidates:
            # ── AN EMPTY SHELF IS AN ANSWER, NOT A 404 ─────────────────────
            #
            # This used to raise, and the store owner saw an ERROR PAGE. For a
            # newly onboarded store whose POS has not synced yet - ten of the
            # fourteen in the October cohort - "no in-stock candidate products"
            # is the plain truth about the shelf, not a failure of the request.
            # The run continues and returns an empty slate, which every consumer
            # already handles: the portfolio treats abstention as an answer and
            # says so in those words.
            #
            # It also stops the nightly batch crying wolf. Now that the batch
            # covers all 201 stores rather than one, raising here would log a
            # failure for every store without stock - roughly 150 of them - and
            # bury the handful of real errors underneath.
            #
            # `candidate_count == 0` on the result is what distinguishes this
            # from "we had candidates and none were worth a card", so nothing is
            # lost by not raising.
            log.info("no_candidates_empty_slate", client_id=client_id,
                     location_id=location_id,
                     inventory=len(context.inventory_health),
                     sales_rows=len(context.sales))
        return context

    def _build_capture(
        self,
        context: RecommendationContext,
        recorder: SignalRecorder | None,
        generated_at: datetime,
    ) -> SignalCapture | None:
        """The day's full signal record for the Node side to persist.

        Distinct from ``signal_snapshot`` on the result, which is the capped
        chip list the owner sees. This is the engine's whole input plus the
        health that explains any gap - see app.signals.capture and analytics
        migration 014.

        Returns None when no recorder ran; Node then stores the trimmed
        snapshot, honestly marked as such, rather than mislabelling it.
        """
        if recorder is None:
            return None
        signal_date, day_basis = resolve_day_key(generated_at, recorder.timezone)
        return SignalCapture(
            bundle=context.signals.model_dump(mode="json"),
            signal_date=signal_date,
            day_basis=day_basis,
            timezone=recorder.timezone if day_basis == "store_local" else None,
            source_health=recorder.health(),
            source_geo_keys=recorder.geo_keys,
            latitude=context.store.latitude,
            longitude=context.store.longitude,
            state=context.store.state,
            geo_source=recorder.geo_source,
            # Drains the process-wide buffer: these rows are geo-keyed, so it
            # does not matter which run carries them home.
            raw_payloads=self._raw_collector.drain(),
        )

    async def _narrate_cards(
        self, raw_recs: list[dict], context: RecommendationContext,
        client_id: int, location_id: int,
    ) -> list[dict]:
        """Rewrite each card body with the model, keeping the engine's figures.

        LAW 1 IS INTACT. Nothing here can alter which products were chosen, the
        quantities, the ranking or the budget - all of that is already in
        `raw_recs` and this only replaces `rationale`. The LLM-choosing arm scored
        24.2% against the engine's 75.9% and took every store to zero cards during
        a billing failure; narration cannot do either, because every failure path
        returns the engine's own sentence.

        Degrades in three independent ways, all to today's behaviour: no Anthropic
        client, the setting at zero, or a model that errors, declines, writes too
        much or writes a number the engine did not compute.
        """
        if self._llm is None or not raw_recs:
            return raw_recs
        ctx = RunContext(
            run_id=f"live-narrate-{client_id}-{location_id}-{context.data_as_of}",
            tenant_id=client_id, store_id=location_id, as_of=context.data_as_of,
            snapshot_id=f"snap-{context.data_as_of}", config_version="default",
            seed=0, versions={"narrate": "1.0.0"},
        )
        budget = int(cfg.get(narrate.MAX_NARRATED_CARDS, ctx))
        if budget <= 0:
            return raw_recs

        names = {sku: info.name for sku, info in context.catalogue.items()}
        active = list(getattr(context.signals, "active_keys", []) or [])
        # WHAT HAS ACTUALLY BEEN MEASURED about those signals, so the model is not
        # left to assume a live signal means a sales effect. For almost all of them
        # the honest line is that we looked and the data cannot tell, and saying so
        # in the prompt is what stops the causal sentence being written at all.
        measured = signal_effects_from_rows(
            getattr(context, "signal_effects", ()) or ())
        notes = [
            f"{key} affects {family} by {effect.beta:+.1%} at this store "
            f"(measured, interval excludes zero)"
            for (key, family), effect in sorted(measured.items())
        ] or ["no signal has a measured effect on sales at this store; "
              "488 of 489 cells refused against day-of-week, month and trend "
              "controls"]

        # THE SIGNALS IN FULL, not just their keys. `active_keys` are tokens -
        # `nba_home_game`, `event_concert` - and a card cannot say anything an
        # owner recognises from a token. These are the labelled, dated lines the
        # signal clients actually returned, and `signal_literals` is what lets a
        # date among them survive the numeral check instead of costing the whole
        # sentence. See narrate.signal_lines.
        signal_facts = list(narrate.signal_lines(context.signals, measured))
        signal_literals = narrate.signal_literals(signal_facts)

        narrated = 0
        out: list[dict] = []
        for card in raw_recs:
            if narrated >= budget:
                out.append(card)
                continue
            user = narrate.build_user_prompt(
                card, store_name=context.store.name or str(location_id),
                product_names=names, active_signals=active, signal_notes=notes,
                signal_facts=signal_facts,
            )
            sentence = await self._llm.narrate(narrate.SYSTEM, user)
            result = narrate.ground(sentence, card, ctx, cfg, product_names=names,
                                    signal_facts=signal_literals)
            narrated += 1
            # WHICH SIGNAL THIS CARD ACTUALLY NAMES.
            #
            # `signals_cited` was set to [] on every deterministic card and
            # stayed that way - 0 of 44 cards cited anything on the last live
            # run, at stores with ten live signals. So an owner could see the
            # signals in the panel and never on a card, and reasonably conclude
            # the engine ignores them.
            #
            # Filled from the sentence that was ACCEPTED, not from what was
            # live: "cited" has to mean this card refers to it. A card that
            # mentions nothing still cites nothing, which is the honest answer
            # and leaves the panel as the place to see the rest.
            cited = [line for line in signal_facts
                     if narrate.mentions(result.sentence, line)]
            out.append({**card,
                        "rationale": result.sentence,
                        "rationale_source": result.source,
                        "rationale_engine": card.get("rationale") or "",
                        **({"signals_cited": cited} if cited else {}),
                        **({"rationale_refused": result.refused}
                           if result.refused else {})})
        log.info("cards_narrated", client_id=client_id, location_id=location_id,
                 cards=len(raw_recs), attempted=narrated,
                 from_model=sum(1 for c in out
                                if c.get("rationale_source") == "model"))
        return out

    # ----- the signal impact block, on EVERY card ---------------------------

    def _attach_signal_impact(
        self,
        cards: list[dict],
        context: Any,
    ) -> list[dict]:
        """Stamp every card with what each LIVE signal was found to do here.

        WHAT WAS WRONG. An owner saw "3 events" in the signals panel and not one
        word about them on any card, and concluded the engine ignores the feeds.
        It does not: 639 cells are fitted across the five pilot stores. Ten are
        citable. The other 629 were examined and refused - ~460 of them with
        `too_few_active_days:4<20`, because a per-store fit cannot measure an
        event that happens once a year. None of that reached the card, so the
        honest answer ("we checked tonight's game and cannot measure it yet") was
        indistinguishable from never having looked.

        THIS DOES NOT LET A REFUSED CELL MOVE A RECOMMENDATION. Nothing here
        touches a quantity, a score, an order or `signals_cited`. `cold_box` and
        `pre_stock` still refuse without a citable effect, and
        `signal_effects_from_rows` still drops every refusal before a family sees
        it. This block is a DISCLOSURE: what was looked at, and what was found.

        A REFUSED CELL CARRIES NO NUMBER. `beta` is null with a reason, never 0.0 -
        a zero would say "measured, and the signal does nothing here", and the
        commonest refusal means the event has not occurred often enough to measure
        at all. Presenting the second as the first is the one way this block could
        become a lie, so `signal_status_from_rows` is the only thing that fills it.

        NEVER EMPTY, so that silence can no longer be mistaken for indifference. A
        store with no live signal today gets a block saying exactly that.
        """
        statuses = signal_status_from_rows(
            getattr(context, "signal_effects", ()) or ())
        active = [
            str(key).strip()
            for key in (getattr(getattr(context, "signals", None),
                                "active_keys", None) or ())
            if str(key or "").strip()
        ]
        catalogue = getattr(context, "catalogue", None) or {}

        def family_of(card: dict) -> str | None:
            skus = card.get("primary_skus") or []
            info = catalogue.get(skus[0]) if skus else None
            return category_family_of(getattr(info, "pos_category", "") or "")

        measured_cells = sum(1 for st in statuses.values()
                             if st.state == "measured")
        out: list[dict] = []
        for card in cards:
            family = family_of(card)
            entries: list[dict] = []
            for key in active:
                # The cell for THIS card's drink family. A store-wide row is not
                # substituted: an effect measured on beer says nothing about the
                # wine on this card, and quietly reusing it is how a card acquires
                # a number that was never fitted for it.
                status = statuses.get((key, family)) if family else None
                if status is None:
                    entries.append({
                        "signal_key": key, "family": family,
                        "state": "not_fitted", "beta": None,
                        "interval_lo": None, "interval_hi": None,
                        "reason": ("no fit exists yet for this signal against "
                                   f"{family or 'this product type'}"),
                        "active_days": None, "observations": None,
                    })
                    continue
                entries.append({
                    "signal_key": status.key, "family": status.family,
                    "state": status.state, "beta": status.beta,
                    "interval_lo": status.interval_lo,
                    "interval_hi": status.interval_hi,
                    "reason": status.reason,
                    "active_days": status.active_days,
                    "observations": status.observations,
                })

            # Measured first and by effect size, because that is the only part an
            # owner can act on; the refusals follow in a stable order so the block
            # does not reshuffle between runs for no reason.
            entries.sort(key=lambda e: (
                {"measured": 0, "not_measurable": 1}.get(e["state"], 2),
                -abs(e["beta"] or 0.0),
                e["signal_key"],
            ))
            shown = sum(1 for e in entries if e["state"] == "measured")
            if not entries:
                summary = ("no external signal was live for this store today, so "
                           "none could affect this card")
            elif shown:
                lead = entries[0]
                summary = (
                    f"{len(entries)} live signal(s) checked against "
                    f"{lead['family']}; {shown} measurable - "
                    f"{lead['signal_key']} {lead['beta']:+.1%} "
                    f"[{lead['interval_lo']:+.1%}, {lead['interval_hi']:+.1%}]")
            else:
                summary = (
                    f"{len(entries)} live signal(s) checked against "
                    f"{family or 'this product'}; none measurable yet - "
                    f"{entries[0]['reason']}")
            out.append({**card,
                        "signal_impact": entries,
                        "signal_impact_summary": summary})

        log.info("signal_impact_attached",
                 cards=len(out), live_signals=len(active),
                 fitted_cells=len(statuses), measured_cells=measured_cells)
        return out

    def _event_playbooks(
        self, context: RecommendationContext, client_id: int, location_id: int,
    ) -> list[families.ExtraPick]:
        """Playbooks for the events whose ALERT DATE has arrived.

        An empty list is the normal answer for most of the year, and it is an
        answer rather than a failure: `due_events` returns the events an owner
        should be hearing about NOW, which is `event - window - lead time -
        safety buffer`. On 6 October 2026 that set is empty; Halloween enters it
        on the 16th. Telling a store about Halloween in June is not a service.

        NEEDS NO NEW STORAGE, and that is the design. The uplift compares what
        sold during past occurrences against matched weekdays around them, so
        every number comes from the sales series the selector already holds.
        Nothing to publish, nothing to go stale, nothing to 404.

        Never raises. A playbook that cannot be built is a card the store does
        not get, not a run that fails.
        """
        sales = getattr(context, "sales", None) or []
        if not sales:
            return []
        try:
            by_sku, trading_days = deterministic.daily_series(sales)
            if not trading_days:
                return []
            as_of = context.data_as_of
            ctx = RunContext(
                run_id=f"live-playbook-{client_id}-{location_id}-{as_of}",
                tenant_id=client_id, store_id=location_id, as_of=as_of,
                snapshot_id=f"snap-{as_of}", config_version="default", seed=0,
                versions={"event_playbook": "1.0.0", "event_uplift": "1.0.0"},
            )
            due = event_playbook_builder.due_events(
                as_of=as_of, lead_time_days=deterministic.LEAD_TIME_DAYS,
                ctx=ctx,
            )
            if not due:
                log.info("event_playbook_none_due", client_id=client_id,
                         location_id=location_id, as_of=str(as_of))
                return []

            # The money, from the one map every other money figure now reads -
            # AND THE MERCHANDISE SCREEN, which this path did not apply.
            #
            # Found by reading the output rather than the tests: the first wiring
            # produced order lines for "3 x CALLING CARD" at Northlake and
            # "7 x BLK N MILD SINGLE" (cigars), because `build_for_event` iterates
            # whatever series it is handed and the reorder path is where the screen
            # lived. A SKU with no facts is skipped by the builder, so withholding
            # facts IS the screen here.
            #
            # Note what it does NOT remove: soda, water, energy drinks and nicotine
            # pouches are real stock a liquor store sells and reorders, so they stay.
            # And "ICE CUBES 7LBS" stays too - the term list deliberately matches
            # ice only as a phrase ("ice bag", "cubed ice"), because "ice cube"
            # matches 25 catalogue names of which most are real products: Ice
            # Breakers chewing gum, Colossal ice cube trays, Herb and Lou's
            # cocktail cubes. One bag of ice is the cheaper error.
            facts = {}
            for sku, info in context.catalogue.items():
                if not catalogue_allows(sku, info.name, info.unit_price, ctx):
                    continue
                facts[sku] = event_playbook_builder.SkuFacts(
                    name=info.name or sku,
                    unit_cost=info.unit_cost,
                    unit_margin=slate.Money(unit_price=info.unit_price,
                                            unit_cost=info.unit_cost).unit_margin,
                )

            out: list[families.ExtraPick] = []
            for event_key, year in due:
                playbook = event_playbook_builder.build_for_event(
                    event_key=event_key, year=year,
                    daily_by_sku=by_sku, trading_days=trading_days,
                    facts_by_sku=facts,
                    lead_time_days=deterministic.LEAD_TIME_DAYS,
                    # ONE event, ONE commitment. The declared per-cycle figure is
                    # the right size here even though the slate's budget is now
                    # measured: a playbook is a single order an owner places in one
                    # go, and $2,000 is what that setting's own `why` describes.
                    # Handing it the store's whole replacement spend would let one
                    # card ask for a month of purchasing.
                    cash_budget=float(cfg.get(CASH_BUDGET, ctx)),
                    ctx=ctx,
                )
                if playbook is None or not playbook.lines:
                    continue
                out.extend(families.event_playbook(
                    playbook, occurrences=playbook.min_occurrences))
            log.info("event_playbooks_built", client_id=client_id,
                     location_id=location_id, due=len(due), cards=len(out),
                     events=[k for k, _y in due])
            return out
        except Exception as exc:  # noqa: BLE001 - a card must never sink a run
            log.warning("event_playbook_failed", client_id=client_id,
                        location_id=location_id, error=str(exc))
            return []

    def _assemble(
        self,
        client_id: int,
        location_id: int,
        context: RecommendationContext,
        raw_recs: list[dict],
        recorder: SignalRecorder | None = None,
        engine: EngineInfo | None = None,
        verified_skus: set[str] | None = None,
        # Checklist 17 - the claims the lifecycle retired this run, carried to
        # Node so the retirement date is stored once and honoured afterwards.
        card_retirements: Sequence[Any] = (),
    ) -> RunResult:
        today = datetime.now(UTC).date()
        valid_recs, dropped = validate_recommendations(
            raw_recs,
            context.candidates,
            max_recommendations=self._settings.max_recommendations,
            max_trending=self._settings.trending_max_recommendations,
            verified_skus=verified_skus,
            active_signal_keys=context.signals.active_keys,
            today=today,
            horizon_days=self._settings.holiday_lookahead_days,
            area_winners=context.area_winners,
            trend_proof=context.trend_proof,
            supply_news=_supply_news_index(context.signals),
            chill_driver_keys=_chill_driver_keys(
                context.signals, today, self._settings.cold_box_driver_days
            ),
            cold_box_max=self._settings.cold_box_max_per_run,
            endcap_max=self._settings.endcap_max_per_run,
            canonical_qty=context.canonical_qty,
            register_trend_keys={
                s.key for s in context.signals.social
                if s.key and "registers" in (s.source or "")
            },
            register_trend_max=self._settings.register_trend_recs_max,
            small_format_exclude_ml=self._settings.small_format_max_ml,
            store_intel=context.intel,
            market_gap_max=self._settings.market_gap_recs_max,
        )
        # Anthropic does NOT guarantee tool input conforms to the tool schema,
        # so treat each rec as untrusted: one malformed field drops that rec
        # (counted in dropped_invalid) instead of 500-ing the whole store run
        # — or, on the batch path, the whole collect.
        recommendations: list[Recommendation] = []
        for rec in valid_recs:
            try:
                recommendations.append(Recommendation.model_validate(rec))
            except Exception as exc:  # noqa: BLE001 — pydantic ValidationError et al.
                dropped += 1
                log.warning("recommendation_dropped", reason="model_invalid", error=str(exc))
        for index, model in enumerate(recommendations, start=1):
            model.rank = index
        # Keys the surviving recommendations actually cite: the snapshot trim
        # must never orphan a citation, so cited entries always survive it.
        cited_keys = {
            key
            for model in recommendations
            for key in model.signals_cited
            if isinstance(key, str)
        }
        generated_at = datetime.now(UTC)
        return RunResult(
            client_id=client_id,
            location_id=location_id,
            generated_at=generated_at,
            data_as_of=context.data_as_of,
            candidate_count=len(context.candidates),
            recommendations_generated=len(recommendations),
            dropped_invalid=dropped,
            signal_snapshot=context.signals.snapshot(
                display_cap=self._settings.signal_display_cap,
                cited_keys=cited_keys,
            ),
            recommendations=recommendations,
            signal_capture=self._build_capture(context, recorder, generated_at),
            engine=engine,
            card_retirements=[
                CardRetirementOut.model_validate(r.as_dict())
                for r in card_retirements
            ],
        )

    # ----- single store ----------------------------------------------------

    async def run(self, client_id: int, location_id: int) -> RunResult:
        log.info("run_started", client_id=client_id, location_id=location_id)
        started = time.perf_counter()
        # One recorder per store run: health is per store, unlike the raw
        # payloads, which are shared by geography.
        recorder = SignalRecorder()
        context = await self._build_context(client_id, location_id, recorder)

        # ── WHO CHOOSES ──────────────────────────────────────────────────────
        #
        # The engine does. `app/pipeline` selects the products deterministically
        # - temporal reversion, the deficit, the materiality and confidence
        # gates - and no model is consulted about WHICH products to recommend.
        #
        # This used to be `await self._llm.recommend(prompt)`, which made the
        # model the generator. Two consequences, both observed rather than
        # predicted: the ordering could not be argued with or improved because
        # nobody could say what it optimised, and on 29 September 2026 an
        # Anthropic billing failure produced zero recommendations for every
        # store, because the component that CHOOSES could not be reached.
        #
        # Measured on the production modules over 3.7 years: 75.9% against a
        # 31.9% random pick, +16.7 points against a null that already accounts
        # for mean reversion. See ENGINE-ARCHITECTURE-AND-RESULTS.md.
        #
        # The model writes the prose (sheets 15-16), after the decision is fixed
        # and with every numeral checked against the computed figures, so an
        # outage costs fluency and never a recommendation.
        #
        # THIS COMMENT WAS FALSE FOR MONTHS. The only `_llm.recommend` call is in
        # the `else` branch below - the superseded arm - so on the path that ships
        # the model was never called at all, and `app/pipeline/explain/` sat
        # unimported by anything in this package. Every card body was a hardcoded
        # f-string, which is why the cards read like arithmetic to an owner and why
        # a page listing a home game and a heat advisory mentioned neither on any
        # card. `_narrate_cards` below is the step that was missing.
        if self._settings.use_deterministic_engine:
            # SIGNAL FAMILIES FIRST, so they are not truncated away.
            #
            # Reorder and markdown come from the store's own arithmetic. These
            # come from a live signal (a heat advisory, a home game), the
            # register's own co-purchase counts, or a product comparable stores
            # sell and this one does not. Separate module because the evidence
            # is weaker and should not be mistaken for the arithmetic - see
            # families.py on what is and is not claimed.
            #
            # They used to be appended AFTER ten stock picks and then cut by
            # max_recommendations, so a heat card or a game-day card appeared
            # only on the days a store happened to have fewer than ten
            # stockouts. A family that shows up only when nothing else does is
            # not a family, it is a gap filler.
            #
            # There are at most a handful of them - one bundle, one cold box,
            # two pre-stock, one new arrival - so reserving their slots costs
            # the stock families very little and makes the slate say more than
            # one thing.
            # Every stocked SKU, not the shortlist. Built from `candidates`
            # this held 99 of store 171's 2,691 SKUs, and the bundle family
            # needs BOTH halves of a pair present to write a sentence - so the
            # store's best-supported real pair (22 baskets) was dropped for
            # want of a name while three register-mechanic pairs survived.
            # WITH THE CATEGORY, or no signal family can ever fire.
            #
            # This dict carried name and size only. `families.effect_for` reads
            # `.get("category")` off it to resolve the drink family, got "",
            # resolved None, and so never found the (signal, family) cell that
            # `effects_by_category=` hands over two calls below - and the
            # store-wide fallback is not passed. `effect_for` therefore returned
            # None for every SKU, and cold_box / pre_stock refused unconditionally
            # at every store, including Bethany with a usable heat_advisory x beer
            # cell of +15.8% sitting published and unread.
            #
            # The unit tests never saw it: they hand the families a catalogue that
            # already carries "category". Same resolution the display path uses
            # in `_attach_signal_impact`, so the two can no longer disagree about
            # what family a SKU is in.
            catalogue = {
                sku: {"name": p.name, "size_ml": p.size_ml,
                      "category": p.pos_category}
                for sku, p in context.catalogue.items()
            }
            # Rates stay on the health view's weekly_rate, which covers the
            # whole inventory rather than the shortlist. A SKU with no health
            # row rates 0 and is simply never the fastest seller - these
            # families rank by rate and never divide by it.
            rates = {
                h.sku: float(getattr(h, "weekly_rate", 0) or 0) / 7.0
                for h in context.inventory_health if getattr(h, "sku", None)
            }
            keys = list(getattr(context.signals, "active_keys", []) or [])
            # {(signal_key, drink family): SignalEffect} from the published fit.
            # Built here rather than in the context so the refusal rule lives in
            # one place: a row the endpoint called usable still has to survive
            # `SignalEffect`'s own interval check, and a row that cannot be parsed
            # is dropped rather than guessed at.
            measured_effects = signal_effects_from_rows(
                getattr(context, "signal_effects", ()) or ())
            extra = (
                families.bundles(context.co_purchases, catalogue, rates)
                # ── THE MEASURED EFFECTS, AT LAST ─────────────────────
                #
                # These two families refuse without one (N3.1) and were being
                # passed none, so they returned [] unconditionally at every store
                # forever. The confound is real and the refusal is right: a
                # festival is SCHEDULED for a weekend that was going to be busy
                # anyway, so the naive version credits the signal for the weekend.
                #
                # Supplying the effects does not make them talkative. 499 of 504
                # cells refused on the first estate-wide fit, and the only usable
                # weather effect in the estate is Marshfield's beer FALLING 11.8%
                # in a cold snap - which `cold_box` correctly reads as a reason to
                # say nothing rather than a reason to stock up.
                + families.cold_box(keys, catalogue, rates,
                                    effects_by_category=measured_effects)
                + families.pre_stock(keys, catalogue, rates,
                                     effects_by_category=measured_effects)
                + families.stock_new(context.area_winners)
                # ── THE EVENT PLAYBOOK, WHICH WAS NEVER CALLED ────────────
                #
                # Built, measured over 453 usable (event x SKU) uplifts, covered
                # by 19 tests, recorded as live - and absent from this list, so
                # the entire chain was reachable from a test and from nothing
                # else. Every signal the engine gathers (5 to 13 active keys a
                # store: home fixtures, heat advisories, concerts, social
                # trends) produced exactly zero cards, and this is the family
                # with the evidence to change that.
                #
                # It is LAST in the list deliberately. `bundles`, `cold_box` and
                # `pre_stock` are single-product cards; a playbook is one card
                # carrying up to thirty lines and one cash commitment, so it is
                # the biggest single ask on the slate and should not displace
                # the cheap ones by arriving first.
                + self._event_playbooks(context, client_id, location_id)
            )

            # `select`, not `choose`: the same picks, plus the retirements the
            # lifecycle decided this morning. Those have to leave this process
            # - Node stores them (migration 034) and hands the date back on
            # tomorrow's card-history feed - or every morning recomputes
            # "today + 14" from a card it re-judges every morning.
            selection = deterministic.select(
                context.sales,
                client_id=client_id,
                location_id=location_id,
                as_of=context.data_as_of,
                # N5.1 - the lifecycle feed. Without it the selector has no
                # memory and re-issues a failing card every morning; production
                # showed one store the same product FIFTEEN times. Empty when
                # Node has not shipped the endpoint, which restores the old
                # behaviour rather than breaking the run.
                #
                # Checklist 17: each row may now also carry the STORED
                # retirement for its SKU (`retired_at`, `suppressed_until`,
                # `retirement_rule`), which the selector honours instead of
                # re-deciding.
                card_history_rows=getattr(context, "card_history_rows", ()) or (),
                # THE WHOLE LIMIT, NOT WHAT IS LEFT OVER AFTER THE SIGNAL CARDS.
                #
                # This used to read `max_recommendations - len(extra)`, which
                # meant a heat advisory did not make the slate better, it made it
                # one reorder shorter, and nothing recorded the trade. The slate
                # was ten slots divided by subtraction, which left
                # `rank/portfolio.py` nothing to allocate because the allocation
                # had already happened in arithmetic.
                #
                # `slate.compose` below now holds the ceiling and applies it once
                # to the whole slate, after the budget has decided how many cards
                # the store's cash actually supports.
                limit=self._settings.max_recommendations,
                # The store's STOCKED catalogue, not `context.candidates` -
                # candidates is a pre-filtered shortlist sized by
                # candidate_pool_size, and using it screened 2,592 of 2,691
                # real SKUs on the first live run.
                #
                # None when inventory is unavailable: the mechanics blocklist
                # still applies, and constraining to an empty set would refuse
                # everything. The product master is missing 43.8% of sold
                # store-SKU pairs estate-wide, so this filter has to be able
                # to stand down.
                orderable=frozenset(
                    h.sku for h in context.inventory_health if getattr(h, "sku", None)
                ) or None,
                # What is already on the shelf. Without it the engine
                # recommends reordering things the store is full of.
                on_hand={
                    # `h.on_hand` is None when the POS sent no count. Carried as
                    # None so the selector can tell an unknown shelf from an
                    # empty one; `or 0` would erase exactly that distinction.
                    h.sku: (None if h.on_hand is None else float(h.on_hand))
                    for h in context.inventory_health if getattr(h, "sku", None)
                } or None,
                # Unit cost, for the capital-tied-up figure on an overstock
                # card. Absent at 78 of the 94 trading stores, where the POS
                # sends no cost at all - those stores simply get no overstock
                # cards rather than cards with a blank where the money goes.
                # Unit cost for the capital-tied-up figure on an overstock
                # card, derived from the SAME rows on_hand comes from so the
                # two cannot disagree: tied_up_capital / on_hand IS the unit
                # cost the inventory view already computed.
                #
                # Absent at 78 of the 94 trading stores, where the POS sends no
                # cost at all - those stores get no overstock cards rather than
                # cards with a blank where the money should be.
                # SKUs the inventory view already calls overstocked. Sheet 14
                # will refuse a markdown without this, and it is the right
                # gate: the store's own classification, not a second opinion
                # from a different window.
                # From `candidates`, not `inventory_health`. Sheet 14 reads
                # Candidate.health_status, and filtering on the other
                # collection's `status` looked equivalent and was not - three
                # markdowns were still refused after the first attempt at this.
                overstocked=frozenset(
                    c.sku for c in context.candidates
                    if getattr(c, "sku", None)
                    and str(getattr(c, "health_status", "")).startswith("overstock")
                ) or None,
                # WHAT THE STORE PAID, and it used to be the retail price.
                #
                # This read `tied_up_capital / on_hand`, and the comment above it
                # claimed that IS the unit cost. It is not:
                # `inventory_health.py` computes `tied_up_capital = on_hand x
                # item.PRICE`, so the division returns the shelf price. Every
                # `holding_cost_if_unsold` on a live card was therefore computed
                # on retail rather than on cost, and every overstock card's
                # "$X tied up on the shelf" was a retail valuation wearing the
                # word capital.
                #
                # The overstock family's own docstring already states the rule
                # this now follows: "Needs a cost. Without one there is no
                # capital figure and no claim - the SKU is skipped rather than
                # shown with a blank." So at a store whose POS sends no cost,
                # overstock cards disappear, which is what that sentence always
                # said should happen. Absence is not a fallback to the nearest
                # available number.
                unit_costs={
                    sku: info.unit_cost
                    for sku, info in context.catalogue.items()
                    if info.unit_cost and info.unit_cost > 0
                } or None,
                # Both were simply never passed, so the catalogue merchandise
                # screen ran blind at the live route - name-based and price-based
                # screening of ice bags, tax lines and deposit keys was doing
                # nothing here while doing its job in the backtest.
                product_names={
                    sku: info.name for sku, info in context.catalogue.items()
                } or None,
                unit_prices={
                    sku: info.unit_price
                    for sku, info in context.catalogue.items()
                    if info.unit_price and info.unit_price > 0
                } or None,
                # Checklist 12. The raw POS category, so the screen that knows
                # a scratchcard is not stock runs here as it does in the harness.
                pos_categories={
                    sku: info.pos_category
                    for sku, info in context.catalogue.items()
                    if info.pos_category
                } or None,
                # Checklist 16. The stockout sentence flags the declared seven
                # and quotes a measured per-vendor figure where one exists.
                lead_times=getattr(context, "lead_times", None) or None,
            )
            picks = selection.picks
            card_retirements = selection.retirements

            # ── THE SLATE AS A PORTFOLIO UNDER A BUDGET ────────────────────
            #
            # Measured before it was wired, over 117 real decision dates: the
            # cash budget binds on 3 of them and the abstention floor on 0 of
            # 811 cards, because sheet 20's deficit gating already collapsed the
            # ask from $17,043 to $340. So this is not an accuracy change and
            # must not be sold as one - see slate.py for the figures.
            #
            # What it fixes is WHO CHOOSES. A store that cannot afford the whole
            # slate was picking a subset by affordability, which overrode the
            # engine's ranking on a criterion nobody recorded.
            # ── THE QUANTITY NOW COMES FROM THE ORDER POLICY ───────────
            #
            # It came from the Buying-tab formula in
            # `storeagent/functions/buying.py`, by way of CanonicalDemandMap:
            #
            #     target = forecast(lead + coverage) * (1 + safety_buffer)
            #
            # A SINGLE-POINT forecast times a flat 20%. But a buffer is a
            # statement about DISPERSION and a point estimate has none, so two
            # SKUs both selling five a day - one steady, one swinging between 0
            # and 30 - got the same 20% and the same order. Measured with the
            # real forecaster, the flat rule is wrong in BOTH directions: it
            # buys 67 of a steady SKU the policy sizes at 59, and 25 of a
            # volatile one the policy sizes at 49. It over-buys the predictable
            # and under-buys the volatile, which is backwards.
            #
            # `policy/inventory.py` sizes the buffer from the forecast's own
            # p10/p90 spread at a service level, and ran only from
            # `scripts/run_decisions.py` - so the measured path and the serving
            # path sized orders by two different rules, in the one place where
            # disagreement costs actual money.
            #
            # SELECTION IS UNTOUCHED. Reversion still chooses the products;
            # `deficit_units` is the selection signal and nothing here touches
            # it. This decides only how many of something already chosen.
            #
            # STILL ON THE OLD MAP: the signal families (cold_box, pre_stock,
            # bundle) are built earlier in this method and keep
            # `context.canonical_qty`. Their quantities are advisory rather
            # than an order to place, and moving them is a separate change.
            policy_qty: dict[str, tuple[int, int]] = {}
            # Its own RunContext, built the way `slate.compose` builds one: the
            # stages this runs (classify, forecast_ensemble, policy_inventory,
            # constraints_apply) record themselves into provenance against it,
            # and a seed of 0 keeps the forecast's bootstrap reproducible for a
            # given store and day.
            qty_ctx = RunContext(
                run_id=f"live-qty-{client_id}-{location_id}-{context.data_as_of}",
                tenant_id=client_id, store_id=location_id,
                as_of=context.data_as_of,
                snapshot_id=f"snap-{context.data_as_of}",
                config_version="default", seed=0,
                versions={"forecast_ensemble": "1.0.0",
                          "policy_inventory": "1.0.0",
                          "constraints_apply": "1.0.0"},
            )
            try:
                quantities = quantity.PolicyQuantities(
                    sales=context.sales, ctx=qty_ctx, config=cfg,
                    horizon_open_days=deterministic.COVERAGE_DAYS,
                    on_hand={
                        h.sku: (None if h.on_hand is None else float(h.on_hand))
                        for h in context.inventory_health
                        if getattr(h, "sku", None)
                    },
                    prices={s: getattr(i, "unit_price", None)
                            for s, i in (context.catalogue or {}).items()},
                    costs={s: getattr(i, "unit_cost", None)
                           for s, i in (context.catalogue or {}).items()},
                    categories={h.sku: getattr(h, "category", None)
                                for h in context.inventory_health
                                if getattr(h, "sku", None)},
                    # Checklist 16. Measured per-vendor lead times size the
                    # order; the policy's assumption sentence says which basis.
                    lead_times=getattr(context, "lead_times", None) or None,
                )
                for p in picks:
                    d = quantities.for_sku(p.sku)
                    if d.units is not None and d.units > 0:
                        policy_qty[p.sku] = (
                            d.units,
                            d.horizon_open_days or deterministic.COVERAGE_DAYS,
                        )
                refused = quantities.refusals()
                if refused:
                    # Named, not swallowed. A refusal means that card falls back
                    # to the deficit, and an operator should be able to see how
                    # often that happens and why.
                    log.info("policy_quantity_refusals",
                             store=f"{client_id}:{location_id}",
                             refused=len(refused), sized=len(policy_qty),
                             reasons=sorted({r.split(":")[0]
                                             for r in refused.values()}))
            except Exception as exc:  # pragma: no cover - defensive
                # Failing to SIZE must not lose a slate that was correctly
                # SELECTED, so this degrades to the previous behaviour.
                log.warning("policy_quantity_unavailable",
                            store=f"{client_id}:{location_id}", error=str(exc))

            # Policy first, canonical behind it. The fallback keeps a card
            # orderable where the policy refuses - an unknown shelf count, no
            # sales history - rather than dropping a product the selector chose.
            merged_qty = {**context.canonical_qty, **policy_qty}

            decision = slate.compose(
                picks, extra,
                money=slate.money_from_catalogue(context.catalogue),
                client_id=client_id, location_id=location_id,
                as_of=context.data_as_of,
                limit=self._settings.max_recommendations,
                # The quantity the OWNER is asked to buy. Without it the budget
                # is charged for the deficit, which the validator is about to
                # overwrite - see slate.order_units.
                canonical_qty=merged_qty,
                # MEASURES the cash budget from the store's own receipts instead
                # of declaring it at a flat $2,000 - which was 4% of what these
                # stores actually spend a cycle, and withheld cards at three of
                # five of them for no reason. See policy/replacement.py.
                sales=context.sales,
                product_names={sku: info.name
                               for sku, info in context.catalogue.items()},
            )
            picks, extra = list(decision.picks), list(decision.extra)
            raw_recs = deterministic.to_raw_recommendations(
                picks, as_of=context.data_as_of,
                # Promotes the predictive range and the holding cost onto the
                # live card. Both are additive: neither changes which products
                # are chosen or the order they appear in.
                client_id=client_id, location_id=location_id,
                # Sheet 17. Every card now carries gate_state, gate_reason,
                # gate_displayed and gate_measured. Nothing is DROPPED here - a
                # failing store's cards are still computed, stored and scored,
                # because an engine that quietly returns nothing is
                # indistinguishable from one that is broken.
                gate_inputs=getattr(context, "gate_verdict", None),
                # Sheet 08. None until a curve is fitted, in which case the card
                # keeps stating its raw score with the existing disclaimer.
                calibration_bundle=getattr(context, "calibration_bundle", None),
                # What the slate asked for and what it assumed it had. On every
                # card, because the budget is DECLARED rather than measured -
                # $2,000 a cycle is an ordinary single-store order and nothing in
                # either database records a store's free cash. Surfacing it is
                # how an owner gets to say it is wrong.
                portfolio=decision.portfolio,
                # Whether that budget was measured or declared, and the figure
                # behind it. A card that says "assumed" about the store's own
                # replacement spend invites the owner to dismiss their own number.
                budget_basis=decision.budget_basis,
                replacement=decision.replacement,
                # So the published cost of being wrong prices the quantity the
                # card asks for rather than the deficit behind it - and that is
                # now the POLICY quantity, so the card, the holding cost and the
                # budget are all charged for the same number.
                canonical_qty=merged_qty,
                # The deadline on the card and the lead time it rests on. The
                # same map `choose` quoted in the stockout sentence, so the
                # date, the sentence and the quantity stand on one figure.
                lead_times=getattr(context, "lead_times", None) or None,
            ) + families.to_raw(
                extra, as_of=context.data_as_of, start_rank=len(picks) + 1
            )
            verified = ({p.sku for p in picks}
                        | {s for e in extra for s in e.skus})
            # Read out of this store's own sales, so not hallucinations.
        else:
            # The superseded path. Retained behind a setting rather than
            # deleted so the two can be compared on one store, not so it can
            # be fallen back to: it is the arm that scored 24.2%.
            prompt = build_prompt(context, self._settings)
            raw_recs = await self._llm.recommend(prompt)
            verified = set()
            card_retirements = ()
            # ── THE MODEL WRITES THE SENTENCE ─────────────────────────
            #
            # After every decision is fixed. It cannot change a product, a
            # quantity, an order or a budget; it rewrites the body text and may
            # MENTION a live signal the owner can already see. Every numeral is
            # checked against the figures the engine published and a sentence
            # carrying an unaccounted one is discarded whole.
        # OUTSIDE BOTH BRANCHES. Twice now this call has ended up inside the
        # `else`, where it narrates only the superseded arm that is switched off -
        # the first time from an indentation-ambiguous anchor, the second from a
        # restore that put back the wrong copy of this file. Both times the unit
        # tests were green, because they call `_narrate_cards` directly and it
        # works perfectly in isolation; both times
        # `test_narration_is_attempted_on_the_deterministic_path` was the only
        # thing that noticed. If this line ever moves right by four spaces again,
        # that test is what will say so.
        raw_recs = await self._narrate_cards(
            raw_recs, context, client_id, location_id)
        # ALSO OUTSIDE BOTH BRANCHES, and for the same reason as the line above.
        # Unlike narration this one is not budgeted and not optional: every card
        # carries the block, because the whole point is that an owner can never
        # again be unable to tell "we looked and cannot measure it" from "we never
        # looked". Narration may be skipped for a card; disclosure may not.
        raw_recs = self._attach_signal_impact(raw_recs, context)
        result = self._assemble(
            client_id, location_id, context, raw_recs, recorder,
            EngineInfo(
                version=__version__,
                model=self._settings.llm_model,
                latency_ms=int((time.perf_counter() - started) * 1000),
            ),
            verified_skus=verified,
            card_retirements=card_retirements,
        )
        log.info(
            "run_complete",
            client_id=client_id,
            location_id=location_id,
            generated=result.recommendations_generated,
            dropped=result.dropped_invalid,
        )
        return result

    # ----- bulk ------------------------------------------------------------

    async def run_bulk(self, pairs: Sequence[LocationRef], *, mode: str) -> BulkRunResult:
        if mode == "batch":
            return await self.run_batch(pairs)
        return await self.run_many(pairs)

    async def run_many(self, pairs: Sequence[LocationRef]) -> BulkRunResult:
        """Run every store live with bounded concurrency. Immediate results.

        When prompt caching is on, the first store runs alone before the rest
        fan out: a cache entry only becomes readable after the first response
        starts, so N simultaneous first requests would all pay the uncached
        price. One warm-up run lets the remaining N-1 read the prefix cache.
        """
        log.info("bulk_run_started", mode="concurrent", count=len(pairs))
        outcomes: list[RunResult | BaseException]
        if self._settings.prompt_cache_enabled and len(pairs) > 1:
            first: RunResult | BaseException
            try:
                first = await self.run(pairs[0].client_id, pairs[0].location_id)
            except Exception as exc:  # the warm-up failing must not sink the run
                first = exc
            rest = await gather_with_limit(
                pairs[1:],
                lambda p: self.run(p.client_id, p.location_id),
                self._settings.bulk_max_concurrency,
            )
            outcomes = [first, *rest]
        else:
            outcomes = await gather_with_limit(
                pairs,
                lambda p: self.run(p.client_id, p.location_id),
                self._settings.bulk_max_concurrency,
            )
        results: list[RunResult] = []
        errors: list[BulkRunError] = []
        for pair, outcome in zip(pairs, outcomes, strict=True):
            if isinstance(outcome, BaseException):
                errors.append(_error_for(pair, outcome))
            else:
                results.append(outcome)
        return self._bulk_result("concurrent", pairs, results, errors)

    @staticmethod
    def _custom_id(pair: LocationRef) -> str:
        """Stable batch custom_id so collect can match results without ordering."""
        return f"{pair.client_id}:{pair.location_id}"

    async def _prepare_batch(
        self, pairs: Sequence[LocationRef]
    ) -> tuple[
        dict[str, dict[str, str]],
        dict[str, tuple[LocationRef, RecommendationContext, SignalRecorder]],
        list[BulkRunError],
    ]:
        """Build contexts + prompts for a batch; per-store failures become errors."""
        errors: list[BulkRunError] = []
        built = await gather_with_limit(
            pairs, self._build_recorded, self._settings.bulk_max_concurrency,
        )
        prompts: dict[str, dict[str, str]] = {}
        by_cid: dict[str, tuple[LocationRef, RecommendationContext, SignalRecorder]] = {}
        for pair, outcome in zip(pairs, built, strict=True):
            if isinstance(outcome, BaseException):
                errors.append(_error_for(pair, outcome))
                continue
            ctx, recorder = outcome
            cid = self._custom_id(pair)
            prompts[cid] = build_prompt(ctx, self._settings)
            by_cid[cid] = (pair, ctx, recorder)
        return prompts, by_cid, errors

    def _assemble_batch_outcomes(
        self,
        by_cid: dict[str, tuple[LocationRef, RecommendationContext, SignalRecorder]],
        outcomes: dict[str, object],
        errors: list[BulkRunError],
    ) -> list[RunResult]:
        results: list[RunResult] = []
        for cid, (pair, ctx, recorder) in by_cid.items():
            outcome = outcomes.get(cid)
            recommendations = getattr(outcome, "recommendations", None)
            if recommendations is None:
                msg = getattr(outcome, "error", None) if outcome else "no batch result returned"
                errors.append(
                    BulkRunError(
                        client_id=pair.client_id,
                        location_id=pair.location_id,
                        code="llm_error",
                        message=msg or "batch result missing",
                    )
                )
                continue
            results.append(
                self._assemble(
                    pair.client_id, pair.location_id, ctx, recommendations, recorder,
                    EngineInfo(version=__version__, model=self._settings.llm_model),
                )
            )
        return results

    async def run_batch(self, pairs: Sequence[LocationRef]) -> BulkRunResult:
        """Build every context, submit one Message Batch, assemble results.

        Contexts are held in memory for the duration of the (long-lived) call so
        the result can be validated against each store's own candidate set —
        statelessness is preserved by doing submit + poll + assemble in one
        request rather than persisting anything. For long batches prefer the
        non-blocking submit/status/collect endpoints, which don't hold an HTTP
        connection open through proxies for the whole processing window.
        """
        log.info("bulk_run_started", mode="batch", count=len(pairs))
        prompts, by_cid, errors = await self._prepare_batch(pairs)

        results: list[RunResult] = []
        batch_id: str | None = None
        if prompts:
            batch_id, outcomes = await self._llm.recommend_batch(prompts)
            results = self._assemble_batch_outcomes(by_cid, dict(outcomes), errors)

        return self._bulk_result("batch", pairs, results, errors, batch_id=batch_id)

    # ----- non-blocking batch (submit / status / collect) ------------------

    async def submit_batch_run(self, pairs: Sequence[LocationRef]) -> BatchSubmission:
        """Submit one Message Batch and return immediately with its id.

        Nothing is persisted here — the caller holds the ``batch_id`` and posts
        the same pairs back to collect once the batch has ended.
        """
        log.info("batch_submit_started", count=len(pairs))
        prompts, by_cid, errors = await self._prepare_batch(pairs)
        batch_id = await self._llm.submit_batch(prompts) if prompts else None
        return BatchSubmission(
            batch_id=batch_id,
            requested=len(pairs),
            submitted=len(by_cid),
            errors=errors,
        )

    async def batch_run_status(self, batch_id: str) -> BatchStatus:
        status, counts = await self._llm.batch_status(batch_id)
        return BatchStatus(batch_id=batch_id, processing_status=status, counts=counts)

    async def collect_batch_run(
        self, batch_id: str, pairs: Sequence[LocationRef]
    ) -> BulkRunResult:
        """Collect an ended batch and validate against freshly fetched data.

        The service is stateless, so contexts are rebuilt at collect time —
        which also means SKU validation runs against *current* stock rather
        than a snapshot from submit time. Raises 409 while still processing.
        """
        status, _counts = await self._llm.batch_status(batch_id)
        if status != "ended":
            raise BatchNotFinishedError(
                f"Batch {batch_id} is still {status}; retry once it has ended "
                f"(GET /run-recommendations/batch/{batch_id})."
            )

        outcomes = await self._llm.collect_batch(batch_id)

        # Only rebuild contexts for pairs the batch actually contains.
        known = [p for p in pairs if self._custom_id(p) in outcomes]
        unknown = [p for p in pairs if self._custom_id(p) not in outcomes]
        errors: list[BulkRunError] = [
            BulkRunError(
                client_id=p.client_id,
                location_id=p.location_id,
                code="not_in_batch",
                message=f"No result for this store in batch {batch_id}.",
            )
            for p in unknown
        ]

        built = await gather_with_limit(
            known, self._build_recorded, self._settings.bulk_max_concurrency,
        )
        by_cid: dict[str, tuple[LocationRef, RecommendationContext, SignalRecorder]] = {}
        for pair, outcome in zip(known, built, strict=True):
            if isinstance(outcome, BaseException):
                errors.append(_error_for(pair, outcome))
                continue
            ctx, recorder = outcome
            by_cid[self._custom_id(pair)] = (pair, ctx, recorder)

        results = self._assemble_batch_outcomes(by_cid, dict(outcomes), errors)
        return self._bulk_result("batch", pairs, results, errors, batch_id=batch_id)

    def _bulk_result(
        self,
        mode: str,
        pairs: Sequence[LocationRef],
        results: list[RunResult],
        errors: list[BulkRunError],
        *,
        batch_id: str | None = None,
    ) -> BulkRunResult:
        log.info(
            "bulk_run_complete",
            mode=mode,
            requested=len(pairs),
            succeeded=len(results),
            failed=len(errors),
        )
        return BulkRunResult(
            mode=mode,
            requested=len(pairs),
            succeeded=len(results),
            failed=len(errors),
            batch_id=batch_id,
            results=results,
            errors=errors,
        )
