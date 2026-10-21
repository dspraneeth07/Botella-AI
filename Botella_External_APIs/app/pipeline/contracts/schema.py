"""Versioned data contracts, one per (connector, entity).

Nothing currently stands between a malformed POS payload and a recommendation.
A contract is the declaration of what a connector is supposed to send, so that
"this batch is wrong" becomes a statement with a field name in it rather than a
recommendation nobody can explain.

VERSIONED PER CONNECTOR, and that is the whole point of the structure. The
estate runs eight connectors that agree on almost nothing: Gokul sends no cost
field at all, Square sends neither cost nor category, EPOSNow sends both at
~99%. One shared schema would either be so loose it catches nothing, or so
tight that every store fails it. A Korona schema change must not be able to
fail a Clover store, so contracts are keyed by connector and each carries its
own version history.

NO FLOAT LITERALS. Sheet 00's rule 3 bans them outside the registry, and
coverage minimums are therefore integer PERCENTAGES (`min_coverage_pct=80`)
rather than 0.8. That is not a workaround — a percentage with a unit on it is
what the reader actually wants, and it removes the "is this 0.8 or 80?"
question that every coverage bug starts with.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Literal

FieldType = Literal["string", "int", "number", "date", "datetime", "bool"]

#: Entities a POS connector can deliver. Matches syncgo's `jobs.entity`.
ENTITIES = ("products", "sales", "customers", "purchases", "suppliers")


@dataclass(frozen=True, slots=True)
class FieldSpec:
    """One declared field in a contract."""

    name: str
    type: FieldType
    #: A missing REQUIRED field is a schema failure — the batch is rejected.
    #: A missing optional field is a completeness question, not a schema one.
    required: bool = True
    #: Allowed values. None = not an enum. An unknown enum value is a schema
    #: failure: the POS added a state we have never reasoned about.
    enum: tuple[str, ...] | None = None
    #: Minimum share of rows that must carry a usable value, 0-100.
    #: Below this, the field is marked UNAVAILABLE — never zero-filled.
    min_coverage_pct: int = 0
    #: What downstream loses when this field is unavailable. Written into the
    #: gate result so the reason a recommendation was withheld is legible.
    used_for: str = ""

    def __post_init__(self) -> None:
        if not 0 <= self.min_coverage_pct <= 100:
            raise ValueError(
                f"{self.name}.min_coverage_pct must be 0-100, got {self.min_coverage_pct}"
            )


@dataclass(frozen=True, slots=True)
class Contract:
    """What one connector promises to send for one entity, at one version."""

    connector: str
    entity: str
    version: str
    fields: tuple[FieldSpec, ...]
    #: The column the warehouse partitions on, if any. The partition-range
    #: check hangs off this.
    date_field: str | None = None
    notes: str = ""

    def __post_init__(self) -> None:
        if self.entity not in ENTITIES:
            raise ValueError(f"unknown entity {self.entity!r}; expected one of {ENTITIES}")
        names = [f.name for f in self.fields]
        if len(names) != len(set(names)):
            raise ValueError(f"contract {self.key} declares a field twice")

    @property
    def key(self) -> str:
        return f"{self.connector}/{self.entity}@{self.version}"

    def field(self, name: str) -> FieldSpec | None:
        return next((f for f in self.fields if f.name == name), None)

    @property
    def required_fields(self) -> tuple[FieldSpec, ...]:
        return tuple(f for f in self.fields if f.required)

    @property
    def coverage_fields(self) -> tuple[FieldSpec, ...]:
        return tuple(f for f in self.fields if f.min_coverage_pct > 0)


# ── Type coercion ────────────────────────────────────────────────────────────
# "Coercible" rather than "correct": a POS that sends "2.0" for an integer
# quantity is not sending malformed data, it is sending a decimal string, and
# rejecting the whole batch for that would be absurd. What is NOT coercible is
# a genuine category error — a word where a number belongs.


def coerce(value: Any, to: FieldType) -> tuple[bool, Any]:
    """(ok, coerced). ok=False means a genuine type violation."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return True, None  # absent, not wrong — completeness' problem, not schema's
    try:
        if to == "string":
            return True, str(value)
        if to == "int":
            # int(float(x)) so "2.0" and 2.0 both land as 2; a POS sending a
            # decimal quantity for a keg partial is not a schema breach.
            return True, int(float(value))
        if to == "number":
            return True, float(value)
        if to == "bool":
            if isinstance(value, bool):
                return True, value
            text = str(value).strip().lower()
            if text in ("true", "t", "1", "yes", "y"):
                return True, True
            if text in ("false", "f", "0", "no", "n"):
                return True, False
            return False, None
        if to in ("date", "datetime"):
            if isinstance(value, datetime):
                return True, value if to == "datetime" else value.date()
            if isinstance(value, date):
                return True, value if to == "date" else datetime(value.year, value.month, value.day)
            text = str(value).strip().replace("Z", "+00:00")
            parsed = datetime.fromisoformat(text)
            return True, parsed.date() if to == "date" else parsed
    except (TypeError, ValueError):
        return False, None
    return False, None


def is_present(value: Any) -> bool:
    """Does this row carry a usable value for coverage purposes?

    Zero is PRESENT for a quantity and ABSENT for a cost, and the difference
    matters enormously: a product that costs 0.00 is a product whose cost we do
    not know, and treating it as free is how a 100% margin gets recommended.
    Callers pass the already-coerced value; `zero_is_absent` lives on the
    coverage call because only the field knows which it is.
    """
    return value is not None and value != ""


# ── The registry ─────────────────────────────────────────────────────────────


class ContractRegistry:
    """Contracts by (connector, entity), each with its own version history.

    Lookup falls back to a BASE contract when a connector has no specific one,
    so a newly-onboarded POS is checked against something sane rather than
    waved through. Falling back is recorded on the result — "checked against
    the base contract" is a materially weaker statement than "checked against
    the Clover v2 contract" and the reader is entitled to know which happened.
    """

    def __init__(self) -> None:
        self._by_key: dict[tuple[str, str], list[Contract]] = {}

    def register(self, contract: Contract) -> Contract:
        key = (contract.connector.lower(), contract.entity)
        versions = self._by_key.setdefault(key, [])
        if any(c.version == contract.version for c in versions):
            raise ValueError(f"contract {contract.key} is already registered")
        versions.append(contract)
        return contract

    def get(
        self, connector: str, entity: str, version: str | None = None
    ) -> tuple[Contract | None, bool]:
        """(contract, is_fallback). Latest registered version unless asked."""
        versions = self._by_key.get((str(connector or "").lower(), entity))
        if versions:
            if version is None:
                return versions[-1], False
            match = next((c for c in versions if c.version == version), None)
            if match is not None:
                return match, False
            return None, False
        base = self._by_key.get((BASE, entity))
        return (base[-1], True) if base else (None, True)

    def all(self) -> tuple[Contract, ...]:
        return tuple(c for versions in self._by_key.values() for c in versions)

    def connectors(self) -> tuple[str, ...]:
        return tuple(sorted({k[0] for k in self._by_key}))


#: Connector name for the fallback contract.
BASE = "base"

registry = ContractRegistry()


# ── Declared contracts ───────────────────────────────────────────────────────
# Coverage minimums are deliberately set to what the FIELD IS WORTH, not to
# what the estate currently achieves. Gokul sends 0% cost today; the contract
# still demands it, because "cost at 0% for a connector is a contract breach,
# not a data characteristic". A contract written down to current reality would
# report everything as healthy and tell us nothing.

_SALES_BASE = (
    FieldSpec("sku", "string", required=True, min_coverage_pct=100,
              used_for="joining a sale to a product — nothing works without it"),
    FieldSpec("sale_date", "datetime", required=True, min_coverage_pct=100,
              used_for="every velocity and seasonality calculation"),
    FieldSpec("quantity", "int", required=True, min_coverage_pct=100,
              used_for="units sold"),
    FieldSpec("total_amount", "number", required=True, min_coverage_pct=95,
              used_for="revenue and revenue-weighted unit price"),
)

_PRODUCTS_BASE = (
    FieldSpec("sku", "string", required=True, min_coverage_pct=100,
              used_for="the join key for everything"),
    FieldSpec("product_name", "string", required=True, min_coverage_pct=95,
              used_for="anything a human reads"),
    FieldSpec("price", "number", required=True, min_coverage_pct=90,
              used_for="revenue estimates and price-gap analysis"),
    FieldSpec("cost", "number", required=False, min_coverage_pct=70,
              used_for="MARGIN. Without it no profit figure can be stated, so "
                       "markdown, reorder and liquidate advice must be withheld"),
    FieldSpec("category", "string", required=False, min_coverage_pct=80,
              used_for="category mix, cross-sell and assortment gaps"),
    FieldSpec("stock_qty", "int", required=False, min_coverage_pct=90,
              used_for="on-hand, days-of-supply and stockout risk"),
)

registry.register(Contract(
    connector=BASE, entity="sales", version="1.0.0", fields=_SALES_BASE,
    date_field="sale_date",
    notes="Fallback for any connector without its own sales contract.",
))
registry.register(Contract(
    connector=BASE, entity="products", version="1.0.0", fields=_PRODUCTS_BASE,
    notes="Fallback for any connector without its own products contract.",
))

# Per-connector contracts. Each exists because the connector genuinely differs,
# never to paper over a defect.

registry.register(Contract(
    connector="clover", entity="products", version="1.0.0",
    fields=_PRODUCTS_BASE, date_field=None,
    notes="Clover reaches 64.6% cost and 82.4% category — both below contract, "
          "both reported as connector-level breaches rather than store noise.",
))
registry.register(Contract(
    connector="clover", entity="sales", version="1.0.0",
    fields=_SALES_BASE, date_field="sale_date",
))

registry.register(Contract(
    connector="gokul", entity="products", version="1.0.0",
    fields=_PRODUCTS_BASE,
    notes="Gokul sends 0.00% cost across 19 stores and 160k SKUs. The contract "
          "still demands 70%: this is a breach to be fixed at the connector, "
          "not a characteristic to be designed around.",
))
registry.register(Contract(
    connector="gokul", entity="sales", version="1.0.0",
    fields=_SALES_BASE, date_field="sale_date",
))

registry.register(Contract(
    connector="square", entity="products", version="1.0.0",
    fields=_PRODUCTS_BASE,
    notes="Square sends 0.00% cost AND 0.00% category — the worst in the "
          "estate. Both fail; both are one connector ticket.",
))
registry.register(Contract(
    connector="square", entity="sales", version="1.0.0",
    fields=_SALES_BASE, date_field="sale_date",
))

registry.register(Contract(
    connector="korona", entity="products", version="1.0.0",
    fields=_PRODUCTS_BASE,
    notes="Korona measures 88.4% cost and 100% category — comfortably passing. "
          "Recorded because the original sheet asserted Korona was the 0%-cost "
          "connector; it is one of the best.",
))
registry.register(Contract(
    connector="korona", entity="sales", version="1.0.0",
    fields=_SALES_BASE, date_field="sale_date",
))

for _connector in ("mpower", "eposnow", "localdb", "api"):
    registry.register(Contract(
        connector=_connector, entity="products", version="1.0.0",
        fields=_PRODUCTS_BASE,
    ))
    registry.register(Contract(
        connector=_connector, entity="sales", version="1.0.0",
        fields=_SALES_BASE, date_field="sale_date",
    ))


__all__ = [
    "BASE",
    "ENTITIES",
    "Contract",
    "ContractRegistry",
    "FieldSpec",
    "FieldType",
    "coerce",
    "is_present",
    "registry",
]
