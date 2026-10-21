// useBuyingTotals.js
// -----------------------------------------------------------------------------
// The two money figures the dashboard's KPI grid needs that /api/dashboard does
// not carry: what a full restock would COST, and what being out of stock is
// COSTING. Both are already computed by the buying capability and shown on its
// own report - this reads the same cached row rather than deriving a second,
// slightly different version of them on the client.
//
//   Recommended Purchase (Cost)   ->  buying.buy_total_value
//   Stocking Upside (Revenue)     ->  lost_sales.lost_revenue_estimate
//
// Deliberately read-only and cache-first: no `nocache`, so opening the dashboard
// never triggers a recompute of a heavy capability. If the cache is cold the
// hook reports `unavailable` and the tiles say so - they never show a zero,
// because "not computed yet" and "nothing to buy" are different answers and a
// zero would state the wrong one.
// -----------------------------------------------------------------------------

import { useEffect, useState } from 'react';

const EMPTY = {
  status: 'loading',
  buyValue: null, buySkus: null, buyUnits: null,
  upside: null, stockoutSkus: null, dailyLoss: null,
};

// Module-scoped: leaving the dashboard and coming back should not re-request it.
// Only a SUCCESSFUL read is cached - a cold capability warms in the background
// after login, so a failure must stay retryable.
let CACHE = null;

export default function useBuyingTotals(apiUrl, authToken) {
  const [state, setState] = useState(() => CACHE || EMPTY);

  useEffect(() => {
    if (CACHE) { setState(CACHE); return undefined; }
    if (!authToken) return undefined;
    let alive = true;

    (async () => {
      try {
        const base = (apiUrl || '').replace(/\/api\/?$/, '');
        const res = await fetch(`${base}/api/storeagent/buying`, {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
            'ngrok-skip-browser-warning': 'true',
          },
        });
        if (res.status === 401) {
          localStorage.removeItem('botella_token');
          window.location.href = '/login';
          return;
        }
        if (!res.ok) throw new Error('buying unavailable');

        const json = await res.json();
        const b = json?.buying || {};
        const lost = json?.lost_sales || {};
        const has = (v) => v !== undefined && v !== null && Number.isFinite(Number(v));

        // A capability that has never run comes back without these keys rather
        // than with zeros. Treat that as "not ready", not as "nil".
        if (!has(b.buy_total_value) && !has(lost.lost_revenue_estimate)) {
          throw new Error('not computed yet');
        }

        const next = {
          status: 'ready',
          buyValue: has(b.buy_total_value) ? Number(b.buy_total_value) : null,
          buySkus: has(b.buy_sku_count) ? Number(b.buy_sku_count) : null,
          buyUnits: has(b.buy_units_total) ? Number(b.buy_units_total) : null,
          upside: has(lost.lost_revenue_estimate) ? Number(lost.lost_revenue_estimate) : null,
          stockoutSkus: has(lost.stockout_sku_count) ? Number(lost.stockout_sku_count) : null,
          dailyLoss: has(lost.ongoing_daily_loss) ? Number(lost.ongoing_daily_loss) : null,
        };
        CACHE = next;
        if (alive) setState(next);
      } catch {
        if (alive) setState({ ...EMPTY, status: 'unavailable' });
      }
    })();

    return () => { alive = false; };
  }, [apiUrl, authToken]);

  return state;
}
