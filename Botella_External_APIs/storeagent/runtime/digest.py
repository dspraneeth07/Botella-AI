"""Templated Morning Briefing (no LLM).

Turns the deterministic function outputs into a one-page, dollar-quantified,
action-first briefing. This is the Phase-1 narration; the Claude narration layer
will later replace these templates with natural prose over the SAME numbers.
"""
from __future__ import annotations

from datetime import datetime


def _money(x: float | None) -> str:
    return f"${x:,.0f}" if x is not None else "n/a"


def build_briefing(store_label: str, vc: dict, ds: dict, fc: dict, sbp: dict,
                   ml: dict | None = None, generated_at: datetime | None = None) -> str:
    generated_at = generated_at or datetime.now()
    cls = vc["classes"]
    L: list[str] = []
    w = L.append

    w("=" * 66)
    w(f" MORNING BRIEFING - Store {store_label}")
    w(f" Data as of {vc['as_of']}   |   Generated {generated_at:%Y-%m-%d %H:%M}")
    w("=" * 66)

    w("\nCASH ON YOUR SHELVES")
    w(f"  Total inventory at cost : {_money(fc['total_inventory_value_at_cost'])}")
    w(f"  Frozen in DEAD stock    : {_money(fc['frozen_capital_dead'])}"
      f"  ({fc['frozen_pct_of_inventory']}% of inventory) - cash not moving")
    w(f"  Tied in SLOW/overstock  : {_money(fc['slow_capital'])}")

    w(f"\nHOW YOUR STOCK IS MOVING ({vc['total_skus']:,} SKUs)")
    w(f"  Fast {cls['fast']['sku_count']:>5}   Normal {cls['normal']['sku_count']:>5}   "
      f"Slow {cls['slow']['sku_count']:>5}   Dead {cls['dead']['sku_count']:>5}   "
      f"Never-sold {cls['never_sold']['sku_count']:>5}")

    # ds['items'] is already the actionable (non-premium) dead list.
    w(f"\nTOP DEAD STOCK - free this cash first  "
      f"({ds['actionable_sku_count']:,} liquidatable SKUs, "
      f"{_money(ds['actionable_frozen_capital'])} freeable; "
      f"{_money(ds['total_frozen_capital'])} dead total)")
    if ds["items"]:
        for i, it in enumerate(ds["items"][:5], 1):
            days = it["days_since_last_sale"]
            days_s = f"{days}d ago" if days is not None else "never sold"
            w(f"  {i}. {(it['product_name'] or it['sku'])[:48]}")
            w(f"     {it['on_hand']} on hand | {_money(it['frozen_capital'])} frozen | "
              f"last sold {days_s} | {it['category']}")
            w(f"     -> {it['suggested_action']}")
    else:
        w("  (no non-premium dead stock - clean)")

    if sbp["items"]:
        w(f"\nKEEP, DON'T DUMP - slow but premium ({_money(sbp['premium_slow_value_at_cost'])} at cost)")
        for i, it in enumerate(sbp["items"][:3], 1):
            m = f"{it['margin_pct']}% margin" if it["margin_pct"] is not None else "margin n/a"
            days = it["days_since_last_sale"]
            days_s = f"{days}d since sale" if days is not None else "never sold"
            w(f"  {i}. {(it['product_name'] or it['sku'])[:48]} - "
              f"{_money(it['price'])}, {m}, {days_s}")

    if ml:
        w(f"\nMONEY LEFT ON THE TABLE (last {ml['window_days']}d)  "
          f"~{_money(ml['recoverable_estimate'])} recoverable (high-confidence; "
          f"up to {_money(ml['recoverable_upper_bound'])} incl. uncertain markdowns)")
        w(f"  Discounts given         : {_money(ml['total_discount_given'])}  "
          f"(~{_money(ml['wasted_discount_estimate'])} likely WASTED on items "
          f"already selling well = {ml['wasted_discount_pct_of_total']}%)")
        w(f"  Sold below cost         : {ml['below_cost_lines']:,} sales, "
          f"{_money(ml['below_cost_loss'])} margin destroyed")
        if ml["priced_to_lose_sku_count"]:
            w(f"  Priced below cost (fix) : {ml['priced_to_lose_sku_count']} SKUs "
              f"are on the shelf priced to lose money")
        if ml["top_wasted_discounts"]:
            w("  Biggest wasted markdowns:")
            for it in ml["top_wasted_discounts"][:3]:
                w(f"    - {(it['product_name'] or it['sku'])[:44]} "
                  f"[{it['velocity_class']}] {_money(it['discount_given'])} given away")

    cc = fc["cost_coverage"]
    w("\nDATA HONESTY")
    w(f"  Cost basis: {cc['measured']:,} measured, {cc['imputed']:,} imputed, "
      f"{cc['unknown']:,} unknown.")
    if ds["unknown_cost_sku_count"]:
        w(f"  {ds['unknown_cost_sku_count']:,} dead SKUs have no known cost "
          f"({_money(ds['unknown_cost_retail_value'])} at retail) - excluded from frozen cash.")
    w("  Every figure is computed by deterministic functions over your sales ledger.")
    w("=" * 66)
    return "\n".join(L)


def build_buying_briefing(store_label: str, buy: dict, bt: dict, lost: dict | None = None,
                          generated_at: datetime | None = None) -> str:
    generated_at = generated_at or datetime.now()
    L: list[str] = []
    w = L.append
    w("=" * 66)
    w(f" PREDICTIVE BUYING - Store {store_label}")
    w(f" Data as of {buy['as_of']}   |   Generated {generated_at:%Y-%m-%d %H:%M}")
    w("=" * 66)

    acc = bt.get("accuracy_pct")
    w("\nFORECAST TRUST (walk-forward backtest, store-level daily demand)")
    if acc is not None:
        w(f"  Accuracy ~{acc}% (WAPE {bt['wape_pct']}%), bias {bt['bias_pct']:+}% "
          f"over {bt['test_days']} held-out days.")
    else:
        w("  Not enough history to backtest.")

    sa = buy.get("supplier_aware_sku_count", 0)
    cover_note = (f"per-supplier reorder cadence ({sa:,} SKUs) else "
                  f"lead {buy['lead_time_days']}d + review" if sa
                  else f"lead {buy['lead_time_days']}d + review")
    w(f"\nBUY NOW - cover until the next reorder ({cover_note})")
    w(f"  {buy['buy_sku_count']:,} SKUs to reorder, {_money(buy['buy_total_value'])} total; "
      f"{buy['buy_urgent_count']:,} at stockout risk before stock arrives.")
    for i, r in enumerate(buy["buy_list"][:8], 1):
        urgent = " [URGENT]" if r["stockout_risk"] else ""
        sup = f" | {r['supplier']}" if r.get("supplier") else ""
        cyc = f", reorder ~{r['reorder_cycle_days']}d" if r.get("reorder_cycle_days") else ""
        w(f"  {i}. {(r['product_name'] or r['sku'])[:42]:<42} order {r['order_qty']:>3} "
          f"({_money(r['order_value'])}) | {r['on_hand']} on hand, "
          f"~{r['forecast_units_coverage']:.0f} forecast | by {r['order_by']}{urgent}")
        if sup or cyc:
            w(f"     supplier: {(r.get('supplier') or 'unknown')}{cyc} "
              f"(cover {r['coverage_days']}d)")

    w(f"\nDON'T BUY - stop ordering ({buy['dont_buy_sku_count']:,} SKUs, "
      f"{_money(buy['dont_buy_capital_tied'])} already tied up)")
    for i, r in enumerate(buy["dont_buy_list"][:5], 1):
        dos = f"{r['days_of_supply']:.0f}d supply" if r["days_of_supply"] is not None else "no sales"
        w(f"  {i}. {(r['product_name'] or r['sku'])[:42]:<42} {r['on_hand']:>3} on hand, "
          f"{dos} -> {r['reason']}")

    if lost and lost["stockout_sku_count"]:
        w(f"\nLOST SALES - movers that are OUT OF STOCK right now "
          f"({lost['stockout_sku_count']:,} SKUs)")
        w(f"  Bleeding ~{_money(lost['ongoing_daily_loss'])}/day; "
          f"~{_money(lost['lost_revenue_estimate'])} revenue already missed "
          f"({_money(lost['lost_margin_estimate'])} margin).")
        for i, r in enumerate(lost["items"][:5], 1):
            w(f"  {i}. {(r['product_name'] or r['sku'])[:42]:<42} out {r['days_out']}d, "
              f"~{r['lost_units']:.0f} units lost ({_money(r['lost_revenue'])}) "
              f"@ {r['daily_rate']:.1f}/day")

    w("\nDATA HONESTY")
    w("  Demand model = avg units per weekday over last year x recent-trend factor.")
    w("  Buy qty covers lead+review demand + safety buffer, minus stock on hand.")
    if buy.get("supplier_aware_sku_count"):
        w("  Reorder window per SKU = its supplier's OBSERVED median restock cadence")
        w("  from the purchase ledger (no order->receive lead exists in the data).")
    w("  Accuracy is store-level; single-SKU forecasts are noisier (point estimates).")
    if lost and lost["stockout_sku_count"]:
        w("  Lost sales are INFERRED (no historical stock data): mover + currently out +")
        w("  stopped selling => est. lost = normal daily rate x days since last sale.")
    w("=" * 66)
    return "\n".join(L)


def build_market_briefing(store_label: str, mk: dict,
                          generated_at: datetime | None = None) -> str:
    generated_at = generated_at or datetime.now()
    L: list[str] = []
    w = L.append
    w("=" * 66)
    w(f" MARKET INTELLIGENCE - Store {store_label}")
    if mk.get("available"):
        w(f" Data as of {mk['as_of']}   |   Generated {generated_at:%Y-%m-%d %H:%M}")
    w("=" * 66)
    if not mk.get("available"):
        w(f"\n  Unavailable: {mk.get('reason')}.")
        w("=" * 66)
        return "\n".join(L)
    g = mk["geo"]
    where = f"{g.get('city')}, {g.get('state')}" if g else "?"
    w(f"\n{(g.get('location_name') if g else store_label)} - {where}")
    w(f"  Compared against {mk['peer_count']} stores in your state ({mk['peer_tier']}), last {mk['window_days']}d.")
    w(f"\nSTOCK THESE - selling well in your state, you don't carry them "
      f"({mk['opportunity_count']:,} found)  "
      f"~{_money(mk['total_projected_profit'])}/yr projected profit (top {len(mk['opportunities'])})")
    for i, o in enumerate(mk["opportunities"][:10], 1):
        w(f"  {i}. {(o['product_name'] or o['upc'])[:40]:<40} "
          f"~{_money(o['projected_annual_profit'])}/yr")
        w(f"     {o['peer_stores']} stores in your state sell it ({o['peer_units']:,} units) "
          f"@ ~{_money(o['avg_price'])} | est {o['est_annual_units']:,} units/yr x "
          f"{_money(o['est_unit_margin'])} margin ({o['margin_basis']})")
    w("\nDATA HONESTY")
    w("  Matched across stores by UPC (+ a name guard for different barcodes). Profit")
    w("  is CONSERVATIVE: peer per-store rate x 50% adoption x margin (peer cost or")
    w("  30% default). A demand estimate to test, not a guarantee.")
    w("=" * 66)
    return "\n".join(L)


def build_pricing_briefing(store_label: str, pr: dict,
                           generated_at: datetime | None = None) -> str:
    generated_at = generated_at or datetime.now()
    L: list[str] = []
    w = L.append
    w("=" * 66)
    w(f" PRICING & MARGIN OPTIMIZER - Store {store_label}")
    w(f" Data as of {pr['as_of']}   |   Generated {generated_at:%Y-%m-%d %H:%M}")
    w("=" * 66)
    w(f"\nRAISE PRICE - under-priced fast movers ({pr['raise_sku_count']:,} SKUs)  "
      f"~{_money(pr['est_annual_margin_upside'])}/yr extra margin if volume holds")
    for i, r in enumerate(pr["raise_list"][:8], 1):
        w(f"  {i}. {(r['product_name'] or r['sku'])[:40]:<40} "
          f"{_money(r['price'])} -> {_money(r['suggested_price'])} "
          f"({r['current_margin_pct']}%->{r['category_margin_pct']}% cat) "
          f"= +{_money(r['est_annual_upside'])}/yr")
    if pr["cut_list"]:
        w(f"\nCUT PRICE - over-priced slow movers ({pr['cut_sku_count']:,} SKUs, "
          f"{_money(pr['cut_frozen_capital'])} tied up)")
        for i, r in enumerate(pr["cut_list"][:5], 1):
            w(f"  {i}. {(r['product_name'] or r['sku'])[:40]:<40} "
              f"{_money(r['price'])} -> {_money(r['suggested_price'])} | {r['on_hand']} on hand")
    w("\nDATA HONESTY")
    w("  Target = your category's median margin. Raise upside = price delta x annual")
    w("  units at the CURRENT rate (assumes volume holds; capped at +20%).")
    w("=" * 66)
    return "\n".join(L)


def build_basket_briefing(store_label: str, b: dict,
                          generated_at: datetime | None = None) -> str:
    generated_at = generated_at or datetime.now()
    L: list[str] = []
    w = L.append
    w("=" * 66)
    w(f" BASKET & CROSS-SELL - Store {store_label}")
    if b.get("available"):
        w(f" Data as of {b['as_of']}   |   Generated {generated_at:%Y-%m-%d %H:%M}")
    w("=" * 66)
    if not b.get("available"):
        w(f"\n  Unavailable: {b.get('reason')}.")
        w("=" * 66)
        return "\n".join(L)
    w(f"\nBEST BUNDLE IDEAS - bought together far more than chance "
      f"(of {b['total_baskets']:,} baskets)")
    for i, p in enumerate(b["top_bundles"][:8], 1):
        w(f"  {i}. {(p['a_name'])[:26]:<26} + {(p['b_name'])[:26]:<26} "
          f"x{p['lift']} lift | {p['confidence_a_to_b']}% buy 2nd | {p['together_count']} times")
    w("\nMOST FREQUENT PAIRS")
    for i, p in enumerate(b["top_by_volume"][:4], 1):
        w(f"  {i}. {(p['a_name'])[:26]:<26} + {(p['b_name'])[:26]:<26} "
          f"{p['together_count']} times ({p['support_pct']}% of baskets)")
    w("\nDATA HONESTY")
    w("  lift>1 = sells together more than chance. Computed over the store's top")
    w("  movers in a recent window; 'confidence' = % of A baskets that also have B.")
    w("=" * 66)
    return "\n".join(L)


def build_overview_briefing(store_label: str, o: dict,
                            generated_at: datetime | None = None) -> str:
    generated_at = generated_at or datetime.now()
    L: list[str] = []
    w = L.append
    w("=" * 66)
    w(f" EXECUTIVE COMMAND CENTER - Store {store_label}")
    if o.get("available"):
        w(f" Data as of {o['as_of']}   |   Generated {generated_at:%Y-%m-%d %H:%M}")
    w("=" * 66)
    if not o.get("available"):
        w(f"\n  Unavailable: {o.get('reason')}.")
        w("=" * 66)
        return "\n".join(L)

    queue = o.get("action_queue") or []
    errs = o.get("engine_errors") or []
    w(f"\nDO THIS NEXT - prioritized across your whole business  "
      f"(~{_money(o.get('total_opportunity'))} on the table)")
    for a in queue:
        tag = "OPPORTUNITY" if a["severity"] == "opportunity" else "RISK"
        w(f"  {a['rank']}. [{tag}] {a['title']} - {_money(a['value'])} ({a['value_label']})")
        w(f"     -> {a['recommendation']}  [see: {a['capability']}]")
    if not queue:
        if errs:
            w("  (no actions surfaced - but engines FAILED below; this is NOT a clean run)")
        else:
            w("  (engines returned nothing actionable - clean run)")
    if errs:
        w(f"\nWARNING: {len(errs)} engine(s) failed - the queue above is PARTIAL")
        for e in errs:
            w(f"  - {e['engine']}: {e['error']}")

    an = o.get("anomalies") or {}
    if an.get("declining"):
        w("\nWHAT'S SLIDING - sellers losing steam (last 30d vs prior 30d)")
        for d in an["declining"][:4]:
            w(f"  - {(d['product_name'])[:40]:<40} {d['units_before']}->{d['units_now']} "
              f"units ({d['change_pct']:+.0f}%)")
    if an.get("surging"):
        w("\nWHAT'S HEATING UP - accelerating sellers")
        for s in an["surging"][:4]:
            w(f"  - {(s['product_name'])[:40]:<40} {s['units_before']}->{s['units_now']} "
              f"units ({s['change_pct']:+.0f}%)")

    pl = o.get("pulse") or {}
    mom = f"{pl['revenue_mom_pct']:+}%" if pl.get("revenue_mom_pct") is not None else "n/a"
    gm = f"{float(pl['gross_margin_pct']):.1f}%" if pl.get("gross_margin_pct") is not None else "n/a"
    w(f"\nPULSE: revenue {mom} MoM | margin {gm} | avg basket {_money(pl.get('avg_basket_value'))}")
    w("=" * 66)
    return "\n".join(L)


def build_shrinkage_briefing(store_label: str, sh: dict,
                             generated_at: datetime | None = None) -> str:
    generated_at = generated_at or datetime.now()
    L: list[str] = []
    w = L.append
    w("=" * 66)
    w(f" SHRINKAGE & STAFF INTEGRITY - Store {store_label}")
    if sh.get("available"):
        w(f" Data as of {sh['as_of']}   |   Generated {generated_at:%Y-%m-%d %H:%M}")
    w("=" * 66)
    if not sh.get("available"):
        w(f"\n  Unavailable: {sh.get('reason')}.")
        w("=" * 66)
        return "\n".join(L)
    c = sh["cashiers"]
    w(f"\nCASHIER WATCH ({c['team_size']} cashiers)")
    if c["flagged"]:
        w("  Above-norm void rates - worth a look:")
        for i, f in enumerate(c["flagged"][:5], 1):
            w(f"  {i}. {f['cashier'][:30]:<30} {f['void_rate_pct']}% voids "
              f"({f['voids']}/{f['sales']:,}), {_money(f['void_amount'])} voided, "
              f"{f['discount_pct']}% disc")
    else:
        w("  No cashier stands out above the team norm on voids.")
    sk = sh["shrinkage"]
    w(f"\nBOOK-vs-PHYSICAL SHRINKAGE  {sk['skus_flagged']:,} SKUs, "
      f"~{_money(sk['shrink_value'])} ({sk['units_unaccounted']:,} units unaccounted)")
    for i, it in enumerate(sk["items"][:5], 1):
        w(f"  {i}. {(it['product_name'] or it['sku'])[:38]:<38} "
          f"recv {it['received']} - sold {it['sold']} - {it['on_hand']} stock = "
          f"{it['units_unaccounted']} ({_money(it['shrink_value'])})")
    w("\nDATA HONESTY")
    w("  Shrinkage has no opening count - it flags SKUs whose receipts far exceed")
    w("  sales+stock (review, not proof). Voids/discounts are signals, watch trends.")
    w("=" * 66)
    return "\n".join(L)


def build_loss_briefing(store_label: str, loss: dict,
                        generated_at: datetime | None = None) -> str:
    generated_at = generated_at or datetime.now()
    L: list[str] = []
    w = L.append
    w("=" * 66)
    w(f" LOSS & THEFT RADAR - Store {store_label}")
    if loss.get("available"):
        w(f" Data as of {loss['as_of']}   |   Generated {generated_at:%Y-%m-%d %H:%M}")
    w("=" * 66)

    if not loss.get("available"):
        w(f"\n  Unavailable: {loss.get('reason')}.")
        w("=" * 66)
        return "\n".join(L)

    s = loss["signals"]
    w(f"\nTRANSACTIONS TO REVIEW (last {loss['window_days']}d)  "
      f"~{_money(loss['review_exposure'])} exposure across {loss['flagged_line_count']:,} lines")

    fg = s["free_giveaways"]
    w(f"\nRUNG UP AS ~FREE - real-priced items sold for ~$0 "
      f"({fg['lines']:,} lines, {fg['units']:,} units)")
    w(f"  ~{_money(fg['value_given_away'])} of shelf value given away "
      f"({fg['recent_lines']:,} in the last 90d) - possible sweethearting/register theft.")
    for i, it in enumerate(fg["items"][:5], 1):
        w(f"  {i}. {(it['product_name'] or it['sku'])[:44]:<44} "
          f"{it['units']} units @ {_money(it['price'])} = {_money(it['value_given_away'])} given")

    bc = s["below_cost"]
    if bc["lines"]:
        w(f"\nSOLD BELOW COST ({bc['lines']:,} lines, {_money(bc['margin_lost'])} margin destroyed)")
        for i, it in enumerate(bc["items"][:3], 1):
            w(f"  {i}. {(it['product_name'] or it['sku'])[:44]:<44} "
              f"{it['units']} units, {_money(it['margin_lost'])} lost")

    v = s["voids"]
    w(f"\nVOIDS / REVERSALS  {v['sales']:,} voided sales ({_money(v['amount'])}); "
      f"{v['recent_sales']:,} in the last 90d ({_money(v['recent_amount'])})")

    r = s["returns"]
    if r["lines"]:
        w(f"\nRETURNS  {r['lines']:,} negative-qty lines, {_money(r['amount'])} refunded")

    w("\nDATA HONESTY")
    w("  These are signals to REVIEW, not proof of theft. 'Given away' = shelf price x")
    w("  qty for items rung at <=$0.01. Voids are shown (not summed) - many are legit")
    w("  corrections; watch the trend and concentration by cashier/day.")
    w("=" * 66)
    return "\n".join(L)


def build_customer_briefing(store_label: str, radar: dict,
                            generated_at: datetime | None = None) -> str:
    generated_at = generated_at or datetime.now()
    L: list[str] = []
    w = L.append
    w("=" * 66)
    w(f" CUSTOMER WIN-BACK RADAR - Store {store_label}")
    w(f" Data as of {radar['as_of']}   |   Generated {generated_at:%Y-%m-%d %H:%M}")
    w("=" * 66)

    if not radar.get("available"):
        w("\n  Customer insights UNAVAILABLE for this store.")
        w(f"  Reason: {radar.get('reason')}.")
        w("  (We refuse to invent customer insights from non-CRM data.)")
        w("=" * 66)
        return "\n".join(L)

    seg = radar["segments"]
    w(f"\nYOUR CUSTOMER BASE ({radar['total_customers']:,} customers)")
    w("  " + "   ".join(f"{k}: {v:,}" for k, v in sorted(seg.items(),
        key=lambda kv: -kv[1])))

    w(f"\nWALKING OUT THE DOOR - regulars who broke their visit pattern "
      f"({radar['at_risk_count']:,} at risk)")
    w(f"  Repeat revenue at risk: ~{_money(radar['annual_revenue_at_risk'])}/yr")
    w("  Reach these first (highest value, recently lapsed):")
    for i, c in enumerate(radar["win_back"][:8], 1):
        fav = f" | likes {c['favorite_category']}" if c.get("favorite_category") else ""
        name = c["name"] or f"cust {c['customer_id'][:8]}"
        w(f"  {i}. {name[:26]:<26} {c['visits']:>3} visits, "
          f"~{_money(c['annual_value'])}/yr | last seen {c['days_since_last']}d ago "
          f"(usual gap {c['cadence_days']:.0f}d){fav}")

    w("\nTOP CUSTOMERS (by spend)")
    for i, c in enumerate(radar["top_customers"][:5], 1):
        name = c["name"] or f"cust {c['customer_id'][:8]}"
        flag = "  <- AT RISK" if c["at_risk"] else ""
        w(f"  {i}. {name[:26]:<26} {_money(c['spend'])} lifetime, "
          f"{c['visits']} visits{flag}")

    w("\nDATA HONESTY")
    w("  'At risk' = an established regular now past 2x their own visit gap AND lapsed")
    w("  within the last 180 days (recently winnable, not long-gone). Annual value")
    w("  floors the active span at 90 days to avoid over-extrapolation.")
    if radar.get("non_person_excluded"):
        w(f"  Excluded {radar['non_person_excluded']:,} non-person ids "
          f"(VISA CARDHOLDER, CASH, etc.) - not contactable people.")
    w("=" * 66)
    return "\n".join(L)
