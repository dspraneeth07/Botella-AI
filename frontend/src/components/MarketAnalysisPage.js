import React from 'react';
import { TrendingUp } from 'lucide-react';
import './MarketAnalysisPage.css';

function MarketAnalysisPage() {
  return (
    <div className="ma-container">
      <div className="ma-coming-soon">
        <div className="ma-coming-soon-icon">
          <TrendingUp size={36} />
        </div>
        <span className="ma-coming-soon-pill">Coming Soon</span>
        <h2>Market Analysis</h2>
        <p>
          See market data, regional trends, and category movement beyond your
          own store.
        </p>
      </div>
    </div>
  );
}

export default MarketAnalysisPage;
