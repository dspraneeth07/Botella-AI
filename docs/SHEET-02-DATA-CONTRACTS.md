# Sheet 02 — Data contracts + quality gates

**Status:** complete. 38 Python + 26 Node checks, all green.
**Depends on:** 00, 01. **Blocks:** 03. **Wave:** 1.
**Nature:** additive. New Python package, new Node service, one migration.

This is the sheet that gives the system **the right to refuse** — and, with the
admission gate in §7, the answer to *"recommendations must only be visible if
they are valid and really cause profit, not ambiguous like the past."*

---

## 1. The problem

Nothing currently stands between a malformed POS payload and a recommendation.
A store whose data fails its contract should produce **no recommendation and a
stated reason**, which is infinitely better than a confident one built on
rubbish.

---

## 2. Corrections to the sheet

Three claims in the sheet do not survive contact with the warehouse. All three
were checked, not assumed.

### 2.1 The DEFAULT partition is **not** malformed data

The sheet reads the 43% DEFAULT partition as *"rows whose dates fell outside
every defined partition, absorbed silently"* — implying corruption.

**The 43% is real.** 8,616,193 of 19,752,047 `sale_items` rows sit in
`sale_items_default`. But measured:

| Check | Result |
|---|---|
| `sale_date IS NULL` | **0** |
| Rows before 2025-04-01 | **8,616,193 — all of them** |
| Rows after 2026-12-01 | 0 |
| Actual date range | **2023-01-01 → 2025-03-31** |

Every row has a valid date. They are simply **older than the oldest defined
partition** (2025-04-01) — legitimate backfilled history, absorbed correctly.
There is no corruption to catch here, and a gate built to reject them would
throw away two years of sales.

### 2.2 The real partition risk is the **forward** edge

Partitions run out at **2026-11-30**. Today is 2026-09-22.

**In about ten weeks, every new sale starts landing in DEFAULT** — silently,
exactly as the sheet feared, just at the other end of the range. The schema
gate's partition-range check exists for that, and it is the single most
time-critical finding in this sheet.

### 2.3 Korona and PCAmerica are wrong again (same as sheet 01)

The sheet says *"Cost coverage is 0% for the Korona connector (26 stores) and
89.6% for PCAmerica."* Measured live:

| Connector | Stores | SKUs | Cost % |
|---|---:|---:|---:|
| **mpower** | 3 | 41,919 | **0.00** |
| **square** | 9 | 153,756 | **0.00** |
| **gokul** | 19 | 160,133 | **0.00** |
| clover | 25 | 158,448 | 64.59 |
| api | 27 | 205,768 | 66.02 |
| **korona** | 2 | 17,547 | **88.39** |
| localdb | 17 | 165,678 | 92.30 |
| eposnow | 3 | 7,692 | 99.39 |

**Korona is one of the best connectors, not the worst**, and PCAmerica is not
in the estate. The zero-cost connectors are **mpower, square and gokul** — 31
stores, 355k SKUs. The sheet's *thesis* — that this is a connector-level defect
— is exactly right, so coverage is **measured per connector at runtime**, never
asserted from a constant.

### 2.4 Migration number

The sheet asks for `014_data_quality.sql`. 014 is `daily_signal_capture` and
015/016 are taken, so it is **`017_data_quality.sql`**. Same folder, same rules.

---

## 3. Files

### Python — `Botella_External_APIs/`

| File | Lines | What |
|---|---:|---|
| `app/pipeline/contracts/schema.py` | 300 | `Contract`, `FieldSpec`, `ContractRegistry`, type coercion. 18 contracts across 9 connectors. |
| `app/pipeline/contracts/gates.py` | 640 | The four gates + the composite `QualityVerdict`. 10 declared thresholds. |
| `app/pipeline/contracts/__init__.py` | 60 | Public surface. |
| `tests/test_contracts.py` | 420 | 38 tests. |

### Node — `backend/`

| File | Lines | What |
|---|---:|---|
| `database/analytics-migrations/017_data_quality.sql` | 190 | `data_quality_results`, `store_quality_state`, `recommendation_admission`. |
| `services/recommendationGateService.js` | 330 | **Admission** — the "only if valid and profitable" gate (§7). |
| `services/recommendationService.js` | +40 | `getLatest` applies admission; enrichment now carries `cost`. |
| `tests/rec-admission-verify.js` | 200 | 26 checks. |
| `utils/numbers.js` | 95 | `toNumber`/`toInt`/`toPositiveNumber` — unknown never becomes zero (§8.1). |
| `tests/numbers-verify.js` | 120 | 36 checks; re-tests each original bug at its call site. |

---

## 4. Contracts, versioned per connector

```python
Contract(
    connector="gokul", entity="products", version="1.0.0",
    fields=(
        FieldSpec("sku", "string", required=True, min_coverage_pct=100),
        FieldSpec("cost", "number", required=False, min_coverage_pct=70,
                  used_for="MARGIN. Without it no profit figure can be stated"),
        ...
    ),
)
```

**A Korona schema change cannot fail a Clover store** — contracts are keyed by
`(connector, entity)` and each carries its own version history. An unknown
connector falls back to a `base` contract and the result **says it fell back**,
because "checked against the base contract" is a materially weaker statement.

**Coverage minimums are integer percentages** (`min_coverage_pct=70`, not
`0.7`). Sheet 00 bans float literals outside the registry, and a percentage
with a unit is what the reader wanted anyway — it removes the "is this 0.8 or
80?" question that every coverage bug starts with.

**Contracts declare what the field is WORTH, not what the estate achieves.**
Gokul sends 0% cost today; its contract still demands 70%, because *cost at 0%
for a connector is a contract breach, not a data characteristic*. A contract
written down to current reality would report everything as healthy.

---

## 5. The four gates

Every gate is a **sheet-00 stage**: a pure function of `(input, ctx)` returning
a `StageResult` with populated `Provenance`. No clock, no database, no network
— trailing statistics and sync history arrive as **input**, because a gate that
queries the warehouse cannot be replayed, and a quality verdict that cannot be
replayed is not evidence of anything.

| Gate | Checks | On failure |
|---|---|---|
| **schema** | Declared columns present, types coercible, enums known, dates inside the partition range | **Reject** the batch; the reason names the field |
| **completeness** | Per-field coverage vs the contract minimum | **Accept**, mark the field `UNAVAILABLE` |
| **freshness** | Last sync vs **this store's own** median interval | **Accept**, attach `staleness_days` |
| **anomaly** | Volume, unit price, basket size vs **this store's own** trailing distribution | **Quarantine** — do not merge |

### Type coercion is deliberately lenient

`"2.0"` for an integer quantity is a decimal string, not malformed data —
rejecting a whole batch for a keg partial would be absurd. What is *not*
coercible is a genuine category error: a word where a number belongs. And a few
bad rows are tolerated (2%) while a shape change is not (40%).

### Completeness: absent, never zero

```python
availability.strip(row)   # removes 'cost' — does NOT set it to 0.0
```

This is the one behaviour the gate exists to guarantee. **A cost of 0.0 is
indistinguishable from a free product and produces a 100% margin.** An absent
cost produces no margin at all, which is the correct answer when cost is
unknown.

The subtle case, and the one that actually bites: **a connector sending `0.00`
for every cost would read as 100% covered.** Zero counts as *absent* for money
fields, so gokul's all-zero costs correctly report 0%.

### Freshness must be relative — the subtle part

A fixed "stale after 48 hours" rule would mark a large share of the estate
permanently broken, because cadence varies by connector and by store.

Each store's expected interval is the **median gap between its own successful
syncs** over the trailing quarter. Judged against that:

| Store cadence | At 6 days | At 20 days |
|---|---|---|
| Weekly (median 7d) | **healthy** | stale |
| Daily (median 1d) | **stale** | stale |

Same six days, opposite verdicts. That is the entire point.

With fewer than three gaps there is no cadence to speak of, so the gate falls
back to a default **and records `own_weight = 0.0`** — the answer is not this
store's own evidence and the provenance says so.

### Anomaly: ratio bands, not z-scores

Thresholds are integer percentages of the store's **own** trailing median:
volume outside 25–250%, unit price outside 33–300%, basket above 300%.

A double-load lands at 200%; a decimal shift at 1000% or 10%. Ratio bands catch
both, and *"volume is 340% of this store's normal"* is a sentence an owner can
argue with. A robust z-score over a handful of observations is noise wearing a
lab coat.

A store with **fewer than 7 trailing days abstains** rather than being
quarantined — blocking a new store's first load would block exactly the stores
we most want onboarded.

---

## 6. The composite verdict

```python
verdict = run_quality_gates(ctx, batch=..., freshness=..., anomaly=...)
if not verdict.may_recommend:
    return   # ...with verdict.reasons, never silently
```

| Verdict | Meaning | May recommend? |
|---|---|---|
| `reject` | Schema failed, or never synced | **No** |
| `quarantine` | Anomalous batch, not merged | **No** |
| `degraded` | Accepted; fields unavailable and/or stale | **Yes**, with fields withheld |
| `pass` | Clean | Yes |

Worst-wins, and the order is not arbitrary: a rejected batch was never merged,
so its completeness and anomaly readings describe data that does not exist.

`degraded` still recommends on purpose — a store with no cost data should still
get weather and event advice. It just must not get a margin claim.

---

## 7. Admission — "valid, and really causing profit"

> *Beyond the sheet, and the point of the whole exercise.*

Three independent things must hold before an owner sees a card:

1. **The store's data is usable** — `reject`/`quarantine` produces nothing.
2. **The fields the claim needs are present** — a markdown is a *margin* claim;
   margin needs cost.
3. **The number is positive and stated** — a profit-claiming action with no
   computable figure is **withheld**, not shown with a blank.

```js
markdown / liquidate / bundle   → basis: margin,            requires price + cost
reorder / pre_stock / stock_new → basis: avoided_stockout,  requires price
promote / endcap / cold_box     → basis: revenue,           requires price / nothing
```

**What is not withheld.** A weather recommendation makes no margin claim —
*"99°F Saturday, move seltzer to the cold box"* is actionable without knowing
unit cost. Silencing it would punish the store for its POS vendor's defect.

So for a **gokul** store (0% cost), of three recommendations:

```
markdown   → WITHHELD  "A margin figure cannot be calculated because your POS
                        (gokul) is not sending unit cost, so we are withholding
                        this rather than guessing at the profit."
liquidate  → WITHHELD  same
cold_box   → SHOWN     with data_as_of_days_ago attached
```

Withheld items are **returned, not dropped** — the UI can say *"3 suggestions
were withheld because your POS is not sending cost"* instead of quietly showing
a shorter list. Every decision is recorded in `recommendation_admission`,
because a refusal nobody can explain is just a different kind of unexplainable
output.

**Staleness rides on every shown recommendation** (`data_as_of_days_ago`), so
the owner sees what the advice is based on, not just the advice.

**Shipping the gate must not silence the estate.** A store the gates have never
examined reads `unknown`, which **admits**, and is reported as `ungated`. A
quality-table failure degrades the same way.

---

## 8. Bugs this work surfaced

### 8.1 One bug class, four occurrences — now a shared primitive

Caught by the tests before shipping. All four are the same mistake, and all
four would have looked like the gate working correctly:

    Number.isFinite(Number(x)) ? Number(x) : null      // wrong

is wrong for exactly the values that mean *absent*:

    Number(null) === 0   Number('') === 0   Number([]) === 0   Number(false) === 0

| # | Where | What it produced |
|---|---|---|
| 1 | `suggested_order_qty` | A null read as an explicit 0 → `units = 0` → **no profit figure on any markdown** (they carry no order quantity by nature) |
| 2 | product enrichment | No `cost` field at all, and `on_hand` exposed rather than `stock_qty` → **no margin could ever be computed** |
| 3 | `engine.input_tokens` / `cost_usd` | Absent stored as **"0 tokens"** and **"$0.00"** rather than unknown |
| 4 | product `price` filter | A NULL price kept as a product **priced at 0** → profit 0 → the **wrong refusal reason** (`profit_below_floor` instead of `no_profit_estimate`) |

Every one is the mistake this whole rebuild is about: **a zero that means "we
do not know" is a lie with a decimal point on it.** A cost of 0.00 yields a
100% margin; a staleness of 0 reads as fresh; a token count of 0 reads as a
free run.

Four occurrences is enough for a local fix to be the wrong answer. The
primitive now lives once in **`backend/utils/numbers.js`**
(`toNumber` / `toInt` / `toPositiveNumber` — absent in, null out), is used at
every one of those call sites, and is covered by
**`backend/tests/numbers-verify.js`** (36 checks) which re-tests each original
bug at its own call site so a fifth occurrence fails the build.

Two instances of the pattern remain in `lib/metrics.js`. They are pre-existing
and **safe**: both carry a `> 0` guard, so `Number(null) === 0` fails the test
and falls through to the default. Verified, left alone.

Also fixed alongside: a null `staleness_days` no longer reads as "0 days old"
(i.e. fresh), and a null `confidence` is no longer treated as 0 and wrongly
withheld.

### 8.2 Sheet 00's guard caught my own float literals

`check_no_literals.py` failed the build on `86400.0` and `100.0` in `gates.py`.
They are unit conversions, not judgements — now named integer constants
(`SECONDS_PER_DAY`, `PERCENT`). The guard was right to flag them: a bare number
in a calculation is indistinguishable from a threshold until someone reads the
surrounding line.

### 8.3 The PROVISIONAL count is finally non-zero

`config_report.py` reported `0 of 0` after sheet 00 because no application
module had declared a `Setting`. It now reports **10 of 10 PROVISIONAL** — the
ten thresholds this sheet declares, every one of them an unfitted guess awaiting
wave 6. That number is exactly what the old engine could not produce about its
63 constants.

---

## 9. Every store, empty to full

The estate is not uniform — 79 of 188 configured stores have zero products and
zero sales. The gates hold across the range:

| | EMPTY | PARTIAL | FULL |
|---|---|---|---|
| schema | `empty_batch` — not silent success | passes with tolerated noise | passes |
| completeness | nothing to measure | `cost` UNAVAILABLE, rest kept | all fields available |
| freshness | `never_synced` → refuse | `default_assumed`, `own_weight 0.0` | own cadence, `MATURE` |
| anomaly | abstains — no history to judge | abstains under 7 days | full ratio bands |
| admission | nothing shown, reason given | weather kept, margin withheld | everything, with figures |

- **An empty batch is not success.** `schema_gate` fails it with `empty_batch`:
  "nothing arrived" is a fact downstream must see.
- **No product data yields no profit figure**, so the margin claim is withheld —
  never a $0 that reads as a measurement.
- **Zero units yields NO figure, not $0.** A real distinction.

---

## 10. Verification

```bash
# Python
cd Botella_External_APIs
./.venv/Scripts/python.exe -m pytest tests/test_contracts.py -q   # 38 passed
./.venv/Scripts/python.exe -m pytest -q                           # 575 passed
./.venv/Scripts/python.exe scripts/check_no_literals.py           # exit 0
./.venv/Scripts/python.exe scripts/config_report.py               # 10 PROVISIONAL

# Node
cd backend
npm run migrate                        # applies 017
node tests/rec-admission-verify.js     # 26 checks
node tests/numbers-verify.js           # 36 checks - the unknown-vs-zero guard
```

| Sheet requirement | Proven by |
|---|---|
| A planted schema violation is rejected with the field named | `test_a_planted_schema_violation_names_the_field` |
| A zero-cost connector is marked unavailable, not zero-filled | `test_a_zero_cost_connector_is_marked_unavailable_not_zero_filled`, `test_a_cost_of_zero_counts_as_ABSENT_not_as_covered` |
| A weekly store is not stale at 6 days but is at 20 | `test_a_weekly_store_is_healthy_at_six_days_and_broken_at_twenty` |
| A doubled batch is quarantined | `test_a_doubled_batch_is_quarantined` |
| Gates conform to the sheet-00 envelope | `test_every_gate_is_a_well_formed_stage`, `test_gates_are_replayable_from_an_audit_row` |
| **Only valid, profitable recommendations are visible** | `rec-admission-verify.js`, 26 checks (§7) |

---

## 11. Not done

- **The gates are not yet wired into the daily pipeline run.** They are built,
  tested and conform to the envelope, but nothing calls `run_quality_gates` on
  the real batch path yet — `store_quality_state` is therefore empty, which
  means every store currently reads `unknown` and **admits**. That is the safe
  default, and closing it is the first task of sheet 03.
- **No `store_quality_state` writer.** The table and its reader exist; the
  producer is the same wiring task above.
- **Partition runway (§2.2) is an ops ticket**, not code: someone must add
  partitions beyond 2026-11-30 before December.
- **All 10 thresholds are PROVISIONAL.** By design — wave 6 fits them.
