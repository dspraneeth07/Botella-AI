// CustomCursor.js
// -----------------------------------------------------------------------------
// "Glow spotlight" cursor for the marketing pages: a soft, blurred indigo glow
// follows the pointer with a gentle trailing lag. The normal system cursor
// stays visible - this is purely an ambient glow underneath it.
//
// Desktop-only: skips touch / coarse-pointer devices and prefers-reduced-motion.
// Updates run via a ref + requestAnimationFrame (no React re-renders) and the
// glow is pointer-events:none so it never blocks clicks.
//
// Mounted inside the marketing shell (LandingPage + ContentLayout) only.
// -----------------------------------------------------------------------------

import React, { useEffect, useRef } from 'react';
import './CustomCursor.css';

function CustomCursor() {
  const glowRef = useRef(null);

  useEffect(() => {
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!fine || reduce) return undefined;

    const glow = glowRef.current;
    if (!glow) return undefined;

    let mx = window.innerWidth / 2;
    let my = window.innerHeight / 2;
    let gx = mx;
    let gy = my;
    let raf = 0;
    let shown = false;

    const onMove = (e) => {
      mx = e.clientX;
      my = e.clientY;
      if (!shown) { shown = true; glow.style.opacity = '1'; }
    };
    const onLeave = () => { shown = false; glow.style.opacity = '0'; };

    const loop = () => {
      gx += (mx - gx) * 0.15;
      gy += (my - gy) * 0.15;
      glow.style.transform = `translate(${gx}px, ${gy}px) translate(-50%, -50%)`;
      raf = requestAnimationFrame(loop);
    };
    loop();

    window.addEventListener('mousemove', onMove, { passive: true });
    document.addEventListener('mouseleave', onLeave);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseleave', onLeave);
    };
  }, []);

  return <div ref={glowRef} className="cursor-glow" aria-hidden="true" />;
}

export default CustomCursor;
