"""The sentence written without a model. Same numbers, plainer prose.

WHY THIS EXISTS
    A missing explanation must never mean a missing recommendation.

    The decision was computed, constrained and validated before the model was
    called. If the model is slow, rate-limited, or returns something unusable,
    none of that work stops being true - and withholding the card would punish
    the store for an outage in the one part of the system that contributes no
    arithmetic.

    So the fallback is not an apology and not a blank. It is the same card,
    carrying the identical figures, written by this module.

WHY IT IS NOT "JUST THE FALLBACK"
    It is also the floor the model has to beat, and the reason the model's
    output can be rejected freely. A checker that has nothing to fall back on
    will always be under pressure to accept a marginal sentence. This one can
    reject anything and lose only fluency.

    Tested at parity: `test_a_model_timeout_still_produces_a_card` asserts the
    degraded card carries every figure the model card would have.
"""

from __future__ import annotations

from typing import Any


def _n(value: float) -> str:
    """The same display form the prompt shows the model. One rounding rule."""
    if value == int(value):
        return str(int(value))
    return f"{value:.1f}"


def _reorder(record: Any) -> str:
    figures = record.figures()
    quantity = _n(figures["quantity"])
    parts = [f"Order {quantity} of {record.sku}"]

    if record.order_by_date is not None:
        parts.append(f" by {record.order_by_date.isoformat()}")

    # The coverage window when stage 14 recorded one - it is the honest
    # statement of what the order is for, and the figure sheet 14 went to
    # some trouble to get right.
    if record.coverage_days:
        parts.append(
            f": you have {_n(figures['on_hand'])} on hand and expect to sell "
            f"{_n(figures['coverage_demand'])} in the next "
            f"{_n(figures['coverage_days'])} days"
        )
    else:
        parts.append(
            f": you have {_n(figures['on_hand'])} on hand against demand of "
            f"{_n(figures['demand_p50'])}"
        )
    return "".join(parts) + "."


def _clear(record: Any) -> str:
    figures = record.figures()
    sentence = f"Clear {_n(figures['quantity'])} of {record.sku}"
    if "stated_risk" in figures:
        sentence += f", freeing {_n(figures['stated_risk'])} in tied-up capital"
    return sentence + "."


def _markdown(record: Any) -> str:
    figures = record.figures()
    sentence = f"Mark down {_n(figures['quantity'])} of {record.sku}"
    if "stated_risk" in figures:
        sentence += f" to recover {_n(figures['stated_risk'])}"
    return sentence + "."


def _generic(record: Any) -> str:
    """Any family without bespoke wording.

    Reached by RANGE and SUBSTITUTE today. Deliberately dull rather than
    absent: a plain true sentence beats a blank card, and beats a clever one
    written by a function that does not know what the family means.
    """
    figures = record.figures()
    return (f"{record.family.replace('_', ' ').capitalize()}: "
            f"{_n(figures['quantity'])} of {record.sku}.")


_WRITERS = {
    "reorder": _reorder,
    "clear": _clear,
    "markdown": _markdown,
}


def template_sentence(record: Any) -> str:
    """The deterministic sentence for a validated decision.

    Never raises for an unknown family - it falls through to `_generic`.
    Raising here would convert a model outage into a lost card, which is the
    exact failure this module exists to prevent.
    """
    return _WRITERS.get(record.family, _generic)(record)


__all__ = ["template_sentence"]
