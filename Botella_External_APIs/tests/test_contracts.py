"""Sheet 02 — data contracts and quality gates.

The four tests the sheet asks for, plus the ones whose failure would be
invisible: a gate that passes everything is indistinguishable from a gate that
works, right up until a recommendation is built on rubbish.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest

from app.pipeline import RunContext
from app.pipeline.contracts import (
    AnomalyInput,
    Batch,
    Contract,
    ContractRegistry,
    FieldSpec,
    FreshnessInput,
    TrailingStats,
    anomaly_gate,
    completeness_gate,
    freshness_gate,
    registry,
    run_quality_gates,
    schema_gate,
)

AS_OF = date(2026, 9, 21)


def ctx(**over) -> RunContext:
    base = {
        "run_id": "run-02", "tenant_id": 46, "store_id": 46, "as_of": AS_OF,
        "snapshot_id": "snap-1", "config_version": "default", "seed": 0,
        "versions": {"contracts": "1.0.0"},
    }
    return RunContext(**{**base, **over})


def product_rows(n=100, **over):
    """n well-formed product rows; `over` overrides a field on every row."""
    rows = []
    for i in range(n):
        row = {
            "sku": f"SKU{i}", "product_name": f"Product {i}",
            "price": 19.99, "cost": 12.50, "category": "whiskey", "stock_qty": 5,
        }
        row.update(over)
        rows.append(row)
    return rows


# ── Contracts are versioned per connector ───────────────────────────────────


def test_a_korona_change_cannot_fail_a_clover_store() -> None:
    """The whole reason contracts are keyed by connector."""
    local = ContractRegistry()
    local.register(Contract(
        connector="korona", entity="products", version="1.0.0",
        fields=(FieldSpec("sku", "string"),),
    ))
    local.register(Contract(
        connector="korona", entity="products", version="2.0.0",
        fields=(FieldSpec("sku", "string"), FieldSpec("new_korona_field", "string")),
    ))
    local.register(Contract(
        connector="clover", entity="products", version="1.0.0",
        fields=(FieldSpec("sku", "string"),),
    ))

    korona, _ = local.get("korona", "products")
    clover, _ = local.get("clover", "products")
    assert korona.version == "2.0.0"           # latest wins
    assert clover.version == "1.0.0"           # untouched by Korona's change
    assert "new_korona_field" not in [f.name for f in clover.fields]

    pinned, _ = local.get("korona", "products", "1.0.0")
    assert pinned.version == "1.0.0"           # a pinned run replays its own version


def test_an_unknown_connector_falls_back_and_says_so() -> None:
    contract, fell_back = registry.get("some_new_pos", "products")
    assert fell_back is True
    assert contract is not None and contract.connector == "base"

    known, fell_back = registry.get("clover", "products")
    assert fell_back is False and known.connector == "clover"


def test_the_estate_connectors_all_have_contracts() -> None:
    for connector in ("clover", "gokul", "square", "korona", "mpower",
                      "eposnow", "localdb", "api"):
        contract, fell_back = registry.get(connector, "products")
        assert contract is not None and fell_back is False, connector


# ── 1. Schema gate: a planted violation is rejected, WITH the field named ───


def test_a_planted_schema_violation_names_the_field() -> None:
    rows = product_rows(50)
    for row in rows:
        row["price"] = "not-a-number"          # a genuine category error

    result = schema_gate(Batch("clover", "products", rows), ctx())
    assert result.ok is False
    assert any(r.startswith("type_violation:price") for r in result.reasons), result.reasons


def test_a_missing_required_column_is_rejected_by_name() -> None:
    rows = [{k: v for k, v in r.items() if k != "sku"} for r in product_rows(10)]
    result = schema_gate(Batch("clover", "products", rows), ctx())
    assert result.ok is False
    assert "missing_required_field:sku" in result.reasons


def test_a_few_bad_rows_are_tolerated_but_a_shape_change_is_not() -> None:
    """2% is a POS quirk; 40% is the column changing meaning."""
    rows = product_rows(100)
    rows[0]["price"] = "junk"                   # 1%
    assert schema_gate(Batch("clover", "products", rows), ctx()).ok is True

    for row in rows[:40]:
        row["price"] = "junk"                   # 40%
    assert schema_gate(Batch("clover", "products", rows), ctx()).ok is False


def test_coercible_types_are_not_violations() -> None:
    """"2.0" for an integer quantity is a decimal string, not malformed data."""
    rows = product_rows(10, stock_qty="2.0", price="19.99")
    assert schema_gate(Batch("clover", "products", rows), ctx()).ok is True


def test_an_unknown_enum_value_is_rejected() -> None:
    local_ctx = ctx()
    batch = Batch("clover", "sales", [{"sku": "A", "sale_date": "2026-09-01",
                                       "quantity": 1, "total_amount": 5.0,
                                       "status": "TELEPORTED"}])
    contract = Contract(
        connector="enumtest", entity="sales", version="1.0.0",
        fields=(FieldSpec("sku", "string"),
                FieldSpec("status", "string", required=False,
                          enum=("COMPLETE", "VOID"))),
    )
    local = ContractRegistry()
    local.register(contract)
    from app.pipeline.contracts import gates as gates_mod

    original = gates_mod.contract_registry
    gates_mod.contract_registry = local
    try:
        result = schema_gate(Batch("enumtest", "sales", batch.rows), local_ctx)
    finally:
        gates_mod.contract_registry = original
    assert result.ok is False
    assert any("unknown_enum:status" in r for r in result.reasons), result.reasons


def test_rows_outside_the_partition_range_are_caught() -> None:
    """8,616,193 sale_items rows sit in the warehouse DEFAULT partition. Every
    one has a valid date - they simply predate the oldest defined partition,
    so they were absorbed silently. The live risk is the FORWARD edge:
    partitions stop at 2026-11-30, and after that new sales land in DEFAULT
    with nothing to say so."""
    rows = [{"sku": "A", "sale_date": "2026-12-15", "quantity": 1, "total_amount": 5.0}]
    result = schema_gate(
        Batch("clover", "sales", rows,
              partition_min=date(2025, 4, 1), partition_max=date(2026, 11, 30)),
        ctx(),
    )
    assert result.ok is False
    assert any(r.startswith("outside_partition_range:sale_date") for r in result.reasons)


def test_an_empty_batch_is_not_silently_successful() -> None:
    result = schema_gate(Batch("clover", "products", []), ctx())
    assert result.ok is False and "empty_batch" in result.reasons


# ── 2. Completeness: a zero-cost connector is UNAVAILABLE, never zero ───────


def test_a_zero_cost_connector_is_marked_unavailable_not_zero_filled() -> None:
    """Gokul sends 0.00% cost across 19 stores and 160k SKUs. The field must
    travel as ABSENT - a cost of 0.0 is indistinguishable from a free product
    and yields a 100% margin."""
    rows = product_rows(100, cost=None)
    result = completeness_gate(Batch("gokul", "products", rows), ctx())

    assert result.ok is True                                   # accepted, not rejected
    availability = result.value["availability"]
    assert "cost" in availability.unavailable
    assert result.value["coverage_pct"]["cost"] == 0
    assert any(r.startswith("field_unavailable:cost") for r in result.reasons)

    stripped = availability.strip(rows[0])
    assert "cost" not in stripped, "an unavailable field must be ABSENT"
    assert stripped.get("cost") is None
    assert stripped["price"] == 19.99                          # the rest survives


def test_a_cost_of_zero_counts_as_ABSENT_not_as_covered() -> None:
    """The subtle version, and the one that actually bites: a connector that
    sends 0.00 for every cost would otherwise read as 100% covered."""
    rows = product_rows(100, cost=0.0)
    result = completeness_gate(Batch("gokul", "products", rows), ctx())
    assert result.value["coverage_pct"]["cost"] == 0
    assert "cost" in result.value["availability"].unavailable


def test_a_well_covered_connector_keeps_its_fields() -> None:
    """EPOSNow reaches 99.4% cost; nothing should be withheld from it."""
    rows = product_rows(100)
    result = completeness_gate(Batch("eposnow", "products", rows), ctx())
    assert result.value["availability"].unavailable == ()
    assert result.value["coverage_pct"]["cost"] == 100


def test_completeness_reports_the_connector_so_the_defect_is_attributable() -> None:
    rows = product_rows(100, cost=None, category=None)
    result = completeness_gate(Batch("square", "products", rows), ctx())
    assert result.value["connector"] == "square"
    assert set(result.value["availability"].unavailable) == {"cost", "category"}
    # And it says what is lost, so a withheld recommendation can be explained.
    assert "MARGIN" in result.value["impact"]["cost"]


def test_partial_coverage_below_the_minimum_still_fails() -> None:
    rows = product_rows(100)
    for row in rows[:50]:
        row["cost"] = None                                     # 50% < 70% minimum
    result = completeness_gate(Batch("clover", "products", rows), ctx())
    assert "cost" in result.value["availability"].unavailable
    assert result.value["coverage_pct"]["cost"] == 50


# ── 3. Freshness: relative to THIS store's own cadence ──────────────────────


def weekly_syncs(last_days_ago: int, count: int = 12) -> FreshnessInput:
    last = datetime(2026, 9, 21) - timedelta(days=last_days_ago)
    return FreshnessInput(
        connector="clover", entity="products", last_successful_sync=last,
        recent_syncs=tuple(last - timedelta(days=7 * i) for i in range(count)),
    )


def test_a_weekly_store_is_healthy_at_six_days_and_broken_at_twenty() -> None:
    """The subtle part of the sheet. A fixed 48h rule would mark a large share
    of the estate permanently broken."""
    at_six = freshness_gate(weekly_syncs(6), ctx())
    assert at_six.ok is True
    assert at_six.value["stale"] is False, at_six.value
    assert at_six.value["median_interval_days"] == 7
    assert at_six.value["staleness_days"] == 6

    at_twenty = freshness_gate(weekly_syncs(20), ctx())
    assert at_twenty.ok is True                 # accepted, with staleness attached
    assert at_twenty.value["stale"] is True
    assert any(r.startswith("stale:") for r in at_twenty.reasons)


def test_a_daily_store_is_stale_at_six_days() -> None:
    """The same six days, the opposite verdict - which is the entire point."""
    last = datetime(2026, 9, 21) - timedelta(days=6)
    daily = FreshnessInput(
        connector="api", entity="products", last_successful_sync=last,
        recent_syncs=tuple(last - timedelta(days=i) for i in range(12)),
    )
    result = freshness_gate(daily, ctx())
    assert result.value["median_interval_days"] == 1
    assert result.value["stale"] is True


def test_staleness_is_always_attached_even_when_fresh() -> None:
    result = freshness_gate(weekly_syncs(2), ctx())
    assert "staleness_days" in result.value and result.value["staleness_days"] == 2


def test_too_little_history_falls_back_and_admits_it() -> None:
    """Two data points is not a cadence. Say so rather than inventing one."""
    last = datetime(2026, 9, 20)
    thin = FreshnessInput("clover", "products", last,
                          recent_syncs=(last, last - timedelta(days=30)))
    result = freshness_gate(thin, ctx())
    assert result.value["cadence_source"] == "default_assumed"
    assert result.provenance.own_weight == 0.0   # not this store's own evidence


def test_a_never_synced_store_is_refused() -> None:
    result = freshness_gate(FreshnessInput("clover", "products", None), ctx())
    assert result.ok is False and "never_synced" in result.reasons


# ── 4. Anomaly: a doubled batch is quarantined ──────────────────────────────


def normal_trailing(**over) -> TrailingStats:
    base = {"median_daily_volume": 500.0, "median_unit_price": 20.0,
            "median_basket_size": 3.0, "observations": 90}
    base.update(over)
    return TrailingStats(**base)


def test_a_doubled_batch_is_quarantined() -> None:
    result = anomaly_gate(
        AnomalyInput("clover", "sales", batch_volume=1400.0, trailing=normal_trailing()),
        ctx(),
    )
    assert result.ok is False
    assert any("volume_spike" in r for r in result.reasons), result.reasons


def test_a_decimal_shift_is_caught_in_both_directions() -> None:
    ten_x = anomaly_gate(
        AnomalyInput("clover", "sales", batch_volume=500.0, batch_unit_price=200.0,
                     trailing=normal_trailing()), ctx())
    assert ten_x.ok is False and any("unit_price_spike" in r for r in ten_x.reasons)

    tenth = anomaly_gate(
        AnomalyInput("clover", "sales", batch_volume=500.0, batch_unit_price=2.0,
                     trailing=normal_trailing()), ctx())
    assert tenth.ok is False and any("unit_price_collapsed" in r for r in tenth.reasons)


def test_a_partial_load_collapses_volume_and_is_caught() -> None:
    result = anomaly_gate(
        AnomalyInput("clover", "sales", batch_volume=50.0, trailing=normal_trailing()), ctx())
    assert result.ok is False and any("volume_collapsed" in r for r in result.reasons)


def test_a_normal_busy_day_is_not_quarantined() -> None:
    result = anomaly_gate(
        AnomalyInput("clover", "sales", batch_volume=700.0, batch_unit_price=23.0,
                     batch_basket_size=3.4, trailing=normal_trailing()), ctx())
    assert result.ok is True, result.reasons


def test_a_new_store_abstains_rather_than_being_quarantined() -> None:
    """Quarantining a new store's first load would block exactly the stores we
    most want onboarded."""
    result = anomaly_gate(
        AnomalyInput("clover", "sales", batch_volume=9999.0,
                     trailing=TrailingStats(observations=2)), ctx())
    assert result.ok is True
    assert result.value["abstained"] is True
    assert "insufficient_history_to_judge" in result.reasons


def test_the_baseline_is_this_store_not_the_network() -> None:
    """A small store's normal volume must not be judged against a large one's."""
    small = anomaly_gate(
        AnomalyInput("clover", "sales", batch_volume=12.0,
                     trailing=normal_trailing(median_daily_volume=10.0)), ctx())
    assert small.ok is True, "12 units is normal for a store whose median is 10"


# ── The composite verdict: the right to refuse ──────────────────────────────


def test_a_schema_failure_refuses_the_recommendation() -> None:
    rows = product_rows(50, price="junk")
    verdict = run_quality_gates(ctx(), batch=Batch("clover", "products", rows))
    assert verdict.verdict == "reject"
    assert verdict.may_recommend is False
    assert any("type_violation" in r for r in verdict.reasons)


def test_a_quarantined_batch_refuses_the_recommendation() -> None:
    verdict = run_quality_gates(
        ctx(),
        batch=Batch("clover", "products", product_rows(50)),
        anomaly=AnomalyInput("clover", "sales", batch_volume=5000.0,
                             trailing=normal_trailing()),
    )
    assert verdict.verdict == "quarantine" and verdict.may_recommend is False


def test_a_thin_catalogue_is_DEGRADED_not_silenced() -> None:
    """A store with no cost data should still get weather and event advice -
    it just must not get a margin claim."""
    verdict = run_quality_gates(
        ctx(), batch=Batch("gokul", "products", product_rows(50, cost=None)))
    assert verdict.verdict == "degraded"
    assert verdict.may_recommend is True
    assert "cost" in verdict.unavailable_fields


def test_a_healthy_store_passes_cleanly() -> None:
    verdict = run_quality_gates(
        ctx(),
        batch=Batch("eposnow", "products", product_rows(100)),
        freshness=weekly_syncs(2),
        anomaly=AnomalyInput("eposnow", "sales", batch_volume=500.0,
                             trailing=normal_trailing()),
    )
    assert verdict.verdict == "pass" and verdict.may_recommend is True
    assert verdict.unavailable_fields == ()


def test_a_never_synced_store_refuses() -> None:
    verdict = run_quality_gates(
        ctx(),
        batch=Batch("clover", "products", product_rows(10)),
        freshness=FreshnessInput("clover", "products", None),
    )
    assert verdict.never_synced is True and verdict.may_recommend is False


def test_staleness_rides_on_the_verdict_for_downstream() -> None:
    verdict = run_quality_gates(
        ctx(), batch=Batch("clover", "products", product_rows(50)),
        freshness=weekly_syncs(20))
    assert verdict.staleness_days == 20
    assert verdict.verdict == "degraded"       # stale but usable, with the figure


# ── Gates conform to the sheet-00 envelope ──────────────────────────────────


@pytest.mark.parametrize("call", [
    lambda: schema_gate(Batch("clover", "products", product_rows(10)), ctx()),
    lambda: completeness_gate(Batch("clover", "products", product_rows(10)), ctx()),
    lambda: freshness_gate(weekly_syncs(1), ctx()),
    lambda: anomaly_gate(AnomalyInput("clover", "sales", 500.0,
                                      trailing=normal_trailing()), ctx()),
])
def test_every_gate_is_a_well_formed_stage(call) -> None:
    result = call()
    assert result.stamped, "the @stage decorator must stamp name and version"
    assert result.provenance is not None
    assert result.provenance.own_observations >= 0
    assert result.duration_ms >= 0
    # config_keys filled themselves via cfg.get - the sheet-00 mechanism.
    assert isinstance(result.provenance.config_keys, tuple)


def test_gate_thresholds_record_themselves_into_provenance() -> None:
    result = freshness_gate(weekly_syncs(3), ctx())
    assert "contracts.freshness.tolerance_pct" in result.provenance.config_keys
    assert "contracts.freshness.min_observations" in result.provenance.config_keys


def test_gates_are_replayable_from_an_audit_row() -> None:
    from app.pipeline import replay

    batch = Batch("clover", "products", product_rows(20))
    run_ctx = ctx()
    original = schema_gate(batch, run_ctx)
    row = original.to_audit_row(run_ctx, stage_input=None)
    row["input_digest"] = None                 # the batch is not JSON-able as-is
    replayed = replay(row)
    assert replayed.same_decision_as(original)
