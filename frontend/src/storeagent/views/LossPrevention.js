// Loss prevention (loss + shrinkage merged) - ported from views/LossPrevention.tsx.
import { money, num, titleFor } from '../format';
import { Badge, Card, Pagination, Section, Stat, Table, Td, Th, usePaged } from '../ui';

// Which warehouse repo(s) fetched each component's data (for the per-component
// SQL icon). Register signals come from loss_repo; cashier and shrinkage signals
// come from shrinkage_repo.
const LOSS = 'loss';
const SHRINK = null; // shrinkage is not SQL-reproduced (no cashier data on most stores)

// Proof-of-trust texts - mirror storeagent/functions/loss.py + shrinkage.py.
const INFO = {
  exposure:
    'The total money worth reviewing this period: giveaways, below-cost sales, and refunds added together. Voids are shown separately and left out, since most are honest corrections.',
  free:
    'Items that rang up for next to nothing even though they have a real shelf price. A common sign of sweethearting and worth a look, never proof of wrongdoing.',
  belowCost:
    'Sales where an item left the store for less than you paid for it. Each one is margin lost, worth checking for pricing mistakes or misuse.',
  voids:
    'Sales that were reversed or refunded at the register. A few are normal; watch for a rising trend or one cashier or time of day standing out.',
  shrink:
    'Stock you paid for that is not on the shelf and was not sold, so it is unaccounted for. Flagged only when the gap is big enough to matter, not everyday noise.',
  cashiers:
    'Cashiers whose rate of voided sales stands out from the rest of the team. A prompt to review patterns, never an accusation.',
};

export function LossPreventionView({ data }) {
  const loss = data.loss;
  const sh = data.shrinkage_report;
  // Hooks must run on every render - before any availability early-return.
  const freePage = usePaged((loss.signals && loss.signals.free_giveaways.items) || [], 10);
  const belowPage = usePaged((loss.signals && loss.signals.below_cost.items) || [], 10);
  const cashierPage = usePaged((sh.cashiers && sh.cashiers.all) || [], 10);
  const shrinkPage = usePaged((sh.shrinkage && sh.shrinkage.items) || [], 10);

  const lossOk = loss.available && !!loss.signals;
  const shOk = sh.available && !!sh.cashiers && !!sh.shrinkage;

  if (!lossOk && !shOk) {
    return (
      <Card className="sa-card--warn sa-p-8 sa-text-center">
        <div className="sa-text-lg sa-fw-600 sa-warn">Loss prevention unavailable</div>
        <p className="sa-mt-2 sa-text-sm sa-c-600" style={{ marginLeft: 'auto', marginRight: 'auto', maxWidth: '28rem' }}>
          {loss.reason || sh.reason || 'No sales data for this store.'}
        </p>
      </Card>
    );
  }

  const s = loss.signals;
  const c = sh.cashiers;
  const sk = sh.shrinkage;
  const clean = lossOk && (loss.flagged_line_count || 0) === 0 && s.voids.sales === 0;

  return (
    <div className="sa-stack">
      {/* ---------------- At the register: doubtful sales ---------------- */}
      <GroupLabel>At the Register: Doubtful Sales</GroupLabel>

      {!lossOk ? (
        <Card className="sa-card--warn sa-p-5 sa-text-sm sa-c-600">
          Register signals unavailable: {loss.reason || 'no sales data.'}
        </Card>
      ) : (
        <>
          <div className="sa-grid-stats">
            <Stat label="Exposure to Review" value={money(loss.review_exposure)} sub={`last ${num(loss.window_days)}d`} tone={clean ? 'good' : 'bad'} info={INFO.exposure} sql="loss.review_exposure" />
            <Stat label="Rung Up as ~Free" value={money(s.free_giveaways.value_given_away)} sub={`${num(s.free_giveaways.lines)} lines`} tone="warn" info={INFO.free} sql="loss.free_value_given_away" />
            <Stat label="Below-Cost Loss" value={money(s.below_cost.margin_lost)} sub={`${num(s.below_cost.lines)} sales`} tone="bad" info={INFO.belowCost} sql="loss.below_margin_lost" />
            <Stat label="Voids / Reversals" value={money(s.voids.amount)} sub={`${num(s.voids.sales)} sales · ${num(s.voids.recent_sales)} recent`} tone="accent" info={INFO.voids} sql="loss.void_amount" />
          </div>

          {!clean && (
            <>
              {s.free_giveaways.items.length > 0 && (
              <Section
                title="Give-Away Rings (Real-Priced Items Sold for ~$0)"
                hint={`${num(s.free_giveaways.units)} units · ~${money(s.free_giveaways.value_given_away)} of shelf value · possible sweethearting`}
                info={INFO.free}
                sql="lossprev.free_giveaways"
              >
                    <Table head={<><Th>Product</Th><Th>Category</Th><Th right>Units</Th><Th right>Shelf price</Th><Th right>Given away</Th></>}>
                      {freePage.slice.map((it) => (
                        <tr key={it.sku}>
                          <Td className="sa-truncate sa-c-800" style={{ maxWidth: 240 }}>{titleFor(it.product_name, it.sku)}</Td>
                          <Td className="sa-c-600">{it.category}</Td>
                          <Td right>{num(it.units)}</Td>
                          <Td right className="sa-c-600">{money(it.price, true)}</Td>
                          <Td right className="sa-fw-500 sa-bad">{money(it.value_given_away)}</Td>
                        </tr>
                      ))}
                    </Table>
                    <Pagination {...freePage} onPage={freePage.setPage} csvName="rung-up-as-free" />
              </Section>
              )}

              <div className="sa-grid-2">
                {s.below_cost.items.length > 0 && (
                <Section
                  title="Below-Cost Sales"
                  hint={`${num(s.below_cost.lines)} lines · ${money(s.below_cost.margin_lost)} margin destroyed`}
                  info={INFO.belowCost}
                  sql="lossprev.below_cost"
                >
                      <Table head={<><Th>Product</Th><Th right>Units</Th><Th right>Lines</Th><Th right>Lost</Th></>}>
                        {belowPage.slice.map((it) => (
                          <tr key={it.sku}>
                            <Td className="sa-truncate sa-c-800" style={{ maxWidth: 200 }}>{titleFor(it.product_name, it.sku)}</Td>
                            <Td right>{num(it.units)}</Td>
                            <Td right className="sa-c-600">{num(it.lines)}</Td>
                            <Td right className="sa-fw-500 sa-bad">{money(it.margin_lost)}</Td>
                          </tr>
                        ))}
                      </Table>
                      <Pagination {...belowPage} onPage={belowPage.setPage} csvName="sold-below-cost" />
                </Section>
                )}

                {(s.voids.sales > 0 || s.returns.lines > 0) && (
                <Section title="Voids & Returns" hint="reversed transactions - watch the trend and who rings them" info={INFO.voids} sql="loss.void_amount">
                  <div className="sa-stack-md">
                    <div className="sa-listrow" style={{ borderRadius: 12, border: '1px solid var(--sa-ink-700)', background: 'var(--sa-ink-900)', padding: 12 }}>
                      <div>
                        <div className="sa-text-sm sa-fw-500 sa-c-800">Voided sales</div>
                        <div className="sa-text-xs sa-c-500">{num(s.voids.recent_sales)} in the last 90 days</div>
                      </div>
                      <div className="sa-text-right">
                        <div className="sa-text-lg sa-fw-700 sa-num sa-c-900">{num(s.voids.sales)}</div>
                        <div className="sa-text-xs sa-num sa-c-500">{money(s.voids.amount)}</div>
                      </div>
                    </div>
                    <div className="sa-listrow" style={{ borderRadius: 12, border: '1px solid var(--sa-ink-700)', background: 'var(--sa-ink-900)', padding: 12 }}>
                      <div>
                        <div className="sa-text-sm sa-fw-500 sa-c-800">Returns (negative qty)</div>
                        <div className="sa-text-xs sa-c-500">{num(s.returns.units)} units refunded</div>
                      </div>
                      <div className="sa-text-right">
                        <div className="sa-text-lg sa-fw-700 sa-num sa-c-900">{num(s.returns.lines)}</div>
                        <div className="sa-text-xs sa-num sa-c-500">{money(s.returns.amount)}</div>
                      </div>
                    </div>
                  </div>
                </Section>
                )}
              </div>
            </>
          )}
        </>
      )}

      {/* ---------------- Stock & staff: where did it go ---------------- */}
      <GroupLabel>Stock &amp; Staff: Where Did It Go?</GroupLabel>

      {!shOk ? (
        <Card className="sa-card--warn sa-p-5 sa-text-sm sa-c-600">
          Stock &amp; staff signals unavailable: {sh.reason || 'this store\'s POS records no cashier on transactions.'}
        </Card>
      ) : (
        <>
          <div className="sa-grid-stats">
            <Stat label="Shrink Exposure" value={money(sk.shrink_value)} sub={`${num(sk.skus_flagged)} SKUs · ${num(sk.units_unaccounted)} units missing`} tone="bad" info={INFO.shrink} sql={SHRINK} />
            <Stat label="Cashiers to Review" value={num(c.flagged.length)} sub={`of ${num(c.team_size)} on the floor`} tone={c.flagged.length ? 'warn' : 'good'} info={INFO.cashiers} sql={SHRINK} />
            <Stat label="Voided $ (by Cashier)" value={money(c.total_void_amount)} sub="reversed transactions" tone="accent" sql={SHRINK} />
            <Stat label="Refunded $" value={money(c.total_refunded)} sub="returns / refunds" tone="warn" sql={SHRINK} />
          </div>

          {(c.all || []).length > 0 && (
          <Section
            title="Cashier Watch"
            hint={c.flagged.length ? `${num(c.flagged.length)} above the team's void-rate norm - worth a look` : 'no one stands out above the team norm'}
            info={INFO.cashiers}
            sql={SHRINK}
          >
            <Table head={<><Th>Cashier</Th><Th right>Sales</Th><Th right>Void rate</Th><Th right>Voided</Th><Th right>Discount</Th><Th></Th></>}>
              {cashierPage.slice.map((row) => {
                const flagged = c.flagged.some((f) => f.cashier === row.cashier);
                return (
                  <tr key={row.cashier} style={flagged ? { background: 'rgba(217, 119, 6, 0.05)' } : undefined}>
                    <Td className="sa-truncate sa-c-800" style={{ maxWidth: 200 }}>{row.cashier}</Td>
                    <Td right>{num(row.sales)}</Td>
                    <Td right className={flagged ? 'sa-fw-600 sa-warn' : 'sa-c-600'}>{row.void_rate_pct}%</Td>
                    <Td right className="sa-c-600">{money(row.void_amount)}</Td>
                    <Td right className="sa-c-600">{row.discount_pct}%</Td>
                    <Td>{flagged ? <Badge tone="urgent">review</Badge> : null}</Td>
                  </tr>
                );
              })}
            </Table>
            <Pagination {...cashierPage} onPage={cashierPage.setPage} csvName="cashier-outliers" />
          </Section>
          )}

          {sk.items.length > 0 && (
          <Section
            title="Unaccounted Stock (Book vs. Physical)"
            hint={`units you bought that aren't accounted for by sales or current stock · ${money(sk.shrink_value)} exposure`}
            info={INFO.shrink}
            sql={SHRINK}
          >
                <Table head={<><Th>Product</Th><Th right>Bought</Th><Th right>Sold</Th><Th right>On shelf</Th><Th right>Missing</Th><Th right>% gone</Th><Th right>Est. loss</Th></>}>
                  {shrinkPage.slice.map((it) => (
                    <tr key={it.sku}>
                      <Td className="sa-truncate sa-c-800" style={{ maxWidth: 200 }}>{it.product_name || it.sku}</Td>
                      <Td right className="sa-c-600">{num(it.received)}</Td>
                      <Td right className="sa-c-600">{num(it.sold)}</Td>
                      <Td right className="sa-c-600">{num(it.on_hand)}</Td>
                      <Td right className="sa-fw-600 sa-bad">{num(it.units_unaccounted)}</Td>
                      <Td right className="sa-c-600">{it.unaccounted_pct}%</Td>
                      <Td right className="sa-fw-500 sa-bad">{money(it.shrink_value)}</Td>
                    </tr>
                  ))}
                </Table>
                <Pagination {...shrinkPage} onPage={shrinkPage.setPage} csvName="shrinkage-variances" />
            <p className="sa-mt-3 sa-text-xs sa-c-500">
              Read each row as <span className="sa-fw-500 sa-c-700">Bought − Sold − On shelf = Missing</span>.
              Those units were received but never rang up and aren't on the shelf - likely theft, breakage, or
              miscounts. No opening count exists, so we only flag SKUs where a quarter or more is unaccounted -
              a signal to <strong>review</strong>, not proof.
            </p>
          </Section>
          )}
        </>
      )}

      <p className="sa-text-xs sa-c-500" style={{ paddingLeft: 4, paddingRight: 4 }}>
        Everything on this page is a signal to <strong>review</strong>, not proof of theft. "Given away" = shelf
        price × qty for items rung at ≤$0.01. Voids are shown (not added to exposure) - many are legitimate
        corrections; watch for concentration by cashier or time of day.
      </p>
    </div>
  );
}

function GroupLabel({ children }) {
  return (
    <div className="sa-row" style={{ gap: 12, paddingTop: 4 }}>
      <span className="sa-text-xs sa-fw-600 sa-upper sa-c-500">{children}</span>
      <span className="sa-flex-1" style={{ height: 1, background: 'var(--sa-ink-700)' }} />
    </div>
  );
}
