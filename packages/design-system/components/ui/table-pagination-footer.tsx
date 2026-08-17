"use client";

import { TablePageSizeSelect } from "@closedloop-ai/design-system/components/ui/table-page-size-select";
import { TablePagination } from "@closedloop-ai/design-system/components/ui/table-pagination";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import type { ReactNode } from "react";

/**
 * The paginated-table footer shell shared by every list surface (ISS-4681): a
 * `border-t` strip holding an optional range readout on the left and the shared
 * {@link TablePagination} control on the right.
 *
 * It lives here rather than in `@repo/app` because it knows nothing about any
 * domain: it renders whatever `readout` string it is handed, composes only the
 * design-system pagination primitive that sits beside it, and imports no
 * `@repo/app` / `@repo/api` / `@repo/database` symbol. Four surfaces
 * (My Tasks, Sessions, Branches, and the desktop Branches/Sessions views) had
 * hand-rolled this same strip, which is how they could drift into telling users
 * different stories about the same queue.
 *
 * The readout is a `role="status"` live region: paging here is button-driven
 * with no route change, so without it a screen-reader user gets no announcement
 * that the page they are on has changed. It renders only when a caller supplies
 * a readout — a surface with no honest total omits it rather than announcing an
 * empty region.
 *
 * `TablePagination` renders nothing for a single page, so a caller that wants a
 * readout on page one of one can render this footer unconditionally and get the
 * readout without controls. A caller with no readout should keep its own
 * `totalPages > 1` guard, or the strip becomes an empty bordered band.
 */
export function TablePaginationFooter({
  page,
  totalPages,
  onPageChange,
  readout,
  truncationNote,
  className,
  pageSize,
  onPageSizeChange,
  pageSizeOptions,
}: {
  /** Zero-based current page index. */
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  /**
   * Range readout for the current page ("Showing 1-25 of 240 tasks"). Announced
   * as a live region. Omit when the surface has no total it can state honestly.
   */
  readout?: ReactNode;
  /**
   * Secondary note shown under the readout when the underlying result set was
   * capped server-side, so the readout's total is not the whole population.
   */
  truncationNote?: ReactNode;
  /** Surface-specific padding / flex overrides merged over the base strip. */
  className?: string;
  /**
   * Rows-per-page control (FEA-4199). Wire BOTH to render the select beside the
   * readout; omit either and the footer is byte-identical to before, so the
   * surfaces that have not adopted a page size are unchanged.
   *
   * A caller that grows the page size is responsible for resetting to page 0 —
   * the footer cannot do it without owning page state it deliberately does not
   * have, and silently paging the user somewhere they did not ask for would be
   * worse than making the reset explicit at the call site.
   */
  pageSize?: number;
  onPageSizeChange?: (pageSize: number) => void;
  /** Overrides the shared 25/50/100 ladder. */
  pageSizeOptions?: readonly number[];
}) {
  const showPageSize = pageSize != null && onPageSizeChange != null;
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 overflow-x-auto border-t px-4 py-3 sm:flex-row sm:justify-between",
        className
      )}
    >
      {/* wongk review: the left group renders ONLY when it has something in it.
          An always-present wrapper is still a flex child, so a legacy caller
          with neither a readout nor page-size props got an invisible first
          child that pushed the pager from the left edge to the right under
          `sm:justify-between` — a layout change with the flag off. */}
      {showPageSize || readout ? (
        // `shrink-0`: the pager's nav is `w-full`, so under `sm:justify-between`
        // it claimed most of the strip and squeezed this group until the
        // page-size trigger clipped its own label ("25 / pa") and the readout
        // wrapped mid-sentence at ordinary desktop widths. A control that
        // cannot show what it is set to is worse than a wrapped sentence, so
        // this group holds its width and the pager yields instead.
        <div className="flex shrink-0 items-center gap-3">
          {showPageSize ? (
            <TablePageSizeSelect
              onPageSizeChange={onPageSizeChange}
              options={pageSizeOptions}
              pageSize={pageSize}
            />
          ) : null}
          {readout ? (
            <div className="flex flex-col gap-0.5">
              <p
                className={cn(
                  "text-muted-foreground",
                  // The readout and the page-size select are one control and its
                  // state, so they take one type size. The select's trigger is
                  // `text-xs` inside an `h-8`, so the readout matches it whenever
                  // the two sit side by side. A footer with no select keeps the
                  // `text-sm` the four adopting surfaces already ship.
                  showPageSize ? "text-xs" : "text-sm"
                )}
                role="status"
              >
                {readout}
              </p>
              {truncationNote ? (
                <p className="text-muted-foreground text-xs">
                  {truncationNote}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <TablePagination
        className="min-w-max"
        onPageChange={onPageChange}
        page={page}
        totalPages={totalPages}
      />
    </div>
  );
}
