// RotatingWord.js
// -----------------------------------------------------------------------------
// A single inline word/phrase that cycles through a list with a fade + slight
// slide transition. Used in the hero headline ("Best AI Agent for <rotating>").
//
// The old phrase fades out, the text swaps, then the new phrase fades in - so
// it reads as one smooth crossfade. Honors prefers-reduced-motion (stays on the
// first phrase, no animation).
// -----------------------------------------------------------------------------

import React, { useEffect, useState } from 'react';

function RotatingWord({ words, hold = 2200, fade = 450, className = '' }) {
  const [idx, setIdx] = useState(0);
  const [shown, setShown] = useState(true);

  useEffect(() => {
    if (!words || words.length < 2) return undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;

    let swapTimer;
    const cycle = setInterval(() => {
      setShown(false); // fade current phrase out
      swapTimer = setTimeout(() => {
        setIdx((i) => (i + 1) % words.length);
        setShown(true); // swap text + fade the new phrase in
      }, fade);
    }, hold + fade);

    return () => {
      clearInterval(cycle);
      clearTimeout(swapTimer);
    };
  }, [words, hold, fade]);

  return (
    <span className={`lp-rotate ${className} ${shown ? 'is-in' : 'is-out'}`}>
      {words[idx]}
    </span>
  );
}

export default RotatingWord;
