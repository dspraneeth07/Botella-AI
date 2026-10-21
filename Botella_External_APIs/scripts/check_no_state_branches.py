#!/usr/bin/env python
"""Fail the build if any pipeline stage BRANCHES on evidence_state.

`evidence_state` is a DISPLAY LABEL. The arithmetic uses `n`; the label is what
the interface says out loud. The moment a stage writes

    if provenance.evidence_state == "MATURE":
        ...

the architecture has grown a tier gate through the back door — and a tier gate
is the exact thing sheet 06 exists to abolish. It creates a **cliff**: a store
crossing the boundary sees its recommendations jump overnight for no reason it
can observe. And it creates a code path only some stores exercise, so it is
never tested — which is how the rare case becomes the broken case.

Asking for that rule in a review is not enforcement. This is.

WHAT COUNTS AS A BRANCH
    if / elif whose test reads evidence_state
    a conditional expression (x if evidence_state == ... else y)
    while whose test reads it
    match whose subject is it
    any comparison of it, anywhere

WHAT DOES NOT
    ASSIGNING it (`evidence_state="MATURE"`, `evidence_state=derive(n, k)`) —
    producing the label is what the producing stages are for. The check only
    looks at Load context inside a test or comparison, never at Store context.

    The type alias `EvidenceState` (PascalCase) is a different identifier from
    the field `evidence_state` (snake_case) and is never matched.

EXEMPT FILES, and only these two:
    blend/evidence_state.py  derives the label from n and k — its whole job
    provenance.py            validates the value is one of the four

Usage:
    python scripts/check_no_state_branches.py            # check
    python scripts/check_no_state_branches.py --report   # list, exit 0
"""

from __future__ import annotations

import argparse
import ast
import sys
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

#: The trees the rule applies to.
SCANNED_ROOTS = ("app/pipeline", "storeagent")

#: The field name. PascalCase `EvidenceState` is the TYPE and is not this.
FIELD = "evidence_state"

#: Deriving and validating are legitimate; branching downstream is not.
EXEMPT_FILENAMES = frozenset({"evidence_state.py", "provenance.py"})
EXEMPT_DIR_PARTS = frozenset({"tests", "__pycache__", ".venv", "fixtures"})


@dataclass(frozen=True)
class Violation:
    path: str
    line: int
    kind: str
    snippet: str

    def __str__(self) -> str:
        return f"{self.path}:{self.line}  [{self.kind}] {self.snippet}"


def _reads_field(node: ast.AST) -> bool:
    """Does this subtree READ `evidence_state`?

    Load context only. `evidence_state="NEW"` is a keyword argument or a Store
    and must not trip the check — producing the label is the point of the
    stages that produce it.
    """
    for sub in ast.walk(node):
        if isinstance(sub, ast.Attribute) and sub.attr == FIELD:
            if isinstance(sub.ctx, ast.Load):
                return True
        elif isinstance(sub, ast.Name) and sub.id == FIELD:
            if isinstance(sub.ctx, ast.Load):
                return True
        elif isinstance(sub, ast.Constant) and sub.value == FIELD:
            # A dict lookup keyed by the literal string, e.g.
            # HANDLERS[row["evidence_state"]]() — a jump table is a branch.
            return True
    return False


def _snippet(source_lines: list[str], node: ast.AST) -> str:
    line = getattr(node, "lineno", 0)
    if 1 <= line <= len(source_lines):
        return source_lines[line - 1].strip()[:110]
    return ""


def scan_file(path: Path, rel: str) -> list[Violation]:
    try:
        # utf-8-sig: a BOM is invisible to the importer but breaks ast.parse.
        source = path.read_text(encoding="utf-8-sig")
        tree = ast.parse(source, filename=str(path))
    except (SyntaxError, UnicodeDecodeError) as exc:
        return [Violation(rel, 0, "parse", f"could not parse: {exc}")]

    lines = source.splitlines()
    found: list[Violation] = []

    for node in ast.walk(tree):
        if isinstance(node, (ast.If, ast.While)) and _reads_field(node.test):
            found.append(Violation(rel, node.lineno, "branch", _snippet(lines, node)))
        elif isinstance(node, ast.IfExp) and _reads_field(node.test):
            found.append(Violation(rel, node.lineno, "conditional",
                                   _snippet(lines, node)))
        elif isinstance(node, ast.Match) and _reads_field(node.subject):
            found.append(Violation(rel, node.lineno, "match", _snippet(lines, node)))
        elif isinstance(node, ast.Compare) and _reads_field(node):
            found.append(Violation(rel, node.lineno, "comparison",
                                   _snippet(lines, node)))
        elif isinstance(node, ast.Subscript) and _is_dispatch(node):
            # HANDLERS[p.evidence_state] - a jump table IS a branch, just one
            # spelled with brackets. Without this the rule is trivially
            # sidestepped by a dict of callables.
            found.append(Violation(rel, node.lineno, "dispatch",
                                   _snippet(lines, node)))
    return found


def _is_dispatch(node: ast.Subscript) -> bool:
    """Is this indexing something BY evidence_state?

    The distinction that makes the rule usable:

        row["evidence_state"]              a plain READ - allowed
        HANDLERS[row["evidence_state"]]    a JUMP TABLE - a branch
        HANDLERS[p.evidence_state]         ditto

    A bare Constant slice is the first shape; anything that reaches the field
    through a Name, Attribute or nested Subscript is the second.
    """
    slice_node = node.slice
    if isinstance(slice_node, ast.Constant):
        return False
    return _reads_field(slice_node)


def _should_scan(path: Path) -> bool:
    if path.name in EXEMPT_FILENAMES:
        return False
    return not (EXEMPT_DIR_PARTS & set(path.parts))


def collect(root_dir: Path = REPO_ROOT) -> list[Violation]:
    violations: list[Violation] = []
    for root in SCANNED_ROOTS:
        base = root_dir / root
        if not base.exists():
            continue
        for path in sorted(base.rglob("*.py")):
            if not _should_scan(path):
                continue
            violations.extend(scan_file(path, path.relative_to(root_dir).as_posix()))
    return violations


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", action="store_true", help="list, exit 0")
    parser.add_argument("--root", type=Path, default=REPO_ROOT)
    args = parser.parse_args(argv)

    violations = collect(args.root)

    if args.report:
        for v in violations:
            print(f"  {v}")
        print(f"\n{len(violations)} branch(es) on {FIELD}")
        return 0

    if violations:
        print(
            f"\n[check_no_state_branches] {len(violations)} stage(s) BRANCH on "
            f"{FIELD}:\n", file=sys.stderr,
        )
        for v in violations:
            print(f"  {v}", file=sys.stderr)
        print(
            f"\n{FIELD} is a DISPLAY LABEL. Branch on `n` instead - that is what "
            "the shrinkage formula uses, and it has no cliff. A label gate "
            "makes a store's recommendations jump when it crosses a boundary, "
            "for a reason the owner cannot see.",
            file=sys.stderr,
        )
        return 1

    print(f"[check_no_state_branches] ok - nothing branches on {FIELD}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
