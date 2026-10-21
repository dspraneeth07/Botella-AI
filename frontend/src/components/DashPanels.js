// DashPanels.js
// -----------------------------------------------------------------------------
// The three blocks that now sit above the charts on the dashboard, plus the
// shared glass Panel they are built from.
//
// The old dashboard opened with five KPI tiles and then four charts. A store
// owner had to read the whole page to work out what to do about any of it.
// This inverts that: the answer comes first, the evidence second.
//
//   KpiGrid           the four numbers an owner acts on, 2x2, largest type
//   TasksByPriority   the ranked queue beside it - how many, and the top three
//   StoreIntelligence a scroll feed beside it: daily brief, P&L, market signals
//
// Nothing here invents data. Recommendations come from
// /api/recommendations/latest, the daily brief from /api/summary, the P&L
// highlights are computed from the /api/dashboard payload the page already
// holds, and the market signals are the run's own signal_snapshot - the same
// source the Recommendations page reads.
//
// Every block carries a "View detailed" affordance: panels expand in place,
// and the ones that have a dedicated page hand off to it.
// -----------------------------------------------------------------------------

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ChevronDown, ArrowUpRight, Sparkles, AlertTriangle, TrendingUp, TrendingDown,
  DollarSign, Package, Percent, Radar, CalendarDays, CloudSun, Trophy, MapPin,
  Newspaper, Flame, Loader, ShoppingCart, Boxes, SlidersHorizontal, ArrowRight,
  ListChecks, Check, Download, Lightbulb,
} from 'lucide-react';
import { formatLocalDate } from '../utils/date';
import { SHOW_CARD_CONFIDENCE } from '../utils/features';
import { listTasks, addTask, isSaved, subscribe as subscribeTasks } from '../utils/tasklist';
import useBuyingTotals from '../utils/useBuyingTotals';

/* ── Formatters ────────────────────────────────────────────────────────── */
export const money = (v) =>
  '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const moneyShort = (v) => {
  const n = Number(v || 0);
  if (Math.abs(n) >= 1000000) return `$${(n / 1000000).toFixed(1)}M`;
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
};
export const num = (v) => Number(v || 0).toLocaleString('en-US');
const shortDate = (d) => (d ? formatLocalDate(d, { month: 'short', day: 'numeric' }) : '');
const trim = (s, n) => (!s ? '' : (String(s).trim().length > n ? String(s).trim().slice(0, n) + '…' : String(s).trim()));
const firstSentence = (t) => {
  if (!t) return '';
  const m = String(t).match(/^[\s\S]*?[.!?](?=\s|$)/);
  return (m ? m[0] : String(t)).trim();
};

/* ── Auth'd fetch helper. 401 behaves exactly as it does elsewhere in the
      app: drop the token and bounce to /login. ─────────────────────────── */
async function authedJson(apiUrl, path, token) {
  const base = (apiUrl || '').replace(/\/api\/?$/, '');
  const res = await fetch(`${base}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'ngrok-skip-browser-warning': 'true',
    },
  });
  if (res.status === 401) {
    localStorage.removeItem('botella_token');
    window.location.href = '/login';
    return null;
  }
  if (!res.ok) throw new Error('request failed');
  return res.json();
}

/* =============================================================================
   Panel - the shared glass container
   ============================================================================= */
export function Panel({
  kicker, title, meta, icon, action, children, detail, detailLabel = 'View detailed',
  className = '', bodyClass = '', tone,
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className={`dp-panel glass glass-hover ${tone ? `dp-tone-${tone}` : ''} ${className}`}>
      <header className="dp-head">
        <div className="dp-head-main">
          {kicker && <span className="app-kicker dp-kicker">{kicker}</span>}
          <h3 className="dp-title">
            {icon && <span className="dp-title-icon">{icon}</span>}
            {title}
          </h3>
          {meta && <span className="dp-meta">{meta}</span>}
        </div>
        <div className="dp-head-actions">
          {action}
          {detail && (
            <button
              type="button"
              className="app-btn dp-detail-btn"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
            >
              {open ? 'Hide detail' : detailLabel}
              <ChevronDown size={13} className={open ? 'dp-chev is-open' : 'dp-chev'} />
            </button>
          )}
        </div>
      </header>
      <div className={`dp-body ${bodyClass}`}>{children}</div>
      {detail && open && <div className="dp-detail">{detail}</div>}
    </section>
  );
}

/* =============================================================================
   PRIORITY BAND - the numbers an owner acts on
   -----------------------------------------------------------------------------
   Five tiles, but ranked rather than listed: money first, then the health of
   the margin, then the two things that need a decision today (reorders and
   capital sitting on the shelf). Each tile states what it means underneath, so
   the number is never orphaned from its interpretation.
   ============================================================================= */
const ACTION_LABEL = {
  pre_stock: 'Pre-stock', endcap: 'Endcap', cold_box: 'Cold box', bundle: 'Bundle',
  markdown: 'Markdown', reorder: 'Reorder', liquidate: 'Liquidate', promote: 'Promote',
  stock_new: 'Stock new',
};

/* =============================================================================
   PRIORITY LEVEL - one derivation, used by every surface that shows a badge
   -----------------------------------------------------------------------------
   Read off the model's OWN ordering rather than invented from confidence: rank
   is what the recommender actually sorted by, so a badge that disagrees with
   the list order would be lying about the list. Confidence only breaks the tie
   at the boundary, where a weakly-held #3 should not outrank a certain #4.
   ============================================================================= */
export const PRIORITY_LEVELS = {
  critical: { key: 'critical', label: 'Critical', tone: 'fuchsia' },
  high: { key: 'high', label: 'High', tone: 'violet' },
  medium: { key: 'medium', label: 'Medium', tone: 'cyan' },
};

export function priorityOf(rec) {
  const rank = Number(rec?.rank ?? 99);
  const conf = Number(rec?.confidence ?? 0);
  if (rank <= 2 && conf >= 0.5) return PRIORITY_LEVELS.critical;
  if (rank <= 2) return PRIORITY_LEVELS.high;
  if (rank <= 5) return conf >= 0.7 ? PRIORITY_LEVELS.high : PRIORITY_LEVELS.medium;
  return PRIORITY_LEVELS.medium;
}

/* =============================================================================
   KPI GRID - six tiles, 3x2
   -----------------------------------------------------------------------------
   Six in the footprint four used to occupy. The four were stretched to fill the
   row beside the task queue, which opened a band of dead space inside each one;
   two more tiles use that height to say something instead of padding it.
   The additions are the two money questions the rest of the grid does not
   answer - what a restock would COST, and what being out of stock is COSTING -
   read from the buying capability that already computes both, so the dashboard
   and the Buying Report can never quote different figures.
   ============================================================================= */
export function KpiGrid({ kpis = {}, inventory = {}, revenueTrend, onOpen, apiUrl, authToken }) {
  const buying = useBuyingTotals(apiUrl, authToken);
  const reorder = (kpis.outOfStock || 0) + (kpis.negativeStock || 0) + (kpis.lowStock || 0);

  // Latest day against the 30-day average already on the page - a real
  // comparison, not a projection.
  const trend = Array.isArray(revenueTrend) ? revenueTrend : [];
  const avg = trend.length >= 2
    ? trend.reduce((sum, r) => sum + Number(r.revenue || 0), 0) / trend.length
    : null;
  const delta = avg && avg > 0 ? ((Number(kpis.revenue || 0) - avg) / avg) * 100 : null;
  const marginKnown = kpis.grossMarginPct != null;

  const tiles = [
    {
      key: 'revenue',
      tone: 'violet',
      icon: <DollarSign size={14} />,
      label: 'Total Sales',
      value: money(kpis.revenue),
      note: `${num(kpis.transactions)} transactions · latest trading day`,
      delta,
      target: 'reports',
    },
    {
      key: 'stock',
      tone: 'cyan',
      icon: <Package size={14} />,
      label: 'Products in Stock',
      value: num(kpis.totalProducts),
      note: `active SKUs · ${moneyShort(inventory?.costValue || 0)} on the shelf`,
      target: 'reports',
    },
    {
      key: 'margin',
      tone: 'jade',
      icon: <Percent size={14} />,
      label: 'Gross Margin',
      value: marginKnown ? `${Number(kpis.grossMarginPct).toFixed(1)}%` : 'No data',
      note: marginKnown
        ? (kpis.grossMarginSource === 'store_intelligence' ? 'last 90 days · where cost is known' : 'overall')
        : 'product cost not recorded',
      target: 'reports',
    },
    {
      key: 'reorder',
      tone: 'fuchsia',
      icon: <AlertTriangle size={14} />,
      label: 'Reorder Needed',
      value: num(reorder),
      note: `${num(kpis.outOfStock)} out of stock · ${num(kpis.negativeStock)} negative · ${num(kpis.lowStock)} low`,
      urgent: reorder > 0,
      // Drill-down: land on the Buying report's Suggested Reorder section - the
      // detailed, pre-filtered list of exactly the SKUs that need reordering.
      target: 'suggestions',
      saTab: 'buying',
      saSection: 'reorder',
      hint: 'View the items that need reordering',
    },
    {
      key: 'upside',
      tone: 'jade',
      icon: <TrendingUp size={14} />,
      label: 'Stocking Upside',
      // Revenue being lost to proven sellers sitting out of stock - what
      // restocking them is worth. Never rendered as $0 before the capability
      // has run: "unknown" and "nothing" are different answers.
      value: buying.upside != null ? moneyShort(buying.upside) : 'No data',
      note: buying.status === 'ready'
        ? `revenue potential · ${num(buying.stockoutSkus)} fast movers out of stock`
        : buying.status === 'loading' ? 'reading the buying report…' : 'buying report not computed yet',
      // Drill-down: the Buying report's Lost Revenue section - the fast movers
      // that are out of stock and what the missed sales are worth.
      target: 'suggestions',
      saTab: 'buying',
      saSection: 'lost',
      hint: 'See the revenue you are leaving on the table',
    },
    {
      key: 'purchase',
      tone: 'violet',
      icon: <ShoppingCart size={14} />,
      label: 'Recommended Purchase',
      value: buying.buyValue != null ? moneyShort(buying.buyValue) : 'No data',
      note: buying.status === 'ready'
        ? `cost · ${num(buying.buySkus)} SKUs · ${num(buying.buyUnits)} units`
        : buying.status === 'loading' ? 'reading the buying report…' : 'buying report not computed yet',
      // Drill-down: the Buying report's Suggested Reorder section - the exact
      // SKUs, quantities and cost behind this purchase figure.
      target: 'suggestions',
      saTab: 'buying',
      saSection: 'reorder',
      hint: 'See the full purchase order breakdown',
    },
  ];

  // Drill-down: route a KPI to the screen that details it, and where that
  // screen is the StoreAgent Buying report, deep-link to the exact section so
  // the destination arrives PRE-FILTERED (e.g. "Reorder Needed" lands on the
  // Suggested Reorder list). The sessionStorage handshake is the same one the
  // "Market analysis" button already uses; RecommendationsView opens the
  // Store-Intelligence sub-tab, StoreAgentPanel selects the capability, and
  // Buying.js selects the section - all reading these one-shot keys.
  const drillTo = (t) => {
    if (!onOpen) return;
    if (t.saTab) {
      try {
        sessionStorage.setItem('botella_open_storeagent', '1');
        sessionStorage.setItem('botella_storeagent_tab', t.saTab);
        if (t.saSection) sessionStorage.setItem('botella_storeagent_section', t.saSection);
      } catch { /* sessionStorage unavailable - still navigate to the tab */ }
    }
    // 'reports' is the view key StatisticsPage is mounted under. Three tiles
    // and this default said 'statistics', which is not in ChatPage's
    // VALID_VIEWS and is not handled anywhere - so Revenue, Orders and Gross
    // Margin were buttons that did nothing when clicked. That is what made the
    // row read as static text: half of it was.
    onOpen(t.target || 'reports');
  };

  return (
    <div className="dp-kpi-col">
      <div className="dp-kpi-grid">
        {tiles.map((t, i) => (
          <button
            type="button"
            key={t.key}
            className={`dp-kpi glass glass-hover dp-tone-${t.tone} ${t.urgent ? 'is-urgent' : ''}`}
            style={{ animationDelay: `${i * 55}ms` }}
            onClick={() => drillTo(t)}
            title={t.hint || 'Open full statistics'}
            aria-label={`${t.label}: ${t.hint || 'open detail'}`}
          >
            <span className="dp-kpi-jump"><ArrowUpRight size={15} /></span>
            <span className="dp-kpi-value">{t.value}</span>
            <span className="dp-kpi-label">{t.icon}<span>{t.label}</span></span>
            <span className="dp-kpi-foot">
              {t.delta != null && (
                <span className={`dp-delta ${t.delta >= 0 ? 'is-up' : 'is-down'}`}>
                  {t.delta >= 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                  {Math.abs(t.delta).toFixed(0)}% vs 30-day avg
                </span>
              )}
              <span className="dp-kpi-note">{t.note}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* =============================================================================
   REVIEW CTA - the hand-off into the recommendations page
   -----------------------------------------------------------------------------
   Rendered at the FOOT of the recommendations section rather than under the KPI
   grid. It is the "now go do something about all that" button, so it reads as
   an answer to the recommendations above it rather than as a caption on the
   numbers it used to sit beneath.
   ============================================================================= */
export function ReviewCta({ onReview }) {
  return (
    <button type="button" className="dp-review-cta" onClick={onReview}>
      <Sparkles size={14} />
      <span>Review all recommendations</span>
      <ArrowRight size={14} className="dp-review-cta-go" />
    </button>
  );
}

/* =============================================================================
   TASKS BY PRIORITY - how big the queue is, and the three at the front of it
   -----------------------------------------------------------------------------
   The dashboard's job is to say how much is waiting and what to start with, so
   this shows the TOTAL and then only the top three. Everything else is one
   click away on the Recommendations page rather than scrolled past here.
   ============================================================================= */
function TaskRow({ rec, index, onTakeAction, onSave, saved }) {
  const priority = priorityOf(rec);
  const products = (rec.products && rec.products.length
    ? rec.products
    : (rec.primary_skus || []).map((sku) => ({ sku, product_name: null })));
  const lead = products[0] || {};
  const leadName = lead.product_name || lead.sku || 'this product';
  const action = ACTION_LABEL[rec.action_type] || rec.action_type || 'Act';

  return (
    <li className={`dp-task dp-tone-${priority.tone}`} style={{ animationDelay: `${index * 70}ms` }}>
      <span className="dp-task-rank" aria-hidden="true">{index + 1}</span>
      <div className="dp-task-card glass">
        <div className="dp-task-head">
          <div className="dp-task-title">
            <span className="dp-task-action">{action}</span>
            <span className="dp-task-name">{trim(leadName, 44)}</span>
          </div>
          <span className={`dp-task-badge dp-tone-${priority.tone}`}>
            <AlertTriangle size={11} /> {priority.label}
          </span>
        </div>
        <p className="dp-task-why">{firstSentence(rec.rationale)}</p>
        <div className="dp-task-actions">
          <button
            type="button"
            className="app-btn app-btn-primary dp-task-go"
            onClick={() => onTakeAction(rec, leadName)}
          >
            <Sparkles size={13} />
            <span>Take action</span>
          </button>
          <button
            type="button"
            className={`app-btn dp-task-save ${saved ? 'is-saved' : ''}`}
            onClick={() => onSave(rec, leadName, priority)}
            disabled={saved}
          >
            {saved ? <><Check size={13} /> In tasklist</> : <><ListChecks size={13} /> Add to tasklist</>}
          </button>
        </div>
      </div>
    </li>
  );
}

export function TasksByPriority({ authToken, apiUrl, onSeeAll, onSnapshot, onTakeAction }) {
  const [state, setState] = useState({ status: 'loading', recs: [], total: 0, run: null });
  const [onlyHigh, setOnlyHigh] = useState(false);
  const [tasks, setTasks] = useState(() => listTasks());

  useEffect(() => subscribeTasks(setTasks), []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const json = await authedJson(apiUrl, '/api/recommendations/latest', authToken);
        if (!alive || !json) return;
        const all = (json.recommendations || []).slice().sort((a, b) => (a.rank || 99) - (b.rank || 99));
        setState({ status: 'ready', recs: all, total: all.length, run: json.run || null });
        if (onSnapshot) onSnapshot(json.run?.signal_snapshot || null);
      } catch {
        if (alive) setState({ status: 'error', recs: [], total: 0, run: null });
      }
    })();
    return () => { alive = false; };
  }, [authToken, apiUrl, onSnapshot]);

  const highCount = useMemo(
    () => state.recs.filter((r) => priorityOf(r).key !== 'medium').length,
    [state.recs],
  );
  // Two, not three. The panel is height-matched to the KPI column beside it, and
  // three cards did not fit that height without clipping the last one - a card
  // sliced in half reads as a bug, not as "there is more". The count line above
  // already states the size of the whole queue and "See all" opens it.
  const shown = useMemo(() => {
    const pool = onlyHigh ? state.recs.filter((r) => priorityOf(r).key !== 'medium') : state.recs;
    return pool.slice(0, 2);
  }, [state.recs, onlyHigh]);

  const handleSave = useCallback((rec, title, priority) => {
    addTask(rec, { title, priority: priority.key });
  }, []);

  return (
    <Panel
      className="dp-tasks"
      tone="violet"
      kicker="Priority Actions"
      icon={<Sparkles size={16} />}
      title="Tasks by Priority"
      meta={state.run?.generated_at ? `Generated ${shortDate(state.run.generated_at)}` : null}
      action={
        <>
          <button
            type="button"
            className={`app-btn dp-task-filter ${onlyHigh ? 'is-on' : ''}`}
            onClick={() => setOnlyHigh((v) => !v)}
            aria-pressed={onlyHigh}
            title={onlyHigh ? 'Showing high priority only' : 'Showing all priorities'}
          >
            <SlidersHorizontal size={14} />
            <span>{onlyHigh ? 'High priority' : 'Filter'}</span>
          </button>
          {state.total > 0 && (
            <button type="button" className="app-btn dp-task-all" onClick={onSeeAll}>
              See all {num(state.total)} <ArrowUpRight size={13} />
            </button>
          )}
        </>
      }
    >
      {state.status === 'loading' && (
        <div className="dp-empty"><Loader size={16} className="dp-spin" /> Reading your store…</div>
      )}
      {state.status === 'error' && (
        <div className="dp-empty">Recommendations are unavailable right now.</div>
      )}
      {state.status === 'ready' && state.total === 0 && (
        <div className="dp-empty">
          No recommendations yet. They are generated once your store data has been analysed.
        </div>
      )}

      {state.status === 'ready' && state.total > 0 && (
        <>
          {/* The count line: the whole queue, then how much of it is urgent. */}
          <div className="dp-task-count">
            <span className="dp-task-count-total">{num(state.total)}</span>
            <span className="dp-task-count-word">
              {state.total === 1 ? 'task in the list' : 'tasks in the list'}
            </span>
            <span className="dp-task-count-split">
              <span className="dp-task-count-high">{num(highCount)} high priority</span>
              {tasks.length > 0 && (
                <span className="dp-task-count-saved">{num(tasks.length)} saved</span>
              )}
            </span>
          </div>

          {shown.length === 0 ? (
            <div className="dp-empty">Nothing at high priority right now.</div>
          ) : (
            <ol className="dp-task-list">
              {shown.map((rec, i) => (
                <TaskRow
                  key={rec.id ?? i}
                  rec={rec}
                  index={i}
                  saved={tasks.some((t) => t.id === `rec:${rec.id}`) || isSaved(rec)}
                  onSave={handleSave}
                  onTakeAction={onTakeAction}
                />
              ))}
            </ol>
          )}

        </>
      )}
    </Panel>
  );
}


/* =============================================================================
   RECOMMENDATIONS - the full cards, on the dashboard
   -----------------------------------------------------------------------------
   The task queue beside this says WHICH things are waiting; this says what each
   one actually is, in the shape the Recommendations page uses: the headline and
   its status, the reasoning, one line of advice, and a rail of actions.
   Three at a time, because the dashboard is a starting point rather than the
   whole list - the rest is a page away.
   ============================================================================= */
const PAGE_SIZE = 3;

// The status phrase beside a product name. Derived from the action the model
// chose, so it always agrees with the button underneath it.
const STATUS_PHRASE = {
  reorder: 'Needs restocking',
  pre_stock: 'Needs pre-stocking',
  liquidate: 'Needs clearing',
  markdown: 'Markdown needed',
  promote: 'Promotion needed',
  endcap: 'Endcap placement',
  cold_box: 'Cold box placement',
  bundle: 'Bundle opportunity',
  stock_new: 'Worth stocking',
};

// The urgency line in the advice bar, read off how long the call stays valid
// rather than asserted.
function adviceFor(rec) {
  const through = rec?.valid_through ? new Date(rec.valid_through) : null;
  if (!through || Number.isNaN(through.getTime())) {
    return 'We suggest you take necessary actions for this';
  }
  const days = Math.ceil((through - new Date()) / 86400000);
  if (days < 0) return 'This one has expired - check it is still worth doing';
  if (days <= 1) return 'Today is the last day this still applies';
  if (days <= 3) return `Worth doing in the next ${days} days`;
  return `Can be done within ${days} days, but sooner is better`;
}

function toCsv(recs) {
  // The Confidence column rides on SHOW_CARD_CONFIDENCE (features.js): the
  // export is the owner's copy of the screen, and a percentage the screen
  // withholds must not reappear in the spreadsheet.
  const head = ['Rank', 'Priority', 'Action', 'Product', 'Status',
    ...(SHOW_CARD_CONFIDENCE ? ['Confidence'] : []), 'Valid through', 'Why'];
  const cell = (v) => {
    const t = v == null ? '' : String(v);
    // Quote everything and double any embedded quote - product names carry
    // commas and quotation marks often enough that this is not optional.
    return `"${t.replace(/"/g, '""')}"`;
  };
  const rows = recs.map((r) => {
    const lead = (r.products && r.products[0]) || {};
    return [
      r.rank ?? '',
      priorityOf(r).label,
      ACTION_LABEL[r.action_type] || r.action_type || '',
      lead.product_name || lead.sku || '',
      STATUS_PHRASE[r.action_type] || 'Needs attention',
      ...(SHOW_CARD_CONFIDENCE
        ? [r.confidence != null ? `${Math.round(r.confidence * 100)}%` : '']
        : []),
      r.valid_through || '',
      r.rationale || '',
    ].map(cell).join(',');
  });
  return [head.map(cell).join(','), ...rows].join('\r\n');
}

function RecCard({ rec, index, onExecute, onAskMore }) {
  const priority = priorityOf(rec);
  const products = (rec.products && rec.products.length
    ? rec.products
    : (rec.primary_skus || []).map((sku) => ({ sku, product_name: null })));
  const lead = products[0] || {};
  const leadName = lead.product_name || lead.sku || 'this product';
  const status = STATUS_PHRASE[rec.action_type] || 'Needs attention';
  const [saved, setSaved] = useState(() => isSaved(rec));

  return (
    <article className={`dp-reccard glass dp-tone-${priority.tone}`} style={{ animationDelay: `${index * 70}ms` }}>
      <div className="dp-reccard-main">
        <h4 className="dp-reccard-title">
          {trim(leadName, 46)}
          <span className="dp-reccard-status"> · {status}</span>
        </h4>
        <p className="dp-reccard-why">{rec.rationale}</p>

        {/* The advice bar: one line of counsel, and a way to ask for the rest. */}
        <div className="dp-reccard-advice">
          <Sparkles size={14} className="dp-reccard-advice-icon" />
          <span className="dp-reccard-advice-text">{adviceFor(rec)}</span>
          <button
            type="button"
            className="dp-reccard-more"
            onClick={() => onAskMore(rec, leadName)}
          >
            Ask for more
          </button>
        </div>
      </div>

      <div className="dp-reccard-rail">
        <button
          type="button"
          className="app-btn app-btn-primary dp-reccard-exec"
          onClick={() => onExecute(rec, leadName)}
          title="Opens a new chat that walks through how to carry this out"
        >
          <Sparkles size={13} />
          <span>Ask AI how to execute</span>
        </button>
        <span className={`dp-reccard-priority dp-tone-${priority.tone}`}>
          <AlertTriangle size={12} /> Priority level: {priority.label}
        </span>
        <button
          type="button"
          className={`dp-reccard-task ${saved ? 'is-saved' : ''}`}
          onClick={() => { addTask(rec, { title: leadName, priority: priority.key }); setSaved(true); }}
          disabled={saved}
        >
          {saved ? <><Check size={13} /> In tasklist</> : <><ListChecks size={13} /> Add to Tasklist</>}
        </button>
      </div>
    </article>
  );
}

export function DashRecommendations({ authToken, apiUrl, onSeeAll, onExecute, onAskMore }) {
  const [state, setState] = useState({ status: 'loading', recs: [] });
  const [page, setPage] = useState(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const json = await authedJson(apiUrl, '/api/recommendations/latest', authToken);
        if (!alive || !json) return;
        const recs = (json.recommendations || []).slice().sort((a, b) => (a.rank || 99) - (b.rank || 99));
        setState({ status: 'ready', recs });
      } catch {
        if (alive) setState({ status: 'error', recs: [] });
      }
    })();
    return () => { alive = false; };
  }, [authToken, apiUrl]);

  const pages = Math.max(1, Math.ceil(state.recs.length / PAGE_SIZE));
  const shown = useMemo(
    () => state.recs.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE),
    [state.recs, page],
  );

  const downloadCsv = useCallback(() => {
    // A BOM so Excel opens the UTF-8 correctly rather than mangling accents.
    const blob = new Blob(['\ufeff' + toCsv(state.recs)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'botella-recommendations.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [state.recs]);

  return (
    <section className="dp-recs">
      <header className="dp-recs-head">
        <span className="app-kicker dp-kicker">
          <Lightbulb size={12} /> Recommendations
        </span>
        <h3>These recommendations need your attention</h3>
      </header>

      {state.status === 'loading' && (
        <div className="dp-empty"><Loader size={16} className="dp-spin" /> Reading your store…</div>
      )}
      {state.status === 'error' && (
        <div className="dp-empty">Recommendations are unavailable right now.</div>
      )}
      {state.status === 'ready' && state.recs.length === 0 && (
        <div className="dp-empty">
          No recommendations yet. They are generated once your store data has been analysed.
        </div>
      )}

      {state.status === 'ready' && state.recs.length > 0 && (
        <>
          <div className="dp-recs-list">
            {shown.map((rec, i) => (
              <RecCard
                key={rec.id ?? `${page}-${i}`}
                rec={rec}
                index={i}
                onExecute={onExecute}
                onAskMore={onAskMore}
              />
            ))}
          </div>

          <footer className="dp-recs-foot">
            <button type="button" className="app-btn dp-recs-csv" onClick={downloadCsv}>
              <Download size={14} /> Download CSV
            </button>
            <span className="dp-recs-count">
              Showing {shown.length} out of {num(state.recs.length)}
            </span>
            <button type="button" className="app-btn dp-recs-all" onClick={onSeeAll}>Show all</button>
            {pages > 1 && (
              <div className="dp-recs-dots" role="tablist" aria-label="Recommendation pages">
                {Array.from({ length: pages }, (_, i) => (
                  <button
                    key={i}
                    type="button"
                    role="tab"
                    aria-selected={i === page}
                    aria-label={`Page ${i + 1} of ${pages}`}
                    className={`dp-recs-dot ${i === page ? 'is-on' : ''}`}
                    onClick={() => setPage(i)}
                  />
                ))}
              </div>
            )}
          </footer>
        </>
      )}
    </section>
  );
}

/* =============================================================================
   STORE INTELLIGENCE - the scroll feed beside the priorities
   -----------------------------------------------------------------------------
   Three streams, deliberately short. Every card is a headline plus one line of
   consequence; anything longer sits behind its own "Detail" toggle. The point
   is that an owner can read the whole column in fifteen seconds and know
   whether anything needs them.
   ============================================================================= */
function FeedCard({ tone, icon, kind, title, line, detail, when }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`dp-feed-card dp-tone-${tone}`}>
      <div className="dp-feed-top">
        <span className="dp-feed-icon">{icon}</span>
        <span className="dp-feed-kind">{kind}</span>
        {when && <span className="dp-feed-when">{when}</span>}
      </div>
      <div className="dp-feed-title">{title}</div>
      {line && <div className="dp-feed-line">{line}</div>}
      {detail && (
        <>
          <button type="button" className="dp-feed-more" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? 'Hide' : 'Detail'} <ChevronDown size={11} className={open ? 'dp-chev is-open' : 'dp-chev'} />
          </button>
          {open && <div className="dp-feed-detail">{detail}</div>}
        </>
      )}
    </li>
  );
}

export function StoreIntelligence({ authToken, apiUrl, dashboard, snapshot, onOpenMarket, onAsk }) {
  const [brief, setBrief] = useState({ status: 'loading', data: null });
  const [tab, setTab] = useState('all');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const json = await authedJson(apiUrl, '/api/summary', authToken);
        if (alive && json) setBrief({ status: 'ready', data: json });
      } catch {
        if (alive) setBrief({ status: 'error', data: null });
      }
    })();
    return () => { alive = false; };
  }, [authToken, apiUrl]);

  /* ── Daily brief: the latest trading day, straight from /api/summary ── */
  const briefCards = useMemo(() => {
    const s = brief.data?.sales;
    if (!s) return [];
    const out = [];
    out.push({
      tone: 'violet',
      icon: <CalendarDays size={13} />,
      kind: 'Daily brief',
      when: shortDate(s.date),
      title: `${money(s.total_revenue)} across ${num(s.total_transactions)} sales`,
      line: `${num(s.total_units)} units moved.`,
      detail: s.top_products?.length ? (
        <ul className="dp-mini-list">
          {s.top_products.slice(0, 5).map((p, i) => (
            <li key={i}>
              <span>{trim(p.name || p.product_name, 34)}</span>
              <span>{money(p.revenue)}</span>
            </li>
          ))}
        </ul>
      ) : null,
    });
    if (Array.isArray(brief.data?.slow_inventory) && brief.data.slow_inventory.length) {
      const slow = brief.data.slow_inventory;
      out.push({
        tone: 'fuchsia',
        icon: <Package size={13} />,
        kind: 'Daily brief',
        title: `${num(slow.length)} products are not moving`,
        line: 'Sitting on the shelf without recent sales.',
        detail: (
          <ul className="dp-mini-list">
            {slow.slice(0, 5).map((p, i) => (
              <li key={i}>
                <span>{trim(p.name || p.product_name, 34)}</span>
                <span>{p.on_hand != null ? `${num(p.on_hand)} on hand` : ''}</span>
              </li>
            ))}
          </ul>
        ),
      });
    }
    return out;
  }, [brief.data]);

  /* ── P&L: computed from the dashboard payload already on the page ───── */
  const pnlCards = useMemo(() => {
    if (!dashboard) return [];
    const cats = dashboard.categoryBreakdown || [];
    const inv = dashboard.inventory || {};
    const marginKnown = dashboard.kpis?.grossMarginPct != null;
    const out = [];

    if (marginKnown && cats.length) {
      const profit = cats.reduce((s, c) => s + Number(c.profit || 0), 0);
      const revenue = cats.reduce((s, c) => s + Number(c.revenue || 0), 0);
      const ranked = [...cats].sort((a, b) => (b.profit || 0) - (a.profit || 0));
      const best = ranked[0];
      const worst = ranked[ranked.length - 1];
      out.push({
        tone: 'jade',
        icon: <TrendingUp size={13} />,
        kind: 'P&L',
        when: dashboard.panelsWindow?.label || null,
        title: `${moneyShort(profit)} gross profit on ${moneyShort(revenue)}`,
        line: best ? `${trim(best.category, 26)} earns the most of it.` : null,
        detail: (
          <ul className="dp-mini-list">
            {ranked.slice(0, 5).map((c, i) => (
              <li key={i}>
                <span>{trim(c.category, 30)}</span>
                <span>{money(c.profit)}</span>
              </li>
            ))}
            {worst && ranked.length > 5 && (
              <li className="is-weak">
                <span>Weakest: {trim(worst.category, 24)}</span>
                <span>{money(worst.profit)}</span>
              </li>
            )}
          </ul>
        ),
      });
    } else {
      out.push({
        tone: 'muted',
        icon: <Percent size={13} />,
        kind: 'P&L',
        title: 'Profit cannot be computed yet',
        line: 'Product cost is not recorded for this store, so margin is unknown.',
      });
    }

    if (inv.retailValue) {
      const spread = Number(inv.retailValue || 0) - Number(inv.costValue || 0);
      out.push({
        tone: 'cyan',
        icon: <Boxes size={13} />,
        kind: 'P&L',
        title: `${moneyShort(inv.costValue)} of stock at cost`,
        line: `${moneyShort(spread)} of margin sits unsold on the shelf.`,
        detail: (
          <ul className="dp-mini-list">
            <li><span>Retail value</span><span>{money(inv.retailValue)}</span></li>
            <li><span>Cost value</span><span>{money(inv.costValue)}</span></li>
            <li><span>Unrealised margin</span><span>{money(spread)}</span></li>
          </ul>
        ),
      });
    }

    const over = inv.overstocked || [];
    if (over.length) {
      const tied = over.reduce((s, o) => s + Number(o.tiedUp || 0), 0);
      out.push({
        tone: 'fuchsia',
        icon: <AlertTriangle size={13} />,
        kind: 'P&L',
        title: `${moneyShort(tied)} tied up in overstock`,
        line: `${num(over.length)} products carry more cover than they need.`,
        detail: (
          <ul className="dp-mini-list">
            {over.slice(0, 5).map((o, i) => (
              <li key={i}><span>{trim(o.name, 32)}</span><span>{money(o.tiedUp)}</span></li>
            ))}
          </ul>
        ),
      });
    }
    return out;
  }, [dashboard]);

  /* ── Market: the run's own signal snapshot, not a separate feed ─────── */
  const marketCards = useMemo(() => {
    const s = snapshot || {};
    const out = [];
    if (s.weather?.summary) {
      const hi = s.weather.high_f != null ? `${Math.round(s.weather.high_f)}°` : null;
      out.push({
        tone: 'cyan',
        icon: <CloudSun size={13} />,
        kind: 'Market',
        title: s.weather.summary,
        line: hi ? `Peak ${hi} this week${s.weather.high_date ? ` on ${shortDate(s.weather.high_date)}` : ''}.` : null,
      });
    }
    (s.holidays || []).slice(0, 2).forEach((h) => out.push({
      tone: 'violet',
      icon: <CalendarDays size={13} />,
      kind: 'Market',
      when: shortDate(h.date),
      title: h.name,
      line: 'Holiday demand window opening.',
    }));
    (s.sports || []).filter((g) => g.is_local_home).slice(0, 2).forEach((g) => out.push({
      tone: 'jade',
      icon: <Trophy size={13} />,
      kind: 'Market',
      when: shortDate(g.date),
      title: `${g.away} @ ${g.home}`,
      line: g.games > 1 ? `${g.games}-game home series.` : 'Home game - local footfall.',
    }));
    (s.events || []).slice(0, 3).forEach((e) => out.push({
      tone: 'fuchsia',
      icon: <MapPin size={13} />,
      kind: 'Market',
      when: shortDate(e.date),
      title: e.name,
      line: e.note || (e.draw === 'major' ? 'Major local draw.' : 'Local event nearby.'),
    }));
    (s.social || []).slice(0, 3).forEach((t) => out.push({
      tone: 'fuchsia',
      icon: <Flame size={13} />,
      kind: 'Market',
      title: `${t.term} is trending`,
      line: t.note || 'Rising interest in your area.',
    }));
    const news = (s.news || []).filter((n) => n.impact);
    (news.length ? news : (s.news || []).slice(0, 2)).slice(0, 3).forEach((n) => out.push({
      tone: 'cyan',
      icon: <Newspaper size={13} />,
      kind: 'Market',
      title: trim(n.headline, 90),
      line: n.note || null,
    }));
    return out;
  }, [snapshot]);

  const groups = { brief: briefCards, pnl: pnlCards, market: marketCards };
  const all = [...briefCards, ...pnlCards, ...marketCards];
  const shown = tab === 'all' ? all : (groups[tab] || []);

  const TABS = [
    ['all', 'All', all.length],
    ['brief', 'Brief', briefCards.length],
    ['pnl', 'P&L', pnlCards.length],
    ['market', 'Market', marketCards.length],
  ];

  return (
    <Panel
      className="dp-si"
      kicker="Store Intelligence"
      icon={<Radar size={16} />}
      title="Recent Changes"
      action={
        <button type="button" className="app-btn" onClick={onOpenMarket}>
          Market analysis <ArrowUpRight size={13} />
        </button>
      }
    >
      <div className="dp-si-tabs" role="tablist">
        {TABS.map(([k, label, count]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            className={`dp-si-tab ${tab === k ? 'is-on' : ''}`}
            onClick={() => setTab(k)}
            disabled={count === 0 && k !== 'all'}
          >
            {label}<em>{count}</em>
          </button>
        ))}
      </div>

      <ul className="dp-feed si-feed app-scroll">
        {brief.status === 'loading' && shown.length === 0 && (
          <li className="dp-empty"><Loader size={15} className="dp-spin" /> Gathering signals…</li>
        )}
        {brief.status !== 'loading' && shown.length === 0 && (
          <li className="dp-empty">Nothing new in this stream.</li>
        )}
        {shown.map((c, i) => <FeedCard key={`${c.kind}-${i}`} {...c} />)}
      </ul>

      <button type="button" className="dp-si-ask app-btn" onClick={onAsk}>
        Ask Botella about this <ArrowUpRight size={13} />
      </button>
    </Panel>
  );
}

export default Panel;
