// Daily Report - the landing view, written like a short daily brief rather
// than another data page. One readable line for the month's pulse, then one
// plain-language item per finding (from the backend overview action queue),
// each with a CTA into the page that holds the full detail. No tables here;
// depth lives in the other pages. Styles: the `sa-report-*` block.
// shortDate: only used by the retired "numbers through ..." header below.
// import { money, num, shortDate } from '../format';
import { money, num } from '../format';

// Backend action.capability -> the page (and its label) that holds the detail.
// Doubles as the report's filter: findings from engines without a page
// are dropped entirely.
const PAGE_FOR_CAP = {
  market: { page: 'pricing_market', label: 'Market Intelligence' },
  // Price & Profit Analysis tab retired, so pricing findings are dropped here
  // (this map doubles as the filter). Kept for reuse:
  // pricing: { page: 'pricing', label: 'Price & Profit Analysis' },
  // The Inventory Intelligence tab is retired; its Zero Movement Report lives
  // on the Buying tab now, so inventory findings link there.
  // inventory: { page: 'inventory', label: 'Inventory Intelligence' },
  inventory: { page: 'buying', label: 'Buying Report' },
  buying: { page: 'buying', label: 'Buying Report' },
  customers: { page: 'customers', label: 'Customer Win-Back' },
  // Retired tabs - their findings are dropped from the report (this map is
  // also the filter). Kept for reuse:
  // basket: { page: 'basket', label: 'Basket & Cross-Sell' },
  // lossprev: { page: 'lossprev', label: 'Loss Prevention' },
};

const Arrow = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
       strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

// The month's numbers as a small visual scorecard. The detail sentence is
// intentionally secondary: the owner should get the answer before the prose.
function PulseLead({ pulse }) {
  if (pulse.revenue_30d == null) return null;
  const mom = pulse.revenue_mom_pct;
  return (
    <div className="sa-report-scorecard">
      <div className="sa-report-score sa-report-score--hero">
        <span className="sa-report-score-label">Sales</span>
        <strong>{money(pulse.revenue_30d)}</strong>
        <span className={mom != null && mom < 0 ? 'sa-warn' : 'sa-good'}>
          {mom == null ? 'last 30 days' : `${mom >= 0 ? '↑' : '↓'} ${Math.abs(mom)}% vs before`}
        </span>
      </div>
      <div className="sa-report-score">
        <span className="sa-report-score-label">Orders</span>
        <strong>{num(pulse.transactions_30d || 0)}</strong>
        <span>shopper visits</span>
      </div>
      <div className="sa-report-score">
        <span className="sa-report-score-label">Basket</span>
        <strong>{money(pulse.avg_basket_value, true)}</strong>
        <span>average spend</span>
      </div>
      <div className="sa-report-score">
        <span className="sa-report-score-label">Margin</span>
        <strong className={pulse.gross_margin_pct == null ? 'is-muted' : 'sa-good'}>
          {pulse.gross_margin_pct == null ? 'No data' : `${Number(pulse.gross_margin_pct).toFixed(1)}%`}
        </strong>
        <span>{pulse.gross_margin_pct == null ? 'add product costs' : 'money kept'}</span>
      </div>
    </div>
  );
}

// One product's 30-day change. Each figure carries its own period label rather
// than the two being joined by an arrow: read as "187 → 18 units" nothing said
// which end was the recent month, and the heading names the recent period
// first, so the arrow looked like it ran the other way.
function ChangeRow({ d, up = false }) {
  return (
    <div className="sa-report-change">
      <span className={`sa-report-change-arrow ${up ? 'sa-good' : 'sa-warn'}`}>{up ? '▲' : '▼'}</span>
      <span className="sa-report-change-name">{d.product_name}</span>
      <span className="sa-report-change-detail">
        prior 30 days {num(d.units_before)} units · last 30 days {num(d.units_now)} (
        {up ? '+' : ''}{d.change_pct}%)
      </span>
    </div>
  );
}

export function OverviewView({ data, onOpen }) {
  const ov = data.overview;
  if (!ov || !ov.available) {
    return (
      <div className="sa-report">
        <div className="sa-report-quiet">
          <div className="sa-text-lg sa-fw-600 sa-warn">Report unavailable</div>
          <p className="sa-mt-2 sa-text-sm sa-c-600">{ov?.reason || 'No sales data for this store.'}</p>
        </div>
      </div>
    );
  }
  // Retired finding keys are dropped here as well as in the Python queue:
  // fresh payloads no longer include them, but cached ones in Postgres / the
  // browser still can. 'leaks' lost its detail page with the Inventory
  // Intelligence tab; 'win_back' was a forecast, not a measurement.
  const RETIRED_KEYS = new Set(['leaks', 'win_back']);
  const actions = (ov.action_queue || []).filter((a) => PAGE_FOR_CAP[a.capability] && !RETIRED_KEYS.has(a.key));
  // Summed over the shown items (not ov.total_opportunity: old cached payloads
  // include figures from engines whose findings we no longer surface). The
  // reorder item is excluded: its dollar is money to SPEND on stock, not
  // opportunity recovered, so adding it to "combined" would inflate the number.
  const combined = actions.reduce((s, a) => s + (a.key !== 'reorder' ? a.value || 0 : 0), 0);
  const errors = ov.engine_errors || [];
  const declining = (ov.anomalies?.declining || []).slice(0, 3);
  const surging = (ov.anomalies?.surging || []).slice(0, 3);

  return (
    <div className="sa-report">
      {/* "Your store this month" header retired - the lead sentence below
          already says "In the last 30 days...". Restore the shortDate import
          along with this block.
      <div className="sa-report-eyebrow">
        <span>Your store this month</span>
        {ov.as_of && <span className="sa-report-eyebrow-aside">numbers through {shortDate(ov.as_of)}</span>}
      </div>
      */}
      <PulseLead pulse={ov.pulse || {}} />

      <div className="sa-report-eyebrow sa-report-section-label">
        <span>Today&apos;s moves</span>
        {actions.length > 0 && (
          <span className="sa-report-eyebrow-aside sa-good">
            {money(combined)} to protect or unlock
          </span>
        )}
      </div>

      {actions.length === 0 ? (
        <div className="sa-report-quiet">
          <div className="sa-report-quiet-mark">{errors.length > 0 ? '!' : '✓'}</div>
          <div className="sa-fw-600 sa-c-900">
            {errors.length > 0 ? 'No findings could be computed on this run' : 'Nothing urgent today'}
          </div>
          <p className="sa-mt-2 sa-text-sm sa-c-600" style={{ margin: '8px auto 0', maxWidth: 420 }}>
            {errors.length > 0
              ? 'Try Refresh; if it persists, the warehouse may be slow.'
              : 'No dollar-sized problems or opportunities stood out. The reports above have the full detail.'}
          </p>
        </div>
      ) : (
        actions.map((a, i) => {
          const dest = PAGE_FOR_CAP[a.capability];
          const linked = !!(dest && onOpen);
          return (
            <div
              key={a.key}
              className={`sa-report-item sa-report-item--${a.severity === 'risk' ? 'risk' : 'opp'}${linked ? ' is-link' : ''}`}
              onClick={linked ? () => onOpen(dest.page) : undefined}
            >
              <span className="sa-report-idx">{i + 1}</span>
              <div className="sa-report-body">
                <div className="sa-report-title">{a.title}</div>
                <p className="sa-report-text">
                  {a.recommendation}. <strong>{money(a.value)}</strong> {a.value_label}.
                </p>
              </div>
              {linked && (
                <button
                  type="button"
                  className="sa-report-cta"
                  onClick={(e) => { e.stopPropagation(); onOpen(dest.page); }}
                >
                  {dest.label} <Arrow />
                </button>
              )}
            </div>
          );
        })
      )}
      {errors.length > 0 && actions.length > 0 && (
        <p className="sa-text-xs sa-warn" style={{ margin: '0 4px' }}>
          Heads up: the {errors.map((e) => e.engine).join(' and ')} check failed on this run, so
          today's list may be missing items. Refresh to retry.
        </p>
      )}

      {(declining.length > 0 || surging.length > 0) && (
        <>
          {/* Heading was "What changed this month". These rows are per-SKU
              units sold over the last 30 days vs the 30 before - selling pace,
              not stock movement. Each row names both periods itself, so the
              aside only has to say what is being counted. */}
          <div className="sa-report-eyebrow">
            <span>Product movement</span>
            <span className="sa-report-eyebrow-aside">units sold</span>
          </div>
          <div className="sa-report-changes">
            {declining.map((d) => (
              <ChangeRow key={`d-${d.sku}`} d={d} up={false} />
            ))}
            {surging.map((d) => (
              <ChangeRow key={`s-${d.sku}`} d={d} up />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
