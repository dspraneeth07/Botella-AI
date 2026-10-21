"""Shared test fixtures and factories.

Required settings are stubbed via env so importing ``app.config`` never fails,
even though the pure-logic tests don't hit the network or the LLM.
"""

from __future__ import annotations

import os

os.environ.setdefault("NODE_API_BASE_URL", "http://node.test")
os.environ.setdefault("ANTHROPIC_API_KEY", "test-key")
# The developer's live .env may enable network-touching signal sources
# (GOOGLE_TRENDS_ENABLED=true, API keys). Real env vars outrank the dotenv in
# pydantic-settings, so pin the flag off here: tests must never depend on the
# checkout's .env or reach the network outside respx. Per-test overrides still
# win (init kwargs outrank env vars).
os.environ["GOOGLE_TRENDS_ENABLED"] = "false"
os.environ["REDDIT_CLIENT_ID"] = ""
os.environ["YOUTUBE_API_KEY"] = ""
os.environ["APIFY_TOKEN"] = ""
os.environ["EMAIL_IMAP_USER"] = ""

from datetime import UTC, date, datetime  # noqa: E402

import pytest  # noqa: E402

from app.config import Settings  # noqa: E402
from app.schemas.store import InventoryItem, SaleRecord  # noqa: E402

NOW = datetime(2026, 6, 3, 12, 0, tzinfo=UTC)
TODAY = NOW.date()


@pytest.fixture
def settings() -> Settings:
    return Settings(node_api_base_url="http://node.test", anthropic_api_key="test-key")


def sale(sku: str, days_ago: int, units: int, price: float = 10.0) -> SaleRecord:
    return SaleRecord(
        sku=sku,
        sale_date=date.fromordinal(TODAY.toordinal() - days_ago),
        units=units,
        unit_price=price,
    )


def item(
    sku: str,
    *,
    category: str = "beer",
    on_hand: int = 10,
    price: float = 10.0,
    cost: float | None = None,
    name: str | None = None,
    created_days_ago: int | None = None,
    sub_category: str | None = None,
) -> InventoryItem:
    created_at = None
    if created_days_ago is not None:
        created_at = datetime.fromordinal(TODAY.toordinal() - created_days_ago).replace(
            tzinfo=UTC
        )
    return InventoryItem(
        sku=sku,
        product_name=name or f"Product {sku}",
        category=category,
        sub_category=sub_category,
        price=price,
        cost=cost,
        on_hand=on_hand,
        created_at=created_at,
    )
