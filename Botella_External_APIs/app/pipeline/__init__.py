"""The stage envelope — the contract every pipeline stage is written against.

A stage receives everything it may use (``RunContext``) and returns everything
it decided (``StageResult``), including how it decided (``Provenance``).

    from app.pipeline import Provenance, RunContext, StageResult, cfg, stage

    THRESHOLD = Setting(
        name="dead_stock.days", default=90, unit="days", owner="inventory",
        why="provisional; to be fitted in wave 6", status="PROVISIONAL",
    )

    @stage("dead_stock", "1.0.0")
    def dead_stock(items, ctx):
        days = cfg.get(THRESHOLD, ctx)          # records itself into provenance
        record_input("items.last_sold_at")      # ditto
        stale = [i for i in items if (ctx.as_of - i.last_sold).days >= days]
        if not stale:
            return StageResult.failure("no_dead_stock")
        return StageResult.success(
            stale,
            Provenance(
                own_observations=len(items), own_weight=1.0,
                evidence_state="ESTABLISHED",
            ),
        )

Nothing in a stage may read the clock, the environment, or a connection. If a
stage needs it, it belongs in RunContext — see the module docstrings for why
one stray ``date.today()`` is worse than it looks.
"""

from app.pipeline.context import FrozenDict, RunContext
from app.pipeline.envelope import (
    AUDIT_SCHEMA,
    PipelineError,
    ProvenanceError,
    ReplayMismatch,
    StageResult,
    digest,
    replay,
    stage,
)
from app.pipeline.fixtures import load_fixture, save_fixture
from app.pipeline.provenance import (
    COHORT_LEVELS,
    EVIDENCE_STATES,
    CohortLevel,
    EvidenceState,
    Provenance,
    record_input,
    record_inputs,
    recording,
)
from app.pipeline.registry import (
    STATUSES,
    ConfigError,
    ConfigRegistry,
    ConfigReport,
    ConfigVersionMismatch,
    DuplicateSetting,
    Setting,
    Status,
    UnregisteredSetting,
    catalog,
    cfg,
)

__all__ = [
    "AUDIT_SCHEMA",
    "COHORT_LEVELS",
    "EVIDENCE_STATES",
    "STATUSES",
    "CohortLevel",
    "ConfigError",
    "ConfigRegistry",
    "ConfigReport",
    "ConfigVersionMismatch",
    "DuplicateSetting",
    "EvidenceState",
    "FrozenDict",
    "PipelineError",
    "Provenance",
    "ProvenanceError",
    "ReplayMismatch",
    "RunContext",
    "Setting",
    "StageResult",
    "Status",
    "UnregisteredSetting",
    "catalog",
    "cfg",
    "digest",
    "load_fixture",
    "record_input",
    "record_inputs",
    "recording",
    "replay",
    "save_fixture",
    "stage",
]
