import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Mail, ChevronDown, TrendingUp } from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip,
} from 'recharts';
import { signedMoney } from './EffectivenessCase';
import { formatLocalDate } from '../utils/date';
import './EffectivenessDigests.css';

// ── Weekly digests - the archived record + "Am I getting better?" ───────────
//   GET /api/recommendations/digest/history?limit=12
// Each row: { week_start, generated_at, emailed, subject, body_text, payload }
// where payload carries the structured week (recs/measured/winners/
// underperformers/acted/acted_won/revenue_impact/margin_impact/
// pending_actions + week_start/week_end/store_name). Everything shown is the
// week's MEASURED record - dollar fields may be null and render as "not yet
// measured", never a projection.
//
// The trend needs >= 4 measurable weeks before it draws anything (a two-point
// "trend" would be noise); weeks with measured === 0 leave a GAP in the line,
// never a guessed point. Win rate and acted_won are different scales, so they
// get two small aligned bands sharing one x-axis + synced hover - never a
// dual-axis chart.
//
// If the endpoint 404s / errors / returns no rows, this renders nothing and
// tells the parent via onAvailability(false) so the old single-latest digest
// card stays (graceful degradation on older backends).

const shortDate = (d) => (d ? formatLocalDate(d, { month: 'short', day: 'numeric' }) : '');

function WeekTip({ active, payload, label, kind }) {
  if (!active || !payload || !payload.length) return null;
  const v = payload[0].value;
  return (
    <div className="ed-tip">
      <span className="ed-tip-dim">Week of {shortDate(label)}</span>
      {kind === 'rate' ? (
        v == null
          ? <strong className="ed-tip-quiet">nothing measurable</strong>
          : <strong>{v}% worked</strong>
      ) : (
        <strong>{v} win{v === 1 ? '' : 's'} you acted on</strong>
      )}
    </div>
  );
}

function StatCell({ label, value, quiet, title }) {
  return (
    <div className="ed-cell" title={title}>
      <span className="ed-cell-label">{label}</span>
      <strong className={quiet ? 'ed-cell-quiet' : ''}>{value}</strong>
    </div>
  );
}

export default function EffectivenessDigests({ authed, onAvailability }) {
  const [state, setState] = useState({ status: 'loading', rows: [] });
  const [openWeeks, setOpenWeeks] = useState(() => new Set());
  const [openMail, setOpenMail] = useState(() => new Set());

  useEffect(() => {
    if (!authed) return undefined;
    let alive = true;
    (async () => {
      try {
        const res = await authed('/api/recommendations/digest/history?limit=12');
        if (!alive) return;
        if (!res.ok) throw new Error('digest history unavailable');
        const body = await res.json();
        if (!alive) return;
        const rows = body.digests || [];
        setState({ status: 'ready', rows });
        if (onAvailability) onAvailability(rows.length > 0);
      } catch {
        if (!alive) return;
        setState({ status: 'unavailable', rows: [] });
        if (onAvailability) onAvailability(false);
      }
    })();
    return () => { alive = false; };
  }, [authed, onAvailability]);

  const toggleWeek = useCallback((k) => {
    setOpenWeeks((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }, []);
  const toggleMail = useCallback((k) => {
    setOpenMail((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }, []);

  // Chronological (rows arrive newest-first) points for the trend bands.
  const weeks = useMemo(() => state.rows.slice().reverse().map((r) => {
    const p = r.payload || {};
    const measured = Number(p.measured) || 0;
    return {
      week: r.week_start,
      win_rate: measured > 0 ? Math.round(((Number(p.winners) || 0) / measured) * 100) : null,
      acted_won: Number(p.acted_won) || 0,
    };
  }), [state.rows]);
  const xTicks = useMemo(() => {
    if (!weeks.length) return [];
    const idx = [0, Math.floor((weeks.length - 1) / 2), weeks.length - 1];
    return [...new Set(idx.map((i) => weeks[i].week))];
  }, [weeks]);
  const showTrend = weeks.filter((w) => w.win_rate != null).length >= 4;

  if (state.status !== 'ready' || state.rows.length === 0) return null;

  return (
    <div className="ed-card">
      <h4><Mail size={14} /> Weekly digests <span className="ed-count">{state.rows.length}</span></h4>
      <p className="ed-sub">
        The week-by-week record: what was called, what worked, what it measurably earned.
      </p>

      {showTrend && (
        <div className="ed-trend">
          <p className="ed-trend-title"><TrendingUp size={13} /> Am I getting better?</p>
          <div className="ed-band">
            <span className="ed-band-label">Win rate: share of measured calls that worked</span>
            <ResponsiveContainer width="100%" height={112} className="ed-bandchart ed-bandchart-line">
              <LineChart data={weeks} syncId="ed-trend" margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                <XAxis dataKey="week" scale="band" hide />
                <YAxis
                  width={34}
                  domain={[0, 100]}
                  ticks={[0, 50, 100]}
                  tickFormatter={(v) => `${v}%`}
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip content={<WeekTip kind="rate" />} isAnimationActive={false} />
                <Line
                  type="monotone"
                  dataKey="win_rate"
                  name="win rate"
                  className="ed-line"
                  stroke="#8B5CF6"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  activeDot={{ r: 4, strokeWidth: 0 }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="ed-band">
            <span className="ed-band-label">Wins you acted on</span>
            <ResponsiveContainer width="100%" height={92} className="ed-bandchart ed-bandchart-bars">
              <BarChart data={weeks} syncId="ed-trend" margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <XAxis
                  dataKey="week"
                  ticks={xTicks}
                  interval={0}
                  tickFormatter={shortDate}
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  height={16}
                />
                <YAxis
                  width={34}
                  allowDecimals={false}
                  tickCount={3}
                  domain={[0, (dataMax) => Math.max(dataMax, 1)]}
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip content={<WeekTip kind="won" />} isAnimationActive={false} cursor={{ fillOpacity: 0.35 }} />
                <Bar
                  dataKey="acted_won"
                  name="wins you acted on"
                  className="ed-bars"
                  fill="#2FBF97"
                  barSize={14}
                  radius={[4, 4, 0, 0]}
                  isAnimationActive={false}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="ed-trend-note">
            Weeks where nothing was measurable yet leave a gap, never a guessed point.
          </p>
        </div>
      )}

      <div className="ed-weeks">
        {state.rows.map((r) => {
          const p = r.payload || {};
          const open = openWeeks.has(r.week_start);
          const mail = openMail.has(r.week_start);
          const range = `${shortDate(p.week_start || r.week_start)}${p.week_end ? `-${shortDate(p.week_end)}` : ''}`;
          const measured = Number(p.measured) || 0;
          return (
            <div className="ed-week" key={r.week_start}>
              <button
                type="button"
                className="ed-week-head"
                aria-expanded={open}
                title={r.subject || undefined}
                onClick={() => toggleWeek(r.week_start)}
              >
                <span className="ed-week-range">Week of {range}</span>
                {r.emailed && <em className="ed-emailed"><Mail size={10} /> emailed</em>}
                <span className="ed-week-quick">
                  {measured > 0 ? `${p.winners ?? 0} of ${measured} worked` : 'nothing measurable yet'}
                </span>
                <ChevronDown size={14} className={`ed-chev ${open ? 'ed-flip' : ''}`} />
              </button>
              {open && (
                <div className="ed-week-body">
                  <div className="ed-grid">
                    <StatCell label="calls measured" value={p.measured ?? 'n/a'} />
                    <StatCell label="worked" value={p.winners ?? 'n/a'} />
                    <StatCell label="wins you acted on" value={p.acted_won ?? 'n/a'} />
                    <StatCell
                      label="measured $"
                      value={p.revenue_impact != null ? signedMoney(p.revenue_impact) : 'not yet measured'}
                      quiet={p.revenue_impact == null}
                      title={p.margin_impact != null ? `margin ${signedMoney(p.margin_impact)}` : undefined}
                    />
                  </div>
                  {r.body_text && (
                    <>
                      <button
                        type="button"
                        className="ed-mail-btn"
                        aria-expanded={mail}
                        onClick={() => toggleMail(r.week_start)}
                      >
                        <Mail size={12} /> {mail ? 'hide the email' : 'see the email'}
                      </button>
                      {mail && <pre className="ed-mail">{r.body_text}</pre>}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
