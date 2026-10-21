// checkSql.js
// -----------------------------------------------------------------------------
// Resolves a component key ('buying.buy_total_value', 'inventory') to the
// verified query that reproduces that figure from the warehouse.
//
// The queries themselves live in checkSql.data.js and are fetched by the
// dynamic import below. That import sits inside a test written against the raw
// build-time literal rather than a helper, because that is what makes it
// disappear: CRA substitutes process.env.REACT_APP_ENV during the build,
// webpack folds the branch while parsing, and the import inside it is never
// registered - so a production build emits no chunk and contains no SQL.
//
// Both arms of the test name the SAME variable, and that matters. CRA only
// substitutes REACT_APP_* vars that are actually set, so an earlier
// `|| process.env.REACT_APP_SHOW_SQL` escape hatch left a live lookup in the
// expression, nothing could be folded, and the 33 kB chunk was emitted next to
// the production bundle anyway - sitting at a guessable URL, which is most of
// the leak it was meant to close. Comparing one defined variable against two
// literals still folds.
//
// Before this split, all 102 queries were statically imported into main.js and
// shipped to every store owner regardless of which buttons were rendered.
/* eslint-disable */

import { useEffect, useState } from 'react';

let CHECK_SQL = null;
let ready = false;
const waiting = new Set();

if (process.env.REACT_APP_ENV === 'staging' || process.env.REACT_APP_ENV === 'qa') {
  import(/* webpackChunkName: "check-sql" */ './checkSql.data')
    .then((m) => { CHECK_SQL = m.CHECK_SQL; })
    .catch(() => { /* diagnostics are optional; the app is not */ })
    .then(() => { ready = true; waiting.forEach((fn) => fn()); });
}

/**
 * The query for `key`, with %(cid)s resolved to the signed-in store, or null -
 * which is also what every production build returns, always.
 */
export function checkSqlFor(key) {
  if (!CHECK_SQL) return null;
  let store = 'YOUR_CLIENT_ID';
  try { store = localStorage.getItem('botella_client_id') || store; } catch (e) {}
  const sql = CHECK_SQL[key];
  return sql ? sql.split('%(cid)s').join(store) : null;
}

/**
 * Has the query chunk arrived? A component that decides whether to render a
 * control based on checkSqlFor() has to re-render when it does, or it would
 * render its verdict from the empty first moment and keep it forever. Returns
 * true immediately in production: nothing is coming, and nothing should wait.
 */
export function useCheckSqlReady() {
  const [, bump] = useState(0);
  useEffect(() => {
    if (ready) return undefined;
    const fn = () => bump((n) => n + 1);
    waiting.add(fn);
    return () => { waiting.delete(fn); };
  }, []);
  return ready;
}
