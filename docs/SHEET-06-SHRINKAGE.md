# Sheet 06 — Shrinkage / blending

**Status:** complete. 30 tests, all green. Two build guards, both enforced.
**Depends on:** 04, 05. **Wave:** 3. **Importance:** the architectural keystone.
**Nature:** additive. ~90 lines of code, ~400 lines of tests. That ratio is the point.

---

## 1. The whole sheet

```
θ̂ = (n · θ_own + k · θ_cohort) / (n + k)

n = 0    →  θ̂ = θ_cohort exactly.   a brand-new store. NO BRANCH TAKEN.
n = k    →  θ̂ = the midpoint.        an emerging store.
n >> k   →  θ̂ ≈ θ_own.               a mature store. SAME THREE LINES.
```

This is the smallest module in the programme and the one that makes the
architecture work. **Forty lines of arithmetic replace what would otherwise be
a tier system with branches**, and branches for rare cases are exactly the code
that never gets tested and rots.

---

## 2. What was *not* written, and why it was tempting

```python
if store.tier == "T0":  return cohort_estimate(...)   # NOT WRITTEN
if n == 0:              return theta_cohort           # NOT WRITTEN
if store.is_new:        ...                           # NOT WRITTEN
```

A tier gate does two bad things at once:

1. **It creates a cliff.** A store crossing the boundary sees its
   recommendations jump overnight for no reason it can observe.
2. **It creates a code path only cold-start stores exercise** — so it is never
   tested, which is how the rare case becomes the broken case.

The formula handles every case **because the formula is every case.**

---

## 3. The absence is enforced, not requested

Asking for this rule in review is not enforcement. Three mechanisms make it
structural:

### 3.1 `blend()` contains no conditional at all

`test_blend_contains_no_conditional_of_any_kind` parses the function's own AST
and fails on any `If`, `IfExp`, `Match`, `While` or `Assert`. Not "no tier
gate" — **no conditional of any kind**. A defensive ternary would fail it too.

### 3.2 Nothing anywhere branches on `evidence_state`

`scripts/check_no_state_branches.py` walks every module in `app/pipeline/` and
`storeagent/` and fails the build on a branch, conditional, `match`,
comparison **or dispatch table** whose subject is `evidence_state`. It runs as
a pytest test, so there is no separate CI step to forget.

What it allows, deliberately:

| Shape | Verdict | Why |
|---|---|---|
| `evidence_state="MATURE"` | allowed | **Producing** the label is what the producing stages are for |
| `row["evidence_state"]` | allowed | A plain read, e.g. for rendering |
| `if p.evidence_state == "MATURE"` | **fails** | A tier gate |
| `match p.evidence_state:` | **fails** | A tier gate |
| `HANDLERS[p.evidence_state]` | **fails** | A jump table is a branch spelled with brackets |

Two files are exempt and only two: `blend/evidence_state.py`, which *derives*
the label, and `provenance.py`, which *validates* it is one of the four.
Deriving a label from numbers is not branching on the label.

### 3.3 No tier vocabulary in executable code

`test_the_source_contains_no_tier_gate` checks the AST for any reference named
`tier`, `is_new`, `is_cold_start` or `store_tier`.

---

## 4. Files

| File | Lines | What |
|---|---:|---|
| `app/pipeline/blend/shrink.py` | 260 | The formula, and the five per-pattern `k` Settings. |
| `app/pipeline/blend/evidence_state.py` | 95 | The four bands + `own_weight`. Display only. |
| `app/pipeline/blend/__init__.py` | 50 | Public surface. |
| `scripts/check_no_state_branches.py` | 210 | The guard (§3.2). |
| `tests/test_blend.py` | 400 | 30 tests. |

---

## 5. The two edges that needed care

### 5.1 θ_own when there is nothing of it

A store with n=0 has no own estimate, but the formula still needs a number —
where it is multiplied by n, i.e. by **zero**, and annihilated.

`BlendRequest` normalises it once at the boundary into a separate
`own_estimate` field, so the hot path stays branchless. And rather than assert
that the substitution is harmless,
`test_theta_own_is_annihilated_when_n_is_zero` **proves** it: `None`, `0.0`,
`-1e9`, `1e9` and `123.456` all produce the identical answer. If the
substitution could matter, it would be a hidden branch.

> mypy caught the first version of this: the field was declared `float | None`
> while `__post_init__` guaranteed a float — the annotation was lying about the
> value. Hence the separate `own_estimate` field rather than an in-place
> rewrite. The caller's contract genuinely allows `None`; the arithmetic's
> genuinely does not.

### 5.2 The one guard, and why it is not a branch on data

`k_for_pattern` refuses a non-positive `k`. That is **configuration
validation** — it fires on a misconfigured registry, identically for every
store, and never on the shape of a store's data. With `k ≥ 1` the denominator
`n + k` cannot be zero for any `n ≥ 0`, so `blend()` itself needs no guard at
all.

---

## 6. Evidence state — four words, display only

| Label | Condition |
|---|---|
| `NEW` | n = 0 |
| `EMERGING` | 0 < n < k |
| `ESTABLISHED` | k ≤ n < 4k |
| `MATURE` | n ≥ 4k |

**No stage may branch on these.** The arithmetic uses `n`; the label is what
the interface says out loud. `test_evidence_state_changes_label_without_changing_any_number`
walks n through all four bands and verifies the value at every point equals
`(n·θ_own + k·θ_cohort)/(n+k)` computed independently.

And crucially, `test_there_is_no_jump_where_the_LABEL_changes`: crossing from
`EMERGING` to `ESTABLISHED` moves the number by **less than 2 units on a
100-vs-20 blend**. That boundary is exactly where a tier system would have its
cliff.

---

## 7. `own_weight` — the sentence the card says out loud

```python
provenance.own_weight = n / (n + k)
```

```
"Based 0% on your own sales (0 observations) and 100% on 24 similar stores (state)."
"Based 62% on your own sales (34 observations) and 38% on 24 similar stores (state)."
```

An owner can act on that. A bare number they cannot.

---

## 8. k is a registry Setting per pattern — never a literal

| Setting | Default | Unit |
|---|---:|---|
| `shrink.k.day_of_week` | 8 | observations |
| `shrink.k.weekly_trend` | 13 | complete weeks |
| `shrink.k.monthly_seasonality` | 3 | complete years covering the month |
| `shrink.k.sku_velocity` | 21 | open days with a known price |
| `shrink.k.category_share` | 14 | open days with a sale in the category |

All **PROVISIONAL**. Wave 6 fits them from holdout WAPE: the right k is the
one that minimises error across the estate, and it will differ between
day-of-week and seasonality because the patterns differ in how fast a single
store's own data becomes trustworthy.

*Writing a fixed 12 into the code and calling it done is how the current engine
acquired 63 unexamined constants.* `sku_velocity` gets the highest k on purpose
— intermittent SKUs are the majority (sheet 05: 89.8% of UPCs are carried by
fewer than 5 stores), so a handful of noisy days must not override a cohort of
60 stores.

---

## 9. Continuity — there is no cliff to find

`test_the_blend_is_continuous_across_n_0_to_100` walks n from 0 to 100 and
asserts the curve is **monotone** and that **every step is smaller than the
first**. A shrinkage curve has no cliff by construction; a tier gate would show
up here as a jump. Repeated for all five patterns.

---

## 10. Every store, empty to full

| | n = 0 | n = k | n ≫ k |
|---|---|---|---|
| θ̂ | `θ_cohort` exactly | the midpoint | ≈ `θ_own` |
| `own_weight` | 0.0 | 0.5 | > 0.99 |
| Label | `NEW` | `ESTABLISHED` | `MATURE` |
| **Code path** | **identical** | **identical** | **identical** |

`test_a_brand_new_store_and_a_mature_one_run_the_same_code` asserts the same
stage, same version, same outcome shape — only `n` differs.

---

## 11. Verification

```bash
cd Botella_External_APIs
./.venv/Scripts/python.exe -m pytest tests/test_blend.py -q        # 30 passed
./.venv/Scripts/python.exe -m pytest -q                            # 701 passed
./.venv/Scripts/python.exe scripts/check_no_state_branches.py      # exit 0
./.venv/Scripts/python.exe scripts/check_no_literals.py            # exit 0
```

| Sheet requirement | Proven by |
|---|---|
| n=0 returns exactly θ_cohort, own_weight 0.0 | `test_n_zero_returns_exactly_theta_cohort_with_own_weight_zero` |
| The blend is continuous across n=0..100 | `test_the_blend_is_continuous_across_n_0_to_100` (+ all patterns) |
| Label changes without changing any number | `test_evidence_state_changes_label_without_changing_any_number` |
| k from the registry, no literals | `test_k_is_a_registry_setting_per_pattern_not_a_literal` |
| **A test that greps for branches on evidence_state** | `test_NOTHING_IN_THE_PIPELINE_BRANCHES_ON_EVIDENCE_STATE` |
| **No branch anywhere in the module** | `test_blend_contains_no_conditional_of_any_kind` |

The guard is itself tested: `test_the_guard_catches_a_planted_branch` plants
four shapes (branch, conditional, match, dispatch table), confirms each is
caught, and confirms a clean file passes. Without that, a silently broken guard
would read exactly like a clean codebase.

---

## 12. Not done

- **Nothing calls `blend()` yet.** Sheets 04 (n) and 05 (θ_cohort) produce its
  inputs; the wiring that assembles them per SKU is the pipeline assembly work.
  Sheet 07 reads `dispersion_cv_pct`, which is carried through untouched.
- **All five k values are PROVISIONAL.** By design — wave 6 fits them.
- **RESOLVED in [sheet 06A](SHEET-06A-INTEGRATION.md).** The builder has run
  across the estate (94/94 stores, 12,091,569 rows), every calendar-day
  divisor is migrated, and 04 -> 05 -> 06 runs end to end on real stores.
  Assembling the three sheets is also what surfaced the pattern-vocabulary
  drift between 04 and 05/06, and a cohort prior supplied at the wrong grain -
  neither of which any single sheet's tests could have caught.
- **43 of 43 registry settings are PROVISIONAL** (6 new here).
