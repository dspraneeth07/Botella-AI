# Go-live runbook: Bethany (171), Tuscany (173), Grapes and Grains (188)

Written 19 October 2026 against branch `Enh_Engine_v1` at the commit that adds
this file. It is the ordered list of things an operator does to put the
recommendation engine in front of these three stores, what each step proves,
and what must still be asked of the SyncGo team. Every figure here was
measured on 19 October; the pages that re-measure them are named.

## 0. Where each store stands today

| Store | POS / feed | Data | Engine state | Money, as measured | Verdict |
|---|---|---|---|---|---|
| **171 Bethany Discount Liquor** | PCAmerica, on-prem uploader | 3.75 years of sales (Jan 2023 to 16 Oct 2026); purchases feed dead | Quality pass; store gate live; 350 cards in 120 days; backtest +16.6 points over the null (p = 0.0005) | 5 distinct confirmed losses (largest card 34, -$319.06), 3 distinct gains, +$130.68 net over the 4 fully priced confirmed product-windows (too few to bound); 4 more losses bounded at >= $347.08 together | **Pilot now**, Effectiveness tab on |
| **173 Tuscany Wine, Spirits + Craft** | LiquorPOS, on-prem uploader | 105 days of sales (from 5 Jul 2026); live purchases feed (dates via `invoice_date` until SyncGo fixes the alias) | Quality pass; 30 cards since 13 Oct; no closed outcome window; backtest refuses (needs 492 days) | Nothing measurable yet: 0 closed windows, 2 confirmed purchases | **Pilot on the forward test**; first 30-day windows close in November |
| **188 Grapes and Grains Liquor** | PCAmerica, on-prem uploader | Sales stop on 5 Aug 2026; product master still syncs | Quality degraded (74 days stale); refused by the gate every night; 0 cards ever | No cards, so no money at risk, and no evidence either way | **Blocked by the feed**, not by code |

The money audit that produced the middle column: `audit/money/INDEX.html`,
regenerated on demand with `node backend/scripts/money-audit.js`.

## 1. Before the deploy: what the box needs

The production stack is Docker Compose on the EC2 box (`deploy/docker-compose.prod.yml`),
driven by the manual `deploy` job in `.gitlab-ci.yml` on `main`. The Python
service runs on the host at `:8000` under `/opt/botella`; the Node container
reaches it through `host.docker.internal`.

1. Merge `Enh_Engine_v1` to `main`. The `deploy` button only appears after
   `test-backend`, `test-frontend`, `test-python`, `test-migrations` and
   `test-backend-db` pass.
2. Run the `preflight` job once (docker, compose, registry login).
3. Confirm `/opt/botella/node` exists and is writable by `gitlab-runner`
   (the job prints the exact `install -d` line if not).

## 2. Environment: the values that decide what owners see

### backend.env (Node, in `/opt/botella/node`)

| Variable | Value for go-live | Why |
|---|---|---|
| `PORT` | `3000` | Compose publishes 3000 |
| `REC_SERVICE_URL`, `STOREAGENT_API_URL` | set by compose to `host.docker.internal:8000` | Overrides anything in the file |
| `REC_SERVICE_API_KEY` | same string as the Python `SERVICE_API_KEY` | The Python service refuses to start in production without it |
| `NODE_API_TOKEN` | same string as the Python `NODE_API_TOKEN` | The engine calls back into Node for sales |
| `JWT_SECRET` | production secret | Owner logins |
| `ANALYTICS_PG_HOST` | `host.docker.internal` (if Postgres is on the host) | `localhost` inside the container is the container |
| `REC_CRON_LOCATIONS` | `171:171,173:173,188:188` | Generate only for the three stores. `ALL` would spend the nightly budget on 80+ stores |
| `REC_MIN_PROFIT_USD` | `1` | The dollar floor. On this laptop it is `0` ("show everything, let the owner judge"); the audit found 0 cards under $1 at Bethany in 120 days, so the floor costs no cards and stops a sub-dollar card from ever being shown |
| `REC_REQUIRE_PROFIT_FIGURE` | `true` | A profit-claiming card whose money cannot be computed is withheld with a reason, not shown with a blank |
| `REC_MIN_CONFIDENCE` | `0.35` | Applies only to cards whose `confidence_basis` is `isotonic` (migration 041); harmless elsewhere |
| `REC_GATE_ENFORCED` | `false` | Leave off until the five store-gate verdicts are republished with `valid_until` (defect 6). Enforcing today would withhold every card |
| `REC_MAX_STALENESS_MULTIPLE`, `REC_MIN_STALENESS_DAYS` | `6`, `1` | The staleness refusal that is correctly blocking 188 |
| `FORWARD_TEST_CRON_SCHEDULE` | default `15 4 * * *` Asia/Kolkata | Daily until the final report on 30 Oct 2026 |
| `TZ` | the box's zone | Every other cron below is in server-local time |

The frontend flags live in `frontend/src/utils/features.js`:
`SHOW_CARD_CONFIDENCE = false` (the number is a ranking score, not a
probability, defect 18) and `SHOW_EFFECTIVENESS = true`.

### Python `.env` (`/opt/botella`)

`ENVIRONMENT=production`, `SERVICE_API_KEY`, `NODE_API_BASE_URL=http://host.docker.internal:3000`,
`NODE_API_TOKEN`, the `PG*` warehouse read-only credentials, `APP_PG*` analytics
credentials, `NWS_USER_AGENT` (weather is the one external source with a
priced effect so far). Everything else in `Botella_External_APIs/.env.example`
can stay at its default for the pilot.

## 3. Database

`npm run migrate` in `backend/` applies every pending analytics migration;
the newest are:

| Migration | What it adds | Needed for |
|---|---|---|
| 034 | card retirement | cards stop being "open" forever |
| 035 | outcome quantities | units sold vs expected on every outcome |
| 036 | pilot scoreboards | monthly per-store money page |
| 037 | supplier lead times | measured lead per vendor |
| 038 | forward test tables | the 16-30 Oct run |
| 039 | fulfilment state machine | "Completed" only from data |
| 040 | `confidence_basis` NOT NULL | the closed vocabulary |
| 041 | admission notes | why the floor did or did not apply |
| 042 | `order_by`, `lead_time_days`, `lead_time_basis` | one deadline on both screens |

The warehouse (`syncgo`) is read-only to this stack; nothing here writes to it.

## 4. The nightly chain (server-local time unless stated)

| Time | Job | Proves |
|---|---|---|
| 03:00 | ingestion digest | what each feed delivered |
| 03:10 | lead-time refresh | per-vendor measured lead from receipts |
| 03:30 | store-intelligence pre-warm | the owner screens open fast |
| 03:45 | on-hand capture | shelf counts for stockout grading |
| 03:50 | quality gates | `store_quality_state` per store (188 reads `degraded`) |
| 04:00 | **recommendation batch** for `REC_CRON_LOCATIONS` | new cards, admission audit written at issue |
| 04:15 IST | forward test (to 30 Oct) | capture, evaluate, report under `audit/forward/` |
| 05:00 | evaluation + holdout report | outcomes, fulfilment states |
| 05:30 Mon | weekly owner digest | |
| 06:00 | store gate | Gate A / Gate B verdicts |
| 06:30 | drift monitor | |
| 07:00 | calibration refit | publishes a curve only past 50 pooled outcomes |
| 08:00 Sun | signal-effect fit | which external signals have earned a coefficient |
| 07:30 on the 1st | pilot scoreboards | |
| on demand | `node scripts/money-audit.js` | per-card made / lost / cannot say |

node-cron runs seven days a week; there is no weekend gap and no Task
Scheduler dependency on the box. The laptop-specific detached-launch tasks
are not part of production.

## 5. After the deploy: the ten-minute check

```
curl -fsS http://localhost:3000/api/health
curl -fsS http://localhost:8000/health
```

Then, with an owner JWT for each store:

1. `GET /api/recommendations/latest` returns cards; each buy card carries
   `order_by`, `lead_time_days`, `lead_time_basis` and a `confidence_basis`.
2. The Recommendations card and the Purchasing row for the same SKU print the
   same quantity and the same "Order by" date (the row says "from your
   recommendation").
3. `GET /api/recommendations/money-audit?days=120` answers for the tenant.
4. In the analytics database, every card of the newest run has an admission
   row:

```sql
SELECT r.run_id, count(*) cards, count(a.rec_id) admission_rows
FROM recommendations r LEFT JOIN recommendation_admission a ON a.rec_id = r.id
WHERE r.location_id IN (171,173,188)
GROUP BY 1 ORDER BY 1 DESC LIMIT 3;
```

5. The next morning: `[ForwardTest cron] Done` and the 04:00 batch's
   per-store lines in the Node log; `store_quality_state.checked_at` is today.

## 6. Asks for the SyncGo / uploader team (none of these is code in this repo)

1. **LiquorPOS purchases alias** (stores 173, 182, 184, 186). In
   `client_pos_config.meta_data.QUERIES.purchases` change
   `DATE AS PurchaseDate` to `DATE AS Date` and re-pull purchases. Until then
   every reader here falls back to `invoice_date`, which for this connector is
   the same POS field.
2. **Tuscany history.** The uploader's first sales pull covers the 30 days
   before the first successful pull, which is why 173 has sales only from
   5 Jul 2026 while its purchases reach back to 2019. Set
   `client_pos_config.meta_data.INITIAL_PULL_FROM = "2023-01-01"` for 173
   (and 184, 186) and run a one-off ranged sales pull 2023-01-01 to
   2026-07-05, chunked by month, after confirming the LiquorPOS `storage.dbf`
   still holds the old tickets. Rows dedupe on `unique_hash`, so overlap is
   safe. Bethany was re-pulled this way on 31 Jul and 7 Aug 2026. With the
   history, Tuscany's full backtest and the 365-day reversion window become
   available instead of refusing.
3. **Grapes and Grains uploader.** The on-prem uploader stopped pushing sales
   on 5 Aug 2026. Nothing on this side can be generated until it resumes; the
   gate is right to refuse. Expect about four months of sales after the
   feed returns before the store's own backtest can judge it.

## 7. What "not losing money" means on day one, per store

- **Bethany**: not "no". The audit names 5 distinct confirmed losses and 3
  gains; the net over the fully priced confirmed windows is +$130.68 with
  >= $347 of bounded losses beside it. Run the pilot with the money audit
  weekly and read the losses, which are concentrated in low-margin
  ($0.34/unit) high-volume SKUs that sold under their baseline.
- **Tuscany**: nothing measurable yet. The first 7-day windows close this
  week, 30-day windows in November. The admission audit now records expected
  profit at issue for every card, so the day a window closes the page can
  compare promise with outcome.
- **Grapes and Grains**: no recommendations, so no losses, and no clean bill.

## 8. Rollback

`deploy` is pinned to a commit SHA; re-running it for the previous pipeline
redeploys that image. Migrations 034-042 are additive (new tables and
nullable columns) and need no rollback for an application rollback; the
manual DROP statements are in each file's footer.
