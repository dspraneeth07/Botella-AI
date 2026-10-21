# Sheet 15 — Explanation (RAG + LLM)

**Status:** complete. **1084 Python tests (+46), two build guards, ruff + mypy
clean.**
**Depends on:** 14. **Wave:** 5. **Extends:** `app/recommender/*`.

> **Note on the source path.** The sheet header names
> `C:/Users/Techm/Downloads/external_api`. That is the **stale August copy**.
> All work is in `BottleAI-gitlab/Botella_External_APIs`, branch
> `New_Rec_Engine_v1.0`.

---

## 1. Why this is smaller than you expect

**The model's job shrinks to writing.** It does not choose, rank, compute or
decide. Every number in its output was fixed by stages 10–14 before it was
called, and the prompt says so in as many words.

That is the whole sheet. Everything else follows from it — including the one
rule that makes sheet 16 possible at all.

---

## 2. The live bug, fixed first

`app/recommender/llm_client.py` built its request params with **no
`temperature` key at all**, so the call inherited the API default. The chat
path at `backend/routes/chat.js:1548` sets `temperature: 0`.

**The two paths disagreed, and the one that sizes purchase orders was the
sampled one.**

```python
params: dict[str, Any] = {
    "model": self.model_id(),
    "max_tokens": self._settings.llm_max_tokens,
    "temperature": self._settings.llm_temperature,   # ← was absent
    ...
}
```

It matters more now than it did before this sheet. When the model was choosing
recommendations, sampling changed *what you got*. Now that every figure is
fixed beforehand, sampling can only vary the prose around fixed numbers — which
turns a genuine prompt regression into something indistinguishable from
run-to-run noise. That is precisely the distinction sheet 16 exists to make.

`test_temperature_zero_is_actually_sent` asserts on the **request payload**,
not on the setting, because a setting nobody reads is exactly the bug that was
there.

### Pinning, and what "pinned" honestly means

`llm_model` is `claude-sonnet-4-6` — an **alias**, and an alias moves. A card
written six months ago cannot be explained by an alias.

- `llm_model_pinned` takes a dated snapshot and is sent instead when set.
- Every call logs both `model` (what we asked for) and `resolved_model` (what
  the API resolved it to) — the dated id to put in `llm_model_pinned` when
  freezing a run.
- `model_id()` is the single source for what is sent *and* what is recorded, so
  the two cannot drift.

Three things now travel in Provenance on every card: **model id, temperature,
and `PROMPT_TEMPLATE_VERSION`**. "Why did this card read oddly" is
unanswerable without all three.

---

## 3. The one rule, made structural

> **Retrieval supplies WORDS AND PRECEDENT, NEVER A FIGURE.**

This is not a guideline anybody has to remember. `RetrievedText` **refuses to
be constructed** from a string containing a digit:

```python
RetrievedText(text="this SKU sold 400 units last March", source="doc:1")
# RetrievalContainsFigure
```

…and from a string containing a number *word*, because a digit check alone has
an obvious bypass:

```python
RetrievedText(text="customers usually buy two at a time", source="doc:2")
# RetrievalContainsFigure
```

The check is at the boundary rather than in a review comment, because a rule
enforced by attention is a rule that holds until the day somebody is busy.

### Why it matters more than it looks

Sheet 16 verifies faithfulness by checking every numeral in the sentence
against stage 14's record. **That check is only meaningful if the record is the
only source of numerals.** One retrieved passage carrying a stale figure makes
the whole verification decorative — the model would be quoting a real number
from a real document, and the checker would see a numeral it cannot account
for, or *worse*, one that happens to match.

So the arithmetic and the retrieval are kept in **separate pipes**. The
arithmetic pipe carries numbers and no prose. The retrieval pipe carries prose
and no numbers. Nothing merges them but the sentence, and the sentence is
checked.

### The three sources, and why only one needs a vector store

| Retrieval use | Allowed | How |
|---|---|---|
| Any figure on a card | **Never** | Every number comes from stage 14 |
| This store's past outcomes | From day one | **Structured** — a keyed read |
| Cohort precedent | From day one | **Structured** — counted and sourced |
| Product / substitution text | Once the store has category data | pgvector |

The first two are keyed reads. Treating them as a retrieval problem would add a
vector store to a question that is a `WHERE` clause.

The third is the only genuine retrieval, and it is **useless without category
data** — which 31 stores in this estate do not have. For those,
`vector_retrieval_is_useful()` returns False and the store is **not queried at
all** rather than queried for noise. An empty result is a fact; a
nearest-neighbour match over a catalogue with no categories is a
confident-looking irrelevance.

Passages that carry a figure are dropped and **counted** —
`Explanation.retrieval_dropped` — so a card can be honest about how much of the
retrieval it actually used. Silently dropping three of five would make the
retrieval look more relevant than it was.

---

## 4. The prompt: the record, and nothing else

`build_prompt(record, precedent)` takes the **`DecisionRecord` itself** — not a
store id, not a query — so there is nothing for the function to look up and
nothing for a future edit to *start* looking up.

Asserted by two tests:

- `test_the_prompt_contains_no_warehouse_rows` — no SQL markers, no table
  names, no tenant columns.
- `test_the_prompt_cannot_query_anything` — an AST walk proving the module
  imports no database driver, no HTTP client, and no model SDK.

The system prompt states the rule in the model's own terms:

> EVERY NUMBER YOU NEED IS GIVEN TO YOU. You may not compute, derive, round,
> convert, estimate or infer any figure. … Do not turn 116 into "about 120",
> do not turn 14 days into "two weeks", do not add up two given numbers to
> make a third.
>
> YOU ARE NOT DECIDING ANYTHING. The action, the quantity and the date were
> decided and validated before you were called.

**Figures are shown in display form, not as raw floats.** Handing the model
`277.79999999999995` invites a "correction" to `277.8` — which would be the
model *computing*, and sheet 16 rejecting a numeral that is arguably more right
than the one it was given. Rounding happens once, in `_format_figure`, and what
the model sees is what the card shows.

---

## 5. Degraded mode: a missing explanation is never a missing card

If the model is slow, rate-limited, or returns something unusable, the card
ships with a **template sentence carrying the identical numbers**.

```
Order 88 of 080686001904 by 2026-09-30: you have 48 on hand and expect
to sell 107.4 in the next 14 days.
```

The decision was computed, constrained and validated before the model was
called. Withholding the card would punish the store for an outage in the one
part of the system that contributes **no arithmetic**.

`model_sentence=None` is an **ordinary input**, not an exception — so "the model
timed out" and "the model answered" travel the same code and are tested the
same way. The stage has **no path that returns `ok=False` for a model
problem**.

Four structural faults fall back: empty, over `MAX_SENTENCE_CHARS`, a refusal
("I cannot…", "As an AI…"), or nothing at all. Whether the *numerals* are
faithful is sheet 16's question, asked after this stage — answering it in both
places would let the two drift.

The template is also **the floor the model has to beat**, and the reason model
output can be rejected freely. A checker with nothing to fall back on is always
under pressure to accept a marginal sentence.

---

## 6. The provenance sentence is generated, never written

When `own_weight < 1` the estimate is partly borrowed, and the card says so:

```
(based on 14 similar stores in Texas; you have 3 weeks of your own history)
```

Those figures come from `Provenance` — counted facts travelling with the
estimate — so the model never gets the chance to round 14 to "about a dozen" or
turn "3 weeks" into "a few weeks". **A hedge is only worth printing if it is
exact**; a vague hedge reads as a disclaimer and gets ignored.

### Two bugs found writing it

**The rung and the place are different facts.** `Provenance.cohort_level` is
one of `store | state | region | national` — the rung of sheet 05's ladder,
validated against exactly that vocabulary. It is *not* a place name. The first
version read it as one and would have printed *"based on 14 similar stores in
state"*. The place comes from `CohortPrecedent.region`, a structured lookup;
without it the sentence says how many peers answered but not where, which is
less useful and still true. `test_the_rung_is_never_printed_as_if_it_were_a_place`
pins it, and the **national rung names no place even when one is supplied** —
it covers everywhere.

**A permitted numeral that appears nowhere is a hole.** Provenance figures were
added to `allowed_figures` unconditionally, so a card carrying *no hedge* still
permitted `own_observations` as a numeral. A fixture where that happened to be
120 let an invented *"order about 120 units"* pass the check. They are now
added **only when the clause is actually printed**.

Cards that need no hedge get none: `own_weight == 1.0` returns `""`, because a
hedge on a card that does not need one trains owners to ignore the hedge on
cards that do. And at `n = 0` — the pure cold-start case — the card says *"this
is your first data on it"*, which is the whole point of sheet 06.

---

## 7. The contract with sheet 16

`Explanation` carries exactly what a faithfulness check needs:

| Field | What it is |
|---|---|
| `allowed_figures` | Every numeral that may appear: stage 14's `figures()`, plus provenance figures **only when the clause prints them** |
| `allowed_literals` | The SKU and the ISO order-by date |
| `source` | `"model"` or `"template"` |
| `degraded_reason` | Why the model's sentence was not used |
| `model_id`, `temperature`, `template_version` | What wrote it |

`unaccounted_numerals()` lives here rather than in sheet 16 so the prompt, the
template and the verifier share **one** definition of "a numeral" and one of
"matches".

### A SKU is an identifier, not a quantity

`080686001904` is a name that happens to be spelled in digits. So is
`2026-09-30`. Neither is arithmetic, neither can be "rounded", and the first
version of the checker **flagged both on every single card** — the shape of
false positive that gets a checker switched off. ISO dates are stripped and
`allowed_literals` removed before the numeral scan.

A thousands separator is **one** figure, not two: `1,389` matches `1389.0`.

The tolerance is a registry Setting, and `check_no_literals` caught the first
version where it was a default argument — the guard doing its job. It absorbs
display rounding and nothing else: a model that wrote "about 120" for 116 is
out by **eighty times** the tolerance, and is computing rather than quoting.

---

## 8. Running on real data

`scripts/run_decisions.py` now runs **03 → 07 → 10 → 11 → 12 → 14 → 15**. It
calls no model, so every card takes the **degraded path deliberately** — which
is the thing worth demonstrating:

```
3 decisions passed the gate (14-day coverage window)

The cards as an owner reads them (sheet 15, degraded path - no model was called):
  Order 88 of 080686001904 by 2026-09-30: you have 48 on hand and expect to sell
    107.4 in the next 14 days. (based on 6 similar stores; you have 38 weeks of
    your own history)
  Order 10 of 721059000505 by 2026-09-30: you have 125 on hand and expect to sell
    102.6 in the next 14 days. (based on 5 similar stores; you have 22 weeks of
    your own history)
  Order 32 of 858800 by 2026-09-30: you have 29 on hand and expect to sell 43.4
    in the next 14 days. (based on 6 similar stores; you have 19 weeks of your
    own history)
```

The chain runs sheet 16's check inline and **raises** if any numeral on any card
is unaccounted for — so the contract is proven by the run, not asserted in
prose.

---

## 9. Files

| File | Lines | What |
|---|---:|---|
| `app/pipeline/explain/precedent.py` | 215 | The RAG scope rule, enforced at construction |
| `app/pipeline/explain/prompt.py` | 175 | Versioned template; the record, and nothing else |
| `app/pipeline/explain/template.py` | 110 | The degraded sentence |
| `app/pipeline/explain/render.py` | 330 | The stage, the provenance sentence, the numeral contract |
| `app/pipeline/explain/__init__.py` | 65 | Public surface |
| `app/recommender/llm_client.py` | +30 | **temperature 0**, `model_id()`, resolved model logged |
| `app/config.py` | +20 | `llm_temperature`, `llm_model_pinned` |
| `scripts/run_decisions.py` | +45 | Stage 15 in the chain, with the numeral check |
| `tests/test_explain.py` | 480 | 41 tests |
| `tests/test_llm_client.py` | +55 | 5 tests, asserting on the request payload |

---

## 10. Verification

```bash
cd Botella_External_APIs
./.venv/Scripts/python.exe -m pytest tests/test_explain.py -q      # 41
./.venv/Scripts/python.exe -m pytest tests/test_llm_client.py -q   # 13
./.venv/Scripts/python.exe -m pytest -q                            # 1084
./.venv/Scripts/python.exe scripts/check_no_literals.py            # exit 0
./.venv/Scripts/python.exe -m mypy app/pipeline/                   # clean
./.venv/Scripts/python.exe scripts/run_decisions.py s171.json      # cards
```

| Sheet requirement | Proven by |
|---|---|
| temperature 0 is actually sent | `test_temperature_zero_is_actually_sent` |
| The two paths agree | `test_the_recommendation_path_agrees_with_the_chat_path` |
| The model version can be pinned | `test_a_pinned_model_is_sent_instead_of_the_floating_alias` |
| The prompt contains no warehouse rows | `test_the_prompt_contains_no_warehouse_rows` |
| The prompt cannot query anything | `test_the_prompt_cannot_query_anything` |
| A model timeout still produces a card | `test_a_model_timeout_still_produces_a_card_with_every_number_intact` |
| A cohort-weighted card always carries provenance | `test_a_cohort_weighted_card_always_carries_a_provenance_sentence` |
| Retrieval can never carry a figure | `test_retrieved_text_carrying_a_digit_cannot_be_constructed` |
| …nor a number word | `test_retrieved_text_carrying_a_number_WORD_is_also_refused` |
| No vector search without category data | `test_a_store_without_category_data_is_not_searched_at_all` |
| The model cannot change the decision | `test_the_explain_stage_cannot_change_the_decision` |

---

## 11. Not done

- **Nothing calls this in the live run yet.** Same migration dependency as
  sheets 10–14: `app/recommender/pipeline.py` still uses the legacy generator,
  where the model chooses *and* writes. This sheet replaces only the writing
  half, and the switch happens when stage 12's typed candidates replace the
  14-slice generator.
- **The pgvector store does not exist.** `precedent.py` defines what retrieval
  may supply and refuses anything that breaks the rule, but nothing populates
  it. The structured halves — store outcomes and cohort precedent — are keyed
  reads that work today and are what the chain currently uses.
- **`llm_model_pinned` is None by default**, so runs still use the floating
  alias and record what it resolved to. Freezing it is a deliberate act with a
  cost (no automatic model upgrades), and belongs to whoever owns the release.
- **The number-word list stops at twelve.** Beyond that, prose says "dozens"
  rather than counting, and a longer list starts rejecting ordinary phrases
  that carry no claim about this store.

---

## 12. The one-line summary

The model stopped deciding and started writing — at temperature 0, from a
versioned prompt containing only a validated decision, with retrieval
structurally unable to contribute a single digit, and a template that ships the
same numbers when the model does not answer at all.
