# Sheet 17 — The gate

**Status:** complete. **1151 Python tests (+32), 12 Node suites, two build
guards, ruff + mypy clean.**
**Depends on:** 19 (see §9). **Wave:** 6. **Extends:**
`recommendationEvalService.js`, `recommendationService.js`.

---

## 1. Why this exists

**This is the sheet that would have prevented the 23% result from ever reaching
a customer.**

A recommendation family is shown at a store only once it has beaten a
volume-matched null **at that store**. Until then it runs in **shadow**:
computed, stored, scored, not displayed.

---

## 2. The finding: it was not "configuration rather than construction"

The sheet says the mechanism was built and never switched on, and that
switching it on is the highest-value change available today.

The first half is true. The second half was not, and the difference would have
cost a quarter.

### The holdout arm reshuffled on every run

```js
const isHoldout = holdoutPct > 0 && ((runId * 31 + r.rank) % 100) < holdoutPct;
```

`runId` is a **fresh serial on every run**. `rank` moves as the ranking moves.
So the same store-SKU landed in a different arm almost every day. Measured over
100 consecutive runs:

```
rank 1:  1* 32  63  94  25  56  87  18* 49  80  11* 42
         ↑ withheld       ↑ shown      ↑ withheld

rank 1 changed arm 39 times in 100 runs
```

A holdout measures what happens when a store is **not** told something. If the
same product is withheld on Monday, shown on Tuesday and withheld again on
Wednesday, **no outcome can be attributed to either arm**. Switching it on in
that state would have accumulated a quarter of noise and then reported that the
engine does not work — which is the same mistake the 23% backtest already made
once, for a different reason.

### The key is the thing being measured

An arm has to be stable for as long as the question is open, and the question
is *"does recommending **this product** to **this store** change anything"*. So
the key is exactly that, and nothing else:

```
client_id : location_id : sku : family
```

No run id (changes every run). No rank (changes with the ranking). No date (the
arm would flip daily by construction). **Family is included** because the gate
is per store *and* per family: a store can be live for reorder and still in
shadow for markdown, and the arms must be independent for that to mean
anything.

### And a real hash, not `* 31`

`(runId * 31 + rank) % 100` is an arithmetic progression, not a hash.
Consecutive ids land in a fixed stride of 31 buckets, so assignment was
*structured* and correlated with whatever else correlates with id order — for
us, the order stores were onboarded.

| | old key | new key |
|---|---|---|
| distinct strides over 50 consecutive keys | **1** | **>20** |
| arm changes in 100 runs | **39** | **0** |
| 10% holdout actually assigns | — | 9.6% |

FNV-1a over the key string, `Math.imul` to stay in 32-bit space (a plain `*`
promotes to a double past 2⁵³ and loses the low bits that carry the entropy).

### It is now on

`REC_HOLDOUT_PCT` defaults to **10** rather than 0. That is **the one change in
this sheet that alters what stores see**: one card in ten is withheld from the
owner so the other nine can be proven to do something. `REC_HOLDOUT_PCT=0`
turns it off, at the price of never knowing.

---

## 3. The gate itself

```
gate_state(store, family) -> shadow | live | suspended
```

| State | Meaning |
|---|---|
| `shadow` | computed, stored, scored, **not displayed**. The default for every new store-family pair. |
| `live` | beat the volume-matched null **at this store**, with ≥ N outcomes and p below the threshold. |
| `suspended` | **was** live, then fell below the null. Automatic and reversible. |

**`suspended` is deliberately not the same state as `shadow`.** Shadow means
"we have not learned anything yet"; suspended means "we learned something and
it stopped being true". They need different alerting and produce different
conversations — a store whose reorder family was live for three months and is
now suspended is a signal about that store, not a new store.

---

## 4. The null is volume-matched, and that is the whole point

A product selling 2 units a month and one selling 200 are **not comparable in
percentage terms**. The quiet one routinely doubles or halves on a single
basket; the busy one does not move 100% without something real happening.

Compare against the whole catalogue and the answer is decided by which side
happened to draw the quieter products — the comparison flatters or damns an arm
for a reason that has nothing to do with the recommendation.

So the null is drawn from the **same volume class, at the same store, over the
same window**. Everything that could explain the difference is held still
except the one thing being tested: whether we said something.

**An unmeasured rate is its own class**, not folded into the slowest one — "we
never measured this SKU" and "it sells almost nothing" are different facts, and
matching one against the other assumes the answer.

### A randomisation test, not a t-test

Lift distributions here are skewed, bounded below and fat-tailed at low volume
— none of which a t-test's assumptions survive. 400 matched baskets per
comparison, the number the original backtest used, so the gate and that
analysis stay comparable.

**The p-value can never be reported as zero.** With B draws the strongest claim
available is 1/(B+1), and the result carries its own `resolution` so a p of
0.0025 is not read as "vanishingly unlikely" when it is simply the floor.
Pretending to more precision than the simulation has is how a gate opens on
noise.

**Deterministic.** The draw is seeded from `ctx.seed` *and* `ctx.snapshot_id` —
never system entropy. Two runs over the same snapshot give byte-identical
p-values months apart; a *different* snapshot draws differently, so a re-run
over new data cannot reuse the old draw and look more stable than it is.

**No comparable products is a refusal, not a pass.** A comparison with nothing
to compare against is not a p-value of 1 — it is an absence of evidence, and
the two must not look alike to the gate.

---

## 5. A design bug my own test caught

The maintenance threshold defaulted to `0.5`, with the rule *"suspend a live
family whose p exceeds it"*. That condition was **unreachable**.

A roughly symmetric null puts p **below** 0.5 whenever the observed value is
above the null mean at all. So `beats_null && p > 0.5` can never both hold —
the check would only ever fire where the below-the-null check had already
fired, and the two conditions collapsed into one.

The fix is a proper **hysteresis band**: strong evidence to open, weaker
evidence to stay open, suspended when even the weaker bar fails.

```
p < 0.05   →  go live
p < 0.20   →  stay live
p ≥ 0.20   →  suspended (or below the null at all)
```

`test_the_maintenance_bar_sits_between_going_live_and_a_coin_flip` pins
`P_THRESHOLD < SUSPEND_P_THRESHOLD < 0.5` so this cannot silently regress.

Asymmetry is the point: symmetric thresholds would flap a family in and out of
view on noise, which reads to an owner as the system being broken.

---

## 6. A new store inherits, then earns

A store that opened last week has no outcomes of its own. Leaving it in shadow
until it accumulates N would mean **the newest stores — the ones with the least
of their own data, which sheet 06 exists to serve — get the least help for a
quarter**.

So it inherits its cohort's state until it has N outcomes of its own, and
switches to its own verdict the moment it does.

**Inheritance is not a free pass.** The cohort's state is only `live` if the
cohort actually proved it, so an unproven family is unproven everywhere. And a
new store can **contradict** its cohort once it has its own evidence:
inherited-live becomes shadow if its own outcomes say so.

---

## 7. Where each half lives

| | Python `app/pipeline/gate/` | Node |
|---|---|---|
| volume classes, matched null, p-value | ✅ | — |
| state transitions, cohort inheritance | ✅ | — |
| registry Settings, build guards | ✅ | — |
| the table, persistence, transitions report | — | ✅ |
| enforcement at serve time | — | ✅ |

Node **does not reimplement the transition rule**. A second implementation
would drift from the first and the estate would have two answers to "is this
family live" — the 454-vs-485 failure this programme exists to remove.

### Fail closed, and say so

A store-family with **no row is in shadow**. Not live. A gate that fails open
when its table is empty is not a gate — and the empty-table case is precisely
the state every store starts in, so failing open would mean it never did
anything at all. An unrecognised state is also shadow.

The one place it fails **open** is when the gate cannot be *read* at all (table
missing, query error): recommendations are served ungated and a warning is
logged. The difference is between *"we have not proven this"* and *"we could
not ask"*.

### Enforcement is off, on purpose

`REC_GATE_ENFORCED` defaults to `false`. The gate needs roughly a quarter of
accumulated outcomes before any family can go live; enforcing on day one would
show every store **nothing at all** — that is not a cautious rollout, it is an
outage.

The sequence is: **holdout on** (ships here) → **gate computed and visible**
(ships here) → **enforcement on** once families start going live. With
enforcement off, every recommendation still carries the `gate_state` it *would*
have had, so the gate can be watched before it is trusted.

Withheld recommendations are **returned with their reason**, never silently
dropped, and the explanation is owner-readable — a suspended family says it is
*paused while we re-measure*, not *still being measured*.

---

## 8. Files

| File | Lines | What |
|---|---:|---|
| `backend/lib/holdoutAssignment.js` | 110 | The stable key. The bug this sheet's step 1 was really about |
| `backend/services/familyGateService.js` | 220 | Read, persist, enforce |
| `backend/database/analytics-migrations/019_...sql` | 75 | The table, with a CHECK on the three states |
| `backend/services/recommendationService.js` | +45 | Stable assignment, holdout on, gate at serve time |
| `backend/tests/holdout-assignment-verify.js` | 140 | 14 checks, including the old key as a regression witness |
| `backend/tests/family-gate-verify.js` | 190 | 22 checks against the real database |
| `app/pipeline/gate/matched.py` | 230 | Volume classes, the matched null, the randomisation test |
| `app/pipeline/gate/state.py` | 290 | The three states, transitions, cohort inheritance |
| `tests/test_gate.py` | 390 | 32 tests |
| `scripts/check_no_literals.py` | +20 | Sequence defaults on a `Setting` |

---

## 9. Verification

```bash
cd backend
npm run migrate                              # 019
node tests/holdout-assignment-verify.js      # 14 — the arm does not move
node tests/family-gate-verify.js             # 22 — fail closed, transitions

cd ../Botella_External_APIs
./.venv/Scripts/python.exe -m pytest tests/test_gate.py -q   # 32
./.venv/Scripts/python.exe -m pytest -q                      # 1151
./.venv/Scripts/python.exe scripts/check_no_literals.py      # exit 0
```

| Sheet requirement | Proven by |
|---|---|
| Holdout assignment is stable across runs | `holdout-assignment-verify.js` 1–2 |
| A family below the null does not go live | `test_a_family_below_the_null_does_not_go_live` |
| A live family that drifts is suspended | `test_a_live_family_that_drifts_is_suspended` |
| A new store inherits, then transitions | `test_a_new_store_inherits_cohort_state_then_transitions` |
| Withheld recs are still computed and stored | `daily-snapshot-verify.js` 6, 6b |
| Both arms are scored identically | `test_the_holdout_arm_is_the_control_not_a_worse_recommendation` |
| The null is volume-matched | `test_the_null_is_drawn_from_the_same_class` |
| Suspension is reversible | `family-gate-verify.js` 20 |
| A missing row is never displayable | `family-gate-verify.js` 3–7 |

---

## 10. Not done

- **Sheet 19 is not built**, and this sheet's header lists it as a dependency.
  The gate takes outcomes and a null pool as **supplied inputs**, so it is
  complete and tested against them — but nothing yet assembles those inputs
  from `recommendation_evaluations` on a schedule. That job is the remaining
  connection, and it is a query plus a loop over `recordVerdict`.
- **Enforcement is off** (`REC_GATE_ENFORCED=false`) until families start going
  live. See §7 for why turning it on today would be an outage rather than a
  rollout.
- **No family is live anywhere yet**, and none can be for roughly a quarter —
  that is the cost of the mechanism having been switched off until now, and it
  is exactly why step 1 had to ship before the rest of wave 6.
- **The volume-class cut points are PROVISIONAL** and have not been fitted to
  the estate's actual distribution. The matching matters far more than the
  boundaries: what must not happen is a 2-a-month SKU being compared against a
  200-a-month one, and any reasonable partition prevents that.

---

## 11. The one-line summary

The holdout that was built and never switched on is now on — but only after
fixing the assignment key that reshuffled arms 39 times in 100 runs, which
would have turned a quarter of accumulated evidence into noise; and above it
sits a per-store, per-family gate that keeps a recommendation in shadow until
it has beaten a volume-matched null at that store, and suspends it again if it
stops.
