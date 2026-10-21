/**
 * Image Generation - Unified engine (OpenAI or Gemini).
 *
 * Auto-selects engine:
 *   - If OPENAI_API_KEY is set → uses OpenAI (gpt-image-1)
 *   - Else if GEMINI_API_KEY is set → uses Gemini (imagen-3)
 *   - Else → throws error
 *
 * The route layer doesn't need to know which engine is active.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { OPENAI_SIZE_MAP } = require('./imagegen-prompts');

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

// ── Engine detection ──────────────────────────────────────────────

function getActiveEngine() {
  const openaiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (openaiKey && openaiKey !== 'your_openai_api_key_here') return 'openai';
  throw new Error('No image generation API key configured. Set OPENAI_API_KEY in your .env file.');
}

// ══════════════════════════════════════════════════════════════════
//  OPENAI ENGINE
// ══════════════════════════════════════════════════════════════════

let _openaiClient = null;

function getOpenAIClient() {
  if (_openaiClient) return _openaiClient;
  const OpenAI = require('openai');
  _openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openaiClient;
}

async function openaiTextOnly(prompt, fmt) {
  const client = getOpenAIClient();
  const size = OPENAI_SIZE_MAP[fmt] || '1024x1024';
  const response = await client.images.generate({
    model: 'gpt-image-1',
    prompt,
    size,
    quality: 'high',
  });
  return response.data[0].b64_json;
}

// Resize base64 image to max dimensions (prevents oversized reference images)
function resizeBase64(base64Str, maxSize = 512) {
  // We can't use PIL in Node, but we can limit what we send
  // If the base64 is too large (>2MB), it'll slow down the API
  // For now, just pass through - OpenAI handles resizing server-side
  return base64Str;
}

async function openaiWithReference(prompt, referenceImages, fmt) {
  const client = getOpenAIClient();
  const size = OPENAI_SIZE_MAP[fmt] || '1024x1024';

  const contentParts = [];
  for (const img of referenceImages) {
    contentParts.push({
      type: 'input_image',
      image_url: `data:image/png;base64,${img.base64}`,
    });
  }
  contentParts.push({ type: 'input_text', text: prompt });

  const response = await client.responses.create({
    model: 'gpt-4.1',
    input: [{ role: 'user', content: contentParts }],
    tools: [{ type: 'image_generation', quality: 'high', size }],
    tool_choice: { type: 'image_generation' },
  });

  for (const block of response.output) {
    if (block.type === 'image_generation_call') {
      return block.result;
    }
  }
  throw new Error('No image_generation_call found in OpenAI response');
}

// ══════════════════════════════════════════════════════════════════
//  GEMINI ENGINE (Imagen 3)
// ══════════════════════════════════════════════════════════════════

const GEMINI_SIZE_MAP = {
  post: { width: 1024, height: 1024 },   // square
  story: { width: 768, height: 1366 },   // 9:16 vertical (closest supported)
};

function geminiRequest(url, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          const data = JSON.parse(raw);
          if (res.statusCode >= 400) {
            const errMsg = data?.error?.message || `Gemini API error ${res.statusCode}`;
            reject(new Error(errMsg));
          } else {
            resolve(data);
          }
        } catch {
          reject(new Error(`Gemini returned non-JSON (status ${res.statusCode}): ${raw.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(new Error('Gemini request timed out')); });
    req.write(postData);
    req.end();
  });
}

async function geminiTextOnly(prompt, fmt) {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${apiKey}`;

  const response = await geminiRequest(url, {
    instances: [{ prompt }],
    parameters: {
      sampleCount: 1,
      aspectRatio: fmt === 'story' ? '9:16' : '1:1',
    },
  });

  // Extract base64 image
  const predictions = response.predictions || [];
  if (predictions.length === 0) {
    throw new Error('Gemini returned no images. The prompt may have been blocked by safety filters.');
  }

  const b64 = predictions[0].bytesBase64Encoded;
  if (!b64) throw new Error('Gemini response missing image data.');
  return b64;
}

async function geminiWithReference(prompt, referenceImages, fmt) {
  // Gemini Imagen doesn't support reference images in the same way as OpenAI.
  // We append a note to the prompt and use text-only generation.
  console.log('[ImageGen] Gemini: reference images not supported by Imagen - using text-only with enhanced prompt');

  let enhancedPrompt = prompt;
  if (referenceImages.some((r) => r.label === 'product')) {
    enhancedPrompt += '\n\nNote: Generate the product bottle based on the product name described above. Make it photorealistic and accurate.';
  }
  if (referenceImages.some((r) => r.label === 'logo')) {
    enhancedPrompt += '\nNote: Include the store name text prominently in the footer bar as described.';
  }

  return geminiTextOnly(enhancedPrompt, fmt);
}

// ══════════════════════════════════════════════════════════════════
//  PUBLIC API (used by routes/imagegen.js)
// ══════════════════════════════════════════════════════════════════

async function generateImageTextOnly(prompt, fmt = 'post') {
  getActiveEngine(); // validates key exists
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[ImageGen] Attempt ${attempt}/${MAX_RETRIES} - openai text-only`);
      return await openaiTextOnly(prompt, fmt);
    } catch (err) {
      lastError = err;
      console.error(`[ImageGen] Attempt ${attempt} failed: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        const wait = RETRY_DELAY_MS * attempt;
        console.log(`[ImageGen] Retrying in ${wait}ms...`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastError;
}

async function generateImageWithReference(prompt, referenceImages = [], fmt = 'post') {
  getActiveEngine(); // validates key exists
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[ImageGen] Attempt ${attempt}/${MAX_RETRIES} - openai with-reference`);
      return await openaiWithReference(prompt, referenceImages, fmt);
    } catch (err) {
      lastError = err;
      console.error(`[ImageGen] Attempt ${attempt} failed: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        const wait = RETRY_DELAY_MS * attempt;
        console.log(`[ImageGen] Retrying in ${wait}ms...`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastError;
}

/** Reset clients (e.g. when API key changes). */
function resetClient() {
  _openaiClient = null;
}

// ── File utilities ────────────────────────────────────────────────

function saveBase64Image(base64Data, outputDir, filename) {
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, filename);
  const buffer = Buffer.from(base64Data, 'base64');
  fs.writeFileSync(filePath, buffer);
  console.log(`[ImageGen] Image saved: ${filePath}`);
  return filePath;
}

function fileToBase64(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath).toString('base64');
}

module.exports = {
  getActiveEngine,
  resetClient,
  generateImageTextOnly,
  generateImageWithReference,
  saveBase64Image,
  fileToBase64,
};
