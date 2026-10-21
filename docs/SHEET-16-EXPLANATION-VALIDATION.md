# Sheet 16 — Explanation validation

**Status:** complete. **1119 Python tests (+35), two build guards, ruff + mypy
clean.**
**Depends on:** 14, 15. **Wave:** 5. **On failure:** **log — not a page.**

> **Note on the source path.** The sheet header names
> `C:/Users/Techm/Downloads/external_api`. That is the **stale August copy**.
> All work is in `BottleAI-gitlab/Botella_External_APIs`, branch
> `New_Rec_Engine_v1.0`.

---

## 1. Why this exists

The backtest found **two invented SKUs out of roughly 480 referenced**.

That is 0.4%, and it is fatal. A single fabricated product destroys an owner's
trust in every other card on the screen — so there is no rate of invention low
enough to be acceptable, which is why this is a **set membership test** and not
a confidence score.

---

## 2. The other half of the split

| | Sheet 14 | Sheet 16 |
|---|---|---|
| Question | is the **decision** correct | does the **sentence** match it |
| Runs | before the model | after the model |
| Failure means | an upstream stage produced something impossible | a prompt or model regression |
| Severity | **PAGE** — wake someone | **LOG** — count it, look Monday |
| On failure | drop the card | drop the **prose**, keep the **decision** |

This never re-checks whether the decision is correct. Sheet 14 owns that
question and has already answered it; re-deriving the arithmetic would put the
same check in two places and let them drift.

**The stage returns `ok=True` even when the sentence fails.** The verdict is in
the value, not the envelope — because a failed envelope here would read to an
operator exactly like a sheet-14 page, and that conflation is precisely what
made the old single validator useless.

---

## 3. Four checks, all decidable

It does not judge whether a sentence is *good*. A semantic check would have
opinions, and opinions cannot be regression tested. These four can be:

### 1. Numerals — every number appears in the stage-14 record

Extract, normalise, set-compare. **Rounded, summed and invented all fail
identically**, because the prompt forbids computing: any figure not in the
record arrived by a route the card cannot justify.

```
$1,924.80   1,924.80   1924.8   $1924.80     →  all compare equal
"about 120" for 116                           →  FAILS (rounding is computing)
"164 after delivery" (48 + 116)               →  FAILS (a figure nobody validated)
```

Three things are removed before scanning, and each would otherwise fail *every*
card:

- **the ISO order-by date** — `2026-09-30` is a date, not the figures 2026, 09 and 30
- **the SKU** — `080686001904` is a name that happens to be spelled in digits
- **the product name** — `Terra Lager 12pk` contains `12`

### 2. Identity — exact key match, never a name lookup

Every SKU referenced must exist for **this** store, on
`(client_id, location_id, sku)`. Not a name lookup: two stores can carry
products with similar names, and "close enough" is exactly the judgement that
produced the two invented SKUs.

The SKU token pattern is **deliberately narrow** — six or more characters with
at least one digit. Treating `116` as a possible SKU would fail every card,
which is the false-positive rate that gets a checker switched off.

A **stale catalogue says so** rather than passing silently: if the decision's
own SKU is absent, the card may be right and the catalogue wrong, and every
other check here trusts it.

> **What this cannot do, stated plainly.** It cannot catch a wholly invented
> product *name* with no SKU attached — detecting "that phrase is a product
> name" in free prose is a semantic judgement, and this checker is mechanical
> on purpose. Sheet 15 closes that route from the other end: the model is given
> one record and forbidden to introduce anything not in it, and retrieval
> cannot supply a name either.

### 3. Provenance — the hedge must be present when the estimate is borrowed

`own_weight < 1` means some of this answer came from other stores. A card that
does not disclose that reads as a measurement of **this** shop, which is the
single most misleading thing a cold-start card can do.

### 4. Claims — no claim without the field that backs it

An **explicit list**, kept as data so it can be read, argued with and extended
without touching the checker:

| Claim | Triggered by | Requires |
|---|---|---|
| `substitution` | "switching to", "instead of", "substitute" | `substitution_evidence` |
| `price_effect` | "discount", "price cut", "elastic" | `elasticity` (sheet 09) |
| `trend` | "trending", "picking up", "taking off" | `trend_evidence` |
| `peer_comparison` | "similar stores", "stores like yours" | `cohort_size` |
| `margin` | "margin", "profit", "markup" | `unit_margin` |
| `stockout` | "run out", "sell out", "empty shelf" | `demand_p90` |

Each reason explains *why* the field is required — a margin claim needs cost
because 31 stores send 0.00% and a margin on a zero cost is an imaginary 100%;
a stockout claim needs the **upper** bound because running out is a tail event,
not a midpoint.

**Zero is treated as no evidence.** A cohort of 0 stores is not a cohort.

---

## 4. On failure: drop the prose, keep the decision

The decision was computed, constrained and validated long before the model
wrote anything. A bad sentence is a reason to use a **different sentence**,
never a reason to withhold a correct recommendation.

**The stage does the substitution itself.** A failed verdict already carries
sheet 15's template text in `.text`, so a caller cannot forget to fall back —
returning only a verdict and trusting every call site to handle it is how a card
ships with no sentence at all.

```python
verdict = validate_explanation(request, ctx).value
print(verdict.text)   # the model's sentence, or the template. Always shippable.
```

### The rate is the signal

`ExplanationStats` counts, because one failed sentence is a bad sentence while a
failure **rate that moves** is a regression — and that is only visible if
somebody is counting. `failure_rate` is **`None`, not `0.0`**, before anything
has been checked: "no cards failed" and "no cards were checked" are different
facts, and a zero would make an unrun check look like a clean one.

---

## 5. A gap in sheet 14 that this surfaced

`DecisionRecord` carried **no product name** — while sheet 14's own contract is
that the record holds every figure the card may display. A card says *"Order
116 of Terra Lager 12pk"*; the name is displayed, and sheet 16 could not check a
name the record never carried.

`ReorderCandidate` already had `display_name`; stage 14 simply was not
propagating it. `DecisionRecord.product_name` now does, and sheet 15 adds it to
`allowed_literals` — without which `Terra Lager 12pk` would fail the numeral
check on its own pack size.

A second near-miss, caught before it shipped: sheet 15 exports
`ExplanationRequest` and this sheet originally did too — two different types
with one name in the same package. Renamed to `ExplanationCheckRequest` and
`ExplanationVerdict`. One asks for a sentence to be **written**, the other for
one to be **checked**; two types sharing a name is how the wrong one gets
imported on a Friday.

---

## 6. On real data

`scripts/run_decisions.py` now runs the whole engine —
**03 → 07 → 10 → 11 → 12 → 14 → 15 → 16** — and sheet 16 runs on every card
exactly as it would in production:

```
The cards as an owner reads them (sheet 15, degraded path - no model was called):
  Order 88 of 080686001904 by 2026-09-30: you have 48 on hand and expect to sell
    107.4 in the next 14 days. (based on 6 similar stores; you have 38 weeks of
    your own history)
  ...

  sheet 16: 3 card(s) checked, 0 failed (0%) - every numeral traced to a validated figure
```

| store | cards | failed |
|---|---:|---:|
| 171 | 3 | **0** |
| 22 | 7 | **0** |

The card that **ships** is the verdict's text, never the raw model output — a
failed sentence has already been replaced by the time it is printed.

---

## 7. Files

| File | Lines | What |
|---|---:|---|
| `app/pipeline/validate/explanation.py` | 430 | The four checks, the claim list, the counter |
| `app/pipeline/validate/decision.py` | +12 | `product_name` on the record |
| `app/pipeline/explain/render.py` | +6 | the name in `allowed_literals` |
| `scripts/run_decisions.py` | +40 | sheet 16 on every card, counted |
| `tests/test_validate_explanation.py` | 400 | 35 tests |

---

## 8. Verification

```bash
cd Botella_External_APIs
./.venv/Scripts/python.exe -m pytest tests/test_validate_explanation.py -q  # 35
./.venv/Scripts/python.exe -m pytest -q                                     # 1119
./.venv/Scripts/python.exe scripts/check_no_literals.py                     # exit 0
./.venv/Scripts/python.exe -m mypy app/pipeline/                            # clean
./.venv/Scripts/python.exe scripts/run_decisions.py s171.json               # cards + rate
```

| Sheet requirement | Proven by |
|---|---|
| A planted invented number is caught | `test_a_planted_invented_number_is_caught` |
| `$1,924.80` vs `1924.8` compare equal | `test_currency_and_separators_compare_equal` |
| A nonexistent SKU is caught | `test_a_nonexistent_sku_is_caught` |
| A missing hedge on a cohort card is caught | `test_a_missing_provenance_sentence_on_a_cohort_card_is_caught` |
| A failure still ships a card with correct numbers | `test_a_failure_still_ships_a_card_with_correct_numbers` |
| Log, never page | `test_every_failure_is_log_severity_never_page` |
| The stage cannot read as a page | `test_the_stage_never_fails_so_it_cannot_read_as_a_page` |
| It never re-checks the decision | `test_it_never_rechecks_whether_the_decision_is_correct` |
| All four checks run after one fails | `test_all_four_checks_run_even_after_one_fails` |
| A short number is not mistaken for a SKU | `test_a_short_number_is_not_mistaken_for_a_sku` |
| A pack size in a product name is not arithmetic | `test_naming_its_own_product_is_fine_even_with_a_pack_size_in_the_name` |

---

## 9. Not done

- **Nothing calls this in the live run yet** — the same migration dependency as
  sheets 10–15. `app/recommender/validator.py` still runs the old combined
  checks, where a pipeline bug and a wording slip produce the same dropped card.
- **The claim list will need extending.** Six patterns cover what cards say
  today. A new claim type is a one-line addition to `CLAIM_PATTERNS`, which is
  the point of keeping it as data — but nobody has swept the live corpus for
  claims the list does not yet name.
- **Spelled-out numbers are not checked.** "order one hundred and sixteen"
  contains no numeral and passes. Flagging number words would false-positive on
  ordinary prose ("one of your best sellers"), and a check with false positives
  gets switched off — which costs more than this evasion does, given the prompt
  forbids it and temperature is 0.
- **`StoreCatalogue` is supplied, not fetched**, and nothing populates it in
  the live path yet. The chain script builds it from the exported stock block;
  production will need the store's full SKU set, which is a keyed read Node
  already does elsewhere.

---

## 10. The one-line summary

Every numeral on every card is traced back to a figure stage 14 validated, every
SKU to something the store actually carries — mechanically, so the check can be
regression tested — and when a sentence fails, the prose is dropped and the
decision ships anyway with a template that carries the identical numbers.
