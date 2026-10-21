// BottleSenseScreen.js
// -----------------------------------------------------------------------------
// The measurement models from the August 2026 BottleSense research, rebuilt for
// one store and run on the thing that estate does not have: cost.
//
// The research searched all 133 BottleSense datasets for a cost, margin, profit,
// landed or wholesale column and found two, both shipping cost on marketplace
// order tables - against 194 price and revenue columns. So the brief was never
// to copy their 161 tiles. 88 of those are structurally unreachable (ad
// platforms, clickstream, marketplace commissions) and most of the rest are
// ordinary revenue counts. What transfers is the measurement ENGINEERING:
//
//   * a health score that always shows its named driver          (their #1)
//   * trend CLASSIFICATION rather than a raw slope               (their #3)
//   * every level materialised beside its previous window        (their #4)
//   * nine-litre case normalisation                              (their #5)
//   * coverage published next to the figure it qualifies         (their #6)
//   * average days to return                                     (their #10)
//   * pre-computed day parts                                     (their #9)
//
// And three of their habits deliberately not copied: no unbounded "all history"
// tiles, no hardcoded date windows, and one definition per metric. The window is
// printed on the screen for that reason.
// -----------------------------------------------------------------------------

import React, { useState, useEffect, useCallback } from 'react';
import { Gauge, TrendingUp, TrendingDown, AlertTriangle, Loader, Boxes, Users, Clock, Percent, ShieldCheck } from 'lucide-react';
import MetricInfo from './MetricInfo';
import { API_BASE } from '../utils/env';
import './BottleSenseScreen.css';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const money = (v) => (v === null || v === undefined ? 'No data'
  : v >= 1000 ? '$' + Math.round(v).toLocaleString('en-US') : '$' + (Math.round(v * 100) / 100).toLocaleString('en-US'));
const num = (v) => (v === null || v === undefined ? 'No data' : Math.round(v).toLocaleString('en-US'));
const pctTxt = (v) => (v === null || v === undefined ? 'No data' : (v > 0 ? '+' : '') + v + '%');

/** A level and its comparison, which is the only way this screen shows a level. */
function Delta({ value, good }) {
  if (value === null || value === undefined) return <span className="bs-delta is-none">no prior window</span>;
  const up = value >= 0;
  const positive = good === undefined ? up : (good ? up : !up);
  return (
    <span className={`bs-delta ${positive ? 'is-good' : 'is-bad'}`}>
      {up ? <TrendingUp size={12} /> : <TrendingDown size={12} />} {pctTxt(value)}
    </span>
  );
}

function Tile({ label, value, delta, deltaGood, note, info, sqlKey }) {
  return (
    <div className="bs-tile">
      <span className="bs-tile-label">{label}<MetricInfo label={label} info={info} sqlKey={sqlKey} /></span>
      <span className="bs-tile-value">{value}</span>
      <span className="bs-tile-foot">
        <Delta value={delta} good={deltaGood} />
        {note && <span className="bs-tile-note">{note}</span>}
      </span>
    </div>
  );
}

export default function BottleSenseScreen({ authToken, apiUrl, onNavigate }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const base = (apiUrl || API_BASE || '').replace(/\/api\/?$/, '');

  const fetchAll = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`${base}/api/bottlesense`, {
        headers: { Authorization: `Bearer ${authToken}`, 'ngrok-skip-browser-warning': 'true' },
      });
      if (r.status === 401) { localStorage.removeItem('botella_token'); window.location.href = '/login'; return; }
      const body = await r.json();
      if (!r.ok) throw new Error((body.error && body.error.message) || `HTTP ${r.status}`);
      setData(body);
    } catch (e) {
      setError(e.message || 'Could not load BottleSense.');
    } finally { setLoading(false); }
  }, [base, authToken]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  if (loading && !data) {
    return (
      <div className="bs-page">
        <div className="bs-loading"><Loader size={22} className="bs-spin" /><span>Measuring your store…</span></div>
      </div>
    );
  }
  if (error && !data) {
    return (
      <div className="bs-page">
        <div className="bs-error"><AlertTriangle size={18} /><span>{error}</span>
          <button type="button" onClick={fetchAll}>Retry</button></div>
      </div>
    );
  }
  if (data && data.available === false) {
    return (
      <div className="bs-page">
        <div className="bs-empty"><Gauge size={26} /><p>{data.reason}</p></div>
      </div>
    );
  }

  const { health, window: w, margin, stock, trend, nineLitre, customers, dayPart, windows } = data;
  const maxCell = Math.max(1, ...dayPart.map((d) => d.revenue || 0));
  const totalTrend = Object.values(trend.buckets).reduce((a, b) => a + b, 0) || 1;

  return (
    <div className="bs-page">
      <header className="bs-head">
        <h1 className="bs-title"><Gauge size={20} /> BottleSense</h1>
        <p className="bs-sub">
          Store health measured on cost, not just revenue.
          {/* The window is printed because the research's first "habit not to
              copy" is tiles that render all history with no time bound. */}
          <span className="bs-window">{windows.label}</span>
        </p>
      </header>

      {/* ── HEALTH SCORE ──────────────────────────────────────────────────────
          Their best design idea: a score is not actionable, a score plus a named
          cause is. Every driver shows its weight, its own score and its reason. */}
      <section className={`bs-health bs-band-${health.band}`}>
        <div className="bs-health-score">
          <div className="bs-score-ring" style={{ '--pct': (health.score || 0) }}>
            <span className="bs-score-num">{health.score === null ? '–' : health.score}</span>
            <span className="bs-score-of">/ 100</span>
          </div>
          <span className={`bs-band bs-band-tag-${health.band}`}>{health.band}</span>
        </div>
        <div className="bs-health-body">
          <span className="bs-health-eyebrow">
            Store health
            <MetricInfo
              label="Store health"
              info={'A weighted score from five things a liquor store lives or dies on: gross margin, the revenue trend, how much of what sells is actually on the shelf, how much capital is sitting idle, and how much of your sales carry a cost price. Every weight is shown below - a score you cannot take apart is a number to argue with, not a measurement.'}
            />
          </span>
          <h2 className="bs-health-headline">{health.headline}</h2>
          {health.headlineDriver && (
            <p className="bs-health-driver">Weakest driver: <strong>{health.headlineDriver}</strong></p>
          )}
          <div className="bs-drivers">
            {health.drivers.map((d) => (
              <div key={d.key} className="bs-driver">
                <div className="bs-driver-top">
                  <span className="bs-driver-label">{d.label}</span>
                  <span className="bs-driver-weight">weight {d.weight}</span>
                  <span className="bs-driver-value">{d.value === null ? 'No data' : d.value}</span>
                </div>
                <div className="bs-driver-bar">
                  <div
                    className={`bs-driver-fill ${d.score === null ? 'is-none' : d.score >= 70 ? 'is-good' : d.score >= 45 ? 'is-mid' : 'is-bad'}`}
                    style={{ width: `${d.score === null ? 0 : d.score}%` }}
                  />
                </div>
                <div className="bs-driver-reason">{d.reason}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── ROLLING WINDOW ───────────────────────────────────────────────────
          Every level carries its previous window. The research calls this the
          cheapest fix for context-free KPIs. */}
      <div className="bs-tiles">
        <Tile
          label="Revenue" value={money(w.revenue)} delta={w.revenueGrowthPct}
          note={`vs ${money(w.revenuePrev)} previous ${windows.rolling}d`}
          info={`Everything taken in the last ${windows.rolling} days, against the ${windows.rolling} days before it. The comparison is shown with the number on purpose - a level with no prior period cannot tell you whether it is good.`}
        />
        <Tile
          label="Orders" value={num(w.orders)} delta={w.ordersGrowthPct}
          note={`vs ${num(w.ordersPrev)} previous ${windows.rolling}d`}
          info={`Separate sales rung up in the window. Falling orders with steady revenue means fewer, larger baskets; the reverse means your regulars are spending less per visit.`}
        />
        <Tile
          label="Average basket" value={money(w.aov)} delta={w.aovGrowthPct}
          note={`vs ${money(w.aovPrev)} previous ${windows.rolling}d`}
          info="Revenue divided by orders. The cheapest number to move: a dollar on every basket is usually worth more than any single product win."
        />
        <Tile
          label="Units sold" value={num(w.units)}
          delta={w.unitsPrev ? Math.round(((w.units - w.unitsPrev) / w.unitsPrev) * 1000) / 10 : null}
          note={`vs ${num(w.unitsPrev)} previous ${windows.rolling}d`}
          info="Bottles and cans, not dollars. Compare with revenue: units up and revenue flat means you are selling more of the cheap stuff."
        />
      </div>

      {/* ── MARGIN + COVERAGE ────────────────────────────────────────────────
          The reason this screen exists, and the coverage figure is not
          decoration: a margin computed over part of your revenue must say so. */}
      <section className="bs-card bs-margin">
        <header className="bs-card-head">
          <span className="bs-card-title">
            <Percent size={15} /> What your sales actually earned
            <MetricInfo
              label="Gross margin"
              info={`Revenue minus what the stock cost you, over ${windows.margin} days. This is the figure the BottleSense estate cannot produce at all - a search of all 133 of its datasets found no product cost, no landed cost and no margin column anywhere.`}
            />
          </span>
          <span className="bs-card-sub">Last {windows.margin} days</span>
        </header>
        <div className="bs-margin-row">
          <div className="bs-margin-fig">
            <span className="bs-margin-label">Gross margin</span>
            <span className="bs-margin-value">{margin.marginPct === null ? 'No data' : margin.marginPct + '%'}</span>
          </div>
          <div className="bs-margin-fig">
            <span className="bs-margin-label">Gross profit</span>
            <span className="bs-margin-value">{money(margin.grossProfit)}</span>
          </div>
          <div className="bs-margin-fig">
            <span className="bs-margin-label">Cost of goods</span>
            <span className="bs-margin-value bs-muted">{money(margin.cogs)}</span>
          </div>
          {/* The disclosure column, adopted wholesale from their model. */}
          <div className="bs-coverage">
            <span className="bs-coverage-label">
              <ShieldCheck size={13} /> Cost coverage
              <MetricInfo
                label="Cost coverage"
                info="The share of revenue in this window that has a cost price recorded against it. A margin computed over part of your sales is an estimate, and this says how much of one. Published beside the margin so an inflated figure discloses itself rather than being taken at face value."
              />
            </span>
            <span className="bs-coverage-value">{margin.coveragePct === null ? 'None' : margin.coveragePct + '%'}</span>
            <div className="bs-coverage-bar">
              <div className="bs-coverage-fill" style={{ width: `${margin.coveragePct || 0}%` }} />
            </div>
            <span className="bs-coverage-note">
              {num(margin.linesCosted)} of {num(margin.linesTotal)} sale lines carry a cost
            </span>
          </div>
        </div>
      </section>

      {/* ── TREND CLASSIFICATION ─────────────────────────────────────────────
          Classification, not a slope. "Which products are dying" is a question a
          gradient does not answer. */}
      <section className="bs-card">
        <header className="bs-card-head">
          <span className="bs-card-title">
            <Boxes size={15} /> Where your products are heading
            <MetricInfo
              label="Trend classification"
              info={`Every product you sold in the last ${windows.rolling * 2} days, sorted into four groups by comparing its latest ${windows.rolling} days against the ${windows.rolling} before. Dying means it sold before and has now stopped completely - which a percentage change would hide among everything else that fell.`}
            />
          </span>
          <span className="bs-card-sub">{windows.rolling}d vs previous {windows.rolling}d</span>
        </header>
        <div className="bs-trend-bar">
          {['growing', 'stable', 'declining', 'dying'].map((k) => (
            trend.buckets[k] > 0 && (
              <div key={k} className={`bs-trend-seg bs-trend-${k}`} style={{ width: `${(trend.buckets[k] / totalTrend) * 100}%` }} title={`${k}: ${trend.buckets[k]} products`} />
            )
          ))}
        </div>
        <div className="bs-trend-legend">
          {['growing', 'stable', 'declining', 'dying'].map((k) => (
            <span key={k} className="bs-trend-key">
              <i className={`bs-dot bs-trend-${k}`} /> {k} <strong>{num(trend.buckets[k])}</strong>
            </span>
          ))}
          <span className="bs-trend-risk">
            {money(trend.revenueAtRisk)} of last window&apos;s revenue is in products now declining or stopped
          </span>
        </div>

        {trend.rows.length > 0 && (
          <div className="bs-table-wrap">
            <table className="bs-table">
              <thead>
                <tr>
                  <th>Product</th><th>Category</th><th className="bs-n">Units before</th>
                  <th className="bs-n">Units now</th><th className="bs-n">Revenue before</th><th>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {trend.rows.slice(0, 10).map((r) => (
                  <tr key={r.sku}>
                    <td className="bs-strong" title={r.product_name}>{(r.product_name || r.sku || '').slice(0, 40)}</td>
                    <td className="bs-muted">{r.category || '-'}</td>
                    <td className="bs-n">{num(r.u_prev)}</td>
                    <td className="bs-n">{num(r.u_now)}</td>
                    <td className="bs-n">{money(Number(r.r_prev))}</td>
                    <td><span className={`bs-pill bs-trend-${r.trend}`}>{r.trend}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="bs-split">
        {/* ── NINE-LITRE CASES ───────────────────────────────────────────────
            The liquor trade's standard volume unit. Counting units compares
            24 beers with 24 magnums; this does not. */}
        <section className="bs-card">
          <header className="bs-card-head">
            <span className="bs-card-title">
              Volume in nine-litre cases
              <MetricInfo
                label="Nine-litre cases"
                info="The liquor industry's standard unit of volume, so beer, wine and spirits can be compared on one scale - counting units cannot, because a case of beer and a case of magnums are not the same amount of drink. Sizes are read from the product name, and the coverage figure says for how much of each category that worked."
              />
            </span>
            <span className="bs-card-sub">Last {windows.rolling} days</span>
          </header>
          <table className="bs-table bs-table-compact">
            <thead><tr><th>Category</th><th className="bs-n">9L cases</th><th className="bs-n">Revenue</th><th className="bs-n">Sized</th></tr></thead>
            <tbody>
              {nineLitre.map((c) => (
                <tr key={c.category}>
                  <td className="bs-strong">{c.category}</td>
                  <td className="bs-n">{c.cases9l === null ? '-' : c.cases9l.toLocaleString('en-US')}</td>
                  <td className="bs-n">{money(c.revenue)}</td>
                  {/* Coverage again: a case count from 60% of lines is not a
                      case count, and the column says which it is. */}
                  <td className={`bs-n ${c.sizedPct < 70 ? 'bs-warn' : 'bs-muted'}`}>{c.sizedPct === null ? '-' : c.sizedPct + '%'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* ── CUSTOMERS ──────────────────────────────────────────────────────── */}
        <section className="bs-card">
          <header className="bs-card-head">
            <span className="bs-card-title">
              <Users size={15} /> When your regulars come back
              <MetricInfo
                label="Days to return"
                info="The average gap between one customer's visits, over the last year. It sets the cadence for contacting someone: a shopper who normally returns every eight days and has not been in for a month is not simply due, they are lapsing. Needs a customer linked at the till, so the coverage figure is shown with it."
              />
            </span>
          </header>
          <div className="bs-cust">
            <div className="bs-cust-fig">
              <span className="bs-cust-value">{customers.avgDaysToReturn === null ? 'No data' : customers.avgDaysToReturn}</span>
              <span className="bs-cust-label">average days between visits</span>
            </div>
            <div className="bs-cust-fig">
              <span className="bs-cust-value">{customers.medianDaysToReturn === null ? 'No data' : customers.medianDaysToReturn}</span>
              <span className="bs-cust-label">median - the typical shopper</span>
            </div>
          </div>
          <div className="bs-cust-cov">
            <span>{num(customers.customersWithRepeat)} customers with more than one visit</span>
            <span className={customers.coveragePct >= 80 ? 'bs-ok' : 'bs-warn'}>
              {customers.coveragePct === null ? 'no linkage' : customers.coveragePct + '% of sales identify a customer'}
            </span>
          </div>
        </section>
      </div>

      {/* ── DAY PART ─────────────────────────────────────────────────────────── */}
      <section className="bs-card">
        <header className="bs-card-head">
          <span className="bs-card-title">
            <Clock size={15} /> When the money comes in
            <MetricInfo
              label="Day part"
              info={`Revenue by weekday and hour over the last ${windows.rolling} days. Useful for staffing, for when to run a promotion, and for spotting a quiet hour that has always been quiet versus one that has just gone quiet.`}
            />
          </span>
          <span className="bs-card-sub">Last {windows.rolling} days</span>
        </header>
        <div className="bs-heat">
          <div className="bs-heat-hours">
            <span />
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h} className="bs-heat-hour">{h % 3 === 0 ? h : ''}</span>
            ))}
          </div>
          {DAYS.map((day, dow) => (
            <div key={day} className="bs-heat-row">
              <span className="bs-heat-day">{day}</span>
              {Array.from({ length: 24 }, (_, h) => {
                const cell = dayPart.find((d) => d.dow === dow && d.hour === h);
                const v = cell ? cell.revenue : 0;
                return (
                  <span
                    key={h}
                    className="bs-heat-cell"
                    style={{ '--v': v ? Math.max(0.08, v / maxCell) : 0 }}
                    title={v ? `${day} ${h}:00 - ${money(v)} across ${cell.orders} orders` : `${day} ${h}:00 - no sales`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </section>

      <p className="bs-foot">
        Every figure on this screen is bounded to a stated window and computed once, server-side, from the
        same as-of date ({String(data.asOf).slice(0, 10)}) - so no two tiles here can disagree with each other.
      </p>
    </div>
  );
}
