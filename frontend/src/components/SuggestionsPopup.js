import React, { useState, useEffect, useCallback, useRef } from 'react';
import { formatLocalDate } from '../utils/date';
import {
  Lightbulb,
  X,
  Store,
  TrendingUp,
  DollarSign,
  Package,
  Sparkles,
  RefreshCw,
  AlertTriangle,
  Zap,
} from 'lucide-react';
import ReactDOM from 'react-dom';
import { API_BASE as ENV_API_BASE } from '../utils/env';

const API_BASE = ENV_API_BASE;

const ICON_MAP = { Store, TrendingUp, DollarSign, Package };

const CAT_META = {
  overview: { colorClass: 'cat-overview', gradient: 'linear-gradient(135deg, #2FBF97, #059669)' },
  sales: { colorClass: 'cat-sales', gradient: 'linear-gradient(135deg, #8B5CF6, #6D28D9)' },
  margins: { colorClass: 'cat-margins', gradient: 'linear-gradient(135deg, #F0ABFC, #d97706)' },
  inventory: { colorClass: 'cat-inventory', gradient: 'linear-gradient(135deg, #C4A6FF, #7C3AED)' },
};

// Animated number counter
function AnimatedNumber({ value, duration = 800 }) {
  const [display, setDisplay] = useState(value);
  const prevRef = useRef(value);

  useEffect(() => {
    const str = String(value);
    // Only animate pure numbers or $-prefixed numbers
    const match = str.match(/^\$?([\d,.]+[KMB]?)$/);
    if (!match) {
      setDisplay(value);
      return;
    }

    const prefix = str.startsWith('$') ? '$' : '';
    const suffix = str.match(/[KMB]$/)?.[0] || '';
    const numStr = str.replace(/[$,KMB]/g, '');
    const target = parseFloat(numStr);

    if (isNaN(target)) {
      setDisplay(value);
      return;
    }

    const prevStr = String(prevRef.current);
    const prevNumStr = prevStr.replace(/[$,KMB]/g, '');
    const start = parseFloat(prevNumStr) || 0;
    prevRef.current = value;

    if (start === target) {
      setDisplay(value);
      return;
    }

    const startTime = performance.now();
    let raf;

    const animate = (now) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = start + (target - start) * eased;

      const hasDecimal = numStr.includes('.');
      const formatted = hasDecimal
        ? current.toFixed(numStr.split('.')[1]?.length || 1)
        : Math.round(current).toLocaleString();

      setDisplay(`${prefix}${formatted}${suffix}`);

      if (progress < 1) {
        raf = requestAnimationFrame(animate);
      }
    };

    raf = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  return <>{display}</>;
}

// Shimmer loading placeholder
function ShimmerCard({ delay = 0 }) {
  return (
    <div className="ins-card ins-shimmer-card" style={{ animationDelay: `${delay}ms` }}>
      <div className="ins-shimmer-header" />
      <div className="ins-shimmer-body">
        <div className="ins-shimmer-line w60" />
        <div className="ins-shimmer-line w80" />
        <div className="ins-shimmer-line w40" />
        <div className="ins-shimmer-line w70" />
      </div>
    </div>
  );
}

function SuggestionsPopup({ onSuggestionClick, onCloseSidebar }) {
  const [isOpen, setIsOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const fetchedRef = useRef(false);

  const fetchInsights = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem('botella_token');
      const res = await fetch(`${API_BASE}/insights`, {
        headers: {
          'ngrok-skip-browser-warning': 'true',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
      });
      if (!res.ok) throw new Error('Failed to load insights');
      const json = await res.json();
      setData(json);
      fetchedRef.current = true;
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleOpen = () => {
    setIsOpen(true);
    setClosing(false);
    if (!fetchedRef.current) fetchInsights();
  };

  const handleClose = useCallback(() => {
    setClosing(true);
    setTimeout(() => {
      setIsOpen(false);
      setClosing(false);
    }, 280);
  }, []);

  const handleRefresh = () => {
    fetchedRef.current = false;
    fetchInsights();
  };

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e) => { if (e.key === 'Escape') handleClose(); };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, handleClose]);

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  // Render metric
  const renderMetric = (item, idx, catId) => (
    <div
      key={idx}
      className={`ins-metric ${item.highlight ? 'ins-highlight' : ''}`}
      style={{ animationDelay: `${300 + idx * 80}ms` }}
    >
      <span className="ins-metric-label">{item.label}</span>
      <span className="ins-metric-value">
        <AnimatedNumber value={item.value} />
      </span>
      {item.sub && <span className="ins-metric-sub">{item.sub}</span>}
    </div>
  );

  // Render table
  const renderTable = (item, idx) => (
    <div
      key={idx}
      className={`ins-table-wrap ${item.warning ? 'ins-warning' : ''}`}
      style={{ animationDelay: `${500 + idx * 100}ms` }}
    >
      <div className="ins-table-label">
        {item.warning && <AlertTriangle size={12} />}
        {item.label}
      </div>
      <div className="ins-table-scroll">
        <table className="ins-table">
          <thead>
            <tr>
              {item.columns.map((col, ci) => <th key={ci}>{col}</th>)}
            </tr>
          </thead>
          <tbody>
            {item.rows.map((row, ri) => (
              <tr key={ri} style={{ animationDelay: `${600 + ri * 60}ms` }}>
                {row.map((cell, ci) => <td key={ci}>{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <>
      <button className="ins-trigger" onClick={handleOpen}>
        <div className="ins-trigger-glow" />
        <Zap size={15} />
        <span>Insights</span>
        <Sparkles size={13} className="ins-trigger-sparkle" />
      </button>

      {isOpen &&
        ReactDOM.createPortal(
          <div className={`ins-overlay ${closing ? 'ins-closing' : ''}`} onClick={handleClose}>
            <div
              className={`ins-modal ${closing ? 'ins-modal-closing' : ''}`}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Floating particles background */}
              <div className="ins-particles">
                {[...Array(6)].map((_, i) => (
                  <div key={i} className={`ins-particle p${i}`} />
                ))}
              </div>

              {/* Header */}
              <div className="ins-header">
                <div className="ins-header-left">
                  <div className="ins-header-icon">
                    <Lightbulb size={22} />
                  </div>
                  <div>
                    <h2 className="ins-title">Live Insights</h2>
                    <p className="ins-subtitle">
                      {data?.latestSaleDate
                        ? `Data through ${formatLocalDate(data.latestSaleDate, { month: 'long', day: 'numeric', year: 'numeric' })}`
                        : 'Real-time analysis from your store'}
                    </p>
                  </div>
                </div>
                <div className="ins-header-actions">
                  <button
                    className={`ins-refresh-btn ${loading ? 'ins-spinning' : ''}`}
                    onClick={handleRefresh}
                    disabled={loading}
                    title="Refresh data"
                  >
                    <RefreshCw size={15} />
                  </button>
                  <button className="ins-close-btn" onClick={handleClose}>
                    <X size={18} />
                  </button>
                </div>
              </div>

              {/* Body */}
              <div className="ins-body">
                {/* Loading shimmer */}
                {loading && !data && (
                  <div className="ins-grid">
                    {[0, 1, 2, 3].map((i) => <ShimmerCard key={i} delay={i * 120} />)}
                  </div>
                )}

                {/* Error */}
                {error && !data && (
                  <div className="ins-error-state">
                    <div className="ins-error-icon">
                      <AlertTriangle size={32} />
                    </div>
                    <h3>Could not load insights</h3>
                    <p>{error}</p>
                    <button className="ins-retry-btn" onClick={handleRefresh}>
                      <RefreshCw size={14} />
                      Try Again
                    </button>
                  </div>
                )}

                {/* Data cards */}
                {data?.categories && (
                  <div className="ins-grid">
                    {data.categories.map((cat, ci) => {
                      const IconComp = ICON_MAP[cat.icon] || Store;
                      const meta = CAT_META[cat.id] || CAT_META.overview;
                      return (
                        <div
                          key={cat.id}
                          className={`ins-card ${meta.colorClass}`}
                          style={{ animationDelay: `${ci * 100}ms` }}
                        >
                          {/* Card glow edge */}
                          <div className="ins-card-glow" style={{ background: meta.gradient }} />

                          {/* Card header */}
                          <div className="ins-card-header" style={{ background: meta.gradient }}>
                            <div className="ins-card-header-icon">
                              <IconComp size={18} />
                            </div>
                            <span>{cat.title}</span>
                          </div>

                          {/* Card content */}
                          <div className="ins-card-body">
                            {/* Metrics */}
                            {cat.insights.some(i => i.type === 'metric') && (
                              <div className="ins-metrics-grid">
                                {cat.insights
                                  .filter(i => i.type === 'metric')
                                  .map((item, idx) => renderMetric(item, idx, cat.id))}
                              </div>
                            )}
                            {/* Tables */}
                            {cat.insights
                              .filter(i => i.type === 'table')
                              .map((item, idx) => renderTable(item, idx))}
                            {/* Text fallbacks */}
                            {cat.insights
                              .filter(i => i.type === 'text')
                              .map((item, idx) => (
                                <div key={idx} className="ins-metric" style={{ animationDelay: `${300 + idx * 80}ms` }}>
                                  <span className="ins-metric-label">{item.label}</span>
                                  <span className="ins-metric-value">{item.value}</span>
                                </div>
                              ))}
                          </div>

                          {/* Refresh shimmer overlay */}
                          {loading && data && (
                            <div className="ins-card-refreshing">
                              <div className="ins-card-refresh-shimmer" />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}

export default SuggestionsPopup;
