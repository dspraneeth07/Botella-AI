"""The four quality gates — and the system's right to refuse.

A store whose data fails its contract produces NO recommendation and a stated
reason. That is infinitely better than a confident one built on rubbish, and
it is the property this module exists to provide.

    Gate          On failure
    ────────────  ──────────────────────────────────────────────────────────
    schema        Reject the batch. Page the connector owner — the POS changed.
    completeness  Accept; mark the field UNAVAILABLE. Downstream must not use it.
    freshness     Accept; attach staleness measured against THIS store's cadence.
    anomaly       Quarantine the batch. Do not merge. Raise for review.

Every gate is a sheet-00 stage: a pure function of `(input, ctx)` returning a
`StageResult` with populated `Provenance`. No clock, no database, no network —
the trailing statistics and the sync history arrive as INPUT, computed by the
caller, because a gate that queries the warehouse cannot be replayed and a
quality verdict that cannot be replayed is not evidence of anything.

THRESHOLDS ARE INTEGER PERCENTAGES. Sheet 00 bans float literals outside the
registry, so a 2.5× tolerance is `250` percent and a 40% floor is `40`. The
anomaly gate uses ratio bands rather than z-scores for the same reason it uses
percentages: "volume is 340% of this store's normal" is a sentence an owner can
argue with, and a robust z-score over a handful of observations is noise
wearing a lab coat.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

from app.pipeline.context import RunContext
from app.pipeline.contracts.schema import (
    Contract,
    coerce,
    is_present,
)
from app.pipeline.contracts.schema import (
    registry as contract_registry,
)
from app.pipeline.envelope import StageResult, stage
from app.pipeline.provenance import EvidenceState, Provenance, record_inputs
from app.pipeline.registry import ConfigRegistry, Setting, cfg

# ── Thresholds, declared once with an owner and a reason ─────────────────────

SCHEMA_MAX_BAD_ROW_PCT = Setting(
    name="contracts.schema.max_bad_row_pct",
    default=2,
    unit="percent",
    owner="data-quality",
    why="provisional; a handful of unparseable rows is a POS quirk, but 2%+ is "
        "a shape change. To be fitted against observed connector noise in wave 6",
    status="PROVISIONAL",
)

FRESHNESS_TOLERANCE_PCT = Setting(
    name="contracts.freshness.tolerance_pct",
    default=250,
    unit="percent of the store's own median sync interval",
    owner="data-quality",
    why="provisional; a store is stale once it has missed roughly 2.5 of its own "
        "cycles. A weekly store is therefore healthy at 6 days and broken at 20, "
        "which a fixed 48h rule gets backwards. To be fitted in wave 6",
    status="PROVISIONAL",
)

FRESHNESS_MIN_OBSERVATIONS = Setting(
    name="contracts.freshness.min_observations",
    default=3,
    unit="successful syncs",
    owner="data-quality",
    why="provisional; below three gaps a median cadence is not a cadence, and "
        "the gate falls back to the connector default rather than inventing one",
    status="PROVISIONAL",
)

FRESHNESS_DEFAULT_INTERVAL_DAYS = Setting(
    name="contracts.freshness.default_interval_days",
    default=1,
    unit="days",
    owner="data-quality",
    why="provisional; the assumed cadence for a store with too little history "
        "to derive its own. Most connectors poll at least daily",
    status="PROVISIONAL",
)

ANOMALY_VOLUME_HIGH_PCT = Setting(
    name="contracts.anomaly.volume_high_pct",
    default=250,
    unit="percent of the store's trailing median volume",
    owner="data-quality",
    why="provisional; a double-load lands at 200%, so the band sits above it "
        "with headroom for a genuine busy day. To be fitted in wave 6",
    status="PROVISIONAL",
)

ANOMALY_VOLUME_LOW_PCT = Setting(
    name="contracts.anomaly.volume_low_pct",
    default=25,
    unit="percent of the store's trailing median volume",
    owner="data-quality",
    why="provisional; a partial load (one page of many) shows up as a collapse "
        "in volume, which is as wrong as a doubling and half as noticeable",
    status="PROVISIONAL",
)

ANOMALY_PRICE_HIGH_PCT = Setting(
    name="contracts.anomaly.price_high_pct",
    default=300,
    unit="percent of the store's trailing median unit price",
    owner="data-quality",
    why="provisional; a decimal shift is 1000%, so this catches it with room "
        "for a legitimate premium-mix day",
    status="PROVISIONAL",
)

ANOMALY_PRICE_LOW_PCT = Setting(
    name="contracts.anomaly.price_low_pct",
    default=33,
    unit="percent of the store's trailing median unit price",
    owner="data-quality",
    why="provisional; the other direction of a decimal shift (10%), plus a "
        "cents-vs-dollars unit error",
    status="PROVISIONAL",
)

ANOMALY_BASKET_HIGH_PCT = Setting(
    name="contracts.anomaly.basket_high_pct",
    default=300,
    unit="percent of the store's trailing median basket size",
    owner="data-quality",
    why="provisional; a re-load that merges every line into one receipt inflates "
        "basket size without changing volume, so it slips past the volume band",
    status="PROVISIONAL",
)

ANOMALY_MIN_OBSERVATIONS = Setting(
    name="contracts.anomaly.min_observations",
    default=7,
    unit="trailing days",
    owner="data-quality",
    why="provisional; below a week there is no distribution to compare against "
        "and the gate abstains rather than quarantining a new store's first load",
    status="PROVISIONAL",
)


# Unit conversions, not judgements. Named integers rather than inline floats:
# sheet 00's guard correctly flagged `86400.0` and `100.0`, and it is right to
# — a bare number in a calculation is indistinguishable from a threshold until
# someone reads the surrounding line. These are exact and never tuned.
SECONDS_PER_DAY = 86400
PERCENT = 100


# ── Inputs ───────────────────────────────────────────────────────────────────
# Everything a gate needs, computed by the caller. A gate never fetches.


@dataclass(frozen=True, slots=True)
class Batch:
    """One connector's delivery for one store and entity."""

    connector: str
    entity: str
    rows: Sequence[dict[str, Any]]
    batch_id: str = ""
    contract_version: str | None = None
    #: Inclusive date bounds the warehouse has partitions for. Rows outside
    #: land in the DEFAULT partition and are absorbed silently — see
    #: partition_range_check.
    partition_min: date | None = None
    partition_max: date | None = None


@dataclass(frozen=True, slots=True)
class FreshnessInput:
    """This store's own sync cadence, from the caller."""

    connector: str
    entity: str
    last_successful_sync: datetime | None
    #: Successful sync timestamps over the trailing quarter, any order.
    recent_syncs: tuple[datetime, ...] = ()


@dataclass(frozen=True, slots=True)
class TrailingStats:
    """This store's own trailing distribution — never a network-wide one."""

    median_daily_volume: float | None = None
    median_unit_price: float | None = None
    median_basket_size: float | None = None
    observations: int = 0


@dataclass(frozen=True, slots=True)
class AnomalyInput:
    connector: str
    entity: str
    batch_volume: float | None
    batch_unit_price: float | None = None
    batch_basket_size: float | None = None
    trailing: TrailingStats = field(default_factory=TrailingStats)


#: A field that failed completeness. Travels as ABSENT, never as zero.
UNAVAILABLE = "UNAVAILABLE"


@dataclass(frozen=True, slots=True)
class FieldAvailability:
    """Which declared fields survived completeness, and which did not."""

    available: tuple[str, ...]
    unavailable: tuple[str, ...]
    coverage_pct: dict[str, int]
    #: field -> what downstream loses by its absence.
    impact: dict[str, str]

    def is_available(self, name: str) -> bool:
        return name in self.available

    def strip(self, row: dict[str, Any]) -> dict[str, Any]:
        """Remove unavailable fields from a row.

        REMOVE, not zero. A cost of 0.0 is indistinguishable from a free
        product and produces a 100% margin; an absent cost produces no margin
        at all, which is the correct answer when cost is unknown. This is the
        one behaviour the completeness gate exists to guarantee.
        """
        return {k: v for k, v in row.items() if k not in self.unavailable}


def _pct(part: int, whole: int) -> int:
    """Integer percentage, rounded down. 0 rows = 0%, never a division error."""
    return 0 if whole <= 0 else (PERCENT * part) // whole


def _median(values: Sequence[float]) -> float | None:
    ordered = sorted(v for v in values if v is not None)
    if not ordered:
        return None
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return float(ordered[mid])
    return (float(ordered[mid - 1]) + float(ordered[mid])) / 2


def _ratio_pct(actual: float, baseline: float) -> int | None:
    """actual as an integer percentage of baseline."""
    if baseline is None or baseline == 0:
        return None
    return int(round(PERCENT * float(actual) / float(baseline)))


def _resolve_contract(batch: Batch) -> tuple[Contract | None, bool]:
    return contract_registry.get(batch.connector, batch.entity, batch.contract_version)


# ── 1. Schema gate ───────────────────────────────────────────────────────────


@stage("schema_gate", "1.0.0")
def schema_gate(batch: Batch, ctx: RunContext, config: ConfigRegistry = cfg) -> StageResult:
    """Declared columns present, types coercible, enums known.

    FAIL rejects the batch, and the reason NAMES THE FIELD — "rejected" on its
    own sends someone reading 8 million rows to find out which column changed.

    Also checks the partition range. 8,616,193 sale_items rows currently sit in
    the warehouse's DEFAULT partition: every one has a valid date, they are
    simply older than the oldest defined partition (2025-04-01), so they were
    absorbed correctly rather than corrupted. The live risk is the other end —
    partitions stop at 2026-11-30, and after that every new sale silently lands
    in DEFAULT with nothing to say so.
    """
    record_inputs(f"batch.{batch.entity}.rows")
    contract, fell_back = _resolve_contract(batch)
    rows = list(batch.rows)

    if contract is None:
        return StageResult.failure(
            f"no_contract:{batch.connector}/{batch.entity}",
            provenance=Provenance(own_observations=len(rows), own_weight=1.0,
                                  evidence_state="NEW"),
        )

    prov = Provenance(
        own_observations=len(rows),
        own_weight=1.0,
        evidence_state="ESTABLISHED" if rows else "NEW",
        inputs=(f"contract:{contract.key}",),
    )

    if not rows:
        # An empty batch is not a schema violation, and it is not success
        # either. It is "nothing arrived", which downstream must see.
        return StageResult.failure("empty_batch", provenance=prov)

    max_bad_pct = config.get(SCHEMA_MAX_BAD_ROW_PCT, ctx)

    # Missing REQUIRED columns are judged on the batch, not per row: a column
    # absent from every row is a shape change, which is a different and much
    # louder fact than a few rows missing a value.
    present_columns: set[str] = set()
    for row in rows:
        present_columns.update(row.keys())

    missing = [f.name for f in contract.required_fields if f.name not in present_columns]
    if missing:
        return StageResult.failure(
            *[f"missing_required_field:{name}" for name in sorted(missing)],
            provenance=prov,
        )

    type_errors: dict[str, int] = {}
    enum_errors: dict[str, set[str]] = {}
    out_of_partition = 0
    partition_examples: list[str] = []

    for row in rows:
        for spec in contract.fields:
            if spec.name not in row:
                continue
            ok, value = coerce(row[spec.name], spec.type)
            if not ok:
                type_errors[spec.name] = type_errors.get(spec.name, 0) + 1
                continue
            if spec.enum and value is not None and str(value) not in spec.enum:
                enum_errors.setdefault(spec.name, set()).add(str(value))

        if contract.date_field and (batch.partition_min or batch.partition_max):
            ok, when = coerce(row.get(contract.date_field), "date")
            if ok and when is not None:
                if (batch.partition_min and when < batch.partition_min) or (
                    batch.partition_max and when > batch.partition_max
                ):
                    out_of_partition += 1
                    if len(partition_examples) < 3:
                        partition_examples.append(when.isoformat())

    reasons: list[str] = []
    for name, count in sorted(type_errors.items()):
        share = _pct(count, len(rows))
        if share > max_bad_pct:
            reasons.append(f"type_violation:{name}:{count}_rows:{share}pct")
    for name, values in sorted(enum_errors.items()):
        reasons.append(f"unknown_enum:{name}:{','.join(sorted(values)[:5])}")
    if out_of_partition:
        share = _pct(out_of_partition, len(rows))
        reasons.append(
            f"outside_partition_range:{contract.date_field}:"
            f"{out_of_partition}_rows:{share}pct:{','.join(partition_examples)}"
        )

    detail = {
        "contract": contract.key,
        "fallback_contract": fell_back,
        "rows": len(rows),
        "type_errors": type_errors,
        "enum_errors": {k: sorted(v) for k, v in enum_errors.items()},
        "out_of_partition_rows": out_of_partition,
    }

    if reasons:
        return StageResult.failure(*reasons, provenance=prov)
    # A fallback contract passing is a weaker statement than a real one
    # passing, and the result says so rather than implying full coverage.
    notes = ("checked_against_base_contract",) if fell_back else ()
    return StageResult.success(detail, prov, reasons=notes)


# ── 2. Completeness gate ─────────────────────────────────────────────────────


@stage("completeness_gate", "1.0.0")
def completeness_gate(batch: Batch, ctx: RunContext, config: ConfigRegistry = cfg) -> StageResult:
    """Per-field coverage against the contract minimum, per connector.

    ACCEPTS and marks the field UNAVAILABLE. Rejecting the batch would throw
    away a store's whole catalogue because one optional column is thin; using
    the field anyway is how a 0.00-cost product becomes a 100%-margin
    recommendation. The third option — carry the data, name what is missing —
    is the only one that is both honest and useful.

    Reports BY CONNECTOR because that is where the defect lives. Gokul sends
    0.00% cost across 19 stores and 160k SKUs; Square sends neither cost nor
    category. Read per store that is 28 data-quality problems; read per
    connector it is two tickets.
    """
    record_inputs(f"batch.{batch.entity}.rows")
    contract, fell_back = _resolve_contract(batch)
    rows = list(batch.rows)

    if contract is None:
        return StageResult.failure(
            f"no_contract:{batch.connector}/{batch.entity}",
            provenance=Provenance(own_observations=len(rows), own_weight=1.0,
                                  evidence_state="NEW"),
        )

    prov = Provenance(
        own_observations=len(rows),
        own_weight=1.0,
        evidence_state="ESTABLISHED" if rows else "NEW",
        inputs=(f"contract:{contract.key}",),
    )

    coverage: dict[str, int] = {}
    unavailable: list[str] = []
    available: list[str] = []
    impact: dict[str, str] = {}

    for spec in contract.coverage_fields:
        # Zero counts as ABSENT for money fields. A product costing 0.00 is a
        # product whose cost we do not know; counting it as covered is exactly
        # how a connector sending all-zero costs reads as 100% complete.
        zero_is_absent = spec.name in ("cost", "price")
        present = 0
        for row in rows:
            ok, value = coerce(row.get(spec.name), spec.type)
            if not ok or not is_present(value):
                continue
            if zero_is_absent and isinstance(value, (int, float)) and float(value) == 0.0:
                continue
            present += 1

        pct = _pct(present, len(rows))
        coverage[spec.name] = pct
        if pct < spec.min_coverage_pct:
            unavailable.append(spec.name)
            impact[spec.name] = spec.used_for
        else:
            available.append(spec.name)

    availability = FieldAvailability(
        available=tuple(sorted(available)),
        unavailable=tuple(sorted(unavailable)),
        coverage_pct=coverage,
        impact=impact,
    )
    detail = {
        "contract": contract.key,
        "fallback_contract": fell_back,
        "connector": contract.connector,
        "rows": len(rows),
        "coverage_pct": coverage,
        "minimums_pct": {f.name: f.min_coverage_pct for f in contract.coverage_fields},
        "unavailable": list(availability.unavailable),
        "impact": impact,
        "availability": availability,
    }

    # ok=True even with breaches: the batch is accepted. The REASONS carry the
    # contract breaches so they reach the digest and the connector's ticket.
    minimums = {f.name: f.min_coverage_pct for f in contract.coverage_fields}
    reasons = tuple(
        f"field_unavailable:{name}:{coverage[name]}pct<{minimums[name]}pct"
        for name in availability.unavailable
    )
    return StageResult.success(detail, prov, reasons=reasons)


# ── 3. Freshness gate ────────────────────────────────────────────────────────


@stage("freshness_gate", "1.0.0")
def freshness_gate(
    info: FreshnessInput, ctx: RunContext, config: ConfigRegistry = cfg
) -> StageResult:
    """Staleness against THIS STORE's own cadence, never a fixed threshold.

    A fixed "stale after 48 hours" rule would mark a large share of the estate
    permanently broken, because cadence varies by connector and by store. The
    store's expected interval is the MEDIAN GAP between its own successful
    syncs over the trailing quarter, and it is judged against that: a store
    that has always synced weekly is healthy at six days and genuinely broken
    at twenty.

    Accepts and ATTACHES staleness rather than failing — the figure travels to
    every downstream result so a recommendation can carry "as of 6 days ago"
    instead of being silently withheld or silently trusted. The one refusal is
    a store that has never synced at all, which has no data to be fresh about.
    """
    record_inputs("sync_state.last_successful_sync", "sync_state.recent_syncs")

    stamps = sorted(info.recent_syncs)
    gaps = [
        (b - a).total_seconds() / SECONDS_PER_DAY
        for a, b in zip(stamps, stamps[1:], strict=False)
    ]
    min_obs = config.get(FRESHNESS_MIN_OBSERVATIONS, ctx)
    tolerance_pct = config.get(FRESHNESS_TOLERANCE_PCT, ctx)

    evidence: EvidenceState
    if len(gaps) >= min_obs:
        median_interval = _median(gaps) or float(config.get(FRESHNESS_DEFAULT_INTERVAL_DAYS, ctx))
        cadence_source = "own_history"
        evidence = "MATURE" if len(gaps) >= min_obs * 3 else "ESTABLISHED"
    else:
        # Too little history to claim a cadence. Say so rather than inventing
        # one from two data points.
        median_interval = float(config.get(FRESHNESS_DEFAULT_INTERVAL_DAYS, ctx))
        cadence_source = "default_assumed"
        evidence = "EMERGING" if gaps else "NEW"

    prov = Provenance(
        own_observations=len(stamps),
        own_weight=1.0 if cadence_source == "own_history" else 0.0,
        evidence_state=evidence,
        inputs=("sync_state.recent_syncs",),
    )

    if info.last_successful_sync is None:
        return StageResult.failure(
            "never_synced",
            provenance=prov,
        )

    as_of = datetime.combine(ctx.as_of, datetime.min.time())
    last = info.last_successful_sync
    if last.tzinfo is not None:
        last = last.replace(tzinfo=None)
    staleness_days = max(0.0, (as_of - last).total_seconds() / SECONDS_PER_DAY)

    allowed_days = median_interval * tolerance_pct / PERCENT
    stale = staleness_days > allowed_days

    detail = {
        "staleness_days": round(staleness_days, 2),
        "median_interval_days": round(median_interval, 2),
        "allowed_days": round(allowed_days, 2),
        "tolerance_pct": tolerance_pct,
        "cadence_source": cadence_source,
        "observations": len(stamps),
        "stale": stale,
        "last_successful_sync": info.last_successful_sync.isoformat(),
    }
    # Accepted either way; `stale` rides on the value and the reason makes it
    # visible to anything that only reads reasons.
    reasons = (
        (f"stale:{round(staleness_days, 1)}d>allowed_{round(allowed_days, 1)}d",) if stale else ()
    )
    return StageResult.success(detail, prov, reasons=reasons)


# ── 4. Anomaly gate ──────────────────────────────────────────────────────────


@stage("anomaly_gate", "1.0.0")
def anomaly_gate(
    info: AnomalyInput, ctx: RunContext, config: ConfigRegistry = cfg
) -> StageResult:
    """Volume, unit price and basket size against this store's own trailing
    distribution. Catches a double-load and a decimal shift.

    FAIL quarantines: the batch is not merged, and a human looks. Merging a
    doubled batch is worse than merging nothing, because the numbers stay
    plausible and every downstream figure is quietly wrong for as long as the
    trailing window remembers it.

    Compared against THIS STORE's own history. A network-wide band would
    quarantine every small store and wave through every large one.
    """
    record_inputs("trailing.median_daily_volume", "trailing.median_unit_price",
                  "trailing.median_basket_size")

    trailing = info.trailing
    min_obs = config.get(ANOMALY_MIN_OBSERVATIONS, ctx)

    evidence: EvidenceState
    if trailing.observations >= min_obs * 4:
        evidence = "MATURE"
    elif trailing.observations >= min_obs:
        evidence = "ESTABLISHED"
    elif trailing.observations:
        evidence = "EMERGING"
    else:
        evidence = "NEW"

    prov = Provenance(
        own_observations=trailing.observations,
        own_weight=1.0,
        evidence_state=evidence,
        inputs=("trailing.distribution",),
    )

    if trailing.observations < min_obs:
        # Abstain. A new store's first load has nothing to be compared with,
        # and quarantining it would block exactly the stores we most want
        # onboarded.
        return StageResult.success(
            {"abstained": True, "observations": trailing.observations,
             "required_observations": min_obs},
            prov,
            reasons=("insufficient_history_to_judge",),
        )

    checks: list[tuple[str, float | None, float | None, int, int]] = [
        ("volume", info.batch_volume, trailing.median_daily_volume,
         config.get(ANOMALY_VOLUME_LOW_PCT, ctx), config.get(ANOMALY_VOLUME_HIGH_PCT, ctx)),
        ("unit_price", info.batch_unit_price, trailing.median_unit_price,
         config.get(ANOMALY_PRICE_LOW_PCT, ctx), config.get(ANOMALY_PRICE_HIGH_PCT, ctx)),
        ("basket_size", info.batch_basket_size, trailing.median_basket_size,
         0, config.get(ANOMALY_BASKET_HIGH_PCT, ctx)),
    ]

    ratios: dict[str, int] = {}
    breaches: list[str] = []
    for name, actual, baseline, low, high in checks:
        if actual is None or baseline is None:
            continue
        ratio = _ratio_pct(actual, baseline)
        if ratio is None:
            continue
        ratios[name] = ratio
        if low and ratio < low:
            breaches.append(f"{name}_collapsed:{ratio}pct_of_normal")
        elif ratio > high:
            breaches.append(f"{name}_spike:{ratio}pct_of_normal")

    detail = {
        "ratios_pct": ratios,
        "observations": trailing.observations,
        "baselines": {
            "median_daily_volume": trailing.median_daily_volume,
            "median_unit_price": trailing.median_unit_price,
            "median_basket_size": trailing.median_basket_size,
        },
    }
    if breaches:
        return StageResult.failure(*breaches, provenance=prov)
    return StageResult.success(detail, prov)


# ── Composite ────────────────────────────────────────────────────────────────

#: Overall verdicts, worst first.
VERDICTS = ("reject", "quarantine", "degraded", "pass")


@dataclass(frozen=True, slots=True)
class QualityVerdict:
    """What the four gates concluded, and what downstream may do about it."""

    verdict: str
    gates: dict[str, StageResult]
    unavailable_fields: tuple[str, ...]
    staleness_days: float | None
    never_synced: bool
    reasons: tuple[str, ...]

    @property
    def may_recommend(self) -> bool:
        """The right to refuse, in one property.

        A rejected or quarantined batch produces NO recommendation. `degraded`
        still may — with fields marked unavailable and staleness attached — so
        a store with a thin catalogue is not silenced entirely.
        """
        return self.verdict in ("pass", "degraded")


def run_quality_gates(
    ctx: RunContext,
    *,
    batch: Batch | None = None,
    freshness: FreshnessInput | None = None,
    anomaly: AnomalyInput | None = None,
    config: ConfigRegistry = cfg,
) -> QualityVerdict:
    """Run every applicable gate and reduce them to one verdict.

    Precedence is worst-wins, and the order is not arbitrary: a rejected batch
    was never merged, so its completeness and anomaly readings describe data
    that does not exist.
    """
    gates: dict[str, StageResult] = {}
    reasons: list[str] = []
    unavailable: tuple[str, ...] = ()
    staleness: float | None = None
    never_synced = False

    if batch is not None:
        gates["schema"] = schema_gate(batch, ctx, config)
        gates["completeness"] = completeness_gate(batch, ctx, config)
        comp = gates["completeness"]
        if comp.ok and comp.value:
            unavailable = comp.value["availability"].unavailable
        reasons.extend(comp.reasons)

    if freshness is not None:
        gates["freshness"] = freshness_gate(freshness, ctx, config)
        fresh = gates["freshness"]
        if fresh.ok and fresh.value:
            staleness = fresh.value["staleness_days"]
        else:
            never_synced = "never_synced" in fresh.reasons
        reasons.extend(fresh.reasons)

    if anomaly is not None:
        gates["anomaly"] = anomaly_gate(anomaly, ctx, config)
        reasons.extend(r for r in gates["anomaly"].reasons if r != "insufficient_history_to_judge")

    if "schema" in gates and not gates["schema"].ok:
        verdict = "reject"
        reasons = list(gates["schema"].reasons) + reasons
    elif "anomaly" in gates and not gates["anomaly"].ok:
        verdict = "quarantine"
        reasons = list(gates["anomaly"].reasons) + reasons
    elif never_synced:
        verdict = "reject"
    elif unavailable or any(r.startswith("stale:") for r in reasons):
        verdict = "degraded"
    else:
        verdict = "pass"

    return QualityVerdict(
        verdict=verdict,
        gates=gates,
        unavailable_fields=unavailable,
        staleness_days=staleness,
        never_synced=never_synced,
        reasons=tuple(dict.fromkeys(reasons)),
    )


__all__ = [
    "UNAVAILABLE",
    "VERDICTS",
    "AnomalyInput",
    "Batch",
    "FieldAvailability",
    "FreshnessInput",
    "QualityVerdict",
    "TrailingStats",
    "anomaly_gate",
    "completeness_gate",
    "freshness_gate",
    "run_quality_gates",
    "schema_gate",
]
