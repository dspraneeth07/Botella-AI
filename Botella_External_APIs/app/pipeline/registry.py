"""The config registry — every threshold declared once, with an owner and a reason.

The current engine has 63 magic constants. Not one of them records who chose
it, why, what unit it is in, or whether it was ever measured — so none of them
were ever revisited, and nobody could have produced a list of which judgements
in the system are still guesses. That list is the point of this module.

A Setting is a declaration, not a number:

    SHRINKAGE_K_SEASONAL = Setting(
        name="shrinkage.k.seasonal",
        default=12.0,
        unit="observations",
        owner="forecasting",
        why="provisional; to be fitted from holdout WAPE per pattern in wave 6",
        status="PROVISIONAL",
    )

``status`` is what pays off later. Everything starts PROVISIONAL and is
promoted to FITTED only once it has actually been fitted against a holdout, or
MEASURED once it comes from a measurement rather than a fit. At any moment
``cfg.report()`` answers "how much of this engine is still guesswork", and CI
prints that count on every run so it cannot quietly grow.

This module is the one place in ``app/pipeline/`` exempt from the no-float-
literals check, because it is where the numbers are supposed to live.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from typing import Any, Generic, Literal, TypeVar, get_args

from app.pipeline.context import FrozenDict, RunContext
from app.pipeline.provenance import current_recorder

V = TypeVar("V")

Status = Literal["PROVISIONAL", "FITTED", "MEASURED"]
STATUSES: tuple[str, ...] = get_args(Status)

#: Ordered worst-to-best, so reports lead with the settings that need work.
STATUS_ORDER: tuple[str, ...] = ("PROVISIONAL", "FITTED", "MEASURED")


class ConfigError(Exception):
    """Base for configuration contract violations."""


class DuplicateSetting(ConfigError):
    """Two different declarations claimed the same name — rule 3 violated."""


class UnregisteredSetting(ConfigError):
    """A Setting was read that no module ever declared."""


class ConfigVersionMismatch(ConfigError):
    """A stage asked for a value from a config set its context does not pin."""


@dataclass(frozen=True, slots=True)
class Setting(Generic[V]):
    """One declared threshold.

    Constructing a Setting REGISTERS it. That is a deliberate side effect: a
    threshold that exists but is not in the catalogue is invisible to
    ``report()``, which would defeat the purpose — the whole value here is
    being able to enumerate every judgement in the system.
    """

    name: str
    default: V
    unit: str
    owner: str
    why: str
    status: Status = "PROVISIONAL"

    def __post_init__(self) -> None:
        if not self.name or not self.name.strip():
            raise ValueError("Setting.name must be non-empty")
        for attr in ("unit", "owner", "why"):
            if not str(getattr(self, attr) or "").strip():
                raise ValueError(
                    f"Setting {self.name!r} needs a non-empty {attr}. A threshold "
                    "without an owner and a stated reason is a magic number with "
                    "extra steps."
                )
        if self.status not in STATUSES:
            raise ValueError(
                f"Setting {self.name!r} has status {self.status!r}; expected one of {STATUSES}"
            )
        _register(self)


# ── Catalogue ────────────────────────────────────────────────────────────────
# Module-level, because declaration is module-level: `X = Setting(...)` runs
# once per process at import.

_CATALOG: dict[str, Setting[Any]] = {}


def _register(setting: Setting[Any]) -> None:
    existing = _CATALOG.get(setting.name)
    if existing is not None and existing != setting:
        raise DuplicateSetting(
            f"Setting {setting.name!r} is already declared with different terms.\n"
            f"  existing: {existing}\n"
            f"  new:      {setting}\n"
            "Declare each threshold exactly once, in the module that owns it."
        )
    _CATALOG[setting.name] = setting


def catalog() -> Mapping[str, Setting[Any]]:
    """Every declared setting, read-only."""
    return FrozenDict(_CATALOG)


def reset_catalog_for_tests() -> Iterator[None] | None:
    """Clear the catalogue. Tests only — never call this from app code."""
    _CATALOG.clear()
    return None


# ── Report ───────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class ConfigReport:
    """Every setting grouped by status, plus the number that still matters."""

    by_status: Mapping[str, tuple[Setting[Any], ...]]

    @property
    def provisional_count(self) -> int:
        """How many judgements in the system are still guesses."""
        return len(self.by_status.get("PROVISIONAL", ()))

    @property
    def total(self) -> int:
        return sum(len(v) for v in self.by_status.values())

    def __str__(self) -> str:
        lines: list[str] = []
        for status in STATUS_ORDER:
            settings = self.by_status.get(status, ())
            lines.append(f"{status} ({len(settings)})")
            if not settings:
                lines.append("  (none)")
            for s in settings:
                lines.append(f"  {s.name}  = {s.default!r} {s.unit}  [{s.owner}]")
                lines.append(f"      why: {s.why}")
        lines.append("")
        lines.append(
            f"{self.total} settings declared; {self.provisional_count} still PROVISIONAL."
        )
        return "\n".join(lines)


# ── Registry ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class ConfigRegistry:
    """Resolves a Setting to a value for a given run, and records the read.

    ``version`` is checked against ``ctx.config_version`` on every read. That
    looks pedantic until a replay quietly resolves a threshold from today's
    config set instead of the one the original run used, reproduces a
    different number, and is believed.
    """

    version: str = "default"
    overrides: Mapping[str, Any] = field(default_factory=FrozenDict)

    def __post_init__(self) -> None:
        if not self.version or not self.version.strip():
            raise ValueError("ConfigRegistry.version must be non-empty")
        object.__setattr__(self, "overrides", FrozenDict(self.overrides))

    def get(self, setting: Setting[V], ctx: RunContext) -> V:
        """The value of ``setting`` for this run, recording that it was read.

        The recording is the reason this takes ``ctx`` at all: it is what
        makes ``Provenance.config_keys`` fill itself, so a stage cannot
        under-report the thresholds behind its answer even by accident.
        """
        declared = _CATALOG.get(setting.name)
        if declared is None:
            raise UnregisteredSetting(
                f"Setting {setting.name!r} was never declared. Construct it at module "
                "level so it lands in the catalogue and shows up in cfg.report()."
            )
        if declared != setting:
            raise DuplicateSetting(
                f"Setting {setting.name!r} does not match the declared one — two "
                "different objects are using the same name."
            )
        if ctx.config_version != self.version:
            raise ConfigVersionMismatch(
                f"context pins config_version={ctx.config_version!r} but this registry "
                f"serves {self.version!r}. Resolve the run against the config set it "
                "was pinned to, or replay will silently use today's thresholds."
            )

        recorder = current_recorder()
        if recorder is not None:
            recorder.record_config(setting.name)

        if setting.name in self.overrides:
            value = self.overrides[setting.name]
            _check_override_type(setting, value)
            return value
        return setting.default

    def with_overrides(self, version: str, overrides: Mapping[str, Any]) -> ConfigRegistry:
        """A sibling registry for a different config set. Same catalogue."""
        unknown = sorted(set(overrides) - set(_CATALOG))
        if unknown:
            raise UnregisteredSetting(
                f"overrides name settings that were never declared: {unknown}"
            )
        return ConfigRegistry(version=version, overrides=overrides)

    def print_report(self, stream: Any = None) -> ConfigReport:
        """Print every setting grouped by status; return the report too.

        ``report()`` returns rather than prints so it can be asserted on and
        composed; this is the verb the sheet asks for, and what
        scripts/config_report.py and CI call.
        """
        report = self.report()
        print(report, file=stream)
        return report

    def report(self) -> ConfigReport:
        """Every setting grouped by status."""
        grouped: dict[str, list[Setting[Any]]] = {s: [] for s in STATUS_ORDER}
        for setting in sorted(_CATALOG.values(), key=lambda s: s.name):
            grouped.setdefault(setting.status, []).append(setting)
        return ConfigReport(
            by_status=FrozenDict({k: tuple(v) for k, v in grouped.items()})
        )


def _check_override_type(setting: Setting[Any], value: Any) -> None:
    """Reject an override of the wrong type.

    Overrides usually arrive from JSON or an env-backed map, where 12.0
    becomes "12.0" without complaint and every downstream comparison then
    silently does the wrong thing.
    """
    expected = type(setting.default)
    if isinstance(value, bool) != isinstance(setting.default, bool):
        raise ConfigError(
            f"override for {setting.name!r} is {value!r}; expected {expected.__name__}"
        )
    if isinstance(setting.default, (int, float)) and isinstance(value, (int, float)):
        return  # int/float are interchangeable for a numeric threshold
    if not isinstance(value, expected):
        raise ConfigError(
            f"override for {setting.name!r} is {type(value).__name__} "
            f"({value!r}); expected {expected.__name__}"
        )


#: The default registry. Stages take one by injection where they can, but a
#: single well-known instance keeps the common path honest.
cfg = ConfigRegistry()


__all__ = [
    "STATUSES",
    "STATUS_ORDER",
    "ConfigError",
    "ConfigRegistry",
    "ConfigReport",
    "ConfigVersionMismatch",
    "DuplicateSetting",
    "Setting",
    "Status",
    "UnregisteredSetting",
    "catalog",
    "cfg",
    "reset_catalog_for_tests",
]
