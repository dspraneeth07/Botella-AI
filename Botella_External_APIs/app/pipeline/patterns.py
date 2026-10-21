"""The ONE pattern vocabulary, and the translation between the two spellings.

THE DEFECT THIS EXISTS TO CLOSE
    Sheet 04 named two of the five patterns differently from sheets 05 and 06:

        evidence      day_of_week  weekly_trend  monthly              sku_velocity  category
        priors/blend  day_of_week  weekly_trend  monthly_seasonality  sku_velocity  category_share

    Each module was internally consistent and fully tested, so nothing caught
    it. It only surfaced on the first attempt to run 04 -> 05 -> 06 as one
    pipeline, which is the point of assembling them: a contract between two
    modules is not tested by testing each module.

    Left alone it would not have raised - `k_for_pattern("monthly")` throws, so
    the failure would at least have been loud. But `count_evidence` for
    `category` and `estimate_prior` for `category_share` describe the SAME
    quantity, and any code that reconciled them by hand would have had a second
    place to get it wrong.

WHY NOT JUST RENAME
    `category` is already taken twice over in this codebase: it is a
    SPECIFICITY rung on the prior ladder (sku -> category -> all_products) and
    a field on every product. Renaming the evidence pattern to `category_share`
    across 48 sites would have put three meanings of one word within a few
    lines of each other. The canonical name is the priors/blend spelling; the
    evidence spelling is an alias, translated exactly once, here.

WHY THIS CANNOT DRIFT AGAIN
    `test_the_three_sheets_agree_on_the_pattern_vocabulary` asserts the map is
    a bijection over both tuples. Adding a sixth pattern to one sheet and not
    the others fails the build.
"""

from __future__ import annotations

#: The canonical five. The spelling sheets 05 and 06 use.
CANONICAL: tuple[str, ...] = (
    "day_of_week",
    "weekly_trend",
    "monthly_seasonality",
    "sku_velocity",
    "category_share",
    # Sheet 09. A genuine sixth pattern rather than a special case: beta is a
    # per-store quantity estimated from own data and shrunk toward a cohort,
    # which is exactly what the other five are.
    "elasticity",
)

#: evidence spelling -> canonical spelling. Only the two that differ.
_EVIDENCE_TO_CANONICAL: dict[str, str] = {
    "monthly": "monthly_seasonality",
    "category": "category_share",
}

_CANONICAL_TO_EVIDENCE: dict[str, str] = {
    v: k for k, v in _EVIDENCE_TO_CANONICAL.items()
}


def canonical(pattern: str) -> str:
    """The priors/blend spelling of a pattern, whichever spelling came in.

    Idempotent: a canonical name in gives itself back, so a caller need not
    track which side of the boundary it is on.
    """
    if pattern in CANONICAL:
        return pattern
    resolved = _EVIDENCE_TO_CANONICAL.get(pattern)
    if resolved is None:
        raise ValueError(
            f"unknown pattern {pattern!r}; expected one of {CANONICAL} "
            f"or an evidence alias {tuple(_EVIDENCE_TO_CANONICAL)}"
        )
    return resolved


def for_evidence(pattern: str) -> str:
    """The sheet-04 spelling, for calling `count_evidence`. Idempotent."""
    if pattern in _EVIDENCE_TO_CANONICAL:
        return pattern
    return _CANONICAL_TO_EVIDENCE.get(pattern, pattern)


__all__ = ["CANONICAL", "canonical", "for_evidence"]
