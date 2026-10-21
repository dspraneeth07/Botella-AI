// Pricing (raise/cut candidates) - ported from views/Pricing.tsx.
import { money, num, titleFor } from '../format';
import { Card, Pagination, Section, Stat, Table, Td, Th, usePaged } from '../ui';

// Which warehouse repo(s) fetched this component's data (for the per-component
// SQL icon). All pricing data comes from the same source.
const SRC = 'pricing';

// Proof-of-trust texts - mirror storeagent/functions/pricing.py.
const INFO = {
  upside:
    'For every under-priced fast mover: (suggested − current price) × its annual units at the current selling rate, summed. The suggested price lifts the item to YOUR category\'s median margin, capped at +20% so no shock raises. Assumes volume holds - that\'s why raises stay modest and only fast sellers qualify.',
  raises:
    'Sells well (fast/normal class) but its margin sits 5+ points below the median margin of its own category in your store (we need 5+ same-category products with real costs before judging). Benchmarked against your store, not industry guesses.',
  cuts:
    'Slow or dead, not premium, priced 5+ margin points ABOVE your category norm - over-pricing may be exactly why it\'s stuck. The suggested cut never goes below cost + 5%. No dollar promise is attached: we can\'t measure how demand responds until it happens.',
  cutCapital:
    'On-hand × unit cost summed across the cut list - the cash a price cut could un-stick.',
};

export function PricingView({ data }) {
  const p = data?.pricing;
  // Hooks must run on every render - before the availability early-return.
  const raisePage = usePaged(p?.raise_list ?? [], 10);
  const cutPage = usePaged(p?.cut_list ?? [], 10);
  if (!p) {
    return (
      <Card className="sa-card--warn sa-p-8 sa-text-center">
        <div className="sa-text-lg sa-fw-600 sa-warn">Pricing data unavailable</div>
      </Card>
    );
  }
  return (
    <div className="sa-stack">
      <div className="sa-grid-stats">
        <Stat label="Potential Annual Margin Gain" value={money(p.est_annual_margin_upside)} tone="good" info={INFO.upside} sql="pricing.est_annual_margin_upside" />
        <Stat label="Products with Price Increase Potential" value={num(p.raise_sku_count)} sub="under-priced fast movers" tone="accent" info={INFO.raises} sql="pricing.raise_sku_count" />
        <Stat label="Price Reduction Candidates" value={num(p.cut_sku_count)} sub="over-priced slow movers" tone="warn" info={INFO.cuts} sql="pricing.cut_sku_count" />
        <Stat label="Capital in Reduction List" value={money(p.cut_frozen_capital)} sub="Cash Locked in Slow Sellers  " info={INFO.cutCapital} sql="pricing.cut_frozen_capital" />
      </div>

      {p.raise_list?.length > 0 && (
      <Section
        title="Price Increase Opportunities"
        hint={`Top sellers earning less margin than the rest of their category · about ${money(p.est_annual_margin_upside)}/yr in potential gain`}
        info={INFO.raises}
        sql="pricing.raise_list"
      >
        <Table head={<><Th>Product</Th><Th right>Now</Th><Th right>Suggested</Th><Th right>Your margin</Th><Th right>Category</Th><Th right>Annual upside</Th></>}>
          {raisePage.slice.map((r) => (
            <tr key={r.sku}>
              <Td className="sa-c-800">
                <span className="sa-truncate" style={{ display: 'block', maxWidth: 240 }}>{titleFor(r.product_name, r.sku)}</span>
              </Td>
              <Td right className="sa-c-600">{money(r.price, true)}</Td>
              <Td right className="sa-fw-600 sa-good">{money(r.suggested_price, true)}</Td>
              <Td right className="sa-c-600">{r.current_margin_pct}%</Td>
              <Td right className="sa-c-600">{r.category_margin_pct}%</Td>
              <Td right className="sa-fw-500 sa-good">+{money(r.est_annual_upside)}</Td>
            </tr>
          ))}
        </Table>
        <Pagination {...raisePage} onPage={raisePage.setPage} csvName="price-raise-candidates" />
      </Section>
      )}

      {p.cut_list?.length > 0 && (
      <Section
        title="Price Reduction Opportunities"
        hint={`${num(p.cut_sku_count)} slow sellers priced above your category's norm - a lower price may get them moving`}
        info={INFO.cuts}
        sql="pricing.cut_list"
      >
            <Table head={<><Th>Product</Th><Th right>Now</Th><Th right>Suggested</Th><Th right>On hand</Th><Th right>Frozen</Th></>}>
              {cutPage.slice.map((r) => (
                <tr key={r.sku}>
                  <Td className="sa-c-800">
                    <span className="sa-truncate" style={{ display: 'block', maxWidth: 240 }}>{titleFor(r.product_name, r.sku)}</span>
                  </Td>
                  <Td right className="sa-c-600">{money(r.price, true)}</Td>
                  <Td right className="sa-fw-600 sa-warn">{money(r.suggested_price, true)}</Td>
                  <Td right>{num(r.on_hand)}</Td>
                  <Td right className="sa-c-600">{money(r.frozen_capital)}</Td>
                </tr>
              ))}
            </Table>
            <Pagination {...cutPage} onPage={cutPage.setPage} csvName="price-cut-candidates" />
      </Section>
      )}

    </div>
  );
}
