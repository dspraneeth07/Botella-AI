// DemoPopup.js
// -----------------------------------------------------------------------------
// Email-capture popup used by every "Book a Demo" / "Get Started" / "Try
// Botella Now" button on the public site. Posts the email to /api/leads
// (the same endpoint the home page has always used). Shown via the
// useDemoPopup() hook from DemoPopupContext.
//
// Controlled component: takes `isOpen` + `onClose` and renders nothing
// when closed. Body state (email, submitting, submitted, error) lives
// locally and resets every time the popup is opened.
// -----------------------------------------------------------------------------

import React, { useEffect, useState } from 'react';
import './DemoPopup.css';
import { API_ORIGIN as ENV_API_ORIGIN } from '../utils/env';

function DemoPopup({ isOpen, onClose }) {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState('');

  // Reset state every time the popup opens - otherwise a previous
  // submission's success state or error would persist on re-open.
  useEffect(() => {
    if (isOpen) {
      setEmail('');
      setSubmitting(false);
      setSubmitted(false);
      setSubmitError('');
    }
  }, [isOpen]);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  // Prevent body scroll while modal is open
  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [isOpen]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      // Same API surface the home page has always used.
      // Strip trailing /api so we don't end up with /api/api.
      const apiUrl = ENV_API_ORIGIN;
      const base = apiUrl.replace(/\/api\/?$/, '');
      const res = await fetch(`${base}/api/leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setSubmitted(true);
      } else {
        setSubmitError(data.error || 'Something went wrong. Please try again.');
      }
    } catch {
      setSubmitError('Could not connect. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="dp-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="dp-popup" onClick={(e) => e.stopPropagation()}>
        <button
          className="dp-close"
          onClick={onClose}
          aria-label="Close"
          type="button"
        >
          ×
        </button>

        {!submitted ? (
          <>
            <h3>Get Started with Botella</h3>
            <p>
              Enter your email and we'll set up a free 30-minute demo for your store.
              No commitment.
            </p>
            <form onSubmit={handleSubmit} className="dp-form" noValidate>
              <input
                type="email"
                placeholder="you@yourstore.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
                required
                disabled={submitting}
                aria-label="Email address"
              />
              <button type="submit" disabled={submitting || !email.trim()}>
                {submitting ? 'Submitting…' : 'Book a Demo'}
              </button>
              {submitError && <p className="dp-error">{submitError}</p>}
            </form>
            <p className="dp-fineprint">
              We'll never share your email. Reply STOP anytime to opt out of follow-ups.
            </p>
          </>
        ) : (
          <div className="dp-success">
            <span className="dp-check">✓</span>
            <h3>Thanks - you're in.</h3>
            <p>We'll reach out within one business day to schedule your demo.</p>
            <button
              className="dp-success-close"
              onClick={onClose}
              type="button"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default DemoPopup;
