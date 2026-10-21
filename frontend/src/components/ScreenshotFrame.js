// ScreenshotFrame.js
// -----------------------------------------------------------------------------
// Framed product screenshot with a click-to-enlarge lightbox.
//
// Dense dashboard / chat captures are illegible when shrunk into the SEO hero
// column, so this shows a tidy framed *preview* and lets the visitor click to
// open the full-resolution image in a lightbox (Esc / click backdrop / ✕ to
// close).
//
// IMPORTANT: one image file powers BOTH the preview and the lightbox - pass the
// same `/screenshots/<name>.png` you'd put in a plain <img>. So the "drop one
// PNG into frontend/public/screenshots/" workflow is unchanged.
// -----------------------------------------------------------------------------

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';

function ScreenshotFrame({
  src,
  alt,
  // Placeholder ratio, used ONLY until the image reports its own. It reserves
  // roughly the right space so the page does not jump when the image lands; it
  // no longer decides how the image is cropped, because it never knew the
  // image's real shape.
  ratio = '4 / 3',
  focus = 'top center',
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  // The frame takes its aspect ratio FROM THE IMAGE.
  //
  // Every caller was passing a ratio that matched no file: 16/9 for a 2.000
  // image, 4/3 for a 0.765 one. With `object-fit: cover` that difference is
  // not a rounding error, it is a crop - between 11% and 43% of each product
  // screenshot was being cut off, which is how "RETAIL VALUE" arrived on the
  // page as "TAIL VALUE".
  //
  // Measuring the image removes the guess entirely, and means a new capture
  // dropped into public/screenshots just works at whatever shape it happens to
  // be.
  const imgRef = useRef(null);
  const [naturalRatio, setNaturalRatio] = useState(null);
  const readRatio = useCallback((el) => {
    if (el && el.naturalWidth > 0 && el.naturalHeight > 0) {
      setNaturalRatio(`${el.naturalWidth} / ${el.naturalHeight}`);
    }
  }, []);

  // A cached image can finish loading before React attaches onLoad, in which
  // case that event never fires. Checking `complete` on mount covers it - the
  // common case on a second visit.
  useEffect(() => {
    const el = imgRef.current;
    if (el && el.complete) readRatio(el);
  }, [src, readRatio]);

  // While the lightbox is open: Esc closes it, and the page behind is locked
  // from scrolling (same pattern as DemoPopup).
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, close]);

  return (
    <figure className="cp-shot">
      <div className="cp-shot-frame">
        {/* The clickable preview. Crops to the top of the image so the most
            meaningful part shows; full image opens in the lightbox. */}
        <button
          type="button"
          className="cp-shot-body"
          style={{ aspectRatio: naturalRatio || ratio }}
          onClick={() => setOpen(true)}
          aria-label={`Enlarge screenshot: ${alt}`}
        >
          <img
            ref={imgRef}
            src={src}
            alt={alt}
            loading="lazy"
            onLoad={(e) => readRatio(e.currentTarget)}
            style={{ objectPosition: focus }}
          />
          <span className="cp-shot-zoom">⤢&nbsp; Click to enlarge</span>
        </button>
      </div>

      {/* The lightbox is PORTALLED to document.body, and that is load-bearing.
          Every SEO page wraps its sections in `.cp-rich`, whose rule
          `.cp-rich > * { position: relative; z-index: 1 }` gives each direct
          child section its own stacking context. Rendered in place, the
          overlay's `z-index: 1200` therefore only competed INSIDE the hero
          section - and the next section, a later sibling at the same z-index:1,
          painted straight over it. That is why enlarging a screenshot showed
          the following section's heading on top of the image.
          A portal takes the overlay out of that hierarchy entirely, so no page
          layout can put anything above it. */}
      {open && createPortal((
        <div
          className="cp-shot-lightbox"
          onClick={close}
          role="dialog"
          aria-modal="true"
          aria-label={alt}
        >
          <button
            type="button"
            className="cp-shot-lightbox-close"
            onClick={close}
            aria-label="Close enlarged screenshot"
          >
            ✕
          </button>
          {/* stopPropagation so clicking the image itself doesn't close */}
          <img src={src} alt={alt} onClick={(e) => e.stopPropagation()} />
        </div>
      ), document.body)}
    </figure>
  );
}

export default ScreenshotFrame;
