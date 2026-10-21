import React, { useState } from 'react';
import { Lightbulb, Store, Target, PackageCheck } from 'lucide-react';
import SuggestionsPage from './SuggestionsPage';
import EffectivenessPage from './EffectivenessPage';
import PoEffectiveness from './PoEffectiveness';
import StoreAgentPanel from '../storeagent/StoreAgentPanel';
import { SHOW_EFFECTIVENESS } from '../utils/features';
import './RecommendationsView.css';

// The Recommendations tab hosts three views behind a sub-tab toggle:
//   - "AI Recommendations" (tab id 'suggestions'): the daily, signal-aware
//     recommendation cards.
//   - "Effectiveness" (tab id 'effectiveness'): measured outcomes of past
//     recommendations - winners/underperformers, acted-as-recommended, lift.
//     ON since migration 039: "acted" now means confirmed by the store's own
//     data (purchases feed, invoice, stock inflow, price drop, catalogue
//     arrival), never an owner's click, so the figures it prints are ones a
//     store can check. SHOW_EFFECTIVENESS_TAB follows SHOW_EFFECTIVENESS in
//     utils/features.js - it used to be a separate literal, which meant the
//     sidebar item and this sub-tab could be withdrawn one without the other,
//     and a hidden screen stayed one click away. The ActionCheckBar feedback
//     banner lives inside EffectivenessPage.
//   - "Store Intelligence" (tab id 'storeagent'): the deterministic decision
//     dashboard (pricing, buying, etc.), which renders its own capability tab
//     strip underneath.
// Store Intelligence is mounted lazily (only when its sub-tab is opened) so it doesn't
// warm every capability cache for users who never open it. Its result caches are
// module-scoped, so re-opening the sub-tab is instant.
const SHOW_EFFECTIVENESS_TAB = SHOW_EFFECTIVENESS;
export default function RecommendationsView({ authToken, apiUrl, onAnalyse }) {
  const [tab, setTab] = useState(() => {
    // One-shot deep links: the Effectiveness sidebar item opens the Purchase
    // Orders tab; the startup digest / Store-Intelligence links open storeagent.
    try {
      if (sessionStorage.getItem('botella_open_po_eff') === '1') {
        sessionStorage.removeItem('botella_open_po_eff');
        return 'po-effectiveness';
      }
      if (sessionStorage.getItem('botella_open_storeagent') === '1') {
        sessionStorage.removeItem('botella_open_storeagent');
        return 'storeagent';
      }
    } catch {
      /* sessionStorage unavailable */
    }
    return 'suggestions';
  });

  return (
    <div className="rec-view">
      <div className="rec-subtabs" role="tablist" aria-label="Recommendations sections">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'suggestions'}
          className={`rec-subtab ${tab === 'suggestions' ? 'rec-subtab-active' : ''}`}
          onClick={() => setTab('suggestions')}
        >
          <Lightbulb size={16} />
          <span>AI Recommendations</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'storeagent'}
          className={`rec-subtab ${tab === 'storeagent' ? 'rec-subtab-active' : ''}`}
          onClick={() => setTab('storeagent')}
        >
          <Store size={16} />
          <span>Store Intelligence</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'po-effectiveness'}
          className={`rec-subtab ${tab === 'po-effectiveness' ? 'rec-subtab-active' : ''}`}
          onClick={() => setTab('po-effectiveness')}
        >
          <PackageCheck size={16} />
          <span>Purchase Orders</span>
        </button>
        {SHOW_EFFECTIVENESS_TAB && (
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'effectiveness'}
            className={`rec-subtab ${tab === 'effectiveness' ? 'rec-subtab-active' : ''}`}
            onClick={() => setTab('effectiveness')}
          >
            <Target size={16} />
            <span>Effectiveness</span>
          </button>
        )}
      </div>

      <div className="rec-subpanel">
        {tab === 'suggestions' ? (
          <SuggestionsPage authToken={authToken} apiUrl={apiUrl} onAnalyse={onAnalyse} />
        ) : tab === 'po-effectiveness' ? (
          <PoEffectiveness authToken={authToken} apiUrl={apiUrl} />
        ) : tab === 'effectiveness' ? (
          <EffectivenessPage authToken={authToken} apiUrl={apiUrl} />
        ) : (
          <StoreAgentPanel />
        )}
      </div>
    </div>
  );
}
