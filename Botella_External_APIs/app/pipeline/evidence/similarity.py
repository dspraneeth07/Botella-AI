"""Store similarity on OBSERVABLE STRUCTURE. Deliberately boring.

Resist the urge to learn an embedding. Every match must be explainable to a
store owner in one sentence, because sheet 15 will say *"stores like yours"*
and has to mean something specific by it. "The model thinks you are similar"
is not an explanation; "same state, 88% category overlap, comparable monthly
volume" is.

WHAT THE SHEET ASKS FOR, AND WHAT ACTUALLY EXISTS

The sheet names five signals. Checked against the warehouse:

    state                 ✓ client_locations.state (TX 34, FL 23, IL 13, …)
    category mix          ✓ computable from products.category + sale_items
    monthly volume band   ✓ computable
    store format / size   ✗ NO SUCH COLUMN ANYWHERE
    urban / rural         ✗ no population or density data anywhere

Two of five are simply not in the estate. The honest response is to score on
what exists, RENORMALISE over the available dimensions, and declare the
missing ones on the result — not to default them to a neutral value, which
would silently dilute every score by a constant and make two stores look more
alike than the evidence supports. `missing_dimensions` travels with every
match for exactly that reason.

Weights are integer percentages (sheet 00 bans float literals outside the
registry) and they are renormalised over whichever dimensions were actually
comparable.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from app.pipeline.context import RunContext
from app.pipeline.registry import ConfigRegistry, Setting, cfg

PERCENT = 100

# ── Weights ──────────────────────────────────────────────────────────────────

WEIGHT_CATEGORY_MIX = Setting(
    name="peers.weight.category_mix_pct",
    default=50,
    unit="percent of the similarity score",
    owner="evidence",
    why="provisional; what a store SELLS is the strongest observable signal of "
        "what it is. A wine-led shop and a beer-and-singles shop in the same "
        "town are not peers. To be fitted in wave 6",
    status="PROVISIONAL",
)

WEIGHT_VOLUME_BAND = Setting(
    name="peers.weight.volume_band_pct",
    default=30,
    unit="percent of the similarity score",
    owner="evidence",
    why="provisional; scale changes which advice applies - a 200-unit/day shop "
        "and a 2,000-unit/day shop have different stockout economics",
    status="PROVISIONAL",
)

WEIGHT_FORMAT = Setting(
    name="peers.weight.format_pct",
    default=20,
    unit="percent of the similarity score",
    owner="evidence",
    why="provisional; store format and urban/rural. CURRENTLY UNUSED - the "
        "estate has neither field, so this weight is renormalised away and "
        "reported as a missing dimension rather than silently applied",
    status="PROVISIONAL",
)

VOLUME_BAND_RATIO_PCT = Setting(
    name="peers.volume_band.full_credit_ratio_pct",
    default=150,
    unit="percent - the larger volume over the smaller",
    owner="evidence",
    why="provisional; within 1.5x of each other counts as the same scale band. "
        "Beyond 4x they score zero on this dimension",
    status="PROVISIONAL",
)

VOLUME_BAND_ZERO_RATIO_PCT = Setting(
    name="peers.volume_band.zero_credit_ratio_pct",
    default=400,
    unit="percent - the larger volume over the smaller",
    owner="evidence",
    why="provisional; a 4x difference in scale means the stores face different "
        "problems, whatever else they share",
    status="PROVISIONAL",
)


# ── Store features ───────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class StoreFeatures:
    """The observable structure of one store. All of it explainable out loud."""

    client_id: int
    location_id: int
    state: str | None = None
    #: category -> share of revenue, summing to ~1. The shape of the business.
    category_share: Mapping[str, float] = field(default_factory=dict)
    #: Units per OPEN day (sheet 03's rate, never per calendar day).
    monthly_volume: float | None = None
    #: Neither exists in the estate today; kept so the code is ready and the
    #: gap is visible rather than forgotten.
    store_format: str | None = None
    density_class: str | None = None

    @property
    def key(self) -> tuple[int, int]:
        return (self.client_id, self.location_id)


@dataclass(frozen=True, slots=True)
class Similarity:
    """One pairwise comparison, with its reasons."""

    score: float
    components: dict[str, float]
    weights_used: dict[str, int]
    missing_dimensions: tuple[str, ...]
    match_reasons: tuple[str, ...]

    def as_dict(self) -> dict[str, Any]:
        return {
            "score": self.score,
            "components": dict(self.components),
            "weights_used": dict(self.weights_used),
            "missing_dimensions": list(self.missing_dimensions),
            "match_reasons": list(self.match_reasons),
        }


# ── The pieces ───────────────────────────────────────────────────────────────


def cosine_similarity(a: Mapping[str, float], b: Mapping[str, float]) -> float | None:
    """Cosine over category revenue share. Symmetric by construction.

    None when either side has nothing to compare — an unknown overlap is not
    a zero overlap, and scoring it as one would make a brand-new store look
    maximally different from everybody.
    """
    if not a or not b:
        return None
    keys = set(a) | set(b)
    dot = sum(float(a.get(k, 0.0)) * float(b.get(k, 0.0)) for k in keys)
    norm_a = math.sqrt(sum(float(v) ** 2 for v in a.values()))
    norm_b = math.sqrt(sum(float(v) ** 2 for v in b.values()))
    if norm_a == 0.0 or norm_b == 0.0:
        return None
    return max(0.0, min(1.0, dot / (norm_a * norm_b)))


def volume_band_similarity(
    a: float | None, b: float | None, full_credit_pct: int, zero_credit_pct: int
) -> float | None:
    """1.0 within `full_credit_pct` of each other, 0.0 beyond `zero_credit_pct`.

    Uses the RATIO of larger to smaller, which is symmetric: comparing A to B
    and B to A gives the same band distance. A difference-based measure would
    not, and `find_peers` would then produce different neighbours depending on
    which store asked.
    """
    if a is None or b is None:
        return None
    if a <= 0 or b <= 0:
        return None
    hi, lo = (a, b) if a >= b else (b, a)
    ratio_pct = PERCENT * hi / lo
    if ratio_pct <= full_credit_pct:
        return 1.0
    if ratio_pct >= zero_credit_pct:
        return 0.0
    span = zero_credit_pct - full_credit_pct
    return max(0.0, min(1.0, 1.0 - (ratio_pct - full_credit_pct) / span))


def exact_similarity(a: str | None, b: str | None) -> float | None:
    if not a or not b:
        return None
    return 1.0 if a.strip().lower() == b.strip().lower() else 0.0


def _top_shared_categories(
    a: Mapping[str, float], b: Mapping[str, float], limit: int = 2
) -> list[str]:
    shared = [(k, min(float(a.get(k, 0.0)), float(b.get(k, 0.0)))) for k in set(a) & set(b)]
    shared.sort(key=lambda kv: kv[1], reverse=True)
    return [k for k, v in shared[:limit] if v > 0]


# ── The comparison ───────────────────────────────────────────────────────────


def compare(
    a: StoreFeatures, b: StoreFeatures, ctx: RunContext, config: ConfigRegistry = cfg
) -> Similarity:
    """Score two stores. SYMMETRIC: compare(a, b) == compare(b, a).

    Every component that cannot be computed is dropped and named. The score is
    renormalised over the weights that were actually used, so a store missing
    one dimension is not penalised for the gap — it is simply scored on less,
    and the result says how much less.
    """
    w_cat = config.get(WEIGHT_CATEGORY_MIX, ctx)
    w_vol = config.get(WEIGHT_VOLUME_BAND, ctx)
    w_fmt = config.get(WEIGHT_FORMAT, ctx)
    full_pct = config.get(VOLUME_BAND_RATIO_PCT, ctx)
    zero_pct = config.get(VOLUME_BAND_ZERO_RATIO_PCT, ctx)

    candidates: list[tuple[str, float | None, int]] = [
        ("category_mix", cosine_similarity(a.category_share, b.category_share), w_cat),
        ("volume_band",
         volume_band_similarity(a.monthly_volume, b.monthly_volume, full_pct, zero_pct),
         w_vol),
        # Both currently None estate-wide; they drop out and are reported.
        ("store_format", exact_similarity(a.store_format, b.store_format), w_fmt),
    ]

    components: dict[str, float] = {}
    weights_used: dict[str, int] = {}
    missing: list[str] = []
    for name, value, weight in candidates:
        if value is None:
            missing.append(name)
            continue
        components[name] = round(value, 4)
        weights_used[name] = weight

    if a.density_class is None or b.density_class is None:
        missing.append("density_class")

    total_weight = sum(weights_used.values())
    score = (
        sum(components[name] * weights_used[name] for name in components) / total_weight
        if total_weight else 0.0
    )

    reasons: list[str] = []
    if exact_similarity(a.state, b.state) == 1.0:
        reasons.append(f"same state ({a.state})")
    if "category_mix" in components:
        pct = int(round(PERCENT * components["category_mix"]))
        shared = _top_shared_categories(a.category_share, b.category_share)
        reasons.append(
            f"{pct}% category-mix overlap"
            + (f" (mainly {' and '.join(shared)})" if shared else "")
        )
    if "volume_band" in components and a.monthly_volume and b.monthly_volume:
        hi, lo = max(a.monthly_volume, b.monthly_volume), min(a.monthly_volume, b.monthly_volume)
        reasons.append(
            "comparable volume" if components["volume_band"] >= 1.0
            else f"volume differs {hi / lo:.1f}x"
        )
    for name in missing:
        reasons.append(f"{name} not comparable (not held for this estate)")

    return Similarity(
        score=round(score, 4),
        components=components,
        weights_used=weights_used,
        missing_dimensions=tuple(missing),
        match_reasons=tuple(reasons),
    )


def explain(a: StoreFeatures, b: StoreFeatures, sim: Similarity) -> str:
    """One sentence a store owner would accept. Sheet 15 renders this."""
    usable = [r for r in sim.match_reasons if "not comparable" not in r]
    if not usable:
        return "No comparable structure — this match is not explainable, so it should not be shown."
    return "Matched because: " + "; ".join(usable) + "."


__all__ = [
    "VOLUME_BAND_RATIO_PCT",
    "VOLUME_BAND_ZERO_RATIO_PCT",
    "WEIGHT_CATEGORY_MIX",
    "WEIGHT_FORMAT",
    "WEIGHT_VOLUME_BAND",
    "Similarity",
    "StoreFeatures",
    "compare",
    "cosine_similarity",
    "exact_similarity",
    "explain",
    "volume_band_similarity",
]
