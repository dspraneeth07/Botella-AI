// Buying (forecast + reorder) - ported from views/Buying.tsx.
import { money, num, shortDate, titleFor } from '../format';
import { Badge, Pagination, Section, Stat, Table, Td, Th, usePaged, useSort } from '../ui';
import { ZeroMovementView } from './Inventory';
import { useState } from 'react';

// Which warehouse repo(s) fetched this view's data (for the per-component SQL
// icon). Buying/forecast figures come from the forecast and supplier repos.
const SRC = 'buying';

// Proof-of-trust texts - mirror storeagent/forecasting/* and functions/buying.py.
const INFO = {
  buyNow:
    "What to reorder now, and how much, so you don't run out before your next delivery. Only your fast sellers make this list (recently sold and in your store's top selling rates, or nearly out of stock) - slower products are deliberately left off. The dollar figure is the estimated cost of placing these orders (quantity × your supplier unit cost) - money you would spend, not revenue.",
  urgent:
    "These will likely sell out before your next order arrives. Prioritize them so you don't lose sales to empty shelves.",
  // Reworded when the Avg/day column was removed - the daily rate still drives
  // the estimate, it is just no longer a column. Original:
  // lost:
  //   'Money you are likely losing because proven sellers are sitting out of stock. Each row shows the selling pace behind the estimate: Avg/day comes from the last 90 days of sales (last year if quieter), and Revenue = Avg/day × days out of stock × price.',
  lost:
    'Money you are likely losing because proven sellers are sitting out of stock. The estimate uses each product\'s average daily sales over the last 90 days (last year if quieter): Revenue = that daily rate × days out of stock × price.',
  // Accelerating Demand section retired (kept for reuse) - see the commented
  // section in BuyingView below.
  // accelerating:
  //   "Products suddenly selling faster than their usual pace, with real volume behind them. Catch them early and restock before they sell out. Trend compares a product's recent pace to its own baseline over the days it has actually been on your shelf - so a brand-new listing is not counted as \"accelerating\" just for being new, and a product that has stopped selling drops off.",
  // No-Reorder Recommendations retired (kept for reuse) - see the commented
  // stat card and section in BuyingView below.
  // dontBuy:
  //   'Products to stop reordering, because they have stopped selling or you already have months of stock on hand. Each row explains why.',
};

// Reorder priority. Driven by the SAME `stockout_risk` flag the service sets
// (days of supply below the coverage window) - a binary, so there are exactly
// two levels here; do not invent intermediate tiers the backend can't back, or
// the table stops reconciling with `buy_urgent_count`.
// It renders in its OWN column: appended to the product name it was being cut
// off by the name cell's truncation whenever the name ran long.
function Priority({ atRisk }) {
  return atRisk ? <Badge tone="urgent">Urgent</Badge> : <Badge tone="default">Normal</Badge>;
}

export function BuyingView({ data, inventoryData }) {
  const b = data.buying;
  const lost = data.lost_sales;
  const buySort = useSort(b.buy_list);
  const buyPage = usePaged(buySort.sorted, 10);
  // No-Reorder Recommendations retired - hooks kept for reuse with the stat
  // card and section below.
  // const dontSort = useSort(b.dont_buy_list);
  // const dontPage = usePaged(dontSort.sorted, 10);
  // Accelerating Demand retired - hooks kept for reuse with the section below.
  // const accelSort = useSort(b.accelerating);
  // const accelPage = usePaged(accelSort.sorted, 10);
  const lostSort = useSort(lost.items);
  const lostPage = usePaged(lostSort.sorted, 10);
  const [activeSection, setActiveSection] = useState(() => {
    // Drill-down deep link: a dashboard KPI tile ("Reorder Needed", "Stocking
    // Upside", "Recommended Purchase") can name the section to land on, so the
    // click arrives pre-filtered to the relevant list. Read once, then cleared.
    try {
      const want = sessionStorage.getItem('botella_storeagent_section');
      if (want) {
        sessionStorage.removeItem('botella_storeagent_section');
        if (['reorder', 'lost', 'zero'].includes(want)) return want;
      }
    } catch {
      /* sessionStorage unavailable */
    }
    return b.buy_list.length ? 'reorder' : lost.items.length ? 'lost' : 'zero';
  });

  const sections = [
    { id: 'reorder', label: 'Suggested Reorder', count: b.buy_list.length, tone: 'good' },
    { id: 'lost', label: 'Lost Revenue', count: lost.items.length, tone: 'bad' },
    { id: 'zero', label: 'Zero Movement', count: inventoryData?.dead_stock?.items?.length || 0, tone: 'warn' },
  ];

  return (
    <div className="sa-stack">
      {/* sa-grid-2 (was sa-grid-3): two stats left after the No-Reorder card
          retired, so they fill the row instead of leaving an empty column. */}
      <div className="sa-grid-2">
        <Stat
          label="Recommended Purchase (Cost)"
          value={money(b.buy_total_value)}
          sub={`${num(b.buy_sku_count)} SKUs · ${num(b.buy_units_total)} units`}
          tone="good"
          info={INFO.buyNow}
          sql="buying.buy_total_value"
        />
        {/* No-Reorder Recommendations stat retired. Restore the sa-grid-3
            class on the wrapper above when bringing this back.
        <Stat
          label="No-Reorder Recommendations"
          value={num(b.dont_buy_units_total)}
          sub={`${num(b.dont_buy_sku_count)} SKUs · ${money(b.dont_buy_capital_tied)} cash locked`}
          tone="warn"
          info={INFO.dontBuy}
          sql="buying.dont_buy_units_total"
        />
        */}
        <Stat
          label="Daily Revenue Lost"
          value={money(lost.ongoing_daily_loss)}
          sub={`${num(lost.stockout_sku_count)} fast movers out of stock`}
          tone="warn"
          info={INFO.lost}
          sql="buying.ongoing_daily_loss"
        />
      </div>

      <div className="sa-buying-slider">
        <div className="sa-buying-tabs" role="tablist" aria-label="Buying report sections">
          {sections.map((section) => (
            <button
              key={section.id}
              type="button"
              role="tab"
              aria-selected={activeSection === section.id}
              className={`sa-buying-tab sa-buying-tab--${section.tone}${activeSection === section.id ? ' is-active' : ''}`}
              onClick={() => setActiveSection(section.id)}
              disabled={!section.count}
            >
              <span>{section.label}</span>
              <strong>{num(section.count)}</strong>
            </button>
          ))}
        </div>

      {activeSection === 'reorder' && b.buy_list.length > 0 && (
      <Section
        title="Suggested Reorder"
        hint={`Recommended quantities to cover demand until your next delivery.`}
        info={INFO.buyNow}
        sql="buying.buy_list"
      >
        <Table
          head={
            <>
              <Th>Product</Th>
              <Th sortKey="stockout_risk" sort={buySort.sort} onSort={buySort.onSort}>Priority</Th>
              <Th>Supplier</Th>
              <Th right sortKey="on_hand" sort={buySort.sort} onSort={buySort.onSort}>On hand</Th>
              <Th right sortKey="units_90" sort={buySort.sort} onSort={buySort.onSort}>90d sold</Th>
              <Th right sortKey="order_qty" sort={buySort.sort} onSort={buySort.onSort}>Order</Th>
              <Th right sortKey="order_value" sort={buySort.sort} onSort={buySort.onSort}>Value</Th>
              <Th sortKey="order_by" sort={buySort.sort} onSort={buySort.onSort}>Order by</Th>
            </>
          }
        >
          {buyPage.slice.map((r) => (
            <tr key={r.sku}>
              <Td className="sa-c-800">
                <div className="sa-truncate" style={{ maxWidth: 200 }}>
                  <span title={`${titleFor(r.product_name, r.sku)} · last sold ${shortDate(r.last_sold)}`}>
                    {titleFor(r.product_name, r.sku)}
                  </span>
                </div>
              </Td>
              <Td><Priority atRisk={r.stockout_risk} /></Td>
              <Td className="sa-c-600">
                {r.supplier || '-'}
                {r.reorder_cycle_days ? (
                  <span className="sa-text-xs sa-c-500" style={{ marginLeft: 4 }}>
                    ~{r.reorder_cycle_days}d
                  </span>
                ) : null}
              </Td>
              <Td right>{num(r.on_hand)}</Td>
              <Td right className="sa-c-600">
                {num(r.units_90)}
              </Td>
              <Td right className="sa-fw-600 sa-accent">
                {num(r.order_qty)}
              </Td>
              <Td right>{money(r.order_value)}</Td>
              <Td className="sa-c-600">{shortDate(r.order_by)}</Td>
            </tr>
          ))}
        </Table>
        <Pagination {...buyPage} onPage={buyPage.setPage} csvName="buy-now" />
      </Section>
      )}

      {/* Accelerating Demand retired from the Buying report. To bring it back,
          uncomment this block plus the accelSort/accelPage hooks and
          INFO.accelerating above.
      {b.accelerating.length === 0 ? (
      // An empty list is a finding, not a reason to hide the section. The two
      // causes read very differently to an owner: a store whose sales feed is
      // shorter than two 28-day windows CANNOT produce a trend (recent pace and
      // lifetime pace are the same number), which is a data problem to chase -
      // whereas a store with full history and nothing heating up is just a
      // quiet week. `accelerating_status` from functions/buying.py tells them
      // apart; older payloads without it fall back to the neutral wording.
      <Section
        title="Accelerating Demand"
        hint="Products whose recent pace has pulled ahead of their own baseline"
        info={INFO.accelerating}
        sql="buying.accelerating"
      >
        <div className="sa-p-8 sa-text-center">
          <div className="sa-text-lg sa-fw-600">
            {b.accelerating_status === 'insufficient_history'
              ? 'Not enough sales history yet'
              : 'Nothing is heating up right now'}
          </div>
          <p className="sa-mt-2 sa-text-sm sa-c-600" style={{ margin: '8px auto 0', maxWidth: 448 }}>
            {b.accelerating_status === 'insufficient_history'
              ? `This store has ${num(b.history_days)} days of sales history. Spotting a product that is speeding up means comparing its recent pace against an earlier one, so this needs roughly two months of sales before it can report anything.`
              : 'Every product is selling at about its usual pace. Nothing is pulling far enough ahead of its own baseline to be worth an early restock.'}
          </p>
        </div>
      </Section>
      ) : (
      <Section
        title="Accelerating Demand"
        hint={`${num(b.accelerating_count)} products selling faster than usual - restock before they run out`}
        info={INFO.accelerating}
        sql="buying.accelerating"
      >
        <Table
          head={
            <>
              <Th>Product</Th>
              <Th sortKey="stockout_risk" sort={accelSort.sort} onSort={accelSort.onSort}>Priority</Th>
              <Th>Supplier</Th>
              <Th right sortKey="units_28" sort={accelSort.sort} onSort={accelSort.onSort}>28d</Th>
              <Th right sortKey="units_90" sort={accelSort.sort} onSort={accelSort.onSort}>90d</Th>
              <Th right sortKey="units_365" sort={accelSort.sort} onSort={accelSort.onSort}>1y</Th>
              <Th right sortKey="trend" sort={accelSort.sort} onSort={accelSort.onSort}>Trend</Th>
              <Th right sortKey="proj_30d" sort={accelSort.sort} onSort={accelSort.onSort}>Proj. 30d</Th>
              <Th right sortKey="on_hand" sort={accelSort.sort} onSort={accelSort.onSort}>On hand</Th>
              <Th right sortKey="days_of_supply" sort={accelSort.sort} onSort={accelSort.onSort}>Supply</Th>
            </>
          }
        >
          {accelPage.slice.map((a) => (
            <tr key={a.sku}>
              <Td className="sa-c-800">
                <div className="sa-truncate" style={{ maxWidth: 200 }}>
                  <span title={titleFor(a.product_name, a.sku)}>{titleFor(a.product_name, a.sku)}</span>
                </div>
              </Td>
              <Td><Priority atRisk={a.stockout_risk} /></Td>
              <Td className="sa-c-600">{a.supplier || '-'}</Td>
              <Td right>{num(a.units_28)}</Td>
              <Td right className="sa-c-600">
                {num(a.units_90)}
              </Td>
              <Td right className="sa-c-600">
                {num(a.units_365)}
              </Td>
              <Td right className="sa-fw-600 sa-good">
                ×{a.trend}
              </Td>
              <Td right className="sa-fw-600 sa-accent">
                {a.proj_30d != null ? num(Math.round(a.proj_30d)) : '-'}
              </Td>
              <Td right>{num(a.on_hand)}</Td>
              <Td right className="sa-c-600">
                {a.days_of_supply !== null ? `${num(Math.round(a.days_of_supply))}d` : '-'}
              </Td>
            </tr>
          ))}
        </Table>
        <Pagination {...accelPage} onPage={accelPage.setPage} csvName="demand-heating-up" />
      </Section>
      )}
      */}

      {/* No-Reorder Recommendations retired from the Buying report. To bring it
          back, uncomment this block plus the dontSort/dontPage hooks, the stat
          card, and INFO.dontBuy above (and restore sa-grid-3).
      {b.dont_buy_list.length > 0 && (
      <Section
        title="No-Reorder Recommendations"
        hint={`recommended to stop ordering these products.`}
        info={INFO.dontBuy}
        sql="buying.dont_buy_list"
      >
        <Table
          head={
            <>
              <Th>Product</Th>
              <Th right sortKey="on_hand" sort={dontSort.sort} onSort={dontSort.onSort}>On hand</Th>
              <Th right sortKey="last_sold" sort={dontSort.sort} onSort={dontSort.onSort}>Last sold</Th>
              <Th right sortKey="last_bought" sort={dontSort.sort} onSort={dontSort.onSort}>Last bought</Th>
              <Th right sortKey="days_of_supply" sort={dontSort.sort} onSort={dontSort.onSort}>Supply</Th>
              <Th right sortKey="capital_tied" sort={dontSort.sort} onSort={dontSort.onSort}>Tied</Th>
            </>
          }
        >
          {dontPage.slice.map((r) => (
            <tr key={r.sku}>
              <Td className="sa-c-800">
                <div className="sa-truncate" style={{ maxWidth: 180 }}>
                  {titleFor(r.product_name, r.sku)}
                </div>
              </Td>
              <Td right>{num(r.on_hand)}</Td>
              <Td right className="sa-c-600">
                <span style={{ whiteSpace: 'nowrap' }}>
                  {shortDate(r.last_sold)}
                  {r.days_since_sold !== null && (
                    <span className="sa-c-400" style={{ display: 'block', fontSize: 10 }}>
                      {num(r.days_since_sold)}d ago
                    </span>
                  )}
                </span>
              </Td>
              <Td right className="sa-c-600">
                <span style={{ whiteSpace: 'nowrap' }}>
                  {shortDate(r.last_bought)}
                  {r.days_since_bought !== null && (
                    <span className="sa-c-400" style={{ display: 'block', fontSize: 10 }}>
                      {num(r.days_since_bought)}d ago
                    </span>
                  )}
                </span>
              </Td>
              <Td right className="sa-c-600">
                {r.days_of_supply !== null ? `${num(Math.round(r.days_of_supply))}d` : '-'}
              </Td>
              <Td right className="sa-fw-500 sa-warn">
                {money(r.capital_tied)}
              </Td>
            </tr>
          ))}
        </Table>
        <Pagination {...dontPage} onPage={dontPage.setPage} csvName="dont-buy" />
      </Section>
      )}
      */}

      {activeSection === 'lost' && lost.stockout_sku_count > 0 && (
      <Section
        title="Lost Revenue Opportunities"
        hint={`Estimated revenue impact of current stockouts: ${money(lost.lost_revenue_estimate)} (${money(lost.lost_margin_estimate)} in margin), based on each product's recent selling rate`}
        info={INFO.lost}
        sql="buying.lost_sales"
      >
            <Table
              head={
                <>
                  <Th>Product</Th>
                  <Th right sortKey="days_out" sort={lostSort.sort} onSort={lostSort.onSort}>Out</Th>
                  <Th right sortKey="units_30" sort={lostSort.sort} onSort={lostSort.onSort}>Last 30d</Th>
                  <Th right sortKey="units_90" sort={lostSort.sort} onSort={lostSort.onSort}>Last 90d</Th>
                  {/* Avg/day column retired - uncomment with its <Td> below.
                  <Th right sortKey="daily_rate" sort={lostSort.sort} onSort={lostSort.onSort}>Avg/day</Th>
                  */}
                  <Th right sortKey="lost_units" sort={lostSort.sort} onSort={lostSort.onSort}>Predicted units lost</Th>
                  <Th right sortKey="lost_revenue" sort={lostSort.sort} onSort={lostSort.onSort}>Revenue</Th>
                </>
              }
            >
              {lostPage.slice.map((r) => (
                <tr key={r.sku}>
                  <Td className="sa-c-800">
                    <div className="sa-truncate" style={{ maxWidth: 220 }}>
                      {titleFor(r.product_name, r.sku)}
                    </div>
                  </Td>
                  <Td right className="sa-c-600">
                    {num(r.days_out)}d
                  </Td>
                  <Td right className="sa-c-600">{num(r.units_30)}</Td>
                  <Td right className="sa-c-600">{num(r.units_90)}</Td>
                  {/* Avg/day cell retired - uncomment with its <Th> above.
                  <Td right className="sa-c-600">{r.daily_rate}</Td>
                  */}
                  <Td right>{Math.round(r.lost_units)}</Td>
                  <Td right className="sa-fw-500 sa-bad">
                    {money(r.lost_revenue)}
                  </Td>
                </tr>
              ))}
            </Table>
            <Pagination {...lostPage} onPage={lostPage.setPage} csvName="lost-sales" />
      </Section>
      )}

        {activeSection === 'zero' && inventoryData && <ZeroMovementView data={inventoryData} />}
        {!sections.find((section) => section.id === activeSection)?.count && (
          <div className="sa-buying-empty">Nothing needs attention here right now.</div>
        )}
      </div>

    </div>
  );
}
