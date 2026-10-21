// StartupDigest - a quick "store at a glance" briefing shown on the first
// login of the day (then a 20h rolling cooldown suppresses it).
// It surfaces the few things a store owner can act on immediately:
//   - yesterday's revenue / profit / volume (from /api/summary, fast)
//   - products at stockout risk to reorder now (storeagent buying.buy_list)
//   - fast-selling movers running low (storeagent buying.accelerating)
// The summary loads fast and shows the popup; the buying sections fill in when
// the (cached) storeagent result lands, so a slow/cold warehouse never blocks it.
import React, { useEffect, useState } from 'react';
import { X, TrendingUp, AlertTriangle, Flame, Sparkles, Lightbulb, ChevronRight } from 'lucide-react';
import './StartupDigest.css';

// Last-shown timestamp, per store, in localStorage. A 20h ROLLING window (not a
// calendar-day key) so a 9am login today and an 8am login tomorrow both get the
// briefing, but a lunchtime re-login the same day doesn't. localStorage (not
// sessionStorage) so new tabs / fresh logins within the window stay quiet.
const SEEN_KEY_PREFIX = 'botella_digest_last_shown';
const COOLDOWN_MS = 20 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000; // hard cap so a slow warehouse call never hangs the popup

// fetch + JSON with an abort timeout, so each section resolves (data or fails)
// within the timeout instead of spinning forever on a slow upstream.
function fetchJSON(url, headers, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { headers, signal: ctrl.signal })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .finally(() => clearTimeout(timer));
}

// The insight fetches get a longer leash: a cold store computes for ~6-15s
// (worse when racing the buying fetch on the same warehouse), and the popup
// must show everything on the FIRST login of the day. The card has no loader,
// so a late result simply appears while the user reads the rest; sections
// that render placeholder text keep the short timeout.
const INSIGHT_TIMEOUT_MS = 25000;

const humanize = (s) => (s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const num = (n) => Number(n || 0).toLocaleString('en-US');

// Two Store Intelligence insights for the popup. The only popup-eligible
// findings come from the inventory and market engines (stockouts already have
// their own popup section; the other engines produce none), so those two
// capabilities are fetched in parallel - each ~6s cold vs 10s+ for the full
// overview - and their findings are shaped here exactly like the backend's
// action queue (storeagent pipeline._action_queue), same titles and dollars,
// so the popup and the Daily Report always agree. Rules: ignore findings
// under $100; prefer one risk + one opportunity, else top two by value.
const MIN_INSIGHT_VALUE = 100;
function pickInsights(candidates) {
  const pool = (candidates || [])
    .filter((a) => (a.value || 0) >= MIN_INSIGHT_VALUE)
    .sort((a, b) => (b.value || 0) - (a.value || 0));
  const topRisk = pool.find((a) => a.severity === 'risk');
  const topOpp = pool.find((a) => a.severity !== 'risk');
  const picks = [topRisk, topOpp].filter(Boolean);
  for (const a of pool) {
    if (picks.length >= 2) break;
    if (!picks.includes(a)) picks.push(a);
  }
  return picks.sort((a, b) => (b.value || 0) - (a.value || 0)).slice(0, 2);
}

// Mirrors pipeline._action_queue's inventory actions over the inventory
// capability payload (dead_stock / frozen_capital / money_leaks).
function inventoryInsights(d) {
  const acts = [];
  const ds = d?.dead_stock || {};
  const fc = d?.frozen_capital || {};
  const ml = d?.money_leaks || {};
  const freeable = fc.value_basis === 'cost' ? ds.actionable_frozen_capital : ds.actionable_frozen_retail;
  if ((freeable || 0) > 0) {
    acts.push({
      key: 'dead_stock', capability: 'inventory', severity: 'risk',
      title: 'Free up frozen cash', value: freeable, value_label: 'tied in dead stock',
      recommendation: `Liquidate or bundle ${num(ds.actionable_sku_count)} dead SKUs`,
    });
  }
  if ((ml.recoverable_estimate || 0) > 0) {
    acts.push({
      key: 'leaks', capability: 'inventory', severity: 'risk',
      title: 'Plug profit leaks', value: ml.recoverable_estimate, value_label: 'recoverable / yr',
      recommendation: `${num(ml.below_cost_lines)} below-cost sales + ${money(ml.wasted_discount_estimate)} wasted markdowns`,
    });
  }
  return acts;
}

function marketInsights(d) {
  const mk = d?.market || {};
  if (!mk.available || !(mk.opportunity_count > 0) || !((mk.total_projected_profit || 0) > 0)) return [];
  return [{
    key: 'market', capability: 'market', severity: 'opportunity',
    title: 'Capture nearby demand', value: mk.total_projected_profit, value_label: 'projected profit / yr',
    recommendation: `Stock ${num(mk.opportunity_count)} products selling at nearby stores`,
  }];
}

// Short human labels for the run's active external signals (mirrors the
// Recommendations page's signal strip). Used to show a recommendation's active
// signal - falling back to the run's signals when a rec cites none of its own.
function activeSignalLabels(snapshot) {
  const s = snapshot || {};
  const out = [];
  (s.holidays || []).forEach((h) => h?.name && out.push(h.name));
  if (s.weather && s.weather.summary) out.push(s.weather.summary);
  (s.sports || []).filter((g) => g.is_local_home).forEach((g) => out.push(`${g.away} @ ${g.home}`));
  (s.events || []).forEach((e) => e?.name && out.push(e.name));
  // Newer snapshots carry only analyst-relevant headlines (impact is set);
  // older ones carry every fetched headline, so prefer the analyzed subset
  // and fall back to a single headline instead of listing noise.
  const news = s.news || [];
  const analyzedNews = news.filter((n) => n?.impact);
  (analyzedNews.length > 0 ? analyzedNews : news.slice(0, 1)).forEach(
    (n) => n?.headline && out.push(n.headline)
  );
  return out;
}

export default function StartupDigest({ authToken, apiBase, onOpenStoreIntelligence }) {
  const [visible, setVisible] = useState(false);
  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [buying, setBuying] = useState(null);
  const [buyingLoading, setBuyingLoading] = useState(true);
  const [recs, setRecs] = useState([]);
  const [run, setRun] = useState(null);
  const [recsLoading, setRecsLoading] = useState(true);
  const [insightPool, setInsightPool] = useState([]);

  useEffect(() => {
    if (!authToken) return undefined;
    const storeId = localStorage.getItem('botella_location_id') || 'default';
    const seenKey = `${SEEN_KEY_PREFIX}_${storeId}`;
    try {
      const last = Number(localStorage.getItem(seenKey));
      if (Number.isFinite(last) && last > 0 && Date.now() - last < COOLDOWN_MS) {
        return undefined; // shown within the last 20h - stay quiet
      }
    } catch {
      /* localStorage unavailable - show */
    }

    setVisible(true); // show immediately; each section fills in as its data lands
    // Mark shown at display time (not on close), so navigating away without
    // closing doesn't re-trigger it on the next page load.
    try {
      localStorage.setItem(seenKey, String(Date.now()));
    } catch {
      /* ignore */
    }

    let cancelled = false;
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
      'ngrok-skip-browser-warning': 'true',
    };

    // Yesterday's revenue / profit / top sellers (fast, Node). quick=1 skips the
    // heavy slow-inventory scan + AI call; prev=1 anchors to the previous
    // completed sales day so we show yesterday, not today's partial numbers.
    fetchJSON(`${apiBase}/summary?quick=1&prev=1`, headers)
      .then((d) => {
        if (!cancelled) setSummary(d);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setSummaryLoading(false);
      });

    // Understock + fast-selling - fills its sections when the cached result lands.
    fetchJSON(`${apiBase}/storeagent/buying`, headers)
      .then((d) => {
        if (!cancelled) setBuying(d);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setBuyingLoading(false);
      });

    // Store Intelligence insights: the two source capabilities are fetched in
    // parallel and each merges into the pool as it lands, so whichever
    // finishes first shows first. Warm stores are instant (Node cache); cold
    // stores usually land inside the popup timeout (~6s each); anything that
    // still times out completes + caches server-side for the next login.
    // The merge is keyed so a re-run never duplicates rows.
    const mergeInsights = (acts) => {
      if (!acts.length) return;
      setInsightPool((p) => [...p.filter((x) => !acts.some((a) => a.key === x.key)), ...acts]);
    };
    fetchJSON(`${apiBase}/storeagent/inventory`, headers, INSIGHT_TIMEOUT_MS)
      .then((d) => {
        if (!cancelled) mergeInsights(inventoryInsights(d));
      })
      .catch(() => {});
    fetchJSON(`${apiBase}/storeagent/market`, headers, INSIGHT_TIMEOUT_MS)
      .then((d) => {
        if (!cancelled) mergeInsights(marketInsights(d));
      })
      .catch(() => {});

    // Top signal-aware AI recommendations (highest confidence shown).
    fetchJSON(`${apiBase}/recommendations/latest`, headers)
      .then((d) => {
        if (!cancelled) {
          setRecs(Array.isArray(d?.recommendations) ? d.recommendations : []);
          setRun(d?.run || null);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setRecsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [authToken, apiBase]);

  if (!visible) return null;

  const close = () => setVisible(false);

  const s = summary?.sales;
  const buy = buying?.buying || {}; // buy_list / accelerating are nested under .buying
  const understock = (buy.buy_list || []).filter((r) => r.stockout_risk).slice(0, 5);
  const flaggedFast = (buy.accelerating || []).filter((a) => a.stockout_risk);
  const fastList = (flaggedFast.length ? flaggedFast : buy.accelerating || []).slice(0, 5);

  // Server rank, not model confidence: the popup's #1 must be the page's #1
  // (and confidence is no longer a user-facing number anywhere).
  const topRecs = [...recs].sort((a, b) => (a.rank || 99) - (b.rank || 99)).slice(0, 2);
  const recLead = (r) => {
    const p = (r.products && r.products[0]) || (r.primary_skus || []).map((sku) => ({ sku }))[0] || {};
    return p.product_name || p.sku || 'Recommendation';
  };
  const activeSignals = activeSignalLabels(run?.signal_snapshot);
  const insights = pickInsights(insightPool);

  return (
    <div className="sd-scrim" onClick={close}>
      <div className="sd-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Daily store briefing">
        <button className="sd-close" onClick={close} aria-label="Close">
          <X size={18} />
        </button>

        <div className="sd-head">
          <div className="sd-head-title">Your store at a glance</div>
        </div>

        {/* KPI cards always render so they fill in place (skeleton -> value)
            instead of popping in after a one-line loading message. */}
        <section className="sd-card sd-card--ai sd-kpi-section">
          <div className="sd-card-head sd-accent">
            <TrendingUp size={15} /> Yesterday's performance
          </div>
          <div className="sd-kpis">
          <div className="sd-kpi sd-kpi--good">
            <div className="sd-kpi-label">Revenue</div>
            <div className="sd-kpi-value">
              {summaryLoading ? <span className="sd-kpi-skel" /> : s ? money(s.total_revenue) : '-'}
            </div>
          </div>
          <div className="sd-kpi sd-kpi--accent">
            <div className="sd-kpi-label">Profit</div>
            <div className="sd-kpi-value">
              {summaryLoading ? <span className="sd-kpi-skel" /> : s ? money(s.total_profit) : '-'}
            </div>
          </div>
          <div className="sd-kpi">
            <div className="sd-kpi-label">Transactions</div>
            <div className="sd-kpi-value">
              {summaryLoading ? <span className="sd-kpi-skel" /> : s ? num(s.total_transactions) : '-'}
            </div>
          </div>
          <div className="sd-kpi">
            <div className="sd-kpi-label">Units sold</div>
            <div className="sd-kpi-value">
              {summaryLoading ? <span className="sd-kpi-skel" /> : s ? num(s.total_units) : '-'}
            </div>
          </div>
          </div>
        </section>

        <div className="sd-grid">
          <section className="sd-card">
            <div className="sd-card-head sd-good">
              <TrendingUp size={15} /> Top sellers
            </div>
            {summaryLoading ? (
              <div className="sd-muted">Checking sales…</div>
            ) : !s?.top_products?.length ? (
              <div className="sd-muted">No sales recorded.</div>
            ) : (
              <ul className="sd-list">
                {s.top_products.slice(0, 5).map((p, i) => (
                  <li key={p.sku || i}>
                    <span className="sd-name" title={p.name}>{p.name}</span>
                    <span className="sd-meta">{num(p.units)} units · {money(p.revenue)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="sd-card sd-card--urgent">
            <div className="sd-card-head sd-bad">
              <AlertTriangle size={15} /> Restock now
            </div>
            {buyingLoading ? (
              <div className="sd-muted">Checking inventory…</div>
            ) : understock.length === 0 ? (
              <div className="sd-muted">Nothing urgent - you're well stocked.</div>
            ) : (
              <ul className="sd-list">
                {understock.map((r, i) => (
                  <li key={r.sku || i}>
                    <span className="sd-name" title={r.product_name}>{r.product_name}</span>
                    <span className="sd-meta">{num(r.on_hand)} on hand · order {num(r.order_qty)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="sd-card sd-card--hot">
            <div className="sd-card-head sd-warn">
              <Flame size={15} /> Selling fast, running low
            </div>
            {buyingLoading ? (
              <div className="sd-muted">Checking demand…</div>
            ) : fastList.length === 0 ? (
              <div className="sd-muted">No accelerating movers at risk.</div>
            ) : (
              <ul className="sd-list">
                {fastList.map((a, i) => (
                  <li key={a.sku || i}>
                    <span className="sd-name" title={a.product_name}>{a.product_name}</span>
                    <span className="sd-meta">
                      {num(a.on_hand)} on hand · {a.trend}× pace · {a.days_of_supply != null ? `${num(a.days_of_supply)}d left` : 'low stock'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {insights.length > 0 && (
          <section className="sd-card">
            <div className="sd-card-head sd-warn">
              <Lightbulb size={15} /> Store intelligence
            </div>
            <ul className="sd-list">
                {insights.map((a) => (
                  <li
                    key={a.key}
                    style={{ cursor: onOpenStoreIntelligence ? 'pointer' : 'default' }}
                    onClick={() => {
                      if (!onOpenStoreIntelligence) return;
                      close();
                      onOpenStoreIntelligence();
                    }}
                  >
                    <span className="sd-name" title={a.recommendation}>
                      <span
                        style={{
                          display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
                          marginRight: 7, verticalAlign: 'middle',
                          background: a.severity === 'risk' ? 'var(--red, #FF6B8A)' : 'var(--green, #2FBF97)',
                        }}
                      />
                      {a.title}
                    </span>
                    <span className="sd-meta">
                      {money(a.value)} {a.value_label}
                      {onOpenStoreIntelligence && <ChevronRight size={13} style={{ verticalAlign: 'middle', marginLeft: 4 }} />}
                    </span>
                  </li>
                ))}
            </ul>
          </section>
        )}

        <section className="sd-card sd-card--ai">
          <div className="sd-card-head sd-accent">
            <Sparkles size={15} /> Top AI recommendations
          </div>
          {recsLoading ? (
            <div className="sd-muted">Loading recommendations…</div>
          ) : topRecs.length === 0 ? (
            <div className="sd-muted">No recommendations generated yet.</div>
          ) : (
            <div className="sd-recs">
              {topRecs.map((r, i) => {
                // The recommendation's active signal(s): its own cited signals when
                // present, else the run's active external signals as context.
                const recSignals = (Array.isArray(r.signals_cited) && r.signals_cited.length > 0)
                  ? r.signals_cited.slice(0, 3).map(humanize)
                  : activeSignals.slice(0, 2);
                return (
                <div className="sd-rec" key={i}>
                  <div className="sd-rec-badge">
                    <Sparkles size={14} />
                  </div>
                  <div className="sd-rec-body">
                    <div className="sd-rec-titlerow">
                      <span className="sd-rec-name" title={recLead(r)}>{recLead(r)}</span>
                      {r.action_type && <span className="sd-rec-action">{humanize(r.action_type)}</span>}
                    </div>
                    {r.rationale && <p className="sd-rec-why">{r.rationale}</p>}
                    {recSignals.length > 0 && (
                      <div className="sd-rec-tags">
                        {recSignals.map((sig, j) => (
                          <span className="sd-rec-tag" key={j}>{sig}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </section>

        <div className="sd-actions">
          <button className="sd-btn-secondary" onClick={close}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
