// useCellTitles.js
// -----------------------------------------------------------------------------
// A tooltip on every table cell whose text does not fit.
//
// These tables clip with `text-overflow: ellipsis`, so any value longer than its
// column is silently cut: "Already selling at or a…", "+3-5 units / yr · +$7…".
// Hand-adding `title` to the cells that need one has been tried twice in this
// file's history and misses every time, because which cells overflow depends on
// the data, the column widths and how wide the sidebar happens to be - none of
// which are knowable while writing the markup.
//
// So it is measured instead of guessed. After each render this compares each
// cell's scrollWidth against its clientWidth and sets `title` on the ones that
// are actually cut, using the cell's own text. A cell that already carries a
// title keeps it - the hand-written ones say more than the visible text does
// ("Southern Glazers Wine and Spirits of Texas LLC" against a truncated name).
//
// Cheap by construction: these tables hold ten rows, the read is one layout pass
// on data that has just been laid out anyway, and nothing is written unless the
// cell is genuinely clipped.
// -----------------------------------------------------------------------------

import { useEffect } from 'react';

const CELL = 'td, th';

/** True when the element's content is wider than the box drawing it. */
function isClipped(el) {
  // +1 absorbs sub-pixel rounding, which otherwise marks whole tables as cut.
  return el.scrollWidth > el.clientWidth + 1;
}

/**
 * Give clipped cells a tooltip of their own text.
 *
 * @param {React.RefObject<HTMLElement>} ref  container to scan; omit to scan the document
 * @param {Array} deps  re-run when the data changes (rows, page, filter)
 */
export function useCellTitles(ref, deps = []) {
  useEffect(() => {
    const root = (ref && ref.current) || document;
    if (!root || !root.querySelectorAll) return undefined;

    // After paint: widths are not final until the browser has laid the table
    // out, and reading them in the same frame measures the previous render.
    const id = requestAnimationFrame(() => {
      root.querySelectorAll(CELL).forEach((cell) => {
        const existing = cell.getAttribute('title');
        if (existing) return;                      // a better title already set
        const text = (cell.textContent || '').trim();
        if (!text) return;
        if (isClipped(cell)) {
          cell.setAttribute('title', text);
          cell.dataset.autoTitle = '1';
        } else if (cell.dataset.autoTitle) {
          // No longer clipped - the sidebar widened, or the value is shorter -
          // so the tooltip has to go, or it lingers on text you can read.
          cell.removeAttribute('title');
          delete cell.dataset.autoTitle;
        }
      });
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export default useCellTitles;
