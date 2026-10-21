// Inventory (frozen capital, dead stock, money leaks) - ported from views/Inventory.tsx.
import { useState } from 'react';
import { money, num, pct, titleFor } from '../format';
import { Badge, Bar, Card, ComponentSql, Pagination, Section, Stat, Table, Td, Th, usePaged, useSort } from '../ui';

const CLASS_ORDER = ['fast', 'normal', 'slow', 'dead', 'never_sold'];
const CLASS_LABEL = {
  fast: 'Fast', normal: 'Normal', slow: 'Slow', dead: 'Dead', never_sold: 'Never sold',
};
const CLASS_TONE = {
  fast: 'good', normal: 'accent', slow: 'warn', dead: 'bad', never_sold: 'default',
};

// Which warehouse repo(s) fetched each component's data (for the per-component
// SQL icon). The inventory dataset is built by inventory_repo (+ sku_key);
// money-leaks comes from margin_repo.
// Section keys -> the verified reproduction query shown in the SQL icon (checkSql.js).
const DATASET = 'inventory';

// Proof-of-trust texts - these mirror the actual deterministic rules in
// storeagent/functions/inventory.py and margin.py. Update together.
const INFO = {
  inventory: 'The total money currently tied up in the stock on your shelves. If supplier costs are missing we value it at shelf price instead, and tell you with a banner.',
  frozen: 'Cash stuck in products that have stopped selling. This money stays locked on the shelf until you move, discount, or stop reordering these items.',
  slow: 'Money tied up in slow-moving or overstocked products. They still sell, just slowly, or you are holding far more than you are selling.',
  recoverable: 'Money you have likely lost to unnecessary markdowns and below-cost sales. These are the confirmed cases; anything uncertain is left out.',
  freeable: 'Cash you could realistically free up by clearing dead stock, ranked by what is worth the most. Premium bottles are left out, since those are worth holding.',
  classes: 'Your products grouped by how fast they sell, from fast movers to dead stock that has not sold in months. It shows at a glance where your money is working and where it is stuck.',
  leaks: 'Where you are quietly losing margin: mostly discounts on products that were already selling fine, plus items sold below cost. Worth a look to plug the leak.',
  deadTable: 'Products that have stopped selling, ranked by the cash they tie up, each with a faster-selling item to bundle them with. Premium bottles are excluded, since those are worth keeping.',
  brands: 'How much unsold and dead stock value sits with each brand. Helps you spot if too much of your frozen cash is concentrated in one supplier.',
};

export function InventoryView({ data }) {
  const fc = data.frozen_capital;
  const ds = data.dead_stock;
  const ml = data.money_leaks;
  const vc = data.velocity_classes;
  const bc = data.brand_concentration;
  // Selected analysis window (30/60/90) or null for the default analysis. The
  // SQL proof icons reproduce the DEFAULT analysis only, so hide them on
  // windowed views rather than show queries whose numbers won't match.
  const win = data.window_days || null;
  const sqlKey = (k) => (win ? null : k);
  const maxClass = Math.max(...CLASS_ORDER.map((c) => (vc.classes[c] ? vc.classes[c].sku_count : 0)));
  const brandFrozen = (b) =>
    fc.value_basis === 'cost' ? b.frozen_capital : b.frozen_retail;
  const maxBrand = Math.max(1, ...bc.top_frozen_brands.map(brandFrozen));
  // Velocity drill-down: click a class bar to list the products behind it.
  const [velClass, setVelClass] = useState(null);
  const velItems = (velClass && vc.classes[velClass]?.items) || [];
  const velSort = useSort(velItems);
  const velPage = usePaged(velSort.sorted, 8);
  const wastedSort = useSort(ml.top_wasted_discounts);
  const wastedPage = usePaged(wastedSort.sorted, 8);
  const brandSort = useSort(bc.top_frozen_brands);
  const brandPage = usePaged(brandSort.sorted, 8);

  // Some stores carry no supplier cost data; fall back to retail price (flagged).
  const atCost = fc.value_basis === 'cost';
  const basisLabel = atCost ? 'at cost' : 'at retail';
  // Only worth annotating a card when the basis is the RETAIL fallback - that's
  // a real data caveat (and banner-flagged below). "at cost" is the normal
  // basis, so spelling it out on every card was just noise.
  const basisNote = atCost ? null : basisLabel;
  const invVal = atCost ? fc.total_inventory_value_at_cost : fc.total_inventory_value_at_retail;
  const frozenVal = atCost ? fc.frozen_capital_dead : fc.frozen_capital_dead_retail;
  const slowVal = atCost ? fc.slow_capital : fc.slow_capital_retail;
  const freeable = atCost ? ds.actionable_frozen_capital : ds.actionable_frozen_retail;
  const hasDiscounts = ml.total_discount_given > 0;

  return (
    <div className="sa-stack">
      {!atCost && (
        <Card className="sa-card--warn sa-p-4 sa-text-sm sa-c-700">
          <span className="sa-fw-600 sa-warn">Showing values at retail price.</span>{' '}
          This store has no supplier cost data ({pct(fc.cost_coverage_pct)} cost coverage), so dollar
          figures use shelf price × quantity rather than cost.
        </Card>
      )}

      <div className="sa-grid-stats">
        <Stat label={`Inventory ${basisLabel}`} value={money(invVal)} sub={`${num(vc.total_skus)} SKUs`} info={INFO.inventory} sql={sqlKey('inventory.inventory_at_cost')} />
        <Stat
          label={`Frozen in zero-movement stock`}
          value={money(frozenVal)}
          sub={`${pct(fc.frozen_pct_of_inventory)} of inventory${basisNote ? ` · ${basisNote}` : ''}`}
          tone="bad"
          info={INFO.frozen}
          sql={sqlKey('inventory.frozen_dead')}
        />
        <Stat label={`Tied in slow / overstock`} value={money(slowVal)} sub={basisNote} tone="warn" info={INFO.slow} sql={sqlKey('inventory.slow_capital')} />
        <Stat
          label={hasDiscounts ? 'Recoverable leaks' : 'Freeable from dead stock'}
          value={money(hasDiscounts ? ml.recoverable_estimate : freeable)}
          sub={hasDiscounts
            ? `high-confidence, last ${ml.window_days}d · up to ${money(ml.recoverable_upper_bound)} incl. uncertain`
            : `${num(ds.actionable_sku_count)} SKUs`}
          tone="good"
          info={hasDiscounts ? INFO.recoverable : INFO.freeable}
          sql={sqlKey(hasDiscounts ? 'money_leaks.recoverable_estimate' : 'inventory.actionable_frozen_capital')}
        />
      </div>

      <div className="sa-grid-2">
        {vc.total_skus > 0 && (
        <Section title="Stock Velocity Breakdown" hint={`Your ${num(vc.total_skus)} products grouped by how fast they sell${win ? ` over the last ${win} days` : ''} · click a class to see its products`} info={INFO.classes} sql={sqlKey('inventory.velocity_classes')}>
          <div className="sa-stack-md">
            {CLASS_ORDER.map((c) => {
              const cl = vc.classes[c];
              if (!cl) return null;
              const active = velClass === c;
              return (
                <div
                  key={c}
                  className="sa-row"
                  role="button"
                  tabIndex={0}
                  aria-expanded={active}
                  onClick={() => setVelClass(active ? null : c)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setVelClass(active ? null : c); } }}
                  style={{ cursor: 'pointer', borderRadius: 8, padding: '2px 4px',
                           outline: active ? '1px solid var(--sa-ink-500)' : 'none',
                           background: active ? 'var(--sa-ink-900)' : 'transparent' }}
                >
                  <div className="sa-shrink-0" style={{ width: 96 }}>
                    <Badge tone={CLASS_TONE[c]}>{CLASS_LABEL[c]}</Badge>
                  </div>
                  <div className="sa-flex-1">
                    <Bar value={cl.sku_count} max={maxClass} tone={CLASS_TONE[c]} />
                  </div>
                  <div className="sa-shrink-0 sa-text-right sa-text-sm sa-num sa-c-700" style={{ width: 112 }}>
                    {num(cl.sku_count)} SKUs {active ? '▾' : '▸'}
                  </div>
                </div>
              );
            })}
          </div>
          {velClass && (
            <div className="sa-mt-4">
              <div className="sa-text-xs sa-fw-600 sa-upper sa-c-500" style={{ marginBottom: 8 }}>
                {CLASS_LABEL[velClass]} products
                {vc.classes[velClass].sku_count > velItems.length
                  ? ` · top ${num(velItems.length)} of ${num(vc.classes[velClass].sku_count)}`
                  : ` · ${num(velItems.length)}`}
                {['fast', 'normal'].includes(velClass) ? ' by 90-day units' : ` by value ${basisLabel}`}
              </div>
              <Table
                head={
                  <>
                    <Th>Product</Th>
                    <Th sortKey="on_hand" sort={velSort.sort} onSort={velSort.onSort} right>On hand</Th>
                    <Th sortKey="units_90" sort={velSort.sort} onSort={velSort.onSort} right>Sold 90d</Th>
                    <Th sortKey={atCost ? 'value_at_cost' : 'value_at_retail'} sort={velSort.sort} onSort={velSort.onSort} right>Value {basisLabel}</Th>
                    <Th sortKey="days_since_last_sale" sort={velSort.sort} onSort={velSort.onSort} right>Last sold</Th>
                  </>
                }
              >
                {velPage.slice.map((it) => (
                  <tr key={it.sku}>
                    <Td className="sa-truncate sa-c-800" style={{ maxWidth: 220 }}>
                      {titleFor(it.product_name, it.sku)}
                    </Td>
                    <Td right className="sa-c-600">{num(it.on_hand)}</Td>
                    <Td right className="sa-c-600">{num(it.units_90)}</Td>
                    <Td right className="sa-fw-500 sa-c-900">{money(atCost ? it.value_at_cost : it.value_at_retail)}</Td>
                    <Td right className="sa-c-600">
                      {it.days_since_last_sale != null ? `${num(it.days_since_last_sale)}d ago` : 'never'}
                    </Td>
                  </tr>
                ))}
              </Table>
              <Pagination {...velPage} onPage={velPage.setPage} csvName={`velocity-${velClass}`} />
            </div>
          )}
        </Section>
        )}

        {hasDiscounts && (
        <Section
          title="Recoverable Margin Leaks"
          info={INFO.leaks}
          hint={`${money(ml.wasted_discount_estimate)} in likely-wasted discounts · ${num(ml.below_cost_lines)} sales below cost`}
        >
              <div className="sa-grid-3" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
                <div style={{ borderRadius: 12, border: '1px solid rgba(5,150,105,0.2)', background: 'rgba(5,150,105,0.05)', padding: 12 }}>
                  <div className="sa-text-xs sa-upper sa-c-500">Confirmed waste <ComponentSql sql={sqlKey('money_leaks.elasticity_confirmed_waste')} label="Confirmed wasted markdowns" /></div>
                  <div className="sa-mt-1 sa-fw-700 sa-num sa-good" style={{ fontSize: 20 }}>
                    {money(ml.elasticity_confirmed_waste)}
                  </div>
                  <div className="sa-c-500" style={{ fontSize: 11 }}>markdowns that didn't move units</div>
                </div>
                <div style={{ borderRadius: 12, border: '1px solid rgba(217,119,6,0.2)', background: 'rgba(217,119,6,0.05)', padding: 12 }}>
                  <div className="sa-text-xs sa-upper sa-c-500">Uncertain <ComponentSql sql={sqlKey('money_leaks.elasticity_uncertain_waste')} label="Uncertain markdowns" /></div>
                  <div className="sa-mt-1 sa-fw-700 sa-num sa-warn" style={{ fontSize: 20 }}>
                    {money(ml.elasticity_uncertain_waste)}
                  </div>
                  <div className="sa-c-500" style={{ fontSize: 11 }}>discount may be load-bearing</div>
                </div>
              </div>
              <div className="sa-mt-4">
                <Table head={<><Th>Biggest wasted markdowns <ComponentSql sql={sqlKey('money_leaks.top_wasted_discounts')} label="Biggest wasted markdowns" /></Th><Th>Class</Th><Th right sortKey="discount_share_pct" sort={wastedSort.sort} onSort={wastedSort.onSort}>Share off</Th><Th right sortKey="discount_given" sort={wastedSort.sort} onSort={wastedSort.onSort}>Given away</Th></>}>
                  {wastedPage.slice.map((w) => (
                    <tr key={w.sku}>
                      <Td className="sa-truncate sa-c-800" style={{ maxWidth: 200 }}>{titleFor(w.product_name, w.sku)}</Td>
                      <Td><Badge tone={w.confidence}>{w.confidence}</Badge></Td>
                      <Td right>{pct(w.discount_share_pct)}</Td>
                      <Td right className="sa-fw-500 sa-bad">{money(w.discount_given)}</Td>
                    </tr>
                  ))}
                </Table>
                <Pagination {...wastedPage} onPage={wastedPage.setPage} csvName="wasted-markdowns" />
              </div>
        </Section>
        )}
      </div>

      <ZeroMovementView data={data} />

      {bc.top_frozen_brands.length > 0 && (
      <Section
        title="Brand Concentration"
        hint={`${num(bc.distinct_brands)} brands · where your tied-up cash is concentrated`}
        info={INFO.brands}
        sql={sqlKey('inventory.brand_concentration')}
      >
        <div className="sa-stack-sm" style={{ gap: 10 }}>
          {brandPage.slice.map((b) => (
            <div key={b.brand} className="sa-row">
              <div className="sa-shrink-0 sa-truncate sa-text-sm sa-c-800" style={{ width: 160 }}>{b.brand}</div>
              <div className="sa-flex-1"><Bar value={brandFrozen(b)} max={maxBrand} tone="bad" /></div>
              <div className="sa-shrink-0 sa-text-right sa-text-sm sa-num sa-bad" style={{ width: 96 }}>{money(brandFrozen(b))}</div>
              <div className="sa-shrink-0 sa-text-right sa-text-xs sa-num sa-c-500" style={{ width: 64 }}>{num(b.sku_count)} SKU</div>
            </div>
          ))}
        </div>
        <Pagination {...brandPage} onPage={brandPage.setPage} csvName="brand-concentration" />
      </Section>
      )}
    </div>
  );
}

// Zero Movement Report as a standalone view. The Inventory Intelligence tab is
// retired (see StoreAgentPanel.js) and this is the only section that survived:
// it now renders inside the Buying tab, still fed by the inventory capability's
// payload. InventoryView above also renders it, so reviving that tab won't
// duplicate code.
export function ZeroMovementView({ data }) {
  const fc = data.frozen_capital;
  const ds = data.dead_stock;
  const win = data.window_days || null;
  const sqlKey = (k) => (win ? null : k);
  const atCost = fc.value_basis === 'cost';
  const basisLabel = atCost ? 'at cost' : 'at retail';
  const freeable = atCost ? ds.actionable_frozen_capital : ds.actionable_frozen_retail;
  const deadSort = useSort(ds.items);
  const deadPage = usePaged(deadSort.sorted, 10);

  if (ds.items.length === 0) return null;
  return (
      <Section
        title="Zero Movement Report"
        hint={`Stock with no sales in ${win ? `the last ${win} days` : 'over 180 days'}, worth clearing first · ${num(ds.actionable_sku_count)} products · ${money(freeable)} tied up ${basisLabel}`}
        info={INFO.deadTable}
        sql={sqlKey('inventory.dead_stock')}
      >
        <Table head={<><Th>Product</Th><Th>Category</Th><Th right sortKey="on_hand" sort={deadSort.sort} onSort={deadSort.onSort}>On hand</Th><Th right sortKey={atCost ? 'frozen_capital' : 'frozen_capital_retail'} sort={deadSort.sort} onSort={deadSort.onSort}>Frozen</Th><Th right sortKey="days_since_last_sale" sort={deadSort.sort} onSort={deadSort.onSort}>Last sold</Th><Th>Bundle with (a fast mover)</Th></>}>
          {deadPage.slice.map((it) => (
            <tr key={it.sku}>
              <Td className="sa-truncate sa-c-800" style={{ maxWidth: 220 }}>{titleFor(it.product_name, it.sku)}</Td>
              <Td className="sa-c-600">{it.category}</Td>
              <Td right>{num(it.on_hand)}</Td>
              <Td right className="sa-fw-500 sa-bad">{money(atCost ? it.frozen_capital : it.frozen_capital_retail)}</Td>
              <Td right className="sa-c-600">{it.days_since_last_sale === null ? 'never' : `${num(it.days_since_last_sale)}d`}</Td>
              <Td style={{ maxWidth: 260 }}>
                {it.bundle_with ? (
                  <span className="sa-truncate sa-c-800">
                    <span className="sa-accent">↳</span> {titleFor(it.bundle_with.product_name, it.bundle_with.sku)}
                    <span className="sa-text-xs sa-c-500" style={{ marginLeft: 4 }}>fast {it.bundle_with.category}</span>
                  </span>
                ) : (
                  <span className="sa-text-xs sa-c-500">Liquidate / clear - low value</span>
                )}
              </Td>
            </tr>
          ))}
        </Table>
        <Pagination {...deadPage} onPage={deadPage.setPage} csvName="dead-stock" />
      </Section>
  );
}
