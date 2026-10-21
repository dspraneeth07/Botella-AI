# Sheet 00 — The stage envelope

**Status:** complete. 56 new tests (Python) + 24 checks (Node), all green.
**Blocks:** all 19 remaining sheets. Nothing else should start before this is understood.
**Nature:** purely additive. No existing module was modified.

---

## 1. The problem it removes

Today a calculation reads the database wherever it needs to, takes the date from
the process clock, and returns a bare number.

Two consequences, both of which we have actually paid for:

- **The 23% backtest could not be traced to a specific input.** The number
  existed; the reasoning behind it did not survive the function call.
- **Two components computing the same figure drifted.** The dead-stock tile said
  454, chat said 485 — each went to the data separately and applied its own
  rule. Neither was "wrong" in a way you could point at, because neither
  recorded what it had done.

A bare number cannot be argued with. You cannot tell whether it rests on eleven
observations from this store or on a national cohort average, which thresholds
shaped it, or which features it even read.

**The envelope makes that structurally impossible.** A stage receives everything
it may use and returns everything it decided, including how it decided.

---

## 2. Files

### Python — `Botella_External_APIs/`

| File | Lines | What it is |
|---|---:|---|
| `app/pipeline/context.py` | 158 | `RunContext` — the pinned world a stage may know about. Plus `FrozenDict`. |
| `app/pipeline/provenance.py` | 241 | `Provenance` — how a stage decided. Plus the ContextVar recording scope. |
| `app/pipeline/envelope.py` | 323 | `StageResult`, the `@stage` decorator, `replay()`, `digest()`. |
| `app/pipeline/registry.py` | 288 | `Setting`, `ConfigRegistry`, `ConfigReport`. The one place numbers may live. |
| `app/pipeline/fixtures.py` | 75 | `load_fixture()` / `save_fixture()` — run a stage from a flat file. |
| `app/pipeline/__init__.py` | 101 | Public surface. One import line for a stage author. |
| `scripts/check_no_literals.py` | 286 | The build guard: no magic numbers, no ambient reads. |
| `scripts/config_report.py` | 88 | "How much of this engine is still guesswork" — for CI. |
| `scripts/no_literals_baseline.json` | — | The grandfathered debt list (see §7). |
| `tests/test_pipeline_envelope.py` | 428 | 32 tests — the contract itself. |
| `tests/test_pipeline_guards.py` | 254 | 24 tests — the guards, including planted violations. |
| `tests/fixtures/dead_stock_basic.json` | — | Reference fixture: a stage's whole world in one file. |
| `tests/fixtures/stage_result_golden.json` | — | Cross-language contract pin (see §6). |
| `.gitlab-ci.yml` | +21 | A `test` stage — the project had none (see §7.3). |

### Node — `backend/`

| File | Lines | What it is |
|---|---:|---|
| `lib/stageEnvelope.js` | 231 | Parses the same JSON shape. The only place Node reads a stage output. |
| `tests/stage-envelope-verify.js` | 131 | 24 checks against a Python-emitted golden row. |
| `tests/fixtures/stage_result_golden.json` | — | The same golden row, committed on this side too. |

---

## 3. The contract

### `RunContext` — everything a stage may know

```python
@dataclass(frozen=True, slots=True)
class RunContext:
    run_id: str                     # one uuid per pipeline execution
    tenant_id: int                  # client_id, also the RLS GUC
    store_id: int                   # location_id
    as_of: date                     # THE clock. No stage may call date.today()
    snapshot_id: str                # which data snapshot — makes replay exact
    config_version: str             # which threshold set
    seed: int = 0                   # for anything stochastic
    versions: Mapping[str, str]     # pinned code/model/data versions
```

A stage is a pure function of `(value, ctx)`. Anything ambient it might
otherwise reach for arrives here instead. Given the same input and the same
`RunContext`, a stage must produce the same output forever.

**Three deliberate hard edges:**

- `as_of` **rejects a `datetime`.** `datetime` is a `date` subclass, so the
  obvious `isinstance(as_of, date)` check accepts a timestamp — and a
  time-of-day silently reintroduces the sub-day clock dependence the field
  exists to remove.
- `tenant_id` **rejects a `bool`.** `bool` is an `int` subclass; `True` would
  quietly become tenant 1.
- `versions` is a **`FrozenDict`**, not a dict. A plain dict on a frozen
  dataclass is a hole in the freeze — the dataclass refuses attribute
  assignment while the caller happily mutates the mapping it passed in.

### `Provenance` — how it decided, travelling WITH the value

```python
@dataclass(frozen=True, slots=True, kw_only=True)
class Provenance:
    own_observations: int              # n — the evidence count
    cohort_level: str | None = None    # store | state | region | national
    cohort_size: int | None = None
    own_weight: float                  # 0.0 .. 1.0 — how much was this store
    evidence_state: str                # NEW | EMERGING | ESTABLISHED | MATURE
    inputs: tuple[str, ...] = ()       # feature keys actually read
    config_keys: tuple[str, ...] = ()  # thresholds actually applied
```

The important word is **WITH**. This is not a log line emitted next to the
value — logs get sampled, truncated, rotated and detached from the number they
explain. It is a field on the result, persisted in the same audit row, so a
figure and its justification cannot be separated.

`own_weight` is the field to read before trusting a number: `1.0` means the
answer is this store's own behaviour; `0.0` means it is entirely a cohort prior
wearing this store's name.

**Keyword-only on purpose.** Seven fields, several of them numbers, is exactly
the shape where positional construction transposes two arguments and nothing
ever notices.

**`inputs` and `config_keys` fill themselves** — see §4.

### `StageResult` — the envelope

```python
@dataclass(frozen=True)
class StageResult(Generic[T]):
    ok: bool                  # False is a legitimate outcome, not an error
    value: T | None
    reasons: tuple[str, ...]
    provenance: Provenance
    stage: str
    stage_version: str
    duration_ms: int
```

**`ok=False` is a normal outcome.** "Not enough evidence to say anything about
this SKU" is a real answer and belongs in the same shape as a real value,
carrying reasons. Raising for it would push the decision into exception
handling, where it stops being data and starts being control flow.

`StageResult.failure()` **requires at least one reason.** A bare `ok=False` is
as unhelpful as a bare number: it says something did not happen without saying
what to do about it.

### `Setting` — rule 3 made real

```python
SHRINKAGE_K_SEASONAL = Setting(
    name="shrinkage.k.seasonal",
    default=12.0,
    unit="observations",
    owner="forecasting",
    why="provisional; to be fitted from holdout WAPE per pattern in wave 6",
    status="PROVISIONAL",        # PROVISIONAL | FITTED | MEASURED
)
```

Constructing a `Setting` **registers** it. That side effect is deliberate: a
threshold that exists but is not in the catalogue is invisible to
`cfg.report()`, which would defeat the entire purpose.

`unit`, `owner` and `why` are **mandatory and non-empty**. A threshold without
an owner and a stated reason is a magic number with extra steps.

`status` is what pays off later. Everything starts `PROVISIONAL` and is promoted
to `FITTED` only once wave 6 has measured it. At any moment you can ask how many
judgements in the system are still guesses — **a number the current engine
cannot produce at all**, which is why its 63 constants went unexamined for so
long.

---

## 4. Provenance fills itself

This is the mechanism that makes the contract hold in practice rather than in
principle.

```python
@stage("dead_stock", "1.0.0")
def dead_stock(payload, ctx):
    days = cfg.get(DEAD_STOCK_DAYS, ctx)     # ← records "dead_stock.days"
    record_input("items.last_sold_days_ago")  # ← records the feature key
    ...
    return StageResult.success(stale, Provenance(
        own_observations=len(items), own_weight=1.0,
        evidence_state="ESTABLISHED", inputs=("items.sku",),
    ))
```

The returned `Provenance` never mentions `dead_stock.days`. It appears anyway:

```python
result.provenance.config_keys  # ('dead_stock.days',)
result.provenance.inputs       # ('items.last_sold_days_ago', 'items.sku')
```

**How.** `@stage` opens a recording scope backed by a `ContextVar`.
`ConfigRegistry.get()` and `record_input()` write into whichever scope is active
in the current task. On return, the decorator **unions** what was recorded with
what the stage declared.

Union, not overwrite: a stage may legitimately name an input it read through a
path the recorder cannot see, and dropping it would make the provenance less
true, not more.

A `ContextVar` rather than a global because a bulk run fans out many stores
concurrently; asyncio tasks inherit context, so each stage's reads are
attributed to that stage even with thirty in flight.

Keys are stored **sorted and de-duplicated**, so two runs that read the same
keys in a different order produce byte-identical provenance. Replay compares
results for equality; incidental ordering would break it.

---

## 5. What `@stage` does, and what it refuses

```python
@stage("dead_stock", "1.0.0")
def dead_stock(value, ctx) -> StageResult: ...
```

1. **Times it** in whole milliseconds.
2. **Opens the recording scope**, then merges the reads into the provenance.
3. **Converts an escaped exception into `ok=False`** with the exception as a
   reason. One bad stage degrades its own output; it does not sink the run. The
   provenance on such a result is the most pessimistic reading possible
   (`0` observations, `0.0` weight, `NEW`) so a failure can never be mistaken
   for a well-evidenced answer.
4. **Refuses an unprovenanced result** — raises `ProvenanceError`. A programmer
   error, not a data outcome, so it raises rather than degrading. This check
   deliberately sits *outside* the exception handler, so a contract violation
   cannot be swallowed into the failure path it is meant to police.
5. **Refuses an `async` function**, at decoration time. A stage that needs to
   await something is a stage talking to the network or the database, which is
   precisely what `RunContext` exists to prevent.

### `replay(audit_row)`

```python
recorded = replay(row)                      # deserialise history
fresh    = replay(row, dead_stock, payload)  # re-execute and PROVE it matches
```

Three ways it refuses to give a false pass:

| Refusal | Why |
|---|---|
| `stage_version` on the row ≠ the code's | An old row against new code is a mismatch to **report**, not to paper over. |
| `input_digest` ≠ the supplied input | A replay fed the wrong input would otherwise "disagree" for the wrong reason. |
| value / reasons / **provenance** differ | Provenance is part of the answer, so it is part of the comparison. |

`duration_ms` is excluded from the comparison. Wall clock differs between two
runs of identical code by definition; including it would make every replay fail
and the check worthless.

A **config change reproduces as a difference, not a silent pass**: the registry
refuses to serve a stage whose `ctx.config_version` does not match. That looks
pedantic until a replay quietly resolves a threshold from today's config set,
produces a different number, and is believed. There is a test for exactly this.

---

## 6. The Node mirror

`backend/lib/stageEnvelope.js` is the **one** place Node turns a stage output
into an object. The alternative — every consumer picking fields out of the blob
it happens to receive — is how 454 and 485 happened in the first place.

**Field names are not translated.** The wire is snake_case, the analytics
columns are snake_case, so the parsed object is snake_case too. Renaming to
camelCase would be exactly the "bespoke adapter" this file exists to remove: a
second vocabulary to keep in sync, which nobody would, and which would drift
silently because both spellings look correct in isolation.

It **throws rather than coerces**. A stage output that does not match the
contract is a bug on the producing side; silently repairing it here means the
bug ships and is discovered much later, in a number nobody can explain. It
re-validates the same invariants Python does — `own_weight` within 0..1, known
`evidence_state`, no `cohort_size` without a `cohort_level`, `ok:false` must
carry reasons.

`as_of` **stays a string**. `new Date('2026-09-21')` is UTC midnight, which
renders as the 20th in any timezone behind UTC — the same class of bug that made
the daily-capture tables key on the store's own calendar date.

### The cross-language pin

`stage_result_golden.json` is **emitted by Python** and committed on **both**
sides. Python asserts it can still produce it; Node asserts it can still parse
it. If the shape ever drifts, both fail — rather than a tile quietly rendering
`undefined`.

---

## 7. Decisions and deviations

Three places where I did not do the literal thing, each with a reason.

### 7.1 The literal check ships with a baseline

The sheet says the check must fail the build on **any** float literal in
`app/pipeline/` or `storeagent/`. The prompt says **"purely additive — do not
modify any existing module."** Those conflict: `storeagent/` contains **49 float
literals across 13 files**, and you cannot remove them without editing
`storeagent/`.

Resolution: the 49 are recorded in `scripts/no_literals_baseline.json` (45
unique keys — some files repeat a value). **New violations fail.** The count is
printed on every run. `--update-baseline` **refuses to grow the list**.

`app/pipeline/` itself carries **zero** grandfathered entries and a test enforces
that it stays that way.

The worst offenders, for whoever burns this down:

| File | Literals |
|---|---:|
| `storeagent/canonical/size.py` | 14 |
| `storeagent/config.py` | 8 |
| `storeagent/functions/market.py` | 5 |
| `storeagent/functions/pricing.py` | 5 |

Burn-down: move each into `app/pipeline/registry.py` as a declared `Setting`,
delete its baseline entry, re-run. The `provisional_count` goes up, which is
correct — it was always a guess; now it is a *visible* guess.

**Baseline keys deliberately exclude the line number**, so adding an import
above a grandfathered constant does not read as a new violation. Otherwise the
baseline becomes noise and gets ignored.

### 7.2 A second rule the sheet implies but does not list

"Do not reintroduce" names `datetime.now()`, `date.today()`, `os.environ` and
**connection object**; done-when #1 says "no database, no network and no clock".
The checker enforces all of it inside `app/pipeline/`:

- **clock** — `datetime.now`, `datetime.utcnow`, `date.today`, `time.time`
- **environment** — `os.environ`, `os.getenv`
- **stochastic** — `random.*`, `uuid.uuid4`
- **database** — `psycopg.connect`, `psycopg2.connect`, `create_engine`,
  `app_conn`, `source_conn`
- **network** — `httpx.*`, `requests.*`, `urlopen`, `socket.socket`

Matching handles both `date.today()` and the fully-qualified
`datetime.datetime.now()` by checking the trailing pair of a dotted name.

Legacy `storeagent/` is in scope for the float rule only, until it is ported.
Applying the clock rule there today would block every commit.

### 7.3 CI

The Python project **had no test stage at all**. I added one, `when: manual` —
the only configured runner is the box's shell executor (tag `ec2`) and I have
not verified it has a Python toolchain. **Delete that one line once you have
checked.**

The guards bite locally regardless: the literal check and the ambient check are
*pytest tests*, so `pytest` enforces them whether or not CI runs.

### 7.4 Two smaller notes

- **`scripts/` and `fixtures.py` are beyond the four modules the prompt named.**
  `load_fixture` was required and needed a home; the scripts were required and
  `scripts/` did not exist. `pyproject.toml` already anticipated `scripts/*.py`
  in its ruff per-file ignores.
- **`config_report` currently prints `0 of 0`.** Correct: no *application*
  module declares a `Setting` yet. Real thresholds arrive with later sheets; the
  machinery and the CI hook are in place ahead of them.

---

## 8. Verification

```bash
# Python
cd Botella_External_APIs
./.venv/Scripts/python.exe -m pytest -q                      # 537 passed
./.venv/Scripts/python.exe -m pytest tests/test_pipeline_envelope.py tests/test_pipeline_guards.py -q
./.venv/Scripts/python.exe scripts/check_no_literals.py      # exit 0
./.venv/Scripts/python.exe scripts/check_no_literals.py --report   # the debt list
./.venv/Scripts/python.exe scripts/config_report.py          # PROVISIONAL count
./.venv/Scripts/python.exe -m ruff check app/pipeline scripts
./.venv/Scripts/python.exe -m mypy app/pipeline              # 0 errors

# Node
cd backend
node tests/stage-envelope-verify.js                          # 24 checks
```

### Done-when, one by one

| # | Criterion | Where it is proven |
|---|---|---|
| 1 | A stage runs from a JSON fixture with no database, no network and no clock | `test_a_stage_runs_from_a_json_fixture_alone`, plus the guard tests that make DB/network/clock reads a build failure |
| 2 | `replay(audit_row)` reproduces a past stage output exactly | `test_a_stage_replays_exactly_from_an_audit_row` — round-trips through JSON first, as it would from a jsonb column |
| 3 | A check fails the build on any float literal | `test_a_planted_float_is_caught_and_passes_once_removed` (+ §7.1 on the baseline) |
| 4 | `cfg.report()` lists every setting by status; CI prints the PROVISIONAL count | `test_report_groups_by_status_and_counts_provisional`, `test_cfg_print_report_prints_grouped_by_status`, `scripts/config_report.py` |
| 5 | `stageEnvelope.js` parses the same JSON shape | `backend/tests/stage-envelope-verify.js` against a Python-emitted golden row |

---

## 9. Writing a stage (the whole API)

```python
from app.pipeline import (
    Provenance, Setting, StageResult, cfg, record_input, stage,
)

DEAD_STOCK_DAYS = Setting(
    name="dead_stock.days", default=90, unit="days", owner="inventory",
    why="provisional; to be fitted from holdout WAPE in wave 6",
    status="PROVISIONAL",
)

@stage("dead_stock", "1.0.0")
def dead_stock(payload, ctx):
    days = cfg.get(DEAD_STOCK_DAYS, ctx)
    record_input("items.last_sold_days_ago")

    items = payload["items"]
    stale = sorted(i["sku"] for i in items if i["last_sold_days_ago"] >= days)

    if not stale:
        return StageResult.failure("no_dead_stock")

    return StageResult.success(stale, Provenance(
        own_observations=len(items),
        own_weight=1.0,
        evidence_state="ESTABLISHED",
        inputs=("items.sku",),
    ))
```

Run it, audit it, replay it:

```python
payload, ctx = load_fixture("dead_stock_basic")   # no DB, no network, no clock
result = dead_stock(payload, ctx)
row    = result.to_audit_row(ctx, stage_input=payload)   # persist this
replay(row, dead_stock, payload)                  # raises unless identical
```

### Rules for stage authors

1. Never read the clock, the environment, a connection or a random source. If
   you need it, it belongs in `RunContext`. **One clock read inside one stage
   destroys replay for every run that touches it, and it will not be noticed for
   months.**
2. Never write a bare float. Declare a `Setting`.
3. `ok=False` for "no answer", with a reason. Exceptions are for bugs.
4. Always state `own_observations`, `own_weight` and `evidence_state` honestly.
   A cohort-backed guess wearing `own_weight=1.0` is worse than no provenance.

---

## 10. Not done

- **`storeagent/`'s 49 literals are grandfathered, not migrated** (§7.1). This
  is the visible debt list the sheet's "63 constants" line is about.
- **The CI test stage is manual** until the runner's toolchain is confirmed
  (§7.3).
- **`evidence_state` has no classifier.** Sheet 00 defines the vocabulary so
  every stage uses the same words; where the boundaries between NEW / EMERGING /
  ESTABLISHED / MATURE fall is a threshold, and thresholds belong to wave 6.
- **No stage has been ported yet.** That is sheet 01 onward — this sheet only
  establishes what they will be written against.
