"""k-anonymity — and it is not optional.

A cohort statistic is **other tenants' data**. A prior computed from two peers
effectively discloses those two shops' trading to a third party, and no amount
of averaging changes that: with n=2 and one known value, the other is
arithmetic. This is a legal boundary as much as a statistical one, which is why
it is in the code from the first commit rather than retrofitted.

THE RULE. Never compute a cohort statistic from fewer than `k` distinct
stores. If a rung has fewer, **climb** to the next rung rather than returning a
thin cohort. Climbing loses specificity; returning a thin cohort loses a
tenant's confidentiality, and only one of those is recoverable.

THE SECOND RULE, which bare k does not give you. A cohort of five where one
store contributes 96% of the volume is a cohort of one wearing a disguise: the
mean is that store's number, and publishing it discloses it as surely as n=1
would. So a cohort also fails when a single store dominates it beyond
`max_store_share_pct`. Bare k-anonymity is a count; this is about whether the
count means anything.

Both floors are registry Settings, so "what is our k, and has it ever changed"
is auditable rather than archaeological.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from app.pipeline.context import RunContext
from app.pipeline.registry import ConfigRegistry, Setting, cfg

PERCENT = 100

K_ANONYMITY_MIN = Setting(
    name="priors.k_anonymity.min_stores",
    default=5,
    unit="distinct stores",
    owner="privacy",
    why="the disclosure floor for any cross-tenant statistic. Below five "
        "stores an average is close enough to an individual shop's trading to "
        "identify it. A legal boundary, not a tuning knob - raise it freely, "
        "lower it only with sign-off",
    status="PROVISIONAL",
)

MAX_STORE_SHARE_PCT = Setting(
    name="priors.k_anonymity.max_single_store_share_pct",
    default=60,
    unit="percent of the cohort's total weight",
    owner="privacy",
    why="provisional; a cohort of five where one store is 96% of the volume "
        "discloses that store as surely as n=1 would. Bare k counts members; "
        "this checks the count means something. To be fitted in wave 6",
    status="PROVISIONAL",
)


@dataclass(frozen=True, slots=True)
class CohortObservation:
    """One store's contribution to a cohort statistic.

    `store_key` is what k counts — never row count. Fifty observations from
    two stores is a cohort of two, and the whole point of this module is that
    the distinction is never quietly lost.
    """

    store_key: tuple[int, int]
    value: float
    #: How much this store should count. Defaults to 1 (one store, one vote),
    #: which is deliberate: weighting by volume would let the largest store
    #: dominate the prior AND the disclosure risk at the same time.
    weight: float = 1.0


@dataclass(frozen=True, slots=True)
class KAnonVerdict:
    """Whether a cohort may be published, and why not if not."""

    ok: bool
    distinct_stores: int
    k: int
    max_share_pct: int
    dominant_store_share_pct: int | None
    reason: str | None

    def as_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok, "distinct_stores": self.distinct_stores, "k": self.k,
            "max_share_pct": self.max_share_pct,
            "dominant_store_share_pct": self.dominant_store_share_pct,
            "reason": self.reason,
        }


def distinct_stores(observations: Sequence[CohortObservation]) -> int:
    """Distinct STORES, not rows. The number k is about."""
    return len({o.store_key for o in observations})


def dominant_share_pct(observations: Sequence[CohortObservation]) -> int | None:
    """The largest single store's share of total weight, as an integer percent.

    Aggregates per store first: a store contributing thirty rows is still one
    store, and summing its rows is what makes the share meaningful.
    """
    if not observations:
        return None
    by_store: dict[tuple[int, int], float] = {}
    for o in observations:
        by_store[o.store_key] = by_store.get(o.store_key, 0.0) + abs(float(o.weight))
    total = sum(by_store.values())
    if total <= 0:
        return None
    return int(round(PERCENT * max(by_store.values()) / total))


def check(
    observations: Sequence[CohortObservation],
    ctx: RunContext,
    config: ConfigRegistry = cfg,
) -> KAnonVerdict:
    """May this cohort be published?

    Returns a verdict rather than raising: the caller's correct response is to
    CLIMB the ladder, not to fail, and an exception would make the normal path
    an error path.
    """
    k = config.get(K_ANONYMITY_MIN, ctx)
    max_share = config.get(MAX_STORE_SHARE_PCT, ctx)
    n = distinct_stores(observations)
    share = dominant_share_pct(observations)

    if n < k:
        return KAnonVerdict(
            ok=False, distinct_stores=n, k=k, max_share_pct=max_share,
            dominant_store_share_pct=share,
            reason=f"k_anonymity:{n}<{k}_distinct_stores",
        )
    if share is not None and share > max_share:
        return KAnonVerdict(
            ok=False, distinct_stores=n, k=k, max_share_pct=max_share,
            dominant_store_share_pct=share,
            reason=f"k_anonymity:single_store_is_{share}pct>{max_share}pct_of_cohort",
        )
    return KAnonVerdict(
        ok=True, distinct_stores=n, k=k, max_share_pct=max_share,
        dominant_store_share_pct=share, reason=None,
    )


def redact(observations: Sequence[CohortObservation]) -> list[float]:
    """Values only, store keys dropped, sorted.

    What leaves this module into a statistic. Sorted so the output is
    deterministic — an unsorted list would make two identical cohorts produce
    different hashes and break replay — and store-stripped so a downstream
    accident cannot re-identify a contributor.
    """
    return sorted(float(o.value) for o in observations)


__all__ = [
    "K_ANONYMITY_MIN",
    "MAX_STORE_SHARE_PCT",
    "CohortObservation",
    "KAnonVerdict",
    "check",
    "distinct_stores",
    "dominant_share_pct",
    "redact",
]
