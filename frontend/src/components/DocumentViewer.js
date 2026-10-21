// DocumentViewer.js
// -----------------------------------------------------------------------------
// The uploaded invoice, shown IN the app rather than thrown at a new tab.
//
// "View original" used to call window.open() on a blob URL. Three problems with
// that, all of which a store owner hits on the first try:
//
//   * Popup blockers eat it. window.open() from inside an async fetch callback
//     is no longer a user gesture as far as the browser is concerned, so the
//     click appears to do nothing at all.
//   * It leaves the app. You lose the parsed lines you were checking the
//     document against, which is the entire reason for opening it.
//   * A blob: tab has no filename, no controls of ours, and no way back.
//
// So it opens here, beside the parse, with the download button in the same
// frame. PDFs render in an <iframe> (every target browser has a built-in PDF
// viewer); images render as an <img> with zoom, because a photographed invoice
// is usually unreadable at fit-to-window.
// -----------------------------------------------------------------------------

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Download, ZoomIn, ZoomOut, Maximize2, Loader, AlertTriangle, ExternalLink } from 'lucide-react';
import './DocumentViewer.css';

// pdfToolbar={false} opens a PDF without the browser viewer's own toolbar
// (#toolbar=0, honoured by Chrome and Edge). That toolbar carries a second
// Download, which saves the file under the blob's random id instead of its
// name; ours, in the header, is the one to keep. Its zoom, pages and print
// go with it: Ctrl+scroll still zooms, and "Open in a new tab" still gives
// the browser's full viewer.
export default function DocumentViewer({ open, title, fileName, mimeType, fetchBlob, onClose, onDownload, pdfToolbar = true }) {
  const [url, setUrl] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [zoom, setZoom] = useState(1);
  const urlRef = useRef(null);

  const isPdf = /pdf/i.test(mimeType || '') || /\.pdf$/i.test(fileName || '');
  const isImage = /^image\//i.test(mimeType || '') || /\.(png|jpe?g|webp|gif)$/i.test(fileName || '');

  // Fetch once per open. The endpoint is behind the JWT so it cannot be a plain
  // <img src>; a blob URL is the only way to hand the browser real bytes while
  // still sending an Authorization header.
  useEffect(() => {
    let cancelled = false;
    if (!open) return undefined;
    setError(null); setLoading(true); setZoom(1);
    (async () => {
      try {
        const blob = await fetchBlob();
        if (cancelled) return;
        const u = URL.createObjectURL(blob);
        urlRef.current = u;
        setUrl(u);
      } catch (e) {
        if (!cancelled) setError(e.message || 'The file could not be loaded.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      // Revoke on close, not on a timer: a blob URL held open is a copy of the
      // whole document sitting in memory.
      if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
      setUrl(null);
    };
  }, [open, fetchBlob]);

  const close = useCallback(() => { onClose && onClose(); }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      if (isImage && (e.key === '+' || e.key === '=')) setZoom((z) => Math.min(5, z + 0.25));
      if (isImage && e.key === '-') setZoom((z) => Math.max(0.5, z - 0.25));
      if (isImage && e.key === '0') setZoom(1);
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, close, isImage]);

  if (!open) return null;

  return createPortal(
    <div className="dv-scrim" onClick={close} role="dialog" aria-modal="true" aria-label={title || 'Document'}>
      <div className="dv" onClick={(e) => e.stopPropagation()}>
        <header className="dv-head">
          <div className="dv-titles">
            <span className="dv-title">{title || fileName || 'Document'}</span>
            {fileName && title !== fileName && <span className="dv-file">{fileName}</span>}
          </div>
          <div className="dv-actions">
            {isImage && (
              <>
                <button type="button" className="dv-btn" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} title="Zoom out (-)" aria-label="Zoom out">
                  <ZoomOut size={15} />
                </button>
                <span className="dv-zoom">{Math.round(zoom * 100)}%</span>
                <button type="button" className="dv-btn" onClick={() => setZoom((z) => Math.min(5, z + 0.25))} title="Zoom in (+)" aria-label="Zoom in">
                  <ZoomIn size={15} />
                </button>
                <button type="button" className="dv-btn" onClick={() => setZoom(1)} title="Fit to window (0)" aria-label="Fit to window">
                  <Maximize2 size={15} />
                </button>
                <span className="dv-sep" />
              </>
            )}
            {url && (
              /* A real tab, for anyone who wants the browser's own PDF tools.
                 This one IS a user gesture, so it survives popup blockers. */
              <a className="dv-btn" href={url} target="_blank" rel="noopener noreferrer" title="Open in a new tab">
                <ExternalLink size={15} />
              </a>
            )}
            <button type="button" className="dv-btn dv-btn-primary" onClick={() => onDownload && onDownload()}>
              <Download size={15} /> Download
            </button>
            <button type="button" className="dv-btn" onClick={close} aria-label="Close">
              <X size={16} />
            </button>
          </div>
        </header>

        <div className={`dv-body ${isImage ? 'is-image' : ''}`}>
          {loading && <div className="dv-state"><Loader size={22} className="dv-spin" /><span>Opening the document…</span></div>}
          {error && (
            <div className="dv-state dv-state-error">
              <AlertTriangle size={20} />
              <span>{error}</span>
              <span className="dv-state-hint">The parsed lines are still available behind this window.</span>
            </div>
          )}
          {!loading && !error && url && isPdf && (
            <iframe className="dv-frame" src={pdfToolbar ? url : `${url}#toolbar=0&navpanes=0`} title={fileName || 'Document'} />
          )}
          {!loading && !error && url && isImage && (
            <div className="dv-imagewrap">
              <img
                className="dv-image"
                src={url}
                alt={fileName || 'Uploaded document'}
                style={{ transform: `scale(${zoom})` }}
              />
            </div>
          )}
          {!loading && !error && url && !isPdf && !isImage && (
            /* Neither a PDF nor an image the browser can paint. Say so, and
               offer the two things that still work, rather than showing an
               empty frame that looks broken. */
            <div className="dv-state">
              <AlertTriangle size={20} />
              <span>This file type cannot be previewed in the browser.</span>
              <span className="dv-state-hint">{mimeType || 'unknown type'} - download it to open in another application.</span>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
