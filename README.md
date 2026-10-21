# Botella

AI agent for liquor stores. Tells store owners what to reorder, what's about to
move, who their best customers are — and answers natural-language questions
about inventory, sales and customers in real time.

**Three services.** A React app, an Express API, and a Python recommendation
engine. The engine is deterministic: **no model chooses what to recommend.**

---

## TL;DR — running everything

```bash
# one-time
npm ci --prefix backend && npm ci --prefix frontend
cp backend/.env.example backend/.env          # ask for the real values
cp frontend/.env.example frontend/.env
cd Botella_External_APIs && python -m venv .venv && .venv/Scripts/pip install -e ".[dev]" && cd ..

# every time — three terminals
npm start --prefix backend                                   # API      :3000 (PORT)
npm start --prefix frontend                                  # web app  :3001
cd Botella_External_APIs && uvicorn app.main:app --reload --port 8000
```

Open **http://localhost:3001**.

**Ports.** The defaults are **3000** for Node and **8000** for Python, and the
production compose (`deploy/docker-compose.prod.yml`) keeps them. Four variables
move them, and they have to move *together* or the services stop finding each
other: `PORT` in `backend/.env` (where Node listens), `REC_SERVICE_URL` and
`STOREAGENT_API_URL` in `backend/.env` (where Node finds the Python service —
both point at the same uvicorn, the second with `/storeagent` appended),
`NODE_API_BASE_URL` in `Botella_External_APIs/.env` (where Python calls back into
Node), plus uvicorn's own `--port` to match. `SELF_BASE_URL` in `backend/.env`
(the URL the nightly Python scripts call back on) follows `PORT`, and the
frontend dev server proxies `/api` to whatever `proxy` names in
`frontend/package.json`. The current **local override** on the development
laptop, since 19 October 2026 because another project holds 3000, is Node on
**3010** and Python on **8010**: `PORT=3010`,
`REC_SERVICE_URL=http://127.0.0.1:8010`,
`STOREAGENT_API_URL=http://127.0.0.1:8010/storeagent`,
`SELF_BASE_URL=http://127.0.0.1:3010`, `NODE_API_BASE_URL=http://127.0.0.1:3010`,
`uvicorn … --port 8010`, `frontend/package.json` `proxy` at 3010 and
`.claude/launch.json` at 3010. A fresh clone that copies the `.env.example`
files gets the 3000/8000 defaults.

**Check the wiring before anything else.** `npm run doctor --prefix backend`
reads the env files and says which database each one actually points at. It is
worth ten minutes of confusion: `ANALYTICS_DATABASE_URL` is read by *nothing* at
runtime — the server uses the `ANALYTICS_PG_*` parts — so an environment where
the two disagree writes to one database and reads from another, and every symptom
looks like missing data rather than a misconfiguration.

**Migrations apply themselves at boot** outside production, so the first
`npm start --prefix backend` on a fresh clone creates the analytics schema. You
only need `npm run migrate --prefix backend` by hand when you want to see what
would run, or when `NODE_ENV=production` turns boot-time migration off.

> `.env` files are git-ignored and must stay that way — they hold the warehouse
> password, the JWT signing secret and three vendor API keys. Anyone with that
> file could read every tenant's sales data and mint a token for any store.

---

## Generating recommendations for one store

The thing you probably want first. The engine is an HTTP service; the daily batch
just calls it in a loop.

```bash
# the work endpoints are key-protected — the key lives in
# Botella_External_APIs/.env as SERVICE_API_KEY
KEY=$(grep -E "^SERVICE_API_KEY=" Botella_External_APIs/.env | cut -d= -f2-)

curl -s -X POST -H "X-API-Key: $KEY" \
     http://127.0.0.1:8000/run-recommendations/171/171 | jq .
```

The path is `/{client_id}/{location_id}`; for every pilot store they are the same
number. Without the header you get a 401, which is the first thing most people
hit.

**An empty slate is a valid 200.** A store whose POS has never synced returns
`recommendations: []` with `candidate_count: 0` rather than an error — "nothing
on the shelf" is the truth about the shelf, not a failed request.

**Every store runs nightly.** `REC_CRON_LOCATIONS` defaults to `ALL`; set it to a
comma-separated `client:location` list to narrow it to a pilot.

| job | when | what it does |
|---|---|---|
| recommendation batch | 04:00 | generates and persists a slate per store |
| evaluation | 05:00 | scores finished windows against what actually sold |
| store gate | 06:00 | decides which stores may display cards |
| calibration refit | 07:00 | refits the confidence curve on new outcomes |
| signal-effect fit | Sun 08:00 | refits what each external signal is worth |

The order matters and is not an accident: the gate judges on outcomes, so it has
to run after the evaluation that produces them.

**The last three shell out to Python.** They run `gate_eval.py`,
`publish_calibration.py` and `publish_signal_effects.py`, which import
`app.pipeline` and nothing else — that package is pure stdlib, so they need an
interpreter and the source, with no virtualenv and no installed dependencies.
The backend resolves the interpreter in this order, and says at startup whether
it found one:

| variable | default | when to set it |
|---|---|---|
| `PYTHON_BIN` | the sibling `.venv`, then `python3` on `PATH` | the interpreter is somewhere else |
| `PYTHON_SCRIPTS_DIR` | `Botella_External_APIs/scripts` | the two checkouts are not side by side |
| `SIGNAL_FIT_DATA` | `audit/data` | the gzipped sales exports live elsewhere |

The backend image sets the first two itself and carries both halves, so a
container needs none of them. Watch for `[Python jobs] ready` in the log on
boot — the alternative is one caught error a night, which is how an estate goes
a month without gating and nobody notices.

---

## The 60-second demo — prove the engine works

No servers, no database, no API key. Just the transaction export:

```bash
cd Botella_External_APIs
.venv/Scripts/python scripts/real_engine_backtest.py \
    --data ../audit/data --file store_171_sale_items.csv.gz \
    --store "Bethany Discount Liquor" --every 14 --out run/
```

`--file` is not optional in practice: the default filename is an old export that
is no longer in the repository, so the command without it exits `not found`.

~50 seconds → `run/REAL_ENGINE_REPORT.html`, a **self-contained** page with five
charts that opens offline and can be emailed as one attachment.

It backtests **the production modules in `app/pipeline`** — not a copy of them —
across 3.7 years of one store's real transactions:

| | |
|---|---:|
| Hit rate | **75.9%** (clustered 95% CI 70.3–80.7) |
| Random-pick baseline | 31.9% |
| **Reversion-matched baseline** *(the hard one)* | **59.2%** → **+16.7 pts** |
| p-value | 0.0005 (pooled permutation) |
| Decision dates scoring ≥50% | **45 of 52** |

Full detail and the caveats: **[ENGINE-ARCHITECTURE-AND-RESULTS.md](docs/ENGINE-ARCHITECTURE-AND-RESULTS.md)**

---

## What's where

```
BottleAI-gitlab/
├── backend/                  Express API · Postgres pools · Claude integration
│   ├── routes/               /api/* (chat, dashboard, recommendations, …)
│   ├── services/             recommendation gate, feature store, eval, lift
│   ├── lib/lift.js           THE lift definition (twinned in Python)
│   └── tests/                29 verification suites
├── frontend/                 React app on :3001
├── Botella_External_APIs/    Python FastAPI service + the engine
│   ├── app/pipeline/         THE ENGINE — pure stdlib, no numpy/scipy/sklearn
│   ├── storeagent/           read-only warehouse access (the only DB dep)
│   ├── scripts/              backtest, ledgers, publishers, build guards
│   └── tests/                1,898 tests
├── audit/                    generated evidence — start at audit/index.html
└── docs/                     SHEET-00..20, one per architectural decision
```

**Three databases.** `syncgo` (POS warehouse, **SELECT-only by design**),
`bottleai_analytics` (**Node is the only writer**), `storeagent`.
Python holds **no analytics credentials** and opens no connection to them.

---

## Commands you'll actually use

### Tests

```bash
cd Botella_External_APIs
.venv/Scripts/python -m pytest tests/ -q          # 1,898 tests, ~35s
.venv/Scripts/python scripts/check_no_literals.py       # no magic numbers
.venv/Scripts/python scripts/check_no_state_branches.py # no branch on evidence state
.venv/Scripts/python scripts/config_report.py           # what's still a guess

cd backend
node tests/lift-parity-verify.js        # Python and JS agree digit-for-digit
node tests/outcome-feedback-verify.js
node tests/redteam-verify.js            # SQL-injection guard
```

Six backend suites need a server on `:3100` (`audit-verify`, `fixfinal-verify`,
`reaudit-fixes`, `round5-e2e`, `routing-eval`, `metric-spike-eval`) and
`hallucination-eval` needs network.

### The engine, on one real store

```bash
cd Botella_External_APIs
node ../backend/scripts/export-pipeline-input.js 171 171 --top 25 > input.json
.venv/Scripts/python scripts/run_pipeline.py  input.json   # → forecast
.venv/Scripts/python scripts/run_decisions.py input.json   # → validated cards
```

`run_decisions.py` goes all the way to the sentence an owner reads, plus the
check that every numeral in it traces back to a validated figure. **No model is
called** — it deliberately takes the degraded path, which is the point: a model
outage costs fluency, never a recommendation.

### Backtest options

```bash
--data   folder holding bethanys_sale_items_2023_2026.csv.gz   (required)
--every  decision date every N trading days   (default 14 → 52 dates, ~50s)
--out    output folder                        (default run_real_engine)
```

Lower `--every` for more dates and tighter intervals; it costs runtime roughly
linearly.

### Database migrations

```bash
npm run migrate --prefix backend           # apply to bottleai_analytics
npm run migrate:status  --prefix backend
npm run migrate:dry-run --prefix backend
```

Applied migrations are immutable: the runner checksums each file and warns
`EDITED after being applied` rather than re-running it. Fix forward with a new
numbered file. Note that two features landed on 023–025 independently, so those
numbers appear twice — the runner orders and tracks by full filename, so both
apply, but do not assume the number is unique.

### Reports and evidence

```bash
cd Botella_External_APIs
# a month of cards per store, each followed for 30/60/90/120 days
.venv/Scripts/python scripts/run_all_ledgers.py \
    --data ../audit/data --out ../audit --month 2026-03

# every store on one page, then the folder's front door
.venv/Scripts/python scripts/build_combined_ledger.py --audit ../audit --month 2026-03
.venv/Scripts/python scripts/build_audit_home.py     --audit ../audit --month 2026-03
```

A month can only be published once it has **120 days of outcomes behind it**, so
the newest publishable month trails the data by four months. Deleting
`audit/calibration/` forces the confidence curve to refit, which is necessary
after any change to selection — a curve fitted on one population and applied to
another is a real bug, not a stale cache.

### Refitting what the external signals are worth

```bash
cd Botella_External_APIs
.venv/Scripts/python scripts/publish_signal_effects.py \
    --stores 171,176,177,178,181 --data ../audit/data --dry-run
```

It fits every (signal × drink family) cell and **publishes the refusals too** —
on the current estate 7 of 525 cells earn an effect a card may cite. It also
fits `friday` as a placebo and **exits non-zero if that earns one**, because a
Friday has no business carrying a demand effect once day-of-week is controlled
for. A non-zero exit means the controls are not working and the numbers cannot
be trusted.

---

## How the engine decides

```
feature store (open days, never calendar days)
   → evidence n  → cohort prior
   → TEMPORAL REVERSION   shrink the recent rate toward the SKU's own long run
   → shrinkage (own ↔ cohort) → forecast p10/p50/p90
   → inventory policy → constraints → typed candidates
   → RANK:  expected value = margin × DEFICIT   (never total demand)
   → validation (5 gates) → explanation → numeral check
   → the gate: has this actually worked at THIS store?
```

**The one idea that made it work.** A 28-day window is a *biased* estimate of
demand — it over-states a product that just spiked and under-states one that
just went quiet. The old engine ranked on that number, so it selected the SKUs
whose windows were most **inflated**, which are exactly the ones that fall back.
It scored **31%** and was destroying measurable margin. Ranking on the
**deficit** — the units the current plan *misses* — scores **76%**.

Every threshold is a declared `Setting` with an owner, a unit and a stated
reason, so `config_report.py` can answer *"how much of this is still guesswork"*
on any run. Currently **112 settings, 102 still provisional** — run
`config_report.py` for the live count.

---

## Reading the documentation

| start here | |
|---|---|
| [ENGINE-ARCHITECTURE-AND-RESULTS.md](docs/ENGINE-ARCHITECTURE-AND-RESULTS.md) | architecture, stack, measured results, **and what they don't prove** |
| [ANALYTICS-SCHEMA.md](docs/ANALYTICS-SCHEMA.md) | every table in `bottleai_analytics`, and why each exists |
| [ENGINE-REBUILD.md](docs/ENGINE-REBUILD.md) | the index — one row per sheet |
| [SHEET-20-TEMPORAL-REVERSION.md](docs/SHEET-20-TEMPORAL-REVERSION.md) | the change that moved the number |
| [SHEET-00-STAGE-ENVELOPE.md](docs/SHEET-00-STAGE-ENVELOPE.md) | the contract every stage obeys |

Sheets 01–19 cover ingestion, contracts, the feature store, cohort priors,
shrinkage, forecasting, calibration, elasticity, inventory policy, constraints,
candidates, ranking, validation, explanation, the gate, the interface and the
outcome loop. Each records **what was measured and what is still assumed.**

---

## Four rules every sheet inherits

1. **Open days, never calendar days.** A store shut on Sundays trades ~24 days
   a month; dividing by 28 understates every rate by 14%.
2. **No magic numbers.** Every threshold is a registry `Setting` with an owner
   and a reason. Enforced by `check_no_literals.py` on every commit.
3. **Refusing is a valid answer.** A forecast too wide to order against
   produces no card, rather than a confident-looking midpoint.
4. **No model in the selection path.** The LLM writes prose about a decision
   that is already fixed. Every card replays from its recorded inputs.

---

## Known gaps — stated, not hidden

- **The live path still runs the old generator.** Sheets 12–16 and 20 are wired
  to each other but not yet to the request that serves a store. This is the gap
  between the backtest above and an owner seeing it.
- **Measured on one store.** Bethany's Discount Liquor. Another tenant could
  look materially different.
- **The 7-day lead time is declared, never measured.** Nothing in the warehouse
  records when an order actually arrived — `purchase_orders` has the right
  columns and zero rows.
- **No historical shelf counts**, so understock/overstock recommendations are
  absent from every measured result.
- **Causation is unproven.** Nobody acted on the backtested recommendations.
  The holdout mechanism exists (`REC_HOLDOUT_PCT`) and needs switching on.

---

## Build changelog

Newest builds at the top. Each build documents user-visible changes and engineering work, so you can answer the question *"what's different from the previous build?"* by reading top-to-bottom.

### Build — 2026-06-09 (Removed Email Automation + Socials/Image-Gen + video generation)

Stripped three half-shipped modules out of the codebase entirely. Each was already dead or hidden for the end user — behind commented-out nav, a disabled import, or an unfinished `501` stub — and the decision was to remove rather than keep dead code on standby. All three are recoverable from git history if ever revived.

**User-visible**

- **"Socials" / Image Generator removed.** The DALL·E image generation + Instagram/Facebook posting tab is gone. It was already hidden from the sidebar (commented out) and reachable only by typing `/marketing` directly; that route now renders nothing.
- **Email Automation removed.** The Gmail-OAuth "send promotions / inbox / replies" feature is gone. It was already fully disabled (the `EmailPage` import was commented out and `/email` rendered a blank pane).
- **Video generation removed.** The `/api/imagegen/generate/video` endpoint (an unfinished Gemini stub that returned `501 Not Implemented`) went with the rest of the image-gen module.
- **No change to any live feature.** Chat, Dashboard, chat history, voice input, CSV download, the Suggestions / Market-Analysis "Coming Soon" stubs, and the entire public marketing site are untouched.

**Files removed**

- Frontend: `components/ImageGenPage.js` + `.css`, `components/EmailPage.js` + `.css`.
- Backend: `routes/imagegen.js`, `routes/email.js`, and the entire `helpers/` directory (8 `imagegen-*.js` files: caption, db, gemini, meta, openai, prompts, scraper, styles).

**Files updated**

- `frontend/src/pages/ChatPage.js` — removed the `ImageGenPage` import, the commented `EmailPage` import, the `marketing` + `email` entries in `VALID_VIEWS`, the `?email_connected` OAuth-callback effect, the `onMarketing` Sidebar prop, the `marketing` render block, and the now-unused `Image` lucide icon.
- `frontend/src/App.js` — dropped `/marketing` and `/email` from `APP_VIEW_PATHS`.
- `frontend/src/components/Sidebar.js` — removed the `onMarketing` prop, both commented-out "Socials" buttons, and the now-unused `Image` icon import.
- `backend/server.js` — removed the `/imagegen-files` static mount, the Gmail + Meta OAuth callbacks, the `/api/email` + `/api/imagegen` route mounts, the daily promo-email cron, and the now-unused `node-cron` / `googleapis` / `fs` requires.
- `backend/package.json` — dropped 5 now-unused deps: `openai`, `googleapis`, `node-cron`, `multer`, `xlsx`. (`better-sqlite3` kept — still used by `database/schema.js`; `nodemailer` kept — still used by `routes/leads.js`.)
- `.gitignore`, `frontend/public/robots.txt`, `architecture.md` — stale references to the deleted routes / components / data dirs removed.

**Operational**

- **Run `npm install` in `backend/`** after pulling — `package.json` lost 5 deps, so the lockfile needs reconciling (a plain `npm install` does it; `npm ci` would otherwise fail).
- **Backend restart required** — route mounts and the cron schedule changed.
- Build verified: `CI=true npm run build` compiles clean; JS bundle unchanged, CSS −3.32 kB (the two deleted component stylesheets no longer bundled).
- Runtime data left untouched on purpose: any existing `backend/data/imagegen/` images and `gmail_token_*` files are now orphaned but were NOT deleted (git-ignored runtime artifacts, not code).

### Build — 2026-05-22 (BOTELLA ticket sprint + streaming overhaul + CSV downloads + v3 SEO + marketing-site polish + self-maintained docs)

> ⚠ **POST-BUILD AMENDMENT (Jun 1 2026):** developer `sajan@techmaticsys.com` committed `573afe9e "prompt changes according to sales data, temp 0, history 5"` and `a8d99b62 "prompt changes for inventory fix"`, which rolled back three pieces of this build. **Phase 1 (`dataContextCache` TTL + per-turn `fetchDataSnapshot`), Phase C (`backend/lib/metrics.js` + the 4 named typed tools — `get_category_sales_for_date`, `get_most_expensive_products`, `get_earliest_customer_of_day`, `get_sales_by_hour`), and the streaming-pipeline `COMMIT_DELAY_MS=0` JS-side buffer pattern are NO LONGER in the codebase.** Whether this was intentional (prompt-quality decision) or accidental (large rewrite that didn't notice the deletions) wasn't documented in the commit messages. The bullets below describing those three items are kept for build-history fidelity, but they do not reflect the current HEAD. Phases A, B, D, the SSE-layer streaming fixes (`setNoDelay`, `X-Accel-Buffering`, `flushSync`, `useLayoutEffect`, rAF yield, animation:none), CSV download, SMTP migration, marketing-site polish, and the new docs system all survived and ARE in the current HEAD.

A big-batch build covering five themes that all landed together: (1) a four-phase fix-it sprint closing 15 of the open BOTELLA Jira tickets the QA team filed (data freshness, security leaks, wrong answers, broken pagination, table column shift), (2) **rebuilt streaming pipeline** so chat replies now reveal token-by-token like ChatGPT/Claude.ai, (3) **new "Download all rows" CSV feature** for chat tables, (4) **v3 SEO content rewrite** across home + 7 sub-pages, (5) marketing-site polish (icon removal, home-page section reordering, layout-bug fix), plus a new **self-maintained docs system** (`context.md` / `architecture.md` / `agent-log.md`) so future agents and human devs can trace why every change was made.

**User-visible — chat behaviour**

- **Chat streams token-by-token.** Previously short answers (under ~200ms generation) appeared in a single paint. Now visible reveal at Anthropic's natural emission rate.
- **"Download CSV" downloads ALL rows** — not just the 20 visible in chat. The bot tells you "you have 802 low-stock items, here are the first 20…" and the CSV button downloads all 802 (capped at 5,000).
- **Markdown tables keep column alignment** — empty cells now render as `—` so columns to the right don't shift left. Closes BOTELLA-11.
- **"What is today's sale?" anchors to today's actual date** — stops the "today is April 29" hallucination that surfaced weeks after the dashboard had moved on. Data-context cache now has a 5-minute TTL and every chat turn pulls a fresh `MAX(sale_date)` snapshot.
- **List answers lead with the true count.** "Show me low-stock items" now answers *"You have **802 low-stock items**. Here are the first 20 …"* with the full table below. Closes BOTELLA-20.
- **Customer UUIDs never leak in chat answers** — server-side regex pass strips them BEFORE the response streams. Closes BOTELLA-22.
- **SQL queries never leak in chat answers** — fenced and bare SQL blocks stripped. Closes BOTELLA-23.
- **Most-expensive product shows ALL ties** (not just one). Closes BOTELLA-12.
- **Sales-by-category for a given date uses the canonical category** from the product catalogue. Closes BOTELLA-6.
- **"Earliest customer of day"** returns the right customer. Closes BOTELLA-21.
- **"Morning vs afternoon sales"** now answers (was previously "I wasn't able to retrieve…"). Buckets into Morning 00–11 / Afternoon 12–17 / Evening 18–23. Closes BOTELLA-24.
- **Generic product searches no longer auto-filter to in-stock.** Stock filter only applies when the user explicitly asks for "available" / "in stock" items. Closes BOTELLA-17.
- **Bot stops caving on pushback.** "Are you sure?" now triggers a re-verify-then-respond cycle instead of immediate "you're absolutely right" capitulation.
- **Transient Anthropic errors retry silently** (up to 3 attempts, exponential backoff). Users only see "Temporarily Unavailable" when all retries fail. Closes BOTELLA-16.
- **Currency on the dashboard shows full precision** (`$1,234,567.89`) instead of K/M abbreviations. Chart axis ticks still abbreviate. Closes BOTELLA-15.

**User-visible — marketing site**

- **v3 SEO content rewrite** across home + 7 SEO sub-pages (Retailers, AI Agent, Inventory, Customer Insights, Sales Analytics, Margin Optimization, Product Recommendations). Hero subheading + intro paragraph reworked, "What is Botella AI?" bullet checklist near top, comparison table trimmed to 6 rows, Smart Selling cards removed, FAQ + Final CTA rewritten verbatim from v3 doc.
- **Distilleries page + Auto Reordering page + Red Bull promo image removed** end-to-end (routes, nav links, sitemap, comparison-table rows, references). These are **hard no's** going forward — see `context.md` §4.
- **70 emoji card icons removed** across LandingPage + 7 SEO sub-pages (📦 👤 🤖 📊 💰 🪦 ❤️ etc.). Cards now read as deliberately-designed product copy rather than auto-generated AI prose. Functional ✓ checkmarks and `$`/`%` typographic chars kept; WhatsApp + email mockup emojis kept (they simulate real customer messages).
- **Home page sections reorganised:**
  - Proven Results: dropped the 3 pill bullets, swapped 3-metric → 4-metric bar (30% stockouts / Day 1 no-training / 40% admin tasks / 15% margin)
  - Metrics bar: 3-col → 4-col grid (mobile falls back to 2×2)
  - **NEW bottom split:** "What is Botella AI?" (left) side-by-side with "GET STARTED — Let Botella run the work" CTA (right). Collapses to single column under 980px.
  - "Why Liquor Stores Need an AI Agent" restored to its original mid-page position (between Automation and Comparison Table) — the elevator-pitch belongs beside the contact CTA, the pain-points stand on their own mid-page.
- **InventoryPage card-layout fixed.** Cards on "Liquor Inventory Management" + "Business Impact" sections were rendering with each heading word on its own line ("Reduced" / "Stockouts", "Inventory Optimization" overflowing into description). Root cause: a 3-column grid CSS rule reserved 64px for the emoji icon — when the icons were removed, headings orphan-placed into the narrow column. Reverted to standard h3-above-p block layout.
- **New favicon set** — purple-gradient rounded-square "B" monogram. SVG + 32×32 + 192×192 + apple-touch-icon. Generated by a Pillow script (`frontend/public/_build_favicon.py`).
- **Site header/footer** now use an image logo (`/logo.png`) instead of gradient-text wordmark. Header height + chat-header alignment refined.
- **Dropdown menus highlight the active page** (Solutions ▾ / Features ▾ show an accent pill on the current sub-page).
- **Bing Webmaster verification meta tag** added to `index.html`.

**User-visible — lead pipeline**

- **"Book a demo" notifications actually arrive in your inbox.** Gmail OAuth client had been silently 401-ing for ~2 months; replaced with `nodemailer` + Gmail SMTP using an App Password. Fans out to 3 configurable recipients (comma-separated `NOTIFICATION_EMAIL` env var). `replyTo` set to the visitor's email so hitting Reply goes back to the lead directly.

**Behind the scenes**

- **`backend/lib/responseSanitizer.js`** (NEW) — server-side regex pass that strips UUIDs + SQL from every SSE delta and from every fully-assembled response. Two surfaces: `sanitizeText` (one-shot) and `createStreamingSanitizer()` (with a 40-char hold-back tail so patterns spanning delta boundaries are still caught). Also normalises markdown table rows (empty inner cells → `—`).
- **`backend/lib/metrics.js`** (NEW) — 4 typed canonical-query functions backing the named tools (`getCategorySalesForDate` / `getMostExpensiveProducts` / `getEarliestCustomerOfDay` / `getSalesByHour`). Each runs hardcoded SQL with tenant filters baked in + an 8-second query timeout. The LLM can't get these queries wrong because it doesn't write them.
- **`backend/routes/chat.js`** got the heaviest rework:
  - Phase 1 (data freshness): TTL on `dataContextCache`, uncached per-turn `fetchDataSnapshot()`, `## CURRENT DATA SNAPSHOT` block in system prompt.
  - Phase A (security): sanitiser wired into `streamClaude`; SQL-pattern regex tightened to remove a "Create" false positive (BOTELLA-7).
  - Phase B (prompt): anti-sycophancy + result-set-sizing + no-auto-stock-filter rules added.
  - Phase C (named tools): 4 typed tools registered BEFORE `run_sql` in `TOOLS[]`; PREFERRED NAMED TOOLS section in system prompt routes user questions to them.
  - Phase D (resilience): `isRetryableClaudeError` + 3-attempt exponential backoff in `streamClaude` (retry suppressed once any text has been streamed).
  - **Streaming-pipeline overhaul** — three-layer fix to make per-token reveal work:
    1. `COMMIT_DELAY_MS: 800 → 200 → 0` — the JS-side buffer was swallowing short answers whole.
    2. `openSSE()` now calls `res.socket.setNoDelay(true)` to disable Nagle's algorithm (was coalescing per-token `res.write` calls into ~40ms TCP batches) AND sets `X-Accel-Buffering: no` unconditionally.
    3. (frontend) `flushSync` to defeat React 18 batching + `useLayoutEffect` in `StreamingBubble` to write innerHTML synchronously + `await requestAnimationFrame` between deltas to yield a paint frame.
  - **CSV download pipeline** — new `downloadCache` Map (1-hour TTL) stashes the SQL string of every `run_sql` result with >5 rows under a 16-hex-char id; the id is returned in `tool_result` and surfaces in Claude's answer as a `[download:ID]` marker. New `GET /api/chat/csv/:id` route verifies tenant match, strips trailing LIMIT/OFFSET, runs with `LIMIT 5000`, streams RFC-4180 CSV.
- **`backend/routes/leads.js`** — full migration from `googleapis` Gmail OAuth to `nodemailer` SMTP. Transport verified at startup (`transporter.verify()`) so a bad SMTP password fails LOUDLY in `logs/error.log` instead of silently dropping leads. `NOTIFICATION_RECIPIENTS` parsed from comma-separated env var with dedupe.
- **`frontend/src/pages/ChatPage.js`** — streaming-side rewrite (removed the old rAF typewriter, added `flushSync` + `useLayoutEffect` + rAF yield); BOTELLA-11 table-column-fix in `buildTable` + `renderStreaming`; CSV button click handler now fetches from `/api/chat/csv/:id` when a `data-download-id` is present, falls back to the embedded `data-csv` payload otherwise; `renderMarkdown` parses `[download:HEXID]` markers, attaches the id to the closing table's CSV button, hides the marker from output; `renderStreaming` hides the marker during streaming too. Plus various cleanup passes (removed dead `streamingBufferRef`, condensed iteration-trail comments, etc.).
- **`frontend/src/styles/global.css`** — `.chat-message:has(.chat-bubble-streaming) { animation: none }` so the 300ms `chatFadeIn` doesn't mask the per-token reveal for short responses.
- **`frontend/src/components/PageEffects.css`** — InventoryPage card-layout regression fixed (removed the orphan 64px grid column left over from the emoji-icon removal).
- **`frontend/src/components/Dashboard.js`** — `fmtMoney` returns full precision (`$1,234,567.89`); axis tick formatters still abbreviate.
- **New self-maintained docs system at repo root:**
  - **`context.md`** (NEW, 177 lines) — project identity, multi-tenant model, roles, hard-no's (Distilleries / Reordering / Red Bull), code-style conventions, the 9 chat-prompt rules, and the §7 "read before, log after" workflow rule.
  - **`architecture.md`** (NEW, 347 lines) — repo layout, backend route map, chat turn lifecycle diagram, the three-layer streaming pipeline explained, response-sanitiser internals, CSV download pipeline, tenant-filter enforcement, named typed tools, frontend render pipeline (`StreamingBubble` / `renderMarkdown` / `buildTable`), lead pipeline, auth, logging, and a "where to look for X" cheatsheet.
  - **`agent-log.md`** (NEW, rolling) — every meaningful change in this build is logged here with timestamp, files touched, why, and verify steps. Acts as the audit trail.
  - **`.gitignore`** updated with `!architecture.md` so the case-insensitive `ARCHITECTURE.md` rule on Windows doesn't silently swallow the new lowercase tracked file.
- **Distilleries + Auto Reordering pages removed end-to-end** — deleted `frontend/src/pages/seo/DistilleriesPage.js`, `ReorderingPage.js`, `frontend/public/screenshots/promo-redbull.{png,webp}`. Updates to App.js (imports + routes), SiteHeader.js + SiteFooter.js (nav + active-page highlighting), `sitemap.xml` (URLs), `LandingPage.js` (comparison-table rows trimmed).

**Files added (8)**
- `backend/lib/responseSanitizer.js`
- `backend/lib/metrics.js`
- `context.md`, `architecture.md`, `agent-log.md`
- `frontend/public/favicon.svg` + `favicon-32x32.png` + `favicon-192x192.png` + `apple-touch-icon.png`
- `frontend/public/_build_favicon.py`

**Files removed (5)**
- `frontend/src/pages/seo/DistilleriesPage.js`
- `frontend/src/pages/seo/ReorderingPage.js`
- `frontend/public/screenshots/promo-redbull.png` + `.webp`
- (And 70 inline emoji card-icon spans across LandingPage.js + 7 SEO sub-pages, plus a dead `streamingBufferRef` in ChatPage.js)

**Files updated (25+)** — `backend/routes/chat.js`, `backend/routes/leads.js`, `backend/package.json` (nodemailer), `backend/.env`, `frontend/src/pages/ChatPage.js`, `frontend/src/pages/LandingPage.js` + `.css`, all 7 `frontend/src/pages/seo/*.js`, `frontend/src/components/Dashboard.js`, `SiteHeader.js`, `SiteFooter.js`, `PageEffects.css`, `frontend/src/App.js`, `frontend/public/index.html` (favicon links + Bing verification), `frontend/public/sitemap.xml`, `frontend/src/styles/global.css`, `frontend/src/pages/ContactPage.js`, `.gitignore`.

**Operational**

- Build verified: `CI=true npm run build` compiles clean. JS ~222 kB gzipped (well within budget), CSS ~38 kB gzipped.
- **Backend restart required** after pulling this build — new `/api/chat/csv/:id` route, SMTP transport, streaming-flush changes, and named-tool registry all need the Node process to reload. `Ctrl+C` and `npm start` in `backend/`.
- **Required env vars in `backend/.env`** (new since previous build): `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER=<gmail account>`, `SMTP_PASS=<16-char Gmail App Password>`, `NOTIFICATION_EMAIL=<comma-separated recipients>`.
- **Verify after deploy:**
  - Chat: ask *"what is today's sales?"* — bot anchors to actual MAX(sale_date), not a stale literal date.
  - Chat: ask *"show me low-stock items"* — true count up front, 20-row table, CSV button downloads ALL rows.
  - Chat: send any prompt — bubble reveals token-by-token. If it appears one-shot, hard-refresh (Ctrl+Shift+R) — the dev server isn't picking up the new bundle hash.
  - Contact form: submit a test lead — all three `NOTIFICATION_EMAIL` recipients receive a copy within seconds; Reply hits the lead's email directly.
  - InventoryPage: confirm the feature cards + Business Impact cards have headings on their own line above descriptions, not wrapped word-by-word.

**Known follow-ups (not blocking launch)**

- The streaming-overhaul `setNoDelay(true)` only fires for SSE responses opened via `openSSE()`. Any future streaming endpoint that bypasses that helper will silently re-introduce the Nagle-coalescing bug — documented in `openSSE`'s comment block.
- CSV download cache is process-local — if the backend gets replicated behind a load balancer, sticky sessions OR move the cache to Redis.
- The `[download:ID]` marker depends on Claude reliably emitting it after every partial table. If Claude forgets, the user gets only the visible-rows CSV (the embedded fallback). Worth a backend audit log to count missing-marker turns.
- 3 BOTELLA tickets (8 / 9 / 19) were diagnosed but root-caused at the data-ingest layer, not the chat layer — triage separately.
- The `.page-inventory .cp-feat-card` layout regression fixed in this build was caused by the emoji-icon removal leaving an orphan 64px grid column. The same pattern likely exists in `.page-retailers / .page-customers / .page-analytics / .page-margin / .page-recommend / .page-distilleries` — audit those per-page CSS rules in a follow-up pass before users report similar wrapping bugs there.
- The 30% / 15% metrics in the new 4-metric Proven Results bar are an explicit v3-doc deviation — v3 only listed 2 metrics (40% admin tasks + Day 1 no training). The owner asked to bring the other two back. If a future v4 SEO doc lands, reconcile.

---

### Build — 2026-05-13 (SEO v2 brief + tracking + a11y polish)

This build folds in everything from the **v2 SEO Changes** doc plus a long tail of polish: rewritten home page, two new legal pages, refreshed tracking codes, structured data for rich results, an Open Graph image, full form validation on the contact page, click-to-toggle dropdowns for touch users, and a sitewide email change.

**User-visible**

- **Home page** rewritten per v2 brief:
  - Hero subheading + paragraph updated (now mentions customer engagement, marketing, follow-ups)
  - **NEW section** *"What is Botella AI?"* — positions Botella as a 24/7 AI manager with a 7-item green checklist. Moved to the **bottom of the page** in a 2-column split with the final CTA on the right (was originally between hero and metrics)
  - **NEW section** *"Botella AI automates the work behind your store"* — 6 cards covering Social Media · Email · WhatsApp · Smart Follow-Ups · Customer Journey · Operational Tasks. Slots in between the feature grid and "Why AI"
  - Pain points in "Why AI" grew from 6 to 9 (added Inconsistent Follow-Ups · Missed Marketing Opportunities · Lost Upsell Potential)
  - Comparison table grew from 5 rows to 7 (added Social Automation · WhatsApp Messaging · Follow-Up Automation)
  - FAQ replaced with v2's 5 questions (added "Can Botella AI automate customer communication?" and "Can Botella AI improve liquor store sales?")
  - Final CTA renamed: **"Let Botella run the work. You run the store."**
  - Removed the "2s Average response time" stat from the metrics bar; metrics row is now 4 cells instead of 5
- **Contact page** (`/contact`) updated per v2 spec:
  - Form fields: Full Name, Business Email, **Phone Number (new)**, Company / Store Name, Business Type dropdown (Liquor Store / Multi-Location Retailer / Distillery / Other), Message
  - Submit button: **"Book My Demo"**
  - New final CTA section: *"Ready to modernize your liquor store?"*
  - **Full client-side validation** on every required field: name, email, phone, company, message. Per-field red border + inline error message + auto-scroll-to-first-error on submit. Errors clear as the user types.
- **NEW** `/privacy-policy` — 11-section Privacy Policy with effective date, GDPR/CCPA rights, cookie disclosure, retention, etc.
- **NEW** `/terms-and-conditions` — 14-section Terms with acceptance, IP, disclaimers, $100 liability cap, Delaware governing law.
- **Sitewide email change**: every `hello@` / `sales@` / `support@` / `partners@` / `legal@` / `privacy@` `botella.ai` reference now points to **`info@botella.ai`** (26 occurrences across 14 files). Backend lead-notification default also updated.
- **Open Graph image** (`/og-image.png` 1200×630) shipping with the build. LinkedIn / WhatsApp / Slack / Twitter shares of any page now show a branded preview with the gradient "Botella" wordmark, tagline, and URL.
- **Header polish**:
  - Removed the small gradient dot next to the wordmark (cleaner, just the gradient text)
  - Added a **Home** link to the nav (before Solutions ▾)
  - Nav font size bumped 14 → 16 → **18px**, weight 500 → **600**, color near-full text, hover lights up indigo
  - Theme toggle button rotates 15° on hover, gets a softer ring
  - **Login** button is now a gradient pill with a shine-sweep animation on hover
  - Active-route indicator (small glowing dot) under the current page link
- **Click-to-toggle dropdowns** — Solutions ▾ / Features ▾ now work on **touch devices** (tap to open, tap again to close, tap outside / Esc to close). Mouse hover still works exactly as before. Triggers are real `<button>` elements with `aria-haspopup` + `aria-expanded` so screen readers announce state correctly.
- Removed the placeholder dropdown icons inside Solutions / Features menus — clean text-only items matching the design reference.
- Automation section description widened so "Botella handles them automatically." no longer wraps awkwardly onto a second line.

**Behind the scenes**

- **SPA pageview tracking** (`utils/usePageView.js`) — fires `gtag('config', …)` + `dataLayer.push({ event: 'pageview', … })` on every route change. Without this, only the initial page load was tracked. First-load guard prevents double-counting. Errors swallowed so analytics glitches can't break the page.
- **Schema.org JSON-LD** (`components/JsonLd.js` + `buildFaqSchema()` helper):
  - Sitewide: `Organization` + `WebSite` + `SoftwareApplication` injected directly into `index.html`
  - Per-page `FAQPage` schema on home + AIAgentPage + InventoryPage + CustomerInsightsPage + SalesAnalyticsPage + ContactPage. Each FAQ array is a module-level constant powering both the visible UI and the schema, so they can never drift apart.
  - Should unlock FAQ-accordion rich results in Google over time. Verify with the [Rich Results Test](https://search.google.com/test/rich-results) after deploy.
- **Tracking codes refreshed in `public/index.html`** per v2 brief:
  - Google Search Console verification → `nyhMWXSi1g86fYnecow8cmO0cp_Evth8tW3nW4n5ajo`
  - Google Analytics 4 → `G-R69CLRQEKW` (was `G-SD15NVYJ5X`)
  - **Microsoft Clarity** added — project `wpb2me9jdw`
  - Default OG + Twitter card meta tags hard-coded in `<head>` so non-JS crawlers still get a preview
- **Backend `/api/leads`** (`backend/routes/leads.js`):
  - `NOTIFICATION_EMAIL` default → `info@botella.ai` (override via env var to fan out to multiple recipients)
  - Accepts the optional `meta` payload from the Contact form (name, phone, company, businessType, message) and stores all of it on the saved lead
  - Notification email subject dynamically includes the company name when present
  - Email body lists every populated field (skips empty ones so popup-only leads stay clean)
- **OG image generator** (`public/_build_og_image.py`) — Pillow-based script that builds the 1200×630 PNG from scratch. Re-run anytime you want to refresh the image. Falls back gracefully if Inter / Arial Black aren't installed.
- **`useSEO` extended** with a `DEFAULT_OG_IMAGE` constant — every page that doesn't pass a custom image falls back to `/og-image.png`. Plus `og:image:width` / `og:image:height` meta tags for predictable rendering.

**Files added (7)**

- `frontend/src/pages/PrivacyPolicyPage.js`
- `frontend/src/pages/TermsAndConditionsPage.js`
- `frontend/src/pages/LegalPage.css`
- `frontend/src/utils/usePageView.js`
- `frontend/src/components/JsonLd.js`
- `frontend/public/og-image.png`
- `frontend/public/_build_og_image.py`

**Files updated (15+)**

- `frontend/src/App.js` — added Privacy / Terms routes, mounted `<PageViewTracker />` inside `<DemoPopupProvider>`
- `frontend/src/pages/LandingPage.js` + `.css` — all v2 home-page changes + bottom split + new automation section + What-Is section
- `frontend/src/pages/ContactPage.js` + `.css` — v2 form fields + full validation + final CTA + per-field error styling
- `frontend/src/components/SiteHeader.js` + `.css` — Home link, click-to-toggle dropdowns, font bump, button reset, focus ring, gradient Login button
- `frontend/src/components/SiteFooter.js` — Privacy/Terms/Contact links now go to real pages
- `frontend/src/utils/useSEO.js` — default OG image + dimension meta tags
- `frontend/public/index.html` — refreshed GA4 ID + Search Console token + Microsoft Clarity + OG defaults + 3 sitewide JSON-LD scripts
- `frontend/public/sitemap.xml` — added `/contact`, `/privacy-policy`, `/terms-and-conditions`
- `backend/routes/leads.js` — accepts `meta` payload, sends notifications to `info@botella.ai`, dynamic subject + body
- All 9 SEO pages + 5 with FAQs — `info@botella.ai` swap + FAQPage schema on the 5 that have FAQs

**Operational**

- Build verified: `npm run build` compiles clean. JS ~226 KB gzipped, CSS ~29 KB gzipped — both well under the budget the previous build set.
- **Verify after deploy**: open Chrome DevTools → Network → filter `google-analytics.com` and click around the site; each route change should fire a `collect` request. Same for `clarity.ms`.
- **Verify schema**: paste any page URL into the [Rich Results Test](https://search.google.com/test/rich-results) — `Organization`, `WebSite`, `SoftwareApplication`, and `FAQPage` (where present) should all parse.
- **Verify OG**: paste the home URL into the [LinkedIn Post Inspector](https://www.linkedin.com/post-inspector/) and the [Facebook Sharing Debugger](https://developers.facebook.com/tools/debug/) — preview should show the gradient "Botella" image.
- **Submit sitemap**: Google Search Console + Bing Webmaster Tools → submit `https://botella.ai/sitemap.xml`.

**Known follow-ups (not blocking launch)**

- Real product screenshots to replace the in-page CSS mockups (chat card, inventory table, charts) — current mockups look great but the brief wants actual product captures eventually.
- **301 redirects + force HTTPS + force non-www** per v2 brief — hosting / DNS config, not frontend. Configure at CloudFront / Netlify / Nginx.
- Customer logos bar on home ("Trusted by …") once pilot customers agree to be named.
- Real status page (or remove the "All systems operational" footer badge if no status page).

---

### Build — 2026-05-11 (SEO overhaul + 9 new landing pages)

**User-visible**

- Home page rewritten for SEO per the *Botella AI — SEO Changes & New Landing Pages* brief:
  - New H1: **"Best AI Agent for Liquor Stores"**, with new subheading + intro paragraph
  - New section after hero: *"What is the best AI agent for liquor stores?"*
  - New section: *"Proven Results for Liquor Stores Using AI"* (heading over the metrics bar)
  - All 6 feature card titles renamed to keyword-rich versions (e.g. "Inventory" → "AI Inventory Management for Liquor Stores"); each card now links to its dedicated feature page
  - New section: *"Why Liquor Stores Need an AI Agent"* (5 pain points) before Store Intelligence
  - New section: *"Botella AI vs Traditional Liquor Store Software"* — 5-row comparison table
  - SEO microcopy line added under Automatic Updates and Smart Selling sections
  - New 4-question FAQ section before the CTA
  - Footer now shows LinkedIn (fixed URL), Facebook, and Instagram icons
- **9 new public landing pages**, each fully crawlable with its own Meta Title, Meta Description, canonical URL, H1, structured H2/H3 content, and FAQ block:

  | Page | URL |
  |---|---|
  | AI Agent for Liquor Stores | `/ai-agent-for-liquor-stores` |
  | For Retailers | `/ai-for-liquor-retailers` |
  | For Distilleries | `/ai-for-distilleries` |
  | AI Inventory Management | `/ai-inventory-management-liquor-stores` |
  | Customer Insights & Behavior | `/customer-insights-liquor-stores` |
  | Sales Analytics & Insights | `/liquor-store-sales-analytics-insights` |
  | Automated Reordering & Forecasting | `/automated-reordering-liquor-stores` |
  | Margin Optimization & Profit Intelligence | `/margin-optimization-liquor-stores` |
  | AI Product Recommendations | `/ai-product-recommendations-liquor-stores` |

- Every new page uses a shared `ContentLayout` (top nav with dropdown for Features + 4-column footer with full site map). Mobile menu collapses the nav into a hamburger.

**Behind the scenes**

- `frontend/src/utils/useSEO.js` — lightweight hook to set `<title>`, `<meta name="description">`, `<link rel="canonical">`, and Open Graph / Twitter card tags per route. No react-helmet dependency added; we just imperatively upsert tags into `<head>` on mount.
- `frontend/src/components/ContentLayout.js` + `ContentLayout.css` — shared shell used by all 9 SEO pages. Includes auto scroll-to-top on `location.pathname` change (otherwise visitors land mid-page after a route change).
- `frontend/src/pages/seo/` — 9 new page components, one per route. Content sourced verbatim from the SEO brief.
- `frontend/src/App.js` — added `SEO_PUBLIC_PAGES` route array (data-driven so future renames touch one place).
- `frontend/src/pages/LandingPage.js` + `LandingPage.css` — extended for the new home-page sections; existing structure preserved.
- `frontend/public/sitemap.xml` — new sitemap listing all 10 public URLs (home + 9 SEO pages) with `lastmod=2026-05-11`.
- `frontend/public/robots.txt` — added, allows all crawlers and points to the sitemap.

**Operational**

- **Build verified**: `npm run build` compiles cleanly. JS bundle +18.97 KB gzipped (213.6 KB total), CSS +1.68 KB gzipped (21.4 KB total) — well within budget for a content-heavy site.
- **No backend changes**, no DB changes, no env-var changes. SEO pages are pure frontend additions.
- **Sitemap submission**: after deploying, submit `https://botella.ai/sitemap.xml` in Google Search Console and Bing Webmaster Tools to speed up indexation.
- **Canonical URLs** all point to `https://botella.ai/...` — if the live domain ever changes, update the `canonical` value in each page's `useSEO({...})` call.

**Known follow-ups (out of scope for this build)**

- The pages currently render text-only image placeholders (`<div class="cp-image-list">`) where the brief calls for screenshots/charts. Real images need to be exported from the product UI and added to `frontend/public/` then referenced via `<ImageRun>`-equivalent.
- A few SEO pages mention WhatsApp + email alerts — those flows aren't wired to the auto-digest backend yet (still on the roadmap).
- One stray garbled emoji (`🖼️`) was in the original brief on the Automated Reordering page — silently stripped.

**Styling refinement #6 — 404 / Not Found page**

Closes the gap that any unknown URL (e.g. visitor clicks a stale link or typos a slug) was rendering as a blank page. Now we have a proper branded 404:

- New `pages/NotFoundPage.js` + `NotFoundPage.css` — wrapped in the same `ContentLayout` as every SEO page, so the site header + footer stay consistent and visitors can navigate out via the nav, footer, or the suggested links on the page itself.
- New `<Route path="*">` catch-all in `App.js` — must be the LAST route so it only catches what nothing else matched.
- The page shows:
  - Giant gradient "404" using the brand indigo→purple gradient (matches the wordmark)
  - "Page not found" heading
  - The user's typed path shown in a monospace pill (`<code>{location.pathname}</code>`) so they can see exactly which URL didn't match
  - Two CTAs: **← Back to Home** and **Book a Demo** (wired to the shared `useDemoPopup()` so the same email-capture popup opens)
  - 6 suggested destinations in a 2-column card grid (Home · AI Agent · Retailers · Inventory · Reordering · Sales Analytics) — each card has icon + bold title + short description + hover arrow
  - "Still stuck? Email hello@botella.ai" footer line
- Extended `utils/useSEO.js` with a new `noindex` option — `NotFoundPage` passes `noindex: true` so Google adds `<meta name="robots" content="noindex, nofollow">`. The hook also resets to `index, follow` when navigating from a noindex page back to a real one (otherwise the noindex tag would persist across navigations).
- Fully responsive: 2-column grid collapses to 1-column on mobile, font sizes scale via `clamp()` for the "404" numeral.
- Fully theme-aware: gradient swaps between dark-mode indigo/light-mode darker indigo per `[data-theme="light"]` selectors.

Build status: ✅ Clean compile. JS +737 B, CSS +720 B.

**Styling refinement #5 — Site-wide "Book a Demo" email popup**

Before this fix, the **"Book a Demo"** button on each of the 9 SEO pages just routed to `/login`, which is wrong — visitors should get the same email-capture popup the home page has shown for months. Unified it:

- New `components/DemoPopup.js` + `DemoPopup.css` — controlled popup component (`isOpen`, `onClose`). Posts to `POST /api/leads` (the existing endpoint that emails the lead notification to the team via Gmail). Smooth fade-in animation, ESC to close, body-scroll lock while open, autofocus on the input.
- New `components/DemoPopupContext.js` — `<DemoPopupProvider>` renders a single `<DemoPopup>` at the React root and exposes `openDemoPopup()` + `closeDemoPopup()` to every descendant via `useDemoPopup()`.
- `App.js` — wraps all `<Routes>` with `<DemoPopupProvider>` so every page (home, SEO, login, app) can trigger the same popup.
- All **9 SEO pages** — replaced `onClick={() => navigate('/login')}` on their Book-a-Demo CTAs with `onClick={openDemoPopup}`. Removed the now-unused `useNavigate` import from each.
- `LandingPage.js` — removed its 80 lines of inline popup JSX + state (`showPopup`, `email`, `submitted`, `submitting`, `submitError`) + `handleEmailSubmit` function. Now uses the shared `openDemoPopup()` like every other page. Old `.lp-popup-*` CSS classes are still in `LandingPage.css` but unused (kept as dead code for safety; can be deleted in a follow-up).

The popup itself is more polished than the home-page original:
- Pop-in spring animation (cubic-bezier easing).
- Disabled submit button until email is non-empty.
- Better error state (boxed callout, not just red text).
- Success state has a "Close" button instead of forcing the user to click outside.
- Fine-print line under the form: *"We'll never share your email. Reply STOP anytime to opt out of follow-ups."*

**One source of truth:** changing the form copy, swapping the API endpoint, or adding fields like company name only requires editing `DemoPopup.js`.

**Styling refinement #4 — Cross-browser CSS compat sweep**

VS Code's `vscode-webhint` was flagging missing vendor prefixes ("`user-select` is not supported by Safari, Safari on iOS"). Did a full sweep across every CSS file in `frontend/src/`:

- **`-webkit-user-select`** added to every `user-select: none / text;` declaration that was missing it. 11 sites across 5 files (SiteHeader.css, SiteFooter.css, LandingPage.css, LoginPage.css, global.css).
- **`-webkit-appearance` + `-moz-appearance`** added to every `appearance: none;` declaration on form controls (LoginPage.css checkbox, ImageGenPage.css select).
- **`-webkit-backdrop-filter`** verified on every `backdrop-filter: blur(…)` — already correctly paired across the codebase.
- **`-webkit-background-clip: text;` + `-webkit-text-fill-color: transparent;`** verified on every gradient-text element (18 sites) — already correctly paired.
- Reordered one declaration in `global.css` (line ~2832) where `user-select` came before `-webkit-user-select`. Functionally equivalent but conventional order is prefix-first.

**Why this matters now:** the production build's autoprefixer (driven by the `browserslist` entry in `package.json`) does add these prefixes at build time, so users in Safari were already getting working pages. But the source files are what humans read and what IDE linters check. With the source files clean:

- VS Code stops flagging warnings.
- Newer browser quirks ship correctly even if autoprefixer's database lags.
- iOS Safari < 16 and macOS Safari < 14 (still ~5% combined per caniuse) get reliable `user-select`, `appearance`, and gradient-text rendering.

Browserslist target unchanged: `>0.2%, not dead, not op_mini all` for production builds.

**Styling refinement #3 — Site-wide unified header**

Same problem the footer had: the home page and the SEO pages were rendering two different navs (home had Solutions / Features dropdowns + Metrics + Contact; content pages had AI Agent / Retailers / Distilleries + a Features dropdown). Extracted both into a single source of truth:

- New `components/SiteHeader.js` + `SiteHeader.css` — used by both `LandingPage` and `ContentLayout`. Identical chrome everywhere.
- Nav structure: **Solutions ▾** (3 audience pages) · **Features ▾** (6 feature pages) · **Metrics** · **Contact** · theme toggle · **Login** button · hamburger (mobile).
- Cross-page anchors handled correctly: clicking **Metrics** or **Contact** from a content page navigates to `/#lp-metrics` or `/#lp-contact`. `LandingPage` now reads `location.hash` on mount and smooth-scrolls to that section after a short delay (so the section has rendered). From the home page itself, it still smooth-scrolls in place.
- Mobile menu: hamburger toggles an expanded panel with grouped link sections (Solutions / Features / More). The X icon swaps in when the menu is open.
- Theme state now lives **only** inside `SiteHeader` — removed the duplicate copy that was in `LandingPage`. Single source of truth for dark/light.
- Cleaned up LandingPage: removed `toggleTheme`, `goToChat`, `smoothScroll`, `theme` state, and the entire inline `<nav>` JSX (~80 lines). Removed the unused `useNavigate` import.
- Cleaned up ContentLayout: removed its 60-line inline `<nav>` and 40-line inline `<footer>`. The component is now ~30 lines.

**Styling refinement #2 — Site-wide professional footer**

- Replaced the previous bare "wordmark + 3 social icons + copyright" footer with a full SaaS-style multi-column footer modelled on Stripe / Linear / Vercel:
  - **Brand column**: gradient wordmark, tagline, social icon row (LinkedIn / Facebook / Instagram), animated "All systems operational" status badge
  - **4 link columns**: Product (7 feature pages), Solutions (audience pages), Company (contact / demo / careers / email), Resources (Help Center / FAQs / Login / Sitemap)
  - **Bottom legal bar**: © + year, Privacy Policy / Terms of Service / Cookie Policy / DPA, "Built for liquor stores in the USA" note
- Extracted into shared `components/SiteFooter.js` + `SiteFooter.css` and used on both the home page and every SEO landing page so the entire public site now has a single, consistent footer.
- Year in copyright is computed from `new Date().getFullYear()` so it never goes stale.
- Auto-pulsing green dot on the status badge (CSS `@keyframes`), no JS — purely cosmetic.

**Styling refinement #1 (same day, after initial review)**

- **"Why Liquor Stores Need an AI Agent"** — first pass was a flat bulleted list with weak contrast in light theme. Reworked as a 3×2 grid of icon cards with hover lift, plus a gradient "decision engine" callout footer. Six pain points now (added Guesswork Decisions) so the grid is balanced. Reads well in both themes.
- **Comparison table** — first pass used plain text "Yes / No". Now uses checkmark / X icons inside colored circular badges (green for yes, red for no), with the Botella column subtly highlighted and a gradient brand label in the header. Hover-row highlight added.
- **Home page nav — two new dropdowns added**:
  - **Solutions ▾** → links to AI Agent / Retailers / Distilleries pages
  - **Features ▾** → links to all 6 feature pages (Inventory, Reordering, Customer Insights, Sales Analytics, Margin Optimization, Product Recommendations)
  - Each dropdown item has icon + bold title + small description, opens on hover, shadowed pop-out card. Mobile: dropdowns hide (the feature card grid below already links to each page; nav stays clean on small screens).

### Build — 2026-05-05 (Tool loop limit lowered 6 → 3)

**User-visible**

- Worst-case latency on chat questions drops from ~30 s to ~15 s. The AI now has **at most 3 tool calls** per user question instead of 6 before the fallback ("I wasn't able to find enough information…") kicks in.
- More likely to hit the fallback on legitimately complex multi-step questions (e.g., a question that needs `list_distinct_values` for category discovery → SQL → verification → answer would have used 3-4 tools and now only has 3). Watch out for an uptick in fallback-text replies; if so, the budget is too tight and we should re-tune.

**Behind the scenes**

- `backend/routes/chat.js`:
  - `const MAX_TOOL_LOOPS = 6;` → `const MAX_TOOL_LOOPS = 3;` (line ~902)
  - SCHEMA_PROMPT Rule #9 ("TOOL BUDGET — STRICT"): updated text from *"at most 6 tool calls"* → *"at most 3 tool calls"* so Claude's prompt-side budget matches the runtime cap. Without this update Claude would think it had 6 attempts but the loop would cut it off at 3, leaving more partial / fallback responses.
- All other references in chat.js use the `MAX_TOOL_LOOPS` constant directly so they pick up the new value automatically (loop guard, log prefix, and warn line).
- SCHEMA_PROMPT verified to still be a valid 27,674-char string after the edit.

**Operational**

- **Backend restart required** so the new constant + prompt are loaded into memory: `Ctrl+C`, `node server.js`.
- Prompt cache invalidates the next request after restart (any change to SCHEMA_PROMPT bytes does this) — first request post-restart will be a cache MISS, then warm again. One-time cost.

**How to monitor whether 3 is enough**

Watch the backend terminal for these patterns:

- Healthy: `[DONE] Response streamed (1 tool loops)` or `(2 tool loops)`
- Edge: `[DONE] Response streamed (3 tool loops)` — used the full budget, may be near the limit
- Trouble: `[WARN] Hit max tool loops (3)` followed by `[FALLBACK] Response incomplete` — the question needed more rounds and got cut off

If you see frequent `[WARN] Hit max tool loops` lines on questions that should be answerable, raise the limit back to 4 or 5. If you only see them on genuinely ambiguous data questions, leave at 3.

---

### Build — 2026-05-02 (Brand wordmark — text replaces logo images)

**User-visible**

- The four brand-logo image placements (chat header, landing nav, landing footer, login card) now render the word **"Botella"** as styled text instead of an `<img>`. The old logo PNG/JPEG files weren't reading well, so we switched to a typographic wordmark with a gradient that matches the brand colours.
- Each placement is sized for its context: 30 px in the chat header, 28 px in the landing-page nav, 20 px in the footer, and 40 px on the login card. Letter-spacing tightened slightly at each size for cleaner kerning.
- Theme-aware: the wordmark uses a brighter indigo→purple gradient (`#818cf8 → #c084fc`) on the dark theme and a deeper indigo→violet (`#4f46e5 → #9333ea`) on the light theme. Toggle the theme and the gradient swaps.

**Behind the scenes**

- `frontend/src/pages/ChatPage.js`, `LandingPage.js`, `LoginPage.js` — the four `<img src="logo-*.png">` blocks were replaced with `<span className="*-wordmark">Botella</span>`.
- `frontend/src/styles/global.css` — added `.chat-header-wordmark` rule (+ light-theme override).
- `frontend/src/pages/LandingPage.css` — added `.lp-logo-wordmark` and `.lp-footer-wordmark` rules.
- `frontend/src/pages/LoginPage.css` — added `.login-logo-wordmark` rule (+ light-theme override).
- The old `*-logo-img` CSS classes are **kept on standby** in all three stylesheets so re-enabling images later is just a JSX swap, no CSS to rewrite.
- `frontend/public/botella-dark.png|jpeg` and `botella-light.png|jpeg` files are still on disk but no longer referenced. They can be deleted to save ~250 KB or kept for the future.

**No backend change required** — pure frontend / styling.

---

### Build — 2026-04-30 (Analyse-flow display text persisted end-to-end)

**User-visible**

- **Suggestions → Analyse chats now show the right title and the right user message everywhere.** Previously:
  - Sidebar title for an Analyse-spawned chat read `"DO NOT query the database…"` (the long internal prompt) instead of the clean question.
  - When the user navigated away and returned to the same chat, the user-bubble text changed from the clean question (`"How do I execute the Clearance Display strategy for…"`) to the internal hidden prompt.
- Both issues are now fixed: the readable question is shown in the sidebar, in the chat bubble, and survives navigation / refresh.

**Behind the scenes**

- The bug was a missing data path: the human-readable text shown to the user (`displayMsg`) was never sent to the backend, so the `question_display` column was always NULL. On revisit, the API fell back to the raw `question` (the hiddenPrompt). Same reason the title was wrong — derived from `question`.
- `frontend/src/pages/ChatPage.js`:
  - `streamChat` now accepts a 4th argument `displayMsg`. Includes it as `display_message` in the POST body when it differs from the actual prompt sent to Claude.
  - `sendMessage` passes `visibleText` as the 4th arg.
  - The `onAnalyse` `streamChat` call now passes `displayMsg`.
  - `resendFrom` doesn't need it (no hidden prompt scenario).
- `backend/routes/chat.js`:
  - Destructures `display_message` from `req.body`.
  - Passes it as `questionDisplay` to `logChatInteraction` in both the success path and the error path.
  - The analytics logger has accepted `questionDisplay` since Phase 1 — it just was never being given a value before.
- `backend/routes/conversations.js`:
  - LIST query title derivation now uses `(ARRAY_AGG(COALESCE(question_display, question) ORDER BY created_at ASC))[1]` so the sidebar title prefers the readable text whenever it's stored.
  - GET single-conversation query already returned `question_display` — `rowsToMessages` already preferred it. Now that the column is actually populated, this works as designed.

**No schema change required** — the `question_display` column has existed since Phase 1.

---

### Build — 2026-04-30 (Soft-delete for conversations + Suggestions-Analyse fresh chat)

**User-visible**

- **Deleting a conversation now sticks.** Previously the conversation came back after deletion because the backend `DELETE` was failing silently (the `bottleai_writer` role didn't have `DELETE` permission, so the frontend rolled back the optimistic UI). Now uses **soft-delete** — the data stays in the database for analytics / audit retention, but the user no longer sees it in the sidebar.
- **Clicking "Analyse" on a Suggestion now ALWAYS opens a fresh conversation.** Previously the analyse message was being appended to whichever chat was open last (stale-closure bug from `setTimeout(... sendMessage ...)`). Now each Analyse click creates a brand-new conversation in the sidebar with a clean title derived from the analyse question (e.g. *"How do I execute the Bundle Promotion strategy for X?"*) instead of the long instructional hidden prompt.
- **No more 300ms artificial delay** when starting an Analyse-driven chat — streaming begins immediately.

**Behind the scenes**

- New column on `chat_interactions`:
  ```sql
  ALTER TABLE chat_interactions ADD COLUMN deleted_at TIMESTAMPTZ;
  CREATE INDEX idx_chat_interactions_active
    ON chat_interactions (conversation_id, user_id) WHERE deleted_at IS NULL;
  GRANT UPDATE ON chat_interactions TO bottleai_writer;
  ```
- `backend/routes/conversations.js`:
  - `GET /` (list) and `GET /:id` (one) now filter `WHERE deleted_at IS NULL` so soft-deleted rows are hidden from the user.
  - `DELETE /:id` now runs `UPDATE chat_interactions SET deleted_at = NOW() ...` instead of `DELETE FROM ...`. Idempotent — second delete returns 404. Requires `UPDATE` privilege (no longer needs `DELETE`).
- `frontend/src/pages/ChatPage.js`:
  - `onAnalyse` callback rewritten — no longer calls `handleNewChat()` followed by `setTimeout(sendMessage, 300)`. Generates the new conversation upfront and calls `streamChat(...)` directly with explicit values (baseMessages, hiddenPrompt, newConvId), bypassing all stale-closure traps.
  - Conversation title for an Analyse-spawned chat is now derived from the human-readable `displayMsg`, not the long internal `hiddenPrompt`.

**Operational**

- Run the SQL block above once in pgAdmin (as `postgres`, on the `bottleai_analytics` database) before this build is functional.
- Restart the backend after the SQL change so the route loads the new query bodies (`Ctrl+C`, `node server.js`).
- Soft-deleted rows accumulate forever today. When volume matters, add a nightly cron: `DELETE FROM chat_interactions WHERE deleted_at < NOW() - INTERVAL '90 days'`.

---

### Build — 2026-04-29 (Login terms gate + read-only history endpoint polish)

**User-visible**

- **Terms & Conditions on login page.** New checkbox "I agree to the Terms & Conditions" sits between password and Sign In. Sign In is disabled until the box is checked.
- **Terms modal.** Clicking the **Terms & Conditions** link opens a modal with the full data-license clauses (Customer Data and Data Use License, Definitions, Ownership, License Grant, Limitations, Customer Rights, etc. — section numbering removed for cleaner reading).
- **Modal close behavior:**
  - Clicking **I Agree** in the modal closes it AND ticks the login checkbox.
  - Clicking the X close button, pressing Escape, or clicking the dark backdrop closes the modal but DOES NOT tick the checkbox.
- **Pressing Enter on the login form without ticking the box** now shows an inline error: *"Please accept the Terms & Conditions to continue."*

**Behind the scenes**

- `backend/routes/conversations.js` — fixed: response time now flows back when loading past chats from the server. Hover-tooltip on assistant messages shows "2.3s" / "850ms" again after a refresh or conversation switch.
- `frontend/src/pages/LoginPage.js` — added `acceptedTerms` and `showTermsModal` state, ESC-key listener, modal markup with full T&C clauses.
- `frontend/src/pages/LoginPage.css` — new styles: `.login-terms`, `.login-terms-link`, `.terms-modal-overlay`, `.terms-modal`, `.terms-modal-header/-body/-footer/-btn`. Mobile breakpoint at 600 px makes the modal nearly full-screen.
- All terms acceptance is **per-login** — there is no localStorage flag yet. If you want to remember acceptance across sessions later, add a `users.accepted_terms_at` column and set it on successful login.

**Things to know going forward**

- The terms text is hardcoded in the modal JSX. To update wording, edit `frontend/src/pages/LoginPage.js`.
- For legal audit trail, you may eventually want to record acceptance server-side (which version of the terms, when, by which user). Not built yet.
- The current draft is a starting point — get a SaaS contracts lawyer to review before going to production with paying customers.

---

### Build — 2026-04-29 (Cache cost breakdown columns + fix)

**Behind the scenes**

- `chat_interactions` table got two new columns earlier (manual `ALTER TABLE`):
  - `cache_read_cost_usd NUMERIC(12, 6)` — cost of cache hits, broken out separately from `question_cost_usd`
  - `cache_creation_cost_usd NUMERIC(12, 6)` — cost of cache writes, broken out separately
- `backend/utils/analytics.js` updated to populate both new columns on every chat turn. Previously they were always NULL because the INSERT didn't reference them.
- `calculateCosts()` now exposes `cacheReadCost` and `cacheCreationCost` in addition to the existing `questionCost`, `responseCost`, `totalCost`.

**Backfill (optional, for old rows)**

```sql
UPDATE chat_interactions
SET
  cache_read_cost_usd     = ROUND((COALESCE(claude_cache_read_tokens, 0)     * 0.30 / 1000000)::numeric, 6),
  cache_creation_cost_usd = ROUND((COALESCE(claude_cache_creation_tokens, 0) * 3.75 / 1000000)::numeric, 6)
WHERE cache_read_cost_usd IS NULL OR cache_creation_cost_usd IS NULL;
```

---

### Build — 2026-04-29 (Brand rename + GUID conversation IDs)

**User-visible**

- **"BottleAI" renamed to "Botella"** across every user-facing string: page title, landing page hero text and sections, login page logo alt, chat welcome message, print page header, dashboard footer, the AI's identity responses (Claude now self-identifies as "Botella"), email subject + body for new lead notifications.
- **Conversation IDs are now RFC-4122 v4 UUIDs** (e.g. `f47ac10b-58cc-4372-a567-0e02b2c3d479`) instead of short random strings.

**Skipped intentionally** (NOT changed):

- `bottleai_analytics` PostgreSQL database name — internal identifier, never user-visible. Renaming would require DB migration.
- `botella_*` localStorage key prefixes — already use the target spelling.
- `.claude/settings.local.json` — contains literal filesystem paths (`D:/BottleAI_Staging/`), not brand references.

**Behind the scenes**

- `frontend/src/utils/storage.js` — `generateId()` rewritten to prefer `crypto.randomUUID()` with a manual `crypto.getRandomValues()` fallback for older browsers / insecure contexts.
- 12 files touched for the rename, 47 occurrences replaced (verified with `grep -r "BottleAI"` returning 0 results in source code).
- SCHEMA_PROMPT (the system prompt sent to Claude) verified to still resolve to a valid 27,674-char string after the edits.

---

### Build — 2026-04-28/29 (Path B: server-side chat history)

**User-visible**

- **Chat history now survives clearing browser data.** Chat history lives on the server, fetched on login.
- **Chat history syncs across devices and browsers.** Log in on a different machine → see the same conversation list.
- localStorage is kept as a **fallback cache** so the app still works if the analytics database is unreachable.

**Behind the scenes**

- New backend route: `backend/routes/conversations.js`
  - `GET /api/conversations` — list current user's conversations (id, derived title, message count, timestamps)
  - `GET /api/conversations/:id` — load all messages in a conversation (oldest-first)
  - `DELETE /api/conversations/:id` — hard-delete (cascades through `chat_interactions`)
  - All endpoints filter by `user_id = req.user.user_id` (plus tenant fields for defense-in-depth).
- `backend/server.js` registers `/api/conversations` with `verifyToken` middleware (no `attachPool` needed — uses the analytics pool internally).
- `backend/routes/chat.js` was already accepting `conversation_id` in the request body — wired up now.
- `frontend/src/pages/ChatPage.js`:
  - On mount: fetches conversation list from API, falls back to localStorage on failure.
  - On select: tries API first for that conversation's messages, falls back to local cache.
  - On send: includes `conversation_id` in the chat POST body.
  - On stream complete: refetches the list so the sidebar reflects new conversations and updated message counts.
  - On delete: optimistic UI update + DELETE call + refetch on failure.
- localStorage is still written as a cache layer — the app degrades gracefully when the server is offline.

---

### Build — 2026-04-28 (Chat interactions analytics — Phase 1)

**Behind the scenes**

- New PostgreSQL database `bottleai_analytics` with one table `chat_interactions`.
- Table stores per-turn: who asked (user_id, username, location_id, location_name, conversation_id), the question, the response, all SQL queries Claude ran (as JSONB array), token counts (input / output / cache_read / cache_creation), wall-clock response time, tool loops used, error message if any, and per-turn cost in USD (question_cost_usd, response_cost_usd, total_cost_usd).
- Three database users:
  - `postgres` — superuser (admin)
  - `bottleai_writer` — backend service account, has `INSERT, SELECT` only (least privilege — no UPDATE/DELETE)
  - `bottleaianalytics` — read-only role for human/tool access (e.g. BI tools, audit, dashboards)
- New file: `backend/database/analytics-connection.js` — separate `pg.Pool` for the analytics DB, max 5 connections, isolated from the production `syncgo` pool.
- New file: `backend/utils/analytics.js` — exports `logChatInteraction(data)` and `calculateCosts(tokens)`. Pricing constants for Claude Sonnet 4 are at the top of this file in one place.
- `backend/routes/chat.js` — wired to log every chat turn (early-return paths included: identity questions, raw-SQL block, non-English block, success path, error path). All logging is fire-and-forget — analytics failures NEVER break user-facing chat.
- `backend/server.js` — added `testAnalyticsConnection()` probe at startup so credential issues surface immediately.

**Operational**

- `.env` requires four new variables:
  ```
  ANALYTICS_PG_HOST=localhost
  ANALYTICS_PG_PORT=5432
  ANALYTICS_PG_DATABASE=bottleai_analytics
  ANALYTICS_PG_USER=bottleai_writer
  ANALYTICS_PG_PASSWORD=<the password you set for that role>
  ```
  All four fall back to the production `PG_*` values if not set, so the app keeps working even with partial config.
- Successful startup shows two pool-creation lines:
  ```
  [DB] Pool created for database: syncgo
  [Analytics DB] Pool created for database: bottleai_analytics
  [Analytics DB] Connection verified
  ```

---

### Build — 2026-04-25/28 (T&C draft + analytics planning)

**Planning / docs only — no code changes.**

- Drafted Customer Data and Data Use License clause for terms of service. Explored implications of storing chat history in a separate analytics database (data ownership, customer rights, retention, GDPR/CCPA, marketing claims, etc.).
- Designed `chat_interactions` table schema (single-table approach, JSONB for sql_queries array). Two cost-column extensions added later (cache_read_cost_usd, cache_creation_cost_usd).
- Discussed Path A (shadow logging only) vs. Path B (server-side history with localStorage fallback) — chose Path B.

---

### Build — 2026-04-22/24 (Streaming, prompt rules, cross-browser fixes)

**User-visible**

- Chat free-flow layout: assistant replies render as plain text with a small wine-glass icon (no bubble); user messages stay in soft pills.
- Markdown in chat: `### headings`, `- bullets`, `1. numbered lists`, code, bold all render in both streaming and final views.
- Tool-use preamble flicker: 400 ms commit-buffer in `streamClaude` so reasoning text never leaks before tool calls.
- Mobile auto-focus stops popping the soft keyboard when sidebar / theme / mic buttons are tapped.
- Header no longer disappears on Android when the keyboard opens.
- "Coming soon" Trending's tab added to sidebar.
- Click-to-copy removed from dashboard hovers.
- Dashboard responsive grid stops cramping at 768–1366 px.

**Behind the scenes (key changes)**

- Prompt rules added: case-insensitive `sale_status` filter, historical-month query rules (no `<= MAX(sale_date)` for past months), don't claim data is missing without verifying first. Resolved the "no data for March 2026" false-negative bug.
- Tool loop budget reduced 10 → 6 to bound worst-case latency.
- Prompt caching enabled on `SCHEMA_PROMPT` and `TOOLS` array — ~65% input-token cost reduction on warm requests.
- `pg.Pool` config: max 20 connections, 30s idle timeout, 5s connect timeout, 15s statement timeout.
- Dashboard endpoint TTL cache (45s) with request coalescing.
- URL routing: each tab is now its own route (`/chat`, `/dashboard`, `/suggestions`, `/trendings`).
- Cross-browser: `-webkit-backdrop-filter` added on 9 spots; clipboard helper with `execCommand` fallback for non-HTTPS or older iOS; voice-mic shows disabled state on Firefox <121 instead of vanishing.
- Google Tag Manager + GA4 + Search Console + Bing verification snippets in `index.html`.

---

## Build operations

### Backend startup

```bash
cd backend
npm install                # only if dependencies changed
node server.js             # default port 3000
```

Healthy startup shows:
```
[DB] Pool created for database: syncgo
[Analytics DB] Pool created for database: bottleai_analytics
[Analytics DB] Connection verified
[info] BottleAI API running on http://localhost:3000
[info] Database connected successfully
[info] Analytics database connected successfully
```

### Frontend startup

```bash
cd frontend
npm install
npm start                  # forces PORT=3001, opens browser
```

### Required env files

`backend/.env`:
```
PG_HOST=...
PG_PORT=5432
PG_DATABASE=syncgo
PG_USER=bottela
PG_PASSWORD=...

ANALYTICS_PG_HOST=localhost
ANALYTICS_PG_PORT=5432
ANALYTICS_PG_DATABASE=bottleai_analytics
ANALYTICS_PG_USER=bottleai_writer
ANALYTICS_PG_PASSWORD=...

ANTHROPIC_API_KEY=sk-ant-...
JWT_SECRET=...
PORT=3000
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REDIRECT_URI=...
OPENAI_API_KEY=sk-...
NOTIFICATION_EMAIL=where_lead_emails_should_go@example.com
```

`frontend/.env` (optional):
```
REACT_APP_API_URL=http://localhost:3000/api
```

### Telemetry / observability

Per-chat-turn the backend logs:

```
[CACHE] call#1 usage={"input_tokens":2601,"cache_read_input_tokens":6773,...}    ← cache hit confirmation
[LOOP 1/6] run_sql                                                                ← tool iteration
[SQL] SELECT ...                                                                  ← actual SQL Claude generated
[DONE] Response streamed (1 tool loop)
[TIMING] Total: 3421ms | Claude: 2803ms (2 calls) | DB: 312ms (3 queries) | Format: 306ms
[ANALYTICS] Logged interaction id=42 user=praveen cost=$0.012505                  ← per-turn DB row written
```

### Useful analytics queries

```sql
-- Recent activity per user
SELECT user_id, COUNT(*) AS questions, MAX(created_at) AS last_active
FROM chat_interactions WHERE role = 'user'
GROUP BY user_id ORDER BY questions DESC LIMIT 20;

-- API spend per store this month
SELECT client_id, location_name,
       SUM(claude_input_tokens)        AS in_tok,
       SUM(claude_cache_read_tokens)   AS cache_tok,
       SUM(claude_output_tokens)       AS out_tok,
       SUM(total_cost_usd)             AS spend_usd,
       COUNT(*)                        AS turns
FROM chat_interactions
WHERE created_at >= DATE_TRUNC('month', NOW())
GROUP BY client_id, location_name
ORDER BY spend_usd DESC;

-- Failed SQL Claude has been generating
SELECT c.created_at, c.question, q.value->>'query' AS failed_query, q.value->>'error' AS error
FROM chat_interactions c, jsonb_array_elements(c.sql_queries) q
WHERE (q.value->>'success')::boolean = FALSE
  AND c.created_at >= NOW() - INTERVAL '7 days'
ORDER BY c.created_at DESC;
```

---

## Known gaps / things deferred

These are intentionally not built yet. They appear here so future builds can pick them up without re-discovering the design.

- **Per-user RAG retrieval** — `chat_interactions` is the storage layer for this; once enough data accumulates, embed past Q&A pairs and inject the top-K into the system prompt for new questions. Adds visible "self-improvement" without fine-tuning.
- **Email Automation & Socials/Image-Gen removed** — the Gmail-OAuth email feature and the OpenAI image-gen + Instagram/Facebook posting feature (plus the unfinished Gemini video stub) were deleted from the codebase on 2026-06-09. If revived, restore from git history rather than re-discovering the design.
- **Touch targets <44 px** — chat action buttons (Copy, Print, Edit, Retry) are ~26 px. Below WCAG 2.5.5 minimum. Doesn't break anything, but worth fixing for mobile UX.
- **Server-side terms acceptance audit** — currently the T&C checkbox state is not recorded anywhere. For a legal audit trail, add `users.accepted_terms_version` and `users.accepted_at` columns and POST those on successful login.
- **Auto-delete old analytics rows** — `chat_interactions` will grow forever. Add a nightly cron when storage matters.
- **Sitemap.xml + robots.txt + 9 SEO landing pages** — drafted in the SEO PDF, not built. Architectural choice between CRA + Prerender, Next.js migration, or hybrid static site is still open.
- **WhatsApp automation** — phased plan drafted. Not built. (The Email automation feature was built and later removed — see the 2026-06-09 changelog entry.)

---

## Helpful internal docs

- `D:\BottleAI_Documentation\` — historic engineering docs (CHANGELOG, ARCHITECTURE, TESTING, OPERATIONS markdown files plus a Word doc)
- This file (`README.md`) — newer build-by-build log, updated with each meaningful change

If a build introduces something user-visible, please add a new section at the top of "Build changelog" with the date and a short list of what changed.
