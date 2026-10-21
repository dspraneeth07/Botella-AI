// CardStatementsScreen.js
// -----------------------------------------------------------------------------
// Card Statement Analysis - upload a monthly card processing statement (PDF, or
// a transaction CSV) and see what it charged, where money leaks, and what the
// store would have kept with Rebelipay.
//
// Built the way Quick PO is: a LIST of statements and the DETAIL of one in the
// same screen rather than two routes, so the owner never loses the list (its
// search, filter and page) while reading a statement. The detail lives in
// CardStatementDetail; this file is the list, the upload dialog and the log.
//
// What is different from Quick PO, on purpose:
//   - errors arrive as { error: { code, message } } and go through errorText;
//     a proxy's HTML error page (413, 502, 504) is not parsed as JSON;
//   - a 401 ends the session instead of printing "Unauthorized" in a banner;
//   - an identity duplicate is only found after the statement is read, so a
//     row can vanish from the list while analysing. The screen says where it
//     went rather than letting it disappear.
//
// Copy rule: the Rebelipay price (its percentage and its per-transaction fee)
// is never shown, not even split out of a total. Only what the owner keeps.
// -----------------------------------------------------------------------------

import React, { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import {
  Upload, FileText, Loader, AlertTriangle, Check, X, Search, Eye, Trash2, RefreshCw,
  ChevronLeft, ChevronRight, ScrollText, CreditCard, ArrowDown, ArrowUp, ArrowUpDown, Copy,
} from 'lucide-react';
import './ReferenceScreen.css';
import './CardStatementsScreen.css';
import { useDialog } from './Dialog';
import MetricInfo from './MetricInfo';
import CardStatementDetail from './CardStatementDetail';
import { useCellTitles } from '../utils/useCellTitles';
import { errorText } from '../utils/errorText';
import { clearSession } from '../utils/session';

/* ── Formatting ─────────────────────────────────────────────────────────────
   Local on purpose: there is no shared formatter, and the list wants whole
   dollars for volumes and fees but cents for the saving. */
const dollars = (v) => (v == null ? 'n/a' : '$' + Math.round(Number(v)).toLocaleString('en-US'));
const money = (v) => (v == null ? 'n/a' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pct = (v, dp) => (v == null ? 'n/a' : `${Number(v).toFixed(dp)}%`);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "Jul 2026" from "2026-07-31". Read off the string, never through new Date():
 * a bare date parses as UTC midnight, which is the previous day - and on the
 * 1st, the previous MONTH - anywhere west of Greenwich.
 */
function periodLabel(iso) {
  const m = /^(\d{4})-(\d{2})/.exec(String(iso || ''));
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${m[1]}` : null;
}

const stamp = (d) => (d
  ? new Date(d).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })
  : 'n/a');

/* ── Responses ──────────────────────────────────────────────────────────────── */

/**
 * The body of a response, without trusting it to be JSON.
 *
 * Most failures come from our API as { error: { code, message } }, but the ones
 * that matter most for an upload do not: a 413 from nginx for a file over its
 * body limit, or a 502/504 while the backend restarts, arrive as an HTML page.
 * `res.json()` on that throws "Unexpected token <", which is what the owner
 * would have read. Here an unreadable body is simply empty, and the status
 * explains it (see failure()).
 *
 * A 401 is an expired session, never a document problem (the API promises
 * that), so it signs out instead of showing a banner nobody can act on.
 */
async function readBody(res) {
  if (res.status === 401) {
    clearSession();
    window.location.assign('/login');
    throw new Error('Your session has ended. Please sign in again.');
  }
  try {
    return (await res.json()) || {};
  } catch {
    return {};
  }
}

/** The owner-facing message for a failed response, whatever shape it came in. */
function failure(res, body, fallback) {
  if (body && body.error != null) return errorText(body.error, fallback);
  if (res.status === 413) return 'That file is larger than 20 MB.';
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    return 'Botella did not answer in time. Please try again in a minute.';
  }
  return fallback;
}

/* ── Upload limits, mirrored from the server ───────────────────────────────── */
const MAX_FILES = 20;
const MAX_BYTES = 20 * 1024 * 1024;

// The list's default order: newest period first, statements not read yet on
// top. (The server's own default is still store A to Z; the screen asks for
// this one. Each store uploads its own statements, so there is no Store
// column to sort by.)
const DEFAULT_SORT = 'period';

// Every statement gets the same six checks (Finding 01 to 06), so a count of
// flagged ones reads "5 of 6 flagged" (D43): the statement page shows all six.
const CHECKS = 6;

// One turn of the Refresh icon (.cs-spin in the CSS): a press spins whole
// turns so the icon comes to rest where it started.
const SPIN_MS = 900;
// How long "Updated just now" stays (the .cs-updated fade in the CSS).
const UPDATED_MS = 2600;
// Under reduced motion the icon does not turn; a press holds the dim this
// long so it reads as a refresh, not a flicker.
const REDUCED_HOLD_MS = 450;
// A request that never reached the server. The browser's own message for
// this is "Failed to fetch", which tells an owner nothing.
const UNREACHABLE = 'Could not reach the server. Check your connection and try again.';

const prefersReducedMotion = () => (typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
  : false);

/**
 * Why a file will not be accepted, or null if it looks fine.
 *
 * The server checks every file itself (by its bytes, not its name), so this is
 * not the guard - it only saves a round trip, and it matters for drag and drop,
 * which ignores the picker's `accept` list entirely.
 */
function fileProblem(f) {
  const named = /\.(pdf|csv)$/i.test(f.name || '');
  const typed = f.type === 'application/pdf' || f.type === 'text/csv';
  if (!named && !typed) return 'Only PDF statements and CSV files can be read.';
  if (f.size === 0) return 'This file is empty.';
  if (f.size > MAX_BYTES) return 'This file is larger than 20 MB.';
  return null;
}

/* ── What survives leaving the screen ──────────────────────────────────────
   The screen unmounts whenever the owner opens another view, and with it the
   statements it was watching and the notices it had not shown yet. Both are
   kept for the tab's session, per client (two accounts in one tab never see
   each other's file names), so a statement found to be a duplicate while the
   owner was elsewhere is still explained when they come back. Storage can be
   missing or full (private mode); then the screen simply forgets, as before. */

function storeKey(name) {
  let client = '';
  try { client = localStorage.getItem('botella_client_id') || ''; } catch { /* storage unavailable */ }
  return `botella_cs_${name}_${client}`;
}

function readStored(name) {
  try {
    const v = JSON.parse(sessionStorage.getItem(storeKey(name)) || 'null');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeStored(name, value) {
  try {
    if (value.length) sessionStorage.setItem(storeKey(name), JSON.stringify(value));
    else sessionStorage.removeItem(storeKey(name));
  } catch {
    /* storage unavailable or full: nothing to keep */
  }
}

const loadWatch = () => new Map(readStored('watch')
  .filter((e) => Array.isArray(e) && e[0] != null)
  .map(([id, name]) => [String(id), String(name || '')]));

const loadNotices = () => readStored('notices').filter((n) => n && n.id != null && n.fileName);

/* ── Modal focus ────────────────────────────────────────────────────────────
   A dialog takes focus when it opens, keeps Tab and Shift+Tab inside itself,
   and hands focus back to whatever opened it when it closes, so a keyboard
   user is not dropped at the top of the page. Escape stays with each dialog. */

const FOCUSABLE = [
  'button:not([disabled])', '[href]', 'select:not([disabled])', 'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])', '[tabindex]:not([tabindex="-1"])',
].join(',');

function useModalFocus(dialogRef, initialRef) {
  useEffect(() => {
    const opener = document.activeElement;
    const start = (initialRef && initialRef.current) || dialogRef.current;
    if (start) start.focus();

    const onKey = (e) => {
      const box = dialogRef.current;
      if (e.key !== 'Tab' || !box) return;
      // The file input is display:none (inside [hidden]) and never tabbable.
      const items = Array.from(box.querySelectorAll(FOCUSABLE)).filter((el) => !el.closest('[hidden]'));
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      if (!box.contains(at)) { e.preventDefault(); first.focus(); return; }
      if (e.shiftKey && at === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    };
  }, [dialogRef, initialRef]);
}

// A column heading with its ⓘ saying what the column is. The ⓘ follows the
// last word on its line, as the sort arrows do, never on a line of its own.
const ColHead = ({ label, info, num }) => {
  const words = label.split(' ');
  const last = words.pop();
  return (
    <th className={num ? 'ref-num' : undefined} aria-label={label}>
      {words.length ? `${words.join(' ')} ` : ''}
      <span className="cs-th-end">{last}<MetricInfo label={label} info={info} /></span>
    </th>
  );
};

function CardStatementsScreen({ authToken, apiUrl }) {
  const base = (apiUrl || '').replace(/\/api\/?$/, '') + '/api/card-statements';
  // No Content-Type here, ever: the upload sends FormData, and a hand-set
  // multipart type has no boundary, so the server cannot find the file.
  const headers = useCallback(() => ({
    Authorization: `Bearer ${authToken}`,
    'ngrok-skip-browser-warning': 'true',
  }), [authToken]);

  const dialog = useDialog();
  const [list, setList] = useState([]);
  const [total, setTotal] = useState(0);
  const [stores, setStores] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Search, filters, sort and paging all run on the server, so the "1-N of T"
  // line and the rows under it always describe the same query.
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [storeFilter, setStoreFilter] = useState('');
  const [sort, setSort] = useState(DEFAULT_SORT);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);

  // The upload dialog, and what is in flight inside it. The ref mirrors the
  // state for the upload loop, which outlives the render it started in and
  // must know whether the dialog is still there to report what did not go in.
  const [uploadOpen, setUploadOpen] = useState(false);
  const uploadOpenRef = useRef(false);
  const showUpload = useCallback((open) => { uploadOpenRef.current = open; setUploadOpen(open); }, []);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [queue, setQueue] = useState([]); // { name, size, state, error }
  const [overflow, setOverflow] = useState(0); // files past MAX_FILES, not sent
  const fileRef = useRef(null);

  const [logRow, setLogRow] = useState(null);

  // Statements this screen has seen analysing, id -> file name. A statement
  // that turns out to be one already on the list (same merchant, same period)
  // is only recognised AFTER it has been read, and then it leaves the list -
  // duplicates are never listed. Without this the owner watches a row vanish
  // and is left to guess whether the upload was lost. Kept in sessionStorage
  // too (see loadWatch), so leaving the screen does not lose the watch.
  const watchRef = useRef(null);
  if (watchRef.current === null) watchRef.current = loadWatch();
  const [watching, setWatching] = useState(() => watchRef.current.size);
  // { id, kind, fileName, originalId, target, message }. kind: undefined (the
  // same statement, found after reading), 'same-file' or 'failed' (from a
  // batch whose dialog was closed), 'overflow' (files past MAX_FILES).
  const [notices, setNotices] = useState(loadNotices);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; uploadOpenRef.current = false; };
  }, []);
  useEffect(() => { writeStored('notices', notices); }, [notices]);

  const syncWatch = useCallback(() => {
    setWatching(watchRef.current.size);
    writeStored('watch', [...watchRef.current]);
  }, []);

  // Once the screen is gone its state is too; a notice found after that goes
  // straight to storage, and the next visit shows it.
  const addNotices = useCallback((items) => {
    if (!items.length) return;
    const merge = (prev) => [...prev, ...items.filter((n) => !prev.some((p) => p.id === n.id))];
    if (mountedRef.current) setNotices(merge);
    else writeStored('notices', merge(loadNotices()));
  }, []);

  // Typing should not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => { setDebouncedQ(q.trim()); setPage(0); }, 300);
    return () => clearTimeout(t);
  }, [q]);

  /**
   * Find out where a watched statement went.
   *
   * Absent from the page is not the same as gone: it may sit on another page,
   * or outside the current filter. So ask for it by id. Still analysing - keep
   * watching. A duplicate - say so, naming the statement it duplicates. Deleted
   * or anything else - nothing to explain.
   */
  const explainVanished = useCallback(async (id, fileName) => {
    try {
      const res = await fetch(`${base}/${id}`, { method: 'GET', headers: headers() });
      const row = await readBody(res);
      if (!res.ok) return;
      if (row.status === 'analysing') {
        watchRef.current.set(id, fileName);
        syncWatch();
        return;
      }
      if (row.status !== 'duplicate') return;

      let original = null;
      if (row.duplicateOf) {
        const res2 = await fetch(`${base}/${row.duplicateOf}`, { method: 'GET', headers: headers() });
        const body2 = await readBody(res2);
        if (res2.ok) original = body2;
      }
      const source = original || row;
      const target = [source.merchantName, periodLabel(source.periodEnd)].filter(Boolean).join(' · ');
      addNotices([{
        id,
        fileName: fileName || row.fileName || 'That file',
        originalId: original ? String(original.id) : null,
        target: target || 'a statement already on your list',
      }]);
    } catch {
      // The notice is a courtesy. Failing to fetch it must not raise a banner
      // over a list that loaded fine.
    }
  }, [base, headers, syncWatch, addNotices]);

  /** Compare the rows just loaded with the ones being watched. */
  const followAnalysing = useCallback((rows) => {
    const watched = watchRef.current;
    const gone = [];
    watched.forEach((fileName, id) => {
      const row = rows.find((r) => String(r.id) === id);
      if (row && row.status === 'analysing') return;
      watched.delete(id);
      if (!row) gone.push({ id, fileName });
    });
    rows.forEach((r) => { if (r.status === 'analysing') watched.set(String(r.id), r.fileName || ''); });
    syncWatch();
    gone.forEach(({ id, fileName }) => { explainVanished(id, fileName); });
  }, [explainVanished, syncWatch]);

  // Every list request takes a number, and only the latest one may touch the
  // screen. Requests overlap (a poll, an upload's reload, a filter change) and
  // can answer out of order; without this an older answer for an older query
  // lands last and the rows stop matching the search, filter or page shown.
  const seqRef = useRef(0);
  // The request in flight. A newer one cancels it: its answer would be
  // dropped anyway, and a slow one must not hold a Refresh press open.
  const listAbortRef = useRef(null);

  // Resolves to the request's number when its answer is the one now on
  // screen, 0 otherwise (overtaken, failed, or stepped back a page).
  const loadList = useCallback(async ({ quiet = false } = {}) => {
    const seq = ++seqRef.current;
    const stale = () => seq !== seqRef.current;
    if (listAbortRef.current) listAbortRef.current.abort();
    const abort = new AbortController();
    listAbortRef.current = abort;
    if (!quiet) setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(rowsPerPage),
        offset: String(page * rowsPerPage),
        sort,
      });
      if (debouncedQ) params.set('q', debouncedQ);
      if (statusFilter) params.set('status', statusFilter);
      if (storeFilter) params.set('store', storeFilter);
      // no-store: a Refresh must reach the server, never a cached answer.
      const res = await fetch(`${base}?${params.toString()}`, {
        method: 'GET', headers: headers(), cache: 'no-store', signal: abort.signal,
      }).catch((e) => {
        // The browser's own words for a network failure are "Failed to fetch".
        if (e && e.name === 'AbortError') throw e;
        throw new Error(UNREACHABLE);
      });
      if (stale()) return 0;
      const body = await readBody(res);
      if (stale()) return 0;
      if (!res.ok) throw new Error(failure(res, body, 'Could not load your statements.'));
      const rows = Array.isArray(body.data) ? body.data : [];
      const count = Number(body.total) || 0;
      // Deleting the last row on the last page leaves the page past the end.
      // Step back to the real last page rather than show "No statements".
      if (!rows.length && count > 0 && page > 0) {
        setPage(Math.max(0, Math.ceil(count / rowsPerPage) - 1));
        return 0;
      }
      setList(rows);
      setTotal(count);
      setStores(Array.isArray(body.stores) ? body.stores : []);
      setError('');
      followAnalysing(rows);
      return seq;
    } catch (e) {
      // An aborted request is always a stale one: nothing to say.
      if (!stale()) setError(e.message);
      return 0;
    } finally {
      // The latest request ends the spinner whether or not it was quiet: a
      // loud one overtaken by a poll would otherwise never clear it.
      if (!stale()) setLoading(false);
    }
  }, [base, headers, rowsPerPage, page, sort, debouncedQ, statusFilter, storeFilter, followAnalysing]);

  // For code that awaits before it reloads (the upload loop, a delete behind
  // its confirm): by then the owner may have changed the query, and the
  // loadList that code closed over would load the old one.
  const loadListRef = useRef(loadList);
  loadListRef.current = loadList;

  useEffect(() => { loadList(); }, [loadList]);

  // A press of Refresh. The list answers in a few milliseconds, faster than
  // the spinner or the dim can be seen, so a press looked like it did nothing.
  // Now the icon turns and stops where its animation began: on a whole turn
  // counted from when it STARTED turning, so a second press mid-turn never
  // stops it part-way round. A lone press gets one full turn; a press into a
  // turn already going gets at least half a turn more, so a double click
  // still ends after one turn. The rows dim while it turns, and "Updated just
  // now" says it worked, but only if the press's answer is still the one on
  // screen when the turn ends: a search, filter, page, poll or error since
  // then means it is not. Under reduced motion nothing turns, so the press
  // waits only long enough for the dim to read as a refresh, not a flicker.
  const [pressing, setPressing] = useState(false);
  const [updated, setUpdated] = useState(false);
  const pressRef = useRef(0);
  const spinning = loading || pressing;
  const spinStartRef = useRef(0);
  useLayoutEffect(() => { if (spinning) spinStartRef.current = Date.now(); }, [spinning]);
  const refresh = useCallback(async () => {
    const mine = ++pressRef.current;
    const pressed = Date.now();
    setUpdated(false);
    setPressing(true);
    const answered = await loadList();
    const now = Date.now();
    let until = pressed + REDUCED_HOLD_MS;
    if (!prefersReducedMotion()) {
      const start = spinStartRef.current || pressed;
      until = start + Math.ceil((Math.max(now, pressed + SPIN_MS / 2) - start) / SPIN_MS) * SPIN_MS;
    }
    await new Promise((r) => { setTimeout(r, Math.max(0, until - now)); });
    if (mine !== pressRef.current) return;
    setPressing(false);
    if (answered && answered === seqRef.current) setUpdated(true);
  }, [loadList]);
  useEffect(() => {
    if (!updated) return undefined;
    const t = setTimeout(() => setUpdated(false), UPDATED_MS);
    return () => clearTimeout(t);
  }, [updated]);
  // The note sits beside the buttons, or under Refresh where there is no room
  // beside them. Measured, not a breakpoint: the room depends on the
  // sidebar's width as much as the window's, and the page clips what spills.
  const noteRef = useRef(null);
  const [noteUnder, setNoteUnder] = useState(false);
  useLayoutEffect(() => {
    if (!updated) { setNoteUnder(false); return; }
    const note = noteRef.current;
    const page = note && note.closest('.ref-page');
    if (!page) return;
    const clip = page.getBoundingClientRect().left + page.clientLeft + page.clientWidth;
    if (note.getBoundingClientRect().right > clip - 4) setNoteUnder(true);
  }, [updated]);

  // A statement is written as 'analysing' before it is read, and reading takes
  // a minute or more. Poll quietly while one is in flight (or one we are
  // watching is somewhere off this page), then stop: a permanent timer on a
  // settled table is wasted requests. Not while a statement is open - the
  // detail polls its own row.
  const anyAnalysing = list.some((d) => d.status === 'analysing');
  useEffect(() => {
    if (openId || (!anyAnalysing && watching === 0)) return undefined;
    const t = setInterval(() => loadList({ quiet: true }), 3000);
    return () => clearInterval(t);
  }, [openId, anyAnalysing, watching, loadList]);

  // Pressing "Card Statement Analysis" in the sidebar while reading a
  // statement returns to the list (see the botella-renav note in ChatPage),
  // and reloads it as Back does: opening a statement can re-file its figures
  // (D44), and the list must not show the ones from before. loadListRef
  // (above) always holds the current query's loader.
  useEffect(() => {
    const onRenav = (e) => {
      if (e.detail !== 'card-statements') return;
      setOpenId(null);
      loadListRef.current({ quiet: true });
    };
    window.addEventListener('botella-renav', onRenav);
    return () => window.removeEventListener('botella-renav', onRenav);
  }, []);

  // Handed to the detail. Stable, because the detail lists onChanged as an
  // effect dependency and a fresh arrow every render would re-run that effect.
  const refreshQuietly = useCallback(() => loadList({ quiet: true }), [loadList]);
  const closeDetail = useCallback(() => { setOpenId(null); loadList({ quiet: true }); }, [loadList]);

  // A tooltip on any cell whose text is clipped - measured, not guessed.
  useCellTitles(null, [list, openId]);

  /* ── Upload ─────────────────────────────────────────────────────────────── */

  /**
   * Upload a set of files, one request at a time.
   *
   * The upload answers as soon as the row exists (202) and the reading happens
   * after, so "queued" is the honest word for a file that went through: the
   * table below is where the real status lands, and it polls until it settles.
   *
   * Sequential, not parallel: twenty concurrent reads would compete for the
   * same model and the same database for no gain.
   */
  const doUpload = async (files) => {
    const all = Array.from(files || []);
    const picked = all.slice(0, MAX_FILES);
    if (!picked.length) return;
    const extra = all.length - picked.length;

    // The loop's own record of each file. The queue state says the same for
    // the dialog, but the loop cannot read state, and it needs the outcome at
    // the end when the dialog may already be closed.
    const results = picked.map((f) => {
      const problem = fileProblem(f);
      return { name: f.name, size: f.size, state: problem ? 'failed' : 'waiting', error: problem || '' };
    });
    const mark = (i, patch) => {
      Object.assign(results[i], patch);
      setQueue((prev) => prev.map((row, n) => (n === i ? { ...row, ...patch } : row)));
    };

    setError('');
    setOverflow(extra);
    setQueue(results.map((r) => ({ ...r })));
    setUploading(true);

    // A new statement is written as analysing and, with no store name yet,
    // sorts to the top of every store and period order. A search, a filter or
    // the savings sort left over from before would hide it, so a batch that
    // sends anything starts from the default view.
    if (results.some((r) => r.state === 'waiting')) {
      setQ('');
      setDebouncedQ('');
      setStatusFilter('');
      setStoreFilter('');
      setSort(DEFAULT_SORT);
      setPage(0);
    }

    let clean = extra === 0;
    for (let i = 0; i < picked.length; i++) {
      if (results[i].state === 'failed') { clean = false; continue; }
      mark(i, { state: 'uploading' });
      try {
        const fd = new FormData();
        fd.append('file', picked[i]);
        const res = await fetch(`${base}/upload`, { method: 'POST', headers: headers(), body: fd });
        const body = await readBody(res);
        if (!res.ok) throw new Error(failure(res, body, 'Upload failed.'));
        // The same file uploaded before: the server kept the copy it had and
        // added nothing. Its own state, not success - "done" on a row that
        // added nothing is how a list quietly grows a second identical copy.
        if (body.duplicate) {
          clean = false;
          mark(i, {
            state: 'duplicate',
            error: errorText(body.message, 'This file is already on your list.'),
            originalId: body.id != null ? String(body.id) : null,
          });
        } else {
          if (body.id != null) {
            watchRef.current.set(String(body.id), picked[i].name);
            syncWatch();
          }
          mark(i, { state: 'queued', error: '' });
        }
        loadListRef.current({ quiet: true });
      } catch (e) {
        clean = false;
        mark(i, { state: 'failed', error: e.message });
      }
    }

    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
    await loadListRef.current({ quiet: true });

    // Every file went in: close and let the table carry on. Anything that did
    // not (a failure, a duplicate, files over the limit) keeps the dialog open,
    // because closing it would throw away the only place that says so.
    if (clean) {
      showUpload(false);
      setQueue([]);
      return;
    }

    // The owner closed the dialog while files were still going. It is not
    // reopened over whatever they moved on to; what did not go in is said
    // above the list instead, once per file.
    if (!uploadOpenRef.current) {
      const batch = `upload-${Date.now()}`;
      const missed = [];
      results.forEach((r, i) => {
        if (r.state === 'duplicate') {
          missed.push({ id: `${batch}-${i}`, kind: 'same-file', fileName: r.name, originalId: r.originalId || null, message: r.error });
        } else if (r.state === 'failed') {
          missed.push({ id: `${batch}-${i}`, kind: 'failed', fileName: r.name, originalId: null, message: r.error });
        }
      });
      if (extra > 0) {
        missed.push({ id: `${batch}-over`, kind: 'overflow', fileName: `${extra} more ${extra === 1 ? 'file' : 'files'}`, count: extra, originalId: null, message: '' });
      }
      addNotices(missed);
      setQueue([]);
      setOverflow(0);
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    if (!uploading) doUpload(e.dataTransfer.files);
  };

  // Reopened while a batch is still going, the dialog shows that batch. The
  // next batch resets the queue itself (doUpload), so only a settled one is
  // cleared here.
  const openUpload = () => {
    if (!uploading) { setQueue([]); setOverflow(0); }
    showUpload(true);
  };
  const closeUpload = () => {
    showUpload(false);
    if (!uploading) setQueue([]);
    loadList({ quiet: true });
  };

  /* ── Delete ─────────────────────────────────────────────────────────────── */

  // Behind the app's own confirm: the bin sits one row away from the View
  // button, which is a bad place for a misclick.
  const askRemove = async (d) => {
    const period = periodLabel(d.periodEnd);
    const name = d.merchantName
      ? [d.merchantName, period].filter(Boolean).join(' · ')
      : (d.fileName || 'This statement');
    const yes = await dialog.confirm({
      title: 'Delete this statement?',
      message: `${name}, its analysis and the original file will be removed. This cannot be undone.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Keep',
      tone: 'danger',
    });
    if (!yes) return;
    // A deleted row vanishing from the list is not a mystery to explain.
    watchRef.current.delete(String(d.id));
    syncWatch();
    try {
      const res = await fetch(`${base}/${d.id}`, { method: 'DELETE', headers: headers() });
      const body = await readBody(res);
      if (!res.ok) throw new Error(failure(res, body, 'Could not delete that statement.'));
      setError('');
    } catch (e) {
      setError(e.message);
    }
    loadListRef.current({ quiet: true });
  };

  const dismissNotice = (id) => setNotices((prev) => prev.filter((n) => n.id !== id));

  /* ── Sort ───────────────────────────────────────────────────────────────── */
  // The default is newest period first. The Period header flips its own
  // direction; the savings header goes most saved, least saved, then back to
  // the default.
  const sortBy = (next) => { setSort(next); setPage(0); };
  const SORT_HEADERS = {
    period: { up: 'period_asc', down: 'period', first: 'period', title: 'Sort by statement period' },
    savings: { up: 'savings_asc', down: 'savings', first: 'savings', title: 'Sort by what you would keep with Rebelipay' },
  };
  const sortHeader = (key) => {
    const h = SORT_HEADERS[key];
    const dir = sort === h.up ? 'ascending' : sort === h.down ? 'descending' : 'none';
    const next = dir === 'none' ? h.first
      : key === 'savings' ? (dir === 'descending' ? h.up : DEFAULT_SORT)
        : (dir === 'ascending' ? h.down : h.up);
    return {
      ariaSort: dir,
      Icon: dir === 'ascending' ? ArrowUp : dir === 'descending' ? ArrowDown : ArrowUpDown,
      on: dir !== 'none',
      title: h.title,
      onClick: () => sortBy(next),
    };
  };
  const periodSort = sortHeader('period');
  const savingsSort = sortHeader('savings');

  // Derived, never stored: a stored copy goes stale the moment a filter
  // changes the total.
  const pageCount = Math.max(1, Math.ceil(total / rowsPerPage));
  const filtered = Boolean(debouncedQ || statusFilter || storeFilter);
  // A store the filter still names but the list no longer has (its last
  // statement was deleted) keeps an option, or the select would show the
  // wrong store while still filtering by the old one.
  const storeOptions = storeFilter && !stores.some((s) => s.merchantNumber === storeFilter)
    ? [...stores, { merchantNumber: storeFilter, merchantName: null, count: 0 }]
    : stores;
  // The store filter (shown only when a client has more than one store) names
  // each store by its name alone. Only stores that trade under the same name
  // add the merchant # to tell them apart; a store with no name read yet shows
  // its merchant #.
  const nameKey = (s) => String(s.merchantName || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const nameUses = storeOptions.reduce((m, s) => (nameKey(s) ? m.set(nameKey(s), (m.get(nameKey(s)) || 0) + 1) : m), new Map());
  const storeLabel = (s) => {
    if (!nameKey(s)) return s.merchantNumber;
    return nameUses.get(nameKey(s)) > 1 ? `${s.merchantName} · ${s.merchantNumber}` : s.merchantName;
  };
  // The closed dropdown can cut a long label (the merchant # that tells two
  // same-name stores apart is at its end), so its tooltip carries it whole.
  const pickedStore = storeOptions.find((s) => s.merchantNumber === storeFilter);
  const storeTitle = pickedStore ? storeLabel(pickedStore) : 'All stores';

  /* ── Render ─────────────────────────────────────────────────────────────── */
  // The detail brings its own content and no page shell: this one scrolls it,
  // gives it the gutter, and leaves room for the Ask bar, same as the list.
  if (openId) {
    return (
      <div className="ref-page cs-page">
        <CardStatementDetail
          id={openId}
          authToken={authToken}
          apiUrl={apiUrl}
          onBack={closeDetail}
          onChanged={refreshQuietly}
        />
      </div>
    );
  }

  const empty = !loading && !error && total === 0 && !filtered;
  // Only the very first load (nothing to show yet) gets the "Loading" row;
  // every later one keeps the rows on screen, dimmed (see the table).
  const firstLoad = loading && list.length === 0;
  const refreshing = loading && !firstLoad;

  return (
    <div className="ref-page cs-page">
      <header className="cs-head">
        <div>
          <h1 className="ref-title"><CreditCard size={20} /> Card Statement Analysis</h1>
          <p className="ref-sub">
            Upload credit/debit card statements to see what you paid,
            where money leaks, and what you would have <strong className="cs-sub-saved">saved</strong>.
          </p>
        </div>
        <div className="cs-head-actions">
          {/* Never disabled: greying it out on every page change made the
              header flicker. A second click while loading just asks again,
              and only the latest answer is shown. */}
          <button type="button" className="cs-btn" onClick={refresh} aria-busy={spinning}>
            <RefreshCw size={14} className={spinning ? 'cs-spin' : ''} /> Refresh
          </button>
          <button type="button" className="cs-btn cs-btn-primary" onClick={openUpload}>
            <Upload size={14} /> Upload statement
          </button>
          {/* Always in the page, so a screen reader hears it when the note
              arrives; out of the flow, so the note moves nothing. */}
          <span className={`cs-updated-live ${noteUnder ? 'is-under' : ''}`} role="status">
            {updated && (
              <span className="cs-updated" ref={noteRef}><Check size={13} aria-hidden="true" /> Updated just now</span>
            )}
          </span>
        </div>
      </header>

      {notices.length > 0 && (
        <div className="cs-notices" aria-live="polite">
          {notices.map((n) => (
            <div key={n.id} className={`cs-notice ${n.kind === 'failed' || n.kind === 'overflow' ? 'is-failed' : ''}`} role="status">
              {n.kind === 'failed' || n.kind === 'overflow'
                ? <AlertTriangle size={16} aria-hidden="true" />
                : <Copy size={16} aria-hidden="true" />}
              <NoticeText notice={n} />
              {n.originalId && (
                <button
                  type="button"
                  className="cs-notice-link"
                  onClick={() => { dismissNotice(n.id); setOpenId(n.originalId); }}
                >
                  View
                </button>
              )}
              <button
                type="button"
                className="cs-notice-x"
                onClick={() => dismissNotice(n.id)}
                aria-label="Dismiss this notice"
              >
                <X size={15} />
              </button>
            </div>
          ))}
        </div>
      )}

      {error && <div className="cs-error" role="alert"><AlertTriangle size={16} /> {error}</div>}

      {empty ? (
        <div className="ref-empty cs-empty">
          <CreditCard size={28} aria-hidden="true" />
          <p>Upload a card processing statement (PDF or CSV) to see what it isn&apos;t telling you.</p>
          <button type="button" className="cs-btn cs-btn-primary" onClick={openUpload}>
            <Upload size={14} /> Upload statement
          </button>
        </div>
      ) : (
        <>
          {/* The toolbar sits outside the empty-result check: a search box that
              vanishes when a filter matches nothing leaves no way to change
              the filter. */}
          <div className="cs-toolbar">
            <div className="cs-search">
              <Search size={14} aria-hidden="true" />
              <input
                type="text"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search by store, merchant ID, file name or period (e.g. June 2026)…"
                aria-label="Search statements by store, merchant number, file name or period"
                title="Every word must match. Periods: June, Jun 2026, 06/2026, 2026-06, 2026, or a day such as 06/30/2026."
              />
              {q && (
                <button type="button" className="cs-search-clear" onClick={() => setQ('')} aria-label="Clear search">
                  <X size={13} />
                </button>
              )}
            </div>

            {/* Everything but the search, kept together on the right of it, in
                one row. Where the row is too narrow the group moves under the
                search as a whole, never one control at a time. */}
            <div className="cs-toolbar-controls">
              <label className="cs-filter">
                <span>Status:</span>
                <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(0); }}>
                  <option value="">All</option>
                  <option value="analysed">Analysed</option>
                  <option value="analysing">Analysing</option>
                  <option value="failed">Could not read</option>
                </select>
              </label>

              {/* One store has nothing to choose between. */}
              {(storeOptions.length > 1 || storeFilter) && (
                <label className="cs-filter">
                  <span>Store:</span>
                  <select value={storeFilter} title={storeTitle} onChange={(e) => { setStoreFilter(e.target.value); setPage(0); }}>
                    <option value="">All stores</option>
                    {storeOptions.map((s) => (
                      <option key={s.merchantNumber} value={s.merchantNumber}>{storeLabel(s)}</option>
                    ))}
                  </select>
                </label>
              )}

              <div className="cs-pager">
                <span className="cs-count">
                  {total === 0 ? '0' : `${page * rowsPerPage + 1}-${Math.min(total, (page + 1) * rowsPerPage)}`}
                  {' of '}<strong>{total}</strong>
                </span>
                <label className="cs-filter">
                  <span>Rows:</span>
                  <select value={rowsPerPage} onChange={(e) => { setRowsPerPage(Number(e.target.value)); setPage(0); }}>
                    {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
                <button
                  type="button" className="cs-page-btn" aria-label="Previous page"
                  onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}
                >
                  <ChevronLeft size={15} />
                </button>
                <span className="cs-page-of">{`${page + 1} / ${pageCount}`}</span>
                <button
                  type="button" className="cs-page-btn" aria-label="Next page"
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  disabled={page >= pageCount - 1}
                >
                  <ChevronRight size={15} />
                </button>
              </div>
            </div>
          </div>

          {/* A page change, a sort or a search keeps the rows it has on screen,
              dimmed, until the next ones arrive. Swapping them for a one-line
              "Loading" row collapsed the table, the page lost its scrollbar,
              and everything above it, the header buttons included, jumped. */}
          <div className={`ref-card cs-card ${refreshing ? 'is-loading' : ''} ${pressing ? 'is-pressed' : ''}`}>
            <div className="ref-table-wrap">
              <table className="ref-table cs-table" aria-busy={spinning}>
                <thead>
                  <tr>
                    {/* Headings in the words the statement page uses, each with
                        an ⓘ saying what the column is (D41). */}
                    <th aria-label="View" />
                    <ColHead label="Merchant ID" info="Your store's ID with your card processor (the merchant number on your statement). Statements with the same ID are from the same account." />
                    <th aria-sort={periodSort.ariaSort}>
                      <button type="button" className={`cs-sort ${periodSort.on ? 'is-on' : ''}`} onClick={periodSort.onClick} title={periodSort.title}>
                        Period <periodSort.Icon size={12} aria-hidden="true" />
                      </button>
                    </th>
                    <ColHead num label="Card sales" info="Your total card sales for the period, minus refunds, before any fees come out." />
                    <ColHead num label="Fees paid" info="Everything your processor charged for the period, including card fees, account fees and penalties." />
                    <ColHead num label="Effective rate" info="Your fees divided by your card sales: how many cents in fees you paid for every $1 of card sales. Lower is better." />
                    <ColHead num label="Debit share" info="The part of your card sales paid with debit cards. Open the statement to see what debit cards cost you (Finding 01)." />
                    <th className="ref-num" aria-sort={savingsSort.ariaSort} aria-label="Save with Rebelipay">
                      <button type="button" className={`cs-sort ${savingsSort.on ? 'is-on' : ''}`} onClick={savingsSort.onClick} title={savingsSort.title}>
                        {/* Two lines on purpose ("SAVE WITH" / "REBELIPAY ⇅ ⓘ"):
                            left to wrap, the arrow or the ⓘ ended on a line
                            of its own. */}
                        Save with{' '}<br />Rebelipay <savingsSort.Icon size={12} aria-hidden="true" />
                      </button>
                      <MetricInfo label="Save with Rebelipay" info="Our estimate of what you would save in fees with Rebelipay in a year at this pace (this upload's saving times 12, a once-a-year fee counted once), and under it the saving on this upload alone. A dash means there is no saving to show: your fees already match or beat our estimate, or we could not compare them." />
                    </th>
                    <ColHead label="Findings" info="How many of the six checks on the statement flagged something: Urgent, Needs a look or Worth a look. Open the statement to see them, each with why." />
                    <th>Status</th>
                    <ColHead label="Log" info="The statement's history: when it was uploaded, analysed or analysed again, and any problem reading it." />
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {/* The note spans the whole (wide) table; the inner span
                      keeps it in the part that is on screen (see the CSS). */}
                  {firstLoad && (
                    <tr>
                      <td colSpan={12} className="cs-table-note">
                        <span className="cs-table-note-in"><Loader size={16} className="cs-spin" /> Loading your statements…</span>
                      </td>
                    </tr>
                  )}

                  {!loading && list.length === 0 && (
                    <tr>
                      <td colSpan={12} className="cs-table-note">
                        <span className="cs-table-note-in">
                          {filtered ? 'No statements match that search.' : 'No statements to show.'}
                        </span>
                      </td>
                    </tr>
                  )}

                  {!firstLoad && list.map((d) => {
                    // Nothing has been read from a statement that is still
                    // analysing, or that could not be read, so its figure cells
                    // stay blank: "n/a" eleven times over says less than an
                    // empty row with its status beside it. An analysed row with
                    // a genuinely missing figure says n/a.
                    const analysing = d.status === 'analysing';
                    const analysed = d.status === 'analysed';
                    const blank = (v, fmt) => (v == null ? (analysed ? 'n/a' : '') : fmt(v));
                    const name = analysing
                      ? (d.fileName || 'Statement')
                      : (d.merchantName || d.fileName || 'Statement');
                    const saves = analysed && d.rebelipayEligible && d.rebelipaySavings != null;
                    const period = d.periodEnd ? periodLabel(d.periodEnd) : null;
                    // There is no Store column: each store uploads its own
                    // statements, so every row would say the same name. The
                    // name still reaches a screen reader and the tooltip.
                    const viewLabel = [name, period].filter(Boolean).join(', ');
                    return (
                      <tr key={d.id} className="cs-row">
                        <td className="cs-td-view">
                          {/* The only way in. The row itself does nothing, so a
                              mis-aimed click on Log or Delete never opens the
                              statement instead. */}
                          <button
                            type="button"
                            className="cs-open-btn"
                            onClick={() => setOpenId(String(d.id))}
                            disabled={analysing}
                            aria-label={`View ${viewLabel}`}
                            title={analysing ? 'It opens once it is analysed' : `View ${viewLabel}`}
                          >
                            <Eye size={13} aria-hidden="true" /> View
                          </button>
                        </td>
                        {/* A statement not read yet (analysing, or could not be
                            read) has no merchant # to show; its file name
                            stands in, so the row still says which upload it is. */}
                        <td title={!d.merchantNumber && d.fileName ? d.fileName : undefined}>
                          {!d.merchantNumber && d.fileName && !analysed
                            ? <span className="cs-muted cs-file-name">File: {d.fileName}</span>
                            : blank(d.merchantNumber, (v) => v)}
                        </td>
                        <td>{blank(d.periodEnd, (v) => periodLabel(v) || 'n/a')}</td>
                        <td className="ref-num">{blank(d.amountSubmitted, dollars)}</td>
                        <td className="ref-num">{blank(d.totalFees, dollars)}</td>
                        <td className="ref-num">{blank(d.effectiveRate, (v) => pct(v, 2))}</td>
                        <td className="ref-num">{blank(d.debitShare, (v) => pct(v, 0))}</td>
                        <td className="ref-num cs-td-save">
                          {saves && (
                            <>
                              {/* The year first, as the statement page leads
                                  with it; this upload's own amount under it (D49). */}
                              {d.rebelipaySavingsAnnual != null ? (
                                <>
                                  <span className="cs-save">{dollars(d.rebelipaySavingsAnnual)}{d.layoutVersion === 'csv' ? ' per 12 periods' : '/yr'}</span>
                                  <span className="cs-save-yr">{money(d.rebelipaySavings)} {d.layoutVersion === 'csv' ? 'this file' : 'this statement'}</span>
                                </>
                              ) : (
                                <span className="cs-save">{money(d.rebelipaySavings)}</span>
                              )}
                            </>
                          )}
                          {analysed && !saves && (
                            <span className="cs-muted" title="No saving to show">
                              <span aria-hidden="true">&mdash;</span>
                              <span className="cs-sr">No saving to show</span>
                            </span>
                          )}
                        </td>
                        <td>
                          {analysed && (Number(d.findingsCount) > 0
                            ? <span className="cs-badge">{d.findingsCount} of {CHECKS} flagged</span>
                            : <span className="cs-muted">None flagged</span>)}
                        </td>
                        <td><StatusChip status={d.status} detail={d.parseError} /></td>
                        <td>
                          <button
                            type="button"
                            className="cs-log-btn"
                            onClick={() => setLogRow(d)}
                            aria-label={`Log for ${viewLabel}`}
                          >
                            <ScrollText size={13} aria-hidden="true" /> Log
                          </button>
                        </td>
                        <td className="cs-row-actions">
                          <button
                            type="button"
                            className="cs-icon-btn"
                            aria-label={`Delete ${viewLabel}`}
                            onClick={() => askRemove(d)}
                          >
                            <Trash2 size={15} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {logRow && <LogModal row={logRow} base={base} headers={headers} onClose={() => setLogRow(null)} />}

      {uploadOpen && (
        <UploadDialog
          fileRef={fileRef}
          dragging={dragging}
          setDragging={setDragging}
          uploading={uploading}
          queue={queue}
          overflow={overflow}
          onFiles={doUpload}
          onDrop={onDrop}
          onClose={closeUpload}
        />
      )}
    </div>
  );
}

/** What a notice says. Each kind names the file and what happened to it. */
function NoticeText({ notice: n }) {
  if (n.kind === 'same-file') {
    return (
      <p className="cs-notice-text">
        <strong>{n.fileName}</strong> is already on your list and was not added again.
      </p>
    );
  }
  if (n.kind === 'failed') {
    return (
      <p className="cs-notice-text">
        <strong>{n.fileName}</strong> could not be added. {n.message || 'Upload failed.'}
      </p>
    );
  }
  if (n.kind === 'overflow') {
    return (
      <p className="cs-notice-text">
        <strong>{n.fileName}</strong> {n.count === 1 ? 'was' : 'were'} not sent. Only the first {MAX_FILES} files of a batch are taken; upload the rest now.
      </p>
    );
  }
  return (
    <p className="cs-notice-text">
      <strong>{n.fileName}</strong> is the same statement as {n.target} and was not added again.
    </p>
  );
}

function StatusChip({ status, detail }) {
  if (status === 'analysed') return <span className="cs-chip cs-chip-ok"><Check size={12} aria-hidden="true" /> Analysed</span>;
  if (status === 'failed') {
    return (
      <span className="cs-chip cs-chip-bad" title={detail || ''}>
        <X size={12} aria-hidden="true" /> Could not read
      </span>
    );
  }
  return <span className="cs-chip cs-chip-wait"><Loader size={12} className="cs-spin" aria-hidden="true" /> Analysing…</span>;
}

/* ═══════════════════════════════════════════════════════════════════════════
   UPLOAD
   ═══════════════════════════════════════════════════════════════════════════

   Closing the dialog while files are still going does NOT stop them: each
   statement that went through is already a row in the table, marked as
   analysing, and the list polls until it settles. The close button therefore
   says nothing about cancelling. */

const STATE_LABEL = {
  waiting: 'Waiting',
  uploading: 'Uploading…',
  queued: 'Added · analysing',
  duplicate: 'Already on your list',
  failed: 'Failed',
};

function UploadDialog({ fileRef, dragging, setDragging, uploading, queue, overflow, onFiles, onDrop, onClose }) {
  const dropRef = useRef(null);
  const boxRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Keyboard users land on the drop target, which opens the picker.
  useModalFocus(boxRef, dropRef);

  const pick = () => { if (!uploading && fileRef.current) fileRef.current.click(); };
  const done = !uploading && queue.length > 0;

  return (
    <div className="cs-modal-overlay" onMouseDown={onClose}>
      <div
        ref={boxRef}
        className="cs-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cs-upload-title"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="cs-modal-head">
          <div>
            <h2 className="cs-modal-title" id="cs-upload-title">Upload statements</h2>
            <p className="cs-modal-sub">
              PDF statements or a transaction CSV. Up to {MAX_FILES} files, 20 MB each. Each file becomes its own statement.
            </p>
          </div>
          <button type="button" className="cs-modal-x" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>

        <div
          ref={dropRef}
          className={`cs-drop ${dragging ? 'is-dragging' : ''} ${uploading ? 'is-busy' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={pick}
          role="button"
          tabIndex={0}
          aria-disabled={uploading}
          aria-label="Choose statement files to upload"
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } }}
        >
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".pdf,.csv,application/pdf,text/csv"
            hidden
            onChange={(e) => onFiles(e.target.files)}
          />
          <Upload size={22} aria-hidden="true" />
          <strong>Drag and drop files here, or click to browse</strong>
          <span>PDF or CSV</span>
        </div>

        {queue.length > 0 && (
          <ul className="cs-queue" aria-live="polite">
            {queue.map((f, i) => (
              <li key={`${f.name}-${i}`} className={`cs-queue-row is-${f.state}`}>
                <FileText size={15} aria-hidden="true" />
                <div className="cs-queue-body">
                  <span className="cs-queue-name">{f.name}</span>
                  <span className="cs-queue-meta">
                    {(f.size / 1024).toFixed(1)} KB
                    {f.error ? ` · ${f.error}` : ''}
                  </span>
                </div>
                <span className="cs-queue-chip">
                  {f.state === 'uploading' && <Loader size={12} className="cs-spin" aria-hidden="true" />}
                  {STATE_LABEL[f.state]}
                </span>
              </li>
            ))}
          </ul>
        )}

        {overflow > 0 && (
          <p className="cs-modal-note">
            Only the first {MAX_FILES} files were taken. Upload the other {overflow} once these are done.
          </p>
        )}

        {uploading && (
          <p className="cs-modal-note">
            You can close this. Files already sent keep analysing and the rest keep uploading. We will tell you if any could not be added.
          </p>
        )}

        {done && (
          <div className="cs-modal-actions">
            <button type="button" className="cs-btn" onClick={onClose}>Close</button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   LOG
   ═══════════════════════════════════════════════════════════════════════════

   The summary is the outcome (did it read, did the figures add up); the
   activity is the history (who uploaded it, when it was analysed, whether it
   was a duplicate, re-run, interrupted, or sent to Rebelipay). */

const EVENT_LABEL = {
  uploaded: 'Uploaded',
  analysed: 'Analysed',
  analysis_failed: 'Could not read',
  duplicate: 'Duplicate',
  reanalysed: 'Analysed again',
  interrupted: 'Interrupted',
  rebelipay_interest: 'Asked about Rebelipay',
};

const STATUS_LABEL = {
  analysed: 'Analysed',
  analysing: 'Analysing…',
  failed: 'Could not read',
  duplicate: 'Duplicate',
};

const keyLabel = (k) => {
  const words = String(k).replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const isNum = (v) => v != null && v !== '' && Number.isFinite(Number(v));

const fileSize = (bytes) => {
  const n = Number(bytes);
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(0.1, n / 1024).toFixed(1)} KB`;
};

const took = (ms) => {
  const s = Math.max(1, Math.round(Number(ms) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};

/**
 * What each event's payload shows, as label/value pairs, in a fixed order.
 *
 * Only keys named here are ever shown. A payload is written for the record,
 * not for the owner: it has raw keys (savingsPct, checksTotal), unformatted
 * numbers and fields that must never reach the screen, and a generic dump
 * of it read like a debug view. An event or a key not listed shows nothing.
 */
const EVENT_DETAILS = {
  uploaded: (p) => [
    ['File type', p.kind ? String(p.kind).toUpperCase() : null],
    ['Size', isNum(p.size) ? fileSize(p.size) : null],
  ],
  analysed: (p) => [
    ['Took', isNum(p.ms) ? took(p.ms) : null],
    // The printed totals that agree. Not 'checks': that word is the six findings (D43).
    ['Totals', isNum(p.checksTotal) && isNum(p.checksPassed) ? `${p.checksPassed} of ${p.checksTotal} add up` : null],
    ['Findings flagged', isNum(p.findings) ? `${Number(p.findings)} of ${CHECKS}` : null],
  ],
  reanalysed: (p) => [
    ...EVENT_DETAILS.analysed(p),
    ['Read the file again', p.reextract ? 'Yes' : null],
  ],
  analysis_failed: (p) => [['Reason', p.message ? String(p.message) : null]],
  duplicate: (p) => [
    ['Why', p.reason === 'same_file' ? 'The same file was uploaded again'
      : p.reason === 'same_statement' ? 'The same statement was uploaded again' : null],
    ['File', p.fileName ? String(p.fileName) : null],
    ['Kept', p.duplicateOf != null ? `Statement #${p.duplicateOf}` : null],
  ],
  interrupted: (p) => [['Waited', isNum(p.staleMinutes) ? `${p.staleMinutes} min` : null]],
  rebelipay_interest: (p) => {
    const sv = (p.savings && typeof p.savings === 'object') ? p.savings : {};
    const period = (p.period && typeof p.period === 'object') ? p.period : {};
    return [
      ['Merchant', p.merchantName || p.merchantNumber || null],
      ['Period', period.label || null],
      ['Card volume', isNum(sv.volume) ? money(sv.volume) : null],
      ['Current fees', isNum(sv.currentCost) ? money(sv.currentCost) : null],
      ['Current rate', isNum(sv.currentRate) ? pct(sv.currentRate, 2) : null],
      ['You save per year', isNum(sv.savingsAnnual) ? money(sv.savingsAnnual) : null],
      ['You save', isNum(sv.savings) ? money(sv.savings) : null],
      // With a penalty the store stops itself, what the page showed in all (D49).
      ['Total found per year', isNum(sv.totalFoundAnnual) && sv.totalFoundAnnual !== sv.savingsAnnual ? money(sv.totalFoundAnnual) : null],
    ];
  },
};

/** An event's details for the log, formatted and with nothing unlisted. */
function payloadRows(event, payload) {
  const pick = EVENT_DETAILS[event];
  if (!pick || !payload || typeof payload !== 'object') return [];
  return pick(payload).filter(([, v]) => v != null && v !== '');
}

function LogModal({ row, base, headers, onClose }) {
  const [events, setEvents] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const closeRef = useRef(null);
  const boxRef = useRef(null);
  const id = row.id;

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`${base}/${id}/log`, { method: 'GET', headers: headers() });
        const body = await readBody(res);
        if (!res.ok) throw new Error(failure(res, body, 'Could not load the log.'));
        if (alive) { setEvents(Array.isArray(body.data) ? body.data : []); setError(''); }
      } catch (e) {
        if (alive) setError(e.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    // The fetch outlives the dialog if it is closed quickly; without this the
    // response would set state on a component that is gone.
    return () => { alive = false; };
  }, [id, base, headers]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useModalFocus(boxRef, closeRef);

  const checks = row.reconciliationOk === true
    ? 'Everything adds up'
    : row.reconciliationOk === false
      ? 'Some totals did not add up'
      : 'n/a';

  return (
    <div className="cs-modal-overlay" onMouseDown={onClose}>
      <div
        ref={boxRef}
        className="cs-modal cs-modal-log"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cs-log-title"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="cs-modal-head">
          <div>
            <h2 className="cs-modal-title" id="cs-log-title">Statement log</h2>
            <p className="cs-modal-sub">{row.fileName || 'What happened to this statement, oldest first.'}</p>
          </div>
          <button type="button" className="cs-modal-x" ref={closeRef} onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>

        <div className="cs-log-body">
          <dl className="cs-log-summary">
            <div><dt>Status</dt><dd>{STATUS_LABEL[row.status] || row.status}</dd></div>
            <div><dt>Totals</dt><dd>{row.status === 'analysed' ? checks : 'n/a'}</dd></div>
            <div><dt>Uploaded by</dt><dd>{row.uploadedBy || 'n/a'}</dd></div>
            <div><dt>Uploaded</dt><dd>{stamp(row.createdAt)}</dd></div>
            <div><dt>Updated</dt><dd>{stamp(row.updatedAt)}</dd></div>
          </dl>

          {row.parseError && (
            <div className="cs-log-section">
              <h3 className="cs-log-head">Why it could not be read</h3>
              <p className="cs-log-notes">{row.parseError}</p>
            </div>
          )}

          <div className="cs-log-section">
            <h3 className="cs-log-head">Activity</h3>
            {loading && <p className="cs-table-note"><Loader size={16} className="cs-spin" /> Loading the log…</p>}
            {!loading && error && <div className="cs-error" role="alert"><AlertTriangle size={16} /> {error}</div>}
            {!loading && !error && events && events.length === 0 && (
              <p className="cs-log-empty">Nothing has happened to this statement yet.</p>
            )}
            {!loading && !error && events && events.length > 0 && (
              <ul className="cs-log-events">
                {events.map((e, i) => {
                  const details = payloadRows(e.event, e.payload);
                  return (
                    <li key={e.id || i} className="cs-log-event">
                      <div className="cs-log-event-top">
                        <span className={`cs-log-tag is-${e.event}`}>{EVENT_LABEL[e.event] || keyLabel(e.event)}</span>
                        {/* No actor means the system did it: an analysis
                            finishing is not a person's action. */}
                        <span className="cs-log-actor">{e.actor || 'system'}</span>
                        <span className="cs-log-when">{stamp(e.createdAt)}</span>
                      </div>
                      {details.length > 0 && (
                        <dl className="cs-log-details">
                          {details.map(([label, value]) => (
                            <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
                          ))}
                        </dl>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default CardStatementsScreen;
