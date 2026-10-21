"""Sheet 14 — decision validation. The last gate before the model is called.

Asks ONE question - is this decision correct - and asks it before a token is
spent. Sheet 16 asks a different one: does the sentence match the decision.

A failure here PAGES: an upstream stage produced something impossible. A
sheet-16 failure only logs. Conflating the two is what made the previous
single validator useless.
"""

from app.pipeline.validate.decision import (
    INVENTORY_TOLERANCE_UNITS,
    MAX_ORDER_BY_HORIZON_DAYS,
    MAX_PLAUSIBLE_ORDER_MULTIPLE,
    REQUIRED_CONSTRAINTS,
    RISK_TOLERANCE_PCT,
    Check,
    DecisionRecord,
    DecisionRequest,
    Failure,
    Severity,
    coverage_demand,
    pageable,
    validate_decision,
)
from app.pipeline.validate.explanation import (
    CLAIM_PATTERNS,
    ClaimPattern,
    ExplanationCheck,
    ExplanationCheckRequest,
    ExplanationFailure,
    ExplanationStats,
    ExplanationVerdict,
    StoreCatalogue,
    claim_evidence,
    validate_explanation,
)

__all__ = [
    "CLAIM_PATTERNS", "ClaimPattern", "ExplanationCheck", "ExplanationFailure",
    "ExplanationCheckRequest", "ExplanationVerdict", "ExplanationStats",
    "StoreCatalogue", "claim_evidence", "validate_explanation",
    "INVENTORY_TOLERANCE_UNITS", "MAX_ORDER_BY_HORIZON_DAYS",
    "MAX_PLAUSIBLE_ORDER_MULTIPLE", "REQUIRED_CONSTRAINTS",
    "RISK_TOLERANCE_PCT", "Check", "DecisionRecord", "DecisionRequest",
    "Failure", "Severity", "coverage_demand", "pageable",
    "validate_decision",
]
