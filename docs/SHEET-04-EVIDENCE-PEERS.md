# Sheet 04 — Evidence + peer engine

**Status:** complete. 37 tests, all green, validated against the live warehouse.
**Depends on:** 03. **Blocks:** 05, 06. **Wave:** 2.
**Nature:** additive. New Python package, no migration, no caller changes.

---

## 1. The problem

Everything downstream needs one number: **n**, the count of usable observations
behind an estimate. It decides the shrinkage weight in sheet 06, the interval
width in sheet 07, the confidence in sheet 15 and the evidence-state label the
owner sees.

The current engine has no such number, **which is precisely why it was equally
confident about a store with four years of history and one with three weeks.**

---

## 2. What I verified, and where the sheet needed correcting

### 2.1 Store 122's "52 per weekday" is exactly right — over a one-year window

Sheet: *"store 122 is our worst-data store and still has 52 observations per
weekday with a 1.7× day-of-week spread."*

Store 122 is **Big Hollow Convenient, Peoria IL**. Measured:

| Window | Observations per weekday | Spread |
|---|---:|---:|
| Full history (1,358 days) | **194–195** | 1.34× |
| **Trailing 364 days** | **exactly 52, every weekday** | 1.35× |

52 = exactly 52 weeks, so the sheet means a **one-year window**. With that
reading the number is precise. The spread measures 1.34–1.35× rather than 1.7×,
which varies with window and metric.

### 2.2 But 122 is *not* the worst-data store — it's close to the best

122 trades **seven days a week with a full year of history**, which is the
*maximum* possible: 52 of 52. The genuinely thin stores measure far lower:

```
73:73    min obs/weekday  1
171:171  min obs/weekday  1
170:170  min obs/weekday  1
190:190  min obs/weekday  1
172:172  min obs/weekday  3
```

So the sheet's tripwire — *"if your day_of_week count for a typical store comes
out below ~40, something is counting calendar days"* — is a good check for a
**7-day store**, and I kept it as a test. It is not a floor for the estate.

### 2.3 Two of the five peer signals do not exist

The sheet names five. Checked against the warehouse:

| Signal | Status |
|---|---|
| state | ✅ `client_locations.state` — TX 34, FL 23, IL 13, GA 13, NY 11… |
| category mix | ✅ computable from `products.category` + `sale_items` |
| monthly volume band | ✅ computable |
| **store format / size** | ❌ **no such column anywhere** |
| **urban / rural from population density** | ❌ **no population or density data anywhere** |

The honest response is to score on what exists, **renormalise** over the
available dimensions, and **declare the missing ones on every result** — not
default them to a neutral value, which would dilute every score by a constant
and make two stores look more alike than the evidence supports.

`missing_dimensions` travels with every match for exactly that reason.

### 2.4 Four states hold exactly one store

So *"a store with no same-state peers"* is a **reachable, real outcome**, not a
hypothetical edge case. It returns `ok=True` with an empty list and a stated
reason.

---

## 3. Files

| File | Lines | What |
|---|---:|---|
| `app/pipeline/evidence/count.py` | 520 | **Part 1** — n per pattern. Never counts a closed day. |
| `app/pipeline/evidence/similarity.py` | 290 | The pairwise math. Deliberately boring. |
| `app/pipeline/evidence/peers.py` | 250 | **Part 2** — `find_peers` with reasons. |
| `app/pipeline/evidence/__init__.py` | 60 | Public surface. |
| `tests/test_evidence.py` | 480 | 37 tests. |

No migration. Everything reads the feature store (sheet 03) and is a pure
sheet-00 stage.

---

## 4. Part 1 — what n means, per pattern

| Pattern | n counts | Floor |
|---|---|---:|
| `day_of_week` | Open days per weekday, **weakest** weekday | 8 |
| `weekly_trend` | Complete weeks with ≥ 4 open days | 13 |
| `monthly` | Complete prior years covering the target month | 2 |
| `sku_velocity` | Open days with a **non-null price** for that SKU | 14 |
| `category` | Open days with any sale in the category | 14 |

**n is the weakest weekday, not the average.** 300 Saturdays do not help you
predict a Tuesday, and a day-of-week model is only as good as its thinnest
bucket.

**`sku_velocity` counts priced days, not selling days.** A day the SKU was
stocked and priced but sold nothing is a real observation of *zero demand*; a
day with no price is a day we know nothing about. Counting only days with sales
would make every intermittent SKU look like it has no history — when in fact it
has a long history of not selling, which is exactly what a reorder decision
needs.

**`monthly` ignores the trailing window on purpose** (a seasonal question is
about the same month in prior years), and the current year never counts because
the month is not over.

### The third state the sheet does not name

A pattern is not just sufficient or insufficient. It can be **not applicable**:

```
sufficient      n is at or above the floor
insufficient    n is below the floor — we could know this, we just don't yet
NOT APPLICABLE  n is structurally zero — this store never trades then
```

Bethany closes every Sunday. Its Sunday evidence is not *thin*, it is **absent
by construction**, and reporting it as low-confidence would invite someone to
wait for data that is never coming. The difference is *"wait a month"* versus
*"this will never happen"*.

---

## 5. A flaw real data exposed in my own design

The first implementation validated cleanly on synthetic fixtures and then
produced this against the warehouse:

```
171:171  Bethany   n=1   insufficient
         per weekday: mon 52, tue 52, wed 52, thu 49, fri 52, sat 52, sun 1
```

**Bethany traded exactly one Sunday out of 52.** My "weakest weekday" rule
faithfully reported n=1 — so a store with 49–52 observations on every day it
genuinely trades looked like it had almost no evidence at all. Downstream, that
would have shrunk its estimates hard toward the peer cohort and widened every
interval, for no reason.

One-of-52 is not a thin sample; it is a day the store does not normally open.
So a weekday traded on fewer than `rare_weekday_pct` (20%) of its **occurrences
in the window** now folds into `not_applicable` rather than dragging the
headline down. After the fix:

```
122:122  Big Hollow   n=52  sufficient   not_applicable: -
171:171  Bethany      n=49  sufficient   not_applicable: ['sunday']
46:46    pilot        n=51  sufficient   not_applicable: -
```

The rule is careful not to swallow *real* thinness — a store open on 60% of its
Sundays but only 5 times is still reported `insufficient`. There is a test for
each side.

---

## 6. Part 2 — peers, kept boring

> *"Resist the urge to learn an embedding."*

```
score = Σ(component × weight) / Σ(weights actually used)

  category_mix   50%   cosine over category revenue share
  volume_band    30%   ratio-based band, symmetric
  store_format   20%   UNAVAILABLE — renormalised away and declared
```

**State is a gate, not a weight.** The sheet lists it among the signals; it is
an exact filter because a Texas store and a Maine store are not 60% similar —
they are differently regulated, taxed and seasonal. Within a state, the score
decides.

**Symmetry is load-bearing.** The volume band compares the *ratio* of larger to
smaller, so `compare(a,b) == compare(b,a)`. A difference-based measure would
not be symmetric and the cohort would depend on which store asked. Tie-breaking
is by store key so the order is deterministic and replayable.

**An unknown overlap is not a zero overlap.** A store with no category history
scores `None` on that dimension — it is dropped and declared, not scored 0,
which would make every brand-new store look maximally different from everybody.

**A store is never its own peer** — it would score 1.0 and anchor every cohort
statistic to the store being compared against.

Every match carries a sentence sheet 15 can render verbatim:

> *"Matched because: same state (TX); 94% category-mix overlap (mainly whiskey
> and beer); comparable volume."*

**Widening is sheet 05's job.** Fewer than `min_peers` qualifying returns what
there is with `insufficient_peers:1<5:widening_is_sheet_05`.

The peer cohort's provenance sets **`own_weight = 0.0`** and
`cohort_level = "state"` — a cohort is borrowed evidence, never this store's
own, and sheet 06 reads exactly that field to decide how hard to shrink.

---

## 7. Every store, empty to full

| | EMPTY | PARTIAL | FULL |
|---|---|---|---|
| `day_of_week` | n=0, `not_applicable` | n=49, Sunday excluded | n=52 |
| `weekly_trend` | n=0 | insufficient at 4 weeks | sufficient at 52 |
| `monthly` | n=0 | 1 prior year → insufficient | 2+ years |
| `sku_velocity` | n=0 | priced but never sold → **still counts** | full |
| peers | empty list + reason | below floor + reason | ordered cohort |

**A zero-history store returns n=0 for every pattern without raising** — the
sheet's explicit requirement, tested across all five patterns. `ok=True` with
n=0, because *"this store knows nothing about that"* is a legitimate and
necessary answer.

---

## 8. Verification

```bash
cd Botella_External_APIs
./.venv/Scripts/python.exe -m pytest tests/test_evidence.py -q   # 37 passed
./.venv/Scripts/python.exe -m pytest -q                          # 640 passed
./.venv/Scripts/python.exe scripts/check_no_literals.py          # exit 0
```

| Sheet requirement | Proven by |
|---|---|
| Closed days never counted | `test_closed_days_are_never_counted`, `test_the_sheets_tripwire…` |
| Zero-history store returns n=0 for every pattern without raising | `test_a_zero_history_store_returns_n_0_for_every_pattern_without_raising` |
| Peer similarity is symmetric | `test_peer_similarity_is_symmetric` |
| No same-state peers → ok=True, empty list, stated reason | `test_a_store_with_no_same_state_peers_returns_empty_with_a_reason` |
| n published for downstream | `test_n_is_published_as_provenance_own_observations` |
| Every match explainable in one sentence | `test_every_match_is_explainable_in_one_sentence` |

Validated against the live warehouse on three stores (§5).

---

## 9. Not done

- **Nothing consumes n yet.** That is sheets 06 (shrinkage), 07 (intervals) and
  15 (confidence). The number is produced, published in
  `Provenance.own_observations`, and unread.
- **No store-features loader.** `find_peers` takes the candidate pool as input,
  by design (a stage never fetches). The query that assembles
  `StoreFeatures` for the estate is a small piece of wiring that belongs with
  whichever sheet first needs a live cohort.
- **`store_format` and `density_class` stay unavailable** until someone adds
  them to the estate. The code path exists and the gap is declared on every
  match rather than forgotten.
- **RESOLVED in [sheet 06A](SHEET-06A-INTEGRATION.md).** The builder has run
  across the estate (94/94 stores, 12,091,569 rows), every calendar-day
  divisor is migrated, and 04 -> 05 -> 06 runs end to end on real stores.
- **32 of 32 registry settings are PROVISIONAL** (13 new here).
