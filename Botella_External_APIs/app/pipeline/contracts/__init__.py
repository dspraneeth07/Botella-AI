"""Data contracts and quality gates — the system's right to refuse.

A store whose data fails its contract produces no recommendation and a stated
reason, which is infinitely better than a confident one built on rubbish.

    from app.pipeline.contracts import Batch, run_quality_gates

    verdict = run_quality_gates(ctx, batch=batch, freshness=fresh, anomaly=anom)
    if not verdict.may_recommend:
        return  # ...with verdict.reasons, never silently

Every gate is a sheet-00 stage: pure, replayable, provenance-carrying.
"""

from app.pipeline.contracts.gates import (
    UNAVAILABLE,
    VERDICTS,
    AnomalyInput,
    Batch,
    FieldAvailability,
    FreshnessInput,
    QualityVerdict,
    TrailingStats,
    anomaly_gate,
    completeness_gate,
    freshness_gate,
    run_quality_gates,
    schema_gate,
)
from app.pipeline.contracts.schema import (
    BASE,
    ENTITIES,
    Contract,
    ContractRegistry,
    FieldSpec,
    coerce,
    is_present,
    registry,
)

__all__ = [
    "BASE",
    "ENTITIES",
    "UNAVAILABLE",
    "VERDICTS",
    "AnomalyInput",
    "Batch",
    "Contract",
    "ContractRegistry",
    "FieldAvailability",
    "FieldSpec",
    "FreshnessInput",
    "QualityVerdict",
    "TrailingStats",
    "anomaly_gate",
    "coerce",
    "completeness_gate",
    "freshness_gate",
    "is_present",
    "registry",
    "run_quality_gates",
    "schema_gate",
]
