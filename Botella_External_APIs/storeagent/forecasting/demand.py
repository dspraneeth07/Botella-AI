"""Demand model: day-of-week seasonal average x recent-trend factor.

Explainable by design: expected demand on a future day = the average units sold
on that weekday over the SKU's selling life (up to a year), scaled by how its
recent pace compares to that lifetime rate. No black box. Captures the
weekend/holiday surge that dominates liquor sales, plus recent up/down trend.

Every rate divides by the days the SKU has ACTUALLY BEEN SELLING (`days_live`),
never by the full calendar window. A product first sold four weeks ago has no
sales across the preceding eleven months because it wasn't on the shelf; dividing
its units by 365 understates its true rate ~13x, and the trend ratio that
corrects for it then pins to the clamp ceiling — so every new listing reads as a
fake "3x accelerating" while its 30-day projection comes out ~4x too low. For a
SKU with a full year of history `days_live` saturates and nothing changes.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta

from ..config import FORECAST, ForecastThresholds


def pg_dow(d: date) -> int:
    """Postgres-style day-of-week: Sunday=0 .. Saturday=6."""
    return d.isoweekday() % 7


def dow_counts_between(start: date, end: date) -> list[int]:
    """How many of each weekday fall in [start, end], both ends inclusive.

    Inclusive on purpose: it is the denominator for units summed with
    `sale_date >= start` (through as_of), so the two must span the same days.
    """
    counts = [0] * 7
    if end < start:
        return counts
    for i in range((end - start).days + 1):
        counts[pg_dow(start + timedelta(days=i))] += 1
    return counts


@dataclass
class SkuDemand:
    sku: str
    product_name: str | None
    category: str
    on_hand: int
    cost: float | None
    price: float | None
    units_28: int
    units_90: int
    units_365: int
    last_sale: date | None
    dow_units: list[float]          # units sold per weekday (Sun..Sat) over the window
    as_of: date
    window_days: int = 365
    units_30: int = 0               # last-30d units (shown on Lost Revenue rows)
    first_sale: date | None = None  # earliest sale in the window -> shelf age
    # Per-supplier replenishment (refinement; None -> use flat defaults).
    supplier_id: str | None = None
    supplier_name: str | None = None
    reorder_cycle_days: int | None = None   # observed median gap between restocks
    last_purchase_date: date | None = None  # when this SKU was last bought from a supplier
    days_live: int = field(default=0, init=False, repr=False)
    _dow_counts: list[int] = field(default=None, init=False, repr=False)

    def __post_init__(self):
        # The queried window is [as_of - window_days, as_of] inclusive. A SKU
        # whose first sale falls inside it has only been selling since then.
        start = self.as_of - timedelta(days=self.window_days)
        live_start = max(start, self.first_sale) if self.first_sale else start
        self.days_live = max(1, (self.as_of - live_start).days + 1)
        self._dow_counts = dow_counts_between(live_start, self.as_of)

    def _span(self, window: int) -> int:
        """Days a `window`-day rate should divide by: the window, or the SKU's
        shorter selling life."""
        return max(1, min(window, self.days_live))

    def _rate(self, units: int, window: int) -> float:
        return units / self._span(window) if units else 0.0

    def coverage_days(self, t: ForecastThresholds = FORECAST) -> int:
        """Days of demand a reorder must cover: the ASSUMED planning lead (see
        ForecastThresholds.lead_time_days — not a measured delivery time) + the
        gap until the next realistic reorder. Uses this SKU's supplier's
        observed reorder cycle when known, else the flat review-period default.

        A YOUNG SKU (under ``young_sku_history_days`` of shelf life) gets the
        window capped at twice its observed history, floored at the delivery
        lead: two days of launch sales justify about a week's order, not
        three weeks of an unproven product. The cap lifts itself as history
        accumulates."""
        review = self.reorder_cycle_days if self.reorder_cycle_days else t.review_period_days
        cov = t.lead_time_days + int(review)
        if self.days_live < t.young_sku_history_days:
            cov = min(cov, max(t.lead_time_days,
                               self.days_live * t.young_sku_coverage_multiple))
        return cov

    def lifetime_daily(self) -> float:
        """Baseline rate: units over the SKU's whole selling life."""
        return self._rate(self.units_365, self.window_days)

    def recency_factor(self, t: ForecastThresholds = FORECAST) -> float:
        """Last 90 days vs lifetime pace. Meaningless below ~90 days of shelf
        life (units_90 == units_365 there, so it is identically 1.0) — see
        `trend_factor`, which picks the window that has signal."""
        rate_long = self.lifetime_daily()
        rate_short = self._rate(self.units_90, 90)
        if rate_long <= 0:
            return 1.0 if rate_short > 0 else 0.0
        return max(t.recency_clamp_lo, min(t.recency_clamp_hi, rate_short / rate_long))

    def recent_factor(self, t: ForecastThresholds = FORECAST) -> float:
        """Last 28 days vs lifetime pace — the short window the UI shows. Sees a
        ramp inside a young SKU's life, and sees a mover that has just stopped."""
        rate_long = self.lifetime_daily()
        rate_short = self._rate(self.units_28, 28)
        if rate_long <= 0:
            return 1.0 if rate_short > 0 else 0.0
        return max(t.recency_clamp_lo, min(t.recency_clamp_hi, rate_short / rate_long))

    def trend_factor(self, t: ForecastThresholds = FORECAST) -> float:
        """The multiplier the forecast uses. Prefers the smoother 90-day
        comparison, but a SKU younger than that has no 90d-vs-year contrast to
        make, so fall back to the 28-day one rather than reporting a flat 1.0."""
        if self.days_live > 90:
            return self.recency_factor(t)
        return self.recent_factor(t)

    def trend_basis(self) -> str:
        return "90d" if self.days_live > 90 else "28d"

    def dow_avg(self, weekday: int) -> float:
        cnt = self._dow_counts[weekday]
        if cnt:
            return self.dow_units[weekday] / cnt
        # A weekday the SKU has never been on the shelf for carries no
        # evidence of ZERO demand — it's unobserved, not dead. Without this
        # fallback a two-day-old listing forecast ~0 for five of seven
        # weekdays, so its order quantity implied a rate 3-4x below the
        # base_daily shown on the very same row (store 171's Fireball Vanilla:
        # "sells 21/week, 4.7 days of stock" next to "order 9"). Unobserved
        # weekdays borrow the overall daily rate; observed ones keep their
        # seasonal signal, and any SKU with >= 7 days on the shelf is
        # untouched (every weekday has a count).
        return self.base_daily()

    def base_daily(self) -> float:
        if self.units_90:
            return self._rate(self.units_90, 90)
        return self.lifetime_daily()

    def forecast(self, horizon_days: int, t: ForecastThresholds = FORECAST) -> float:
        """Expected total units over the next `horizon_days`.

        Summed as SEVEN weekday buckets (that weekday's average x how many of it
        fall in the horizon), not one addition per day. Identical on paper, but
        adding day-by-day re-rounds a running float once per day and the error
        accumulates in one direction: a 57-day horizon whose true total is 12
        came back as 12.000000000000004, and `math.ceil` in buy_recommendations
        turned that dust into a whole extra unit on the order (measured: 1 row
        in 836 on store 175, $12.75). Seven multiplications round once each, so
        a clean total stays clean - and it is the same arithmetic sql_checks
        uses, so the tab and its SQL icon reconcile.
        """
        rf = self.trend_factor(t)
        counts = dow_counts_between(self.as_of + timedelta(days=1),
                                    self.as_of + timedelta(days=horizon_days))
        return rf * sum(self.dow_avg(w) * counts[w] for w in range(7))

    def projected_daily(self, t: ForecastThresholds = FORECAST,
                        horizon_days: int = 30) -> float:
        """Forward daily rate implied by the forecast — trend included."""
        return self.forecast(horizon_days, t) / horizon_days

    def days_of_supply(self) -> float | None:
        """Cover at the CURRENT (un-trended) pace. The store-wide inventory
        classification uses this, so it stays deliberately conservative."""
        bd = self.base_daily()
        return (max(self.on_hand, 0) / bd) if bd > 0 else None

    def days_of_supply_at_trend(self, t: ForecastThresholds = FORECAST) -> float | None:
        """Cover at the PROJECTED pace. On a row that also shows a 30-day
        projection this is the one that agrees with it: on_hand / projected rate.
        Reporting the un-trended figure next to a trended projection is what let
        an item show 126 days of cover and a 30-day sell-through at once.

        Computed as on_hand / forecast * 30 in THAT order — the same float
        rounding path the UI's reconciliation uses. Dividing by a pre-rounded
        daily rate (forecast/30) differs in the last ulp and made the row and
        its SQL check disagree by dust."""
        f = self.forecast(30, t)
        return (max(self.on_hand, 0) / f * 30) if f > 0 else None
