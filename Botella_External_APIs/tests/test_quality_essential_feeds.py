"""An ancillary feed must not refuse a store its recommendations.

WHAT HAPPENED. `_worst_freshness` ranked every entity with "never synced
outranks stale" and handed the winner to the store-level verdict, where
never_synced is a REJECT. So a store whose `suppliers` feed had never synced
was refused outright - before the engine was asked - while its sales and
products were current.

On QA that was 182 of 211 stores producing no recommendations at all, Bethany
among them:

    [Rec cron] Done - 29 ok, 0 failed, 182 refused by data quality
    [Rec cron] Store refused ... {"clientId":171,"verdict":"reject",
      "reasons":["store_quality:reject","store_never_synced"]}

A missing supplier list costs a lead-time sentence on a card. It is not grounds
to show an owner nothing.
"""

from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from quality_eval import ESSENTIAL_ENTITIES, _worst_freshness  # noqa: E402

from app.pipeline import StageResult  # noqa: E402


class Info:
    """Just enough of FreshnessInput for the ranking contest."""

    def __init__(self, entity: str) -> None:
        self.entity = entity


def fresh(days: float = 0.0, allowed: float = 7.0) -> StageResult:
    return StageResult.success(
        {"staleness_days": days, "allowed_days": allowed, "stale": days > allowed},
        provenance=None,
    )


def never() -> StageResult:
    return StageResult.failure("never_synced", provenance=None)


def test_sales_and_products_are_the_essential_feeds() -> None:
    assert set(ESSENTIAL_ENTITIES) == {"sales", "products"}


def test_a_never_synced_ancillary_feed_does_not_decide_the_verdict() -> None:
    """The exact shape of store 171 on QA."""
    inputs = [Info("products"), Info("sales"), Info("suppliers"),
              Info("customers"), Info("purchases")]
    results = [fresh(0.2), fresh(0.5), never(), never(), never()]
    chosen = _worst_freshness(inputs, results)
    assert inputs[chosen].entity in ESSENTIAL_ENTITIES, (
        "an ancillary feed drove the store verdict, which is the bug")
    # And the chosen one is fresh, so the store is served.
    assert results[chosen].ok is True


def test_a_never_synced_SALES_feed_still_rejects() -> None:
    """The gate must keep its teeth where it matters.

    No sales is the one condition that genuinely makes a slate impossible, so
    it must still win the contest and still reject.
    """
    inputs = [Info("products"), Info("sales"), Info("suppliers")]
    results = [fresh(0.1), never(), fresh(0.1)]
    chosen = _worst_freshness(inputs, results)
    assert inputs[chosen].entity == "sales"
    assert results[chosen].ok is False


def test_the_stalest_essential_feed_wins_among_essentials() -> None:
    inputs = [Info("products"), Info("sales")]
    results = [fresh(30.0, allowed=7.0), fresh(1.0, allowed=7.0)]
    assert inputs[_worst_freshness(inputs, results)].entity == "products"


def test_an_ancillary_feed_is_judged_when_there_is_nothing_better() -> None:
    """A payload with no essential feed still gets judged.

    Silently passing would be worse than judging on what is there - this is the
    one case where an ancillary feed is allowed to decide, because it is the
    only evidence.
    """
    inputs = [Info("suppliers"), Info("customers")]
    results = [never(), fresh(0.1)]
    chosen = _worst_freshness(inputs, results)
    assert inputs[chosen].entity == "suppliers"
    assert results[chosen].ok is False


@pytest.mark.parametrize("entity", ["SALES", "Products"])
def test_the_entity_match_is_case_insensitive(entity: str) -> None:
    inputs = [Info(entity), Info("suppliers")]
    results = [fresh(0.1), never()]
    assert inputs[_worst_freshness(inputs, results)].entity == entity
