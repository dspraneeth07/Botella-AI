// CardStatementDetail.js
// -----------------------------------------------------------------------------
// One card-processing statement, read and analysed (CARD-STATEMENTS.md §8.4).
//
// The list screen renders this in place of its table, the way Quick-PO opens a
// document, so the owner never loses the list they came from. Everything here
// comes from GET /api/card-statements/:id: the header columns, the
// reconciliation result and the `analysis` object the engine builds (§5). The
// engine already did every sum; this file formats, lays out and links. It
// computes nothing an owner could read as a new number.
//
// Two rules shape most of what follows:
//
//   * Missing is not zero. A legacy statement prints no customer counts, a CSV
//     export has no fee lines. Any section the engine returns as null says
//     "Not on this statement" rather than a row of $0.00.
//   * Rebelipay's price is never shown in parts (D7). The hero states totals
//     and one all-in rate, and "How we calculated this" explains the method in
//     words only.
// -----------------------------------------------------------------------------

import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import {
  BarChart as RBarChart, Bar, Cell, LabelList, AreaChart, Area, ReferenceDot,
  XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, ResponsiveContainer,
  PieChart, Pie, Customized,
} from 'recharts';
import {
  ArrowLeft, RefreshCw, Download, FileText, ChevronDown, Trash2,
  AlertTriangle, Loader, ExternalLink, Copy, CreditCard, Check, PiggyBank, MousePointerClick,
} from 'lucide-react';
import './ReferenceScreen.css';
import './CardStatementDetail.css';
import { useDialog } from './Dialog';
import DocumentViewer from './DocumentViewer';
import MetricInfo from './MetricInfo';
import { useChartTheme, glassDefs } from './chartTheme';
import { errorText } from '../utils/errorText';
import { clearSession } from '../utils/session';
import { formatLocalDate, parseLocalDate } from '../utils/date';
import { useCellTitles } from '../utils/useCellTitles';

/* ── Formatters ──────────────────────────────────────────────────────────── */
// '-' is the one placeholder the copy rules allow, and only for a value that
// is genuinely absent. Negative money keeps a plain hyphen-minus.
const DASH = '-';
const isNum = (v) => v != null && v !== '' && Number.isFinite(Number(v));
const money = (v, d = 2) => (!isNum(v)
  ? DASH
  : (Number(v) < 0 ? '-' : '') + '$' + Math.abs(Number(v)).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const money0 = (v) => money(v, 0);
const num = (v) => (!isNum(v) ? DASH : Number(v).toLocaleString('en-US'));
const pct = (v, d = 2) => (!isNum(v) ? DASH : `${Number(v).toFixed(d)}%`);
const signedPct = (v, d = 1) => (!isNum(v) ? DASH : `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(d)}%`);
const axisMoney = (v) => (Math.abs(v) >= 1000 ? `$${Math.round(v / 1000)}K` : `$${Math.round(v)}`);
const shortDay = (d) => (d ? formatLocalDate(d, { month: 'short', day: 'numeric' }) : DASH);
const longDay = (d) => (d ? formatLocalDate(d, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : DASH);
const monthLabel = (ym) => (ym ? formatLocalDate(`${String(ym).slice(0, 7)}-01`, { month: 'short', year: 'numeric' }) : DASH);
const truncate = (s, n) => (!s ? '' : (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s)));
const asText = (v) => (Array.isArray(v) ? v.filter(Boolean).join(' ') : (v == null ? '' : String(v)));

/* ── Plain words ───────────────────────────────────────────────────────────
   Titles an owner can read without a glossary, and what each ⓘ says: what
   the figure is, then how it helps (D39). One term per thing across the page:
   card sales (never "volume" or "submitted"), fees you paid, sent to your
   bank, average sale, fee rate. A CSV upload is a "file" covering a
   "period", never a "statement" or a "month". */

const LAYOUT_TAG = { legacy_2026: 'Older layout', v2_2026: 'Newer layout', csv: 'CSV file' };
const LAYOUT_INFO = {
  legacy_2026: "Your processor's older statement design. It has no customer counts or 13-month sales chart, so we build your sales trend from your uploads for earlier months and leave customer figures out.",
  v2_2026: "Your processor's newer statement design. It includes customer counts and a 13-month sales chart, which this page uses.",
  csv: 'A file listing each card payment, not a processor statement. It has no fee breakdown, notices or 1099-K tax figures, so those parts are left out.',
};

const NOTICE_KIND = {
  acquirer_change: 'Processing bank change',
  ach_descriptor_change: 'Deposit name change',
  delivery_change: 'Statement delivery change',
  fee_change: 'Fee change',
  other: 'Information',
};
const NOTICE_INFO = {
  acquirer_change: 'The bank behind your card processing changes. The step shown with it says what to do.',
  ach_descriptor_change: 'Your card deposits get a new company name on your bank statement. Tell your bank and bookkeeper the new name.',
  delivery_change: 'The way you get your statements changes, for example from an emailed file to a website. Make sure someone can still get them.',
  fee_change: 'A fee on your account is new or changes from a set date. Check what the new fee will cost you.',
  other: 'General news from your processor. Usually there is nothing to do.',
};

const ANOMALY_LABEL = {
  low_batch: 'Low sales day',
  zero_with_fees: 'Fees, no sales',
  prior_period: 'Earlier sales',
  split_funding: 'Split deposit',
  unusual: 'Unusual day',
};
const ANOMALY_INFO = {
  low_batch: 'Card sales this day were under a tenth of your usual for that weekday, and the next day was over 1.5 times its usual. The sales may have been sent a day late.',
  zero_with_fees: 'Fees were charged on a day with no card sales. Often these are the fees for the day before, charged a day late. If they do not match that day, ask your processor what they were for.',
  prior_period: 'Sales dated before this statement starts but counted on it. Keep this in mind when you match the statement to your own books.',
  split_funding: 'Card sales from these days were paid in more than one deposit. The amount shown is the part paid a day or more after the first deposit; check it reached your bank.',
  unusual: 'A day with fees but no card sales, or a very low sales day followed by a busier than usual day. Check it against your own records.',
};

const TAG_LABEL = { penalty: 'Penalty', negotiable: 'Could be cut', watch: 'Keep watching', review: 'Ask about it' };
const FLAG_INFO = 'Why we marked this fee: a penalty you can stop, a fee that could be cut, a fee to keep watching, or an account fee to ask your processor about.';
const FEE_AS_PRINTED_INFO = 'The fee exactly as your statement prints it, so you can find the same line there.';
const A_YEAR_INFO = "An estimate: this month's fee times 12, as if it repeats every month. A fee charged once a year is counted once.";
const ESTIMATE_INFO = 'A best guess, not an exact amount. The yearly figures assume each fee repeats every month, and count a once-a-year fee once.';

const CATEGORY_LABEL = { transaction: 'Transaction', account: 'Account', interchange: 'Card network', other: 'Other' };
// A fee line's card group by the names the rest of the page uses, not the
// statement's capitals; other groups as printed.
const PRODUCT_NAME = { VISA: 'Visa', MASTERCARD: 'Mastercard', DISCOVER: 'Discover', AMEX: 'Amex', 'AMEX ACQ': 'Amex', 'DEBIT CARD': 'Debit card' };
const productName = (p) => PRODUCT_NAME[String(p).trim().toUpperCase()] || p;

// Card types by the names an owner knows (the donut, the card-type tables,
// the card mix key), not the statement's capitals ("AMEX ACQ", "Debit/Atm").
// DEBIT is the statement's PIN-debit row only (Visa and Mastercard debit are
// filed under Visa and Mastercard), so it is not called plain "Debit", which
// Finding 01 uses for all debit cards.
const CARD_TYPE_NAME = { VISA: 'Visa', MASTERCARD: 'Mastercard', AMEX: 'Amex', DISCOVER: 'Discover', DEBIT: 'PIN debit', ACCOUNT_OTHER: 'Other fees' };
const CARD_TYPE_LONG = { ACCOUNT_OTHER: 'Account and other fees' };
// On a CSV file the DEBIT row is any sale marked debit with no brand, not
// known to be PIN debit.
const cardTypeName = (r, csv) => (r.type === 'DEBIT' && csv ? 'Debit, no brand' : CARD_TYPE_NAME[r.type]) || String(r.label || r.type || 'Other')
  .toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

// Colour follows the card network, never its rank in this month's mix, so
// Amex is the same colour on every statement.
const NETWORK_SLOT = { VISA: 0, MASTERCARD: 1, AMEX: 2, DISCOVER: 3, DEBIT: 4 };
const networkColor = (theme, type) => (NETWORK_SLOT[type] != null ? theme.series[NETWORK_SLOT[type]] : theme.other);

const FRI_SUN = new Set(['Fri', 'Sat', 'Sun']);
const NARROW_QUERY = '(max-width: 760px)';
const POLL_MS = 3000;
// How long the note after a Reanalyse ("Reanalysed · 7 of 7 totals add up")
// stays: the .csd-updated fade in the stylesheet runs the same 6s.
const DONE_MS = 6000;
// A request that never reached the server. The browser's own message for
// this is "Failed to fetch", which tells an owner nothing.
const UNREACHABLE = 'Could not reach the server. Check your connection and try again.';

const prefersReducedMotion = () => (typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
  : false);

// Recharts takes literal colours. The alert colour is the app's own --red
// token, read off <html> so it follows the theme the chart re-renders for.
const cssVar = (name, fallback) => {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch { return fallback; }
};

/* ── Small hooks ─────────────────────────────────────────────────────────── */

function useMediaQuery(query) {
  const get = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    // Safari before 14 only has the old listener API.
    if (mq.addEventListener) mq.addEventListener('change', on); else mq.addListener(on);
    return () => { if (mq.removeEventListener) mq.removeEventListener('change', on); else mq.removeListener(on); };
  }, [query]);
  return matches;
}

/**
 * Count a figure up from zero, once per value. Skipped entirely under
 * prefers-reduced-motion: the final number is simply there.
 */
function useCountUp(target, ms = 900) {
  const [value, setValue] = useState(() => (prefersReducedMotion() ? target : 0));
  useEffect(() => {
    if (!isNum(target)) return undefined;
    if (prefersReducedMotion()) { setValue(target); return undefined; }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now) => {
      // A frame's timestamp can come from just before t0 was read: below 0
      // the easing turns negative, and the saving flashed as "-$...".
      const p = Math.max(0, Math.min(1, (now - t0) / ms));
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(p >= 1 ? target : target * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    setValue(0);
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}

/* ── Shared fetch plumbing ───────────────────────────────────────────────── */

// nginx answers a 413 or 504 with an HTML page, not JSON. Reading that as JSON
// throws a SyntaxError that says nothing about the real problem.
const readJson = (res) => res.json().catch(() => ({}));

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// RFC 5987 first (the route sends filename*=), then the plain form.
function fileNameFrom(res, fallback) {
  const cd = res.headers.get('Content-Disposition') || '';
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(cd);
  if (star) { try { return decodeURIComponent(star[1].trim()); } catch { /* fall through */ } }
  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(cd);
  return plain ? plain[1].trim() : fallback;
}

/* ═══════════════════════════════════════════════════════════════════════════
   DETAIL
   ═══════════════════════════════════════════════════════════════════════════ */

export default function CardStatementDetail({ id, authToken, apiUrl, onBack, onChanged }) {
  const base = (apiUrl || '').replace(/\/api\/?$/, '') + '/api/card-statements';
  const headers = useCallback(() => ({
    Authorization: `Bearer ${authToken}`,
    'ngrok-skip-browser-warning': 'true',
  }), [authToken]);

  const dialog = useDialog();
  // The statement on screen. Usually the `id` the list opened, but the
  // duplicate banner can step across to the original without a round trip
  // through the list.
  const [sid, setSid] = useState(id);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [acting, setActing] = useState('');      // 'reanalyse' | 'delete' | 'csv' | 'original' | ''
  const [viewing, setViewing] = useState(false); // the in-app document viewer
  const [tab, setTab] = useState('overview');
  // Lower-priority checks open one at a time and stay open while the owner
  // moves between tabs; another statement starts with them closed (D43).
  const [openChecks, setOpenChecks] = useState({});
  const toggleCheck = useCallback((key) => setOpenChecks((o) => ({ ...o, [key]: !o[key] })), []);
  const narrow = useMediaQuery(NARROW_QUERY);
  const latestSid = useRef(sid);
  const prevStatus = useRef(null);

  useEffect(() => { setSid(id); }, [id]);
  useEffect(() => { setOpenChecks({}); }, [sid]);
  useEffect(() => { latestSid.current = sid; }, [sid]);

  // A 401 is an expired session, never a document problem (the API promises
  // that). Clear it and go to sign-in, as every other screen does.
  const guard = useCallback((res) => {
    if (res.status === 401) {
      clearSession();
      window.location.href = '/login';
      throw new Error('Your session has ended. Please sign in again.');
    }
    return res;
  }, []);

  // Every load takes a number, and only the latest may touch the screen:
  // Refresh is never disabled, so two presses (or a press and a poll) can be
  // in flight together and answer out of order. A newer load also cancels
  // the one before it. Resolves to the load's number when its answer is the
  // statement now on screen, 0 otherwise.
  const loadSeq = useRef(0);
  const loadAbort = useRef(null);
  const load = useCallback(async ({ quiet = false } = {}) => {
    const want = sid;
    const seq = ++loadSeq.current;
    // Overtaken by a newer load, or another statement was opened meanwhile.
    const current = () => seq === loadSeq.current && latestSid.current === want;
    if (loadAbort.current) loadAbort.current.abort();
    const abort = new AbortController();
    loadAbort.current = abort;
    if (!quiet) setLoading(true);
    try {
      // no-store: a Refresh must reach the server, never a cached answer.
      const res = guard(await fetch(`${base}/${want}`, { headers: headers(), cache: 'no-store', signal: abort.signal })
        .catch((e) => {
          // The browser's own words for a network failure are "Failed to fetch".
          if (e && e.name === 'AbortError') throw e;
          throw new Error(UNREACHABLE);
        }));
      const body = await readJson(res);
      if (!current()) return 0;
      if (res.status === 404) { setNotFound(true); setDetail(null); setError(''); return 0; }
      if (!res.ok) throw new Error(errorText(body.error, 'Could not load this statement.'));
      setNotFound(false);
      setDetail(body);
      setError('');
      return seq;
    } catch (e) {
      // An aborted load is always an overtaken one: nothing to say.
      if (current()) setError(errorText(e, 'Could not load this statement.'));
      return 0;
    } finally {
      // The latest load ends the spinner whether or not it was quiet: a loud
      // one overtaken by a poll would otherwise never clear it.
      if (current()) setLoading(false);
    }
  }, [base, sid, headers, guard]);

  // Reanalyse is the one way to redo a statement: it reads the stored original
  // from the start, checks every printed total again and rebuilds the
  // analysis (POST /reanalyse with reextract, 202, then this screen polls).
  // While it runs the status says Analysing… and no figures show; when it
  // lands, a note says how the printed totals came out ("7 of 7 totals add up"). A
  // read that fails shows the Could not read banner instead.
  const [doneNote, setDoneNote] = useState('');
  const reanalysingRef = useRef(false);   // set on a press, cleared when its read lands
  useEffect(() => {
    if (!doneNote) return undefined;
    const t = setTimeout(() => setDoneNote(''), DONE_MS);
    return () => clearTimeout(t);
  }, [doneNote]);
  // The note is centred under the button, but the button can sit at either end
  // of a row of wrapped buttons and the page clips what spills past its edges,
  // so the note is nudged back inside the page's content when it would spill.
  const noteRef = useRef(null);
  useLayoutEffect(() => {
    const note = noteRef.current;
    if (!note) return;
    note.style.marginLeft = '';
    const page = doneNote && note.closest('.ref-page');
    if (!page) return;
    const pad = window.getComputedStyle(page);
    const edge = page.getBoundingClientRect().left + page.clientLeft;
    const left = edge + parseFloat(pad.paddingLeft);
    const right = edge + page.clientWidth - parseFloat(pad.paddingRight);
    const box = note.getBoundingClientRect();
    const dx = box.left < left ? left - box.left : (box.right > right ? right - box.right : 0);
    if (dx) note.style.marginLeft = `${dx}px`;
  }, [doneNote]);

  useEffect(() => {
    setDetail(null); setTab('overview'); setViewing(false); prevStatus.current = null;
    // Another statement: a reanalyse still running was for the last one.
    reanalysingRef.current = false; setDoneNote('');
    load();
  }, [load]);

  // Written as 'analysing' before the work begins, so poll quietly until it
  // settles, then stop. A permanent timer on a finished statement is wasted
  // requests.
  const status = detail ? detail.status : null;
  useEffect(() => {
    if (status !== 'analysing') return undefined;
    const t = setInterval(() => load({ quiet: true }), POLL_MS);
    return () => clearInterval(t);
  }, [status, load]);

  // The list shows the same row, so tell it when the background work lands;
  // and after a Reanalyse from here, say how the checks came out.
  const recon = detail && detail.reconciliation;
  useEffect(() => {
    if (prevStatus.current === 'analysing' && status && status !== 'analysing') {
      if (onChanged) onChanged();
      if (reanalysingRef.current && status === 'analysed') {
        const checks = recon && isNum(recon.passed) && isNum(recon.total) ? ` · ${recon.passed} of ${recon.total} totals add up` : '';
        setDoneNote(`Reanalysed${checks}`);
      }
      reanalysingRef.current = false;
    }
    prevStatus.current = status;
  }, [status, onChanged, recon]);

  useCellTitles(null, [detail, tab]);

  /* ── Actions ──────────────────────────────────────────────────────────── */

  // The file endpoint is a GET behind the JWT, so it cannot be a plain
  // <a href>. useCallback keeps the viewer from re-downloading on every poll.
  const fetchOriginal = useCallback(async (download) => {
    const res = guard(await fetch(`${base}/${sid}/file${download ? '?download=1' : ''}`, { headers: headers() }));
    if (!res.ok) throw new Error('The original file could not be opened.');
    return res.blob();
  }, [base, sid, headers, guard]);
  const fetchInline = useCallback(() => fetchOriginal(false), [fetchOriginal]);

  const isCsvFile = !!detail && (/csv/i.test(detail.fileMime || '') || /\.csv$/i.test(detail.fileName || '') || detail.layoutVersion === 'csv');

  const downloadOriginal = async () => {
    setActing('original');
    try {
      const blob = await fetchOriginal(true);
      saveBlob(blob, (detail && detail.fileName) || `statement-${sid}${isCsvFile ? '.csv' : '.pdf'}`);
    } catch (e) {
      dialog.alert({ title: 'Could not download the original', message: errorText(e, 'The file could not be fetched.'), tone: 'danger' });
    } finally { setActing(''); }
  };

  // PDFs open in the app beside the analysis; a CSV has nothing to preview, so
  // the same button simply saves it.
  const openOriginal = () => { if (isCsvFile) downloadOriginal(); else setViewing(true); };

  const exportCsv = async () => {
    setActing('csv');
    try {
      const res = guard(await fetch(`${base}/${sid}/csv`, { headers: headers() }));
      if (!res.ok) {
        const body = await readJson(res);
        throw new Error(errorText(body.error, 'The export could not be built.'));
      }
      const blob = await res.blob();
      const ym = detail && detail.periodEnd ? String(detail.periodEnd).slice(0, 7) : '';
      saveBlob(blob, fileNameFrom(res, `card-statement-${(detail && detail.merchantNumber) || sid}${ym ? `-${ym}` : ''}.csv`));
    } catch (e) {
      dialog.alert({ title: 'Could not export this statement', message: errorText(e, 'The export did not complete.'), tone: 'danger' });
    } finally { setActing(''); }
  };

  /**
   * Reanalyse: reads the stored original again from the start (reextract), so
   * every total is checked again and the analysis rebuilt, in the background
   * (202). The screen goes back to Analysing and polls; the effect above says
   * how the checks came out when the read lands.
   */
  const reanalyse = async () => {
    if (acting) return;
    setActing('reanalyse');
    setDoneNote('');
    reanalysingRef.current = true;
    try {
      const res = guard(await fetch(`${base}/${sid}/reanalyse`, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ reextract: true }),
      }));
      const body = await readJson(res);
      if (!res.ok) throw new Error(errorText(body.error, 'The analysis could not be run again.'));
      if (res.status === 202 || body.status === 'analysing') {
        setDetail((d) => (d ? { ...d, status: 'analysing', parseError: null } : d));
        load({ quiet: true });
      } else if (body && body.id != null) {
        setDetail(body);
      } else {
        load({ quiet: true });
      }
      setError('');
      if (onChanged) onChanged();
    } catch (e) {
      reanalysingRef.current = false;
      dialog.alert({ title: 'Could not analyse it again', message: errorText(e, 'The analysis did not run.'), tone: 'danger' });
    } finally { setActing(''); }
  };

  const remove = async () => {
    const name = (detail && (detail.merchantName || detail.fileName)) || 'This statement';
    const yes = await dialog.confirm({
      title: 'Delete this statement?',
      message: `${name}${detail && detail.periodEnd ? ` (${monthLabel(detail.periodEnd)})` : ''} and its original file will be removed. This cannot be undone.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Keep',
      tone: 'danger',
    });
    if (!yes) return;
    setActing('delete');
    try {
      const res = guard(await fetch(`${base}/${sid}`, { method: 'DELETE', headers: headers() }));
      if (!res.ok) {
        const body = await readJson(res);
        throw new Error(errorText(body.error, 'The statement could not be deleted.'));
      }
      if (onChanged) onChanged();
      if (onBack) onBack();
    } catch (e) {
      dialog.alert({ title: 'Could not delete it', message: errorText(e, 'The statement was not deleted.'), tone: 'danger' });
    } finally { setActing(''); }
  };

  // Fire and forget: the new tab is already open, and a lost interest event
  // must never look like a failed click.
  const recordInterest = () => {
    try {
      fetch(`${base}/${sid}/rebelipay-interest`, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: '{}',
        keepalive: true,
      }).catch(() => {});
    } catch { /* never surfaces */ }
  };

  /* ── Render ───────────────────────────────────────────────────────────── */

  const backBtn = (
    <button type="button" className="csd-back" onClick={onBack}>
      <ArrowLeft size={14} /> Back to statements
    </button>
  );

  if (notFound) {
    return (
      <div className="csd">
        {backBtn}
        <div className="ref-empty">
          <CreditCard size={26} />
          <p>This statement is no longer here. It may have been deleted.</p>
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="csd">
        {backBtn}
        {loading || !error ? (
          <>
            <div className="csd-skel-head" />
            <div className="ref-skel-tiles">{[0, 1, 2, 3].map((i) => <div key={i} className="ref-skel-tile" />)}</div>
          </>
        ) : (
          <div className="ref-error"><AlertTriangle size={18} /><span>{error}</span><button type="button" onClick={() => load()}>Retry</button></div>
        )}
      </div>
    );
  }

  const a = detail.status === 'analysed' ? detail.analysis : null;
  const analysing = detail.status === 'analysing';
  const isDuplicate = detail.status === 'duplicate';
  // Reading: the statement is being read, or a Reanalyse is on its way there.
  const busyReading = analysing || acting === 'reanalyse';
  const failedChecks = detail.status === 'analysed'
    ? ((detail.reconciliation && detail.reconciliation.checks) || []).filter((c) => c && !c.ok && !c.skipped)
    : [];
  const findings = a && Array.isArray(a.findings) ? a.findings : [];
  const processor = (a && a.processor) || detail.processor;
  const periodEnd = (a && a.period && a.period.end) || detail.periodEnd;
  const periodStart = (a && a.period && a.period.start) || detail.periodStart;
  const periodText = (a && a.period && a.period.label) || (periodEnd ? monthLabel(periodEnd) : null);
  const layout = (a && a.layoutVersion) || detail.layoutVersion;
  const title = detail.merchantName || (a && a.merchant && a.merchant.name) || detail.fileName || `Statement #${detail.id}`;

  const hero = a && a.rebelipay ? (
    <RebelipaySavingsHero
      rebelipay={a.rebelipay}
      savingsToDate={detail.savingsToDate}
      csv={layout === 'csv'}
      ctaUrl={detail.rebelipayCtaUrl || 'https://rebelipay.com'}
      processor={processor}
      onInterest={recordInterest}
    />
  ) : null;

  const TABS = [
    { key: 'overview', label: 'Overview' },
    { key: 'fees', label: 'Fees', count: Array.isArray(a && a.feeLines) ? a.feeLines.length : null },
    { key: 'daily', label: 'Day by day' },
    { key: 'mix', label: 'Card types' },
    {
      key: 'notices',
      label: 'Notices and disputes',
      count: !a || layout === 'csv' ? null
        : (Array.isArray(a.notices) ? a.notices.length : 0) + ((a.disputes && Number(a.disputes.count)) || 0),
    },
  ];

  const onTabKey = (e) => {
    const i = TABS.findIndex((t) => t.key === tab);
    let next = null;
    if (e.key === 'ArrowRight') next = (i + 1) % TABS.length;
    if (e.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = TABS.length - 1;
    if (next == null) return;
    e.preventDefault();
    setTab(TABS[next].key);
    const el = document.getElementById(`csd-tab-${TABS[next].key}`);
    if (el) el.focus();
  };

  return (
    <div className="csd">
      {backBtn}

      <header className="csd-head">
        <div className="csd-head-titles">
          <h1 className="csd-title">{title}</h1>
          <p className="csd-sub">
            <StatusPill status={detail.status} />
            {detail.merchantNumber && (
              <span className="csd-sub-item">
                Merchant ID {detail.merchantNumber}
                <MetricInfo label="Merchant ID" info="Your store's ID with your card processor (the merchant number on your statement). We use it to link uploads from the same account." />
              </span>
            )}
            {/* A file covers a span of days, not a month: only the dates. */}
            {layout === 'csv' && periodStart && periodEnd
              ? <span>{shortDay(periodStart)} to {formatLocalDate(periodEnd, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
              : periodText && (
                <span>
                  {periodText}
                  {periodStart && periodEnd ? ` (${shortDay(periodStart)} to ${shortDay(periodEnd)})` : ''}
                </span>
              )}
            {processor && <span>Card processor: {processor}</span>}
            {LAYOUT_TAG[layout] && (
              <span className="csd-layout-tag">
                {LAYOUT_TAG[layout]}
                <MetricInfo label={LAYOUT_TAG[layout]} info={LAYOUT_INFO[layout]} />
              </span>
            )}
          </p>
        </div>
        <div className="csd-actions">
          <button type="button" className="ref-btn" onClick={openOriginal} disabled={isDuplicate || acting === 'original'}>
            {isCsvFile ? <Download size={14} /> : <FileText size={14} />} Original
          </button>
          <button type="button" className="ref-btn" onClick={exportCsv} disabled={!a || acting === 'csv'}>
            <Download size={14} /> CSV
          </button>
          {/* Reads the original again, checks every total, rebuilds the
              analysis. Says Analysing… for as long as that runs (a minute or
              two), and is off for a copy of another statement. */}
          <span className="csd-refresh">
            <button
              type="button" className="ref-btn csd-reanalyse" onClick={reanalyse}
              disabled={busyReading || isDuplicate || !!acting} aria-busy={busyReading}
            >
              <RefreshCw size={14} className={busyReading ? 'ref-spin' : ''} /> {busyReading ? 'Analysing…' : 'Reanalyse'}
            </button>
            {/* Always in the page, so a screen reader hears the note arrive;
                out of the flow, so it moves nothing. */}
            <span className="csd-updated-live" role="status" ref={noteRef}>
              {doneNote && (
                <span className="csd-updated"><Check size={13} aria-hidden="true" /> {doneNote}</span>
              )}
            </span>
          </span>
          <button type="button" className="ref-btn csd-btn-danger" onClick={remove} disabled={acting === 'delete'}>
            <Trash2 size={14} /> Delete
          </button>
        </div>
      </header>

      {error && <div className="csd-banner csd-banner-bad" role="alert"><AlertTriangle size={16} /><div>{error}</div></div>}

      {/* ── Banners ─────────────────────────────────────────────────────── */}
      {detail.status === 'failed' && (
        <div className="csd-banner csd-banner-bad" role="alert">
          <AlertTriangle size={16} />
          <div className="csd-banner-body">
            <strong>Could not read this statement.</strong>
            <div>{detail.parseError || 'No reason was recorded.'}</div>
            <div className="csd-banner-hint">The original file is still here. Reanalyse reads it again, which often works.</div>
          </div>
        </div>
      )}

      {isDuplicate && (
        <div className="csd-banner csd-banner-info">
          <Copy size={16} />
          <div className="csd-banner-body">
            <strong>Same statement as #{detail.duplicateOf || '?'}</strong>
            <div>This merchant and period were already uploaded, so this copy was not added again.</div>
          </div>
          {detail.duplicateOf && (
            <button type="button" className="ref-btn" onClick={() => setSid(String(detail.duplicateOf))}>
              Open #{detail.duplicateOf}
            </button>
          )}
        </div>
      )}

      {failedChecks.length > 0 && (
        <div className="csd-banner csd-banner-warn">
          <AlertTriangle size={16} />
          <div className="csd-banner-body">
            <strong>Some printed totals did not add up when we checked them.</strong>
            <ul className="csd-check-list">
              {failedChecks.map((c, i) => <li key={c.name || i}>{c.label || c.name}</li>)}
            </ul>
            <div className="csd-banner-hint">
              The figures below are as read. Compare them with the original, or use Reanalyse to read it again.
            </div>
          </div>
        </div>
      )}

      {analysing && (
        <div className="ref-card csd-analysing" role="status" aria-live="polite">
          <Loader size={20} className="ref-spin" />
          <div>
            <strong>Analysing…</strong>
            <p>Reading the statement and checking every total. This usually takes a minute or two, and this page updates by itself.</p>
          </div>
        </div>
      )}

      {a && (
        <>
          {!narrow && hero}

          <KpiBand kpis={a.kpis || {}} rebelipay={a.rebelipay} csv={layout === 'csv'} />

          <div className="ref-subtabs csd-tabs" role="tablist" aria-label="Statement sections" onKeyDown={onTabKey}>
            {TABS.map((t) => (
              <button
                key={t.key}
                id={`csd-tab-${t.key}`}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                aria-controls={`csd-panel-${t.key}`}
                tabIndex={tab === t.key ? 0 : -1}
                className={`ref-subtab ${tab === t.key ? 'is-on' : ''}`}
                onClick={() => setTab(t.key)}
              >
                {t.label}
                {t.count != null && <span className="ref-subtab-count">{t.count}</span>}
              </button>
            ))}
          </div>

          <div id={`csd-panel-${tab}`} role="tabpanel" aria-labelledby={`csd-tab-${tab}`} className="csd-panel">
            {tab === 'overview' && (
              <>
                {narrow && hero}
                {findings.length === 0
                  ? <NotOnStatement />
                  : <FindingsOverview findings={findings} analysis={a} onTab={setTab} csv={layout === 'csv'} open={openChecks} onToggle={toggleCheck} />}
              </>
            )}
            {tab === 'fees' && <FeesTab analysis={a} />}
            {tab === 'daily' && <DailyTab analysis={a} />}
            {tab === 'mix' && <CardMixTab analysis={a} />}
            {tab === 'notices' && <NoticesTab analysis={a} />}
          </div>
        </>
      )}

      <div className="ref-disclaimer">
        Savings figures are estimates based on this {layout === 'csv' ? 'file' : 'statement'} and are not guaranteed. They are not tax, legal, or accounting advice.
      </div>

      <DocumentViewer
        open={viewing}
        title={periodText ? `${title} · ${periodText}` : title}
        fileName={detail.fileName}
        mimeType={detail.fileMime}
        fetchBlob={fetchInline}
        onClose={() => setViewing(false)}
        onDownload={downloadOriginal}
        pdfToolbar={false}
      />
    </div>
  );
}

/* ── Status ──────────────────────────────────────────────────────────────── */

// The statement's status, as the list shows it: Analysing… while a read runs
// (an upload, or a Reanalyse), then Analysed or Could not read. A copy of
// another statement has its own banner instead.
function StatusPill({ status }) {
  if (status === 'analysed') return <span className="csd-status is-ok"><Check size={12} aria-hidden="true" /> Analysed</span>;
  if (status === 'failed') return <span className="csd-status is-bad"><AlertTriangle size={12} aria-hidden="true" /> Could not read</span>;
  if (status === 'analysing') return <span className="csd-status is-wait"><Loader size={12} className="ref-spin" aria-hidden="true" /> Analysing…</span>;
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   REBELIPAY SAVINGS HERO
   ═══════════════════════════════════════════════════════════════════════════ */

// A share too small to show at one decimal reads "under 0.1%", never "0.0%".
const smallPct = (v) => (isNum(v) && Number(v) > 0 && Number(v) < 0.05 ? 'under 0.1%' : pct(v, 1));

/**
 * What the owner would have kept with Rebelipay on this statement.
 *
 * Totals and one all-in rate only. The offer's own price never appears, not
 * even in the footnote (D7): the method is described in words. When Rebelipay
 * would not have been cheaper the API removes the figures, and this shows a
 * quiet sentence with no numbers and no button.
 */
function RebelipaySavingsHero({ rebelipay, savingsToDate, ctaUrl, processor, onInterest, csv }) {
  const rp = rebelipay || {};
  const eligible = rp.eligible === true && isNum(rp.savings);
  const savings = eligible ? Number(rp.savings) : null;
  // A penalty the store stops with a free step, whichever processor it uses
  // (the PCI form), is its own line beside switching, and the headline is the
  // two together (D49).
  const fix = eligible && isNum(rp.penaltyFix) && Number(rp.penaltyFix) > 0 ? Number(rp.penaltyFix) : 0;
  const total = !eligible ? null : (isNum(rp.totalFound) ? Number(rp.totalFound) : savings + fix);
  // The headline leads with the year, the bigger and steadier figure; the
  // statement's own amount sits under it (D49).
  const yearOf = (v) => (isNum(v) ? Number(v) : null);
  const switchYear = eligible ? yearOf(rp.savingsAnnual) : null;
  const fixYear = fix ? yearOf(rp.penaltyFixAnnual) : null;
  const totalYear = !eligible ? null : (fix ? yearOf(rp.totalFoundAnnual) : switchYear);
  const shown = useCountUp(isNum(totalYear) ? totalYear : total);
  const [byTypeOpen, setByTypeOpen] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  // Which part of the comparison the cursor is on: 'now' (paid today), 'rp'
  // (what Rebelipay would charge), 'save' (what switching keeps), 'fix' (the
  // penalty the store stops itself) or 'kept' (the two together), from the
  // bars, the lines, the pill or the donut alike. That part and its words
  // light up; the rest fades.
  const [hl, setHl] = useState(null);
  // Moving from one part to the next (a label to its bar, the bar to the
  // pill) crosses a gap of a few pixels. Clearing the highlight there at once
  // made the whole box blink back to normal and light up again; waiting a
  // moment lets the next part take over directly.
  const leaveTimer = useRef(0);
  const hover = useCallback((k) => { clearTimeout(leaveTimer.current); setHl(k); }, []);
  const leave = useCallback(() => {
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => setHl(null), 160);
  }, []);
  const onHl = useCallback((k) => (k ? hover(k) : leave()), [hover, leave]);
  useEffect(() => () => clearTimeout(leaveTimer.current), []);
  const group = typeof hl === 'string' && hl.startsWith('type:') ? 'now' : hl;
  // What the pill speaks for: with a penalty, the part pointed at (switching
  // or the fix) or else both together; without one, the one saving.
  const pillKey = !fix ? 'save' : (group === 'save' || group === 'fix' ? group : 'kept');
  // The pill's pointer sits under the middle of the part the pill speaks
  // for, measured from the bar itself (the fix segment is held at its
  // minimum width, so a share of the bar would miss it), never past the
  // pill's rounded ends, and glides there (see .csd-save-caret).
  const trackRef = useRef(null);
  const pillRef = useRef(null);
  const [caretRight, setCaretRight] = useState(null);
  useLayoutEffect(() => {
    const track = trackRef.current;
    const pillEl = pillRef.current;
    if (!track || !pillEl) return undefined;
    const place = () => {
      const parts = [...track.querySelectorAll(pillKey === 'kept' ? '.is-save, .is-fix' : `.is-${pillKey}`)]
        .map((e) => e.getBoundingClientRect());
      if (!parts.length) return;
      const mid = (Math.min(...parts.map((r) => r.left)) + Math.max(...parts.map((r) => r.right))) / 2;
      const right = track.getBoundingClientRect().right - mid - 5;
      const most = Math.max(14, pillEl.getBoundingClientRect().width - 24);
      setCaretRight(Math.round(Math.min(Math.max(right, 14), most)));
    };
    place();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(place);
    ro.observe(track);
    ro.observe(pillEl);
    return () => ro.disconnect();
  }, [pillKey, eligible]);

  if (!eligible) {
    if (rp.reason === 'no_current_fees') {
      return (
        <section className="ref-card csd-hero csd-hero-quiet" aria-label="Rebelipay comparison">
          <span className="csd-hero-eyebrow">Rebelipay <span className="ref-est-label">Estimate</span></span>
          <p className="csd-quiet-text">
            With Rebelipay, the card sales in this file would have cost an estimated <strong>{money(rp.rebelipayCost)}</strong> in
            fees. This file does not show what
            your processor charged, so we cannot compare the two.
          </p>
        </section>
      );
    }
    if (rp.reason === 'no_volume') {
      return (
        <section className="ref-card csd-hero csd-hero-quiet" aria-label="Rebelipay comparison">
          <span className="csd-hero-eyebrow">Rebelipay</span>
          <p className="csd-quiet-text">
            We found no card sales we could compare {csv ? 'in this file' : 'on this statement'}, so there is no Rebelipay estimate.
          </p>
        </section>
      );
    }
    if (rp.reason === 'incomplete') {
      return (
        <section className="ref-card csd-hero csd-hero-quiet" aria-label="Rebelipay comparison">
          <span className="csd-hero-eyebrow">Rebelipay</span>
          <p className="csd-quiet-text">
            We could not read every card type {csv ? 'in this file' : 'on this statement'} in full, so there is no Rebelipay
            estimate. Press Reanalyse at the top to try again.
          </p>
        </section>
      );
    }
    // Only a statement Rebelipay would really cost more on is called
    // competitive; any other reason gets a neutral line, never that claim.
    return (
      <section className="ref-card csd-hero csd-hero-quiet" aria-label="Rebelipay comparison">
        <span className="csd-hero-eyebrow">Rebelipay</span>
        <p className="csd-quiet-text">
          {rp.reason === 'costs_more'
            ? `Your current fees already match or beat our Rebelipay estimate for this ${csv ? 'file' : 'statement'}.`
            : `There is no Rebelipay comparison for this ${csv ? 'file' : 'statement'}.`}
        </p>
      </section>
    );
  }

  const current = Number(rp.currentCost) || 0;
  const withRp = Number(rp.rebelipayCost) || 0;
  const share = isNum(rp.savingsPct) ? Number(rp.savingsPct) : (current > 0 ? (savings / current) * 100 : 0);
  const toDate = savingsToDate && isNum(savingsToDate.amount) && Number(savingsToDate.amount) > 0
    && Number(savingsToDate.statements) >= 2 ? savingsToDate : null;
  const byType = Array.isArray(rp.byCardType) ? rp.byCardType : [];
  // The processor named on the statement. The page header already shows it,
  // so the bars say "Paid today" and leave it to the screen-reader label: as
  // "Paid to Better Payments" a name like that read as words.
  const processorName = processor || rp.currentProcessor || '';
  // The pill and its pointer cover everything kept: switching and the fix.
  const savePct = current > 0 ? (total / current) * 100 : 0;
  const keptShare = fix ? savePct : share;
  const fixLabel = rp.penaltyFixLabel || 'Stop the penalty fees';
  const fixShort = fixLabel.replace(/\s*\(.*\)\s*$/, '');
  const pci = /PCI/.test(fixLabel);
  const where = csv ? 'in this file' : 'on this statement';
  const yearWords = csv ? 'over 12 periods like this one' : 'a year';
  // A fee charged once a year counts once in the yearly figure, not 12 times.
  const yearlyOnce = isNum(switchYear) && Math.round(switchYear * 100) !== Math.round(savings * 100) * 12;
  const yearInfo = `The yearly figure is ${csv ? 'the amount in this file' : 'this statement’s amount'} times 12${yearlyOnce ? ', with a fee your processor charges once a year counted once' : ''}: an estimate at this pace, not a guarantee.`;
  // A card type in the donut's outer ring is a part of what was paid today,
  // so it lights the "Paid today" bar.
  const onAny = (...ks) => (group ? (ks.includes(group) ? ' is-on' : ' is-off') : '');
  const on = (k) => onAny(k);
  const lit = (k) => (group === k ? ' is-on' : '');
  // The pill's words for the part it speaks for.
  const fixShare = current > 0 ? (fix / current) * 100 : 0;
  // All of them are laid in one cell and only the current one shows, so the
  // pill keeps the width of the longest and its words cross-fade in place.
  const pillTexts = [
    { key: fix ? 'kept' : 'save', main: `You save ${money(total)}${fix ? ' in all' : ''}`, pct: `· ${pct(keptShare, 1)} of your fees` },
    ...(fix ? [
      { key: 'save', main: `Switching saves ${money(savings)}`, pct: `· ${pct(share, 1)} of your fees` },
      { key: 'fix', main: `${pci ? 'The PCI fix' : 'Stopping the penalties'} saves ${money(fix)}`, pct: `· ${smallPct(fixShare)} of your fees` },
    ] : []),
  ];
  const splitRows = fix ? [
    {
      key: 'save', name: 'Switch to Rebelipay', year: switchYear, now: savings,
      info: `Paid today less the ${pci ? 'PCI ' : ''}penalty, minus our estimate of what Rebelipay would charge for the same card sales. ${yearInfo}`,
    },
    {
      key: 'fix', name: fixLabel, year: fixYear, now: fix,
      info: pci
        ? `Your processor charged ${money(fix)} for not sending in your PCI security form. Filling in the free form, about 20 minutes, stops it with any processor, so we count it apart from switching. It is listed with your other fees below.`
        : `Your processor charged ${money(fix)} in penalty fees. They stop once the cause is fixed, with any processor, so we count them apart from switching. They are listed with your other fees below.`,
    },
    {
      key: 'total', name: 'Total savings Botella found', year: totalYear, now: total,
      info: `Switching to Rebelipay and ${pci ? 'fixing the PCI penalty' : 'stopping the penalty fees'}, added up. A penalty charged every month counts 12 times in the year, a yearly one once.`,
    },
  ] : [];

  const switchNow = () => {
    // Synchronously, inside the click, so no popup blocker treats it as
    // unrequested. The interest event follows and is never awaited.
    window.open(ctaUrl, '_blank', 'noopener,noreferrer');
    onInterest();
  };

  return (
    <section className="ref-card csd-hero" aria-labelledby="csd-hero-title">
      {/* Everything in the left 60%, top to bottom (eyebrow, headline,
          sub-line, bars, buttons, "How we calculated this"), and the donut in
          the right 40%, centred both ways in the whole height; under the bars
          on a narrow screen. See .csd-hero-body in the stylesheet. */}
      <div className="csd-hero-body">
        <div className="csd-hero-top">
          <span className="csd-hero-eyebrow">Rebelipay <span className="ref-est-label">Estimate</span></span>
        </div>
        {/* The year first, the statement's own amount under it (D49). With
            no yearly figure (never expected) it falls back to the statement. */}
        {(() => {
          const byYear = isNum(totalYear);
          const fig = byYear ? money0(totalYear) : money(total);
          const after = byYear ? ` ${yearWords}` : ` ${where}`;
          const lead = fix ? 'Botella found you about ' : (byYear ? 'With Rebelipay, you could save about ' : 'With Rebelipay, you’d have saved ');
          const tail = fix ? `${after} in savings` : after;
          return (
            <h2 id="csd-hero-title" className="csd-hero-title" aria-label={`${lead}${fig}${tail}`}>
              {/* The figure counts up inside a box held at its final width (an
                  invisible copy of the final figure shares the cell), so the
                  words after it stay still while the digits change, instead
                  of sliding along as the number grows. */}
              <span aria-hidden="true">
                {lead}
                <span className="csd-hero-figure">
                  <span className="csd-hero-figure-final">{fig}</span>
                  <strong className="csd-hero-amount">{byYear ? money0(shown) : money(shown)}</strong>
                </span>
                {tail}
              </span>
            </h2>
          );
        })()}
        <div className="csd-hero-sub">
          {fix ? (
            // Three lines, as the owner would act on them: switch, the free
            // fix, and what the two come to. Each line's year in bold, its
            // amount on this statement beside it (D49).
            <ul className="csd-split" aria-label="Where the savings come from">
              {splitRows.map((r) => (
                <li
                  key={r.key} className={`csd-split-row is-${r.key}${lit(r.key === 'total' ? 'kept' : r.key)}`}
                  onMouseEnter={() => hover(r.key === 'total' ? 'kept' : r.key)} onMouseLeave={leave}
                >
                  <span className="csd-split-name">
                    {r.key !== 'total' && <span className={`csd-sw is-${r.key}`} aria-hidden="true" />}
                    <span>{r.name}</span>
                    <MetricInfo label={r.name} info={r.info} />
                  </span>
                  <span className="csd-split-year">
                    {isNum(r.year) ? <><strong>{money0(r.year)}</strong> {yearWords}</> : null}
                  </span>
                  <span className="csd-split-now">{money(r.now)} {where}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="csd-split-one">
              {isNum(totalYear) ? <>{money(savings)} {where}</> : null}
              <MetricInfo label="The yearly figure" info={yearInfo} />
            </p>
          )}
          {toDate && (
            <span className="csd-hero-todate">
              {fix ? 'Switching would have saved you' : 'You’d have saved'} {money(toDate.amount)} across {num(toDate.statements)} of your uploads for this store
              <MetricInfo label="Saved across your uploads" info="Your estimated savings with Rebelipay on uploads for this store, added up. It counts every upload we could compare, including any where Rebelipay would not have saved you money." />
            </span>
          )}
        </div>

        {/* Two bars on one scale: what was paid today, and the same amount
            with Rebelipay, split into what Rebelipay would charge and what you
            keep, the highlight, with its pill under it. */}
        <div className="csd-compare">
          {/* The whole comparison in one sentence for a screen reader; the
              bars themselves are hidden from it, and their labels' ⓘ stay
              reachable (inside a role="img" they were not). */}
          <span className="csd-sr">
            {`Paid today${processorName ? ` to ${processorName}` : ''}: ${money(current)}. With Rebelipay: ${money(withRp)}. `
              + (fix
                ? `Switching saves ${money(savings)}, ${pci ? 'fixing the PCI penalty' : 'stopping the penalty fees'} saves ${money(fix)}: ${money(total)} in all, ${pct(keptShare, 1)} of your fees.`
                : `You save ${money(savings)}, ${pct(share, 1)} of your fees.`)}
          </span>
          <div className="csd-bar-row" onMouseEnter={() => hover('now')} onMouseLeave={leave}>
            <div className={`csd-bar-head${on('now')}`}>
              <span className="csd-bar-label">
                Paid today
                <MetricInfo label="Paid today" info={csv ? 'What you pay now: the fees listed in this file, added up.' : 'What you pay now: everything your current processor charged on this statement, including account fees and penalties.'} />
              </span>
              <strong className="csd-bar-value">{money(current)}</strong>
            </div>
            <div className="csd-bar-track" aria-hidden="true"><span className={`csd-bar-fill is-now${on('now')}`} /></div>
          </div>
          <div className="csd-bar-row">
            <div className={`csd-bar-head${on('rp')}`} onMouseEnter={() => hover('rp')} onMouseLeave={leave}>
              <span className="csd-bar-label">
                <span className="csd-bar-key" aria-hidden="true" />With Rebelipay
                <MetricInfo label="With Rebelipay" info="Our estimate of what Rebelipay would have charged you for the same card sales." />
              </span>
              <strong className="csd-bar-value">{money(withRp)}</strong>
            </div>
            <div className="csd-bar-track" aria-hidden="true" ref={trackRef}>
              <span className={`csd-bar-fill is-rp${on('rp')}`} style={{ flexGrow: withRp }} onMouseEnter={() => hover('rp')} onMouseLeave={leave} />
              <span className={`csd-bar-fill is-save${onAny('save', 'kept')}`} style={{ flexGrow: savings }} onMouseEnter={() => hover('save')} onMouseLeave={leave} />
              {fix > 0 && (
                <span className={`csd-bar-fill is-fix${onAny('fix', 'kept')}`} style={{ flexGrow: fix }} onMouseEnter={() => hover('fix')} onMouseLeave={leave} />
              )}
            </div>
            {/* The pill speaks for the part pointed at (with a penalty:
                switching, the fix, or both), its pointer under the middle of
                that part, never past the pill's own ends. Its words fade in
                when they change. */}
            <div className="csd-save-row">
              <span
                ref={pillRef}
                className={`csd-save-pill${fix ? onAny('save', 'fix', 'kept') : on('save')}`}
                onMouseEnter={() => hover(fix ? 'kept' : 'save')} onMouseLeave={leave}
              >
                <PiggyBank size={15} aria-hidden="true" />{' '}
                <span className="csd-save-words-box">
                  {pillTexts.map((x) => (
                    <span key={x.key} className={`csd-save-words${x.key === pillKey ? ' is-shown' : ''}`}>
                      <span className="csd-save-main">{x.main}</span> <span className="csd-save-pct">{x.pct}</span>
                    </span>
                  ))}
                </span>
                <MetricInfo
                  label="You save"
                  info={fix
                    ? `The estimated difference between Paid today and With Rebelipay: switching, and the ${money(fix)} ${pci ? 'PCI penalty' : 'in penalty fees'} you stop yourself. The percent is how much of your current fees that is.`
                    : 'The estimated difference between Paid today and With Rebelipay. The percent is how much of your current fees you would have saved.'}
                />
              </span>
              <span
                className={`csd-save-caret${fix ? onAny('save', 'fix', 'kept') : on('save')}`} aria-hidden="true"
                style={{ right: caretRight != null ? `${caretRight}px` : `clamp(14px, calc(${(savePct / 2).toFixed(2)}% - 6px), 140px)` }}
              />
            </div>
          </div>
        </div>
        <SavingsDonut paid={current} withRp={withRp} savings={savings} share={share} fix={fix} fixName={fixShort} byType={byType} processorName={processorName} hl={hl} onHl={onHl} csv={csv} />

        <div className="csd-hero-actions">
          <button type="button" className="csd-cta" onClick={switchNow}>
            Explore Rebelipay <ExternalLink size={14} />
          </button>
          {byType.length > 0 && (
            <button
              type="button"
              className="ref-btn"
              aria-expanded={byTypeOpen}
              aria-controls="csd-hero-bytype"
              onClick={() => setByTypeOpen((v) => !v)}
            >
              See by card type <ChevronDown size={13} className={byTypeOpen ? 'csd-rot' : ''} />
            </button>
          )}
        </div>

        {/* "How we calculated this": a toggle that stays under the buttons, and
            its text in a row of its own under the donut. As a <details> the
            text opened inside the rows the donut is centred in, made them
            taller, and the donut slid down; the card-type table, below it,
            opens under the donut for the same reason. */}
        <button
          type="button" className="csd-how" aria-expanded={howOpen} aria-controls="csd-hero-how"
          onClick={() => setHowOpen((v) => !v)}
        >
          How we calculated this
        </button>
        <div id="csd-hero-how" className="csd-how-text" hidden={!howOpen}>
          <p>
            {csv
              ? 'We priced every card sale in this file at Rebelipay’s one price for all card types. Then we compared that with the fees listed in the file.'
              : 'We priced every card sale on this statement at Rebelipay’s one price for all card types. Then we compared that with everything your processor charged you, including account fees and penalties. It assumes Rebelipay charges no account fees, penalties or other fees on top of that one price.'}
            {rp.refundsCredited ? ' Refunded sales get their Rebelipay fee back.' : ''}
            {fix > 0 && (pci
              ? ` The ${money(fix)} PCI penalty is on a line of its own: filling in the free PCI form stops it with any processor, so it is not part of the switching saving.`
              : ` The ${money(fix)} in penalty fees is on a line of its own: fixing the cause stops it with any processor, so it is not part of the switching saving.`)}
          </p>
          <p>
            {`For the yearly figures we multiply ${csv ? 'the amounts in this file' : 'this statement’s amounts'} by 12, and count a fee charged once a year only once.`}
          </p>
          <p>This is an estimate based on this {csv ? 'file' : 'statement'}, not a guarantee.</p>
        </div>

        {byTypeOpen && byType.length > 0 && (
          <div id="csd-hero-bytype" className="ref-table-wrap csd-hero-table">
            <table className="ref-table csd-table-sm">
              <thead>
                <tr>
                  <Th label="Card type" />
                  <Th num label="Number of sales" infoLabel="Number of sales, by card type" info="How many card sales of this type, not counting refunds." />
                  <Th num label="Sales before refunds" infoLabel="Sales before refunds, by card type" info="What customers paid with this card type, before refunds were taken off." />
                  <Th num label="Paid today" infoLabel="Paid today, by card type" info={csv ? 'The fees this file lists for this card type.' : 'The fees your processor charged for this card type. Fees not tied to one card type, like account fees and penalties, are in their own row.'} />
                  <Th num label="With Rebelipay" infoLabel="With Rebelipay, by card type" info="Our estimate of what Rebelipay would have charged for these same sales." />
                  <Th num label="You save" infoLabel="You save, by card type" info="Our estimate: Paid today minus With Rebelipay. One card type can cost a little more with Rebelipay while the total still saves you money." />
                </tr>
              </thead>
              <tbody>
                {byType.filter((r) => !(csv && r.type === 'ACCOUNT_OTHER' && !(Number(r.currentCost) > 0))).map((r, i) => (
                  <tr key={r.type || i}>
                    <td className="ref-name">{CARD_TYPE_LONG[r.type] || cardTypeName(r, csv)}</td>
                    <td className="ref-num">{num(r.transactions)}</td>
                    <td className="ref-num">{money(r.volume)}</td>
                    <td className="ref-num">{money(r.currentCost)}</td>
                    <td className="ref-num">{money(r.rebelipayCost)}</td>
                    {/* A card type can cost a few cents more on its own while the
                        statement as a whole saves: honest arithmetic, but never in
                        the saving colour. Zero or less stays muted. */}
                    <td className={`ref-num ${Number(r.savings) > 0 ? 'ref-good' : 'csd-muted'}`}>{money(r.savings)}</td>
                  </tr>
                ))}
                <tr className="csd-total-row">
                  <td>Total</td>
                  <td className="ref-num">{num(rp.transactions)}</td>
                  <td className="ref-num">{money(rp.volume)}</td>
                  <td className="ref-num">{money(rp.currentCost)}</td>
                  <td className="ref-num">{money(rp.rebelipayCost)}</td>
                  <td className="ref-num ref-good">{money(rp.savings)}</td>
                </tr>
              </tbody>
            </table>
            {fix > 0 && (
              <p className="csd-table-note">
                {`You save is the switching saving. The ${money(fix)} ${pci ? 'PCI penalty' : 'in penalty fees'} is in Paid today but not in You save: ${pci ? 'the free form' : 'fixing the cause'} stops it with any processor.`}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/* ── Savings donut ───────────────────────────────────────────────────────── */

const shareText = (part, whole) => {
  const p = whole > 0 ? (part / whole) * 100 : 0;
  return p > 0 && p < 1 ? 'under 1%' : `${Math.round(p)}%`;
};
// A highlight index can only be one the stylesheet knows (t-0 .. t-7).
const MAX_TYPES = 8;

// One ring, so there is one thing to read. With the card types known (two or
// more), the ring is what was paid today, split by card type in the Card
// types tab's network colours (account fees and penalties grey), biggest
// first from the top and account fees last, and its middle gives the three
// totals: paid today, with Rebelipay, and what you save (the saving's figure
// green). Pointing at a card type, its slice or its key, reads that card out
// instead: what it cost today, its share of your fees, what Rebelipay would
// have charged for it, and what you save on it, only when it saves (a card
// type can cost a few cents more on its own, never shown as a saving). The
// bars stay the comparison; the ring is where today's fees went. Pointing at
// the bars reads their totals out in the middle. Without card types (an
// older payload, or only one), the ring is the bars' second row as a share:
// what Rebelipay would charge and what you save, its middle asking for a
// hover. Highlighting is CSS on data attributes, and the chart's props stay
// the same objects from one render to the next, so a hover never restarts
// its drawing.
function SavingsDonut({ paid, withRp, savings, share, fix = 0, fixName = '', byType, processorName, hl, onHl, csv }) {
  const chart = useChartTheme();
  // With a penalty the store stops itself, what it keeps is two slices (D49).
  const split = useMemo(() => [
    { key: 'save', name: fix > 0 ? 'Switch to Rebelipay' : 'You save', value: savings },
    ...(fix > 0 ? [{ key: 'fix', name: fixName, value: fix }] : []),
    { key: 'rp', name: 'With Rebelipay', value: withRp },
  ], [savings, withRp, fix, fixName]);
  const kept = savings + (fix > 0 ? fix : 0);
  const types = useMemo(() => (Array.isArray(byType) ? byType : [])
    .filter((r) => r && isNum(r.currentCost) && Number(r.currentCost) > 0)
    .map((r) => ({
      key: r.type,
      name: cardTypeName(r, csv),
      long: CARD_TYPE_LONG[r.type] || cardTypeName(r, csv),
      value: Number(r.currentCost),
      rebelipay: isNum(r.rebelipayCost) ? Number(r.rebelipayCost) : null,
      savings: isNum(r.savings) ? Number(r.savings) : null,
      fill: r.type === 'ACCOUNT_OTHER' ? chart.other : networkColor(chart, r.type),
      last: r.type === 'ACCOUNT_OTHER',
    }))
    .sort((a, b) => (a.last - b.last) || (b.value - a.value))
    .slice(0, MAX_TYPES), [byType, chart, csv]);
  const byCard = types.length > 1;
  const enter = useCallback((_, i) => {
    if (byCard) onHl(types[i] ? `type:${i}` : null);
    else onHl(split[i] ? split[i].key : null);
  }, [onHl, byCard, types, split]);
  const leave = useCallback(() => onHl(null), [onHl]);
  if (!(paid > 0) || !isNum(savings) || !(savings > 0) || !isNum(withRp) || withRp < 0) return null;
  const typeIndex = byCard && typeof hl === 'string' && hl.startsWith('type:') ? Number(hl.slice(5)) : null;
  const t = typeIndex != null ? types[typeIndex] : null;

  let centre;
  let centreKind;
  if (t) {
    centreKind = `type:${typeIndex}`;
    centre = (
      <>
        <span className="csd-donut-label">{t.long}</span>
        <strong className="csd-donut-value">{money(t.value)}</strong>
        <span className="csd-donut-line">{shareText(t.value, paid)} of your fees</span>
        {t.rebelipay != null && <span className="csd-donut-line">With Rebelipay {money(t.rebelipay)}</span>}
        {t.savings > 0 && <span className="csd-donut-line">You save <strong className="csd-donut-save">{money(t.savings)}</strong></span>}
      </>
    );
  } else if (hl === 'rp') {
    // What it comes to against today, the difference, not its share of
    // today ("93.4%" told the reader nothing).
    centreKind = 'rp';
    centre = (
      <>
        <strong className="csd-donut-value">{money(withRp)}</strong>
        <span className="csd-donut-label">With Rebelipay · {money(kept)} less than you paid</span>
      </>
    );
  } else if (hl === 'save') {
    centreKind = 'save';
    centre = (
      <>
        <strong className="csd-donut-value">{money(savings)}</strong>
        <span className="csd-donut-label">{fix > 0 ? 'Switch to Rebelipay' : 'You save'} · {pct(share, 1)} of your fees</span>
      </>
    );
  } else if (hl === 'fix' && fix > 0) {
    centreKind = 'fix';
    centre = (
      <>
        <strong className="csd-donut-value">{money(fix)}</strong>
        <span className="csd-donut-label">{fixName} · {smallPct((fix / paid) * 100)} of your fees</span>
      </>
    );
  } else if (hl === 'kept' && fix > 0) {
    // Switching and the fix together, as the pill and the Total line say.
    centreKind = 'kept';
    centre = (
      <>
        <strong className="csd-donut-value">{money(kept)}</strong>
        <span className="csd-donut-label">You save in all · {pct((kept / paid) * 100, 1)} of your fees</span>
      </>
    );
  } else if (byCard || hl === 'now') {
    centreKind = 'paid';
    centre = (
      <>
        <span className="csd-donut-label">Paid today</span>
        <strong className="csd-donut-value">{money(paid)}</strong>
        <span className="csd-donut-line">With Rebelipay {money(withRp)}</span>
        <span className="csd-donut-line">You save <strong className="csd-donut-save">{money(kept)}</strong>{fix > 0 ? ' in all' : ''}</span>
      </>
    );
  } else {
    centreKind = 'hint';
    centre = (
      <span className="csd-donut-hint">
        <MousePointerClick size={18} />
        <span>
          <span className="csd-hint-mouse">Hover over</span><span className="csd-hint-touch">Tap</span> the chart or
          the bars to see each amount
        </span>
      </span>
    );
  }
  const dataHl = t ? 'type' : (['now', 'rp', 'save', 'fix', 'kept'].includes(hl) ? hl : undefined);
  const fixSaid = fix > 0 ? `, and ${/PCI/.test(fixName) ? 'fixing the PCI penalty' : 'stopping the penalty fees'} saves ${money(fix)} more` : '';
  const said = byCard
    ? `Of the ${money(paid)} paid today${processorName ? ` to ${processorName}` : ''}: ${types.map((x) => `${x.long} ${money(x.value)}`).join(', ')}. With Rebelipay you would pay ${money(withRp)} and save ${money(savings)} (${pct(share, 1)})${fixSaid}.`
    : `Of the ${money(paid)} paid today${processorName ? ` to ${processorName}` : ''}, you would save ${money(savings)} (${pct(share, 1)}) by switching${fixSaid}, and Rebelipay would charge ${money(withRp)}.`;
  return (
    <div
      className={`csd-donut${byCard ? ' has-types' : ''}`} role="img" data-hl={dataHl} data-ti={t ? typeIndex : undefined}
      aria-label={said}
    >
      <div className="csd-donut-chart" aria-hidden="true">
        <ResponsiveContainer width="100%" aspect={1}>
          <PieChart>
            <Pie
              data={byCard ? types : split} dataKey="value" nameKey="name" cx="50%" cy="50%"
              innerRadius="76%" outerRadius="97%" cornerRadius={4} minAngle={byCard ? 3 : 0}
              startAngle={90} endAngle={-270}
              isAnimationActive={!prefersReducedMotion()} animationDuration={700}
              onMouseEnter={enter} onMouseLeave={leave}
            >
              {byCard
                ? types.map((x, i) => <Cell key={x.key} fill={x.fill} className={`csd-donut-slice is-type t-${i}`} />)
                : split.map((d) => <Cell key={d.key} className={`csd-donut-slice is-${d.key}`} />)}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className={`csd-donut-centre${['save', 'fix', 'kept'].includes(hl) ? ' is-save' : ''}`}>
          <div key={centreKind} className="csd-donut-centre-in">{centre}</div>
        </div>
      </div>
      {/* The ring's key: colour never alone. Pointing at a card type here
          reads it out, as its slice does. */}
      {byCard && (
        <div className="csd-donut-key" aria-hidden="true">
          <span className="csd-donut-key-title">Paid today, by card type</span>
          <ul>
            {types.map((x, i) => (
              <li key={x.key} className={typeIndex === i ? 'is-on' : ''} onMouseEnter={() => onHl(`type:${i}`)} onMouseLeave={leave}>
                <span className="csd-sw" style={{ background: x.fill }} />{x.name}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ── KPI band ────────────────────────────────────────────────────────────── */

// "1 sale", "3,135 sales".
const sales = (n) => `${num(n)} ${Number(n) === 1 ? 'sale' : 'sales'}`;

// How a top figure moved from last month, in words (D47): "up 10.32% from
// last month". `better` is the direction that is good for the owner, for the
// colour only (or a tone to use instead); the words say it without colour.
function moved(change, better, tone) {
  if (!isNum(change)) return null;
  const v = Number(change);
  if (Math.abs(v) < 0.005) return { text: 'same as last month', tone: 'flat' };
  const up = v > 0;
  return { text: `${up ? 'up' : 'down'} ${pct(Math.abs(v))} from last month`, tone: tone || (up === (better === 'up') ? 'good' : 'bad') };
}
const SINCE_INFO = ' The line under it compares with your statement for last month.';
// Card sales' change is finding 02's: printed on this statement, or built
// from your uploads (D47).
const SALES_SINCE_INFO = {
  printed: ' The line under it is the change from last month that this statement prints.',
  uploads: ' The line under it compares with your statement for last month.',
};

function KpiBand({ kpis, rebelipay, csv }) {
  const k = kpis || {};
  const lm = k.lastMonth || {};
  const eligible = k.rebelipayEligible === true && isNum(k.rebelipaySavings);
  const yearly = eligible && isNum(k.rebelipaySavingsAnnual);
  const reason = rebelipay && rebelipay.reason;
  // The same rate when it reads the same, to the two places shown.
  const sameRate = isNum(lm.effectiveRate) && isNum(k.effectiveRate) && pct(lm.effectiveRate) === pct(k.effectiveRate);
  const rateNote = !isNum(k.effectiveRate) ? null
    : !isNum(lm.effectiveRate) ? `${pct(k.effectiveRate)} effective rate`
      : `${pct(k.effectiveRate)} effective rate, ${sameRate ? 'same as' : `${pct(lm.effectiveRate)}`} last month`;
  const salesMoved = moved(lm.cardVolumePct, 'up');
  // Fees rise with sales; whether that is bad is the rate's to say: red only
  // when the effective rate went up, green when it went down.
  const rateTone = !isNum(lm.effectiveRate) || !isNum(k.effectiveRate) || sameRate ? 'flat'
    : k.effectiveRate > lm.effectiveRate ? 'bad' : 'good';
  const feesMoved = moved(lm.processingFeesPct, 'down', rateTone);
  const bankMoved = moved(lm.netDepositedPct, 'up');
  const ticketMoved = moved(lm.avgTicketPct, 'up');
  const debitWas = isNum(lm.debitShare) ? { text: `was ${pct(lm.debitShare, 0)} last month`, tone: 'flat' } : null;
  return (
    <div className="csd-kpis">
      <Tile
        label="Card sales"
        info={`Your total card sales this period, minus refunds, before any fees come out.${salesMoved ? (SALES_SINCE_INFO[lm.cardVolumeSource] || '') : ''}`}
        value={money0(k.cardVolume)}
        note={isNum(k.transactions) ? sales(k.transactions) : null}
        change={salesMoved}
      />
      <Tile
        label="Fees paid"
        info={(csv
          ? 'The fees listed in this file, added up. The effective rate is your fees divided by your card sales: how many cents in fees you paid for every $1 of card sales.'
          : 'Everything your processor charged you this period, including card fees, account fees and penalties. The effective rate is your fees divided by your card sales: how many cents in fees you paid for every $1 of card sales.')
          + (feesMoved ? SINCE_INFO : '')}
        value={money(k.processingFees)}
        note={rateNote}
        change={feesMoved}
      />
      <Tile
        label="Debit share"
        info={(csv
          ? 'The part of your card sales paid with cards this file lists as debit. See Finding 01 for what debit cards cost you.'
          : 'The part of your card sales paid with debit cards. See Finding 01 for what debit cards cost you.')
          + (debitWas ? SINCE_INFO : '')}
        value={pct(k.debitShare, 0)}
        note={!isNum(k.debitVolume) ? null : `${money0(k.debitVolume)} on debit cards`}
        change={debitWas}
      />
      {/* The year first, as the hero leads with it; this statement's amount
          under it (D49). */}
      <Tile
        label="Save with Rebelipay"
        info={csv
          ? 'Our estimate of what you would save in fees with Rebelipay over 12 periods like the one in this file. The line under it is the saving on this file alone.'
          : 'Our estimate of what you would save in fees with Rebelipay in a year at this pace: this statement’s saving times 12, with a fee charged once a year counted once. The line under it is the saving on this statement alone.'}
        tone="gr"
        value={!eligible ? DASH : (yearly ? `${money0(k.rebelipaySavingsAnnual)}${csv ? '' : '/yr'}` : money(k.rebelipaySavings))}
        valueClass={eligible ? 'ref-good' : ''}
        note={eligible
          ? (yearly
            ? (csv ? `over 12 periods like this one · ${money(k.rebelipaySavings)} in this file` : `${money(k.rebelipaySavings)} on this statement (est.)`)
            : null)
          : (reason === 'no_current_fees' ? 'Your fees are not in this file'
            : reason === 'incomplete' ? 'Some card types not fully read' : null)}
      />
      <Tile
        label={csv ? 'Left after fees' : 'Sent to your bank'}
        info={(csv
          ? 'Your card sales in this file minus the fees listed in it.'
          : 'What is left of your card sales after fees, disputes and any other changes. Your processor sends this money to your bank.')
          + (bankMoved ? SINCE_INFO : '')}
        value={money(k.netDeposited)}
        change={bankMoved}
      />
      <Tile
        label="Average sale"
        info={`The average amount of one card sale this period. Watch it over time to see if customers spend more or less each time they pay.${ticketMoved ? SINCE_INFO : ''}`}
        value={money(k.avgTicket)}
        note={k.avgTicketSource === 'printed' ? 'from your statement' : (isNum(k.avgTicket) ? 'card sales ÷ number of sales' : null)}
        change={ticketMoved}
      />
    </div>
  );
}

const Tile = ({ label, info, value, note, change, tone, valueClass = '' }) => (
  <div className={`ref-tile csd-tile ${tone ? `ref-tile-${tone}` : ''}`}>
    <span className="ref-tile-label">{label}<MetricInfo label={label} info={info} /></span>
    <span className={`ref-tile-value csd-tile-value ${valueClass}`}>{value}</span>
    {note && <span className="ref-tile-note">{note}</span>}
    {change && <span className={`csd-tile-change is-${change.tone}`}>{change.text}</span>}
  </div>
);

const NotOnStatement = ({ text = 'Not on this statement' }) => <p className="csd-na">{text}</p>;

/* ═══════════════════════════════════════════════════════════════════════════
   FINDINGS
   ═══════════════════════════════════════════════════════════════════════════ */

// The engine's chart shapes (§5.1): { type: 'debitCredit', bars }, { type:
// 'trend', points, peak, trough }, { type: 'cardMix', rows } and { type:
// 'daily', rows }. The finding key is the reliable switch; the series comes
// from the chart when it carries one, else from the metrics and sections.
const chartType = (f) => (typeof f.chart === 'string' ? f.chart : (f.chart && (f.chart.type || f.chart.kind)) || null);
const chartData = (f, key) => {
  const c = f.chart && typeof f.chart === 'object' ? f.chart : null;
  if (!c) return null;
  if (Array.isArray(c[key])) return c[key];
  return Array.isArray(c.data) ? c.data : null;
};

// The engine's tables: { type: 'math', cells: [{ label, value, format }] } is a
// row of figures; { type: 'grid', columns: [{ key, label, format }], rows } is
// a small table. A bare array of cells is accepted too.
function tableCells(table) {
  if (table && table.type === 'grid') return null;
  const list = Array.isArray(table) ? table : (table && table.cells) || null;
  if (!Array.isArray(list) || !list.length) return null;
  return list.every((c) => c && typeof c === 'object' && 'label' in c && ('value' in c || 'display' in c || 'text' in c)) ? list : null;
}
function tableGrid(table) {
  if (!table || table.type !== 'grid' || !Array.isArray(table.columns) || !Array.isArray(table.rows)) return null;
  const columns = table.columns.filter((c) => c && c.key);
  return columns.length && table.rows.length ? { columns, rows: table.rows.filter(Boolean) } : null;
}

// One value in the engine's formats: money | pct | text | tag | date (plus a
// count, which the screen's own cells use).
function fmtValue(v, format) {
  const f = String(format || '').toLowerCase();
  if (f === 'date') return v ? shortDay(String(v)) : DASH;
  if (f === 'text' || f === 'tag') return v == null || v === '' ? DASH : (TAG_LABEL[v] && f === 'tag' ? TAG_LABEL[v] : String(v));
  if (!isNum(v)) return v == null || typeof v === 'object' ? DASH : String(v);
  if (/money|usd|\$|currency/.test(f)) return money(v);
  if (/pct|percent|%/.test(f)) return pct(v);
  if (/count|int|number/.test(f)) return num(v);
  return null;
}

function fmtCell(c) {
  if (c.display != null) return String(c.display);
  if (c.text != null) return String(c.text);
  const v = c.value;
  const known = fmtValue(v, c.format || c.unit || c.kind);
  if (known != null) return known;
  // No format given: let the label decide, since a share and a dollar figure
  // can both be 74.
  if (/rate|share|%|percent/i.test(c.label || '')) return pct(v);
  if (/volume|paid|fee|cost|amount|\$|ticket/i.test(c.label || '')) return money(v);
  return num(v);
}

const NUMERIC_FORMATS = new Set(['money', 'pct', 'count']);

// A heading's words with its ⓘ after the last one, the two kept together, so
// the ⓘ is never alone on a line or off to the side of a wrapped heading.
const headWords = (label, info, infoLabel) => {
  if (!info) return label;
  const words = String(label).split(' ');
  const last = words.pop();
  return (
    <>
      {words.length ? `${words.join(' ')} ` : ''}
      <span className="csd-th-end">{last}<MetricInfo label={infoLabel || label} info={info} /></span>
    </>
  );
};

// A table heading with its ⓘ, when it has one: what the column is and how it
// helps. Named by its words alone (aria-label), so a screen reader does not
// read the ⓘ's name out on every cell of the column.
const Th = ({ label, info, infoLabel, num: numeric, className }) => (
  <th className={[numeric ? 'ref-num' : null, className].filter(Boolean).join(' ') || undefined} aria-label={info ? label : undefined}>
    {headWords(label, info, infoLabel)}
  </th>
);

/* A grid table from the engine, in its own column order and formats. Tags
   render as the same chips the Fees tab uses. On a narrow card each row
   stacks into "label  value" lines (the CSS reads `data-label`), so the
   amounts and the fix are on screen rather than scrolled off to the right.
   The explicit roles keep it a table to a screen reader once the CSS
   changes its display. */
function GridTable({ grid, footer }) {
  const { columns, rows } = grid;
  const label = (c) => c.label || c.key;
  return (
    <div className="ref-table-wrap">
      <table className="ref-table csd-table-sm csd-grid" role="table">
        <thead>
          <tr role="row">
            {columns.map((c) => (
              <th key={c.key} role="columnheader" aria-label={c.info ? label(c) : undefined} className={NUMERIC_FORMATS.has(c.format) ? 'ref-num' : (c.format === 'text' ? 'csd-col-text' : undefined)}>
                {headWords(label(c), c.info)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} role="row">
              {columns.map((c, j) => {
                const v = r[c.key];
                if (c.format === 'tag') return <td key={c.key} role="cell" data-label={label(c)}><TagChip tag={v} /></td>;
                const text = fmtValue(v, c.format) ?? (v == null ? DASH : String(v));
                return (
                  <td
                    key={c.key}
                    role="cell"
                    data-label={label(c)}
                    className={NUMERIC_FORMATS.has(c.format) ? 'ref-num' : (j === 0 ? 'ref-name' : undefined)}
                    title={c.format === 'text' && v ? String(v) : undefined}
                  >
                    {text}
                  </td>
                );
              })}
            </tr>
          ))}
          {footer && (
            <tr className="csd-total-row" role="row">
              {columns.map((c, j) => (
                <td key={c.key} role="cell" data-label={label(c)} className={NUMERIC_FORMATS.has(c.format) ? 'ref-num' : (j === 0 ? 'ref-name' : undefined)}>
                  {j === 0 ? footer.label : (c.key in footer.values ? fmtValue(footer.values[c.key], c.format) : null)}
                </td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/* A finding's figures: each tile as wide as its words, text centred, with an
   ⓘ that says what the figure is and how it helps. */
function MathRow({ cells }) {
  const list = (cells || []).filter((c) => c && (c.value !== undefined || c.display != null || c.text != null));
  if (!list.length) return null;
  return (
    <div className="csd-mathrow">
      {list.map((c, i) => (
        <div key={c.label || i} className={`csd-mathcell ${c.tone ? `is-${c.tone}` : ''}`}>
          <span className="csd-mathcell-k">{c.label}<MetricInfo label={c.label} info={c.info} /></span>
          <span className="csd-mathcell-v">{fmtCell(c)}</span>
          {c.sub && <span className="csd-mathcell-sub">{c.sub}</span>}
          {/* How it compares with a usual day or last month (D47). */}
          {c.vs && <span className="csd-mathcell-vs">{c.vs}</span>}
        </div>
      ))}
    </div>
  );
}

// A finding's impact label split into its figure and the words after it, so
// the figure can stand out: "$3,724.61 paid on debit" is "$3,724.61" and
// "paid on debit". A label with no figure in front ("Action needed") is all
// words. The engine's "YoY" and "MoM" read as words here.
const IMPACT_WORDS = { YoY: 'vs a year ago', MoM: 'vs last month' };
function splitImpact(label) {
  const s = String(label || '').trim();
  const m = /^([+\-−]?\$?[\d,]+(?:\.\d+)?%?)\s+(.+)$/.exec(s);
  if (!m) return { figure: null, words: s };
  return { figure: m[1].replace(/^-/, '−'), words: IMPACT_WORDS[m[2]] || m[2] };
}

// Each finding's topic, for the line above its title, and what its ⓘ says:
// what we check and why it matters, in plain words.
const FINDING_TOPIC = {
  // A fact about the store, never a flag (D48): Rebelipay charges one price
  // for every card, so debit costing what credit does is not called wrong.
  debit_at_credit_rates: { topic: 'Debit cards', info: 'How much of your card sales were paid with debit cards, and the fee rate on them beside the rate on credit cards.' },
  sales_trend: { topic: 'Card sales over time', info: 'Your card sales month by month, and how this period compares with last month and with a year ago. It helps you spot a slowdown early.' },
  customer_scorecard: { topic: 'Customers and cards', info: 'How many card customers were new or came back, your average sale, and which cards people paid with. It shows if shoppers return and whether Amex or Visa customers spend more per sale.' },
  daily_patterns: { topic: 'Card sales by day', info: 'Checks your card sales day by day: your busiest days, and days that look off, like fees on a day with no card sales. Use it to plan staff and spot problems.' },
  junk_fees: { topic: 'Junk fees', info: 'Finds fees to check, like penalties, paper statement fees and account fees we do not recognise. Some you could stop or lower; the table says how.' },
  fine_print: { topic: 'Fine print', info: "Reads your processor's notices, your 1099-K sales total and any customer disputes. Notices can tell you about a new processing bank, deposit name or fee, so do not skip them." },
};

// The one thing a card's figures cannot say for themselves, in a line: a
// trend built from this store's uploads rather than printed on the
// statement, and a layout with no customer counts (missing is not zero, so
// the card says so rather than leaving the counts out silently).
function findingNote(f, analysis) {
  const m = f.metrics || {};
  if (f.key === 'sales_trend' && m.source && m.source !== 'statement') {
    const pts = (Array.isArray(m.points) ? m.points : []).filter((p) => p && p.month);
    if (pts.length < 2) return null;
    return `Built from ${pts.length} months of your uploads for this store, ${monthLabel(pts[0].month)} to ${monthLabel(pts[pts.length - 1].month)}.`;
  }
  if (f.key === 'customer_scorecard' && !isNum(m.newCustomers) && !isNum(m.repeatCustomers)) {
    return (analysis && analysis.layoutVersion) === 'csv'
      ? 'This file does not show how many new and repeat customers you had.'
      : 'This statement does not show how many new and repeat customers you had.';
  }
  return null;
}

// What the header's figure is, for its ⓘ, by finding and by what it shows.
function impactInfo(f) {
  const m = f.metrics || {};
  switch (f.key) {
    case 'debit_at_credit_rates': return 'How much customers paid with debit cards this period, before fees.';
    case 'sales_trend': return isNum(m.yoyPct)
      ? 'How your card sales for this period compare with the same month last year.'
      : 'How your card sales for this period compare with the month before. One month can swing, so check the chart too.';
    case 'customer_scorecard': return 'Of all your card customers this month, the percent who were repeat customers. Watch it over time to see if people keep coming back.';
    case 'daily_patterns': return f.flagged
      ? 'How many days and deposits on this card to check. Each one is listed under the chart.'
      : 'How much of your card sales came in on Fridays, Saturdays and Sundays. Use it to plan staff and stock for the weekend.';
    case 'junk_fees': return 'An estimate of what these fees cost you in a year: each fee times 12 if it repeats every month, a once-a-year fee counted once.';
    case 'fine_print': return f.flagged
      ? 'At least one notice or dispute here asks you to do something. Each one says what to do.'
      : 'Nothing in the notices or disputes here needs a step from you.';
    default: return null;
  }
}

// How each check came out, in the label beside its name (D43). A flagged
// check says how much it matters in words as well as in its colour (D45),
// so the order to work in never rests on telling pink from violet; the rest
// are lower priority.
const LEVEL_LABEL = { high: 'Urgent', medium: 'Needs a look', low: 'Worth a look' };
const STANDING = { clear: 'Nothing to fix', unchecked: 'Not checked' };
const standingOf = (f) => (f.available === false ? 'unchecked' : f.flagged ? 'flagged' : 'clear');
// A flagged check's level. One with no level the screen knows reads as
// "Needs a look", the colour it has always had.
const levelOf = (f) => (LEVEL_LABEL[f.severity] ? f.severity : 'medium');
const LevelTag = ({ level }) => <span className={`csd-standing is-${level}`}>{LEVEL_LABEL[level]}</span>;
// Why a flagged check has its level: the engine's sentence for this card
// (D47), led in by the level, with the rule behind every level in its ⓘ.
const WHY_LEAD = { high: 'Why it’s urgent:', medium: 'Why it needs a look:', low: 'Why it’s worth a look:' };
const LEVEL_BASIS = 'We label what we find by how much it can cost you and how soon you need to act. '
  + 'Urgent: it costs you money on most of your sales every month, or a change needs a step from you now. '
  + 'Needs a look: it may be costing you money, or needs checking soon. '
  + 'Worth a look: something to check when you have time; nothing looks wrong.';

// Whether a check with nothing to fix has more to show than its title. A
// "No junk fees" card would only say "No penalties or account fees" again,
// so it gets no "Show details"; the others have figures, a chart or a table.
function hasDetails(f, analysis) {
  const m = f.metrics || {};
  if (f.key === 'junk_fees') return !!tableGrid(f.table) || (Array.isArray(m.items) && m.items.length > 0);
  if (f.key === 'fine_print') {
    const notices = Array.isArray(m.notices) ? m.notices : ((analysis && analysis.notices) || []);
    const rs = m.reportableSales || (analysis && analysis.reportableSales);
    const disputes = m.disputes || (analysis && analysis.disputes);
    return notices.length > 0 || !!(rs && isNum(rs.ytdAmount)) || !!disputes || !!tableGrid(f.table);
  }
  return true;
}

// The line over the cards: how many of the checks flagged something (D43).
function overviewSummary(findings, csv) {
  const total = findings.length;
  const flagged = findings.filter((f) => f.flagged).length;
  const unchecked = findings.filter((f) => f.available === false).length;
  const ran = total - unchecked;
  const noun = csv ? 'file' : 'statement';
  // With nothing flagged, the headline claims only what the checks that ran
  // can say: a file with no fees is not "nothing to fix" (D43).
  let rest;
  if (flagged) rest = 'checks flagged something';
  else if (!unchecked) rest = `Nothing to fix on this ${noun}`;
  else if (ran) rest = `The ${ran === 1 ? 'one check' : `${ran} checks`} we could run found nothing to fix`;
  else rest = `We could not run any checks on this ${noun}`;
  return {
    count: flagged ? (flagged === total ? `All ${total}` : `${flagged} of ${total}`) : null,
    rest,
    sub: unchecked && ran ? `We could not run ${unchecked === 1 ? '1 check' : `${unchecked} checks`} on this ${noun}.` : null,
  };
}

/* The checks that found something come first, in full; the rest follow
   under "Lower priority", folded to their title (D43). Each keeps its own
   number, so "Finding 03" is the same check on every statement. */
function FindingsOverview({ findings, analysis, onTab, csv, open, onToggle }) {
  const flagged = findings.filter((f) => f.flagged);
  const rest = findings.filter((f) => !f.flagged);
  const sum = overviewSummary(findings, csv);
  const card = (f) => {
    const i = findings.indexOf(f);
    const key = f.key || String(i);
    return (
      <FindingCard key={key} f={f} index={i} analysis={analysis} onTab={onTab}
        open={!!open[key]} onToggle={() => onToggle(key)} />
    );
  };
  return (
    <>
      <div className="csd-ov-sum">
        <h2 className="csd-ov-head">{sum.count && <strong>{sum.count}</strong>}{sum.count ? ' ' : ''}{sum.rest}</h2>
        {sum.sub && <p className="csd-ov-sub">{sum.sub}</p>}
      </div>
      {flagged.map(card)}
      {flagged.length > 0 && rest.length > 0 && <h2 className="csd-ov-group">Lower priority</h2>}
      {rest.map(card)}
    </>
  );
}

function FindingCard({ f, index, analysis, onTab, open = false, onToggle }) {
  const n = f.number || `Finding ${String(index + 1).padStart(2, '0')}`;
  // The label and the headline figure share one level, so their colours agree.
  const sev = f.flagged ? levelOf(f) : 'info';
  const headId = `csd-f-${f.key || index}`;
  const available = f.available !== false;
  const callout = f.callout;
  const calloutTitle = callout && typeof callout === 'object' ? (callout.title || callout.label || callout.heading) : null;
  const calloutText = callout && typeof callout === 'object' ? (callout.text || callout.body || callout.message) : callout;
  const impact = f.impactLabel ? splitImpact(f.impactLabel) : null;
  const note = available ? findingNote(f, analysis) : null;
  const topic = FINDING_TOPIC[f.key];
  const standing = standingOf(f);
  // A check with nothing to fix shows its title and figure; its tiles and
  // chart wait behind "Show details", and one with nothing more to show has
  // no button. One that could not run is a line long already, so it shows in
  // full.
  const quietDetails = standing === 'clear' && !!(note || calloutText || hasDetails(f, analysis));
  const folds = quietDetails && typeof onToggle === 'function';
  const bare = standing === 'clear' && !quietDetails;
  const bodyId = `${headId}-body`;

  const body = (
    <>
      {/* The figures speak for the card: no "What the statement shows /
          What it doesn't say" sentences, footnote or "From statement
          line" list (the owner found them noise; they said each figure
          again). Each figure shows once, in the header or a tile. The
          Fees, Daily and Notices tabs still list every statement line. */}
      {note && <p className="csd-f-note">{note}</p>}

      <FindingVisual f={f} analysis={analysis} onTab={onTab} />

      {calloutText && (
        <div className="csd-callout">
          {calloutTitle && <strong>{calloutTitle}: </strong>}{asText(calloutText)}
        </div>
      )}
    </>
  );

  return (
    <article className={`ref-card csd-finding${standing === 'flagged' ? '' : ' is-quiet'}`} aria-labelledby={headId} data-finding={f.key || undefined}>
      <header className="csd-f-head">
        {/* What the card is about, in two or three words, with an ⓘ that says
            what we check and why it matters; the title says what we found.
            The label at the end says how the check came out. */}
        <span className="csd-f-eyebrow">
          <span className="csd-f-num">{n}</span>
          {topic && available && (
            <>
              <span className="csd-f-dot" aria-hidden="true">·</span>
              <span className="csd-f-topic">{topic.topic}</span>
              <MetricInfo label={topic.topic} info={topic.info} />
            </>
          )}
          {standing === 'flagged'
            ? <LevelTag level={sev} />
            : <span className="csd-standing is-quiet">{STANDING[standing]}</span>}
        </span>
        <h3 id={headId} className="csd-f-title">{f.title}</h3>
        <span className="csd-f-tags">
          {f.isEstimate && (
            <span className="csd-est">
              <span className="ref-est-label">Estimate</span>
              <MetricInfo label="Estimate" info={ESTIMATE_INFO} />
            </span>
          )}
          {/* The impact, large, in the severity colour: the one figure to
              take away from the section. */}
          {impact && (
            <span className={`csd-impact is-${sev}${impact.figure ? '' : ' is-words'}`}>
              {impact.figure && <strong className="csd-impact-figure">{impact.figure}</strong>}
              <span className="csd-impact-words">{impact.words}</span>
              <MetricInfo label={impact.words} info={impactInfo(f)} />
            </span>
          )}
        </span>
      </header>

      {standing === 'flagged' && f.why && (
        <p className="csd-f-why">
          <strong>{WHY_LEAD[sev]}</strong> {f.why}
          <MetricInfo label="Urgent, Needs a look and Worth a look" info={LEVEL_BASIS} />
        </p>
      )}

      {!available ? (
        <>
          <NotOnStatement text={f.unavailableReason || 'Not on this statement'} />
          {/* Its footnote still says what would fill it in, e.g. a legacy
              statement's trend: "Upload earlier statements for this store". */}
          {f.footnote && <p className="csd-footnote">{asText(f.footnote)}</p>}
        </>
      ) : folds ? (
        <>
          <button type="button" className="csd-f-more" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
            {open ? 'Hide details' : 'Show details'}
            {/* Each button says whose details, for a list of buttons read aloud. */}
            <span className="csd-sr"> for {topic ? topic.topic : f.title}</span>
            <ChevronDown size={15} aria-hidden="true" />
          </button>
          <div id={bodyId} className="csd-f-body" hidden={!open}>{open && body}</div>
        </>
      ) : bare ? null : body}
    </article>
  );
}

// "Through June 2026, tax ID ending 0000", or as much of it as was read.
function reportableSub(rs) {
  const month = rs.monthLabel ? String(rs.monthLabel) : null;
  const year = isNum(rs.ytdYear) ? String(rs.ytdYear) : null;
  const when = month && year ? `Through ${month} ${year}` : (year ? `For ${year}` : (month ? `Through ${month}` : null));
  const tin = rs.tinLast4 ? `tax ID ending ${rs.tinLast4}` : null;
  if (when && tin) return `${when}, ${tin}`;
  if (tin) return `Tax ID ending ${rs.tinLast4}`;
  return when;
}

// The biggest day against a usual day of its weekday (D47): "4.2 times a
// usual Saturday", or "about what a usual Saturday brings in" when close.
function usualDay(big) {
  if (!big || !big.date || !isNum(big.timesUsual)) return null;
  const day = formatLocalDate(big.date, { weekday: 'long' });
  const times = Number(big.timesUsual);
  return times >= 1.1 ? `${times.toFixed(1)} times a usual ${day}` : `about what a usual ${day} brings in`;
}

function FindingVisual({ f, analysis, onTab }) {
  const m = f.metrics || {};
  const type = chartType(f);
  const cells = tableCells(f.table);
  const grid = tableGrid(f.table);

  if (f.key === 'debit_at_credit_rates' || type === 'debitCredit') {
    // Facts side by side, never a verdict (D48): the title says the debit
    // share and the header the debit sales, so neither is repeated in a tile.
    const mathCells = [
      isNum(m.debitRatePct) && {
        label: 'Debit card fee rate', value: m.debitRatePct, format: 'pct',
        info: 'The percent fee charged on your debit card sales (for example, 3% means $3 on every $100).',
      },
      isNum(m.creditRatePct) && {
        label: 'Credit card fee rate', value: m.creditRatePct, format: 'pct',
        info: 'The percent fee charged on your credit card sales.',
      },
      !f.impactLabel && isNum(m.debitVolume) && { label: 'Debit card sales', value: m.debitVolume, format: 'money', info: 'How much customers paid with debit cards this period, before fees.' },
      isNum(m.debitFeesPaid) && { label: 'Debit card fees', value: m.debitFeesPaid, format: 'money', info: 'The total you paid in debit card fees this period.' },
      !/^Debit is /.test(f.title || '') && isNum(m.debitShare) && {
        label: 'Debit share', value: m.debitShare, format: 'pct',
        info: 'How much of your card sales this period were paid with debit cards.',
      },
    ].filter(Boolean);
    const bars = chartData(f, 'bars') || [
      { key: 'debit', label: 'Debit', volume: m.debitVolume, fees: m.debitFeesPaid, ratePct: m.debitRatePct },
      { key: 'credit', label: 'Credit', volume: m.creditVolume, fees: m.creditFeesPaid, ratePct: m.creditRatePct },
    ];
    return (
      <>
        <MathRow cells={mathCells} />
        <DebitCreditChart bars={bars} />
      </>
    );
  }

  if (f.key === 'sales_trend' || type === 'trend') {
    const points = chartData(f, 'points') || m.points || (analysis.salesTrend && analysis.salesTrend.points) || [];
    const peak = (f.chart && f.chart.peak) || m.peak;
    const trough = (f.chart && f.chart.trough) || m.trough;
    // The changes as figures, coloured by direction (down red, up green),
    // and the best and slowest months beside them. The header shows the
    // year-on-year change (month on month when there is no year-ago month),
    // so that one is not repeated. With two months the best and slowest are
    // just the chart's two points.
    const inHeader = f.impactLabel ? (isNum(m.yoyPct) ? 'yoy' : 'mom') : null;
    const months = points.length >= 3;
    return (
      <>
        <MathRow cells={[
          inHeader !== 'yoy' && isNum(m.yoyPct) && {
            label: 'vs a year ago', display: signedPct(m.yoyPct, 2), tone: Number(m.yoyPct) < 0 ? 'bad' : 'good',
            info: 'How your card sales for this period compare with the same month last year.',
          },
          inHeader !== 'mom' && isNum(m.momPct) && {
            label: 'vs last month', display: signedPct(m.momPct, 2), tone: Number(m.momPct) < 0 ? 'bad' : 'good',
            info: 'How your card sales for this period compare with the month before. One month can swing, so check the chart too.',
          },
          months && peak && isNum(peak.amount) && { label: `Best month, ${monthLabel(peak.month)}`, value: peak.amount, format: 'money', info: 'Your highest month of card sales on this chart.' },
          months && trough && isNum(trough.amount) && { label: `Slowest month, ${monthLabel(trough.month)}`, value: trough.amount, format: 'money', info: 'Your lowest month of card sales on this chart.' },
        ].filter(Boolean)}
        />
        <TrendChart points={points} peak={peak} trough={trough} />
      </>
    );
  }

  if (f.key === 'customer_scorecard' || type === 'cardMix') {
    const mix = chartData(f, 'rows') || m.cardMix || (analysis.cardMix && analysis.cardMix.rows) || [];
    // The header shows the repeat share, and the band above the tabs the
    // all-in fee rate, so neither is repeated here.
    const scorecard = [
      isNum(m.newCustomers) && {
        label: 'New customers', value: m.newCustomers, format: 'count',
        info: 'How many card customers your statement counts as new this month. Compare it with repeat customers to see how many people come back.',
      },
      isNum(m.repeatCustomers) && {
        label: 'Repeat customers', value: m.repeatCustomers, format: 'count',
        info: 'How many card customers your statement counts as returning this month. A higher number means more people keep coming back.',
      },
      !f.impactLabel && isNum(m.repeatSharePct) && {
        label: 'Percent who came back', value: m.repeatSharePct, format: 'pct',
        info: 'Of all your card customers this month, the percent who were repeat customers: repeat divided by new plus repeat.',
      },
      isNum(m.avgTicket) && {
        label: 'Average sale', value: m.avgTicket, format: 'money',
        info: 'The average amount of one card sale this period. Watch it over time to see if customers spend more or less each time they pay.',
      },
      isNum(m.amexPremiumPct) && {
        label: 'Amex vs Visa sale',
        display: signedPct(m.amexPremiumPct, 0),
        sub: isNum(m.amexAvgTicket) && isNum(m.visaAvgTicket) ? `Amex ${money(m.amexAvgTicket)}, Visa ${money(m.visaAvgTicket)}` : null,
        info: 'How the average Amex sale compares with the average Visa sale. +30% means Amex customers spend 30% more per sale, and a minus means they spend less.',
      },
    ].filter(Boolean);
    return (
      <>
        <MathRow cells={cells || scorecard} />
        <CardMixBar rows={mix} csv={(analysis && analysis.layoutVersion) === 'csv'} />
      </>
    );
  }

  if (f.key === 'daily_patterns' || type === 'daily') {
    // The Daily section carries fees and deposits for the tooltip; the
    // chart's own rows (amount, friToSun, anomaly) are the fallback.
    const rows = (analysis.daily && analysis.daily.rows) || chartData(f, 'rows') || [];
    const anomalies = Array.isArray(m.anomalies) ? m.anomalies : [];
    const big = m.biggestDay;
    // A file or a short period is not a month (the engine's own rule).
    const span = (analysis && analysis.layoutVersion) === 'csv' || (isNum(m.daysInPeriod) && m.daysInPeriod < 28) ? 'period' : 'month';
    // With nothing flagged the header shows the Fri to Sun share and the
    // title the 60% figure, so the tiles leave them out. Split-funding days
    // are listed with their dates under the chart.
    return (
      <>
        <MathRow cells={cells || [
          (f.flagged || !f.impactLabel) && isNum(m.friSunSharePct) && {
            label: 'Sales Friday to Sunday', value: m.friSunSharePct, format: 'pct',
            info: 'How much of your card sales came in on Fridays, Saturdays and Sundays. Use it to plan staff and stock for the weekend.',
          },
          big && {
            label: 'Biggest sales day', value: big.amount, format: 'money',
            sub: `${shortDay(big.date)}${isNum(big.sharePct) ? `, ${pct(big.sharePct, 1)} of the ${span}'s card sales` : ''}`,
            vs: usualDay(big),
            info: `The day with the most card sales${usualDay(big) ? ', how much of the total it brought in, and how it compares with a usual day of the same weekday' : ', and how much of the total it brought in'}. Make sure days like it have enough staff and stock.`,
          },
          f.flagged && isNum(m.daysFor60Pct) && {
            label: 'Busiest days', display: `${m.daysFor60Pct} of ${m.daysInPeriod || rows.length}`,
            sub: isNum(m.daysFor60SharePct) ? `brought in ${Math.round(m.daysFor60SharePct)}% of your card sales` : null,
            info: 'The fewest of your busiest days that together brought in 60% or more of your card sales. Keep those days well staffed and stocked.',
          },
        ].filter(Boolean)}
        />
        {rows.length > 0 ? <DailyChart rows={rows} height={200} csv={(analysis && analysis.layoutVersion) === 'csv'} /> : <NotOnStatement />}
        {anomalies.length > 0 && (
          <ul className="csd-anomalies">
            {anomalies.map((x, i) => {
              const dated = !!x.date || (Array.isArray(x.dates) && x.dates.length > 0);
              // The row shows the date and amount, so the words take up after
              // them (the engine's note); without both, the whole sentence.
              const words = dated && isNum(x.amount) && x.note ? x.note : x.detail;
              return (
                <li key={i}>
                  <span className="csd-chip-group">
                    <span className="csd-chip is-alert">{ANOMALY_LABEL[x.type] || x.type}</span>
                    <MetricInfo label={ANOMALY_LABEL[x.type] || x.type} info={ANOMALY_INFO[x.type]} />
                  </span>
                  {x.date
                    ? <span className="csd-anom-date">{shortDay(x.date)}</span>
                    : (dated && (
                      <span className="csd-anom-date">{x.dates.slice(0, 4).map(shortDay).join(', ')}{x.dates.length > 4 ? ` and ${x.dates.length - 4} more` : ''}</span>
                    ))}
                  {isNum(x.amount) && <span className="csd-anom-amt">{money(x.amount)}</span>}
                  {words && <span className="csd-anom-detail">{words}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </>
    );
  }

  if (f.key === 'junk_fees') {
    const items = Array.isArray(m.items) ? m.items : [];
    if (grid) {
      // A year is an estimate (it assumes the fee repeats), so its column
      // says so; an annual fee is counted once, not twelve times, and its
      // cell says that. The header shows the year's total; with two or more
      // fees one total row adds up both columns.
      const HEAD = {
        line: { label: 'Fee as printed', info: FEE_AS_PRINTED_INFO },
        tag: { label: 'Flag', info: FLAG_INFO },
        monthly: { label: 'This month' },
        annualised: { label: 'A year (est.)', info: A_YEAR_INFO },
        fix: { label: 'What to do' },
      };
      const columns = grid.columns.map((c) => ({ ...c, ...(HEAD[c.key] || {}) }));
      const rows = grid.rows.map((r, i) => (items[i] && items[i].period === 'annual' && isNum(r.annualised)
        ? { ...r, annualised: `${money(r.annualised)} (once a year)` }
        : r));
      const values = {};
      if (columns.some((c) => c.key === 'monthly')) {
        values.monthly = items.reduce((s, it) => s + (isNum(it.monthly) ? Number(it.monthly) : 0), 0);
      }
      if (columns.some((c) => c.key === 'annualised') && isNum(m.totalAnnualised)) values.annualised = m.totalAnnualised;
      const total = rows.length > 1 && Object.keys(values).length ? { label: 'Total', values } : null;
      return <GridTable grid={{ columns, rows }} footer={total} />;
    }
    if (!items.length) return <NotOnStatement text="No penalties or account fees on this statement." />;
    return (
      <div className="ref-table-wrap">
        <table className="ref-table csd-table-sm">
          <thead>
            <tr>
              <Th label="Fee as printed" info={FEE_AS_PRINTED_INFO} />
              <Th label="Flag" info={FLAG_INFO} />
              <Th num label="This month" />
              <Th num label="A year (est.)" info={A_YEAR_INFO} />
              <Th label="What to do" />
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => {
              const line = typeof it.line === 'number'
                ? (((analysis.feeLines || []).find((l) => l.index === it.line) || {}).description || `Fee line ${it.line + 1}`)
                : it.line;
              return (
                <tr key={i}>
                  <td className="ref-name" title={line || ''}>{line || DASH}</td>
                  <td><TagChip tag={it.tag} /></td>
                  <td className="ref-num">{money(it.monthly)}</td>
                  <td className="ref-num">{money(it.annualised)}{it.period === 'annual' ? ' (once a year)' : ''}</td>
                  <td title={it.fix || ''}>{it.fix || DASH}</td>
                </tr>
              );
            })}
            {isNum(m.totalAnnualised) && (
              <tr className="csd-total-row">
                <td>Total a year (est.)</td><td /><td /><td className="ref-num">{money(m.totalAnnualised)}</td><td />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    );
  }

  if (f.key === 'fine_print') {
    const notices = Array.isArray(m.notices) ? m.notices : (analysis.notices || []);
    const rs = m.reportableSales || analysis.reportableSales;
    const disputes = m.disputes || analysis.disputes;
    return (
      <div className="csd-fine">
        {notices.length > 0 && (
          <ul className="csd-fine-notices">
            {notices.map((nt, i) => (
              <li key={i}>
                <span className="csd-chip-group">
                  <span className={`csd-chip ${nt.kind && nt.kind !== 'other' ? 'is-attn' : ''}`}>{NOTICE_KIND[nt.kind] || 'Notice'}</span>
                  <MetricInfo label={NOTICE_KIND[nt.kind] || 'Notice'} info={NOTICE_INFO[nt.kind]} />
                </span>
                {nt.effectiveDate && <span className="csd-anom-date">from {shortDay(nt.effectiveDate)}</span>}
                <span className="csd-anom-detail">{nt.action || truncate(nt.text, 120)}</span>
              </li>
            ))}
          </ul>
        )}
        <MathRow cells={[
          rs && isNum(rs.ytdAmount) && {
            label: '1099-K sales so far',
            value: rs.ytdAmount,
            format: 'money',
            sub: reportableSub(rs),
            info: 'Your card sales so far this year, before refunds, as printed on your statement. Your 1099-K tax form is built from this total, so check it against your records.',
          },
          disputes && {
            label: 'Disputes and chargebacks',
            info: 'Card payments taken back from you, usually because a customer disputed the charge with their bank. Check each one against your receipts.',
            display: Number(disputes.count) > 0
              ? `${num(disputes.count)} · ${money(disputes.amount)}`
              : (Number(disputes.amount) ? money(disputes.amount) : 'None'),
            tone: Number(disputes.count) > 0 || Number(disputes.amount) ? 'bad' : 'good',
          },
        ].filter(Boolean)}
        />
        {grid && <GridTable grid={grid} />}
        {notices.length > 0 && (
          <button type="button" className="csd-linkbtn" onClick={() => onTab('notices')}>Read the full notices</button>
        )}
      </div>
    );
  }

  if (cells) return <MathRow cells={cells} />;
  return grid ? <GridTable grid={grid} /> : null;
}

const TagChip = ({ tag }) => (tag
  ? <span className={`csd-tag csd-tag-${tag}`}>{TAG_LABEL[tag] || tag}</span>
  : <span className="csd-muted">{DASH}</span>);

/* ── Charts ──────────────────────────────────────────────────────────────── */

function ChartTip({ active, payload, render }) {
  if (!active || !payload || !payload.length) return null;
  const body = render(payload);
  return body ? <div className="csd-tip">{body}</div> : null;
}

const TipRow = ({ color, name, value }) => (
  <div className="csd-tip-row">
    {color && <span className="csd-tip-dot" style={{ background: color }} />}
    <span className="csd-tip-name">{name}</span>
    <span className="csd-tip-val">{value}</span>
  </div>
);

/* Debit against credit: one axis (volume), each bar's volume at its end, the
   fees and rate in the tooltip (the rates are the tiles above it). Two
   measures of different size never share a chart scale. The axis names the
   bars, so there is no legend. */
const BAR_NAME = { debit: 'Debit cards', credit: 'Credit cards' };

function DebitCreditChart({ bars }) {
  const chart = useChartTheme();
  // A side the statement does not show (no rated credit lines, say) is left
  // out rather than drawn as a $0 bar.
  const data = (bars || [])
    .filter((b) => b && isNum(b.volume))
    .map((b, i) => ({
      name: BAR_NAME[b.key] || b.label || (i === 0 ? 'Debit cards' : 'Credit cards'),
      volume: Number(b.volume),
      fees: b.fees,
      rate: b.ratePct,
      fill: chart.series[b.key === 'credit' ? 1 : (b.key === 'debit' ? 0 : i % 2)],
    }));
  if (!data.length) return null;
  return (
    <div className="csd-chart-panel">
      <ResponsiveContainer width="100%" height={120}>
        <RBarChart data={data} layout="vertical" margin={{ top: 4, right: 72, left: 4, bottom: 0 }} barCategoryGap="28%">
          <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} horizontal={false} />
          <XAxis type="number" tickFormatter={axisMoney} tick={{ fill: chart.axis, fontSize: 11 }} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey="name" width={100} tick={{ fill: chart.tick, fontSize: 12 }} axisLine={false} tickLine={false} />
          <RTooltip
            cursor={{ fill: chart.rimSoft }}
            content={<ChartTip render={(p) => {
              const d = p[0].payload;
              return (
                <>
                  <div className="csd-tip-label">{d.name}</div>
                  <TipRow color={d.fill} name="Sales" value={money(d.volume)} />
                  <TipRow name="Fees paid" value={money(d.fees)} />
                  <TipRow name="Fee rate" value={pct(d.rate)} />
                </>
              );
            }}
            />}
          />
          <Bar dataKey="volume" name="Sales" radius={[0, 4, 4, 0]} maxBarSize={26} isAnimationActive={!prefersReducedMotion()}>
            {data.map((d) => <Cell key={d.name} fill={d.fill} />)}
            <LabelList dataKey="volume" position="right" formatter={money0} fill={chart.tick} fontSize={12} fontWeight={700} />
          </Bar>
        </RBarChart>
      </ResponsiveContainer>
    </div>
  );
}

function TrendChart({ points, peak, trough }) {
  const chart = useChartTheme();
  const data = (points || []).filter((p) => p && isNum(p.amount)).map((p) => ({ month: p.month, amount: Number(p.amount) }));
  if (data.length < 2) return <NotOnStatement text="A trend needs at least two months of card sales" />;
  const has = (pt) => pt && data.some((d) => d.month === pt.month);
  return (
    <div className="csd-chart-panel">
      <ResponsiveContainer width="100%" height={210}>
        <AreaChart data={data} margin={{ top: 22, right: 14, left: -6, bottom: 0 }}>
          {glassDefs({ id: 'csd-trend', theme: chart })}
          <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} vertical={false} />
          <XAxis dataKey="month" tickFormatter={(v) => formatLocalDate(`${v}-01`, { month: 'short', year: 'numeric' })} tick={{ fill: chart.axis, fontSize: 11 }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={14} />
          <YAxis tickFormatter={axisMoney} tick={{ fill: chart.axis, fontSize: 11 }} axisLine={false} tickLine={false} width={48} />
          <RTooltip
            cursor={{ stroke: chart.rimSoft }}
            content={<ChartTip render={(p) => (
              <>
                <div className="csd-tip-label">{monthLabel(p[0].payload.month)}</div>
                <TipRow color={chart.series[0]} name="Card sales" value={money(p[0].payload.amount)} />
              </>
            )}
            />}
          />
          <Area type="monotone" dataKey="amount" name="Card sales" stroke={chart.series[0]} strokeWidth={2} fill="url(#csd-trend-wash)" isAnimationActive={!prefersReducedMotion()} />
          {has(peak) && (
            <ReferenceDot x={peak.month} y={Number(peak.amount)} r={5} fill={chart.series[0]} stroke={chart.surface} strokeWidth={2}
              label={{ value: 'Best', position: 'top', fill: chart.tick, fontSize: 11 }} />
          )}
          {has(trough) && (
            <ReferenceDot x={trough.month} y={Number(trough.amount)} r={5} fill={chart.series[0]} stroke={chart.surface} strokeWidth={2}
              label={{ value: 'Slowest', position: 'top', fill: chart.tick, fontSize: 11 }} />
          )}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

const dowOf = (r) => r.dow || (parseLocalDate(r.date) ? parseLocalDate(r.date).toLocaleDateString('en-US', { weekday: 'short' }) : '');
const anomalyTypes = (r) => (Array.isArray(r.anomalies) ? r.anomalies : [])
  .map((x) => (typeof x === 'string' ? x : x && x.type))
  .filter(Boolean);

/* Day numbers alone repeat when the days run into a new month ("30, 1, 2 ...
   30"), so the daily chart names each month under its days and draws a
   dashed line where one month ends and the next begins. */
const monthSpans = (data) => data.reduce((spans, d) => {
  const key = String(d.date).slice(0, 7);
  const prev = spans[spans.length - 1];
  if (prev && prev.key === key) prev.last = d.date;
  else spans.push({ key, first: d.date, last: d.date });
  return spans;
}, []);
// Longest name first; a month with only a day or two on the chart gets the
// short one ("Apr" under one bar, "May 2026" under the rest).
const MONTH_NAMES = [{ month: 'long', year: 'numeric' }, { month: 'short', year: 'numeric' }, { month: 'long' }, { month: 'short' }];
// A close estimate of an 11px label's width (no canvas to measure with).
const labelWidth = (s) => [...s].reduce((w, c) => w + 11 * (c === ' ' ? 0.28 : /[A-Z]/.test(c) ? 0.68 : /\d/.test(c) ? 0.6 : 0.55), 0);

/* Drawn through <Customized>, which hands over the chart's own x scale and
   plot box (Recharts drops a plain component child, see chartTheme.js). */
function MonthMarks({ xAxisMap, offset, width, monthSpans: spans, dividerColor, labelColor }) {
  const axis = xAxisMap && Object.values(xAxisMap)[0];
  const scale = axis && axis.scale;
  if (!scale || typeof scale.bandwidth !== 'function' || !offset || !spans || !spans.length) return null;
  const band = scale.bandwidth();
  const top = axis.y + axis.height + 1; // the row under the day numbers
  return (
    <g className="csd-month-mark">
      {spans.map((s, i) => {
        const x0 = scale(s.first);
        const x1 = scale(s.last) + band;
        if (!Number.isFinite(x0) || !Number.isFinite(x1)) return null;
        const names = MONTH_NAMES.map((o) => formatLocalDate(`${s.key}-01`, o));
        const text = names.find((n) => labelWidth(n) + 8 <= x1 - x0) || names[names.length - 1];
        const w = labelWidth(text);
        // Centred under its days. Where even the short name is wider than its
        // days, the first month's name ends at the dashed line and the last
        // one's starts there, so it never sits under the other month.
        let anchor = 'middle';
        let x = (x0 + x1) / 2;
        if (w + 8 > x1 - x0 && spans.length > 1) {
          if (i === 0) { anchor = 'end'; x = x1 - 4; } else if (i === spans.length - 1) { anchor = 'start'; x = x0 + 4; }
        }
        const left = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
        if (left < 2) x += 2 - left;
        else if (Number.isFinite(width) && left + w > width - 2) x -= left + w - (width - 2);
        return (
          <g key={s.key}>
            {i > 0 && (
              <line x1={x0} x2={x0} y1={offset.top} y2={offset.top + offset.height}
                stroke={dividerColor} strokeOpacity={0.6} strokeDasharray="4 3" />
            )}
            <text x={x} y={top} dy="0.71em" textAnchor={anchor} fill={labelColor} fontSize={11} fontWeight={600}>{text}</text>
          </g>
        );
      })}
    </g>
  );
}

/* Fri to Sun darker, anomaly days in the alert colour, prior-period rows in
   the neutral step. Identity is never colour alone: the legend names each,
   and the tooltip says it in words. */
function DailyChart({ rows, height = 240, csv = false }) {
  const chart = useChartTheme();
  const alert = cssVar('--red', '#FF6B8A');
  // Rows from the Daily section ({ submitted, weekend, anomalies: [type] }) or
  // from the finding's chart ({ amount, friToSun, anomaly: boolean }).
  const data = rows.filter((r) => r && r.date).map((r) => {
    const dow = dowOf(r);
    const types = anomalyTypes(r).filter((t) => t !== 'prior_period');
    if (!types.length && r.anomaly === true && !r.priorPeriod) types.push('unusual');
    const prior = !!r.priorPeriod;
    const friSun = FRI_SUN.has(dow) || (!dow && !!(r.weekend || r.friToSun));
    const fill = types.length ? alert : prior ? chart.other : friSun ? chart.seriesDeep[0] : chart.seriesLit[0];
    return { ...r, dow, types, prior, friSun, fill, submitted: Number(isNum(r.submitted) ? r.submitted : r.amount) || 0 };
  });
  const anyAnomaly = data.some((d) => d.types.length);
  const anyPrior = data.some((d) => d.prior);
  const spans = monthSpans(data);
  return (
    <div className="csd-chart-panel">
      {/* 6px taller than asked: the month row sits under the day numbers and
          the bars keep their height. */}
      <ResponsiveContainer width="100%" height={height + 6}>
        <RBarChart data={data} margin={{ top: 8, right: 6, left: -6, bottom: 14 }} barCategoryGap="18%">
          <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} vertical={false} />
          <Customized component={<MonthMarks monthSpans={spans} dividerColor={chart.axis} labelColor={chart.tick} />} />
          <XAxis dataKey="date" height={22} tickFormatter={(d) => { const dt = parseLocalDate(d); return dt ? String(dt.getDate()) : ''; }} tick={{ fill: chart.axis, fontSize: 11 }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={8} />
          <YAxis tickFormatter={axisMoney} tick={{ fill: chart.axis, fontSize: 11 }} axisLine={false} tickLine={false} width={48} />
          <RTooltip
            cursor={{ fill: chart.rimSoft }}
            content={<ChartTip render={(p) => {
              const d = p[0].payload;
              return (
                <>
                  <div className="csd-tip-label">{longDay(d.date)}</div>
                  <TipRow color={d.fill} name="Card sales" value={money(d.submitted)} />
                  <TipRow name="Fees" value={money(d.fees)} />
                  <TipRow name={csv ? 'Left after fees' : 'Sent to your bank'} value={money(d.processed)} />
                  {d.prior && <div className="csd-tip-flag">{ANOMALY_LABEL.prior_period}</div>}
                  {d.types.map((t) => <div key={t} className="csd-tip-flag is-alert">{ANOMALY_LABEL[t] || t}</div>)}
                </>
              );
            }}
            />}
          />
          <Bar dataKey="submitted" name="Card sales" radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={!prefersReducedMotion()}>
            {data.map((d) => <Cell key={d.date} fill={d.fill} />)}
          </Bar>
        </RBarChart>
      </ResponsiveContainer>
      <ul className="csd-legend">
        <li><span className="csd-sw" style={{ background: chart.seriesLit[0] }} />Monday to Thursday</li>
        <li><span className="csd-sw" style={{ background: chart.seriesDeep[0] }} />Friday to Sunday</li>
        {anyAnomaly && (
          <li>
            <span className="csd-sw" style={{ background: alert }} />{ANOMALY_LABEL.unusual}
            <MetricInfo label={ANOMALY_LABEL.unusual} info={ANOMALY_INFO.unusual} />
          </li>
        )}
        {anyPrior && (
          <li>
            <span className="csd-sw" style={{ background: chart.other }} />{ANOMALY_LABEL.prior_period}
            <MetricInfo label={ANOMALY_LABEL.prior_period} info={ANOMALY_INFO.prior_period} />
          </li>
        )}
      </ul>
    </div>
  );
}

/* One stacked bar of card sales (after refunds) by card type. */
function CardMixBar({ rows, csv = false }) {
  const chart = useChartTheme();
  const list = (rows || []).filter((r) => r && isNum(r.net) && Number(r.net) > 0);
  if (!list.length) return <NotOnStatement text="No sales by card type to show" />;
  const total = list.reduce((s, r) => s + Number(r.net), 0);
  const row = { name: 'Card types' };
  list.forEach((r, i) => { row[`k${i}`] = Number(r.net); });
  return (
    <div className="csd-chart-panel">
      <ResponsiveContainer width="100%" height={48}>
        <RBarChart data={[row]} layout="vertical" margin={{ top: 4, right: 0, left: 0, bottom: 4 }}>
          <XAxis type="number" hide domain={[0, total]} />
          <YAxis type="category" dataKey="name" hide />
          <RTooltip
            cursor={false}
            shared={false}
            content={<ChartTip render={(p) => {
              const i = Number(String(p[0].dataKey).slice(1));
              const r = list[i];
              if (!r) return null;
              const share = isNum(r.sharePct) ? r.sharePct : (Number(r.net) / total) * 100;
              return (
                <>
                  <div className="csd-tip-label">{cardTypeName(r, csv)}</div>
                  <TipRow color={networkColor(chart, r.type)} name="Sales after refunds" value={money(r.net)} />
                  <TipRow name="Percent of card sales" value={smallPct(share)} />
                </>
              );
            }}
            />}
          />
          {list.map((r, i) => (
            <Bar key={`k${i}`} dataKey={`k${i}`} stackId="mix" name={cardTypeName(r, csv)} fill={networkColor(chart, r.type)} stroke={chart.surface} strokeWidth={2} isAnimationActive={!prefersReducedMotion()} />
          ))}
        </RBarChart>
      </ResponsiveContainer>
      <ul className="csd-legend">
        {list.map((r, i) => (
          <li key={r.type || i}>
            <span className="csd-sw" style={{ background: networkColor(chart, r.type) }} />
            {cardTypeName(r, csv)} <strong>{smallPct(isNum(r.sharePct) ? r.sharePct : (Number(r.net) / total) * 100)}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   TABS
   ═══════════════════════════════════════════════════════════════════════════ */

function FeesTab({ analysis }) {
  const lines = Array.isArray(analysis.feeLines) ? analysis.feeLines : null;
  if (!lines || !lines.length) {
    return <section className="ref-card"><NotOnStatement text={analysis.layoutVersion === 'csv' ? 'This file does not list fees by name.' : undefined} /></section>;
  }
  const total = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  return (
    <section className="ref-card">
      <header className="ref-card-head">
        <div>
          <span className="ref-card-title">
            All your fees
            <MetricInfo label="All your fees" info="Each fee printed on your statement, line by line. Use it to see where your money went and which fees you could cut." />
          </span>
          <p className="ref-card-sub">Each fee as printed, in the same order as your statement. Flagged fees are the ones to check.</p>
        </div>
      </header>
      <div className="ref-table-wrap">
        <table className="ref-table csd-fees-table">
          <thead>
            <tr>
              <Th label="Fee as printed" info={FEE_AS_PRINTED_INFO} />
              <Th label="Fee type" info="The part of your statement the fee is listed under, such as transaction, account or card network fees, with the card brand or group when one is printed." />
              <Th label="Flag" info={FLAG_INFO} />
              <Th label="Debit card" info="Marks fees for debit cards, including debit network fees. Added up, they are what debit cards cost you." />
              <Th num label="Fee rate" info="The percent this fee takes from the sales it covers. For example, 3% means $3 on every $100." />
              <Th num label="Charged on" info="The sales the percent was charged on. For a flat fee, it shows how many times it was charged and the price each time." />
              <Th num label="You paid" />
              <Th label="What to do" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.index != null ? l.index : i}>
                <td className="ref-name" title={l.description || ''}>{l.description || DASH}</td>
                <td title={l.product ? productName(l.product) : undefined}>
                  {CATEGORY_LABEL[l.category] || l.category || DASH}{l.product ? ` · ${productName(l.product)}` : ''}
                </td>
                <td><TagChip tag={l.tag} /></td>
                <td>{l.isDebit ? <span className="csd-tag csd-tag-debit">Debit</span> : <span className="csd-muted">{DASH}</span>}</td>
                <td className="ref-num">{isNum(l.ratePct) ? pct(l.ratePct) : DASH}</td>
                <td className="ref-num">{isNum(l.baseAmount) ? money(l.baseAmount) : (isNum(l.count) ? `${num(l.count)} at ${money(l.unitPrice)} each` : DASH)}</td>
                <td className="ref-num ref-strong">{money(l.amount)}</td>
                <td title={l.fix || ''}>{l.fix || <span className="csd-muted">{DASH}</span>}</td>
              </tr>
            ))}
            <tr className="csd-total-row">
              <td>Total</td><td /><td /><td /><td /><td /><td className="ref-num">{money(total)}</td><td />
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DailyTab({ analysis }) {
  const csv = analysis.layoutVersion === 'csv';
  const d = analysis.daily;
  const rows = d && Array.isArray(d.rows) ? d.rows : null;
  if (!rows || !rows.length) return <section className="ref-card"><NotOnStatement /></section>;
  const t = d.totals || {};
  return (
    <>
      <section className="ref-card">
        <header className="ref-card-head">
          <div>
            <span className="ref-card-title">
              Card sales by day
              <MetricInfo label="Card sales by day" info="Each bar is one day's card sales. Use it to find your busiest days and spot days worth checking." />
            </span>
            <p className="ref-card-sub">
              {csv
                ? 'Your card sales each day, after refunds. Tap or hover over a bar to see the fees and what was left.'
                : 'Your card sales each day, after refunds. Tap or hover over a bar to see fees and what was sent to your bank.'}
            </p>
          </div>
        </header>
        <DailyChart rows={rows} height={260} csv={csv} />
      </section>
      <section className="ref-card">
        <div className="ref-table-wrap">
          <table className="ref-table csd-daily-table">
            <thead>
              <tr>
                <Th label="Date" />
                <Th label="Day" />
                <Th num label="Card sales" infoLabel="Card sales that day" info="Your card sales that day, after refunds and before fees." />
                <Th num label="Disputes" info="Money taken back that day because a card payment was disputed or reversed." />
                <Th num label="Adjustments" info="Money your processor added or took off that day. A minus amount was taken from you." />
                <Th num label="Fees" infoLabel="Fees that day" info="What your processor charged that day." />
                <Th
                  num
                  label={csv ? 'Left after fees' : 'Sent to your bank'}
                  infoLabel={csv ? 'Left after fees that day' : 'Sent to your bank that day'}
                  info={csv
                    ? 'Your card sales that day minus the fees listed for it.'
                    : 'What your processor sent to your bank for that day: card sales minus fees and disputes, plus or minus adjustments. A minus amount means more was taken out than paid in.'}
                />
                <Th label="Notes" info="Marks days to check: sales dated before the start date, a very low sales day before a busier one, or fees on a day with no card sales." />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const types = anomalyTypes(r).filter((x) => x !== 'prior_period');
                return (
                  <tr key={r.date || i} className={r.priorPeriod ? 'csd-row-prior' : (types.length ? 'csd-row-alert' : '')}>
                    <td>{shortDay(r.date)}</td>
                    <td>{dowOf(r)}</td>
                    <td className="ref-num">{money(r.submitted)}</td>
                    <td className="ref-num">{money(r.disputes)}</td>
                    <td className="ref-num">{money(r.adjustments)}</td>
                    <td className="ref-num">{money(r.fees)}</td>
                    <td className="ref-num">{money(r.processed)}</td>
                    <td>
                      {r.priorPeriod && <span className="csd-chip">{ANOMALY_LABEL.prior_period}</span>}
                      {types.map((x) => <span key={x} className="csd-chip is-alert">{ANOMALY_LABEL[x] || x}</span>)}
                    </td>
                  </tr>
                );
              })}
              {isNum(d.monthEndCharges) && (
                <tr>
                  <td colSpan={2}>
                    <span className="csd-th">
                      Month-end fees
                      <MetricInfo label="Month-end fees" info="Fees charged at the end of the month, not on any one day. The Total row adds them to Fees and takes them off Sent to your bank." />
                    </span>
                  </td>
                  <td /><td /><td />
                  <td className="ref-num">{money(d.monthEndCharges)}</td><td /><td />
                </tr>
              )}
              <tr className="csd-total-row">
                <td>Total</td><td />
                <td className="ref-num">{money(t.submitted)}</td><td /><td />
                <td className="ref-num">{money(t.fees)}</td>
                <td className="ref-num">{money(t.processed)}</td><td />
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function CardMixTab({ analysis }) {
  const csv = analysis.layoutVersion === 'csv';
  const mix = analysis.cardMix;
  const rows = mix && Array.isArray(mix.rows) ? mix.rows : null;
  if (!rows || !rows.length) return <section className="ref-card"><NotOnStatement /></section>;
  const t = mix.totals || {};
  return (
    <section className="ref-card">
      <header className="ref-card-head">
        <div>
          <span className="ref-card-title">
            Sales by card type
            <MetricInfo label="Sales by card type" info="Your card sales split by card type, with counts and refunds. Use it to see which cards bring in most of your sales." />
          </span>
          <p className="ref-card-sub">The percent is each card type's part of your card sales after refunds.</p>
        </div>
      </header>
      <CardMixBar rows={rows} csv={csv} />
      <div className="ref-table-wrap">
        <table className="ref-table csd-mix-table">
          <thead>
            <tr>
              <Th label="Card type" info="The card brand customers paid with. Visa and Mastercard debit cards are counted under their brand; PIN debit is debit sales not filed under a brand." />
              <Th num label="Average sale" infoLabel="Average sale for this card type" info="The average amount of one sale with this card type, so you can see which cards bring bigger purchases." />
              <Th num label="Number of sales" infoLabel="Number of sales for this card type" info="How many sales were paid with this card type. Refunds are not counted here." />
              <Th num label="Sales before refunds" infoLabel="Sales before refunds for this card type" info="Everything customers paid with this card type, before refunds were taken off." />
              <Th num label="Number of refunds" />
              <Th num label="Refunds" />
              <Th num label="Total count" info="Number of sales plus number of refunds for this card type." />
              <Th num label="Sales after refunds" info="Sales before refunds, minus refunds. The percent column is worked out from this amount." />
              <Th num label="Percent of card sales" info="This card type's part of all your card sales after refunds. It shows which cards bring in the most money." />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.type || i}>
                <td className="ref-name">{cardTypeName(r, csv)}</td>
                <td className="ref-num">{money(r.avgTicket)}</td>
                <td className="ref-num">{num(r.items)}</td>
                <td className="ref-num">{money(r.gross)}</td>
                <td className="ref-num">{num(r.refundItems)}</td>
                <td className="ref-num">{money(r.refunds)}</td>
                <td className="ref-num">{num(r.netItems)}</td>
                <td className="ref-num ref-strong">{money(r.net)}</td>
                <td className="ref-num">{smallPct(r.sharePct)}</td>
              </tr>
            ))}
            <tr className="csd-total-row">
              <td>Total</td><td />
              <td className="ref-num">{num(t.items)}</td>
              <td className="ref-num">{money(t.gross)}</td>
              <td className="ref-num">{num(t.refundItems)}</td>
              <td className="ref-num">{money(t.refunds)}</td>
              <td className="ref-num">{num(t.netItems)}</td>
              <td className="ref-num">{money(t.net)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function NoticesTab({ analysis }) {
  const csv = analysis.layoutVersion === 'csv';
  const notices = Array.isArray(analysis.notices) ? analysis.notices : null;
  const rs = analysis.reportableSales;
  const disputes = analysis.disputes;
  const items = disputes && Array.isArray(disputes.items) ? disputes.items : [];
  return (
    <>
      <section className="ref-card">
        <header className="ref-card-head">
          <span className="ref-card-title">
            Notices from your processor
            <MetricInfo label="Notices from your processor" info="Messages your processor prints on your statements, such as a new processing bank, a new deposit name or a fee change. Each one comes with what to do." />
          </span>
        </header>
        {notices == null ? <NotOnStatement text={csv ? 'This file does not include notices.' : 'Not on this statement'} /> : notices.length === 0 ? (
          <p className="csd-na">{csv ? 'This file does not include notices.' : 'No notices on this statement.'}</p>
        ) : (
          <ul className="csd-notices">
            {notices.map((nt, i) => (
              <li key={i} className="csd-notice">
                <div className="csd-notice-top">
                  <span className="csd-chip-group">
                    <span className={`csd-chip ${nt.kind && nt.kind !== 'other' ? 'is-attn' : ''}`}>{NOTICE_KIND[nt.kind] || 'Notice'}</span>
                    <MetricInfo label={NOTICE_KIND[nt.kind] || 'Notice'} info={NOTICE_INFO[nt.kind]} />
                  </span>
                  {nt.effectiveDate && <span className="csd-anom-date">From {formatLocalDate(nt.effectiveDate)}</span>}
                </div>
                <blockquote className="csd-notice-text">{nt.text}</blockquote>
                {nt.action && <p className="csd-notice-action"><strong>What to do:</strong> {nt.action}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="ref-card">
        <header className="ref-card-head">
          <span className="ref-card-title">
            1099-K sales
            <MetricInfo label="1099-K sales" info="Your card sales before refunds, as your processor counts them for your 1099-K tax form. Check the year-so-far total against your own records." />
          </span>
        </header>
        {!rs ? <NotOnStatement text={csv ? 'This file does not include 1099-K sales.' : undefined} /> : (
          <MathRow cells={[
            { label: rs.monthLabel ? `Reported for ${rs.monthLabel}` : 'Reported for the month', value: rs.monthAmount, format: 'money' },
            { label: rs.ytdYear && rs.monthLabel ? `${rs.ytdYear} through ${rs.monthLabel}` : (rs.ytdYear ? `${rs.ytdYear} so far` : 'Year so far'), value: rs.ytdAmount, format: 'money' },
            rs.tinLast4 && { label: 'Tax ID', display: `ending ${rs.tinLast4}`, info: "The last 4 digits of the tax ID these sales are reported under. Check that it is your business's." },
          ].filter(Boolean)}
          />
        )}
      </section>

      <section className="ref-card">
        <header className="ref-card-head">
          <span className="ref-card-title">
            Disputes and chargebacks
            <MetricInfo label="Disputes and chargebacks" info="Card payments taken back from you, usually because a customer disputed the charge with their bank. Check each one against your receipts." />
          </span>
        </header>
        {!disputes ? <NotOnStatement text={csv ? 'This file does not include disputes.' : undefined} /> : Number(disputes.count) > 0 || items.length > 0 ? (
          <>
            <p className="csd-dispute-sum">
              {(() => {
                const n = disputes.count != null ? Number(disputes.count) : items.length;
                return `${num(n)} ${n === 1 ? 'dispute' : 'disputes'} this period, ${money(disputes.amount)} taken back from your deposits.`;
              })()}
            </p>
            {items.length > 0 && (
              <div className="ref-table-wrap">
                <table className="ref-table csd-table-sm">
                  <thead><tr><th>Date</th><th className="ref-num">Amount</th><th>Reason</th></tr></thead>
                  <tbody>
                    {items.map((it, i) => (
                      <tr key={i}>
                        <td>{shortDay(it.date)}</td>
                        <td className="ref-num">{money(it.amount)}</td>
                        <td title={it.reason || ''}>{it.reason || DASH}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : Number(disputes.amount) > 0 ? (
          <p className="csd-dispute-sum">{money(disputes.amount)} taken back for disputes this period.</p>
        ) : (
          <p className="csd-zero">No disputes or chargebacks this period</p>
        )}
      </section>
    </>
  );
}
