#!/usr/bin/env node
/**
 * Postbuild: keep the Netlify STAGING site out of Google, without touching the
 * AWS PRODUCTION site.
 *
 * Runs after `react-scripts build`. It writes a Netlify `_headers` rule that
 * sends `X-Robots-Tag: noindex` on every response, so search engines drop the
 * staging URLs from their index.
 *
 * Scope — why this can never affect production (botella.ai on AWS):
 *  - It only fires when `NETLIFY=true`, which Netlify sets automatically in its
 *    build environment. Your AWS build never sets it, so this is a no-op there.
 *  - `_headers` is a Netlify-only feature anyway; AWS/nginx/CloudFront ignore it.
 *  - Escape hatch: set STAGING_NOINDEX=false to force-disable (e.g. if a Netlify
 *    deploy should ever be indexed), or =true to force-enable off Netlify.
 *
 * Why a header and not `Disallow` in robots.txt:
 *  - robots.txt only blocks CRAWLING, not indexing; an already-indexed staging
 *    URL can linger in results. `noindex` is the signal that removes it.
 *  - A `Disallow` would STOP Google from crawling the page, so it could never
 *    see the noindex — leaving it indexed. So robots.txt stays as-is (allowing
 *    crawl) and we rely on the header.
 */
const fs = require('fs');
const path = require('path');

const onNetlify = String(process.env.NETLIFY || '').toLowerCase() === 'true';
const forced = String(process.env.STAGING_NOINDEX || '').toLowerCase();
const enabled = forced === 'true' || (onNetlify && forced !== 'false');

if (!enabled) {
  console.log('[apply-noindex] not a Netlify/staging build — no noindex applied (production stays indexable).');
  process.exit(0);
}

const buildDir = path.join(__dirname, '..', 'build');
const headersPath = path.join(buildDir, '_headers');
const RULE = '/*\n  X-Robots-Tag: noindex\n';

let existing = '';
try {
  existing = fs.readFileSync(headersPath, 'utf8');
} catch {
  /* no _headers yet — we create it */
}

if (existing.includes('X-Robots-Tag')) {
  console.log('[apply-noindex] _headers already carries X-Robots-Tag — leaving as is.');
  process.exit(0);
}

const out = existing ? `${existing.trimEnd()}\n\n${RULE}` : RULE;
fs.writeFileSync(headersPath, out);
console.log(`[apply-noindex] Netlify/staging build — wrote X-Robots-Tag: noindex to ${headersPath}`);
