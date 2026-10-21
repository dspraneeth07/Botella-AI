// ConversationHistory.js
// -----------------------------------------------------------------------------
// The previous-conversations list, rendered INSIDE the sidebar, under the seven
// navigation items, whenever Ask Botella is the open screen.
//
// It replaces ConversationColumn, which rendered the same list as a 250px column
// inside the chat view itself. That arrangement had two faults that no amount of
// styling could fix:
//
//   * .chat-container is a COLUMN flex, so the "column" was really a band across
//     the top of the transcript. The messages could never use the space beside
//     it, and a scrolled-to-bottom thread left that band empty.
//   * The list had no height to be bounded by, so once it grew past the viewport
//     it ran off the bottom, behind the composer, with nothing to scroll.
//
// Here the list sits in a flex column that is already bounded to the sidebar's
// height, and it is the one element allowed to grow (`flex: 1`) with its own
// scroll. It cannot overlap anything or push anything off-screen.
// -----------------------------------------------------------------------------

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Plus, Search, X, MessageSquare, MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import './ConversationHistory.css';
import { useDialog } from './Dialog';

/* When a conversation last changed.
 *
 * ChatPage writes camelCase (createdAt / updatedAt); this list was reading
 * snake_case (updated_at / created_at). Both were therefore undefined, every
 * row got an Invalid Date, and the whole list fell into one bucket regardless
 * of when anything actually happened - which looked exactly like the grouping
 * being broken, because it was.
 *
 * Reads BOTH spellings rather than picking a side: conversations arrive from
 * the server, from localStorage written by older builds, and from this
 * session, and they have not always agreed. */
function convTime(c) {
  return c.updatedAt || c.updated_at || c.createdAt || c.created_at || null;
}

/* Days between two dates, counted as CALENDAR days rather than 24-hour blocks.
 * 11pm and 1am are an hour apart and belong to different days; a difference in
 * milliseconds cannot tell you that, which is how a conversation from last
 * night ends up filed under "today". */
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function daysAgo(d) {
  return Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
}

/* The meta line on a row.
 *
 * Under a "TODAY" heading, a row reading "Today" says nothing the heading has
 * not - so today's rows show the clock instead, which is the part that still
 * distinguishes them. Everything older names its day, because "3 days ago"
 * makes the reader do arithmetic to arrive at "Friday". */
function metaTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';

  const mins = Math.floor((Date.now() - d) / 60000);
  if (mins < 1) return 'Just now';

  const days = daysAgo(d);
  if (days === 0) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  if (days < 365) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// PINNED is a group, not a sort order. A pinned conversation leaves its date
// group entirely and sits at the top - the point of pinning is that you stop
// having to remember when you last opened it.
const PINNED = 'PINNED';
/* Four buckets, because that is how far anyone reasons back about a chat:
 * it happened today, it happened yesterday, it happened this week, or it is
 * old enough that the date is the useful thing. "Previous 30 days" used to
 * hold everything from two days ago to a month ago in one heap. */
const GROUPS = [PINNED, 'TODAY', 'YESTERDAY', 'THIS WEEK', 'OLDER'];

/* Must return a heading that is in GROUPS - a row whose bucket is not listed
 * there is silently never rendered, so the two are kept next to each other. */
function groupOf(iso) {
  const d = new Date(iso);
  // No usable date: file it under Older rather than inventing a day for it,
  // but that is now a genuine absence, not a field-name mismatch.
  if (Number.isNaN(d.getTime())) return 'OLDER';
  const days = daysAgo(d);
  if (days <= 0) return 'TODAY';        // <= 0 also catches a clock skewed ahead
  if (days === 1) return 'YESTERDAY';
  /* A rolling seven days, not "since Monday". A calendar week would leave THIS
   * WEEK empty every Monday - and something from Saturday would jump to OLDER
   * overnight, which is not what anyone means by "this week". */
  if (days < 7) return 'THIS WEEK';
  return 'OLDER';
}

function ConversationHistory({
  conversations = [], activeId, onSelect, onNewChat,
  onRename, onPin, onDelete, pinnedIds,
}) {
  const [query, setQuery] = useState('');
  // Which row's "..." menu is open, and which row is being renamed. Only one of
  // each at a time - two open menus in a 300px sidebar is never what was meant.
  const [menuFor, setMenuFor] = useState(null);
  const [renamingId, setRenamingId] = useState(null);
  const [draftTitle, setDraftTitle] = useState('');
  const wrapRef = useRef(null);
  const dialog = useDialog();

  const isPinned = React.useCallback(
    // pinnedIds arrives as a Set from ChatPage, but tolerate an array so this
    // component is not the thing that breaks if that ever changes.
    (id) => (pinnedIds instanceof Set ? pinnedIds.has(id) : Array.isArray(pinnedIds) ? pinnedIds.includes(id) : false),
    [pinnedIds],
  );

  // Close the menu on an outside click or Escape. Without this it survives the
  // next click anywhere, including on another row, and two rows appear armed.
  useEffect(() => {
    if (!menuFor) return undefined;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setMenuFor(null); };
    const onKey = (e) => { if (e.key === 'Escape') setMenuFor(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menuFor]);

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = q
      ? conversations.filter((c) => (c.title || '').toLowerCase().includes(q))
      : conversations;
    const out = {};
    rows.forEach((c) => {
      const g = isPinned(c.id) ? PINNED : groupOf(convTime(c));
      (out[g] = out[g] || []).push(c);
    });
    return out;
  }, [conversations, query, isPinned]);

  const commitRename = (id) => {
    const next = draftTitle.trim();
    // An empty title would leave the row reading "Untitled conversation" with
    // no way to tell it from a genuinely new one, so treat it as a cancel.
    if (next && onRename) onRename(id, next);
    setRenamingId(null);
    setDraftTitle('');
  };

  const askDelete = async (c) => {
    setMenuFor(null);
    const yes = await dialog.confirm({
      title: 'Delete this conversation?',
      message: `"${c.title || 'Untitled conversation'}" and its messages will be removed. This cannot be undone.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Keep',
      tone: 'danger',
    });
    if (yes && onDelete) onDelete(c.id);
  };

  const empty = GROUPS.every((g) => !grouped[g] || grouped[g].length === 0);

  return (
    <div className="ch-wrap" ref={wrapRef}>
      <button type="button" className="ch-new" onClick={onNewChat}>
        <Plus size={14} /> New conversation
      </button>

      <div className="ch-search">
        <Search size={13} />
        <input
          type="text"
          placeholder="Search conversations"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button type="button" className="ch-search-clear" onClick={() => setQuery('')} aria-label="Clear search">
            <X size={12} />
          </button>
        )}
      </div>

      <div className="ch-list app-scroll">
        {empty && (
          <div className="ch-empty">
            <MessageSquare size={20} />
            <p>{query ? 'No matching conversations' : 'No conversations yet'}</p>
          </div>
        )}

        {GROUPS.map((g) => {
          const rows = grouped[g];
          if (!rows || rows.length === 0) return null;
          return (
            <div key={g} className="ch-group">
              <div className="ch-group-label">{g}</div>
              {rows.map((c) => {
                const active = String(c.id) === String(activeId);
                const pinned = isPinned(c.id);

                // Renaming replaces the row with its input. A row that kept the
                // title visible beside an edit field asks which one is real.
                if (renamingId === c.id) {
                  return (
                    <div key={c.id} className="ch-item ch-item-renaming">
                      <input
                        className="ch-rename-input"
                        value={draftTitle}
                        autoFocus
                        onChange={(e) => setDraftTitle(e.target.value)}
                        onBlur={() => commitRename(c.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); commitRename(c.id); }
                          // Escape must abandon the edit, so clear the draft
                          // first - blur fires next and would otherwise commit it.
                          if (e.key === 'Escape') { setDraftTitle(''); setRenamingId(null); }
                        }}
                        aria-label="Conversation title"
                      />
                    </div>
                  );
                }

                return (
                  // A div, not a button: the row holds the "..." control, and a
                  // button inside a button is invalid HTML that browsers repair
                  // by hoisting the inner one out of the row entirely.
                  <div
                    key={c.id}
                    className={`ch-item ${active ? 'ch-item-active' : ''} ${menuFor === c.id ? 'ch-item-menu-open' : ''}`}
                  >
                    <button
                      type="button"
                      className="ch-item-main"
                      onClick={() => onSelect && onSelect(c.id)}
                      title={c.title || 'Untitled conversation'}
                    >
                      <span className="ch-item-title">
                        {pinned && <Pin size={11} className="ch-item-pin" aria-hidden="true" />}
                        {c.title || 'Untitled conversation'}
                      </span>
                      <span className="ch-item-meta">{metaTime(convTime(c))}</span>
                    </button>

                    {(onRename || onPin || onDelete) && (
                      <button
                        type="button"
                        className="ch-item-more"
                        aria-label="Conversation options"
                        aria-haspopup="menu"
                        aria-expanded={menuFor === c.id}
                        onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === c.id ? null : c.id); }}
                      >
                        <MoreHorizontal size={15} />
                      </button>
                    )}

                    {menuFor === c.id && (
                      <div className="ch-menu" role="menu">
                        {onRename && (
                          <button
                            type="button" role="menuitem" className="ch-menu-item"
                            onClick={() => { setRenamingId(c.id); setDraftTitle(c.title || ''); setMenuFor(null); }}
                          >
                            <Pencil size={13} /> Rename
                          </button>
                        )}
                        {onPin && (
                          <button
                            type="button" role="menuitem" className="ch-menu-item"
                            onClick={() => { onPin(c.id); setMenuFor(null); }}
                          >
                            {pinned ? <><PinOff size={13} /> Unpin</> : <><Pin size={13} /> Pin</>}
                          </button>
                        )}
                        {onDelete && (
                          <button
                            type="button" role="menuitem" className="ch-menu-item ch-menu-danger"
                            onClick={() => askDelete(c)}
                          >
                            <Trash2 size={13} /> Delete
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default ConversationHistory;
