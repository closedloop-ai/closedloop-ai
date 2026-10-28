"use client";

import { TablePaginationFooter } from "@repo/design-system/components/ui/table-pagination-footer";
import { useTablePageSizeOptions } from "../hooks/use-table-page-size-options";
import {
  type ListPageRange,
  listPageRange,
} from "../lib/list-pagination-readout";

/**
 * ISS-9225 — the ONE footer both v2 list surfaces render, as
 * `ListSurfaceToolbarV2` is the one toolbar.
 *
 * Sessions rendered `SessionsListPagination` and Branches rendered the
 * design-system `TablePaginationFooter` itself, so the strip's frame, its
 * disabled state, its rows-per-page ladder and its suppression rule were each
 * decided twice. They agreed, which is the state ISS-9211 exists to close: two
 * implementations that match today and nothing that fails the day they stop.
 *
 * A caller supplies DATA and its own sentence. It cannot reach the ladder, the
 * frame, the pager's single-page behaviour, or the rule deciding when the
 * readout says nothing — those are stated here, once.
 *
 * ISS-9692: WHICH ladder is now a question (the `table-page-size-ladder` flag
 * adds 250 and 500), and it is asked here for the same reason the ladder itself
 * lives here — two surfaces asking it separately is how they come to offer
 * different choices for one control. The `pageSize` a caller hands in is still
 * the size its read actually used, so the range below stays honest; resolving
 * that value against the ladder in force is the caller's job, because only the
 * caller can hold its read until the answer lands.
 */
export function ListSurfacePaginationFooter({
  formatRange,
  isPlaceholderPage,
  isRangeUnsettled = false,
  onPageChange,
  onPageSizeChange,
  page,
  pageSize,
  rowsOnPage,
  total,
  totalPages,
}: {
  /**
   * The surface's own wording over the range derived here, or `null` where it
   * states none. A `(range) => string | null` rather than the `ReactNode` seam
   * ISS-9216 retired: the caller cannot decide WHICH page the sentence is
   * about, only how this list says it. Sessions announces a sentence with the
   * unit and Branches states the terse range because that is each list's
   * shipped copy, and unifying an implementation does not license rewording a
   * control.
   */
  formatRange: (range: ListPageRange, total: number) => string | null;
  /**
   * The rows on screen are not the page `page` names. Pins every control: the
   * shared visibility rule keeps this footer MOUNTED through a placeholder
   * read, so a live pager would page a list whose rows are already stale.
   */
  isPlaceholderPage: boolean;
  /**
   * The range is not yet knowable for a reason that does not pin the pager — a
   * read in flight, or an out-of-range page awaiting its clamp. Suppresses the
   * sentence only; the reader can still page away.
   */
  isRangeUnsettled?: boolean;
  onPageChange: (page: number) => void;
  /**
   * Omitted where this list has no rows-per-page control to offer:
   * `TablePaginationFooter` renders the select only when it has BOTH a size and
   * a handler, so withholding the handler withholds the control. A control that
   * cannot change anything is worse than no control.
   */
  onPageSizeChange?: (pageSize: number) => void;
  /**
   * Zero-based index of the page on screen. MUST be the index the rows came
   * from — Sessions' CLAMPED page, not the one a bookmark named — because the
   * pager and the readout below are one control.
   */
  page: number;
  pageSize: number;
  /** Rows rendered on this page. */
  rowsOnPage: number;
  /** Total matching rows, as reported by the list read. */
  total: number;
  totalPages: number;
}) {
  const { options: pageSizeOptions } = useTablePageSizeOptions(pageSize);
  const range = listPageRange({
    isPagingPlaceholder: isPlaceholderPage || isRangeUnsettled,
    pageIndex: page,
    pageSize,
    rowsOnPage,
    total,
  });
  const readout = range ? formatRange(range, total) : null;
  return (
    <TablePaginationFooter
      className="w-full border-t-0 p-0"
      disabled={isPlaceholderPage}
      onPageChange={onPageChange}
      onPageSizeChange={onPageSizeChange}
      page={page}
      pageSize={pageSize}
      pageSizeOptions={pageSizeOptions}
      readout={readout ?? undefined}
      showPagerOnSinglePage
      totalPages={totalPages}
    />
  );
}
