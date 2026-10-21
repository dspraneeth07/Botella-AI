// PurchaseOrdersScreen.js
// -----------------------------------------------------------------------------
// Quick PO - upload a supplier invoice or purchase order, read it, and see the
// lines against your own catalogue.
//
// Two views in one screen rather than two routes: a LIST of documents, and the
// DETAIL of one. The detail is where all the work happens (correcting a parsed
// line, linking it to a product, adding a product that does not exist yet), and
// keeping it in the same screen means the owner never loses the list they came
// from while resolving a dozen lines.
//
// The one thing this screen is really for: showing which lines Botella could
// NOT find in the catalogue, so the owner can fix them. Everything else is in
// service of that.
// -----------------------------------------------------------------------------

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Upload, FileText, Loader, AlertTriangle, Check, X, Search, Plus, Download, Eye, Trash2, ArrowLeft, RefreshCw, Sparkles, Pencil, RotateCcw, ChevronLeft, ChevronRight, ScrollText } from 'lucide-react';
import './PurchaseOrdersScreen.css';
import { useDialog } from './Dialog';
import DocumentViewer from './DocumentViewer';
import { useCellTitles } from '../utils/useCellTitles';

const money = (v) => (v == null ? 'n/a' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const qty = (v) => (v == null ? 'n/a' : Number(v).toLocaleString('en-US'));
const shortDate = (d) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'n/a');

/**
 * Packs per case, read off the pack notation.
 *
 * A beverage pack reads leading-number-first: "4/6/12 BTL" is 4 packs of 6 of
 * 12oz, "12/24 CAN" is 12 of 24. So the first integer IS the packs-per-case,
 * and nothing needs to be stored for it.
 *
 * Returns a dash rather than a guess when the field is absent or does not start
 * with a number - a fabricated 1 would read as fact.
 */
function packsPerCase(pack) {
  if (!pack) return '\u2014';
  const m = String(pack).match(/^\s*(\d+)/);
  return m ? m[1] : '\u2014';
}

function PurchaseOrdersScreen({ authToken, apiUrl, onNavigate }) {
  const base = (apiUrl || '').replace(/\/api\/?$/, '') + '/api/purchase-orders';
  const headers = useCallback(() => ({
    Authorization: `Bearer ${authToken}`,
    'ngrok-skip-browser-warning': 'true',
  }), [authToken]);

  const listDialog = useDialog();
  const [list, setList] = useState([]);
  const [total, setTotal] = useState(0);
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef(null);

  // Search / filter / paging. The server does all three, so the "1-N of T"
  // line and the rows below it always describe the same query - counting every
  // document while showing a filtered page is how a table ends up claiming
  // "1-25 of 38" above an empty body.
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);

  // The upload dialog, and what is in flight inside it.
  const [uploadOpen, setUploadOpen] = useState(false);
  const [logId, setLogId] = useState(null);
  const [queue, setQueue] = useState([]); // { name, size, state, error }

  // Typing should not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => { setDebouncedQ(q.trim()); setPage(0); }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const loadList = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(rowsPerPage),
        offset: String(page * rowsPerPage),
      });
      if (debouncedQ) params.set('q', debouncedQ);
      if (statusFilter) params.set('status', statusFilter);
      const res = await fetch(`${base}?${params.toString()}`, { headers: headers() });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not load your documents.');
      setList(body.data || []);
      setTotal(Number(body.total) || 0);
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [base, headers, rowsPerPage, page, debouncedQ, statusFilter]);

  // A document is written as 'parsing' before the parse begins, so a row can be
  // on screen while the work is still happening - including after the upload
  // dialog has been closed. Poll quietly until none are left, then stop: a
  // permanent timer on a settled table is wasted requests.
  const anyParsing = list.some((d) => d.status === 'parsing');
  useEffect(() => {
    if (!anyParsing) return undefined;
    const t = setInterval(() => loadList({ quiet: true }), 3000);
    return () => clearInterval(t);
  }, [anyParsing, loadList]);

  const loadDetail = useCallback(async (id) => {
    setBusy(true);
    try {
      const res = await fetch(`${base}/${id}`, { headers: headers() });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not load that document.');
      setDetail(body);
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }, [base, headers]);

  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => { if (openId) loadDetail(openId); else setDetail(null); }, [openId, loadDetail]);

  // Pressing "Purchase Orders" in the sidebar while reading one invoice used to
  // do nothing: the route was already /purchase-orders, so nothing navigated,
  // and the open document lives here rather than in the URL. ChatPage now
  // announces a re-navigation to the view you are already on; closing the
  // document is what that means on this screen.
  useEffect(() => {
    const onRenav = (e) => { if (e.detail === 'purchase-orders') setOpenId(null); };
    window.addEventListener('botella-renav', onRenav);
    return () => window.removeEventListener('botella-renav', onRenav);
  }, []);

  /* ── Upload ─────────────────────────────────────────────────────────────── */
  const MAX_FILES = 20;

  /**
   * Upload a set of files, one request at a time.
   *
   * The endpoint takes a single file and parses it INLINE, so there is no queue
   * to report - each file is genuinely waiting, then being read. The states
   * below say exactly that rather than borrowing the word "queued" for
   * something that is not queued anywhere.
   *
   * Sequential, not parallel: twenty concurrent parses would compete for the
   * same model and the same database, and the first file would finish later
   * than it does now for no gain.
   */
  const doUpload = async (files) => {
    const picked = Array.from(files || []).slice(0, MAX_FILES);
    if (!picked.length) return;

    setError('');
    setQueue(picked.map((f) => ({ name: f.name, size: f.size, state: 'waiting', error: '' })));
    setUploading(true);

    let firstId = null;
    for (let i = 0; i < picked.length; i++) {
      setQueue((prev) => prev.map((row, n) => (n === i ? { ...row, state: 'reading' } : row)));
      // The row is written as 'parsing' before the parse starts, so refreshing
      // now puts it in the table straight away - which is what makes closing
      // this dialog mid-upload leave something behind rather than nothing.
      loadList({ quiet: true });
      try {
        const fd = new FormData();
        fd.append('file', picked[i]);
        const res = await fetch(`${base}/upload`, { method: 'POST', headers: headers(), body: fd });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || 'Upload failed.');
        if (firstId === null) firstId = body.id;
        // The server recognised this file's CONTENT and kept the copy it had.
        // Reported as its own state rather than as success: "done" on a row
        // that added nothing is how a list quietly grows a third identical
        // invoice while everyone believes the upload worked.
        // The upload answers as soon as the row exists; the read happens after.
        // "Read" here would be a lie for another ninety seconds - the table
        // below is where the real status lands, and it polls until it settles.
        const state = body.duplicate ? 'duplicate'
          : body.status === 'parsing' ? 'queued'
            : 'done';
        setQueue((prev) => prev.map((row, n) => (n === i
          ? { ...row, state, error: body.duplicate ? body.message : '' }
          : row)));
      } catch (e) {
        setQueue((prev) => prev.map((row, n) => (n === i ? { ...row, state: 'failed', error: e.message } : row)));
      }
    }

    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
    await loadList();

    // Stay on the list, whether one file or ten.
    //
    // A single upload used to open its document. That reads as helpful and is
    // not: the reason to upload is usually to upload, and being thrown into a
    // detail screen means finding your way back before adding the next one. The
    // new row is already at the top of the list with its status on it, which is
    // what the person wanted to know.
    if (firstId !== null) {
      setUploadOpen(false);
      setQueue([]);
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    doUpload(e.dataTransfer.files);
  };

  /* ── Mutations, all of which return the fresh detail ────────────────────── */
  const mutate = async (path, options = {}) => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${base}${path}`, {
        ...options,
        headers: { ...headers(), ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'That did not work.');
      if (body.items) setDetail(body);
      return body;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const removeDoc = async (id) => {
    const body = await mutate(`/${id}`, { method: 'DELETE' });
    if (body) { setOpenId(null); loadList(); }
  };

  // Deleting from the list, behind the app's own confirm. The row is one click
  // from opening the document, so an unguarded bin icon beside it is a bad
  // place for a misclick.
  const askRemove = async (d) => {
    const yes = await listDialog.confirm({
      title: 'Delete this document?',
      message: `${d.invoiceNo || d.fileName || 'This document'} and its ${d.itemCount ?? 0} line items will be removed. This cannot be undone.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Keep',
      tone: 'danger',
    });
    if (yes) removeDoc(d.id);
  };

  // Total pages for the pager. Derived, never stored: a stored copy goes stale
  // the moment a filter changes the total.
  const pageCount = Math.max(1, Math.ceil(total / rowsPerPage));

  /* ── Render ─────────────────────────────────────────────────────────────── */
  // Gated on openId ALONE, not on the detail having arrived.
  //
  // The detail endpoint resolves every line against the POS catalogue, which
  // lives in the remote warehouse, and takes a couple of seconds. Waiting for
  // it before switching screens meant a click on a row did nothing visible for
  // that whole time - the list just sat there, so the click read as ignored and
  // people clicked again.
  //
  // The list row already holds everything the top of the detail shows: the
  // invoice number, the vendor, the date and the totals. So the screen opens
  // immediately from that, and the lines fill in underneath when they land.
  // A tooltip on any cell whose text is clipped - measured, not guessed.
  useCellTitles(null, [list, detail, openId]);

  if (openId) {
    const placeholder = list.find((d) => String(d.id) === String(openId)) || null;

    // Neither yet: the row is not on the page we are showing (opened straight
    // after an upload, or from a filtered list). Nothing to render optimistically,
    // so say what is happening rather than crash on a null.
    if (!detail && !placeholder) {
      return (
        <div className="po-page">
          <button type="button" className="po-back po-back-top" onClick={() => { setOpenId(null); loadList(); }}>
            <ArrowLeft size={14} /> Back to invoices
          </button>
          <div className="po-table-note"><Loader size={16} className="po-spin" /> Opening the document…</div>
        </div>
      );
    }

    return (
      <div className="po-page">
        <DetailView
          detail={detail || placeholder}
          pending={!detail}
          base={base}
          authToken={authToken}
          busy={busy}
          error={error}
          onBack={() => { setOpenId(null); loadList(); }}
          onMutate={mutate}
          onDelete={() => removeDoc(detail.id)}
          onRefresh={() => loadDetail(detail.id)}
        />
      </div>
    );
  }

  return (
    <div className="po-page">
      <header className="po-head po-head-row">
        <div>
          <h1 className="po-title"><FileText size={20} /> Purchase Orders</h1>
          <p className="po-sub">Upload, review, and manage parsed invoices.</p>
        </div>
        <div className="po-head-actions">
          <button type="button" className="po-btn" onClick={() => loadList()} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'po-spin' : ''} /> Refresh
          </button>
          <button type="button" className="po-btn po-btn-primary" onClick={() => { setQueue([]); setUploadOpen(true); }}>
            <Upload size={14} /> Upload
          </button>
        </div>
      </header>

      {/* The toolbar sits OUTSIDE the empty check on purpose. A search box that
          vanishes when a filter matches nothing leaves no way to change the
          filter - the only escape is a page reload. */}
      <div className="po-toolbar">
        <div className="po-search">
          <Search size={14} />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by invoice no, PO, or vendor…"
            aria-label="Search documents"
          />
          {q && (
            <button type="button" className="po-search-clear" onClick={() => setQ('')} aria-label="Clear search">
              <X size={13} />
            </button>
          )}
        </div>

        <label className="po-filter">
          <span>Status:</span>
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(0); }}
          >
            <option value="">All statuses</option>
            <option value="parsed">Read</option>
            <option value="parsing">Reading</option>
            <option value="failed">Could not read</option>
          </select>
        </label>

        <div className="po-pager">
          <span className="po-count">
            {total === 0 ? '0' : `${page * rowsPerPage + 1}–${Math.min(total, (page + 1) * rowsPerPage)}`}
            {' of '}<strong>{total}</strong>
          </span>
          <label className="po-filter">
            <span>Rows:</span>
            <select
              value={rowsPerPage}
              onChange={(e) => { setRowsPerPage(Number(e.target.value)); setPage(0); }}
            >
              {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <button
            type="button" className="po-page-btn" aria-label="Previous page"
            onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}
          >
            <ChevronLeft size={15} />
          </button>
          <span className="po-page-of">{pageCount === 0 ? '0 / 0' : `${page + 1} / ${pageCount}`}</span>
          <button
            type="button" className="po-page-btn" aria-label="Next page"
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            disabled={page >= pageCount - 1}
          >
            <ChevronRight size={15} />
          </button>
        </div>
      </div>

      {error && <div className="po-error"><AlertTriangle size={16} /> {error}</div>}

      <div className="ref-card">
        <div className="ref-table-wrap">
          <table className="ref-table po-table po-list-table">
            <thead>
              <tr>
                <th>Invoice #</th>
                <th>Vendor</th>
                <th>Date</th>
                <th className="ref-num">Total</th>
                <th className="ref-num">Items</th>
                <th>Parsed</th>
                <th>Status</th>
                <th>Log</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={9} className="po-table-note"><Loader size={16} className="po-spin" /> Loading your documents…</td></tr>
              )}

              {!loading && list.length === 0 && (
                <tr>
                  <td colSpan={9} className="po-table-note">
                    {debouncedQ || statusFilter
                      ? 'No documents match that search.'
                      : 'No documents yet. Use Upload to add your first invoice.'}
                  </td>
                </tr>
              )}

              {!loading && list.map((d) => {
                // A document still being read has no invoice number, vendor or
                // total yet, because nothing has been extracted. Showing the
                // zeros the row literally holds would read as a $0.00 invoice
                // from an unnamed vendor.
                const pending = d.status === 'parsing';
                return (
                  <tr key={d.id} className="po-row">
                    <td className="ref-name" title={d.fileName}>
                      {/* The View button is the ONLY way in. The whole row used
                          to carry the same onClick, which made every Delete and
                          Log press a race against navigation and meant a
                          mis-aimed click anywhere in a nine-column row took you
                          off the page. Each action in this row is now its own
                          target, and this is the one that opens the document. */}
                      <button
                        type="button"
                        className="po-invoice-btn"
                        onClick={(e) => { e.stopPropagation(); setOpenId(d.id); }}
                        disabled={pending}
                      >
                        <Eye size={13} />
                        {pending ? '(pending)' : (d.invoiceNo || d.poNumber || 'No invoice no.')}
                      </button>
                      {!pending && <span className="po-doctype">{d.docType === 'purchase_order' ? 'PO' : 'Invoice'}</span>}
                      {/* The file name is the row's identity only when nothing
                          was extracted - a document the parser could not read
                          has no invoice number to show. It belongs UNDER the
                          column, not in it: a column headed "Invoice #" that
                          prints "KRAMER.pdf" is not truncated or missing, it is
                          answering a different question. */}
                      {!pending && !d.invoiceNo && !d.poNumber && d.fileName && (
                        <span className="po-filename" title={d.fileName}>{d.fileName}</span>
                      )}
                    </td>
                    <td title={d.vendorName || ''}>{pending ? <span className="po-muted">—</span> : (d.vendorName || 'n/a')}</td>
                    <td>{pending ? <span className="po-muted">—</span> : shortDate(d.invoiceDate || d.createdAt)}</td>
                    <td className="ref-num">{pending ? <span className="po-muted">—</span> : money(d.invoiceTotal)}</td>
                    <td className="ref-num">{pending ? <span className="po-muted">—</span> : (d.itemCount ?? 0)}</td>
                    <td><StatusChip status={d.status} /></td>
                    <td><MappingChip doc={d} /></td>
                    <td>
                      <button
                        type="button"
                        className="po-log-btn"
                        onClick={(e) => { e.stopPropagation(); setLogId(d.id); }}
                        aria-label={`Parser log for ${d.invoiceNo || d.fileName || 'document'}`}
                      >
                        <ScrollText size={13} /> Log
                      </button>
                    </td>
                    <td className="po-row-actions">
                      <button
                        type="button"
                        className="po-icon-btn"
                        aria-label={`Delete ${d.invoiceNo || d.fileName || 'document'}`}
                        onClick={(e) => { e.stopPropagation(); askRemove(d); }}
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

      {logId && <ParserLogModal id={logId} base={base} headers={headers} onClose={() => setLogId(null)} />}

      {uploadOpen && (
        <UploadDialog
          fileRef={fileRef}
          dragging={dragging}
          setDragging={setDragging}
          uploading={uploading}
          queue={queue}
          maxFiles={MAX_FILES}
          onFiles={doUpload}
          onDrop={onDrop}
          onClose={() => { setUploadOpen(false); if (!uploading) setQueue([]); loadList({ quiet: true }); }}
        />
      )}
    </div>
  );
}

/* The upload dialog. Closing it while files are still being read does NOT stop
   them: each document already exists as a row in the table, marked as being
   read, and the list polls until it settles. The close button therefore says so
   rather than implying a cancel it does not perform. */
function UploadDialog({ fileRef, dragging, setDragging, uploading, queue, maxFiles, onFiles, onDrop, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const STATE_LABEL = {
    waiting: 'Waiting',
    reading: 'Uploading…',
    queued: 'Added · reading',
    done: 'Read',
    duplicate: 'Already on your list',
    failed: 'Failed',
  };

  return (
    <div className="po-modal-overlay" role="dialog" aria-modal="true" aria-label="Upload invoices" onMouseDown={onClose}>
      <div className="po-modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="po-modal-head">
          <div>
            <h2 className="po-modal-title">Upload invoices</h2>
            <p className="po-modal-sub">
              PDF, JPG or PNG. Up to {maxFiles} files, 20MB each. Each file becomes its own document.
            </p>
          </div>
          <button type="button" className="po-icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>

        <div
          className={`po-drop ${dragging ? 'is-dragging' : ''} ${uploading ? 'is-busy' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => !uploading && fileRef.current && fileRef.current.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileRef.current?.click(); }}
        >
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="application/pdf,image/png,image/jpeg,image/webp"
            hidden
            onChange={(e) => onFiles(e.target.files)}
          />
          <Upload size={22} />
          <strong>Drag and drop files here, or click to browse</strong>
        </div>

        {queue.length > 0 && (
          <ul className="po-queue">
            {queue.map((f, i) => (
              <li key={`${f.name}-${i}`} className={`po-queue-row is-${f.state}`}>
                <FileText size={15} />
                <div className="po-queue-body">
                  <span className="po-queue-name">{f.name}</span>
                  <span className="po-queue-meta">
                    {(f.size / 1024).toFixed(1)} KB
                    {f.error ? ` · ${f.error}` : ''}
                  </span>
                </div>
                <span className="po-queue-chip">
                  {f.state === 'reading' && <Loader size={12} className="po-spin" />}
                  {STATE_LABEL[f.state]}
                </span>
              </li>
            ))}
          </ul>
        )}

        {uploading && (
          <p className="po-modal-note">
            You can close this. Each document is already in the table and will finish reading on its own.
          </p>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   PARSER LOG
   ═══════════════════════════════════════════════════════════════════════════

   Two things in one panel, because they answer one question together.

   The SUMMARY is the outcome: did it read, with what, how sure was it, and what
   did it note. The ACTIVITY is the history: who uploaded it, when the parse
   finished, and which lines a person has corrected since.

   Neither is enough on its own. A confidence of 64% on an untouched document is
   a parse worth checking; the same 64% on one whose lines have all been
   corrected by hand has already been dealt with. Only the trail beside the
   score tells them apart. */

const EVENT_LABEL = {
  uploaded: 'UPLOADED',
  parsed: 'PARSED',
  parse_failed: 'PARSE FAILED',
  reparsed: 'RE-PARSED',
  'items.edited': 'ITEMS.EDITED',
  'items.mapped': 'ITEMS.MAPPED',
  'items.unmapped': 'ITEMS.UNMAPPED',
};

const PARSE_LABEL = { parsed: 'Success', failed: 'Failed', parsing: 'Still reading' };

const stamp = (d) => (d
  ? new Date(d).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })
  : '—');

function ParserLogModal({ id, base, headers, onClose }) {
  const [log, setLog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`${base}/${id}/log`, { headers: headers() });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || 'Could not load the log.');
        if (alive) { setLog(body); setError(''); }
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

  return (
    <div className="po-modal-overlay" role="dialog" aria-modal="true" aria-label="Parser log" onMouseDown={onClose}>
      <div className="po-modal po-modal-log" onMouseDown={(e) => e.stopPropagation()}>
        <header className="po-modal-head">
          <div>
            <h2 className="po-modal-title">Parser log</h2>
            <p className="po-modal-sub">Parsing result and activity history for this document.</p>
          </div>
          <button type="button" className="po-icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>

        <div className="po-log-body">
          {loading && <p className="po-table-note"><Loader size={16} className="po-spin" /> Loading the log…</p>}
          {!loading && error && <div className="po-error"><AlertTriangle size={16} /> {error}</div>}

          {!loading && log && (
            <>
              <dl className="po-log-summary">
                <div><dt>Parsed status</dt><dd>{PARSE_LABEL[log.status] || log.status}</dd></div>
                <div><dt>Method</dt><dd>{log.method || '—'}</dd></div>
                <div>
                  <dt>Confidence</dt>
                  {/* The stored value is a share of lines, 0-1. Shown as a
                      percentage because that is how it was described to
                      everyone who asked what it means. */}
                  <dd>{log.confidence == null ? '—' : `${(log.confidence * 100).toFixed(1)}%`}</dd>
                </div>
                <div><dt>Updated</dt><dd>{stamp(log.updatedAt)}</dd></div>
              </dl>

              {log.parseError && (
                <div className="po-log-section">
                  <h3 className="po-log-head">Error</h3>
                  <p className="po-log-notes">{log.parseError}</p>
                </div>
              )}

              {log.notes && (
                <div className="po-log-section">
                  <h3 className="po-log-head">Notes</h3>
                  <p className="po-log-notes">{log.notes}</p>
                </div>
              )}

              <div className="po-log-section">
                <h3 className="po-log-head">Activity</h3>
                {log.events.length === 0 ? (
                  <p className="po-log-empty">Nothing has happened to this document yet.</p>
                ) : (
                  <ul className="po-log-events">
                    {log.events.map((e, i) => (
                      <li key={i} className="po-log-event">
                        <div className="po-log-event-top">
                          <span className="po-log-tag">{EVENT_LABEL[e.event] || e.event.toUpperCase()}</span>
                          {/* No actor means the system did it - a parse
                              finishing is not a person's action. */}
                          <span className="po-log-actor">{e.actor || 'system'}</span>
                          <span className="po-log-when">{stamp(e.at)}</span>
                        </div>
                        {e.payload && Object.keys(e.payload).length > 0 && (
                          <pre className="po-log-payload">{JSON.stringify(e.payload, null, 2)}</pre>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* Mapping progress, from counts the list query returns. This is BottleAI's own
   notion of "ready" - how many lines are matched to a POS SKU - not a push
   state, which this product does not have. */
function MappingChip({ doc }) {
  if (doc.status !== 'parsed') return <span className="po-muted">—</span>;
  const items = Number(doc.itemCount || 0);
  const mapped = Number(doc.mappedCount || 0);
  if (items === 0) return <span className="po-muted">—</span>;
  if (mapped >= items) return <span className="po-chip po-chip-ok"><Check size={12} /> Mapped</span>;
  if (mapped === 0) return <span className="po-chip po-chip-warn">Mapping required</span>;
  return <span className="po-chip po-chip-warn">{mapped}/{items} mapped</span>;
}

function StatusChip({ status }) {
  if (status === 'parsed') return <span className="po-chip po-chip-ok"><Check size={12} /> Read</span>;
  if (status === 'failed') return <span className="po-chip po-chip-bad"><X size={12} /> Could not read</span>;
  return <span className="po-chip po-chip-wait"><Loader size={12} className="po-spin" /> Reading</span>;
}

/* ═══════════════════════════════════════════════════════════════════════════
   DETAIL
   ═══════════════════════════════════════════════════════════════════════════ */

/* One correctable value. Click it, type, Enter or blur to save, Escape to
   abandon. The numbers a model read off a scan are exactly the ones a person
   needs to be able to fix, and the PATCH endpoint for it has existed since the
   first build with nothing calling it. */
function EditableCell({ item, field, value, align, format, badge, onSave, editing, setEditing, bare }) {
  const isEditing = editing && editing.id === item.id && editing.field === field;
  const [draft, setDraft] = useState('');

  useEffect(() => { if (isEditing) setDraft(value == null ? '' : String(value)); }, [isEditing, value]);

  // `bare` returns the control WITHOUT its <td>. The detail table builds its own
  // cells now - a product cell carries the name, the code, the mapped chip and
  // the buttons - and a component that insists on owning the cell cannot be put
  // inside one. The wrapped form is kept for callers that still want a cell.
  const wrap = (inner, cls) => (bare
    ? inner
    : <td className={cls}>{inner}{!isEditing && badge}</td>);

  if (!isEditing) {
    return wrap(
      <>
        <button
          type="button"
          className="po-cell-btn"
          onClick={() => setEditing({ id: item.id, field })}
          title="Click to correct"
        >
          {format ? format(value) : (value == null || value === '' ? '-' : value)}
          <Pencil size={11} className="po-cell-pencil" />
        </button>
        {bare && badge}
      </>,
      align === 'num' ? 'ref-num po-editable' : 'po-editable',
    );
  }
  return wrap(
    <input
      className="po-cell-input"
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onSave(item, field, draft.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); onSave(item, field, draft.trim()); }
        if (e.key === 'Escape') { e.preventDefault(); setEditing(null); }
      }}
    />,
    align === 'num' ? 'ref-num' : '',
  );
}

function DetailView({ detail, pending, base, authToken, busy, error, onBack, onMutate, onDelete, onRefresh }) {
  const dialog = useDialog();
  const [viewing, setViewing] = useState(false); // the in-app document viewer
  const [tab, setTab] = useState('items');       // 'items' | 'source'
  // Editing is off until asked for. Every number here is correctable, but
  // leaving the whole table click-to-edit meant a stray click started an edit.
  const [editMode, setEditMode] = useState(false);
  const [editing, setEditing] = useState(null);  // { id, field } - one cell at a time
  const [reparsing, setReparsing] = useState(false);
  const [picker, setPicker] = useState(null);   // { item } - link to existing
  const [creator, setCreator] = useState(null); // { item } - add to inventory

  // The file endpoints are GETs behind the JWT, so they cannot be a plain
  // <a href>. Fetching to a blob keeps the Authorization header and still
  // gives the browser a real file to open or save.
  // Fetching to a blob is not optional: the endpoint is behind the JWT, so it
  // cannot be a plain <a href> or <img src>.
  const fetchOriginal = useCallback(async (download) => {
    const res = await fetch(`${base}/${detail.id}/file${download ? '?download=1' : ''}`, {
      headers: { Authorization: `Bearer ${authToken}`, 'ngrok-skip-browser-warning': 'true' },
    });
    if (!res.ok) throw new Error('The original file could not be opened.');
    return res.blob();
  }, [base, detail.id, authToken]);

  const openFile = async (download) => {
    // Viewing now happens IN the app. window.open() from inside an async fetch
    // is no longer a user gesture, so popup blockers ate it and the button
    // looked dead; and a blob: tab has no filename and no way back to the
    // parsed lines you opened it to check.
    if (!download) { setViewing(true); return; }
    try {
      const blob = await fetchOriginal(true);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = detail.fileName || 'document';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      // Was window.alert(e.message): a raw exception string, in the OS's own
      // chrome, with our URL above it. Say what actually failed instead.
      dialog.alert({
        title: 'Could not open that document',
        message: `The file could not be fetched from the server. ${e.message || ''}`.trim(),
        tone: 'danger',
      });
    }
  };

  const reparse = async () => {
    if (reparsing) return;
    setReparsing(true);
    try {
      const res = await fetch(`${base}/${detail.id}/reparse`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}`, 'ngrok-skip-browser-warning': 'true' },
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      onRefresh();
      const r = body.reparse || {};
      await dialog.alert({
        title: r.itemsFound ? 'Parsed again' : 'Still no lines found',
        message: r.itemsFound
          ? `Found ${r.itemsFound} line${r.itemsFound === 1 ? '' : 's'}.`
            + (r.linksCarried ? ` ${r.linksCarried} of your links carried across.` : '')
            + (r.linksLost ? ` ${r.linksLost} could not be matched to a line and will need doing again.` : '')
          : 'The document was read again and still produced no line items. It may be a scan the model cannot read, or not an invoice.',
        confirmLabel: 'Got it',
      });
    } catch (e) {
      await dialog.alert({
        title: 'Could not parse it again',
        message: e.message || 'The re-parse did not complete.',
        tone: 'danger',
      });
    } finally { setReparsing(false); }
  };

  // One cell at a time, saved on blur or Enter. PATCH /:id/items/:itemId has
  // existed since the first build and nothing called it - the numbers a model
  // read off a scan are exactly the numbers a person needs to be able to fix.
  const saveCell = async (item, field, raw) => {
    const before = item[field];
    const value = raw === '' ? null : raw;
    if (String(before ?? '') === String(value ?? '')) { setEditing(null); return; }
    try {
      const res = await fetch(`${base}/${detail.id}/items/${item.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
          'ngrok-skip-browser-warning': 'true',
        },
        body: JSON.stringify({ [field]: value }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || `HTTP ${res.status}`);
      }
      onRefresh();
    } catch (e) {
      await dialog.alert({
        title: 'That change was not saved',
        message: e.message || 'The line could not be updated.',
        tone: 'danger',
      });
    } finally { setEditing(null); }
  };

  const downloadCsv = async () => {
    const res = await fetch(`${base}/${detail.id}/csv`, {
      headers: { Authorization: `Bearer ${authToken}`, 'ngrok-skip-browser-warning': 'true' },
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${detail.invoiceNo || detail.id}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const unmatched = detail.unmatchedCount || 0;

  return (
    <>
      <button type="button" className="po-back po-back-top" onClick={onBack}>
        <ArrowLeft size={14} /> Back to invoices
      </button>

      <header className="po-dhead">
        <div className="po-dhead-titles">
          <h1 className="po-dtitle">
            {detail.docType === 'purchase_order' ? 'Purchase order' : 'Invoice'}
            {detail.invoiceNo ? ` #${detail.invoiceNo}` : ''}
          </h1>
          <p className="po-dsub">
            {detail.vendorName || 'Vendor not stated'}
            {detail.invoiceDate ? ` \u00b7 ${shortDate(detail.invoiceDate)}` : ''}
          </p>
        </div>
        <div className="po-dhead-actions">
          <button type="button" className="po-btn" onClick={() => openFile(true)}><Download size={14} /> Original</button>
          <button type="button" className="po-btn" onClick={downloadCsv}><Download size={14} /> CSV</button>
          <button type="button" className="po-btn" onClick={reparse} disabled={reparsing || busy} title="Read the stored document again - keeps the links you have already made">
            <RotateCcw size={14} /> {reparsing ? 'Parsing\u2026' : 'Parse again'}
          </button>
          <button type="button" className="po-btn" onClick={onRefresh} disabled={busy}><RefreshCw size={14} /> Refresh</button>
          <button type="button" className="po-btn po-btn-danger" onClick={onDelete}><Trash2 size={14} /> Delete</button>
        </div>
      </header>

      {error && <div className="po-error"><AlertTriangle size={16} /> {error}</div>}

      {detail.status === 'failed' && (
        <div className="po-error">
          <AlertTriangle size={16} />
          <div>
            <strong>Botella could not read this document.</strong>
            <div>{detail.parseError || 'No reason was recorded.'}</div>
            <div className="po-error-hint">The original file is still here. You can view or download it above.</div>
          </div>
        </div>
      )}

      {detail.status === 'parsed' && (
        <>
          {/* Delivery appears only when there is one. A permanent $0.00
              delivery tile would spend a fifth of the row saying nothing. */}
          <div className="po-stats">
            <Stat label="Subtotal" v={detail.subtotal} />
            <Stat label="Tax" v={detail.taxTotal} />
            <Stat label="Discount" v={detail.discountTotal} />
            {detail.deliveryTotal ? <Stat label="Delivery" v={detail.deliveryTotal} /> : null}
            <Stat label="Total" v={detail.invoiceTotal} strong />
          </div>

          <div className="po-tabs">
            <button
              type="button"
              className={`po-tab ${tab === 'items' ? 'is-on' : ''}`}
              onClick={() => setTab('items')}
            >
              Line items ({detail.itemCount != null ? detail.itemCount : (detail.items || []).length})
            </button>
            <button
              type="button"
              className={`po-tab ${tab === 'source' ? 'is-on' : ''}`}
              onClick={() => { setTab('source'); setViewing(true); }}
            >
              Source {(detail.fileMime || '').includes('pdf') ? 'PDF' : 'file'}
            </button>
          </div>

          <div className="po-detail-grid">
            <div className="po-detail-main">
              {!pending && unmatched > 0 && (
                <div className="po-warn">
                  <AlertTriangle size={16} />
                  <div>
                    <strong>{unmatched} of {detail.itemCount} lines are not in your inventory.</strong>
                    <div>Link each one to a product you already carry, or add it to your inventory. Until then Botella cannot count these against your stock.</div>
                  </div>
                </div>
              )}

              <div className="ref-card">
                <div className="po-card-head">
                  <div>
                    <h2 className="po-card-title">Line items</h2>
                    <p className="po-card-sub">
                      {detail.itemCount != null ? detail.itemCount : (detail.items || []).length} item
                      {(detail.itemCount != null ? detail.itemCount : (detail.items || []).length) === 1 ? '' : 's'} on this document.
                      {' '}Unmapped lines carry Link and Add-to-inventory buttons. A mapped line shows its
                      cost against your POS: <span className="po-up">red</span> means the document costs{' '}
                      <em>more</em> than the POS holds, <span className="po-down">green</span> means less.
                    </p>
                  </div>
                  {/* A toggle, not a separate page. Every number here is
                      correctable, but leaving them all click-to-edit meant a
                      stray click on a row began an edit nobody asked for. */}
                  <button
                    type="button"
                    className={`po-btn ${editMode ? 'po-btn-primary' : ''}`}
                    disabled={pending}
                    onClick={() => { setEditMode((v) => !v); setEditing(null); }}
                  >
                    <Pencil size={14} /> {editMode ? 'Done' : 'Edit'}
                  </button>
                </div>

                {pending ? (
                  // Rows, not a spinner: the table is about to be here, and a
                  // skeleton the same shape stops the page jumping when it is.
                  <div className="po-skel-rows">
                    {Array.from({ length: Math.min(detail.itemCount || 5, 8) }).map((_, i) => (
                      <div key={i} className="po-skel-row" />
                    ))}
                  </div>
                ) : (
                <div className="ref-table-wrap">
                  <table className="ref-table po-table po-items-table">
                    <thead>
                      <tr>
                        <th className="po-th-line">#</th>
                        <th>Product</th>
                        <th>Pack</th>
                        <th>Size</th>
                        <th className="ref-num">Pk/Cs</th>
                        <th className="ref-num">Qty</th>
                        <th className="ref-num">Cost</th>
                        <th className="ref-num">Tax</th>
                        <th className="ref-num">Ext</th>
                        <th aria-label="Actions" />
                      </tr>
                    </thead>
                    <tbody>
                      {detail.items.map((it) => (
                        <tr key={it.id} className={it.match.matched ? '' : 'po-row-unmatched'}>
                          <td className="po-td-line">{it.lineNo}</td>

                          <td className="po-td-product">
                            {/* NOT editable, even in edit mode. Every other
                                editable field here corrects a number the parser
                                misread - a quantity, a cost. The product name is
                                different: it is the text the document actually
                                carries, it is what the mapping matched on, and
                                it is what a reader compares against the source
                                PDF. Rewriting it silently detaches the line from
                                the invoice it came from. A wrong name is fixed
                                by re-parsing or by mapping the line to the right
                                product, both of which are already on this row. */}
                            <span className="po-prod-name">{it.productName || 'n/a'}</span>
                            {it.productNo && (
                              <span className="po-prod-no" title={it.upc ? `UPC ${it.upc}` : ''}>{it.productNo}</span>
                            )}

                            {it.match.matched ? (
                              <>
                                <span className="po-chip po-chip-ok po-prod-chip" title={`Matched on ${it.match.via}`}>
                                  <Check size={11} /> Mapped
                                </span>
                                <span className="po-prod-map">&rarr; {it.match.productName}</span>
                              </>
                            ) : (
                              <>
                                <span className="po-chip po-chip-warn po-prod-chip">Not mapped</span>
                                {(it.suggestions || []).length > 0 && (
                                  <div className="po-suggests">
                                    {it.suggestions.map((sg) => (
                                      <button
                                        key={sg.sku}
                                        type="button"
                                        className={`po-suggest ${sg.confident ? 'is-confident' : ''}`}
                                        title={`${sg.productName} - ${Math.round(sg.score * 100)}% name match${sg.stockQty != null ? `, ${sg.stockQty} on hand` : ''}`}
                                        onClick={() => onMutate(`/${detail.id}/items/${it.id}/link`, {
                                          method: 'POST', body: JSON.stringify({ sku: sg.sku }),
                                        })}
                                      >
                                        <Sparkles size={11} /> {sg.productName}
                                      </button>
                                    ))}
                                  </div>
                                )}
                                <span className="po-fix">
                                  <button type="button" className="po-mini" onClick={() => setPicker({ item: it })}>
                                    <Search size={12} /> Link
                                  </button>
                                  <button type="button" className="po-mini po-mini-primary" onClick={() => setCreator({ item: it })}>
                                    <Plus size={12} /> Add to inventory
                                  </button>
                                </span>
                              </>
                            )}
                          </td>

                          <td className="po-td-dim">{[it.pack, it.uom].filter(Boolean).join(' ') || '\u2014'}</td>
                          <td className="po-td-dim">{it.productVolume || '\u2014'}</td>
                          <td className="ref-num po-td-dim">{packsPerCase(it.pack)}</td>

                          <td className="ref-num">
                            {editMode
                              ? <EditableCell bare item={it} field="quantity" value={it.quantity} align="num" format={qty} onSave={saveCell} editing={editing} setEditing={setEditing} />
                              : qty(it.quantity)}
                          </td>

                          <td className="ref-num po-td-cost">
                            {editMode
                              ? <EditableCell bare item={it} field="cost" value={it.cost} align="num" format={money} onSave={saveCell} editing={editing} setEditing={setEditing} />
                              : <CostAgainstPos item={it} />}
                          </td>

                          <td className="ref-num">{it.taxAmt == null ? '\u2014' : money(it.taxAmt)}</td>

                          <td className="ref-num">
                            {editMode
                              ? <EditableCell bare item={it} field="extPrice" value={it.extPrice} align="num" format={money} onSave={saveCell} editing={editing} setEditing={setEditing} />
                              : money(it.extPrice)}
                          </td>

                          <td className="po-row-actions">
                            {it.match.matched && (
                              <button
                                type="button"
                                className="po-icon-btn"
                                aria-label="Unlink this line from your inventory"
                                title="Unlink from inventory"
                                onClick={() => onMutate(`/${detail.id}/items/${it.id}/link`, { method: 'DELETE' })}
                              >
                                <X size={15} />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                )}
              </div>
            </div>

            <aside className="po-side">
              <div className="ref-card po-side-card">
                <h3 className="po-side-title">Vendor</h3>
                <dl className="po-side-list">
                  <div><dt>Vendor</dt><dd>{detail.vendorName || '\u2014'}</dd></div>
                  <div><dt>Account #</dt><dd>{detail.accountNo || '\u2014'}</dd></div>
                  <div><dt>PO #</dt><dd>{detail.poNumber || '\u2014'}</dd></div>
                  <div><dt>Document</dt><dd className="po-side-file" title={detail.fileName}>{detail.fileName || '\u2014'}</dd></div>
                </dl>
              </div>

              <div className="ref-card po-side-card">
                <h3 className="po-side-title">Dates</h3>
                <dl className="po-side-list">
                  <div><dt>Invoice date</dt><dd>{detail.invoiceDate ? shortDate(detail.invoiceDate) : '\u2014'}</dd></div>
                  <div><dt>Due date</dt><dd>{detail.dueDate ? shortDate(detail.dueDate) : '\u2014'}</dd></div>
                  <div><dt>PO date</dt><dd>{detail.poDate ? shortDate(detail.poDate) : '\u2014'}</dd></div>
                  <div><dt>Uploaded</dt><dd>{detail.createdAt ? shortDate(detail.createdAt) : '\u2014'}</dd></div>
                </dl>
              </div>

              {detail.notes && (
                <div className="ref-card po-side-card">
                  <h3 className="po-side-title">Notes</h3>
                  <p className="po-side-notes">{detail.notes}</p>
                </div>
              )}
            </aside>
          </div>
        </>
      )}

      <DocumentViewer
        open={viewing}
        title={detail.invoiceNo ? `Invoice ${detail.invoiceNo}` : (detail.fileName || 'Document')}
        fileName={detail.fileName}
        mimeType={detail.fileMime || detail.mimeType}
        fetchBlob={() => fetchOriginal(false)}
        onClose={() => setViewing(false)}
        onDownload={() => openFile(true)}
      />

      {picker && (
        <LinkDialog
          item={picker.item}
          base={base}
          authToken={authToken}
          onClose={() => setPicker(null)}
          onPick={async (sku) => {
            await onMutate(`/${detail.id}/items/${picker.item.id}/link`, {
              method: 'POST', body: JSON.stringify({ sku }),
            });
            setPicker(null);
          }}
        />
      )}

      {creator && (
        <CreateDialog
          item={creator.item}
          onClose={() => setCreator(null)}
          onCreate={async (payload) => {
            const ok = await onMutate(`/${detail.id}/items/${creator.item.id}/create-product`, {
              method: 'POST', body: JSON.stringify(payload),
            });
            if (ok) setCreator(null);
          }}
        />
      )}
    </>
  );
}

/**
 * The invoice cost, against what the POS holds for the product it is mapped to.
 *
 * Only shown for a mapped line with a POS cost: an unmapped line has nothing to
 * compare against, and a mapped one whose POS cost is null would otherwise be
 * coloured red against a zero it does not have. Red means this delivery cost
 * MORE than the POS expects - the direction that costs money.
 */
function CostAgainstPos({ item }) {
  const posCost = item.match && item.match.matched ? item.match.cost : null;
  if (posCost == null || item.cost == null) return <>{money(item.cost)}</>;
  const diff = Number(item.cost) - Number(posCost);
  if (Math.abs(diff) < 0.005) return <>{money(item.cost)}</>;
  return (
    <span className={diff > 0 ? 'po-up' : 'po-down'}>
      {diff > 0 ? '\u2197' : '\u2198'} {money(item.cost)}
      <span className="po-pos-cost">POS: {money(posCost)}</span>
    </span>
  );
}

const Stat = ({ label, v, strong }) => (
  <div className={`po-stat ${strong ? 'is-strong' : ''}`}>
    <span className="po-stat-label">{label}</span>
    <span className="po-stat-value">{v == null ? '\u2014' : money(v)}</span>
  </div>
);

/* ── Link to an existing product ─────────────────────────────────────────── */

function LinkDialog({ item, base, authToken, onClose, onPick }) {
  // Prefill from the line: the owner is looking for THIS product, so make the
  // first search the one they would have typed.
  const [q, setQ] = useState(item.productName || '');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return undefined; }
    let alive = true;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`${base}/products/search?q=${encodeURIComponent(q)}`, {
          headers: { Authorization: `Bearer ${authToken}`, 'ngrok-skip-browser-warning': 'true' },
        });
        const body = await res.json();
        if (alive) setResults(body.data || []);
      } catch { if (alive) setResults([]); }
      if (alive) setSearching(false);
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [q, base, authToken]);

  return (
    <Modal title="Link to a product you already carry" onClose={onClose}>
      <p className="po-modal-sub">On the document: <strong>{item.productName || 'n/a'}</strong></p>
      <div className="po-search">
        <Search size={14} />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your inventory by name, sku or UPC" />
      </div>
      <div className="po-results">
        {searching && <div className="po-results-note">Searching…</div>}
        {!searching && q.trim().length >= 2 && results.length === 0 && (
          <div className="po-results-note">Nothing in your inventory matches. Close this and use "Add to inventory" instead.</div>
        )}
        {results.map((p) => (
          <button type="button" key={p.sku} className="po-result" onClick={() => onPick(p.sku)}>
            <span className="po-result-name">{p.productName}</span>
            <span className="po-result-meta">{p.sku}{p.upc ? ` · ${p.upc}` : ''} · {p.onHand} on hand</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

/* ── Add a product that is not in inventory yet ──────────────────────────── */

function CreateDialog({ item, onClose, onCreate }) {
  // Everything prefills from the invoice line. The sku defaults to the vendor's
  // own code because that is usually what the owner would have typed, but it is
  // editable: it becomes this product's identity everywhere else in Botella.
  const [sku, setSku] = useState(item.productNo || '');
  const [name, setName] = useState(item.productName || '');
  const [upc, setUpc] = useState(item.upc || '');
  const [cost, setCost] = useState(item.cost != null ? String(item.cost) : '');
  const [price, setPrice] = useState('');
  const [category, setCategory] = useState('');
  const [stockQty, setStockQty] = useState(item.quantity != null ? String(item.quantity) : '0');

  const canSubmit = sku.trim() && name.trim();

  return (
    <Modal title="Add this product to your inventory" onClose={onClose}>
      <p className="po-modal-sub">
        Creates the product in your catalogue and links this line to it. Everything is prefilled from the document.
      </p>
      <div className="po-form">
        <Field label="SKU" required hint="How this product is identified everywhere else in Botella.">
          <input value={sku} onChange={(e) => setSku(e.target.value)} autoFocus />
        </Field>
        <Field label="Product name" required>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="UPC">
          <input value={upc} onChange={(e) => setUpc(e.target.value)} />
        </Field>
        <Field label="Category">
          <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Bourbon" />
        </Field>
        <Field label="Cost" hint="From the document.">
          <input value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" />
        </Field>
        <Field label="Retail price" hint="Leave blank to set later.">
          <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
        </Field>
        <Field label="Opening stock" hint="Defaults to the quantity on this line.">
          <input value={stockQty} onChange={(e) => setStockQty(e.target.value)} inputMode="numeric" />
        </Field>
      </div>
      <div className="po-modal-actions">
        <button type="button" className="ref-btn" onClick={onClose}>Cancel</button>
        <button
          type="button"
          className="po-btn-primary"
          disabled={!canSubmit}
          onClick={() => onCreate({ sku: sku.trim(), productName: name.trim(), upc: upc.trim(), category: category.trim(), cost, price, stockQty })}
        >
          <Plus size={14} /> Add product
        </button>
      </div>
    </Modal>
  );
}

const Field = ({ label, required, hint, children }) => (
  <label className="po-field">
    <span className="po-field-label">{label}{required && <em> required</em>}</span>
    {children}
    {hint && <span className="po-field-hint">{hint}</span>}
  </label>
);

function Modal({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="po-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="po-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="po-modal-head">
          <h3>{title}</h3>
          <button type="button" className="po-modal-x" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="po-modal-body">{children}</div>
      </div>
    </div>
  );
}

export default PurchaseOrdersScreen;
