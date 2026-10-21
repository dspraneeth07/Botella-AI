// Cross-browser clipboard helper.
//
// navigator.clipboard.writeText() is the modern API but only works on:
//   - HTTPS origins (and localhost as a secure-context exception)
//   - Browsers that implement the Async Clipboard API
//
// It silently rejects on HTTP deploys and on iOS Safari <13. This helper
// tries the modern API first and falls back to the legacy `document.execCommand('copy')`
// trick for older / insecure contexts.
//
// Returns a Promise<boolean> - true on success, false if nothing worked.
export async function copyToClipboard(text) {
  if (text == null) return false;
  const str = String(text);

  // Modern path - secure contexts only.
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(str);
      return true;
    } catch {
      // fall through to legacy path
    }
  }

  // Legacy fallback via a hidden textarea + execCommand('copy').
  try {
    const ta = document.createElement('textarea');
    ta.value = str;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, str.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
