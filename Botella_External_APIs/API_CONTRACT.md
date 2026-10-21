# Node ↔ Python API Contract

This Python service holds **no database connection**. Every DB-backed value is
fetched from your Node backend over HTTP, and the generated recommendations are
handed back to the caller (cron / Node) to persist and serve.

This document is the source of truth for the contract. It matches the endpoints
Node ships today (nested under `/api/clients/:clientId/locations/:locationId`)
and stays in sync with `app/clients/node_api.py` (inbound) and
`app/schemas/recommendation.py` (the result Node persists).

```
                 ┌──────────────────────────── Python service ────────────────────────────┐
 external cron ─▶│ POST /run-recommendations/{client_id}/{location_id}                      │
                 │     │                                                                    │
                 │     ├─ GET {NODE}/api/clients/{cid}/locations/{lid}/profile   ─┐         │
                 │     ├─ GET {NODE}/api/clients/{cid}/locations/{lid}/inventory  ├─ raw ◀── Node + DB
                 │     └─ GET {NODE}/api/clients/{cid}/locations/{lid}/sales?days ┘ rows    │
                 │     │                                                                    │
                 │     └─▶ fan-out signals → compute → 1 Claude call → validate             │
                 │                                                                          │
                 │  returns RunResult JSON ─────────────────────────────────────────────────┼─▶ cron/Node
                 └────────────────────────────────────────────────────────────────────────────┘
                                                                       Node persists + serves to UI
```

**Tenant keys.** `client_id` and `location_id` are both mandatory path segments
on every call — that's exactly how the non-negotiable `client_id + location_id`
filter is satisfied for this non-JWT machine caller.

**Auth (outbound, Python → Node).** Optional today. When `NODE_API_TOKEN` is
set, Python sends `Authorization: Bearer <token>` on every request; drop your
Bearer middleware in on the Node side and set the env var — no Python change
needed.

**Auth (inbound, cron/Node → Python).** When `SERVICE_API_KEY` is set, every
work endpoint (`/run-recommendations*`) requires that value in the `X-API-Key`
header and returns `401 { "error": { "code": "unauthorized" } }` otherwise.
Health endpoints stay open for probes. Unset = open (development only).

**Envelopes.** Responses may be a bare JSON array/object **or** a
`{ "data": ... }` envelope. Errors use `{ "error": { "code", "message" } }`.

---

## 1. Endpoints you implement in Node (inbound to Python)

### 1.1 `GET /api/clients/:clientId/locations/:locationId/profile`

Store metadata for geo-targeting signals + prompt context. Return the **street
address** fields — the Python side geocodes them to lat/long (free US Census
geocoder, cached), so you do **not** need to store coordinates.

**Response `200`**

```json
{
  "id": 42,
  "name": "Downtown Wine & Spirits",
  "address": "251 Broadway",
  "city": "Saranac Lake",
  "state": "NY",
  "postal_code": "12983",
  "country": "USA",
  "size_class": "medium"
}
```

| Field         | Type            | Required | Notes                                                                 |
|---------------|-----------------|----------|-----------------------------------------------------------------------|
| `id`          | integer         | ✅       | Location id.                                                          |
| `name`        | string          | ➖       | Defaults to "Unknown store".                                          |
| `address`     | string \| null  | ➖       | Street address (e.g. "251 Broadway"). Used for geocoding.            |
| `city`        | string \| null  | ➖       | Used for geocoding + shown in the prompt.                            |
| `state`       | string \| null  | ➖       | 2-letter code. Geocoding + the sports "local game" heuristic.        |
| `postal_code` | string \| null  | ➖       | Accepted as `postal_code` (or `zip`). Used for geocoding.            |
| `country`     | string \| null  | ➖       | Geocoding is US-only; non-US (`country` not USA/US) skips it.        |
| `latitude`    | number \| null  | ➖       | Optional. If you ever store coordinates, send them and geocoding is skipped. |
| `longitude`   | number \| null  | ➖       | Optional — same.                                                     |
| `dma_code`    | string \| null  | ➖       | Optional / informational.                                            |
| `size_class`  | string          | ➖       | Free-text; default `medium`.                                         |

> **Geo comes from the address.** The service builds `"<address>, <city>, <state>,
> <postal_code>"`, geocodes it once (cached in-process), and uses the result for
> NWS weather + Ticketmaster events. If the address is missing or doesn't match,
> those two signals stay empty and the run still succeeds on holidays + sports +
> inventory — no errors. Non-US stores skip geocoding (Census is US-only).

Return `404` for an unknown location.

---

### 1.2 `GET /api/clients/:clientId/locations/:locationId/inventory`

Current on-hand snapshot, one row per stocked product. Soft-deleted products
excluded; `on_hand = 0` rows are included.

**Response `200`**

```json
[
  {
    "sku": "0123",
    "product_name": "Modelo Especial 12pk",
    "category": "beer_mexican",
    "sub_category": "mexican_lager",
    "price": 18.99,
    "cost": 13.25,
    "on_hand": 48,
    "created_at": null
  }
]
```

| Field          | Type             | Required | Notes                                                                |
|----------------|------------------|----------|----------------------------------------------------------------------|
| `sku`          | string           | ✅       | Stable per-location product key. Join key for sales.                |
| `product_name` | string           | ➖       |                                                                      |
| `category`     | string \| null   | ➖       | **Must match the tokens in `app/signals/mapping.py`** (e.g. `beer_mexican`, `tequila`) for signal-aligned selection, and drives health thresholds via the leading token (`wine_rose` → `wine`). |
| `sub_category` | string \| null   | ➖       | Shown to the model for nuance.                                      |
| `price`        | number \| string | ➖       | Unit retail price; numeric strings coerced. Default `0`.            |
| `cost`         | number \| string \| null | ➖ | **Optional** unit cost (what the store paid). When present, the service computes gross margin % per SKU and a units-weighted category margin mix, and the model is told to prefer higher-margin picks / quantify markdown give-up. Absent/`null` → margin context degrades to inert (no guessing). |
| `on_hand`      | integer          | ➖       | Units in stock. Default `0`.                                        |
| `created_at`   | ISO datetime \| null | ➖   | **First-seen date from Node's catalog tracking** (the products table has no creation timestamp; `last_updated` mutates every sync, so it's deliberately not used). Node diffs each inventory pull's SKU set against its `product_first_seen` registry and returns when the SKU first appeared; SKUs present before tracking started (baseline) stay `null`. Drives the "new"/"new_hot" candidate slices (≤ 7 days old). |

---

### 1.3 `GET /api/clients/:clientId/locations/:locationId/sales?days=90`

POS sales for the trailing window. `days` is a query param (default 90).
Pre-aggregated to **one row per sku per day** (smallest payload at scale) — the
Python side re-aggregates either way.

> **Canonical demand semantics (one-number rule).** This feed measures the
> same units the storeagent demand engine measures, so both AI surfaces quote
> one velocity per product: each line's key is remapped to the canonical
> `products.sku` when the store rang it under the product's **upc** (dual-key
> catalog, deduped so a shared barcode never fans out; unmatched lines keep
> their raw sku), **VOID sales are excluded**, and **only positive quantities
> count** (returns don't subtract from demand).

**Response `200`**

```json
[
  { "sku": "0123", "sale_date": "2026-06-01", "units": 14, "unit_price": 18.99 },
  { "sku": "0245", "sale_date": "2026-05-30", "units": 3,  "unit_price": 52.99 }
]
```

| Field        | Type             | Required | Notes                                              |
|--------------|------------------|----------|----------------------------------------------------|
| `sku`        | string           | ✅       | Joins to inventory.                               |
| `sale_date`  | `YYYY-MM-DD`     | ✅       | Used for the 7/30/90-day windows.                 |
| `units`      | integer          | ➖       | Units sold. Default `0`.                          |
| `unit_price` | number \| string | ➖       | Used for the revenue-mix summary. Default `0`.    |

> **Data-lag handling (important).** Node anchors its window to `MAX(sale_date)`,
> not wall-clock, because the source DB can lag. **The Python side matches this**:
> velocity windows (7/30/90-day) and trend are anchored to the latest `sale_date`
> in the returned rows (`data_as_of` in the result), not to "today". This keeps
> recent buckets from silently losing days and mislabeling every SKU as
> "falling". Real wall-clock "today" is still used for signals and `valid_through`.

---

### 1.4 `GET /api/clients/:clientId/locations/:locationId/recommendation-history?days=30&limit=20` — **optional**

Past persisted recommendations (the ones Python generated and Node stored).
Powers the **feedback loop**: Python joins these against the sales rows it
already fetched, measures each rec's realized lift (units in the 7 days after
vs. the SKU's trailing baseline), and tells the model which recommendation
categories actually convert at this store.

**`limit`** (Python sends `20` by default) bounds the list so it never fills the
prompt. Return **voted recs first** (a thumbs up/down is the scarce, high-value
signal), then the most recent unvoted recs, up to `limit`. Python re-applies the
same voted-first cap defensively, so an over-sized or unordered response is
still bounded — but ordering it on the Node side keeps the *right* recs.

**This endpoint is optional.** Until Node implements it (404 is fine), the
feedback section of the prompt simply doesn't render — nothing breaks.

Each rec gets a **score** in Python: realized lift blended with thumbs votes
(weights configurable). Recs scoring above the winner threshold push their
SKUs into the candidate pool as a "proven" slice; recs below the loser
threshold land on a didn't-convert avoid-list shown to the model.

**Response `200`**

Either a bare array of rows (older Node) or the envelope below (current Node).
Python accepts both; the `effectiveness` lists degrade to empty when absent.

```json
{
  "data": [
    {
      "date": "2026-05-12", "category": "weather", "primary_skus": ["0123"],
      "confidence": 0.82, "thumbs_up": 1, "thumbs_down": 0,
      "evaluated_score": 0.71, "action_taken": true, "action_claim": "did",
      "verdict": "winner", "lift": 2.3
    }
  ],
  "effectiveness": {
    "proven": [
      { "sku": "0245", "name": "Casamigos Blanco 750ml", "category": "calendar_sports",
        "evidence": "worked 2 of 2 times, avg lift 2.1x" }
    ],
    "avoid": [
      { "sku": "0788", "name": null, "category": "bundle",
        "evidence": "worked 0 of 2 times" }
    ]
  }
}
```

Row fields (`data[]`):

| Field             | Type           | Required | Notes                                            |
|-------------------|----------------|----------|--------------------------------------------------|
| `date`            | `YYYY-MM-DD`   | ✅       | The day the recommendation was generated.        |
| `category`        | string         | ➖       | The rec's `category` enum value.                 |
| `primary_skus`    | string[]       | ➖       | The SKUs the rec cited.                          |
| `confidence`      | number \| null | ➖       | Enables confidence-calibration feedback.         |
| `thumbs_up`       | integer        | ➖       | Count of positive user votes on this rec (UI feature; send `0`/omit until it exists). |
| `thumbs_down`     | integer        | ➖       | Count of negative votes. Votes are weighted into the rec's score alongside computed lift. |
| `evaluated_score` | number \| null | ➖       | Node's measured 0-1 score from the rec's longest **scored** window; supersedes Python's own blend when present. |
| `action_taken`    | bool \| null   | ➖       | Tri-state from the rec's longest **evaluated** window: `true` = store seen acting, `false` = provably did not (we checked), `null` = can't tell. Never round `null` up. May come from a different window than `evaluated_score`. |
| `action_claim`    | string \| null | ➖       | Owner self-report: `did` \| `did_not` \| `dismissed` \| null. `dismissed` = declined to answer (evidence of nothing). |
| `verdict`         | string \| null | ➖       | `winner` \| `neutral` \| `underperformer` \| `insufficient_data` \| null, from the longest evaluated window. `insufficient_data` = not yet measured, never a failure. |
| `lift`            | number \| null | ➖       | RAW UNCAPPED stored lift of that window. Python caps at 5 before averaging or displaying (honesty rule). |

`effectiveness` (always present in the envelope; `{proven: [], avoid: []}` when
nothing qualifies): register-measured SKU lessons — one row per rec's longest
scored window, holdout excluded, 365-day lookback independent of `?days=`, a
SKU needs ≥ 2 scored evaluations; mean `final_score` ≥ 0.6 → `proven`,
≤ 0.4 → `avoid`; each list caps at 10 entries. Entry fields:

| Field      | Type           | Required | Notes                                              |
|------------|----------------|----------|----------------------------------------------------|
| `sku`      | string         | ✅       |                                                    |
| `name`     | string \| null | ➖       | Product name; `null` when the warehouse was slow/unreachable. |
| `category` | string         | ➖       | Modal rec category for that SKU.                   |
| `evidence` | string         | ➖       | Plain-language measured fragment, e.g. `worked 2 of 2 times, avg lift 2.1x` (avg already capped at 5 server-side). |

Python renders these in the prompt's **MEASURED TRACK RECORD** section (prefer
proven SKUs, never re-recommend repeated losers, distinguish "owner ignored"
from "followed and failed") and boosts proven SKUs into the candidate pool's
`PROVEN` slice.

### 1.5 `GET /api/clients/:clientId/locations/:locationId/co-purchases?days=90&limit=50` — **optional**

Top basket co-occurrence pairs (two SKUs in the same transaction), computed
from your transaction/basket data. Grounds the `bundle` recommendations in
observed behavior instead of LLM guesses. Pairs are only shown to the model
when **both** SKUs are in the candidate pool, so send the top pairs by support
and let Python filter.

**This endpoint is optional** — 404 degrades to no co-purchase section.

**Response `200`**

```json
[
  { "sku_a": "0123", "sku_b": "0456", "support": 41 }
]
```

| Field     | Type    | Required | Notes                                  |
|-----------|---------|----------|----------------------------------------|
| `sku_a`   | string  | ✅       |                                        |
| `sku_b`   | string  | ✅       |                                        |
| `support` | integer | ➖       | Number of baskets containing both SKUs.|

### 1.6 `GET /api/clients/:clientId/locations/:locationId/area-winners?days=30&limit=10` — **optional**

Cross-store new-product intelligence: products **first seen ≤ 7 days ago** at
**other** stores in this store's area (same state; same-city weighted first)
that are selling at least ~5 units in the window. Matched across stores by
`upc` (SKUs are per-location POS codes) and returned as **anonymized
aggregates** — no contributing store is ever identified. Powers `new_arrival`
recommendations, including `stock_new` picks for products this store doesn't
carry yet.

**This endpoint is optional** — 404 degrades to no AREA WINNERS section.

**Response `200`**

```json
[
  {
    "upc": "0812066021123",
    "product_name": "High Noon Peach 4pk",
    "category": "rtd",
    "store_count": 3,
    "same_city_stores": 1,
    "avg_weekly_units": 6.2,
    "days_since_first_seen": 12,
    "carried": false,
    "this_store_sku": null,
    "this_store_on_hand": null
  }
]
```

| Field                  | Type           | Required | Notes                                                   |
|------------------------|----------------|----------|---------------------------------------------------------|
| `upc`                  | string         | ✅       | Cross-store product identity (the barcode).             |
| `product_name`         | string         | ➖       | From the strongest-selling contributor.                 |
| `category`             | string \| null | ➖       |                                                         |
| `store_count`          | integer        | ➖       | Contributing nearby stores (≥ threshold units each).    |
| `same_city_stores`     | integer        | ➖       | Of those, how many share this store's city.             |
| `avg_weekly_units`     | number         | ➖       | Mean units/week per contributing store.                 |
| `days_since_first_seen`| integer \| null| ➖       | Age of the earliest first-seen among contributors.      |
| `carried`              | boolean        | ➖       | Whether THIS store already stocks the product.          |
| `this_store_sku`       | string \| null | ➖       | This store's SKU when carried (joins the candidate pool tagged `AREA_WINNER`). |
| `this_store_on_hand`   | integer \| null| ➖       | This store's stock when carried.                        |

> A **NOT CARRIED** winner can produce a SKU-less recommendation:
> `category = new_arrival`, `action_type = stock_new`, `primary_skus = []`,
> with the product named at the start of the rationale and `area_winner` in
> `signals_cited`. Persist it like any other rec — the UI renders it from the
> rationale.

### 1.7 `GET /api/clients/:clientId/locations/:locationId/trend-validation?terms=aperol,high+noon` — **optional**

Register-measured validation of **social-media trending drink terms** (the
Python side's Reddit / Google Trends signal channel). For each term, Node
matches product names / sub-categories word-bounded against **same-state peer
stores** and reports how many sell a match, at what weekly rate (28-day
window, anchored to each store's latest sale), and how many are
**accelerating** (trailing-7-day rate ≥ 1.3× the prior baseline). This is what
separates internet hype from drinks actually moving at nearby registers.

`terms` is a comma-separated list (letters/digits/space/hyphen/apostrophe,
2-40 chars each, max 8 terms; invalid terms are dropped, and an entirely
invalid list is a `400`).

**Privacy:** identical posture to §1.6 — anonymized aggregates only, and the
velocity fields are `null` entirely when fewer than 3 peer stores sell a match
(k-anonymity floor). `stores_selling` alone is always reported.

**This endpoint is optional** — 404/failure degrades to no TREND PROOF section.

**Response `200`**

```json
[
  {
    "term": "buzzballz",
    "stores_selling": 5,
    "avg_weekly_units": 6.3,
    "accelerating_stores": 3,
    "product_name": "BuzzBallz Chocolate Tease 200ml",
    "upc": "854372008021",
    "carried": false,
    "this_store_sku": null,
    "this_store_on_hand": null,
    "this_store_weekly_units": null
  }
]
```

| Field                     | Type            | Required | Notes                                                  |
|---------------------------|-----------------|----------|--------------------------------------------------------|
| `term`                    | string          | ✅       | Echoed input term (normalized lowercase).              |
| `stores_selling`          | integer         | ➖       | Same-state peer stores with matching sales (28d).      |
| `avg_weekly_units`        | number \| null  | ➖       | Mean units/week per selling store; null below floor.   |
| `accelerating_stores`     | integer \| null | ➖       | Stores whose last 7d outpace their baseline; null below floor. |
| `product_name`            | string \| null  | ➖       | Strongest peer seller's product (stock_new grounding). |
| `upc`                     | string \| null  | ➖       | That product's barcode (cross-store identity).         |
| `carried`                 | boolean         | ➖       | Whether THIS store stocks a matching product.          |
| `this_store_sku`          | string \| null  | ➖       | This store's best-stocked matching SKU when carried.   |
| `this_store_on_hand`      | integer \| null | ➖       | Its on-hand when carried.                              |
| `this_store_weekly_units` | number \| null  | ➖       | This store's own weekly rate for matches (28d).        |

> A **NOT CARRIED** proof with a named top seller can produce the second
> SKU-less shape: `category = social_trending`, `action_type = stock_new`,
> `primary_skus = []`, the product named at the start of the rationale and the
> trend's `trend_<term>` key in `signals_cited`. The validator stamps
> `reference_upc` from the proof, so the effectiveness evaluator can later
> detect the store started carrying it — same loop as area winners.

### 1.8 `GET /api/clients/:clientId/locations/:locationId/social-trends?days=14` — **optional**

**Instagram hashtag velocity** for the drink-hashtag vocabulary Node's cron
polls daily on Meta's Graph API (Meta has no trending API, so trend = a
term's post velocity accelerating against its own baseline). **GLOBAL data**
— hashtag popularity is not per-store — but mounted under the tenant path so
it rides the same auth as every other integration pull.

Python treats this as a *quantification* source like Google Trends: rows
whose `acceleration` clears its threshold become `momentum = rising` entries
merged onto the social channel (and therefore into §1.7 trend validation).

`days` (default 14, clamped 2-60) bounds the baseline window server-side.

**This endpoint is optional** — 404/failure/empty degrades to no Instagram
contribution. Rows carry `acceleration = null` until the poller has ≥ 2 days
of snapshots for the term (observable, not yet rankable).

**Response `200`**

```json
{
  "data": [
    {
      "term": "espressomartini",
      "display_term": "espresso martini",
      "hashtag_id": "17842306324066640",
      "captured_at": "2026-08-17T09:49:03.184Z",
      "posts_per_hour": 2.6,
      "engagement": 21772,
      "baseline_posts_per_hour": 1.4,
      "baseline_points": 6,
      "acceleration": 1.857
    }
  ],
  "source": "instagram",
  "window_days": 14
}
```

| Field                     | Type            | Required | Notes                                                    |
|---------------------------|-----------------|----------|----------------------------------------------------------|
| `term`                    | string          | ✅       | Normalized hashtag (lowercase alnum, no `#`).            |
| `display_term`            | string \| null  | ➖       | Word-bounded form ("espresso martini") for product matching; falls back to `term`. |
| `hashtag_id`              | string \| null  | ➖       | Meta's permanent hashtag node ID.                        |
| `captured_at`             | string \| null  | ➖       | Timestamp of the latest snapshot.                        |
| `posts_per_hour`          | number \| null  | ➖       | Latest velocity (timestamp spread of newest posts); null when the sample is too thin. |
| `engagement`              | number \| null  | ➖       | Likes + comments over the latest top-posts sample.       |
| `baseline_posts_per_hour` | number \| null  | ➖       | Mean velocity of prior-day observations in-window (20h+ older than latest — daily snapshots sit ~24h apart). |
| `baseline_points`         | integer         | ➖       | Observations behind the baseline (0 = fresh deployment). |
| `acceleration`            | number \| null  | ➖       | `posts_per_hour / baseline_posts_per_hour`; the ranking signal. |

**Dynamic vocabulary** — `POST .../social-trends/observed-terms` (optional):
after each run, Python reports the trend terms its discovery channels
surfaced, as `{"terms": [{"term", "display_term"?, "source"?}]}`. Node stores
them (14-day freshness TTL) and the daily Instagram poll merges the freshest
into its vocabulary beside the stable core, governed to stay under Meta's
30-unique-hashtags/7-days cap — so a newly viral drink starts being measured
within a day of first sighting. Response: `{"accepted": n}`. Fire-and-forget;
failures never affect the run.

### 1.9 `GET /api/clients/:clientId/locations/:locationId/register-trends?limit=8` — **optional**

**Register-measured trend discovery** — the inverse of §1.7: no input terms.
Node mines same-state peer registers for drink categories whose trailing 7
days outpace their prior 21-day baseline (same windows, acceleration bar,
anonymization, and k-anonymity floor as §1.7; term identity is
`sub_category` where filled, else `category` with the family prefix
stripped). Python renders each row as a `registers` TREND line — the
strongest evidence tier its prompt knows — and skips re-validating these
terms through §1.7.

**This endpoint is optional** — 404/failure degrades to no register-trend
lines. Rows below the floors (3+ selling stores, 2+ accelerating) never
appear.

**Response `200`**

```json
{
  "data": [
    {
      "term": "gin",
      "stores_selling": 5,
      "accelerating_stores": 4,
      "avg_weekly_units": 7.7,
      "avg_growth": 2.0,
      "product_name": "The Botanist 50mL",
      "upc": "087236700423"
    }
  ],
  "source": "registers"
}
```

| Field                 | Type           | Required | Notes                                                   |
|-----------------------|----------------|----------|---------------------------------------------------------|
| `term`                | string         | ✅       | Normalized category term (lowercase, prefix stripped).  |
| `stores_selling`      | integer        | ➖       | Same-state peers selling the category (28d, ≥ 3).       |
| `accelerating_stores` | integer        | ➖       | Peers whose last 7d beat their baseline (≥ 2).          |
| `avg_weekly_units`    | number \| null | ➖       | Mean units/week per selling store.                      |
| `avg_growth`          | number \| null | ➖       | Mean recent/baseline rate ratio across measurable peers.|
| `product_name`        | string \| null | ➖       | Top cross-store seller in the category (rec grounding). |
| `upc`                 | string \| null | ➖       | That product's barcode (cross-store identity).          |

---

## 2. What Python returns (you persist this in Node)

`POST /run-recommendations/{client_id}/{location_id}` responds `200` with a
`RunResult`. Persist the envelope as one `recommendation_runs` row and each item
as a `recommendations` row.

```json
{
  "client_id": 96,
  "location_id": 42,
  "generated_at": "2026-06-03T09:12:44.000Z",
  "data_as_of": "2026-06-01",
  "candidate_count": 150,
  "recommendations_generated": 9,
  "dropped_invalid": 1,
  "signal_snapshot": {
    "weather": null,
    "sports": [],
    "events": [
      {
        "name": "Zach Bryan", "venue": "Moody Center", "date": "2026-05-08",
        "distance_mi": 2.1, "category": "Music", "nights": 2,
        "draw": "major", "key": "event_zach_bryan_moody_center",
        "note": "Country crowd two nights running, stock beer and seltzer cold."
      }
    ],
    "holidays": [{ "name": "Cinco de Mayo", "date": "2026-05-05", "days_away": 2, "key": "cinco_de_mayo" }],
    "news": [],
    "active_keys": ["cinco_de_mayo", "event_concert", "event_nearby", "event_zach_bryan_moody_center"]
  },
  "recommendations": [
    {
      "rank": 1,
      "category": "calendar_sports",
      "action_type": "pre_stock",
      "primary_skus": ["0245"],
      "quantity_hint": "order 3-5 cases",
      "rationale": "Cinco de Mayo in 2 days. Casamigos Blanco is a fast mover running low (understock flag) — pre-stock ahead of the holiday.",
      "signals_cited": ["cinco_de_mayo"],
      "confidence": 0.84,
      "valid_through": "2026-05-05"
    }
  ]
}
```

**Suggested mapping**

| `recommendation_runs` | from RunResult              | `recommendations` | from each item        |
|-----------------------|-----------------------------|-------------------|-----------------------|
| `client_id`           | `client_id`                 | `run_id`          | FK to the run row     |
| `location_id`         | `location_id`               | `location_id`     | `location_id`         |
| `generated_at`        | `generated_at`              | `rank`            | `rank`                |
| `data_as_of`          | `data_as_of` (date)         | `category`        | `category`            |
| `signal_snapshot`     | `signal_snapshot` (jsonb)   | `action_type`     | `action_type`         |
| `candidate_count`     | `candidate_count`           | `primary_skus`    | `primary_skus` (text[]) |
| `recommendation_count`| `recommendations_generated` | `quantity_hint`   | `quantity_hint`       |
|                       |                             | `rationale`       | `rationale`           |
|                       |                             | `signals_cited`   | `signals_cited` (text[]) |
|                       |                             | `confidence`      | `confidence`          |
|                       |                             | `valid_through`   | `valid_through` (date) |

Enum values:
- `category` ∈ `inventory_understock`, `inventory_overstock`, `weather`, `calendar_sports`, `news`, `bundle`, `new_arrival`, `social_trending`
- **Budgets**: the daily categories share one cap (`max_recommendations`, default 10); `social_trending` rides a **separate budget** (`trending_max_recommendations`, default 4, top-N by `confidence`) and its recs rank **after** the dailies — consumers should render them as their own Trending section, not mixed into the daily list
- `action_type` ∈ `pre_stock`, `endcap`, `cold_box`, `bundle`, `markdown`, `reorder`, `liquidate`, `promote`, `stock_new`

The `signal_snapshot` may also carry `social` (term-level trend entries:
`term`, `source`, `mentions`, `score`, `momentum`, `interest`, `evidence`,
`key`, `note`) plus `trend_categories` / `trend_product_keywords` — additive
fields the frontend SignalStrip renders as trend chips.

`primary_skus` is non-empty for every recommendation except the three
sanctioned SKU-less shapes: `new_arrival` + `stock_new` + `area_winner` cited
(§1.6), `social_trending` + `stock_new` + a `trend_<term>` key cited (§1.7),
and `new_arrival` + `stock_new` + `market_gap` cited — a Market-tab
assortment gap (a peer-proven product the store does not carry), sourced
in-process from the storeagent market engine and rationed to
`market_gap_recs_max` (default 1) per run.

Each recommendation also carries `reference_upc` (string | null): set ONLY on
SKU-less `stock_new` picks — the area winner's, trend proof's, or market
gap's UPC, stamped by the validator. Persist it
(`recommendations.reference_upc`); Node's effectiveness evaluator uses it to
detect that the store later started carrying the product.

Each recommendation also carries `suggested_order_qty` (integer | null): the
**canonical reorder quantity** from the shared storeagent demand engine — the
exact `order_qty` the Store Intelligence Buying tab prints for that SKU.
Stamped by the validator on single-SKU `reorder`/`pre_stock` picks (which
also enforces that `quantity_hint` quotes it, in units, never cases); null
otherwise. Persist it (`recommendations.suggested_order_qty`, analytics
migration 007) so downstream surfaces can render the figure without parsing
hint prose. A `reorder` pick whose SKU the engine says needs nothing is
dropped by the validator — reorders only ship when there is something to
order.

**Effectiveness evaluation (Node-side).** Node measures every persisted rec
against realized sales / restocks / price changes over configurable windows
(`REC_EVAL_WINDOWS`, default 7/30/60/90 days) and stores one
`recommendation_evaluations` row per (rec, window) — see
`backend/services/recommendationEvalService.js`. Dollar attribution
(revenue/margin impact), a weekly per-store digest, a pending-actions nudge
feed and an anonymized network benchmark build on the same rows; the
Effectiveness sub-tab in the UI renders it all. The §1.4 history rows include
each rec's measured `evaluated_score` (0-1, longest evaluated window, null
until evaluated); this Python service treats it as authoritative for that
rec's feedback score when present (it already blends lift, action compliance
and shrunk votes), avoiding double-counting.

When `REC_HOLDOUT_PCT` > 0 on the Node side, a slice of each run is persisted
with `status = 'holdout'`: generated and evaluated normally but never shown to
the store and **excluded from the §1.4 history feed** — the shown-vs-holdout
lift comparison estimates what would have sold anyway.

#### `signal_capture` — the day's full signal record (persist to `daily_store_signals`)

`signal_snapshot` above is the **owner-facing chip list**: capped at
`SIGNAL_DISPLAY_CAP` entries and trimmed for the UI. It is not the engine's
input and must never be stored as though it were. `signal_capture` is the rest
of the story, and Node persists it to `daily_store_signals` +
`signal_source_payloads` (analytics migrations 014/015).

```json
{
  "signal_capture": {
    "bundle": { "weather": { "...": "the COMPLETE untrimmed SignalBundle" } },
    "signal_date": "2026-09-21",
    "day_basis": "store_local",
    "timezone": "America/Chicago",
    "source_health": {
      "weather": { "ok": true, "items": 1, "latency_ms": 412 },
      "sports":  { "ok": false, "items": 0, "error": "degraded: HTTP 500" },
      "events":  { "ok": true, "items": 0, "dormant": "no_api_key" },
      "news":    { "ok": true, "items": 5, "cache_hit": true }
    },
    "source_geo_keys": { "weather": { "scope": "gridpoint", "key": "32.78,-96.8" } },
    "latitude": 32.7801, "longitude": -96.8005,
    "state": "TX", "geo_source": "geocoded",
    "raw_payloads": [
      {
        "source": "weather", "geo_scope": "gridpoint", "geo_key": "32.78,-96.8",
        "fetch_date": "2026-09-21", "item_count": 4, "ok": true,
        "http_status": 200, "latency_ms": 412,
        "payload": { "requests": [{ "url": "...", "status": 200, "body": {} }] }
      }
    ]
  }
}
```

Field notes, because several of these are easy to misread:

- **`signal_date` / `day_basis` / `timezone`** — the STORE'S calendar date. The
  daily cron fires at 04:00 UTC, which is the previous evening in every US
  timezone, so a UTC-keyed day misdates the whole network. The zone comes from
  the IANA `timeZone` that NWS returns for the store's gridpoint; without
  coordinates `day_basis` is `"utc"` and `timezone` is null. Node derives the
  same key the same way and the two always agree.
- **`source_health`** — what makes an ABSENT signal legible. `dormant`
  (`no_api_key` / `disabled` / `no_geo`) means the source produced nothing **by
  design** and is NOT a failure; `ok: false` means it should have worked and
  did not. A `"degraded: ..."` error means the fetcher absorbed an upstream
  failure and returned empty — the run survived, but the source did not answer.
- **`raw_payloads`** — keyed by GEOGRAPHY, not by store, because that is what
  the response varies by: one NWS gridpoint forecast is identical for every
  store on it. Node upserts on `(source, geo_scope, geo_key, fetch_date)`, so a
  thousand stores reporting the same payload collapse to one row. Each entry
  bundles every HTTP call the logical fetch made (weather makes four) under
  `payload.requests`. The list is DRAINED per response, so most runs in a bulk
  fan-out carry an empty one — that is correct, not a bug.
- **`engine`** (sibling of `signal_capture`) — `{ version, model,
  prompt_version, input_tokens, output_tokens, cost_usd, latency_ms }`,
  persisted onto the day archive so a change in output can be attributed to a
  change in the engine rather than to the world.

Both objects are **additive and optional**. A Node deploy that ignores them
keeps working; a Node deploy that receives no `signal_capture` stores the
trimmed snapshot and marks the row `bundle_fidelity = 'display_trimmed'` rather
than mislabelling a ten-chip view as the engine's full input.

**Error responses** (envelope `{ "error": { "code", "message" } }`):

| HTTP | When                                                              |
|------|-------------------------------------------------------------------|
| 401  | `SERVICE_API_KEY` is set and the `X-API-Key` header is missing/wrong. |
| 404  | Location not found (Node profile 404) or no candidate products.   |
| 409  | Batch collect attempted while the batch is still processing.      |
| 502  | Node API unreachable/5xx, or the LLM call failed.                 |
| 500  | Unexpected error.                                                 |
| 400  | Bulk call exceeds `BULK_MAX_PAIRS`, or an empty `pairs` list.      |

### 2.1 Bulk runs — `POST /run-recommendations`

For a whole-network run, post a list of pairs instead of one call per store. The
service owns concurrency (and shares the geo-keyed signal cache across stores),
so you don't need `xargs`.

```json
// request
{ "pairs": [{ "client_id": 96, "location_id": 42 }], "mode": "concurrent" }
```

`mode` is `"concurrent"` (live, immediate) or `"batch"` (one Anthropic Message
Batch, ~50% LLM cost, minutes of latency — best for the nightly cron). The
response wraps the same per-store `RunResult` objects; persist each exactly as
above. A per-store failure lands in `errors[]` and never sinks the run.

```json
// response (BulkRunResult)
{
  "mode": "batch",
  "requested": 1, "succeeded": 1, "failed": 0,
  "batch_id": "msgbatch_…",
  "results": [ { /* RunResult, as in §2 */ } ],
  "errors": [ /* { client_id, location_id, code, message } */ ]
}
```

### 2.2 Non-blocking batch — submit / status / collect (preferred for large runs)

`mode="batch"` holds one HTTP connection open for the whole processing window
(up to `BATCH_MAX_WAIT_SECONDS`), which is fragile through proxies/LBs. The
non-blocking flow does the same work in three short calls:

```
POST /run-recommendations/batch                      { "pairs": [...] }
  -> { "batch_id": "msgbatch_…", "requested": N, "submitted": M, "errors": [...] }

GET  /run-recommendations/batch/{batch_id}
  -> { "batch_id": "…", "processing_status": "in_progress|ended", "counts": {...} }

POST /run-recommendations/batch/{batch_id}/collect   { "pairs": [...] }   // same pairs
  -> BulkRunResult (as in §2.1)        // 409 batch_not_finished while processing
```

The service stays stateless: results are matched by a `client_id:location_id`
custom id, and SKU validation at collect time runs against **freshly fetched
inventory** (current stock), which is the safer behavior anyway. Anthropic
retains batch results for 29 days, so a missed collect is always recoverable.

---

## 3. Reads for the frontend

Persisted recommendations are read **directly from Node** (your DB), not from
this service — Python is a stateless generator. Add the read endpoints your
suggestions tab needs on the Node side, e.g.:

```
GET /api/clients/:clientId/locations/:locationId/recommendations?date=YYYY-MM-DD&category=weather&limit=10
GET /api/clients/:clientId/locations/:locationId/recommendation-runs/latest
```
