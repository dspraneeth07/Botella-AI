/**
 * Image Generation - Gemini Veo video generation via REST API.
 * Ported from discount-image-generator/generator.py
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const POLL_INTERVAL_MS = 10000; // 10 seconds
const MAX_POLL_TIME_MS = 300000; // 5 minutes

// ── HTTP helper ───────────────────────────────────────────────────

function httpsRequest(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const data = Buffer.concat(chunks);
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data.toString()) });
        } catch {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => {
      req.destroy(new Error('Request timed out'));
    });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Generate video via Gemini Veo ─────────────────────────────────

async function generateVideo(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured.');

  console.log('[ImageGen] Starting Gemini video generation...');

  // Start long-running operation
  const startUrl = `https://generativelanguage.googleapis.com/v1beta/models/veo-2:predictLongRunning?key=${apiKey}`;
  const startRes = await httpsRequest(startUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, {
    instances: [{ prompt }],
    parameters: { aspectRatio: '9:16', durationSeconds: 8 },
  });

  if (startRes.status !== 200) {
    throw new Error(`Gemini API error ${startRes.status}: ${JSON.stringify(startRes.data)}`);
  }

  const operationName = startRes.data.name;
  if (!operationName) {
    throw new Error('No operation name returned from Gemini');
  }

  console.log(`[ImageGen] Operation started: ${operationName}`);

  // Poll for completion
  let elapsed = 0;
  while (elapsed < MAX_POLL_TIME_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    elapsed += POLL_INTERVAL_MS;

    const pollUrl = `https://generativelanguage.googleapis.com/v1beta/${operationName}?key=${apiKey}`;
    const pollRes = await httpsRequest(pollUrl, { method: 'GET' });

    if (pollRes.data.done) {
      console.log(`[ImageGen] Video generation complete (${elapsed / 1000}s)`);

      const response = pollRes.data.response;
      if (!response || !response.predictions || response.predictions.length === 0) {
        throw new Error('No video returned from Gemini');
      }

      // Return base64 video data
      const video = response.predictions[0];
      if (video.bytesBase64Encoded) {
        return video.bytesBase64Encoded;
      }
      // If video has a URI, download it
      if (video.videoUri) {
        return { uri: video.videoUri };
      }
      throw new Error('Unexpected video response format');
    }

    console.log(`[ImageGen] Polling... (${elapsed / 1000}s elapsed)`);
  }

  throw new Error(`Video generation timed out after ${MAX_POLL_TIME_MS / 1000}s`);
}

// ── Save video to disk ────────────────────────────────────────────

function saveVideoFile(base64Data, outputDir, filename) {
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, filename);
  const buffer = Buffer.from(base64Data, 'base64');
  fs.writeFileSync(filePath, buffer);
  console.log(`[ImageGen] Video saved: ${filePath}`);
  return filePath;
}

module.exports = { generateVideo, saveVideoFile };
