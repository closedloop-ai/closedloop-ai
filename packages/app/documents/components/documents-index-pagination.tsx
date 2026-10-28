"use client";

import { TablePaginationFooter } from "@repo/design-system/components/ui/table-pagination-footer";

/**
 * ISS-9157: everything a Documents index body needs to render the pager under
 * its table, resolved by the container from the paged read's ENVELOPE.
 *
 * Data and handlers only — never a flag boolean. `undefined` on the unbounded
 * arm, so a body that receives one renders it and a body that does not has
 * nothing to branch on (the ISS-8940 posture `DocumentsIndexBodyProps` keeps).
 * `readout` is `null` and `disabled` is true while the rows on screen are not
 * the page the pager names (a placeholder page, or an out-of-range page waiting
 * for its clamp), so the strip never states a range the reader cannot see.
 */
export type DocumentsIndexPagination = {
  /** Zero-based page the rows on screen came from, per the server envelope. */
  page: number;
  totalPages: number;
  /**
   * The rows-per-page control, present only when the server actually bounded
   * the page. `TablePaginationFooter` renders the select only when it has both
   * a size and a handler, so withholding them withholds the control.
   */
  pageSize?: number;
  pageSizeOptions?: readonly number[];
  onPageSizeChange?: (pageSize: number) => void;
  readout: string | null;
  disabled: boolean;
  onPageChange: (page: number) => void;
};

/**
 * The one mapping from the descriptor to the design-system strip, so the two
 * bodies cannot bind it differently. The raw `TablePaginationFooter` (not the
 * Sessions/Branches `ListSurfacePaginationFooter`) because this index is a
 * `DocumentsView` surface, the family the project board and My Tasks belong
 * to, and those render this strip directly.
 */
export function DocumentsIndexPaginationFooter({
  pagination,
}: Readonly<{ pagination: DocumentsIndexPagination }>) {
  return (
    <TablePaginationFooter
      className="shrink-0"
      disabled={pagination.disabled}
      onPageChange={pagination.onPageChange}
      onPageSizeChange={pagination.onPageSizeChange}
      page={pagination.page}
      pageSize={pagination.pageSize}
      pageSizeOptions={pagination.pageSizeOptions}
      readout={pagination.readout ?? undefined}
      totalPages={pagination.totalPages}
    />
  );
}
