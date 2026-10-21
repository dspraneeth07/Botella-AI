# Sheet 13 — Deterministic ranking

**Status:** complete. **990 Python tests (+27), two build guards, ruff + mypy clean.**
**Depends on:** 12. **Wave:** 4. **Replaces:** LLM-chosen ordering.

---

## 1. Why this exists

Today the **model** chooses which recommendations appear and in what order.
That single fact explains most of the backtest result: the ordering was
unstable, unexplainable and **unimprovable**, because nobody could say what it
optimised.

Ranking becomes an ordinary function of numbers the pipeline already computed.
After this lands, the ordering can be **argued about, tuned and tested**. It is
arguably the smallest module in the programme and the one that most changes the
system's character.

```
score = expected_value × calibrated_confidence × urgency
```

---

## 2. The three terms, and why they multiply

| term | what it is |
|---|---|
| `expected_value` | margin × units at risk (or units gained). Money. |
| `calibrated_confidence` | sheet 08's **calibrated** value, never the raw one |
| `urgency` | how soon the decision window closes |

**Multiplied, not summed.** Each is a fraction of the others' value: a certain,
urgent recommendation worth nothing is worth nothing; a valuable, certain one
whose window closed last month is worth nothing too. A weighted sum would let
two strong terms carry a zero third — which is exactly the "high confidence, no
money" card this rebuild exists to remove.

`test_a_zero_in_any_term_zeroes_the_score` pins it.

Live example:

```
1. CCC  score= 145.50  EV=300  conf=0.50  urgency=0.97
2. AAA  score=  72.80  EV=100  conf=0.80  urgency=0.91
3. BBB  score=   4.50  EV= 20  conf=0.90  urgency=0.25
```

BBB is the **most confident** card and ranks last, because it is worth $20 and
its window is three weeks out. That ordering is now arguable — which was the
point.

---

## 3. Calibrated, never raw — asserted by AST

Sheet 08 measured stated confidence at **0.48 against a 0.23 hit rate**.
Ranking on that number would order cards by how confident the engine *sounds*
rather than by how often it is right.

`test_raw_confidence_is_never_used_in_place_of_calibrated` walks both modules'
ASTs for any `raw` name or attribute. The input field is called
`calibrated_confidence` — not `confidence`, because **an ambiguous name is how
the raw value gets used by accident.**

> A test bug worth recording: the first version grepped the *source text*, which
> failed — both docstrings legitimately **name** the thing they forbid
> (`datetime.now`, `raw_confidence`) while explaining why it is absent. A
> substring grep cannot tell an explanation from a violation. The check is an
> AST walk over imports and calls now.

---

## 4. Byte-identical, and asserted in CI

```python
first.to_bytes() == second.to_bytes()   # 489 bytes, identical
```

This stage is one of the few in the pipeline where **bitwise** determinism is
achievable — no bootstrap, no model, no clock — so it is asserted rather than
hoped for. The day somebody sorts on a dict, reads a clock, or lets a set's
iteration order leak into the output, the test fails.

**The tie-break is part of the contract.** `(-score, sku)`. Scores collide
constantly — two reorders with the same margin and confidence produce exactly
the same float — and Python's sort is stable, so without an explicit tie-break
the order would be whatever order the *caller* happened to build the list in.
That is reproducible only by accident.

Ascending SKU, so the tie-break is a property of the **data** rather than of the
caller. `test_input_order_does_not_change_the_output` reverses the input and
compares bytes.

**No model, no randomness, no clock.** Asserted by AST over imports
(`random`, `secrets`, `time`, `anthropic`, `openai`, `httpx`) and calls
(`now`, `today`, `shuffle`, `choice`). Every date comes from `ctx.as_of`, so
two runs over the same snapshot rank identically **months apart** —
`test_every_date_comes_from_the_run_context` changes `run_id` and `seed` and
compares bytes.

---

## 5. Diversity is a cap on crowding out, not a hard quota

A store that receives ten reorder cards and nothing else has been told one
thing ten times.

The precise guarantee: **every family present gets up to `cap` slots in the
window before any family gets more than `cap`.**

| scenario | result |
|---|---|
| 8 reorders, 8 clears | clears get 3 reserved slots even though all 8 reorders score higher |
| 8 reorders, 1 clear | the clear **is visible** — not crowded out |
| 8 reorders, nothing else | all 8 shown — the room goes back to the family that has something to say |

> **A design question I had to settle.** The first implementation held surplus
> candidates back unconditionally, which meant a store with only reorders saw
> **three cards instead of eight** — the cap firing where there was nothing to
> protect. That is not diversity, it is just showing less.
>
> The cap now binds **only where there is competition**: hold back first, then
> backfill any room the cap left over, in score order. A store with eight
> reorders and one clear should see the clear; a store with eight reorders and
> nothing else is not helped by being told the other five exist somewhere.

A hard quota would go further and **manufacture** a markdown to fill a slot,
which is the opposite of every other rule in this programme.

Nothing is deleted: held-back candidates appear lower in `ranked` and are
recorded in `overflow` with the reason. And `overflow` records only those that
**stayed out** — one the backfill readmitted was never displaced, and saying so
would be a false reason on a real card.

---

## 6. Missing margin is not an assumed margin

31 stores send 0.00% cost, so a candidate whose margin cannot be computed is
common. It scores **zero expected value** and carries `margin_available=False`,
because *a candidate worth nothing* and *a candidate whose worth is unknown*
look identical as a number and are not the same thing.

`rank.default_margin_rate` is **0** on purpose: a non-zero default would rank a
store's cards on a margin nobody measured. Sheet 02 already withholds margin
*claims* without cost; this is the ranking half of the same rule.

---

## 7. Every weight is a registry Setting

| Setting | Default | Why an exponent |
|---|---:|---|
| `rank.weight.expected_value` | 1.0 | a *multiplier* on a product term only rescales every score identically and **cannot change an ordering** |
| `rank.weight.confidence` | 1.0 | raising it makes the engine conservative — a commercial preference, not an engineering one |
| `rank.weight.urgency` | 1.0 | raising it pushes closing-window cards up |
| `rank.urgency_horizon_days` | 30 | decay horizon |
| `rank.urgency_floor` | 0.1 | **above zero** — a distant deadline makes a card less pressing, not worthless. Zero would multiply the whole score to nothing and silently delete every card without a near deadline, including large ones |
| `rank.max_per_family_in_top_n` | 3 | the diversity cap |
| `rank.top_n` | 10 | the window it applies to |

All PROVISIONAL, to be fitted against holdout outcomes in wave 6. No literals —
`check_no_literals` enforces it.

`test_raising_the_confidence_weight_favours_the_certain_candidate` proves the
weights actually change the ordering: at weight 1.0 a $360 risky card beats a
$158 certain one; at weight 6.0 the certain one wins.

**A past deadline scores 1.0, not zero** — the window closing is the most urgent
state there is, not a reason to stop mentioning it.

---

## 8. Files

| File | Lines | What |
|---|---:|---|
| `app/pipeline/rank/score.py` | 250 | The three terms, weights, urgency decay |
| `app/pipeline/rank/order.py` | 200 | Stable sort, family cap, `to_bytes()` |
| `app/pipeline/rank/__init__.py` | 40 | Public surface |
| `tests/test_rank.py` | 390 | 27 tests |

---

## 9. Verification

```bash
cd Botella_External_APIs
./.venv/Scripts/python.exe -m pytest tests/test_rank.py -q   # 27
./.venv/Scripts/python.exe -m pytest -q                      # 990
./.venv/Scripts/python.exe scripts/check_no_literals.py      # exit 0
./.venv/Scripts/python.exe -m mypy app/pipeline/             # clean
```

| Sheet requirement | Proven by |
|---|---|
| Identical input → identical bytes | `test_two_runs_produce_byte_identical_output` |
| Changing margin moves it predictably | `test_raising_a_candidates_margin_moves_it_up` |
| The family cap holds | `test_the_family_cap_holds` |
| Raw confidence never used | `test_raw_confidence_is_never_used_in_place_of_calibrated` |
| No model, no randomness, no clock | `test_the_module_calls_no_model_reads_no_clock_and_uses_no_randomness` |
| Dates come from `ctx.as_of` | `test_every_date_comes_from_the_run_context` |
| Ties break on ascending SKU | `test_ties_break_on_ascending_sku` |

---

## 10. Not done

- **The LLM still chooses the ordering in the live run.** This module replaces
  that, but nothing calls it yet — `validator.py` still caps and sorts on
  `_rank_confidence`. Switching over means stage 12's typed candidates must
  first replace the 14-slice generator, which is the migration sheet 12 named.
- **`units_at_stake` and `unit_margin` are supplied by the caller**, not yet
  derived from the candidate. A REORDER's units at risk is its `feasible_qty`;
  a CLEAR's is its `units`. Mapping them is small and belongs with the
  migration above.
- **All 7 weights are PROVISIONAL** (87 PROVISIONAL, 7 MEASURED overall). They
  are the tuning surface wave 6 exists for, and the first time this programme
  has had one.

---

## 11. The one-line summary

The ordering stopped being a model's opinion and became a formula over numbers
the pipeline already computed — byte-identical across runs, asserted in CI, and
for the first time something a person can disagree with.
