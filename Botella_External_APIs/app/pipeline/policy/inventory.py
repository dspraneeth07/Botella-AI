"""Reorder point and safety stock — the IDEAL quantity, before reality.

    safety_stock  = z(service_level) * sigma_demand * sqrt(lead_time)
    reorder_point = mu_demand * lead_time + safety_stock
    order_up_to   = reorder_point + review_period * mu_demand
    ideal_qty     = order_up_to - on_hand - on_order

WHY THIS EXISTS
    A forecast is not a decision. Turning "we expect 14 units over three weeks"
    into "order 24" needs a service-level target, a lead time and the demand
    VARIANCE. `storeagent/functions/buying.py` does it today with

        safety = demand_cover * t.safety_buffer

    - a flat percentage of the forecast. That has no service level in it, no
    sigma, and it does not scale with lead time, so a vendor who takes three
    weeks and one who takes three days get the same buffer on the same SKU.
    Those are assumptions wearing the shape of a parameter.

SIGMA COMES FROM THE INTERVAL, NEVER FROM A POINT ESTIMATE
    This is why sheet 07 had to return p10/p50/p90. Without a spread there is
    no principled safety stock and the number is guessed:

        sigma_horizon = (p90 - p10) / (z(0.90) - z(0.10))

    The divisor is COMPUTED from the same quantile settings sheet 07 used, not
    written as 2.563 - so if those levels ever change, this follows rather than
    silently rescaling every safety stock in the estate.

    A forecast arriving without a usable interval is REFUSED. Substituting a
    default sigma would produce a confident-looking quantity resting on a
    number nobody measured, which is the failure this whole rebuild exists to
    remove.

LEAD TIME IS NOT IN THE WAREHOUSE
    Confirmed a fourth time for this sheet: `purchases` carries `date` and
    `invoice_date`, and ZERO columns matching receive / deliver / arrive /
    lead. `purchase_orders` has `po_date`, `invoice_date` and `due_date` - and
    0 rows. There is no observed interval between ordering and receiving
    anywhere in either database.

    So lead time is a DECLARED ASSUMPTION: a registry Setting, PROVISIONAL,
    carried in `assumptions` and surfaced on the card. The owner is told the
    number rests on it. A per-vendor override is accepted the moment anyone
    measures one; until then every store gets the same declared figure and
    knows it.

    CHECKLIST 16 - NOW IT CAN BE. Migration 037 gave `purchase_orders` a
    `received_date` (the parser reads it off a delivery note; the owner can set
    it), and Node's leadTimeService keeps a per-vendor median with its
    provenance. The policy therefore ALWAYS records a lead-time assumption
    sentence, in one of three shapes, so a card can never print a bare number:

        "a 7-day delivery lead time for X (supplier default, declared, not measured)"
        "a 4-day delivery lead time for X (measured from 4 receipts between A and B)"
        "a 3-day delivery lead time (supplied by the caller, provenance not stated)"

    The third exists for the harness and the tests, which hand in an override
    without saying where it came from; it must not read as measured. Before
    this, a supplied override recorded NO sentence at all - and `generate.py`
    withholds a reorder whose `lead_time_assumption` is empty, so the first
    measured vendor would have silently lost its cards.

SERVICE LEVEL IS A BUSINESS DECISION
    95% on a slow-moving mezcal ties up capital for a year. 85% on a top-20
    vodka loses sales every week. So it is a Setting per category family, not
    one global number buried in code, and every one is PROVISIONAL until
    somebody with commercial authority signs it off.

    The seeds are measured rather than invented - see SERVICE_LEVEL_* below.

WHAT THIS STAGE DOES NOT DO
    Round to case packs. Cap by shelf space. Apply MOQ. All of that is sheet
    11, and keeping them separate is exactly what lets the card explain why
    37.4 became 24.
"""

from __future__ import annotations

import math
import sys
from dataclasses import dataclass
from datetime import date
from typing import Any

from app.pipeline.context import RunContext
from app.pipeline.envelope import StageResult, stage
from app.pipeline.policy.holding import holding_cost
from app.pipeline.provenance import Provenance, record_inputs
from app.pipeline.registry import ConfigRegistry, Setting, cfg

PERCENT = 100

#: Bisection tolerance for the inverse normal CDF, derived from machine
#: epsilon rather than written as 1e-10: it is a property of floating-point
#: arithmetic, not a judgement about inventory, so it does not belong in the
#: registry - and a hardcoded constant would be wrong on a platform with
#: different precision.
_Z_TOLERANCE = sys.float_info.epsilon * 1024
#: Bisection bracket. Normal quantiles beyond +/-10 sigma are not reachable
#: from any service level a human would set.
_Z_BRACKET = 10

# ── Service level, per category family, seeded from measured margin and
#    turnover across 103,267 SKUs with both cost and revenue since 2026-01-01:
#
#      family    SKUs    units      margin%   units/SKU
#      beer      9,449   484,833    20.6      51.3   <- fastest turnover
#      spirits  18,540   710,625    29.5      38.3
#      default  66,616 2,446,057    29.1      36.7
#      wine      6,111   110,266    27.5      18.0   <- slowest turnover
#
#    Fast turnover means a stockout is noticed within days and costs repeat
#    visits; slow turnover means holding cost dominates and a stockout is rare
#    and cheap. That is the axis these seeds follow.

SERVICE_LEVEL_BEER = Setting(
    name="policy.service_level.beer",
    default=0.95,
    unit="probability of not stocking out in a lead time",
    owner="commercial",
    why="provisional; beer turns fastest in the estate - 51.3 units per SKU "
        "against wine's 18.0 - so a stockout is noticed within days and costs "
        "repeat visits, not just one sale. Its 20.6% margin is the lowest "
        "measured, which argues the other way, and turnover wins because "
        "beer is the trip driver. NEEDS COMMERCIAL SIGN-OFF",
    status="PROVISIONAL",
)

SERVICE_LEVEL_SPIRITS = Setting(
    name="policy.service_level.spirits",
    default=0.92,
    unit="probability of not stocking out in a lead time",
    owner="commercial",
    why="provisional; the highest measured margin (29.5%) on good turnover "
        "(38.3 units per SKU), so a lost sale is expensive but the shelf is "
        "not being emptied weekly. NEEDS COMMERCIAL SIGN-OFF",
    status="PROVISIONAL",
)

SERVICE_LEVEL_WINE = Setting(
    name="policy.service_level.wine",
    default=0.85,
    unit="probability of not stocking out in a lead time",
    owner="commercial",
    why="provisional, and deliberately the LOWEST. Wine turns slowest - 18.0 "
        "units per SKU, a third of beer's rate - so holding cost dominates "
        "and 95% service would tie up capital for a year on a bottle that "
        "sells four times. This is the sheet's own mezcal example, measured. "
        "NEEDS COMMERCIAL SIGN-OFF",
    status="PROVISIONAL",
)

SERVICE_LEVEL_DEFAULT = Setting(
    name="policy.service_level.default",
    default=0.90,
    unit="probability of not stocking out in a lead time",
    owner="commercial",
    why="provisional; the fallback for the 66,616 SKUs whose category does "
        "not map to a beer/wine/spirits family - mixers, snacks, tobacco and "
        "everything else. Their blended margin (29.1%) and turnover (36.7) "
        "sit near the estate middle, so the seed does too. NEEDS COMMERCIAL "
        "SIGN-OFF",
    status="PROVISIONAL",
)

SERVICE_LEVEL_BY_FAMILY: dict[str, Setting[float]] = {
    "beer": SERVICE_LEVEL_BEER,
    "spirits": SERVICE_LEVEL_SPIRITS,
    "wine": SERVICE_LEVEL_WINE,
    "default": SERVICE_LEVEL_DEFAULT,
}

LEAD_TIME_DAYS = Setting(
    name="policy.lead_time_days.declared",
    default=7,
    unit="calendar days between ordering and receiving",
    owner="operations",
    why="A DECLARED ASSUMPTION, not a measurement. Verified a fourth time for "
        "sheet 10: `purchases` has `date` and `invoice_date` and ZERO columns "
        "matching receive/deliver/arrive/lead; `purchase_orders` had po_date, "
        "invoice_date and due_date, and 0 rows. Seven days is a common "
        "distributor cycle and nothing more than that. It is carried in "
        "`assumptions` and surfaced on the card so the owner knows the "
        "quantity rests on it. Checklist 16: `purchase_orders.received_date` "
        "now exists (migration 037) and Node measures a per-vendor median "
        "from it; where that measurement exists the caller supplies it and "
        "this figure is NOT used. This remains the fallback for every vendor "
        "without enough receipts, and the card says which it got",
    status="PROVISIONAL",
)

#: The provenance values a caller may attach to a supplied lead time. Anything
#: else is treated as "supplied, provenance not stated" rather than guessed at.
LEAD_TIME_SOURCE_MEASURED = "measured"
LEAD_TIME_SOURCE_DEFAULT = "default"

REVIEW_PERIOD_DAYS = Setting(
    name="policy.review_period_days",
    default=7,
    unit="calendar days between reorder opportunities",
    owner="operations",
    why="provisional; how often the buyer can realistically place an order. "
        "The order-up-to level has to cover the lead time PLUS the wait until "
        "the next chance to order, or every cycle runs short by exactly the "
        "review gap. Overridden per supplier where an observed reorder cycle "
        "exists",
    status="PROVISIONAL",
)

MIN_SIGMA_RATIO = Setting(
    name="policy.min_sigma_ratio",
    default=0,
    unit="sigma as a fraction of mu",
    owner="forecasting",
    why="provisional, and ZERO on purpose. A floor here would manufacture "
        "safety stock for a SKU whose forecast is genuinely tight, which is "
        "the guessed-sigma failure this sheet refuses. It exists so that if "
        "wave 6 finds intervals are systematically too narrow, the fix is a "
        "measured setting rather than a constant appearing in the formula",
    status="PROVISIONAL",
)


# ── z(p): the inverse normal CDF, from math.erf ──────────────────────────────


def normal_cdf(x: float) -> float:
    """P(Z <= x). Exact to float precision via `math.erf`."""
    return (1 + math.erf(x / math.sqrt(2))) / 2


def z_for(probability: float) -> float:
    """Inverse normal CDF by bisection on `normal_cdf`.

    Bisection rather than a rational approximation (Acklam, Beasley-Springer-
    Moro) on purpose: those carry twenty-odd published float constants, and a
    wall of unexplained decimals is exactly what `check_no_literals` exists to
    keep out of this package. `math.erf` is in the standard library, the
    inverse is monotone, and bisection on a monotone function converges to
    float precision in about fifty iterations with nothing to tune.
    """
    if not 0.0 < probability < 1.0:
        raise ValueError(
            f"service level must be strictly between 0 and 1, got {probability}"
        )
    low, high = -float(_Z_BRACKET), float(_Z_BRACKET)
    while high - low > _Z_TOLERANCE:
        middle = (low + high) / 2
        if normal_cdf(middle) < probability:
            low = middle
        else:
            high = middle
    return (low + high) / 2


@dataclass(frozen=True, slots=True)
class PolicyRequest:
    """One SKU's forecast and stock position. Supplied, never fetched."""

    sku: str
    #: The category family (beer / wine / spirits / default) that selects the
    #: service level. Already resolved by the caller via `family_of`.
    family: str

    #: Sheet 07's interval over `horizon_open_days`. ALL THREE are required -
    #: see `estimate_policy` for why a missing interval is refused rather than
    #: defaulted.
    p10: float | None
    p50: float | None
    p90: float | None
    horizon_open_days: int

    on_hand: float
    #: None means UNKNOWN, not zero. No table in either database records
    #: outstanding orders (`purchase_orders` exists with 0 rows), so unknown
    #: is the normal state - but it is recorded as an assumption rather than
    #: silently treated as a measured zero.
    on_order: float | None = None

    #: Per-vendor override. None falls back to the declared Setting.
    lead_time_days: int | None = None
    review_period_days: int | None = None
    vendor: str | None = None
    #: N1.3 - the economics, so the service level can be DERIVED rather than
    #: taken from the declared family Setting. Supply both and the policy uses
    #: the newsvendor critical fractile; supply neither and it falls back to the
    #: declared level and says so. Appended, never inserted.
    unit_price: float | None = None
    unit_cost: float | None = None
    #: Checklist 16 - WHERE a supplied `lead_time_days` came from, so the
    #: assumption sentence can say "measured from 4 receipts" rather than
    #: nothing. "measured" needs `lead_time_observations` > 0 to be believed;
    #: "default" means the caller resolved the vendor but Node had too few
    #: receipts; None means the caller did not say. Appended, never inserted.
    lead_time_source: str | None = None
    lead_time_observations: int | None = None
    lead_time_measured_from: date | None = None
    lead_time_measured_to: date | None = None


def lead_time_assumption(
    lead_time: int,
    *,
    vendor: str | None,
    source: str | None,
    observations: int | None,
    measured_from: date | None,
    measured_to: date | None,
    declared: bool,
) -> str:
    """The one sentence every quantity carries about its lead time.

    Three shapes, and they must stay DISTINGUISHABLE by substring, because
    `run_decisions.py` and `generate.py` look for a lead-time sentence and the
    card prints it verbatim: "declared, not measured" marks a default, "measured
    from" marks a measurement, and the third shape says the caller supplied a
    figure without saying where it came from - which is not the same as
    measured and must not read as it.
    """
    who = f" for {vendor}" if vendor else ""
    head = f"a {lead_time}-day delivery lead time{who}"
    if declared or source == LEAD_TIME_SOURCE_DEFAULT:
        return f"{head} (supplier default, declared, not measured)"
    if source == LEAD_TIME_SOURCE_MEASURED and observations:
        receipts = "receipt" if observations == 1 else "receipts"
        window = ""
        if measured_from is not None and measured_to is not None:
            window = (f" between {measured_from.isoformat()} and "
                      f"{measured_to.isoformat()}")
        return f"{head} (measured from {observations} {receipts}{window})"
    return f"{head} (supplied by the caller, provenance not stated)"


@dataclass(frozen=True, slots=True)
class InventoryPolicy:
    """The IDEAL quantity, and every input that produced it."""

    sku: str
    family: str
    mu_daily: float
    sigma_daily: float
    service_level: float
    z: float
    lead_time_days: int
    review_period_days: int
    safety_stock: float
    reorder_point: float
    order_up_to: float
    on_hand: float
    on_order: float
    ideal_qty: float
    #: Every number in this result that is DECLARED rather than measured.
    #: Surfaced on the card; never empty in practice, because lead time is
    #: always one of them until somebody measures it.
    assumptions: tuple[str, ...]

    @property
    def should_order(self) -> bool:
        return self.ideal_qty > 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "sku": self.sku, "family": self.family,
            "mu_daily": self.mu_daily, "sigma_daily": self.sigma_daily,
            "service_level": self.service_level, "z": self.z,
            "lead_time_days": self.lead_time_days,
            "review_period_days": self.review_period_days,
            "safety_stock": self.safety_stock,
            "reorder_point": self.reorder_point,
            "order_up_to": self.order_up_to,
            "on_hand": self.on_hand, "on_order": self.on_order,
            "ideal_qty": self.ideal_qty,
            "assumptions": list(self.assumptions),
        }

    def explain(self) -> str:
        """The sentence the card says, assumptions included.

        The assumptions are in the SAME sentence as the number, not a footnote.
        A quantity resting on a declared lead time and a quantity resting on a
        measured one look identical once they are both integers.
        """
        base = (
            f"Order {self.ideal_qty:.0f}: enough to cover "
            f"{self.lead_time_days} days of delivery plus "
            f"{self.review_period_days} days until the next order "
            f"({self.mu_daily:.1f}/day), with {self.safety_stock:.0f} spare "
            f"for a {self.service_level:.0%} chance of not running out"
        )
        if self.on_order:
            base += f", less {self.on_order:.0f} already on the way"
        if self.assumptions:
            base += f". Assumes: {'; '.join(self.assumptions)}"
        return base + "."


def service_level_for(
    family: str, ctx: RunContext, config: ConfigRegistry = cfg
) -> float:
    """The service level for a category family, from the registry."""
    setting = SERVICE_LEVEL_BY_FAMILY.get(
        family, SERVICE_LEVEL_BY_FAMILY["default"]
    )
    return float(config.get(setting, ctx))


# ── N1.3: the service level is DERIVED, not declared ────────────────────────
#
# The four SERVICE_LEVEL_* Settings above are PROVISIONAL and documented as
# "NEEDS COMMERCIAL SIGN-OFF". They do not need sign-off, because the service
# level is not a preference - it is the newsvendor critical fractile, and it is
# computable per SKU from figures already in the warehouse:
#
#     q* = Cu / (Cu + Co)
#     Cu = unit margin                     what a stockout costs
#     Co = holding cost for ONE CYCLE      what one surplus unit costs
#
# WHY THIS COMES OUT HIGH, AND WHY THAT IS THE POINT
#     Liquor does not spoil, so Co is small: on a $20 spirit over a 14-day cycle
#     it is about 35 cents against $10 of margin, giving q* near 0.97. The engine
#     should stock these GENEROUSLY. That is the exact opposite direction from
#     the promise, which wants a LOW quantile - and the two pulling apart is the
#     whole architecture of N1: a 14-unit mean promises about 10 and orders 19.
#     One number cannot do both jobs, which is why it was wrong at both.
#
# WHY THE DECLARED SETTINGS STAY
#     Five of ten audited stores send no unit cost at all, so there is no margin
#     and no fractile to compute. Those stores fall back to the declared family
#     level, and the card says which basis it used - a computed fractile and a
#     commercial guess should not be indistinguishable on the wire.


Q_STAR_FLOOR = Setting(
    name="policy.q_star.floor",
    default=0.70,
    unit="probability of not stocking out in a lead time",
    owner="forecasting",
    why="provisional. A floor on the DERIVED fractile, not on the policy. A "
        "thin-margin, high-hazard SKU can compute a fractile in the 0.5s, and "
        "below about 0.70 the quantile is so far into the body of the "
        "distribution that sigma_from_interval - which recovers sigma from a "
        "p10/p90 spread assuming normality - is being asked for a number the "
        "interval does not support. The clamp is an admission about the "
        "INTERVAL, not about the economics, and it is recorded on the result so "
        "a clamped SKU is visible rather than quietly rounded. It becomes "
        "MEASURED when per-class intervals exist and the supportable range is "
        "known rather than assumed",
    status="PROVISIONAL",
)

Q_STAR_CEILING = Setting(
    name="policy.q_star.ceiling",
    default=0.98,
    unit="probability of not stocking out in a lead time",
    owner="forecasting",
    why="provisional. Liquor's carrying cost is so small against its margin "
        "that q* runs to 0.97 and beyond, and at 0.99 the normal z is 2.33 "
        "against 1.88 at 0.97 - a quarter more safety stock bought on the "
        "strength of a tail nobody has measured. The ceiling says the engine "
        "will not order against the extreme tail of an interval that was only "
        "ever calibrated in its middle. It becomes MEASURED the moment interval "
        "coverage is verified above the 95th percentile",
    status="PROVISIONAL",
)


@dataclass(frozen=True, slots=True)
class ServiceLevel:
    """The service level actually used, and where it came from."""

    value: float
    #: "critical_fractile" or "declared_family:<family>". A card must be able to
    #: say which, because a derived number and a commercial guess carry very
    #: different weight and look identical once they are both a float.
    basis: str
    unit_margin: float | None
    #: Cost of holding ONE surplus unit for one cycle. None when unknown.
    holding_per_unit: float | None
    cycle_days: int
    #: True when the economics asked for a quantile outside the clamp.
    clamped: bool

    @property
    def is_derived(self) -> bool:
        return self.basis == "critical_fractile"

    def as_dict(self) -> dict[str, Any]:
        return {
            "value": self.value, "basis": self.basis,
            "unit_margin": self.unit_margin,
            "holding_per_unit": self.holding_per_unit,
            "cycle_days": self.cycle_days, "clamped": self.clamped,
        }

    def explain(self) -> str:
        if not self.is_derived:
            return (
                f"Service level {self.value:.0%}, the declared level for this "
                f"category - this store sends no unit cost, so the economic "
                f"trade-off cannot be computed."
            )
        base = (
            f"Service level {self.value:.0%}, computed from ${self.unit_margin:.2f} "
            f"of margin against ${self.holding_per_unit:.2f} of holding cost over "
            f"{self.cycle_days} days"
        )
        return base + (", clamped." if self.clamped else ".")


def service_level_for_sku(
    *,
    category_family: str | None,
    unit_price: float | None,
    unit_cost: float | None,
    ctx: RunContext,
    config: ConfigRegistry = cfg,
    lead_time_days: int | None = None,
    review_period_days: int | None = None,
) -> ServiceLevel:
    """q* where the economics are known, the declared level where they are not.

    `category_family` is the CATEGORY family (beer / wine / spirits), not the
    recommendation family - the same overloaded word that `hazard_for` guards
    against by naming its parameter.
    """
    lead = (lead_time_days if lead_time_days is not None
            else int(config.get(LEAD_TIME_DAYS, ctx)))
    review = (review_period_days if review_period_days is not None
              else int(config.get(REVIEW_PERIOD_DAYS, ctx)))
    cycle = lead + review

    # The same margin rule the outcome grader uses, so the economics the engine
    # orders against and the money it is later scored on cannot disagree.
    margin: float | None = None
    if (unit_price is not None and unit_cost is not None
            and 0 < unit_cost < unit_price):
        margin = unit_price - unit_cost

    fallback = ServiceLevel(
        value=service_level_for(category_family or "default", ctx, config),
        basis=f"declared_family:{category_family or 'default'}",
        unit_margin=margin, holding_per_unit=None,
        cycle_days=cycle, clamped=False,
    )
    if margin is None or unit_cost is None:
        return fallback

    held = holding_cost(1.0, unit_cost, cycle, ctx, config,
                        category_family=category_family)
    if held is None:
        return fallback
    co = held.total
    raw = margin / (margin + co) if (margin + co) > 0 else 1.0

    floor = float(config.get(Q_STAR_FLOOR, ctx))
    ceiling = float(config.get(Q_STAR_CEILING, ctx))
    clamped = min(max(raw, floor), ceiling)
    return ServiceLevel(
        value=clamped,
        basis="critical_fractile",
        unit_margin=margin,
        holding_per_unit=co,
        cycle_days=cycle,
        clamped=clamped != raw,
    )


def sigma_from_interval(
    p10: float, p90: float, lower_q: float, upper_q: float
) -> float:
    """Recover sigma from a central interval, assuming normality.

    The divisor is COMPUTED from the quantile levels sheet 07 actually used,
    not written as 2.563. If those levels ever change, every safety stock in
    the estate follows rather than silently rescaling.

    The normality assumption is the weak point and worth naming: sheet 07's
    intervals come from a bootstrap and are frequently SKEWED, especially for
    intermittent and lumpy SKUs where the upper tail is long. A skewed
    interval converted this way overstates sigma slightly, which buys slightly
    more safety stock than strictly needed - erring toward holding stock
    rather than toward stocking out, which is the safer error for a shelf.
    """
    spread = z_for(upper_q) - z_for(lower_q)
    if spread <= 0:
        raise ValueError(
            f"upper quantile {upper_q} must exceed lower quantile {lower_q}"
        )
    return max(0.0, (p90 - p10) / spread)


@stage("policy_inventory", "1.0.0")
def estimate_policy(
    request: PolicyRequest, ctx: RunContext, config: ConfigRegistry = cfg
) -> StageResult:
    """The ideal order quantity for one SKU. Refuses rather than guessing.

    Returns ok=False when the forecast carries no usable interval. Substituting
    a default sigma would produce a confident-looking quantity resting on a
    number nobody measured.
    """
    record_inputs("forecast_ensemble.p10", "forecast_ensemble.p50",
                  "forecast_ensemble.p90", "products.stock_qty")

    from app.pipeline.calibrate.fit import FAMILIES  # noqa: F401  (registry warm)
    from storeagent.forecasting.ensemble import LOWER_QUANTILE, UPPER_QUANTILE

    if request.horizon_open_days < 1:
        return StageResult.failure(
            f"horizon_must_be_at_least_one_open_day:{request.horizon_open_days}",
            provenance=_provenance(()),
        )

    # THE REFUSAL. A point estimate is not enough to size a buffer.
    if request.p50 is None:
        return StageResult.failure(
            "no_forecast:cannot_size_an_order_without_one",
            provenance=_provenance(()),
        )
    if request.p10 is None or request.p90 is None:
        return StageResult.failure(
            "forecast_has_no_interval:refusing_to_substitute_a_default_sigma",
            provenance=_provenance(()),
        )
    if request.p90 < request.p10:
        return StageResult.failure(
            f"interval_is_inverted:p10={request.p10:.3f}>p90={request.p90:.3f}",
            provenance=_provenance(()),
        )

    assumptions: list[str] = []

    # ALWAYS recorded, whichever way the figure arrived. A supplied override
    # used to record nothing, which left a measured vendor's card unable to
    # say it was measured - and `generate.py` withholding the reorder for
    # want of any lead-time sentence at all.
    declared = request.lead_time_days is None
    lead_time = (int(config.get(LEAD_TIME_DAYS, ctx)) if declared
                 else request.lead_time_days)
    assumptions.append(lead_time_assumption(
        lead_time,
        vendor=request.vendor,
        source=request.lead_time_source,
        observations=request.lead_time_observations,
        measured_from=request.lead_time_measured_from,
        measured_to=request.lead_time_measured_to,
        declared=declared,
    ))
    if lead_time < 1:
        return StageResult.failure(
            f"lead_time_must_be_at_least_one_day:{lead_time}",
            provenance=_provenance(tuple(assumptions)),
        )

    review_period = request.review_period_days
    if review_period is None:
        review_period = int(config.get(REVIEW_PERIOD_DAYS, ctx))
        assumptions.append(f"ordering again in {review_period} days")

    on_order = request.on_order
    if on_order is None:
        # UNKNOWN, not zero - and said so. `purchase_orders` exists with 0
        # rows, so nothing records outstanding orders anywhere. Treating
        # unknown as a measured zero is how a store orders twice for stock
        # already on its way.
        on_order = 0.0
        assumptions.append("nothing already on order (not recorded anywhere)")

    # ── The arithmetic ───────────────────────────────────────────────────
    lower_q = float(config.get(LOWER_QUANTILE, ctx))
    upper_q = float(config.get(UPPER_QUANTILE, ctx))
    sigma_horizon = sigma_from_interval(request.p10, request.p90, lower_q, upper_q)

    mu_daily = request.p50 / request.horizon_open_days
    # Independence across days: sigma over H days scales as sqrt(H), so the
    # per-day sigma is the horizon sigma divided by sqrt(H). Demand is in fact
    # autocorrelated (a busy week is busy on several days), which makes this
    # an UNDER-estimate of daily variance - the same direction as the skew
    # note in sigma_from_interval, and the opposite of dangerous.
    sigma_daily = sigma_horizon / math.sqrt(request.horizon_open_days)

    floor_ratio = float(config.get(MIN_SIGMA_RATIO, ctx))
    if floor_ratio > 0:
        sigma_daily = max(sigma_daily, floor_ratio * mu_daily)

    # N1.3 - DERIVE the service level from this SKU's own economics where they
    # are known, and fall back to the declared family level where they are not.
    # The basis travels into the assumptions, because a computed fractile and a
    # commercial guess look identical once they are both a float.
    sl = service_level_for_sku(
        category_family=request.family,
        unit_price=request.unit_price,
        unit_cost=request.unit_cost,
        ctx=ctx, config=config,
        lead_time_days=request.lead_time_days,
        review_period_days=request.review_period_days,
    )
    service_level = sl.value
    if sl.is_derived:
        assumptions.append(
            f"service level {service_level:.0%} computed from "
            f"${sl.unit_margin:.2f} margin against ${sl.holding_per_unit:.2f} "
            f"of holding cost over {sl.cycle_days} days"
            + (" (clamped)" if sl.clamped else "")
        )
    else:
        assumptions.append(
            f"service level {service_level:.0%} is the DECLARED level for "
            f"{request.family} - no unit cost, so the trade-off could not be "
            f"computed"
        )
    z = z_for(service_level)

    safety_stock = z * sigma_daily * math.sqrt(lead_time)
    reorder_point = mu_daily * lead_time + safety_stock
    order_up_to = reorder_point + review_period * mu_daily
    # on_order SUBTRACTED. The existing buying.py subtracts only on_hand, so a
    # store that ordered yesterday and has not received it orders the same
    # quantity again today.
    ideal_qty = max(0.0, order_up_to - request.on_hand - on_order)

    policy = InventoryPolicy(
        sku=request.sku,
        family=request.family,
        mu_daily=mu_daily,
        sigma_daily=sigma_daily,
        service_level=service_level,
        z=z,
        lead_time_days=lead_time,
        review_period_days=review_period,
        safety_stock=safety_stock,
        reorder_point=reorder_point,
        order_up_to=order_up_to,
        on_hand=request.on_hand,
        on_order=on_order,
        ideal_qty=ideal_qty,
        assumptions=tuple(assumptions),
    )
    return StageResult.success(policy, _provenance(tuple(assumptions)))


def _provenance(assumptions: tuple[str, ...]) -> Provenance:
    return Provenance(
        own_observations=0,
        own_weight=1.0,
        evidence_state="ESTABLISHED" if not assumptions else "EMERGING",
        inputs=("forecast_ensemble.p10", "forecast_ensemble.p50",
                "forecast_ensemble.p90", "products.stock_qty"),
    )


__all__ = [
    "LEAD_TIME_DAYS",
    "LEAD_TIME_SOURCE_DEFAULT",
    "LEAD_TIME_SOURCE_MEASURED",
    "MIN_SIGMA_RATIO",
    "REVIEW_PERIOD_DAYS",
    "SERVICE_LEVEL_BY_FAMILY",
    "SERVICE_LEVEL_DEFAULT",
    "InventoryPolicy",
    "PolicyRequest",
    "estimate_policy",
    "lead_time_assumption",
    "normal_cdf",
    "service_level_for",
    "sigma_from_interval",
    "z_for",
]
