// ContactPage.js
import { errorText } from '../utils/errorText';
// -----------------------------------------------------------------------------
// /contact - dedicated contact page wired to the same POST /api/leads endpoint
// the demo popup uses. Reuses ContentLayout for the shared header/footer.
// -----------------------------------------------------------------------------

import React, { useState } from 'react';
import ContentLayout from '../components/ContentLayout';
import JsonLd, { buildFaqSchema } from '../components/JsonLd';
import useSEO from '../utils/useSEO';
import './ContactPage.css';
import { API_ORIGIN as ENV_API_ORIGIN } from '../utils/env';

// FAQ trimmed to exactly the 2 questions listed in the v3 SEO doc.
const CONTACT_FAQS = [
  {
    q: 'How quickly can I get started?',
    a: 'Most businesses can get started within days.',
  },
  {
    q: 'Does it work with existing systems?',
    a: 'Yes, Botella AI integrates with existing POS and inventory systems.',
  },
];

function ContactPage() {
  useSEO({
    title: 'Contact Botella AI | Book a Demo or Talk to Our Team',
    description:
      "Get in touch with Botella AI. Book a free demo, ask about our AI agent for liquor stores, or reach our support team. We typically reply within one business day.",
    canonical: 'https://botella.ai/contact',
  });

  // Form fields per v2 SEO brief - added `phone` and the business-type
  // dropdown now uses the v2 options (Liquor Store / Multi-Location / etc.)
  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    company: '',
    businessType: 'liquor-store',
    message: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  // Per-field validation errors. Empty string means "no error".
  // Keys match the form state shape so every field has its own slot.
  const [fieldErrors, setFieldErrors] = useState({
    name: '',
    email: '',
    phone: '',
    company: '',
    message: '',
  });

  const onChange = (k) => (e) => {
    const value = e.target.value;
    setForm((f) => ({ ...f, [k]: value }));
    // Live-clear the field's error as soon as the user types - keeps the
    // form feeling responsive instead of yelling at every keystroke.
    if (fieldErrors[k]) {
      setFieldErrors((fe) => ({ ...fe, [k]: '' }));
    }
  };

  // Validate every required field at submit time. Returns an object of
  // { field: errorMessage } for each invalid field - empty object means
  // all good. Centralised so the submit handler stays clean.
  const validate = (f) => {
    const errs = {};

    if (!f.name.trim()) {
      errs.name = 'Please enter your full name.';
    } else if (f.name.trim().length < 2) {
      errs.name = 'Name looks too short.';
    }

    if (!f.email.trim()) {
      errs.email = 'Email is required so we can reply.';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) {
      errs.email = 'That email doesn\'t look valid.';
    }

    if (!f.phone.trim()) {
      errs.phone = 'Please enter a phone number.';
    } else if (f.phone.replace(/\D/g, '').length < 7) {
      // Strip non-digits and require at least 7 - handles international
      // formatting like "+1 (555) 123-4567" gracefully.
      errs.phone = 'Phone number looks too short.';
    }

    if (!f.company.trim()) {
      errs.company = 'Please enter your store or company name.';
    }

    if (!f.message.trim()) {
      errs.message = 'A short message helps us prep for the demo.';
    } else if (f.message.trim().length < 10) {
      errs.message = 'Tell us a bit more (at least 10 characters).';
    }

    return errs;
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;

    // Validate every field first. If anything's missing, surface
    // per-field errors and bail out without hitting the API.
    const errs = validate(form);
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      setError('Please fill in every required field.');
      // Scroll to the first invalid field for usability.
      const firstKey = Object.keys(errs)[0];
      const el = document.getElementById(`cf-${firstKey}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.focus({ preventScroll: true });
      }
      return;
    }

    setSubmitting(true);
    setError('');
    setFieldErrors({ name: '', email: '', phone: '', company: '', message: '' });

    try {
      // Same endpoint the demo popup uses - `/api/leads` accepts an `email`
      // string and an optional `meta` payload. The backend persists + emails
      // the team at info@botella.ai (set via the NOTIFICATION_EMAIL default
      // in backend/routes/leads.js).
      const apiUrl = ENV_API_ORIGIN;
      const base = apiUrl.replace(/\/api\/?$/, '');
      const res = await fetch(`${base}/api/leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: form.email.trim(),
          meta: {
            source: 'contact-page',
            name: form.name.trim(),
            phone: form.phone.trim(),
            company: form.company.trim(),
            businessType: form.businessType,
            message: form.message.trim(),
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setSubmitted(true);
      } else {
        setError(errorText(data.error, 'Something went wrong. Please email us directly.'));
      }
    } catch {
      setError('Could not connect. Please email info@botella.ai directly.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ContentLayout>
      <JsonLd data={buildFaqSchema(CONTACT_FAQS)} />

      <div className="cp-rich">

        {/* ── HERO ─────────────────────────────────────────────────── */}
        {/* Hero copy aligned to v3 SEO doc verbatim: H1 "Contact Botella AI",
            subheading "See how AI can help…", and the body paragraph
            describing the demo. */}
        <section className="cp-hero-split contact-hero">
          <div className="cp-hero-text">
            <div className="cp-tag-pill">Get In Touch</div>
            <h1>Contact <i>Botella AI</i></h1>
            <p className="cp-hero-sub">
              See how AI can help your liquor store make smarter decisions.
            </p>
            <p className="cp-hero-body">
              Book a demo to learn how Botella AI helps automate inventory,
              surface demand patterns, reduce stockouts, and improve margins.
            </p>

            {/* Quick contact options */}
            <div className="contact-options">
              <a href="mailto:info@botella.ai" className="contact-opt">
                <span className="contact-opt-icon">✉️</span>
                <span className="contact-opt-body">
                  <strong>Email</strong>
                  <em>info@botella.ai</em>
                </span>
                <span className="contact-opt-arrow">→</span>
              </a>
              <a href="https://www.linkedin.com/company/botellaai/" target="_blank" rel="noopener noreferrer" className="contact-opt">
                <span className="contact-opt-icon">💼</span>
                <span className="contact-opt-body">
                  <strong>LinkedIn</strong>
                  <em>linkedin.com/company/botellaai</em>
                </span>
                <span className="contact-opt-arrow">→</span>
              </a>
              <a href="#form" className="contact-opt">
                <span className="contact-opt-icon">📝</span>
                <span className="contact-opt-body">
                  <strong>Send us a message</strong>
                  <em>Fill the form on this page</em>
                </span>
                <span className="contact-opt-arrow">→</span>
              </a>
            </div>
          </div>

          {/* Contact form - embedded in hero on desktop */}
          <div className="cp-hero-visual contact-form-wrap" id="form">
            {!submitted ? (
              <form className="contact-form" onSubmit={onSubmit} noValidate>
                <h3>Request a Demo</h3>
                <p className="contact-form-sub">
                  Tell us a bit about your store and we'll reach out to schedule
                  a personalised walk-through.
                </p>

                <div className="contact-row">
                  <div className={`contact-field ${fieldErrors.name ? 'has-error' : ''}`}>
                    <label htmlFor="cf-name">Full Name <span className="req">*</span></label>
                    <input
                      id="cf-name"
                      type="text"
                      placeholder="Mark Thompson"
                      value={form.name}
                      onChange={onChange('name')}
                      disabled={submitting}
                      aria-invalid={fieldErrors.name ? 'true' : 'false'}
                    />
                    {fieldErrors.name && <span className="contact-field-error">{fieldErrors.name}</span>}
                  </div>
                  <div className={`contact-field ${fieldErrors.email ? 'has-error' : ''}`}>
                    <label htmlFor="cf-email">Business Email <span className="req">*</span></label>
                    <input
                      id="cf-email"
                      type="email"
                      placeholder="you@yourstore.com"
                      value={form.email}
                      onChange={onChange('email')}
                      disabled={submitting}
                      aria-invalid={fieldErrors.email ? 'true' : 'false'}
                    />
                    {fieldErrors.email && <span className="contact-field-error">{fieldErrors.email}</span>}
                  </div>
                </div>

                <div className="contact-row">
                  <div className={`contact-field ${fieldErrors.phone ? 'has-error' : ''}`}>
                    <label htmlFor="cf-phone">Phone Number <span className="req">*</span></label>
                    <input
                      id="cf-phone"
                      type="tel"
                      placeholder="(555) 123-4567"
                      value={form.phone}
                      onChange={onChange('phone')}
                      disabled={submitting}
                      aria-invalid={fieldErrors.phone ? 'true' : 'false'}
                    />
                    {fieldErrors.phone && <span className="contact-field-error">{fieldErrors.phone}</span>}
                  </div>
                  <div className={`contact-field ${fieldErrors.company ? 'has-error' : ''}`}>
                    <label htmlFor="cf-company">Company / Store Name <span className="req">*</span></label>
                    <input
                      id="cf-company"
                      type="text"
                      placeholder="Manhattan Wines & Spirits"
                      value={form.company}
                      onChange={onChange('company')}
                      disabled={submitting}
                      aria-invalid={fieldErrors.company ? 'true' : 'false'}
                    />
                    {fieldErrors.company && <span className="contact-field-error">{fieldErrors.company}</span>}
                  </div>
                </div>

                <div className="contact-field">
                  <label htmlFor="cf-businessType">Business Type <span className="req">*</span></label>
                  <select
                    id="cf-businessType"
                    value={form.businessType}
                    onChange={onChange('businessType')}
                    disabled={submitting}
                  >
                    <option value="liquor-store">Liquor Store</option>
                    <option value="multi-location">Multi-Location Retailer</option>
                    <option value="distillery">Distillery</option>
                    <option value="other">Other</option>
                  </select>
                </div>

                <div className={`contact-field ${fieldErrors.message ? 'has-error' : ''}`}>
                  <label htmlFor="cf-message">Message <span className="req">*</span></label>
                  <textarea
                    id="cf-message"
                    rows={4}
                    placeholder="Tell us about your business goals."
                    value={form.message}
                    onChange={onChange('message')}
                    aria-invalid={fieldErrors.message ? 'true' : 'false'}
                    disabled={submitting}
                  />
                  {fieldErrors.message && <span className="contact-field-error">{fieldErrors.message}</span>}
                </div>

                {error && <div className="contact-error">{error}</div>}

                <button
                  type="submit"
                  className="cp-btn-fill contact-submit"
                  disabled={submitting}
                >
                  {submitting ? 'Sending…' : 'Book My Demo'}
                </button>
                <p className="contact-fineprint">
                  By submitting you agree to be contacted by Botella AI. We
                  never share your details. Reply STOP anytime to opt out.
                </p>
              </form>
            ) : (
              <div className="contact-success">
                <div className="contact-success-check">✓</div>
                <h3>Thanks - message received.</h3>
                <p>
                  We'll reach out within one business day from{' '}
                  <strong>info@botella.ai</strong>. Check your spam folder
                  just in case.
                </p>
                <p className="contact-success-sub">
                  Need to reach us sooner?{' '}
                  <a href="mailto:info@botella.ai">Email us directly</a>.
                </p>
              </div>
            )}
          </div>
        </section>

        {/* The 3-support-channels + company-info sections that previously
            lived here have been removed because they are not present in
            the v3 SEO doc. Only the doc's hero / form / FAQ / final CTA
            sections remain. */}

        {/* ── FAQ - only the 2 questions from the v3 doc ──────────── */}
        <section className="cp-section-v2">
          <div className="cp-section-head">
            <h2>Frequently <i>Asked Questions</i></h2>
          </div>

          <div className="cp-faq-grid">
            {CONTACT_FAQS.map((f, i) => (
              <div className="cp-faq-card" key={i}>
                <h3>{f.q}</h3>
                <p>{f.a}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── FINAL CTA - text trimmed to match v3 doc exactly ──────── */}
        <section className="cp-final-cta">
          <h2>Ready to Modernize <i>Your Liquor Store?</i></h2>
          <p>Book a personalized demo today.</p>
          <div className="cp-final-cta-actions">
            <a href="#form" className="cp-btn-fill">Schedule Demo</a>
            <a href="mailto:info@botella.ai" className="cp-btn-line">info@botella.ai</a>
          </div>
        </section>

      </div>
    </ContentLayout>
  );
}

export default ContactPage;
