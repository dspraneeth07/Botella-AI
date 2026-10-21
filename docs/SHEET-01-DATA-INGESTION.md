# Sheet 01 — Data ingestion

**Status:** complete. 49 + 30 checks, all green, verified against the live warehouse.
**Depends on:** sheet 00. **Wave:** 1. **Risk:** highest in the system.
**Nature:** additive. One new service, one new route, one migration, two lines in `server.js`.

---

## 1. The problem

Ingestion works. What it lacks is isolation and replay.

Measured on the live warehouse today: **132,611 of 519,702 sync runs have
failed — 25.5%.** (The sheet said 26.1% of 504,366; the table has grown since,
the rate has not meaningfully moved.)

At 94 stores a person can look at those. At 1,500 the same rate is background
noise, and stores go dark unnoticed while the engine keeps serving stale data
with full confidence.

**It is already happening.** The first run of the new digest found:

| Finding | Detail |
|---|---|
| A store dark for **169 days** | An `(unmapped)` store — no `client_pos_config` row at all |
| **Square: 0 runs, 27 stale stores** | A connector that is entirely silent and previously looked healthy |
| **MPower: 231 never-synced job-entities**, worst 112 days | |
| **Clover: 195 never-synced, 100 stale**, 100% failure (98/98 runs) | Every one a `401` — expired merchant tokens |
| **38 Gokul jobs that can never succeed** | `Service 'GokulService' does not implement method 'ProcessSupplier'` |
| **17 LocalDB jobs misconfigured** | `ResolveService \| Service '' not found or not registered` — empty service name |
| **API: worst 141 days** | EPOSNow-backed stores, all `401` |

None of that was visible before. It is a handful of tickets, retried a hundred
thousand times.

---

## 2. Findings that changed the design

### 2.1 The sheet's premise about *where* was wrong

The sheet says to harden `backend/services/integrationService.js`. **That file
does no POS fetching.** It is the Python-facing read API — it turns the syncgo
schema into the JSON the recommendation service pulls.

The actual fetching is done by an **external service** (the errors are stamped
`CloverService`, `GokulService`, `MPowerService`, `POS service message`) which
writes the `syncgo` warehouse. This Node backend has **SELECT-only** access
there, by design.

So this sheet did not touch `integrationService.js` at all. It adds a new
**control plane** around the fetcher: the durable log it lands into, the
classifier, the batch runner, the staleness marker, the digest.

### 2.2 The migration does not go where the sheet says

The sheet says `backend/database/migrations/003_`. That folder targets
**syncgo**, and these tables must not go there:

- The app role on syncgo is **SELECT-only by design** (`database/migrate.js`:
  *"syncgo: SYNCGO_MIGRATE_DSN, REQUIRED — there is no fallback on purpose"*).
  A table the control plane INSERTs into every few minutes cannot live on a
  connection that is not allowed to write.
- syncgo is the vendor's warehouse — the record of what stores sold. These are
  **our** operational tables.
- Every downstream consumer of staleness already reads the analytics pool.

It is `analytics-migrations/016_sync_ingestion.sql`. Nothing else changed.

### 2.3 The sheet's coverage numbers were stale — the *pattern* was right

The sheet says *"Korona's 26 stores have 100% category coverage and 0% cost;
PCAmerica reaches 89.6%."* Measured live:

| Connector | Stores | SKUs | Cost % | Category % |
|---|---:|---:|---:|---:|
| **MPower** | 3 | 41,919 | **0.00** | 100.00 |
| **Square** | 9 | 153,756 | **0.00** | **0.00** |
| **Gokul** | 19 | 160,133 | **0.00** | 98.62 |
| Clover | 25 | 158,448 | 64.59 | 82.36 |
| API | 27 | 205,768 | 66.02 | 98.23 |
| Korona | 2 | 17,547 | **88.39** | 100.00 |
| LocalDB | 17 | 165,678 | 92.30 | 99.95 |
| EPOSNow | 3 | 7,692 | 99.39 | 98.53 |

- **Korona is at 88.4% cost, not 0%** — the sheet has it backwards, and it has
  2 stores, not 26.
- **PCAmerica does not exist** in `client_pos_config` at all.
- The real zero-cost connectors are **MPower, Square and Gokul** — 31 stores,
  355k SKUs.
- **Square is worst: 0% cost AND 0% category.**

The sheet's *thesis* is exactly right and now demonstrated: coverage tracks the
connector, not the store. A digest hard-coded around Korona and PCAmerica would
have measured the wrong thing, so coverage is computed per connector from live
data rather than asserted.

### 2.4 `result` is a job log, not an error message

Every row in `job_runs_history.result` — pass or fail — opens with
`Start | Processing job for ClientId=N, LocationId=N, Entity=products`. The
actual cause is on the **last** line. Classifying the whole blob would sort
every failure by its preamble. `classifyFailure` weights the tail first.

### 2.5 My first implementation reproduced the exact bug it was meant to fix

Caught while verifying the "works on every store" requirement, and worth
recording because it is the most instructive failure in this sheet.

`refreshSyncState` originally derived its universe of (store, entity) from
**runs in the last 30 days**. Measured on the live warehouse:

- 935 jobs are configured, across 187 stores
- only **59 stores** had any run in the last 30 days
- **662 of 935 jobs (71%)** therefore got **no state row at all**
- **322 jobs have never run, ever**

So a store that stopped syncing two months ago was *invisible* — absent from
the digest, absent from the staleness read, and indistinguishable from a store
that does not exist. That is precisely "stores go dark unnoticed", faithfully
reproduced by the mechanism built to prevent it.

**Fixed:** the universe is now anchored on the `jobs` table (every configured
job) unioned with everything that has ever run. A job that has never run gets a
row with `last_successful_sync = NULL` and reads as **never synced** rather than
as absent.

The effect on visibility:

| | Before | After |
|---|---:|---:|
| State rows | 273 | **940** |
| Never-synced detected | ~51 | **587** |
| Worst staleness found | 134 days | **169 days** |
| Silent connectors detected | 0 | Square (0 runs, 27 stale stores) |

The same pass also replaced the per-row upsert with a batched `unnest` upsert:
940 rows now land in **5.2s**, where one round trip per row would have been
~7,500 round trips at 1,500 stores.

### 2.6 jsonb does not preserve key order

Caught by a test. `sync_raw_log.payload` is `jsonb` (as the sheet specifies), and
Postgres normalises key order: `{"zebra":1,"alpha":2}` reads back as
`{"alpha":2,"zebra":1}`. Hashing the bytes as they arrived would produce a
digest that **can never be re-verified after read-back** — the integrity check
would be decorative.

So `payload_sha256` is computed over the **canonical** (key-sorted) form. It
round-trips, and it makes dedupe mean the right thing: if a POS reorders its
keys between two identical fetches, that is the same document, not a second row.
We are asking *"did the data change"*, not *"did the vendor's serializer change"*.

---

## 3. Files

| File | Lines | What it is |
|---|---:|---|
| `backend/database/analytics-migrations/016_sync_ingestion.sql` | 210 | The three tables. |
| `backend/services/ingestionService.js` | 700 | The control plane: classifier, raw log, state, batch runner, digest. |
| `backend/routes/ingestion.js` | 170 | `/raw`, `/outcome`, `/freshness`, `/digest`, `/refresh-state`. |
| `backend/tests/ingestion-verify.js` | 290 | 49 checks against the real failure corpus. |
| `backend/tests/store-spectrum-verify.js` | 300 | 30 checks: the whole architecture, empty store → full store. |
| `backend/server.js` | +2 / +50 | Route mount and the 03:00 digest cron. |

**Not modified:** `integrationService.js`, `routes/integration.js`,
`database/connection.js`. The sheet named those three; §2.1 explains why the
work does not belong in them.

---

## 4. Schema

### `sync_raw_log` — land every fetch before parsing

```
id, connector, client_id, location_id, entity, fetched_at,
payload_sha256, payload jsonb, bytes,
first_fetched_at, fetch_count
UNIQUE (connector, client_id, location_id, entity, payload_sha256)
```

Replay becomes reading a row instead of re-fetching from a POS that may no
longer hold the data, and a parser bug becomes repairable for history instead
of permanent.

`entity` is part of the identity because failures are per (store, entity):
Gokul can sync products and cannot sync suppliers. Without it, replay cannot
find the right payload.

A re-fetch of identical bytes is the **common** case — most syncs change
nothing. The first landing wins; `fetch_count` records that it happened again.
Storing each one would multiply the table by the sync frequency for no
information.

`payload` may be `NULL`: *"we asked and got nothing"* is the fact being kept.

### `sync_store_state` — the staleness marker

```
client_id, location_id, entity  (PK), connector,
last_successful_sync, last_attempt_at,
consecutive_failures, last_failure_class, last_error, last_failure_at,
disabled_at, disabled_reason, updated_at
```

**`last_successful_sync` is advanced ONLY by a success.** That is the entire
"do not reintroduce" rule: a failed sync must never leave the previous data
looking fresh. A store whose last success was eleven days ago reads as eleven
days stale to every downstream stage, and sheet 02 can refuse on it.

`never_synced` is kept **distinct** from "stale by N days" — `days_stale` is
`null`, not `9999`. "Has never worked" is a different condition, not a large
number, and callers must be able to tell them apart.

### `sync_connector_digest` — one row per connector per day

Failure counts split by class, staleness (`stores_stale`, `stores_never`,
`max_stale_days`, `median_stale_days`), coverage (`skus`,
`cost_coverage_pct`, `category_coverage_pct`), and up to five `exemplars` so
the one ticket has something concrete in it.

---

## 5. Failure classification

`classifyFailure(err)` → `transient | credential | schema | dead`. Every
pattern was taken from a real, counted failure — none is speculative.

| Class | Action | Live examples | Volume |
|---|---|---|---|
| **credential** | Mark the store, notify, **do not retry** | Clover `401 Unauthorized`, EPOSNow `403 Forbidden` | ~42,000 |
| **schema** | Page the connector owner | `Service 'GokulService' does not implement method 'ProcessSupplier'`, `Invalid entity 'purchases'` | ~12,600 |
| **transient** | Retry, exponential backoff, max 3 | `504`, `429`, `ECONNRESET`, Korona `502 BadGateway` | small |
| **dead** | Disable after N, **one** ticket | `404`, `Service '' not found or not registered` | 17+ |

Three deliberate behaviours:

- **Unknown text defaults to `transient`.** Being wrong toward retry costs three
  attempts and a log line; being wrong toward `dead` silently disables a healthy
  store's sync.
- **An `Error` carrying only `{ status: 401 }` still classifies as credential.**
  Numeric status is read before the message.
- **Only `transient` is retryable.** Retrying a dead token is precisely how one
  bad credential became 27,000 identical rows.

---

## 6. Per-store isolation

```js
const summary = await runStoreBatch(stores, worker, { analyticsPool });
// { attempted, succeeded, failed, skipped, byClass, results, durationMs }
```

Returns a **summary**, never throws. Partial estate output is the normal case:
at 1,500 stores an exception that aborts the run means 1,499 stores do not sync
because one merchant rotated a token.

- Retries **only** transient failures, exponential with **jitter** — a
  connector-wide outage must not produce 1,500 synchronised retries.
- A **disabled** job is `skipped`, not attempted, and **not counted as failed**
  — otherwise a dead job inflates its connector's failure rate forever, hiding
  whether the live stores are healthy.
- A **success clears everything**, including a disable: a store that fixes its
  own token comes back on its own.

---

## 7. Connector-level aggregation

One ticket per connector per day, never one per store. This is the single
change that makes 1,500 stores operable: at 26% failure, per-store alerting is
~390 messages a day, which gets muted, after which stores go dark unnoticed.

Real output, first run:

```
CLOVER  —  25 store(s)
  runs 98   failed 98 (100%)
  by class: credential 98, schema 0, transient 0, dead 0
  staleness: 1 stale, 1 never synced, worst 134d
  coverage: cost 64.59%, category 82.36% over 158448 SKUs
    e.g. 33:33 products [credential] ... Status: 401 Unauthorized

GOKUL  —  19 store(s)
  runs 1832   failed 76 (4.1%)
  by class: credential 0, schema 76, transient 0, dead 0
  staleness: 1 stale, 38 never synced, worst 4d
  coverage: cost 0.00%, category 98.62% over 160133 SKUs
    ^ CONNECTOR DEFECT: sends no cost data at all.
```

Coverage is **first-class**, and zero cost coverage is named a
`CONNECTOR DEFECT` outright — read per store it looks like a data-quality
problem at 31 sites; read per connector it is three tickets.

A connector with **zero runs but stale stores still appears**, or "silent"
would read as "healthy".

---

## 8. API

Mounted at `/api/ingestion` under `verifyServiceToken` — server-to-server (the
fetcher, cron, ops scripts), never a browser. Same posture as `/api/clients`.

| Endpoint | Purpose |
|---|---|
| `POST /raw` | Land a fetch before parsing. `201` new, `200` deduped. |
| `POST /outcome` | Report success/failure. Success advances freshness; failure does not. |
| `GET /freshness/:clientId/:locationId` | **The read sheet 02 refuses on.** |
| `GET /digest?date=&format=text\|json` | The daily report. |
| `POST /refresh-state?days=30` | Mirror syncgo's run history into `sync_store_state`. |

### The integration point for the fetcher

```
1. POST /api/ingestion/raw      { connector, client_id, location_id, entity, payload }
2. ...parse and load...
3. POST /api/ingestion/outcome  { connector, client_id, location_id, entity, ok, error }
```

Until the external fetcher adopts those two calls, `POST /refresh-state` (run by
the 03:00 cron) derives the same state from `job_runs_history`, so the digest
and the staleness marker are **correct today** with no change to the fetcher.

### Freshness contract

```json
{
  "client_id": 33, "location_id": 33, "tracked": 5,
  "never_synced": false, "worst_days_stale": 134, "stale": true,
  "reason": null,
  "entities": [ { "entity": "products", "days_stale": 134, "stale": true,
                  "last_failure_class": "credential", "disabled": false } ]
}
```

A store with **no state row at all** returns `stale: true` with
`reason: "no_sync_state_recorded"` — never `fresh`. Absence of evidence is not
evidence of freshness.

---

## 9. Verification

```bash
cd backend
npm run migrate                       # applies 016
node tests/ingestion-verify.js        # 49 checks
node tests/store-spectrum-verify.js   # 30 checks, empty store -> full store
node scripts/check-routes.js          # route wiring

# against live data
curl -s localhost:3000/api/ingestion/digest?format=text
curl -s -XPOST localhost:3000/api/ingestion/refresh-state
```

| Sheet requirement | Proven by |
|---|---|
| A failing store does not abort the batch | checks 1, 1b, 1c |
| Identical payloads dedupe | 2c, 2d, 2g3 (incl. key-reordered) |
| Each failure class routes correctly | 3 × 9 real corpus cases, 3b–3f |
| The digest groups by connector | 4, 4b–4g |
| **A failed sync does not refresh staleness** | 5, 5b, 5d, 5f |
| Retry only what is retryable | 6, 6b, 6c |
| Disabled jobs are skipped | 7, 7b, 7c |
| **Works on every store, empty to full** | `store-spectrum-verify.js`, 30 checks (§9b) |

---

## 9b. Works on every store, empty to full

The estate is not uniform. Of 188 configured stores, **79 have zero products
and zero sales**; 88 have thousands of both. A pipeline that only works on the
healthy middle silently produces nonsense for 42% of the network.

`tests/store-spectrum-verify.js` (30 checks) exercises all three layers built
so far against three store shapes:

| | EMPTY | PARTIAL | FULL |
|---|---|---|---|
| **Ingestion** | never synced, `days_stale: null` | products fresh, sales 11d stale | all five entities fresh |
| **Daily capture** | 0 recs, `{}` bundle | some signals, few recs | full bundle, `fidelity: full` |
| **Envelope** | `ok=false` + reason, `own_weight 0.0`, `NEW` | `own_weight 0.15`, cohort disclosed | `own_weight 1.0`, `MATURE` |

The properties that matter are not "does not crash" — they are about a store
with no data never producing a **confident-looking** answer:

- An empty store reads **stale**, never fresh. A store with no state row at all
  returns `stale: true, reason: "no_sync_state_recorded"`. Absence of evidence
  is not evidence of freshness.
- `never_synced` stays **distinct** from stale-by-N: `days_stale` is `null`, not
  `0` and not `9999`. "Has never worked" is a different condition, not a large
  number.
- A run that produced **nothing is still archived** as an explicit zero. A
  missing row is indistinguishable from "the cron never fired"; a row saying
  `recommendation_count = 0` is a fact, and `idx_daily_recs_empty` makes
  "which stores produced nothing today" one indexed query.
- Empty collections are **empty arrays, never null**, so a consumer can
  `.length` them without a guard.
- Unknown coverage renders **`n/a`, never `0%`** — 0% is a connector defect and
  gets named as one; unknown is silence and must not be confused with it.
- A connector with **zero runs still appears** in the digest. Silent is not
  healthy: Square has 0 runs, 27 stale stores and a 116-day worst case.
- In a mixed batch, the healthy store still succeeds while the dead and the
  transient ones fail around it, each attributed to its own class.

---

## 10. Operating it

The 03:00 cron (`INGEST_DIGEST_SCHEDULE`) refreshes state, builds the digest,
prints it, and logs one `connector needs attention` line per connector — before
the 03:30 store-intelligence warm and the 04:00 rec batch, so the day's
staleness is known before anything reasons on the data.

| Env var | Default | Meaning |
|---|---|---|
| `SYNC_DEAD_AFTER` | 5 | Consecutive failures before disabling |
| `SYNC_MAX_RETRIES` | 3 | Max attempts for a transient failure |
| `SYNC_BACKOFF_BASE_MS` | 1000 | Backoff base; attempt *n* waits `base × 2^(n−1)` + jitter |
| `SYNC_STALE_AFTER_DAYS` | 2 | What the digest calls stale (not a refusal threshold) |
| `SYNC_CONCURRENCY` | 5 | Batch worker pool size |
| `INGEST_DIGEST_SCHEDULE` | `0 3 * * *` | Digest cron |

---

## 11. Not done

- **The external fetcher does not call `/raw` yet.** The endpoint, the table and
  the dedupe are built and tested, but until the POS service posts to it the
  raw log only fills for fetches this backend performs. Everything else —
  classification, staleness, the digest — is live today via `/refresh-state`.
  **This is the one hand-off sheet 01 needs from the connector team.**
- **No notification transport.** `credential` failures are classified, counted
  and reported; wiring them to an actual store-facing email is a separate
  decision about who receives it.
- **No retention job on `sync_raw_log`.** The app role has no DELETE; pruning is
  an admin job. Wanted before this runs at 1,500 stores for a year.
- **`Service '' not found or not registered`** (LocalDB, 17 jobs, 5 stores never
  synced) is classified `dead` and reported, but it is an upstream config bug
  someone has to go and fix.
