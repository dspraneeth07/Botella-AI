# Sheet 12 — Candidate generation

**Status:** complete. **963 Python tests (+26), two build guards, ruff + mypy clean.**
**Depends on:** 10, 11. **Wave:** 4. **Extends:** `app/store_data/candidates.py` (untouched).

---

## 1. The rule that makes the explanation layer checkable

**A candidate carries every number that will ever appear on its card.** If a
figure is not in `figures()`, stage 16 rejects any sentence containing it.

That is what turns *"do not hallucinate"* from an **instruction** into a
**mechanism**. An instruction is followed most of the time; a mechanism is a
set membership test.

```python
candidate.figures()
# {'feasible_qty': 116.0, 'demand_p50': 277.8, 'demand_p90': 354.1,
#  'on_hand': 48.0, 'on_order': 0.0, 'lead_time_days': 7.0}
```

Adding a number to a card means adding it to the candidate first, which means
sourcing it from a stage that computed it. That is the whole point.

**Missing figures fail at construction**, not at render:

```
ValueError: reorder candidate for 080686001904 is missing required
figure(s): demand_p90. Every number that will appear on the card must be
on the candidate.
```

---

## 2. The five families, and what each must carry

| Family | Claim | Carries |
|---|---|---|
| `REORDER` | Order n units by date d | `feasible_qty` · `constraint_reasons` · `order_by_date` · `demand_p50` · `demand_p90` · `on_hand` · `on_order` · `lead_time_assumption` |
| `CLEAR` | This capital is stuck | `units` · `capital` · `days_since_last_sale` · `rule_applied` |
| `MARKDOWN` | Cut price, volume compensates | `beta` · `beta_interval` — **may not exist at all** (§3) |
| `RANGE` | Stock something you do not | `cohort_level` · `cohort_size` · `peer_adoption_rate` |
| `SUBSTITUTE` | This replaces that | `replaces` (an identity) · `evidence_kind` · basket evidence |

Every candidate also carries the **Provenance** from the stages that produced
it — `evidence_state`, `own_weight`, `cohort_level`, `config_keys`. A card that
cannot say how much of itself is this store's own behaviour is a card nobody
can weigh.

Three families refuse to exist without their justification:

- a `CLEAR` must **name the clearing rule** — "this is stuck" with no rule is
  an opinion;
- a `RANGE` must **name which cohort** — it is a claim about comparable stores,
  so it has to say which ones;
- a `SUBSTITUTE` must state `basket` or `category` evidence — a link with no
  stated evidence is name-matching wearing a different hat.

---

## 3. MARKDOWN is never constructed — not constructed, then flagged

The elasticity check happens **before the object exists**. There is no
MarkdownCandidate carrying a "weak evidence" flag for a later stage to filter,
because a `MarkdownCandidate` that exists at all is already the claim that
cutting the price pays. A flag would leave that claim sitting in the pipeline
waiting for somebody to forget to check it.

Two lines of defence:

1. `generate.py` consults sheet 09's elasticity before building one;
2. `MarkdownCandidate.__post_init__` raises on a zero-spanning interval
   regardless of who calls it.

The generator withholds with a **specific** reason, not a generic one:

```
elasticity_interval_spans_zero:[-1.100,0.500]
elasticity_is_positive:[0.500,0.900]
elasticity_is_inelastic:[-0.700,-0.300]
```

Those are three different findings. On real data sheet 09 measured **98.5% of
(store, category) cells unable to support the claim** — 51.6% spanning zero,
9.0% positive, 23.6% inelastic — so most markdowns simply never become
candidates.

---

## 4. Identity is `(client_id, location_id, sku)`. Never a name.

Two SKUs are not the same product because their names share a word. The same
bottle is "Tito's Handmade Vodka 750ml" in one store and "TITOS VODKA 750" in
another.

`test_no_name_based_matching_anywhere_in_the_package` walks both modules' ASTs
and fails on any `match` / `search` / `startswith` / `ilike` whose receiver is
a name-shaped attribute, on any comparison against one, and on `import re`
appearing at all. Asserted, not reviewed.

### A correction to the sheet

> The sheet says *"the termPattern matcher at `backend/lib/metrics.js:561-566`
> matches without word boundaries, so a query for Tito's collides with
> unrelated products"* and warns against reintroducing it.

**Checked against the live database. That defect is already fixed.** The
function returns `` `\y${body}\y` ``, and `\y` is Postgres's word-boundary
escape. Measured:

| pattern | "gin bottle" | "ginger ale" | "virgin mary" |
|---|---|---|---|
| `\ygin\y` (today's code) | ✅ true | **false** | **false** |
| `gin` (unbounded — the bug) | true | ⚠️ true | ⚠️ true |

The rule is enforced in this module anyway, because it is right regardless of
whether anyone else is currently breaking it — and because a word-bounded name
match is *still* not an identifier.

`SubstituteCandidate.replaces` is a `CandidateIdentity`, not a string. That is
the family where a name match would do the most damage, since its entire claim
is that two SKUs are related.

---

## 5. Generation reads only from earlier stages

`generate.py` opens no connection and issues no query. Everything arrives in
`SkuInputs`: the forecast (07), the elasticity (09), the policy (10), the
constraints (11), the cohort figures (05).

`test_generation_never_touches_a_database` asserts the source contains no
`psycopg`, `connect(`, `cursor`, `SELECT ` or `execute(`. A stage that reads a
database cannot be replayed, only re-run — and a candidate whose numbers came
from somewhere other than a recorded stage output is exactly the figure stage
16 has no way to check.

---

## 6. It runs on real data

Store 171, the full chain **03 → 07 → 10 → 11 → 12**:

```
18 SKUs through the chain
  candidates generated: 3   withheld: 0

  reorder  sku=080686001904  feasible_qty=116  p50=277.8  p90=354.1  on_hand=48
  reorder  sku=721059000505  feasible_qty=34   p50=251.4  p90=333.0  on_hand=125
  reorder  sku=858800        feasible_qty=32   p50=89.7   p90=129.1  on_hand=29
```

Fifteen of eighteen produce **no candidate at all** — the store is well stocked
(125, 223, 495 units against a 30-day forecast), so the policy asks for nothing
and no card is proposed. That is the pipeline declining to manufacture activity.

---

## 7. Withheld candidates carry reasons

```python
CandidateSet(candidates=..., withheld=(("SKU", "markdown", "elasticity_is_inelastic:[-0.70,-0.30]"), ...))
```

*"We considered a markdown and the elasticity did not support it"* is
information. Its absence reads as *"we never looked"* — the same distinction
sheet 11 draws between UNAVAILABLE and unbounded.

---

## 8. Files

| File | Lines | What |
|---|---:|---|
| `app/pipeline/candidates/types.py` | 330 | Five frozen dataclasses, `figures()`, identity |
| `app/pipeline/candidates/generate.py` | 300 | Generation from earlier stages only |
| `app/pipeline/candidates/__init__.py` | 40 | Public surface |
| `tests/test_candidates_typed.py` | 400 | 26 tests |

`app/store_data/candidates.py` (424 lines) is **untouched** — the existing
14-slice generator still produces what ships today.

---

## 9. Verification

```bash
cd Botella_External_APIs
./.venv/Scripts/python.exe -m pytest tests/test_candidates_typed.py -q  # 26
./.venv/Scripts/python.exe -m pytest -q                                 # 963
./.venv/Scripts/python.exe scripts/check_no_literals.py                 # exit 0
./.venv/Scripts/python.exe -m mypy app/pipeline/                        # clean
```

| Sheet requirement | Proven by |
|---|---|
| No markdown when β spans zero | `test_a_markdown_candidate_is_not_generated_when_beta_spans_zero` |
| Every candidate's numbers present and non-null | `test_every_candidates_numbers_are_all_present_and_non_null` |
| Zero-history store carries cohort level and size | `test_a_zero_history_store_carries_cohort_level_and_size` |
| No name-based matching anywhere | `test_no_name_based_matching_anywhere_in_the_package` |
| Generation never queries the warehouse | `test_generation_never_touches_a_database` |
| Identity is the triple | `test_identity_is_the_triple_and_requires_a_sku` |

---

## 10. Not done

- **Nothing calls this in the live run.** `app/store_data/candidates.py` still
  produces the candidates that ship. Migrating means replacing 14 named slices
  with 5 typed families, and it should follow stage 13 (ranking) so the
  replacement has somewhere to go.
- **SUBSTITUTE has no evidence source wired.** The type and its validation
  exist; `co_purchases` reaches `RecommendationContext` but is not yet mapped
  into `SkuInputs`.
- **RANGE has no peer-adoption source wired.** Sheet 05's ladder produces
  cohort observations; computing "what fraction of the cohort carries this SKU"
  is a small query nobody has written.
- **CLEAR has no `days_since_last_sale` source wired.** It is derivable from
  `feature_daily` in one pass.
- **3 new settings, all PROVISIONAL** (79 PROVISIONAL, 7 MEASURED overall).

---

## 11. The one-line summary

A card can now only say a number that some stage actually computed, because the
candidate carries the set and stage 16 checks membership — and a markdown
cannot even be *proposed* unless the elasticity says a price cut pays.
