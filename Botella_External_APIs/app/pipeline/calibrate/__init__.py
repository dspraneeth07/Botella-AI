"""Sheet 08 — confidence calibration, fitted from outcomes and applied before
the decision.

    fit      offline, weekly   isotonic per (family, demand class)
    apply    ONLINE, in-run    before ranking and before display
    monitor  after outcomes    Brier / ECE / reliability, and suspension

The ordering in `apply` is the sheet: calibration shapes what gets
recommended rather than grading what already was.
"""

from app.pipeline.calibrate.apply import (
    IDENTITY,
    IDENTITY_VERSION,
    ISOTONIC,
    ApplyRequest,
    Calibrated,
    apply_calibration,
    calibrate_many,
    rank_key,
)
from app.pipeline.calibrate.fit import (
    FAMILIES,
    CalibrationBundle,
    FitRequest,
    IsotonicFit,
    Outcome,
    fit_calibration,
    pool_adjacent_violators,
)
from app.pipeline.calibrate.monitor import (
    COIN_FLIP_BRIER,
    Bin,
    FamilyScore,
    MonitorReport,
    MonitorRequest,
    Prediction,
    brier_score,
    expected_calibration_error,
    monitor_calibration,
    reliability_curve,
)

__all__ = [
    "COIN_FLIP_BRIER",
    "FAMILIES",
    "IDENTITY",
    "IDENTITY_VERSION",
    "ISOTONIC",
    "ApplyRequest",
    "Bin",
    "Calibrated",
    "CalibrationBundle",
    "FamilyScore",
    "FitRequest",
    "IsotonicFit",
    "MonitorReport",
    "MonitorRequest",
    "Outcome",
    "Prediction",
    "apply_calibration",
    "brier_score",
    "calibrate_many",
    "expected_calibration_error",
    "fit_calibration",
    "monitor_calibration",
    "pool_adjacent_violators",
    "rank_key",
    "reliability_curve",
]
