// Basket (affinity / bundle ideas) - ported from views/Basket.tsx.
import { num } from '../format';
import { Card, Pagination, Section, Stat, Table, Td, Th, usePaged, useSort } from '../ui';

// Which warehouse repo(s) fetched this view's data (for the per-component SQL
// icon). The whole basket dataset is built by basket_repo.
const SRC = 'basket';

// Proof-of-trust texts - mirror storeagent/functions/basket.py.
const INFO = {
  baskets:
    'How many shopping trips this period included more than one item. These are the trips that reveal what your customers like to buy together.',
  pairs:
    'The number of product combinations your customers actually buy together. Each one is a chance to bundle, cross-sell, or place items side by side.',
  lift:
    'Product pairs your customers reliably buy together, far more often than chance. Put them side by side, bundle them, or cross-sell one at the register to grow basket size.',
  volume:
    'Your most common product combinations, ranked by how often they sell together. The pairs at the top are everyday staples worth keeping stocked and close to each other.',
};

export function BasketView({ data }) {
  const b = data.basket;
  // Hooks must run on every render - before the availability early-return.
  const bundleSort = useSort(b.top_bundles ?? []);
  const bundlePage = usePaged(bundleSort.sorted, 10);
  const volumeSort = useSort(b.top_by_volume ?? []);
  const volumePage = usePaged(volumeSort.sorted, 10);
  if (!b.available) {
    return (
      <Card className="sa-card--warn sa-p-8 sa-text-center">
        <div className="sa-text-lg sa-fw-600 sa-warn">Basket analysis unavailable</div>
        <p className="sa-mt-2 sa-text-sm sa-c-600">{b.reason}</p>
      </Card>
    );
  }
  const bundles = b.top_bundles || [];
  // Enough traffic, but no product pair repeats often enough to trust. That is
  // a finding about how the store sells, not an error, so say what it means.
  if (bundles.length === 0 && (b.top_by_volume || []).length === 0) {
    return (
      <Card className="sa-p-8 sa-text-center">
        <div className="sa-text-lg sa-fw-600">No recurring co-purchase patterns</div>
        <p className="sa-mt-2 sa-text-sm sa-c-600" style={{ margin: '8px auto 0', maxWidth: 448 }}>
          Across {num(b.total_baskets)} transactions in the last {num(b.window_days)} days, no
          product pair sold together often enough to trust as a bundle.
        </p>
        {b.single_item_pct != null && (
          <p className="sa-mt-2 sa-text-sm sa-c-600" style={{ margin: '8px auto 0', maxWidth: 448 }}>
            {b.single_item_pct}% of those trips were single-item. Counter displays, chilled
            mixers by the register, and simple multi-buy deals are the usual ways to lift that.
          </p>
        )}
      </Card>
    );
  }

  return (
    <div className="sa-stack">
      <div className="sa-grid-3">
        <Stat
          label="Baskets Analyzed (Non-Void Only)"
          value={num(b.total_baskets)}
          sub={`last ${num(b.window_days)}d${b.single_item_pct != null ? ` · ${b.single_item_pct}% single-item` : ''}`}
          info={INFO.baskets}
          sql="basket.total_baskets"
        />
        <Stat label="Co-Purchase Pairs Found" value={num(b.pairs_analyzed)} tone="accent" info={INFO.pairs} sql="basket.pairs_analyzed" />
        <Stat label="High-Affinity Bundles" value={num(bundles.length)} sub="pairing strength > 1.2×" tone="good" info={INFO.lift} sql="basket.strong_bundle_count" />
      </div>

      {bundles.length > 0 && (
      <Section
        title="Top Bundle Opportunities"
        hint="Products bought together far more often than chance - your strongest pairings to bundle or cross-sell"
        info={INFO.lift}
        sql="basket.top_bundles"
      >
        <Table head={<><Th>Pair</Th><Th right sortKey="lift" sort={bundleSort.sort} onSort={bundleSort.onSort}>Pairing strength</Th><Th right sortKey="confidence_a_to_b" sort={bundleSort.sort} onSort={bundleSort.onSort}>Buy 2nd</Th><Th right sortKey="together_count" sort={bundleSort.sort} onSort={bundleSort.onSort}>Together</Th></>}>
          {bundlePage.slice.map((p) => (
            <tr key={`${p.a_sku}-${p.b_sku}`}>
              <Td className="sa-c-800">
                <span className="sa-fw-500">{p.a_name}</span>
                <span className="sa-accent" style={{ margin: '0 6px' }}>+</span>
                <span className="sa-fw-500">{p.b_name}</span>
              </Td>
              <Td right className="sa-fw-600 sa-good">×{p.lift}</Td>
              <Td right className="sa-c-600">{p.confidence_a_to_b}%</Td>
              <Td right className="sa-c-600">{num(p.together_count)}</Td>
            </tr>
          ))}
        </Table>
        <Pagination {...bundlePage} onPage={bundlePage.setPage} csvName="best-bundle-ideas" />
      </Section>
      )}

      {(b.top_by_volume || []).length > 0 && (
      <Section title="Most Frequent Co-Purchases" hint="The product pairs your customers buy together most often" info={INFO.volume} sql="basket.top_by_volume">
        <Table head={<><Th>Pair</Th><Th right sortKey="together_count" sort={volumeSort.sort} onSort={volumeSort.onSort}>Together</Th><Th right sortKey="support_pct" sort={volumeSort.sort} onSort={volumeSort.onSort}>% of baskets</Th></>}>
          {volumePage.slice.map((p) => (
            <tr key={`v-${p.a_sku}-${p.b_sku}`}>
              <Td className="sa-c-800">
                <span className="sa-fw-500">{p.a_name}</span>
                <span className="sa-c-400" style={{ margin: '0 6px' }}>+</span>
                <span className="sa-fw-500">{p.b_name}</span>
              </Td>
              <Td right>{num(p.together_count)}</Td>
              <Td right className="sa-c-600">{p.support_pct}%</Td>
            </tr>
          ))}
        </Table>
        <Pagination {...volumePage} onPage={volumePage.setPage} csvName="frequent-pairs" />
      </Section>
      )}

    </div>
  );
}
