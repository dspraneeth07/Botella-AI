const router = require('express').Router();
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// OAuth2 client setup
const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  process.env.GMAIL_REDIRECT_URI
);

// Token storage per location
const TOKEN_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(TOKEN_DIR)) fs.mkdirSync(TOKEN_DIR, { recursive: true });

function getTokenPath(locationId) {
  return path.join(TOKEN_DIR, `gmail_token_location_${locationId}.json`);
}

function loadToken(locationId) {
  const tokenPath = getTokenPath(locationId);
  if (fs.existsSync(tokenPath)) {
    return JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  }
  return null;
}

function saveToken(locationId, tokens) {
  fs.writeFileSync(getTokenPath(locationId), JSON.stringify(tokens, null, 2));
}

function getEmailLogPath(locationId) {
  return path.join(TOKEN_DIR, `email_log_location_${locationId}.json`);
}

function loadEmailLog(locationId) {
  const logPath = getEmailLogPath(locationId);
  if (fs.existsSync(logPath)) {
    return JSON.parse(fs.readFileSync(logPath, 'utf8'));
  }
  return [];
}

function saveEmailLog(locationId, log) {
  fs.writeFileSync(getEmailLogPath(locationId), JSON.stringify(log, null, 2));
}

// ============================================================
// GET /api/email/status - Check if Gmail is connected
// ============================================================
router.get('/status', (req, res) => {
  const locationId = req.user.location_id;
  const token = loadToken(locationId);
  res.json({ connected: !!token, location_id: locationId });
});

// ============================================================
// GET /api/email/connect - Start OAuth flow
// ============================================================
router.get('/connect', (req, res) => {
  const locationId = req.user.location_id;
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify',
    ],
    state: JSON.stringify({ location_id: locationId, token: req.headers.authorization?.split(' ')[1] }),
  });
  res.json({ authUrl });
});

// ============================================================
// GET /api/email/oauth/callback - Handle OAuth callback
// ============================================================
router.get('/oauth/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const { location_id } = JSON.parse(state);
    const { tokens } = await oauth2Client.getToken(code);
    saveToken(location_id, tokens);
    // Redirect to frontend with success
    res.redirect('/chat?email_connected=true');
  } catch (err) {
    console.error('[Email] OAuth error:', err.message);
    res.redirect('/chat?email_connected=false');
  }
});

// ============================================================
// POST /api/email/disconnect - Remove Gmail connection
// ============================================================
router.post('/disconnect', (req, res) => {
  const locationId = req.user.location_id;
  const tokenPath = getTokenPath(locationId);
  if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
  res.json({ success: true, message: 'Gmail disconnected.' });
});

// ============================================================
// GET /api/email/promotions - Get products on sale with matching customers
// ============================================================
router.get('/promotions', async (req, res) => {
  const pool = req.pool;
  const clientId = req.user.client_id;
  const locationId = req.user.location_id;

  try {
    // Find products currently on sale (sale_price < price) and customers who bought them
    const result = await pool.query(`
      SELECT DISTINCT
        c.customer_id,
        c.customer_name,
        c.contact_email as email,
        p.product_name,
        p.sku,
        p.sale_price,
        p.price as regular_price
      FROM products p
      JOIN sale_items si ON (TRIM(si.sku) = TRIM(p.sku) OR TRIM(si.sku) = TRIM(p.upc)) AND si.client_id = p.client_id AND si.location_id = p.location_id
      JOIN sales s ON s.sale_id = si.sale_id AND s.client_id = si.client_id AND s.location_id = si.location_id
      JOIN customers c ON c.customer_id = s.customer_id AND c.client_id = s.client_id AND c.location_id = s.location_id
      WHERE p.client_id = $1 AND p.location_id = $2
        AND p.sale_price IS NOT NULL
        AND p.sale_price > 0
        AND p.sale_price < p.price
        AND c.contact_email IS NOT NULL
        AND TRIM(c.contact_email) != ''
      ORDER BY c.customer_name
      LIMIT 100
    `, [clientId, locationId]);

    res.json({ promotions: result.rows });
  } catch (err) {
    console.error('[Email] Promotions error:', err.message);
    res.status(500).json({ error: 'Failed to load promotions: ' + err.message });
  }
});

// ==============================================================
// POST /api/email/send - Send promo email to specific customers
// ==============================================================
router.post('/send', async (req, res) => {
  const locationId = req.user.location_id;
  const locationName = req.user.location_name || 'Our Store';
  const token = loadToken(locationId);

  if (!token) {
    return res.status(400).json({ error: 'Gmail not connected. Please connect your Gmail first.' });
  }

  const { recipients } = req.body;
  // recipients: [{ email, customer_name, product_name, sale_price, regular_price }]

  if (!recipients || recipients.length === 0) {
    return res.status(400).json({ error: 'No recipients provided.' });
  }

  try {
    oauth2Client.setCredentials(token);

    // Refresh token if needed
    if (token.expiry_date && Date.now() >= token.expiry_date) {
      const { credentials } = await oauth2Client.refreshAccessToken();
      saveToken(locationId, credentials);
      oauth2Client.setCredentials(credentials);
    }

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const emailLog = loadEmailLog(locationId);
    const results = [];

    for (const r of recipients) {
      try {
        const subject = `Special Sale on ${r.product_name} at ${locationName}!`;
        const htmlBody = `
          <div style="font-family: -apple-system, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
            <div style="background: linear-gradient(135deg, #6366f1, #818cf8); padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 24px;">${locationName}</h1>
              <p style="color: rgba(255,255,255,0.8); margin: 8px 0 0;">Special Offer Just for You</p>
            </div>
            <div style="background: #ffffff; padding: 32px 24px; border: 1px solid #e5e7eb; border-top: none;">
              <p style="font-size: 16px; color: #374151;">Hi ${r.customer_name || 'Valued Customer'},</p>
              <p style="font-size: 16px; color: #374151;">Great news! A product you've purchased before is now on sale:</p>
              <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: center;">
                <h2 style="color: #111827; margin: 0 0 8px;">${r.product_name}</h2>
                ${r.regular_price ? `<p style="color: #9ca3af; text-decoration: line-through; margin: 0;">Regular: $${parseFloat(r.regular_price).toFixed(2)}</p>` : ''}
                <p style="color: #6366f1; font-size: 28px; font-weight: 700; margin: 8px 0;">$${parseFloat(r.sale_price).toFixed(2)}</p>
              </div>
              <p style="font-size: 16px; color: #374151;">Visit us today to grab this deal before it's gone!</p>
              <p style="font-size: 14px; color: #9ca3af; margin-top: 24px;">- ${locationName} Team</p>
            </div>
            <div style="text-align: center; padding: 16px; color: #9ca3af; font-size: 12px;">
              <p>You're receiving this because you've shopped with us before.</p>
            </div>
          </div>
        `;

        const rawMessage = [
          `To: ${r.email}`,
          `Subject: ${subject}`,
          `Content-Type: text/html; charset=utf-8`,
          `MIME-Version: 1.0`,
          '',
          htmlBody,
        ].join('\r\n');

        const encodedMessage = Buffer.from(rawMessage)
          .toString('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');

        const sent = await gmail.users.messages.send({
          userId: 'me',
          requestBody: { raw: encodedMessage },
        });

        emailLog.push({
          id: sent.data.id,
          threadId: sent.data.threadId,
          to: r.email,
          customer_name: r.customer_name,
          product_name: r.product_name,
          subject,
          type: 'sent',
          date: new Date().toISOString(),
          location_id: locationId,
        });

        results.push({ email: r.email, status: 'sent', messageId: sent.data.id });
      } catch (sendErr) {
        console.error(`[Email] Failed to send to ${r.email}:`, sendErr.message);
        results.push({ email: r.email, status: 'failed', error: sendErr.message });
      }
    }

    saveEmailLog(locationId, emailLog);
    res.json({ results, sent: results.filter(r => r.status === 'sent').length });
  } catch (err) {
    console.error('[Email] Send error:', err.message);
    res.status(500).json({ error: 'Failed to send emails: ' + err.message });
  }
});

// ============================================================
// POST /api/email/send-auto - Auto-send promos (called by cron)
// ============================================================
router.post('/send-auto', async (req, res) => {
  const pool = req.pool;
  const locationId = req.user.location_id;
  const clientId = req.user.client_id;
  const locationName = req.user.location_name || 'Our Store';
  const token = loadToken(locationId);

  if (!token) {
    return res.json({ skipped: true, reason: 'Gmail not connected' });
  }

  try {
    const emailLog = loadEmailLog(locationId);
    const today = new Date().toDateString();

    // Check if already sent today
    const sentToday = emailLog.some(e => new Date(e.date).toDateString() === today && e.type === 'sent');
    if (sentToday) {
      return res.json({ skipped: true, reason: 'Already sent today' });
    }

    // Find products on sale with matching customers
    const result = await pool.query(`
      SELECT DISTINCT
        c.contact_email as email,
        c.customer_name,
        p.product_name,
        p.sku,
        p.sale_price,
        p.price as regular_price
      FROM products p
      JOIN sale_items si ON (TRIM(si.sku) = TRIM(p.sku) OR TRIM(si.sku) = TRIM(p.upc)) AND si.client_id = p.client_id AND si.location_id = p.location_id
      JOIN sales s ON s.sale_id = si.sale_id AND s.client_id = si.client_id AND s.location_id = si.location_id
      JOIN customers c ON c.customer_id = s.customer_id AND c.client_id = s.client_id AND c.location_id = s.location_id
      WHERE p.client_id = $1 AND p.location_id = $2
        AND p.sale_price IS NOT NULL
        AND p.sale_price > 0
        AND p.sale_price < p.price
        AND c.contact_email IS NOT NULL
        AND TRIM(c.contact_email) != ''
      LIMIT 50
    `, [clientId, locationId]);

    if (result.rows.length === 0) {
      return res.json({ skipped: true, reason: 'No promotions with matching customers' });
    }

    res.json({ ready: true, count: result.rows.length, message: 'Auto-send triggered' });
  } catch (err) {
    console.error('[Email] Auto-send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /api/email/inbox - Get customer replies
// ============================================================
router.get('/inbox', async (req, res) => {
  const locationId = req.user.location_id;
  const token = loadToken(locationId);

  if (!token) {
    return res.status(400).json({ error: 'Gmail not connected.' });
  }

  try {
    oauth2Client.setCredentials(token);

    // Refresh token if needed
    if (token.expiry_date && Date.now() >= token.expiry_date) {
      const { credentials } = await oauth2Client.refreshAccessToken();
      saveToken(locationId, credentials);
      oauth2Client.setCredentials(credentials);
    }

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Get recent emails (inbox replies)
    const response = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 20,
      q: 'in:inbox is:unread',
    });

    const messages = [];
    if (response.data.messages) {
      for (const msg of response.data.messages.slice(0, 20)) {
        try {
          const detail = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id,
            format: 'metadata',
            metadataHeaders: ['From', 'Subject', 'Date'],
          });

          const headers = detail.data.payload.headers;
          const getHeader = (name) => headers.find(h => h.name === name)?.value || '';

          messages.push({
            id: msg.id,
            threadId: msg.threadId,
            from: getHeader('From'),
            subject: getHeader('Subject'),
            date: getHeader('Date'),
            snippet: detail.data.snippet,
            unread: detail.data.labelIds?.includes('UNREAD'),
          });
        } catch (e) {
          // Skip messages that can't be read
        }
      }
    }

    res.json({ messages });
  } catch (err) {
    console.error('[Email] Inbox error:', err.message);
    res.status(500).json({ error: 'Failed to fetch inbox: ' + err.message });
  }
});

// ============================================================
// GET /api/email/thread/:threadId - Get full email thread
// ============================================================
router.get('/thread/:threadId', async (req, res) => {
  const locationId = req.user.location_id;
  const token = loadToken(locationId);

  if (!token) {
    return res.status(400).json({ error: 'Gmail not connected.' });
  }

  try {
    oauth2Client.setCredentials(token);

    if (token.expiry_date && Date.now() >= token.expiry_date) {
      const { credentials } = await oauth2Client.refreshAccessToken();
      saveToken(locationId, credentials);
      oauth2Client.setCredentials(credentials);
    }

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const thread = await gmail.users.threads.get({
      userId: 'me',
      id: req.params.threadId,
      format: 'full',
    });

    const emails = thread.data.messages.map(msg => {
      const headers = msg.payload.headers;
      const getHeader = (name) => headers.find(h => h.name === name)?.value || '';

      // Extract body
      let body = '';
      if (msg.payload.body?.data) {
        body = Buffer.from(msg.payload.body.data, 'base64').toString('utf8');
      } else if (msg.payload.parts) {
        const textPart = msg.payload.parts.find(p => p.mimeType === 'text/plain');
        const htmlPart = msg.payload.parts.find(p => p.mimeType === 'text/html');
        const part = textPart || htmlPart;
        if (part?.body?.data) {
          body = Buffer.from(part.body.data, 'base64').toString('utf8');
        }
      }

      return {
        id: msg.id,
        from: getHeader('From'),
        to: getHeader('To'),
        subject: getHeader('Subject'),
        date: getHeader('Date'),
        body,
        snippet: msg.snippet,
      };
    });

    res.json({ emails });
  } catch (err) {
    console.error('[Email] Thread error:', err.message);
    res.status(500).json({ error: 'Failed to load thread: ' + err.message });
  }
});

// ============================================================
// POST /api/email/reply - Reply to a customer email
// ============================================================
router.post('/reply', async (req, res) => {
  const locationId = req.user.location_id;
  const token = loadToken(locationId);

  if (!token) {
    return res.status(400).json({ error: 'Gmail not connected.' });
  }

  const { threadId, messageId, to, subject, body } = req.body;

  if (!to || !body) {
    return res.status(400).json({ error: 'Recipient and message body are required.' });
  }

  try {
    oauth2Client.setCredentials(token);

    if (token.expiry_date && Date.now() >= token.expiry_date) {
      const { credentials } = await oauth2Client.refreshAccessToken();
      saveToken(locationId, credentials);
      oauth2Client.setCredentials(credentials);
    }

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const rawMessage = [
      `To: ${to}`,
      `Subject: Re: ${subject || ''}`,
      `In-Reply-To: ${messageId || ''}`,
      `References: ${messageId || ''}`,
      `Content-Type: text/html; charset=utf-8`,
      `MIME-Version: 1.0`,
      '',
      `<div style="font-family: -apple-system, Arial, sans-serif; font-size: 15px; color: #374151;">${body.replace(/\n/g, '<br>')}</div>`,
    ].join('\r\n');

    const encodedMessage = Buffer.from(rawMessage)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const sent = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage,
        threadId: threadId,
      },
    });

    // Log the reply
    const emailLog = loadEmailLog(locationId);
    emailLog.push({
      id: sent.data.id,
      threadId: sent.data.threadId,
      to,
      subject: `Re: ${subject}`,
      type: 'reply',
      date: new Date().toISOString(),
      location_id: locationId,
    });
    saveEmailLog(locationId, emailLog);

    res.json({ success: true, messageId: sent.data.id });
  } catch (err) {
    console.error('[Email] Reply error:', err.message);
    res.status(500).json({ error: 'Failed to send reply: ' + err.message });
  }
});

// ============================================================
// GET /api/email/log - Get sent email history
// ============================================================
router.get('/log', (req, res) => {
  const locationId = req.user.location_id;
  const log = loadEmailLog(locationId);
  res.json({ log: log.reverse().slice(0, 50) });
});

module.exports = router;
