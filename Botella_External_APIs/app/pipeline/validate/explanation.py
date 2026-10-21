"""Sheet 16 — does the SENTENCE match the decision? Mechanical, never semantic.

THE OTHER HALF OF THE SPLIT
    Sheet 14 asks whether the DECISION is correct, before a token is spent, and
    a failure PAGES because an upstream stage produced something impossible.

    This asks whether the SENTENCE matches a decision already known to be
    correct. It never re-checks the decision. A failure here is a prompt or
    model regression - a working-hours problem - so it LOGS AND COUNTS and
    never pages.

    Under the previous single validator both kinds produced the same dropped
    card and the same log line, so neither was ever investigated. Keeping the
    alerting distinct is the point of having two sheets.

WHY MECHANICAL IS WHAT MAKES IT RELIABLE
    This does not judge whether a sentence is GOOD. Four things that are all
    decidable:

      1. every numeral in the text appears in the stage-14 record
      2. every SKU referenced exists for THIS store, by exact key
      3. the provenance clause is present when own_weight < 1
      4. no claim without the field that backs it

    A semantic check would have opinions, and opinions cannot be regression
    tested. These four can be, and a rising failure rate is then a signal
    rather than a mood.

WHY IT MATTERS AT A LOW RATE
    The backtest found TWO invented SKUs out of roughly 480 referenced. That
    is 0.4%, and it is fatal: a single fabricated product destroys an owner's
    trust in every other card on the screen. There is no rate of invention low
    enough to be acceptable, which is why the check is a set membership test
    rather than a confidence score.

ON FAILURE: DROP THE PROSE, KEEP THE DECISION
    The decision was computed, constrained and validated long before the model
    wrote anything. A bad sentence is a reason to use a different sentence,
    never a reason to withhold a correct recommendation.

    The stage does the substitution ITSELF - a failed verdict already carries
    sheet 15's template text in `.text`, so a caller cannot forget to fall
    back. Returning only a verdict and trusting every call site to handle it
    is how a card ships with no sentence at all.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from app.pipeline.context import RunContext
from app.pipeline.envelope import StageResult, stage
from app.pipeline.explain.render import (
    DISPLAY_ROUNDING_TOLERANCE,
    numerals_in,
)
from app.pipeline.explain.template import template_sentence
from app.pipeline.provenance import Provenance
from app.pipeline.registry import ConfigRegistry, cfg
from app.pipeline.validate.decision import Severity


class ExplanationCheck(StrEnum):
    """The four checks, named so a failure says which one caught it."""

    NUMERALS = "numerals"
    IDENTITY = "identity"
    PROVENANCE = "provenance"
    CLAIMS = "claims"


@dataclass(frozen=True, slots=True)
class ExplanationFailure:
    """One failed check. Severity is LOG, always - see the module docstring."""

    check: ExplanationCheck
    reason: str
    severity: Severity = Severity.LOG

    def as_dict(self) -> dict[str, Any]:
        return {"check": self.check.value, "reason": self.reason,
                "severity": self.severity.value}


@dataclass(frozen=True, slots=True)
class StoreCatalogue:
    """What THIS store actually carries. Supplied, never fetched.

    Keyed on (client_id, location_id) and checked by EXACT SKU MATCH, never by
    name. A name lookup is how a card ends up describing a product the store
    does not stock: two stores can carry different products with similar
    names, and "close enough" is exactly the judgement that produced the two
    invented SKUs in the backtest.
    """

    client_id: int
    location_id: int
    skus: frozenset[str] = frozenset()
    #: Product names this store carries, lowercased. Used to catch a card that
    #: names a DIFFERENT product than the one it decided about - see
    #: `_check_identity` for what this can and cannot detect.
    product_names: frozenset[str] = frozenset()

    def carries(self, sku: str) -> bool:
        return sku in self.skus


#: A token that looks like a SKU: a long run of digits, or digits mixed with
#: letters. Deliberately narrow. A short number is a QUANTITY and belongs to
#: the numeral check; treating "116" as a possible SKU would make every card
#: fail identity, which is the false-positive rate that gets a checker
#: switched off.
_SKU_TOKEN = re.compile(r"\b(?=[A-Za-z]*\d)[A-Za-z0-9_-]{6,}\b")

#: Removed before scanning, so a deadline is not read as a SKU or a figure.
_ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


@dataclass(frozen=True, slots=True)
class ClaimPattern:
    """A phrase that asserts something, and the field that has to back it.

    EXPLICIT, AND A LIST RATHER THAN A HEURISTIC.
        Every entry is a claim a card has actually made or could plausibly
        make, paired with the field that would make it true. A card may say
        "customers are switching to X" only if the candidate carries
        substitution evidence; with no backing field there is no claim.

        Kept as data so the list can be read, argued with and extended without
        touching the checker - and so a new claim type is a one-line addition
        rather than a new branch.
    """

    name: str
    #: Matched case-insensitively against the sentence.
    pattern: re.Pattern[str]
    #: The evidence key that must be present AND truthy.
    requires: str
    #: Shown in the failure so whoever reads the log knows what was missing.
    explain: str


def _claim(name: str, regex: str, requires: str, explain: str) -> ClaimPattern:
    return ClaimPattern(name, re.compile(regex, re.IGNORECASE), requires, explain)


#: The claim vocabulary. Each needs a field on the candidate to be sayable.
CLAIM_PATTERNS: tuple[ClaimPattern, ...] = (
    _claim("substitution",
           r"\b(switching to|switched to|moving to|substitut\w*|instead of)\b",
           "substitution_evidence",
           "a substitution claim needs measured substitution evidence on the "
           "candidate - without it the card is asserting a customer behaviour "
           "nobody observed"),
    _claim("price_effect",
           r"\b(price cut|discount\w*|markdown will|lower(ing)? the price|"
           r"elastic\w*|price sensitiv\w*)\b",
           "elasticity",
           "a price-effect claim needs sheet 09's elasticity, whose interval "
           "must lie beyond -1. 98.5% of cells cannot support one"),
    _claim("trend",
           r"\b(trending|picking up|on the rise|growing demand|taking off)\b",
           "trend_evidence",
           "a trend claim needs a measured trend, not a forecast level - a "
           "high number is not a rising one"),
    _claim("peer_comparison",
           r"\b(similar stores|stores like yours|peers?|other stores|"
           r"nearby stores)\b",
           "cohort_size",
           "a peer comparison needs a cohort that actually answered, and its "
           "size, or the card is citing stores it cannot count"),
    _claim("margin",
           r"\b(margin|profit|markup)\b",
           "unit_margin",
           "a margin claim needs cost. 31 stores send 0.00% cost and a margin "
           "built on a zero cost is an imaginary 100%"),
    _claim("stockout",
           r"\b(run out|stock ?out|sell out|selling out|empty shelf)\b",
           "demand_p90",
           "a stockout claim needs the upper demand bound, not the midpoint - "
           "running out is a tail event"),
)


def _normalised(numeral: str) -> float:
    """$1,924.80 / 1,924.80 / 1924.8 all become 1924.8.

    The currency symbol never enters the match (the pattern starts at the
    digit) and the thousands separator is stripped here, so three spellings of
    one figure compare equal - which is the whole requirement, because a model
    that formats a number for a human has not changed it.
    """
    return float(numeral.replace(",", ""))


def _check_numerals(
    text: str,
    allowed: Mapping[str, float],
    literals: Sequence[str],
    tolerance: float,
) -> list[ExplanationFailure]:
    """Every number in the text must appear in the record.

    Rounded, summed or invented all fail identically, and that is deliberate:
    the prompt forbids computing, so any figure that is not in the record
    arrived by a route the card cannot justify.
    """
    scannable = _ISO_DATE.sub(" ", text)
    for literal in sorted(literals, key=len, reverse=True):
        scannable = scannable.replace(literal, " ")

    values = list(allowed.values())
    unaccounted = [
        numeral for numeral in numerals_in(scannable)
        if not any(abs(_normalised(numeral) - value) <= tolerance
                   for value in values)
    ]
    if not unaccounted:
        return []
    return [ExplanationFailure(
        ExplanationCheck.NUMERALS,
        f"numerals not in the decision record: {unaccounted} "
        f"(allowed: {sorted(allowed)})",
    )]


def _check_identity(
    text: str, record: Any, catalogue: StoreCatalogue
) -> list[ExplanationFailure]:
    """Every SKU referenced must exist for THIS store, by exact key.

    WHAT THIS CATCHES, AND WHAT IT CANNOT.
        It catches an invented or foreign SKU - the failure the backtest
        actually found - because a SKU is a token with a checkable shape and
        an exact membership test.

        It also catches a card that NAMES a different product than the one it
        decided about, when that name is in the store's catalogue.

        It cannot catch a wholly invented product NAME with no SKU attached,
        because detecting "that phrase is a product name" in free prose is a
        semantic judgement, and this checker is mechanical on purpose. Sheet
        15 closes that route from the other end instead: the model is given
        one record and forbidden to introduce anything not in it, and
        retrieval cannot supply a name either, because retrieval passages are
        prose the model paraphrases rather than fields it quotes.
    """
    failures: list[ExplanationFailure] = []

    scannable = _ISO_DATE.sub(" ", text)
    for token in _SKU_TOKEN.findall(scannable):
        if token == record.sku:
            continue
        if not catalogue.carries(token):
            failures.append(ExplanationFailure(
                ExplanationCheck.IDENTITY,
                f"sku_not_carried_by_this_store:{token} "
                f"(store {catalogue.client_id}:{catalogue.location_id})",
            ))

    # The decision's own SKU must be in the catalogue too. If it is not, the
    # card is right and the CATALOGUE is wrong - which is worth saying rather
    # than passing silently, because every other check here trusts it.
    if not catalogue.carries(record.sku):
        failures.append(ExplanationFailure(
            ExplanationCheck.IDENTITY,
            f"decision_sku_missing_from_catalogue:{record.sku} - the card may "
            f"be correct and the supplied catalogue stale",
        ))

    lowered = text.lower()
    named = [name for name in catalogue.product_names if name and name in lowered]
    own_name = (getattr(record, "product_name", None) or "").lower()
    for name in named:
        if own_name and name in own_name:
            continue
        if not own_name:
            # No name on the record to compare against: naming any carried
            # product is not evidence of a fault.
            continue
        failures.append(ExplanationFailure(
            ExplanationCheck.IDENTITY,
            f"card names a different product than it decided about: {name!r}",
        ))
    return failures


def _check_provenance(
    provenance: Provenance, provenance_sentence: str
) -> list[ExplanationFailure]:
    """A partly-borrowed estimate must say so.

    `own_weight < 1` means some of this answer came from other stores. A card
    that does not disclose that reads as a measurement of THIS shop, which is
    the single most misleading thing a cold-start card can do.
    """
    if provenance.own_weight >= 1.0:
        return []
    if provenance_sentence.strip():
        return []
    return [ExplanationFailure(
        ExplanationCheck.PROVENANCE,
        f"own_weight={provenance.own_weight:.2f} but the card carries no "
        f"provenance sentence - it reads as measured when it is partly "
        f"borrowed",
    )]


def _check_claims(
    text: str, evidence: Mapping[str, Any]
) -> list[ExplanationFailure]:
    """No claim without the field that backs it."""
    failures: list[ExplanationFailure] = []
    for claim in CLAIM_PATTERNS:
        if not claim.pattern.search(text):
            continue
        backing = evidence.get(claim.requires)
        if backing is None or backing is False or backing == 0:
            failures.append(ExplanationFailure(
                ExplanationCheck.CLAIMS,
                f"unsupported_claim:{claim.name} needs "
                f"{claim.requires!r} - {claim.explain}",
            ))
    return failures


def claim_evidence(record: Any, provenance: Provenance,
                   candidate: Any = None) -> dict[str, Any]:
    """The fields a claim can be backed by, gathered in one place.

    Built from the validated record and its provenance rather than from the
    model's output, so a claim is checked against what the pipeline MEASURED
    and not against what the sentence asserts.
    """
    evidence: dict[str, Any] = {
        "unit_margin": record.unit_margin,
        "demand_p90": record.demand_p90,
        "cohort_size": provenance.cohort_size,
    }
    for key in ("substitution_evidence", "elasticity", "trend_evidence"):
        evidence[key] = getattr(candidate, key, None) if candidate else None
    return evidence


@dataclass(frozen=True, slots=True)
class ExplanationVerdict:
    """The verdict on one sentence, and the text that should actually ship."""

    ok: bool
    #: What the card should show: the model's sentence when it passed, sheet
    #: 15's template when it did not.
    text: str
    #: "model" | "template" - which one `text` is.
    source: str
    failures: tuple[ExplanationFailure, ...] = ()
    checks_run: tuple[str, ...] = ()

    @property
    def reasons(self) -> tuple[str, ...]:
        return tuple(f"{f.severity.value}:{f.check.value}:{f.reason}"
                     for f in self.failures)

    def as_dict(self) -> dict[str, Any]:
        return {"ok": self.ok, "text": self.text, "source": self.source,
                "failures": [f.as_dict() for f in self.failures],
                "checks_run": list(self.checks_run)}


@dataclass(frozen=True, slots=True)
class ExplanationCheckRequest:
    """One generated sentence, and everything needed to check it.

    NOT `explain.ExplanationRequest`, which is sheet 15's - that one asks for a
    sentence to be WRITTEN, this one asks for a sentence to be CHECKED. Two
    types with one name in the same package is how the wrong one gets imported
    on a Friday; the names are kept apart deliberately.

    Everything is SUPPLIED. This stage reads no database and calls no model -
    it is the cheapest stage in the pipeline and runs on every card.
    """

    text: str
    record: Any
    provenance: Provenance
    catalogue: StoreCatalogue
    #: The generated hedge, as sheet 15 produced it.
    provenance_sentence: str = ""
    #: Numerals the card may contain. Sheet 15's `Explanation.allowed_figures`
    #: - passed in rather than recomputed, so the prompt that was built and
    #: the check that runs cannot disagree about what was permitted.
    allowed_figures: Mapping[str, float] = field(default_factory=dict)
    allowed_literals: tuple[str, ...] = ()
    #: Fields a claim may be backed by. See `claim_evidence`.
    evidence: Mapping[str, Any] = field(default_factory=dict)


@stage("validate_explanation", "1.0.0")
def validate_explanation(
    request: ExplanationCheckRequest,
    ctx: RunContext,
    config: ConfigRegistry = cfg,
) -> StageResult[ExplanationVerdict]:
    """Four mechanical checks. Never pages; always returns a shippable card.

    `ok=True` on the StageResult even when the sentence failed - because the
    DECISION is fine and a card is going out either way. The verdict is in the
    value, not in the envelope. A failed envelope here would read to an
    operator exactly like a sheet-14 page, which is the conflation this pair
    of sheets exists to end.
    """
    tolerance = float(config.get(DISPLAY_ROUNDING_TOLERANCE, ctx))
    text = request.text

    failures: list[ExplanationFailure] = []
    failures += _check_numerals(text, request.allowed_figures,
                                request.allowed_literals, tolerance)
    failures += _check_identity(text, request.record, request.catalogue)
    failures += _check_provenance(request.provenance,
                                  request.provenance_sentence)
    failures += _check_claims(text, request.evidence)

    checks = tuple(c.value for c in ExplanationCheck)
    if failures:
        # DROP THE PROSE, KEEP THE DECISION.
        return StageResult.success(
            ExplanationVerdict(
                ok=False,
                text=template_sentence(request.record),
                source="template",
                failures=tuple(failures),
                checks_run=checks,
            ),
            request.provenance,
        )

    return StageResult.success(
        ExplanationVerdict(ok=True, text=text, source="model",
                          checks_run=checks),
        request.provenance,
    )


@dataclass
class ExplanationStats:
    """A running count, because the RATE is the signal.

    One failed sentence is a bad sentence. A failure rate that moves is a
    prompt or model regression, and it is only visible if somebody is
    counting - which is the difference between "log it" and "log and count
    it".
    """

    total: int = 0
    failed: int = 0
    by_check: dict[str, int] = field(default_factory=dict)

    def record(self, verdict: ExplanationVerdict) -> None:
        self.total += 1
        if verdict.ok:
            return
        self.failed += 1
        for failure in verdict.failures:
            key = failure.check.value
            self.by_check[key] = self.by_check.get(key, 0) + 1

    @property
    def failure_rate(self) -> float | None:
        """None, not 0.0, when nothing has been checked.

        "no cards failed" and "no cards were checked" are different facts and
        a zero would make an unrun check look like a clean one.
        """
        if not self.total:
            return None
        return self.failed / self.total

    def as_dict(self) -> dict[str, Any]:
        return {"total": self.total, "failed": self.failed,
                "failure_rate": self.failure_rate,
                "by_check": dict(sorted(self.by_check.items()))}


__all__ = [
    "CLAIM_PATTERNS",
    "ClaimPattern",
    "ExplanationCheck",
    "ExplanationFailure",
    "ExplanationCheckRequest",
    "ExplanationVerdict",
    "ExplanationStats",
    "StoreCatalogue",
    "claim_evidence",
    "validate_explanation",
]
