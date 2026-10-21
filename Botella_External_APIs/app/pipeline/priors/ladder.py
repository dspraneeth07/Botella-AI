"""The ladder — and the rule that it must always terminate.

    1. same state,  >= k  ->  level='state'
    2. same region, >= k  ->  level='region'
    3. national           ->  level='national'   (the floor)

The ladder terminating unconditionally is what lets the architecture claim
"one path". If the national level could fail, every downstream stage would
need a branch for the case where there is no prior — and that branch is
exactly the untested code path this whole design exists to eliminate.

TWO AXES, NOT ONE. The sheet describes geography. The data requires a second
axis, and without it the geography ladder cannot keep its own promise.

Measured on the estate:

    282,068 of 313,990 UPCs (89.8%) are carried by FEWER THAN 5 STORES.

For `sku_velocity` that means k=5 fails at the **national** rung for nine SKUs
in ten — and national is the top of the geography ladder, so there is nowhere
left to climb. The ladder would terminate in failure for the overwhelmingly
common case, which is the precise opposite of the guarantee.

The rescue is to widen the UNIT rather than the map:

    sku  ->  category  ->  all_products

and the category axis genuinely rescues it. Measured: beer spans 71 stores,
wine 67, vodka 57, tequila 56; 115 categories clear k=5 nationally, and those
categories cover the bulk of the catalogue.

So a rung is a PAIR — (geography, specificity) — and the ladder walks
geography first at each level of specificity, because a same-state category
prior is a better answer than a national SKU prior. The terminal rung is
`national × all_products`, which with 188 stores in the estate always clears k.

REGIONS. US Census divisions, and state codes are NORMALISED through
`app.signals.us_states.to_code` before mapping. That is not defensive
politeness: store 170:170 has `state="Texas"` spelled out, and a naive
two-letter lookup drops it straight to national for no reason. Three stores in
the estate have an unmappable state today (a blank HQ row, "Texas", and a
"DM"); they skip the region rung and land on national, which is exactly what
the floor is for.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from app.signals.us_states import to_code

GeoLevel = Literal["state", "region", "national"]
Specificity = Literal["sku", "category", "all_products"]

GEO_LEVELS: tuple[str, ...] = ("state", "region", "national")
SPECIFICITIES: tuple[str, ...] = ("sku", "category", "all_products")

#: US Census regions. Four buckets, standard, and explainable to an owner in
#: one word — which matters because sheet 15 renders the cohort level.
REGIONS: dict[str, tuple[str, ...]] = {
    "northeast": ("CT", "ME", "MA", "NH", "RI", "VT", "NJ", "NY", "PA"),
    "midwest": ("IL", "IN", "MI", "OH", "WI", "IA", "KS", "MN", "MO", "NE",
                "ND", "SD"),
    "south": ("DE", "FL", "GA", "MD", "NC", "SC", "VA", "DC", "WV", "AL", "KY",
              "MS", "TN", "AR", "LA", "OK", "TX"),
    "west": ("AZ", "CO", "ID", "MT", "NV", "NM", "UT", "WY", "AK", "CA", "HI",
             "OR", "WA"),
}

_REGION_BY_STATE: dict[str, str] = {
    state: region for region, states in REGIONS.items() for state in states
}


def region_for(state: str | None) -> str | None:
    """US Census region for a state, or None when it cannot be placed.

    Normalises through `to_code` first, so "Texas", "texas" and "TX" all map
    to the south. Store 170:170 stores its state as the full word and would
    otherwise be silently demoted to the national rung.
    """
    code = to_code(state)
    return _REGION_BY_STATE.get(code) if code else None


@dataclass(frozen=True, slots=True)
class Rung:
    """One step: a geography and a unit of analysis."""

    geo_level: GeoLevel
    specificity: Specificity

    @property
    def label(self) -> str:
        return f"{self.geo_level}/{self.specificity}"

    @property
    def is_terminal(self) -> bool:
        """The floor. Reaching this and failing k is the only case in which a
        prior is not drawn from real peers at all."""
        return self.geo_level == "national" and self.specificity == "all_products"


#: Which unit each pattern starts at. A day-of-week shape is a property of the
#: STORE, not of a SKU, so it starts (and stays) at all_products; asking for a
#: per-SKU Tuesday effect would shred the cohort for no gain.
PATTERN_START: dict[str, Specificity] = {
    # Sheet 09 estimates beta per (store, CATEGORY), so the ladder starts at
    # the category rung. Starting at sku would ask for a per-SKU elasticity,
    # which needs more price variation than any single SKU has.
    "elasticity": "category",
    "day_of_week": "all_products",
    "weekly_trend": "all_products",
    "monthly_seasonality": "all_products",
    "sku_velocity": "sku",
    "category_share": "category",
}

PATTERNS: tuple[str, ...] = tuple(PATTERN_START)


def rungs_for(pattern: str, *, has_region: bool = True) -> tuple[Rung, ...]:
    """The ordered ladder for a pattern. Always ends at the terminal rung.

    Geography is walked FIRST at each specificity: a same-state category prior
    beats a national SKU prior, because stores in one state share tax,
    licensing and weather, and those move demand more than a barcode does.

    `has_region=False` (an unmappable state) simply omits the region rungs —
    the ladder still terminates, which is the whole point.
    """
    if pattern not in PATTERN_START:
        raise ValueError(f"unknown pattern {pattern!r}; expected one of {PATTERNS}")

    start = PATTERN_START[pattern]
    widening = SPECIFICITIES[SPECIFICITIES.index(start):]
    geos: tuple[str, ...] = (
        GEO_LEVELS if has_region else ("state", "national")
    )

    rungs = [
        Rung(geo, spec)  # type: ignore[arg-type]
        for spec in widening
        for geo in geos
    ]
    # Belt and braces: the guarantee is structural, not incidental.
    terminal = Rung("national", "all_products")
    if terminal not in rungs:
        rungs.append(terminal)
    return tuple(rungs)


def members_for(
    rung: Rung,
    subject_state: str | None,
    candidates: Sequence[tuple[tuple[int, int], str | None]],
) -> tuple[tuple[int, int], ...]:
    """Store keys belonging to this rung's geography.

    `candidates` is (store_key, state) pairs, supplied by the caller — a stage
    never fetches. The subject store is NOT excluded here: a prior for a store
    with history legitimately includes it, and `estimate_prior` drops it when
    the point is specifically to borrow from others.
    """
    if rung.geo_level == "national":
        return tuple(sorted(key for key, _ in candidates))
    if rung.geo_level == "state":
        code = to_code(subject_state)
        if not code:
            return ()
        return tuple(sorted(key for key, st in candidates if to_code(st) == code))
    region = region_for(subject_state)
    if not region:
        return ()
    return tuple(sorted(key for key, st in candidates if region_for(st) == region))


__all__ = [
    "GEO_LEVELS",
    "PATTERNS",
    "PATTERN_START",
    "REGIONS",
    "SPECIFICITIES",
    "GeoLevel",
    "Rung",
    "Specificity",
    "members_for",
    "region_for",
    "rungs_for",
]
