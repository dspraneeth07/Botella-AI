# Contextual Intelligence Service

A Python (FastAPI) service that produces **8–10 daily, signal-aware product
recommendations per liquor store**. It fuses external real-world signals
(weather, sports, local events, holidays, news) with each store's own inventory
and sales velocity, and surfaces the result in the suggestions tab of your
existing web app.

> *"There's a heatwave Friday, the Eagles play Sunday, and Cinco de Mayo is
> Monday — load up on Modelo, Tito's, Casamigos, and lime juice today."*

This implements `contextual_intelligence_design.md` with one deliberate
architectural change for this deployment:

- **No database in Python.** All DB-backed data (store profile, inventory,
  sales) is fetched over HTTP from your **Node backend**. See
  [`API_CONTRACT.md`](./API_CONTRACT.md) for the exact endpoints to build.
- **Stateless generator.** The run endpoint returns the recommendations as
  JSON; **Node persists them and serves reads** to the frontend.

---

## How it works

```
external cron ──▶ POST /run-recommendations/{location_id}
                       │
                       ▼
          ┌─ external signals (asyncio.gather, fail-soft) ─┐
          │   NWS weather · ESPN sports · Ticketmaster      │
          │   events · static holidays · NewsData news      │
          │   daily industry email (IMAP)                   │
          └─────────────────────────────────────────────────┘
          ┌─ store data (fetched raw from Node, computed here) ─┐
          │   velocity (z-scored within category) · inventory   │
          │   health flags · 90-day summary · ~150 candidates   │
          └──────────────────────────────────────────────────────┘
                       │
                       ▼
          one Claude tool-use call  →  validate (drop hallucinated SKUs)
                       │
                       ▼
              RunResult JSON  →  Node persists + UI reads
```

Total wall time per store ≈ 8–15s. The signal fan-out, store-data math, and the
single LLM call are the only moving parts — no scheduler, no workers, no vector
store.

### Project layout

```
app/
├── main.py                 # FastAPI app factory + lifespan (creates/owns clients)
├── config.py               # typed settings (pydantic-settings)
├── logging_config.py       # structlog
├── exceptions.py           # domain errors + handlers
├── dependencies.py         # FastAPI DI providers
├── api/routes.py           # run endpoints (single, bulk, batch submit/status/collect), health
├── clients/
│   ├── node_api.py         # NodeApiClient — the ONLY source of DB data
│   ├── signal_cache.py     # geo-keyed TTL cache shared across stores in a run
│   └── retry.py            # transient-only retry policy
├── signals/                # weather, sports, events, holidays, news + mapping
├── store_data/             # velocity, inventory_health, store_summary, candidates
├── recommender/
│   ├── context_builder.py  # fan-out + assemble RecommendationContext
│   ├── prompt_builder.py   # compact system prompt + per-store payload
│   ├── llm_client.py       # tool-use call (single stream + Message Batches)
│   ├── validator.py        # anti-hallucination (SKU salvage, citation + date checks)
│   └── pipeline.py         # end-to-end orchestration (single + bulk + batch)
└── schemas/                # pydantic models (store, signals, derived, recommendation, bulk, feedback)
tests/                      # pure-logic + client + app tests
```

---

## Quick start

Requires Python 3.11+.

```bash
cd Botella_external_api
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

cp .env.example .env
# edit .env: set NODE_API_BASE_URL and ANTHROPIC_API_KEY (minimum)

uvicorn app.main:app --reload --port 8000
```

Then, with your Node endpoints live (path is `{client_id}/{location_id}`):

```bash
curl -X POST http://localhost:8000/run-recommendations/96/42 | jq
```

Health checks: `GET /health`, `GET /healthz`. Interactive docs at `/docs`.

### Run the tests

```bash
pytest          # pure-logic + client + app tests (no network, no API key needed)
ruff check .    # lint
mypy app        # types
```

---

## Triggering (production)

The service has **no internal scheduler**. Point your existing post-close cron at
it. For a single store:

```bash
curl -fsS -X POST "$SERVICE_URL/run-recommendations/$CLIENT_ID/$LOCATION_ID"
```

The endpoint runs synchronously and returns `200` with the `RunResult` or a
non-2xx with an error envelope; **let cron handle retries.** Your cron (or a thin
Node handler) takes the `RunResult` and writes it to the DB.

### Whole network — the bulk endpoint

`POST /run-recommendations` (no path params) takes a list of pairs and lets the
**service** own concurrency, so it can share the geo-keyed signal cache across
stores instead of relying on `xargs -P`. Per-store failures are reported in
`errors[]` without sinking the run:

```bash
curl -fsS -X POST "$SERVICE_URL/run-recommendations" -H 'content-type: application/json' -d '{
  "pairs": [{"client_id": 96, "location_id": 42}, {"client_id": 96, "location_id": 43}],
  "mode": "concurrent"
}'
```

- **`mode: "concurrent"`** (default) — live runs, bounded by `BULK_MAX_CONCURRENCY`,
  immediate results. When prompt caching is on, the first store runs alone to
  warm the prefix cache, then the rest fan out and read it.
- **`mode: "batch"`** — submits **one Anthropic Message Batch** (~50% LLM token
  cost) and holds the connection open while it processes. Ideal for the nightly
  cron, which tolerates minutes of latency; give your client a generous timeout.

The response is a `BulkRunResult`: `{ mode, requested, succeeded, failed,
batch_id, results: [RunResult...], errors: [...] }`. Persist each `RunResult`
exactly as for the single-store endpoint.

#### Non-blocking batch (preferred for large runs)

Holding one connection open for a 30-minute batch is fragile through proxies.
The submit/status/collect flow does the same thing in three short calls:

```bash
curl -X POST "$SERVICE_URL/run-recommendations/batch" -d '{"pairs": [...]}'   # -> batch_id
curl "$SERVICE_URL/run-recommendations/batch/$BATCH_ID"                        # poll until "ended"
curl -X POST "$SERVICE_URL/run-recommendations/batch/$BATCH_ID/collect" -d '{"pairs": [...]}'
```

Collect rebuilds each store's context, so SKU validation runs against *current*
stock; a 409 means the batch hasn't ended yet. Anthropic retains results for
29 days, so a missed collect is recoverable.

---

## Configuration

All settings live in `app/config.py` and load from env / `.env`. The only
**required** values are `NODE_API_BASE_URL` and `ANTHROPIC_API_KEY`. Notable
optional ones:

| Var | Default | Purpose |
|-----|---------|---------|
| `SERVICE_API_KEY` | — | When set, all work endpoints require this value in `X-API-Key` (401 otherwise). Set it in production — runs cost LLM money. |
| `LLM_MODEL` | `claude-sonnet-4-6` | Recommendation model. Sonnet matches the design's cost model (~$2–3K/mo at 1,200 stores). Set `claude-opus-4-8` for more headroom. |
| `LLM_EFFORT` | `medium` | Thinking depth / token spend (`low`–`max`; blank = API default). |
| `PROMPT_CACHE_ENABLED` | `true` | Caches the static system+tool prefix across stores in a daily run. Note: Sonnet 4.6 only caches prefixes ≥ 2,048 tokens — the shipped system prompt clears that; verify via `cache_read` in the `llm_call_complete` log line. |
| `CANDIDATE_POOL_SIZE` | `150` | SKUs surfaced to the model. |
| `FEEDBACK_WINDOW_DAYS` | `30` | Window of past recs fetched from Node (optional endpoint) to measure realized lift. |
| `SPORTS_LOCAL_RADIUS_MILES` | `40` | A home game is "local" when the team's metro is within this distance of the store. |
| `TICKETMASTER_API_KEY` / `NEWSDATA_API_KEY` | — | Optional; those signals degrade gracefully to empty when absent. |
| `EMAIL_IMAP_USER` / `EMAIL_IMAP_PASSWORD` | — | Credentials for the subscription mailbox (Titan Mail / GoDaddy IMAP); the email signal stays dormant without them. Sender allowlist via `EMAIL_SENDERS`. |
| `SIGNAL_CACHE_ENABLED` / `SIGNAL_CACHE_TTL_SECONDS` | `true` / `21600` | Shares weather/sports/events/holidays/news fetches across stores in the same area within a run. Set `false` to disable. |
| `BULK_MAX_CONCURRENCY` / `BULK_MAX_PAIRS` | `8` / `500` | Concurrency and size cap for the bulk endpoint. |
| `BATCH_POLL_INTERVAL_SECONDS` / `BATCH_MAX_WAIT_SECONDS` | `10` / `1800` | Poll cadence and ceiling for `mode="batch"` (Message Batches API). |
| `CORS_ALLOW_ORIGINS` | `[]` | CORS is **off** by default (machine-to-machine service); set a JSON list to enable. |

### Tuning the signal → category map

`app/signals/mapping.py` maps active signals (e.g. `heat_advisory`,
`cinco_de_mayo`, `nfl_home_game`) to **product category tokens**. Mapping is
**family-aware**: a generic token (`beer`, `wine`, `spirits`) expands to every
granular token in that family (`beer_ipa`, `stout`, `bourbon`, `wine_red`, ...),
so a well-categorized inventory never falls out of eligibility on an
exact-string comparison — including on quiet days, when the fallback covers all
three families. This is the only "rules" left in the system — it shapes
*eligibility*, not the actual picks (the LLM reasons over the candidates).

---

## Signal sources (all free tiers)

| Signal | Source | Key needed |
|--------|--------|------------|
| Weather forecast + alerts | NWS `api.weather.gov` | No (set a descriptive `NWS_USER_AGENT`) |
| Pro sports (NFL/NBA/MLB/NHL) | ESPN unofficial endpoints | No |
| Holidays (federal + drinking) | Static Python module | No |
| Local events / concerts | Ticketmaster Discovery API | `TICKETMASTER_API_KEY` |
| Local news | NewsData.io | `NEWSDATA_API_KEY` |
| Daily industry email | IMAP mailbox (Titan Mail / GoDaddy) | `EMAIL_IMAP_USER` + `EMAIL_IMAP_PASSWORD` |

Any signal source that errors or lacks a key is skipped — a flaky ESPN endpoint
never blocks a run. Details worth knowing:

- **Weather** scans the full `SIGNAL_LOOKAHEAD_DAYS` forecast window (a Friday
  heatwave is visible on Tuesday's run), and only *stock-up class* alerts
  (winter storm, blizzard, hurricane, severe thunderstorm, extreme heat/cold,
  ...) activate the `severe_weather` eligibility key — an air-quality alert or
  rip-current statement stays prompt-only context.
- **Sports** fetches all leagues concurrently and caches **one national
  schedule** for the whole network. A game is "local" when the home team's
  metro is within `SPORTS_LOCAL_RADIUS_MILES` of the store's coordinates
  (haversine against a static team → metro table), so a Buffalo store no longer
  flags Knicks games; teams missing from the table fall back to the
  venue-state heuristic.
- **News is analyzed semantically, not keyword-matched.** A small LLM call
  (`NEWS_LLM_MODEL`, Haiku by default — one call per *state* per signal-cache
  TTL, so cost is independent of store count) reads the fetched headlines and
  returns structured analysis per article: impact direction (`demand_up`,
  `demand_down`, `price_increase_risk`, `supply_risk`), affected **category
  tokens** (which widen candidate eligibility exactly like mapped signal keys),
  **product-name keywords** (e.g. "rioja", "cava" for a Spanish-tariff story —
  matching candidates get a `NEWS_MATCH` tag), a citable snake_case key, and a
  one-line actionable note shown on the news line. So "Trump announces tariffs
  on Spanish imports" becomes a buy-ahead recommendation on the store's actual
  Spanish SKUs — without anyone having anticipated that headline in a keyword
  list. Headlines the analyst rejects are dropped from the prompt and the
  snapshot entirely (a local journalism award never reaches the owner's
  active-signals view). The fetch query also widens in this mode (`"<state>" OR (<topics>)`)
  since relevance filtering happens downstream. Everything is fail-soft: if the
  analyst is disabled (`NEWS_LLM_ENABLED=false`) or errors, the narrow
  keyword pipeline (`(<topics>) AND "<full state name>"`, precise phrases only)
  is the floor.
- **Events are screened for liquor relevance the same way.** The raw
  Ticketmaster feed within `EVENT_RADIUS_MILES` is indiscriminate: a kids'
  puppet show and a stadium country act both used to surface as an equally
  weighted name + date. A small LLM call (`EVENTS_LLM_MODEL`, Haiku by default,
  one call per store *area* per signal-cache TTL) reads a broad, de-duplicated
  fetch (multi-night runs collapse into one event with a `nights` count) and
  keeps **only** the top `EVENTS_MAX_KEPT` events that plausibly move liquor
  demand (drinking-age crowd: concerts, festivals, pro/college sports, food &
  drink events), each with a
  crowd-size judgment (`draw`: major/moderate/minor), the **categories** that
  crowd actually buys (widening eligibility like news categories do), a citable
  snake_case key, and a one-line note ("Country crowd, stock beer cold").
  Irrelevant events are dropped from the prompt, the snapshot the frontend
  shows, and eligibility, so they no longer assert `event_nearby`. Fail-soft:
  if disabled (`EVENTS_LLM_ENABLED=false`) or erroring, the segment-keyword
  mapping keeps every nearby event exactly as before.
- **The daily industry email is mined for actionable items.** The network
  subscribes to a daily email from a Sazerac rep (`EMAIL_SENDERS`, default
  `mbrown@sazerac.com`), pulled over IMAP from the shared mailbox (GoDaddy
  Professional Email is powered by Titan Mail — `imap.titan.email:993`; a
  legacy GoDaddy Workspace mailbox uses `imap.secureserver.net` instead, check
  the domain's MX records). The mailbox is store-independent but must be fresh
  per run — the issue lands shortly before the post-close cron — so its cache
  entry uses a short TTL override (`EMAIL_CACHE_TTL_SECONDS`, 15 min): every
  run re-reads the mailbox, while all stores within a run share one read-only
  IMAP round-trip (messages are fetched with `BODY.PEEK`, so nothing is marked
  read). Only a **fresh** issue counts: messages older than
  `EMAIL_MAX_AGE_HOURS` (20) are skipped, so a run never re-ships yesterday's
  news; and when the primary mailbox has no fresh issue, the server's declared
  `\Junk` folder plus the `EMAIL_SPAM_MAILBOXES` name guesses are checked too,
  because the subscription sometimes lands in spam. Because one issue can carry an allocation drop, two price increases,
  and a page of pleasantries, a small LLM call (`EMAIL_LLM_MODEL`, Haiku by
  default, one call per run) *extracts* the demand-relevant items instead of
  classifying the whole message; each
  item rides the news channel tagged `industry_email` with an impact
  direction, category tokens and product keywords (widening eligibility like
  analyzed news), a citable `email_*` key, and a one-line note. An issue with
  nothing actionable contributes nothing. Fail-soft twice over: a flaky
  mailbox yields no signals, and an analyst error degrades to the subject
  line as prompt-only context. Dormant until `EMAIL_IMAP_USER` and
  `EMAIL_IMAP_PASSWORD` are set.
- **Geocoding** caches definitive results (hits and confirmed no-matches)
  forever, but a transient Census outage is retried on the next run instead of
  disabling weather/events for the process lifetime.

**Signals shape eligibility, not just context.** Weather, sports, holidays —
**and now nearby events and strong local news** — emit *active keys* that
[`app/signals/mapping.py`](./app/signals/mapping.py) turns into eligible product
categories for the signal-aligned candidate slice. A local concert
(`event_concert`), a beer festival (`event_festival`/`news_festival`), or a
viral-cocktail story (`news_viral_cocktail`) now widens the candidate pool
instead of being prompt-only text the model couldn't act on. The holiday
calendar also covers Valentine's, Mardi Gras (Easter-derived), Easter,
Mother's/Father's Day, Oktoberfest, Day of the Dead, and Lunar New Year on top
of the original set.

### Geocoding & current data caveats (Node side)

The Node `clients` table stores a **street address** (`address, city, state,
postal_code, country`), not coordinates. The service geocodes that address to
lat/long with the free **US Census geocoder** (no key, US-only, cached
in-process), which is what enables NWS weather and Ticketmaster events. No DB
backfill of coordinates is required. If a profile already carries
`latitude`/`longitude`, geocoding is skipped. If the address is missing/unmatched,
weather + events simply stay empty and the run still succeeds. Set
`GEOCODING_ENABLED=false` to turn it off.

Some source fields are optional and degrade gracefully:

- **No product `created_at`** → the "new arrivals" candidate slices (`new` /
  `new_hot`) stay inert, and no `new_arrival` recommendations are produced.
  Node now fills `created_at` from its first-seen catalog tracking (it diffs
  each inventory pull's SKU set against a registry — see the contract §1.2), so
  this only applies to callers that don't send it.
- **No product `cost`** → profit context stays inert: per-SKU gross margin and the
  category margin mix are simply omitted, and the model is told to ignore margin
  rather than guess. Send `cost` on the inventory rows and the model starts
  preferring higher-margin picks and quantifying markdown give-up — no other
  change needed.
- **Data can lag wall-clock** → velocity/health windows anchor to the latest
  `sale_date` in the data (returned as `data_as_of`), not to "today", so a
  lagging sync never makes every SKU look like it's falling.

---

## Data-driven extras (inert until Node ships the endpoints)

Three optional Node endpoints unlock more grounding — all degrade gracefully
(404 = section simply absent), exactly like `cost` and `created_at`:

- **Feedback loop (scored, not just prompted)** —
  `GET .../recommendation-history?days=30` (API_CONTRACT §1.4). Every past rec
  gets a deterministic **score** in Python: realized lift (units in the 7 days
  after the rec vs. the SKU's trailing 21-day baseline, squashed to 0–1) blended
  with explicit **thumbs up/down votes** when the UI provides them
  (`FEEDBACK_LIFT_WEIGHT`/`FEEDBACK_USER_WEIGHT`, renormalized when a component
  is missing). The scores act mechanically, not just rhetorically:
  - recs scoring ≥ `FEEDBACK_WINNER_THRESHOLD` (0.6) push their SKUs into a
    **"proven" candidate slice** (tagged `PROVEN` in the prompt) — feedback
    changes eligibility the same way signals do;
  - recs scoring ≤ `FEEDBACK_LOSER_THRESHOLD` (0.4) land on a **didn't-convert
    avoid-list** the model is told not to re-recommend without changed
    conditions;
  - the per-category score/lift table and confidence-calibration split still go
    into the prompt for the judgment-level steering.
- **Data-driven bundles** — `GET .../co-purchases?days=90&limit=50`
  (API_CONTRACT §1.5). Real basket co-occurrence pairs are shown to the model
  (only pairs where both SKUs are in the candidate pool), and the system prompt
  instructs it to ground `bundle` recommendations in them instead of guessing
  affinities.
- **Cross-store area winners** — `GET .../area-winners?days=30&limit=10`
  (API_CONTRACT §1.6). New products (first seen ≤ 7 days) selling well at
  OTHER stores in the same area, matched by UPC and fully anonymized. Carried
  winners join the candidate pool as an `AREA_WINNER` slice; not-carried ones
  render in an AREA WINNERS prompt section and may earn the sanctioned SKU-less
  `new_arrival` + `stock_new` recommendation ("start carrying this").

Quantities are also grounded now: every candidate line carries `wk:` (units/
week), and the system prompt's quantity-math rules make `quantity_hint` an
arithmetic result ("wk:12, stock:5 → order 20–30 units"), not a vibe.

## Later stages (deliberately not built yet)

Kept here so the roadmap survives the codebase:

- **Year-over-year / month-over-month seasonality** — "last Cinco de Mayo,
  tequila ran 3.4× baseline here" needs Node to serve last year's sales window;
  highest-persuasion rationale line available once it exists.
- **Eval harness** — freeze a handful of real `RecommendationContext`s as
  fixtures, replay them through the prompt + LLM on every prompt change, score
  mechanically (SKU validity, category spread, citation validity) + LLM-as-judge.
- **Observability** — `/metrics` (Prometheus): runs, latency, token usage and
  cost per run, signal-source failure rates, cache hit rate; bind
  `client_id`/`location_id` into structlog contextvars via middleware.
- **Structured `quantity_hint`** — `{min_units, max_units}` instead of a string
  so Node can one-click a rec into a PO line (contract change, coordinate with
  the frontend).
- **Out of scope here: cross-store benchmarking** — network-level comparisons
  are owned by a separate service; duplicating them here risks the two
  disagreeing.

---

## Docker

```bash
docker build -t contextual-intelligence .
docker run --rm -p 8000:8000 --env-file .env contextual-intelligence
# or: docker compose up --build
```

---

## What this service does not do

- **No DB access** — all data comes from Node (`API_CONTRACT.md`).
- **No persistence** — it returns results; Node stores them.
- **No scheduler / workers / vector store** — request-driven. One LLM call per
  store (single endpoint), or one Message Batch for a bulk `mode="batch"` run.
