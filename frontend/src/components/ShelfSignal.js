// ShelfSignal.js
// -----------------------------------------------------------------------------
// THE SIGNATURE ELEMENT.
//
// A live "store intelligence" visualization: three shelves of SKUs rendered as
// vertical bars, each bar coloured by the state Botella has read from the data -
// moving, slowing, low stock, dead stock. A scan line sweeps the shelves the way
// the agent sweeps the catalog, and a small readout below reports what it found.
//
// Two variants:
//   default   - the hero object. Shelves + readout, framed like a device.
//   console   - the Platform section. Same shelf language, plus an agent action
//               feed so the "it does the next thing" claim is shown, not stated.
//
// Everything is deterministic (fixed seed arrays, no Math.random) so the picture
// is identical on every render, and every moving part is pure CSS animation that
// prefers-reduced-motion switches off. No canvas, no images, no layout shift.
// -----------------------------------------------------------------------------

import React from 'react';
import './ShelfSignal.css';

// Bar heights, 0-100. Three shelves of twelve. Hand-tuned so the silhouette
// reads like a real shelf rather than a chart.
const SHELVES = [
  [62, 78, 45, 88, 54, 71, 36, 92, 60, 48, 83, 55],
  [70, 41, 66, 52, 95, 58, 74, 39, 61, 86, 47, 68],
  [51, 84, 59, 73, 43, 90, 56, 65, 38, 77, 63, 49],
];

// State per bar, indexed the same way. Kept sparse on purpose: a store where
// everything is on fire is not a credible picture.
//   '' = healthy   'fast' = moving fast   'low' = running out   'dead' = idle
const STATES = [
  ['', 'fast', '', '', 'low', '', 'dead', 'fast', '', '', '', ''],
  ['', '', 'low', '', 'fast', '', '', 'dead', '', 'fast', '', ''],
  ['', 'fast', '', '', 'dead', 'fast', '', '', 'low', '', '', ''],
];

const LEGEND = [
  { k: 'fast', label: 'Moving fast' },
  { k: 'low', label: 'Running out' },
  { k: 'dead', label: 'Idle stock' },
];

// The agent action feed for the console variant. Each row is a thing Botella
// actually does: watch, flag, draft, message, report.
const FEED = [
  { tag: 'Inventory', text: 'Maker’s Mark 750ml projected out in 3 days - reorder drafted', tone: 'fuchsia' },
  { tag: 'Margin', text: 'Premium whisky margin up 2.2 pts week over week', tone: 'jade' },
  { tag: 'Dead stock', text: '6 SKUs idle 40+ days - bundle promotion suggested', tone: 'muted' },
  { tag: 'Customers', text: '38 lapsed regulars matched to this week’s offer', tone: 'cyan' },
];

function Shelves({ compact }) {
  return (
    <div className={`ss-shelves ${compact ? 'is-compact' : ''}`}>
      <div className="ss-scan" aria-hidden="true" />
      {SHELVES.map((row, r) => (
        <div className="ss-shelf" key={r}>
          <div className="ss-bars">
            {row.map((h, c) => {
              const state = STATES[r][c];
              return (
                <span
                  key={c}
                  className={`ss-bar ${state ? `is-${state}` : ''}`}
                  style={{
                    '--h': `${h}%`,
                    '--i': `${(r * 12 + c) * 0.035}s`,
                  }}
                />
              );
            })}
          </div>
          <div className="ss-plank" />
        </div>
      ))}
    </div>
  );
}

function ShelfSignal({ variant = 'hero' }) {
  const isConsole = variant === 'console';

  return (
    <figure className={`ss ${isConsole ? 'ss-console' : 'ss-hero'}`}>
      <figcaption className="ss-sr">
        A visualization of Botella reading a store catalog: shelves of products
        where fast-moving, low-stock and idle items are identified automatically.
      </figcaption>

      <div className="ss-frame">
        <div className="ss-head" aria-hidden="true">
          <span className="ss-head-live">
            <span className="ss-head-dot" />
            Live
          </span>
          <span className="ss-head-title">Store intelligence</span>
          <span className="ss-head-meta">{isConsole ? 'Agent feed' : '1,284 SKUs'}</span>
        </div>

        <Shelves compact={isConsole} />

        {isConsole ? (
          <ul className="ss-feed" aria-hidden="true">
            {FEED.map((f, i) => (
              <li
                key={f.text}
                className={`ss-feed-row ss-tone-${f.tone}`}
                style={{ '--i': `${i * 0.9}s` }}
              >
                <span className="ss-feed-tag">{f.tag}</span>
                <span className="ss-feed-text">{f.text}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="ss-readout" aria-hidden="true">
            <div className="ss-readout-row">
              {[
                { v: '7', l: 'reorder now', tone: 'fuchsia' },
                { v: '6', l: 'idle 40+ days', tone: 'muted' },
                { v: '+2.2', l: 'margin pts', tone: 'jade' },
              ].map((r) => (
                <div className={`ss-stat ss-tone-${r.tone}`} key={r.l}>
                  <span className="ss-stat-v">{r.v}</span>
                  <span className="ss-stat-l">{r.l}</span>
                </div>
              ))}
            </div>
            <div className="ss-legend">
              {LEGEND.map((l) => (
                <span className="ss-legend-item" key={l.k}>
                  <span className={`ss-legend-key is-${l.k}`} />
                  {l.label}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </figure>
  );
}

export default ShelfSignal;
