"""The feature store — one definition of velocity, read everywhere.

Velocity was computed in app/store_data/velocity.py, again in
backend/lib/metrics.js, and again in SQL inside chat tools. When those
disagree you get 454 versus 485. This package is the authority.

    from app.pipeline.features import FeatureRequest, read_window

    result = read_window(FeatureRequest(
        sku="0245", window_days=28, facts=facts, calendar=calendar,
    ), ctx)
    result.value.units_per_open_day   # divides by OPEN days, never calendar

Closed days are absent, not zero. Windows anchor to ctx.as_of, never to the
latest row in the data. Reads are point-in-time correct.
"""

from app.pipeline.features.build import (
    CALENDAR_WINDOW_SQL,
    FEATURE_DAILY_SQL,
    FEATURE_WINDOW_SQL,
    STORE_DAY_SQL,
    UPSERT_FEATURE_DAILY_SQL,
    UPSERT_STORE_DAY_SQL,
    CalendarRequest,
    MergeRequest,
    TradingDay,
    derive_calendar,
    incremental_bounds,
    merge_day_facts,
    upsert_params,
)
from app.pipeline.features.store import (
    CalendarDay,
    DayFact,
    FeatureRequest,
    FeatureWindow,
    read_window,
    read_windows,
    visible_at,
    window_bounds,
)

__all__ = [
    "CALENDAR_WINDOW_SQL",
    "FEATURE_DAILY_SQL",
    "FEATURE_WINDOW_SQL",
    "STORE_DAY_SQL",
    "UPSERT_FEATURE_DAILY_SQL",
    "UPSERT_STORE_DAY_SQL",
    "CalendarDay",
    "CalendarRequest",
    "DayFact",
    "FeatureRequest",
    "FeatureWindow",
    "MergeRequest",
    "TradingDay",
    "derive_calendar",
    "incremental_bounds",
    "merge_day_facts",
    "read_window",
    "read_windows",
    "upsert_params",
    "visible_at",
    "window_bounds",
]
