/**
 * Image Generation - Product image search.
 * Uses DuckDuckGo image search (no API key needed, no anti-bot blocks).
 */

const https = require('https');

/**
 * Fetch a URL and return the response body as a string.
 */
function fetchUrl(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      timeout: timeoutMs,
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrl(res.headers.location, timeoutMs).then(resolve).catch(reject);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * Search for product images using DuckDuckGo.
 * Returns up to `count` image URLs.
 */
async function searchProductImages(productName, count = 5) {
  try {
    // Step 1: Get a vqd token from DuckDuckGo
    const query = `${productName} bottle product photo`;
    const encodedQuery = encodeURIComponent(query);
    const tokenPage = await fetchUrl(`https://duckduckgo.com/?q=${encodedQuery}&t=h_&iax=images&ia=images`);

    // Extract vqd token
    const vqdMatch = tokenPage.match(/vqd=["']?([^"'&]+)/);
    if (!vqdMatch) {
      console.warn('[ImageGen] Could not get DuckDuckGo vqd token - trying fallback');
      return await searchWithBing(productName, count);
    }
    const vqd = vqdMatch[1];

    // Step 2: Fetch image results JSON
    const apiUrl = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodedQuery}&vqd=${vqd}&f=size:Medium,type:photo&p=1`;
    const jsonStr = await fetchUrl(apiUrl);
    const data = JSON.parse(jsonStr);

    const skipPatterns = ['favicon', 'logo', 'icon', '1x1', 'pixel', 'tracking'];
    const results = [];

    for (const item of (data.results || [])) {
      const imgUrl = item.image || item.thumbnail;
      if (!imgUrl) continue;
      const lower = imgUrl.toLowerCase();
      if (skipPatterns.some((s) => lower.includes(s))) continue;
      results.push(imgUrl);
      if (results.length >= count) break;
    }

    console.log(`[ImageGen] DuckDuckGo found ${results.length} images for "${productName}"`);
    return results;
  } catch (err) {
    console.warn(`[ImageGen] DuckDuckGo search failed: ${err.message} - trying Bing fallback`);
    return await searchWithBing(productName, count);
  }
}

/**
 * Fallback: Search Bing Images (scraping, no API key).
 */
async function searchWithBing(productName, count = 5) {
  try {
    const query = encodeURIComponent(`${productName} bottle product photo`);
    const html = await fetchUrl(`https://www.bing.com/images/search?q=${query}&form=HDRSC2&first=1`);

    const imgRegex = /murl&quot;:&quot;(https?:\/\/[^&]+?\.(?:jpg|jpeg|png|webp))/gi;
    const skipPatterns = ['bing.com', 'microsoft.com', 'favicon', 'logo', 'icon'];
    const results = [];
    let match;

    while ((match = imgRegex.exec(html)) !== null) {
      const imgUrl = match[1];
      const lower = imgUrl.toLowerCase();
      if (skipPatterns.some((s) => lower.includes(s))) continue;
      results.push(imgUrl);
      if (results.length >= count) break;
    }

    console.log(`[ImageGen] Bing found ${results.length} images for "${productName}"`);
    return results;
  } catch (err) {
    console.error(`[ImageGen] Bing search also failed: ${err.message}`);
    return [];
  }
}

module.exports = { searchProductImages };
