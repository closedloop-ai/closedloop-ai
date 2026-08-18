"use client";

import { TablePaginationFooter } from "@repo/design-system/components/ui/table-pagination-footer";

type MyTasksPaginationFooterProps = {
  /** Zero-based current page. */
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  /** The resolved range sentence (see `../lib/my-tasks-range-readout.ts`). */
  readout: string;
  /**
   * Optional disclosure naming exactly what was left out, rendered on its own
   * line beneath the readout when the total above it is a floor. `null` when
   * nothing was left out.
   */
  truncationNote?: string | null;
};

/**
 * The My Tasks pagination footer, shared by the list and card views (ISS-4576).
 *
 * One implementation so the two views cannot drift into telling the user two
 * different stories about the same queue.
 *
 * ISS-4681: the strip itself is now the shared design-system
 * {@link TablePaginationFooter}, the same shell Sessions, Branches, and the two
 * desktop views render — so "matches the Sessions/Branches footer pattern" is
 * enforced by composition instead of by four copies of the same classnames.
 * This wrapper keeps the My-Tasks-specific contract (a required `readout`, a
 * nullable `truncationNote`) and the one layout delta the surface needs.
 *
 * That delta is `shrink-0`, and it is load-bearing (ISS-4576 / #4131): both
 * views mount this as the last child of an `overflow-hidden` flex column whose
 * body grows, and the pager is the one control that must never be squeezed out
 * of the column to make room for the rows it pages through. `items-start` (with
 * `sm:items-center`) keeps the two-line readout left-aligned against the
 * truncation note on narrow widths rather than centering it.
 *
 * The readout is a `role="status"` live region inside the shared shell. Paging
 * is button-driven with no route change, so without it a screen-reader user
 * clicks Next and hears nothing: no new page, no new range.
 */
export function MyTasksPaginationFooter({
  page,
  totalPages,
  onPageChange,
  readout,
  truncationNote,
}: Readonly<MyTasksPaginationFooterProps>) {
  return (
    <TablePaginationFooter
      className="shrink-0 items-start sm:items-center"
      onPageChange={onPageChange}
      page={page}
      readout={readout}
      totalPages={totalPages}
      // The caveat gets its own line rather than trailing the count: the eye
      // should read what is on screen first and the disclosure second. `null`
      // (nothing was left out) renders no second line.
      truncationNote={truncationNote}
    />
  );
}
