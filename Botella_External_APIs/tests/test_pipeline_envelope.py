"""Sheet 00 — the stage envelope.

The tests that matter here are the ones whose failure would be invisible in
production: a stage that quietly reads the clock, a provenance that silently
under-reports the thresholds behind a number, a replay that passes because it
compared the wrong things.
"""

from __future__ import annotations

import json
from datetime import UTC, date, datetime

import pytest

from app.pipeline import (
    ConfigRegistry,
    ConfigVersionMismatch,
    DuplicateSetting,
    Provenance,
    ProvenanceError,
    ReplayMismatch,
    RunContext,
    Setting,
    StageResult,
    UnregisteredSetting,
    catalog,
    digest,
    load_fixture,
    record_input,
    replay,
    stage,
)
from app.pipeline.registry import ConfigError

# ── A realistic stage, used by most of the tests below ──────────────────────
# Declared at module level exactly as a real threshold would be, so it lands
# in the catalogue and shows up in cfg.report().

DEAD_STOCK_DAYS = Setting(
    name="test.dead_stock.days",
    default=90,
    unit="days",
    owner="inventory",
    why="provisional; to be fitted from holdout WAPE in wave 6",
    status="PROVISIONAL",
)

REGISTRY = ConfigRegistry(version="default")


@stage("dead_stock", "1.0.0")
def dead_stock(payload, ctx):
    """Items unsold for longer than the configured window."""
    days = REGISTRY.get(DEAD_STOCK_DAYS, ctx)
    record_input("items.last_sold_days_ago")
    items = payload["items"]
    stale = sorted(i["sku"] for i in items if i["last_sold_days_ago"] >= days)
    if not stale:
        return StageResult.failure("no_dead_stock")
    return StageResult.success(
        stale,
        Provenance(
            own_observations=len(items),
            own_weight=1.0,
            evidence_state="ESTABLISHED",
            inputs=("items.sku",),
        ),
    )


def make_ctx(**over) -> RunContext:
    base = {
        "run_id": "run-1",
        "tenant_id": 46,
        "store_id": 46,
        "as_of": date(2026, 9, 21),
        "snapshot_id": "snap-1",
        "config_version": "default",
        "seed": 7,
        "versions": {"engine": "2.0.0"},
    }
    return RunContext(**{**base, **over})


# ── RunContext ──────────────────────────────────────────────────────────────


def test_context_is_immutable_and_hashable() -> None:
    ctx = make_ctx()
    # frozen dataclasses raise FrozenInstanceError, a subclass of AttributeError.
    with pytest.raises(AttributeError):
        ctx.as_of = date(2026, 1, 1)  # type: ignore[misc]
    with pytest.raises(TypeError):
        ctx.versions["engine"] = "hacked"  # type: ignore[index]
    assert hash(ctx) == hash(make_ctx())


def test_as_of_rejects_a_datetime() -> None:
    """datetime IS a date subclass, so a naive isinstance check would accept a
    timestamp - and a time-of-day in as_of reintroduces the sub-day clock
    dependence the field exists to remove."""
    with pytest.raises(TypeError, match="unreplayable"):
        make_ctx(as_of=datetime(2026, 9, 21, 4, 0, tzinfo=UTC))


def test_context_round_trips_through_json() -> None:
    ctx = make_ctx()
    assert RunContext.from_dict(json.loads(json.dumps(ctx.to_dict()))) == ctx


def test_context_rejects_a_bool_tenant_id() -> None:
    # bool is an int subclass; True would silently become tenant 1.
    with pytest.raises(TypeError):
        make_ctx(tenant_id=True)


# ── Provenance ──────────────────────────────────────────────────────────────


def test_provenance_rejects_impossible_values() -> None:
    with pytest.raises(ValueError, match="own_weight"):
        Provenance(own_observations=1, own_weight=1.5, evidence_state="NEW")
    with pytest.raises(ValueError, match="evidence_state"):
        Provenance(own_observations=1, own_weight=1.0, evidence_state="SOLID")
    with pytest.raises(ValueError, match="cohort"):
        # A size with no level says "borrowed from 240 of something".
        Provenance(
            own_observations=1, own_weight=1.0, evidence_state="NEW", cohort_size=240
        )


def test_provenance_keys_are_sorted_and_deduplicated() -> None:
    """Two runs that read the same keys in a different order must produce
    byte-identical provenance, or replay comparison breaks on ordering."""
    a = Provenance(
        own_observations=1, own_weight=1.0, evidence_state="NEW",
        inputs=("b", "a", "b"), config_keys=("z", "y"),
    )
    assert a.inputs == ("a", "b")
    assert a.config_keys == ("y", "z")


# ── cfg.get records itself into provenance ──────────────────────────────────


def test_cfg_get_records_its_key_into_provenance() -> None:
    """The stage never mentions the threshold in its Provenance - the read
    itself is what puts it there."""
    payload, ctx = load_fixture("dead_stock_basic")
    result = dead_stock(payload, ctx)

    assert result.ok
    assert "test.dead_stock.days" in result.provenance.config_keys


def test_recorded_and_declared_inputs_are_unioned() -> None:
    payload, ctx = load_fixture("dead_stock_basic")
    result = dead_stock(payload, ctx)
    # "items.sku" was declared on the Provenance; "items.last_sold_days_ago"
    # was recorded by record_input(). Both must survive.
    assert result.provenance.inputs == ("items.last_sold_days_ago", "items.sku")


def test_reading_config_outside_a_stage_does_not_raise() -> None:
    # Scripts and module-level code legitimately read config.
    assert REGISTRY.get(DEAD_STOCK_DAYS, make_ctx()) == 90


# ── The @stage decorator ────────────────────────────────────────────────────


def test_stage_stamps_name_version_and_duration() -> None:
    payload, ctx = load_fixture("dead_stock_basic")
    result = dead_stock(payload, ctx)
    assert (result.stage, result.stage_version) == ("dead_stock", "1.0.0")
    assert result.duration_ms >= 0
    assert result.stamped


def test_failure_is_a_normal_outcome_not_an_exception() -> None:
    ctx = make_ctx()
    result = dead_stock({"items": [{"sku": "A", "last_sold_days_ago": 1}]}, ctx)
    assert result.ok is False
    assert result.reasons == ("no_dead_stock",)
    assert result.value is None
    assert result.stage == "dead_stock"  # still stamped, still auditable


def test_an_escaped_exception_becomes_ok_false() -> None:
    @stage("boom", "1.0.0")
    def boom(payload, ctx):
        raise ValueError("upstream went away")

    result = boom(None, make_ctx())
    assert result.ok is False
    assert result.reasons[0].startswith("exception:ValueError: upstream went away")
    assert result.provenance.evidence_state == "NEW"  # pessimistic, not fabricated


def test_a_stage_without_provenance_is_a_hard_error() -> None:
    """A bare value is exactly what this package exists to abolish, so this
    raises rather than degrading to ok=False - it is a programmer error."""

    @stage("naked", "1.0.0")
    def naked(payload, ctx):
        return {"just": "a dict"}

    with pytest.raises(ProvenanceError, match="not a StageResult"):
        naked(None, make_ctx())


def test_stage_refuses_an_async_function() -> None:
    with pytest.raises(TypeError, match="async"):

        @stage("io", "1.0.0")
        async def io_stage(payload, ctx):  # pragma: no cover - never runs
            return None


def test_stage_requires_a_runcontext() -> None:
    with pytest.raises(TypeError, match="RunContext"):
        dead_stock({"items": []}, {"as_of": "2026-09-21"})


# ── Fixtures: no DB, no network, no clock ───────────────────────────────────


def test_a_stage_runs_from_a_json_fixture_alone() -> None:
    payload, ctx = load_fixture("dead_stock_basic")
    assert ctx.as_of == date(2026, 9, 21)
    result = dead_stock(payload, ctx)
    assert result.value == ["MD1", "ZB1"]


def test_missing_fixture_names_what_is_available() -> None:
    with pytest.raises(FileNotFoundError, match="dead_stock_basic"):
        load_fixture("no_such_fixture")


# ── Replay ──────────────────────────────────────────────────────────────────


def test_a_stage_replays_exactly_from_an_audit_row() -> None:
    payload, ctx = load_fixture("dead_stock_basic")
    original = dead_stock(payload, ctx)
    row = original.to_audit_row(ctx, stage_input=payload)

    # Round-trip through JSON: this is how it actually comes back, out of a
    # jsonb column, not as the in-memory object.
    row = json.loads(json.dumps(row))

    replayed = replay(row, dead_stock, payload)
    assert replayed.same_decision_as(original)
    assert replayed.value == original.value
    assert replayed.provenance == original.provenance


def test_replay_without_a_stage_fn_just_deserialises() -> None:
    payload, ctx = load_fixture("dead_stock_basic")
    original = dead_stock(payload, ctx)
    recorded = replay(original.to_audit_row(ctx, stage_input=payload))
    assert recorded.same_decision_as(original)


def test_replay_ignores_duration_but_nothing_else() -> None:
    payload, ctx = load_fixture("dead_stock_basic")
    original = dead_stock(payload, ctx)
    row = original.to_audit_row(ctx, stage_input=payload)
    row["duration_ms"] = original.duration_ms + 5_000  # wall clock always differs
    replay(row, dead_stock, payload)  # must not raise

    row["provenance"]["own_observations"] = 999
    with pytest.raises(ReplayMismatch, match="did not reproduce"):
        replay(row, dead_stock, payload)


def test_replay_catches_a_changed_input() -> None:
    payload, ctx = load_fixture("dead_stock_basic")
    row = dead_stock(payload, ctx).to_audit_row(ctx, stage_input=payload)
    tampered = {"items": payload["items"][:1]}
    with pytest.raises(ReplayMismatch, match="input does not match"):
        replay(row, dead_stock, tampered)


def test_replay_catches_a_version_bump() -> None:
    """An old row against new code is a mismatch to report, not to paper over."""
    payload, ctx = load_fixture("dead_stock_basic")
    row = dead_stock(payload, ctx).to_audit_row(ctx, stage_input=payload)

    @stage("dead_stock", "2.0.0")
    def dead_stock_v2(p, c):
        return dead_stock.undecorated(p, c)

    with pytest.raises(ReplayMismatch, match="version"):
        replay(row, dead_stock_v2, payload)


def test_replay_reproduces_a_config_change_as_a_difference() -> None:
    """The point of pinning config_version: the same code and the same input
    under a different threshold is a DIFFERENT answer, and replay says so."""
    payload, ctx = load_fixture("dead_stock_basic")
    row = dead_stock(payload, ctx).to_audit_row(ctx, stage_input=payload)

    strict = ConfigRegistry(version="strict", overrides={"test.dead_stock.days": 10})

    @stage("dead_stock", "1.0.0")
    def dead_stock_strict(p, c):
        days = strict.get(DEAD_STOCK_DAYS, c)
        return StageResult.success(
            sorted(i["sku"] for i in p["items"] if i["last_sold_days_ago"] >= days),
            Provenance(own_observations=len(p["items"]), own_weight=1.0,
                       evidence_state="ESTABLISHED", inputs=("items.sku",)),
        )

    row["context"]["config_version"] = "strict"
    with pytest.raises(ReplayMismatch, match="did not reproduce"):
        replay(row, dead_stock_strict, payload)


def test_unstamped_results_cannot_be_audited() -> None:
    naked = StageResult.success(1, Provenance(
        own_observations=1, own_weight=1.0, evidence_state="NEW"))
    with pytest.raises(ProvenanceError, match="unstamped"):
        naked.to_audit_row(make_ctx())


def test_digest_is_order_independent() -> None:
    assert digest({"a": 1, "b": 2}) == digest({"b": 2, "a": 1})
    assert digest({"a": 1}) != digest({"a": 2})


# ── Registry ────────────────────────────────────────────────────────────────


def test_config_version_mismatch_is_refused() -> None:
    """Silently resolving today's thresholds during a replay of an old run is
    the failure mode this check exists to prevent."""
    other = ConfigRegistry(version="experiment-b")
    with pytest.raises(ConfigVersionMismatch, match="experiment-b"):
        other.get(DEAD_STOCK_DAYS, make_ctx())


def test_overrides_apply_and_are_type_checked() -> None:
    strict = ConfigRegistry(version="strict", overrides={"test.dead_stock.days": 10})
    assert strict.get(DEAD_STOCK_DAYS, make_ctx(config_version="strict")) == 10

    sloppy = ConfigRegistry(version="strict", overrides={"test.dead_stock.days": "10"})
    with pytest.raises(ConfigError, match="expected int"):
        sloppy.get(DEAD_STOCK_DAYS, make_ctx(config_version="strict"))


def test_an_undeclared_setting_cannot_be_read() -> None:
    ghost = Setting.__new__(Setting)  # bypass __post_init__/registration
    object.__setattr__(ghost, "name", "never.declared")
    object.__setattr__(ghost, "default", 1)
    object.__setattr__(ghost, "unit", "x")
    object.__setattr__(ghost, "owner", "nobody")
    object.__setattr__(ghost, "why", "n/a")
    object.__setattr__(ghost, "status", "PROVISIONAL")
    with pytest.raises(UnregisteredSetting):
        REGISTRY.get(ghost, make_ctx())


def test_declaring_the_same_name_twice_is_refused() -> None:
    with pytest.raises(DuplicateSetting):
        Setting(
            name="test.dead_stock.days", default=30, unit="days",
            owner="someone_else", why="conflicting redeclaration",
        )


def test_a_setting_needs_an_owner_and_a_reason() -> None:
    with pytest.raises(ValueError, match="owner"):
        Setting(name="test.no.owner", default=1, unit="days", owner="", why="x")


def test_report_groups_by_status_and_counts_provisional() -> None:
    report = REGISTRY.report()
    assert DEAD_STOCK_DAYS in report.by_status["PROVISIONAL"]
    assert report.provisional_count >= 1
    assert report.total == len(catalog())
    rendered = str(report)
    assert "PROVISIONAL" in rendered and "still PROVISIONAL" in rendered


# ── Cross-language contract ─────────────────────────────────────────────────


def test_the_audit_row_shape_matches_the_node_golden_fixture() -> None:
    """backend/lib/stageEnvelope.js parses THIS shape.

    The golden file is emitted by this very code and committed on both sides.
    Pinning it here means a change to the audit row fails in Python too,
    rather than only surfacing later as a Node tile rendering `undefined`.
    Regenerate both copies deliberately when the shape must change.
    """
    from pathlib import Path

    golden_path = (
        Path(__file__).resolve().parents[1]
        / "tests" / "fixtures" / "stage_result_golden.json"
    )
    golden = json.loads(golden_path.read_text(encoding="utf-8"))

    @stage("dead_stock", "1.0.0")
    def golden_stage(payload, ctx):
        stale = sorted(i["sku"] for i in payload["items"] if i["last_sold_days_ago"] >= 90)
        return StageResult.success(
            stale,
            Provenance(
                own_observations=len(payload["items"]),
                cohort_level="state", cohort_size=240,
                own_weight=0.8, evidence_state="ESTABLISHED",
                inputs=("items.last_sold_days_ago", "items.sku"),
                config_keys=("dead_stock.days",),
            ),
        )

    payload, ctx = load_fixture("dead_stock_basic")
    row = golden_stage(payload, ctx).to_audit_row(ctx, stage_input=payload)
    row["duration_ms"] = 0  # wall clock; the golden pins it to 0

    assert row == golden, (
        "The audit-row shape changed. Regenerate the golden fixture in BOTH "
        "tests/fixtures/ and backend/tests/fixtures/, and check "
        "backend/lib/stageEnvelope.js still parses it."
    )
