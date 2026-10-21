#!/usr/bin/env python
"""Fail the build if a recommendation family does not quote a price.

THE DEFECT THIS LOCKS OUT
    Four hardcoded confidences in `app/recommender/families.py` - 0.55, 0.55,
    0.7, 0.6 - and a `units_at_stake` that did not exist. A hand-written
    confidence cannot be ranked against a measured one, so the slate had to be
    carved up by FAMILY rather than by VALUE, and a weak weather card displaced a
    strong reorder while a large weather opportunity could never take more than
    one slot.

    The fix is a contract (`app/pipeline/rank/family.py`). This guard is what
    stops the contract being quietly reverted one family at a time, which is how
    it would go: somebody adds a twelfth family in a hurry, copies the nearest
    example, and the nearest example is the one that still has a literal in it.

TWO RULES
    1. Every `FamilyPick(...)` construction passes `units_at_stake`. It is a
       required field, so Python already enforces its presence - what this
       catches is `units_at_stake=None` and `units_at_stake=0.0` written to get
       past it. A family that cannot compute the units must REFUSE.
    2. No family module hardcodes a confidence. `confidence=0.55` or
       `raw_confidence=0.7` as a literal is the exact defect, so a bare float
       there fails. A confidence must come from a measurement, a registry
       Setting, or a computation over them.

WHY NOT FOLD THIS INTO check_no_literals.py
    That guard scans `app/pipeline` and `storeagent`, and the families live in
    `app/recommender`. Widening its roots would pull in the whole request path at
    once and bury the signal in a baseline of hundreds. A small guard with one
    job is easier to keep honest than a large one with an exemption list.

Usage:
    python scripts/check_families_quote_ev.py            # check (CI + tests)
    python scripts/check_families_quote_ev.py --report   # list, exit 0
"""

from __future__ import annotations

import argparse
import ast
import sys
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

#: Where families are built. Narrow on purpose - see the module docstring.
SCANNED_FILES = (
    "app/recommender/families.py",
    "app/recommender/deterministic.py",
)

#: The contract's constructor, and the legacy one it replaces.
PICK_CONSTRUCTORS = frozenset({"FamilyPick", "ExtraPick"})

#: Keyword arguments that must never be a bare literal.
CONFIDENCE_KEYWORDS = frozenset({"confidence", "raw_confidence"})

#: Floats that are structural rather than a judgement, as in check_no_literals.
ALLOWED_FLOATS = frozenset({0.0, 1.0})


@dataclass(frozen=True)
class Violation:
    path: str
    line: int
    rule: str
    detail: str

    def key(self) -> str:
        return f"{self.path}:{self.line}:{self.rule}"

    def __str__(self) -> str:
        return f"{self.path}:{self.line}  {self.rule}  {self.detail}"


def _is_number(node: ast.expr) -> bool:
    return isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) \
        and not isinstance(node.value, bool)


def check_file(path: Path, rel: str) -> list[Violation]:
    out: list[Violation] = []
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=rel)
    except (OSError, SyntaxError) as exc:          # pragma: no cover - CI noise
        return [Violation(rel, 0, "unparseable", str(exc))]

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = (node.func.id if isinstance(node.func, ast.Name)
                else node.func.attr if isinstance(node.func, ast.Attribute)
                else None)
        if name not in PICK_CONSTRUCTORS:
            continue

        kwargs = {kw.arg: kw.value for kw in node.keywords if kw.arg}

        # Rule 1 - the units must be a real computed quantity.
        if name == "FamilyPick":
            units = kwargs.get("units_at_stake")
            if units is None and not any(kw.arg is None for kw in node.keywords):
                out.append(Violation(
                    rel, node.lineno, "missing_units_at_stake",
                    "a FamilyPick must quote the units the card is about",
                ))
            elif isinstance(units, ast.Constant) and units.value is None:
                out.append(Violation(
                    rel, node.lineno, "units_at_stake_is_none",
                    "None ranks. A family that cannot compute units must refuse",
                ))

        # Rule 2 - no hand-written confidence.
        for kw_name in CONFIDENCE_KEYWORDS:
            value = kwargs.get(kw_name)
            if value is None:
                continue
            if _is_number(value) and float(value.value) not in ALLOWED_FLOATS:
                out.append(Violation(
                    rel, node.lineno, "hardcoded_confidence",
                    f"{kw_name}={value.value} is a literal; it must come from a "
                    f"measurement or a registry Setting",
                ))
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", action="store_true",
                        help="list violations and exit 0")
    args = parser.parse_args(argv)

    violations: list[Violation] = []
    missing: list[str] = []
    for rel in SCANNED_FILES:
        path = REPO_ROOT / rel
        if not path.exists():
            missing.append(rel)
            continue
        violations.extend(check_file(path, rel))

    for rel in missing:
        print(f"[check_families_quote_ev] skipped (not found): {rel}")

    if not violations:
        print("[check_families_quote_ev] ok - every family quotes a price")
        return 0

    for v in sorted(violations, key=lambda x: (x.path, x.line)):
        print(f"[check_families_quote_ev] {v}")
    print(f"[check_families_quote_ev] {len(violations)} violation(s)")
    if args.report:
        return 0
    print(
        "\nA family that cannot compute units_at_stake must REFUSE rather than "
        "pass a sentinel, and a confidence must be measured rather than written. "
        "See app/pipeline/rank/family.py."
    )
    return 1


if __name__ == "__main__":       # pragma: no cover
    sys.exit(main())
