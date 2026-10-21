// StoreAgent, rendered as a native view INSIDE BottleAI's ChatPage shell
// (same sidebar + header + theme). The capabilities are a tab strip here. The
// active store is resolved server-side from the JWT (see the Node /api/storeagent
// proxy), so this component never picks a store itself.
//
// Data model:
//  - Base result and AI narration are fetched + cached SEPARATELY. The base
//    (sections, tables, SQL) loads first; toggling AI fetches only the narration
//    and shows a loader in that one panel, never reloading the rest of the view.
//  - Caches are module-scoped, so results survive tab switches and leaving /
//    returning to StoreAgent. The Node backend also persists them in Postgres,
//    so even a fresh session loads instantly from the DB.
//  - Refresh busts both caches (browser + server) and recomputes from the
//    warehouse, showing the status loader while it works.
//  - A tab can be a single capability OR a "composite" that stacks several
//    capability views under one name (see COMPOSITES). Each part is still a real
//    backend capability, fetched / cached / narrated / refreshed on its own.

import { useEffect, useMemo, useReducer, useState } from 'react';

import './storeagent.css';
import { getCacheStatus, getCapabilities, getCapability, getHealth, getNarration } from './api';
import { noDash } from './format';
import { NarrationPanel } from './Narration';
import { isMissing } from './retrieval';
import { Card, DataUnavailable, DebugSqlContext, ErrorBox, InlineLoader, StatusLoader }
  from './ui';
import { CAPABILITY_LABEL, inspect as inspectAvailability } from './availability';

import { OverviewView } from './views/Overview';
// Inventory Intelligence tab retired: only its Zero Movement Report survives,
// rendered inside the Buying tab (see COMPOSITES). Uncomment InventoryView to
// bring the full tab back.
import { ZeroMovementView } from './views/Inventory';
// import { InventoryView } from './views/Inventory';
// import { PricingView } from './views/Pricing'; // Price & Profit Analysis tab retired
import { BuyingView } from './views/Buying';
// import { BasketView } from './views/Basket'; // Basket & Cross-Sell tab retired
import { CustomersView } from './views/Customers';
import { MarketView } from './views/Market';
// import { LossPreventionView } from './views/LossPrevention'; // Loss Prevention tab retired

// Which view component renders each capability's payload.
const VIEW_BY_CAP = {
  overview: OverviewView,
  // inventory: InventoryView, // full Inventory Intelligence page, retired
  inventory: ZeroMovementView, // only the Zero Movement Report renders (inside Buying)
  // pricing: PricingView, // Price & Profit Analysis tab retired
  buying: BuyingView,
  // basket: BasketView, // Basket & Cross-Sell tab retired
  customers: CustomersView,
  market: MarketView,
  // lossprev: LossPreventionView, // Loss Prevention tab retired
};

// Tab order (flat, single row): the daily report first, then money-makers,
// then buying (which now carries the Zero Movement Report), then CRM.
// Retired tabs, kept for reuse:
// const TAB_ORDER = ['overview', 'pricing', 'pricing_market', 'buying', 'inventory', 'lossprev', 'customers', 'basket'];
// const TAB_ORDER = ['overview', 'pricing', 'pricing_market', 'buying', 'customers'];
const TAB_ORDER = ['overview', 'pricing_market', 'buying', 'customers'];

// Capabilities that exist backend-side but have no page of their own. Listing
// retired tabs here matters: anything NOT reachable from a visible tab is never
// fetched or warmed, so these capabilities cost nothing at page load / refresh.
const HIDDEN_CAPS = new Set(['lossprev', 'basket', 'pricing']);

// Composite tabs stack several capability views under one tab + name. Each part
// is a real backend capability; the parts are hidden as standalone tabs.
const COMPOSITES = {
  pricing_market: {
    label: 'Market Intelligence',
    sub: 'See what shoppers want, what to stock, and where your prices stand.',
    parts: ['market'],
  },
  // Buying carries the Zero Movement Report (from the retired Inventory
  // Intelligence tab): the inventory part still computes / caches / refreshes
  // as its own capability, but renders only the zero-movement section
  // (VIEW_BY_CAP maps it to ZeroMovementView).
  buying: {
    label: 'Buying Report',
    sub: 'Know what to order now and what is stuck on the shelf.',
    parts: ['buying', 'inventory'],
  },
};
const COMPOSED_PARTS = new Set(Object.values(COMPOSITES).flatMap((c) => c.parts));
const partsOf = (cap) => COMPOSITES[cap]?.parts || [cap];

// Single source of truth for StoreAgent display copy. The same `label` is used
// for BOTH the tab and the page heading (so they always match), and `sub` is the
// professional one-line description shown under the heading. These intentionally
// override the backend's capability metadata so wording can change without
// redeploying the Python service.
const CAP_META = {
  overview: {
    label: 'Daily Report',
    sub: 'Your money, your movers, and the one thing to do next.',
  },
  // Price & Profit Analysis tab retired - kept for reuse.
  // pricing: {
  //   label: 'Price & Profit Analysis',
  //   sub: 'Raise under-priced fast movers and reduce over-priced slow movers, benchmarked against your own category norms.',
  // },
  // Loss Prevention tab retired - kept for reuse.
  // lossprev: {
  //   label: 'Loss Prevention',
  //   sub: 'Where money quietly walks out: free rings, below-cost sales, voids, cashier outliers, and missing stock. Scans the last 12 months.',
  // },
  buying: {
    label: 'Buying Report',
  },
  // Basket & Cross-Sell tab retired - kept for reuse.
  // basket: {
  //   label: 'Basket & Cross-Sell',
  //   sub: 'What sells together and what to bundle, from the last 120 days of receipts.',
  // },
  market: {
    label: 'Market Intelligence',
    sub: 'See what shoppers want, what to stock, and where your prices stand.',
  },
  // The inventory capability now surfaces only as the Zero Movement Report
  // inside the Buying tab; this label is its section divider there. Original
  // Inventory Intelligence copy, kept for reuse:
  // inventory: {
  //   label: 'Inventory Intelligence',
  //   sub: 'Stock health and tied-up capital for your current inventory. Velocity uses the analysis window you pick; dead stock means no sale in 180+ days.',
  // },
  inventory: {
    label: 'Zero Movement Report',
    sub: 'Stock that has stopped selling and the cash it ties up. Dead stock means no sale in 180+ days, or within the analysis window you pick.',
  },
  customers: {
    label: 'Customer Win-Back',
    sub: 'Find the regulars going quiet and bring them back.',
  },
};

// ---- Session-scoped caches (survive remounts within the SPA) ---------------
const RESULT_CACHE = new Map(); // key -> base capability result
const NARRATION_CACHE = new Map(); // key -> narration object
const INFLIGHT = new Map();
const NARR_INFLIGHT = new Map();
// When we fetched the row we currently hold, and when the server last rewrote
// it (from /cache-status). Both feed the login-refresh poller below: server
// stamp newer than our fetch means the row changed under us and we should
// re-read it.
const LOAD_STAMP = new Map(); // key -> epoch ms of our fetch
const ROW_STAMP = new Map(); // key -> epoch ms of the row's computed_at

export function clearStoreAgentCache() {
  RESULT_CACHE.clear();
  NARRATION_CACHE.clear();
  INFLIGHT.clear();
  NARR_INFLIGHT.clear();
  LOAD_STAMP.clear();
  ROW_STAMP.clear();
}

// ---- Login-refresh freshness -----------------------------------------------
// Signing in kicks off a background recompute of this store's capabilities
// (backend routes/auth.js -> storeIntelligenceService.refreshStoreOnLogin). It
// runs the capabilities one at a time against the warehouse, so it finishes
// minutes after the tab has already rendered - from the row the PREVIOUS
// session left behind. Without the poller below, the open page never learned
// the fresh rows had landed and the only way to see them was the Refresh
// button, which is what users hit and reported as "it didn't refresh itself".
//
// So: poll the cheap freshness map, and re-read only the capabilities whose
// stamp moved past our fetch. The tab still paints instantly from cache; the
// numbers correct themselves in place when the recompute lands.
const FRESHNESS_POLL_MS = 15_000;
// How long after login a refresh could still plausibly be running (5 capabilities
// x up to 90s upstream timeout, plus slack). Past this we stop polling even if
// rows never moved - a failed refresh must not leave the page polling forever.
const LOGIN_REFRESH_WINDOW_MS = 8 * 60 * 1000;

function sessionStartedMs() {
  try {
    const raw = Date.parse(localStorage.getItem('botella_session_started') || '');
    return Number.isFinite(raw) ? raw : 0;
  } catch {
    return 0; // storage disabled - treat as "no login to wait on"
  }
}

// "88:inventory@60" -> { rowCap: 'inventory@60', capability: 'inventory', window: 60 }
// rowCap is the server's cache key (routes/storeagent.js cacheCap), which is
// what /cache-status is keyed by.
function partOfKey(k) {
  const rowCap = k.slice(k.indexOf(':') + 1);
  const [capability, win] = rowCap.split('@');
  return { rowCap, capability, window: win ? Number(win) : null };
}

// `window` (30/60/90, inventory only) is part of the cache key so each analysis
// window keeps its own cached result.
function baseKey(capability, window = null) {
  let store = 'me';
  try {
    store = localStorage.getItem('botella_client_id') || 'me';
  } catch {
    /* ignore */
  }
  return `${store}:${capability}${window ? `@${window}` : ''}`;
}

function loadBase(capability, { force = false, window = null } = {}) {
  const k = baseKey(capability, window);
  if (!force && RESULT_CACHE.has(k)) return Promise.resolve(RESULT_CACHE.get(k));
  const existing = INFLIGHT.get(k);
  if (existing && !force) return existing;
  const p = getCapability(capability, { nocache: force, window })
    .then((d) => {
      RESULT_CACHE.set(k, d);
      LOAD_STAMP.set(k, Date.now());
      INFLIGHT.delete(k);
      return d;
    })
    .catch((e) => {
      INFLIGHT.delete(k);
      throw e;
    });
  INFLIGHT.set(k, p);
  return p;
}

// Re-read one capability the server has since rewritten. Deliberately NOT
// nocache: the row is already fresh, we just hold an older copy, so this is a
// DB read rather than another warehouse pass. Narration is dropped because the
// server nulls it on every payload write - the narration effect refetches it
// if AI is on.
function reloadBase(capability, window = null) {
  const k = baseKey(capability, window);
  return getCapability(capability, { window }).then((d) => {
    RESULT_CACHE.set(k, d);
    LOAD_STAMP.set(k, Date.now());
    NARRATION_CACHE.delete(k);
    return d;
  });
}

function loadNarration(capability, window = null) {
  const k = baseKey(capability, window);
  if (NARRATION_CACHE.has(k)) return Promise.resolve(NARRATION_CACHE.get(k));
  const existing = NARR_INFLIGHT.get(k);
  if (existing) return existing;
  const p = getNarration(capability, { window })
    .then((n) => {
      NARRATION_CACHE.set(k, n);
      NARR_INFLIGHT.delete(k);
      return n;
    })
    .catch((e) => {
      NARR_INFLIGHT.delete(k);
      throw e;
    });
  NARR_INFLIGHT.set(k, p);
  return p;
}

// Selectable analysis windows for Inventory Intelligence (null = the default
// long-horizon analysis: velocity over 90d/365d, dead = no sale in >180d).
// Retired with the Inventory Intelligence tab: the Zero Movement Report on the
// Buying tab always uses the default analysis, consistent with the buying
// report's fixed lookbacks. Kept for reuse with the chips block below.
// const INV_WINDOWS = [
//   { value: null, label: 'Standard' },
//   { value: 30, label: '30d' },
//   { value: 60, label: '60d' },
//   { value: 90, label: '90d' },
// ];

export default function StoreAgentPanel() {
  const [health, setHealth] = useState(null);
  const [metas, setMetas] = useState([]);
  // One-shot deep link: a caller (the dashboard's "Market analysis" button)
  // can name the tab to land on. Read once and cleared, so a later visit opens
  // on the default rather than repeating the last jump.
  const [capability, setCapability] = useState(() => {
    try {
      const want = sessionStorage.getItem('botella_storeagent_tab');
      if (want) {
        sessionStorage.removeItem('botella_storeagent_tab');
        if (TAB_ORDER.includes(want)) return want;
      }
    } catch {
      /* sessionStorage unavailable */
    }
    return 'overview';
  });
  const [narrate] = useState(false); // AI narration toggle removed; narration stays off
  const [refreshing, setRefreshing] = useState(false);
  // Window selector retired (see INV_WINDOWS above) - always the default
  // analysis now. The window plumbing below (windowOf/keyOf/loadBase) is left
  // intact so reviving the selector is just restoring this state + the chips.
  // const [invWindow, setInvWindow] = useState(null); // inventory analysis window (null/30/60/90)
  const invWindow = null;
  const [err, setErr] = useState(null); // { key, msg, err }
  const [narrErr, setNarrErr] = useState(null); // { key, msg }
  // Login-refresh freshness. `pending`: rows on screen still predate this
  // session's login, so the background recompute has not reached them yet.
  // `updatedAt`: when the poller last swapped a fresher row in.
  const [freshness, setFreshness] = useState({ pending: false, updatedAt: null });
  const [, forceUpdate] = useReducer((x) => x + 1, 0);

  // Window applies only to the inventory part; every other capability ignores it.
  const windowOf = (p) => (p === 'inventory' ? invWindow : null);
  const keyOf = (p) => baseKey(p, windowOf(p));

  useEffect(() => {
    Promise.all([getHealth(), getCapabilities()])
      .then(([h, m]) => {
        setHealth(h);
        setMetas(m);
      })
      .catch((e) => setErr({ key: '*', msg: String(e.message || e), err: e }));
  }, []);

  const narrationEnabled = !!health?.narration_enabled;
  const narrationActive = narrate && narrationEnabled;

  // The active tab resolves to one or more capability "parts".
  const parts = partsOf(capability);
  const partKeys = parts.map((p) => keyOf(p));
  const partData = parts.map((p) => RESULT_CACHE.get(keyOf(p)) || null);
  const dataSig = partData.map(Boolean).join(','); // changes as each part lands
  const mine = err && (partKeys.includes(err.key) || err.key === '*');
  const error = mine ? err.msg : null;
  // A failure that means THIS STORE HAS NO SUCH DATA is not an outage, and
  // must not be shown as one: "Something went wrong" invites a retry that can
  // never succeed, and never names the only action the owner has.
  const errAbsent = mine && isMissing(err.err) ? err.err : null;
  const loading = !error && partData.some((d) => !d);

  // Store identity (name + address) comes from the market capability's geo. Market
  // is part of the default tab and stays cached, so we can surface the store name
  // at the top of every tab instead of the raw "Store 46/46" client/location id.
  const marketData = RESULT_CACHE.get(baseKey('market'))?.market || null;
  const geo = marketData?.geo || null;
  const storeName = geo?.location_name || null;
  // Standard one-line address: "Street, City, ST 78702" (country dropped as noise).
  const storeAddr = geo
    ? [geo.address, [[geo.city, geo.state].filter(Boolean).join(', '), geo.postal_code].filter(Boolean).join(' ')]
        .filter(Boolean)
        .join(', ')
    : null;
  const activeMeta = useMemo(() => metas.find((m) => m.capability === capability), [metas, capability]);
  const headLabel =
    COMPOSITES[capability]?.label || CAP_META[capability]?.label || activeMeta?.label || 'Store Intelligence';
  const headSub = COMPOSITES[capability]?.sub || CAP_META[capability]?.sub;

  const tabs = useMemo(() => {
    const byKey = new Map(metas.map((m) => [m.capability, m]));
    const ordered = TAB_ORDER.map((c) =>
      COMPOSITES[c] ? { capability: c, label: COMPOSITES[c].label } : byKey.get(c),
    ).filter(Boolean);
    const rest = metas.filter(
      (m) =>
        !TAB_ORDER.includes(m.capability) &&
        !HIDDEN_CAPS.has(m.capability) &&
        !COMPOSED_PARTS.has(m.capability),
    );
    return [...ordered, ...rest];
  }, [metas]);

  // Load the active tab's part result(s) when not cached.
  useEffect(() => {
    let cancelled = false;
    parts.forEach((p) => {
      const pk = keyOf(p);
      if (RESULT_CACHE.has(pk)) return;
      loadBase(p, { window: windowOf(p) })
        .then(() => !cancelled && forceUpdate())
        .catch((e) => !cancelled && setErr({ key: pk, msg: String(e.message || e), err: e }));
    });
    return () => {
      cancelled = true;
    };
  }, [capability, invWindow]);

  // Load narration for each part once AI is on and that part's base data landed.
  useEffect(() => {
    if (!narrationActive) return undefined;
    let cancelled = false;
    parts.forEach((p) => {
      const pk = keyOf(p);
      if (!RESULT_CACHE.has(pk) || NARRATION_CACHE.has(pk)) return;
      if (narrErr && narrErr.key === pk) return;
      loadNarration(p, windowOf(p))
        .then(() => !cancelled && forceUpdate())
        .catch((e) => !cancelled && setNarrErr({ key: pk, msg: String(e.message || e) }));
    });
    return () => {
      cancelled = true;
    };
  }, [capability, invWindow, narrationActive, dataSig, narrErr]);

  // Warm caches for the OTHER visible tabs (and their parts), all in parallel
  // and immediately - the backend single-flights per capability (Node and
  // Python), so these requests collapse into the same computations the active
  // tab already triggered instead of duplicating warehouse work, and every
  // tab lands as soon as its own engines finish.
  useEffect(() => {
    if (!metas.length) return undefined;
    const warm = new Set(tabs.flatMap((t) => partsOf(t.capability)));
    let cancelled = false;
    metas.forEach((m) => {
      if (!warm.has(m.capability) || parts.includes(m.capability) || RESULT_CACHE.has(baseKey(m.capability)))
        return;
      loadBase(m.capability)
        .then(() => !cancelled && forceUpdate())
        .catch(() => {
          /* warm-up only */
        });
    });
    return () => {
      cancelled = true;
    };
  }, [metas, capability]);

  // Pick up the login-triggered recompute WITHOUT a manual Refresh. Poll the
  // cheap freshness map; when a row's computed_at moves past the copy we hold,
  // re-read just that capability and swap it in. Runs only inside the window a
  // login refresh could still be working, so a long-open page is not polling
  // all day. See the FRESHNESS block at module scope for the full rationale.
  useEffect(() => {
    const started = sessionStartedMs();
    if (!started || Date.now() - started > LOGIN_REFRESH_WINDOW_MS) return undefined;

    let cancelled = false;
    let timer = null;

    async function tick() {
      let status = null;
      try {
        status = await getCacheStatus();
      } catch {
        /* best-effort: a failed poll just retries on the next tick */
      }
      if (cancelled) return;

      if (status) {
        const held = [...RESULT_CACHE.keys()];
        const stale = [];
        held.forEach((k) => {
          const { rowCap, capability: cap, window } = partOfKey(k);
          const at = Date.parse(status[rowCap] || '');
          if (!Number.isFinite(at)) return;
          ROW_STAMP.set(k, at);
          // Newer than our fetch => the recompute rewrote it under us.
          if (at > (LOAD_STAMP.get(k) || 0)) stale.push({ cap, window });
        });

        if (stale.length) {
          await Promise.all(stale.map(({ cap, window }) => reloadBase(cap, window).catch(() => null)));
          if (cancelled) return;
          forceUpdate();
        }

        // Still waiting while nothing has loaded yet, or any row on screen was
        // computed before this session's login.
        const waiting = !held.length || held.some((k) => (ROW_STAMP.get(k) || 0) < started);
        setFreshness((f) => ({ pending: waiting, updatedAt: stale.length ? Date.now() : f.updatedAt }));
        if (!waiting) return; // every row on screen belongs to this session
      }

      if (cancelled) return;
      if (Date.now() - started < LOGIN_REFRESH_WINDOW_MS) {
        timer = setTimeout(tick, FRESHNESS_POLL_MS);
      } else {
        // Window is up and something never arrived (a capability the refresh
        // failed on, say). Stop claiming an update is in progress - a spinner
        // that never resolves is worse than no spinner.
        setFreshness((f) => ({ ...f, pending: false }));
      }
    }

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  function selectCapability(cap) {
    if (cap !== capability) setCapability(cap);
  }

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    setErr(null);
    setNarrErr(null);
    parts.forEach((p) => {
      RESULT_CACHE.delete(keyOf(p));
      NARRATION_CACHE.delete(keyOf(p));
    });
    forceUpdate(); // data now null -> status loader shows
    try {
      await Promise.all(parts.map((p) => loadBase(p, { force: true, window: windowOf(p) })));
    } catch (e) {
      setErr({ key: keyOf(parts[0]), msg: String(e.message || e), err: e });
    } finally {
      setRefreshing(false);
      forceUpdate(); // narration effect refetches if AI is on
    }
  }

  return (
    <div className="sa-root sa-panel">
      <div className="sa-panel-inner">
        <nav className="sa-tabs">
          {tabs.map((m) => (
            <button
              key={m.capability}
              className={`sa-tab${m.capability === capability ? ' is-active' : ''}`}
              onClick={() => selectCapability(m.capability)}
            >
              <CapIcon name={m.capability} />
              <span>{COMPOSITES[m.capability]?.label || CAP_META[m.capability]?.label || m.label}</span>
            </button>
          ))}
        </nav>

        <div className="sa-viewhead">
          <div className="sa-context-bar">
            <div className="sa-context-left">
              <div className="sa-store-id">
                {storeName && <span className="sa-store-id-name">{storeName}</span>}
                {storeAddr && <span className="sa-store-id-addr">{storeAddr}</span>}
              </div>
              {/* Says out loud what the freshness poller is doing, so numbers
                  that predate this login are never mistaken for current ones
                  and the swap is not a silent change under the reader. */}
              {(freshness.pending || freshness.updatedAt) && (
                <div className={`sa-freshness${freshness.pending ? ' is-updating' : ''}`}>
                  {freshness.pending ? 'Updating with the latest numbers' : 'Updated with the latest numbers'}
                </div>
              )}
            </div>

            <div className="sa-panel-actions">
              {/* Analysis-window chips retired with the Inventory Intelligence
                  tab - the Zero Movement Report always uses the default 180d
                  analysis. To revive, uncomment this plus INV_WINDOWS and the
                  invWindow state above.
              {parts.includes('inventory') && (
                <div className="sa-window-chips" role="group" aria-label="Analysis window">
                  {INV_WINDOWS.map((w) => (
                    <button
                      key={w.label}
                      className={`sa-window-chip${invWindow === w.value ? ' is-active' : ''}`}
                      onClick={() => setInvWindow(w.value)}
                      disabled={refreshing}
                      title={w.value
                        ? `Analyse the last ${w.value} days (dead = no sale in ${w.value}+ days)`
                        : 'Default analysis (velocity over 90d/365d, dead = no sale in 180+ days)'}
                    >
                      {w.label}
                    </button>
                  ))}
                </div>
              )}
              */}
              <button
                onClick={refresh}
                disabled={refreshing || loading}
                title="Refresh this view from the warehouse"
                className={`sa-refresh-btn${refreshing ? ' is-busy' : ''}`}
                aria-label="Refresh"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 11-2.64-6.36M21 3v6h-6" />
                </svg>
              </button>
            </div>
          </div>

          {/* Composite tabs (e.g. Pricing & Market Intelligence) skip the page
              heading/subheading - each stacked section has its own divider label. */}
          {!COMPOSITES[capability] && (
            <div className="sa-titleblock">
              <h2 className="sa-panel-title">{headLabel}</h2>
              {headSub && <p className="sa-panel-sub" title={noDash(headSub)}>{noDash(headSub)}</p>}
            </div>
          )}
        </div>

        <div className="sa-stack">
          {loading ? (
            <StatusLoader title={`Crunching ${headLabel}`} />
          ) : errAbsent ? (
            <DataUnavailable
              title={CAPABILITY_LABEL[capability] || headLabel}
              reason={errAbsent.reason}
              detail={errAbsent.detail}
            />
          ) : error ? (
            <ErrorBox message={error} />
          ) : (
            <>
              {parts.map((p) => {
                const d = RESULT_CACHE.get(keyOf(p));
                const View = VIEW_BY_CAP[p];
                if (!d || !View) return null;
                if (capability === 'buying' && p === 'inventory') return null;

                // DOES THIS STORE HAVE THE DATA THIS VIEW DRAWS?
                //
                // The payload arrives as 200 with whatever the engines could
                // compute, so a store with no CRM, no cost data or no supplier
                // history gets fewer sections - and the view used to render
                // regardless, putting its headings over nothing and its stat
                // tiles on zero. A measured zero and an absence then look
                // identical, and the absence is the one an owner needs to act
                // on, because the fix is upstream of this screen.
                //
                // Only when NOTHING the view needs is present: one section of
                // four missing still leaves something true to draw, and the
                // view owns that case.
                const avail = inspectAvailability(p, d);
                if (avail.unavailable) {
                  return (
                    <DataUnavailable
                      key={p}
                      title={CAPABILITY_LABEL[p] || CAP_META[p]?.label || p}
                      reason={avail.reason}
                    />
                  );
                }
                const n = NARRATION_CACHE.get(keyOf(p));
                const nFailed = narrErr && narrErr.key === keyOf(p) ? narrErr.msg : null;
                return (
                  <DebugSqlContext.Provider key={p} value={d.debug_sql || null}>
                    {COMPOSITES[capability] && (
                      <div className="sa-merged-divider">{CAP_META[p]?.label || p}</div>
                    )}
                    {narrationActive &&
                      (n ? (
                        <NarrationPanel narration={n} />
                      ) : nFailed ? (
                        <Card className="sa-narration-off">AI narration unavailable: {noDash(nFailed)}</Card>
                      ) : (
                        <Card className="sa-narration">
                          <div className="sa-narration-bar" />
                          <div className="sa-narration-head">
                            <span className="sa-narration-spark">✦</span>
                            <span className="sa-narration-tag">Store Intelligence AI</span>
                          </div>
                          <div style={{ paddingLeft: 8 }}>
                            <InlineLoader words={['Reading the numbers', 'Writing your brief', 'Almost ready']} />
                          </div>
                        </Card>
                      ))}
                    <View
                      data={d}
                      inventoryData={capability === 'buying' && p === 'buying' ? RESULT_CACHE.get(keyOf('inventory')) : null}
                      onOpen={selectCapability}
                    />
                  </DebugSqlContext.Provider>
                );
              })}
              <p
                className="sa-text-xs sa-c-500"
                style={{ padding: '12px 4px 0', marginTop: 4, borderTop: '1px solid var(--sa-ink-700)' }}
              >
                These figures are estimates generated from your historical data and may be incomplete or
                inaccurate. They are provided for informational purposes only, not as financial or business
                advice. Please verify against your own records before making decisions.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function CapIcon({ name }) {
  const c = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' };
  const p = {
    overview: <path {...c} d="M4 13h4v7H4v-7zm6-9h4v16h-4V4zm6 5h4v11h-4V9z" />,
    inventory: <path {...c} d="M4 7l8-4 8 4v10l-8 4-8-4V7zm8 4l8-4m-8 4L4 7m8 4v10" />,
    // pricing: <path {...c} d="M20.6 13.4L13.4 20.6a2 2 0 01-2.8 0l-7.2-7.2A2 2 0 013 12V4h8a2 2 0 011.4.6l8.2 8.2a2 2 0 010 2.6zM7.5 7.5h.01" />, // tab retired
    pricing_market: <path {...c} d="M20.6 13.4L13.4 20.6a2 2 0 01-2.8 0l-7.2-7.2A2 2 0 013 12V4h8a2 2 0 011.4.6l8.2 8.2a2 2 0 010 2.6zM7.5 7.5h.01" />,
    // lossprev: <path {...c} d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3zm0 6v3m0 3h.01" />, // tab retired
    buying: <path {...c} d="M3 4h2l2 12h11l2-8H6.5M9 20a1 1 0 11-2 0 1 1 0 012 0zm10 0a1 1 0 11-2 0 1 1 0 012 0z" />,
    // basket: <path {...c} d="M3 9h18l-1.5 10.5a2 2 0 01-2 1.5H6.5a2 2 0 01-2-1.5L3 9zm5 0L12 3l4 6m-7 5v3m6-3v3" />, // tab retired
    customers: <path {...c} d="M16 19v-1a4 4 0 00-4-4H7a4 4 0 00-4 4v1m13-7a3 3 0 100-6m4 13v-1a4 4 0 00-3-3.85M9.5 11a3 3 0 100-6 3 3 0 000 6z" />,
    market: <path {...c} d="M12 21s-7-5.2-7-11a7 7 0 0114 0c0 5.8-7 11-7 11zm0-8.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{p[name] || p.inventory}</svg>;
}
