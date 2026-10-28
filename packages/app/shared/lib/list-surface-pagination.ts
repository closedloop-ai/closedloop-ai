/**
 * ISS-9225 — the page BOUNDS a v2 list surface pages within.
 *
 * `shouldRenderListPagination` owns whether the footer renders and
 * `listPageRange` owns the sentence it states (both ISS-9216); this owns the
 * page the two of them describe. It arrived as `resolveSessionsPagination` in
 * the Sessions model, which is why Sessions clamped its page against a capped
 * total while Branches' hosts each did their own arithmetic — a Sessions-named
 * helper is one no other surface will find.
 *
 * Nothing here is Sessions-specific: the rows are opaque, and the clamp is the
 * pager's own (`resolvePaginationBounds`) so the slice and the footer cannot
 * name different pages. Branches does not call it because its page bounds come
 * from the server read, not from rows in hand.
 */
import { resolveCappedTotalPages } from "@repo/api/src/utils/math";
import { resolvePaginationBounds } from "@repo/design-system/components/ui/table-pagination-v2";

export function resolveListSurfacePagination<TRow>({
  isGrouped,
  isServerDriven,
  maxOffset,
  page,
  pageSize,
  rows,
  serverTotalRows,
}: {
  isGrouped: boolean;
  isServerDriven: boolean;
  maxOffset?: number;
  page: number;
  pageSize: number;
  rows: readonly TRow[];
  serverTotalRows?: number;
}): { pagedRows: readonly TRow[]; safePage: number; totalPages: number } {
  const total = serverTotalRows ?? rows.length;
  const totalPages = resolveCappedTotalPages(total, pageSize, maxOffset);
  const { safePage } = resolvePaginationBounds(page, totalPages);
  if (isGrouped || isServerDriven) {
    return { pagedRows: rows, safePage, totalPages };
  }
  const start = safePage * pageSize;
  return {
    pagedRows: rows.slice(start, start + pageSize),
    safePage,
    totalPages,
  };
}
