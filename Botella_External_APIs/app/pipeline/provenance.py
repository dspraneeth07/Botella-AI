"""Provenance — how a stage decided, travelling WITH what it decided.

The dead-stock tile said 454 and chat said 485 because each went to the data
separately, applied its own rule, and returned a bare number. A bare number
cannot be argued with: you cannot tell whether it rests on eleven observations
from this store or on a national cohort average, which thresholds shaped it, or
which features it even read.

Provenance is the fix, and the important word is WITH. It is not a log line
emitted next to the value — logs get sampled, truncated, rotated and detached
from the number they explain. It is a field on the result, persisted in the
same audit row, so a figure and its justification cannot be separated.

Two of its fields fill themselves. ``config_keys`` is populated by
``registry.ConfigRegistry.get`` and ``inputs`` by ``record_input``, both via a
recording scope the ``@stage`` decorator opens. A developer who forgets to
declare a threshold they read does not get a quietly incomplete provenance —
the read is recorded whether they remember or not.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, Literal, get_args

# How much evidence stands behind a judgement. The boundaries between these
# are thresholds, and thresholds belong in the registry — sheet 00 defines the
# vocabulary only, so that every stage written against it uses the same words
# before anyone argues about where the lines fall.
EvidenceState = Literal["NEW", "EMERGING", "ESTABLISHED", "MATURE"]
EVIDENCE_STATES: tuple[str, ...] = get_args(EvidenceState)

# Whose behaviour the judgement is actually based on. A figure backed by
# "national" is a very different claim from one backed by "store", and the
# reader of a recommendation is entitled to know which they are being given.
CohortLevel = Literal["store", "state", "region", "national"]
COHORT_LEVELS: tuple[str, ...] = get_args(CohortLevel)


@dataclass(frozen=True, slots=True, kw_only=True)
class Provenance:
    """The evidence behind one stage's value.

    Keyword-only on purpose: seven fields, several of them numbers, is exactly
    the shape where positional construction silently transposes two arguments
    and nothing ever notices.
    """

    own_observations: int
    """n — how many observations came from THIS store."""

    cohort_level: CohortLevel | None = None
    """Which peer group was borrowed from, if any. None = own data only."""

    cohort_size: int | None = None
    """How many members that cohort had."""

    own_weight: float
    """0.0 .. 1.0 — how much of the answer is this store rather than the
    cohort. 1.0 is a pure own-data judgement; 0.0 is a pure cohort prior."""

    evidence_state: EvidenceState
    """NEW | EMERGING | ESTABLISHED | MATURE."""

    inputs: tuple[str, ...] = ()
    """Feature keys actually read. Fills itself via record_input()."""

    config_keys: tuple[str, ...] = ()
    """Thresholds actually applied. Fills itself via ConfigRegistry.get()."""

    calibration_version: str | None = None
    """Which calibration curve shaped this number (sheet 08).

    None means no calibration was applied - either the stage produces no
    confidence, or no fit existed and the identity transform was used. It is
    NOT a failure state.

    This is on Provenance rather than beside the value on purpose. A card
    shown to an owner six months ago was ranked by a curve fitted from the
    outcomes available at the time; without the version recorded, that card
    cannot be explained later, and a calibration that cannot be audited is
    just a second unexplained number on top of the first."""

    def __post_init__(self) -> None:
        if not isinstance(self.own_observations, int) or isinstance(self.own_observations, bool):
            raise TypeError("Provenance.own_observations must be an int")
        if self.own_observations < 0:
            raise ValueError("Provenance.own_observations cannot be negative")

        if not isinstance(self.own_weight, (int, float)) or isinstance(self.own_weight, bool):
            raise TypeError("Provenance.own_weight must be a number")
        if not 0.0 <= float(self.own_weight) <= 1.0:
            raise ValueError(
                f"Provenance.own_weight must be within 0.0..1.0, got {self.own_weight}"
            )
        object.__setattr__(self, "own_weight", float(self.own_weight))

        if self.evidence_state not in EVIDENCE_STATES:
            raise ValueError(
                f"Provenance.evidence_state must be one of {EVIDENCE_STATES}, "
                f"got {self.evidence_state!r}"
            )
        if self.cohort_level is not None and self.cohort_level not in COHORT_LEVELS:
            raise ValueError(
                f"Provenance.cohort_level must be one of {COHORT_LEVELS} or None, "
                f"got {self.cohort_level!r}"
            )
        if self.cohort_size is not None:
            if not isinstance(self.cohort_size, int) or isinstance(self.cohort_size, bool):
                raise TypeError("Provenance.cohort_size must be an int or None")
            if self.cohort_size < 0:
                raise ValueError("Provenance.cohort_size cannot be negative")
            if self.cohort_level is None:
                # A size without a level says "borrowed from 240 of something".
                raise ValueError(
                    "Provenance.cohort_size was given without a cohort_level — "
                    "a cohort size is meaningless without saying which cohort."
                )

        # Sorted and de-duplicated so two runs that read the same keys in a
        # different order produce byte-identical provenance. Replay compares
        # results for equality; incidental ordering would break it.
        object.__setattr__(self, "inputs", _normalize(self.inputs))
        object.__setattr__(self, "config_keys", _normalize(self.config_keys))

    def to_dict(self) -> dict[str, Any]:
        return {
            "own_observations": self.own_observations,
            "cohort_level": self.cohort_level,
            "cohort_size": self.cohort_size,
            "own_weight": self.own_weight,
            "evidence_state": self.evidence_state,
            "inputs": list(self.inputs),
            "config_keys": list(self.config_keys),
            "calibration_version": self.calibration_version,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Provenance:
        return cls(
            own_observations=int(data["own_observations"]),
            cohort_level=data.get("cohort_level"),
            cohort_size=(None if data.get("cohort_size") is None else int(data["cohort_size"])),
            own_weight=float(data["own_weight"]),
            evidence_state=data["evidence_state"],
            inputs=tuple(data.get("inputs") or ()),
            config_keys=tuple(data.get("config_keys") or ()),
            calibration_version=data.get("calibration_version"),
        )

    @classmethod
    def unknown(cls) -> Provenance:
        """Provenance for a stage that crashed before it could state any.

        Deliberately the most pessimistic reading — no observations, no
        weight, NEW — so a result built from a failure can never be mistaken
        for a well-evidenced one.
        """
        return cls(own_observations=0, own_weight=0.0, evidence_state="NEW")


def _normalize(keys: Iterable[str]) -> tuple[str, ...]:
    return tuple(sorted({str(k) for k in keys}))


# ── Recording scope ──────────────────────────────────────────────────────────
# A ContextVar, not a global: stages run concurrently across stores in a bulk
# fan-out, and asyncio tasks inherit context, so each stage's reads are
# attributed to that stage even with thirty in flight.


@dataclass(slots=True)
class StageRecorder:
    """Collects what a stage touched while it runs."""

    config_keys: set[str] = field(default_factory=set)
    inputs: set[str] = field(default_factory=set)

    def record_config(self, name: str) -> None:
        self.config_keys.add(str(name))

    def record_input(self, key: str) -> None:
        self.inputs.add(str(key))

    def merge_into(self, provenance: Provenance) -> Provenance:
        """Union what was recorded with what the stage declared.

        Union rather than overwrite: a stage may legitimately name an input it
        read through a path the recorder cannot see, and dropping that would
        make the provenance less true, not more.
        """
        if not self.config_keys and not self.inputs:
            return provenance
        from dataclasses import replace

        return replace(
            provenance,
            inputs=_normalize(set(provenance.inputs) | self.inputs),
            config_keys=_normalize(set(provenance.config_keys) | self.config_keys),
        )


_recording: ContextVar[StageRecorder | None] = ContextVar("pipeline_recording", default=None)


def current_recorder() -> StageRecorder | None:
    """The recorder for the stage running in this task, if any.

    None outside a stage — reading config at import time or from a script is
    legitimate and must not raise.
    """
    return _recording.get()


@contextmanager
def recording() -> Iterator[StageRecorder]:
    """Open a recording scope. Used by @stage; useful directly in tests."""
    recorder = StageRecorder()
    token = _recording.set(recorder)
    try:
        yield recorder
    finally:
        _recording.reset(token)


def record_input(key: str) -> None:
    """Declare that the running stage read feature ``key``.

    A no-op outside a stage, so feature accessors can call it unconditionally
    without knowing whether they are inside the pipeline.
    """
    recorder = _recording.get()
    if recorder is not None:
        recorder.record_input(key)


def record_inputs(*keys: str) -> None:
    for key in keys:
        record_input(key)


__all__ = [
    "COHORT_LEVELS",
    "EVIDENCE_STATES",
    "CohortLevel",
    "EvidenceState",
    "Provenance",
    "StageRecorder",
    "current_recorder",
    "record_input",
    "record_inputs",
    "recording",
]
