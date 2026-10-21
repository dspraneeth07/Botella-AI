"""The incremental feature-store builder.

Turns raw POS rows into `feature_daily` (sparse facts) and `feature_store_day`
(the dense calendar). Two responsibilities, kept apart:

  * `FEATURE_DAILY_SQL` / `STORE_DAY_SQL` — the extraction, which must live in
    SQL because it reads 19.7M sale_items rows and Postgres is where that
    belongs.
  * `derive_calendar` / `merge_day_facts` — the pure transformations, which are
    sheet-00 stages so they can be tested from a fixture with no database.

THE CANONICAL SALES RULE, COPIED EXACTLY
    The builder is only useful if it reconciles to what the Purchasing screen
    shows. That screen, `integrationService.getSales`, and storeagent's
    forecast repo all apply the same four rules, so the builder applies them
    too — deviating by even one would recreate the 454-vs-485 problem in a new
    place:

      1. UPC→SKU canonicalisation. A line rung under a barcode is credited to
         the canonical products.sku, resolved DISTINCT ON (join key) with the
         sku claim first, then the row holding stock.
      2. VOID receipts excluded by sale_id.
      3. quantity > 0 only.
      4. Non-empty sku only.
      5. units = SUM(quantity); unit_price = SUM(total_amount)/SUM(quantity),
         revenue-weighted, NEVER a plain AVG (ARCHITECTURE Rule 6a).

    Measured on Bethany (171:171) over 28 days: naive SUM(quantity) gives
    5,942 and the canonical rule gives 5,945 — a 3-unit spread on that store.
    Small here, not small everywhere, and free to get right.

WHAT THE BUILDER WILL NOT INVENT
    `on_hand` is NULL for every historical row. syncgo's products.stock_qty is
    CURRENT-only (last_updated mutates on each sync), so there is no on-hand
    history to reconstruct. Back-filling it from today's stock would be the
    most confident lie in the table: it would tell a backtest that a SKU which
    stocked out in March had 40 units all along.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from app.pipeline.context import RunContext
from app.pipeline.envelope import StageResult, stage
from app.pipeline.features.store import CalendarDay, DayFact
from app.pipeline.provenance import EvidenceState, Provenance, record_inputs
from app.pipeline.registry import ConfigRegistry, Setting, cfg

# ── Thresholds ───────────────────────────────────────────────────────────────

CLOSED_RUN_IS_OUTAGE_DAYS = Setting(
    name="features.calendar.closed_run_is_outage_days",
    default=5,
    unit="consecutive days",
    owner="feature-store",
    why="provisional; a store that closes for one or two days is on holiday, "
        "but a five-day silence is far more likely to be a dead sync than a "
        "closure, and calling it 'closed' would hide an outage behind a "
        "plausible-looking calendar. To be fitted in wave 6",
    status="PROVISIONAL",
)

BUILD_LOOKBACK_DAYS = Setting(
    name="features.build.lookback_days",
    default=7,
    unit="days",
    owner="feature-store",
    why="provisional; how far back an incremental build re-reads to absorb "
        "late-arriving rows. Must exceed the worst observed POS lag",
    status="PROVISIONAL",
)


# ── Extraction SQL ───────────────────────────────────────────────────────────
# Bound parameters: %(cid)s, %(lid)s, %(start)s, %(end)s.
# `end` is ctx.as_of — NEVER max(sale_date). See store.py rule 3.

#: The canonical join-key catalogue. Lifted verbatim in shape from
#: integrationService.getSales so the two cannot drift.
_CATALOG_CTE = """
catalog AS (
  SELECT DISTINCT ON (jk) jk, sku
    FROM (
      SELECT sku, sku AS jk, 0 AS jk_pri, stock_qty AS jk_stock
        FROM products
       WHERE client_id = %(cid)s AND location_id = %(lid)s
         AND is_deleted IS NOT TRUE AND NULLIF(TRIM(sku), '') IS NOT NULL
      UNION ALL
      SELECT sku, upc AS jk, 1 AS jk_pri, stock_qty AS jk_stock
        FROM products
       WHERE client_id = %(cid)s AND location_id = %(lid)s
         AND is_deleted IS NOT TRUE AND NULLIF(TRIM(upc), '') IS NOT NULL
         AND NULLIF(TRIM(sku), '') IS NOT NULL
    ) u
   ORDER BY jk, jk_pri, jk_stock DESC NULLS LAST, sku
),
voids AS (
  SELECT sale_id FROM sales
   WHERE client_id = %(cid)s AND location_id = %(lid)s
     AND sale_status = 'VOID' AND sale_id IS NOT NULL
)
"""

#: One row per (sku, day) that had activity. SPARSE by construction.
FEATURE_DAILY_SQL = f"""
WITH {_CATALOG_CTE},
     lines AS (
       SELECT COALESCE(c.sku, si.sku) AS sku,
              si.sale_date::date       AS obs_date,
              si.quantity,
              si.total_amount,
              si.sale_id
         FROM sale_items si
         LEFT JOIN catalog c ON c.jk = si.sku
        WHERE si.client_id = %(cid)s AND si.location_id = %(lid)s
          AND si.sale_date >= %(start)s AND si.sale_date < (%(end)s::date + 1)
          AND NULLIF(TRIM(si.sku), '') IS NOT NULL
          AND si.quantity > 0
          AND (si.sale_id IS NULL OR si.sale_id NOT IN (SELECT sale_id FROM voids))
     )
SELECT sku,
       obs_date,
       SUM(quantity)                                   AS units_sold,
       SUM(total_amount)                               AS revenue,
       -- Revenue-weighted, never AVG (ARCHITECTURE Rule 6a).
       ROUND(SUM(total_amount) / NULLIF(SUM(quantity), 0), 4) AS price,
       COUNT(DISTINCT sale_id)                         AS baskets_containing
  FROM lines
 GROUP BY sku, obs_date
 ORDER BY obs_date, sku
"""

#: One row per DAY the store transacted. The dense calendar is derived from
#: this in Python (derive_calendar) because the gaps are the interesting part
#: and SQL cannot see a day that is not there.
STORE_DAY_SQL = f"""
WITH {_CATALOG_CTE}
SELECT si.sale_date::date                AS obs_date,
       COUNT(DISTINCT si.sale_id)        AS baskets,
       SUM(si.total_amount)              AS revenue,
       SUM(si.quantity)                  AS units_total,
       COUNT(DISTINCT COALESCE(c.sku, si.sku)) AS distinct_skus
  FROM sale_items si
  LEFT JOIN catalog c ON c.jk = si.sku
 WHERE si.client_id = %(cid)s AND si.location_id = %(lid)s
   AND si.sale_date >= %(start)s AND si.sale_date < (%(end)s::date + 1)
   AND NULLIF(TRIM(si.sku), '') IS NOT NULL
   AND si.quantity > 0
   AND (si.sale_id IS NULL OR si.sale_id NOT IN (SELECT sale_id FROM voids))
 GROUP BY si.sale_date::date
 ORDER BY 1
"""

#: The point-in-time read. `known_at <= %(known_as_of)s` is the clause that
#: stops a backtest seeing rows that had not arrived yet.
FEATURE_WINDOW_SQL = """
SELECT f.sku, f.obs_date, f.units_sold, f.revenue, f.unit_cost,
       f.on_hand, f.price, f.baskets_containing, f.known_at
  FROM feature_daily f
 WHERE f.client_id = %(cid)s AND f.location_id = %(lid)s
   AND f.obs_date >= %(start)s AND f.obs_date <= %(end)s
   AND f.known_at <= %(known_as_of)s
 ORDER BY f.obs_date, f.sku
"""

CALENDAR_WINDOW_SQL = """
SELECT d.obs_date, d.was_open, d.has_data, d.open_source
  FROM feature_store_day d
 WHERE d.client_id = %(cid)s AND d.location_id = %(lid)s
   AND d.obs_date >= %(start)s AND d.obs_date <= %(end)s
 ORDER BY d.obs_date
"""


# ── Pure transformations ─────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class TradingDay:
    """A day the store demonstrably transacted."""

    obs_date: date
    baskets: int | None = None
    revenue: float | None = None
    units_total: float | None = None
    distinct_skus: int | None = None


@dataclass(frozen=True, slots=True)
class CalendarRequest:
    trading_days: Sequence[TradingDay]
    start_date: date
    end_date: date
    #: Last day sync has actually delivered. Days after it are UNKNOWN, not
    #: closed — the distinction that replaces the data-frontier anchor.
    synced_through: date | None = None


@stage("derive_store_calendar", "1.0.0")
def derive_calendar(
    request: CalendarRequest, ctx: RunContext, config: ConfigRegistry = cfg
) -> StageResult:
    """Build the dense calendar from observed trading days.

    AT STORE GRAIN, never per SKU. A SKU that sold nothing on Tuesday is
    indistinguishable from a closed Tuesday if you look at that SKU alone;
    at store grain it is obvious, because the store rang up 340 other items.

    Three states, and keeping them apart is the point:

      was_open=True,  has_data=True   the store traded. Counts as a denominator.
      was_open=False                  closed. Bethany's 191 Sundays.
      was_open=True,  has_data=False  we do not know yet — sync has not
                                      delivered it. Excluded from denominators
                                      exactly like a closure, but for a
                                      different reason and recoverable.

    A long unbroken silence is reported as `no_sync` rather than as a closure.
    A store does not shut for five days without warning nearly as often as a
    connector dies, and labelling an outage "closed" hides it behind a
    plausible-looking calendar.
    """
    record_inputs("sale_items.sale_date")

    traded = {t.obs_date: t for t in request.trading_days}
    outage_days = config.get(CLOSED_RUN_IS_OUTAGE_DAYS, ctx)
    synced_through = request.synced_through

    span = (request.end_date - request.start_date).days + 1
    if span < 1:
        return StageResult.failure(
            "empty_date_range",
            provenance=Provenance(own_observations=0, own_weight=1.0,
                                  evidence_state="NEW"),
        )

    all_days = [request.start_date + timedelta(days=i) for i in range(span)]

    # Find runs of consecutive non-trading days so an outage can be told from
    # a Sunday. Done in one pass over the span.
    non_trading_run: dict[date, int] = {}
    run: list[date] = []
    for day in all_days:
        if day in traded:
            for d in run:
                non_trading_run[d] = len(run)
            run = []
        else:
            run.append(day)
    for d in run:
        non_trading_run[d] = len(run)

    calendar: list[CalendarDay] = []
    for day in all_days:
        if day in traded:
            calendar.append(CalendarDay(day, was_open=True, has_data=True,
                                        open_source="observed"))
        elif synced_through is not None and day > synced_through:
            # Beyond what sync has delivered: unknown, not shut.
            calendar.append(CalendarDay(day, was_open=True, has_data=False,
                                        open_source="no_sync"))
        elif non_trading_run.get(day, 0) >= outage_days:
            calendar.append(CalendarDay(day, was_open=True, has_data=False,
                                        open_source="no_sync"))
        else:
            calendar.append(CalendarDay(day, was_open=False, has_data=True,
                                        open_source="assumed_closed"))

    open_days = sum(1 for c in calendar if c.was_open and c.has_data)
    closed = sum(1 for c in calendar if not c.was_open)
    unsynced = sum(1 for c in calendar if c.was_open and not c.has_data)

    evidence: EvidenceState = (
        "MATURE" if open_days >= 90 else
        "ESTABLISHED" if open_days >= 21 else
        "EMERGING" if open_days else "NEW"
    )
    provenance = Provenance(
        own_observations=open_days,
        own_weight=1.0,
        evidence_state=evidence,
        inputs=("sale_items.sale_date",),
    )

    notes: list[str] = []
    if closed:
        notes.append(f"closed_days:{closed}")
    if unsynced:
        notes.append(f"unsynced_days:{unsynced}")
    return StageResult.success(
        {"calendar": calendar, "open_days": open_days,
         "closed_days": closed, "unsynced_days": unsynced,
         "calendar_days": span},
        provenance, reasons=tuple(notes),
    )


@dataclass(frozen=True, slots=True)
class MergeRequest:
    """Facts from sales, joined to whatever catalogue attributes we have."""

    facts: Sequence[DayFact]
    calendar: Sequence[CalendarDay]
    #: sku -> unit cost. Absent where the connector omits it; NEVER defaulted
    #: to 0, which would make every margin 100%.
    unit_cost_by_sku: dict[str, float | None] | None = None
    known_at: datetime | None = None


@stage("merge_day_facts", "1.0.0")
def merge_day_facts(
    request: MergeRequest, ctx: RunContext, config: ConfigRegistry = cfg
) -> StageResult:
    """Attach costs and the point-in-time stamp; drop closed-day rows.

    A fact on a day the calendar says was CLOSED is a contradiction — most
    often a timezone-shifted receipt. It is dropped and counted rather than
    written, because a row on a closed day would make `was_open` a lie and
    the denominator wrong in the one direction nobody checks.
    """
    record_inputs("products.cost")

    open_by_date = {c.obs_date: c for c in request.calendar}
    costs = request.unit_cost_by_sku or {}
    stamp = request.known_at

    merged: list[DayFact] = []
    on_closed_day = 0
    outside_calendar = 0

    for fact in request.facts:
        day = open_by_date.get(fact.obs_date)
        if day is None:
            outside_calendar += 1
            continue
        if not day.was_open:
            on_closed_day += 1
            continue
        # NOT `costs.get(sku, 0)`. A missing cost stays None so no margin can
        # be built on it — the completeness gate (sheet 02) then marks the
        # field unavailable and the admission gate withholds the claim.
        cost = costs.get(fact.sku)
        merged.append(
            DayFact(
                obs_date=fact.obs_date, sku=fact.sku,
                units_sold=fact.units_sold, revenue=fact.revenue,
                unit_cost=cost if cost is not None and cost > 0 else None,
                on_hand=fact.on_hand, price=fact.price,
                baskets_containing=fact.baskets_containing,
                known_at=stamp or fact.known_at,
            )
        )

    provenance = Provenance(
        own_observations=len(merged),
        own_weight=1.0,
        evidence_state="ESTABLISHED" if merged else "NEW",
        inputs=("feature_daily", "products.cost"),
    )
    notes: list[str] = []
    if on_closed_day:
        notes.append(f"dropped_facts_on_closed_days:{on_closed_day}")
    if outside_calendar:
        notes.append(f"dropped_facts_outside_calendar:{outside_calendar}")

    with_cost = sum(1 for f in merged if f.unit_cost is not None)
    return StageResult.success(
        {"facts": merged, "rows": len(merged),
         "rows_with_cost": with_cost,
         "cost_coverage_pct": (100 * with_cost // len(merged)) if merged else 0,
         "dropped_on_closed_days": on_closed_day,
         "dropped_outside_calendar": outside_calendar},
        provenance, reasons=tuple(notes),
    )


def incremental_bounds(ctx: RunContext, config: ConfigRegistry = cfg) -> tuple[date, date]:
    """The window an incremental build re-reads.

    Ends at ctx.as_of, never at max(sale_date). Starts a lookback earlier so
    late-arriving rows are absorbed — a POS that delivers Tuesday's receipts on
    Thursday must not leave Tuesday permanently thin.
    """
    lookback = config.get(BUILD_LOOKBACK_DAYS, ctx)
    return ctx.as_of - timedelta(days=lookback), ctx.as_of


def upsert_params(
    ctx: RunContext, facts: Iterable[DayFact], known_at: datetime | None = None
) -> list[tuple]:
    """Rows ready for the feature_daily upsert, in column order."""
    stamp = known_at or datetime.combine(ctx.as_of, datetime.min.time())
    return [
        (
            ctx.tenant_id, ctx.store_id, f.sku, f.obs_date,
            f.units_sold, f.revenue, f.unit_cost, f.on_hand, f.price,
            f.baskets_containing, f.known_at or stamp,
        )
        for f in facts
    ]


UPSERT_FEATURE_DAILY_SQL = """
INSERT INTO feature_daily
  (client_id, location_id, sku, obs_date, units_sold, revenue, unit_cost,
   on_hand, price, baskets_containing, known_at, updated_at)
VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s, now())
ON CONFLICT (client_id, location_id, sku, obs_date) DO UPDATE SET
  units_sold = EXCLUDED.units_sold,
  revenue    = EXCLUDED.revenue,
  unit_cost  = COALESCE(EXCLUDED.unit_cost, feature_daily.unit_cost),
  on_hand    = COALESCE(EXCLUDED.on_hand,   feature_daily.on_hand),
  price      = EXCLUDED.price,
  baskets_containing = EXCLUDED.baskets_containing,
  -- known_at is NEVER advanced on update: it records when the fact FIRST
  -- became known, and moving it forward would let a backtest see a row
  -- earlier than it really arrived.
  updated_at = now()
"""

UPSERT_STORE_DAY_SQL = """
INSERT INTO feature_store_day
  (client_id, location_id, obs_date, was_open, has_data, open_source,
   baskets, revenue, units_total, distinct_skus, known_at, updated_at)
VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s, now())
ON CONFLICT (client_id, location_id, obs_date) DO UPDATE SET
  was_open    = EXCLUDED.was_open,
  has_data    = EXCLUDED.has_data,
  open_source = EXCLUDED.open_source,
  baskets     = EXCLUDED.baskets,
  revenue     = EXCLUDED.revenue,
  units_total = EXCLUDED.units_total,
  distinct_skus = EXCLUDED.distinct_skus,
  updated_at  = now()
"""


__all__ = [
    "BUILD_LOOKBACK_DAYS",
    "CALENDAR_WINDOW_SQL",
    "CLOSED_RUN_IS_OUTAGE_DAYS",
    "FEATURE_DAILY_SQL",
    "FEATURE_WINDOW_SQL",
    "STORE_DAY_SQL",
    "UPSERT_FEATURE_DAILY_SQL",
    "UPSERT_STORE_DAY_SQL",
    "CalendarRequest",
    "MergeRequest",
    "TradingDay",
    "derive_calendar",
    "incremental_bounds",
    "merge_day_facts",
    "upsert_params",
]
