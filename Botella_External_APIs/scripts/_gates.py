"""Gate A and Gate B — now a re-export of the real module.

WHY THIS FILE IS A SHIM
    This logic decided which stores were fit to ship, and it lived here: in
    `scripts/`, which the deployed application cannot import. So the verdict
    existed, was published on an audit page, and the engine it was a verdict ABOUT
    had no way to read it.

    It now lives in `app/pipeline/gate/store.py`, where the serving path can
    consult it. This file stays so the harness, the audit pages, the report
    generators and every existing test keep importing `scripts._gates` unchanged —
    moving the logic should not have been a reason to touch twenty call sites.

    New code should import from `app.pipeline.gate.store` directly.

WHAT IS STILL HARNESS-ONLY, AND CORRECTLY SO
    `scripts/_gate_inputs.py`. A store's ECE, interval coverage and net margin can
    only be computed from accumulated outcomes, which is batch work over ledgers.
    The INPUTS are measured offline; only the VERDICT is read on the request path.
    That split is deliberate and is why this module is pure stdlib and that one is
    not.
"""

from __future__ import annotations

from app.pipeline.gate.store import (
    MAX_ECE_POINTS,
    MAX_NULL_P_VALUE,
    MAX_RELIABILITY_DEVIATION_POINTS,
    MIN_CARDS_FOR_A_FAMILY_VERDICT,
    MIN_EDGE_POINTS,
    MIN_INTERVAL_COVERAGE,
    MIN_NET_MARGIN_PER_MONTH,
    PROMISE_FILL_BAND,
    Check,
    GateResult,
    ServingDecision,
    StoreVerdict,
    cost_coverage,
    gate_a,
    gate_b,
    gate_table,
    has_cost_data,
    serving_decision,
    verdict_for,
)

__all__ = [
    "MAX_ECE_POINTS",
    "MAX_NULL_P_VALUE",
    "MAX_RELIABILITY_DEVIATION_POINTS",
    "MIN_CARDS_FOR_A_FAMILY_VERDICT",
    "MIN_EDGE_POINTS",
    "MIN_INTERVAL_COVERAGE",
    "MIN_NET_MARGIN_PER_MONTH",
    "PROMISE_FILL_BAND",
    "Check",
    "GateResult",
    "ServingDecision",
    "StoreVerdict",
    "cost_coverage",
    "gate_a",
    "gate_b",
    "gate_table",
    "has_cost_data",
    "serving_decision",
    "verdict_for",
]
