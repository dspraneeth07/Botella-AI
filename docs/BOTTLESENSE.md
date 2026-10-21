# BottleSense

A new tab in the dashboard, built from the **BottleSense KPI & Data Reference**
(read-only research, August 2026).

---

## What the research actually found

BottleSense is an Apache Superset deployment over Bottlecapps' ecommerce
warehouse: **161 live KPI tiles, 425 charts, 133 datasets** across a 707-account
supplier panel. The research assigns every tile a verdict against Botella's
schema:

| Verdict | Meaning | Tiles |
|---|---|---|
| SKIP | Ad platform, clickstream, marketplace or Bottlecapps' own commercial model | **88** |
| TAKE | Botella has the equivalent source fields today | 31 |
| ADAPT | Good model, built for a multi-store panel; scope must change | 25 |
| NEEDS DATA | Requires customer identity at checkout | 17 |

**More than half of their estate is structurally unreachable**, and most of the
rest is ordinary — revenue, orders, quantity, AOV. So this screen does not copy
their tiles. It takes their measurement *engineering*.

### The asymmetry the screen is built around

The research searched all 133 datasets for a column matching
`/cost|margin|profit|purchase_price|landed|wholesale/` and found **two**, in
full:

```
view_tbl_bevstack.ShippingCost
tblbevstackraw_extended.ShippingCost
```

Both are shipping cost on marketplace order tables. Against **194**
price/amount/revenue-like columns.

> BottleSense can measure revenue in extraordinary detail — by store, brand,
> category, sub-category, size, varietal, hour, weekday, channel, order type and
> campaign. It cannot measure whether any of it made money.

Botella has `cost` on `sale_items`, `products` **and** `purchases`. Measured on
the audited tenant: **99.8% of revenue carries a cost price.** That is the moat,
and it is what this screen leads with.

---

## What the screen shows

Everything is one endpoint — `GET /api/bottlesense` — computed server-side from
a single as-of date.

### 1. Store health score, with a named driver
*Research item #1 — their best design idea.*

Their `CSPriorityScore` is paired with a `CSPriorityReason` ("Inactive –
Declining Trend", "New Store – Onboarding"). A score alone is not actionable; a
score plus a named cause is.

Ported to one store over time rather than across a portfolio, weighted on things
BottleSense has no column for:

| Driver | Weight | Scale |
|---|---|---|
| Gross margin | 25 | 15% floor → 30% target |
| Revenue trend | 20 | -20% → +10% |
| Shelf availability | 20 | 20% of movers out → 0% |
| Capital efficiency | 20 | 60% idle → 15% |
| Cost data coverage | 15 | 50% → 95% |

**The weights are published on the screen**, every driver shows its own score,
value and one-line reason, and the headline names the weakest one. The research
is blunt about this: *"Publish the weights; never ship a score without its
driver."*

### 2. Every level beside its previous window
*Research item #4 — "the cheapest fix for context-free KPIs."*

Revenue, orders, average basket and units, each rendered with the previous
equal-length window. There is no code path on this screen that shows a level
without its comparison.

### 3. Margin, with coverage published next to it
*Research item #6.*

The figure BottleSense cannot produce — and beside it, the share of revenue that
actually carries a cost. A 40% margin computed over 30% of revenue is not a 40%
margin, and the screen says which it is. Their equivalent habit is
`UnknownSourcePct` / `UnknownOrderTypePct`: coverage recorded *in the model*.

### 4. Trend classification, not a slope
*Research item #3.*

Every product sorted into **growing / stable / declining / dying** by comparing
its latest window against the one before. A product that sold before and has now
stopped completely is `dying`, not a -100% outlier buried among everything else
that fell. On the audited tenant: 594 growing, 206 stable, 286 declining, **339
dying**.

### 5. Nine-litre cases
*Research item #5.*

The liquor trade's standard volume unit, so beer, wine and spirits sit on one
scale — counting units does not, because a case of beer and a case of magnums
are not the same amount of drink.

`products.pack_size` and `products.uom` exist but are unpopulated on the audited
tenant (every row `pack_size='1'`, `uom='0.0'`), so size is parsed from the
product name. **The parse coverage is shown per category** and turns amber below
70%, because a case count derived from 34% of lines is not a case count.

### 6. Average days to return
*Research item #10 — the one customer metric the research says to build now.*

The average and median gap between one customer's visits. It sets the cadence
for contacting someone: a shopper who normally returns every 7 days and has not
been in for a month is not due, they are lapsing. Ships with its linkage
coverage.

### 7. Day part
*Research item #9.*

Revenue by weekday and hour. They materialise `Week_Day` and `Hour_By_CST` as
columns, which "removes a whole class of timezone bugs"; we derive them in one
place, server-side, so every consumer agrees.

---

## Three of their habits deliberately not copied

The research lists these, and the screen is built against them.

**1. No time bound.** Most of their 161 tiles render *all history* — a "top
products" tile ranks five years cumulatively, so something that stopped selling
in 2022 outranks a current seller. Every figure here carries an explicit window,
and the window is **printed in the header**.

**2. Hardcoded windows.** 28 of their charts pin a range typed at build time;
one SEO tile is bounded `2020-01-01 : 2021-01-01` and reports a five-year-old
number beside two live ones. Every window here is derived from the store's own
latest sale date — and deliberately *not* from `now()`, so a POS that stopped
syncing on Friday reports Friday rather than a week of zeroes that reads as a
collapse in trade.

**3. One name, several meanings.** "Total Orders" is computed independently in
sixteen of their datasets, "Total Stores" in twelve — two dashboards can
disagree and both be correct. Every metric here is defined once, in
`bottleSenseService.js`, and the whole screen renders from one call.

---

## Files

| File | What |
|---|---|
| `backend/services/bottleSenseService.js` | Every metric, defined once |
| `backend/routes/bottlesense.js` | `GET /api/bottlesense` |
| `frontend/src/components/BottleSenseScreen.js` / `.css` | The screen |
| `Sidebar.js`, `ChatPage.js`, `App.js` | The tab, the route, the view |

---

## Verified

Driven in a real browser against the live warehouse, **14/14**: the tab exists
and navigates, the score computes (52, "action"), the headline names the weakest
driver, all five drivers render with weights and reasons, all four levels carry
a comparison, coverage is published beside margin, products are classified into
four bands with 22 listed, twelve categories carry a nine-litre figure, the
day-part grid is complete at 168 cells, the window is stated on screen, and
nothing throws.

---

## Not built, and why

From the research's own shortlist:

- **Order-sequence cohorts** (#2) — first/second/third/fourth-plus order revenue.
  Buildable: this tenant has 100% customer linkage. Left out of the first cut
  because it deserves its own panel rather than a corner of this one.
- **Order-value decomposition** (#7) — subtotal, tax, delivery, tips, fees,
  three discount fields. `sale_items.discount` is unpopulated on every audited
  tenant, so the schema is worth adopting but the data is not there yet.
- **Derived sales from inventory deltas** (#8) — their `tblfinalinventory_batch_list_final`
  differences paired snapshots into `Quantity_Sold`, which lets a store be
  analysed *before* its POS is integrated. A genuine onboarding accelerator and
  the most technically interesting thing in their estate. Needs snapshot history
  Botella does not currently retain.
- **Peer benchmarking** (#11) — they already do it (`BenchmarkStoreCount`,
  `TierAlignmentFlag`). Botella's version could carry cost, which theirs cannot;
  that is the long-term moat, and it needs panel-shaped collection started early.

---

## One naming note

The tab is labelled **BottleSense**, as asked. That is the name of the
Bottlecapps product this research studied, not a Botella product — if this ships
to customers it will want a name of its own. Renaming it later is a one-line
change in `Sidebar.js` plus the route slug.
