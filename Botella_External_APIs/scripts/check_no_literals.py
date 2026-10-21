#!/usr/bin/env python
"""Fail the build on magic numbers in the pipeline.

Rule 3, enforced. A float literal sitting in a calculation is a judgement with
no owner, no unit, no stated reason and no record of whether it was ever
measured. The engine accumulated 63 of them and not one was revisited, because
nothing made them visible. Thresholds belong in ``app/pipeline/registry.py``
as declared Settings; everywhere else a bare float is a defect.

0.0 and 1.0 are exempt. They are almost never thresholds — they are identity
elements, probability bounds and empty accumulators — and banning them would
generate noise that teaches people to add the suppression comment reflexively.

SECOND RULE: ambient reads inside a stage. ``datetime.now()``, ``date.today()``,
``os.environ`` and friends are what RunContext exists to replace. One clock
read inside one stage destroys replay for every run that touches it, and
because the output still looks reasonable it will not be noticed for months.
This is cheaper to catch here than in a post-mortem.

BASELINE
    ``storeagent/`` already contains ~48 grandfathered float literals — the
    very constants this rule exists to surface. Blocking every commit until
    they are all migrated would just get the check deleted, so existing
    violations are recorded in a baseline file and only NEW ones fail. The
    baseline is a debt list: it is printed on every run, it can only shrink,
    and ``--update-baseline`` refuses to grow it.

Usage:
    python scripts/check_no_literals.py              # check (CI + tests)
    python scripts/check_no_literals.py --report     # list the debt, exit 0
    python scripts/check_no_literals.py --update-baseline
"""

from __future__ import annotations

import argparse
import ast
import json
import sys
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
BASELINE_PATH = Path(__file__).resolve().parent / "no_literals_baseline.json"

#: Trees the rule applies to.
SCANNED_ROOTS = ("app/pipeline", "storeagent")

#: Exempt. registry.py is where numbers are SUPPOSED to live; tests assert on
#: concrete values by definition; generated/vendored trees are not ours.
EXEMPT_FILENAMES = frozenset({"registry.py"})
EXEMPT_DIR_PARTS = frozenset({"tests", "__pycache__", ".venv", "fixtures"})

#: Floats that are structural rather than judgements.
ALLOWED_FLOATS = frozenset({0.0, 1.0})

#: The one call whose `default=` may be a bare float.
#:
#: Sheet 07 was the first to need a float-valued threshold (the published
#: Syntetos-Boylan cuts, 1.32 and 0.49) declared OUTSIDE registry.py, and this
#: check flagged them - while its own error message told the author to "declare
#: thresholds as a Setting with an owner, a unit and a reason", which is
#: exactly what they were. The rule was never "no floats"; it is "no
#: UNEXPLAINED numbers", and a Setting is the explanation. Every earlier sheet
#: happened to use integer defaults, so the gap went unnoticed.
#:
#: Deliberately narrow: ONLY the `default` keyword, and ONLY of a call spelled
#: `Setting(...)` - a scalar, or the elements of one literal sequence (sheet 17
#: declares volume-class cut points that way). A float anywhere else in the
#: same file is still a violation,
#: which `test_the_guard_still_catches_a_bare_float_beside_a_setting` proves.
SETTING_CALL = "Setting"
SETTING_DEFAULT_KEYWORD = "default"

#: Ambient reads that break replay. (dotted call or attribute, explanation)
AMBIENT_CALLS: dict[str, str] = {
    # The clock. The single worst one: a stage that reads it still returns a
    # perfectly reasonable-looking number, so nothing fails, and every run
    # that touched it is quietly unreplayable.
    "datetime.now": "use ctx.as_of",
    "datetime.utcnow": "use ctx.as_of",
    "date.today": "use ctx.as_of",
    "time.time": "use ctx.as_of",
    "time.monotonic": "timing belongs to the @stage decorator",
    # The environment.
    "os.getenv": "declare it in app/pipeline/registry.py and read it with cfg.get",
    # Anything stochastic.
    "random.random": "use ctx.seed",
    "random.randint": "use ctx.seed",
    "random.choice": "use ctx.seed",
    "random.shuffle": "use ctx.seed",
    "random.sample": "use ctx.seed",
    "uuid.uuid4": "identifiers belong in RunContext",
    # Database. The sheet names "connection object" explicitly: a stage that
    # opens one is reading data that is not in its input, so its output can
    # never be reproduced from the audit row. That is exactly how the
    # dead-stock tile came to say 454 while chat said 485 - two readers going
    # to the data separately, each applying its own rule.
    "psycopg.connect": "the stage's data belongs in its input",
    "psycopg2.connect": "the stage's data belongs in its input",
    "sqlalchemy.create_engine": "the stage's data belongs in its input",
    "create_engine": "the stage's data belongs in its input",
    "app_conn": "the stage's data belongs in its input",
    "source_conn": "the stage's data belongs in its input",
    # Network. Same argument, plus a stage that makes a call is a stage whose
    # output depends on when it ran.
    "httpx.get": "fetch upstream OUTSIDE the stage and pass the result in",
    "httpx.post": "fetch upstream OUTSIDE the stage and pass the result in",
    "httpx.Client": "fetch upstream OUTSIDE the stage and pass the result in",
    "httpx.AsyncClient": "fetch upstream OUTSIDE the stage and pass the result in",
    "requests.get": "fetch upstream OUTSIDE the stage and pass the result in",
    "requests.post": "fetch upstream OUTSIDE the stage and pass the result in",
    "requests.request": "fetch upstream OUTSIDE the stage and pass the result in",
    "urlopen": "fetch upstream OUTSIDE the stage and pass the result in",
    "socket.socket": "fetch upstream OUTSIDE the stage and pass the result in",
}
AMBIENT_ATTRS: dict[str, str] = {
    "os.environ": "declare it in app/pipeline/registry.py and read it with cfg.get",
}

#: The ambient rule applies only where stages live. storeagent/ is legacy and
#: is only in scope for the float rule until it is ported.
AMBIENT_ROOTS = ("app/pipeline",)


@dataclass(frozen=True)
class Violation:
    path: str
    line: int
    kind: str  # "float" | "ambient"
    detail: str

    @property
    def key(self) -> str:
        """Baseline identity. Deliberately excludes the LINE NUMBER: adding an
        import above a grandfathered constant must not read as a new
        violation, or the baseline becomes unusable noise."""
        return f"{self.path}|{self.kind}|{self.detail}"

    def __str__(self) -> str:
        return f"{self.path}:{self.line}  [{self.kind}] {self.detail}"


def _dotted(node: ast.AST) -> str:
    """'datetime.now' from a Name/Attribute chain; '' if it is not one."""
    parts: list[str] = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    return ""


def _ambient_match(name: str, table: dict[str, str]) -> str | None:
    """Match a dotted name against the ambient table, full name or last pair.

    Both ``datetime.now()`` (from a `from datetime import datetime`) and
    ``datetime.datetime.now()`` (from `import datetime`) are the same sin, and
    only the first spelling is worth listing. Matching the trailing pair
    catches the qualified forms - including ones reached through an alias -
    without listing every import style anyone might use.
    """
    if name in table:
        return name
    parts = name.split(".")
    if len(parts) > 2:
        tail = ".".join(parts[-2:])
        if tail in table:
            return tail
    return None


def _should_scan(path: Path) -> bool:
    if path.name in EXEMPT_FILENAMES:
        return False
    return not (EXEMPT_DIR_PARTS & set(path.parts))


def scan_file(path: Path, rel: str, *, ambient: bool) -> list[Violation]:
    try:
        # utf-8-sig, not utf-8: a BOM is invisible to the Python importer but
        # ast.parse rejects it as a non-printable character, which would have
        # reported a perfectly valid module as unparseable.
        tree = ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))
    except (SyntaxError, UnicodeDecodeError) as exc:
        return [Violation(rel, 0, "parse", f"could not parse: {exc}")]

    found: list[Violation] = []
    declared = _declared_setting_defaults(tree)
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, float):
            # bool is not a float, but complex/NaN reach here; compare safely.
            if node.value not in ALLOWED_FLOATS and id(node) not in declared:
                found.append(Violation(rel, node.lineno, "float", repr(node.value)))
        if not ambient:
            continue
        if isinstance(node, ast.Call):
            hit = _ambient_match(_dotted(node.func), AMBIENT_CALLS)
            if hit:
                found.append(
                    Violation(rel, node.lineno, "ambient", f"{hit}() - {AMBIENT_CALLS[hit]}")
                )
        elif isinstance(node, ast.Attribute):
            hit = _ambient_match(_dotted(node), AMBIENT_ATTRS)
            if hit:
                found.append(
                    Violation(rel, node.lineno, "ambient", f"{hit} - {AMBIENT_ATTRS[hit]}")
                )
    return found


def _declared_setting_defaults(tree: ast.AST) -> set[int]:
    """Float nodes that are the `default=` of a `Setting(...)` call.

    Identified by node identity rather than by value, so that a Setting default
    of 0.49 does not also excuse a bare 0.49 elsewhere in the same file.

    A default may be a SEQUENCE as well as a scalar - sheet 17 declares volume
    class boundaries as `default=(0.1, 0.5, 2.0, 10.0)`, which is one declared
    threshold that happens to have four cut points. Its elements are exempt for
    exactly the same reason the scalar is: they are declared, with an owner, a
    unit and a reason. Nesting stops at the sequence, so a computed expression
    inside a default is still a violation.
    """
    allowed: set[int] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = (
            func.id if isinstance(func, ast.Name)
            else func.attr if isinstance(func, ast.Attribute)
            else None
        )
        if name != SETTING_CALL:
            continue
        for keyword in node.keywords:
            if keyword.arg != SETTING_DEFAULT_KEYWORD:
                continue
            value = keyword.value
            if (isinstance(value, ast.Constant)
                    and isinstance(value.value, float)):
                allowed.add(id(value))
            elif isinstance(value, (ast.Tuple, ast.List, ast.Set)):
                for element in value.elts:
                    if (isinstance(element, ast.Constant)
                            and isinstance(element.value, float)):
                        allowed.add(id(element))
    return allowed


def collect(root_dir: Path = REPO_ROOT) -> list[Violation]:
    violations: list[Violation] = []
    for root in SCANNED_ROOTS:
        base = root_dir / root
        if not base.exists():
            continue
        ambient = root in AMBIENT_ROOTS
        for path in sorted(base.rglob("*.py")):
            if not _should_scan(path):
                continue
            rel = path.relative_to(root_dir).as_posix()
            violations.extend(scan_file(path, rel, ambient=ambient))
    return violations


def load_baseline(path: Path = BASELINE_PATH) -> set[str]:
    if not path.exists():
        return set()
    data = json.loads(path.read_text(encoding="utf-8"))
    return set(data.get("grandfathered", []))


def write_baseline(violations: list[Violation], path: Path = BASELINE_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "_comment": (
            "Grandfathered magic numbers predating the stage envelope (sheet 00). "
            "This list may SHRINK, never grow: new violations fail the build. "
            "Burn it down by moving each constant into app/pipeline/registry.py "
            "as a declared Setting."
        ),
        "grandfathered": sorted({v.key for v in violations}),
    }
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", action="store_true", help="list everything, exit 0")
    parser.add_argument("--update-baseline", action="store_true")
    parser.add_argument("--no-baseline", action="store_true", help="fail on every violation")
    parser.add_argument("--root", type=Path, default=REPO_ROOT)
    parser.add_argument("--baseline", type=Path, default=BASELINE_PATH)
    args = parser.parse_args(argv)

    violations = collect(args.root)

    if args.update_baseline:
        previous = load_baseline(args.baseline)
        added = {v.key for v in violations} - previous
        if previous and added:
            print("Refusing to grow the baseline. New violations:", file=sys.stderr)
            for key in sorted(added):
                print(f"  {key}", file=sys.stderr)
            return 1
        write_baseline(violations, args.baseline)
        print(f"baseline written: {len({v.key for v in violations})} grandfathered")
        return 0

    baseline = set() if args.no_baseline else load_baseline(args.baseline)
    fresh = [v for v in violations if v.key not in baseline]
    grandfathered = len(violations) - len(fresh)

    if args.report:
        for v in violations:
            mark = " " if v.key in baseline else "*"
            print(f"{mark} {v}")
        print(f"\n{len(violations)} total, {len(fresh)} new, {grandfathered} grandfathered")
        return 0

    if grandfathered:
        # Printed on every run: debt that is invisible is debt that grows.
        print(f"[check_no_literals] {grandfathered} grandfathered magic numbers remain "
              f"(see {args.baseline.name}; move them into the registry)")

    if fresh:
        print(f"\n[check_no_literals] {len(fresh)} NEW violation(s):\n", file=sys.stderr)
        for v in fresh:
            print(f"  {v}", file=sys.stderr)
        print(
            "\nDeclare thresholds in app/pipeline/registry.py as a Setting with an "
            "owner, a unit and a reason. Ambient reads belong in RunContext.",
            file=sys.stderr,
        )
        return 1

    print("[check_no_literals] ok - no new magic numbers")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
