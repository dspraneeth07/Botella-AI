import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, memo } from 'react';
import { flushSync } from 'react-dom';
import {
  Send,
  User,
  PanelLeftOpen,
  PanelLeftClose,
  Square,
  Copy,
  Check,
  Wine,
  BarChart3,
  Package,
  Users,
  Tag,
  ShoppingCart,
  Pencil,
  RefreshCw,
  X,
  LogOut,
  Lightbulb,
  LayoutDashboard,
  Printer,
} from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import VoiceMicButton from '../components/VoiceMicButton';
import DeadStockPopup from '../components/DeadStockPopup';
import RecommendationsView from '../components/RecommendationsView';
import Dashboard from '../components/Dashboard';
import StatisticsPage from './StatisticsPage';
import InsightSummary from '../components/InsightSummary';
import CommandCenter from '../components/CommandCenter';
import RecommendationsHome from '../components/RecommendationsHome';
import PurchasingScreen from '../components/PurchasingScreen';
import PurchaseOrdersScreen from '../components/PurchaseOrdersScreen';
import CardStatementsScreen from '../components/CardStatementsScreen';
import MarketComparisonScreen from '../components/MarketComparisonScreen';
import CustomersScreen from '../components/CustomersScreen';
import EffectivenessScreen from '../components/EffectivenessScreen';
import BottleSenseScreen from '../components/BottleSenseScreen';
import StartupDigest from '../components/StartupDigest';
import { ChatFeedbackPopup, SessionFeedbackToast } from '../components/Feedback';
import MarketAnalysisPage from '../components/MarketAnalysisPage';
import AskBar from '../components/AskBar';
import { useTheme } from '../utils/useTheme';
import { clearSession } from '../utils/session';
import {
  loadConversations,
  saveConversations,
  generateId,
  deriveTitle,
  loadPinnedIds,
  savePinnedIds,
} from '../utils/storage';
import { copyToClipboard } from '../utils/clipboard';
import { API_BASE as ENV_API_BASE, API_ORIGIN as ENV_API_ORIGIN } from '../utils/env';
import { isHiddenView } from '../utils/features';
import { displayStoreName } from '../utils/storeIdentity';

const API_BASE = ENV_API_BASE;

const INITIAL_MESSAGE = {
  role: 'assistant',
  text: "Hello! I'm **Botella** - your intelligent liquor store assistant. I can query your database and answer questions about sales, inventory, profitability, vendors, customers, and more.\n\nTry asking me anything!",
};

/* A message's day, named the way people say it.
 *
 * Messages only started carrying `at` once this shipped, so anything from an
 * older conversation has no time of its own. Those fall back to the
 * conversation's own date, which puts the whole thread under one heading
 * rather than under none - honest about what is known, and it improves by
 * itself as new messages arrive.
 *
 * Calendar days, not 24-hour blocks: 11pm and 1am are an hour apart and belong
 * to different days. */
function dayStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }

function dayLabel(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const days = Math.round((dayStart(new Date()) - dayStart(d)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  if (days < 365) return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

const SUGGESTIONS = [
  { text: 'What are the top selling products?', icon: BarChart3 },
  { text: 'Show me low stock items', icon: Package },
  { text: 'What is the total inventory value?', icon: Wine },
  { text: 'Who are the top customers?', icon: Users },
  { text: 'Show active promotions', icon: Tag },
  { text: "What are today's sales?", icon: ShoppingCart },
];

const ACTIVE_ID_KEY = 'botella_active_conversation';

// Escape HTML to prevent XSS
const escapeHtml = (str) =>
  str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Helper - builds a clean borderless data view from markdown-style table rows
// Long dashes are house-banned in Botella's own copy, and an assistant reply is
// Botella's copy. The model is told not to write them (routes/chat.js, RESPONSE
// RULES), but a prompt is guidance; this is the guarantee.
//
// The rule is simply LONG -> SHORT: an em dash (U+2014) or en dash (U+2013)
// becomes a plain ASCII hyphen, and the spacing around it is left exactly as it
// was. That matches the house style already used in the site's own copy
// ("Botella - the AI operating system for retail - in production") and it is
// predictable, which matters more here than cleverness: an earlier version
// rewrote dashes into commas and colons by context, which meant the same
// sentence could come back punctuated two different ways depending on whether
// the model happened to bold the word before it.
//
// An ASCII hyphen already inside a word ("top-selling") is a different
// character and is never touched.
export function deDash(text) {
  if (!text) return text;
  return String(text).replace(/[\u2013\u2014]/g, '-');
}

// Note: cell content is already escaped & markdown-processed by renderMarkdown, so no extra escaping here
//
// BOTELLA-11 fix: previously we did `.filter(c => c.trim() !== '')` which dropped
// every empty cell, including inner ones. For a row like `| a | b |  | d | e |`
// (an empty Category cell, which Claude legitimately emits when the product has
// no category) the filter removed the middle empty AND the leading/trailing
// empties together, leaving 4 cells instead of 5 - every column right of the
// blank shifted left by one. The fix: split on `|`, drop only the FIRST and
// LAST entries (which are always empty because every row begins and ends with
// `|`), and replace any remaining empty inner cell with an em-dash so the
// column count stays in sync with the header.
const buildTable = (rows, downloadId = null) => {
  if (rows.length === 0) return '';
  const cells = rows.map((r) => {
    const parts = r.split('|');
    // parts[0] and parts[parts.length-1] are always the empty strings before
    // the leading `|` and after the trailing `|` - drop them as syntax markers.
    return parts.slice(1, -1).map((c) => {
      const t = c.trim();
      return t === '' ? '-' : t;
    });
  });
  const header = cells[0];
  const body = cells.slice(1);

  // Build CSV payload for download button (strip HTML tags from cells). This
  // payload is the FALLBACK - used when no downloadId was emitted by the
  // backend (small results, or tool calls that bypassed run_sql). When a
  // downloadId IS present, the click handler ignores this and fetches the
  // full result-set from /api/chat/csv/:id instead, so the download contains
  // every matching row, not just the 20 the user can see.
  const stripTags = (s) => s.replace(/<[^>]*>/g, '');
  const csvLines = [header, ...body]
    .map((row) => row.map((cell) => `"${stripTags(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const csvEncoded = encodeURIComponent(csvLines);
  const dlAttr = downloadId ? ` data-download-id="${downloadId}"` : '';
  const titleText = downloadId ? 'Download as CSV (all rows)' : 'Download as CSV';

  let html = `<div class="chat-data-wrapper">`;
  html += `<button class="chat-csv-btn" data-csv="${csvEncoded}"${dlAttr} title="${titleText}">&#8595;&nbsp;CSV</button>`;
  html += '<div class="chat-data-view">';
  html += '<div class="chat-data-header">';
  header.forEach((h) => (html += `<span class="chat-data-col">${h}</span>`));
  html += '</div>';
  body.forEach((row) => {
    html += '<div class="chat-data-row">';
    row.forEach((c, i) => (html += `<span class="chat-data-col" data-label="${header[i] || ''}">${c}</span>`));
    html += '</div>';
  });
  html += '</div></div>';
  return html;
};

// Simple streaming renderer - no table parsing, just text + bold + code
// Tables render as plain text during streaming; full parsing happens after completion
const renderStreaming = (text) => {
  // Same deDash as renderMarkdown: without it a dash shows for the whole of the
  // stream and then disappears when the message is committed, which reads as a
  // glitch even though the end state is right.
  let html = escapeHtml(deDash(text))
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.*?)`/g, '<code>$1</code>');
  // Strip markdown table separator rows and pipe chars for cleaner streaming display
  const lines = html.split('\n');
  const result = [];
  let inList = false;
  const closeList = () => { if (inList) { result.push('</ul>'); inList = false; } };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { closeList(); continue; }
    // Skip separator rows like |---|---|
    if (/^\|[\s\-:|]+\|$/.test(trimmed)) continue;
    // Hide the download marker during streaming - there's no CSV button on
    // the streaming bubble (it only appears once the message is committed),
    // so the marker would just look like junk text to the user.
    if (/^\[download:[a-f0-9]{16}\]$/i.test(trimmed)) continue;
    // Headings: ###/##/# text
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      closeList();
      const level = Math.min(headingMatch[1].length, 6);
      result.push(`<h${level}>${headingMatch[2]}</h${level}>`);
      continue;
    }
    // Bulleted list items: -, *, + prefix
    const bulletMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (bulletMatch) {
      if (!inList) { result.push('<ul>'); inList = true; }
      result.push(`<li>${bulletMatch[1]}</li>`);
      continue;
    }
    // Numbered list items: "1. text"
    const numberedMatch = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (numberedMatch) {
      if (!inList) { result.push('<ul>'); inList = true; }
      result.push(`<li>${numberedMatch[1]}</li>`);
      continue;
    }
    closeList();
    // Convert table rows to clean text. Same BOTELLA-11 logic as buildTable -
    // only strip the leading/trailing syntax-marker empties, and keep inner
    // empties as em-dashes so columns don't collapse during streaming.
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const parts = trimmed.split('|');
      const cells = parts.slice(1, -1).map((c) => {
        const t = c.trim();
        return t === '' ? '-' : t;
      });
      result.push(`<p>${cells.join('&nbsp;&nbsp;&nbsp;&nbsp;')}</p>`);
    } else {
      result.push(`<p>${trimmed}</p>`);
    }
  }
  closeList();
  return result.join('');
};

// Lightweight streaming bubble - updates DOM directly via ref to avoid React
// re-render overhead.
//
// CRITICAL: this MUST be `useLayoutEffect`, not `useEffect`. With `useEffect`,
// the innerHTML update is queued for AFTER the browser paint. Combined with
// the `flushSync(setStreamingText(...))` in the SSE delta handler, the React
// commit happens synchronously but the actual DOM write is deferred - so even
// though we call setStreamingText per-token, the browser only ever sees the
// LATEST innerHTML when it finally paints, collapsing every per-token update
// into one visible jump. `useLayoutEffect` runs synchronously during the
// commit phase (inside flushSync), so innerHTML is written before each
// `await requestAnimationFrame` yield gives the browser a paint frame.
const StreamingBubble = memo(({ text }) => {
  const bubbleRef = useRef(null);
  const lastTextRef = useRef('');

  useLayoutEffect(() => {
    if (!bubbleRef.current || text === lastTextRef.current) return;
    lastTextRef.current = text;
    const clean = text.replace(/<<FOLLOWUPS>>.*$/s, '');
    bubbleRef.current.innerHTML = renderStreaming(clean);
  }, [text]);

  return <div className="chat-bubble chat-bubble-streaming" ref={bubbleRef} />;
});

function ChatPage() {
  const navigate = useNavigate();
  const authToken = localStorage.getItem('botella_token');

  const getAuthHeaders = () => ({
    'Content-Type': 'application/json',
    'ngrok-skip-browser-warning': 'true',
    ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
  });

  const handleAuthError = (res) => {
    if (res.status === 401) {
      clearSession(); // auth keys + idle timestamp + storeagent cache
      navigate('/login');
      return true;
    }
    return false;
  };

  const [showLogoutModal, setShowLogoutModal] = useState(false);

  // ── View routing ─────────────────────────────────────────────────────
  // activeView is derived from the URL so that /chat, /dashboard,
  // /suggestions, and /market-analysis each correspond to a distinct
  // tab. This gives users deep links, working back/forward buttons, and
  // proper analytics pageviews.
  const location = useLocation();
  // Every view here must also have a matching path in App.js's
  // APP_VIEW_PATHS, or navigating to it falls through to the 404 route.
  const VALID_VIEWS = ['chat', 'recommendations', 'purchasing', 'purchase-orders', 'card-statements', 'market', 'customers', 'effectiveness', 'command', 'summary', 'dashboard', 'reports', 'suggestions', 'market-analysis', 'bottlesense'];
  // G1: the screen is Reports and lives at /reports. The old /statistics path
  // stays a permanent alias so existing links and bookmarks keep working.
  const LEGACY_VIEW_ALIASES = { statistics: 'reports' };
  // A view withdrawn by a feature flag is treated as unknown, not as valid:
  // activeView comes from the URL, so a nav item removed from the sidebar does
  // nothing for /effectiveness typed, bookmarked, or sitting in a tester's
  // history. Both the address bar and in-app navigation resolve through the
  // same guard, so neither is a side door. See utils/features.js.
  const viewFromPath = (pathname) => {
    const slug = (pathname || '').replace(/^\/+/, '').split('/')[0];
    const resolved = LEGACY_VIEW_ALIASES[slug] || slug;
    return (VALID_VIEWS.includes(resolved) && !isHiddenView(resolved))
      ? resolved
      : 'recommendations';
  };
  const activeView = viewFromPath(location.pathname);
  const setActiveView = (view) => {
    // Resolve the alias here too, not only in viewFromPath. It was applied to
    // URLs but not to in-app navigation, so setActiveView('statistics') fell
    // through to the 'recommendations' fallback - a caller asking for Reports
    // was silently sent somewhere else, with nothing logged. Any unknown view
    // still lands on recommendations rather than a blank screen, but a name
    // the app knows an alias for now goes where it means.
    const resolved = LEGACY_VIEW_ALIASES[view] || view;
    const target = (VALID_VIEWS.includes(resolved) && !isHiddenView(resolved))
      ? resolved
      : 'recommendations';
    if (target !== activeView) { navigate(`/${target}`); return; }
    // Already here. A screen with its own drill-down is NOT already where the
    // reader asked to go: pressing "Purchase Orders" while reading one invoice
    // did nothing at all, because the view had not changed and the open
    // document lives in that screen's own state. Announce the re-navigation so
    // the screen can return to its top level.
    try { window.dispatchEvent(new CustomEvent('botella-renav', { detail: target })); } catch { /* no-op */ }
  };
  // G1: normalise a legacy alias in the address bar to its canonical path, so a
  // bookmarked /statistics lands on /reports rather than lingering on the old
  // URL. replace: true keeps the alias out of the back-button history.
  const legacySlug = (location.pathname || '').replace(/^\/+/, '').split('/')[0];
  useEffect(() => {
    if (LEGACY_VIEW_ALIASES[legacySlug]) {
      navigate(`/${LEGACY_VIEW_ALIASES[legacySlug]}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legacySlug]);

  // Seven-item navigation (v7.2 restructure). Maps each sidebar item to the
  // screen that serves it today; the not-yet-rebuilt reference screens deep-link
  // into the existing Store-Intelligence / Statistics / Chat surfaces.
  // Which sidebar item is highlighted is derived from the current view (URL),
  // not click state - so a direct load or refresh of /market, /customers, etc.
  // lights up the right item. Views that a nav item deep-links into map back to
  // that item here (reports keeps its own nav item, suggestions → effectiveness).
  const VIEW_TO_NAV = {
    recommendations: 'recommendations', purchasing: 'purchasing', 'purchase-orders': 'purchase-orders', market: 'market',
    customers: 'customers', effectiveness: 'effectiveness', reports: 'reports', suggestions: 'effectiveness', chat: 'ask',
    bottlesense: 'bottlesense', 'card-statements': 'card-statements',
  };
  const navKey = VIEW_TO_NAV[activeView] || 'recommendations';
  const goNav = (key) => {
    setSidebarOpen(false);
    const openSA = (tab) => { try { sessionStorage.setItem('botella_open_storeagent', '1'); sessionStorage.setItem('botella_storeagent_tab', tab); } catch { /* no-op */ } };
    switch (key) {
      case 'recommendations': setActiveView('recommendations'); break;
      case 'purchasing': setActiveView('purchasing'); break;
      case 'market': setActiveView('market'); break;
      case 'customers': setActiveView('customers'); break;
      case 'purchase-orders': setActiveView('purchase-orders'); break;
      case 'card-statements': setActiveView('card-statements'); break;
      case 'reports': setActiveView('reports'); break;
      case 'effectiveness': setActiveView('effectiveness'); break;
      case 'bottlesense': setActiveView('bottlesense'); break;
      case 'ask': setActiveView('chat'); break;
      default: setActiveView('recommendations');
    }
  };

  // Clean up old persistence keys from previous versions
  try { localStorage.removeItem('botella_active_view'); } catch {}
  try { sessionStorage.removeItem('botella_active_view'); } catch {}
  const deadStockRef = useRef(null);
  // const PROMO_URL = process.env.REACT_APP_PROMO_URL || 'http://localhost:3000'; // disabled

  // The confirmation had no keyboard escape: once open, the only way out was a
  // mouse. Esc closes it, matching every other dismissible surface in the app.
  useEffect(() => {
    if (!showLogoutModal) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setShowLogoutModal(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showLogoutModal]);

  const handleLogout = () => {
    try { sessionStorage.removeItem('botella_digest_seen'); } catch {} // re-show briefing on next login
    clearSession(); // auth keys + idle timestamp + storeagent cache
    navigate('/');
  };

  // Conversation management state
  const [conversations, setConversations] = useState(() => loadConversations());
  const [pinnedIds, setPinnedIds] = useState(() => loadPinnedIds());
  const [activeConversationId, setActiveConversationId] = useState(() => {
    try {
      const savedId = localStorage.getItem(ACTIVE_ID_KEY);
      if (!savedId) return null;
      // Verify the conversation still exists
      const convs = loadConversations();
      return convs.find((c) => c.id === savedId) ? savedId : null;
    } catch {
      return null;
    }
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('botella_sidebar_collapsed') === 'true'; } catch { return false; }
  });
  // One theme source for the whole product (utils/useTheme). `themePreference`
  // is what the user chose - light | dark | system; `theme` is what is actually
  // painted, which under 'system' follows the OS live.
  const { preference: themePreference, resolved: theme, setPreference: setThemePreference } = useTheme();

  // Focus input on page load / refresh
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  // Lock body scrolling on chat page (landing/login pages need scrolling)
  useEffect(() => {
    document.documentElement.classList.add('no-scroll');
    return () => document.documentElement.classList.remove('no-scroll');
  }, []);

  // ── Server-side conversation history (Path B) ────────────────────────────
  // Conversations live in bottleai_analytics.chat_interactions, fetched via
  // /api/conversations. localStorage acts as a fallback cache when the server
  // is unreachable so the user never sees an empty sidebar mid-session.
  const fetchConversationListFromAPI = useCallback(async () => {
    if (!authToken) return null;
    try {
      const res = await fetch(`${API_BASE}/conversations`, { headers: getAuthHeaders() });
      if (handleAuthError(res)) return null;
      if (!res.ok) return null;
      const data = await res.json();
      return (data.conversations || []).map((c) => ({
        id: c.id,
        title: c.title,
        messages: [], // lazily loaded when the user opens the conversation
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        messageCount: c.messageCount,
      }));
    } catch {
      return null; // network error - caller falls back to localStorage
    }
  }, [authToken]);

  const fetchConversationFromAPI = useCallback(async (id) => {
    if (!authToken || !id) return null;
    try {
      const res = await fetch(`${API_BASE}/conversations/${encodeURIComponent(id)}`, {
        headers: getAuthHeaders(),
      });
      if (handleAuthError(res)) return null;
      if (!res.ok) return null;
      const data = await res.json();
      return {
        id: data.id,
        title: data.title,
        messages: data.messages || [],
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      };
    } catch {
      return null;
    }
  }, [authToken]);

  const deleteConversationFromAPI = useCallback(async (id) => {
    if (!authToken || !id) return false;
    try {
      const res = await fetch(`${API_BASE}/conversations/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      if (handleAuthError(res)) return false;
      return res.ok;
    } catch {
      return false;
    }
  }, [authToken]);

  // On mount: replace localStorage-loaded conversations with the server's view.
  // If the server is unreachable, the existing localStorage state stays as-is
  // (graceful degradation - user can still browse what they have cached).
  useEffect(() => {
    let cancelled = false;
    fetchConversationListFromAPI().then((apiConvs) => {
      if (cancelled || !apiConvs) return;
      // Preserve any locally-cached `messages` arrays so we don't refetch on
      // every mount when the user just refreshes the page. Also preserve any
      // user-renamed title - the API endpoint derives titles from the first
      // question on every call, so without this the rename would get wiped.
      setConversations((prev) => {
        const localById = new Map((prev || []).map((c) => [c.id, c]));
        const merged = apiConvs.map((apiC) => {
          const cached = localById.get(apiC.id);
          if (!cached) return apiC;
          return {
            ...apiC,
            title: cached.title || apiC.title,
            ...(cached.messages?.length ? { messages: cached.messages } : {}),
          };
        });
        // Sync back to localStorage as a cache layer
        try { saveConversations(merged); } catch {}
        return merged;
      });
    });
    return () => { cancelled = true; };
  }, [fetchConversationListFromAPI]);

  // Track mobile vs desktop for sidebar behavior
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 768);
  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth <= 768;
      setIsMobile(mobile);
      // Close mobile sidebar when switching to desktop
      if (!mobile) setSidebarOpen(false);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // The circular wipe is kept, but it is driven by the SEGMENT that was clicked
  // rather than by a single toggle, and it is skipped when the choice does not
  // change what is painted (picking System while already matching the OS) - a
  // full-screen wipe revealing an identical page reads as a glitch.
  const chooseTheme = (next, e) => {
    if (next === themePreference) return;
    const willPaint = next === 'system'
      ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : next;
    if (willPaint === theme || !e) { setThemePreference(next); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const maxRadius = Math.ceil(
      Math.hypot(
        Math.max(x, window.innerWidth - x),
        Math.max(y, window.innerHeight - y)
      )
    );

    // --vt-*, not --tx/--ty/--tr: `--tx` is the text-colour alias in
    // RecommendationsHome.css and ReferenceScreen.css, and writing a pixel
    // length into it on the root is a trap even though both redefine it.
    document.documentElement.style.setProperty('--vt-x', `${x}px`);
    document.documentElement.style.setProperty('--vt-y', `${y}px`);
    document.documentElement.style.setProperty('--vt-r', `${maxRadius}px`);

    if (document.startViewTransition) {
      // flushSync is required, not defensive. startViewTransition captures the
      // "after" snapshot as soon as its callback returns, and a bare
      // setState only SCHEDULES the render - so the callback would return with
      // the DOM unchanged, Chrome would capture two identical frames, and the
      // reveal would animate the old theme over the old theme before the real
      // change popped in at the end.
      document.startViewTransition(() => flushSync(() => setThemePreference(next)));
    } else {
      setThemePreference(next);
    }
  };

  // Chat state - restore messages from active conversation
  const [messages, setMessages] = useState(() => {
    try {
      const savedId = localStorage.getItem(ACTIVE_ID_KEY);
      if (!savedId) return [INITIAL_MESSAGE];
      const convs = loadConversations();
      const conv = convs.find((c) => c.id === savedId);
      return conv ? conv.messages : [INITIAL_MESSAGE];
    } catch {
      return [INITIAL_MESSAGE];
    }
  });
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState(null);
  const [followups, setFollowups] = useState(() => {
    try {
      const savedId = localStorage.getItem(ACTIVE_ID_KEY);
      if (!savedId) return [];
      const convs = loadConversations();
      const conv = convs.find((c) => c.id === savedId);
      if (!conv) return [];
      const lastAssistant = [...conv.messages].reverse().find(m => m.role === 'assistant');
      return lastAssistant?.followups || [];
    } catch {
      return [];
    }
  });
  const [editingIndex, setEditingIndex] = useState(null);
  const [editText, setEditText] = useState('');
  const [isLoadingConv, setIsLoadingConv] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [statusText, setStatusText] = useState('Thinking');
  const streamingBufferRef = useRef(''); // mirror of accumulated text - used by 'clear' to reset

  const bottomRef = useRef(null);
  const lastResponseRef = useRef(null);
  const prevLoadingRef = useRef(false);
  const inputRef = useRef(null);
  const activeIdRef = useRef(activeConversationId);
  const abortControllerRef = useRef(null);
  const streamingConvIdRef = useRef(null); // tracks which conversation is currently streaming
  const inFlightConvsRef = useRef(new Set()); // tracks all conversations with active streams

  // Keep activeIdRef in sync + persist active ID
  useEffect(() => {
    activeIdRef.current = activeConversationId;
    try {
      if (activeConversationId) {
        localStorage.setItem(ACTIVE_ID_KEY, activeConversationId);
      } else {
        localStorage.removeItem(ACTIVE_ID_KEY);
      }
    } catch {}
  }, [activeConversationId]);

  // Always keep cursor in the input box after any click on the page
  useEffect(() => {
    const refocusInput = (e) => {
      const tag = e.target.tagName.toLowerCase();
      // Don't steal focus from real input fields (edit textarea, sidebar rename, search, etc.)
      if (tag === 'input' || tag === 'textarea') return;
      // Don't refocus while a message is being edited inline
      if (editingIndex !== null) return;
      // Only apply when the chat view is active
      if (activeView !== 'chat') return;
      // Don't steal focus if the user is selecting text (allows copy)
      const selection = window.getSelection();
      if (selection && selection.toString().trim().length > 0) return;
      // Run after current click handlers finish so buttons process first.
      //
      // Re-check inside the timeout - clicking a button (e.g. the kebab menu's
      // "Rename" option) causes React to mount an input with autoFocus on the
      // next render. By the time this timeout fires that input is already
      // focused; stealing focus back to the chat box was the cause of the
      // "rename input loses focus instantly" bug. Same protection applies to
      // any other input/textarea that may have grabbed focus in the meantime.
      setTimeout(() => {
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
        inputRef.current?.focus();
      }, 0);
    };
    document.addEventListener('mouseup', refocusInput);
    return () => document.removeEventListener('mouseup', refocusInput);
  }, [editingIndex, activeView]);

  // Smart auto-scroll: scroll to bottom while streaming, scroll to top of response when done
  useEffect(() => {
    if (loading) {
      // While loading/streaming - keep scrolling to bottom
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    } else if (prevLoadingRef.current && !loading) {
      // Response just finished - scroll to the top of the assistant's response
      setTimeout(() => {
        lastResponseRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 50);
    }
    prevLoadingRef.current = loading;
  }, [messages, loading]);

  // Auto-save conversation to localStorage whenever messages change
  useEffect(() => {
    if (!activeConversationId) return;
    if (messages.length <= 1) return;

    setConversations((prev) => {
      const updated = prev.map((c) =>
        c.id === activeConversationId
          ? {
              ...c,
              messages,
              // Preserve existing title - it may be a user-rename. Only fall
              // back to deriving from the first message when there is no
              // title yet (brand-new conversation that just got its first turn).
              title: c.title || deriveTitle(messages),
            }
          : c
      );
      saveConversations(updated);
      return updated;
    });
  }, [messages, activeConversationId]);

  // ----- Conversation handlers -----

  const handleSelectConversation = async (id) => {
    const localConv = conversations.find((c) => c.id === id);
    if (!localConv) return;
    // Switch to chat view if on another tab (Suggestions, Marketing, etc.)
    setActiveView('chat');
    setIsLoadingConv(true);
    setActiveConversationId(id);
    setInput('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    const hasActiveStream = inFlightConvsRef.current.has(id);
    setStreamingText('');
    setStatusText(hasActiveStream ? 'Thinking' : 'Thinking');
    setLoading(hasActiveStream);
    setSidebarOpen(false);

    // Fetch the conversation's full messages from the server. Fall back to the
    // locally-cached messages if the network is down - UX stays usable offline.
    let messagesToShow = null;
    if (!hasActiveStream) {
      // Don't refetch a conversation that's actively streaming - local state has
      // the freshest tokens.
      const apiConv = await fetchConversationFromAPI(id);
      if (apiConv && apiConv.messages?.length) {
        messagesToShow = [INITIAL_MESSAGE, ...apiConv.messages];
        // Refresh the local cache for this conversation so the next mount is
        // fast. Preserve the user's renamed title (c.title) - the API derives
        // the title from the first question on every call, so writing
        // apiConv.title here would overwrite any rename the moment the user
        // navigates back to this conversation.
        setConversations((prev) => {
          const updated = prev.map((c) =>
            c.id === id ? { ...c, messages: messagesToShow, title: c.title || apiConv.title } : c
          );
          try { saveConversations(updated); } catch {}
          return updated;
        });
      }
    }
    if (!messagesToShow) {
      messagesToShow = (localConv.messages && localConv.messages.length)
        ? localConv.messages
        : [INITIAL_MESSAGE];
    }
    setMessages(messagesToShow);

    // Restore follow-ups from the last assistant message
    const lastAssistant = [...messagesToShow].reverse().find((m) => m.role === 'assistant');
    setFollowups(lastAssistant?.followups || []);

    setTimeout(() => {
      setIsLoadingConv(false);
      // Don't pop the keyboard on mobile - same rule as elsewhere
      if (window.innerWidth > 768) inputRef.current?.focus();
    }, 250);
  };

  const handleRenameConversation = (id, newTitle) => {
    if (!newTitle.trim()) return;
    setConversations((prev) => {
      const updated = prev.map((c) =>
        c.id === id ? { ...c, title: newTitle.trim() } : c
      );
      saveConversations(updated);
      return updated;
    });
  };

  const handlePinConversation = (id) => {
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      savePinnedIds(next);
      return next;
    });
  };

  const handleNewChat = () => {
    setActiveConversationId(null);
    setMessages([INITIAL_MESSAGE]);
    setInput('');
    setEditingIndex(null);        // cancel any inline edit in progress
    setEditText('');               // clear edit buffer
    setFollowups([]);
    // Clear streaming UI but let background stream finish saving to correct conversation
    setStreamingText('');
    setStatusText('Thinking');
    setLoading(false);
    setSidebarOpen(false);
    // Switch to chat view if on another tab
    setActiveView('chat');
    // Reset textarea height and clear value directly to avoid stale DOM state
    setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.value = '';
        inputRef.current.style.height = 'auto';
        inputRef.current.focus();
      }
    }, 100);
  };

  const handleDeleteConversation = async (id) => {
    // If this conversation has an in-flight stream, abort it BEFORE removing
    // from local state. Without this, the stream continues to fire 'delta'
    // events whose if-guard (activeIdRef.current === capturedId) fails - but
    // streamingText was already set with content from before the delete, so
    // the partial response visually bleeds through into the new-chat view.
    // Aborting also stops the backend (see chat.js req.on('close')) from
    // burning more Claude tokens on a response the user no longer wants.
    if (streamingConvIdRef.current === id && abortControllerRef.current) {
      try { abortControllerRef.current.abort(); } catch {}
    }
    inFlightConvsRef.current.delete(id);

    // Optimistic UI update - remove from local state immediately so the click
    // feels snappy. If the server delete fails, we'll refetch and restore.
    setConversations((prev) => {
      const updated = prev.filter((c) => c.id !== id);
      try { saveConversations(updated); } catch {}
      return updated;
    });
    if (id === activeConversationId) {
      setActiveConversationId(null);
      setMessages([INITIAL_MESSAGE]);
      setInput('');
      // Reset the streaming UI - the aborted stream's finally block won't
      // touch these (it checks activeIdRef.current === capturedId, which no
      // longer matches), so we must clear them here.
      setLoading(false);
      setStreamingText('');
      setStatusText('Thinking');
      streamingBufferRef.current = '';
    }
    // Persist deletion on the server. On failure, refetch the list to undo the
    // optimistic removal so the user doesn't lose data unexpectedly.
    const ok = await deleteConversationFromAPI(id);
    if (!ok) {
      const apiConvs = await fetchConversationListFromAPI();
      if (apiConvs) {
        setConversations((prev) => {
          const localById = new Map((prev || []).map((c) => [c.id, c]));
          const merged = apiConvs.map((apiC) => {
            const cached = localById.get(apiC.id);
            if (!cached) return apiC;
            return {
              ...apiC,
              title: cached.title || apiC.title,
              ...(cached.messages?.length ? { messages: cached.messages } : {}),
            };
          });
          try { saveConversations(merged); } catch {}
          return merged;
        });
      }
    }
  };

  // ----- Voice input handler -----

  const handleVoiceTranscript = (transcript) => {
    setInput((prev) => (prev ? prev + ' ' + transcript : transcript));
    inputRef.current?.focus();
  };

  // ----- Copy message -----

  const handleCopy = async (text, index) => {
    const ok = await copyToClipboard(text);
    if (!ok) return;
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  // ----- Print a specific assistant response -----
  const handlePrint = (index) => {
    const msg = messages[index];
    if (!msg) return;
    const body = renderMarkdown(msg.text);
    const win = window.open('', '_blank', 'width=820,height=900');
    if (!win) return;
    const html = `<!DOCTYPE html>
<html><head><title>Botella Response</title>
<style>
  body { font: 14px/1.6 -apple-system, 'Segoe UI', Roboto, sans-serif; color: #111; padding: 32px; max-width: 720px; margin: 0 auto; }
  h1 { font-size: 18px; margin: 0 0 4px; color: #6D28D9; }
  .meta { color: #666; font-size: 12px; margin-bottom: 24px; border-bottom: 1px solid #e5e7eb; padding-bottom: 16px; }
  p { margin: 0 0 10px; }
  strong { color: #6D28D9; }
  code { background: #f4f4f5; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  .chat-data-wrapper { margin: 12px 0; }
  .chat-data-view { display: table; width: 100%; border-collapse: collapse; }
  .chat-data-header, .chat-data-row { display: table-row; }
  .chat-data-col { display: table-cell; padding: 6px 10px; border-bottom: 1px solid #e5e7eb; font-size: 13px; vertical-align: top; }
  .chat-data-header .chat-data-col { background: #f4f4f5; font-weight: 600; border-bottom: 2px solid #d4d4d8; }
  .chat-csv-btn { display: none; }
  @media print { body { padding: 0; max-width: none; } }
</style></head>
<body>
  <h1>Botella Response</h1>
  <div class="meta">${new Date().toLocaleString()}</div>
  ${body}
</body></html>`;
    win.document.write(html);
    win.document.close();
    win.onafterprint = () => win.close();
    setTimeout(() => { win.focus(); win.print(); }, 250);
  };

  // ----- Stop response -----

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setLoading(false);
    setMessages((prev) => [
      ...prev,
      { role: 'assistant', text: '*Response stopped by user.*', at: Date.now() },
    ]);
    inputRef.current?.focus();
  };

  // ----- Edit user message -----

  const handleEditStart = (index) => {
    setEditingIndex(index);
    setEditText(messages[index].text);
  };

  const handleEditCancel = () => {
    setEditingIndex(null);
    setEditText('');
  };

  const handleEditSave = () => {
    if (!editText.trim() || loading) return;
    const edited = editText.trim();
    // Truncate conversation to before this message, then resend
    const truncated = messages.slice(0, editingIndex);
    setMessages(truncated);
    setEditingIndex(null);
    setEditText('');
    setFollowups([]);
    // Use a small delay so state updates before sending
    setTimeout(() => resendFrom(truncated, edited), 0);
  };

  // ----- Retry (regenerate) last assistant response -----

  const handleRetry = (assistantIndex) => {
    if (loading) return;
    // Find the user message before this assistant message
    const userMsg = messages[assistantIndex - 1];
    if (!userMsg || userMsg.role !== 'user') return;
    // Truncate to remove both the assistant response AND the user message
    // (resendFrom will re-add the user message)
    const truncated = messages.slice(0, assistantIndex - 1);
    setMessages(truncated);
    setFollowups([]);
    setTimeout(() => resendFrom(truncated, userMsg.text), 0);
  };

  // ----- Core: SSE streaming chat helper -----

  // Helper: save an assistant message to a specific conversation in storage
  // Used when the user has switched away and we can't use setMessages
  const saveToConversation = (convId, assistantMsg) => {
    setConversations((prev) => {
      const updated = prev.map((c) => {
        if (c.id !== convId) return c;
        const updatedMsgs = [...c.messages, assistantMsg];
        return {
          ...c,
          messages: updatedMsgs,
          // Preserve user-renamed title (same reasoning as the auto-save effect)
          title: c.title || deriveTitle(updatedMsgs),
          updatedAt: new Date().toISOString(),
        };
      });
      saveConversations(updated);
      return updated;
    });
  };

  // streamChat - initiates the SSE stream for one chat turn.
  //
  // Args:
  //   updatedMessages - full message list including the user's most-recent
  //                      message at the end (used as `history` minus that last item)
  //   userMsg         - the actual prompt sent to Claude (may be a hidden prompt)
  //   convId          - conversation_id for analytics + sidebar grouping
  //   displayMsg      - OPTIONAL: the human-readable text shown in the chat
  //                      bubble. When this differs from userMsg (e.g. the
  //                      Suggestions → Analyse flow which hides a long
  //                      instructional prompt behind a clean question), pass
  //                      it so the backend can store it in question_display
  //                      and the sidebar title / re-render display the right
  //                      thing later.
  const streamChat = async (updatedMessages, userMsg, convId, displayMsg = null) => {
    const capturedId = convId;
    streamingConvIdRef.current = capturedId;
    inFlightConvsRef.current.add(capturedId); // mark this conversation as in-flight
    const controller = new AbortController();
    abortControllerRef.current = controller;

    // Hard safety timeout - if response takes > 90s, abort and reset UI.
    //
    // Before clearing the UI, we try to recover the response from the API:
    // the backend's `logChatInteraction` fire-and-forget INSERT often
    // completes even after the stream is aborted (e.g. user backgrounded
    // the tab and the SSE connection got dropped). If the assistant message
    // is already saved server-side, we hydrate it into the chat instead of
    // leaving the user with their question dangling.
    const hardTimeout = setTimeout(async () => {
      try { controller.abort(); } catch {}
      if (activeIdRef.current !== capturedId) return;

      try {
        const apiConv = await fetchConversationFromAPI(capturedId);
        const apiMsgs = apiConv?.messages || [];
        const lastApiMsg = apiMsgs[apiMsgs.length - 1];
        if (lastApiMsg?.role === 'assistant' && activeIdRef.current === capturedId) {
          setMessages([INITIAL_MESSAGE, ...apiMsgs]);
          if (lastApiMsg.followups?.length) setFollowups(lastApiMsg.followups);
        }
      } catch {}

      setLoading(false);
      setStreamingText('');
      setStatusText('Thinking');
    }, 90000);

    try {
      const res = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          message: userMsg,
          history: updatedMessages.slice(0, -1),
          // Tie this chat turn to a conversation in the analytics DB so the
          // sidebar can list it and the user can revisit it later. capturedId
          // is the same id we just generated (or the active one for follow-ups).
          conversation_id: capturedId,
          // What the user actually saw in the chat bubble. Differs from `message`
          // only when a hidden prompt is being sent (e.g. Suggestions → Analyse).
          // Backend stores this in question_display; falls back to `message` when null.
          display_message: displayMsg && displayMsg !== userMsg ? displayMsg : null,
        }),
        signal: controller.signal,
      });

      if (handleAuthError(res)) return;

      // A non-OK response body isn't SSE - feeding it to the parser below yields
      // zero events and the turn ends silently with no message and no error.
      if (!res.ok) {
        const httpErr = new Error(`chat request failed (HTTP ${res.status})`);
        httpErr.httpStatus = res.status;
        throw httpErr;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));

            if (event.type === 'status') {
              // Only update UI if user is still on this conversation
              if (activeIdRef.current === capturedId) {
                setStatusText(event.text);
              }
            } else if (event.type === 'clear') {
              // Server detected a tool_use turn mid-stream and told us to wipe any
              // preamble prose that leaked before the tool_use block was announced.
              accumulated = '';
              if (activeIdRef.current === capturedId) {
                streamingBufferRef.current = '';
                setStreamingText('');
              }
            } else if (event.type === 'delta') {
              // Per-token streaming, ChatGPT / Claude.ai style. Three things
              // have to line up for this to actually be visible:
              //
              //   1. `flushSync(setStreamingText(...))` - defeats React 18's
              //      automatic batching, which otherwise collapses every
              //      setState inside this synchronous `for (line of lines)`
              //      loop into one render with the final value. flushSync
              //      forces React to commit each delta immediately.
              //
              //   2. `useLayoutEffect` inside StreamingBubble (see top of
              //      file) - writes innerHTML synchronously DURING the React
              //      commit instead of after-paint. Without this, flushSync
              //      commits per-delta but the actual DOM mutation lags.
              //
              //   3. `await requestAnimationFrame` below - yields control to
              //      the browser between deltas so it actually gets a paint
              //      frame to display each commit. Without the yield, all
              //      commits in this loop execute inside one JS task and the
              //      browser only paints once at the end.
              //
              //      Browsers suspend rAF in hidden tabs, so awaiting it there
              //      freezes the entire streaming loop until the user returns
              //      - at which point the 90s hardTimeout has often already
              //      fired, aborting the stream and leaving the question with
              //      no reply. Skipping the yield when hidden lets the loop
              //      keep processing deltas into state; nothing visible needs
              //      to be paint-paced anyway.
              accumulated += event.text;
              if (activeIdRef.current === capturedId) {
                streamingBufferRef.current = accumulated;
                flushSync(() => {
                  setStreamingText(accumulated);
                });
                if (document.visibilityState === 'visible') {
                  await new Promise((resolve) => requestAnimationFrame(resolve));
                }
              }
            } else if (event.type === 'done') {
              // Strip followup tags from the final text (server already strips them
              // from the stream, but kept here as a safety net for older responses).
              let finalText = accumulated;
              const followupMatch = finalText.match(/<<FOLLOWUPS>>(.*?)<\/FOLLOWUPS>>/s) || finalText.match(/<<FOLLOWUPS>>(.*?)<<\/FOLLOWUPS>>/s);
              if (followupMatch) {
                finalText = finalText.replace(/<<FOLLOWUPS>>.*?<\/FOLLOWUPS>>/s, '').replace(/<<FOLLOWUPS>>.*?<<\/FOLLOWUPS>>/s, '').trim();
              }

              const savedFollowups = event.followups || [];
              const responseTimeMs = event.responseTimeMs || null;
              const assistantMsg = { role: 'assistant', text: finalText || 'Sorry, something went wrong.', followups: savedFollowups, responseTimeMs, at: Date.now() };

              // Commit the final message immediately - no typewriter to wait on.
              // The streaming bubble already shows the full accumulated text by
              // this point (every delta was rendered as it arrived), so swapping
              // it out for the committed message is a no-op visually.
              streamingBufferRef.current = '';

              if (activeIdRef.current === capturedId) {
                setMessages((prev) => [...prev, assistantMsg]);
                if (savedFollowups.length > 0) {
                  setFollowups(savedFollowups);
                }
                setStreamingText('');
                setLoading(false);
              } else {
                saveToConversation(capturedId, assistantMsg);
                setStreamingText('');
              }
            } else if (event.type === 'error') {
              const errorMsg = { role: 'assistant', text: event.text, at: Date.now() };
              if (activeIdRef.current === capturedId) {
                setMessages((prev) => [...prev, errorMsg]);
              } else {
                saveToConversation(capturedId, errorMsg);
              }
              setStreamingText('');
            }
          } catch {}
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      const errorMsg = {
        role: 'assistant',
        text: err.httpStatus
          ? `Something went wrong on the server (HTTP ${err.httpStatus}). Please try again.`
          : 'Network error. Make sure the backend is running.',
      };
      if (activeIdRef.current === capturedId) {
        setMessages((prev) => [...prev, errorMsg]);
      } else {
        saveToConversation(capturedId, errorMsg);
      }
      setStreamingText('');
    } finally {
      clearTimeout(hardTimeout); // clear the 90s safety timeout
      streamingBufferRef.current = '';
      abortControllerRef.current = null;
      streamingConvIdRef.current = null;
      inFlightConvsRef.current.delete(capturedId); // no longer in-flight
      // Only update UI if user is still on this conversation
      if (activeIdRef.current === capturedId) {
        setStreamingText('');
        setStatusText('Thinking');
        setLoading(false);
      }
      // Don't pop the keyboard on mobile right after streaming finishes.
      if (window.innerWidth > 768) {
        setTimeout(() => inputRef.current?.focus(), 50);
      }

      // Refetch the conversation list so the sidebar reflects the new server-side
      // state (new conversation appears, existing message_count / updated_at refresh).
      // Preserve local messages arrays to avoid clobbering them with the metadata-only
      // server response.
      fetchConversationListFromAPI().then((apiConvs) => {
        if (!apiConvs) return;
        setConversations((prev) => {
          const localById = new Map((prev || []).map((c) => [c.id, c]));
          const merged = apiConvs.map((apiC) => {
            const cached = localById.get(apiC.id);
            if (!cached) return apiC;
            return {
              ...apiC,
              title: cached.title || apiC.title,
              ...(cached.messages?.length ? { messages: cached.messages } : {}),
            };
          });
          try { saveConversations(merged); } catch {}
          return merged;
        });
      });
    }
  };

  // ----- Core: send a message given a specific conversation state -----

  const resendFrom = async (currentMessages, userMsg) => {
    const updatedMessages = [...currentMessages, { role: 'user', text: userMsg, at: Date.now() }];
    setMessages(updatedMessages);
    setLoading(true);
    setStreamingText('');
    setStatusText('Thinking');

    let convId = activeConversationId;
    if (!convId) {
      convId = generateId();
      const now = new Date().toISOString();
      const newConv = {
        id: convId,
        title: userMsg.length > 50 ? userMsg.slice(0, 50) + '...' : userMsg,
        messages: updatedMessages,
        createdAt: now,
        updatedAt: now,
      };
      setActiveConversationId(convId);
      setConversations((prev) => {
        const updated = [newConv, ...prev];
        saveConversations(updated);
        return updated;
      });
    }

    await streamChat(updatedMessages, userMsg, convId);
  };

  // ----- Send message -----

  const sendMessage = async (text, displayText) => {
    const userMsg = text || input.trim();
    if (!userMsg || loading) return;

    // displayText = what the user sees in the chat bubble (defaults to the full message)
    const visibleText = displayText || userMsg;

    setInput('');
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }
    setFollowups([]);
    setStreamingText('');
    setStatusText('Thinking');
    const updatedMessages = [...messages, { role: 'user', text: visibleText, at: Date.now() }];
    setMessages(updatedMessages);
    setLoading(true);

    let convId = activeConversationId;
    if (!convId) {
      convId = generateId();
      const now = new Date().toISOString();
      const newConv = {
        id: convId,
        title: visibleText.length > 50 ? visibleText.slice(0, 50) + '...' : visibleText,
        messages: updatedMessages,
        createdAt: now,
        updatedAt: now,
      };
      setActiveConversationId(convId);
      setConversations((prev) => {
        const updated = [newConv, ...prev];
        saveConversations(updated);
        return updated;
      });
    }

    await streamChat(updatedMessages, userMsg, convId, visibleText);
  };

  const isMobileDevice = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  const handleKeyDown = (e) => {
    // On mobile: Enter = new line, only send via send button
    // On desktop: Enter = send, Shift+Enter = new line
    if (e.key === 'Enter' && !e.shiftKey && !isMobileDevice) {
      e.preventDefault();
      sendMessage();
    }
  };

  // Auto-resize textarea to fit content
  // Tracks whether the composer has grown past a single line. The bar is a full
  // pill at rest, matching the AskBar exactly; once it wraps, the radius relaxes
  // to a rounded rectangle, because a 999px radius on a 200px-tall box reads as
  // a lozenge rather than as the same object.
  const [composerTall, setComposerTall] = useState(false);

  const autoResize = (el) => {
    if (!el) return;
    el.style.height = 'auto';
    const h = Math.min(el.scrollHeight, 200);
    el.style.height = h + 'px';
    el.style.overflowY = h >= 200 ? 'auto' : 'hidden';
    setComposerTall(h > 34);
  };

  // ----- Markdown rendering -----

  const renderMarkdown = useCallback((text) => {
    // Escape HTML first to prevent XSS, then apply markdown formatting.
    // deDash runs before anything else: the model is instructed not to emit an
    // em/en dash (routes/chat.js, RESPONSE RULES), but a prompt is guidance and
    // this is a guarantee. Applied to the answer text only - never to SQL, ids
    // or CSV payloads, which do not pass through here.
    let html = escapeHtml(deDash(text))
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/`(.*?)`/g, '<code>$1</code>');

    const lines = html.split('\n');
    const result = [];
    let inTable = false;
    let tableRows = [];
    let inList = false;
    const closeList = () => { if (inList) { result.push('</ul>'); inList = false; } };
    // closeTable now takes an optional downloadId - set when the table is
    // followed immediately by a `[download:HEXID]` marker emitted by the
    // backend. The id powers the CSV button so it downloads ALL matching
    // rows from the original query, not just the 20 the user can see.
    const closeTable = (downloadId = null) => {
      if (inTable) { result.push(buildTable(tableRows, downloadId)); inTable = false; tableRows = []; }
    };
    // Matches the line the LLM is instructed to emit after partial tables.
    // 16 lower-case hex chars deliberately avoids the standard UUID format
    // (8-4-4-4-12) so the response-sanitiser's UUID stripper doesn't eat it.
    const downloadMarkerRe = /^\[download:([a-f0-9]{16})\]$/i;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('|') && line.endsWith('|')) {
        closeList();
        if (!inTable) { inTable = true; tableRows = []; }
        if (!/^\|[\s\-:|]+\|$/.test(line)) tableRows.push(line);
        continue;
      }
      // Download marker - strip from displayed output, but if it's the
      // first non-table line after a table block, pair it with that table
      // so the CSV button knows the cache id to hit.
      const downloadMatch = line.match(downloadMarkerRe);
      if (downloadMatch) {
        if (inTable) closeTable(downloadMatch[1]);
        continue;
      }
      closeTable();
      if (!line) { closeList(); continue; }

      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        closeList();
        const level = Math.min(headingMatch[1].length, 6);
        result.push(`<h${level}>${headingMatch[2]}</h${level}>`);
        continue;
      }
      const bulletMatch = line.match(/^[-*+]\s+(.+)$/);
      if (bulletMatch) {
        if (!inList) { result.push('<ul>'); inList = true; }
        result.push(`<li>${bulletMatch[1]}</li>`);
        continue;
      }
      const numberedMatch = line.match(/^\d+[.)]\s+(.+)$/);
      if (numberedMatch) {
        if (!inList) { result.push('<ul>'); inList = true; }
        result.push(`<li>${numberedMatch[1]}</li>`);
        continue;
      }
      closeList();
      result.push(`<p>${line}</p>`);
    }
    closeTable();
    closeList();

    return result.join('');
  }, []);


  // ----- Render -----

  const isWelcome = messages.length === 1;

  // The "Ask AI how to execute" hand-off, shared by the dashboard's task
  // cards and the Recommendations page: one definition, so the two surfaces
  // cannot drift into asking the model for different things.
  // `mode` picks the framing: 'execute' asks for the steps, 'explain' asks
  // what the call rests on. Both open a fresh chat the same way, so the two
  // buttons cannot drift apart in behaviour - only in what they ask for.
  // The dashboard's ask bar: the owner's own question, opened in a fresh
  // conversation and streamed immediately. Shares askExecutionPlan's machinery
  // deliberately - one path that starts a conversation, so the sidebar title,
  // the stored question and the streaming state cannot drift between them.
  // True for the moment after a question is dispatched from the ask bar. Drives
  // the arrival animation only - nothing about the conversation depends on it,
  // so a missed reset can never strand the view.
  const [arriving, setArriving] = useState(false);
  const arriveTimer = useRef(null);
  useEffect(() => () => clearTimeout(arriveTimer.current), []);

  const askFreeform = (question) => {
    const text = String(question || '').trim();
    if (!text) return;
    // Marks this conversation as one that ARRIVED from the ask bar, so the chat
    // can enter from where the bar was rather than appearing fully formed. Set
    // before the view switches so the class lands on the first painted frame.
    setArriving(true);
    clearTimeout(arriveTimer.current);
    arriveTimer.current = setTimeout(() => setArriving(false), 1100);
    startConversationWith(text, text);
  };

  const askExecutionPlan = (suggestion, productName, strategyName, mode = 'execute') => {
    // Hidden instructions sent to AI - short and focused
    const hiddenPrompt = mode === 'explain'
      ? `DO NOT query the database. This is an explanatory question about a recommendation you already made.

Context: ${suggestion}

Explain this recommendation in under 180 words: what it is asking for, the reasoning behind it, what evidence supports it, and what the risk is of doing nothing. Plain sentences, no numbered plan.`
      : `DO NOT query the database. This is an instructional planning question.

Context: ${suggestion}

Give me a concise, actionable execution plan (under 200 words). Use this format:

**Step 1: <Action>** - specific details
**Step 2: <Action>** - specific details
**Step 3: <Action>** - specific details
**Step 4: <Action>** - specific details

Then one line: "Expected timeline: <X days>". Keep it tactical, not generic.`;
    // Clean message shown to the user (and used as the conversation title)
    const displayMsg = mode === 'explain'
      ? `Tell me more about the ${strategyName || 'suggested'} recommendation for ${productName}.`
      : `How do I execute the ${strategyName || 'suggested'} strategy for ${productName}?`;

    startConversationWith(hiddenPrompt, displayMsg);
  };

  // ALWAYS starts a fresh conversation, regardless of which chat was open
  // before. Done explicitly (no handleNewChat + setTimeout dance) because that
  // pattern relied on stale-closure state and could accidentally append the
  // message to whichever chat was active in the last render.
  //
  // `prompt` is what the model receives, `displayMsg` what the user sees and
  // what titles the conversation. For a free-text question the two are the same.
  function startConversationWith(hiddenPrompt, displayMsg) {
    const newConvId = generateId();
    const now = new Date().toISOString();
    const baseMessages = [INITIAL_MESSAGE, { role: 'user', text: displayMsg, at: Date.now() }];
    const newConv = {
      id: newConvId,
      title: displayMsg.length > 50 ? displayMsg.slice(0, 50) + '…' : displayMsg,
      messages: baseMessages,
      createdAt: now,
      updatedAt: now,
    };

    // Reset state for the new chat and switch to the chat view
    setActiveView('chat');
    setActiveConversationId(newConvId);
    setMessages(baseMessages);
    setInput('');
    setEditingIndex(null);
    setEditText('');
    setFollowups([]);
    setStreamingText('');
    setStatusText('Thinking');
    setLoading(true);
    setSidebarOpen(false);
    setConversations((prev) => {
      const updated = [newConv, ...prev];
      try { saveConversations(updated); } catch {}
      return updated;
    });

    // Stream directly with everything passed explicitly - no reliance
    // on closure values that may be stale from the previous render.
    // 4th arg (displayMsg) ensures the backend stores the human-readable
    // question in question_display so the sidebar title and any future
    // page reload show the clean text instead of the long hiddenPrompt.
    streamChat(baseMessages, hiddenPrompt, newConvId, displayMsg);
  }

  // The open conversation, for the day divider: messages saved before this
  // shipped carry no time of their own, so the thread's own date stands in.
  const activeConv = conversations.find((c) => c.id === activeConversationId) || null;

  return (
    <>
      <Sidebar
        conversations={conversations}
        activeId={activeConversationId}
        onSelect={handleSelectConversation}
        onNewChat={handleNewChat}
        onNav={goNav}
        navKey={navKey}
        activeView={activeView}
        onDelete={handleDeleteConversation}
        themePreference={themePreference}
        theme={theme}
        onThemeChange={chooseTheme}
        onRename={handleRenameConversation}
        onPin={handlePinConversation}
        pinnedIds={pinnedIds}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        collapsed={sidebarCollapsed}
        onCollapse={() => {
          setSidebarCollapsed((prev) => {
            const next = !prev;
            try { localStorage.setItem('botella_sidebar_collapsed', String(next)); } catch {}
            return next;
          });
        }}
        storeName={displayStoreName('')}
        userName={localStorage.getItem('botella_client_name') || ''}
        onLogout={() => setShowLogoutModal(true)}
      />

      {/* One-time-per-login "store at a glance" briefing (revenue, restock-now,
          fast-selling movers). Self-gates via sessionStorage. */}
      <StartupDigest
        authToken={authToken}
        apiBase={API_BASE}
        onOpenStoreIntelligence={() => {
          // One-shot handoff: RecommendationsView consumes this on mount and
          // opens its Store Intelligence sub-tab instead of AI Recommendations.
          try { sessionStorage.setItem('botella_open_storeagent', '1'); } catch {}
          navigate('/suggestions');
        }}
      />

      {/* Gentle "rate us" toast after ~5 min - only on NON-chat screens (chat has
          its own in-chat feedback banner). Self-gated once/session. */}
      {/* Asked once per conversation, in the corner, clear of the transcript. */}
      <ChatFeedbackPopup
        apiBase={API_BASE}
        authToken={authToken}
        conversationId={activeConversationId}
        answerCount={messages.filter((m) => m.role === 'assistant').length - 1}
      />

      <SessionFeedbackToast
        authToken={authToken}
        apiBase={API_BASE}
        suppressed={activeView === 'chat'}
      />

      <div className="chat-page">
        {/* The header is now MOBILE-ONLY. The wordmark moved to the sidebar
            (A11) and the theme control moved into the account block at the foot
            of it, which left this bar holding nothing on desktop - an empty
            strip with a hairline under it, above every screen. On mobile it
            still carries the button that opens the sidebar. */}
        {isMobile && (
          <div className="chat-header">
            <button
              className="sidebar-toggle-btn"
              onClick={() => { setSidebarOpen(true); setSidebarCollapsed(false); }}
              title="Open menu"
              aria-label="Open menu"
            >
              <PanelLeftOpen size={20} />
            </button>
          </div>
        )}

        {/* Dashboard view */}
        {/* AI Recommendations home (v7.2) - the primary, and the only screen with actions. */}
        {activeView === 'recommendations' && (
          <RecommendationsHome
            authToken={authToken}
            apiUrl={ENV_API_ORIGIN}
            onNavigate={goNav}
            onAnalyse={askExecutionPlan}
          />
        )}

        {/* Purchasing (v7.2 reference screen) - fast, async buying data. */}
        {activeView === 'purchasing' && (
          <PurchasingScreen
            authToken={authToken}
            apiUrl={ENV_API_ORIGIN}
            onNavigate={goNav}
          />
        )}

        {/* Market Comparison (v7.2 reference screen) - fast, async market data. */}
        {activeView === 'market' && (
          <MarketComparisonScreen
            authToken={authToken}
            apiUrl={ENV_API_ORIGIN}
            onNavigate={goNav}
          />
        )}

        {/* Customers (v7.2 reference screen) - fast, async customer-radar data. */}
        {activeView === 'customers' && (
          <CustomersScreen
            authToken={authToken}
            apiUrl={ENV_API_ORIGIN}
            onNavigate={goNav}
          />
        )}

        {/* Effectiveness (v7.2) - dedicated page, no legacy PO tabs (B1). */}
        {activeView === 'effectiveness' && (
          <EffectivenessScreen
            authToken={authToken}
            apiUrl={ENV_API_ORIGIN}
            onNavigate={goNav}
          />
        )}

        {/* BottleSense - the measurement models from the BottleSense research,
            run on cost, which that estate has no column for anywhere. */}
        {activeView === 'bottlesense' && (
          <BottleSenseScreen
            authToken={authToken}
            apiUrl={ENV_API_ORIGIN}
            onNavigate={goNav}
          />
        )}

        {/* Command Center - merged Dashboard + Summary (prototype). */}
        {activeView === 'command' && (
          <CommandCenter
            authToken={authToken}
            apiUrl={ENV_API_ORIGIN}
            onNavigate={setActiveView}
            onAnalyse={askExecutionPlan}
          />
        )}

        {activeView === 'dashboard' && (
          <Dashboard
            authToken={authToken}
            apiUrl={ENV_API_ORIGIN}
            /* Lets the dashboard's "view detailed" hand-offs jump straight to
               the page that owns the detail, instead of dead-ending. */
            onNavigate={setActiveView}
            onAnalyse={askExecutionPlan}
          />
        )}

        {/* Summary view - the insight-first dashboard: leads with what the POS
            can't show (measured impact, new SKUs winning nearby, missed
            opportunity, category comparison). */}
        {activeView === 'summary' && (
          <InsightSummary
            authToken={authToken}
            apiUrl={ENV_API_ORIGIN}
            onRecommendations={() => setActiveView('suggestions')}
            onChat={() => setActiveView('chat')}
          />
        )}

        {/* Quick PO - upload a supplier invoice or purchase order and read it
            into a table checked against the store's own catalogue. */}
        {activeView === 'purchase-orders' && (
          <PurchaseOrdersScreen
            authToken={authToken}
            apiUrl={ENV_API_ORIGIN}
            onNavigate={goNav}
          />
        )}

        {/* Card Statement Analysis - upload a card processing statement and see
            what it charged, where money leaks, and what Rebelipay would cost. */}
        {activeView === 'card-statements' && (
          <CardStatementsScreen
            authToken={authToken}
            apiUrl={ENV_API_ORIGIN}
            onNavigate={goNav}
          />
        )}

        {/* Statistics view - the charts that used to sit under the dashboard */}
        {activeView === 'reports' && (
          <StatisticsPage
            authToken={authToken}
            apiUrl={ENV_API_ORIGIN}
            onNavigate={goNav}
          />
        )}

        {/* Recommendations view - signal-aware suggestions + StoreAgent (sub-tabs) */}
        {activeView === 'suggestions' && (
          <RecommendationsView
            authToken={authToken}
            apiUrl={ENV_API_ORIGIN}
            onAnalyse={askExecutionPlan}
          />
        )}

        {/* Market Analysis view - product search across the tenant's inventory */}
        {activeView === 'market-analysis' && (
          <MarketAnalysisPage
            authToken={authToken}
            apiUrl={ENV_API_ORIGIN}
          />
        )}

        {/* The assistant dock - one bar, over every view, always in the same
            place. Not on the chat view itself: the composer already owns that
            spot there, and two inputs stacked on each other is a worse answer
            than one. */}
        {activeView !== 'chat' && <AskBar onAsk={askFreeform} />}

        {/* Chat view */}
        <div
          className={`chat-container ${arriving ? 'is-arriving' : ''}`}
          style={{ display: activeView === 'chat' ? 'flex' : 'none' }}
        >
          {/* The conversation history is NOT rendered here. It lives in the
              sidebar (Sidebar -> ConversationHistory). As a child of
              .chat-container - a COLUMN flex - it was a band across the top of
              the transcript rather than a column beside it: the messages could
              never use that space, and a long list ran off the bottom of the
              screen behind the composer with nothing to scroll. */}
          <div
            className="chat-messages"
            onClick={async (e) => {
              // CSV download - event delegation for dynamically rendered tables.
              // Two paths:
              //   - `data-download-id` present → fetch from /api/chat/csv/:id,
              //     which re-runs the original SQL without LIMIT/OFFSET and
              //     returns ALL matching rows (up to 5000). This is the
              //     normal case for partial tables Claude renders from
              //     run_sql results.
              //   - Otherwise → fall back to the embedded `data-csv` payload,
              //     which only contains the 20 rows visible in the chat.
              //     Used for tool results that didn't get a downloadId
              //     (small result sets ≤5 rows).
              const btn = e.target.closest('.chat-csv-btn');
              if (!btn) return;

              const downloadId = btn.dataset.downloadId;
              if (downloadId) {
                try {
                  btn.disabled = true;
                  const prevText = btn.innerHTML;
                  btn.innerHTML = '&#8595;&nbsp;…';
                  const res = await fetch(`${API_BASE}/chat/csv/${downloadId}`, {
                    headers: {
                      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
                      'ngrok-skip-browser-warning': 'true',
                    },
                  });
                  if (!res.ok) {
                    // 404 = cache expired (entries live ~1 hour). Fall through
                    // to the embedded data-csv so the user still gets the
                    // visible rows rather than an outright failure.
                    throw new Error(`csv endpoint returned ${res.status}`);
                  }
                  const blob = await res.blob();
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `botella-export-${new Date().toISOString().slice(0, 10)}.csv`;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                  btn.innerHTML = prevText;
                  btn.disabled = false;
                  return;
                } catch (err) {
                  // Fall through to embedded fallback below
                  btn.disabled = false;
                  btn.innerHTML = '&#8595;&nbsp;CSV';
                }
              }

              const csv = decodeURIComponent(btn.dataset.csv || '');
              if (!csv) return;
              const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = 'store-data.csv';
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
            }}
          >
           <div className="chat-messages-inner">

            {/* Skeleton loader - shown briefly when switching conversations */}
            {isLoadingConv && (
              <div className="chat-skeleton">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className={`chat-skeleton-msg ${i % 3 === 1 ? 'user' : 'assistant'}`}>
                    <div className="chat-skeleton-avatar" />
                    <div className="chat-skeleton-lines">
                      <div className="chat-skeleton-line" style={{ width: `${50 + (i * 13) % 35}%` }} />
                      {i % 2 === 0 && <div className="chat-skeleton-line" style={{ width: `${30 + (i * 17) % 30}%` }} />}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Welcome screen */}
            {!isLoadingConv && isWelcome && (
              <div className="chat-welcome">
                <h2>Welcome to Botella</h2>
                <p>
                  Your intelligent liquor store assistant. Ask me anything about
                  sales, inventory, vendors, customers, and more.
                </p>
              </div>
            )}

            {/* Messages */}
            {!isLoadingConv && !isWelcome &&
              messages.map((msg, i) => {
                // Attach ref to the last assistant message
                const isLastAssistant = msg.role === 'assistant' &&
                  i === messages.map((m, idx) => m.role === 'assistant' ? idx : -1).filter(x => x >= 0).pop();

                // A divider only where the day actually changes - including
                // before the first message, so a thread always says when it
                // happened. activeConv's date covers messages predating `at`.
                const label = dayLabel(msg.at || activeConv?.createdAt);
                const prevLabel = i === 0
                  ? null
                  : dayLabel(messages[i - 1].at || activeConv?.createdAt);
                const showDay = label && label !== prevLabel;

                return (
                <React.Fragment key={i}>
                {showDay && (
                  <div className="chat-day" role="separator" aria-label={label}>
                    <span>{label}</span>
                  </div>
                )}
                <div className={`chat-message ${msg.role}`} ref={isLastAssistant ? lastResponseRef : null}>
                  <div className="chat-avatar">
                    {msg.role === 'assistant' ? (
                      <Wine size={18} />
                    ) : (
                      <User size={18} />
                    )}
                  </div>
                  <div className="chat-bubble-wrapper">
                    {/* Inline editing mode for user messages */}
                    {editingIndex === i ? (
                      <div className="chat-edit-area">
                        <textarea
                          className="chat-edit-input"
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey && !isMobileDevice) {
                              e.preventDefault();
                              handleEditSave();
                            }
                            if (e.key === 'Escape') handleEditCancel();
                          }}
                          rows={Math.min(editText.split('\n').length, 6)}
                          autoFocus
                        />
                        <div className="chat-edit-actions">
                          <button className="chat-edit-cancel" onClick={handleEditCancel}>
                            Cancel
                          </button>
                          <button className="chat-edit-save" onClick={handleEditSave}>
                            Send
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div
                          className="chat-bubble"
                          dangerouslySetInnerHTML={{
                            __html: renderMarkdown(msg.text),
                          }}
                        />
                        {/* Action buttons row */}
                        <div className="chat-msg-actions">
                          {/* User message: Edit button */}
                          {msg.role === 'user' && !loading && (
                            <button
                              className="chat-action-btn"
                              onClick={() => handleEditStart(i)}
                              title="Edit message"
                            >
                              <Pencil size={12} />
                            </button>
                          )}
                          {/* Assistant message: Copy + Retry */}
                          {msg.role === 'assistant' && i > 0 && (
                            <>
                              <button
                                className={`chat-action-btn ${copiedIndex === i ? 'copied' : ''}`}
                                onClick={() => handleCopy(msg.text, i)}
                                title={copiedIndex === i ? 'Copied!' : 'Copy'}
                              >
                                {copiedIndex === i ? <Check size={12} /> : <Copy size={12} />}
                              </button>
                              <button
                                className="chat-action-btn"
                                onClick={() => handlePrint(i)}
                                title="Print response"
                              >
                                <Printer size={12} />
                              </button>
                              {!loading && (
                                <button
                                  className="chat-action-btn"
                                  onClick={() => handleRetry(i)}
                                  title="Regenerate response"
                                >
                                  <RefreshCw size={12} />
                                </button>
                              )}
                              {msg.responseTimeMs != null && (
                                <span className="chat-response-time" title="Response time">
                                  {msg.responseTimeMs < 1000
                                    ? `${msg.responseTimeMs}ms`
                                    : `${(msg.responseTimeMs / 1000).toFixed(1)}s`}
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </div>
                </React.Fragment>
              )})}

            {/* Follow-up suggestions */}
            {!isLoadingConv && !loading && followups.length > 0 && (
              <div className="chat-followups">
                {followups.map((q, i) => (
                  <button
                    key={i}
                    className="chat-followup"
                    onClick={() => sendMessage(q)}
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}

            {/* Streaming response - shows text as it arrives */}
            {loading && streamingText && (
              <div className="chat-message assistant">
                <div className="chat-avatar">
                  <Wine size={18} />
                </div>
                <div className="chat-bubble-wrapper">
                  <StreamingBubble text={streamingText} />
                </div>
              </div>
            )}

            {/* Typing indicator - animated dots with status */}
            {loading && !streamingText && (
              <div className="chat-message assistant">
                <div className="chat-avatar">
                  <Wine size={18} />
                </div>
                <div className="chat-bubble chat-typing" role="status" aria-label="Loading response">
                  <div className="typing-dots">
                    <span />
                    <span />
                    <span />
                  </div>
                  <span className="typing-label">{statusText}</span>
                </div>
              </div>
            )}
            {/* Suggestion cards */}
            {!isLoadingConv && isWelcome && (
              <div className="chat-suggestions">
                {SUGGESTIONS.map((s, i) => {
                  const Icon = s.icon;
                  return (
                    <button
                      key={i}
                      className="chat-suggestion"
                      onClick={() => sendMessage(s.text)}
                    >
                      <Icon size={16} className="chat-suggestion-icon" />
                      <span>{s.text}</span>
                    </button>
                  );
                })}
              </div>
            )}

            <div ref={bottomRef} />
           </div>
          </div>

          {/* The composer is the AskBar in a different posture: same width, same
              pill, same hairline, same focus ring, same mark on the left. The
              two used to differ by 440px of width and a 24px-vs-999px radius,
              so moving between Ask Botella and any other screen looked like
              moving between two different products. */}
          <div className="chat-input-area">
            <div className={`chat-input-wrapper ${composerTall ? 'is-tall' : ''}`}>
              <span className="ab-mark chat-input-mark" aria-hidden="true">
                <span className="ab-mark-glyph">B<em>.</em></span>
              </span>
              <textarea
                ref={inputRef}
                className="chat-input"
                placeholder="Ask anything about your store..."
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  autoResize(e.target);
                }}
                onKeyDown={handleKeyDown}
                disabled={loading}
                rows={1}
                maxLength={4000}
              />
              <div className="chat-input-actions">
                <VoiceMicButton
                  onTranscript={handleVoiceTranscript}
                  onClose={() => setTimeout(() => inputRef.current?.focus(), 50)}
                  disabled={loading}
                />
                {loading ? (
                  <button
                    className="chat-stop-btn"
                    onClick={handleStop}
                    title="Stop generating"
                    aria-label="Stop generating"
                  >
                    <Square size={14} />
                  </button>
                ) : (
                  <button
                    className="chat-send-btn"
                    onClick={() => sendMessage()}
                    disabled={!input.trim()}
                    aria-label="Send message"
                  >
                    <Send size={16} />
                  </button>
                )}
              </div>
            </div>
            <p className="chat-input-hint">
              Botella is an AI and can make mistakes. Please verify important data.
            </p>
          </div>
        </div>
      </div>

      {/* Dead stock suggestions popup - auto once per day + manual via header button */}
      <DeadStockPopup
        ref={deadStockRef}
        authToken={authToken}
        apiUrl={ENV_API_ORIGIN}
      />

      {/* Logout confirmation modal */}
      {showLogoutModal && (
        <div
          className="logout-modal-overlay"
          onClick={() => setShowLogoutModal(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="logout-title"
        >
          <div className="logout-modal" onClick={(e) => e.stopPropagation()}>
            <div className="logout-modal-icon">
              <LogOut size={24} />
            </div>
            <h3 className="logout-modal-title" id="logout-title">Sign out?</h3>
            {/* Name the account. "Are you sure you want to log out of your
                account?" told the user nothing they did not already know, and
                on a shared back-office machine the useful question is WHICH
                account is about to be signed out. */}
            <p className="logout-modal-text">
              You will be signed out of{' '}
              <strong>{displayStoreName('this store')}</strong>
              {' '}on this device. Your data and recommendations stay where they are.
            </p>
            <div className="logout-modal-actions">
              {/* autoFocus on CANCEL, not on the confirm: the safe option should
                  be the one a stray Enter lands on. */}
              <button
                className="logout-modal-cancel"
                onClick={() => setShowLogoutModal(false)}
                autoFocus
              >
                Stay signed in
              </button>
              <button className="logout-modal-confirm" onClick={handleLogout}>
                <LogOut size={15} /> Sign out
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default ChatPage;
