"""Register-measured trend discovery -> the social channel's strongest tier.

Node mines same-state peer registers for drink categories whose trailing week
outpaces their own baseline (contract §1.9) — trend discovery from MEASURED
PURCHASES, where every social source is only ever a proxy. Rows reduce to the
same term-level :class:`TrendSignal` shape as every other source so
``social.combine`` can merge them, with ``source="registers"`` marking the
evidence tier the prompt treats as strongest.

Like the Instagram source, the fetch itself lives in ``context_builder``
(where the Node client is); only the row -> signal reduction lives here.
Register terms are already register-measured, so context_builder EXCLUDES
them from the §1.7 trend-validation slice — validating them again would just
burn fan-out budget re-proving what the discovery already proved.
"""

from __future__ import annotations

from app.config import Settings
from app.logging_config import get_logger
from app.schemas.signals import TrendSignal
from app.schemas.store import RegisterTrend
from app.signals.social import trend_key
from app.store_data.categorize import classify_from_name

log = get_logger(__name__)


def to_signals(
    rows: list[RegisterTrend], settings: Settings
) -> tuple[list[TrendSignal], list[str], list[str]]:
    """Accelerating register categories -> (signals, categories, keywords).

    Node already enforces the k-anonymity floor and the acceleration bar, so
    every row is signal-worthy; this just bounds the count and shapes the
    evidence sentence the prompt shows.
    """
    if not settings.social_trends_enabled or not settings.register_trends_enabled:
        return [], [], []

    signals: list[TrendSignal] = []
    categories: set[str] = set()
    keywords: set[str] = set()
    for row in rows[: settings.register_trends_max]:
        growth = f", {row.avg_growth}x week-over-baseline" if row.avg_growth else ""
        rate = (
            f", avg {row.avg_weekly_units} units/wk/store"
            if row.avg_weekly_units is not None
            else ""
        )
        top = f"; top seller: {row.product_name}" if row.product_name else ""
        signals.append(
            TrendSignal(
                term=row.term,
                source="registers",
                momentum="rising",
                mentions=row.accelerating_stores,
                evidence=(
                    f"{row.accelerating_stores} of {row.stores_selling} nearby "
                    f"stores accelerating{growth}{rate}{top}"
                ),
                key=trend_key(row.term),
            )
        )
        token = classify_from_name(row.term)
        if token:
            categories.add(token)
        keywords.add(row.term.strip().lower())
    if signals:
        log.info("register_trends_rising", terms=[s.term for s in signals])
    return signals, sorted(categories), sorted(keywords)
