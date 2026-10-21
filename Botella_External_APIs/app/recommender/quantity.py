"""THE quantity on a card, from the order policy, fed by the forecast interval.

WHAT THIS REPLACES, AND WHY IT HAD TO GO

    The card's quantity came from ``storeagent/functions/buying.py``'s
    ``order_quantity`` - the Buying-tab formula - by way of
    ``CanonicalDemandMap`` and ``context.canonical_qty``. That formula is

        target = forecast(lead_time + coverage) * (1 + safety_buffer)
        qty    = ceil(target - on_hand)

    which takes a SINGLE-POINT forecast and multiplies it by a flat 20%. The
    point forecast cannot set a buffer, because a buffer is a statement about
    DISPERSION and a point estimate has none: two SKUs both selling 5 a day,
    one steady and one spiking between 0 and 30, get the same 20% and the same
    order. The flat percentage is doing the work that a quantile is supposed to
    do, and it is doing it identically for every demand shape in the catalogue.

    ``app/pipeline/policy/inventory.py`` already does this properly - safety
    stock from the forecast's own spread at a service level, order-up-to point,
    ideal quantity net of stock on hand - and it ran only from
    ``scripts/run_decisions.py``. So the measured path and the serving path
    sized orders by two different rules, which is the 454-vs-485 lesson in the
    one place where disagreement costs actual money.

    ``storeagent/forecasting/ensemble.py`` supplies the p10/p50/p90 the policy
    needs, per demand class (Croston/SBA for intermittent, ETS for smooth), and
    is already validated by ``backtest_by_class``.

WHAT STAYS THE SAME

    SELECTION. Reversion still picks the products - ``deficit_units`` is the
    selection signal and is untouched. This module only decides HOW MANY of
    something already chosen, which is the division the two modules were always
    designed around: reversion answers "is this product behind its own normal",
    the policy answers "how many does that imply buying".

REFUSALS ARE THE POINT, NOT AN EDGE CASE

    ``estimate_policy`` refuses without an interval rather than substituting a
    default sigma, and refuses an unknown shelf count rather than reading it as
    zero - zero orders the MAXIMUM. Every refusal here is carried as a reason
    on the decision, so a card with no quantity says why instead of printing a
    number nobody measured. A refusal must never become a quantity.

COST

    Measured: classify plus forecast is about 2ms per SKU on a 364-day series
    (0.4ms classify, 1.2-2.2ms forecast across smooth, intermittent and lumpy),
    so a hundred candidates cost about 200ms. It is memoised per SKU anyway,
    because the knapsack asks for the same quantity more than once.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any, Iterable, Mapping, Sequence

from app.pipeline import ConfigRegistry, RunContext, cfg
from app.pipeline.constraints import (
    ApplyRequest,
    ConstraintSet,
    apply_constraints,
    budget_unavailable,
    known,
    shelf_capacity_unavailable,
    unavailable,
)
from app.pipeline.features.store import CalendarDay, DayFact
from app.pipeline.features.taxonomy import category_family_of
from app.pipeline.policy.inventory import (
    LEAD_TIME_SOURCE_MEASURED,
    PolicyRequest,
    estimate_policy,
)

#: The window the forecast is fitted over, in trading days. Matches the
#: `window_days` default in `EstateInput` and the year of sales the live context
#: already carries, so the live path fits over the same span the backtest does.
FIT_WINDOW_DAYS = 364


@dataclass(frozen=True, slots=True)
class QuantityDecision:
    """How many to order, or why we will not say.

    `units is None` is a REFUSAL and must be rendered as an absence. It is not
    zero: "we cannot size this" and "order none" are different answers, and the
    second one is a recommendation.
    """

    sku: str
    units: int | None
    basis: str
    refused_reason: str | None = None
    p10: float | None = None
    p50: float | None = None
    p90: float | None = None
    horizon_open_days: int | None = None
    ideal_qty: float | None = None
    order_up_to: float | None = None
    demand_class: str | None = None
    assumptions: tuple[str, ...] = ()
    constrained_by: tuple[str, ...] = ()

    @property
    def usable(self) -> bool:
        return self.units is not None and self.units > 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "sku": self.sku, "units": self.units, "basis": self.basis,
            "refused_reason": self.refused_reason,
            "p10": self.p10, "p50": self.p50, "p90": self.p90,
            "horizon_open_days": self.horizon_open_days,
            "ideal_qty": self.ideal_qty, "order_up_to": self.order_up_to,
            "demand_class": self.demand_class,
            "assumptions": list(self.assumptions),
            "constrained_by": list(self.constrained_by),
        }


def _calendar_and_facts(
    sales: Iterable[Any],
) -> tuple[list[CalendarDay], dict[str, list[DayFact]], list[date]]:
    """The store's trading days and per-SKU daily facts, from raw sales.

    A TRADING DAY IS A DAY THE STORE SOLD SOMETHING, which is the only
    definition available from sales alone - and deliberately the same one
    `deterministic._daily` uses. Deriving it differently here would give the
    forecast a different idea of the store's opening pattern from the selector's,
    which is how two halves of one run come to disagree about a rate.

    `has_data=True` on every day for the same reason: these days exist BECAUSE
    there were sales on them, so "open but unsynced" is not reachable from this
    source. A day the store was open and sold nothing is invisible here, which
    understates the denominator slightly and is the honest limit of deriving a
    calendar from sales rather than from `feature_store_day`.
    """
    per_sku: dict[str, dict[date, float]] = {}
    days: set[date] = set()
    for row in sales:
        sku = getattr(row, "sku", None)
        day = getattr(row, "sale_date", None)
        if not sku or day is None:
            continue
        units = float(getattr(row, "units", 0) or 0)
        days.add(day)
        bucket = per_sku.setdefault(sku, {})
        bucket[day] = bucket.get(day, 0.0) + units

    ordered = sorted(days)[-FIT_WINDOW_DAYS:]
    calendar = [CalendarDay(obs_date=d, was_open=True, has_data=True)
                for d in ordered]
    in_window = set(ordered)
    facts: dict[str, list[DayFact]] = {}
    for sku, by_day in per_sku.items():
        facts[sku] = [
            DayFact(obs_date=d, sku=sku, units_sold=u)
            for d, u in sorted(by_day.items()) if d in in_window
        ]
    return calendar, facts, ordered


class PolicyQuantities:
    """Lazily computed policy quantities for one run, memoised per SKU.

    One object per run rather than a module-level cache: the calendar, the
    service level and the context's seed all belong to this run, and a cache
    that outlived it would hand one store's forecast to another.
    """

    def __init__(
        self,
        *,
        sales: Iterable[Any],
        ctx: RunContext,
        config: ConfigRegistry = cfg,
        horizon_open_days: int,
        on_hand: dict[str, float | None] | None = None,
        prices: dict[str, float | None] | None = None,
        costs: dict[str, float | None] | None = None,
        categories: dict[str, str | None] | None = None,
        case_packs: dict[str, float | None] | None = None,
        #: Checklist 16 - per-SKU delivery lead time with provenance
        #: (`RecommendationContext.lead_times`). Duck-typed on purpose: anything
        #: with `.days`, `.source`, `.observations`, `.vendor` and the two
        #: `measured_*` dates, so the harness can hand in a namespace. None or
        #: empty means no vendor is known for anything, and every SKU rests on
        #: the declared default - which the policy now says out loud.
        lead_times: Mapping[str, Any] | None = None,
    ) -> None:
        self._ctx = ctx
        self._config = config
        self._horizon = int(horizon_open_days)
        self._on_hand = on_hand or {}
        self._prices = prices or {}
        self._costs = costs or {}
        self._categories = categories or {}
        self._case_packs = case_packs or {}
        self._lead_times = lead_times or {}
        self._calendar, self._facts, self._days = _calendar_and_facts(sales)
        self._cache: dict[str, QuantityDecision] = {}

    @property
    def trading_days(self) -> int:
        return len(self._days)

    def for_sku(self, sku: str) -> QuantityDecision:
        hit = self._cache.get(sku)
        if hit is None:
            hit = self._compute(sku)
            self._cache[sku] = hit
        return hit

    def refusals(self) -> dict[str, str]:
        """Every SKU asked about that could not be sized, and why."""
        return {s: d.refused_reason for s, d in self._cache.items()
                if d.units is None and d.refused_reason}

    # -- the chain ---------------------------------------------------------

    def _lead_time_overrides(self, sku: str) -> dict[str, Any]:
        """What the policy is told about this SKU's vendor, if anything.

        A MEASURED row overrides the declared lead time and carries its
        provenance, so the assumption sentence reads "measured from N receipts".
        A DEFAULT row passes the vendor NAME only: the figure the policy orders
        against stays the registry Setting, because two declarations of one
        default - Node's env and Python's registry - must not be able to
        disagree about what "the default" is. The sentence then names the
        vendor, which is more than it could say before.

        The median is rounded HERE, not in the policy: `inventory.py` forbids
        `round` so that sheet 11's case-pack rounding cannot leak into it, and
        a lead time of 3.5 days is a whole-day quantity to a buyer anyway.
        """
        lt = self._lead_times.get(sku)
        if lt is None:
            return {}
        out: dict[str, Any] = {}
        vendor = getattr(lt, "vendor", None)
        if vendor:
            out["vendor"] = str(vendor)
        measured = (getattr(lt, "source", None) == LEAD_TIME_SOURCE_MEASURED
                    and int(getattr(lt, "observations", 0) or 0) > 0)
        if not measured:
            return out
        try:
            days = max(1, int(round(float(lt.days))))
        except (TypeError, ValueError):
            return out
        out.update(
            lead_time_days=days,
            lead_time_source=LEAD_TIME_SOURCE_MEASURED,
            lead_time_observations=int(lt.observations),
            lead_time_measured_from=getattr(lt, "measured_from", None),
            lead_time_measured_to=getattr(lt, "measured_to", None),
        )
        return out

    def _refuse(self, sku: str, reason: str, **kw: Any) -> QuantityDecision:
        return QuantityDecision(sku=sku, units=None, basis="refused",
                                refused_reason=reason, **kw)

    def _compute(self, sku: str) -> QuantityDecision:
        # Imported here, not at module scope: `storeagent` imports from
        # `app.pipeline`, so a top-level import closes the cycle. The same
        # reason `assemble.estimate_and_forecast` does it.
        from storeagent.forecasting.classify import ClassifyRequest, classify
        from storeagent.forecasting.ensemble import ForecastRequest, forecast

        facts = self._facts.get(sku)
        if not facts:
            return self._refuse(sku, "no_sales_history_for_this_sku")
        if self._horizon < 1:
            return self._refuse(sku, f"horizon_not_positive:{self._horizon}")

        classified = classify(
            ClassifyRequest(sku=sku, calendar=self._calendar, facts=facts,
                            window_days=FIT_WINDOW_DAYS),
            self._ctx, self._config,
        )
        if not classified.ok or classified.value is None:
            return self._refuse(sku,
                                "unclassifiable:" + ";".join(classified.reasons))
        profile = classified.value
        demand_class = str(getattr(profile, "demand_class", "") or "") or None

        by_day = {f.obs_date: float(f.units_sold or 0.0) for f in facts}
        series = [by_day.get(d, 0.0) for d in self._days]

        predicted = forecast(
            ForecastRequest(
                profile=profile,
                horizon_open_days=self._horizon,
                series=series,
                open_days_per_week=_open_days_per_week(self._days),
            ),
            self._ctx, self._config,
        )
        if not predicted.ok or predicted.value is None:
            return self._refuse(sku,
                                "unforecastable:" + ";".join(predicted.reasons),
                                demand_class=demand_class)
        fc = predicted.value

        # UNKNOWN STOCK REFUSES. `ideal_qty = order_up_to - on_hand - on_order`,
        # so a missing count read as zero orders the order-up-to point in full -
        # the maximum, not the minimum. This is the same rule the shelf-count
        # work applies everywhere else.
        have = self._on_hand.get(sku)
        if have is None:
            return self._refuse(sku, "shelf_count_unknown:cannot_size_an_order",
                                p10=fc.p10, p50=fc.p50, p90=fc.p90,
                                horizon_open_days=self._horizon,
                                demand_class=demand_class)
        if have < 0:
            return self._refuse(sku, f"shelf_count_negative:{have:g}",
                                p10=fc.p10, p50=fc.p50, p90=fc.p90,
                                horizon_open_days=self._horizon,
                                demand_class=demand_class)

        family = category_family_of(self._categories.get(sku)) or "default"
        decided = estimate_policy(
            PolicyRequest(
                sku=sku, family=family,
                p10=fc.p10, p50=fc.p50, p90=fc.p90,
                horizon_open_days=self._horizon,
                on_hand=float(have),
                # No table in either database records outstanding orders, so
                # unknown is the normal state. The policy records it as an
                # assumption rather than treating it as a measured zero.
                on_order=None,
                unit_price=self._prices.get(sku),
                unit_cost=self._costs.get(sku),
                **self._lead_time_overrides(sku),
            ),
            self._ctx, self._config,
        )
        if not decided.ok or decided.value is None:
            return self._refuse(sku, "; ".join(decided.reasons),
                                p10=fc.p10, p50=fc.p50, p90=fc.p90,
                                horizon_open_days=self._horizon,
                                demand_class=demand_class)
        policy = decided.value

        if policy.ideal_qty <= 0:
            # NOT a refusal and not an error - a real answer that happens to be
            # "nothing". Distinguished from a refusal by carrying units=0 with
            # a basis, so a caller can tell "stocked above the reorder point"
            # from "we could not work it out".
            return QuantityDecision(
                sku=sku, units=0, basis="policy_stocked_above_reorder_point",
                p10=fc.p10, p50=fc.p50, p90=fc.p90,
                horizon_open_days=self._horizon,
                ideal_qty=float(policy.ideal_qty),
                order_up_to=float(policy.order_up_to),
                demand_class=demand_class,
                assumptions=tuple(getattr(policy, "assumptions", ()) or ()),
            )

        pack = self._case_packs.get(sku)
        constraints = ConstraintSet(
            case_pack=(known("case_pack", float(pack)) if pack
                       else unavailable("case_pack", "no pack size recorded")),
            on_hand=known("on_hand", float(have)),
            moq=unavailable("moq", "no purchase order history in this warehouse"),
            shelf_capacity=shelf_capacity_unavailable(),
            budget=budget_unavailable(),
        )
        feasible = apply_constraints(
            ApplyRequest(sku, float(policy.ideal_qty), constraints), self._ctx,
        )
        if not feasible.ok or feasible.value is None:
            return self._refuse(sku, "; ".join(feasible.reasons),
                                p10=fc.p10, p50=fc.p50, p90=fc.p90,
                                horizon_open_days=self._horizon,
                                demand_class=demand_class)
        final = feasible.value
        return QuantityDecision(
            sku=sku, units=int(final.feasible_qty),
            basis="policy_inventory_on_ensemble_interval",
            p10=fc.p10, p50=fc.p50, p90=fc.p90,
            horizon_open_days=self._horizon,
            ideal_qty=float(policy.ideal_qty),
            order_up_to=float(policy.order_up_to),
            demand_class=demand_class,
            assumptions=tuple(getattr(policy, "assumptions", ()) or ()),
            constrained_by=tuple(final.reasons or ()),
        )


def _open_days_per_week(days: Sequence[date]) -> int:
    """Trading days per week, derived from the calendar rather than assumed.

    The seasonal period of the ETS path. Assuming 7 for a store that closes
    Sundays puts the seasonality one day out of phase every week.
    """
    if not days:
        return 7
    weekdays = {d.weekday() for d in days}
    return max(1, min(7, len(weekdays)))


__all__ = ["FIT_WINDOW_DAYS", "PolicyQuantities", "QuantityDecision"]
