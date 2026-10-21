// ThemeSwitch.js
// -----------------------------------------------------------------------------
// The theme control: Light / Dark / System, as three segments rather than a
// two-state toggle.
//
// A toggle cannot express "follow my OS" - it only has two positions, so the
// System option has nowhere to live. Three segments show all three states at
// once and show which one is active, which a toggle also cannot do (a sun icon
// alone never tells you whether you are in light mode or being offered it).
// -----------------------------------------------------------------------------

import React from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import './ThemeSwitch.css';

const OPTIONS = [
  { key: 'light', label: 'Light', Icon: Sun },
  { key: 'dark', label: 'Dark', Icon: Moon },
  { key: 'system', label: 'System', Icon: Monitor },
];

function ThemeSwitch({ preference, resolved, onChange, className = '' }) {
  return (
    <div
      className={`ts ${className}`.trim()}
      role="radiogroup"
      aria-label="Colour theme"
    >
      {OPTIONS.map(({ key, label, Icon }) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={preference === key}
          className={`ts-opt ${preference === key ? 'is-on' : ''}`}
          // The event is passed on purpose: ChatPage uses the clicked
          // segment's position as the origin of the circular wipe. Dropping it
          // silently downgraded every theme change to a hard cut.
          onClick={(e) => onChange(key, e)}
          // The System option says what it RESOLVED to, not just what it is.
          // Someone who picks System and gets dark on a light desktop has no
          // way to tell whether the app ignored them or their browser reported
          // dark; this makes the app's reading visible so the two can be told
          // apart without a console.
          title={key === 'system'
            ? `Follow my system setting${resolved ? ` (your browser currently reports ${resolved})` : ''}`
            : `${label} theme`}
        >
          <Icon size={15} />
          <span className="ts-label">{label}</span>
          {key === 'system' && preference === 'system' && resolved && (
            <span className="ts-resolved" aria-hidden="true">{resolved === 'dark' ? 'dark' : 'light'}</span>
          )}
        </button>
      ))}
    </div>
  );
}

export default ThemeSwitch;
