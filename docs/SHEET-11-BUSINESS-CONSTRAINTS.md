# Sheet 11 — Business constraints

**Status:** complete. **937 Python tests (+41), two build guards, ruff + mypy clean.**
**Depends on:** 03. **Wave:** 2 — deliberately early. **Value:** highest per day spent.

> The sheet header names `C:/Users/Techm/Downloads/external_api`, the stale
> August copy. All work is in `BottleAI-gitlab/Botella_External_APIs`.

---

## 1. Why this is scheduled early

A recommendation that says *"order 37"* when the supplier ships cases of twelve
is wrong in a way **no forecast improvement fixes**. Worse, it is wrong in a way
the owner reads as *the software does not understand my business* — a judgement
that is very hard to reverse.

It is cheap, independent of forecast quality, and removes a whole class of
visibly wrong output. So it lands in wave 2, not wave 4.

```
ideal    = 37.4 units      (sheet 10's policy)
feasible = 24              (2 cases of 12, capped by shelf 40)
reasons  = ["rounded up to 4 case pack(s) of 12 (48)",
            "capped at shelf capacity 40 -> 24"]
```

The **reasons travel with the number**. That is the difference between looking
wrong and looking careful.

---

## 2. What is actually available — measured, not assumed

Every figure below was re-verified against the warehouse for this sheet:

| Constraint | Source | Coverage | Status |
|---|---|---|---|
| Case pack | `products.pack_size` | **100%** of 911,022 rows | 380 distinct values, normalised |
| On hand | `products.stock_qty` | **100%** | usable directly |
| MOQ | `purchases.quantity` | **429,690 rows · 682 suppliers** | derived per supplier-SKU |
| Unit of measure | `products.uom` | **69.9%** non-empty | see §4 — it is *not* a pack count |
| Lead time | — | **absent** | declared assumption (sheet 10) |
| Shelf capacity | — | **absent** | owner input; recorded UNAVAILABLE |
| Budget | — | **absent** | owner input; recorded UNAVAILABLE |
| Promotion locks | — | **absent** | needs a promotions feed |
| Perishability | — | **absent** | per-category shelf life |

> The sheet quoted 910,935 product rows and 340,280 purchase rows. Today's
> counts are **911,022** and **429,690** — the tables have grown since the
> audit. Supplier count (682) and `uom` coverage (69.9%) match exactly.

---

## 3. The parser — 99.45% of rows, and the rest reported

`pack_size` is 100% populated and completely inconsistent. Measured shapes
across the 380 distinct values:

```
int          68   "1" (696,196 rows), "12", "24"
float        52   "12.0" (10,589), "6.0" (8,551), "24.0" (7,302)
num + text  219   "4 PK", "6-Pack", "1 BOTTLE" — and "-50", "0MG"
text only    35   "BAG", "BOTTLE", "CASE", "KEGS", "GIFT PACK"
single-word   6   "Single" (41,986), "SINGLE" (17,068), "EACH"
```

**Row-weighted result over all 911,022 product rows:**

| | rows | share |
|---|---:|---:|
| parsed to an integer | **905,966** | **99.45%** |
| refused with a reason | 5,056 | 0.55% |

The 5,056 refusals, itemised — none of them silently became a 1:

| reason | rows |
|---|---:|
| `pack_size_is_the_literal_string` (`"NULL"`) | 2,142 |
| `no_number_in_pack_size` | 1,418 |
| `container_word_without_a_count` (`"CASE"`, `"KEGS"`) | 1,160 |
| `pack_size_is_not_positive` (`"-6"`, `"0MG"`) | 336 |

**Defaulting to 1 is worse than failing.** A pack size of 1 silently *disables*
the constraint: every quantity rounds to itself and the recommendation goes out
at 37 when the supplier ships twelves. That is precisely the visibly-wrong
output this sheet exists to remove, reached by a default rather than by a bug.

Two refusals worth naming:

- **`"NULL"` is the four-character string**, 2,142 rows of it — not a null. It
  must not be mistaken for either a number or an absence.
- **`"CASE"` is a container word with no count.** A case is 6, 12 or 24
  depending on the product. Guessing 12 would be the silent default again.

### Where the constraint actually bites

| resulting pack | rows | share |
|---|---:|---:|
| 1 | 764,332 | 83.9% |
| 6 | 43,111 | 4.7% |
| 4 | 39,270 | 4.3% |
| 12 | 29,758 | 3.3% |
| 24 | 9,356 | 1.0% |
| **> 1 (binds)** | **141,634** | **15.5%** |

**141,634 products where "order 37" would be visibly wrong.** For the other
83.9% the constraint is correctly inert — and it is inert because it was
*parsed as 1*, not because parsing failed.

---

## 4. `uom` cannot validate the pack parse — a correction to the sheet

The sheet asks to "validate against uom where present (69.9% coverage)". The
coverage figure is exactly right. The validation is not possible.

**`uom` in this warehouse is container VOLUME, not units per case.** Its top
values are `750ML` (169,549), `0.0` (98,944), `750 ML`, `1.75L`, `375ML`,
`12OZ`. Knowing a bottle is 750ml says nothing about whether the case holds 6
or 12 of them.

So `uom` is used for the one thing it honestly can do: a volume-bearing `uom`
**confirms the row describes a single container** rather than an unlabelled
case. That fired on **504,808 rows (55.4%)**. Nothing more is claimed, and
`uom` never rescues an unparseable `pack_size`.

A real conflict found while checking this: sku `1002` carries
`pack_size="4 PK"` with `uom="6PK"`. Had `uom` been trusted as a pack source,
that row would have been ordered in sixes when the supplier ships fours.

---

## 5. MOQ uses the MODE, and the data says why

Derived per supplier-SKU from `purchases.quantity`. Measured over 20,000
supplier-SKUs with at least three purchases:

- all 20,000 produced a value;
- **5,352 of them (26.8%) have `min ≠ modal`.**

```
supplier    sku        n    min   modal
019b70b5-4  12702      5     4     12
019b70b5-4  12703      5     4      8
019b70b5-4  195971    10     4      8
019b70b5-4  196693     7     6     18
```

In over a quarter of cases the **minimum is far below the mode**. A single
small order — a sample, a partial delivery, a correction — would drag the MOQ
to 4 and effectively switch the constraint off. The mode is what this
supplier-SKU is *normally* bought in.

Both are reported, so a reader can see when they disagree. Thin history returns
`INSUFFICIENT_HISTORY` rather than a guessed floor, and improves as the 429,690
purchase rows accumulate.

---

## 6. The rule that matters most

**An unavailable constraint is recorded as UNAVAILABLE, never silently treated
as unbounded.** `shelf_capacity = None` means *we do not know*, **not**
infinity.

Four states, not two:

| state | meaning | can it bind? |
|---|---|---|
| `KNOWN` | we have a value | **yes** |
| `UNAVAILABLE` | the column does not exist in this warehouse | no |
| `UNPARSEABLE` | the source had data and we could not read it | no |
| `INSUFFICIENT_HISTORY` | derived, but too thin to trust yet | no |

`UNAVAILABLE` and `UNPARSEABLE` call for **different actions** — one needs a
product decision, the other needs a data fix — so collapsing them would lose
the only information that tells you which.

Every non-binding constraint lands in `not_applied` with its reason. Running
the real chain on store 171, **all 18 SKUs carried three of them** — `moq`,
`shelf_capacity`, `budget` — rather than silently skipping them:

```
shelf_capacity: unavailable (no planogram or shelf data in either database -
  owner input needed. This is NOT unlimited shelf space)
```

That is the difference between a system honest about its limits and one that
recommends 400 units into a shop with room for 40.

---

## 7. Application order, defined and tested

```
1. MOQ             raise to the supplier's minimum
2. case pack       round UP to a whole number of packs
3. shelf capacity  cap by what fits, then re-round DOWN to whole packs
4. budget          cap by spend, then re-round DOWN to whole packs
```

Caps come **after** rounding and force a re-round, because rounding up then
capping can leave a part-pack the supplier will not ship. Re-rounding down can
reach **zero**, and zero is a legitimate answer: *this does not fit and we are
not going to pretend otherwise*.

On **real products**, with the policy asking for 37.4:

| sku | pack_size | uom | stock | parsed | feasible | reason |
|---|---|---|---:|---:|---:|---|
| 207171 | `'6'` | — | 3 | 6 | **42** | rounded up to 7 packs of 6 |
| 46120 | `'6'` | 12OZ | 9 | 6 | **42** | rounded up to 7 packs of 6 |
| 1002 | `'4 PK'` | 6PK | 6 | 4 | **40** | rounded up to 10 packs of 4 |
| 541 | `'12'` | — | 5 | 12 | **48** | rounded up to 4 packs of 12 |

And the sheet's own example, once a shelf capacity exists:

> Order **24** rather than 37.4: rounded up to 4 case pack(s) of 12 (48);
> capped at shelf capacity 40 → 24.

> **One interpretation to confirm.** The sheet's example (37.4, pack 12,
> shelf 40 → 24) only reaches 24 if **existing stock counts against the
> shelf** — `room = shelf_capacity − on_hand`. With `on_hand = 0` the answer
> is 36. With 10–16 already on the shelf it is exactly 24. The implementation
> subtracts on-hand, which is what "capacity" normally means for a fixture,
> but it is an interpretation and worth a nod.

---

## 8. A floating-point trap closed

`ceil(36.0 / 12)` can land on `3.0000000000000004` after the preceding
divisions, and would then order a **fourth case of twelve for one unit of
dust**. The rounding carries an epsilon derived from `sys.float_info.epsilon`
rather than a hardcoded `1e-9` — it is a property of float arithmetic, not a
judgement about ordering, so it does not belong in the registry.

---

## 9. Files

| File | Lines | What |
|---|---:|---|
| `app/pipeline/constraints/normalise.py` | 220 | The pack-size parser |
| `app/pipeline/constraints/sources.py` | 190 | Availability states, MOQ derivation |
| `app/pipeline/constraints/apply.py` | 240 | Ordered application + reasons |
| `app/pipeline/constraints/__init__.py` | 45 | Public surface |
| `tests/test_constraints.py` | 290 | 41 tests |

---

## 10. Verification

```bash
cd Botella_External_APIs
./.venv/Scripts/python.exe -m pytest tests/test_constraints.py -q   # 41
./.venv/Scripts/python.exe -m pytest -q                             # 937
./.venv/Scripts/python.exe scripts/check_no_literals.py             # exit 0
./.venv/Scripts/python.exe -m mypy app/pipeline/                    # clean
```

| Sheet requirement | Proven by |
|---|---|
| 37.4 + pack 12 + shelf 40 → 24 with both reasons | `test_37_4_with_pack_12_and_shelf_40_gives_24_with_both_reasons` |
| Unparseable pack reports, never defaults to 1 | `test_unparseable_values_report_rather_than_defaulting_to_1` |
| Reasons travel with the number | `test_the_reasons_travel_with_the_number` |
| Unavailable ≠ unbounded | `test_an_unavailable_shelf_capacity_does_not_cap_and_is_recorded` |
| Unavailable ≠ insufficient history | `test_unavailable_and_insufficient_history_are_different_states` |
| MOQ uses the mode | `test_moq_uses_the_modal_order_quantity_not_the_minimum` |
| A cap re-rounds to whole packs | `test_a_cap_re_rounds_down_to_whole_packs` |

---

## 11. Not done

- **Nothing calls this in the live run.** The chain 03 → 07 → 10 → 11 runs on
  real data from an exported payload; wiring it into the daily job replaces
  `buying.py`'s quantities and is its own commit.
- **Shelf capacity, budget, promo locks and perishability are all still
  absent** — and every one is recorded as such on every recommendation rather
  than assumed away. Shelf capacity and budget are cheap to capture from the
  owner and would change output immediately.
- **MOQ is not joined to the recommendation path**: `purchases.supplier_id`
  links to a supplier, but nothing yet maps a store's candidate SKU to the
  supplier it would be bought from.
- **1 new setting, PROVISIONAL** (76 PROVISIONAL, 7 MEASURED overall).

---

## 12. The one-line summary

99.45% of 911,022 product rows now carry a parsed case pack, the 0.55% that do
not say why instead of quietly becoming 1, and the constraints that this
warehouse simply does not have are recorded as absent on every single
recommendation — because "we do not know how much shelf you have" and "you have
infinite shelf" are different sentences.
