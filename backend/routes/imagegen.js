/**
 * Image Generation Routes - /api/imagegen
 * Protected by verifyToken + attachPool middleware (set in server.js).
 *
 * Tenant isolation: every query filters by req.user.client_id + req.user.location_id.
 */

const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const XLSX = require('xlsx');

const { EVENT_STYLES, THEME_STYLES, FESTIVAL_LIST } = require('../helpers/imagegen-styles');
const { buildDiscountPrompt, buildGenericPrompt, buildVideoPrompt } = require('../helpers/imagegen-prompts');
const {
  getActiveEngine,
  generateImageTextOnly,
  generateImageWithReference,
  saveBase64Image,
  fileToBase64,
} = require('../helpers/imagegen-openai');
// Gemini video disabled - using OpenAI only
// const { generateVideo, saveVideoFile } = require('../helpers/imagegen-gemini');
const { searchProductImages } = require('../helpers/imagegen-scraper');
const { generateCaption } = require('../helpers/imagegen-caption');
const {
  getOAuthUrl, exchangeCodeForToken, getConnectedAccounts,
  postToInstagram, postToFacebook, loadToken, saveToken, deleteToken,
} = require('../helpers/imagegen-meta');
const { getIGPool, ensureTables } = require('../helpers/imagegen-db');

// ── Auto-create tables on startup ────────────────────────────────
ensureTables();

const https = require('https');
const http = require('http');

// ── Constants & Helpers ──────────────────────────────────────────

const DATA_DIR = path.join(__dirname, '..', 'data', 'imagegen');

/**
 * Download an image URL and return its base64 string.
 * Returns null if download fails.
 */
function downloadImageAsBase64(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: timeoutMs,
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadImageAsBase64(res.headers.location, timeoutMs).then(resolve);
        return;
      }
      if (res.statusCode !== 200) { resolve(null); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (buffer.length < 1000) { resolve(null); return; } // too small, probably an error page
        resolve(buffer.toString('base64'));
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
const DEFAULT_WEEKLY_LIMIT = 50;

// Multer for file uploads (logo, product images, CSV/Excel)
const upload = multer({
  dest: path.join(DATA_DIR, 'uploads'),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

function getTenantDir(clientId, locationId) {
  const dir = path.join(DATA_DIR, `${clientId}_${locationId}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeName(name) {
  return name.replace(/[^a-zA-Z0-9_\- ]/g, '').trim().replace(/\s+/g, '_').substring(0, 50);
}

// ── Settings helpers ─────────────────────────────────────────────

async function getOrCreateSettings(pool, clientId, locationId) {
  let res = await pool.query(
    'SELECT * FROM ig_store_settings WHERE client_id = $1 AND location_id = $2',
    [clientId, locationId]
  );
  if (res.rows.length > 0) return res.rows[0];

  // Auto-create default settings
  res = await pool.query(
    `INSERT INTO ig_store_settings (client_id, location_id, weekly_limit, generations_this_week, week_start)
     VALUES ($1, $2, $3, 0, CURRENT_DATE)
     ON CONFLICT (client_id, location_id) DO NOTHING
     RETURNING *`,
    [clientId, locationId, DEFAULT_WEEKLY_LIMIT]
  );
  if (res.rows.length > 0) return res.rows[0];

  // If ON CONFLICT hit, fetch again
  res = await pool.query(
    'SELECT * FROM ig_store_settings WHERE client_id = $1 AND location_id = $2',
    [clientId, locationId]
  );
  return res.rows[0];
}

async function checkAndResetWeek(pool, clientId, locationId) {
  const settings = await getOrCreateSettings(pool, clientId, locationId);
  const weekStart = new Date(settings.week_start);
  const now = new Date();
  const daysDiff = (now - weekStart) / (1000 * 60 * 60 * 24);

  if (daysDiff >= 7) {
    await pool.query(
      `UPDATE ig_store_settings
       SET generations_this_week = 0, week_start = CURRENT_DATE, updated_at = NOW()
       WHERE client_id = $1 AND location_id = $2`,
      [clientId, locationId]
    );
    return { ...settings, generations_this_week: 0 };
  }
  return settings;
}

async function checkLimit(pool, clientId, locationId) {
  const settings = await checkAndResetWeek(pool, clientId, locationId);
  if (settings.generations_this_week >= settings.weekly_limit) {
    return {
      allowed: false,
      used: settings.generations_this_week,
      limit: settings.weekly_limit,
    };
  }
  return { allowed: true, used: settings.generations_this_week, limit: settings.weekly_limit };
}

async function incrementGeneration(pool, clientId, locationId) {
  await pool.query(
    `UPDATE ig_store_settings
     SET generations_this_week = generations_this_week + 1, updated_at = NOW()
     WHERE client_id = $1 AND location_id = $2`,
    [clientId, locationId]
  );
}

// ── Bulk batch tracking (in-memory) ──────────────────────────────

const batchProgress = new Map();

// ══════════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════════

// ── GET / - Available styles & themes ────────────────────────────

router.get('/', (req, res) => {
  let engine = 'none';
  try { engine = getActiveEngine(); } catch {}

  res.json({
    engine,
    events: Object.entries(EVENT_STYLES).map(([key, desc]) => ({
      key,
      name: FESTIVAL_LIST[key]?.name || key,
      emoji: FESTIVAL_LIST[key]?.emoji || '',
      colors: FESTIVAL_LIST[key]?.colors || [],
      description: desc,
    })),
    themes: Object.entries(THEME_STYLES).map(([key, data]) => ({
      key,
      name: data.name,
    })),
    festivals: FESTIVAL_LIST,
  });
});

// ── GET /settings - Store settings ───────────────────────────────

router.get('/settings', async (req, res) => {
  try {
    const { client_id, location_id, location_name } = req.user;
    const settings = await checkAndResetWeek(getIGPool(), client_id, location_id);
    const hasLogo = settings.logo_path && fs.existsSync(settings.logo_path);

    res.json({
      store_display_name: settings.store_display_name || location_name || '',
      has_logo: !!hasLogo,
      weekly_limit: settings.weekly_limit,
      used: settings.generations_this_week,
      remaining: Math.max(0, settings.weekly_limit - settings.generations_this_week),
    });
  } catch (err) {
    console.error('[ImageGen] Settings error:', err.message);
    res.status(500).json({ error: 'Failed to load settings.' });
  }
});

// ── PUT /settings - Update store settings ────────────────────────

router.put('/settings', async (req, res) => {
  try {
    const { client_id, location_id } = req.user;
    const { store_display_name } = req.body;

    await getOrCreateSettings(getIGPool(), client_id, location_id);
    await getIGPool().query(
      `UPDATE ig_store_settings
       SET store_display_name = COALESCE($1, store_display_name), updated_at = NOW()
       WHERE client_id = $2 AND location_id = $3`,
      [store_display_name || null, client_id, location_id]
    );

    res.json({ status: 'success' });
  } catch (err) {
    console.error('[ImageGen] Update settings error:', err.message);
    res.status(500).json({ error: 'Failed to update settings.' });
  }
});

// ── GET /settings/logo-image - Serve store logo image ─────────────

router.get('/settings/logo-image', async (req, res) => {
  try {
    const { client_id, location_id } = req.user;
    const settings = await getOrCreateSettings(getIGPool(), client_id, location_id);

    if (!settings.logo_path || !fs.existsSync(settings.logo_path)) {
      return res.status(404).json({ error: 'No logo found.' });
    }

    res.sendFile(settings.logo_path);
  } catch (err) {
    console.error('[ImageGen] Logo serve error:', err.message);
    res.status(500).json({ error: 'Failed to load logo.' });
  }
});

// ── POST /settings/logo - Upload store logo ──────────────────────

router.post('/settings/logo', upload.single('logo'), async (req, res) => {
  try {
    const { client_id, location_id } = req.user;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const tenantDir = getTenantDir(client_id, location_id);
    const logoDir = path.join(tenantDir, 'logos');
    fs.mkdirSync(logoDir, { recursive: true });

    const destPath = path.join(logoDir, 'store_logo.png');
    fs.renameSync(req.file.path, destPath);

    await getOrCreateSettings(getIGPool(), client_id, location_id);
    await getIGPool().query(
      `UPDATE ig_store_settings SET logo_path = $1, updated_at = NOW()
       WHERE client_id = $2 AND location_id = $3`,
      [destPath, client_id, location_id]
    );

    res.json({ status: 'success', has_logo: true });
  } catch (err) {
    console.error('[ImageGen] Logo upload error:', err.message);
    res.status(500).json({ error: 'Failed to upload logo.' });
  }
});

// ── POST /generate/discount - Single discount image ──────────────

router.post('/generate/discount', upload.single('product_image'), async (req, res) => {
  try {
    const { client_id, location_id } = req.user;

    // Check limit
    const limitCheck = await checkLimit(getIGPool(), client_id, location_id);
    if (!limitCheck.allowed) {
      return res.status(429).json({
        error: `Weekly generation limit reached (${limitCheck.limit}).`,
        used: limitCheck.used,
        limit: limitCheck.limit,
      });
    }

    const {
      product_name,
      original_price,
      discount_pct,
      event = '',
      theme = 'flash_sale_gold',
      format = 'post',
      product_image_url = '',
      custom_instructions = '',
    } = req.body;

    if (!product_name) return res.status(400).json({ error: 'Product name is required.' });
    const price = parseFloat(original_price);
    const discount = parseInt(discount_pct, 10);
    if (!price || price <= 0) return res.status(400).json({ error: 'Valid original price is required.' });
    if (!discount || discount < 1 || discount > 99) return res.status(400).json({ error: 'Discount must be 1-99%.' });

    // Get store settings for branding
    const settings = await getOrCreateSettings(getIGPool(), client_id, location_id);
    const storeName = settings.store_display_name || req.user.location_name || '';

    // Build prompt
    const prompt = buildDiscountPrompt({
      productName: product_name,
      originalPrice: price,
      discountPct: discount,
      event,
      theme,
      storeName,
      fmt: format,
      customInstructions: custom_instructions,
    });

    // Collect reference images
    const referenceImages = [];

    // Product image - user upload OR auto-search Google
    if (req.file) {
      const b64 = fileToBase64(req.file.path);
      if (b64) referenceImages.push({ base64: b64, label: 'product' });
    } else {
      // Auto-search Google for product image
      try {
        console.log(`[ImageGen] No product image uploaded - searching Google for "${product_name}"`);
        const imageUrls = await searchProductImages(product_name, 3);
        if (imageUrls.length > 0) {
          // Download the first image and convert to base64
          const imgB64 = await downloadImageAsBase64(imageUrls[0]);
          if (imgB64) {
            referenceImages.push({ base64: imgB64, label: 'product' });
            console.log(`[ImageGen] Auto-fetched product image from Google (${imgB64.length} chars)`);
          }
        }
      } catch (searchErr) {
        console.warn(`[ImageGen] Google image search failed: ${searchErr.message} - continuing without product reference`);
      }
    }

    // Store logo
    if (settings.logo_path && fs.existsSync(settings.logo_path)) {
      const b64 = fileToBase64(settings.logo_path);
      if (b64) referenceImages.push({ base64: b64, label: 'logo' });
    }

    // Generate
    let base64;
    if (referenceImages.length > 0) {
      let refPrompt = prompt;
      if (referenceImages.some((r) => r.label === 'product')) {
        refPrompt += '\n\nIMPORTANT: The attached image is the ACTUAL product photo. Use this EXACT bottle/product appearance in the poster - match its shape, label, colors, and branding precisely. Do NOT invent a different bottle design.';
      }
      if (referenceImages.some((r) => r.label === 'logo')) {
        refPrompt += '\nThe other attached image is the store LOGO. Place this logo in the bottom bar, clearly visible.';
      }
      base64 = await generateImageWithReference(refPrompt, referenceImages, format);
    } else {
      base64 = await generateImageTextOnly(prompt, format);
    }

    // Save file
    const tenantDir = getTenantDir(client_id, location_id);
    const safeName = sanitizeName(product_name);
    const filename = `${safeName}_${Date.now()}_discount_promo.png`;
    saveBase64Image(base64, tenantDir, filename);

    // Record in DB
    const relPath = `${client_id}_${location_id}/${filename}`;
    await getIGPool().query(
      `INSERT INTO ig_generations (client_id, location_id, product_name, gen_type, image_path, original_price, discount_pct, event, theme, format, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'completed')`,
      [client_id, location_id, product_name, event ? 'festival' : 'discount', relPath, price, discount, event, theme, format]
    );
    await incrementGeneration(getIGPool(), client_id, location_id);

    // Clean up temp upload
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    res.json({ status: 'success', image_path: relPath });
  } catch (err) {
    console.error('[ImageGen] Discount generation error:', err.message);
    res.status(500).json({ error: 'Failed to generate image: ' + err.message });
  }
});

// ── POST /generate/generic - Brand showcase image ────────────────

router.post('/generate/generic', upload.single('product_image'), async (req, res) => {
  try {
    const { client_id, location_id } = req.user;

    const limitCheck = await checkLimit(getIGPool(), client_id, location_id);
    if (!limitCheck.allowed) {
      return res.status(429).json({ error: `Weekly limit reached (${limitCheck.limit}).` });
    }

    const {
      product_name,
      product_size = '',
      event = '',
      theme = 'flash_sale_gold',
      format = 'post',
      custom_instructions = '',
    } = req.body;

    if (!product_name) return res.status(400).json({ error: 'Product name is required.' });

    const settings = await getOrCreateSettings(getIGPool(), client_id, location_id);
    const storeName = settings.store_display_name || req.user.location_name || '';

    const prompt = buildGenericPrompt({
      productName: product_name,
      productSize: product_size,
      event,
      theme,
      storeName,
      fmt: format,
      customInstructions: custom_instructions,
    });

    const referenceImages = [];

    // Product image - user upload OR auto-search Google
    if (req.file) {
      const b64 = fileToBase64(req.file.path);
      if (b64) referenceImages.push({ base64: b64, label: 'product' });
    } else {
      try {
        console.log(`[ImageGen] No product image uploaded - searching Google for "${product_name}"`);
        const imageUrls = await searchProductImages(product_name, 3);
        if (imageUrls.length > 0) {
          const imgB64 = await downloadImageAsBase64(imageUrls[0]);
          if (imgB64) {
            referenceImages.push({ base64: imgB64, label: 'product' });
            console.log(`[ImageGen] Auto-fetched product image from Google (${imgB64.length} chars)`);
          }
        }
      } catch (searchErr) {
        console.warn(`[ImageGen] Google image search failed: ${searchErr.message}`);
      }
    }

    // Store logo
    if (settings.logo_path && fs.existsSync(settings.logo_path)) {
      const b64 = fileToBase64(settings.logo_path);
      if (b64) referenceImages.push({ base64: b64, label: 'logo' });
    }

    let base64;
    if (referenceImages.length > 0) {
      let refPrompt = prompt;
      if (referenceImages.some((r) => r.label === 'product')) {
        refPrompt += '\n\nIMPORTANT: The attached image is the ACTUAL product photo. Use this EXACT bottle/product appearance - match its shape, label, colors, and branding precisely. Do NOT invent a different bottle design.';
      }
      if (referenceImages.some((r) => r.label === 'logo')) {
        refPrompt += '\nThe other attached image is the store LOGO. Place it in the bottom bar.';
      }
      base64 = await generateImageWithReference(refPrompt, referenceImages, format);
    } else {
      base64 = await generateImageTextOnly(prompt, format);
    }

    const tenantDir = getTenantDir(client_id, location_id);
    const safeName = sanitizeName(product_name);
    const filename = `${safeName}_${Date.now()}_generic_promo.png`;
    saveBase64Image(base64, tenantDir, filename);

    const relPath = `${client_id}_${location_id}/${filename}`;
    await getIGPool().query(
      `INSERT INTO ig_generations (client_id, location_id, product_name, gen_type, image_path, event, theme, format, status)
       VALUES ($1, $2, $3, 'generic', $4, $5, $6, $7, 'completed')`,
      [client_id, location_id, product_name, relPath, event, theme, format]
    );
    await incrementGeneration(getIGPool(), client_id, location_id);

    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    res.json({ status: 'success', image_path: relPath });
  } catch (err) {
    console.error('[ImageGen] Generic generation error:', err.message);
    res.status(500).json({ error: 'Failed to generate image: ' + err.message });
  }
});

// ── POST /generate/video - Disabled (Gemini removed, OpenAI only) ──
router.post('/generate/video', (req, res) => {
  res.status(501).json({ error: 'Video generation is not available. Only image generation via OpenAI is supported.' });
});

// ── POST /generate/bulk - Bulk from CSV/Excel ────────────────────

router.post('/generate/bulk', upload.single('file'), async (req, res) => {
  try {
    const { client_id, location_id } = req.user;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!['.csv', '.xlsx', '.xls'].includes(ext)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Only CSV and Excel files are allowed.' });
    }

    // Parse file
    const workbook = XLSX.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (rawRows.length === 0) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'File is empty.' });
    }

    // Map columns flexibly
    const columnMap = {};
    const firstRow = rawRows[0];
    for (const col of Object.keys(firstRow)) {
      const norm = col.toLowerCase().replace(/[\s_]/g, '');
      if (['productname', 'product', 'name', 'itemname', 'item'].includes(norm)) columnMap[col] = 'product_name';
      else if (['originalprice', 'price', 'mrp', 'regularprice', 'actualprice'].includes(norm)) columnMap[col] = 'original_price';
      else if (['discountedprice', 'discountprice', 'saleprice', 'offerprice', 'finalprice', 'sellingprice'].includes(norm)) columnMap[col] = 'discounted_price';
      else if (['producturl', 'url', 'link', 'image', 'imageurl', 'productimage'].includes(norm)) columnMap[col] = 'product_url';
      else if (['productdescription', 'description', 'desc', 'details'].includes(norm)) columnMap[col] = 'product_description';
    }

    // Normalize rows
    const rows = rawRows.map((raw) => {
      const mapped = {};
      for (const [origCol, normCol] of Object.entries(columnMap)) {
        mapped[normCol] = String(raw[origCol] || '').trim();
      }
      return mapped;
    });

    // Validate required columns
    const has = (col) => rows.some((r) => r[col]);
    if (!has('product_name') || !has('original_price') || !has('discounted_price')) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({
        error: 'Missing required columns: product_name, original_price, discounted_price.',
        found_columns: Object.keys(firstRow),
      });
    }

    // Create batch
    const batchId = `batch_${Date.now()}`;
    batchProgress.set(batchId, { total: rows.length, completed: 0, results: [], status: 'processing' });

    fs.unlinkSync(req.file.path);

    // Process in background
    processBulk(batchId, rows, getIGPool(), client_id, location_id, req.user.location_name).catch((err) => {
      console.error('[ImageGen] Bulk processing error:', err.message);
      const batch = batchProgress.get(batchId);
      if (batch) batch.status = 'error';
    });

    res.json({ status: 'processing', batch_id: batchId, total: rows.length });
  } catch (err) {
    console.error('[ImageGen] Bulk upload error:', err.message);
    res.status(500).json({ error: 'Failed to process file: ' + err.message });
  }
});

async function processBulk(batchId, rows, _pool, clientId, locationId, locationName) {
  const pool = getIGPool();
  const batch = batchProgress.get(batchId);
  const settings = await getOrCreateSettings(pool, clientId, locationId);
  const storeName = settings.store_display_name || locationName || '';

  for (const row of rows) {
    try {
      const limitCheck = await checkLimit(pool, clientId, locationId);
      if (!limitCheck.allowed) {
        batch.results.push({ product_name: row.product_name, status: 'skipped', error: 'Weekly limit reached' });
        batch.completed++;
        continue;
      }

      const origVal = parseFloat(String(row.original_price || '0').replace(/[^0-9.]/g, '')) || 0;
      const discVal = parseFloat(String(row.discounted_price || '0').replace(/[^0-9.]/g, '')) || 0;
      const discountPct = origVal > 0 && discVal < origVal ? Math.round(((origVal - discVal) / origVal) * 100) : 0;

      const prompt = buildDiscountPrompt({
        productName: row.product_name || 'Product',
        originalPrice: origVal,
        discountPct,
        storeName,
      });

      const base64 = await generateImageTextOnly(prompt, 'post');

      const tenantDir = getTenantDir(clientId, locationId);
      const safeName = sanitizeName(row.product_name || 'product');
      const filename = `${safeName}_${Date.now()}_discount_promo.png`;
      saveBase64Image(base64, tenantDir, filename);

      const relPath = `${clientId}_${locationId}/${filename}`;
      await pool.query(
        `INSERT INTO ig_generations (client_id, location_id, product_name, gen_type, image_path, original_price, discount_pct, status)
         VALUES ($1, $2, $3, 'discount', $4, $5, $6, 'completed')`,
        [clientId, locationId, row.product_name, relPath, origVal, discountPct]
      );
      await incrementGeneration(pool, clientId, locationId);

      batch.results.push({ product_name: row.product_name, status: 'success', image_path: relPath });
    } catch (err) {
      batch.results.push({ product_name: row.product_name, status: 'error', error: err.message });
    }
    batch.completed++;
  }
  batch.status = 'done';
}

// ── GET /generate/bulk/:batchId/status - Bulk progress ───────────

router.get('/generate/bulk/:batchId/status', (req, res) => {
  const batch = batchProgress.get(req.params.batchId);
  if (!batch) return res.status(404).json({ error: 'Batch not found.' });
  res.json(batch);
});

// ── GET /gallery - List generations ──────────────────────────────

router.get('/gallery', async (req, res) => {
  try {
    const { client_id, location_id } = req.user;
    const { type, favorite, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    let where = 'WHERE client_id = $1 AND location_id = $2';
    const params = [client_id, location_id];
    let paramIdx = 3;

    if (type && type !== 'all') {
      where += ` AND gen_type = $${paramIdx}`;
      params.push(type);
      paramIdx++;
    }
    if (favorite === 'true') {
      where += ' AND is_favorite = true';
    }

    const countRes = await getIGPool().query(
      `SELECT COUNT(*) FROM ig_generations ${where}`, params
    );
    const total = parseInt(countRes.rows[0].count, 10);

    const dataRes = await getIGPool().query(
      `SELECT id, product_name, gen_type, image_path, original_price, discount_pct,
              event, theme, format, status, is_favorite, created_at
       FROM ig_generations ${where}
       ORDER BY created_at DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, parseInt(limit, 10), offset]
    );

    res.json({
      images: dataRes.rows.map((r) => ({
        ...r,
        media: r.image_path && r.image_path.endsWith('.mp4') ? 'video' : 'image',
      })),
      total,
      page: parseInt(page, 10),
      pages: Math.ceil(total / parseInt(limit, 10)),
    });
  } catch (err) {
    console.error('[ImageGen] Gallery error:', err.message);
    res.status(500).json({ error: 'Failed to load gallery.' });
  }
});

// ── PUT /gallery/:id/favorite - Toggle favorite ──────────────────

router.put('/gallery/:id/favorite', async (req, res) => {
  try {
    const { client_id, location_id } = req.user;
    const { id } = req.params;

    const result = await getIGPool().query(
      `UPDATE ig_generations SET is_favorite = NOT is_favorite
       WHERE id = $1 AND client_id = $2 AND location_id = $3
       RETURNING is_favorite`,
      [id, client_id, location_id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found.' });
    res.json({ status: 'success', is_favorite: result.rows[0].is_favorite });
  } catch (err) {
    console.error('[ImageGen] Favorite toggle error:', err.message);
    res.status(500).json({ error: 'Failed to update.' });
  }
});

// ── DELETE /gallery/:id - Delete generation ──────────────────────

router.delete('/gallery/:id', async (req, res) => {
  try {
    const { client_id, location_id } = req.user;
    const { id } = req.params;

    // Get file path before deleting
    const getRes = await getIGPool().query(
      'SELECT image_path FROM ig_generations WHERE id = $1 AND client_id = $2 AND location_id = $3',
      [id, client_id, location_id]
    );

    if (getRes.rows.length === 0) return res.status(404).json({ error: 'Not found.' });

    // Delete file
    const filePath = path.join(DATA_DIR, getRes.rows[0].image_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    // Delete record
    await getIGPool().query(
      'DELETE FROM ig_generations WHERE id = $1 AND client_id = $2 AND location_id = $3',
      [id, client_id, location_id]
    );

    res.json({ status: 'success' });
  } catch (err) {
    console.error('[ImageGen] Delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete.' });
  }
});

// ── POST /search-product-images - Google image search ────────────

router.post('/search-product-images', async (req, res) => {
  try {
    const { product_name } = req.body;
    if (!product_name) return res.status(400).json({ error: 'Product name required.' });

    const images = await searchProductImages(product_name, 5);
    res.json({ images });
  } catch (err) {
    console.error('[ImageGen] Image search error:', err.message);
    res.json({ images: [], error: err.message });
  }
});

// ── GET /weekly-usage - Usage stats ──────────────────────────────

router.get('/weekly-usage', async (req, res) => {
  try {
    const { client_id, location_id } = req.user;
    const settings = await checkAndResetWeek(getIGPool(), client_id, location_id);

    const totalRes = await getIGPool().query(
      'SELECT COUNT(*) FROM ig_generations WHERE client_id = $1 AND location_id = $2',
      [client_id, location_id]
    );

    res.json({
      weekly_limit: settings.weekly_limit,
      used: settings.generations_this_week,
      remaining: Math.max(0, settings.weekly_limit - settings.generations_this_week),
      total_all_time: parseInt(totalRes.rows[0].count, 10),
    });
  } catch (err) {
    console.error('[ImageGen] Usage error:', err.message);
    res.status(500).json({ error: 'Failed to load usage.' });
  }
});

// ══════════════════════════════════════════════════════════════════
//  SOCIAL POSTING ROUTES
// ══════════════════════════════════════════════════════════════════

// ── POST /caption - Generate AI caption ──────────────────────────

router.post('/caption', async (req, res) => {
  try {
    const { product_name, original_price, discount_pct, event, gen_type, platform } = req.body;
    if (!product_name) return res.status(400).json({ error: 'Product name required.' });

    const caption = await generateCaption({
      productName: product_name,
      originalPrice: parseFloat(original_price) || 0,
      discountPct: parseInt(discount_pct, 10) || 0,
      event: event || '',
      genType: gen_type || 'discount',
      platform: platform || 'instagram',
    });

    res.json({ caption });
  } catch (err) {
    console.error('[ImageGen] Caption error:', err.message);
    res.status(500).json({ error: 'Failed to generate caption.' });
  }
});

// ── GET /social/status - Check Meta connection status ────────────

router.get('/social/status', (req, res) => {
  const { client_id, location_id } = req.user;
  const token = loadToken(client_id, location_id);
  const hasMetaApp = !!(process.env.META_APP_ID && process.env.META_APP_SECRET);

  if (!token) {
    return res.json({ connected: false, has_meta_app: hasMetaApp, accounts: null });
  }

  // Check if token is expired (60 day tokens)
  const ageMs = Date.now() - (token.created_at || 0);
  const expiredMs = (token.expires_in || 5184000) * 1000;
  if (ageMs > expiredMs) {
    deleteToken(client_id, location_id);
    return res.json({ connected: false, expired: true, has_meta_app: hasMetaApp, accounts: null });
  }

  res.json({
    connected: true,
    has_meta_app: hasMetaApp,
    accounts: token.accounts || null,
  });
});

// ── GET /social/connect - Start Meta OAuth flow ──────────────────

router.get('/social/connect', (req, res) => {
  const { client_id, location_id } = req.user;
  const url = getOAuthUrl(client_id, location_id);

  if (!url) {
    return res.status(400).json({
      error: 'Meta API not configured. Add META_APP_ID, META_APP_SECRET, and META_REDIRECT_URI to your .env file.',
    });
  }

  res.json({ oauth_url: url });
});

// ── POST /social/disconnect - Disconnect Meta account ────────────

router.post('/social/disconnect', (req, res) => {
  const { client_id, location_id } = req.user;
  deleteToken(client_id, location_id);
  res.json({ status: 'success' });
});

// ── POST /social/post - Post image to Instagram or Facebook ──────

router.post('/social/post', async (req, res) => {
  try {
    const { client_id, location_id } = req.user;
    const { image_path, caption, platform, account_id } = req.body;

    if (!image_path) return res.status(400).json({ error: 'Image path required.' });
    if (!caption) return res.status(400).json({ error: 'Caption required.' });
    if (!platform) return res.status(400).json({ error: 'Platform required.' });

    const token = loadToken(client_id, location_id);
    if (!token) return res.status(401).json({ error: 'Not connected to Meta. Please connect first.' });

    // The image must be publicly accessible for Meta API
    const serverUrl = process.env.PUBLIC_SERVER_URL || process.env.FRONTEND_URL || `http://localhost:${process.env.PORT || 3000}`;
    const imageUrl = `${serverUrl}/imagegen-files/${image_path}`;

    // Meta API cannot reach localhost - warn the user
    if (imageUrl.includes('localhost') || imageUrl.includes('127.0.0.1')) {
      return res.status(400).json({
        error: 'Direct posting requires a public URL. Your server is running on localhost which Meta cannot reach. Set PUBLIC_SERVER_URL in your .env (e.g., your ngrok URL), or use the Download + manual post option instead.',
      });
    }

    const accounts = token.accounts || {};
    let result;

    if (platform === 'instagram') {
      const igAccount = accounts.instagram_accounts?.find((a) => a.id === account_id)
        || accounts.instagram_accounts?.[0];
      if (!igAccount) return res.status(400).json({ error: 'No Instagram account connected.' });

      result = await postToInstagram({
        igAccountId: igAccount.id,
        pageAccessToken: igAccount.page_access_token,
        imageUrl,
        caption,
      });
    } else if (platform === 'facebook') {
      const fbPage = accounts.facebook_pages?.find((p) => p.id === account_id)
        || accounts.facebook_pages?.[0];
      if (!fbPage) return res.status(400).json({ error: 'No Facebook page connected.' });

      result = await postToFacebook({
        pageId: fbPage.id,
        pageAccessToken: fbPage.access_token,
        imageUrl,
        caption,
      });
    } else {
      return res.status(400).json({ error: 'Unsupported platform. Use "instagram" or "facebook".' });
    }

    // Log the post in DB
    await getIGPool().query(
      `INSERT INTO ig_generations (client_id, location_id, product_name, gen_type, image_path, status)
       VALUES ($1, $2, $3, $4, $5, 'posted')`,
      [client_id, location_id, `Posted to ${platform}`, `post_${platform}`, image_path]
    );

    res.json({ status: 'success', post_id: result.id, platform: result.platform });
  } catch (err) {
    console.error('[ImageGen] Social post error:', err.message);
    res.status(500).json({ error: 'Failed to post: ' + err.message });
  }
});

module.exports = router;
