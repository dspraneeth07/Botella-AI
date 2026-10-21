import React, { useState, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react';
import { X, BoxSelect, Package, Lightbulb, Loader, Calendar, TrendingDown } from 'lucide-react';
import { formatLocalDate } from '../utils/date';
import './DeadStockPopup.css';

const DeadStockPopup = forwardRef(function DeadStockPopup({ authToken, apiUrl }, ref) {
  // Store-specific key so each store gets its own daily popup
  const storeId = localStorage.getItem('botella_location_id') || 'default';
  const STORAGE_KEY = `botella_dead_stock_shown_${storeId}`;
  const [visible, setVisible] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('suggestions');
  const [animateIn, setAnimateIn] = useState(false);

  const shouldShowToday = useCallback(() => {
    try {
      const lastShown = localStorage.getItem(STORAGE_KEY);
      if (!lastShown) return true;
      const today = new Date().toDateString();
      return lastShown !== today;
    } catch {
      return true;
    }
  }, [STORAGE_KEY]);

  const markShownToday = useCallback(() => {
    try {
      localStorage.setItem(STORAGE_KEY, new Date().toDateString());
    } catch {}
  }, [STORAGE_KEY]);

  const fetchAndShow = useCallback(async () => {
    if (!authToken) return;
    try {
      setLoading(true);
      setVisible(true);
      setActiveTab('suggestions');
      // Start animation immediately (show loading state)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setAnimateIn(true));
      });

      // Strip trailing /api if present to avoid double /api/api
      const base = apiUrl.replace(/\/api\/?$/, '');
      const res = await fetch(`${base}/api/dead-stock`, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
          'ngrok-skip-browser-warning': 'true',
        },
      });

      if (!res.ok) throw new Error('Failed to fetch');

      const json = await res.json();
      if (json.items && json.items.length > 0) {
        setData(json);
        // Cache for SuggestionsPage to reuse (avoid extra API calls)
        try {
          localStorage.setItem(`botella_dead_stock_data_${storeId}`, JSON.stringify({
            data: json,
            date: new Date().toDateString(),
          }));
        } catch {}
      } else {
        setData({ items: [], suggestions: [], total_dead_stock_count: 0, message: 'No dead stock items found.' });
      }
    } catch (err) {
      setData({ items: [], suggestions: [], total_dead_stock_count: 0, message: 'Failed to load suggestions.' });
    } finally {
      setLoading(false);
    }
  }, [authToken, apiUrl]);

  // Expose open() method to parent via ref
  useImperativeHandle(ref, () => ({
    open: () => fetchAndShow(),
  }), [fetchAndShow]);

  // Auto-popup DISABLED - the Suggestions tab is currently marked "coming soon",
  // so the daily Dead Stock alert is suppressed. The forwardRef `open()` API is
  // left intact so the popup can still be manually triggered later if needed;
  // to re-enable the daily auto-popup, restore the useEffect below.
  //
  // useEffect(() => {
  //   if (!shouldShowToday() || !authToken) return;
  //   const timer = setTimeout(() => {
  //     fetchAndShow();
  //     markShownToday();
  //   }, 2000);
  //   return () => clearTimeout(timer);
  // }, [authToken, shouldShowToday, markShownToday, fetchAndShow]);

  const handleClose = () => {
    setAnimateIn(false);
    setTimeout(() => {
      setVisible(false);
      setData(null);
    }, 300);
  };

  if (!visible) return null;

  const parseSuggestion = (text) => {
    const match = text.match(/^\*\*(.*?)\*\*\s*[---]\s*(.*)$/);
    if (match) return { title: match[1], detail: match[2] };
    return { title: '', detail: text.replace(/^[-•*]\s*/, '') };
  };

  return (
    <div className={`ds-overlay ${animateIn ? 'ds-overlay-visible' : ''}`} onClick={handleClose}>
      <div className={`ds-popup ${animateIn ? 'ds-popup-visible' : ''}`} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="ds-header">
          <div className="ds-header-icon">
            <BoxSelect size={20} />
          </div>
          <div className="ds-header-text">
            <h3>Dead Stock Alert</h3>
            <p>
              {loading
                ? 'Analyzing your inventory...'
                : data?.total_dead_stock_count
                  ? `${data.total_dead_stock_count} items haven't sold in 90+ days`
                  : data?.message || 'No dead stock found'}
            </p>
          </div>
          <button className="ds-close" onClick={handleClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {loading ? (
          <div className="ds-loading">
            <div className="ds-loading-spinner">
              <Loader size={24} className="ds-spin" />
            </div>
            <p>Generating suggestions for your store...</p>
          </div>
        ) : data && data.items.length > 0 ? (
          <>
            {/* Tabs */}
            <div className="ds-tabs">
              <button
                className={`ds-tab ${activeTab === 'suggestions' ? 'ds-tab-active' : ''}`}
                onClick={() => setActiveTab('suggestions')}
              >
                <Lightbulb size={14} />
                Suggestions
              </button>
              <button
                className={`ds-tab ${activeTab === 'items' ? 'ds-tab-active' : ''}`}
                onClick={() => setActiveTab('items')}
              >
                <Package size={14} />
                Dead Items ({data.items.length})
              </button>
            </div>

            {/* Content */}
            <div className="ds-content">
              {activeTab === 'suggestions' && (
                <div className="ds-suggestions">
                  {data.suggestions.map((s, i) => {
                    const parsed = parseSuggestion(s);
                    return (
                      <div className="ds-suggestion" key={i} style={{ animationDelay: `${i * 0.08}s` }}>
                        <div className="ds-suggestion-num">{i + 1}</div>
                        <div className="ds-suggestion-body">
                          {parsed.title && <div className="ds-suggestion-title">{parsed.title}</div>}
                          <div className="ds-suggestion-detail">{parsed.detail}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {activeTab === 'items' && (
                <div className="ds-items">
                  {data.items.map((item, i) => (
                    <div className="ds-item" key={i} style={{ animationDelay: `${i * 0.06}s` }}>
                      <div className="ds-item-main">
                        <div className="ds-item-name">{item.name}</div>
                        <div className="ds-item-cat">{item.category}</div>
                      </div>
                      {/* Stats row - mirrors the SuggestionsPage layout:
                          icon + value + label, horizontally arranged. The
                          Days Idle stat must handle `days_since_sale === null`
                          (item never sold) - otherwise the prior code rendered
                          a stray "d" with no number in front of it. */}
                      <div className="ds-item-stats">
                        <div className="ds-stat">
                          <Package size={14} />
                          <span className="ds-stat-value">{item.total_units}</span>
                          <span className="ds-stat-label">units</span>
                        </div>
                        {item.price > 0 && (
                          <div className="ds-stat">
                            <TrendingDown size={14} />
                            <span className="ds-stat-value">${item.price.toFixed(2)}</span>
                            <span className="ds-stat-label">price</span>
                          </div>
                        )}
                        <div className="ds-stat ds-stat-danger">
                          <Calendar size={14} />
                          <span className="ds-stat-value">
                            {item.days_since_sale != null ? `${item.days_since_sale}d` : 'Never'}
                          </span>
                          <span className="ds-stat-label">
                            {item.days_since_sale != null ? 'idle' : 'sold'}
                          </span>
                        </div>
                      </div>
                      {item.last_sale_date && item.last_sale_date !== 'Never sold' && (
                        <div className="ds-item-last-sale">
                          Last sold: {formatLocalDate(item.last_sale_date, { month: 'short', day: 'numeric', year: 'numeric' })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="ds-empty">
            <Package size={32} />
            <p>{data?.message || 'No dead stock items found. Your inventory is healthy!'}</p>
          </div>
        )}

        {/* Footer */}
        <div className="ds-footer">
          <button className="ds-footer-btn" onClick={handleClose}>
            Got it, thanks
          </button>
        </div>
      </div>
    </div>
  );
});

export default DeadStockPopup;
