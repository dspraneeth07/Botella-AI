"""Parse `products.pack_size` into an integer, or say why you cannot.

    "12"            -> 12
    "12.0"          -> 12          float-formatted integer
    "6 PK"          -> 6
    "Single"        -> 1           a singular container IS one unit
    "CASE"          -> UNPARSEABLE a case of WHAT? 6, 12 and 24 all exist
    "NULL"          -> UNPARSEABLE the literal four-character string, 2,142 rows
    "-6"            -> UNPARSEABLE
    "12.5"          -> UNPARSEABLE you cannot order half a case

DEFAULTING TO 1 IS WORSE THAN FAILING
    A pack size of 1 silently DISABLES the case-pack constraint: every quantity
    rounds to itself and the recommendation goes out at 37 when the supplier
    ships twelves. The store reads that as "the software does not understand my
    business", which is a judgement that is very hard to reverse.

    So an unparseable value is reported, never defaulted. The caller decides
    whether to withhold the recommendation or show it with the constraint
    marked unavailable - and either of those is honest, where a silent 1 is not.

MEASURED ON THE REAL COLUMN (911,022 product rows, 380 distinct values)
    int          68   "1" (696,196 rows), "12", "24"
    float        52   "12.0" (10,589), "6.0" (8,551), "24.0" (7,302)
    num + text  219   "4 PK", "6-Pack", "1 BOTTLE", and also "-50", "0MG"
    text only    35   "BAG", "BOTTLE", "CASE", "KEGS", "GIFT PACK"
    single-word   6   "Single" (41,986), "SINGLE" (17,068), "EACH"

WHY `uom` CANNOT VALIDATE THE PARSE
    The sheet suggests validating pack size against `uom` (69.9% non-empty -
    confirmed exactly). It cannot: `uom` in this warehouse is CONTAINER VOLUME,
    not units per case. Its top values are 750ML (169,549), 0.0 (98,944),
    1.75L, 375ML, 12OZ. Knowing a bottle is 750ml says nothing about whether
    the case holds 6 or 12 of them.

    So `uom` is used for the one thing it CAN do: a volume-bearing uom on a
    row whose pack_size parsed as a bare container word confirms the row
    describes a single bottle rather than a case. Nothing more is claimed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

#: Words naming a SINGULAR container. These genuinely mean one unit.
SINGULAR_WORDS: frozenset[str] = frozenset({
    "single", "singles", "single bt", "single btl", "each", "ea", "unit",
    "bottle", "botl", "btl", "can", "piece", "pc", "pod", "capsule", "pouch",
    "pair", "king size", "1-pack single", "1 pack single", "can single",
})

#: Words naming a container whose COUNT is unknown. A "CASE" is 6, 12 or 24
#: depending on the product, and guessing is exactly the silent-default this
#: module exists to refuse.
AMBIGUOUS_CONTAINERS: frozenset[str] = frozenset({
    "case", "box", "bag", "carton", "keg", "kegs", "bucket", "kit",
    "gift pack", "gift set", "pack", "pk", "display", "sleeve", "tray",
})

#: The literal string "NULL" appears 2,142 times. It is text, not an absence,
#: and it must not be mistaken for either a number or a null.
LITERAL_NULLS: frozenset[str] = frozenset({"null", "none", "n/a", "na", "-", "--"})

_NUMBER = re.compile(r"-?\d+(?:\.\d+)?")


@dataclass(frozen=True, slots=True)
class ParsedPack:
    """A pack size, or a stated reason there isn't one."""

    raw: Any
    units: int | None
    #: How it was read: "integer" | "float" | "embedded" | "singular_word".
    #: None when unparsed.
    source: str | None
    reason: str | None

    @property
    def ok(self) -> bool:
        return self.units is not None

    def as_dict(self) -> dict[str, Any]:
        return {"raw": self.raw, "units": self.units, "source": self.source,
                "reason": self.reason}


def _fail(raw: Any, reason: str) -> ParsedPack:
    return ParsedPack(raw=raw, units=None, source=None, reason=reason)


def parse_pack_size(raw: Any, uom: str | None = None) -> ParsedPack:
    """Canonicalise one `pack_size` value to a positive integer, or refuse."""
    if raw is None:
        return _fail(raw, "pack_size_is_null")

    text = str(raw).strip()
    if not text:
        return _fail(raw, "pack_size_is_empty")

    lowered = text.lower()
    if lowered in LITERAL_NULLS:
        # Not a null - the four-character STRING "NULL", 2,142 rows of it.
        return _fail(raw, f"pack_size_is_the_literal_string:{text!r}")

    if lowered in SINGULAR_WORDS:
        return ParsedPack(raw, 1, "singular_word", _uom_note(uom))

    if lowered in AMBIGUOUS_CONTAINERS:
        # "CASE" with no number. Refusing beats guessing 12.
        return _fail(raw, f"container_word_without_a_count:{text!r}")

    numbers = _NUMBER.findall(text)
    if not numbers:
        return _fail(raw, f"no_number_in_pack_size:{text!r}")
    if len(numbers) > 1:
        # "12 X 750ML" - which number is the pack? Refusing beats picking one.
        return _fail(raw, f"ambiguous_multiple_numbers:{text!r}")

    value = float(numbers[0])
    if value != int(value):
        return _fail(raw, f"pack_size_is_not_a_whole_number:{text!r}")
    units = int(value)
    if units <= 0:
        return _fail(raw, f"pack_size_is_not_positive:{units}")

    bare_integer = re.fullmatch(r"-?\d+", text) is not None
    bare_float = re.fullmatch(r"-?\d+\.\d+", text) is not None
    source = (
        "integer" if bare_integer
        else "float" if bare_float
        else "embedded"
    )
    return ParsedPack(raw, units, source, _uom_note(uom))


def _uom_note(uom: str | None) -> str | None:
    """The single thing `uom` can honestly contribute.

    `uom` is container VOLUME (750ML, 1.75L, 12OZ), not units per case, so it
    cannot validate a pack count. A volume-bearing uom does confirm the row
    describes a bottle rather than an unlabelled case, which is worth noting
    and is the limit of what it supports.
    """
    if not uom or not str(uom).strip():
        return None
    text = str(uom).strip()
    if re.search(r"\d", text) and text not in {"0.0", "0"}:
        return f"uom_confirms_container:{text}"
    return None


def parse_many(rows: list[tuple[Any, str | None]]) -> tuple[
    list[ParsedPack], dict[str, int]
]:
    """Parse a batch and return the results plus a REPORT of what failed.

    The report is the point. A run that could not parse 4% of its catalogue
    needs to say so, rather than quietly shipping 4% of its recommendations
    with the case-pack constraint switched off.
    """
    parsed = [parse_pack_size(raw, uom) for raw, uom in rows]
    report: dict[str, int] = {}
    for item in parsed:
        if item.reason and not item.ok:
            key = item.reason.split(":")[0]
            report[key] = report.get(key, 0) + 1
    return parsed, report


__all__ = [
    "AMBIGUOUS_CONTAINERS",
    "LITERAL_NULLS",
    "SINGULAR_WORDS",
    "ParsedPack",
    "parse_many",
    "parse_pack_size",
]
