"""Configuration: .env loading, DSNs, and tunable thresholds.

Two databases:
  * SOURCE  -> the read-only `syncgo` warehouse (never written to).
  * APP DB  -> our own writable Postgres 18 (insights, digests, canonical caches).
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = PROJECT_ROOT / ".env"


def load_env(path: Path = ENV_PATH) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip("'").strip('"')
    return env


_ENV = load_env()


def _get(key: str, default: str | None = None) -> str | None:
    return os.environ.get(key) or _ENV.get(key) or default


@dataclass(frozen=True)
class SourceConfig:
    """Read-only connection to the syncgo warehouse."""
    host: str | None = field(default_factory=lambda: _get("PGHOST"))
    port: str = field(default_factory=lambda: _get("PGPORT", "5432"))
    dbname: str | None = field(default_factory=lambda: _get("PGDATABASE"))
    user: str | None = field(default_factory=lambda: _get("PGUSER"))
    password: str | None = field(default_factory=lambda: _get("PGPASSWORD"))
    sslmode: str = field(default_factory=lambda: _get("PGSSLMODE", "prefer"))

    def kwargs(self) -> dict:
        return dict(host=self.host, port=self.port, dbname=self.dbname,
                    user=self.user, password=self.password, sslmode=self.sslmode,
                    connect_timeout=15)


@dataclass(frozen=True)
class AppDBConfig:
    """Our own writable Postgres 18 (local: D:\\PostgreSQL\\18)."""
    host: str = field(default_factory=lambda: _get("APP_PGHOST", "localhost"))
    port: str = field(default_factory=lambda: _get("APP_PGPORT", "5432"))
    dbname: str = field(default_factory=lambda: _get("APP_PGDATABASE", "storeagent"))
    user: str = field(default_factory=lambda: _get("APP_PGUSER", "postgres"))
    password: str | None = field(default_factory=lambda: _get("APP_PGPASSWORD"))
    # Database to connect to for bootstrap (creating `storeagent` db).
    admin_dbname: str = field(default_factory=lambda: _get("APP_PGADMIN_DB", "postgres"))

    def kwargs(self, dbname: str | None = None) -> dict:
        return dict(host=self.host, port=self.port, dbname=dbname or self.dbname,
                    user=self.user, password=self.password, connect_timeout=15)


@dataclass(frozen=True)
class Thresholds:
    """Tunable, defensible inventory-classification thresholds (days / ratios).

    These are explicit and configurable on purpose: every classification an owner
    sees must be explainable ("dead = in stock but no sale in >180 days").
    """
    # Recency buckets (days since last sale)
    active_max_days: int = 30        # sold within 30d -> actively moving
    cooling_max_days: int = 90       # 30-90d -> cooling
    slow_max_days: int = 180         # 90-180d -> slow; >180d -> dead
    # Overstock: more than this many days of supply at current rate = slow/overstocked
    overstock_days_supply: int = 180
    # Fast: top velocity percentile within the store
    fast_velocity_percentile: float = 0.80
    fast_max_days_supply: int = 21   # OR less than ~3 weeks of stock on hand
    # "Premium" cut for slow-but-premium (keep, don't liquidate)
    premium_price_percentile: float = 0.80
    premium_min_price: float = 40.0  # absolute floor (USD) for a "premium" bottle
    # Velocity windows (days)
    window_short: int = 30
    window_mid: int = 90
    window_long: int = 365
    # Below this cost-coverage %, report inventory value at RETAIL (flagged) instead
    # of a misleading $0 — some stores carry no supplier cost data at all.
    min_cost_coverage_pct: float = 40.0


@dataclass(frozen=True)
class CustomerThresholds:
    """Win-Back / churn detection (days unless noted)."""
    min_regular_visits: int = 4          # an "established regular" worth winning back
    churn_cadence_multiple: float = 2.0  # lapsed if gap > 2x their personal cadence
    churn_min_days: int = 30             # and at least this many days since last visit
    recent_lapse_days: int = 180         # "at risk" = broke pattern within this window
    winback_lookback_days: int = 540     # beyond recent_lapse and within this = "lost"
    min_active_span_days: int = 90        # floor when annualising spend (curb extrapolation)
    # Data-readiness gate: refuse to emit customer insights on non-CRM stores.
    # >= min_distinct_customers -> full insights; between min_partial_customers
    # and that -> "partial" mode (insights over the tracked customers only,
    # labeled as such); below, or when one id dominates, -> unavailable.
    min_distinct_customers: int = 500
    min_partial_customers: int = 100
    bucket_dominance_pct: float = 0.20   # if one id holds >20% of visits -> system bucket


@dataclass(frozen=True)
class MarginThresholds:
    """Money-Leak / price-elasticity tuning."""
    # A markdown on a well-selling SKU is "confirmed waste" when only a small
    # share of its units actually needed the discount to move (it sells fine at
    # full price). Above this share, the markdown may be load-bearing -> uncertain.
    confirmed_waste_max_discount_share: float = 0.50
    min_units_for_elasticity: int = 10   # need enough sales to judge discount share


@dataclass(frozen=True)
class ForecastThresholds:
    """Predictive buying parameters."""
    # ASSUMED planning buffer, not a measured delivery time: the purchase
    # ledger has no order->receive timestamps, so real delivery duration is
    # unknowable from our data (could be 2 days, could be 14). Owner-facing
    # prose must therefore never claim "including delivery time" — it says
    # when stock runs out (data) and gives this much head start (policy).
    lead_time_days: int = 7
    # How long until you reorder again. SEVEN, the same review period the card
    # policy declares (`app/pipeline/policy/inventory.py` REVIEW_PERIOD_DAYS,
    # `deterministic.REVIEW_PERIOD_DAYS`), so a Buying-tab row with no card
    # sizes its order over the same 14-day window a card does. It was 14 - a
    # 21-day window the card never used - and on 19 October 2026 the Purchasing
    # row for Weber Ranch 1L said "Qty to cover 28" under a card that asked for
    # a different number for the same bottle. A per-supplier observed cycle
    # still overrides this flat figure (SkuDemand.coverage_days).
    review_period_days: int = 7
    safety_buffer: float = 0.25      # safety stock as a fraction of coverage demand
    horizon_days: int = 14           # default forecast horizon for display
    recency_clamp_lo: float = 0.3    # bound the recent-trend multiplier
    recency_clamp_hi: float = 3.0
    decline_factor: float = 0.5      # recency factor below this = demand declining
    overstock_days_supply: int = 180
    min_units_90_to_buy: int = 2     # ignore near-zero demand for buy recs
    backtest_test_days: int = 28     # walk-forward holdout length
    backtest_min_train_days: int = 120
    # Young-SKU order sizing: a rate measured over 2 days of shelf life is
    # evidence for a week's order, not a month's. Below this much history the
    # coverage window is capped at (days_live x the multiple), floored at the
    # delivery lead — so a hot new listing gets "order a week's worth today"
    # instead of a launch-spike-sized month of stock.
    young_sku_history_days: int = 14
    young_sku_coverage_multiple: int = 2


@dataclass(frozen=True)
class NarrationConfig:
    """Claude narration (Phase 1.5). Deterministic-first: narration is additive.

    Auth accepts either an API key (`ANTHROPIC_API_KEY` -> x-api-key) or a bearer
    token (`ANTHROPIC_AUTH_TOKEN` -> Authorization: Bearer), so the same code path
    works for a direct Anthropic key or a gateway/OAuth token.
    """
    api_key: str | None = field(default_factory=lambda: _get("ANTHROPIC_API_KEY"))
    auth_token: str | None = field(default_factory=lambda: _get("ANTHROPIC_AUTH_TOKEN"))
    base_url: str = field(default_factory=lambda: _get("ANTHROPIC_BASE_URL", "https://api.anthropic.com"))
    model: str = field(default_factory=lambda: _get("NARRATION_MODEL", "claude-sonnet-4-6"))
    version: str = field(default_factory=lambda: _get("ANTHROPIC_VERSION", "2023-06-01"))
    max_tokens: int = field(default_factory=lambda: int(_get("NARRATION_MAX_TOKENS", "1024")))
    timeout_s: int = field(default_factory=lambda: int(_get("NARRATION_TIMEOUT_S", "45")))

    @property
    def enabled(self) -> bool:
        return bool(self.api_key or self.auth_token)


SOURCE = SourceConfig()
APP_DB = AppDBConfig()
NARRATION = NarrationConfig()
THRESHOLDS = Thresholds()
CUSTOMERS = CustomerThresholds()
FORECAST = ForecastThresholds()
MARGIN = MarginThresholds()

# SQL debug: attach the exact warehouse queries behind each result as
# result["debug_sql"]. Off by default because capability payloads reach the
# browser through the Node proxy (and get cached there); set
# STOREAGENT_DEBUG_SQL=true when auditing figures against the warehouse.
DEBUG_SQL = (_get("STOREAGENT_DEBUG_SQL", "false") or "").strip().lower() in ("1", "true", "yes")

# Inventory/Margin pilot: store 10 (rich cost+stock data; customer_id is a bucket here).
PILOT_CLIENT_ID = 10
PILOT_LOCATION_ID = 10

# Customer pilot: store 88 (real per-person CRM: ~25.7k customers, named, natural
# visit distribution). Different capabilities pilot where the data supports them.
PILOT_CUSTOMER_CLIENT_ID = 88
PILOT_CUSTOMER_LOCATION_ID = 88
