"""StageResult, the @stage decorator, and replay.

A stage receives everything it may use and returns everything it decided,
including how it decided. That is the entire contract, and these three pieces
are what make it hold:

``StageResult``  the envelope. Carries the value, whether the stage reached
                 one, why, and the provenance behind it — together, in one
                 object that serialises to one audit row.

``@stage``       times the call, opens the recording scope that fills
                 provenance, turns an escaped exception into ok=False, and
                 refuses to let an unprovenanced result out.

``replay``       re-executes a recorded stage against the context pinned on
                 its audit row and proves the output is identical.

ok=False is a LEGITIMATE OUTCOME, not an error. "Not enough evidence to say
anything about this SKU" is a real answer and belongs in the same shape as a
real value, carrying reasons. Raising for it would push the decision into
exception handling, where it stops being data and starts being control flow.
"""

from __future__ import annotations

import functools
import hashlib
import inspect
import json
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from typing import Any, Generic, TypeVar

from app.pipeline.context import RunContext
from app.pipeline.provenance import Provenance, recording

T = TypeVar("T")

AUDIT_SCHEMA = "stage_result/1"

# What stage/stage_version hold before @stage stamps them. A result carrying
# these has not been through a stage and must not reach an audit row.
UNSTAMPED = ""


class PipelineError(Exception):
    """Base for contract violations in the pipeline scaffolding."""


class ProvenanceError(PipelineError):
    """A stage returned a result without usable provenance.

    A programmer error, not a data outcome — so it raises rather than
    degrading to ok=False. A result with no provenance is exactly the bare
    number this whole package exists to abolish, and letting it through
    quietly would be worse than failing the run.
    """


class ReplayMismatch(PipelineError):
    """A replayed stage did not reproduce its recorded output."""


@dataclass(frozen=True)
class StageResult(Generic[T]):
    """One stage's answer, with its justification attached."""

    ok: bool
    value: T | None
    reasons: tuple[str, ...]
    provenance: Provenance
    stage: str = UNSTAMPED
    stage_version: str = UNSTAMPED
    duration_ms: int = 0

    # ── construction ─────────────────────────────────────────────────────
    # Stages build results with these and leave stage/version/duration blank;
    # @stage stamps them. A stage does not know its own name, and should not
    # have to repeat it on every return path.

    @classmethod
    def success(
        cls, value: T, provenance: Provenance, *, reasons: tuple[str, ...] | list[str] = ()
    ) -> StageResult[T]:
        return cls(ok=True, value=value, reasons=tuple(reasons), provenance=provenance)

    @classmethod
    def failure(
        cls, *reasons: str, provenance: Provenance | None = None
    ) -> StageResult[T]:
        """A legitimate "no answer", with at least one reason.

        The reason is mandatory. A bare ok=False is as unhelpful as a bare
        number: it tells a reader something did not happen without telling
        them what to do about it.
        """
        if not reasons:
            raise ValueError("StageResult.failure() requires at least one reason")
        return cls(
            ok=False,
            value=None,
            reasons=tuple(reasons),
            provenance=provenance if provenance is not None else Provenance.unknown(),
        )

    @property
    def stamped(self) -> bool:
        return self.stage != UNSTAMPED and self.stage_version != UNSTAMPED

    # ── audit ────────────────────────────────────────────────────────────

    def to_audit_row(
        self, ctx: RunContext, *, stage_input: Any = None, include_input_digest: bool = True
    ) -> dict[str, Any]:
        """The row that gets persisted, and that ``replay`` reads back.

        Carries the pinned RunContext, because "replay from the snapshot and
        versions stamped on it" is impossible if the row only holds the
        output. A digest of the input is stamped too, so a replay fed the
        wrong input is caught instead of quietly disagreeing.
        """
        if not self.stamped:
            raise ProvenanceError(
                "Refusing to audit an unstamped StageResult — it has no stage "
                "name or version, so nothing could ever replay it. Build stage "
                "results inside a @stage function."
            )
        row: dict[str, Any] = {
            "schema": AUDIT_SCHEMA,
            "stage": self.stage,
            "stage_version": self.stage_version,
            "ok": self.ok,
            "value": self.value,
            "reasons": list(self.reasons),
            "duration_ms": self.duration_ms,
            "provenance": self.provenance.to_dict(),
            "context": ctx.to_dict(),
        }
        if include_input_digest:
            row["input_digest"] = digest(stage_input)
        return row

    @classmethod
    def from_audit_row(cls, row: Mapping[str, Any]) -> StageResult[Any]:
        schema = row.get("schema")
        if schema != AUDIT_SCHEMA:
            raise ValueError(
                f"Unsupported audit row schema {schema!r} (expected {AUDIT_SCHEMA!r})"
            )
        return cls(
            ok=bool(row["ok"]),
            value=row.get("value"),
            reasons=tuple(row.get("reasons") or ()),
            provenance=Provenance.from_dict(row["provenance"]),
            stage=row["stage"],
            stage_version=row["stage_version"],
            duration_ms=int(row.get("duration_ms", 0)),
        )

    def same_decision_as(self, other: StageResult[Any]) -> bool:
        """Equality for replay purposes — everything EXCEPT duration_ms.

        Wall-clock duration differs between two runs of identical code by
        definition. Including it would make every replay fail and the check
        worthless.
        """
        return (
            self.ok == other.ok
            and self.value == other.value
            and self.reasons == other.reasons
            and self.provenance == other.provenance
            and self.stage == other.stage
            and self.stage_version == other.stage_version
        )


def digest(value: Any) -> str:
    """Stable sha256 over a JSON-able value. Key order never matters."""
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


StageFn = Callable[..., "StageResult[T]"]


def stage(name: str, version: str) -> Callable[[StageFn], StageFn]:
    """Mark a pure ``(value, ctx) -> StageResult`` function as a pipeline stage.

    Does four things the stage should not have to:

    1. Times it, in whole milliseconds.
    2. Opens the recording scope, then merges everything the stage read
       (config keys, feature keys) into the provenance it returned.
    3. Converts an escaped exception into ``ok=False`` with the exception as a
       reason — one bad stage degrades its own output, it does not sink the run.
    4. Refuses an unprovenanced result.

    Synchronous only, and that is enforced. A stage that needs to await
    something is a stage that is talking to the network or the database, which
    is precisely what RunContext exists to prevent.
    """

    def decorate(fn: Callable[..., StageResult[T]]) -> Callable[..., StageResult[T]]:
        if inspect.iscoroutinefunction(fn):
            raise TypeError(
                f"@stage cannot wrap the async function {fn.__qualname__!r}. Stages are "
                "pure functions of (value, ctx); anything awaitable means I/O, and I/O "
                "results belong in RunContext or in the stage's input."
            )

        @functools.wraps(fn)
        def wrapper(value: Any, ctx: RunContext, *args: Any, **kwargs: Any) -> StageResult[T]:
            if not isinstance(ctx, RunContext):
                raise TypeError(
                    f"stage {name!r} was called without a RunContext "
                    f"(got {type(ctx).__name__} as the second argument)"
                )
            started = time.perf_counter_ns()
            with recording() as recorder:
                try:
                    result = fn(value, ctx, *args, **kwargs)
                except Exception as exc:  # noqa: BLE001 — degrade, never propagate
                    result = StageResult.failure(
                        f"exception:{type(exc).__name__}: {exc}",
                        provenance=recorder.merge_into(Provenance.unknown()),
                    )
                else:
                    # Outside the except on purpose: a contract violation must
                    # raise, not be swallowed into the failure path it is
                    # meant to police.
                    _require_provenance(name, result)
                    result = replace(result, provenance=recorder.merge_into(result.provenance))

            duration_ms = max(0, (time.perf_counter_ns() - started) // 1_000_000)
            return replace(
                result, stage=name, stage_version=version, duration_ms=int(duration_ms)
            )

        wrapper.stage_name = name  # type: ignore[attr-defined]
        wrapper.stage_version = version  # type: ignore[attr-defined]
        wrapper.undecorated = fn  # type: ignore[attr-defined]
        return wrapper

    return decorate


def _require_provenance(name: str, result: Any) -> None:
    if not isinstance(result, StageResult):
        raise ProvenanceError(
            f"stage {name!r} returned {type(result).__name__}, not a StageResult. "
            "Return StageResult.success(value, provenance) or StageResult.failure(reason)."
        )
    if not isinstance(result.provenance, Provenance):
        raise ProvenanceError(
            f"stage {name!r} returned a result whose provenance is "
            f"{type(result.provenance).__name__}. Every value must say how it was decided."
        )


def replay(
    audit_row: Mapping[str, Any],
    stage_fn: Callable[..., StageResult[Any]] | None = None,
    stage_input: Any = None,
) -> StageResult[Any]:
    """Rebuild — and optionally re-prove — a past stage output.

    With no ``stage_fn`` this deserialises the recorded result, which is what
    you want when reading history.

    With a ``stage_fn`` it does the real thing: reconstructs the RunContext
    pinned on the row, re-executes the stage against it, and raises
    ReplayMismatch unless the output is identical (duration excepted). Three
    ways it refuses to give a false pass:

    * the stage_version on the row must match the code being replayed — old
      row, new code is a mismatch to report, not to paper over;
    * the input digest on the row must match the input supplied;
    * the results must agree on value, reasons AND provenance.
    """
    recorded = StageResult.from_audit_row(audit_row)
    if stage_fn is None:
        return recorded

    ctx = RunContext.from_dict(audit_row["context"])

    code_version = getattr(stage_fn, "stage_version", None)
    if code_version is not None and code_version != recorded.stage_version:
        raise ReplayMismatch(
            f"stage {recorded.stage!r} was recorded at version "
            f"{recorded.stage_version!r} but the code is at {code_version!r}. "
            "Replay the pinned version, or accept that the output legitimately changed."
        )

    recorded_digest = audit_row.get("input_digest")
    if recorded_digest is not None:
        supplied = digest(stage_input)
        if supplied != recorded_digest:
            raise ReplayMismatch(
                f"input does not match the recorded run for stage {recorded.stage!r} "
                f"(recorded {recorded_digest[:12]}…, supplied {supplied[:12]}…)"
            )

    fresh = stage_fn(stage_input, ctx)
    if not fresh.same_decision_as(recorded):
        raise ReplayMismatch(
            f"stage {recorded.stage!r} did not reproduce its recorded output.\n"
            f"  recorded: {recorded}\n"
            f"  replayed: {fresh}"
        )
    return fresh


__all__ = [
    "AUDIT_SCHEMA",
    "PipelineError",
    "ProvenanceError",
    "ReplayMismatch",
    "StageResult",
    "digest",
    "replay",
    "stage",
]
