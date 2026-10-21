"""RunContext — everything a stage is allowed to know about the world.

A stage is a pure function of ``(value, ctx)``. Anything ambient it might
otherwise reach for — the date, the tenant, the config set, the random seed,
the identity of the data snapshot — arrives here instead. That is the whole
mechanism behind replay: given the same input and the same RunContext, a stage
must produce the same output forever.

The rule that matters most is the clock. ``as_of`` is THE date. A single
``date.today()`` inside a stage makes every run that touches it unreplayable,
and because the output still looks perfectly reasonable, nobody notices for
months.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from datetime import date
from typing import Any, TypeVar

K = TypeVar("K")
V = TypeVar("V")


class FrozenDict(Mapping[K, V]):
    """An immutable, hashable Mapping.

    A plain dict on a frozen dataclass is a hole in the freeze: the dataclass
    refuses attribute assignment while the caller happily mutates the dict it
    passed in. Since RunContext is meant to be safe to hand to any stage —
    including concurrently — the mapping has to be genuinely immutable, not
    immutable by convention.
    """

    __slots__ = ("_data", "_hash")

    def __init__(self, data: Mapping[K, V] | None = None) -> None:
        self._data: dict[K, V] = dict(data or {})
        self._hash: int | None = None

    def __getitem__(self, key: K) -> V:
        return self._data[key]

    def __iter__(self) -> Iterator[K]:
        return iter(self._data)

    def __len__(self) -> int:
        return len(self._data)

    def __repr__(self) -> str:
        return f"FrozenDict({self._data!r})"

    def __eq__(self, other: object) -> bool:
        if isinstance(other, Mapping):
            return dict(self._data) == dict(other)
        return NotImplemented

    def __hash__(self) -> int:
        if self._hash is None:
            self._hash = hash(frozenset(self._data.items()))
        return self._hash

    def to_dict(self) -> dict[K, V]:
        return dict(self._data)


@dataclass(frozen=True, slots=True)
class RunContext:
    """One pipeline execution's immutable world.

    Every field is here because a stage would otherwise have had to reach
    outside itself to get it:

    ``run_id``         one uuid per pipeline execution; ties every stage's
                       audit row back to the run that produced it.
    ``tenant_id``      client_id. Also what gets set as the RLS GUC, so a
                       stage never chooses its own tenant scope.
    ``store_id``       location_id.
    ``as_of``          THE clock. No stage may call ``date.today()``.
    ``snapshot_id``    which data snapshot was read. Without it "replay" means
                       "re-run against whatever the warehouse says now", which
                       is not replay.
    ``config_version`` which threshold set. The registry refuses to serve a
                       stage whose context pins a different one.
    ``seed``           for anything stochastic. Sampling, tie-breaking,
                       holdout assignment.
    ``versions``       code/model/data versions pinned for this run, e.g.
                       {"engine": "2.0.0", "candidates": "1.3.0"}.
    """

    run_id: str
    tenant_id: int
    store_id: int
    as_of: date
    snapshot_id: str
    config_version: str
    seed: int = 0
    versions: Mapping[str, str] = field(default_factory=FrozenDict)

    def __post_init__(self) -> None:
        for name in ("run_id", "snapshot_id", "config_version"):
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"RunContext.{name} must be a non-empty string")
        for name in ("tenant_id", "store_id"):
            value = getattr(self, name)
            # bool is an int subclass and would silently pass an int check.
            if not isinstance(value, int) or isinstance(value, bool):
                raise TypeError(f"RunContext.{name} must be an int, got {type(value).__name__}")
        if not isinstance(self.seed, int) or isinstance(self.seed, bool):
            raise TypeError("RunContext.seed must be an int")

        # datetime IS a date subclass, so `isinstance(as_of, date)` accepts a
        # timestamp — and a timestamp here quietly reintroduces exactly the
        # sub-day clock dependence as_of exists to remove.
        if type(self.as_of) is not date:
            raise TypeError(
                f"RunContext.as_of must be a datetime.date, not "
                f"{type(self.as_of).__name__}. A datetime carries a time of day, "
                "which makes the run unreplayable."
            )

        object.__setattr__(self, "versions", FrozenDict(self.versions))

    def to_dict(self) -> dict[str, Any]:
        """JSON-ready. Used for the audit row and for fixtures."""
        return {
            "run_id": self.run_id,
            "tenant_id": self.tenant_id,
            "store_id": self.store_id,
            "as_of": self.as_of.isoformat(),
            "snapshot_id": self.snapshot_id,
            "config_version": self.config_version,
            "seed": self.seed,
            "versions": dict(self.versions),
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> RunContext:
        missing = {
            "run_id", "tenant_id", "store_id", "as_of", "snapshot_id", "config_version"
        } - set(data)
        if missing:
            raise ValueError(f"RunContext is missing required keys: {sorted(missing)}")
        return cls(
            run_id=data["run_id"],
            tenant_id=int(data["tenant_id"]),
            store_id=int(data["store_id"]),
            as_of=date.fromisoformat(data["as_of"]),
            snapshot_id=data["snapshot_id"],
            config_version=data["config_version"],
            seed=int(data.get("seed", 0)),
            versions=FrozenDict(data.get("versions") or {}),
        )


__all__ = ["FrozenDict", "RunContext"]
