const router = require('express').Router();
const fs = require('fs');
const path = require('path');
// SMTP transport for outbound lead notifications. Switched from the
// previous Gmail-OAuth implementation (`googleapis` + token file) after
// the Google Cloud OAuth client was disabled (`disabled_client` 401),
// which silently broke every lead notification. SMTP via an App Password
// has zero moving parts, no refresh-token expiry, no Google Cloud project
// to babysit - it just works for transactional sends like this.
//
// IMPORTANT: this change is fully self-contained to leads.js. The other
// Gmail-using feature (Email Automation in routes/email.js, used by
// logged-in store owners to send marketing campaigns) still uses Gmail
// OAuth on per-location tokens. That's intentional - campaign sending
// belongs to the store's own Gmail account, not the platform's, so
// OAuth is the right choice there. We're only changing how the platform
// notifies ITSELF about new leads.
const nodemailer = require('nodemailer');
// Structured logger (winston) - same instance dashboard.js + the rest of
// the API use. Routing leads-route log lines through here ensures every
// success/warn/error also lands in logs/combined.log + logs/error.log,
// where they're actually retrievable later. The previous console.log /
// console.error calls only hit stdout - making silent Gmail failures
// invisible after the fact, which is how the OAuth-refresh-token expiry
// went undetected for ~2 months.
const logger = require('../utils/logger');

const DATA_FILE = path.join(__dirname, '..', 'data', 'leads.json');

// Recipients for new-lead notifications. Accepts a comma-separated list in
// the NOTIFICATION_EMAIL env var so a single submission fans out to every
// stakeholder who needs to know - e.g.
//   NOTIFICATION_EMAIL=info@botella.ai,sales@botella.ai,you@yourdomain.com
//
// We parse it once at module load (it doesn't change between requests),
// trim whitespace around each address, drop empties (so a stray trailing
// comma doesn't break things), and dedupe (so accidentally listing the
// same address twice doesn't send a duplicate). The fallback when the
// env var isn't set stays as the single canonical inbox.
const NOTIFICATION_RECIPIENTS = (process.env.NOTIFICATION_EMAIL || 'info@botella.ai')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .filter((addr, i, arr) => arr.indexOf(addr) === i);

// The `To:` header string. RFC 5322 permits comma-separated addresses
// in a single header; nodemailer + every SMTP server accept this.
// Joining with ", " (comma + space) is the conventional, most-compatible
// format.
const NOTIFICATION_TO_HEADER = NOTIFICATION_RECIPIENTS.join(', ');

// SMTP transport - created once at module load and reused for every
// lead notification. nodemailer pools connections internally so this is
// both fast and resource-friendly.
//
// `haveSMTPConfig` lets us skip the transport entirely when the env
// vars aren't set (e.g. local dev without SMTP) instead of crashing.
// In that case the lead is still saved to leads.json and a warning is
// logged - but no email goes out.
//
// secure: true   for port 465 (implicit TLS)
// secure: false  for port 587 (STARTTLS, the modern default)
const SMTP_PORT = parseInt(process.env.SMTP_PORT, 10) || 587;
const haveSMTPConfig = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const smtpTransport = haveSMTPConfig
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    })
  : null;

if (haveSMTPConfig) {
  // Verify the SMTP connection on startup so misconfiguration shows up
  // in the error log immediately - not when the first lead arrives. The
  // verify() call is async and best-effort; we don't await it because
  // this runs at require-time. Errors logged async via the existing
  // logger so they end up in logs/error.log.
  smtpTransport.verify((err) => {
    if (err) {
      logger.error('SMTP connection verify failed at startup', {
        error: err.message,
        host: process.env.SMTP_HOST,
        port: SMTP_PORT,
        user: process.env.SMTP_USER,
        hint: 'Check SMTP_USER / SMTP_PASS in .env. For Gmail, SMTP_PASS must be a 16-char App Password (not your normal Google password) AND 2FA must be enabled on the account.',
      });
    } else {
      logger.info('SMTP ready for lead notifications', {
        host: process.env.SMTP_HOST,
        port: SMTP_PORT,
        sender: process.env.SMTP_USER,
        recipients: NOTIFICATION_RECIPIENTS,
      });
    }
  });
} else {
  logger.warn('SMTP not configured - lead notifications disabled', {
    missing: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'].filter(k => !process.env[k]),
    hint: 'Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in backend/.env to enable email notifications.',
  });
}

// Load existing leads
function loadLeads() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    }
  } catch {}
  return [];
}

// Save leads
function saveLeads(leads) {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(leads, null, 2));
}

// POST /api/leads - public, no auth required
// Accepts:
//   email       - required, must be a valid format
//   meta        - optional object with extra context from the Contact page
//                 form: { source, name, phone, company, businessType, message }
router.post('/', async (req, res) => {
  const { email, meta = {} } = req.body;

  if (!email || !email.trim()) {
    return res.status(400).json({ error: 'Email is required.' });
  }

  // Basic email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email.trim())) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }

  try {
    // 1. Store the lead (with the optional `meta` payload from the
    //    Contact form so future automation has the full record).
    const leads = loadLeads();
    const newLead = {
      email: email.trim().toLowerCase(),
      submitted_at: new Date().toISOString(),
      source: meta.source || 'landing_page',
      name: (meta.name || '').toString().trim(),
      phone: (meta.phone || '').toString().trim(),
      company: (meta.company || '').toString().trim(),
      businessType: (meta.businessType || '').toString().trim(),
      message: (meta.message || '').toString().trim(),
    };
    leads.push(newLead);
    saveLeads(leads);
    logger.info('Lead captured', {
      email: newLead.email,
      name: newLead.name || undefined,
      company: newLead.company || undefined,
      source: newLead.source,
    });

    // 2. Send notification email via SMTP.
    //
    // The lead is already saved at this point, so any failure here is
    // logged but doesn't fail the request - the visitor still sees the
    // success response and we have their data for manual follow-up.
    if (smtpTransport) {
      try {
        // Subject - include the company name if we have it so the inbox
        // preview is immediately useful.
        const subject = newLead.company
          ? `New Demo Request - ${newLead.company} (Botella)`
          : `New Demo Request - Botella`;

        // Body - show every meta field that was filled. Skip empties so
        // notifications from the simple popup (email-only) stay clean.
        const lines = [
          'New demo request received!',
          '',
          `Email:        ${newLead.email}`,
        ];
        if (newLead.name)         lines.push(`Name:         ${newLead.name}`);
        if (newLead.phone)        lines.push(`Phone:        ${newLead.phone}`);
        if (newLead.company)      lines.push(`Company:      ${newLead.company}`);
        if (newLead.businessType) lines.push(`Business:     ${newLead.businessType}`);
        lines.push(`Submitted:    ${new Date(newLead.submitted_at).toLocaleString()}`);
        lines.push(`Source:       ${newLead.source}`);
        if (newLead.message) {
          lines.push('');
          lines.push('Message:');
          lines.push(newLead.message);
        }
        lines.push('');
        lines.push('---');
        lines.push('Botella Lead Notification');
        const body = lines.join('\n');

        // Key UX detail: `replyTo` is set to the visitor's email, so when
        // an admin hits "Reply" in their inbox the response goes back to
        // the prospect - not to the SMTP_USER sender account. This is the
        // whole point of the notification: read the lead, hit reply, talk
        // to them. Without replyTo, replies would loop back to the
        // notification sender and never reach the visitor.
        const info = await smtpTransport.sendMail({
          from: `"Botella" <${process.env.SMTP_USER}>`,
          to: NOTIFICATION_TO_HEADER,
          replyTo: newLead.email,
          subject,
          text: body,
        });

        logger.info('Lead notification sent', {
          recipients: NOTIFICATION_RECIPIENTS,
          recipientCount: NOTIFICATION_RECIPIENTS.length,
          email: newLead.email,
          messageId: info.messageId,
          // info.accepted/rejected are arrays nodemailer fills with the
          // addresses the SMTP server accepted vs. rejected. Useful when
          // ONE of three recipients bounces - the other two still got it.
          accepted: info.accepted,
          rejected: info.rejected,
        });
      } catch (emailErr) {
        // Surfaces the exact SMTP failure reason to logs/error.log.
        // Common causes: SMTP_PASS not an App Password, sender account
        // doesn't have 2FA enabled (so App Passwords don't exist),
        // wrong host/port, network blocked, recipient address invalid.
        logger.error('Lead notification email failed', {
          error: emailErr.message,
          code: emailErr.code,
          command: emailErr.command,
          recipients: NOTIFICATION_RECIPIENTS,
          email: newLead.email,
        });
        // Don't fail the request - lead is already stored
      }
    } else {
      // SMTP isn't configured (env vars missing). Lead is stored, but no
      // email goes out. The startup-time warning already explained which
      // env vars are missing; this per-request line just confirms the
      // skip happened for THIS specific lead so it's visible in the log.
      logger.warn('Lead stored but notification skipped (SMTP not configured)', {
        recipients: NOTIFICATION_RECIPIENTS,
        email: newLead.email,
      });
    }

    res.json({ success: true, message: 'Thank you! We will contact you soon.' });
  } catch (err) {
    logger.error('Lead capture failed', { error: err.message });
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
