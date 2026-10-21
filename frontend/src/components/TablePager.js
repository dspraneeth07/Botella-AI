// TablePager.js
// -----------------------------------------------------------------------------
// The footer under a reference table: what you are looking at, and how to reach
// the rest. Same markup and classes Purchasing already shipped, so every table
// pages and reads identically.
// -----------------------------------------------------------------------------

import React from 'react';

/**
 * @param {object}   p
 * @param {number}   p.first      1-based index of the first row shown
 * @param {number}   p.last       1-based index of the last row shown
 * @param {number}   p.total      rows in the whole (filtered) list
 * @param {number}   p.page       current page, 0-based
 * @param {number}   p.pageCount  total pages
 * @param {Function} p.setPage
 * @param {string}   [p.sortNote] what the list is ordered by, e.g. "most valuable first"
 * @param {string}   [p.emptyNote] shown instead of the range when total is 0
 * @param {boolean}  [p.needsPager] hide the buttons on a single page
 */
export default function TablePager({
  first, last, total, page, pageCount, setPage,
  sortNote, emptyNote = 'No rows to show', needsPager = true,
}) {
  return (
    <footer className="ref-tfoot">
      <span className="ref-tfoot-showing">
        {total === 0
          ? emptyNote
          : `Showing ${first.toLocaleString('en-US')}-${last.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}${sortNote ? ` · ${sortNote}` : ''}`}
      </span>
      {needsPager && (
        <span className="ref-tfoot-pager">
          <button
            type="button" className="ref-pager-btn"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >&larr; Prev</button>
          <span className="ref-pager-pos">{page + 1} / {pageCount}</span>
          <button
            type="button" className="ref-pager-btn"
            disabled={page >= pageCount - 1}
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
          >Next &rarr;</button>
        </span>
      )}
    </footer>
  );
}
