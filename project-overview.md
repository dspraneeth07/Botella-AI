# Botella AI — Project Overview

> Comprehensive synthesis of the codebase as it actually stands at HEAD.
> Read this AFTER `context.md` (rules) and `architecture.md` (technical
> map) when you want a deep, narrative understanding of how the project
> hangs together.
>
> Last full-tree audit: 2026-06-06.

---

## 1. What Botella actually is

**Botella AI is not a standalone product.** It's an AI conversational layer
**layered on top of an existing retail-POS / inventory system called
SyncGo** that's already running for liquor-store clients. SyncGo is a
.NET application (passwords are stored as ASP.NET Core Identity v3 hashes
in the SyncGo `users` table — Botella's `routes/auth.js` re-implements
the .NET hash verification in JS so users can sign in with their existing
SyncGo credentials, no migration needed).

This single fact explains a lot of the codebase:
- **Why JWT, not session auth.** Easy to share with native apps or
  other clients of the SyncGo ecosystem.
- **Why a separate `bottleai_analytics` DB.** SyncGo owns the production
  `syncgo` database; Botella can read but must not write to it. All of
  Botella's own data (chat-interaction logs, conversation history) goes
  to a sibling DB so the two systems stay decoupled.
- **Why the tenant model is `client_id` + `location_id` everywhere.**
  SyncGo serves multi-store retailers ("clients") with many physical
  stores ("locations"). Every business table joins on both.
- **Why the chat layer never INSERT/UPDATE/DELETE.** The `chat.js` SQL
  tool whitelist is read-only. Mutations to SyncGo data would be the
  responsibility of the .NET app, not Botella.

The marketing site at the same repo (`/`, `/login`, the 7 SEO sub-pages,
`/contact`, etc.) sells Botella as an **AI agent for liquor stores** —
that's the customer-facing story. Internally, Botella is the AI/insight
tier of the SyncGo retail stack.

---

## 2. System map at a glance

```
                  ┌─────────────────────────────────────────────────┐
                  │  Liquor-store user (Chrome, http://botella.ai)  │
                  └─────────────────────────────────────────────────┘
                                       │
                       ┌───────────────┴───────────────┐
                       │                               │
              ┌────────▼────────┐             ┌────────▼────────┐
              │   /   (public   │             │  /chat,         │
              │   marketing)    │             │  /dashboard,    │
              │   /login        │             │  /suggestions,  │
              │   7 SEO pages   │             │  /market-analysis│
              │   /contact      │             │  (auth-gated)   │
              └────────┬────────┘             └────────┬────────┘
                       │                               │
                       │   ──── React 18 SPA (CRA, port 3001) ──── │
                       │                               │
                       └───────────────┬───────────────┘
                                       │
                              fetch /api/* (JWT bearer)
                                       │
                       ┌───────────────▼───────────────┐
                       │  Express API (port 3000)       │
                       │  Node 24 + Winston             │
                       │  CORS open, single global pool │
                       └───────────────┬───────────────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              │                        │                        │
     ┌────────▼────────┐      ┌────────▼────────┐      ┌────────▼────────┐
     │  syncgo PG      │      │ bottleai_       │      │  External APIs  │
     │  (production    │      │ analytics PG    │      │                 │
     │   business data)│      │ (chat logs,     │      │  Anthropic      │
     │                 │      │  costs)         │      │   Claude Sonnet 4│
     │  shared with    │      │                 │      │  Gmail SMTP     │
     │  the .NET       │      │  owned by       │      │  (lead notifs)  │
     │  SyncGo app     │      │  Botella alone  │      │                 │
     └─────────────────┘      └─────────────────┘      └─────────────────┘
```

Plus a third local file: `backend/database/liquor_store.db` (SQLite via
better-sqlite3 — schema in `backend/database/schema.js` with classic
liquor-POS tables STR/CAT/TYP/INV/STK). This appears to be **legacy /
unused dev-seed code** — no route or live module references the SQLite
DB, and the schema doesn't match what the chat tool queries. Worth
deleting in a future cleanup, but harmless as-is.

---

## 3. The 9 backend routes (everything mounted in `server.js`)

| Mount path             | File                    | Auth | Purpose |
|------------------------|-------------------------|:---:|---|
| `/api/auth`            | `routes/auth.js`        | ❌  | POST `/login` — verify SyncGo ASP.NET Identity v3 password hash → issue JWT (24h). |
| `/api/leads`           | `routes/leads.js`       | ❌  | POST `/` — public lead capture (DemoPopup + ContactPage). Saves to `data/leads.json`, fan-out SMTP notification via Gmail App Password. |
| `/api/chat`            | `routes/chat.js`        | ✅  | POST `/` — streaming SSE chat turn. Tool-loop with `run_sql` + `list_distinct_values` + `describe_table`. `GET /csv/:id` — full-result CSV download. |
| `/api/summary`         | `routes/summary.js`     | ✅  | GET `/` — daily summary tile: yesterday's sales, top 5 products, slow inventory (60+ days). AI-generated suggestions via Claude. |
| `/api/insights`        | `routes/insights.js`    | ✅  | GET `/` — 11 parallel queries: store overview, top sellers, sales-by-category, recent sales, high/low margin, inventory value, low-stock, overstocked. |
| `/api/dead-stock`      | `routes/dead-stock.js`  | ✅  | Enriched dead-stock list (30/60/90-day movement windows). Template-based AI suggestions for `bundle` / `clearance` / `markdown` strategies. |
| `/api/dashboard`       | `routes/dashboard.js`   | ✅  | GET `/` — 12 parallel queries returning the full Dashboard payload (KPIs, revenue trend, top products, category breakdown, alerts, inventory). 45 s TTL cache + in-flight Promise coalescing. POST `/refresh` to bust the cache. |
| `/api/market-analysis` | `routes/market-analysis.js` | ✅  | GET `/products/search?q=&category=` — type-ahead with 60 s query cache (max 500 entries) + 1 h state-resolution cache. Liquor allow/deny regex filters out tobacco/snacks/accessories from the free-form `category` column. |
| `/api/conversations`   | `routes/conversations.js` | ✅  | GET `/` — list user's conversations from `chat_interactions`. GET `/:id` — full message list. DELETE `/:id` — soft-delete (sets `deleted_at`). |

**Deliberate removals (per `agent-log.md` 2026-06-09):** `routes/email.js`,
`routes/imagegen.js`, all of `backend/helpers/`, and the matching frontend
components (`ImageGenPage.js`, `EmailPage.js`) were intentionally deleted —
Email Automation + Social/Image-Gen + video generation were dead features
the user explicitly wanted gone "with no dangling references". Removed
deps in the same commit: `openai`, `googleapis`, `node-cron`, `multer`,
`xlsx`. Kept: `nodemailer` (still used by `leads.js`), `better-sqlite3`
(still imported by `database/schema.js`).

**Remaining orphan code from those removals:** the `error.js`
`toSafeError()` mapper still has branches for `openai`, `gmail`, and
`meta` services — those used to map errors from the removed routes.
They're now dead branches (no code path can match) but don't break
anything. Worth a one-liner cleanup pass.

Architecture.md §2 also still mentions `email.js` + `imagegen.js` in
the route map — that's stale doc drift, separate from the deliberate
code removal. Worth correcting next time `architecture.md` gets touched.

---

## 4. The two PostgreSQL databases

### `syncgo` (production)

Read-only access for Botella; shared with the .NET SyncGo app.

| Table | Purpose |
|---|---|
| `users` | Login accounts (with `password_hash` in ASP.NET Identity v3 binary format), keyed to `client_id` + `location_id`. |
| `clients` | Retailers (e.g. "Zeke's Liquor"). `client_id` is the top-tier tenant identifier. |
| `client_locations` | Physical stores under each client. `(client_id, location_id)` uniquely identifies a store. Has `state` for state-specific filtering. |
| `products` | Per-location product catalogue. `sku`, `product_name`, `category`, `sub_category`, `price`, `cost`, `stock_qty`. Free-form `category` (~1.2k distinct values in real data — Botella's market-analysis route uses a regex allow-list to filter to actual liquor categories). |
| `sales` | Transaction headers — `sale_id`, `sale_date`, `total_amount`, `customer_id`, `sale_status`. Statuses lower-cased: `locked`, `open`, `pending`, etc. |
| `sale_items` | Line items per transaction. `quantity`, `price`, `cost`, `total_amount`, `sku`, `product_name`, `category`. Some rows have a denormalised `category` column that's often blank — chat.js prompt explicitly tells the LLM to JOIN through `products` for the canonical category. |
| `customers` | Optional named buyers. `customer_id` is a UUID — never expose this; always JOIN and show `customer_name`. |
| `suppliers` | Per-tenant supplier list with contact details. |
| `purchases` | (Existence implied by error classes; not heavily queried in current code.) |

Connection pool: 20 max, 30s idle, 5s connect timeout, 15s
statement_timeout. Single shared pool injected into `req.pool` by the
`attachPool` middleware in `server.js`.

### `bottleai_analytics` (Botella's own)

Owned solely by Botella. Lower connection cap (max 5 — single-INSERT
writes don't need many connections).

| Table | Purpose |
|---|---|
| `chat_interactions` | One row per chat turn. Columns: tenant (`client_id`, `location_id`, `user_id`, `username`, `location_name`), `conversation_id`, `question`, `question_display` (separate column for the hidden-prompt pattern), `response`, `followups` JSONB, `sql_queries` JSONB array (one entry per tool call: iteration / tool / query / success / row_count / execution_time_ms / error), `tool_loops_used`, `response_time_ms`, 4 token columns (`claude_input_tokens` / `_output_tokens` / `_cache_read_tokens` / `_cache_creation_tokens`), 5 cost columns (`question_cost_usd` / `response_cost_usd` / `total_cost_usd` / `cache_read_cost_usd` / `cache_creation_cost_usd`), `error_message`, `deleted_at` (soft-delete via `/api/conversations/:id` DELETE), `created_at`. |

Cost calculation lives in `backend/utils/analytics.js` with hardcoded
Claude Sonnet 4 pricing constants. If Anthropic changes pricing or you
switch models, update the four `PRICE_*_PER_M` constants there.

---

## 5. The chat tool-loop in detail

`backend/routes/chat.js` is **the heart of the product** (1253 lines).
The shape:

```
POST /api/chat   (SSE — text/event-stream)
  ↓
openSSE(res)                                 [setNoDelay, X-Accel-Buffering, headers]
  ↓
discoverDataContext(pool, clientId, locId)    [schema + categories + sample data
                                                 — assembled into SCHEMA_PROMPT prefix]
  ↓
streamClaude({ res, systemBlocks, messages }) [calls Anthropic with stream:true]
  ├── stream.on('text', delta) → emitSanitized(delta) → SSE 'delta' event
  ├── stream.on('streamEvent', tool_use)
  │      ├── if committed=true: send 'clear' SSE to wipe leaked preamble
  │      └── flip isToolCall=true
  └── stream end → drain sanitizer.flush()
  ↓
if response.stop_reason === 'tool_use':
  for each toolUse in response.content:
    handleTool(toolUse, pool, clientId, locId)
       ├── run_sql              [whitelist + tenant filter + 10s timeout]
       │     └── if rowCount > 5: registerDownloadable(sql, ...) → downloadId
       ├── list_distinct_values [for the LLM to discover field domains]
       └── describe_table       [for the LLM to inspect schema]
    push tool_result back into messages
  → loop into streamClaude() again (max 3 loops total)
  ↓
on 'done': extract <<FOLLOWUPS>> tag, send 'done' SSE with followups
  ↓
logChatInteraction({...}) → bottleai_analytics.chat_interactions
```

Defensive layers (all currently in HEAD):
- **`isSafeQuery`** — rejects anything that isn't a SELECT / WITH at the start (no INSERT/UPDATE/DELETE/DROP/etc.).
- **`isBlockedTable`** — rejects access to system tables (`information_schema`, `pg_*`) and analytics-DB tables.
- **`validateTenantFilter`** — requires both `client_id = <N>` and `location_id = <N>` in the WHERE clause matching the authenticated user's tenant.
- **Response sanitiser** (`lib/responseSanitizer.js`) — strips raw customer UUIDs and SQL code blocks from every SSE delta + every fully-assembled response.
- **Retry-with-backoff** — `isRetryableClaudeError` + 3-attempt exponential backoff in `streamClaude`. Retry suppressed once any text has streamed (no duplicated responses).

The CSV-download pipeline lives inside chat.js too: `downloadCache` Map
(1h TTL), `registerDownloadable(sql, clientId, locationId)` returns a
16-hex-char id, Claude is instructed to drop `[download:HEXID]` markers
after partial tables, `GET /api/chat/csv/:id` strips trailing LIMIT/OFFSET
and re-runs the cached SQL with a backend-enforced `LIMIT 5000`,
streaming RFC-4180 CSV.

---

## 6. Frontend in detail

### Framework + setup

- **React 18** via Create React App (react-scripts 5.0.1, frozen — no
  Vite migration on the roadmap).
- **react-router-dom v6** with `<BrowserRouter>` in `index.js`.
- **recharts** for the dashboard chart components.
- **lucide-react** for icons (all the chat / dashboard / popup icons).
- Plain CSS in `src/styles/global.css` + per-component `.css` files (no
  preprocessor, no CSS-in-JS).
- Dev server on port 3001 (`react-scripts start` with `PORT=3001` env);
  proxies `/api/*` to `localhost:3000` via the CRA `proxy` field.

### Route layout (from `App.js`)

```
/                                             LandingPage         (public)
/login                                        LoginPage           (public)
/contact, /privacy-policy, /terms-and-conditions  legal pages     (public)

7 SEO sub-pages under /ai-*-liquor-stores and similar              (public, crawlable)

/chat, /dashboard, /suggestions, /market-analysis  all → ChatPage  (auth-gated)
   ↳ ChatPage reads location.pathname to pick which inner view to render
     (chat / dashboard / suggestions / market-analysis)
   ↳ Single shell component, ~1500 lines

*                                             NotFoundPage         (public)
```

### High-leverage components

| File | Role |
|---|---|
| `pages/ChatPage.js` | The whole auth-gated app surface. Manages 4 views, sidebar, conversation list, SSE streaming, message rendering, follow-ups, CSV download, copy / edit / retry actions. The biggest single file at ~1500 lines. |
| `pages/LandingPage.js` | Marketing home with hero, features grid, automation cards, comparison table, metrics tiles, FAQ, and the bottom-split (WHATIS + GET-STARTED side-by-side). |
| `pages/seo/*.js` | 7 keyword-targeted landing pages — Retailers / AI Agent / Inventory / Customer Insights / Sales Analytics / Margin Optimization / Product Recommendations. Each uses `useSEO()` for per-route meta tags + `JsonLd` for schema.org FAQPage markup where applicable. |
| `components/Dashboard.js` | Recharts-driven KPIs + revenue trend + category pie + top-products bar + inventory tables. `fmtMoney` returns full precision (`$1,234,567.89`); chart-axis tick formatters still abbreviate (`$1.2M`, `$1.2K`) because there's no room. |
| `components/Sidebar.js` | Conversation list (per-user), tab nav (Chat / Dashboard / Suggestions / Market Analysis), store badge, theme + logout. Collapsible. |
| `components/DemoPopup.js` + `DemoPopupContext.js` | Shared modal opened via `useDemoPopup().openDemoPopup()` from any page. Posts to `/api/leads`. |
| `components/SiteHeader.js` + `SiteFooter.js` | Public-site chrome. Active-page highlighting in Solutions / Features dropdowns. |
| `components/ContentLayout.js` | Wrapper used by SEO sub-pages — applies the cosmic background, header / footer, and `cp-rich` page class. |
| `components/JsonLd.js` | Renders `<script type="application/ld+json">` with whatever schema.org object you pass. Used for FAQPage + Organization + WebSite + SoftwareApplication. |
| `utils/useSEO.js` | Per-route hook that sets `<title>`, meta description, canonical URL, OG tags, Twitter card. Defaults to `/og-image.png` for unspecified images. |
| `utils/usePageView.js` | Fires `gtag('config', ...)` + `dataLayer.push({event:'pageview'})` on every SPA route change. Mounted once at App root. |
| `utils/storage.js` | localStorage helpers for conversation persistence (legacy — server-side history via `/api/conversations` is the source of truth now), plus `generateId` (UUIDv4 with crypto.randomUUID + fallback chain), `deriveTitle`. |

### The chat streaming pipeline (frontend half)

Three layers must all be in place for the per-token reveal to actually
show on screen:

1. **`flushSync(() => setStreamingText(...))`** — defeats React 18's
   automatic batching. The synchronous SSE `for (line of lines)` loop
   would otherwise collapse every `setState` into one render.
2. **`StreamingBubble` uses `useLayoutEffect`** to write `innerHTML`
   during the commit (not after paint). Without this, `flushSync`
   commits per-delta but the actual DOM write lags.
3. **`await new Promise(r => requestAnimationFrame(r))`** between
   deltas — yields control to the browser for a paint frame.

CSS layer: `.chat-message:has(.chat-bubble-streaming) { animation: none; }`
in `global.css` — the default `chatFadeIn` would otherwise mask the
token reveal for short responses by fading the wrapper in over 300 ms.

---

## 7. External integrations

| Service | What it's used for | Where in code |
|---|---|---|
| **Anthropic Claude** (Sonnet 4 / `claude-sonnet-4-20250514`) | Main chat tool-loop, summary suggestions, dead-stock template-suggestion grounding | `chat.js`, `summary.js`, `dead-stock.js` |
| **Gmail SMTP** (App Password) | Outbound lead notifications fan-out to NOTIFICATION_EMAIL recipients | `leads.js` |
| **Google Analytics 4 + Google Tag Manager** | Pageview tracking on every SPA route change | `frontend/utils/usePageView.js` + `index.html` |
| **Microsoft Clarity** | Session-replay analytics on the marketing site | `frontend/public/index.html` |
| **Bing Webmaster** | Verification meta tag for indexing | `frontend/public/index.html` |
| **PostgreSQL** (production `syncgo` + analytics `bottleai_analytics`) | All persistent data | `database/connection.js`, `database/analytics-connection.js` |

The `error.js` `toSafeError()` mapper has branches for OpenAI (`dall-e`,
`gpt-image`) and Meta (Instagram/Facebook), but the routes that used
them (`imagegen.js`, parts of an old `email.js`) were deleted on
2026-06-09. Those error branches are orphan code now — they'll never
match, but they don't break anything either.

---

## 8. Caching strategy

| Cache | TTL | Location | Why |
|---|---|---|---|
| Dashboard payload | 45 s | `dashboard.js` in-memory Map | 12 parallel queries cost ~1–2 s cold; 45 s window covers a user clicking around without thrashing PG. |
| Dashboard in-flight | until resolve | `dashboard.js` Promise Map | Concurrent cold requests from the same tenant share one query batch (10 simultaneous loads ⇒ 12 queries, not 120). |
| Market-analysis search result | 60 s | `market-analysis.js` LRU-ish Map (max 500) | Type-ahead fires per keystroke; same prefix across users in the same state collapses to one DB hit. |
| Market-analysis user-state | 1 h | `market-analysis.js` Map | `client_locations.state` rarely changes; cache so search stays one query. |
| CSV download | 1 h | `chat.js` `downloadCache` Map | Stash the SQL string (not the rows) so `GET /api/chat/csv/:id` can re-run lazily. Process-local — if you scale to multiple replicas, sticky sessions or move to Redis. |
| Chat conversation list | none | — | `/api/conversations` queries `chat_interactions` fresh each time; the table's small per user. |

---

## 9. Build, deploy, env-var matrix

### Backend (`backend/package.json`)

- `npm start` → `node server.js` (no nodemon — restarts are manual).
- No build step. Pure Node 24.

### Frontend (`frontend/package.json`)

- `npm start` → `react-scripts start` on port 3001 (CRA dev server with HMR + the `/api/*` proxy to localhost:3000).
- `npm run build` → `react-scripts build` → static bundle in `frontend/build/`.
- `server.js` serves the CRA build directory in production via `express.static`. All non-`/api/*` paths fall through to `index.html` (SPA).

### Required env vars (in `backend/.env` — NOT in git, must be set per environment)

| Var | Purpose | Failure mode if missing |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude API auth | Every chat / summary / dead-stock-AI call 401s. |
| `JWT_SECRET` | JWT signing | Falls back to `botella-default-secret-change-me` — anyone with the source could forge tokens. Set this in prod. |
| `PG_HOST`, `PG_PORT`, `PG_DATABASE`, `PG_USER`, `PG_PASSWORD` | Production `syncgo` DB | Pool init fails; everything 500s. |
| `ANALYTICS_PG_HOST`, `_PORT`, `_DATABASE`, `_USER`, `_PASSWORD` | `bottleai_analytics` DB | Falls back to the production PG creds if unset (same host, different DB). |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Gmail SMTP for lead notifications | `haveSMTPConfig` evaluates false → lead is still saved to `data/leads.json`, but no email goes out. Logs `SMTP not configured — lead notifications disabled` at startup. |
| `NOTIFICATION_EMAIL` | Comma-separated recipients | Falls back to single `info@botella.ai`. |
| `PORT` | Backend port | Defaults to 3000. |
| `LOG_LEVEL` | Winston level | Defaults to `info`. |

`.env` is in `.gitignore` (line 4) → **NEVER pushed via git**. Prod
deploys MUST set these via the platform's secret mechanism (AWS Parameter
Store / Secrets Manager / Task Definition env, PM2 ecosystem file,
Docker `--env-file`, etc.). This is the #1 cause of "works locally but
not in prod" issues — flagged in detail in the most recent
`agent-log.md` entry.

---

## 10. The four workflow docs

This file is the fifth. Roles:

| File | Role | Update when |
|---|---|---|
| `context.md` | The constitution — identity, multi-tenant model, roles, hard-no's, conventions, the 9 chat-prompt rules, the §7 "read before, log after" workflow rule | Project rules / hard-no's change |
| `architecture.md` | The technical map — repo layout, route map, chat turn lifecycle, three-layer streaming pipeline, sanitiser, CSV pipeline, named tools | A module / route / pipeline step lands or changes |
| `agent-log.md` | The audit trail — rolling per-change log, newest first | Every meaningful change |
| `README.md` | The build-by-build changelog | Per deploy |
| **`project-overview.md`** (this file) | **The narrative synthesis — what the project IS, why it's shaped this way, where every piece lives** | **Annually-ish, or after a big audit** |

The workflow rule (`context.md` §7): **before any change, read context
+ architecture + recent log entries; after any change, append to log,
update architecture if anything new lands, update context if rules
shift, add a bullet to the current README build entry if it's
shippable.**

---

## 11. Known follow-ups (from the most recent audit)

From the `agent-log.md` 2026-06-06 audit entry — these are docs-vs-code
drifts already flagged in the affected docs but **not yet acted on**:

1. **`backend/lib/metrics.js` is gone.** Deleted by `sajan@techmaticsys.com`
   in commit `573afe9e "prompt changes according to sales data, temp 0,
   history 5"`. The four named typed tools (`get_category_sales_for_date`,
   `get_most_expensive_products`, `get_earliest_customer_of_day`,
   `get_sales_by_hour`) that wrapped canonical SQL for BOTELLA tickets
   6 / 12 / 21 / 24 are no longer registered. Those tickets may have
   regressed to wrong answers via plain `run_sql`.
2. **`COMMIT_DELAY_MS` JS-side buffer pattern removed** from
   `streamClaude`. Pure-text streaming still works (the TCP-layer
   `setNoDelay` + the frontend layers carry it), but the tool-use
   preamble safety net is gone. Any text Claude emits before a
   `tool_use` block will briefly flash before the `clear` event wipes
   it. The system prompt's "no preamble" rule is now the only defence.
3. **`dataContextCache` TTL + `fetchDataSnapshot`** (Phase 1 hallucination
   fix) — also removed by sajan's commit. The "today is April 29"
   regression is theoretically possible again.
4. **Other `.page-*` per-page CSS rules** may have the same
   icon-dependent orphan-grid bug that the InventoryPage layout fix
   addressed: `.page-retailers`, `.page-customers`, `.page-analytics`,
   `.page-margin`, `.page-recommend`, `.page-distilleries`. Worth a
   single audit pass.
5. **Legacy SQLite seed code.** `backend/database/schema.js` + the
   `liquor_store.db` file with classic STR/CAT/TYP/INV/STK tables
   appears unused. Safe to delete in a future cleanup.
6. **Three BOTELLA tickets** (8 / 9 / 19) were diagnosed during this
   build's ticket sprint as data-ingest issues, not chat issues —
   triage separately.

---

## 12. If you only remember three things about this project

1. **Botella is the AI layer over SyncGo.** Auth re-verifies SyncGo's
   ASP.NET Identity v3 password hashes; the production PG database is
   shared (read-only) with the .NET app; the tenant model
   (`client_id` + `location_id`) is SyncGo's, not Botella's. Don't
   propose schema changes to `syncgo` without coordinating with the
   .NET team.
2. **Defence-in-depth on chat outputs is mandatory.** Three independent
   layers strip UUIDs / SQL / forbidden patterns from every response
   before it reaches the user: the prompt rules in `chat.js`, the
   `validateTenantFilter` + `isBlockedTable` SQL gates in
   `handleTool`, and the response sanitiser. Don't weaken any one of
   them assuming the others will catch it.
3. **Every chat turn costs real money and is logged.** Five cost
   columns are written to `bottleai_analytics.chat_interactions` per
   turn. If you add a new Claude call elsewhere, follow the existing
   pattern: log the interaction, calculate the cost, never let
   analytics failures bubble back into the user-facing response
   (analytics is fire-and-forget).
