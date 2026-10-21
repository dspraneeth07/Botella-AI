"""Generate frontend/src/storeagent/checkSql.js with a query PER COMPONENT:
- each scalar figure -> the section's CTE + a SELECT of just that one column
  (key "section.column")
- each table -> a dedicated table query (TABLE_SQL below, key "section.table")
The full-section keys are kept too. Run: ./.venv/bin/python sql_checks/_build_checksql.py
"""
import json
import os
import re
from sql_checks.verify_all import SQLS

# Path to the generated frontend file. Override with CHECKSQL_DST since the
# frontend lives in a sibling repo whose absolute path differs per machine.
DST = os.environ.get(
    "CHECKSQL_DST",
    "/Users/anirudh/Desktop/BottleAI_v1/BottleAI/frontend/src/storeagent/checkSql.js",
)


def split_final(sql):
    """Return (cte_prefix, final_select) by finding the one depth-0 SELECT."""
    depth = 0
    for i in range(len(sql)):
        c = sql[i]
        if c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
        elif depth == 0 and sql[i:i + 6].upper() == 'SELECT' and (i == 0 or not (sql[i - 1].isalnum() or sql[i - 1] == '_')):
            return sql[:i], sql[i:]
    raise ValueError("no depth-0 SELECT")


def parse_cols(final):
    body = final[6:]  # after SELECT
    # depth-0 FROM
    depth = 0
    from_pos = None
    for i in range(len(body)):
        c = body[i]
        if c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
        elif depth == 0 and body[i:i + 4].upper() == 'FROM' and (i == 0 or not body[i - 1].isalnum()) and not body[i + 4].isalnum():
            from_pos = i
            break
    cols_str = body[:from_pos] if from_pos is not None else body
    from_clause = body[from_pos:] if from_pos is not None else ''
    # Strip -- comments BEFORE splitting: a comma inside a comment ("..., not
    # annualized") is not a column separator — leaving it in generated a broken
    # per-stat query (SELECT not annualized ...) for market.margin_left_total.
    cols_str = re.sub(r'--[^\n]*', '', cols_str)
    # split by depth-0 commas
    cols = []
    depth = 0
    start = 0
    for i, c in enumerate(cols_str):
        if c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
        elif c == ',' and depth == 0:
            cols.append(cols_str[start:i])
            start = i + 1
    cols.append(cols_str[start:])
    out = []
    for col in cols:
        col = col.strip()
        if not col:
            continue
        m = re.search(r'\bAS\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*$', col, re.I)
        if m:
            out.append((m.group(1), col))
    return out, from_clause.strip()


CHECK = {}
for section, sql in SQLS.items():
    CHECK[section] = sql  # keep the full-section query
    prefix, final = split_final(sql)
    cols, from_clause = parse_cols(final)
    for name, col in cols:
        q = prefix + "SELECT " + col + ("\n" + from_clause if from_clause else "")
        CHECK[f"{section}.{name}"] = q

# ---- table queries (hand-written, verified separately) ---------------------
from sql_checks import table_sql  # noqa: E402
for key, q in table_sql.TABLE_SQL.items():
    CHECK[key] = q

order = sorted(CHECK)
lines = ["// Auto-generated from sql_checks/. One query PER COMPONENT: scalar keys are",
         "// 'section.column' (the section CTE + a single SELECT); table keys are",
         "// 'section.table'. %(cid)s is replaced with the logged-in store.",
         "/* eslint-disable */",
         "export const CHECK_SQL = {"]
for k in order:
    lines.append(f"  {json.dumps(k)}: {json.dumps(CHECK[k])},")
lines += ["};", "",
          "export function checkSqlFor(key) {",
          "  let store = 'YOUR_CLIENT_ID';",
          "  try { store = localStorage.getItem('botella_client_id') || store; } catch (e) {}",
          "  const sql = CHECK_SQL[key];",
          "  return sql ? sql.split('%(cid)s').join(store) : null;",
          "}"]
open(DST, "w").write("\n".join(lines) + "\n")
print("wrote", DST)
print("keys:", len(CHECK))
