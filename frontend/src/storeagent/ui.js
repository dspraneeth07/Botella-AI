// Shared StoreAgent UI primitives - ported from ui.tsx (TS+Tailwind -> JS+CSS).
// Same component names and props as the original so the view files port 1:1.
// Includes the loaders (cycling status words) and the SQL transparency overlay
// (debug_sql), which surfaces the exact warehouse queries behind each view.

import { createContext, useCallback, useEffect, useMemo, useState } from 'react';
import { checkSqlFor, useCheckSqlReady } from './checkSql';
import { CAN_REVEAL_SQL } from '../utils/env';
import { sentence } from '../utils/sentence';

export function Card({ children, className = '' }) {
  return <div className={`sa-card ${className}`.trim()}>{children}</div>;
}

// ---- Loaders --------------------------------------------------------------
// Cycle through status words while something computes.
export function useCyclingWord(words, intervalMs = 1500) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!words || words.length <= 1) return undefined;
    const id = setInterval(() => setI((n) => (n + 1) % words.length), intervalMs);
    return () => clearInterval(id);
  }, [words, intervalMs]);
  return words && words.length ? words[i % words.length] : '';
}

const LOAD_WORDS = [
  'Loading',
  'Querying the warehouse',
  'Crunching the ledger',
  'Computing velocity',
  'Ranking opportunities',
  'Almost there',
];

// Loading state: a branded status bar (Botella mark + cycling word) above the
// page's own shape (stat cards + table rows shimmering), so it reads as the view
// building in place rather than a blank spinner.
export function StatusLoader({ words = LOAD_WORDS, title }) {
  const word = useCyclingWord(words);
  return (
    <div className="sa-stack" aria-busy="true">
      <div className="sa-loadbar">
        <span className="sa-loadbar-mark">
          <img src="/logo.png" alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
          <span className="sa-spin sa-loadbar-spin" />
        </span>
        <span className="sa-loadbar-text">
          {title ? `${title} - ` : ''}
          <span className="sa-c-500">
            {word}
            <span className="sa-loader-dots" />
          </span>
        </span>
      </div>
      <SkeletonBody />
    </div>
  );
}

// Inline loader for a single panel (e.g. the AI narration slot).
export function InlineLoader({ words }) {
  const word = useCyclingWord(words || ['Generating', 'Reading the numbers', 'Writing your brief']);
  return (
    <span className="sa-inline-loader">
      <span className="sa-spin" style={{ height: 14, width: 14 }} />
      <span>
        {word}
        <span className="sa-loader-dots" />
      </span>
    </span>
  );
}

// ---- SQL transparency overlay --------------------------------------------
// Each captured query is tagged (connector.py) with the source repo that ran
// it, so a component can show JUST the queries that fetched its own data. The
// whole tagged list is provided per-view through this context; a component
// passes the source repo(s) its data comes from.
export const DebugSqlContext = createContext(null);

// Modal showing the exact, verified query that reproduces a section's figures
// from the warehouse (resolved from checkSql.js, generated from sql_checks/).
function SqlModal({ title, sql, onClose }) {
  const [copied, setCopied] = useState(false);
  const copy = (e) => {
    e.stopPropagation();
    try {
      navigator.clipboard.writeText(sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      /* clipboard unavailable */
    }
  };
  return (
    <div className="sa-sql-scrim" onClick={onClose}>
      <div className="sa-sql-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sa-sql-head">
          <div>
            <div className="sa-sql-title">{title}</div>
            <div className="sa-sql-sub">
              The exact query that reproduces this section's figures from the warehouse. Runs as-is
              for your store.
            </div>
          </div>
          <div className="sa-row" style={{ gap: 8 }}>
            <button onClick={copy} className="sa-sql-close">{copied ? 'copied' : 'copy'}</button>
            <button onClick={onClose} className="sa-sql-close">✕ close</button>
          </div>
        </div>
        <div className="sa-sql-body">
          <pre className="sa-sql-pre">{sql}</pre>
        </div>
      </div>
    </div>
  );
}

// The per-figure "show the SQL" control (the small database icon beside
// Section/Stat headings) is a STAGING tool, not a product feature. It was
// hardcoded on, which meant production builds shipped raw warehouse queries -
// table names, column names and the full derivation of every metric - to store
// owners. It now follows the same build flag as everything else that must not
// leave staging (utils/env.js), which fails safe to hidden.
const SHOW_COMPONENT_SQL = CAN_REVEAL_SQL;

// `sql` is a section key (e.g. "inventory", "pricing"); resolves to the verified
// reproduction query. Renders nothing if there is no query for the key.
export function ComponentSql({ sql, label }) {
  const [open, setOpen] = useState(false);
  useCheckSqlReady();
  if (!SHOW_COMPONENT_SQL) return null;
  const query = typeof sql === 'string' ? checkSqlFor(sql) : null;
  if (!query) return null;
  return (
    <span className="sa-infotip">
      <button
        type="button"
        className="sa-sqltip-btn"
        aria-label="Show the SQL that reproduces this figure"
        title="Show the SQL that reproduces this figure"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.5">
          <ellipse cx="12" cy="5" rx="8" ry="3" />
          <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
          <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
        </svg>
      </button>
      {open && <SqlModal title={label ? `SQL for: ${label}` : 'SQL for this section'} sql={query} onClose={() => setOpen(false)} />}
    </span>
  );
}

// An "i" that reveals a plain-language explanation of what a number means and
// why it matters, so the owner understands it at a glance.
export function InfoTip({ text }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="sa-infotip">
      <button
        type="button"
        aria-label="What this means"
        title="What this means"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className={`sa-infotip-btn${open ? ' is-open' : ''}`}
      >
        i
      </button>
      {open && (
        <>
          <span className="sa-infotip-scrim" onClick={() => setOpen(false)} />
          <span className="sa-infotip-pop">
            <span className="sa-infotip-pop-title">What this means</span>
            <p className="sa-infotip-pop-text">{text}</p>
          </span>
        </>
      )}
    </span>
  );
}

export function Section({ title, hint, right, info, sql, children }) {
  return (
    <Card className="sa-p-5">
      <div className="sa-section-head">
        <div>
          <h3 className="sa-section-title">
            {title}
            {info && <InfoTip text={info} />}
            {sql && <ComponentSql sql={sql} label={title} />}
          </h3>
          {hint && <p className="sa-section-hint">{hint}</p>}
        </div>
        {right}
      </div>
      {children}
    </Card>
  );
}

export function Stat({ label, value, sub, tone = 'default', info, sql }) {
  const toneClass = { good: 'is-good', warn: 'is-warn', bad: 'is-bad', accent: 'is-accent' }[tone] || '';
  return (
    <Card className={`sa-p-4 sa-stat-card sa-stat-card--${tone}`}>
      <div className="sa-stat-label">
        <span>{label}</span>
        {(info || sql) && (
          <span className="sa-row" style={{ gap: 4 }}>
            {info && <InfoTip text={info} />}
            {sql && <ComponentSql sql={sql} label={label} />}
          </span>
        )}
      </div>
      <div className={`sa-stat-value ${toneClass}`.trim()}>{value}</div>
      {sub && <div className="sa-stat-sub">{sub}</div>}
    </Card>
  );
}

const BADGE_TONES = new Set([
  'confirmed', 'uncertain', 'good', 'warn', 'accent', 'low-volume',
  'urgent', 'fast', 'normal', 'slow', 'dead', 'premium', 'bad', 'default',
]);

export function Badge({ children, tone = 'default' }) {
  const t = BADGE_TONES.has(tone) ? tone : 'default';
  return <span className={`sa-badge sa-badge--${t}`}>{children}</span>;
}

export function Bar({ value, max, tone = 'accent' }) {
  const w = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  const toneClass = { good: 'sa-bar--good', warn: 'sa-bar--warn', bad: 'sa-bar--bad' }[tone] || '';
  return (
    <div className={`sa-bar ${toneClass}`.trim()}>
      <span style={{ width: `${w}%` }} />
    </div>
  );
}

export function Table({ head, children }) {
  return (
    <div className="sa-table-wrap">
      <table className="sa-table">
        <thead>
          <tr>{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

// A column header. Pass `sortKey` + the `sort` object + `onSort` from useSort()
// to make it click-to-sort (a minimal caret shows the direction). Without those
// props it renders exactly as before.
export function Th({ children, right = false, style, sortKey, sort, onSort }) {
  const sortable = !!sortKey && typeof onSort === 'function';
  const active = sortable && sort && sort.key === sortKey;
  if (!sortable) {
    return <th className={`sa-th${right ? ' is-right' : ''}`} style={style}>{children}</th>;
  }
  const caret = active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕';
  return (
    <th
      className={`sa-th is-sortable${right ? ' is-right' : ''}${active ? ' is-sorted' : ''}`}
      style={style}
      role="button"
      tabIndex={0}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      title="Sort"
      onClick={() => onSort(sortKey)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSort(sortKey);
        }
      }}
    >
      {children}
      <span className={`sa-sort-caret${active ? ' is-active' : ''}`} aria-hidden="true">{caret}</span>
    </th>
  );
}

export function Td({ children, right = false, className = '', style }) {
  return (
    <td className={`sa-td${right ? ' is-right' : ''} ${className}`.trim()} style={style}>
      {children}
    </td>
  );
}

// Client-side column sorting for a table. Returns the sorted rows plus the
// current sort state and a toggle to wire into <Th sortKey=… sort=… onSort=…>.
// Clicking a header cycles desc → asc → unsorted (back to the incoming order).
// Nulls always sort last; numbers compare numerically, everything else as text.
export function useSort(rows, initial = null) {
  const [sort, setSort] = useState(initial); // { key, dir: 'asc' | 'desc' } | null
  const onSort = useCallback((key) => {
    setSort((cur) =>
      !cur || cur.key !== key
        ? { key, dir: 'desc' }
        : cur.dir === 'desc'
        ? { key, dir: 'asc' }
        : null,
    );
  }, []);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const { key, dir } = sort;
    const mul = dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = a?.[key];
      const bv = b?.[key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1; // nulls last, both directions
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * mul;
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * mul;
    });
  }, [rows, sort]);
  return { sorted, sort, onSort };
}

// Client-side pagination: current page slice + controls.
export function usePaged(items, pageSize = 10) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const safe = Math.min(page, pageCount - 1);
  const slice = items.slice(safe * pageSize, safe * pageSize + pageSize);
  // `items` rides along so Pagination can export ALL rows (in the current
  // sort order), not just the visible page.
  return { slice, page: safe, pageCount, setPage, total: items.length, pageSize, items };
}

function csvEscape(v) {
  if (v == null) return '';
  const s = Array.isArray(v) ? v.join('; ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Serialize rows (array of flat objects) and trigger a browser download.
// Column order = key order of the first row; BOM so Excel opens it as UTF-8.
function downloadCsv(rows, name) {
  if (!rows?.length) return;
  const cols = Object.keys(rows[0]);
  const lines = [cols.map(csvEscape).join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvEscape(r?.[c])).join(','));
  const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name.endsWith('.csv') ? name : `${name}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function Pagination({ page, pageCount, total, pageSize, onPage, items, csvName }) {
  if (total <= pageSize) return null;
  const from = page * pageSize + 1;
  const to = Math.min((page + 1) * pageSize, total);
  return (
    <div className="sa-pagination">
      <span className="sa-text-xs sa-c-500">
        {from}-{to} of {total}
      </span>
      <div className="sa-row" style={{ gap: 6 }}>
        {items?.length > 0 && (
          <button
            className="sa-page-btn"
            title={`Download all ${total} rows as CSV`}
            onClick={() => downloadCsv(items, csvName || 'table')}
          >
            ↓ CSV
          </button>
        )}
        <button className="sa-page-btn" disabled={page === 0} onClick={() => onPage(page - 1)}>
          ← Prev
        </button>
        <span className="sa-text-xs sa-num sa-c-500" style={{ padding: '0 4px' }}>
          {page + 1}/{pageCount}
        </span>
        <button className="sa-page-btn" disabled={page >= pageCount - 1} onClick={() => onPage(page + 1)}>
          Next →
        </button>
      </div>
    </div>
  );
}

function Shimmer({ w, h, soft = false, style }) {
  return (
    <div
      className={`sa-shimmer${soft ? ' sa-shimmer--soft' : ''}`}
      style={{ width: w, height: h, ...style }}
    />
  );
}

// The view's shape (stat cards + two table sections) shimmering while data loads.
function SkeletonBody() {
  return (
    <>
      <div className="sa-grid-stats">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i} className="sa-p-4">
            <Shimmer w={96} h={12} />
            <Shimmer w={112} h={28} style={{ marginTop: 12 }} />
            <Shimmer w={80} h={12} soft style={{ marginTop: 8 }} />
          </Card>
        ))}
      </div>
      {[0, 1].map((s) => (
        <Card key={s} className="sa-p-5">
          <Shimmer w={224} h={16} />
          <Shimmer w={320} h={12} soft style={{ marginTop: 8, maxWidth: '100%' }} />
          <div className="sa-stack-md" style={{ marginTop: 24 }}>
            {[...Array(6)].map((_, r) => (
              <div className="sa-row" key={r} style={{ gap: 16 }}>
                <Shimmer h={12} soft style={{ flex: 1 }} />
                <Shimmer w={56} h={12} soft />
                <Shimmer w={80} h={12} soft />
                <Shimmer w={64} h={12} soft />
              </div>
            ))}
          </div>
        </Card>
      ))}
    </>
  );
}

// Skeleton screen: the page keeps its shape while data loads.
export function LoadingSkeleton({ label }) {
  return (
    <div className="sa-stack" aria-busy="true">
      <SkeletonBody />
      {label && (
        <div className="sa-row sa-text-xs sa-c-500" style={{ justifyContent: 'center', paddingTop: 4 }}>
          <div className="sa-spin" style={{ height: 14, width: 14 }} />
          {label}
        </div>
      )}
    </div>
  );
}

export function Spinner({ label }) {
  return (
    <div className="sa-spinner">
      <div className="sa-spin" style={{ height: 20, width: 20 }} />
      {label && <span className="sa-text-sm">{label}</span>}
    </div>
  );
}

/**
 * The data this screen needs is not there for this store.
 *
 * SEPARATE FROM ErrorBox ON PURPOSE. "Something went wrong" is a statement
 * about us - the service failed, retry may help. This is a statement about the
 * STORE: the POS does not send that data, so nothing is coming and retrying
 * will not change it. Showing the first where the second is true sends an
 * owner to refresh a page forever, and showing an empty view with zeroes in it
 * is worse again, because a measured zero and an absence read identically on a
 * stat tile.
 *
 * `reason` is the engine's own sentence where it supplied one; it knows why it
 * refused better than this component can guess. The contact line is the action
 * the owner actually has - the data has to be connected upstream, which is not
 * something they can do from this screen.
 */
export function DataUnavailable({ title, reason, detail }) {
  return (
    <Card className="sa-card--warn sa-p-8 sa-text-center">
      <div className="sa-text-lg sa-fw-600 sa-warn">
        {title || 'This data'} is not available for this store
      </div>
      <p className="sa-mt-2 sa-text-sm sa-c-600"
         style={{ margin: '8px auto 0', maxWidth: '32rem', lineHeight: 1.6 }}>
        {sentence(reason) || 'Your point-of-sale has not sent the data this screen is '
          + 'built from, so there is nothing to show yet.'}
      </p>
      <p className="sa-mt-2 sa-text-sm sa-c-600"
         style={{ margin: '10px auto 0', maxWidth: '32rem', lineHeight: 1.6 }}>
        If you expect to see this, contact <strong>Botella AI Labs</strong> and
        we will check the connection for your store.
      </p>
      {detail ? (
        <p className="sa-text-sm sa-c-600"
           style={{ margin: '10px auto 0', maxWidth: '32rem', opacity: 0.75 }}>
          {detail}
        </p>
      ) : null}
    </Card>
  );
}

export function ErrorBox({ message }) {
  return (
    <Card className="sa-card--bad sa-p-5 sa-error">
      <div className="sa-error-title">Something went wrong</div>
      <div style={{ marginTop: 4, opacity: 0.8 }}>{message}</div>
    </Card>
  );
}
