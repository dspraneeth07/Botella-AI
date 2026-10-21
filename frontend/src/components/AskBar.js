// AskBar.js
// -----------------------------------------------------------------------------
// The persistent assistant bar: a glass pill pinned to the bottom of the content
// area, over whatever page is open. Mark on the left, the question in the
// middle, the run button on the right.
//
// It lives in the app SHELL rather than on any one page, so it is the same
// object on the dashboard, statistics, recommendations and market intelligence -
// the "ask a human question" affordance is always in the same place, the way a
// support assistant always is. Submitting opens a fresh conversation in the chat
// view and streams the answer straight away; the question is never left sitting
// in a box waiting for a second click.
//
// It is deliberately NOT rendered on the chat view itself - see ChatPage, where
// the real composer already occupies that spot.
//
// The suggestions are not filler. They are questions this product answers well
// and no tile on the dashboard can, which is the case for the bar existing at
// all. They appear on focus so the resting state stays a single quiet line.
// -----------------------------------------------------------------------------

import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Sparkles } from 'lucide-react';
import './AskBar.css';

const SUGGESTIONS = [
  'Which products should I stop carrying?',
  'What sold best last weekend?',
  'Where am I losing margin?',
];

// How long the dispatch gesture runs before the chat takes over. Deliberately
// under the ~200ms that starts reading as lag: long enough to see the pill
// release the question, short enough that the button still feels instant.
const LAUNCH_MS = 180;

function AskBar({ onAsk }) {
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  const [launching, setLaunching] = useState(false);
  const timer = useRef(null);

  // A pending hand-off must not fire into an unmounted tree.
  useEffect(() => () => clearTimeout(timer.current), []);

  const send = (q) => {
    const text = String(q || '').trim();
    if (!text || !onAsk || launching) return;

    // The question stays visible through the gesture rather than clearing on
    // click - watching your own words leave is what makes the two views feel
    // like one movement instead of a cut.
    setLaunching(true);
    setFocused(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      onAsk(text);
      setValue('');
      setLaunching(false);
    }, LAUNCH_MS);
  };

  return (
    <div className="ab-dock">
      <div className={`ab ${focused ? 'is-focused' : ''} ${launching ? 'is-launching' : ''}`}>
        {/* Above the bar, so opening them never pushes the bar off the screen
            edge it is anchored to. */}
        <ul className="ab-chips" aria-hidden={!focused}>
          {SUGGESTIONS.map((q) => (
            <li key={q}>
              <button
                type="button"
                className="ab-chip"
                tabIndex={focused ? 0 : -1}
                // mousedown, not click: the input's blur would tear the chip
                // out from under the pointer before a click could land.
                onMouseDown={(e) => { e.preventDefault(); send(q); }}
              >
                {q}
              </button>
            </li>
          ))}
        </ul>

        <form
          className="ab-bar glass"
          role="search"
          onSubmit={(e) => { e.preventDefault(); send(value); }}
        >
          {/* Drawn, not an image. logo.png is a wordmark and favicon.svg
              carries its own baked-in indigo square - neither sits well inside a
              glass pill. A "B." in the brand gradient on a glass disc is the
              wordmark's own initial and full stop, so the pill, the sidebar mark
              and the site header all read as one brand at any size. */}
          <span className="ab-mark" aria-hidden="true">
            <span className="ab-mark-glyph">B<em>.</em></span>
          </span>

          <label className="ab-field">
            <span className="sr-only">Ask Botella about your store</span>
            <input
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder="Ask Botella anything about your store…"
              autoComplete="off"
              enterKeyHint="go"
            />
          </label>

          <button type="submit" className="ab-go" disabled={!value.trim() || launching}>
            <Sparkles size={14} />
            <span>Ask now</span>
            <ArrowRight size={15} className="ab-go-arrow" />
          </button>
        </form>
      </div>
    </div>
  );
}

export default AskBar;
