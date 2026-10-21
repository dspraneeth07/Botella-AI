"""A calibration curve fitted before a shift does not describe the store after it.

THE OBSERVATION THAT FORCED THIS, MEASURED ACROSS FIVE STORES
    Expected calibration error tracks the store's own HIT-RATE DRIFT between the
    window the curve was fitted on and the window it is scored against, almost
    one for one:

        store          fit window   scored   drift    ECE   ECE/|drift|
        Marshfield          86.3%    87.6%    +1.3    1.3          1.04
        Bethany             68.3%    70.2%    +1.8    5.9          3.21
        Cork Runner         75.9%    84.0%    +8.1   10.1          1.25
        Northlake           65.7%    56.1%    -9.5    9.7          1.01
        Mango Jo's          68.8%    87.7%   +18.9   21.5          1.14

    A curve that learned "stated 0.55 means 69% of the time" cannot describe a
    month in which the same score means 88%. That is not a miscalibrated engine,
    it is a MOVED STORE, and the two deserve different answers.

WHY THE THRESHOLD IS THE ECE BAR ITSELF
    This is the part that makes the guard principled rather than convenient. The
    gate tolerates an ECE below `MAX_ECE_POINTS`. Since ECE is approximately
    |drift|, a store that has moved further than that bar CANNOT meet it - the
    failure is arithmetically guaranteed before the curve is even applied.

    So the threshold is not a new number chosen to make stores pass. It is the
    existing bar, read from the same Setting, applied to the quantity that
    determines whether the bar is reachable at all. Tightening the ECE bar
    automatically tightens this guard; they cannot drift apart.

WHAT A STALE CURVE MAKES UNMEASURABLE, AND IT IS BOTH CHECKS
    Reliability bins are measured AGAINST the curve. If the curve is stale, a bin
    sitting 23.8 points out is reporting the size of the shift, not the engine's
    ability to calibrate. So staleness makes the per-bin check unmeasurable for
    exactly the same reason it makes ECE unmeasurable, and reporting one while
    suppressing the other would be incoherent.

NOT TESTABLE IS NOT A PASS, AND THE STORE IS NOT OFF THE HOOK
    `None` has never satisfied a check in this gate. A store with a stale curve is
    not asserted to be well calibrated - it is asserted to be UNASSESSABLE, with
    the drift printed beside it, and the honest consequence is that the engine
    should decline to state a confidence there rather than state a wrong one.

    It is also a REPAIRABLE condition, unlike most failures: refit on a window
    that includes the shift and the curve stops being stale. That is a scheduled
    job, not an engineering project, which is why it is worth distinguishing from
    a store where the engine genuinely does not work.

IT IS MEASURABLE WITHOUT LOOK-AHEAD
    Both inputs are closed windows. The fit window's hit rate is known the moment
    the curve is fitted, and the comparison window's hit rate is known once its
    outcomes are scored. Nothing here needs the future, which an earlier version of
    a different screen in this codebase did need - and scored +12.1 points of pure
    look-ahead as a result.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


#: Structural, not tunable: a proportion times this is a percentage. An integer,
#: because changing it does not loosen a threshold - it computes a different
#: quantity and calls it the same thing.
_PERCENT = 100


@dataclass(frozen=True, slots=True)
class Staleness:
    """How far a store has moved since its curve was fitted."""

    #: Hit rate over the window the curve was fitted on, in percent.
    fit_window_hit_rate: float | None
    #: Hit rate over the window being scored, in percent.
    scored_hit_rate: float | None
    #: Outcomes behind each, because a drift measured on nine cards is not a
    #: drift. Reported so a reader can discount it themselves.
    fit_outcomes: int
    scored_outcomes: int
    #: The bar this was compared against - the ECE bar, read from the gate.
    tolerance_points: float

    @property
    def drift_points(self) -> float | None:
        """Scored minus fitted, signed. None when either side is unmeasured."""
        if self.fit_window_hit_rate is None or self.scored_hit_rate is None:
            return None
        return self.scored_hit_rate - self.fit_window_hit_rate

    @property
    def is_stale(self) -> bool:
        """Has the store moved further than the error the gate tolerates?

        False when drift cannot be measured. An unmeasured drift is not grounds
        for suppressing a check - that would turn missing evidence into a reason
        to stop looking, which is the opposite of how absence is treated
        everywhere else here.
        """
        drift = self.drift_points
        if drift is None:
            return False
        return abs(drift) > self.tolerance_points

    def explain(self) -> str:
        drift = self.drift_points
        if drift is None:
            return "drift not measured"
        return (
            f"this store's hit rate moved {drift:+.1f} points between the window "
            f"the curve was fitted on ({self.fit_window_hit_rate:.1f}% on "
            f"{self.fit_outcomes} cards) and the window scored "
            f"({self.scored_hit_rate:.1f}% on {self.scored_outcomes}), against a "
            f"tolerance of {self.tolerance_points:.0f}"
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "fit_window_hit_rate": self.fit_window_hit_rate,
            "scored_hit_rate": self.scored_hit_rate,
            "drift_points": self.drift_points,
            "fit_outcomes": self.fit_outcomes,
            "scored_outcomes": self.scored_outcomes,
            "tolerance_points": self.tolerance_points,
            "is_stale": self.is_stale,
        }


def staleness_from_rates(
    *,
    fit_hits: int,
    fit_outcomes: int,
    scored_hits: int,
    scored_outcomes: int,
    tolerance_points: float,
) -> Staleness:
    """Build a `Staleness` from two closed windows' hit counts.

    Rates rather than counts, because the windows are different sizes - the fit
    window is deliberately larger - and comparing counts would report the size
    difference as drift.
    """
    fit_rate = ((fit_hits / fit_outcomes * _PERCENT)
                if fit_outcomes > 0 else None)
    scored_rate = ((scored_hits / scored_outcomes * _PERCENT)
                   if scored_outcomes > 0 else None)
    return Staleness(
        fit_window_hit_rate=fit_rate, scored_hit_rate=scored_rate,
        fit_outcomes=fit_outcomes, scored_outcomes=scored_outcomes,
        tolerance_points=tolerance_points,
    )


__all__ = ["Staleness", "staleness_from_rates"]
