function getStorageKey() {
  const username = localStorage.getItem('botella_username') || 'default';
  return `botella_conversations_${username}`;
}

export function loadConversations() {
  try {
    const raw = localStorage.getItem(getStorageKey());
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveConversations(conversations) {
  try {
    localStorage.setItem(getStorageKey(), JSON.stringify(conversations));
  } catch (e) {
    console.warn('Failed to save conversations:', e.message);
  }
}

// Generates an RFC-4122 v4 UUID (GUID).
// Uses the browser's built-in crypto.randomUUID() when available (HTTPS or
// localhost on every modern browser) and falls back to a manual implementation
// using crypto.getRandomValues() so it still works on insecure contexts and
// older Safari / Firefox versions that lack randomUUID.
export function generateId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: build a v4 UUID manually
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    // Last-resort: Math.random() - only used when crypto is entirely unavailable
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  // Set version (4) and variant bits per RFC 4122
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return (
    hex.slice(0, 4).join('') + '-' +
    hex.slice(4, 6).join('') + '-' +
    hex.slice(6, 8).join('') + '-' +
    hex.slice(8, 10).join('') + '-' +
    hex.slice(10, 16).join('')
  );
}

export function deriveTitle(messages) {
  const firstUserMsg = messages.find((m) => m.role === 'user');
  if (!firstUserMsg) return 'New Chat';
  const text = firstUserMsg.text.trim();
  return text.length > 50 ? text.slice(0, 50) + '...' : text;
}

// ─── Pinned conversations ────────────────────────────────────────────────
// Pin state lives client-side only. The backend conversations API has no
// `pinned` column, and pinning is a per-user/per-device preference anyway.
// Stored as an array of conversation IDs under a per-user key so multiple
// accounts on the same browser don't see each other's pins.
function getPinnedKey() {
  const username = localStorage.getItem('botella_username') || 'default';
  return `botella_pinned_${username}`;
}

export function loadPinnedIds() {
  try {
    const raw = localStorage.getItem(getPinnedKey());
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

export function savePinnedIds(set) {
  try {
    localStorage.setItem(getPinnedKey(), JSON.stringify([...set]));
  } catch (e) {
    console.warn('Failed to save pinned ids:', e.message);
  }
}
