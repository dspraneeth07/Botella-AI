// useTablePage.js
// -----------------------------------------------------------------------------
// Paging for the reference tables, in one place.
//
// Every table on these screens used to cut its list with a bare `.slice(0, 12)`
// and say nothing: Customers showed 12 of 504 regulars, Market Comparison 12 of
// however many assortment gaps, Reports 10 of the top products. The 13th row was
// unreachable and the reader had no way to know it existed - which matters most
// on exactly these tables, where the rows are ranked and the cut is arbitrary.
//
// Purchasing had a working pager. This is that behaviour, extracted, so a table
// gains paging by calling a hook instead of by copying a block.
// -----------------------------------------------------------------------------

import { useMemo, useState } from 'react';

/** The house page size. Ten is what Purchasing already used. */
export const ROWS_PER_PAGE = 10;

/**
 * @param {Array} rows      the full, already-sorted list
 * @param {number} perPage  rows per page (defaults to the house size)
 * @returns {{
 *   page:number, setPage:Function, pageRows:Array, pageCount:number,
 *   first:number, last:number, total:number, needsPager:boolean
 * }}
 *
 * `page` is clamped on read rather than reset by an effect: when a filter
 * shortens the list under the reader's feet, an effect would re-render twice
 * and flash the empty state. Clamping resolves it in the same pass.
 */
export function useTablePage(rows, perPage = ROWS_PER_PAGE) {
  const [page, setPage] = useState(0);
  const total = (rows || []).length;
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);

  const pageRows = useMemo(
    () => (rows || []).slice(safePage * perPage, safePage * perPage + perPage),
    [rows, safePage, perPage],
  );

  return {
    page: safePage,
    setPage,
    pageRows,
    pageCount,
    first: total === 0 ? 0 : safePage * perPage + 1,
    last: Math.min(total, (safePage + 1) * perPage),
    total,
    // A single page needs no controls; showing a disabled "1 / 1" is furniture.
    needsPager: pageCount > 1,
  };
}
