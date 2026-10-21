# Sheet 05 — Cohort prior engine

**Status:** complete. 31 tests including a 600-case fuzz of the core guarantee.
**Depends on:** 03, 04. **Blocks:** 06. **Wave:** 2.
**Nature:** additive. New Python package, no migration.

> *This is the sheet that answers "what do we tell a store that opened
> yesterday".*

---

## 1. The problem

Without this, a zero-data store gets nothing — or, worse and this is what the
current engine does, **gets something invented with no stated basis**.

---

## 2. The finding that changed the design

The sheet describes one ladder: **state → region → national**. The data says
that ladder cannot keep its own promise.

### 2.1 For 9 SKUs in 10, the geography ladder runs out of rungs

Measured on the estate:

| UPCs carried by | Count |
|---|---:|
| 1 store | 205,359 |
| 2 stores | 40,373 |
| 3 stores | 24,349 |
| 4 stores | 11,987 |
| **< 5 stores (fails k)** | **282,068 of 313,990 — 89.8%** |

For `sku_velocity`, k=5 fails at the **national** rung — the top of the
geography ladder. There is nowhere left to climb, so the ladder would
terminate *in failure* for the overwhelmingly common case. That is the precise
opposite of the guarantee.

### 2.2 The rescue is to widen the UNIT, not the map

| Category | Stores carrying |
|---|---:|
| beer | 71 |
| wine | 67 |
| gin / rum / vodka | 57 |
| tequila | 56 |
| brandy | 46 |

**115 categories clear k=5 nationally**, covering the bulk of the catalogue.

So a rung is a **pair** — (geography, specificity):

```
geography     state → region → national
specificity   sku   → category → all_products
```

Geography is walked **first at each specificity**: a same-state *category*
prior beats a national *SKU* prior, because stores in one state share tax,
licensing and weather, and those move demand more than a barcode does.

The terminal rung is `national × all_products`, which with 188 stores always
clears k.

### 2.3 The ladder is genuinely load-bearing

- **27 states, 188 stores**
- **13 of 27 states hold fewer than 5 stores** — so the state rung fails for
  half the states and the climb is the normal path, not the exception
- Regions: south 98, northeast 40, midwest 28, west 20

### 2.4 State codes are not clean

Store **170:170 records its state as `"Texas"`**, spelled out. A naive
two-letter lookup drops it straight to national for no reason. `region_for()`
normalises through `app.signals.us_states.to_code` first.

Three stores cannot be placed at all (a blank `HQ` row, and a bogus `"DM"`).
They skip the region rung and land on national — which is exactly what the
floor is for.

---

## 3. Files

| File | Lines | What |
|---|---:|---|
| `app/pipeline/priors/kanon.py` | 190 | k-anonymity. Not optional. |
| `app/pipeline/priors/ladder.py` | 200 | The two-axis ladder + US regions. |
| `app/pipeline/priors/cohort.py` | 370 | `estimate_prior`, dispersion. |
| `app/pipeline/priors/__init__.py` | 70 | Public surface. |
| `tests/test_priors.py` | 420 | 31 tests incl. a 600-case fuzz. |

---

## 4. The guarantee

```python
estimate_prior(request, ctx)   # ALWAYS returns ok=True
```

No input may cause this to fail for lack of a cohort. If it could, every
downstream stage would need a branch for *"no prior available"* — and
eliminating exactly that branch is the point of the architecture. The untested
error path is the one that breaks at 3am for the store that signed up
yesterday.

Attacked seven ways in `test_nothing_can_make_it_return_ok_false`, then
**fuzzed with 600 randomised shapes** (empty estates, bogus states, missing
units, single-store cohorts, zero and 99× weights). Seeded, so a failure is
reproducible. Not one returns `ok=False`, and not one leaks a cohort below k.

### The one case where no real cohort exists

If even the terminal rung cannot clear k, it **still resolves** — with
`basis="structural_default"`, `cohort_size=0`, `evidence_state="NEW"`,
`own_weight=0.0` and a stated reason.

Resolving and being honest about what resolved are not in tension. Returning
`ok=False` would have been the *dishonest* option, because it pushes the
decision into an error path nobody tests. The default value is `0` and is a
registry Setting — changing it to a non-zero guess would be inventing a number
with no basis, which is the behaviour this sheet exists to end.

---

## 5. k-anonymity — and the second rule bare k doesn't give you

A cohort statistic is **other tenants' data**. With n=2 and one known value,
the other is arithmetic. This is a legal boundary as much as a statistical
one, which is why it is in the code from the first commit.

**Rule 1 — never fewer than k distinct stores.** If a rung has fewer, **climb**.
Climbing loses specificity; returning a thin cohort loses a tenant's
confidentiality, and only one of those is recoverable.

**k counts STORES, not rows.** Observations are collapsed to one value per
store (by median) *before* the check — otherwise a two-store cohort with 500
rows sails past. Tested.

**Rule 2 — no single store may dominate.** A cohort of five where one store is
96% of the weight is a cohort of one wearing a disguise: the mean *is* that
store's number, and publishing it discloses it as surely as n=1 would. Bare
k counts members; this checks the count means anything.

Both floors are registry Settings (`priors.k_anonymity.min_stores`,
`priors.k_anonymity.max_single_store_share_pct`) so *"what is our k, and has it
ever changed"* is auditable rather than archaeological.

---

## 6. Dispersion — what sheet 07 turns into interval width

Every prior carries how much the peers **disagree**:

```python
prior.dispersion.cv_pct              # scale-free, familiar
prior.dispersion.iqr                 # robust, preferred on small cohorts
prior.dispersion.iqr_over_median_pct
prior.dispersion.p25 / p50 / p75
prior.dispersion.high_dispersion     # flagged in reasons
```

A prior drawn from peers who disagree wildly must produce a **wide** interval;
one drawn from peers who agree, a narrow one. A point estimate without
dispersion is the same false confidence this rebuild exists to remove, one
level up.

**A single store reports dispersion as `None`, not zero.** One store cannot
disagree with itself, and reporting `0` would claim perfect agreement from one
observation — producing a confidently narrow interval downstream.

**The prior is the MEDIAN**, not the mean: cohorts are small and one outlier
store should not move it. The mean is reported alongside for contrast — in the
test, median 10 versus mean 1,668.

---

## 7. Provenance — what sheet 06 reads

```python
provenance.cohort_level    # 'state' | 'region' | 'national'
provenance.cohort_size     # distinct STORES
provenance.own_weight      # 0.0 — ALWAYS
provenance.own_observations # 0 — a prior is never the store's own evidence
```

`own_weight = 0.0` is the field sheet 06 reads to decide how hard to shrink. A
prior is borrowed evidence by definition, and saying so in the provenance is
what lets the blend be honest.

The result also reports `rungs_tried` and `rungs_rejected`, so a reader can see
*why* the answer came from where it did:

```
rungs_tried:    ['state/all_products', 'region/all_products']
rungs_rejected: {'state/all_products': 'k_anonymity:2<5_distinct_stores'}
```

---

## 8. Every store, empty to full

| | ZERO history | THIN state | FULL |
|---|---|---|---|
| Cohort | borrows entirely | climbs to region | state |
| `cohort_size` | 6 peers | 8 peers | 34 peers |
| `own_weight` | 0.0 | 0.0 | 0.0 |
| Resolves? | **yes** | **yes** | yes |

A store that opened yesterday gets a real, sourced answer with
`cohort_level='state'` and `cohort_size=6` — not a blank, and not an invention.

---

## 9. Verification

```bash
cd Botella_External_APIs
./.venv/Scripts/python.exe -m pytest tests/test_priors.py -q   # 31 passed
./.venv/Scripts/python.exe -m pytest -q                        # 671 passed
./.venv/Scripts/python.exe scripts/check_no_literals.py        # exit 0
```

| Sheet's "tests that matter most" | Proven by |
|---|---|
| Zero-history store returns a usable prior with level + size | `test_a_store_with_NO_history_still_gets_a_usable_prior` |
| A cohort of 2 is never returned; the ladder widens | `test_a_cohort_of_two_is_never_returned_the_ladder_widens_instead` |
| Dispersion higher for a disagreeing cohort | `test_dispersion_is_higher_for_a_disagreeing_cohort` |
| Same store + same as_of → identical output | `test_the_same_query_twice_returns_identical_output` |
| **The ladder always terminates** | 7 adversarial cases + 600-case fuzz |

---

## 10. Not done

- **No cohort loader.** `estimate_prior` takes candidates and observations as
  input, by design — a stage never fetches. The query that assembles them from
  the feature store is wiring that belongs with sheet 06, which is the first
  consumer.
- **Nothing consumes the prior yet.** Sheet 06 blends it with own evidence
  using `n` (sheet 04) and `own_weight`; sheet 07 turns `dispersion` into
  interval width.
- **RESOLVED in [sheet 06A](SHEET-06A-INTEGRATION.md).** The builder has run
  across the estate (94/94 stores, 12,091,569 rows), every calendar-day
  divisor is migrated, and 04 -> 05 -> 06 runs end to end on real stores.
- **37 of 37 registry settings are PROVISIONAL** (5 new here).
