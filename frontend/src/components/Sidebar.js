import React, { useState, useRef, useEffect, useCallback } from 'react';
import { MessageSquare, X, PanelLeftClose, LogOut, Store, Menu, Lightbulb, BarChart3, ShoppingCart, Users, Trophy, FileText, LayoutGrid, ChevronDown, Gauge, Sun, Moon, Monitor, CreditCard } from 'lucide-react';
import Wordmark from './Wordmark';
import ConversationHistory from './ConversationHistory';
import ThemeSwitch from './ThemeSwitch';
import { SHOW_EFFECTIVENESS, SHOW_BOTTLESENSE, SHOW_CARD_STATEMENTS } from '../utils/features';

// The main navigation. Each maps to a `navKey` the parent (ChatPage.goNav)
// routes to the screen serving it today.
//
// Withdrawn items are filtered out HERE, at the single definition, rather than
// at either render site: the expanded list and the collapsed rail below both
// walk this array, and hiding an item in one and not the other is exactly the
// drift the note on Purchase Orders warns about. See utils/features.js for why
// a flag is off and how to bring it back.
const NAV_ITEMS = [
  { key: 'recommendations', label: 'AI Recommendations', icon: Lightbulb },
  { key: 'purchasing', label: 'Purchasing', icon: ShoppingCart },
  { key: 'market', label: 'Market Comparison', icon: Store },
  { key: 'customers', label: 'Customers', icon: Users },
  { key: 'reports', label: 'Reports', icon: BarChart3 },
  { key: 'effectiveness', label: 'Effectiveness', icon: Trophy, show: SHOW_EFFECTIVENESS },
  { key: 'bottlesense', label: 'BottleSense', icon: Gauge, show: SHOW_BOTTLESENSE },
  // Card statements sit with the other uploaded documents, directly above
  // Purchase Orders, so Purchase Orders keeps its place next to Ask Botella.
  { key: 'card-statements', label: 'Card Statement Analysis', icon: CreditCard, show: SHOW_CARD_STATEMENTS },
  // Purchase Orders sits directly above Ask Botella. The two are the ends of
  // one habit - upload the invoice that just arrived, then ask about it - and
  // this order is rendered by both the expanded list and the collapsed rail
  // below, so they cannot drift apart.
  { key: 'purchase-orders', label: 'Purchase Orders', icon: FileText },
  { key: 'ask', label: 'Ask Botella', icon: MessageSquare },
].filter((item) => item.show !== false);

const MIN_WIDTH = 220;
const MAX_WIDTH = 480;
const STORAGE_KEY = 'botella_sidebar_width';

function Sidebar({
  onNav, navKey, isOpen, onClose, collapsed, onCollapse, storeName, userName, onLogout,
  conversations, activeId, onSelect, onNewChat,
  // ChatPage has always passed these; Sidebar never destructured them, so
  // Rename, Pin and Delete were unreachable - the handlers existed and nothing
  // could call them. They are forwarded to ConversationHistory below.
  onRename, onPin, onDelete, pinnedIds,
  // The theme control lives here now rather than in the page header: it is an
  // account preference, and it was the only thing left in that header on
  // desktop. onThemeChange takes the event - ChatPage uses the clicked
  // segment's position as the origin of the circular wipe.
  themePreference, theme, onThemeChange,
}) {
  // A11: Open-recommendations count badge, published by RecommendationsHome.
  const [openRecCount, setOpenRecCount] = useState(() => { try { return Number(localStorage.getItem('botella_open_rec_count')) || 0; } catch { return 0; } });
  useEffect(() => {
    const read = () => { try { setOpenRecCount(Number(localStorage.getItem('botella_open_rec_count')) || 0); } catch { /* no-op */ } };
    window.addEventListener('botella-open-count', read);
    window.addEventListener('storage', read);
    return () => { window.removeEventListener('botella-open-count', read); window.removeEventListener('storage', read); };
  }, []);
  const [width, setWidth] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, parseInt(saved, 10))) : 300;
    } catch {
      return 300;
    }
  });
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef(null);

  // On Ask Botella the eight nav items fold into one row so the conversation
  // history gets the column. `navOpen` is that disclosure.
  const navFolds = navKey === 'ask';
  const [navOpen, setNavOpen] = useState(false);
  const navRef = useRef(null);

  // Leaving chat unfolds the nav for real, so the disclosure never carries a
  // stale open state back to a screen that shows the full list anyway.
  useEffect(() => { if (!navFolds) setNavOpen(false); }, [navFolds]);

  // Escape, and a click anywhere outside the disclosure, close it. Bound only
  // while it is open.
  useEffect(() => {
    if (!navOpen) return undefined;
    const onDown = (e) => { if (navRef.current && !navRef.current.contains(e.target)) setNavOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setNavOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [navOpen]);

  const goNav = (key) => { setNavOpen(false); if (onNav) onNav(key); };

  // ----- Resize logic -----
  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  const widthRef = useRef(width);
  useEffect(() => { widthRef.current = width; }, [width]);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e) => {
      const newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, e.clientX));
      setWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      try {
        localStorage.setItem(STORAGE_KEY, widthRef.current.toString());
      } catch {}
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  return (
    <aside
      ref={sidebarRef}
      className={`sidebar ${isOpen ? 'sidebar-open' : ''} ${collapsed ? 'sidebar-collapsed' : ''}`}
      style={{ width: collapsed ? '56px' : `${width}px` }}
    >
      {/* Mobile overlay backdrop */}
      <div className="sidebar-overlay" onClick={onClose} />

      {/* Collapsed icon strip */}
      {collapsed && (
        <div className="sidebar-mini">
          <button
            className="sidebar-mini-btn"
            onClick={onCollapse}
            title="Expand sidebar"
          >
            <Menu size={20} />
          </button>
          <div className="sidebar-mini-divider" />
          {NAV_ITEMS.map(({ key, label, icon: Ico }) => (
            <button
              key={key}
              className={`sidebar-mini-btn ${navKey === key ? 'sidebar-mini-active' : ''}`}
              onClick={() => onNav && onNav(key)}
              title={label}
            >
              <Ico size={20} />
            </button>
          ))}
          <div className="sidebar-mini-spacer" />
          {/* Sign out, and nothing else. A store badge sat above this: not a
              button, aria-hidden, no menu behind it - decoration occupying the
              one spot in the collapsed rail where everything else does
              something. The store name is on the expanded sidebar. */}
          {onThemeChange && (() => {
            const ORDER = ['light', 'dark', 'system'];
            const next = ORDER[(ORDER.indexOf(themePreference) + 1) % ORDER.length] || 'dark';
            const Icon = themePreference === 'light' ? Sun : themePreference === 'dark' ? Moon : Monitor;
            return (
              <button
                type="button"
                className="sidebar-mini-btn"
                onClick={(e) => onThemeChange(next, e)}
                title={`Theme: ${themePreference || 'system'}${themePreference === 'system' && theme ? ` (${theme})` : ''} - switch to ${next}`}
                aria-label={`Colour theme, currently ${themePreference || 'system'}. Switch to ${next}.`}
              >
                <Icon size={18} />
              </button>
            );
          })()}
          <button
            type="button"
            className="sidebar-mini-btn sidebar-mini-logout"
            onClick={() => onLogout?.()}
            title="Sign out"
            aria-label={`Sign out of ${storeName || 'your account'}`}
          >
            <LogOut size={18} />
          </button>
        </div>
      )}

      <div className="sidebar-content" style={{ display: collapsed ? 'none' : undefined }}>
        {/* Top row. A11: the wordmark heads the sidebar rather than sitting
            above the page content, so the brand and the navigation read as one
            column. It is the SAME <Wordmark> the marketing header and footer
            render, so the signed-in app and the public site carry one mark. */}
        <div className="sidebar-top-row">
          <span className="sidebar-brand">
            <Wordmark size="sidebar" />
            <span className="sidebar-beta" aria-label="Beta version">BETA</span>
          </span>
          <div className="sidebar-top-actions">
            {/* Collapse button (desktop) */}
            {onCollapse && (
              <button className="sidebar-collapse-btn" onClick={onCollapse} title="Close sidebar">
                <PanelLeftClose size={18} />
              </button>
            )}
            {/* Close button (mobile) */}
            <button className="sidebar-close-btn" onClick={onClose}>
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Navigation. On every screen but Ask Botella this is the plain list.
            On Ask Botella it folds into one row (see `navFolds`) so the
            conversation history gets the column it is the only user of. */}
        <div className={`sidebar-nav ${navFolds ? 'is-folding' : ''}`} ref={navRef}>
          {navFolds && (
            <button
              type="button"
              className={`sidebar-nav-btn sidebar-nav-toggle ${navOpen ? 'is-open' : ''}`}
              onClick={() => setNavOpen((o) => !o)}
              aria-expanded={navOpen}
              aria-controls="sidebar-nav-list"
            >
              <LayoutGrid size={18} />
              {/* One noun in both states. It used to open "Screens" and close
                  a "menu", so the control named two different things depending
                  on which way you were about to push it. */}
              <span>{navOpen ? 'Close menu' : 'Menu'}</span>
              {/* The count must not be hidden behind a disclosure - it is the
                  one thing in this list that is time-sensitive. */}
              {!navOpen && openRecCount > 0 && (
                <span className="sidebar-nav-badge" title={`${openRecCount} open recommendations`}>{openRecCount}</span>
              )}
              <ChevronDown size={16} className={`sidebar-nav-caret ${navOpen ? 'is-open' : ''}`} />
            </button>
          )}

          {(!navFolds || navOpen) && (
            <div className="sidebar-nav-list" id="sidebar-nav-list">
              {NAV_ITEMS.map(({ key, label, icon: Ico }) => (
                <button
                  key={key}
                  className={`sidebar-nav-btn ${navKey === key ? 'sidebar-nav-active' : ''}`}
                  onClick={() => goNav(key)}
                >
                  <Ico size={18} />
                  <span>{label}</span>
                  {key === 'recommendations' && openRecCount > 0 && (
                    <span className="sidebar-nav-badge">{openRecCount}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Conversation history. It belongs to the sidebar, not to the chat
            view: as a column INSIDE the chat it stole a band across the top of
            the transcript (the messages could never use that space), and a long
            list ran off the bottom of the screen behind the composer with
            nothing to scroll. Here it is one scroll region inside a flex
            column that is already height-bounded, so it can never overlap the
            conversation or outgrow the sidebar.

            It appears only on Ask Botella - on the other six screens the
            sidebar stays the seven nav items and the store name. */}
        {navKey === 'ask' && (
          <ConversationHistory
            conversations={conversations}
            activeId={activeId}
            onSelect={onSelect}
            onNewChat={onNewChat}
            onRename={onRename}
            onPin={onPin}
            onDelete={onDelete}
            pinnedIds={pinnedIds}
          />
        )}

        {/* Identity, then the one action. Not a dropdown: the menu that used to
            live here held exactly one item, and dressing it as a store switcher
            (chevron, store icon) promised a feature that does not exist while
            hiding the one that does. */}
        {/* One footer block, pinned to the bottom as a unit. `margin-top: auto`
            used to live on the account row alone, so adding the theme row above
            it left that row floating wherever the nav happened to end while the
            account stayed pinned - two things that read as one control, held
            apart by whatever was above them. */}
        <div className="sidebar-foot">
        {onThemeChange && (
          <div className="sidebar-theme">
            <span className="sidebar-theme-label">Theme</span>
            <ThemeSwitch
              preference={themePreference}
              resolved={theme}
              onChange={onThemeChange}
              className="ts-compact"
            />
          </div>
        )}

        {storeName && (
          <div className="sidebar-account">
            <div className="sidebar-account-id">
              <div className="sidebar-store-icon">
                <Store size={16} />
              </div>
              <div className="sidebar-account-text">
                <span className="sidebar-store-name" title={storeName}>{storeName}</span>
                {userName && <span className="sidebar-account-user" title={userName}>{userName}</span>}
              </div>
            </div>
            <button
              type="button"
              className="sidebar-logout-btn"
              onClick={() => onLogout?.()}
              title="Sign out"
              aria-label={`Sign out of ${storeName || 'your account'}`}
            >
              <LogOut size={16} />
            </button>
          </div>
        )}
        </div>
      </div>

      {/* Resize handle */}
      <div
        className={`sidebar-resize-handle ${isResizing ? 'active' : ''}`}
        onMouseDown={handleMouseDown}
      />
    </aside>
  );
}

export default Sidebar;
