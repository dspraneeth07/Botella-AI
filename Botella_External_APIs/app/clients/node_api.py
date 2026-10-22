"""Client for the Node backend — the single source of all DB-backed data.

This service holds no database connection. Every product, inventory, and sales
fact is fetched here over HTTP. The endpoints and response shapes are defined in
``API_CONTRACT.md``; keep the two in sync.
"""

from __future__ import annotations

from datetime import date
from typing import Any

import httpx
from pydantic import ValidationError
from tenacity import AsyncRetrying

# The engine's own version, to refuse a calibration curve fitted against a
# different one. app/__init__.py holds only a docstring and this constant,
# so there is no import cycle.
from app import __version__
from app.clients.retry import transient_retry
from app.config import Settings
from app.exceptions import NodeApiError
from app.logging_config import get_logger
from app.schemas.context import LeadTime
from app.schemas.feedback import (
    CoPurchasePair,
    LearnedEffectiveness,
    PastRecommendation,
    RecommendationHistoryFeed,
)
from app.schemas.store import (
    AreaWinner,
    InstagramTrend,
    InventoryItem,
    RegisterTrend,
    SaleRecord,
    StoreProfile,
    TrendProof,
)

log = get_logger(__name__)


def _day_or_none(value: Any) -> date | None:
    """A date from Node's ``YYYY-MM-DD`` text, or None for anything else."""
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def _as_list(payload: Any) -> list[dict]:
    """Accept either a bare JSON array or a ``{"data": [...]}`` envelope."""
    if isinstance(payload, dict) and isinstance(payload.get("data"), list):
        return payload["data"]
    if isinstance(payload, list):
        return payload
    raise NodeApiError("Expected a JSON array from the Node API.")


class NodeApiClient:
    """Async client wrapping the Node data endpoints.

    One instance per process; owns its connection pool. Construct in the app
    lifespan and close on shutdown.
    """

    def __init__(self, settings: Settings) -> None:
        headers = {"Accept": "application/json"}
        if settings.node_api_token:
            headers["Authorization"] = f"Bearer {settings.node_api_token}"
        self._client = httpx.AsyncClient(
            base_url=settings.node_api_base_url.rstrip("/"),
            timeout=settings.node_api_timeout_seconds,
            headers=headers,
        )
        self._max_attempts = settings.node_api_max_retries
        self._sales_days = settings.node_sales_window_days
        self._trend_validation_timeout = settings.trend_validation_timeout_seconds

    async def aclose(self) -> None:
        await self._client.aclose()

    async def ping(self) -> bool:
        """Whether the Node base URL is reachable at all (any HTTP status counts)."""
        try:
            await self._client.get("/")
        except httpx.HTTPError:
            return False
        return True

    async def _get(
        self, path: str, params: dict | None = None, *, timeout: float | None = None
    ) -> Any:
        try:
            async for attempt in AsyncRetrying(**transient_retry(self._max_attempts)):
                with attempt:
                    response = await self._client.get(
                        path,
                        params=params,
                        timeout=timeout if timeout is not None else httpx.USE_CLIENT_DEFAULT,
                    )
                    response.raise_for_status()
                    return response.json()
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            if status == 404:
                raise NodeApiError(f"Node API 404 for {path}", status_code=404) from exc
            raise NodeApiError(
                f"Node API returned {status} for {path}",
                status_code=502,
            ) from exc
        except httpx.HTTPError as exc:
            raise NodeApiError(f"Node API unreachable for {path}: {exc}", status_code=502) from exc
        raise NodeApiError(f"Node API request to {path} produced no response.")

    def _base(self, client_id: int, location_id: int) -> str:
        return f"/api/clients/{client_id}/locations/{location_id}"

    async def get_profile(self, client_id: int, location_id: int) -> StoreProfile:
        data = await self._get(f"{self._base(client_id, location_id)}/profile")
        if isinstance(data, dict) and isinstance(data.get("data"), dict):
            data = data["data"]
        return StoreProfile.model_validate(data)

    async def get_inventory(self, client_id: int, location_id: int) -> list[InventoryItem]:
        rows = _as_list(await self._get(f"{self._base(client_id, location_id)}/inventory"))
        # A product row with no name is a product row, not a reason to refuse
        # the store. Store 214's feed carried one `product_name: null` line and
        # every run for the store 500'd on it (22 Oct 2026) - one unnamed SKU
        # cost the owner the whole slate. The schema's default is "", which
        # pydantic does not apply to an explicit null, so it is applied here.
        return [
            InventoryItem.model_validate(
                {**row, "product_name": ""}
                if isinstance(row, dict) and row.get("product_name") is None
                else row
            )
            for row in rows
        ]

    async def get_sales(
        self, client_id: int, location_id: int, *, days: int | None = None
    ) -> list[SaleRecord]:
        window = days or self._sales_days
        rows = _as_list(
            await self._get(
                f"{self._base(client_id, location_id)}/sales", params={"days": window}
            )
        )
        return [SaleRecord.model_validate(row) for row in rows]

    # ----- optional endpoints (fail-soft until Node implements them) -------

    async def _get_optional_rows(
        self, path: str, params: dict | None = None, *, timeout: float | None = None
    ) -> list[dict]:
        """Fetch an optional endpoint; any failure degrades to an empty list.

        These feeds (recommendation history, co-purchases) enrich the prompt
        but must never sink a run — a 404 simply means Node hasn't shipped the
        endpoint yet, mirroring how missing ``cost``/``created_at`` behave.
        """
        try:
            return _as_list(await self._get(path, params=params, timeout=timeout))
        except NodeApiError as exc:
            level = log.debug if exc.status_code == 404 else log.warning
            level("optional_endpoint_unavailable", path=path, error=str(exc))
            return []

    async def get_signal_effects(
        self, client_id: int, location_id: int
    ) -> list[dict]:
        """Measured effects of external signals on each drink family (migration 029).

        An EMPTY list is the normal answer, not a failure. A store where nothing
        has been fitted, or where every cell refused, has nothing for a card to
        cite - and `cold_box`/`pre_stock` already treat the absence of an effect as
        a refusal to speak. Measured estate-wide on the first fit: 499 of 504 cells
        refused, so empty is what most stores legitimately return.

        EVERY ROW COMES BACK, REFUSALS INCLUDED - `?all=1`.

        This asked for the usable rows only, and that is why an owner looking at
        three live events saw no signal on any card. Measured at the five pilot
        stores: 639 cells fitted, TEN usable. So the serving path received one to
        four rows per store and had nothing to say about the other 635 - not even
        that they had been looked at.

        The refusal is the more common answer and the more useful one. ~460 of
        those 629 refusals read `too_few_active_days:4<20`, which is not a defect:
        `holiday_valentines` happens once a year, so a per-store fit can never
        clear a 20-occurrence floor. "We checked tonight's game; it has occurred
        four times in the fit window and twenty are needed" is an answer. Silence
        is not, and silence is what the filter produced.

        THE CITING RULE IS UNCHANGED AND LIVES DOWNSTREAM.
        `signal_effects_from_rows` drops every row whose beta is absent or whose
        interval spans zero, so a refused cell still cannot reach a card's
        `signals_cited` or move a quantity. Only the DISPLAY path widens - see
        `signal_status_from_rows`, which keeps the reason precisely so the card can
        print it. A wider fetch is not a weaker rule: the rule is applied where it
        was always applied.
        """
        path = f"{self._base(client_id, location_id)}/signal-effects"
        return await self._get_optional_rows(path, params={"all": "1"})

    async def get_calibration_bundle(
        self, client_id: int, location_id: int
    ) -> dict | None:
        """The fitted isotonic bundle for this store, or None.

        None is an ABSENCE: no curve has been fitted yet, and
        `apply_calibration` then runs the identity transform while the card
        declines to present its score as a percentage. That is the behaviour the
        engine had for months and it is the correct fallback, not an error.

        Read back with `fit.bundle_from_dict`, which rebuilds the THREE-PART
        lookup keys - a two-part key misses every rung of the fallback chain and
        silently lands on identity, which is indistinguishable from having no
        curve at all.

        A BUNDLE FITTED AGAINST A DIFFERENT ENGINE IS REFUSED.

        The curve maps a RAW RANKING SCORE onto an observed hit rate, so it is a
        statement about the engine that produced those scores. Change how
        candidates are selected or scored and the same raw 0.4 means something
        else; the old curve is then not a weaker claim about the new cards, it
        is a claim about a different quantity, and applying it turns a number
        nobody measured into a percentage with the word "confidence" on it.

        Declining is cheap and already handled: this returns None, which is the
        same absence as "no curve fitted yet", so the identity transform runs
        and the card does not present its score as a probability until the next
        refit - one night away, since the calibration job runs daily.

        `engine_version` is absent on a bundle published before migration 032.
        That is unknown provenance rather than a match, but it is not refused:
        the estate has exactly one engine version in its history (0.1.0, never
        changed), so treating the gap as a mismatch would throw away the only
        curve there is to answer a question nobody has asked yet. It is logged,
        so the first real rollout is visible.
        """
        path = f"{self._base(client_id, location_id)}/calibration-bundle"
        try:
            payload = await self._get(path)
        except NodeApiError as exc:
            level = log.debug if exc.status_code == 404 else log.warning
            level("optional_endpoint_unavailable", path=path, error=str(exc))
            return None
        if isinstance(payload, dict):
            data = payload.get("data")
            if isinstance(data, dict):
                fitted_for = data.get("engine_version")
                if fitted_for is None:
                    log.info("calibration_bundle_without_engine_version",
                             client_id=client_id, location_id=location_id,
                             running=__version__)
                elif str(fitted_for) != __version__:
                    log.warning(
                        "calibration_bundle_refused_engine_mismatch",
                        client_id=client_id, location_id=location_id,
                        fitted_for=str(fitted_for), running=__version__,
                        effect="identity transform until the next refit",
                    )
                    return None
                return data
        return None

    async def get_store_gate_verdict(
        self, client_id: int, location_id: int
    ) -> dict | None:
        """This store's gate verdict, or None when nobody has measured it.

        None is an ABSENCE, not a failure. A 404 means the batch has not run for
        this store yet, and a caller that treats that as "failed" withholds every
        card at every store the first time it honours the flag - which is why the
        verdict carries `measured` separately from `state`.

        Fail-soft like every optional endpoint: the slate is still built, and the
        cards simply carry `gate_measured: false`.
        """
        path = f"{self._base(client_id, location_id)}/gate-verdict"
        try:
            payload = await self._get(path)
        except NodeApiError as exc:
            level = log.debug if exc.status_code == 404 else log.warning
            level("optional_endpoint_unavailable", path=path, error=str(exc))
            return None
        if isinstance(payload, dict):
            data = payload.get("data")
            if isinstance(data, dict):
                return data
            return payload or None
        return None

    async def get_lead_times(
        self, client_id: int, location_id: int
    ) -> dict[str, LeadTime]:
        """Per-SKU delivery lead time with provenance (migration 037).

        Node answers with two maps - `vendors` keyed by normalised vendor and
        `skus` naming each SKU's vendor key - and this joins them, so the
        consumer gets one `LeadTime` per SKU and never has to know the key.
        Both maps come from the same parsed documents, so the keys agree by
        construction; a SKU whose vendor has no row is simply left out.

        An EMPTY dict is the normal answer at a store that has uploaded nothing
        and at an estate that has not run 037, and it is also the fail-soft
        answer: every quantity then rests on the declared default, which is
        exactly what happened before this feed existed - the card just says so
        now. A row that does not parse is skipped, not turned into a default:
        a malformed measurement must not become a confident seven.
        """
        path = f"{self._base(client_id, location_id)}/lead-times"
        try:
            payload = await self._get(path)
        except NodeApiError as exc:
            level = log.debug if exc.status_code == 404 else log.warning
            level("optional_endpoint_unavailable", path=path, error=str(exc))
            return {}
        data = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(data, dict):
            return {}
        vendors = data.get("vendors") if isinstance(data.get("vendors"), dict) else {}
        skus = data.get("skus") if isinstance(data.get("skus"), dict) else {}

        out: dict[str, LeadTime] = {}
        for sku, key in skus.items():
            row = vendors.get(str(key)) if key is not None else None
            if not isinstance(row, dict):
                continue
            try:
                days = float(row.get("lead_time_days"))
                observations = int(row.get("observations") or 0)
            except (TypeError, ValueError):
                continue
            source = str(row.get("source") or "")
            if days <= 0 or source not in ("default", "measured"):
                continue
            out[str(sku)] = LeadTime(
                days=days,
                source=source,
                observations=max(0, observations),
                vendor=str(row.get("vendor_name") or key),
                vendor_key=str(key),
                measured_from=_day_or_none(row.get("measured_from")),
                measured_to=_day_or_none(row.get("measured_to")),
            )
        if out:
            log.info("lead_times_fetched", client_id=client_id,
                     location_id=location_id, skus=len(out),
                     measured=sum(1 for v in out.values() if v.is_measured))
        return out

    async def get_card_history(
        self, client_id: int, location_id: int, *, days: int = 60
    ) -> list[dict]:
        """One row per SKU this store has been shown, for the LIFECYCLE screen.

        A DIFFERENT feed from `get_recommendation_history`, deliberately. That one
        serves the feedback loop: capped at 20 rows and ordered voted-first, one
        row per CARD. Reusing it would report a product shown fifteen times as
        shown once, which is exactly the number the lifecycle screen exists to
        act on.

        Fail-soft like every optional endpoint: a 404 means Node has not shipped
        it yet, and the selector then behaves as it does today - with no memory.
        """
        return await self._get_optional_rows(
            f"{self._base(client_id, location_id)}/card-history",
            params={"days": days},
        )

    async def get_recommendation_history(
        self, client_id: int, location_id: int, *, days: int = 30, limit: int | None = None
    ) -> RecommendationHistoryFeed:
        """Past persisted recommendations — powers the feedback loop.

        Node returns either a bare array of rows (older backend) or the
        contract §1.4 envelope ``{"data": [...], "effectiveness": {"proven":
        [...], "avoid": [...]}}``. Both parse; the learned proven/avoid lists
        degrade to empty whenever absent or malformed, and any fetch failure
        degrades to an empty feed — this endpoint must never sink a run.

        ``limit`` (when set) is sent to Node, which returns a voted-first,
        bounded list. Python re-enforces the bound defensively — see
        ``app.store_data.feedback.prioritize_history``.
        """
        params: dict[str, int] = {"days": days}
        if limit is not None:
            params["limit"] = limit
        path = f"{self._base(client_id, location_id)}/recommendation-history"
        try:
            payload = await self._get(path, params=params)
            rows = _as_list(payload)
        except NodeApiError as exc:
            level = log.debug if exc.status_code == 404 else log.warning
            level("optional_endpoint_unavailable", path=path, error=str(exc))
            return RecommendationHistoryFeed()

        learned = LearnedEffectiveness()
        if isinstance(payload, dict) and isinstance(payload.get("effectiveness"), dict):
            try:
                learned = LearnedEffectiveness.model_validate(payload["effectiveness"])
            except ValidationError as exc:
                log.warning("effectiveness_lists_invalid", error=str(exc))

        try:
            parsed = [PastRecommendation.model_validate(row) for row in rows]
        except ValidationError as exc:
            log.warning("recommendation_history_invalid", error=str(exc))
            parsed = []
        return RecommendationHistoryFeed(rows=parsed, learned=learned)

    async def get_co_purchases(
        self, client_id: int, location_id: int, *, days: int = 90, limit: int = 50
    ) -> list[CoPurchasePair]:
        """Top basket co-occurrence pairs — grounds the bundle recommendations."""
        rows = await self._get_optional_rows(
            f"{self._base(client_id, location_id)}/co-purchases",
            params={"days": days, "limit": limit},
        )
        try:
            return [CoPurchasePair.model_validate(row) for row in rows]
        except ValidationError as exc:
            log.warning("co_purchases_invalid", error=str(exc))
            return []

    async def get_trend_validation(
        self, client_id: int, location_id: int, *, terms: list[str]
    ) -> list[TrendProof]:
        """Register-measured validation of trending drink terms (contract §1.7)
        — anonymized same-state aggregates that separate internet hype from
        drinks actually moving at nearby registers."""
        if not terms:
            return []
        rows = await self._get_optional_rows(
            f"{self._base(client_id, location_id)}/trend-validation",
            params={"terms": ",".join(terms)},
            # Node fans out to ~25 peer stores on the remote warehouse for
            # this one; give it more patience than the default data reads.
            timeout=self._trend_validation_timeout,
        )
        try:
            return [TrendProof.model_validate(row) for row in rows]
        except ValidationError as exc:
            log.warning("trend_validation_invalid", error=str(exc))
            return []

    async def get_social_trends(
        self, client_id: int, location_id: int, *, days: int = 14
    ) -> list[InstagramTrend]:
        """Instagram hashtag velocity for Node's tracked drink vocabulary
        (contract §1.8) — global data that rides the tenant mount for auth."""
        rows = await self._get_optional_rows(
            f"{self._base(client_id, location_id)}/social-trends",
            params={"days": days},
        )
        try:
            return [InstagramTrend.model_validate(row) for row in rows]
        except ValidationError as exc:
            log.warning("social_trends_invalid", error=str(exc))
            return []

    async def post_signal_history(
        self, client_id: int, location_id: int, *, rows: list[dict]
    ) -> None:
        """Record the signal keys this run observed, so they have a past.

        BEST EFFORT, ALWAYS. A failure here costs one day of one store's signal
        history and must never cost the store its recommendations - the cards do
        not depend on this write, only the future ability to measure does.

        Idempotent by construction: the table is append-only with a unique index
        on (store, key, date) and the writer uses ON CONFLICT DO NOTHING, so two
        runs on one morning record one observation. That index had to be added by
        migration 026 after a missing one made the ON CONFLICT a silent no-op and
        a re-run doubled every row.
        """
        if not rows:
            return
        try:
            await self._client.post(
                f"{self._base(client_id, location_id)}/signal-history",
                json={"rows": rows},
            )
        except httpx.HTTPError as exc:
            log.warning("signal_capture_failed", client_id=client_id,
                        location_id=location_id, rows=len(rows), error=str(exc))

    async def post_observed_terms(
        self, client_id: int, location_id: int, *, terms: list[dict]
    ) -> None:
        """Report this run's discovered trend terms so Node's Instagram poller
        can start measuring them (contract §1.8 dynamic vocabulary).
        Best-effort by design: any failure is logged and swallowed — closing
        the discovery loop must never sink a recommendation run."""
        if not terms:
            return
        try:
            await self._client.post(
                f"{self._base(client_id, location_id)}/social-trends/observed-terms",
                json={"terms": terms},
            )
        except httpx.HTTPError as exc:
            log.warning("observed_terms_report_failed", error=str(exc))

    async def get_register_trends(
        self, client_id: int, location_id: int, *, limit: int = 8
    ) -> list[RegisterTrend]:
        """Drink categories accelerating at same-state peer registers
        (contract §1.9) — measured-purchase trend discovery. Node fans out to
        ~25 peer stores like §1.7, so it gets the same extended timeout."""
        rows = await self._get_optional_rows(
            f"{self._base(client_id, location_id)}/register-trends",
            params={"limit": limit},
            timeout=self._trend_validation_timeout,
        )
        try:
            return [RegisterTrend.model_validate(row) for row in rows]
        except ValidationError as exc:
            log.warning("register_trends_invalid", error=str(exc))
            return []

    async def get_area_winners(
        self, client_id: int, location_id: int, *, days: int = 30, limit: int = 10
    ) -> list[AreaWinner]:
        """New products doing well at nearby stores (anonymized aggregates) —
        grounds the cross-store ``new_arrival`` / ``stock_new`` picks."""
        rows = await self._get_optional_rows(
            f"{self._base(client_id, location_id)}/area-winners",
            params={"days": days, "limit": limit},
        )
        try:
            return [AreaWinner.model_validate(row) for row in rows]
        except ValidationError as exc:
            log.warning("area_winners_invalid", error=str(exc))
            return []
