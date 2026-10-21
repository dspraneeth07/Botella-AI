# Daily capture: recommendations and external signals

**Status:** applied — analytics migrations `000`, `014`, `015`.
**Databases touched:** `bottleai_analytics` only.
**Applies to:** the rebuild of the recommendation engine. This is the data
layer the new engine reads, writes and is measured against.

---

## 1. Why this exists

Before this change, the daily output of the recommendation system survived in
a form that could not support a rebuild.

| What we needed | What was actually stored |
|---|---|
| The engine's **input** for a given store on a given day | A **display-trimmed** chip list (`SIGNAL_DISPLAY_CAP`, ~10 entries) on `recommendation_runs.signal_snapshot`. Everything past the cap — which the prompt *did* see — was discarded at write time. |
| Why a signal was **missing** | Nothing. A timed-out Ticketmaster, an unconfigured API key, and a genuinely quiet day were byte-identical in the snapshot. |
| The **raw** upstream response | Nothing. A parser bug was unrepairable for all historical data. |
| Signals from a run that **failed** | Nothing. Signals are gathered before the LLM call; a model error discarded the whole day's observations for that store, silently. |
| "What did we recommend to this store **on this day**" | Only reconstructable by joining runs → recommendations, re-filtering holdouts, and casting `generated_at::date` in whatever timezone the reader happened to have. |
| A **day key** | None existed. Every consumer re-derived it, and they did not all agree. |

On top of that, the core tables had **no DDL in version control at all** — see
§7.1.

## 2. The three databases

Keeping these straight matters; they are not interchangeable.

| Database | Role | Written by |
|---|---|---|
| `syncgo` | Read-only POS warehouse: products, sales, customers. | Nobody here. SELECT-only by design. |
| `bottleai_analytics` | **Everything in this document.** Recommendations, evaluations, POs, chat telemetry, and the new daily capture. | The Node backend, exclusively. |
| `storeagent` | The Python StoreAgent module's own app DB (inventory runs, canonical caches). | The Python StoreAgent module. Unrelated to daily capture. |

**Node is the only writer of `bottleai_analytics`.** The Python service stays
stateless — it holds no analytics credentials and writes nothing. It *reports*
what it saw in its HTTP response, and Node persists it. That preserves the
property that makes the Python service horizontally scalable, and means there
is exactly one writer with no dual-write races.

## 3. Schema

### 3.1 `daily_store_signals` — the per-store daily signal cell

One row per **(store, store-local day)**. Migration `014`.

| Column | Type | Notes |
|---|---|---|
| `client_id`, `location_id`, `signal_date` | `integer`, `integer`, `date` | **Primary key.** `signal_date` is the STORE's calendar date (§4). |
| `day_basis` | `text` | `store_local` \| `utc`. How `signal_date` was derived. |
| `timezone` | `text` | IANA zone, e.g. `America/Chicago`. NULL when `day_basis='utc'`. |
| `captured_at`, `first_captured_at` | `timestamptz` | `first_captured_at` survives upserts — it is the one fact an upsert would otherwise destroy. |
| `capture_count` | `integer` | Runs that landed on this day. |
| **`bundle`** | `jsonb` | **THE CELL.** The complete, untrimmed `SignalBundle` the engine received. |
| `bundle_fidelity` | `text` | `full` \| `display_trimmed`. See the warning below. |
| `display_snapshot` | `jsonb` | The capped view the owner saw. Different question from `bundle`; both get asked. |
| `weather`, `sports`, `events`, `holidays`, `news`, `social` | `jsonb` | **Generated columns** (`GENERATED ALWAYS AS (bundle -> '<field>') STORED`). They cannot drift from `bundle` the way hand-written duplicates would. |
| `active_keys` | `text[]` | The keys a recommendation is allowed to cite. GIN-indexed. |
| `news_categories`, `news_product_keywords`, `event_categories`, `trend_categories`, `trend_product_keywords` | `text[]` | Analyst-produced eligibility widenings. |
| `source_health` | `jsonb` | `{source: {ok, items, latency_ms, cache_hit, dormant, error}}` — §3.4. |
| `source_geo_keys` | `jsonb` | `{source: {scope, key}}` — the join to `signal_source_payloads`. |
| `sources_ok`, `sources_failed`, `sources_dormant` | `integer` | Rolled up from `source_health`. Dormant is **not** a failure. |
| `signal_count` | `integer` | Entries in the FULL bundle — not the snapshot's count. |
| `latitude`, `longitude`, `state`, `geo_source` | — | `geo_source` ∈ `profile` \| `geocoded` \| `none`. Explains geo-scoped gaps. |
| `bundle_sha256` | `char(64)` | "Did anything change since yesterday" in one comparison. |
| `engine_version` | `text` | |

> **`bundle_fidelity` is load-bearing.** `display_trimmed` means only the
> ~10-entry chip view was available (a Node deploy talking to a Python service
> that predates full-bundle capture). Those rows are honest history but **not
> training data** — a backtest that trains on them while believing it has the
> engine's whole input produces confidently wrong conclusions. The column
> defaults to the pessimistic value deliberately.

### 3.2 `signal_source_payloads` — raw upstream responses

One row per **(source, geo_scope, geo_key, fetch_date)** — keyed by geography,
**not** by store. Migration `014`.

| Column | Type | Notes |
|---|---|---|
| `source` | `text` | Matches the cache namespace in `app/signals/__init__.py`. |
| `geo_scope` | `text` | `global` \| `state` \| `gridpoint` \| `latlon` \| `store`. CHECK-constrained. |
| `geo_key` | `text` | `''` for global, `TX`, `32.78,-96.8`, … Never NULL (NULLs would not dedupe). |
| `fetch_date` | `date` | |
| `payload` | `jsonb` | `{"requests": [{url, status, body, latency_ms}]}` — every HTTP call the logical fetch made. NULL on a failed fetch. |
| `payload_sha256`, `payload_bytes`, `item_count` | — | |
| `ok`, `http_status`, `latency_ms`, `error` | — | A failure gets a row: "we asked and got nothing" is the fact being recorded. |
| `capture_count`, `captured_at`, `first_captured_at` | — | `capture_count` doubles as a fan-out signal ("this gridpoint serves 340 stores"). |

**Why geo-keyed:** one NWS gridpoint forecast is byte-identical for every store
on it; the national sports schedule and the social feeds are identical for
everyone. Per-store storage would duplicate the same JSON ~1,200× per day and
turn a tens-of-MB/year table into a multi-GB one for zero extra information.
The geo key here is exactly the key `app/clients/signal_cache.py` already uses
to collapse those fetches, so the two agree by construction.

### 3.3 `daily_store_recommendations` — the per-store daily rec cell

One row per **(store, store-local day)**. Migration `015`.

| Column | Type | Notes |
|---|---|---|
| `client_id`, `location_id`, `rec_date` | | **Primary key.** |
| `day_basis`, `timezone` | `text` | As above. |
| `run_id` | `bigint` | FK → `recommendation_runs(id)` **ON DELETE SET NULL**, not CASCADE: if a run is pruned, the archive is the thing we most want to keep. |
| `signal_date` | `date` | The `daily_store_signals` row this was reasoned from. No FK — signal capture is fail-soft, and a rec set must still be recordable on a day where signal persistence failed. |
| `generated_at`, `first_captured_at`, `capture_count`, `data_as_of` | | |
| **`recommendations`** | `jsonb` | **THE CELL.** Rank-ordered array; each element's `id` is the real `recommendations.id`, so per-rec outcomes (evaluations, votes, action claims) join straight back. CHECK-constrained to an array. |
| `candidate_count`, `recommendation_count`, `shown_count`, `holdout_count`, `dropped_invalid` | `integer` | |
| `categories`, `action_types` | `text[]` | Distinct vocab present. GIN-indexed on `action_types`. |
| `engine_version`, `model`, `prompt_version` | `text` | All nullable: unreported must read as unknown, never as zero. |
| `llm_input_tokens`, `llm_output_tokens`, `llm_cost_usd`, `latency_ms` | | |
| `recommendations_sha256` | `char(64)` | |

**Also added to `recommendation_runs`:** `rec_date`, `day_basis`, `timezone`
(all nullable; the seven pre-existing runs are deliberately **not** backfilled
— we do not know which zone they were meant to be read in, and inventing one
would be worse than admitting it is unknown. Readers treat NULL as "legacy,
fall back to `generated_at`").

### 3.4 `source_health` semantics

Three states that a `SignalBundle` alone cannot distinguish:

```jsonc
{
  "weather": { "ok": true,  "items": 1, "latency_ms": 412 },        // worked
  "events":  { "ok": true,  "items": 0, "dormant": "no_api_key" },  // by design
  "sports":  { "ok": false, "items": 0, "error": "degraded: HTTP 500" }
}
```

- `dormant` (`no_api_key` / `disabled` / `no_geo`) — produced nothing **by
  design**. Counted in `sources_dormant`, **never** as a failure; counting it
  as one would make every store read as permanently degraded.
- `ok: false` — should have worked, did not.
- `"degraded: …"` — the subtle one. Nearly every fetcher is fail-soft: it
  catches its own HTTP error and returns `[]` so a dead source never sinks a
  run. That is correct behaviour, and it means the factory returns *normally*
  after a total upstream outage. Health therefore defers to the **transport**
  verdict, not to "did the factory raise". Observed in testing: ESPN 500ing on
  every request while sports health read healthy with zero items —
  indistinguishable from a quiet sports day, and exactly the confusion this
  layer exists to remove.

## 4. The day key

`signal_date` and `rec_date` are the **store's own calendar date**.

The daily cron fires at **04:00**, which is the *previous evening* in every US
timezone. Keying on UTC (or on the server's zone, which differs between an IST
dev box and a US prod box) labels the whole network's Tuesday as Wednesday.

Resolution chain:

1. **`store_local`** — the IANA zone from NWS's `/points` response for the
   store's gridpoint. The weather fetch already performs that lookup, so the
   zone costs nothing extra and is authoritative for US stores.
2. **`utc`** — fallback when the store has no usable coordinates. Recorded as
   such in `day_basis`, so no row is ever silently ambiguous.

Both sides compute it, from the same IANA zone, and always agree:

- Python — `app/signals/capture.py :: resolve_day_key` (`zoneinfo`)
- Node — `backend/services/dailySnapshotService.js :: resolveDayKey` (`Intl`)

> **Dates are strings at every boundary.** `node-postgres` parses a Postgres
> `date` into a JS `Date` at **local midnight**, so a row stored as
> `2026-09-22` reads back as `2026-09-21T18:30:00Z` on an IST machine and
> `.toISOString().slice(0,10)` then yields the **wrong day**. Every date
> crossing `dailySnapshotService` is a `'YYYY-MM-DD'` string, and every SELECT
> casts `::text`. The existing rec-eval fixtures already carry a comment about
> this exact hazard.

## 5. Data flow

```
04:00  cron  ─→  Node recommendationService.generateAndPersist
                      │
                      ├─1─→ POST Python /run-recommendations/{cid}/{lid}
                      │         │
                      │         ├─ gather_signals()  ── per-source health + geo keys
                      │         │     └─ httpx response hook ── raw bodies (geo-keyed)
                      │         ├─ build_prompt → LLM → validate
                      │         └─ RunResult { …, signal_capture, engine }
                      │
                      ├─2─→ persistRun()  ── ONE TRANSACTION
                      │         ├─ recommendation_runs      (+ rec_date/day_basis/timezone)
                      │         ├─ recommendations          (RETURNING id)
                      │         └─ daily_store_recommendations
                      │
                      └─3─→ captureSignalsForRun()  ── best-effort, after commit
                                ├─ daily_store_signals
                                └─ signal_source_payloads
```

**Three writes, three deliberately different durability rules:**

| Write | Rule | Why |
|---|---|---|
| `daily_store_recommendations` | **Inside** the run transaction | The archive and the run rows must never disagree about a day. A run that cannot be archived at day grain is not one we want half-recorded. |
| `daily_store_signals` | **After** the commit, best-effort | Failing to record what the weather was must not throw away successfully generated recommendations. A missing row is visible and recoverable; losing the recs is neither. |
| `signal_source_payloads` | After the commit, best-effort, geo-keyed | Shared across stores. The hundredth store reporting the same payload is a cheap upsert no-op. |

## 6. Where the code is

### Node — `backend/`

| Path | Role |
|---|---|
| [database/analytics-migrations/000_base_tables.sql](backend/database/analytics-migrations/000_base_tables.sql) | Recovered baseline (§7.1). |
| [database/analytics-migrations/014_daily_signal_capture.sql](backend/database/analytics-migrations/014_daily_signal_capture.sql) | `signal_source_payloads`, `daily_store_signals`. |
| [database/analytics-migrations/015_daily_store_recommendations.sql](backend/database/analytics-migrations/015_daily_store_recommendations.sql) | `daily_store_recommendations`, `recommendation_runs.rec_date`. |
| [database/migrate.js](backend/database/migrate.js) | Runner; gained the `-- @baseline` pragma. |
| [services/dailySnapshotService.js](backend/services/dailySnapshotService.js) | Day keys, all three upserts, schema probes. |
| [services/recommendationService.js](backend/services/recommendationService.js) | `persistRun` writes the archive in-transaction; `generateAndPersist` captures signals after commit. |
| [tests/daily-snapshot-verify.js](backend/tests/daily-snapshot-verify.js) | 30 checks against the real analytics DB. |

### Python — `Botella_External_APIs/`

| Path | Role |
|---|---|
| `app/signals/capture.py` | `SignalRecorder` (health, per store), `RawPayloadCollector` (raw, per geography), `resolve_day_key`, the httpx response hook. |
| `app/signals/__init__.py` | `_maybe_cached` wraps every fetch in a `fetch_scope` — the one place that knows both a source's name and its geography. |
| `app/signals/weather.py` | Lifts the IANA `timeZone` out of the `/points` response. |
| `app/schemas/recommendation.py` | `SignalCapture`, `RawSourcePayload`, `EngineInfo` on `RunResult`. |
| `app/recommender/pipeline.py` | Owns the collector, attaches the hook, assembles `signal_capture`. |
| `tests/test_signal_capture.py` | 16 tests: day keys, DST, health, degradation, concurrency isolation. |

**Concurrency note:** a bulk run fans out many stores over one shared httpx
client, so the response hook cannot tell from the request which fetch it
belongs to. A `contextvars.ContextVar` set around each factory carries that;
asyncio tasks inherit context, so attribution is correct with thirty stores in
flight. There is a test for exactly this.

## 7. Findings from this work

### 7.1 `000_base_tables.sql` was missing from the repo

`schema_migrations` records `000_base_tables.sql` as applied in every
environment, but **the file was never committed**. `recommendations`,
`recommendation_runs`, `chat_interactions`, `feedback` and
`storeagent_capability_results` therefore had no DDL under version control.

A fresh database could not be provisioned from the repo: `npm run migrate`
reaches `001`, then dies at `002`'s
`ALTER TABLE recommendations ADD COLUMN reference_upc` against a table that
does not exist. The only way to stand up a new environment was to `pg_dump` an
old one — impossible in CI, in a throwaway test database, or on a new laptop.

**Fixed.** The DDL was transcribed from the live schema (PostgreSQL 16.15) —
column order, types, defaults, nullability, indexes and CHECK constraints all
match what is deployed. The file is marked `-- @baseline` on line 1, which
tells the runner: this is the authoritative text for DDL that is **already
applied**, so reconcile the recorded checksum once and do **not** re-execute
it. Without the pragma every environment would report permanent
`WARNING … was EDITED after being applied` drift — the kind of warning people
learn to scroll past. Consequence, stated plainly: **editing a `@baseline` file
changes no existing database.** Use it only for a recovered or squashed
baseline; fix forward everywhere else.

### 7.2 Pre-existing issues found but NOT changed

These are real and were deliberately left alone — each is a separate decision
and none is required for daily capture. Flagging rather than fixing.

1. **Migrations 001–004 are drifted.** All four were edited after being
   applied; `npm run migrate` warns about each on every run. Unrelated to this
   work (confirmed against a clean tree). They need either a documented
   reconciliation or a fix-forward file.
2. **`tests/rec-eval-verify.js` crashes.** `TypeError: skus.filter is not a
   function` at `tests/rec-eval-verify.js:128`, in the test's own mock query
   router. Confirmed identical on a clean tree — pre-existing, not a
   regression. The suite passes 10 checks then aborts, so rec-eval has been
   partly unverified for a while.
3. **Lazy `CREATE TABLE` in request paths.** `routes/storeagent.js` and
   `services/feedbackService.js` create tables at runtime, contradicting
   migration 001's stated rule ("there is deliberately NO lazy CREATE in app
   code"). `routes/storeagent.js` also contains an unguarded
   `DELETE FROM storeagent_capability_results;` inside a lazy migration path.
4. **`Botella_External_APIs/` is untracked** in this repo — a separate
   codebase living inside the working tree with its own `.gitlab-ci.yml`. The
   two deploy independently but share a contract; nothing enforces that they
   stay in step.
5. **Pre-existing mypy/ruff baseline** in the Python service (~107 mypy errors
   across 25 files, a handful of ruff findings). Files touched here are clean;
   the rest was not in scope.

## 8. Operating it

```bash
# Apply (idempotent; safe to re-run)
cd backend && npm run migrate
npm run migrate:status          # applied / pending / baseline / DRIFTED

# Verify the capture layer against the real analytics DB (30 checks)
node tests/daily-snapshot-verify.js

# Python side
cd Botella_External_APIs
./.venv/Scripts/python.exe -m pytest -q        # 481 tests
./.venv/Scripts/python.exe -m pytest tests/test_signal_capture.py -q
```

### Query recipes

```sql
-- One store's last week: what we knew, what we said, and what was broken.
SELECT s.signal_date, s.signal_count, s.sources_failed, s.bundle_fidelity,
       r.recommendation_count, r.action_types
  FROM daily_store_signals s
  LEFT JOIN daily_store_recommendations r
    ON  r.client_id = s.client_id AND r.location_id = s.location_id
    AND r.rec_date  = s.signal_date
 WHERE s.client_id = 46 AND s.location_id = 46
 ORDER BY s.signal_date DESC LIMIT 7;

-- Which stores could have cited a heat advisory yesterday (GIN-indexed).
SELECT client_id, location_id
  FROM daily_store_signals
 WHERE signal_date = current_date - 1
   AND active_keys @> ARRAY['heat_advisory'];

-- Network signal health for a day, worst first.
SELECT signal_date, count(*) AS stores,
       sum(sources_failed) AS failed, sum(sources_dormant) AS dormant
  FROM daily_store_signals
 GROUP BY 1 ORDER BY 1 DESC LIMIT 14;

-- The raw bytes behind one store's weather on one day.
SELECT p.payload
  FROM daily_store_signals s
  JOIN signal_source_payloads p
    ON  p.source     =  'weather'
    AND p.geo_scope  =  s.source_geo_keys->'weather'->>'scope'
    AND p.geo_key    =  s.source_geo_keys->'weather'->>'key'
    AND p.fetch_date =  s.signal_date
 WHERE s.client_id = 46 AND s.location_id = 46 AND s.signal_date = '2026-09-21';

-- Rows that are history but NOT training data.
SELECT signal_date, count(*) FROM daily_store_signals
 WHERE bundle_fidelity = 'display_trimmed' GROUP BY 1 ORDER BY 1 DESC;
```

### Growth and retention

Rough order of magnitude at 1,200 stores:

| Table | Rows/day | Notes |
|---|---|---|
| `daily_store_signals` | 1,200 | Dominated by `bundle` + the stored generated columns; TOAST-compressed. |
| `daily_store_recommendations` | 1,200 | Small — ~10 recs of prose each. |
| `signal_source_payloads` | tens | Geo-deduplicated. This is the whole point of layer 1. |

No partitioning yet, and no retention job — **deliberately**. Both primary keys
lead with tenant and carry the date, so range-partitioning by date later is a
mechanical change. The app role has **no DELETE** on any of the three: pruning
is an admin job, never something a request path can do.

## 9. What is not done

- **No retention/partitioning job** (§8) — wanted before this runs on the full
  network for a year, not before it runs at all.
- **No standalone `GET /signals/{cid}/{lid}` endpoint.** Signals are captured
  as part of a run, so a run that fails *before* returning still loses that
  store's signals for the day. The failure window is much smaller than before
  (capture no longer depends on the LLM succeeding, only on the response being
  returned), but it is not zero. A signal-only endpoint would close it and
  would also serve backfills and debugging.
- **No backfill** of `rec_date` on the seven legacy runs (§3.3) — intentional.
- **`bundle_fidelity` will read `display_trimmed`** until the updated Python
  service is deployed alongside this Node change. Both are in this changeset;
  they just have to ship together. Node logs a warning on every run that
  stores a trimmed bundle, so the condition is loud rather than silent.
