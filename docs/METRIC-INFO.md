# Info tooltips and the staging query reveal

Two controls now sit beside the figures in the dashboard.

| | Control | Where it shows | What it is |
|---|---|---|---|
| ⓘ | **What this means** | staging **and** production | A plain-English definition of the figure, in a click-to-open popover. |
| ⛁ | **Show the query** | **staging only** | The verified warehouse query that reproduces that exact figure for the signed-in store. |

---

## Why this needed doing

Two separate problems, one shape.

**The definitions were hover-only.** The rebuilt screens carried their explanations
in native `title=""` attributes. A `title` does not exist on touch, takes about a
second to appear, cannot be styled, and gets truncated by the OS. For text a
store owner is meant to read before trusting a number, that is not a tooltip.

**The query reveal was shipping to production.** `storeagent/ui.js` gated it on a
hardcoded `const SHOW_COMPONENT_SQL = true`, so the small database icon rendered
for every store owner. Worse, hiding a button would not have been enough on its
own: `checkSql.js` was a static import, so **all 102 warehouse queries were
compiled into `main.js`** and readable by anyone who opened DevTools. Measured on
the production build before the change:

```
$ grep -o "WITH params AS" build/static/js/main.*.js | wc -l
102
```

Those queries name warehouse tables and columns and spell out how every metric is
derived. They are how *we* check a number that looks wrong. They are not a
product feature.

---

## How the environment flag works

`frontend/src/utils/env.js`

```js
export const APP_ENV = /* 'staging' | 'production' */;
export const IS_STAGING = APP_ENV === 'staging';
export const CAN_REVEAL_SQL = IS_STAGING;
```

Set at **build** time by CRA, which bakes it into the bundle:

| Build | `REACT_APP_ENV` | Result |
|---|---|---|
| `main` branch → `deploy` | `production` | definitions only |
| any other branch | `staging` | definitions + query reveal |
| local `npm start` / `npm run build` | `staging` (from `frontend/.env`) | definitions + query reveal |
| **unset / misspelled** | **`production`** | **definitions only** |

**It fails safe to production.** A build that forgets the variable gets the
bundle with nothing to leak, not the other way round.

`.gitlab-ci.yml` derives it from the branch, so there is nothing new to remember
when cutting a release:

```yaml
if [ "$CI_COMMIT_BRANCH" = "main" ]; then APP_ENV=production; else APP_ENV=staging; fi
docker build --build-arg REACT_APP_ENV="$APP_ENV" ... frontend
```

`frontend/Dockerfile` declares `ARG REACT_APP_ENV=production` — again, the safe
default if the build arg is ever dropped.

### One flag, on purpose

There is deliberately no second `REACT_APP_SHOW_SQL` override, and no way to turn
the reveal on from the browser (a URL parameter or a localStorage key is
reachable by anyone who is told about it).

The one-flag rule is also what makes the exclusion *work*, and this took a
measurement to find. The first version tested two variables:

```js
if (process.env.REACT_APP_ENV === 'staging' || process.env.REACT_APP_SHOW_SQL === 'true') {
```

CRA only substitutes `REACT_APP_*` variables that are actually **set**. With
`REACT_APP_SHOW_SQL` unset, that half stayed a live lookup, the whole expression
became non-static, webpack could not fold the branch — and the 33 kB query chunk
was emitted next to the production bundle anyway, sitting at a guessable URL.
Which is most of the leak it was meant to close.

---

## How the queries stay out of the production bundle

`storeagent/checkSql.js` is now a loader; the queries live in
`storeagent/checkSql.data.js` and are reached by a dynamic import that only a
staging build ever evaluates:

```js
if (process.env.REACT_APP_ENV === 'staging') {
  import(/* webpackChunkName: "check-sql" */ './checkSql.data')...
}
```

CRA substitutes the literal at build time, webpack folds the branch while
parsing, and the import inside it is never registered — so a production build
**emits no chunk at all**. The queries are not hidden. They are absent.

`checkSqlFor(key)` stays synchronous for existing call sites and simply returns
`null` until the chunk lands (and always, in production). `useCheckSqlReady()`
re-renders the controls that decide their own visibility from it — without that,
they would settle the question during the empty first render and never look
again.

---

## What was verified, and how

Both bundles were built and driven in a real headless Chrome against the live
backend (`scratchpad/infoprobe.js`, `coverage.js`). Not read — measured.

**19/19 checks pass.**

Staging:

- every KPI tile has an info control; the same tiles expose the query control
- the definition opens, and is `position: fixed` on `<body>` — it escapes the
  clipping ancestors (`.rh-figures` sets `overflow: hidden` for its rounded
  corners; the table wrappers set `overflow: auto`)
- it lands fully on screen and wins the hit-test at its centre **and** its far
  corner, at 12.5 px
- Escape closes it
- the query control shows real SQL (11,890 chars for the reorder figure) with
  `%(cid)s` already resolved to the signed-in store
- the panel is labelled `staging only`

Production:

- the info controls are all still there and still open
- **no query control anywhere** — new or legacy
- the query chunk is never requested, and a direct `fetch()` for it returns
  `index.html`, because it is not on the server

Recommendations home specifically:

- each key figure has a control, with **no button nested inside a button** (the
  figure tile is itself a navigating `<button>`; browsers unnest that, which in
  practice means the inner control stops receiving clicks — so the controls are a
  sibling layered on top)
- the label text clears the icons by 18–34 px
- the column dividers survived moving from the button to its new wrapper cell

---

## Coverage — 31 controls

| Screen | Figures | ⓘ | ⛁ |
|---|---|---|---|
| AI Recommendations | 4 key figures + the open-value headline | all | 4 |
| Purchasing | 3 tiles + the tab table heading | all | all |
| Market Comparison | 4 tiles + 2 table headings | all | all |
| Customers | 3 tiles + 4 table headings | all | 5 of 7 |
| Effectiveness | 4 table headings | all | none |
| Reports | 4 KPIs + 4 cards | all | none |

### Where the query control is deliberately absent

It renders only where `checkSql.js` has a query that reproduces **that** figure.
Three places it does not, and why:

- **Reports (all 8).** The `overview.*` queries are fixed 30-day windows. Reports
  reads `/api/summary` over a window the user picks, and *Transactions* is the
  latest **day**, not a period at all. Attaching those would put a database icon
  next to a number the query does not reproduce — worse than no icon, because the
  one person who clicks it is the person trying to work out why a number looks
  wrong. Fixing this properly means a query per panel window in `sql_checks/`.
- **Effectiveness (all 4).** Sourced from the recommendation ledger rather than
  the warehouse. There is no `checkSql` key to attach.
- **Customers → “Customer segments”, and the three engagement tiles**
  (*Busiest day*, *Average ticket*, *Single-item trips*). No per-figure query
  exists for these yet.

In every one of those cases the definition still ships. A `sqlKey` with nothing
behind it renders nothing rather than an empty panel, so adding the missing
queries to `sql_checks/` is all it would take to light them up.

---

## Adding one to a new figure

```jsx
import MetricInfo from '../components/MetricInfo';

<span className="ref-tile-label">
  Capital in dead stock
  <MetricInfo
    label="Capital in dead stock"
    info="What you already paid for stock that has not sold recently."
    sqlKey="buying.dont_buy_capital_tied"   // optional; staging only
  />
</span>
```

- Put it **inside** the label, so it rides the label's baseline.
- `info` is written for a store owner: what the number counts, over what window,
  and what it does *not* include. Not the formula.
- `sqlKey` is a key from `storeagent/checkSql.data.js`. Omit it if no query
  reproduces that exact figure — see above.
- If the figure is itself a `<button>`, render the control as a **sibling**, not
  a child (see `.rh-fig-cell`).

---

## Files

| File | Change |
|---|---|
| `frontend/src/components/MetricInfo.js` / `.css` | new — the two controls |
| `frontend/src/utils/env.js` | new — `APP_ENV`, `IS_STAGING`, `CAN_REVEAL_SQL` |
| `frontend/src/storeagent/checkSql.js` | now a loader; gates the dynamic import |
| `frontend/src/storeagent/checkSql.data.js` | new — the 896 KB of queries, split out |
| `frontend/src/storeagent/ui.js` | `SHOW_COMPONENT_SQL` reads the flag instead of `true` |
| `frontend/Dockerfile` | `ARG REACT_APP_ENV=production` |
| `.gitlab-ci.yml` | branch → environment |
| `frontend/.env` | local dev runs as staging |
| `PurchasingScreen`, `CustomersScreen`, `MarketComparisonScreen`, `EffectivenessScreen`, `RecommendationsHome`, `StatisticsPage` (+ `.css`) | controls wired in; `title=` affordances replaced |

---

## How to check the queries are right

Two different questions, with two different answers.

### "Are the queries themselves correct?"

Not my work, and already answered. They are generated from `sql_checks/` in the
Python service (`botella_external_apis`), where each one was row-reproduced
against live StoreAgent output figure by figure. That repo ships its own
verifier:

```
python sql_checks/verify_tables.py     # prints ALL EXACT TABLES MATCH
python sql_checks/verify_all.py
```

`checkSql.data.js` in this repo is generated output - regenerate it with
`python sql_checks/_build_checksql.py`, never edit it by hand.

### "Is the right query attached to the right figure?"

That part IS hand-written, in the `sqlKey` props on the screens, and nothing
else looks at it. So:

```
VERIFY_TOKEN=<a JWT for the store> node backend/scripts/verify-metric-sql.js 171 171
```

For each wired figure it runs the query against the warehouse and compares the
result with what the screen's own API returns. A **MISMATCH** means the icon
opens a query that does not reproduce the number beside it - fix the `sqlKey`.

**Read the cache line first.** `/api/storeagent/*` is a proxy with a cache; when
the Python service is unreachable the API serves the last computed result, which
can be days old, while the script queries the warehouse as it is now. Comparing
those two means nothing, so the script reads the cache age and marks stale
comparisons **INCONCLUSIVE** rather than MISMATCH. A run where everything is
inconclusive has told you only that the recommendation service needs starting.

A real run, 2026-09-08, against a cache 7 days stale:

```
  buying      172.5h old   << STALE
  MATCH         Purchasing / Capital in dead stock       db=61,267.49  api=61,099.27  drift=0.3%
  INCONCLUSIVE  Purchasing / Daily lost sales (est.)     db=846.86     api=513.39     drift=39.4%
  2 match, 0 mismatch, 6 inconclusive (stale cache)
```

The drift tracks how fast each metric moves, which is what you would expect from
staleness rather than from a wrong mapping: capital in dead stock barely changes
in a week and matches to 0.3%, while daily lost sales is volatile and is 39%
apart.

### What this already caught

**"Sales, latest day" was pointed at `overview.revenue_30d`** - a thirty-day
total behind a one-day number. The tile read $3,293; the query returned about
$118,000. That figure now ships with its definition and **no** query icon,
because no per-day query exists in `sql_checks` yet. When one does, put its key
there.

This is the same trap the Reports screen was deliberately kept out of, and it
was still walked into one screen over. If you add a `sqlKey`, run the verifier.
