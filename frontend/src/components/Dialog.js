// Dialog.js
// -----------------------------------------------------------------------------
// The replacement for window.alert / window.confirm.
//
// A browser alert is not a dialog, it is a hostage situation: it freezes the
// whole tab, it is drawn by the OS in the OS's own typeface with the page's
// URL stamped above it, it cannot be styled or themed, its buttons say "OK" and
// "Cancel" whatever the question was, and on a shared back-office machine it
// looks close enough to a phishing prompt that people click it without reading.
// It also cannot be dismissed with anything but the mouse in some browsers, and
// it is invisible to our own error reporting.
//
// This is the same shape as the sign-out confirmation the app already had, made
// reusable, so every question the product asks looks like the product asking.
//
// Two ways in:
//
//   <Dialog open={...} title="..." onClose={...} onConfirm={...} />   declarative
//   const dialog = useDialog();  await dialog.confirm({...})          imperative
//
// The imperative one exists because the call sites being replaced are inside
// async handlers that branch on the answer - `if (window.confirm(...))`. A hook
// that returns a promise keeps that shape instead of forcing every one of them
// to be turned inside out into component state.
// -----------------------------------------------------------------------------

import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Info, X } from 'lucide-react';
import './Dialog.css';

/* ── The dialog itself ────────────────────────────────────────────────────── */

export function Dialog({
  open,
  title,
  message,
  tone = 'default',          // 'default' | 'danger'
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  showCancel = true,
  onConfirm,
  onClose,
}) {
  const confirmRef = useRef(null);
  const cancelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose && onClose(); }
    };
    document.addEventListener('keydown', onKey);

    // Focus the SAFE option when there is a choice to make, and the only option
    // when there is not. A browser confirm() puts focus on OK; a stray Enter
    // then commits an action the user never read.
    const target = showCancel ? cancelRef.current : confirmRef.current;
    if (target) target.focus();

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, showCancel, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="dlg-scrim"
      onClick={() => onClose && onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="dlg-title"
    >
      <div className={`dlg dlg-${tone}`} onClick={(e) => e.stopPropagation()}>
        <button type="button" className="dlg-x" onClick={() => onClose && onClose()} aria-label="Close">
          <X size={16} />
        </button>
        <div className="dlg-icon">
          {tone === 'danger' ? <AlertTriangle size={20} /> : <Info size={20} />}
        </div>
        <h3 className="dlg-title" id="dlg-title">{title}</h3>
        {message && <p className="dlg-text">{message}</p>}
        <div className="dlg-actions">
          {showCancel && (
            <button type="button" className="dlg-btn dlg-btn-ghost" ref={cancelRef} onClick={() => onClose && onClose()}>
              {cancelLabel}
            </button>
          )}
          <button
            type="button"
            className={`dlg-btn ${tone === 'danger' ? 'dlg-btn-danger' : 'dlg-btn-primary'}`}
            ref={confirmRef}
            onClick={() => (onConfirm ? onConfirm() : onClose && onClose())}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ── The imperative form ──────────────────────────────────────────────────── */

const DialogContext = createContext(null);

/**
 * Mount once, near the root. Everything below can then `await dialog.confirm()`
 * or `dialog.alert()`.
 */
export function DialogProvider({ children }) {
  const [state, setState] = useState(null);
  // The promise's resolve, parked until the user answers. Held in a ref rather
  // than state so answering does not depend on a re-render having happened.
  const resolver = useRef(null);

  const settle = useCallback((value) => {
    setState(null);
    const r = resolver.current;
    resolver.current = null;
    if (r) r(value);
  }, []);

  const api = useMemo(() => ({
    /** Ask a question. Resolves true if confirmed, false if dismissed. */
    confirm(opts) {
      return new Promise((resolve) => {
        resolver.current = resolve;
        setState({ showCancel: true, confirmLabel: 'Confirm', cancelLabel: 'Cancel', ...opts });
      });
    },
    /** Tell them something. Resolves when acknowledged. */
    alert(opts) {
      return new Promise((resolve) => {
        resolver.current = resolve;
        setState({
          showCancel: false,
          confirmLabel: 'OK',
          ...(typeof opts === 'string' ? { title: 'Something went wrong', message: opts } : opts),
        });
      });
    },
  }), []);

  return (
    <DialogContext.Provider value={api}>
      {children}
      <Dialog
        {...(state || {})}
        open={!!state}
        onConfirm={() => settle(true)}
        onClose={() => settle(false)}
      />
    </DialogContext.Provider>
  );
}

/**
 * If no provider is mounted this returns a no-op that resolves false, so a
 * component used outside the tree renders rather than throwing. It never falls
 * back to window.confirm - that is the thing being removed.
 */
export function useDialog() {
  const ctx = useContext(DialogContext);
  return ctx || {
    confirm: () => Promise.resolve(false),
    alert: () => Promise.resolve(false),
  };
}

export default Dialog;
