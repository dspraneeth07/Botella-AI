/* =============================================================================
   TASKLIST - the owner's saved "I'll do this" list
   -----------------------------------------------------------------------------
   Browser-local for now. Everything that touches storage lives behind the small
   API below, so swapping in a real endpoint later is a change to this file and
   nothing else: the components only ever call listTasks/addTask/removeTask/
   toggleDone/subscribe.

   Keyed per store, because one browser can be signed into more than one
   location and a task belongs to the store it was raised against.
   ============================================================================= */

const KEY_PREFIX = 'botella_tasklist_';
const EVENT = 'botella:tasklist';

function storeKey() {
  let id = '';
  try {
    id = localStorage.getItem('botella_location_id')
      || localStorage.getItem('botella_location_name')
      || 'default';
  } catch {
    id = 'default';
  }
  return KEY_PREFIX + id;
}

function read() {
  try {
    const raw = localStorage.getItem(storeKey());
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Corrupt or unavailable storage must not take the dashboard down with it.
    return [];
  }
}

function write(tasks) {
  try {
    localStorage.setItem(storeKey(), JSON.stringify(tasks));
  } catch {
    /* quota or private mode - the in-memory list for this session still works */
  }
  // `storage` only fires in OTHER tabs, so panels in THIS tab need their own
  // nudge to re-read.
  try {
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    /* non-browser env */
  }
}

export function listTasks() {
  return read();
}

// A recommendation's identity: its own id where the backend gave one, else a
// stable digest of what the card actually says, so the same card cannot be
// added twice across reloads.
export function taskIdFor(rec) {
  if (rec?.id != null) return `rec:${rec.id}`;
  const lead = rec?.products?.[0]?.product_name || rec?.primary_skus?.[0] || '';
  return `rec:${rec?.action_type || 'act'}:${lead}:${(rec?.rationale || '').slice(0, 48)}`;
}

export function isSaved(rec) {
  const id = taskIdFor(rec);
  return read().some((t) => t.id === id);
}

export function addTask(rec, extra = {}) {
  const id = taskIdFor(rec);
  const tasks = read();
  if (tasks.some((t) => t.id === id)) return tasks;
  const lead = rec?.products?.[0] || {};
  const next = [
    {
      id,
      title: extra.title || lead.product_name || lead.sku || 'Recommendation',
      action: rec?.action_type || null,
      category: rec?.category || null,
      rationale: rec?.rationale || '',
      priority: extra.priority || null,
      rank: rec?.rank ?? null,
      confidence: rec?.confidence ?? null,
      done: false,
      addedAt: new Date().toISOString(),
    },
    ...tasks,
  ];
  write(next);
  return next;
}

export function removeTask(id) {
  const next = read().filter((t) => t.id !== id);
  write(next);
  return next;
}

export function toggleDone(id) {
  const next = read().map((t) => (t.id === id ? { ...t, done: !t.done } : t));
  write(next);
  return next;
}

// Fires for same-tab writes (the custom event) and other-tab writes (`storage`).
export function subscribe(fn) {
  const handler = () => fn(read());
  window.addEventListener(EVENT, handler);
  window.addEventListener('storage', handler);
  return () => {
    window.removeEventListener(EVENT, handler);
    window.removeEventListener('storage', handler);
  };
}
