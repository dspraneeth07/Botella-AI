"""The volume-matched null. What would have happened anyway?

WHY THE NULL HAS TO BE MATCHED
    A product selling 2 units a month and one selling 200 are not comparable
    in percentage terms. The quiet one routinely doubles or halves on a single
    basket; the busy one does not move 100% without something real happening.

    Compare a recommendation against the WHOLE catalogue and the answer is
    decided by which side happened to draw the quieter products. Whichever arm
    got the low-volume SKUs shows the wider swings, and the comparison flatters
    it or damns it for a reason that has nothing to do with the recommendation.

    So the null is drawn from the SAME volume class, at the SAME store, over
    the SAME window. Everything that could explain the difference is held
    still except the one thing being tested: whether we said something.

WHY A RANDOMISATION TEST AND NOT A t-TEST
    Lift distributions here are skewed, bounded below, and fat-tailed at low
    volume - none of which a t-test's assumptions survive. A randomisation
    test assumes nothing: it builds the null by drawing matched baskets and
    asks how often chance alone produces what we saw.

    It is also honest about small n. With 6 outcomes the p-value simply cannot
    go below 1/(B+1) worth of resolution, and the test says so rather than
    reporting a confident number from thin evidence.

DETERMINISM
    The draw is seeded from `ctx.seed` and `ctx.snapshot_id`, never from the
    system entropy pool. Two runs over the same snapshot produce byte-identical
    p-values, months apart - without that, "the gate opened" would not be a
    reproducible fact and nobody could argue with it.
"""

from __future__ import annotations

import random
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from app.pipeline.context import RunContext
from app.pipeline.registry import ConfigRegistry, Setting, cfg

PERCENT = 100

MATCHED_BASKETS = Setting(
    name="gate.matched_baskets",
    default=400,
    unit="null baskets drawn per comparison",
    owner="forecasting",
    why="provisional; the number the original backtest used, kept so the gate "
        "and that analysis are comparable. It also sets the RESOLUTION of the "
        "p-value: with B draws nothing can be reported below 1/(B+1), so 400 "
        "bottoms out near 0.0025 - comfortably under any threshold worth "
        "setting, and cheap enough to run per store-family every day",
    status="PROVISIONAL",
)

#: Boundaries between volume classes, in units per OPEN day. Open days, not
#: calendar days - the denominator sheet 03 exists to fix.
VOLUME_CLASS_BOUNDS = Setting(
    name="gate.volume_class_bounds",
    default=(0.1, 0.5, 2.0, 10.0),
    unit="units per open day, the cut points between volume classes",
    owner="forecasting",
    why="provisional; five classes spanning the estate, chosen so each holds "
        "enough SKUs to draw a null from at a single store. The cut points "
        "matter less than the matching itself - what must not happen is a "
        "2-a-month SKU being compared against a 200-a-month one, and any "
        "reasonable partition prevents that",
    status="PROVISIONAL",
)


@dataclass(frozen=True, slots=True)
class Outcome:
    """One measured recommendation, and the volume class it belongs to.

    `lift` is the measured effect - sales after against the matched baseline -
    already computed by the evaluation service. This module does not recompute
    it; it only asks whether a set of lifts beats what the same products would
    have done unprompted.
    """

    sku: str
    family: str
    lift: float
    volume_class: str
    #: True when the store was SHOWN this recommendation, False for the
    #: holdout arm. Both are scored identically - that is the point of the
    #: holdout - but only the shown arm is being tested.
    shown: bool = True


def volume_class(
    units_per_open_day: float | None,
    ctx: RunContext,
    config: ConfigRegistry = cfg,
) -> str:
    """Which volume class a SKU belongs to.

    None is its own class rather than being folded into the lowest one.
    "we never measured this SKU's rate" and "this SKU sells almost nothing"
    are different facts, and matching an unmeasured SKU against the slowest
    sellers would quietly assume the answer.
    """
    if units_per_open_day is None:
        return "unmeasured"
    bounds = config.get(VOLUME_CLASS_BOUNDS, ctx)
    for index, bound in enumerate(bounds):
        if units_per_open_day < bound:
            return f"v{index}"
    return f"v{len(bounds)}"


def _rng(ctx: RunContext, salt: str) -> random.Random:
    """A generator seeded from the run, never from the system.

    `snapshot_id` is in the seed as well as `seed`, so two different snapshots
    draw differently even at the same seed - otherwise a re-run over new data
    would reuse the previous draw and look more stable than it is.
    """
    return random.Random(f"{ctx.seed}:{ctx.snapshot_id}:{salt}")


@dataclass(frozen=True, slots=True)
class MatchedResult:
    """The comparison, and everything needed to argue with it."""

    observed: float
    #: Mean of the null distribution - what these products did unprompted.
    null_mean: float
    p_value: float
    n_outcomes: int
    baskets: int
    #: The finest p-value this many baskets can express. Reported so a
    #: p of 0.0025 is not read as "vanishingly unlikely" when it is simply
    #: the floor.
    resolution: float
    #: Per-class counts of the null pool actually available. A class with a
    #: thin pool produces a noisy null, and that is visible here rather than
    #: hidden in the p-value.
    pool_sizes: dict[str, int]

    @property
    def beats_null(self) -> bool:
        return self.observed > self.null_mean

    def as_dict(self) -> dict[str, Any]:
        return {
            "observed": self.observed, "null_mean": self.null_mean,
            "p_value": self.p_value, "n_outcomes": self.n_outcomes,
            "baskets": self.baskets, "resolution": self.resolution,
            "beats_null": self.beats_null,
            "pool_sizes": dict(sorted(self.pool_sizes.items())),
        }


def compare_to_matched_null(
    outcomes: Sequence[Outcome],
    null_pool: dict[str, Sequence[float]],
    ctx: RunContext,
    config: ConfigRegistry = cfg,
) -> MatchedResult | None:
    """Is this family's measured lift better than the same products unprompted?

    `null_pool` maps a volume class to the lifts of SKUs in that class at this
    store which received NO recommendation in the window. Supplied, never
    fetched - Python holds no analytics credentials.

    Returns None when no outcome can be matched at all, which is a refusal
    rather than a result: a comparison with nothing to compare against is not
    a p-value of 1, it is an absence of evidence, and the two must not look
    alike to the gate.
    """
    usable = [o for o in outcomes if null_pool.get(o.volume_class)]
    if not usable:
        return None

    observed = sum(o.lift for o in usable) / len(usable)
    baskets = int(config.get(MATCHED_BASKETS, ctx))
    rng = _rng(ctx, "matched_null")

    # Each draw rebuilds a fake family of the same size and the same volume
    # MIX as the real one - one draw per outcome, from that outcome's own
    # class. Drawing the whole basket from one pooled class would lose the
    # matching the moment a family spans two classes.
    null_means: list[float] = []
    for _ in range(baskets):
        total = 0.0
        for outcome in usable:
            pool = null_pool[outcome.volume_class]
            total += pool[rng.randrange(len(pool))]
        null_means.append(total / len(usable))

    # ADD-ONE. The count includes the observed value itself, so a p-value can
    # never be reported as exactly zero - with B draws the strongest claim
    # available is 1/(B+1), and pretending to more precision than the
    # simulation has is how a gate opens on noise.
    at_least_as_good = sum(1 for m in null_means if m >= observed)
    p_value = (at_least_as_good + 1) / (baskets + 1)

    return MatchedResult(
        observed=observed,
        null_mean=sum(null_means) / len(null_means),
        p_value=p_value,
        n_outcomes=len(usable),
        baskets=baskets,
        resolution=1 / (baskets + 1),
        pool_sizes={cls: len(pool) for cls, pool in null_pool.items()},
    )


__all__ = [
    "MATCHED_BASKETS",
    "VOLUME_CLASS_BOUNDS",
    "MatchedResult",
    "Outcome",
    "compare_to_matched_null",
    "volume_class",
]
