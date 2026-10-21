// Market intelligence - ported from views/Market.tsx (TS+Tailwind -> JS+CSS).
import { money, num, titleFor } from '../format';
import { useState } from 'react';
import { Card, InfoTip, Pagination, Section, Stat, Table, Td, Th, usePaged, useSort } from '../ui';

// Which warehouse repo(s) fetched each component's data (for the per-component
// SQL icon). The entire market dataset is built by market_repo.
const SRC = 'market';

// Proof-of-trust texts - mirror storeagent/functions/market.py + source/market_repo.py.
const INFO = {
  upside:
    'Yearly revenue a typical nearby store rings up on products you do not carry yet - how much of it you could capture by stocking them. Estimated from peer selling rates and prices, deliberately discounted to be conservative.',
  marginLeft:
    'Extra margin you would have earned over the last 90 days by matching prices that sit well below what other stores in your state charge for the same product. Counts only the underperformers - products where the low price is not winning you volume either - since a low price that out-sells the typical peer store may be doing its job. Actual units sold x the price gap, no projections.',
  exposed:
    'Your last-90-day sales on products you price well above the state average AND sell slower than the typical peer store - the premium that appears to be costing you volume. The state figures cover the other stores in your state, not your own sales. Not money lost, but where you are exposed if shoppers compare prices.',
  assortment:
    'How much of what sells well across your state you actually carry. A read on your range, not a target, since some gaps are on purpose.',
  stockThese:
    "Products your state's stores sell the most of at strong prices that you do not carry, ranked by the yearly revenue they ring up at a typical nearby store. A ready-made list of what to consider stocking.",
  priceCheck:
    'How your prices compare with other stores in your state on the same products. State avg and State sold cover the OTHER stores in your state and never include your own sales, so you are always compared against the rest of the market. Obvious mismatches are dropped so you are comparing like for like.',
};

// Sell-through vs the typical peer store carrying the same product:
//   my_units ÷ (state units ÷ peer stores).
// >= 1 means you move at least as many units as the average store in your state
// does - i.e. your price is NOT costing you volume (this is the same index the
// head-to-head table ranks on). Newer service payloads compute this server-side
// (`sell_index`, market.py); the local formula covers older cached payloads.
const sellIndex = (x) =>
  x.sell_index != null
    ? x.sell_index
    : x.peer_stores > 0 && x.area_units > 0 ? x.my_units / (x.area_units / x.peer_stores) : null;
const performingWell = (x) => {
  const s = sellIndex(x);
  return s != null && s >= 1;
};

// One price-position sub-table. `variant` picks the money column that applies to
// that side: revenue-exposed for above-average prices, margin-left for below.
function SalesCompare({ product }) {
  const peerPerStore = product.peer_stores > 0 && product.area_units != null
    ? product.area_units / product.peer_stores
    : product.area_units;
  const index = sellIndex(product);
  const yourWidth = index == null ? 50 : Math.min(100, Math.max(8, index * 50));
  return (
    <div className="sa-price-sales">
      <div className="sa-price-sales-numbers">
        <strong>{num(product.my_units)}</strong>
        <span>you</span>
        <span className="sa-price-sales-vs">vs</span>
        <strong className="sa-c-600">{peerPerStore == null ? '-' : num(Math.round(peerPerStore))}</strong>
        <span>peer</span>
      </div>
      <div className="sa-price-sales-track" aria-label={`${num(product.my_units)} your sales versus ${peerPerStore == null ? 'unknown' : num(Math.round(peerPerStore))} peer sales`}>
        <span className={`sa-price-sales-fill ${index != null && index >= 1 ? 'is-winning' : 'is-losing'}`} style={{ width: `${yourWidth}%` }} />
        <i />
      </div>
    </div>
  );
}

function PricePositionTable({ variant, rows, sort, page, csvName }) {
  const isAbove = variant === 'above';
  return (
    <>
      <Table
        head={
          <>
            <Th>Product</Th>
            <Th sortKey="my_price" sort={sort.sort} onSort={sort.onSort} right>Your price</Th>
            <Th sortKey="area_price" sort={sort.sort} onSort={sort.onSort} right>Avg price</Th>
            <Th sortKey="diff_pct" sort={sort.sort} onSort={sort.onSort} right>Difference</Th>
            <Th right>Your sales / peer</Th>
            <Th sortKey={isAbove ? 'revenue_exposed_90d' : 'margin_left_90d'} sort={sort.sort} onSort={sort.onSort} right>
              Total value
            </Th>
          </>
        }
      >
        {page.slice.map((x) => {
          // The money column follows SELL-THROUGH, not which side of the state
          // average the price sits on: green where the price is working (moving
          // at least as many units as the typical peer store), red where it is
          // not. So a high price that still sells reads as upside, and a low
          // price that still does not sell reads as a problem.
          const well = performingWell(x);
          return (
          <tr key={`${variant}-${x.product_name}`}>
            <Td className="sa-truncate sa-c-800" style={{ maxWidth: 220 }}>{x.product_name}</Td>
            <Td right className="sa-fw-500 sa-c-900">{money(x.my_price, true)}</Td>
            <Td right className="sa-c-600">{money(x.area_price, true)}</Td>
            {/* Diff is always amber: it is the size of the gap from the state
                average - something to look at, not good or bad on its own. */}
            <Td right className="sa-fw-600 sa-warn">{isAbove ? '+' : ''}{x.diff_pct}%</Td>
            <Td right><SalesCompare product={x} /></Td>
            <Td right className={`sa-fw-500 ${well ? 'sa-good' : 'sa-bad'}`}>
              {isAbove ? money(x.revenue_exposed_90d) : `+${money(x.margin_left_90d)}`}
            </Td>
          </tr>
          );
        })}
      </Table>
      <Pagination {...page} onPage={page.setPage} csvName={csvName} />
    </>
  );
}

function PricePositionTabs({ above, below, aboveWellPage, abovePoorPage, belowWellPage, belowPoorPage, aboveWellSort, abovePoorSort, belowWellSort, belowPoorSort }) {
  const [level, setLevel] = useState('above');
  const [performance, setPerformance] = useState('well');
  const isAbove = level === 'above';
  const activeRows = isAbove
    ? (performance === 'well' ? aboveWellPage : abovePoorPage)
    : (performance === 'well' ? belowWellPage : belowPoorPage);
  const activeSort = isAbove
    ? (performance === 'well' ? aboveWellSort : abovePoorSort)
    : (performance === 'well' ? belowWellSort : belowPoorSort);
  const count = isAbove
    ? (performance === 'well' ? aboveWellPage.total : abovePoorPage.total)
    : (performance === 'well' ? belowWellPage.total : belowPoorPage.total);
  const total = isAbove ? above.length : below.length;
  const csvName = `priced-${level}-${performance === 'well' ? 'performing' : 'underperforming'}`;
  const labels = isAbove
    ? [['well', 'Making Extra Money', aboveWellPage.total], ['poor', 'Losing Sales Volume', abovePoorPage.total]]
    : [['well', 'Winning More Customers', belowWellPage.total], ['poor', 'Low Price But Not Selling', belowPoorPage.total]];
  return (
    <div className="sa-price-position">
      <div className="sa-price-levels" role="tablist" aria-label="Choose price position">
        <button type="button" className={isAbove ? 'is-active is-high' : ''} onClick={() => { setLevel('above'); setPerformance('well'); }}>
          <span>Priced Higher Than Market</span><strong>{above.length}</strong>
        </button>
        <button type="button" className={!isAbove ? 'is-active is-low' : ''} onClick={() => { setLevel('below'); setPerformance('well'); }}>
          <span>Priced Lower Than Market</span><strong>{below.length}</strong>
        </button>
      </div>
      <div className="sa-price-subtabs" role="tablist" aria-label="Choose sales result">
        {labels.map(([key, label, itemCount]) => (
          <button key={key} type="button" className={performance === key ? 'is-active' : ''} onClick={() => setPerformance(key)} disabled={!itemCount}>
            <span className={`sa-price-dot ${key === 'well' ? 'is-good' : 'is-bad'}`} />
            {label}<em>{itemCount}</em>
          </button>
        ))}
      </div>
      <div className="sa-price-caption">
        <strong>{count} products</strong>
        <span>{isAbove ? 'Your price is above the state average.' : 'Your price is below the state average.'}</span>
      </div>
      <PricePositionTable variant={level} sort={activeSort} page={activeRows} csvName={csvName} />
    </div>
  );
}

// Green/amber sub-heading above a performing / underperforming group, with a
// plain-language note on what put the products there.
function PerfSubhead({ label, note, tone }) {
  return (
    <div className={`sa-text-xs sa-fw-600 sa-upper ${tone} sa-mt-4`} style={{ marginBottom: 8 }}>
      {label}
      {note && <span className="sa-c-500 sa-fw-500" style={{ textTransform: 'none' }}> · {note}</span>}
    </div>
  );
}

export function MarketView({ data }) {
  const mk = data?.market;
  // Hooks must run on every render - before the availability early-return.
  const oppSort = useSort(mk?.opportunities ?? []);
  const oppPage = usePaged(oppSort.sorted, 10);
  // Each price-position side splits into products where the price is working
  // (selling at/above the typical peer store) and where it is not. (`above` /
  // `below` themselves are declared below, past the availability early-returns.)
  const aboveWell = (mk?.priced_above ?? []).filter(performingWell);
  const abovePoor = (mk?.priced_above ?? []).filter((x) => !performingWell(x));
  const belowWell = (mk?.priced_below ?? []).filter(performingWell);
  const belowPoor = (mk?.priced_below ?? []).filter((x) => !performingWell(x));
  const aboveWellSort = useSort(aboveWell);
  const aboveWellPage = usePaged(aboveWellSort.sorted, 8);
  const abovePoorSort = useSort(abovePoor);
  const abovePoorPage = usePaged(abovePoorSort.sorted, 8);
  const belowWellSort = useSort(belowWell);
  const belowWellPage = usePaged(belowWellSort.sorted, 8);
  const belowPoorSort = useSort(belowPoor);
  const belowPoorPage = usePaged(belowPoorSort.sorted, 8);
  if (!mk || !mk.available) {
    return (
      <Card className="sa-card--warn sa-p-8 sa-text-center">
        <div className="sa-text-lg sa-fw-600 sa-warn">Market intelligence unavailable</div>
        <p className="sa-mt-2 sa-text-sm sa-c-600" style={{ margin: '8px auto 0', maxWidth: 448 }}>
          {/* `mk?` matters: this branch is also the one taken when `market` is
              absent from the payload entirely (a capability that has not been
              computed yet). Reading mk.reason there threw, so the guard against
              a missing payload was itself what crashed the tab. */}
          {mk?.reason || 'This report has not been computed for your store yet.'}
        </p>
        <p className="sa-mt-2 sa-text-xs sa-c-500">
          Needs store geography on file and enough peer stores in your state.
        </p>
      </Card>
    );
  }
  // Available but nothing matched by barcode: a data-coverage problem, not a
  // saturated market. Say so instead of rendering $0 stat cards.
  if (mk.status === 'insufficient_data') {
    return (
      <Card className="sa-p-8 sa-text-center">
        <div className="sa-text-lg sa-fw-600">Not enough matchable market data yet</div>
        <p className="sa-mt-2 sa-text-sm sa-c-600" style={{ margin: '8px auto 0', maxWidth: 448 }}>
          Products selling at other stores in your state could not be matched to yours by
          barcode, so a fair comparison is not possible for this store yet.
        </p>
      </Card>
    );
  }
  // Full regional coverage: a win, framed as one (the old rendering showed a
  // $0.00 "Stocking Upside" card that read as a broken page).
  const saturated = mk.status === 'healthy';
  const opps = mk.opportunities || [];
  const above = mk.priced_above || [];
  const below = mk.priced_below || [];
  // Headline $ tiles cover ONLY the underperformers (the amber groups below):
  // where the price gap is demonstrably not costing volume, the money isn't
  // actionable. New payloads carry these server-side; the client fallback
  // recomputes BOTH figures from the lists for older cached payloads so the
  // tile always agrees with the visible group.
  const marginLeftVal = mk.priced_below_underperf_count != null
    ? mk.margin_left_total
    : belowPoor.reduce((s, x) => s + (x.margin_left_90d || 0), 0);
  const marginLeftCount = mk.priced_below_underperf_count ?? belowPoor.length;
  const exposedVal = mk.priced_above_underperf_count != null
    ? mk.revenue_exposed_total
    : abovePoor.reduce((s, x) => s + (x.revenue_exposed_90d || 0), 0);
  const exposedCount = mk.priced_above_underperf_count ?? abovePoor.length;

  return (
    <div className="sa-stack">
      <div className="sa-grid-stats">
        {saturated ? (
          <Stat
            label="Assortment Coverage"
            value={mk.assortment_coverage_pct != null ? `${mk.assortment_coverage_pct}%` : '100%'}
            sub="you already carry what sells in your state"
            tone="good"
            info={INFO.assortment}
            sql="market.regional_assortment"
          />
        ) : (
          <Stat
            label="Stocking Upside (Revenue potential)"
            value={money(mk.total_revenue_opportunity ?? mk.total_projected_profit)}
            sub={`${num(mk.opportunity_count)} products to add`}
            tone="good"
            info={INFO.upside}
            sql="market.opportunities"
          />
        )}
        <Stat
          label="Margin Left (Under-Priced)"
          value={money(marginLeftVal)}
          sub={`${num(marginLeftCount)} underperforming below your state`}
          tone="warn"
          info={INFO.marginLeft}
          sql="market.margin_left_total"
        />
        <Stat
          label="Revenue Exposed (Over-Priced)"
          value={money(exposedVal)}
          sub={`${num(exposedCount)} underperforming above your state`}
          tone="bad"
          info={INFO.exposed}
          sql="market.revenue_exposed_total"
        />
        <Stat
          label="Statewide Assortment"
          value={num(mk.carried_count)}
          sub={`of ${num(mk.regional_sku_count)} top SKUs in your state`}
          tone="accent"
          info={INFO.assortment}
          sql="market.regional_assortment"
        />
      </div>

      {opps.length > 0 && (
      <Section
        title="Stocking Opportunities"
        hint="Products that sell well in your state but you don't carry yet"
        info={INFO.stockThese}
        sql="market.opportunities"
      >
            <Table
              head={
                <>
                  <Th>Product</Th>
                  <Th sortKey="peer_units" sort={oppSort.sort} onSort={oppSort.onSort} right>State units (90d)</Th>
                  {/* "Stores selling" column retired - uncomment with its <Td> below.
                  <Th sortKey="peer_stores" sort={oppSort.sort} onSort={oppSort.onSort} right>Stores selling</Th>
                  */}
                  <Th sortKey="avg_price" sort={oppSort.sort} onSort={oppSort.onSort} right>Avg price</Th>
                  <Th sortKey="est_annual_units" sort={oppSort.sort} onSort={oppSort.onSort} right>Est units/yr</Th>
                  <Th sortKey="est_annual_revenue" sort={oppSort.sort} onSort={oppSort.onSort} right>Est revenue/yr</Th>
                </>
              }
            >
              {oppPage.slice.map((o) => (
                <tr key={o.upc}>
                  <Td className="sa-truncate sa-c-800" style={{ maxWidth: 220 }}>
                    {titleFor(o.product_name, o.upc)}
                  </Td>
                  <Td right className="sa-c-600">{num(o.peer_units)}</Td>
                  {/* "Stores selling" cell retired - uncomment with its <Th> above.
                  <Td right className="sa-c-600">{num(o.peer_stores)}</Td>
                  */}
                  <Td right className="sa-c-600">{money(o.avg_price, true)}</Td>
                  <Td right>{num(o.est_annual_units)}</Td>
                  <Td right className="sa-fw-600 sa-good">
                    {money(o.est_annual_revenue ?? o.est_annual_units * o.avg_price)}
                  </Td>
                </tr>
              ))}
            </Table>
            <Pagination {...oppPage} onPage={oppPage.setPage} csvName="stocking-opportunities" />
      </Section>
      )}

      {(above.length > 0 || below.length > 0) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <h3 className="sa-text-lg sa-fw-700" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
              Price Position
              <InfoTip text={INFO.priceCheck} />
            </h3>
            <p className="sa-section-hint" style={{ marginTop: 2 }}>
              Find the price gaps that help or hurt sales.
            </p>
          </div>

          <Section title="Price Position" sql="market.priced_above">
            <PricePositionTabs
              above={above}
              below={below}
              aboveWellPage={aboveWellPage}
              abovePoorPage={abovePoorPage}
              belowWellPage={belowWellPage}
              belowPoorPage={belowPoorPage}
              aboveWellSort={aboveWellSort}
              abovePoorSort={abovePoorSort}
              belowWellSort={belowWellSort}
              belowPoorSort={belowPoorSort}
            />
          </Section>
        </div>
      )}

    </div>
  );
}
