import React, { useState, useEffect } from 'react';
import { formatLocalDate } from '../utils/date';
import {
  X, DollarSign, ShoppingCart, TrendingUp, Package,
  AlertTriangle, Lightbulb, Wine, Loader, Percent,
} from 'lucide-react';
import { API_BASE as ENV_API_BASE } from '../utils/env';

const API_BASE = ENV_API_BASE;

function DailySummary({ onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchSummary = async () => {
      try {
        const token = localStorage.getItem('botella_token');
        const res = await fetch(`${API_BASE}/summary`, {
          headers: {
            'ngrok-skip-browser-warning': 'true',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
          },
        });
        if (res.status === 401) {
          localStorage.removeItem('botella_token');
          window.location.href = '/login';
          return;
        }
        if (!res.ok) throw new Error('Failed to fetch');
        const json = await res.json();
        setData(json);
      } catch (err) {
        setError('Could not load daily summary. Please try again.');
      } finally {
        setLoading(false);
      }
    };
    fetchSummary();
  }, []);

  const formatMoney = (val) =>
    '$' + Number(val || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const formatDate = (dateStr) => {
    if (!dateStr) return 'N/A';
    return formatLocalDate(dateStr, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  };

  return (
    <div className="summary-overlay" onClick={onClose}>
      <div className="summary-ring" onClick={(e) => e.stopPropagation()}>
        <div className="summary-modal">
          {/* Header */}
          <div className="summary-header">
            <div className="summary-header-left">
              <div className="summary-header-icon"><Wine size={20} /></div>
              <div>
                <h2>Daily Briefing</h2>
                <span className="summary-subtitle">Your store at a glance</span>
              </div>
            </div>
            <button className="summary-close" onClick={onClose}><X size={18} /></button>
          </div>

        {/* Content */}
        <div className="summary-body">
          {loading && (
            <div className="summary-loading">
              <Loader size={24} className="summary-spinner" />
              <span>Loading your daily summary...</span>
            </div>
          )}

          {error && (
            <div className="summary-error">
              <AlertTriangle size={20} />
              <span>{error}</span>
            </div>
          )}

          {data && !loading && (
            <>
              {/* Sales Section */}
              {data.sales && (
                <div className="summary-section">
                  <h3 className="summary-section-title">
                    <TrendingUp size={16} />
                    Sales - {formatDate(data.sales.date)}
                  </h3>

                  <div className="summary-stats">
                    <div className="summary-stat">
                      <DollarSign size={18} />
                      <div>
                        <span className="stat-value">{formatMoney(data.sales.total_revenue)}</span>
                        <span className="stat-label">Revenue</span>
                      </div>
                    </div>
                    <div className="summary-stat">
                      <ShoppingCart size={18} />
                      <div>
                        <span className="stat-value">{data.sales.total_transactions}</span>
                        <span className="stat-label">Transactions</span>
                      </div>
                    </div>
                    <div className="summary-stat">
                      <Package size={18} />
                      <div>
                        <span className="stat-value">{data.sales.total_units}</span>
                        <span className="stat-label">Units Sold</span>
                      </div>
                    </div>
                    <div className="summary-stat">
                      <TrendingUp size={18} />
                      <div>
                        <span className="stat-value">{formatMoney(data.sales.total_profit)}</span>
                        <span className="stat-label">Profit</span>
                      </div>
                    </div>
                    {/* Same costed-subset formula + gate as the Dashboard, so
                        the two surfaces always agree on the definition. */}
                    {data.sales.gross_margin_pct != null && (
                      <div className="summary-stat" title={data.sales.margin_note || undefined}>
                        <Percent size={18} />
                        <div>
                          <span className="stat-value">{Number(data.sales.gross_margin_pct).toFixed(1)}%</span>
                          <span className="stat-label">Gross Margin</span>
                        </div>
                      </div>
                    )}
                  </div>

                  {data.sales.top_products?.length > 0 && (
                    <div className="summary-top-products">
                      <h4>Top Sellers</h4>
                      <div className="summary-product-list">
                        {data.sales.top_products.map((p, i) => (
                          <div key={i} className="summary-product-row">
                            <span className="product-rank">#{i + 1}</span>
                            <span className="product-name">{p.name?.trim()}</span>
                            <span className="product-units">{p.units} units</span>
                            <span className="product-revenue">{formatMoney(p.revenue)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Slow Inventory Section */}
              {data.slow_inventory?.length > 0 && (
                <div className="summary-section">
                  <h3 className="summary-section-title summary-warning">
                    <AlertTriangle size={16} />
                    Slow-Moving Inventory ({data.slow_inventory.length} items)
                  </h3>

                  <div className="summary-slow-list">
                    {data.slow_inventory.map((item, i) => (
                      <div key={i} className="summary-slow-item">
                        <div className="slow-item-top">
                          <span className="slow-item-name">{item.name}</span>
                          <span className="slow-item-days">{item.days_since_sale}d</span>
                        </div>
                        <div className="slow-item-details">
                          <span>{item.category}</span>
                          <span>{item.total_units} units</span>
                          <span>{formatMoney(item.price)} retail</span>
                          <span>{formatMoney(item.cost)} cost</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* AI Suggestions */}
              {data.suggestions?.length > 0 && (
                <div className="summary-section">
                  <h3 className="summary-section-title summary-tips">
                    <Lightbulb size={16} />
                    AI Suggestions
                  </h3>
                  <ul className="summary-suggestions">
                    {data.suggestions.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* No data state */}
              {!data.sales && data.slow_inventory?.length === 0 && (
                <div className="summary-empty">
                  <Wine size={32} />
                  <p>No sales data or inventory alerts to show right now.</p>
                </div>
              )}
            </>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}

export default DailySummary;
