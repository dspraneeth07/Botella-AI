# Sheet 10 — Inventory policy

**Status:** complete. **895 Python tests (+32), two build guards, ruff + mypy clean.**
**Depends on:** 07. **Wave:** 3. **Extends:** `storeagent/functions/buying.py` (untouched).

> The sheet header names `C:/Users/Techm/Downloads/external_api`, the stale
> August copy. All work is in `BottleAI-gitlab/Botella_External_APIs`.

---

## 1. Why this exists

A forecast is not a decision. Turning *"we expect 14 units over three weeks"*
into *"order 24"* needs a service-level target, a lead time and the demand
**variance**. Today `buying.py` does it with:

```python
safety = demand_cover * t.safety_buffer     # a flat 25%, every SKU
```

No service level. No σ. No lead-time scaling — a vendor who takes three weeks
and one who takes three days get the same buffer on the same SKU. Those are
assumptions wearing the shape of a parameter.

---

## 2. The formula, and what it replaces

```
safety_stock  = z(service_level) · σ_demand · √lead_time
reorder_point = μ_demand · lead_time + safety_stock
order_up_to   = reorder_point + review_period · μ_demand
ideal_qty     = order_up_to − on_hand − on_order
```

**Measured on 20 real SKUs from store 171**, same 21-day coverage window, safety
stock only — so this is method against method, not horizon against horizon:

| sku | class | rel. interval width | flat 25% | z·σ·√L | ratio |
|---|---|---:|---:|---:|---:|
| 080686007715 | smooth | 0.18 | 22.5 | **6.1** | 0.27 |
| 619947000037 | smooth | 0.42 | 20.0 | 12.7 | 0.63 |
| 080686001904 | erratic | 0.52 | 48.1 | 34.6 | 0.72 |
| 088004045456 | intermittent | 0.62 | 12.6 | 11.8 | 0.94 |
| 721059000505 | lumpy | 0.67 | 43.6 | 44.4 | 1.02 |
| 856065002400 | lumpy | 0.97 | 7.6 | 11.2 | 1.47 |
| 088004024086 | lumpy | 1.24 | 4.2 | **7.9** | 1.88 |

**The ratio rises monotonically with forecast width.** That is the whole sheet
in one column:

- The tightest forecast (rel-width 0.18) was carrying **3.7× more buffer than
  it needs** — 22.5 units of capital on one SKU to protect a forecast that is
  already precise.
- The widest (rel-width 1.24) was carrying **half what it needs**.

The flat buffer is proportional to **volume only**. It cannot see uncertainty,
so it systematically over-buffers the predictable and under-buffers the
unpredictable — exactly backwards. Across these SKUs the flat buffer varies
11.8× (volume alone); the policy varies 17.4× (volume **and** uncertainty).

---

## 3. σ comes from the interval — which is why sheet 07 had to return one

```python
sigma_horizon = (p90 - p10) / (z(0.90) - z(0.10))
```

The divisor is **computed** from the same quantile Settings sheet 07 used, not
written as `2.563`. If those levels ever change, every safety stock in the
estate follows rather than silently rescaling.

**A forecast without a usable interval is REFUSED.** Substituting a default σ
would produce a confident-looking quantity resting on a number nobody measured:

```
forecast_has_no_interval:refusing_to_substitute_a_default_sigma
no_forecast:cannot_size_an_order_without_one
interval_is_inverted:p10=40.000>p90=20.000
```

Two assumptions are named rather than hidden, and both err in the safe
direction:

- **Normality.** Sheet 07's intervals are bootstrap-derived and frequently
  skewed, especially for lumpy SKUs. Converting a skewed interval this way
  slightly *overstates* σ — erring toward holding stock rather than stocking
  out.
- **Independence across days.** σ over H days scaling as √H understates daily
  variance, because demand is autocorrelated. Same direction, opposite of
  dangerous.

---

## 4. Lead time is not in the warehouse — confirmed a fourth time

```
purchases        date, invoice_date, ... and ZERO columns matching
                 receive / deliver / arrive / lead
purchase_orders  po_date, invoice_date, due_date  — and 0 rows
```

Nothing in either database records when an order actually arrived. So lead time
is a **declared assumption**: `policy.lead_time_days.declared`, PROVISIONAL,
carried in `assumptions` and put on the card in the same sentence as the number:

> Order 9: enough to cover 7 days of delivery plus 7 days until the next order
> (1.0/day), with 5 spare for a 90% chance of not running out. **Assumes: a
> 7-day delivery lead time (declared, not measured — no receipt date exists in
> the data); ordering again in 7 days; nothing already on order (not recorded
> anywhere).**

The assumptions are in the *same sentence*, not a footnote. A quantity resting
on a declared lead time and one resting on a measured lead time look identical
once they are both integers.

A per-vendor override is accepted the moment anyone measures one, and supplying
it removes the caveat.

---

## 5. Service level is a business decision, seeded from measurement

Not one global number. A Setting **per category family**, every one PROVISIONAL
and every `why` containing **NEEDS COMMERCIAL SIGN-OFF**.

Seeded from 103,267 SKUs carrying both cost and revenue since 2026-01-01:

| family | SKUs | units | margin % | units/SKU | service level |
|---|---:|---:|---:|---:|---:|
| beer | 9,449 | 484,833 | 20.6 | **51.3** | **0.95** |
| spirits | 18,540 | 710,625 | **29.5** | 38.3 | 0.92 |
| default | 66,616 | 2,446,057 | 29.1 | 36.7 | 0.90 |
| wine | 6,111 | 110,266 | 27.5 | **18.0** | **0.85** |

Fast turnover means a stockout is noticed within days and costs repeat visits;
slow turnover means holding cost dominates. Wine turns at a third of beer's
rate — 95% service there would tie up capital for a year on a bottle that sells
four times. **That is the sheet's own mezcal example, measured.**

---

## 6. `on_order` is subtracted, and unknown is not zero

`buying.py` computes `target - on_hand` and never subtracts stock already on
its way, so a store that ordered yesterday orders the same quantity again
today. The policy subtracts it.

`purchase_orders` exists with **0 rows**, so nothing records outstanding
orders. `on_order=None` therefore means **unknown**, and it is recorded as an
assumption — distinct from `on_order=0.0`, which is a measurement. Same
arithmetic, different honesty; the `Number(null) === 0` lesson applied again.

---

## 7. z(p) without a constants table

`z_for` inverts the normal CDF by **bisection on `math.erf`**, which is in the
standard library. Acklam and Beasley-Springer-Moro carry twenty-odd published
float constants, and a wall of unexplained decimals is what `check_no_literals`
exists to keep out of this package. Bisection on a monotone function converges
to float precision with nothing to tune.

Verified against published values: z(0.85)=1.0364, z(0.90)=1.2816,
z(0.95)=1.6449, z(0.975)=1.9600, z(0.99)=2.3263 — all exact to 4 decimals.

---

## 8. What this stage deliberately does NOT do

Rounding to case packs, capping by shelf space and applying MOQ all belong to
**sheet 11**. Keeping them separate is exactly what lets the card explain why
37.4 became 24.

`test_the_ideal_quantity_is_not_rounded_capped_or_moq_adjusted` parses the
module's AST and fails on any call to `round`, `ceil` or `floor`, and on any
name containing `case_pack`, `moq` or `shelf_capacity`. Rounding here would
destroy the information sheet 11 needs to explain itself.

---

## 9. Files

| File | Lines | What |
|---|---:|---|
| `app/pipeline/policy/inventory.py` | 470 | The policy, z(p), σ from the interval |
| `app/pipeline/policy/__init__.py` | 40 | Public surface |
| `tests/test_policy.py` | 340 | 32 tests |

`storeagent/functions/buying.py` is **untouched** — 8 modules import it.

---

## 10. Verification

```bash
cd Botella_External_APIs
./.venv/Scripts/python.exe -m pytest tests/test_policy.py -q   # 32
./.venv/Scripts/python.exe -m pytest -q                        # 895
./.venv/Scripts/python.exe scripts/check_no_literals.py        # exit 0
./.venv/Scripts/python.exe -m mypy app/pipeline/               # clean
```

| Sheet requirement | Proven by |
|---|---|
| Higher service level → more safety stock | `test_a_higher_service_level_produces_more_safety_stock` |
| Wider interval → more safety stock | `test_a_wider_forecast_interval_produces_more_safety_stock` |
| Missing interval refuses, no default σ | `test_a_missing_interval_refuses_rather_than_defaulting_sigma` |
| `on_order` is subtracted | `test_on_order_is_subtracted` |
| Lead time declared, carried, surfaced | `test_the_declared_lead_time_travels_in_the_result_and_the_card` |
| Service level per category, none signed off | `test_every_family_has_its_own_setting_and_none_is_signed_off` |
| No rounding / capping / MOQ here | `test_the_ideal_quantity_is_not_rounded_capped_or_moq_adjusted` |

---

## 11. Not done

- **Nothing calls the policy in the live run.** `buying.py` still produces the
  quantities the engine ships; migrating its callers is a separate commit with
  a real blast radius, and sheet 11 has to land first so the ideal quantity
  becomes orderable.
- **No vendor supplies a measured lead time**, so every store gets the declared
  7 days and is told so.
- **`on_order` is always unknown** until a PO feed exists.
- **7 new settings, all PROVISIONAL** (75 PROVISIONAL, 7 MEASURED overall).
  The four service levels need commercial sign-off, not engineering
  refinement — they are business decisions parked in a place where somebody
  can find and change them.

---

## 12. The one-line summary

The buffer was a flat 25% of volume that could not see uncertainty; it now
scales with the forecast interval, the service level and the square root of the
lead time — and on real data it frees 3.7× of over-held capital on the most
predictable SKU while nearly doubling protection on the least.
