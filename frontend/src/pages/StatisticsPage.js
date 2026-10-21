// StatisticsPage.js
// -----------------------------------------------------------------------------
// The evidence, given a page of its own - redesigned to the "elite" layout:
// a KPI row, three charts (revenue trend, money-source donut, category
// performance), a top-products table and a store-intelligence "what changed"
// panel, closing on a single call-to-action into Recommendations.
//
// Everything reads the SAME /api/dashboard payload the dashboard already
// fetches - no new endpoint, no second source of truth, no invented numbers.
// Where the mockup showed placeholder people ("Recent Buyers"), we show the
// real thing the payload actually carries (top products), because the payload
// has no customer identity to honestly fill that table with.
//
// Palette: none of its own. StatisticsPage.css aliases onto the shared app
// tokens, and the charts draw from components/chartTheme.js - the validated
// brand ramp every other chart in the product uses. Reports used to carry a
// private blue + teal palette on its own near-black ground, which is why it
// read as a different product from the screens either side of it.
// -----------------------------------------------------------------------------

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  BarChart, Bar, PieChart, Pie, Cell, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { DollarSign, Package, Percent, ShoppingBasket, AlertTriangle, Download, Store, BarChart3 } from 'lucide-react';
import { formatLocalDate } from '../utils/date';
import { useChartTheme, sliceStep } from '../components/chartTheme';
import './StatisticsPage.css';
import { useTablePage } from '../utils/useTablePage';
import TablePager from '../components/TablePager';
import MetricInfo from '../components/MetricInfo';
import { useCellTitles } from '../utils/useCellTitles';

/* ── Chart colour ───────────────────────────────────────────────────
   Recharts needs literal colours, so they cannot come from CSS variables.
   They come from chartTheme.js instead - the brand ramp that is already
   validated for lightness band, chroma floor, CVD separation and contrast in
   BOTH registers, and which re-renders itself when the theme flips. This page
   used to hardcode a blue/teal ramp that did none of that and matched nothing
   else in the product. */

/* ── Formatters ──────────────────────────────────────────────────────────── */
const fmtMoney = (v) =>
  '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtMoney0 = (v) =>
  '$' + Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const fmtNum = (v) => Number(v || 0).toLocaleString('en-US');
const fmtCompactMoney = (v) => {
  const n = Number(v || 0);
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
};
const fmtAxisMoney = (v) => (Math.abs(v) >= 1000 ? `$${Math.round(v / 1000)}K` : `$${Math.round(v)}`);
const fmtShortDate = (d) => (d ? formatLocalDate(d, { month: 'short', day: 'numeric' }) : '');
const fmtDate = (d) => (d ? formatLocalDate(d, { month: 'long', day: 'numeric', year: 'numeric' }) : 'N/A');
const truncate = (s, n) => (!s ? '' : (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s)));

/* ── Chart tooltip ───────────────────────────────────────────────────────── */
function ChartTip({ active, payload, label, money = true, suffix = '', decimals = 0 }) {
  const rows = (payload || []).filter((e) => e.type !== 'none');
  if (!active || !rows.length) return null;
  return (
    <div className="sx-tip">
      {label != null && <div className="sx-tip-label">{label}</div>}
      {rows.map((e, i) => (
        <div key={i} className="sx-tip-row">
          <span className="sx-tip-dot" style={{ background: e.color || e.payload?.fill }} />
          <span className="sx-tip-name">{e.name}</span>
          <span className="sx-tip-val">
            {money ? '$' : ''}
            {Number(e.value).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
            {suffix}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── KPI card ────────────────────────────────────────────────────────────── */
function Kpi({ icon, label, value, delta, meta, tone = 'blue', delay = 0, info }) {
  const dir = delta == null ? null : delta >= 0 ? 'up' : 'down';
  return (
    <div className={`sx-kpi sx-tone-${tone}`} style={{ animationDelay: `${delay}ms` }}>
      <div className="sx-kpi-top">
        <span className="sx-kpi-label">{label}<MetricInfo label={label} info={info} /></span>
        <span className="sx-kpi-icon">{icon}</span>
      </div>
      <div className="sx-kpi-value">{value}</div>
      <div className="sx-kpi-foot">
        {dir && (
          <span className={`sx-badge sx-badge-${dir}`}>
            {dir === 'up' ? '+' : ''}{Math.round(delta)}%
          </span>
        )}
        {meta && <span className="sx-kpi-meta">{meta}</span>}
      </div>
    </div>
  );
}

/* ── Card shell ──────────────────────────────────────────────────────────── */
function Card({ title, kicker, actions, children, className = '', delay = 0, info }) {
  return (
    <section className={`sx-card ${className}`} style={{ animationDelay: `${delay}ms` }}>
      <header className="sx-card-head">
        <div className="sx-card-titles">
          {kicker && <span className="sx-kicker">{kicker}</span>}
          <h3 className="sx-card-title">{title}<MetricInfo label={title} info={info} /></h3>
        </div>
        {actions && <div className="sx-card-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

/* ── Segmented control (Revenue / Profit / Margin %) ─────────────────────── */
function Segmented({ options, value, onChange, label }) {
  return (
    <div className="sx-seg" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="tab"
          aria-selected={value === o.key}
          className={`sx-seg-btn ${value === o.key ? 'is-on' : ''}`}
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* A summary stat under a chart. */
const Stat = ({ value, label }) => (
  <div className="sx-stat">
    <div className="sx-stat-value">{value}</div>
    <div className="sx-stat-label">{label}</div>
  </div>
);

const EMPTY = (msg) => <div className="sx-empty">{msg}</div>;

/* =============================================================================
   PAGE
   ============================================================================= */
export default function StatisticsPage({ authToken, apiUrl, onNavigate }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [measure, setMeasure] = useState('revenue');   // category performance
  const [range, setRange] = useState('30');            // revenue-trend window

  // Re-renders every chart on this page when the theme flips, so the marks are
  // always the cut validated against the register they are being drawn on.
  const chart = useChartTheme();
  // The category line carries ONE measure at a time, so its colour is identity,
  // not category: three adjacent slots from the same validated ramp rather than
  // a green/blue/red traffic light borrowed from nothing.
  const lineColor = measure === 'profit'
    ? chart.series[3]
    : measure === 'margin'
      ? chart.series[2]
      : chart.series[0];

  const fetchStats = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const base = (apiUrl || '').replace(/\/api\/?$/, '');
      const res = await fetch(`${base}/api/dashboard`, {
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
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message || 'Unable to load statistics. Please try again.');
      }
      setData(await res.json());
    } catch (err) {
      setError(err.message || 'Unable to load statistics. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [authToken, apiUrl]);

  useEffect(() => { if (authToken) fetchStats(); }, [authToken, fetchStats]);

  const kpis = data?.kpis || {};
  const inventory = data?.inventory || {};
  const alerts = data?.alerts || {};
  const categoryBreakdown = useMemo(() => data?.categoryBreakdown || [], [data]);
  const topProducts = useMemo(() => data?.topProducts || [], [data]);
  const panelsWindow = data?.panelsWindow?.label || null;
  const dataThrough = data?.latestSaleDate || data?.dataThrough || null;
  const profitAvailable = kpis.grossMarginPct != null;

  /* Revenue trend (windowed) + its summary stats. */
  const rawTrend = useMemo(() => data?.revenueTrend || [], [data]);
  const trend = useMemo(() => {
    const days = range === 'all' ? rawTrend.length : Number(range);
    return rawTrend.slice(-days).map((r) => ({ ...r, label: fmtShortDate(r.date) }));
  }, [rawTrend, range]);

  const trendStats = useMemo(() => {
    if (!trend.length) return null;
    const vals = trend.map((r) => Number(r.revenue || 0));
    const total = vals.reduce((a, b) => a + b, 0);
    const avg = total / vals.length;
    let peak = trend[0];
    trend.forEach((r) => { if (Number(r.revenue || 0) > Number(peak.revenue || 0)) peak = r; });
    return { total, avg, peak, multiple: avg > 0 ? Number(peak.revenue || 0) / avg : null };
  }, [trend]);

  /* Revenue delta: last half of the window vs the half before it. The only
     honest period-over-period we can derive from this payload. */
  const revenueDelta = useMemo(() => {
    if (rawTrend.length < 8) return null;
    const half = Math.floor(rawTrend.length / 2);
    const recent = rawTrend.slice(-half).reduce((s, r) => s + Number(r.revenue || 0), 0);
    const prior = rawTrend.slice(-half * 2, -half).reduce((s, r) => s + Number(r.revenue || 0), 0);
    if (!prior) return null;
    return ((recent - prior) / prior) * 100;
  }, [rawTrend]);

  /* Money-source donut: top slices + an aggregated "Other" tail. */
  const totalRevenue = useMemo(
    () => categoryBreakdown.reduce((s, c) => s + Number(c.revenue || 0), 0),
    [categoryBreakdown],
  );
  const pieData = useMemo(() => {
    const topN = categoryBreakdown.slice(0, 9).map((c) => ({ name: c.category, value: Number(c.revenue || 0) }));
    const otherRev = categoryBreakdown.slice(9).reduce((s, c) => s + Number(c.revenue || 0), 0);
    if (otherRev > 0) topN.push({ name: 'Other', value: otherRev });
    return topN.filter((s) => s.value > 0);
  }, [categoryBreakdown]);
  const topShare = pieData.length && totalRevenue ? (pieData[0].value / totalRevenue) * 100 : null;

  /* Category performance line: one measure at a time. */
  const perfData = useMemo(() => {
    const rows = categoryBreakdown.slice(0, 12).map((c) => ({
      category: c.category,
      revenue: Number(c.revenue || 0),
      profit: Number(c.profit || 0),
      margin: c.revenue ? (Number(c.profit || 0) / Number(c.revenue)) * 100 : 0,
    }));
    const key = measure === 'margin' ? 'margin' : measure;
    return rows.slice().sort((a, b) => b[key] - a[key]);
  }, [categoryBreakdown, measure]);

  // Across EVERY category, not just the twelve the line has room to draw. The
  // stat sits under a chart but describes the store, and a subtotal presented
  // as a total is how this card came to disagree with the donut beside it.
  const topPage = useTablePage(topProducts);
  // A tooltip on any cell whose text is clipped - measured, not guessed.
  useCellTitles(null, [data, topPage.page, measure]);


  const perfTotal = useMemo(() => {
    const rev = categoryBreakdown.reduce((s, c) => s + Number(c.revenue || 0), 0);
    const prof = categoryBreakdown.reduce((s, c) => s + Number(c.profit || 0), 0);
    if (measure === 'margin') return rev ? (prof / rev) * 100 : 0;
    return measure === 'profit' ? prof : rev;
  }, [categoryBreakdown, measure]);

  const PERF_OPTS = [
    { key: 'revenue', label: 'Revenue' },
    ...(profitAvailable ? [{ key: 'profit', label: 'Profit' }, { key: 'margin', label: 'Margin%' }] : []),
  ];

  /* Top products. The bar measures each row's units against the BEST-SELLING
     row, not against a total - so it is a "how close to the top seller" figure,
     not a share. The column is labelled and numbered accordingly; it used to be
     an unlabelled bar under a "Share" heading, which read as a share of total
     sales and was not one. */
  const maxUnits = useMemo(
    () => topProducts.reduce((m, p) => Math.max(m, Number(p.units || 0)), 0) || 1,
    [topProducts],
  );

  const exportCsv = useCallback(() => {
    const head = ['Rank', 'Product', 'Units', 'Revenue'];
    const lines = topProducts.map((p, i) =>
      [i + 1, `"${String(p.name || '').replace(/"/g, '""')}"`, p.units || 0, (p.revenue || 0).toFixed(2)].join(','));
    const blob = new Blob(['﻿' + [head.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'botella-top-products.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [topProducts]);

  /* ── Loading / error ─────────────────────────────────────────────────── */
  if (loading && !data) {
    return (
      <div className="sx-page">
        <div className="sx-head">
          <div className="sx-skel" style={{ width: 180, height: 24 }} />
          <div className="sx-skel" style={{ width: 220, height: 13, marginTop: 8 }} />
        </div>
        <div className="sx-kpi-row">
          {[0, 1, 2, 3].map((i) => <div key={i} className="sx-kpi"><div className="sx-skel" style={{ width: '70%', height: 14 }} /><div className="sx-skel" style={{ width: '50%', height: 30, marginTop: 16 }} /><div className="sx-skel" style={{ width: '40%', height: 12, marginTop: 16 }} /></div>)}
        </div>
        <div className="sx-row-3">
          {[0, 1, 2].map((i) => <div key={i} className="sx-card"><div className="sx-skel" style={{ width: '55%', height: 16 }} /><div className="sx-skel" style={{ width: '100%', height: 220, marginTop: 18, borderRadius: 12 }} /></div>)}
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="sx-page">
        <div className="sx-error">
          <AlertTriangle size={18} />
          <span>{error}</span>
          <button type="button" onClick={fetchStats}>Retry</button>
        </div>
      </div>
    );
  }

  const marginValue = profitAvailable ? `${Number(kpis.grossMarginPct).toFixed(1)}%` : 'No data';

  return (
    <div className="sx-page">
      <div className="sx-head">
        <div>
          <h1 className="sx-title"><BarChart3 size={20} /> Reports</h1>
          <p className="sx-sub">
            {panelsWindow ? `${panelsWindow} · ` : ''}
            {dataThrough ? `Data through ${fmtDate(dataThrough)}` : 'Your store, measured'}
          </p>
        </div>
      </div>

      {/* KPI ROW */}
      <div className="sx-kpi-row">
        <Kpi
          tone="blue" delay={0}
          icon={<DollarSign size={18} />}
          label="Sales, latest day"
          info="Takings on the most recent day your POS has finished reporting - not today, which is still in progress, and not the selected window. The comparison is against a typical recent day. The home screen shows the same figure under the same name."
          value={fmtMoney0(kpis.revenue)}
          delta={revenueDelta}
          meta={revenueDelta == null ? 'most recent completed day' : 'vs. a typical day'}
        />
        <Kpi
          tone="teal" delay={60}
          icon={<Package size={18} />}
          label="Products in Stock"
          info="Distinct products your POS currently reports as stocked. It counts lines in your catalogue, not bottles on the shelf - two sizes of the same whiskey are two products."
          value={fmtNum(kpis.totalProducts)}
          meta={kpis.lowStock ? `${fmtNum(kpis.lowStock)} running low` : 'in catalog'}
        />
        <Kpi
          tone="blue" delay={120}
          icon={<Percent size={18} />}
          label="Gross Margin"
          info="What you keep of every dollar taken, after what the stock cost you, over the last 90 days. Only products with a cost price recorded in your POS can be counted, so this describes that part of your range."
          value={marginValue}
          meta={profitAvailable ? 'last 90 days' : 'cost not recorded'}
        />
        <Kpi
          tone="teal" delay={180}
          icon={<ShoppingBasket size={18} />}
          label="Transactions"
          info="How many separate sales rang up on the most recent completed day - not the selected window, and not today, which is still in progress."
          value={fmtNum(kpis.transactions)}
          meta="latest day"
        />
      </div>

      {/* CHART ROW */}
      <div className="sx-row-3">
        {/* Revenue Trends */}
        <Card title="Revenue Trends" delay={0}
          info="Daily takings over the chosen window. Gaps are days with no recorded sales, which usually means the store was closed rather than that nothing sold."

          actions={
            <Segmented
              label="Trend window"
              value={range}
              onChange={setRange}
              options={[{ key: '7', label: '7d' }, { key: '30', label: '30d' }, { key: 'all', label: 'All' }]}
            />
          }
        >
          {trend.length === 0 ? EMPTY('No sales in this window yet.') : (
            <>
              <div className="sx-chart">
                <ResponsiveContainer width="100%" height={230}>
                  <BarChart data={trend} margin={{ top: 8, right: 6, left: -8, bottom: 0 }} barCategoryGap="22%">
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--sx-grid)" vertical={false} />
                    <XAxis dataKey="label" tick={{ fill: 'var(--sx-axis)', fontSize: 11 }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={24} />
                    <YAxis tickFormatter={fmtAxisMoney} tick={{ fill: 'var(--sx-axis)', fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
                    <Tooltip cursor={{ fill: chart.rimSoft }} content={<ChartTip money decimals={2} />} />
                    <Bar dataKey="revenue" name="Revenue" fill={chart.series[0]} radius={[5, 5, 0, 0]} maxBarSize={26} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {trendStats && (
                <div className="sx-stat-row">
                  <Stat value={fmtMoney(trendStats.total)} label="total" />
                  <Stat value={fmtMoney(trendStats.avg)} label="a typical day" />
                  <Stat
                    value={trendStats.peak ? `Peak · ${fmtShortDate(trendStats.peak.date)}` : 'No data'}
                    label={trendStats.multiple ? `${trendStats.multiple.toFixed(1)}× a typical day` : 'busiest day'}
                  />
                </div>
              )}
            </>
          )}
        </Card>

        {/* Revenue composition by category */}
        <Card title="Revenue by Category"
          info="Share of takings by product category over the window. Categories come from your POS, so anything filed as uncategorised there lands together here."
          delay={80}>
          {pieData.length === 0 ? EMPTY('No category revenue yet.') : (
            <>
              <div className="sx-chart sx-donut">
                <ResponsiveContainer width="100%" height={230}>
                  <PieChart>
                    <Tooltip content={<ChartTip money decimals={2} />} />
                    <Pie
                      data={pieData} dataKey="value" nameKey="name"
                      cx="50%" cy="50%" innerRadius={62} outerRadius={95}
                      paddingAngle={2} stroke="none"
                    >
                      {pieData.map((s, i) => <Cell key={i} fill={sliceStep(chart, s, i)} />)}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <div className="sx-donut-center">
                  <div className="sx-donut-value">{fmtCompactMoney(totalRevenue)}</div>
                  <div className="sx-donut-label">Revenue</div>
                </div>
              </div>
              <div className="sx-stat-row">
                <Stat value={fmtNum(categoryBreakdown.length)} label={categoryBreakdown.length === 1 ? 'category' : 'categories'} />
                <Stat value={topShare != null ? `${topShare.toFixed(0)}%` : 'No data'} label={pieData[0] ? `from ${truncate(pieData[0].name, 14)}` : 'top share'} />
              </div>
            </>
          )}
        </Card>

        {/* Category Performance */}
        <Card title="Category Performance" delay={160}
          info="Revenue, units and margin per category side by side, so a category that sells a lot but earns little is visible as such."

          actions={<Segmented label="Measure" value={measure} onChange={setMeasure} options={PERF_OPTS} />}
        >
          {perfData.length === 0 ? EMPTY('No category data yet.') : (
            <>
              <div className="sx-chart">
                <ResponsiveContainer width="100%" height={230}>
                  <LineChart data={perfData} margin={{ top: 10, right: 10, left: -6, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--sx-grid)" vertical={false} />
                    <XAxis dataKey="category" tick={{ fill: 'var(--sx-axis)', fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v) => truncate(v, 8)} interval="preserveStartEnd" minTickGap={10} />
                    <YAxis tickFormatter={measure === 'margin' ? (v) => `${Math.round(v)}%` : fmtAxisMoney} tick={{ fill: 'var(--sx-axis)', fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
                    <Tooltip content={<ChartTip money={measure !== 'margin'} decimals={measure === 'margin' ? 1 : 2} suffix={measure === 'margin' ? '%' : ''} />} />
                    <Line
                      type="monotone" dataKey={measure}
                      name={measure === 'revenue' ? 'Revenue' : measure === 'profit' ? 'Profit' : 'Margin'}
                      stroke={lineColor}
                      strokeWidth={2.5}
                      dot={{ r: 3, strokeWidth: 0, fill: lineColor }}
                      activeDot={{ r: 5 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="sx-stat-row">
                <Stat
                  value={measure === 'margin' ? `${perfTotal.toFixed(1)}%` : fmtMoney(perfTotal)}
                  label={measure === 'margin' ? 'blended margin' : `total ${measure}`}
                />
                <Stat
                  value={fmtNum(categoryBreakdown.length)}
                  label={categoryBreakdown.length > perfData.length
                    ? `categories · top ${perfData.length} charted`
                    : 'categories'}
                />
              </div>
            </>
          )}
        </Card>
      </div>

      {/* TABLE + INTELLIGENCE ROW */}
      <div className="sx-row-2">
        {/* Top Products (the honest stand-in for "Recent Buyers") */}
        <Card title="Top Products" delay={0}
          info="Your best sellers over the window by revenue. The bar shows each product's unit sales as a share of the single best seller's, so it compares volume where the money column compares value."

          actions={
            <button type="button" className="sx-btn" onClick={exportCsv} disabled={!topProducts.length}>
              <Download size={14} /> Export
            </button>
          }
        >
          {topProducts.length === 0 ? EMPTY('No product sales yet.') : (
            <div className="sx-table-wrap sx-table-scroll app-scroll">
              <table className="sx-table">
                <thead>
                  <tr>
                    <th className="sx-th-rank">#</th>
                    <th>Product</th>
                    <th className="sx-th-num">Units</th>
                    <th className="sx-th-bar" title="Each product's unit sales as a percentage of the best-selling product's">
                      vs. best seller
                    </th>
                    <th className="sx-th-num">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {topPage.pageRows.map((p, i) => {
                    const pct = (Number(p.units || 0) / maxUnits) * 100;
                    // The rank is the product's place in the whole list, not on
                    // this page - page two starting again at 1 would restate the
                    // best seller eleven times over.
                    const rank = topPage.page * 10 + i + 1;
                    return (
                      <tr key={rank}>
                        <td className="sx-td-rank">{rank}</td>
                        <td className="sx-td-name" title={p.name}>{truncate(p.name, 34)}</td>
                        <td className="sx-td-num">{fmtNum(p.units)}</td>
                        <td className="sx-td-bar">
                          <span className="sx-bar-wrap">
                            <span className="sx-bar-track">
                              <span className="sx-bar-fill" style={{ width: `${Math.max(4, pct)}%` }} />
                            </span>
                            <span className="sx-bar-pct">{Math.round(pct)}%</span>
                          </span>
                        </td>
                        <td className="sx-td-num sx-td-rev">{fmtMoney(p.revenue)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <TablePager {...topPage} sortNote="highest revenue first" emptyNote="No product sales yet" />
            </div>
          )}
        </Card>

      </div>

      {/* A quiet footer note so the numbers are never orphaned from their scope. */}
      <p className="sx-foot-note">
        <Store size={12} /> All figures read live from your store data
        {panelsWindow ? ` · ${panelsWindow}` : ''}
        {profitAvailable ? '' : ' · margin & profit appear once product costs are recorded'}.
      </p>
    </div>
  );
}
