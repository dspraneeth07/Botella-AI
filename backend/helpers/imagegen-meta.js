/**
 * Meta Graph API integration - Instagram & Facebook posting.
 *
 * Flow:
 * 1. User clicks "Connect Instagram" → redirected to Meta OAuth
 * 2. Meta redirects back with code → exchanged for access token
 * 3. Short-lived token exchanged for long-lived token (60 days)
 * 4. Token stored per tenant in data/imagegen/meta_tokens/
 * 5. Posting: upload image → create media container → publish
 *
 * Requires a Meta Business App with:
 *   - instagram_basic, instagram_content_publish, pages_show_list, pages_read_engagement
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const TOKEN_DIR = path.join(__dirname, '..', 'data', 'imagegen', 'meta_tokens');

// ── HTTP helper ───────────────────────────────────────────────────

function graphRequest(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { reject(new Error('Invalid JSON from Meta API')); }
      });
    }).on('error', reject);
  });
}

function graphPost(url, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = JSON.stringify(body);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { reject(new Error('Invalid JSON from Meta API')); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ── Token management ──────────────────────────────────────────────

function getTokenPath(clientId, locationId) {
  fs.mkdirSync(TOKEN_DIR, { recursive: true });
  return path.join(TOKEN_DIR, `meta_${clientId}_${locationId}.json`);
}

function loadToken(clientId, locationId) {
  const p = getTokenPath(clientId, locationId);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function saveToken(clientId, locationId, tokenData) {
  fs.writeFileSync(getTokenPath(clientId, locationId), JSON.stringify(tokenData, null, 2));
}

function deleteToken(clientId, locationId) {
  const p = getTokenPath(clientId, locationId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// ── OAuth flow ────────────────────────────────────────────────────

function getOAuthUrl(clientId, locationId) {
  const appId = process.env.META_APP_ID;
  const redirectUri = process.env.META_REDIRECT_URI;
  if (!appId || !redirectUri) return null;

  const state = JSON.stringify({ client_id: clientId, location_id: locationId });
  const scopes = [
    'instagram_basic',
    'instagram_content_publish',
    'pages_show_list',
    'pages_read_engagement',
  ].join(',');

  return `https://www.facebook.com/v21.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scopes}&state=${encodeURIComponent(state)}&response_type=code`;
}

async function exchangeCodeForToken(code) {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const redirectUri = process.env.META_REDIRECT_URI;

  // Exchange code for short-lived token
  const shortUrl = `https://graph.facebook.com/v21.0/oauth/access_token?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${appSecret}&code=${code}`;
  const shortRes = await graphRequest(shortUrl);

  if (shortRes.error) throw new Error(shortRes.error.message);

  // Exchange for long-lived token (60 days)
  const longUrl = `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortRes.access_token}`;
  const longRes = await graphRequest(longUrl);

  if (longRes.error) throw new Error(longRes.error.message);

  return {
    access_token: longRes.access_token,
    token_type: longRes.token_type,
    expires_in: longRes.expires_in || 5184000, // ~60 days
    created_at: Date.now(),
  };
}

// ── Fetch connected accounts ──────────────────────────────────────

async function getConnectedAccounts(accessToken) {
  // Get Facebook Pages
  const pagesUrl = `https://graph.facebook.com/v21.0/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${accessToken}`;
  const pagesRes = await graphRequest(pagesUrl);

  if (pagesRes.error) throw new Error(pagesRes.error.message);

  const accounts = { facebook_pages: [], instagram_accounts: [] };

  for (const page of (pagesRes.data || [])) {
    accounts.facebook_pages.push({
      id: page.id,
      name: page.name,
      access_token: page.access_token,
    });

    // If page has connected Instagram Business Account
    if (page.instagram_business_account) {
      const igId = page.instagram_business_account.id;
      const igUrl = `https://graph.facebook.com/v21.0/${igId}?fields=id,username,profile_picture_url&access_token=${accessToken}`;
      const igRes = await graphRequest(igUrl);

      accounts.instagram_accounts.push({
        id: igId,
        username: igRes.username || 'Unknown',
        profile_picture_url: igRes.profile_picture_url || '',
        page_id: page.id,
        page_access_token: page.access_token,
      });
    }
  }

  return accounts;
}

// ── Post to Instagram ─────────────────────────────────────────────

async function postToInstagram({ igAccountId, pageAccessToken, imageUrl, caption }) {
  // Step 1: Create media container
  const createUrl = `https://graph.facebook.com/v21.0/${igAccountId}/media`;
  const createRes = await graphPost(createUrl, {
    image_url: imageUrl,
    caption: caption,
    access_token: pageAccessToken,
  });

  if (createRes.error) throw new Error(`IG container error: ${createRes.error.message}`);

  const containerId = createRes.id;

  // Step 2: Publish the container
  const publishUrl = `https://graph.facebook.com/v21.0/${igAccountId}/media_publish`;
  const publishRes = await graphPost(publishUrl, {
    creation_id: containerId,
    access_token: pageAccessToken,
  });

  if (publishRes.error) throw new Error(`IG publish error: ${publishRes.error.message}`);

  return { id: publishRes.id, platform: 'instagram' };
}

// ── Post to Facebook Page ─────────────────────────────────────────

async function postToFacebook({ pageId, pageAccessToken, imageUrl, caption }) {
  const url = `https://graph.facebook.com/v21.0/${pageId}/photos`;
  const res = await graphPost(url, {
    url: imageUrl,
    message: caption,
    access_token: pageAccessToken,
  });

  if (res.error) throw new Error(`FB post error: ${res.error.message}`);

  return { id: res.id || res.post_id, platform: 'facebook' };
}

module.exports = {
  getOAuthUrl,
  exchangeCodeForToken,
  getConnectedAccounts,
  postToInstagram,
  postToFacebook,
  loadToken,
  saveToken,
  deleteToken,
};
