"""A stray `%` in a query is a runtime error, and it hides for weeks.

WHAT THIS CAUGHT. `fetch_customer_rows` carried a SQL comment reading
"total_amount is blank on ~5% of receipts". psycopg binds parameters
client-side by scanning the WHOLE query string for `%`, and it does not
understand SQL comments, so that `%` followed by a space is an incomplete
placeholder and the query never reached Postgres:

    ProgrammingError: incomplete placeholder: '%'; if you want to use '%'
    as an operator you can double it up, i.e. use '%%'

It failed every time it ran. Nobody saw it for a month. The Node proxy serves
the cached row first and only logs a failed background refresh as a warning,
so the Customers screen kept drawing numbers computed on 16 September while
every recompute after it died. The bug was invisible precisely because the
screen looked fine.

That is the shape worth a test rather than a fix: the mistake is one character
in a comment, it type-checks, it reads correctly to anyone reviewing it, and
the only signal is a capability that quietly stops being recomputed. Linting
cannot see it, because to Python it is just a string.

WHAT COUNTS AS VALID. psycopg's client-side binding accepts `%s`, `%b`, `%t`,
a named `%(name)s`, and a literal `%%`. Anything else is a defect, wherever it
sits in the statement - comment, string literal or expression.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Where queries live. Scanned as source, not imported: a module that needs a
# live database to import would make this test useless exactly where it
# matters most.
SCAN_DIRS = ("storeagent", "app")

# A query is a string that OPENS with a SQL verb - not merely one that mentions
# one. The first version of this matched any string containing "select ...
# from" and swept in three dozen module docstrings, because the prose in this
# codebase discusses queries and quotes percentages constantly. Anchoring at
# the start is what separates a statement from a paragraph about one.
SQL_RE = re.compile(
    r"\A\s*(?:--[^\n]*\n\s*)*"            # leading SQL comments
    r"(select|insert\s+into|update\s+\w|delete\s+from|with\s+\w)\b",
    re.IGNORECASE,
)

# The calls that hand a string to psycopg. A query reaching the driver by any
# of these is bound client-side, which is where a stray `%` is fatal.
DB_CALLS = frozenset({
    "execute", "executemany", "fetch_all", "fetch_one", "fetch_val",
    "fetchall", "fetchone", "query", "scalar", "copy",
})

# Everything psycopg will accept. `%(name)s` first, so a named placeholder is
# consumed whole rather than matching `%(` and leaving a tail.
PLACEHOLDER_RE = re.compile(r"%(?:\([A-Za-z_][A-Za-z0-9_]*\)[sbt]|[sbt%])")


def _sql_strings() -> list[tuple[Path, int, str]]:
    found: list[tuple[Path, int, str]] = []
    for name in SCAN_DIRS:
        base = ROOT / name
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*.py")):
            if "__pycache__" in path.parts:
                continue
            try:
                tree = ast.parse(path.read_text(encoding="utf-8"))
            except SyntaxError:  # pragma: no cover - not our problem here
                continue
            for node in ast.walk(tree):
                for lineno, text in _query_strings(node):
                    found.append((path, lineno, text))
    return found


def _query_strings(node: ast.AST):
    """Strings from this node that are queries, by either of two readings.

    A string ARGUMENT TO A DB CALL is a query whatever it looks like - that is
    the reading that cannot be fooled. A string that OPENS with a SQL verb is
    a query too, which catches the ones held in a module constant and executed
    somewhere else.
    """
    if isinstance(node, ast.Call):
        fn = node.func
        name = getattr(fn, "attr", None) or getattr(fn, "id", None)
        if name in DB_CALLS:
            for arg in node.args:
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    yield arg.lineno, arg.value
            return
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        if SQL_RE.search(node.value):
            yield node.lineno, node.value


def _offenders(sql: str) -> list[str]:
    """The `%` signs in `sql` that psycopg would refuse."""
    stripped = PLACEHOLDER_RE.sub("", sql)
    out = []
    for m in re.finditer("%", stripped):
        start = max(0, m.start() - 40)
        out.append(stripped[start:m.start() + 20].replace("\n", " ").strip())
    return out


def test_queries_were_actually_found() -> None:
    """A scanner that silently matches nothing proves nothing."""
    found = _sql_strings()
    assert len(found) > 20, f"only {len(found)} SQL strings found; the scan is broken"


def test_no_query_carries_a_percent_psycopg_will_refuse() -> None:
    # A query can be found by both readings (a DB-call argument that also
    # opens with a verb), so report each site once.
    problems = sorted({
        f"{path.relative_to(ROOT)}:{line}  ...{context}..."
        for path, line, sql in _sql_strings()
        for context in _offenders(sql)
    })
    assert not problems, (
        "A `%` that is not a psycopg placeholder. It raises "
        "ProgrammingError every time the query runs, and a cached result will "
        "hide that for as long as the cache lives:"
        + "".join(chr(10) + "  " + p for p in problems)
    )


def test_the_scanner_would_have_caught_the_real_one() -> None:
    """The exact comment that broke the Customers screen for a month."""
    sql = """
        SELECT sum(s.sub_total) AS spend
               -- total_amount is blank on ~5% of receipts
        FROM sales s WHERE s.client_id = %s
        """
    assert SQL_RE.search(sql)
    assert _offenders(sql), "the scanner must flag a % inside a SQL comment"


def test_every_legal_placeholder_is_accepted() -> None:
    sql = ("SELECT * FROM t WHERE a = %s AND b = %(cid)s AND c = %b "
           "AND d = %t AND e LIKE 'x%%'")
    assert not _offenders(sql)
